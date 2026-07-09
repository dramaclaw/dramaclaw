"""Migrate per-user `_shared/` directories into the global `state/_shared/`.

Phase 2 originally kept failure-mode defs, training traces, and the
artifact store under `state/<user>/_shared/` so each user had their
own sandbox. In practice everyone is working on the same IP, so the
flywheel needs to be **global**: one canonical registry, one training
pool, one artifact store, aggregating every user's runs.

This one-shot CLI walks every `state/<user>/_shared/` directory that
still exists, merges its contents into `state/_shared/`, and renames
the old directories to `_shared.deprecated` so nothing is deleted in
place (safe rollback).

Merge semantics:
- `verification.db.sketch_failure_mode_defs`: UPSERT by `code`. User
  that migrated last wins on ties (not an issue in practice because
  the seed is identical across installs).
- `director_training.db.*`: INSERT OR IGNORE by primary key — traces
  keyed by `trace_id`, samples by `sample_id`, rejects by `reject_id`,
  events by `event_id`, sketch formats by `version`.
- `artifacts/<sha>/<sha>.<ext>`: content-addressable — rsync wins
  trivially, identical bytes produce identical paths.

Rerunning the migration is safe; it will no-op on rows that have
already landed in the global DB.

Usage:
    uv run python -m novelvideo.verification.cli.migrate_to_global_shared
    uv run python -m novelvideo.verification.cli.migrate_to_global_shared --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path

import aiosqlite

from novelvideo.config import STATE_DIR


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge per-user _shared into global state/_shared/.")
    parser.add_argument("--dry-run", action="store_true", help="Report what would be merged without writing")
    parser.add_argument(
        "--keep-user-shared",
        action="store_true",
        help="Do not rename source user _shared dirs after migration (default: rename to _shared.deprecated)",
    )
    return parser.parse_args()


def _discover_user_shared_dirs() -> list[Path]:
    root = Path(STATE_DIR)
    if not root.exists():
        return []
    out: list[Path] = []
    for user_dir in sorted(root.iterdir()):
        if not user_dir.is_dir():
            continue
        if user_dir.name.startswith("_"):
            # skip state/_shared/ itself and other underscored names
            continue
        candidate = user_dir / "_shared"
        if candidate.is_dir():
            out.append(candidate)
    return out


async def _merge_verification_db(src: Path, dst: Path, dry_run: bool) -> tuple[int, int]:
    """Return (rows_considered, rows_inserted)."""
    if not src.exists():
        return 0, 0
    dst.parent.mkdir(parents=True, exist_ok=True)

    # Ensure destination has schema
    from novelvideo.verification.global_registry_db import DEFS_SCHEMA_SQL

    async with aiosqlite.connect(str(dst)) as db_dst:
        await db_dst.executescript(DEFS_SCHEMA_SQL)
        await db_dst.commit()

    async with aiosqlite.connect(str(src)) as db_src:
        db_src.row_factory = aiosqlite.Row
        try:
            rows = await (await db_src.execute(
                "SELECT * FROM sketch_failure_mode_defs"
            )).fetchall()
        except Exception:
            rows = []

    if not rows:
        return 0, 0

    if dry_run:
        return len(rows), 0

    async with aiosqlite.connect(str(dst)) as db_dst:
        inserted = 0
        for row in rows:
            data = dict(row)
            await db_dst.execute(
                """
                INSERT INTO sketch_failure_mode_defs (
                    code, layer, detection, prevention_rule,
                    correction_template, negative_prompt_clause,
                    gate_enabled, fixture_path, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                          COALESCE(?, datetime('now')),
                          datetime('now'))
                ON CONFLICT(code) DO UPDATE SET
                    layer = excluded.layer,
                    detection = excluded.detection,
                    prevention_rule = excluded.prevention_rule,
                    correction_template = excluded.correction_template,
                    negative_prompt_clause = excluded.negative_prompt_clause,
                    gate_enabled = excluded.gate_enabled,
                    updated_at = datetime('now')
                """,
                (
                    data["code"], data["layer"], data["detection"],
                    data.get("prevention_rule") or "",
                    data.get("correction_template") or "",
                    data.get("negative_prompt_clause") or "",
                    int(data.get("gate_enabled") or 0),
                    data.get("fixture_path") or "",
                    data.get("created_at"),
                ),
            )
            inserted += 1
        await db_dst.commit()
    return len(rows), inserted


async def _merge_training_db(src: Path, dst: Path, dry_run: bool) -> dict[str, int]:
    if not src.exists():
        return {}
    dst.parent.mkdir(parents=True, exist_ok=True)

    from novelvideo.verification.training_db import TRAINING_SCHEMA_SQL

    async with aiosqlite.connect(str(dst)) as db_dst:
        await db_dst.executescript(TRAINING_SCHEMA_SQL)
        await db_dst.commit()

    tables = [
        "sketch_format_versions",
        "accepted_sketch_samples",
        "live_edit_traces",
        "reject_buffer",
        "human_override_events",
    ]
    counts: dict[str, int] = {}
    async with aiosqlite.connect(str(src)) as db_src:
        db_src.row_factory = aiosqlite.Row
        for table in tables:
            try:
                rows = await (await db_src.execute(f"SELECT * FROM {table}")).fetchall()
            except Exception:
                rows = []
            counts[table] = len(rows)

            if dry_run or not rows:
                continue

            # Determine column list dynamically (works with schema evolution)
            cols = list(rows[0].keys())
            async with aiosqlite.connect(str(dst)) as db_dst:
                placeholders = ",".join("?" for _ in cols)
                col_list = ",".join(cols)
                for row in rows:
                    values = [row[c] for c in cols]
                    # INSERT OR IGNORE: primary key conflicts are intentional
                    # (already migrated or duplicate across users)
                    await db_dst.execute(
                        f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES ({placeholders})",
                        values,
                    )
                await db_dst.commit()
    return counts


def _merge_artifacts(src: Path, dst: Path, dry_run: bool) -> int:
    if not src.exists():
        return 0
    dst.mkdir(parents=True, exist_ok=True)
    copied = 0
    for p in src.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(src)
        target = dst / rel
        if target.exists():
            continue  # content-addressable: same bytes, same path
        if dry_run:
            copied += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
        copied += 1
    return copied


async def main_async() -> int:
    args = parse_args()
    state_root = Path(STATE_DIR)
    global_shared = state_root / "_shared"

    sources = _discover_user_shared_dirs()
    if not sources:
        print(json.dumps({"ok": True, "reason": "no per-user _shared dirs found", "sources_scanned": 0}))
        return 0

    report: dict[str, dict] = {}
    for src in sources:
        user = src.parent.name
        summary: dict[str, object] = {}

        verification_src = src / "verification.db"
        verification_dst = global_shared / "verification.db"
        considered, inserted = await _merge_verification_db(verification_src, verification_dst, args.dry_run)
        summary["verification"] = {"source_rows": considered, "upserts": inserted}

        training_src = src / "director_training.db"
        training_dst = global_shared / "director_training.db"
        training_counts = await _merge_training_db(training_src, training_dst, args.dry_run)
        summary["training"] = training_counts

        artifacts_src = src / "artifacts"
        artifacts_dst = global_shared / "artifacts"
        artifacts_copied = _merge_artifacts(artifacts_src, artifacts_dst, args.dry_run)
        summary["artifacts_copied"] = artifacts_copied

        report[user] = summary

        # Preserve old location with a rename (safe rollback).
        if not args.dry_run and not args.keep_user_shared:
            deprecated = src.with_name("_shared.deprecated")
            if deprecated.exists():
                # Don't clobber existing rollback; bump with a timestamp.
                import datetime

                ts = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
                deprecated = src.with_name(f"_shared.deprecated.{ts}")
            src.replace(deprecated)
            summary["moved_to"] = str(deprecated)

    print(json.dumps({
        "ok": True,
        "dry_run": args.dry_run,
        "global_shared_dir": str(global_shared),
        "by_user": report,
    }, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    return asyncio.run(main_async())


if __name__ == "__main__":
    sys.exit(main())

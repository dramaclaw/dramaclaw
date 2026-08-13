#!/usr/bin/env python3
"""Move legacy Docker outputs into the persistent CE data volume."""

from __future__ import annotations

import argparse
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class MigrationResult:
    copied_files: int
    skipped_files: int
    migrated_projects: int
    backup_path: Path | None


def _copy_missing_files(source_root: Path, target_root: Path) -> tuple[int, int]:
    copied = 0
    skipped = 0
    if not source_root.is_dir():
        return copied, skipped

    for source in source_root.rglob("*"):
        relative = source.relative_to(source_root)
        target = target_root / relative
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if not source.is_file():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            skipped += 1
            continue
        shutil.copy2(source, target)
        copied += 1
    return copied, skipped


def _backup_registry(registry_db: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_path = registry_db.with_name(f"{registry_db.name}.backup-{timestamp}")
    source = sqlite3.connect(registry_db)
    target = sqlite3.connect(backup_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    return backup_path


def _migrate_project_paths(
    registry_db: Path,
    *,
    legacy_root: Path,
    target_root: Path,
) -> tuple[int, Path | None]:
    if not registry_db.is_file():
        return 0, None

    legacy_prefix = legacy_root.as_posix().rstrip("/")
    target_prefix = target_root.as_posix().rstrip("/")
    connection = sqlite3.connect(registry_db)
    try:
        rows = connection.execute(
            "SELECT id, output_dir FROM projects WHERE output_dir = ? OR output_dir LIKE ?",
            (legacy_prefix, f"{legacy_prefix}/%"),
        ).fetchall()
        if not rows:
            return 0, None

        backup_path = _backup_registry(registry_db)
        connection.execute("BEGIN IMMEDIATE")
        for project_id, output_dir in rows:
            suffix = str(output_dir)[len(legacy_prefix) :]
            connection.execute(
                "UPDATE projects SET output_dir = ? WHERE id = ?",
                (f"{target_prefix}{suffix}", project_id),
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    return len(rows), backup_path


def migrate_docker_output(
    *,
    legacy_root: Path,
    target_root: Path,
    registry_db: Path,
) -> MigrationResult:
    target_root.mkdir(parents=True, exist_ok=True)
    copied, skipped = _copy_missing_files(legacy_root, target_root)
    migrated_projects, backup_path = _migrate_project_paths(
        registry_db,
        legacy_root=legacy_root,
        target_root=target_root,
    )
    return MigrationResult(
        copied_files=copied,
        skipped_files=skipped,
        migrated_projects=migrated_projects,
        backup_path=backup_path,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Migrate legacy /app/output data into the CE /data volume."
    )
    parser.add_argument("--legacy-root", type=Path, default=Path("/app/output"))
    parser.add_argument("--target-root", type=Path, default=Path("/data/output"))
    parser.add_argument(
        "--registry-db",
        type=Path,
        default=Path("/data/state/local/projects.db"),
    )
    args = parser.parse_args()

    result = migrate_docker_output(
        legacy_root=args.legacy_root,
        target_root=args.target_root,
        registry_db=args.registry_db,
    )
    print(f"copied_files={result.copied_files}")
    print(f"skipped_existing_files={result.skipped_files}")
    print(f"migrated_projects={result.migrated_projects}")
    print(f"registry_backup={result.backup_path or '-'}")
    print("Legacy files were preserved. You can now rebuild the API container.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

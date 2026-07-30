"""Sync PlayCanvas 3GS props into the project global prop registry."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

from novelvideo.models import build_prop_menu
from novelvideo.sqlite_pragmas import configure_sqlite_connection
from novelvideo.sqlite_schema import ensure_sqlite_schema
from novelvideo.utils.project_paths import ProjectPaths

_SCHEMA_COMPONENT = "director_world_props"
# MIGRATION CONTRACT: increment this whenever _ensure_props_table changes.
_SCHEMA_VERSION = 1


def _safe_text(value: Any) -> str:
    return str(value or "").strip()


def _validate_path_segment(value: str, label: str) -> str:
    cleaned = _safe_text(value)
    if not cleaned or "/" in cleaned or "\\" in cleaned or cleaned in {".", ".."}:
        raise ValueError(f"invalid {label}: {cleaned!r}")
    return cleaned


def _prop_id(prop: dict[str, Any]) -> str:
    raw = _safe_text(prop.get("prop_id") or prop.get("name") or prop.get("id"))
    return raw or "global_prop"


def _description(prop: dict[str, Any]) -> str:
    parts = [
        _safe_text(prop.get("semantic_label")),
        _safe_text(prop.get("shape_hint")),
    ]
    return "；".join(part for part in parts if part)


def _visual_prompt(prop: dict[str, Any], prop_id: str) -> str:
    return (
        _safe_text(prop.get("visual_prompt"))
        or _safe_text(prop.get("shape_hint"))
        or _safe_text(prop.get("semantic_label"))
        or prop_id
    )


def _load_json_list(value: str | None) -> list[Any]:
    if not value:
        return []
    try:
        loaded = json.loads(value)
    except Exception:
        return []
    return loaded if isinstance(loaded, list) else []


def _load_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    payload = json.loads(raw)
    return payload if isinstance(payload, dict) else {}


def _ensure_props_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS props (
            name TEXT PRIMARY KEY,
            aliases_json TEXT DEFAULT '[]',
            prop_type TEXT DEFAULT 'object',
            visual_prompt TEXT DEFAULT '',
            description TEXT DEFAULT '',
            owner TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
        """
    )


def _is_global_prop(prop: dict[str, Any]) -> bool:
    scope = _safe_text(prop.get("asset_scope") or prop.get("scope")).lower()
    return prop.get("is_global_asset") is True or scope == "global"


def _merge_unique(existing: list[Any], additions: list[str]) -> tuple[list[Any], list[str]]:
    merged = list(existing)
    seen = {str(item or "").strip() for item in merged if str(item or "").strip()}
    added: list[str] = []
    for item in additions:
        prop_id = _safe_text(item)
        if not prop_id or prop_id in seen:
            continue
        seen.add(prop_id)
        merged.append(prop_id)
        added.append(prop_id)
    return merged, added


def _merge_beat_detected_props(
    conn: sqlite3.Connection,
    *,
    episode: int,
    beat: int | None,
    prop_ids: list[str],
) -> tuple[bool, list[str], list[Any]]:
    if not beat or beat <= 0 or not prop_ids:
        return False, [], []
    row = conn.execute(
        """
        SELECT detected_props_json
        FROM beats
        WHERE episode_number = ? AND beat_number = ?
        """,
        (episode, beat),
    ).fetchone()
    if row is None:
        return False, [], []
    detected_props, added = _merge_unique(
        _load_json_list(row["detected_props_json"]),
        prop_ids,
    )
    if added:
        conn.execute(
            """
            UPDATE beats
            SET detected_props_json = ?, updated_at = datetime('now')
            WHERE episode_number = ? AND beat_number = ?
            """,
            (json.dumps(detected_props, ensure_ascii=False), episode, beat),
        )
    return True, added, detected_props


def sync_global_props(
    *,
    user: str,
    project: str,
    episode: int,
    beat: int | None = None,
    props: list[dict[str, Any]],
) -> dict[str, Any]:
    user = _validate_path_segment(user, "user")
    project = _validate_path_segment(project, "project")
    paths = ProjectPaths(user, project)
    db_path = paths.data_db
    if not db_path.exists():
        return {"ok": False, "error": f"data.db not found: {db_path}"}

    global_props = [prop for prop in props if isinstance(prop, dict) and _is_global_prop(prop)]
    if not global_props:
        return {"ok": True, "synced": 0, "prop_ids": [], "beat_synced": False}

    prop_menu: list[dict[str, Any]] = []
    beat_synced = False
    beat_added_prop_ids: list[str] = []
    beat_detected_props: list[Any] = []
    ensure_sqlite_schema(
        db_path,
        component=_SCHEMA_COMPONENT,
        version=_SCHEMA_VERSION,
        initialize=_ensure_props_table,
    )
    conn = sqlite3.connect(str(db_path), timeout=10)
    try:
        conn.row_factory = sqlite3.Row
        configure_sqlite_connection(conn, set_journal_mode=False)
        row = conn.execute(
            "SELECT prop_menu_json FROM episodes WHERE number = ?",
            (episode,),
        ).fetchone()
        if row is None:
            return {"ok": False, "error": f"episode {episode} not found"}

        menu_by_id = {
            item.prop_id: item.model_dump()
            for item in build_prop_menu(prop_menu=_load_json_list(row["prop_menu_json"]))
        }
        synced_ids: list[str] = []
        for prop in global_props:
            prop_id = _prop_id(prop)
            name = _safe_text(prop.get("name")) or prop_id
            description = _description(prop)
            prop_type = _safe_text(
                prop.get("prop_type") or prop.get("shape_hint") or prop.get("type")
            )
            if prop_type == "prop_staging":
                prop_type = _safe_text(prop.get("shape_hint")) or "object"
            prop_type = prop_type or "object"
            visual_prompt = _visual_prompt(prop, prop_id)

            previous = dict(menu_by_id.get(prop_id) or {})
            previous.update(
                {
                    "prop_id": prop_id,
                    "prop_type": previous.get("prop_type") or prop_type,
                    "description": description or previous.get("description", ""),
                }
            )
            menu_by_id[prop_id] = previous

            aliases = [name] if name and name != prop_id else []
            conn.execute(
                """
                INSERT INTO props (
                    name, aliases_json, prop_type, visual_prompt, description,
                    owner, notes
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    aliases_json=excluded.aliases_json,
                    prop_type=excluded.prop_type,
                    visual_prompt=excluded.visual_prompt,
                    description=excluded.description,
                    owner=excluded.owner,
                    notes=excluded.notes,
                    updated_at=datetime('now')
                """,
                (
                    prop_id,
                    json.dumps(aliases, ensure_ascii=False),
                    prop_type,
                    visual_prompt,
                    description,
                    "",
                    json.dumps(
                        {
                            "source": "playcanvas_3gs",
                            "type": _safe_text(prop.get("type")),
                            "shape_hint": _safe_text(prop.get("shape_hint")),
                        },
                        ensure_ascii=False,
                    ),
                ),
            )
            synced_ids.append(prop_id)

        prop_menu = list(menu_by_id.values())
        beat_synced, beat_added_prop_ids, beat_detected_props = _merge_beat_detected_props(
            conn,
            episode=episode,
            beat=beat,
            prop_ids=synced_ids,
        )
        conn.execute(
            """
            UPDATE episodes
            SET prop_menu_json = ?, updated_at = datetime('now')
            WHERE number = ?
            """,
            (json.dumps(prop_menu, ensure_ascii=False), episode),
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "ok": True,
        "synced": len(synced_ids),
        "prop_ids": synced_ids,
        "beat_synced": beat_synced,
        "beat_added_prop_ids": beat_added_prop_ids,
        "beat_detected_props": beat_detected_props,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--episode", type=int, required=True)
    args = parser.parse_args()
    payload = _load_payload()
    props = payload.get("props") if isinstance(payload.get("props"), list) else []
    try:
        beat = int(payload.get("beat")) if payload.get("beat") is not None else None
    except (TypeError, ValueError):
        beat = None
    result = sync_global_props(
        user=args.user,
        project=args.project,
        episode=args.episode,
        beat=beat,
        props=props,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

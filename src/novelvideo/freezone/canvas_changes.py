# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Bounded per-canvas change logs for cursor replay."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from novelvideo.freezone.agent_canvas_config import canvas_patch_push_enabled
from novelvideo.freezone.agent_canvas_metrics import count, observe
from novelvideo.freezone.paths import CANVAS_ID_RE

CHANGE_LOG_MAX_ENTRIES_ENV = "DRAMACLAW_CANVAS_CHANGE_LOG_MAX_ENTRIES"
CHANGE_LOG_MAX_BYTES_ENV = "DRAMACLAW_CANVAS_CHANGE_LOG_MAX_BYTES"
DEFAULT_CHANGE_LOG_MAX_ENTRIES = 200
DEFAULT_CHANGE_LOG_MAX_BYTES = 4 * 1024 * 1024

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CanvasChangeReplay:
    entries: list[dict]
    reset_revision: int | None


def canvas_changes_dir(project_dir: Path, canvas_id: str) -> Path:
    if not CANVAS_ID_RE.fullmatch(canvas_id):
        raise ValueError("Invalid canvas id")
    return project_dir / "freezone" / "canvas_changes" / canvas_id


def canvas_change_signal_path(project_dir: Path, canvas_id: str) -> Path:
    return canvas_changes_dir(project_dir, canvas_id) / "changes.signal"


def _items_by_id(payload: dict | None, key: str) -> dict[str, dict]:
    items = payload.get(key) if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return {}
    return {
        item["id"]: item
        for item in items
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }


def build_canvas_change(
    canvas_id: str,
    existing: dict | None,
    payload: dict,
    *,
    save_source: str,
    client_save_id: str | None,
) -> dict | None:
    revision = payload.get("revision")
    if not isinstance(revision, int):
        return None
    base_revision = existing.get("revision") if isinstance(existing, dict) else None
    change = {
        "type": "canvas.patch",
        "canvas_id": canvas_id,
        "revision": revision,
        "base_revision": base_revision if isinstance(base_revision, int) else 0,
        "save_source": save_source,
        "client_save_id": client_save_id or None,
        "written_at": datetime.now(timezone.utc).isoformat(),
    }
    for key, deleted_key in (("nodes", "deleted_node_ids"), ("edges", "deleted_edge_ids")):
        old = _items_by_id(existing, key)
        current = payload.get(key)
        valid_items = (
            [item for item in current if isinstance(item, dict) and isinstance(item.get("id"), str)]
            if isinstance(current, list)
            else []
        )
        current_ids = {item["id"] for item in valid_items}
        change[key] = [item for item in valid_items if item != old.get(item["id"])]
        change[deleted_key] = [item_id for item_id in old if item_id not in current_ids]
    return change


def _write_entry(path: Path, payload: dict) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False
        ) as stream:
            temporary = Path(stream.name)
            json.dump(payload, stream, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _entry_paths(directory: Path) -> list[Path]:
    paths = []
    for path in directory.glob("*.json"):
        try:
            revision = int(path.stem)
        except ValueError:
            continue
        paths.append((revision, path))
    return [path for _, path in sorted(paths)]


def _positive_limit(env: str, default: int) -> int:
    try:
        value = int(os.environ.get(env, ""))
    except ValueError:
        return default
    return value if value > 0 else default


def publish_canvas_change(
    project_dir: Path,
    canvas_id: str,
    existing: dict | None,
    payload: dict,
    *,
    save_source: str,
    client_save_id: str | None = None,
) -> None:
    try:
        if not canvas_patch_push_enabled():
            return
        change = build_canvas_change(
            canvas_id, existing, payload, save_source=save_source, client_save_id=client_save_id
        )
        if change is None:
            return
        directory = canvas_changes_dir(project_dir, canvas_id)
        directory.mkdir(parents=True, exist_ok=True)
        _write_entry(directory / f"{change['revision']:012d}.json", change)
        max_entries = _positive_limit(CHANGE_LOG_MAX_ENTRIES_ENV, DEFAULT_CHANGE_LOG_MAX_ENTRIES)
        max_bytes = _positive_limit(CHANGE_LOG_MAX_BYTES_ENV, DEFAULT_CHANGE_LOG_MAX_BYTES)
        files = [(path, path.stat().st_size) for path in _entry_paths(directory)]
        total_bytes = sum(size for _, size in files)
        remaining = len(files)
        for path, size in files[:-1]:
            if remaining <= max_entries and total_bytes <= max_bytes:
                break
            path.unlink(missing_ok=True)
            remaining -= 1
            total_bytes -= size
        count("canvas_change.published")
        observe("canvas_change_log.entries", remaining)
        observe("canvas_change_log.bytes", total_bytes)
        pruned = len(files) - remaining
        if pruned:
            count("canvas_change_log.pruned")
            logger.info(
                "canvas_change_log canvas=%s entries=%d bytes=%d pruned=%d",
                canvas_id, remaining, total_bytes, pruned,
            )
        canvas_change_signal_path(project_dir, canvas_id).touch()
    except Exception as exc:
        logger.warning(
            "Canvas change publish failed canvas_id=%s revision=%s exception=%s",
            canvas_id,
            payload.get("revision"),
            type(exc).__name__,
        )


def read_canvas_changes(project_dir: Path, canvas_id: str, cursor: int) -> CanvasChangeReplay:
    entries = []
    for path in _entry_paths(canvas_changes_dir(project_dir, canvas_id)):
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and isinstance(entry.get("revision"), int):
            entries.append(entry)
    entries.sort(key=lambda entry: entry["revision"])
    if not entries:
        return CanvasChangeReplay([], None)
    head = entries[-1]["revision"]
    if cursor == head:
        return CanvasChangeReplay([], None)
    if cursor > head:
        return CanvasChangeReplay([], head)
    pending = [entry for entry in entries if entry["revision"] > cursor]
    previous_revision = cursor
    for entry in pending:
        if entry.get("base_revision") != previous_revision:
            return CanvasChangeReplay([], head)
        previous_revision = entry["revision"]
    return CanvasChangeReplay(pending, None)


def clear_canvas_changes(project_dir: Path, canvas_id: str) -> None:
    try:
        directory = canvas_changes_dir(project_dir, canvas_id)
        if not directory.exists():
            return
        for path in _entry_paths(directory):
            path.unlink(missing_ok=True)
        canvas_change_signal_path(project_dir, canvas_id).touch()
    except Exception as exc:
        logger.warning(
            "Canvas change cleanup failed canvas_id=%s exception=%s", canvas_id, type(exc).__name__
        )

"""Append-only canvas event records shared by canvas and story routes.

Events are kept for troubleshooting, not audit. Each canvas appends to
`_canvas_events/<canvas_id>.jsonl`; once that file passes
CANVAS_EVENT_SEGMENT_BYTES it is moved to `_canvas_events/_segments/<canvas_id>/`
and only the newest CANVAS_EVENT_SEGMENTS_KEPT segments are kept, so one canvas
holds at most (kept + 1) segments of events. The active file always exists
after an append: canvas creation reads it to keep a deleted canvas's id reserved.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from novelvideo.freezone import canvas_store
from novelvideo.freezone.paths import CANVAS_ID_RE, freezone_root

CANVAS_EVENT_SCHEMA_VERSION = "canvas_event.v1"
CANVAS_EVENT_SEGMENT_BYTES = 8 * 1024 * 1024
CANVAS_EVENT_SEGMENTS_KEPT = 2


def canvas_event_actor(user: dict) -> dict:
    return {
        "kind": "user",
        "id": str(user.get("id") or user.get("username") or "unknown"),
        "username": str(user.get("username") or ""),
    }


def canvas_events_dir(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "_canvas_events"


def _event_file_id(canvas_id: str | None) -> str:
    event_canvas_id = (canvas_id or "").strip() or "_project"
    if not CANVAS_ID_RE.match(event_canvas_id):
        digest = hashlib.sha256(event_canvas_id.encode("utf-8")).hexdigest()[:16]
        event_canvas_id = f"canvas_{digest}"
    return event_canvas_id


def _rotate_if_large(project_dir: Path, path: Path, file_id: str) -> None:
    try:
        if path.stat().st_size <= CANVAS_EVENT_SEGMENT_BYTES:
            return
    except FileNotFoundError:
        return
    from novelvideo.ports import get_canvas_write_mutex

    lock_id = "events_" + hashlib.sha256(file_id.encode()).hexdigest()[:40]
    with get_canvas_write_mutex().write_mutex(project_dir, lock_id) as guard:
        try:
            if path.stat().st_size <= CANVAS_EVENT_SEGMENT_BYTES:
                return  # another writer rotated it while we waited
        except FileNotFoundError:
            return
        segments_dir = canvas_events_dir(project_dir) / "_segments" / file_id
        segments_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        guard.reassert()
        # A writer that opened the old file before this rename finishes its line
        # in the segment, so nothing is lost.
        path.replace(segments_dir / f"{stamp}.jsonl")
        for stale in sorted(segments_dir.glob("*.jsonl"))[:-CANVAS_EVENT_SEGMENTS_KEPT]:
            stale.unlink(missing_ok=True)


def append_canvas_event(
    *,
    project_dir: Path,
    project_id: str,
    canvas_id: str | None,
    event_type: str,
    actor: dict,
    payload: dict,
) -> None:
    file_id = _event_file_id(canvas_id)
    path = canvas_events_dir(project_dir) / f"{file_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    _rotate_if_large(Path(project_dir), path, file_id)
    record = {
        "schema_version": CANVAS_EVENT_SCHEMA_VERSION,
        "event_id": uuid.uuid4().hex,
        "project_id": project_id,
        "canvas_id": (canvas_id or "").strip() or "_project",
        "event_type": event_type,
        "actor": actor,
        "created_at": canvas_store.utc_now_iso(),
        "payload": payload,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

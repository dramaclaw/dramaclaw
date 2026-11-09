"""Append-only canvas event records shared by canvas and story routes."""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path

from novelvideo.freezone import canvas_store
from novelvideo.freezone.paths import CANVAS_ID_RE, freezone_root

CANVAS_EVENT_SCHEMA_VERSION = "canvas_event.v1"


def canvas_event_actor(user: dict) -> dict:
    return {
        "kind": "user",
        "id": str(user.get("id") or user.get("username") or "unknown"),
        "username": str(user.get("username") or ""),
    }


def append_canvas_event(
    *,
    project_dir: Path,
    project_id: str,
    canvas_id: str | None,
    event_type: str,
    actor: dict,
    payload: dict,
) -> None:
    event_canvas_id = (canvas_id or "").strip() or "_project"
    if not CANVAS_ID_RE.match(event_canvas_id):
        digest = hashlib.sha256(event_canvas_id.encode("utf-8")).hexdigest()[:16]
        event_canvas_id = f"canvas_{digest}"
    path = freezone_root(project_dir) / "_canvas_events" / f"{event_canvas_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
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

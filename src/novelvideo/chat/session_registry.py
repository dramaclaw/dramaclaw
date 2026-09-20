"""Pure identity and expiry policy for project-scoped chat sessions.

File ownership, heartbeat, and release remain in the application during
migration; this module owns the stable lock identity and time semantics.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

_CHAT_RUN_LOCK_KEY = "active_chat_run"
_CHAT_RUN_LOCK_TTL_SECONDS = 2 * 60
_CHAT_RUN_LOCK_MAX_SECONDS = 60 * 60
_CHAT_RUN_LOCK_HEARTBEAT_SECONDS = 30.0
_CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS = 5.0

def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _parse_chat_run_lock(
    value: str | None,
) -> tuple[str | None, str | None, int | None, datetime | None, datetime | None]:
    if not value:
        return None, None, None, None, None
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return value, None, None, None, None
    if not isinstance(payload, dict):
        return None, None, None, None, None
    lock_id = payload.get("lock_id")
    owner_id = payload.get("owner_id")
    owner_pid = payload.get("owner_pid")
    started_at = payload.get("started_at")
    updated_at = payload.get("updated_at") or started_at
    return (
        str(lock_id).strip() or None if lock_id is not None else None,
        str(owner_id).strip() or None if owner_id is not None else None,
        int(owner_pid) if isinstance(owner_pid, int) else None,
        _parse_iso_datetime(str(started_at)) if started_at is not None else None,
        _parse_iso_datetime(str(updated_at)) if updated_at is not None else None,
    )


def _chat_run_lock_is_stale(
    started_at: datetime | None,
    updated_at: datetime | None = None,
) -> bool:
    now = datetime.now(timezone.utc)
    if started_at is not None:
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        if (now - started_at).total_seconds() > _CHAT_RUN_LOCK_MAX_SECONDS:
            return True
    heartbeat_at = updated_at or started_at
    if heartbeat_at is None:
        return False
    if heartbeat_at.tzinfo is None:
        heartbeat_at = heartbeat_at.replace(tzinfo=timezone.utc)
    return (now - heartbeat_at).total_seconds() > _CHAT_RUN_LOCK_TTL_SECONDS


def _chat_run_lock_key(project: str) -> str:
    if project.startswith("freezone:"):
        return project
    return _CHAT_RUN_LOCK_KEY


def _chat_run_lock_project_for_turn(
    project: str,
    *,
    tool_mode: str,
    store_scope: Any | None = None,
) -> str:
    if tool_mode != "freezone_canvas":
        return project
    canvas_id = str(getattr(store_scope, "canvas_id", "") or "").strip()
    agent_id = str(getattr(store_scope, "agent_id", "") or "main").strip() or "main"
    if canvas_id:
        return f"freezone:{project}:canvas:{canvas_id}:agent:{agent_id}"
    return f"freezone:{project}:agent:{agent_id}"

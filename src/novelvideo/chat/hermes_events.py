"""Hermes ACP event-shape knowledge.

Only the Hermes adapter (``hermes_sdk``) should need these: it uses them to
stamp provider-neutral flags on ``ChatBackendEvent`` while translating
``session/update`` notifications. The chat application must not call them on
raw payloads; it reads the stamped fields instead. Legacy entrypoints in
``runtime_event_mapper`` and ``presentation_mapping`` delegate here for
callers that still hold a raw update.
"""

from __future__ import annotations

import json
from typing import Any

from novelvideo.chat.presentation import json_loads_with_trailing_repair

TOOL_CALL = "tool_call"
TOOL_CALL_UPDATE = "tool_call_update"
_FAILED_STATUSES = frozenset({"failed", "error", "cancelled", "canceled"})
_RESULT_PAYLOAD_KEYS = ("content", "result", "data", "output", "message", "error")
_BUSINESS_PAYLOAD_KEYS = frozenset(
    {"chat_error", "error", "detail", "message", "result", "content", "data", "output"}
)


def session_update_kind(update: Any) -> str | None:
    if not isinstance(update, dict):
        return None
    kind = update.get("sessionUpdate")
    return str(kind) if isinstance(kind, str) and kind else None


def tool_call_id(update: Any) -> str | None:
    if not isinstance(update, dict):
        return None
    return (
        str(
            update.get("toolCallId")
            or update.get("tool_call_id")
            or update.get("id")
            or ""
        ).strip()
        or None
    )


def is_anonymous_tool_call_update(name: object, update: Any) -> bool:
    """A ``tool_call_update`` whose tool could not be named but that has a call id."""
    if name is not None:
        return False
    return session_update_kind(update) == TOOL_CALL_UPDATE and bool(
        str((update or {}).get("toolCallId") or "").strip()
    )


def is_lifecycle_only_tool_update(text: object, update: Any) -> bool:
    """A tool start, or a status ping that carries no result payload."""
    kind = session_update_kind(update)
    if kind == TOOL_CALL:
        return True
    if kind != TOOL_CALL_UPDATE:
        return False
    if any(update.get(key) not in (None, "", [], {}) for key in _RESULT_PAYLOAD_KEYS):
        return False
    status = str(update.get("status") or "").strip().lower()
    body = str(text or "").strip().lower()
    return bool(status) and body in {status, f"{status}."}


def decode_tool_jsonish(text: str) -> Any | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    try:
        return json_loads_with_trailing_repair(raw)
    except ValueError:
        return None


def contains_freezone_canvas_bridge_result(value: Any) -> bool:
    """True when a tool update already carries a Freezone canvas bridge result."""
    if isinstance(value, str):
        decoded = decode_tool_jsonish(value)
        if decoded is None:
            return False
        return contains_freezone_canvas_bridge_result(decoded)
    if isinstance(value, list):
        return any(contains_freezone_canvas_bridge_result(item) for item in value)
    if not isinstance(value, dict):
        return False
    has_bridge_status = "tool_call_status" in value or "canvas_apply_status" in value
    has_bridge_body = (
        "command_results" in value
        or "applied_count" in value
        or "opened_ui_actions" in value
        or "created_node_ids" in value
        or "user_message" in value
        or "agent_instruction" in value
    )
    if has_bridge_status and has_bridge_body:
        return True
    return any(
        contains_freezone_canvas_bridge_result(child) for child in value.values()
    )


def is_transient_tool_failure(update: Any) -> bool:
    """A failed ``tool_call_update`` that is lifecycle noise or bridge-settled.

    Freezone canvas commands are resolved by the frontend bridge result, so a
    bare ``status=failed`` without a business payload, or one whose payload is
    the bridge result itself, must not become the canvas command's error.
    Whether to hide it is the surface's decision (see ``chat.service``).
    """
    if session_update_kind(update) != TOOL_CALL_UPDATE:
        return False
    if str(update.get("status") or "").strip().lower() not in _FAILED_STATUSES:
        return False
    if not any(key in update for key in _BUSINESS_PAYLOAD_KEYS):
        return True
    return contains_freezone_canvas_bridge_result(update)

"""Map agent runtime events to the chat stream's public event shape.

This module only builds payloads. The chat service still decides when to emit
them and owns session state, persistence, and canvas write evidence.
"""

from __future__ import annotations

from typing import Any


def _optional_id(value: object) -> str | None:
    return str(value or "").strip() or None


def lifecycle_event(event: Any) -> dict[str, Any]:
    """Build a thread or turn lifecycle payload shared by all runtimes."""
    kind = event.type
    if kind not in {"thread_started", "turn_started", "turn_completed"}:
        raise ValueError(f"unsupported lifecycle event: {kind}")
    payload: dict[str, Any] = {
        "type": kind,
        "thread_id": _optional_id(event.thread_id),
        "turn_id": _optional_id(event.turn_id),
    }
    if kind == "turn_started":
        payload["status"] = event.status or "in_progress"
    elif kind == "turn_completed":
        payload.update(
            status=event.status or "completed",
            error=event.error,
            disposition=event.disposition,
        )
    return payload


def progress_event(event: Any, *, include_details: bool = True) -> dict[str, Any]:
    """Build thought, plan, or usage payloads without changing runtime data."""
    kind = event.type
    if kind == "thought_delta":
        payload: dict[str, Any] = {"type": kind, "text": str(event.text or "")}
        if include_details:
            payload["source"] = event.name
        return payload
    if kind == "plan_update":
        payload = {"type": kind, "entries": event.entries or []}
        if include_details:
            payload["text"] = str(event.text or "")
        return payload
    if kind == "usage_update":
        return {"type": kind, "usage": event.usage or {}}
    raise ValueError(f"unsupported progress event: {kind}")


def sdk_tool_event(event: Any, *, text: str) -> dict[str, Any]:
    """Build the common Claude/Codex tool payload after service bookkeeping."""
    if event.type not in {"tool_started", "tool_updated"}:
        raise ValueError(f"unsupported SDK tool event: {event.type}")
    return {
        "type": event.type,
        "text": text.strip(),
        "name": event.name,
        "call_id": event.call_id,
        "status": event.status,
        "input": event.input,
        "output": event.output,
        "error": event.error,
        "result_json": event.structured,
    }


def _is_anonymous_hermes_tool_call_update(event: Any) -> bool:
    raw = getattr(event, "raw", None)
    if getattr(event, "name", None) is not None or not isinstance(raw, dict):
        return False
    return raw.get("sessionUpdate") == "tool_call_update" and bool(
        str(raw.get("toolCallId") or "").strip()
    )


def _is_hermes_lifecycle_tool_update(event: Any) -> bool:
    raw = getattr(event, "raw", None)
    if not isinstance(raw, dict):
        return False
    kind = raw.get("sessionUpdate")
    if kind == "tool_call":
        return True
    if kind != "tool_call_update":
        return False
    has_result_payload = any(
        raw.get(key) not in (None, "", [], {})
        for key in ("content", "result", "data", "output", "message", "error")
    )
    if has_result_payload:
        return False
    text = str(getattr(event, "text", "") or "").strip().lower()
    status = str(raw.get("status") or "").strip().lower()
    return bool(status) and text in {status, f"{status}."}

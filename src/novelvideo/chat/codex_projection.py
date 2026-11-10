"""Pure projection of Codex wire items into browser chat cards."""

import json
from datetime import datetime, timezone
from typing import Any, Sequence

from novelvideo.chat.codex_protocol import CodexItemRecord, CodexTurn
from novelvideo.chat.presentation_text import _redact_local_filesystem_paths

REASONING_TEXT_MAX_BYTES = 32 * 1024
TOOL_PREVIEW_MAX_BYTES = 2 * 1024


def _truncate(text: str, limit: int) -> str:
    return text.encode("utf-8")[:limit].decode("utf-8", "ignore")


def _redact_json(value: Any) -> Any:
    if isinstance(value, str):
        return _redact_local_filesystem_paths(value)
    if isinstance(value, list):
        return [_redact_json(entry) for entry in value]
    if isinstance(value, dict):
        return {
            _redact_local_filesystem_paths(key): _redact_json(entry)
            for key, entry in value.items()
        }
    return value


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _tool_input(arguments: Any) -> Any:
    encoded = _compact_json(arguments)
    if len(encoded.encode("utf-8")) <= TOOL_PREVIEW_MAX_BYTES:
        return _redact_json(arguments)
    return _truncate(_redact_local_filesystem_paths(encoded), TOOL_PREVIEW_MAX_BYTES)


def _tool_result(structured: dict[str, Any] | None) -> dict[str, Any] | None:
    if structured is None:
        return None
    if len(_compact_json(structured).encode("utf-8")) <= TOOL_PREVIEW_MAX_BYTES:
        return _redact_json(structured)
    return {
        key: _truncate(_redact_local_filesystem_paths(value), 512)
        if isinstance(value, str) else value
        for key, value in structured.items()
        if key in {"ok", "status", "code", "error", "message", "user_message"}
        and (value is None or isinstance(value, (str, int, float, bool)))
    }


def _tool_error(item: dict[str, Any], structured: dict[str, Any] | None) -> str:
    item_type = item["type"]
    if item_type == "mcpToolCall":
        message = (item.get("error") or {}).get("message")
        if isinstance(message, str) and message.strip():
            return message
        for key in ("user_message", "message", "error"):
            message = (structured or {}).get(key)
            if isinstance(message, str) and message.strip():
                return message
    if item_type == "commandExecution" and item.get("exitCode") not in (None, 0):
        return f"exit code {item['exitCode']}"
    if item_type == "dynamicToolCall":
        return "dynamic tool call failed"
    if item.get("status") == "declined":
        return "declined"
    return "failed"


def _tool_event(
    item: dict[str, Any], *, turn_id: str, started_at_ms: int | None, completed: bool
) -> dict[str, Any]:
    item_type = item["type"]
    structured = (item.get("result") or {}).get("structuredContent")
    if item_type != "mcpToolCall" or not isinstance(structured, dict):
        structured = None
    tool_input = None
    if item_type == "commandExecution":
        name = "command_execution"
        preview = item.get("aggregatedOutput") or ""
        tool_input = {"command": _redact_local_filesystem_paths(item.get("command") or "")}
    elif item_type == "mcpToolCall":
        name = ".".join(
            part.strip() for part in (item.get("server"), item.get("tool"))
            if part and part.strip()
        )
        preview = "\n".join(
            entry["text"] for entry in (item.get("result") or {}).get("content", [])
            if entry.get("type") == "text" and isinstance(entry.get("text"), str)
        )
        tool_input = _tool_input(item.get("arguments"))
    elif item_type == "dynamicToolCall":
        name = item.get("tool") or ""
        preview = "\n".join(
            entry["text"] for entry in item.get("contentItems") or []
            if isinstance(entry.get("text"), str)
        )
        tool_input = _tool_input(item.get("arguments"))
    elif item_type == "fileChange":
        name = "file_change"
        preview = "\n".join(entry.get("path") or "" for entry in item.get("changes") or [])
    elif item_type == "webSearch":
        name = "web_search"
        preview = item.get("query") or ""
    else:
        name = "view_image"
        preview = item.get("path") or ""

    wire_status = item.get("status", "completed" if completed else "inProgress")
    status = {"inProgress": "in_progress", "declined": "cancelled"}.get(wire_status, wire_status)
    if (
        (item_type == "mcpToolCall" and (
            item.get("error") is not None
            or (structured is not None and structured.get("ok") is False)
        ))
        or (item_type == "commandExecution" and item.get("exitCode") not in (None, 0))
        or (item_type == "dynamicToolCall" and item.get("success") is False)
    ):
        status = "failed"
    error = None
    if status in {"failed", "cancelled"}:
        error = _truncate(
            _redact_local_filesystem_paths(_tool_error(item, structured)), TOOL_PREVIEW_MAX_BYTES
        )
    name = _redact_local_filesystem_paths(name)
    preview = _truncate(
        _redact_local_filesystem_paths(preview).rstrip(), TOOL_PREVIEW_MAX_BYTES
    )
    return {
        "id": f"agent-tool-{item['id']}",
        "role": "tool",
        "text": f"{name}\n\n{preview}" if preview else name,
        "turnId": turn_id,
        "timestamp": started_at_ms or 0,
        "raw": {
            "type": "agent.tool.updated",
            "turn_id": turn_id,
            "call_id": item["id"],
            "name": name,
            "status": status,
            "input": tool_input,
            "text": preview,
            "error": error,
            "result_json": _tool_result(structured),
            "duration_ms": item.get("durationMs"),
        },
    }


def project_item(
    item: dict[str, Any], *, turn_id: str, started_at_ms: int | None, completed: bool
) -> dict[str, Any] | None:
    """Project one wire item using the business turn ID known to the browser."""
    card: dict[str, Any] = {"id": item["id"]}
    if started_at_ms is not None:
        card["seq"] = started_at_ms
    item_type = item["type"]
    if item_type == "agentMessage":
        text = item.get("text") or ""
        if not text.strip():
            return None
        card.update(type="text", text=_redact_local_filesystem_paths(text))
    elif item_type == "reasoning":
        text = "\n\n".join(entry for entry in item.get("summary") or [] if entry.strip())
        if not text:
            return None
        card.update(type="agent_thought", event={
            "type": "agent.thought",
            "turn_id": turn_id,
            "text": _redact_local_filesystem_paths(_truncate(text, REASONING_TEXT_MAX_BYTES)),
            "status": "completed" if completed else "running",
            "truncated": len(text.encode("utf-8")) > REASONING_TEXT_MAX_BYTES,
        })
    elif item_type in {
        "commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch", "imageView"
    }:
        card.update(type="tool_status", event=_tool_event(
            item, turn_id=turn_id, started_at_ms=started_at_ms, completed=completed
        ))
    elif item_type == "contextCompaction":
        card.update(type="context_compaction", event={
            "type": "context_compaction",
            "turn_id": turn_id,
            "status": "completed" if completed else "running",
        })
    else:
        return None
    return card


def business_turn_id(codex_turn_id: str, records: Sequence[CodexItemRecord]) -> str:
    """Prefer the first nonblank user client ID to the Codex turn ID."""
    for record in records:
        client_id = record.item.get("clientId")
        if (
            record.item["type"] == "userMessage"
            and isinstance(client_id, str)
            and client_id.strip()
        ):
            return client_id
    return codex_turn_id


def project_turn(turn: CodexTurn, records: Sequence[CodexItemRecord]) -> dict[str, Any] | None:
    """Project a turn's completed or live items in stable timestamp order."""
    turn_id = business_turn_id(turn.id, records)
    cards = []
    for record in sorted(records, key=lambda r: (r.started_at_ms is None, r.started_at_ms)):
        card = project_item(
            record.item,
            turn_id=turn_id,
            started_at_ms=record.started_at_ms,
            completed=record.completed_at_ms is not None or turn.status != "inProgress",
        )
        if card is not None:
            cards.append(card)
    if not cards:
        return None
    return {
        "id": f"assistant:{turn.id}",
        "role": "assistant",
        "content": "\n\n".join(card["text"] for card in cards if card["type"] == "text"),
        "media": [],
        "attachments": [],
        "turn_id": turn_id,
        "created_at": datetime.fromtimestamp(turn.started_at, timezone.utc).isoformat()
        if turn.started_at is not None else "",
        "parts": cards,
        "ui_events": [],
    }

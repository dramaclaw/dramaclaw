from __future__ import annotations

import asyncio
import json
import threading
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Literal, Protocol, runtime_checkable


@dataclass(slots=True)
class ChatBackendEvent:
    type: Literal[
        "thread_started",
        "turn_started",
        "turn_completed",
        "assistant_delta",
        "thought_delta",
        "plan_update",
        "tool_started",
        "tool_updated",
        "tool_update",
        "permission_requested",
        "usage_update",
        "complete",
        # Internal lifecycle signals. They never reach a WebSocket, a chat
        # transcript or model text; the streaming loop already carries turn
        # boundaries, and the egress ledger needs to know exactly where the
        # request crossed into the agent.
        "egress_submitted",
        "egress_disposition",
    ]
    thread_id: str | None = None
    turn_id: str | None = None
    #: Set on ``egress_disposition`` only. States how the turn ended, because
    #: ``complete`` is also synthesised for timeouts and cannot prove success.
    disposition: str | None = None
    text: str | None = None
    name: str | None = None
    call_id: str | None = None
    status: str | None = None
    input: Any | None = None
    output: Any | None = None
    error: Any | None = None
    request_id: str | int | None = None
    options: list[dict[str, Any]] | None = None
    entries: list[dict[str, Any]] | None = None
    usage: dict[str, Any] | None = None
    structured: Any | None = None
    raw: Any | None = None


@dataclass(slots=True)
class ChatRunResult:
    thread_id: str
    text: str


@runtime_checkable
class AgentRuntimeThreadPort(Protocol):
    """Stable DramaClaw boundary implemented by Codex, Hermes, and Claude."""

    id: str | None

    def stream(self, prompt: str) -> AsyncIterator[ChatBackendEvent]: ...


_LIVE_CODEX_TURNS: dict[tuple[str, str], Any] = {}
_LIVE_CODEX_TURNS_LOCK = threading.Lock()
_INTERRUPTED_CODEX_TURNS: set[tuple[str, str]] = set()
_LIVE_CLAUDE_CLIENTS: dict[str, Any] = {}
_INTERRUPTED_CLAUDE_CLIENTS: set[str] = set()


def register_live_codex_turn(thread_id: str, turn_id: str, turn_handle: Any) -> None:
    key = (str(thread_id or "").strip(), str(turn_id or "").strip())
    if not key[0] or not key[1]:
        return
    with _LIVE_CODEX_TURNS_LOCK:
        _LIVE_CODEX_TURNS[key] = turn_handle


def unregister_live_codex_turn(thread_id: str, turn_id: str) -> None:
    key = (str(thread_id or "").strip(), str(turn_id or "").strip())
    if not key[0] or not key[1]:
        return
    with _LIVE_CODEX_TURNS_LOCK:
        _LIVE_CODEX_TURNS.pop(key, None)


def interrupt_live_codex_turn(thread_id: str, turn_id: str) -> bool:
    key = (str(thread_id or "").strip(), str(turn_id or "").strip())
    if not key[0] or not key[1]:
        return False
    with _LIVE_CODEX_TURNS_LOCK:
        turn_handle = _LIVE_CODEX_TURNS.get(key)
        if turn_handle is not None:
            _INTERRUPTED_CODEX_TURNS.add(key)
    if turn_handle is None:
        return False
    turn_handle.interrupt()
    return True


def consume_interrupted_codex_turn(thread_id: str, turn_id: str) -> bool:
    key = (str(thread_id or "").strip(), str(turn_id or "").strip())
    if not key[0] or not key[1]:
        return False
    with _LIVE_CODEX_TURNS_LOCK:
        if key not in _INTERRUPTED_CODEX_TURNS:
            return False
        _INTERRUPTED_CODEX_TURNS.discard(key)
        return True


def register_live_claude_client(thread_id: str, client: Any) -> None:
    key = str(thread_id or "").strip()
    if not key:
        return
    with _LIVE_CODEX_TURNS_LOCK:
        _LIVE_CLAUDE_CLIENTS[key] = client


def unregister_live_claude_client(thread_id: str) -> None:
    key = str(thread_id or "").strip()
    if not key:
        return
    with _LIVE_CODEX_TURNS_LOCK:
        _LIVE_CLAUDE_CLIENTS.pop(key, None)


async def interrupt_live_claude_client(thread_id: str) -> bool:
    key = str(thread_id or "").strip()
    if not key:
        return False
    with _LIVE_CODEX_TURNS_LOCK:
        client = _LIVE_CLAUDE_CLIENTS.get(key)
    if client is None:
        return False
    await client.interrupt()
    with _LIVE_CODEX_TURNS_LOCK:
        _INTERRUPTED_CLAUDE_CLIENTS.add(key)
    return True


def consume_interrupted_claude_client(thread_id: str) -> bool:
    key = str(thread_id or "").strip()
    if not key:
        return False
    with _LIVE_CODEX_TURNS_LOCK:
        if key not in _INTERRUPTED_CLAUDE_CLIENTS:
            return False
        _INTERRUPTED_CLAUDE_CLIENTS.discard(key)
        return True


def _extract_claude_text(data: dict[str, Any]) -> str | None:
    if data.get("type") == "result" and data.get("subtype") == "success":
        result = data.get("result")
        return result if isinstance(result, str) else None

    if data.get("type") != "assistant":
        return None

    message = data.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if not isinstance(content, list):
        return None

    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(part for part in parts if part).strip() or None


def _parse_claude_stream_event(data: dict[str, Any]) -> dict[str, Any] | None:
    if data.get("type") != "stream_event":
        return None

    event = data.get("event")
    if not isinstance(event, dict):
        return None

    event_type = event.get("type")
    if event_type == "content_block_delta":
        delta = event.get("delta")
        if isinstance(delta, dict) and delta.get("type") == "text_delta":
            text = delta.get("text")
            if isinstance(text, str) and text:
                return {"type": "text_delta", "text": text}
        if isinstance(delta, dict) and delta.get("type") == "input_json_delta":
            partial = delta.get("partial_json")
            if isinstance(partial, str):
                return {"type": "tool_input_delta", "text": partial}

    if event_type == "content_block_start":
        block = event.get("content_block")
        if isinstance(block, dict) and block.get("type") == "tool_use":
            name = block.get("name") if isinstance(block.get("name"), str) else "Tool"
            tool_id = block.get("id") if isinstance(block.get("id"), str) else ""
            return {"type": "tool_start", "name": name, "tool_id": tool_id}

    return None


def _codex_final_response_from_items(items: list[Any]) -> str | None:
    from openai_codex.generated.v2_all import AgentMessageThreadItem, MessagePhase

    last_unknown_phase_response: str | None = None
    for item in reversed(items):
        thread_item = item.root if hasattr(item, "root") else item
        if not isinstance(thread_item, AgentMessageThreadItem):
            continue
        if thread_item.phase == MessagePhase.final_answer:
            return thread_item.text
        if thread_item.phase is None and last_unknown_phase_response is None:
            last_unknown_phase_response = thread_item.text
    return last_unknown_phase_response


def _codex_unwrap_item(item: Any) -> Any:
    return item.root if hasattr(item, "root") else item


def _codex_jsonable(value: Any) -> Any:
    """Return a JSON-safe SDK payload without leaking SDK model types outward."""

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return model_dump(mode="json", by_alias=True, warnings=False)
        except (TypeError, ValueError):
            return model_dump(by_alias=True)
    if isinstance(value, dict):
        return {str(key): _codex_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_codex_jsonable(item) for item in value]
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, (str, int, float, bool)):
        return enum_value
    return str(value)


def _codex_raw_notification(event: Any) -> dict[str, Any]:
    """Keep Codex-specific wire data server-side for diagnostics and evidence."""

    return {
        "runtime": "codex",
        "method": str(getattr(event, "method", "") or ""),
        "params": _codex_jsonable(getattr(event, "payload", None)),
    }


def _codex_tool_event(
    item: Any,
    *,
    phase: Literal["started", "completed"],
    thread_id: str,
    turn_id: str,
    raw: dict[str, Any],
) -> ChatBackendEvent | None:
    """Map Codex tool-like ThreadItems onto the runtime-neutral lifecycle."""

    thread_item = _codex_unwrap_item(item)
    item_type = str(getattr(thread_item, "type", "") or "")
    if item_type not in {
        "collabAgentToolCall",
        "commandExecution",
        "dynamicToolCall",
        "fileChange",
        "imageGeneration",
        "imageView",
        "mcpToolCall",
        "sleep",
        "webSearch",
    }:
        return None

    call_id = str(getattr(thread_item, "id", "") or "").strip() or None
    status_obj = getattr(thread_item, "status", None)
    status = str(getattr(status_obj, "value", status_obj or "") or "").strip()
    if not status:
        status = "pending" if phase == "started" else "completed"

    name = item_type
    tool_input: Any = None
    output: Any = None
    error: Any = None
    structured: Any = None
    if item_type == "mcpToolCall":
        name = ".".join(
            part
            for part in [
                str(getattr(thread_item, "server", "") or "").strip(),
                str(getattr(thread_item, "tool", "") or "").strip(),
            ]
            if part
        ) or item_type
        tool_input = _codex_jsonable(getattr(thread_item, "arguments", None))
        result = getattr(thread_item, "result", None)
        output = _codex_jsonable(result)
        structured = _codex_jsonable(getattr(result, "structured_content", None))
        error = _codex_jsonable(getattr(thread_item, "error", None))
    elif item_type == "dynamicToolCall":
        name = str(getattr(thread_item, "tool", "") or item_type)
        tool_input = _codex_jsonable(getattr(thread_item, "arguments", None))
        output = _codex_jsonable(getattr(thread_item, "content_items", None))
        if getattr(thread_item, "success", None) is False:
            error = {"message": "dynamic tool call failed"}
    elif item_type == "collabAgentToolCall":
        tool = getattr(thread_item, "tool", None)
        name = f"collab.{getattr(tool, 'value', tool or 'agent')}"
        tool_input = {
            "prompt": getattr(thread_item, "prompt", None),
            "model": getattr(thread_item, "model", None),
        }
        output = _codex_jsonable(getattr(thread_item, "agents_states", None))
    elif item_type == "commandExecution":
        name = "command_execution"
        tool_input = {
            "command": getattr(thread_item, "command", None),
            "cwd": _codex_jsonable(getattr(thread_item, "cwd", None)),
        }
        output = {
            "aggregated_output": getattr(thread_item, "aggregated_output", None),
            "exit_code": getattr(thread_item, "exit_code", None),
        }
        if getattr(thread_item, "exit_code", None) not in (None, 0):
            error = {"exit_code": getattr(thread_item, "exit_code", None)}
    elif item_type == "fileChange":
        name = "file_change"
        output = _codex_jsonable(getattr(thread_item, "changes", None))
    elif item_type == "webSearch":
        name = "web_search"
        tool_input = {"query": getattr(thread_item, "query", None)}
        output = _codex_jsonable(getattr(thread_item, "results", None))
    elif item_type == "imageView":
        name = "view_image"
        tool_input = {"path": _codex_jsonable(getattr(thread_item, "path", None))}
    elif item_type == "imageGeneration":
        name = "image_generation"
        output = {
            "result": getattr(thread_item, "result", None),
            "saved_path": _codex_jsonable(getattr(thread_item, "saved_path", None)),
            "revised_prompt": getattr(thread_item, "revised_prompt", None),
        }
        error = _codex_jsonable(getattr(thread_item, "failure", None))
    elif item_type == "sleep":
        name = "sleep"
        tool_input = {"duration_ms": getattr(thread_item, "duration_ms", None)}

    trace = (
        _codex_item_started_trace(thread_item)
        if phase == "started"
        else _codex_item_completed_trace(thread_item)
    )
    if not trace:
        verb = "Running" if phase == "started" else status
        trace = f"\x1b[90m[{verb}]\x1b[0m {name}\n"
    return ChatBackendEvent(
        type="tool_started" if phase == "started" else "tool_updated",
        thread_id=thread_id,
        turn_id=turn_id,
        text=trace,
        name=name,
        call_id=call_id,
        status=status,
        input=tool_input,
        output=output,
        error=error,
        structured=structured,
        raw=raw,
    )


def _codex_item_started_trace(item: Any) -> str | None:
    from openai_codex.generated.v2_all import (
        CollabAgentToolCallThreadItem,
        CommandExecutionThreadItem,
        DynamicToolCallThreadItem,
        McpToolCallThreadItem,
    )

    thread_item = _codex_unwrap_item(item)
    if isinstance(thread_item, CommandExecutionThreadItem):
        return None
    if isinstance(thread_item, McpToolCallThreadItem):
        tool = f"{thread_item.server}.{thread_item.tool}".strip(".")
        return f"\x1b[90m• Running MCP\x1b[0m {tool}\n"
    if isinstance(thread_item, DynamicToolCallThreadItem):
        tool = (thread_item.tool or "").strip()
        if tool:
            return f"\x1b[90m• Running tool\x1b[0m {tool}\n"
    if isinstance(thread_item, CollabAgentToolCallThreadItem):
        tool = (thread_item.tool or "").strip()
        model = (thread_item.model or "").strip()
        if tool or model:
            details = " ".join(part for part in [tool, model] if part)
            return f"\x1b[90m• Running agent\x1b[0m {details}\n"
    return None


def _codex_item_completed_trace(item: Any) -> str | None:
    from openai_codex.generated.v2_all import (
        CommandExecutionThreadItem,
        DynamicToolCallThreadItem,
        FileChangeThreadItem,
        McpToolCallThreadItem,
    )

    thread_item = _codex_unwrap_item(item)
    if isinstance(thread_item, CommandExecutionThreadItem):
        command = (thread_item.command or "").strip()
        exit_code = thread_item.exit_code
        lines = [f"\x1b[90m• Ran {command or 'command'}\x1b[0m"]
        if exit_code not in (None, 0):
            lines.append(f"\x1b[91m[exit {exit_code}]\x1b[0m")
        return "\n".join(lines) + "\n"
    if isinstance(thread_item, McpToolCallThreadItem):
        tool = f"{thread_item.server}.{thread_item.tool}".strip(".")
        status = getattr(thread_item.status, "value", str(thread_item.status or ""))
        return f"\x1b[90m[mcp:{status}]\x1b[0m {tool}\n" if tool else None
    if isinstance(thread_item, DynamicToolCallThreadItem):
        tool = (thread_item.tool or "").strip()
        status = getattr(thread_item.status, "value", str(thread_item.status or ""))
        return f"\x1b[90m[tool:{status}]\x1b[0m {tool}\n" if tool else None
    if isinstance(thread_item, FileChangeThreadItem):
        lines: list[str] = []
        for change in thread_item.changes[:8]:
            path = str(getattr(change, "path", "") or "").strip()
            if not path:
                continue
            kind_obj = getattr(change, "kind", None)
            kind = str(getattr(kind_obj, "type", "") or "").strip().lower()
            marker = {
                "added": "\x1b[92mA\x1b[0m",
                "created": "\x1b[92mA\x1b[0m",
                "add": "\x1b[92mA\x1b[0m",
                "modified": "\x1b[93mM\x1b[0m",
                "updated": "\x1b[93mM\x1b[0m",
                "update": "\x1b[93mM\x1b[0m",
                "deleted": "\x1b[91mD\x1b[0m",
                "removed": "\x1b[91mD\x1b[0m",
                "delete": "\x1b[91mD\x1b[0m",
            }.get(kind, "\x1b[94m•\x1b[0m")
            lines.append(f"  {marker} {path}")
            diff = str(getattr(change, "diff", "") or "").strip()
            if diff:
                preview_lines: list[str] = []
                for raw in diff.splitlines():
                    if raw.startswith(("+++", "---", "@@")):
                        continue
                    if raw.startswith("+"):
                        preview_lines.append(f"    \x1b[92m{raw[:120]}\x1b[0m")
                    elif raw.startswith("-"):
                        preview_lines.append(f"    \x1b[91m{raw[:120]}\x1b[0m")
                    if len(preview_lines) >= 4:
                        break
                lines.extend(preview_lines)
            move_path = str(getattr(kind_obj, "move_path", "") or "").strip()
            if move_path:
                lines.append(f"    \x1b[90m→ {move_path}\x1b[0m")
        if not lines:
            return None
        extra = ""
        if len(thread_item.changes) > 8:
            extra = f"\n  \x1b[90m… +{len(thread_item.changes) - 8} more\x1b[0m"
        return "\x1b[95m[files]\x1b[0m\n" + "\n".join(lines) + extra + "\n"
    return None


def _codex_plan_trace(explanation: str | None, plan: list[Any]) -> str | None:
    lines: list[str] = []
    if explanation:
        lines.append(f"\x1b[95m[plan]\x1b[0m {explanation.strip()}")
    else:
        lines.append("\x1b[95m[plan]\x1b[0m")
    for step in plan:
        status = getattr(getattr(step, "status", None), "value", str(getattr(step, "status", "") or "")).strip()
        step_text = str(getattr(step, "step", "") or "").strip()
        if not step_text:
            continue
        marker = {
            "completed": "\x1b[92m✓\x1b[0m",
            "in_progress": "\x1b[93m→\x1b[0m",
            "pending": "\x1b[90m·\x1b[0m",
        }.get(status, "\x1b[94m•\x1b[0m")
        lines.append(f"  {marker} {step_text}")
    return "\n".join(lines) + "\n" if lines else None


def _codex_guardian_review_trace(label: str, review: Any) -> str | None:
    status = getattr(getattr(review, "status", None), "value", str(getattr(review, "status", "") or "")).strip()
    score = getattr(review, "risk_score", None)
    rationale = str(getattr(review, "rationale", "") or "").strip()
    parts = [part for part in [status, f"risk={score}" if score is not None else ""] if part]
    text = f"\x1b[91m[{label}]\x1b[0m {' '.join(parts)}".rstrip()
    if rationale:
        text += f" — {rationale}"
    return text + "\n"


def _colorize_unified_diff(diff: str) -> str:
    lines: list[str] = []
    for raw in diff.splitlines():
        if raw.startswith(("diff --git", "index ")):
            lines.append(f"\x1b[90m{raw}\x1b[0m")
        elif raw.startswith(("--- ", "+++ ")):
            lines.append(f"\x1b[36m{raw}\x1b[0m")
        elif raw.startswith("@@"):
            lines.append(f"\x1b[95m{raw}\x1b[0m")
        elif raw.startswith("+"):
            lines.append(f"\x1b[92m{raw}\x1b[0m")
        elif raw.startswith("-"):
            lines.append(f"\x1b[91m{raw}\x1b[0m")
        else:
            lines.append(raw)
    return "\n".join(lines)


def _extract_claude_sdk_assistant_text(message: Any) -> str | None:
    content = getattr(message, "content", None)
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text:
            parts.append(text)
    return "\n".join(parts).strip() or None


def _summarize_claude_tool_payload(payload: Any) -> str:
    if not isinstance(payload, dict) or not payload:
        return ""
    keys = [str(key).strip() for key in payload.keys() if str(key).strip()]
    if not keys:
        return ""
    preview = ", ".join(keys[:3])
    if len(keys) > 3:
        preview += ", ..."
    return preview


def _format_claude_tool_use_block(block: Any) -> tuple[str, str] | None:
    tool_id = str(getattr(block, "id", "") or "").strip()
    tool_name = str(getattr(block, "name", "") or "").strip()
    if not tool_id or not tool_name:
        return None
    payload_summary = _summarize_claude_tool_payload(getattr(block, "input", None))
    if payload_summary:
        text = f"[tool:start] {tool_name} ({payload_summary})\n"
    else:
        text = f"[tool:start] {tool_name}\n"
    return (f"tool_use:{tool_id}", text)


def _format_claude_tool_result_block(block: Any) -> tuple[str, str] | None:
    tool_use_id = str(getattr(block, "tool_use_id", "") or "").strip()
    if not tool_use_id:
        return None
    is_error = bool(getattr(block, "is_error", False))
    content = getattr(block, "content", None)
    summary = ""
    if isinstance(content, str):
        summary = content.strip().replace("\r\n", "\n").replace("\r", "\n")
    elif isinstance(content, list) and content:
        first = content[0]
        if isinstance(first, dict):
            summary = str(first.get("text", "") or first.get("content", "") or "").strip()
    if summary:
        summary = summary.splitlines()[0].strip()
        if len(summary) > 120:
            summary = summary[:117].rstrip() + "..."
    label = "tool:error" if is_error else "tool:done"
    text = f"[{label}] {tool_use_id}"
    if summary:
        text += f" — {summary}"
    return (f"tool_result:{tool_use_id}", text + "\n")


def _collect_claude_message_traces(message: Any) -> list[tuple[str, str]]:
    content = getattr(message, "content", None)
    if not isinstance(content, list):
        return []
    traces: list[tuple[str, str]] = []
    for block in content:
        trace = _format_claude_tool_use_block(block)
        if trace:
            traces.append(trace)
            continue
        trace = _format_claude_tool_result_block(block)
        if trace:
            traces.append(trace)
    return traces


def _extract_claude_sdk_session_id(payload: Any) -> str | None:
    if isinstance(payload, dict):
        for key in ("session_id", "sessionId", "id"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None
    for key in ("session_id", "sessionId", "id"):
        value = getattr(payload, key, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _format_claude_system_trace(message: Any) -> str | None:
    subtype = str(getattr(message, "subtype", "") or "").strip()
    data = getattr(message, "data", None)
    if subtype == "task_started":
        description = str(getattr(message, "description", "") or "").strip()
        task_type = str(getattr(message, "task_type", "") or "").strip()
        label = task_type or "task"
        if description:
            return f"[task:start] {label} — {description}\n"
        return f"[task:start] {label}\n"
    if subtype == "task_progress":
        description = str(getattr(message, "description", "") or "").strip()
        last_tool_name = str(getattr(message, "last_tool_name", "") or "").strip()
        if description and last_tool_name:
            return f"[task:progress] {last_tool_name} — {description}\n"
        if description:
            return f"[task:progress] {description}\n"
        if last_tool_name:
            return f"[tool] {last_tool_name}\n"
        return None
    if subtype == "task_notification":
        status = str(getattr(getattr(message, "status", None), "value", getattr(message, "status", "")) or "").strip()
        summary = str(getattr(message, "summary", "") or "").strip()
        output_file = str(getattr(message, "output_file", "") or "").strip()
        text = f"[task:{status or 'update'}]"
        if summary:
            text += f" {summary}"
        if output_file:
            text += f"\n[file] {output_file}"
        return text.rstrip() + "\n"
    if subtype in {"init", "initialized", "ready"}:
        return None
    if subtype:
        parts: list[str] = []
        if isinstance(data, dict):
            for key in ("message", "summary", "description"):
                value = str(data.get(key, "") or "").strip()
                if value:
                    parts.append(value)
                    break
        if not parts:
            return None
        suffix = f" {' — '.join(parts)}"
        return f"[system:{subtype}]{suffix}\n"
    return None


class ClaudeSdkClient:
    def __init__(self, *, cli_path: Path, cwd: Path, env: dict[str, str], model: str | None) -> None:
        self._cli_path = cli_path
        self._cwd = cwd
        self._env = env
        self._model = str(model or "").strip() or None

    def thread_start(self) -> "ClaudeSdkThread":
        return ClaudeSdkThread(
            cli_path=self._cli_path,
            cwd=self._cwd,
            env=self._env,
            model=self._model,
            thread_id=None,
            is_new=True,
        )

    def thread_resume(self, thread_id: str) -> "ClaudeSdkThread":
        return ClaudeSdkThread(
            cli_path=self._cli_path,
            cwd=self._cwd,
            env=self._env,
            model=self._model,
            thread_id=thread_id,
            is_new=False,
        )


class ClaudeSdkThread:
    def __init__(
        self,
        *,
        cli_path: Path,
        cwd: Path,
        env: dict[str, str],
        model: str | None,
        thread_id: str | None,
        is_new: bool,
    ) -> None:
        self._cli_path = cli_path
        self._cwd = cwd
        self._env = env
        self._model = str(model or "").strip() or None
        self.id = str(thread_id or "").strip()
        self._is_new = is_new

    async def stream(self, prompt: str) -> AsyncIterator[ChatBackendEvent]:
        try:
            from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
            from claude_agent_sdk.types import (
                AssistantMessage,
                ResultMessage,
                StreamEvent,
                SystemMessage,
                TaskNotificationMessage,
                TaskProgressMessage,
                TaskStartedMessage,
                UserMessage,
            )
        except ImportError as exc:
            raise RuntimeError("claude-agent-sdk is not installed") from exc

        options = ClaudeAgentOptions(
            cwd=str(self._cwd),
            cli_path=str(self._cli_path),
            env=self._env,
            include_partial_messages=True,
            permission_mode="bypassPermissions",
            tools={"type": "preset", "preset": "claude_code"},
            system_prompt={"type": "preset", "preset": "claude_code"},
            setting_sources=["user", "project", "local"],
            model=self._model,
            resume=(self.id or None) if not self._is_new else None,
        )

        client = ClaudeSDKClient(options=options)
        assistant_parts: list[str] = []
        tool_lines: list[str] = []
        seen_tool_traces: set[str] = set()
        final_result: str | None = None
        provisional_id = self.id
        try:
            await client.connect()
            server_info = await client.get_server_info()
            session_id = _extract_claude_sdk_session_id(server_info)
            if session_id:
                self.id = session_id
            elif not self.id:
                self.id = f"claude-{id(client)}"

            provisional_id = self.id
            register_live_claude_client(self.id, client)
            yield ChatBackendEvent(type="thread_started", thread_id=self.id)

            await client.query(prompt)

            async for message in client.receive_response():
                if isinstance(message, StreamEvent):
                    stream_event = _parse_claude_stream_event(getattr(message, "event", None) or {})
                    if stream_event:
                        if stream_event["type"] == "text_delta":
                            assistant_parts.append(stream_event["text"])
                            yield ChatBackendEvent(
                                type="assistant_delta",
                                thread_id=self.id,
                                text="".join(assistant_parts),
                            )
                        elif stream_event["type"] == "tool_start":
                            tool_lines.append(f"调用工具：{stream_event['name']}")
                            yield ChatBackendEvent(
                                type="tool_update",
                                thread_id=self.id,
                                text="\n".join(tool_lines),
                            )
                        elif stream_event["type"] == "tool_input_delta" and tool_lines:
                            tool_lines[-1] = tool_lines[-1] + stream_event["text"]
                            yield ChatBackendEvent(
                                type="tool_update",
                                thread_id=self.id,
                                text="\n".join(tool_lines),
                            )
                    continue

                if isinstance(
                    message,
                    (TaskStartedMessage, TaskProgressMessage, TaskNotificationMessage, SystemMessage),
                ):
                    trace = _format_claude_system_trace(message)
                    if trace:
                        tool_lines.append(trace.rstrip("\n"))
                        yield ChatBackendEvent(
                            type="tool_update",
                            thread_id=self.id,
                            text="\n".join(tool_lines),
                        )
                    continue

                if isinstance(message, AssistantMessage):
                    for trace_key, trace_text in _collect_claude_message_traces(message):
                        if trace_key in seen_tool_traces:
                            continue
                        seen_tool_traces.add(trace_key)
                        tool_lines.append(trace_text.rstrip("\n"))
                        yield ChatBackendEvent(
                            type="tool_update",
                            thread_id=self.id,
                            text="\n".join(tool_lines),
                        )
                    extracted = _extract_claude_sdk_assistant_text(message)
                    if extracted:
                        final_result = extracted
                    continue

                if isinstance(message, UserMessage):
                    for trace_key, trace_text in _collect_claude_message_traces(message):
                        if trace_key in seen_tool_traces:
                            continue
                        seen_tool_traces.add(trace_key)
                        tool_lines.append(trace_text.rstrip("\n"))
                        yield ChatBackendEvent(
                            type="tool_update",
                            thread_id=self.id,
                            text="\n".join(tool_lines),
                        )
                    continue

                if isinstance(message, ResultMessage):
                    session_id = _extract_claude_sdk_session_id(message)
                    if session_id and session_id != self.id:
                        unregister_live_claude_client(self.id)
                        self.id = session_id
                        register_live_claude_client(self.id, client)
                    if isinstance(message.result, str) and message.result.strip():
                        final_result = message.result.strip()
                    interrupted = consume_interrupted_claude_client(self.id)
                    if interrupted:
                        yield ChatBackendEvent(
                            type="complete",
                            thread_id=self.id,
                            text=(final_result or "".join(assistant_parts)).strip() or "已中断。",
                        )
                        return

            assistant_text = (final_result or "".join(assistant_parts)).strip() or "已执行，但没有返回正文。"
            yield ChatBackendEvent(type="complete", thread_id=self.id, text=assistant_text)
        finally:
            unregister_live_claude_client(self.id or provisional_id)
            try:
                await client.disconnect()
            except Exception:
                pass

    async def run(self, prompt: str) -> ChatRunResult:
        text = ""
        async for event in self.stream(prompt):
            if event.type == "complete":
                text = event.text or ""
        return ChatRunResult(thread_id=self.id, text=text)


class ClaudeCliClient:
    def __init__(self, *, cli_path: Path, cwd: Path, env: dict[str, str]) -> None:
        self._cli_path = cli_path
        self._cwd = cwd
        self._env = env

    def thread_start(self, thread_id: str) -> "ClaudeCliThread":
        return ClaudeCliThread(
            cli_path=self._cli_path,
            cwd=self._cwd,
            env=self._env,
            thread_id=thread_id,
            is_new=True,
        )

    def thread_resume(self, thread_id: str) -> "ClaudeCliThread":
        return ClaudeCliThread(
            cli_path=self._cli_path,
            cwd=self._cwd,
            env=self._env,
            thread_id=thread_id,
            is_new=False,
        )


class ClaudeCliThread:
    def __init__(
        self,
        *,
        cli_path: Path,
        cwd: Path,
        env: dict[str, str],
        thread_id: str,
        is_new: bool,
    ) -> None:
        self._cli_path = cli_path
        self._cwd = cwd
        self._env = env
        self.id = thread_id
        self._is_new = is_new

    async def stream(self, prompt: str) -> AsyncIterator[ChatBackendEvent]:
        if not self._cli_path.exists():
            raise RuntimeError(f"Claude CLI not found: {self._cli_path}")

        cmd = [str(self._cli_path)]
        if self._is_new:
            cmd.extend(["--session-id", self.id])
        else:
            cmd.extend(["--resume", self.id])
        cmd.extend(
            [
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--dangerously-skip-permissions",
                "-p",
                prompt,
            ]
        )

        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(self._cwd),
            env=self._env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        yield ChatBackendEvent(type="thread_started", thread_id=self.id)

        assistant_parts: list[str] = []
        tool_lines: list[str] = []
        final_result: str | None = None

        try:
            assert process.stdout is not None
            async for raw_line in process.stdout:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue

                stream_event = _parse_claude_stream_event(data)
                if stream_event:
                    if stream_event["type"] == "text_delta":
                        assistant_parts.append(stream_event["text"])
                        yield ChatBackendEvent(
                            type="assistant_delta",
                            thread_id=self.id,
                            text="".join(assistant_parts),
                        )
                    elif stream_event["type"] == "tool_start":
                        tool_lines.append(f"调用工具：{stream_event['name']}")
                        yield ChatBackendEvent(
                            type="tool_update",
                            thread_id=self.id,
                            text="\n".join(tool_lines),
                        )
                    elif stream_event["type"] == "tool_input_delta" and tool_lines:
                        tool_lines[-1] = tool_lines[-1] + stream_event["text"]
                        yield ChatBackendEvent(
                            type="tool_update",
                            thread_id=self.id,
                            text="\n".join(tool_lines),
                        )
                    continue

                extracted = _extract_claude_text(data)
                if extracted:
                    final_result = extracted

            stderr_text = ""
            if process.stderr is not None:
                stderr_text = (await process.stderr.read()).decode("utf-8", errors="replace").strip()
            return_code = await process.wait()

            if return_code != 0:
                raise RuntimeError(stderr_text or final_result or f"Claude exited with code {return_code}")

            assistant_text = (
                final_result or "".join(assistant_parts)
            ).strip() or "已执行，但没有返回正文。"
            yield ChatBackendEvent(type="complete", thread_id=self.id, text=assistant_text)
        finally:
            if process.returncode is None:
                try:
                    process.terminate()
                    await asyncio.wait_for(process.wait(), timeout=5)
                except (asyncio.TimeoutError, ProcessLookupError):
                    process.kill()

    async def run(self, prompt: str) -> ChatRunResult:
        text = ""
        async for event in self.stream(prompt):
            if event.type == "complete":
                text = str(event.text or "").strip()
        return ChatRunResult(thread_id=self.id, text=text or "已执行，但没有返回正文。")


def _codex_thread_config(
    config_overrides: tuple[str, ...], env: dict[str, str]
) -> dict[str, Any]:
    """Convert CLI overrides to thread-local config and bind MCP identity."""

    config: dict[str, Any] = {}
    for override in config_overrides:
        key, separator, raw_value = override.partition("=")
        if not separator or not key.strip():
            continue
        try:
            value = tomllib.loads(f"value = {raw_value}")["value"]
        except tomllib.TOMLDecodeError:
            value = raw_value
        config[key.strip()] = value

    mcp_env_names = config.pop("mcp_servers.dramaclaw.env_vars", [])
    if isinstance(mcp_env_names, list):
        mcp_env = {
            str(name): env[str(name)]
            for name in mcp_env_names
            if isinstance(name, str) and env.get(name)
        }
        if mcp_env:
            config["mcp_servers.dramaclaw.env"] = mcp_env
    return config


def _start_or_resume_codex_thread(
    codex: Any,
    thread_id: str | None,
    thread_options: dict[str, Any],
) -> Any:
    """Resume a persisted thread, replacing only a provably stale pointer."""

    if not thread_id:
        return codex.thread_start(**thread_options)

    from openai_codex.errors import InvalidRequestError

    try:
        return codex.thread_resume(thread_id, **thread_options)
    except InvalidRequestError as exc:
        message = str(getattr(exc, "message", exc) or "").lower()
        stale_pointer = "no rollout found for thread id" in message or (
            "thread" in message and "not found" in message
        )
        if not stale_pointer:
            raise
        return codex.thread_start(**thread_options)


def _start_codex_turn(
    thread: Any,
    prompt: str,
    turn_metadata: dict[str, str],
) -> Any:
    """Start a turn with metadata omitted by the 0.147 generated facade.

    App Server 0.147 already accepts ``responsesapiClientMetadata``; only the
    generated Python convenience method lagged behind the protocol. Sending a
    raw params mapping keeps the credential scoped to the turn context instead
    of the long-lived thread configuration.
    """

    if not turn_metadata:
        from openai_codex import TextInput

        return thread.turn(TextInput(prompt))

    from openai_codex._inputs import TextInput, _normalize_run_input, _to_wire_input
    from openai_codex.api import TurnHandle

    wire_input = _to_wire_input(_normalize_run_input(TextInput(prompt)))
    started = thread._client.turn_start(
        thread.id,
        wire_input,
        params={"responsesapiClientMetadata": dict(turn_metadata)},
    )
    return TurnHandle(thread._client, thread.id, started.turn.id)

class CodexClient:
    def __init__(
        self,
        *,
        codex_bin: Path | None,
        cwd: Path,
        env: dict[str, str],
        model: str,
        model_provider: str,
        developer_instructions: str,
        config_overrides: tuple[str, ...] = (),
        thread_config_overrides: tuple[str, ...] | None = None,
        turn_metadata: dict[str, str] | None = None,
    ) -> None:
        self._codex_bin = codex_bin
        self._cwd = cwd
        self._env = env
        self._model = model
        self._model_provider = model_provider
        self._developer_instructions = developer_instructions
        self._config_overrides = tuple(config_overrides)
        effective_thread_overrides = (
            self._config_overrides
            if thread_config_overrides is None
            else tuple(thread_config_overrides)
        )
        self._thread_config = _codex_thread_config(effective_thread_overrides, env)
        self._turn_metadata = dict(turn_metadata or {})

    def thread_start(self) -> "CodexThread":
        return CodexThread(
            codex_bin=self._codex_bin,
            cwd=self._cwd,
            env=self._env,
            model=self._model,
            model_provider=self._model_provider,
            developer_instructions=self._developer_instructions,
            config_overrides=self._config_overrides,
            thread_config=self._thread_config,
            turn_metadata=self._turn_metadata,
            thread_id=None,
        )

    def thread_resume(self, thread_id: str) -> "CodexThread":
        return CodexThread(
            codex_bin=self._codex_bin,
            cwd=self._cwd,
            env=self._env,
            model=self._model,
            model_provider=self._model_provider,
            developer_instructions=self._developer_instructions,
            config_overrides=self._config_overrides,
            thread_config=self._thread_config,
            turn_metadata=self._turn_metadata,
            thread_id=thread_id,
        )


class CodexThread:
    def __init__(
        self,
        *,
        codex_bin: Path | None,
        cwd: Path,
        env: dict[str, str],
        model: str,
        model_provider: str,
        developer_instructions: str,
        config_overrides: tuple[str, ...],
        thread_config: dict[str, Any],
        turn_metadata: dict[str, str],
        thread_id: str | None,
    ) -> None:
        self._codex_bin = codex_bin
        self._cwd = cwd
        self._env = env
        self._model = model
        self._model_provider = model_provider
        self._developer_instructions = developer_instructions
        self._config_overrides = tuple(config_overrides)
        self._thread_config = dict(thread_config)
        self._turn_metadata = dict(turn_metadata)
        self.id = thread_id

    async def stream(self, prompt: str) -> AsyncIterator[ChatBackendEvent]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        current_turn_id: str | None = None

        def emit(kind: str, payload: Any) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, (kind, payload))

        def worker() -> None:
            from openai_codex import (
                ApprovalMode,
                CodexConfig,
                Sandbox,
            )
            from novelvideo.chat.codex_app_server import shared_codex
            from openai_codex.generated.v2_all import (
                AgentMessageDeltaNotification,
                ConfigWarningNotification,
                CommandExecutionOutputDeltaNotification,
                ContextCompactedNotification,
                ErrorNotification,
                ItemGuardianApprovalReviewCompletedNotification,
                ItemGuardianApprovalReviewStartedNotification,
                ItemCompletedNotification,
                McpToolCallProgressNotification,
                ModelReroutedNotification,
                PlanDeltaNotification,
                ReasoningSummaryTextDeltaNotification,
                ReasoningTextDeltaNotification,
                ItemStartedNotification,
                TerminalInteractionNotification,
                ThreadTokenUsageUpdatedNotification,
                TurnDiffUpdatedNotification,
                TurnCompletedNotification,
                TurnPlanUpdatedNotification,
                TurnStartedNotification,
                TurnStatus,
            )

            if self._codex_bin is not None and not self._codex_bin.exists():
                raise RuntimeError(f"Codex binary not found: {self._codex_bin}")

            config = CodexConfig(
                codex_bin=str(self._codex_bin) if self._codex_bin is not None else None,
                cwd=str(self._cwd),
                env=self._env,
                config_overrides=self._config_overrides,
            )

            items: list[Any] = []
            tool_calls: dict[str, ChatBackendEvent] = {}
            assistant_parts: list[str] = []
            final_response: str | None = None
            final_disposition: str | None = None

            with shared_codex(config) as codex:
                thread_options = {
                    # The only pre-approved tools belong to DramaClaw's
                    # project-scoped MCP server. Keep the global policy at
                    # deny-all so shell/filesystem/network escalation cannot
                    # trigger a second, credential-less Guardian model call.
                    "approval_mode": ApprovalMode.deny_all,
                    "config": self._thread_config,
                    "cwd": str(self._cwd),
                    "developer_instructions": self._developer_instructions,
                    "model": self._model,
                    "model_provider": self._model_provider,
                    "sandbox": Sandbox.read_only,
                }
                thread = _start_or_resume_codex_thread(
                    codex,
                    self.id,
                    thread_options,
                )
                self.id = thread.id
                turn = _start_codex_turn(thread, prompt, self._turn_metadata)
                nonlocal current_turn_id
                current_turn_id = turn.id
                register_live_codex_turn(self.id, turn.id, turn)
                emit(
                    "event",
                    ChatBackendEvent(type="thread_started", thread_id=self.id, turn_id=turn.id),
                )
                emit(
                    "event",
                    ChatBackendEvent(
                        type="egress_submitted", thread_id=self.id, turn_id=turn.id
                    ),
                )
                try:
                    for event in turn.stream():
                        payload = event.payload
                        raw = _codex_raw_notification(event)
                        if (
                            isinstance(payload, TurnStartedNotification)
                            and payload.turn.id == turn.id
                        ):
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="turn_started",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    status=str(payload.turn.status.value),
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, AgentMessageDeltaNotification) and payload.turn_id == turn.id:
                            assistant_parts.append(payload.delta)
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="assistant_delta",
                                    thread_id=self.id,
                                    text="".join(assistant_parts),
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, PlanDeltaNotification) and payload.turn_id == turn.id and payload.delta:
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="plan_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=payload.delta,
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, TurnPlanUpdatedNotification) and payload.turn_id == turn.id:
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="plan_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=payload.explanation,
                                    entries=[_codex_jsonable(step) for step in payload.plan],
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ReasoningSummaryTextDeltaNotification) and payload.turn_id == turn.id and payload.delta:
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="thought_delta",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=payload.delta,
                                    name="reasoning_summary",
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ReasoningTextDeltaNotification) and payload.turn_id == turn.id and payload.delta:
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="thought_delta",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=payload.delta,
                                    name="reasoning",
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ItemStartedNotification) and payload.turn_id == turn.id:
                            tool_event = _codex_tool_event(
                                payload.item,
                                phase="started",
                                thread_id=self.id,
                                turn_id=turn.id,
                                raw=raw,
                            )
                            if tool_event is not None:
                                if tool_event.call_id:
                                    tool_calls[tool_event.call_id] = tool_event
                                emit("event", tool_event)
                            continue
                        if isinstance(payload, McpToolCallProgressNotification) and payload.turn_id == turn.id and payload.message:
                            prior = tool_calls.get(payload.item_id)
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="tool_updated",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=f"\x1b[90m[mcp]\x1b[0m {payload.message}\n",
                                    name=prior.name if prior is not None else None,
                                    call_id=payload.item_id,
                                    status="running",
                                    input=prior.input if prior is not None else None,
                                    raw=raw,
                                ),
                            )
                            continue
                        if (
                            isinstance(payload, TerminalInteractionNotification)
                            and payload.turn_id == turn.id
                            and payload.stdin
                        ):
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="tool_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=f"\x1b[90m[stdin]\x1b[0m {payload.stdin}\n",
                                    raw=raw,
                                ),
                            )
                            continue
                        if (
                            isinstance(payload, CommandExecutionOutputDeltaNotification)
                            and payload.turn_id == turn.id
                            and payload.delta
                        ):
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="tool_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=str(payload.delta),
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, TurnDiffUpdatedNotification) and payload.turn_id == turn.id and payload.diff:
                            colored_diff = _colorize_unified_diff(payload.diff)
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="tool_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=f"\x1b[95m[diff]\x1b[0m\n{colored_diff}\n",
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ItemCompletedNotification) and payload.turn_id == turn.id:
                            items.append(payload.item)
                            tool_event = _codex_tool_event(
                                payload.item,
                                phase="completed",
                                thread_id=self.id,
                                turn_id=turn.id,
                                raw=raw,
                            )
                            if tool_event is not None:
                                if tool_event.call_id:
                                    tool_calls.pop(tool_event.call_id, None)
                                emit("event", tool_event)
                            continue
                        if isinstance(payload, ThreadTokenUsageUpdatedNotification) and payload.turn_id == turn.id:
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="usage_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    usage=_codex_jsonable(payload.token_usage),
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ModelReroutedNotification) and payload.turn_id == turn.id:
                            reason = getattr(getattr(payload, "reason", None), "value", str(getattr(payload, "reason", "") or "")).strip()
                            text = f"\x1b[93m[model]\x1b[0m {payload.from_model} → {payload.to_model}"
                            if reason:
                                text += f" ({reason})"
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="tool_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=text + "\n",
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ConfigWarningNotification):
                            text = f"\x1b[91m[config]\x1b[0m {payload.summary}"
                            if payload.path:
                                text += f" [{payload.path}]"
                            if payload.details:
                                text += f"\n{payload.details}"
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="tool_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=text + "\n",
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ContextCompactedNotification) and payload.turn_id == turn.id:
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="tool_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text="\x1b[90m[context]\x1b[0m compacted\n",
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ErrorNotification) and payload.turn_id == turn.id:
                            message = str(getattr(payload.error, "message", "") or "").strip()
                            extra = str(getattr(payload.error, "additional_details", "") or "").strip()
                            retry = " retrying" if payload.will_retry else ""
                            text = f"\x1b[91m[error{retry}]\x1b[0m {message}".rstrip()
                            if extra:
                                text += f"\n{extra}"
                            emit(
                                "event",
                                ChatBackendEvent(
                                    type="tool_update",
                                    thread_id=self.id,
                                    turn_id=turn.id,
                                    text=text + "\n",
                                    error=_codex_jsonable(payload.error),
                                    status="retrying" if payload.will_retry else "failed",
                                    raw=raw,
                                ),
                            )
                            continue
                        if isinstance(payload, ItemGuardianApprovalReviewStartedNotification) and payload.turn_id == turn.id:
                            trace = _codex_guardian_review_trace("guardian:start", payload.review)
                            if trace:
                                emit(
                                    "event",
                                    ChatBackendEvent(
                                        type="tool_update",
                                        thread_id=self.id,
                                        turn_id=turn.id,
                                        text=trace,
                                        raw=raw,
                                    ),
                                )
                            continue
                        if isinstance(payload, ItemGuardianApprovalReviewCompletedNotification) and payload.turn_id == turn.id:
                            trace = _codex_guardian_review_trace("guardian:done", payload.review)
                            if trace:
                                emit(
                                    "event",
                                    ChatBackendEvent(
                                        type="tool_update",
                                        thread_id=self.id,
                                        turn_id=turn.id,
                                        text=trace,
                                        raw=raw,
                                    ),
                                )
                            continue
                    if isinstance(payload, TurnCompletedNotification) and payload.turn.id == turn.id:
                        turn_status = str(payload.turn.status.value)
                        emit(
                            "event",
                            ChatBackendEvent(
                                type="turn_completed",
                                thread_id=self.id,
                                turn_id=turn.id,
                                status=turn_status,
                                error=_codex_jsonable(payload.turn.error),
                                disposition=(
                                    "cancelled"
                                    if payload.turn.status == TurnStatus.interrupted
                                    else turn_status
                                ),
                                raw=raw,
                            ),
                        )
                        if payload.turn.status == TurnStatus.failed:
                            message = None
                            if payload.turn.error is not None:
                                message = payload.turn.error.message
                            raise RuntimeError(message or f"Codex turn failed with status {payload.turn.status.value}")
                        if payload.turn.status == TurnStatus.interrupted:
                            final_response = "".join(assistant_parts).strip() or "已中断。"
                            final_disposition = "cancelled"
                        else:
                            final_response = (
                                _codex_final_response_from_items(items)
                                or "".join(assistant_parts).strip()
                                or "已执行，但没有返回正文。"
                            )
                            final_disposition = "completed"
                finally:
                    unregister_live_codex_turn(self.id, turn.id)

                if final_response is not None and final_disposition is not None:
                    emit(
                        "event",
                        ChatBackendEvent(
                            type="egress_disposition",
                            thread_id=self.id,
                            turn_id=turn.id,
                            disposition=final_disposition,
                        ),
                    )
                    emit(
                        "event",
                        ChatBackendEvent(
                            type="complete",
                            thread_id=self.id,
                            turn_id=turn.id,
                            text=final_response,
                        ),
                    )
                    return

            raise RuntimeError("Codex turn completed event not received")

        async def run_worker() -> None:
            try:
                await asyncio.to_thread(worker)
            except Exception as exc:
                if (
                    self.id
                    and current_turn_id
                    and consume_interrupted_codex_turn(self.id, current_turn_id)
                    and "app-server closed stdout" in str(exc)
                ):
                    await queue.put(
                        (
                            "event",
                            ChatBackendEvent(
                                type="complete",
                                thread_id=self.id,
                                text="已中断。",
                            ),
                        )
                    )
                    return
                await queue.put(("error", str(exc)))

        worker_task = asyncio.create_task(run_worker())

        try:
            while True:
                kind, payload = await queue.get()
                if kind == "error":
                    raise RuntimeError(str(payload))
                event = payload
                yield event
                if event.type == "complete":
                    break
        finally:
            await worker_task

    async def run(self, prompt: str) -> ChatRunResult:
        text = ""
        async for event in self.stream(prompt):
            if event.type == "complete":
                text = event.text or ""
        return ChatRunResult(thread_id=str(self.id or ""), text=text)

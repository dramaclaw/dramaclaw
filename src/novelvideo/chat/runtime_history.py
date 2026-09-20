"""Parse Codex history items without chat storage or media lookup."""

from __future__ import annotations

from typing import Any

from novelvideo.chat.backend_sdk import (
    _codex_item_completed_trace,
    _codex_item_started_trace,
    _codex_unwrap_item,
)


def _split_trace_contents(content: str) -> list[str]:
    raw_lines = str(content or "").rstrip().splitlines()
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in raw_lines:
        if not line.strip():
            if current:
                blocks.append(current)
                current = []
            continue
        current.append(line)
    if current:
        blocks.append(current)
    return ["\n".join(block) for block in blocks if block]


def _extract_codex_user_message_text(item: Any) -> str:
    thread_item = _codex_unwrap_item(item)
    parts: list[str] = []
    for content in getattr(thread_item, "content", []) or []:
        item_type = str(getattr(content, "type", "") or "")
        if item_type == "text":
            text = str(getattr(content, "text", "") or "").strip()
            if text:
                parts.append(text)
        elif item_type == "skill":
            name = str(getattr(content, "name", "") or "").strip()
            if name:
                parts.append(f"[skill] {name}")
        elif item_type == "mention":
            name = str(getattr(content, "name", "") or "").strip()
            path = str(getattr(content, "path", "") or "").strip()
            parts.append(f"[mention] {name or path}".strip())
        elif item_type == "image":
            url = str(getattr(content, "url", "") or "").strip()
            if url:
                parts.append(f"[image] {url}")
        elif item_type == "localImage":
            path = str(getattr(content, "path", "") or "").strip()
            if path:
                parts.append(f"[image] {path}")
    return "\n".join(part for part in parts if part).strip()


def _extract_codex_history_trace(item: Any) -> str:
    from openai_codex.generated.v2_all import CommandExecutionThreadItem

    thread_item = _codex_unwrap_item(item)
    started = _codex_item_started_trace(thread_item) or ""
    completed = _codex_item_completed_trace(thread_item) or ""
    body = ""
    if isinstance(thread_item, CommandExecutionThreadItem):
        aggregated = str(thread_item.aggregated_output or "")
        if aggregated:
            body = aggregated
            if not body.endswith("\n"):
                body += "\n"
    return (started + body + completed).strip()


def parse_codex_history_item(
    item: Any, turn_index: int, item_index: int
) -> list[dict[str, Any]]:
    """Return chat records for one native item, before media and timestamps."""
    from openai_codex.generated.v2_all import (
        AgentMessageThreadItem,
        UserMessageThreadItem,
    )

    thread_item = _codex_unwrap_item(item)
    if isinstance(thread_item, UserMessageThreadItem):
        content = _extract_codex_user_message_text(thread_item)
        return (
            [
                {
                    "id": turn_index * 1000 + item_index,
                    "role": "user",
                    "content": content,
                }
            ]
            if content
            else []
        )
    if isinstance(thread_item, AgentMessageThreadItem):
        content = str(thread_item.text or "").strip()
        return (
            [
                {
                    "id": turn_index * 1000 + item_index,
                    "role": "assistant",
                    "content": content,
                }
            ]
            if content
            else []
        )
    trace = _extract_codex_history_trace(thread_item)
    return [
        {
            "id": turn_index * 10000 + item_index * 10 + block_index,
            "role": "trace",
            "content": block,
        }
        for block_index, block in enumerate(_split_trace_contents(trace))
    ]

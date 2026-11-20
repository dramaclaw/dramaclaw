"""Small Codex wire models for the chat session protocol."""

from typing import Any, Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field

THREAD_REVERT = "thread/revert"
THREAD_TURNS_LIST = "thread/turns/list"
THREAD_ITEMS_LIST = "thread/items/list"
# Codex middle-truncates entry values above its 1000-token budget at 4 bytes per token.
ADDITIONAL_CONTEXT_VALUE_BYTES = 4000


def context_entries(
    key: str, text: str, *, kind: Literal["application", "untrusted"]
) -> dict[str, dict[str, str]]:
    """Split context without losing text or exceeding Codex's per-entry budget."""
    if not text.strip():
        return {}

    def pack(pieces: Iterable[str]) -> list[str]:
        chunks: list[str] = []
        current_bytes = 0
        for piece in pieces:
            piece_bytes = len(piece.encode("utf-8"))
            if chunks and current_bytes + piece_bytes <= ADDITIONAL_CONTEXT_VALUE_BYTES:
                chunks[-1] += piece
                current_bytes += piece_bytes
            else:
                chunks.append(piece)
                current_bytes = piece_bytes
        return chunks

    def split(value: str, separators: tuple[str, ...]) -> list[str]:
        if len(value.encode("utf-8")) <= ADDITIONAL_CONTEXT_VALUE_BYTES:
            return [value]
        if not separators:
            return pack(value)
        separator, *remaining = separators
        parts = value.split(separator)
        return pack(
            chunk
            for index, part in enumerate(parts)
            for chunk in split(
                part + separator if index < len(parts) - 1 else part,
                tuple(remaining),
            )
        )

    chunks = split(text, ("\n\n", "\n"))
    if len(chunks) > 99:
        raise ValueError("Additional context exceeds 99 chunks")
    return {
        key if index == 1 else f"{key}-{index:02d}": {"value": chunk, "kind": kind}
        for index, chunk in enumerate(chunks, 1)
    }


class _WireModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class CodexThreadStatus(_WireModel):
    type: str
    active_flags: list[str] = Field(default_factory=list, alias="activeFlags")


class CodexThreadView(_WireModel):
    id: str
    status: CodexThreadStatus
    history_mode: Literal["legacy", "paginated"] = Field(alias="historyMode")


class CodexThreadResponse(_WireModel):
    thread: CodexThreadView


class ThreadRevertResponse(CodexThreadResponse):
    turns_backwards_cursor: str | None = Field(alias="turnsBackwardsCursor")


class CodexTurn(_WireModel):
    id: str
    status: str
    error: dict[str, Any] | None = None
    started_at: int | None = Field(default=None, alias="startedAt")
    completed_at: int | None = Field(default=None, alias="completedAt")


class ThreadTurnsPage(_WireModel):
    """Turn metadata from thread/turns/list read with itemsView: "notLoaded".

    The items of each turn come from thread/items/list.
    """

    data: list[CodexTurn]
    next_cursor: str | None = Field(alias="nextCursor")


class CodexItemRecord(_WireModel):
    turn_id: str = Field(alias="turnId")
    item: dict[str, Any]
    started_at_ms: int | None = Field(default=None, alias="startedAtMs")
    completed_at_ms: int | None = Field(default=None, alias="completedAtMs")


class ThreadItemsPage(_WireModel):
    data: list[CodexItemRecord]
    next_cursor: str | None = Field(alias="nextCursor")


def newest_turns_params(
    thread_id: str, *, limit: int, cursor: str | None = None
) -> dict[str, Any]:
    params: dict[str, Any] = {"threadId": thread_id, "itemsView": "notLoaded", "limit": limit}
    if cursor is not None:
        params["cursor"] = cursor
    return params


def turn_items_params(
    thread_id: str, turn_id: str, *, limit: int, cursor: str | None = None
) -> dict[str, Any]:
    params: dict[str, Any] = {"threadId": thread_id, "turnId": turn_id, "limit": limit}
    if cursor is not None:
        params["cursor"] = cursor
    return params


def thread_revert_params(thread_id: str, before_turn_id: str) -> dict[str, str]:
    return {"threadId": thread_id, "beforeTurnId": before_turn_id}


def oldest_turn_params(thread_id: str) -> dict[str, str | int]:
    return {
        "threadId": thread_id,
        "sortDirection": "asc",
        "limit": 1,
        "itemsView": "notLoaded",
    }

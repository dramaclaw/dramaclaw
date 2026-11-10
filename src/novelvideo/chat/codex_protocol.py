"""Small Codex wire models for the chat session protocol."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

THREAD_REVERT = "thread/revert"
THREAD_TURNS_LIST = "thread/turns/list"


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


class CodexTurnRef(_WireModel):
    id: str
    status: str


class ThreadTurnIdsPage(_WireModel):
    """An id-only view of thread/turns/list used to find the turn to revert to.

    Full turn/item history models are deliberately not defined here.
    """

    data: list[CodexTurnRef]
    next_cursor: str | None = Field(alias="nextCursor")


def thread_revert_params(thread_id: str, before_turn_id: str) -> dict[str, str]:
    return {"threadId": thread_id, "beforeTurnId": before_turn_id}


def oldest_turn_params(thread_id: str) -> dict[str, str | int]:
    return {
        "threadId": thread_id,
        "sortDirection": "asc",
        "limit": 1,
        "itemsView": "notLoaded",
    }

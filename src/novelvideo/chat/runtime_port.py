"""Provider-neutral runtime contract consumed by chat application code."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal, Protocol, runtime_checkable


@dataclass(slots=True)
class ChatBackendEvent:
    """One normalized event emitted by any Agent runtime adapter."""

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
        "egress_submitted",
        "egress_disposition",
    ]
    thread_id: str | None = None
    turn_id: str | None = None
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
    """Stable boundary implemented by Codex, Hermes, and development adapters."""

    id: str | None

    def stream(self, prompt: str) -> AsyncIterator[ChatBackendEvent]: ...

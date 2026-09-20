"""Characterize event payloads shared by the chat runtime streams."""

from types import SimpleNamespace

import pytest

from novelvideo.chat.runtime_event_mapper import (
    lifecycle_event,
    progress_event,
    sdk_tool_event,
)


def _event(kind: str, **values: object) -> SimpleNamespace:
    defaults = {
        "type": kind,
        "thread_id": "  thread-1  ",
        "turn_id": " turn-2 ",
        "status": None,
        "error": None,
        "disposition": None,
        "text": None,
        "name": None,
        "entries": None,
        "usage": None,
        "call_id": None,
        "input": None,
        "output": None,
        "structured": None,
    }
    return SimpleNamespace(**(defaults | values))


@pytest.mark.parametrize(
    ("kind", "extra"),
    [
        ("thread_started", {}),
        ("turn_started", {"status": "in_progress"}),
        (
            "turn_completed",
            {"status": "completed", "error": None, "disposition": None},
        ),
    ],
)
def test_lifecycle_event_keeps_chat_payload(
    kind: str, extra: dict[str, object]
) -> None:
    assert lifecycle_event(_event(kind)) == {
        "type": kind,
        "thread_id": "thread-1",
        "turn_id": "turn-2",
        **extra,
    }


def test_lifecycle_event_keeps_failure_and_normalizes_empty_ids() -> None:
    event = _event(
        "turn_completed",
        thread_id=" ",
        turn_id=None,
        status="failed",
        error="runtime failed",
        disposition="failed",
    )
    assert lifecycle_event(event) == {
        "type": "turn_completed",
        "thread_id": None,
        "turn_id": None,
        "status": "failed",
        "error": "runtime failed",
        "disposition": "failed",
    }


def test_progress_event_preserves_hermes_and_sdk_shapes() -> None:
    thought = _event("thought_delta", text="thinking", name="agent")
    plan = _event("plan_update", text="plan", entries=[{"step": "one"}])
    usage = _event("usage_update", usage={"input_tokens": 3})

    assert progress_event(thought, include_details=False) == {
        "type": "thought_delta",
        "text": "thinking",
    }
    assert progress_event(thought) == {
        "type": "thought_delta",
        "text": "thinking",
        "source": "agent",
    }
    assert progress_event(plan, include_details=False) == {
        "type": "plan_update",
        "entries": [{"step": "one"}],
    }
    assert progress_event(plan) == {
        "type": "plan_update",
        "text": "plan",
        "entries": [{"step": "one"}],
    }
    assert progress_event(usage) == {
        "type": "usage_update",
        "usage": {"input_tokens": 3},
    }


def test_sdk_tool_event_keeps_structured_result_and_trimmed_text() -> None:
    event = _event(
        "tool_updated",
        text=" ignored by caller ",
        name="generate_image",
        call_id="call-1",
        status="completed",
        input={"prompt": "x"},
        output="done",
        structured={"imageUrl": "asset"},
    )
    assert sdk_tool_event(event, text="  generated  ") == {
        "type": "tool_updated",
        "text": "generated",
        "name": "generate_image",
        "call_id": "call-1",
        "status": "completed",
        "input": {"prompt": "x"},
        "output": "done",
        "error": None,
        "result_json": {"imageUrl": "asset"},
    }


@pytest.mark.parametrize("mapper", [lifecycle_event, progress_event])
def test_event_mapper_rejects_wrong_kind(mapper) -> None:
    with pytest.raises(ValueError, match="unsupported"):
        mapper(_event("assistant_delta"))

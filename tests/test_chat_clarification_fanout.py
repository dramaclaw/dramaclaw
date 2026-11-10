from __future__ import annotations

import pytest

from novelvideo.api.routes import chat as chat_routes
from novelvideo.chat.store import ChatScope, chat_store


@pytest.mark.asyncio
async def test_clarification_result_updates_turn_outside_recent_history(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(
        kind="project", id="project-1", surface="freezone", canvas_id="canvas-1", agent_id="main"
    )

    async def no_project_context(_user, _scope):
        return None

    # Keep scope resolution and storage real; only skip resolving a real project.
    monkeypatch.setattr(
        chat_routes, "_project_context_for_interaction_result", no_project_context
    )
    await chat_store.append_ui_event_async(
        "test-user", scope, "turn-a",
        {"type": "assistant.clarification.request", "bridge_key": "bk-1", "submitted": False},
    )
    for index in range(60):
        await chat_store.append_message_async(
            "test-user", scope, "user", "Another turn", turn_id=f"turn-other-{index}"
        )

    await chat_routes._persist_clarification_result_ui_event(
        user={"username": "test-user"},
        username="test-user",
        payload=chat_routes.ClarificationToolResultIn(
            turn_id="turn-b", bridge_key="bk-1", project_id="project-1", canvas_id="canvas-1",
            agent_id="main", anchor_text_prefix="Here is my answer",
        ),
    )

    events = await chat_store.turn_ui_events_async("test-user", scope, ["turn-a", "turn-b"])
    assert events["turn-a"][-1]["submitted"] is True
    assert events["turn-a"][-1]["bridge_key"] == "bk-1"
    assert "anchor_text_prefix" not in events["turn-a"][-1]
    assert events["turn-b"][-1]["submitted"] is True
    assert events["turn-b"][-1]["bridge_key"] == "bk-1"
    assert events["turn-b"][-1]["anchor_text_prefix"] == "Here is my answer"


@pytest.mark.asyncio
async def test_ui_event_turn_ids_match_type_and_bridge_key_in_first_seen_order(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="project", id="project-1", surface="director")
    for turn_id, event_type, bridge_key in (
        ("turn-z", "assistant.clarification.request", "bk-1"),
        ("turn-other-key", "assistant.clarification.request", "bk-2"),
        ("turn-a", "assistant.clarification.request", "bk-1"),
        ("turn-z", "assistant.clarification.request", "bk-1"),
        ("turn-other-type", "other.event", "bk-1"),
    ):
        await chat_store.append_ui_event_async(
            "test-user", scope, turn_id, {"type": event_type, "bridge_key": bridge_key}
        )

    assert await chat_store.ui_event_turn_ids_async(
        "test-user", scope, event_type="assistant.clarification.request", bridge_key="bk-1"
    ) == ["turn-z", "turn-a"]

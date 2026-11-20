import pytest

from novelvideo.api.routes.chat import ChatScopePayload
from novelvideo.chat.store import ChatScope


@pytest.mark.parametrize(
    "fields",
    [
        {"canvas_id": "c1", "agent_id": "a1"},
        {"canvasId": "c1", "agentId": "a1"},
        {
            "canvasId": "c1",
            "agentId": "a1",
            "canvas_id": "other-canvas",
            "agent_id": "other-agent",
        },
    ],
    ids=["snake_case", "camelCase", "camelCase_precedence"],
)
def test_chat_scope_payload_preserves_canvas_and_agent(fields):
    payload = ChatScopePayload(kind="project", id="p1", surface="freezone", **fields)

    scope = ChatScope.from_payload(payload.model_dump())

    assert scope.canvas_id == "c1"
    assert scope.agent_id == "a1"

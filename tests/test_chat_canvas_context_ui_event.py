"""A canvas context result keeps node details for the agent, not in chat history."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import chat as chat_routes

NODE_DETAIL = {
    "type": "node_detail",
    "node_id": "n1",
    "data": {
        "id": "n1",
        "type": "text",
        "text_content": "第一幕：雨夜，主角推门而入。" * 40,
        "actions": [{"id": "rewrite", "label": "改写"}],
        "imageUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    },
}
SELECTION_DETAIL = {
    "type": "selection_detail",
    "data": {"nodes": [{"node_id": "n2", "text_content": "第二幕"}]},
}


@pytest.fixture
def posted(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    stored: list[dict] = []
    to_agent: list[dict] = []

    async def no_project_state_dir(_user, _payload):
        return None

    async def no_project_context(_user, _scope):
        return None

    def bridge(key, result, *, bridge_dir=None):
        to_agent.append(result)
        return result

    async def append_ui_event(_username, _scope, turn_id, event):
        stored.append({"turn_id": turn_id, "event": event})
        return event

    monkeypatch.setattr(chat_routes, "_bridge_project_state_dir", no_project_state_dir)
    monkeypatch.setattr(chat_routes, "_project_context_for_scope", no_project_context)
    monkeypatch.setattr(chat_routes, "resolve_canvas_context", bridge)
    monkeypatch.setattr(chat_routes.chat_store, "append_ui_event_async", append_ui_event)

    app = FastAPI()
    app.include_router(chat_routes.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"username": "alice"}
    response = TestClient(app).post(
        "/api/v1/chat/canvas-context-tool-result",
        json={
            "turn_id": "turn-1",
            "bridge_key": "ctx-1",
            "project_id": "p1",
            "canvas_id": "c1",
            "anchor_text_prefix": "我先看一下画布",
            "responses": [NODE_DETAIL, SELECTION_DETAIL],
        },
    )
    assert response.status_code == 200
    return stored, to_agent


def test_stored_canvas_context_result_keeps_response_types_and_node_ids(posted):
    stored, _to_agent = posted

    assert stored == [
        {
            "turn_id": "turn-1",
            "event": {
                "schema_version": "canvas_context_result.v1",
                "type": "canvas_context_result",
                "canvas_id": "c1",
                "bridge_key": "ctx-1",
                "result": {
                    "ok": True,
                    "tool_call_status": "completed",
                    "canvas_context_status": "resolved",
                    "responses": [
                        {"type": "node_detail", "node_id": "n1"},
                        {"type": "selection_detail"},
                    ],
                    "errors": [],
                    "message": "Frontend returned requested canvas context.",
                },
                "anchor_text_prefix": "我先看一下画布",
            },
        }
    ]
    serialized = json.dumps(stored, ensure_ascii=False)
    assert "text_content" not in serialized
    assert "data:" not in serialized


def test_agent_still_receives_the_full_node_details(posted):
    _stored, to_agent = posted

    assert [result["responses"] for result in to_agent] == [[NODE_DETAIL, SELECTION_DETAIL]]

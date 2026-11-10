# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Canvas frame admission, replay guards, and browser confirmation receipts."""

from copy import deepcopy
import logging
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import chat, freezone as routes
from novelvideo.chat.store import ChatScope, ChatStore
from novelvideo.freezone import agent_canvas, canvas_confirmations as confirmations, canvas_store
from novelvideo.api.routes.chat import PendingCanvasCommandsIn
from novelvideo.freezone.canvas_command_bridge import (
    canvas_command_bridge_key, canvas_command_idempotency_key,
    list_pending_bridge_messages, put_pending_canvas_command,
    read_bridge_message, resolve_canvas_command, wait_canvas_command_result,
)
from novelvideo.freezone.canvas_core_pool import CanvasCoreError
from novelvideo.freezone.canvas_presence import touch_canvas_presence

BASE = "/projects/proj/freezone/canvases/default"
DELETE = [{"type": "delete_nodes", "node_ids": ["n1"]}]
PAID = [{"type": "run_node_action", "node_id": "n1", "action": "generate_image"}]
USER = {"id": "owner", "username": "owner"}


class CorePool:
    """Use the existing route-test pool approach; no compiled worker is installed."""

    def call(self, op, payload):
        canvas = deepcopy(payload["canvas"])
        for envelope in payload["envelopes"]:
            for command in envelope["commands"]:
                if command["type"] == "delete_nodes":
                    canvas["nodes"] = [
                        node for node in canvas["nodes"] if node["id"] not in command["node_ids"]
                    ]
                    canvas["edges"] = [
                        edge for edge in canvas["edges"]
                        if edge["source"] not in command["node_ids"]
                        and edge["target"] not in command["node_ids"]
                    ]
                elif command["type"] == "delete_edges":
                    canvas["edges"] = [
                        edge for edge in canvas["edges"] if edge["id"] not in command["edge_ids"]
                    ]
                else:
                    raise CanvasCoreError("invalid_request", "Unknown canvas command type")
        return {"status": "applied", "canvas": canvas, "changes": {},
                "receipt": {"canvas_apply_status": "applied"}}


@pytest.fixture
def setup(monkeypatch, tmp_path):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "server")
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    ctx = SimpleNamespace(project_id="proj", project_name="demo", state_dir=tmp_path,
                          requester_user_id="owner")
    clock = [1000]
    monkeypatch.setattr(routes, "_confirmation_now", lambda: clock[0], raising=False)

    async def resolve(project, user, **kwargs):
        assert kwargs["require_home_node"] is False
        return ctx, user["username"], "demo", tmp_path, str(tmp_path)

    async def project_context(user, scope):
        return ctx

    async def catalog(_requester_user_id):
        return []

    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(chat, "_project_context_for_scope", project_context)
    monkeypatch.setattr(routes, "_freezone_image_models_data", catalog)
    monkeypatch.setattr(routes, "_freezone_video_models_data", catalog)
    monkeypatch.setattr(agent_canvas, "get_canvas_core_pool", CorePool)
    store = ChatStore()
    monkeypatch.setattr(chat, "chat_store", store)
    canvas_store.save_canvas(tmp_path, "default", base_revision=None, build_payload=lambda _: {
        "project_id": "proj", "revision": 1,
        "nodes": [
            {"id": "n1", "type": "imageGenNode", "data": {"label": "海报"},
             "position": {"x": 0, "y": 0}},
            {"id": "n2", "type": "videoNode", "data": {"displayName": "片头"},
             "position": {"x": 100, "y": 0}},
            {"id": "n3", "type": "textNode", "data": {}, "position": {"x": 200, "y": 0}},
        ],
        "edges": [{"id": "e1", "source": "n1", "target": "n2"}],
    })
    app = FastAPI()
    async def bridge_state_dir(_user, _payload):
        return tmp_path

    monkeypatch.setattr(chat, "_bridge_project_state_dir", bridge_state_dir)
    monkeypatch.setattr(chat.time, "time", lambda: clock[0])
    app.include_router(chat.router)
    app.include_router(routes.router)
    user = [USER]
    app.dependency_overrides[get_api_user] = lambda: user[0]
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, root=tmp_path, clock=clock, user=user, store=store)


def create(setup, *, commands=DELETE, turn_id="t1", agent_id="main"):
    response = setup.client.post(BASE + "/confirmations", json={
        "commands": commands, "turn_id": turn_id, "agent_id": agent_id,
    })
    assert response.status_code == 200, response.text
    return response.json()["data"]


def directory(setup, agent_id="main"):
    return confirmations.confirmations_dir("owner", agent_id, setup.root)


def record(setup, created):
    return confirmations.read_confirmation(directory(setup), created["confirmation_id"])


def decide(setup, created, **overrides):
    stored = record(setup, created)
    body = {"decision": "confirmed", "via": "card", "turn_id": "t1",
            "command_hash": stored["command_hash"], **overrides}
    return setup.client.post(
        BASE + f"/confirmations/{created['confirmation_id']}/decision", json=body,
    )


def notices(setup, agent_id="main"):
    scope = ChatScope(kind="project", id="demo", surface="freezone", canvas_id="default",
                      agent_id=agent_id, state_dir=str(setup.root))
    with setup.store.connect("owner", scope) as conn:
        return [dict(row) for row in conn.execute(
            "SELECT role, content, turn_id, idempotency_key FROM chat_messages ORDER BY id"
        )]


FREE = [{"type": "delete_edges", "edge_ids": ["e1"]}]


def envelope(commands, **overrides):
    return {
        "schema_version": "canvas_chat_commands.v1", "project_id": "proj",
        "canvas_id": "default", "commands": commands, "external_mcp_command": True,
        "turn_id": "t1", **overrides,
    }


def put(setup, commands, *, key=None, **overrides):
    key = key or canvas_command_bridge_key(
        project_id="proj", canvas_id="default", commands=commands,
    )
    body = envelope(commands, **overrides)
    assert put_pending_canvas_command(
        key=key, project_id="proj", canvas_id="default", commands=commands,
        envelope=body, bridge_dir=directory(setup).parent,
    ) is None
    return key, body


def collect(setup):
    return chat._collect_pending_canvas_commands(
        PendingCanvasCommandsIn(project_id="proj", canvas_id="default"), "owner", setup.root,
    )["data"]["frames"]


def result(setup, key):
    stored = read_bridge_message(key, bridge_dir=directory(setup).parent)
    assert stored["transport_status"] == "cancelled"
    return wait_canvas_command_result(key, 0, bridge_dir=directory(setup).parent)


def confirmed(setup):
    created = create(setup, commands=PAID)
    touch_canvas_presence(setup.root, "default", "browser", now=1000)
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "submitted"
    return created


def test_free_frame_is_server_approved(setup):
    key, body = put(setup, FREE)
    frames = collect(setup)
    assert len(frames) == 1
    assert frames[0] == {
        "type": "canvas.command", "turn_id": "t1", "canvas_id": "default",
        "agent_id": "main", "bridge_key": key, "envelope": body,
        "source": "pending_canvas_bridge", "server_approved": True,
    }


@pytest.mark.parametrize("commands,code,reason", [
    (DELETE, "canvas_confirmation_required", "missing_confirmation"),
    ([{"type": "explode"}], "invalid_canvas_command", "invalid_canvas_command"),
    ([], "invalid_canvas_command", "invalid_canvas_command"),
    ([{}], "invalid_canvas_command", "invalid_canvas_command"),
    ([None], "invalid_canvas_command", "invalid_canvas_command"),
])
def test_unconfirmed_or_invalid_frame_is_refused(setup, caplog, commands, code, reason):
    key, _ = put(setup, commands)
    with caplog.at_level(logging.WARNING):
        assert collect(setup) == []
    stored = result(setup, key)
    assert stored["code"] == code
    assert stored["applied"] is False
    assert stored["canvas_apply_status"] == "not_applied"
    assert any("canvas_confirmation result=frame_refused" in line and f"reason={reason}" in line
               for line in caplog.text.splitlines())
    assert all("海报" not in line and "owner" not in line for line in caplog.text.splitlines())


def test_paid_card_browser_result_finishes_once(setup):
    created = confirmed(setup)
    frames = collect(setup)
    assert len(frames) == 1
    assert frames[0]["envelope"]["confirmation_id"] == created["confirmation_id"]
    key = frames[0]["bridge_key"]
    payload = {
        "bridge_key": key, "project_id": "proj", "canvas_id": "default", "turn_id": "t1",
        "ok": True, "applied": True, "tool_call_status": "completed",
        "canvas_apply_status": "accepted",
    }
    response = setup.client.post("/chat/canvas-command-tool-result", json=payload)
    assert response.status_code == 200, response.text
    stored = record(setup, created)
    assert stored["status"] == "executed"
    assert frames[0]["server_approved"] is True
    assert stored["outcome"] == {"status": "accepted", "bridge_key": key}
    saved = notices(setup)
    assert len(saved) == 1
    assert saved[0]["idempotency_key"] == (
        f"canvas-confirmation:{created['confirmation_id']}:reported"
    )
    assert "reported status accepted" in saved[0]["content"]
    setup.clock[0] = 1001
    assert setup.client.post("/chat/canvas-command-tool-result", json=payload).status_code == 200
    assert notices(setup) == saved
    assert record(setup, created) == stored


@pytest.mark.parametrize("change,reason", [
    ("turn", "turn_mismatch"), ("commands", "command_mismatch"),
    ("key", "missing_confirmation"),
])
def test_confirmed_frame_replay_guards(setup, caplog, change, reason):
    created = confirmed(setup)
    bridge = directory(setup).parent
    genuine = list_pending_bridge_messages(
        project_id="proj", canvas_id="default", bridge_dir=bridge,
    )[0]
    # Remove the genuine delivery so the altered frame is the only candidate.
    # Each case has an independent store; no confirmation record is changed.
    if change == "key":
        resolve_canvas_command(genuine["key"], {"ok": False}, bridge_dir=bridge)
    else:
        # Delete the genuine frame's transport files, keeping the approval store.
        for path in bridge.iterdir():
            if path.is_file():
                path.unlink()
    commands = [{"type": "run_node_action", "node_id": "n2", "action": "generate_image"}] \
        if change == "commands" else PAID
    key, _ = put(
        setup, commands, key=None if change == "key" else genuine["key"],
        confirmation_id=created["confirmation_id"], turn_id="t2" if change == "turn" else "t1",
        agent_id="main",
    )
    with caplog.at_level(logging.WARNING):
        assert collect(setup) == []
    assert result(setup, key)["code"] == "canvas_confirmation_required"
    assert f"reason={reason}" in caplog.text
    assert record(setup, created)["status"] == "confirmed"


def test_pending_record_is_not_admitted(setup, caplog):
    created = create(setup, commands=PAID)
    key = canvas_command_idempotency_key(
        project_id="proj", canvas_id="default",
        commands=[{"canvas_confirmation": created["confirmation_id"]}],
    )
    put(setup, PAID, key=key, confirmation_id=created["confirmation_id"])
    assert collect(setup) == []
    assert result(setup, key)["code"] == "canvas_confirmation_required"
    assert "reason=not_confirmed" in caplog.text
    assert record(setup, created)["status"] == "pending"


class Hub:
    def pending(self, bridge_dir, project_id, canvas_id, kinds):
        return list_pending_bridge_messages(
            project_id=project_id, canvas_id=canvas_id, kinds=kinds, bridge_dir=bridge_dir,
        )

    def legacy_paths(self, bridge_dir):
        return sorted(Path(bridge_dir).glob("*.pending.json"))


@pytest.mark.parametrize("legacy", [False, True])
def test_session_collector_guards_frames(setup, legacy):
    if legacy:
        free_key, free_body = legacy_put(setup, FREE)
        delete_key, _ = legacy_put(setup, DELETE)
    else:
        free_key, free_body = put(setup, FREE)
        delete_key, _ = put(setup, DELETE)
    scope = ChatScope(kind="project", id="proj", surface="freezone", canvas_id="default")
    frames = chat._collect_session_canvas_commands(
        Hub(), [directory(setup).parent], scope, "owner", "t1", set(), 999,
    )
    assert frames == [{
        "type": "canvas.command", "turn_id": "t1", "canvas_id": "default",
        "agent_id": "main", "bridge_key": free_key, "envelope": free_body,
        "server_approved": True,
    }]
    assert result(setup, delete_key)["code"] == "canvas_confirmation_required"


def legacy_put(setup, commands):
    key = canvas_command_bridge_key(project_id="proj", canvas_id="default", commands=commands)
    body = envelope(commands)
    bridge = directory(setup).parent
    bridge.mkdir(parents=True, exist_ok=True)
    (bridge / f"{key}.pending.json").write_text(json.dumps({
        "key": key, "kind": "canvas_command", "project_id": "proj", "canvas_id": "default",
        "commands": commands, "envelope": body, "created_at": 1000,
    }), encoding="utf-8")
    return key, body


@pytest.mark.parametrize("commands,expected_count", [(DELETE, 0), (FREE, 1)])
def test_poll_legacy_frame_guard(setup, commands, expected_count):
    key, body = legacy_put(setup, commands)
    frames = collect(setup)
    assert len(frames) == expected_count
    if expected_count:
        assert frames[0]["server_approved"] is True
        assert frames[0]["envelope"] == body
    else:
        assert result(setup, key)["code"] == "canvas_confirmation_required"

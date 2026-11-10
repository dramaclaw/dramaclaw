# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Canvas confirmation HTTP policy, durable decisions, notices, and bridge payloads."""

from copy import deepcopy
import logging
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import chat, freezone as routes
from novelvideo.chat.store import ChatScope, ChatStore
from novelvideo.freezone import agent_canvas, canvas_confirmations as confirmations, canvas_store
from novelvideo.freezone.canvas_command_bridge import list_pending_bridge_messages
from novelvideo.freezone.canvas_core_pool import CanvasCoreError
from novelvideo.freezone.canvas_presence import touch_canvas_presence

BASE = "/projects/proj/freezone/canvases/default"
DELETE = [{"type": "delete_nodes", "node_ids": ["n1"]}]
PAID = [{"type": "run_node_action", "node_id": "n1", "action": "generate_image"}]
TARGETS = [{"node_id": "n1", "title": "海报", "node_type": "imageGenNode",
            "action": "delete_nodes"}]
USER = {"id": "owner", "username": "owner"}
AGENT = {**USER, "credential_kind": "agent_session", "scopes": ["projects:write"],
         "current_scope_kind": "project", "current_project_id": "proj"}


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


def nodes(setup):
    return [node["id"] for node in canvas_store.read_canvas(setup.root, "default")["nodes"]]


def notices(setup, agent_id="main"):
    scope = ChatScope(kind="project", id="demo", surface="freezone", canvas_id="default",
                      agent_id=agent_id, state_dir=str(setup.root))
    with setup.store.connect("owner", scope) as conn:
        return [dict(row) for row in conn.execute(
            "SELECT role, content, turn_id, idempotency_key FROM chat_messages ORDER BY id"
        )]


def test_confirmation_directory_matches_chat_bridge(setup):
    assert directory(setup) == chat._canvas_bridge_dir(
        "owner", profile="freezone:main", project_state_dir=setup.root,
    ) / "mcp_canvas_approvals"
    assert directory(setup, "second") == chat._canvas_bridge_dir(
        "owner", profile="freezone:second", project_state_dir=setup.root,
    ) / "mcp_canvas_approvals"


def test_direct_commands_enforce_confirmation_but_allow_edge_deletion(setup):
    response = setup.client.post(BASE + "/agent-commands", json={"envelopes": [
        {"schema_version": "canvas_chat_commands.v1", "commands": DELETE},
    ]})
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "canvas_confirmation_required", "kinds": ["delete_nodes"],
    }
    assert nodes(setup) == ["n1", "n2", "n3"]
    response = setup.client.post(BASE + "/agent-commands", json={"envelopes": [
        {"schema_version": "canvas_chat_commands.v1", "commands": [
            {"type": "delete_edges", "edge_ids": ["e1"]},
        ]},
    ]})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "applied"
    assert canvas_store.read_canvas(setup.root, "default")["edges"] == []


def test_unknown_direct_command_retains_core_422(setup):
    response = setup.client.post(BASE + "/agent-commands", json={"envelopes": [
        {"commands": [{"type": "unknown"}]},
    ]})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_agent_canvas_request"


def test_create_confirmation_and_request_errors(setup):
    created = create(setup)
    assert created == {"confirmation_id": created["confirmation_id"], "kinds": ["delete_nodes"],
                       "targets": TARGETS, "expires_at": 2800, "browser_open": False}
    for commands, status, code in [
        ([{"type": "create_node", "node_type": "textNode", "data": {}}],
         422, "canvas_confirmation_not_needed"),
        ([{"type": "delete_nodes", "node_ids": ["nX"]}], 409, "targets_missing"),
        ([{"type": "unknown"}], 422, "invalid_agent_canvas_request"),
    ]:
        response = setup.client.post(BASE + "/confirmations", json={"commands": commands})
        assert response.status_code == status, response.text
        assert response.json()["detail"]["code"] == code
    assert setup.client.post(BASE + "/confirmations", json={"commands": []}).status_code == 422
    response = setup.client.post(BASE.replace("default", "missing") + "/confirmations",
                                 json={"commands": DELETE})
    assert response.status_code == 404


def test_list_exact_fields_filters_turnless_and_expires_once(setup):
    created = create(setup)
    create(setup, turn_id=None)
    stored = record(setup, created)
    response = setup.client.get(BASE + "/confirmations")
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "data": {"confirmations": [{
        "id": created["confirmation_id"], "agent_id": "main", "turn_id": "t1",
        "kinds": ["delete_nodes"], "targets": TARGETS, "command_hash": stored["command_hash"],
        "created_at": 1000, "expires_at": 2800,
    }]}}
    setup.clock[0] = 2800
    for _ in range(2):
        assert setup.client.get(BASE + "/confirmations").json() == {
            "ok": True, "data": {"confirmations": []},
        }
    saved = notices(setup)
    assert len(saved) == 1
    assert saved[0]["role"] == "agent_notification"
    assert saved[0]["turn_id"] == "t1"
    assert "expired after 30 minutes" in saved[0]["content"]
    assert saved[0]["idempotency_key"] == (
        f"canvas-confirmation:{created['confirmation_id']}:expired"
    )


def test_card_confirm_executes_once(setup):
    created = create(setup)
    setup.clock[0] = 1500
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "executed"
    assert response.json()["data"]["result"]["status"] == "applied"
    assert response.json()["data"]["result"]["revision"] == 2
    assert nodes(setup) == ["n2", "n3"]
    assert record(setup, created)["status"] == "executed"
    saved = notices(setup)
    assert len(saved) == 1
    assert "applied it with status applied" in saved[0]["content"]
    response = decide(setup, created)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "already_handled"
    assert len(notices(setup)) == 1


@pytest.mark.parametrize("overrides,code", [
    ({"command_hash": "wrong"}, "command_mismatch"),
    ({"turn_id": "wrong"}, "turn_mismatch"),
])
def test_card_mismatch_leaves_pending(setup, overrides, code):
    created = create(setup)
    response = decide(setup, created, **overrides)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == code
    assert record(setup, created)["status"] == "pending"
    assert nodes(setup) == ["n1", "n2", "n3"]


def test_card_refuse_notice_and_log_do_not_expose_canvas_content(setup, caplog):
    created = create(setup)
    with caplog.at_level(logging.INFO):
        response = decide(setup, created, decision="refused")
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "data": {
        "confirmation_id": created["confirmation_id"], "status": "refused", "applied": False,
    }}
    assert record(setup, created)["status"] == "refused"
    assert nodes(setup) == ["n1", "n2", "n3"]
    assert len(notices(setup)) == 1
    assert "refused" in notices(setup)[0]["content"]
    lines = [line for line in caplog.text.splitlines() if "canvas_confirmation result=" in line]
    assert any("canvas_confirmation result=refused" in line for line in lines)
    assert all("海报" not in line and USER["username"] not in line for line in lines)


def test_expired_card_confirm_does_not_execute(setup):
    created = create(setup)
    setup.clock[0] = 2800
    response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "expired"
    assert nodes(setup) == ["n1", "n2", "n3"]
    assert record(setup, created)["status"] == "expired"
    assert "expired after 30 minutes" in notices(setup)[0]["content"]


def test_changed_targets_voids_without_execution(setup):
    created = create(setup)
    canvas_store.save_canvas(setup.root, "default", base_revision=1,
                             build_payload=lambda old: {
                                 **old, "revision": 2, "nodes": old["nodes"][1:], "edges": [],
                             })
    response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "targets_changed", "node_ids": ["n1"],
        "message": "目标节点已删除或已变化（n1），确认已作废，未执行。",
    }
    assert record(setup, created)["status"] == "voided"
    assert "target nodes changed (n1)" in notices(setup)[0]["content"]
    assert canvas_store.read_canvas(setup.root, "default")["revision"] == 2


@pytest.mark.parametrize("credential", ["agent_session", "local_trusted_agent"])
def test_card_requires_browser_credential(setup, credential):
    created = create(setup)
    setup.user[0] = {**AGENT, "credential_kind": credential}
    response = decide(setup, created)
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == {
        "code": "card_requires_browser",
        "message": "确认卡片只能由浏览器里的用户点击，未执行。",
    }
    assert record(setup, created)["status"] == "pending"


def test_conversation_requires_agent_credential(setup):
    created = create(setup)
    response = decide(setup, created, via="conversation", turn_id="t2")
    assert response.status_code == 403
    assert response.json()["detail"] == {
        "code": "conversation_requires_agent", "message": "对话确认只能由 Agent 调用，未执行。",
    }


def test_conversation_requires_later_turn_then_executes_without_card_notice(setup):
    created = create(setup)
    setup.user[0] = AGENT
    response = decide(setup, created, via="conversation")
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "user_reply_required"
    assert record(setup, created)["status"] == "pending"
    response = decide(setup, created, via="conversation", turn_id="t2")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "executed"
    assert nodes(setup) == ["n2", "n3"]
    assert notices(setup) == []


def test_paid_confirm_requires_presence_then_submits_exact_bridge_envelope(setup):
    created = create(setup, commands=PAID)
    assert created["kinds"] == ["paid_generation"]
    response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "canvas_browser_required", "message": "需要打开画布才能运行",
    }
    assert record(setup, created)["status"] == "pending"
    touch_canvas_presence(setup.root, "default", "browser", now=1000)
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "submitted"
    frames = list_pending_bridge_messages(
        project_id="proj", canvas_id="default", bridge_dir=directory(setup).parent,
    )
    assert len(frames) == 1
    assert frames[0]["kind"] == "canvas_command"
    assert frames[0]["commands"] == PAID
    assert frames[0]["envelope"] == {
        "schema_version": "canvas_chat_commands.v1", "project_id": "proj",
        "canvas_id": "default", "commands": PAID, "agent_id": "main",
        "external_mcp_command": True, "confirmation_id": created["confirmation_id"],
        "turn_id": "t1",
    }
    assert nodes(setup) == ["n1", "n2", "n3"]
    assert record(setup, created)["status"] == "confirmed"


def test_unknown_confirmation_returns_readable_error(setup):
    response = setup.client.post(
        BASE + "/confirmations/cc_unknown/decision",
        json={"decision": "refused", "via": "card"},
    )
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == {
        "code": "not_found", "message": "找不到这条确认记录，未执行。",
    }


def test_execution_error_without_code_preserves_http_error(setup, monkeypatch, caplog):
    created = create(setup)

    async def fail_execution(**kwargs):
        raise HTTPException(422, {"message": "Command rejected"})

    monkeypatch.setattr(routes, "execute_agent_canvas_envelopes", fail_execution)
    with caplog.at_level(logging.INFO):
        response = decide(setup, created)
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {"message": "Command rejected"}
    assert record(setup, created)["status"] == "voided"
    assert "execution_failed" in caplog.text


def test_other_canvas_cannot_decide_record(setup):
    created = create(setup)
    response = setup.client.post(
        BASE.replace("default", "other") + f"/confirmations/{created['confirmation_id']}/decision",
        json={"decision": "refused", "via": "card"},
    )
    assert response.status_code == 404, response.text
    assert response.json()["detail"]["code"] == "not_found"
    assert record(setup, created)["status"] == "pending"


def test_list_distinct_agents_and_sorted_records(setup):
    first = create(setup, agent_id="second")
    setup.clock[0] = 1001
    second = create(setup)
    response = setup.client.get(BASE + "/confirmations", params=[
        ("agent_ids", "main"), ("agent_ids", "second"), ("agent_ids", "main"),
    ])
    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["data"]["confirmations"]] == [
        first["confirmation_id"], second["confirmation_id"],
    ]
    response = setup.client.get(BASE + "/confirmations", params=[
        ("agent_ids", f"agent-{index}") for index in range(51)
    ])
    assert response.status_code == 422


@pytest.mark.parametrize("method,suffix,body", [
    ("post", "/confirmations", {"commands": DELETE}),
    ("get", "/confirmations", None),
    ("post", "/confirmations/cc_invalid/decision", {"decision": "refused", "via": "card"}),
])
def test_invalid_canvas_id_is_400(setup, method, suffix, body):
    response = setup.client.request(method, BASE.replace("default", "invalid!") + suffix, json=body)
    assert response.status_code == 400, response.text

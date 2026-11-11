# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Canvas confirmation HTTP policy, durable decisions, notices, and bridge payloads."""

from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timezone
import logging
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import chat, freezone as routes
from novelvideo.chat.store import ChatScope, ChatStore
from novelvideo import config
from novelvideo.freezone import agent_canvas, canvas_confirmations as confirmations, canvas_store
from novelvideo.freezone import canvas_core_pool, server_workflow_index, workflow_runs
from novelvideo.task_backend import client as task_client
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

    def __init__(self):
        self.plan = {
            "ok": True, "actions": [{"command_index": 0, "node_id": "n1",
                "action": "generate_image", "execution_mode": "task", "label": "海报"}],
            "levels": [[0]], "dependencies": {}, "already_completed": False,
        }
        self.plan_inputs = []

    def call(self, op, payload):
        if op == "plan_workflow":
            self.plan_inputs.append(deepcopy(payload))
            if isinstance(self.plan, Exception):
                raise self.plan
            return deepcopy(self.plan)
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
                          requester_user_id="owner", requester_username="owner",
                          output_dir=tmp_path)
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
    pool = CorePool()
    monkeypatch.setattr(agent_canvas, "get_canvas_core_pool", lambda: pool)
    monkeypatch.setattr(canvas_core_pool, "get_canvas_core_pool", lambda: pool)
    from novelvideo.api import freezone_server_workflow_start as start
    monkeypatch.setattr(start, "get_canvas_core_pool", lambda: pool)
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "index")
    queued = []

    async def enqueue(context, **kwargs):
        assert context is ctx
        queued.append(kwargs)

    monkeypatch.setattr(task_client, "enqueue_project_task", enqueue)
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
        yield SimpleNamespace(client=client, root=tmp_path, clock=clock, user=user, store=store,
                              pool=pool, queued=queued, ctx=ctx)


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
    assert canvas_store.read_canvas(setup.root, "default")["save_source"] == "agent_confirmed"
    assert record(setup, created)["status"] == "executed"
    saved = notices(setup)
    assert len(saved) == 1
    assert "applied it with status applied" in saved[0]["content"]
    response = decide(setup, created)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "already_handled"
    assert len(notices(setup)) == 1


def test_card_confirm_can_empty_the_canvas(setup):
    created = create(setup, commands=[{
        "type": "delete_nodes", "node_ids": ["n1", "n2", "n3"],
    }])
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "executed"
    assert response.json()["data"]["result"]["status"] == "applied"
    assert response.json()["data"]["result"]["revision"] == 2
    assert nodes(setup) == []
    assert canvas_store.read_canvas(setup.root, "default")["save_source"] == "agent_confirmed"
    assert record(setup, created)["status"] == "executed"
    saved = notices(setup)
    assert len(saved) == 1
    assert "applied it with status applied" in saved[0]["content"]


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


def test_browser_paid_confirm_presence_and_exact_bridge_envelope(setup, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
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
    saved = notices(setup)
    assert len(saved) == 1
    assert saved[0]["content"] == (
        "[CANVAS_BACKGROUND_RESULT] The user confirmed canvas confirmation "
        + created["confirmation_id"]
        + " (delete_nodes), but the server could not apply it (execution_failed). "
        "The confirmation is void. Read the canvas before reporting the outcome or asking again. "
        "[/CANVAS_BACKGROUND_RESULT]"
    )
    assert saved[0]["turn_id"] == "t1"


def test_card_execution_error_code_reaches_agent(setup, monkeypatch):
    created = create(setup)

    async def fail_execution(**kwargs):
        raise HTTPException(400, {
            "code": "dangerous_empty_canvas_overwrite", "old_nodes": 1, "new_nodes": 0,
            "save_source": "agent_patch",
        })

    monkeypatch.setattr(routes, "execute_agent_canvas_envelopes", fail_execution)
    response = decide(setup, created)
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == {
        "code": "dangerous_empty_canvas_overwrite", "old_nodes": 1, "new_nodes": 0,
        "save_source": "agent_patch",
    }
    assert record(setup, created)["status"] == "voided"
    saved = notices(setup)
    assert len(saved) == 1
    assert "could not apply it (dangerous_empty_canvas_overwrite)" in saved[0]["content"]


def test_conversation_execution_error_has_no_notice(setup, monkeypatch):
    created = create(setup)

    async def fail_execution(**kwargs):
        raise HTTPException(400, {
            "code": "dangerous_empty_canvas_overwrite", "old_nodes": 1, "new_nodes": 0,
            "save_source": "agent_patch",
        })

    monkeypatch.setattr(routes, "execute_agent_canvas_envelopes", fail_execution)
    setup.user[0] = AGENT
    response = decide(setup, created, via="conversation", turn_id="t2")
    assert response.status_code == 400, response.text
    assert notices(setup) == []


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


def runs(setup):
    return workflow_runs.list_workflow_runs(project_dir=setup.root, canvas_id="default")


def test_server_paid_confirmation_starts_without_browser_once(setup, monkeypatch):
    created = create(setup, commands=PAID)

    def presence_forbidden(*args, **kwargs):
        raise AssertionError("runnable decision must not consult browser presence")

    monkeypatch.setattr(routes, "canvas_browser_open", presence_forbidden)
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data == {"confirmation_id": created["confirmation_id"], "status": "running",
                    "run_id": data["run_id"], "refused": [], "actions": [
                        {"node_id": "n1", "action": "generate_image", "label": "海报"}]}
    run = runs(setup)[0]
    assert run["run_id"] == data["run_id"]
    assert run["owner_kind"] == "server"
    assert [{k: a[k] for k in ("node_id", "action", "status")} for a in run["actions"]] == [
        {"node_id": "n1", "action": "generate_image", "status": "pending"}]
    assert run["metadata"]["requester"] == {"user_id": "owner", "username": "owner"}
    assert run["metadata"]["confirmation"] == {
        "id": created["confirmation_id"], "agent_id": "main", "username": "owner"}
    assert run["metadata"]["levels"] == [[0]]
    assert run["metadata"]["dependencies"] == {}
    assert server_workflow_index.list_server_workflow_runs() == [{
        "project_id": "proj", "state_dir": str(setup.root), "canvas_id": "default",
        "run_id": run["run_id"], "requester": {"user_id": "owner", "username": "owner"}}]
    assert setup.queued == [{
        "task_type": "freezone_workflow_drive", "product_surface": "freezone_assistant",
        "queue_kind": "default", "scope": f"{run['run_id']}:d1",
        "payload": {"canvas_id": "default", "run_id": run["run_id"], "drive_attempt": 1}}]
    assert record(setup, created)["outcome"] == {"status": "running", "run_id": run["run_id"]}
    assert run["run_id"] in notices(setup)[0]["content"]
    assert "freezone_observe_workflow_run" in notices(setup)[0]["content"]
    assert list_pending_bridge_messages(
        project_id="proj", canvas_id="default", bridge_dir=directory(setup).parent) == []
    assert setup.pool.plan_inputs[0]["commands"] == PAID
    assert setup.pool.plan_inputs[0]["env"] == {
        "locale": "zh", "catalogs": {"image": [], "video": []}, "selectedNodeIds": []}
    again = decide(setup, created)
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "already_handled"
    assert len(runs(setup)) == 1


def test_server_conversation_run_without_card_notice(setup):
    created = create(setup, commands=PAID)
    setup.user[0] = AGENT
    response = decide(setup, created, via="conversation", turn_id="t2")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "running"
    assert notices(setup) == []


def test_video_confirmation_starts_server_run_without_browser(setup):
    commands = [{"type": "run_node_action", "node_id": "n2", "action": "generate_video"}]
    setup.pool.plan["actions"][0].update(node_id="n2", action="generate_video", label="片头")
    created = create(setup, commands=commands)
    assert created["browser_open"] is False
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "running"
    assert response.json()["data"]["refused"] == []
    run = runs(setup)[0]
    assert run["owner_kind"] == "server"
    assert [(a["node_id"], a["action"]) for a in run["actions"]] == [
        ("n2", "generate_video"),
    ]
    assert [task["task_type"] for task in setup.queued] == ["freezone_workflow_drive"]


@pytest.mark.parametrize("action,data,reason", [
    ("generate_text_video", {}, "action_not_on_server"),
    ("generate_video", {"count": 2}, "video_count"),
    ("generate_video", {"storyRole": "start", "continuityMode": "auto"},
     "video_story_continuity"),
])
def test_browser_only_video_requires_open_canvas_at_creation_and_decision(setup, action, data, reason):
    commands = [{"type": "run_node_action", "node_id": "n2", "action": action}]
    setup.pool.plan["actions"][0].update(node_id="n2", action=action, label="片头")
    canvas = canvas_store.read_canvas(setup.root, "default")
    canvas["nodes"][1]["data"].update(data)
    canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"), canvas)
    expected = {"code": "canvas_open_required", "message": "这些动作需要打开画布才能运行：片头",
                "blocked": [{"node_id": "n2", "action": action, "label": "片头",
                             "reason": reason}]}
    response = setup.client.post(BASE + "/confirmations", json={"commands": commands})
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == expected
    assert list(directory(setup).glob("cc_*.json")) == []
    touch_canvas_presence(setup.root, "default", "browser", now=1000)
    created = create(setup, commands=commands)
    setup.clock[0] = 1500
    response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == expected
    assert record(setup, created)["status"] == "pending"
    touch_canvas_presence(setup.root, "default", "browser", now=1500)
    assert decide(setup, created).json()["data"]["status"] == "submitted"
    frames = list_pending_bridge_messages(
        project_id="proj", canvas_id="default", bridge_dir=directory(setup).parent)
    assert frames[0]["envelope"] == {
        "schema_version": "canvas_chat_commands.v1", "project_id": "proj",
        "canvas_id": "default", "commands": commands, "agent_id": "main", "turn_id": "t1",
        "external_mcp_command": True, "confirmation_id": created["confirmation_id"]}


@pytest.mark.parametrize("reason", ["recipe_required", "mixed_commands"])
def test_server_blocked_reasons_leave_no_confirmation(setup, reason, request):
    commands = PAID
    expected = {"node_id": "n1", "action": "generate_image", "label": "海报", "reason": reason}
    if reason == "recipe_required":
        from tests.recording_usage_meter import RecordingUsageMeter

        stack = ExitStack()
        request.addfinalizer(stack.close)
        stack.enter_context(RecordingUsageMeter().registered())
        setup.pool.plan["actions"][0].update(action="generate_text")
        expected["action"] = "generate_text"
    else:
        commands = [{"type": "update_node_data", "node_id": "n3", "data": {"content": "Hi"}},
                    *PAID]
        expected = {"node_id": "n3", "action": "update_node_data", "label": "update_node_data",
                    "reason": reason}
    response = setup.client.post(BASE + "/confirmations", json={"commands": commands})
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "canvas_open_required"
    assert response.json()["detail"]["blocked"] == [expected]
    assert list(directory(setup).glob("cc_*.json")) == []
    if reason == "mixed_commands":
        assert setup.pool.plan_inputs == []


@pytest.mark.parametrize("browser_open", [False, True])
def test_partial_refusal_uses_server_without_browser_and_browser_when_open(setup, browser_open):
    setup.pool.plan["actions"].append({
        "command_index": 0, "node_id": "n2", "action": "auto_compose_video",
        "execution_mode": "task", "label": "Compose",
    })
    setup.pool.plan.update(levels=[[0], [1]], dependencies={"n2": ["n1"]})
    commands = [{"type": "run_workflow", "scope": "canvas"}]
    if browser_open:
        touch_canvas_presence(setup.root, "default", "browser", now=1000)
    created = create(setup, commands=commands)
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    if browser_open:
        assert data["status"] == "submitted"
        assert runs(setup) == []
        assert setup.queued == []
        frames = list_pending_bridge_messages(
            project_id="proj", canvas_id="default", bridge_dir=directory(setup).parent)
        assert [frame["envelope"]["commands"] for frame in frames] == [commands]
        return
    assert data == {
        "confirmation_id": created["confirmation_id"], "status": "running",
        "run_id": data["run_id"], "actions": [
            {"node_id": "n1", "action": "generate_image", "label": "海报"},
            {"node_id": "n2", "action": "auto_compose_video", "label": "Compose"},
        ], "refused": [{"node_id": "n2", "action": "auto_compose_video", "label": "Compose",
                        "reason": "action_not_on_server", "code": "canvas_open_required"}],
    }
    run = runs(setup)[0]
    assert [(a["node_id"], a["action"], a["status"]) for a in run["actions"]] == [
        ("n1", "generate_image", "pending"), ("n2", "auto_compose_video", "pending"),
    ]
    assert run["metadata"]["action_manifest"] == [
        {"command_index": 0, "node_id": "n1", "action": "generate_image", "label": "海报",
         "execution_mode": "task"},
        {"command_index": 0, "node_id": "n2", "action": "auto_compose_video", "label": "Compose",
         "execution_mode": "task", "refusal": {
             "code": "canvas_open_required", "reason": "action_not_on_server"}},
    ]


def test_action_parameters_start_server_run_without_browser(setup):
    setup.pool.plan["actions"][0]["parameters"] = {"prompt": "A tree"}
    commands = [dict(PAID[0], parameters={"prompt": "A tree"})]
    created = create(setup, commands=commands)
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "running"
    assert response.json()["data"]["refused"] == []
    assert runs(setup)[0]["metadata"]["action_manifest"] == [
        {"command_index": 0, "node_id": "n1", "action": "generate_image", "label": "海报",
         "execution_mode": "task", "parameters": {"prompt": "A tree"}},
    ]


def test_invalid_plan_creation_and_pending_decision(setup):
    created = create(setup, commands=PAID)
    setup.pool.plan = {"ok": False, "code": "workflow_cycle", "message": "环"}
    response = setup.client.post(BASE + "/confirmations", json={"commands": PAID})
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {"code": "workflow_plan_invalid", "message": "环"}
    assert len(list(directory(setup).glob("cc_*.json"))) == 1
    response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {"code": "workflow_plan_invalid", "message": "环"}
    assert record(setup, created)["status"] == "pending"


@pytest.mark.parametrize("code,status,detail", [
    ("invalid_request", 422, {"code": "invalid_agent_canvas_request", "message": "bad"}),
    ("worker_unavailable", 503, {"code": "worker_unavailable"}),
])
def test_plan_worker_error_mapping(setup, code, status, detail):
    setup.pool.plan = CanvasCoreError(code, "bad")
    response = setup.client.post(BASE + "/confirmations", json={"commands": PAID})
    assert response.status_code == status, response.text
    assert response.json()["detail"] == detail
    assert list(directory(setup).glob("cc_*.json")) == []


def test_active_run_leaves_confirmation_pending(setup):
    created = create(setup, commands=PAID)
    run = workflow_runs.create_workflow_run(
        project_dir=setup.root, project_id="proj", canvas_id="default", owner_kind="server",
        actions=[{"node_id": "n1", "action": "generate_image"}],
        now=datetime.fromtimestamp(1000, timezone.utc))
    response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "workflow_already_running", "run_id": run["run_id"],
        "message": "画布上已有工作流在运行，未执行。"}
    assert record(setup, created)["status"] == "pending"


def test_zero_actions_already_completed(setup):
    setup.pool.plan.update(actions=[], levels=[], already_completed=True)
    created = create(setup, commands=[{"type": "run_workflow", "scope": "canvas"}])
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"confirmation_id": created["confirmation_id"],
                                       "status": "already_completed"}
    assert record(setup, created)["outcome"] == {"status": "already_completed"}
    assert runs(setup) == []
    assert setup.queued == []
    assert "every target already has a current result" in notices(setup)[0]["content"]


def test_start_invalidates_generation_result(setup):
    setup.pool.plan["actions"][0]["invalidation_reason"] = "upstream_changed"
    created = create(setup, commands=PAID)
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    canvas = canvas_store.read_canvas(setup.root, "default")
    assert canvas["save_source"] == "workflow_result"
    assert canvas["nodes"][0]["data"] == {
        "label": "海报", "workflowResultStale": True,
        "workflowInvalidatedAt": "1970-01-01T00:16:40.000Z",
        "workflowInvalidationReason": "upstream_changed"}


def test_run_conflict_after_claim_voids_confirmation(setup, monkeypatch):
    from novelvideo.api import freezone_server_workflow_start as start

    created = create(setup, commands=PAID)
    start_run = start.start_server_workflow_run
    raced = []

    async def race(**kwargs):
        raced.append(workflow_runs.create_workflow_run(
            project_dir=setup.root, project_id="proj", canvas_id="default", owner_kind="server",
            actions=[{"node_id": "n1", "action": "generate_image"}], now=kwargs["now"]))
        return await start_run(**kwargs)

    monkeypatch.setattr(start, "start_server_workflow_run", race)
    response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "workflow_already_running", "run_id": raced[0]["run_id"],
        "message": "画布上已有工作流在运行，未执行。"}
    assert record(setup, created)["status"] == "voided"
    assert record(setup, created)["outcome"] == {"reason": "workflow_already_running"}
    assert setup.queued == []


def test_run_conflict_after_claim_when_active_run_already_ended(setup, monkeypatch):
    from novelvideo.api import freezone_server_workflow_start as start

    created = create(setup, commands=PAID)

    async def conflict(**kwargs):
        raise workflow_runs.WorkflowRunLeaseConflict("another workflow runner is active")

    monkeypatch.setattr(start, "start_server_workflow_run", conflict)
    response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "workflow_already_running", "message": "画布上已有工作流在运行，未执行。"}
    assert record(setup, created)["status"] == "voided"


def test_started_run_is_registered_before_node_patches(setup, monkeypatch):
    from novelvideo.api import freezone_server_workflow_start as start

    setup.pool.plan["actions"][0]["invalidation_reason"] = "upstream_changed"
    created = create(setup, commands=PAID)

    async def patch_fails(self, node_id, patch):
        raise RuntimeError("patch failed")

    monkeypatch.setattr(start.InProcessActionHost, "patch_node", patch_fails)
    with pytest.raises(RuntimeError, match="patch failed"):
        decide(setup, created)
    run = runs(setup)[0]
    assert [entry["run_id"] for entry in server_workflow_index.list_server_workflow_runs()] == [
        run["run_id"]]


def test_first_enqueue_failure_keeps_index_for_recovery(setup, monkeypatch):
    from novelvideo.api import freezone_server_workflow_start as start

    async def full(*args, **kwargs):
        raise RuntimeError("queue is full")

    monkeypatch.setattr(start, "enqueue_server_workflow_drive", full)
    created = create(setup, commands=PAID)
    response = decide(setup, created)
    assert response.status_code == 200, response.text
    run_id = response.json()["data"]["run_id"]
    assert response.json()["data"]["status"] == "running"
    indexed = server_workflow_index.list_server_workflow_runs()
    assert [item["run_id"] for item in indexed] == [run_id]
    metadata = runs(setup)[0]["metadata"]
    assert metadata.get("drive_generation", 0) == 0
    assert metadata["drive_attempt"] == 1
    assert metadata["drive_enqueue_failures"] == 1
    assert metadata["drive_last_enqueue_error"] == "RuntimeError"
    assert setup.queued == []


async def test_terminal_notices_are_idempotent_per_status(setup):
    created = create(setup, commands=PAID)
    saved = record(setup, created)
    for status in ("completed", "failed", "cancelled"):
        for _ in range(2):
            await chat.append_canvas_confirmation_notice(
                USER, saved, f"run_{status}", "run_example: 2 completed, 1 failed")
    messages = notices(setup)
    assert [message["idempotency_key"] for message in messages] == [
        f"canvas-confirmation:{created['confirmation_id']}:run_{status}"
        for status in ("completed", "failed", "cancelled")]
    assert all("run_example: 2 completed, 1 failed" in message["content"] for message in messages)
    assert all("Read the canvas or observe the run before reporting" in message["content"]
               for message in messages)


def test_recipe_admission_failure_voids_confirmation(setup, monkeypatch):
    from tests.recording_usage_meter import RecordingUsageMeter

    canvas = canvas_store.read_canvas(setup.root, "default")
    canvas["nodes"][0]["data"]["workflowCatalog"] = {"recipeId": "image-recipe"}
    canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"), canvas)

    async def reject(*args, **kwargs):
        raise RuntimeError("recipe admission rejected")

    monkeypatch.setattr(routes, "get_task_backend", lambda: SimpleNamespace(
        enqueue_project_task=reject,
    ))
    with RecordingUsageMeter().registered():
        created = create(setup, commands=PAID)
        response = decide(setup, created)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "admission_failed", "message": "recipe admission rejected",
    }
    assert record(setup, created)["status"] == "voided"
    assert record(setup, created)["outcome"] == {"reason": "admission_failed"}
    assert [run["status"] for run in runs(setup)] == ["failed"]
    assert setup.queued == []

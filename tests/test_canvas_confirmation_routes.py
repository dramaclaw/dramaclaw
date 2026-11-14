# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Canvas confirmation HTTP policy, durable decisions, notices, and bridge payloads."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timezone
import json
import logging
import multiprocessing
import os
from pathlib import Path
from threading import Barrier
import time
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import chat, freezone as routes
from novelvideo.chat.store import ChatScope, ChatStore
from novelvideo import config
from novelvideo.freezone import agent_canvas, canvas_confirmations as confirmations, canvas_store
from novelvideo.freezone import (
    canvas_core_pool,
    server_workflow_index,
    workflow_drafts,
    workflow_runs,
)
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
        self.apply_calls = []
        self.apply_fails = False
        self.apply_delay = 0.0
        self.id_prefix = ""
        self.node_count = 0
        self.edge_count = 0

    def call(self, op, payload):
        if op == "plan_workflow":
            self.plan_inputs.append(deepcopy(payload))
            if isinstance(self.plan, Exception):
                raise self.plan
            return deepcopy(self.plan(payload) if callable(self.plan) else self.plan)
        assert op == "apply_commands"
        self.apply_calls.append(deepcopy(payload))
        if self.apply_delay:
            time.sleep(self.apply_delay)
        canvas = deepcopy(payload["canvas"])
        if self.apply_fails:
            return {"status": "validation_failed", "canvas": canvas, "changes": {},
                    "receipt": {"tool_call_status": "failed", "canvas_apply_status": "failed",
                                "applied": False, "cancelled": False,
                                "errors": ["edges[0]: target node not found"], "applied_count": 0,
                                "created_node_ids": [], "command_results": []}}
        client_ids = {}
        created_nodes, created_edges, results = [], [], []
        for envelope in payload["envelopes"]:
            for command in envelope["commands"]:
                kind = command["type"]
                result = {"commandIndex": len(results), "type": kind, "status": "success"}
                if kind == "create_node":
                    self.node_count += 1
                    node_id = f"{self.id_prefix}node-{self.node_count}"
                    canvas["nodes"].append({
                        "id": node_id, "type": command["node_type"],
                        "position": deepcopy(command.get("position") or {"x": 0, "y": 0}),
                        "data": deepcopy(command.get("data") or {}),
                    })
                    client_ids[command["client_id"]] = node_id
                    created_nodes.append(node_id)
                    result.update(nodeId=command["client_id"], createdNodeId=node_id)
                elif kind == "create_edge":
                    self.edge_count += 1
                    edge_id = f"{self.id_prefix}edge-{self.edge_count}"
                    canvas["edges"].append({
                        "id": edge_id,
                        "source": client_ids.get(command["source"], command["source"]),
                        "target": client_ids.get(command["target"], command["target"]),
                    })
                    created_edges.append(edge_id)
                elif kind == "update_node_data":
                    node_id = client_ids.get(command["node_id"], command["node_id"])
                    node = next(node for node in canvas["nodes"] if node["id"] == node_id)
                    node["data"].update(deepcopy(command["data"]))
                elif kind in {"select_nodes", "layout_nodes", "group_nodes"}:
                    pass
                elif kind == "delete_nodes":
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
                results.append(result)
        return {
            "status": "applied", "canvas": canvas,
            "changes": {"created_node_ids": created_nodes, "created_edge_ids": created_edges},
            "receipt": {"tool_call_status": "completed", "canvas_apply_status": "applied",
                        "applied": True, "cancelled": False, "errors": [],
                        "applied_count": len(results), "created_node_ids": created_nodes,
                        "command_results": results},
        }


def _harness(root, patch, setenv, *, seed=True):
    """Install the route doubles; the fixture and spawned API processes share this."""
    setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "server")
    setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    ctx = SimpleNamespace(project_id="proj", project_name="demo", state_dir=root,
                          requester_user_id="owner", requester_username="owner",
                          output_dir=root)
    clock = [1000]
    patch(routes, "_confirmation_now", lambda: clock[0])

    async def resolve(project, user, **kwargs):
        assert kwargs["require_home_node"] is False
        return ctx, user["username"], "demo", root, str(root)

    async def project_context(user, scope):
        return ctx

    async def catalog(_requester_user_id):
        return []

    patch(routes, "_resolve_freezone_project", resolve)
    patch(chat, "_project_context_for_scope", project_context)
    patch(routes, "_freezone_image_models_data", catalog)
    patch(routes, "_freezone_video_models_data", catalog)
    pool = CorePool()
    patch(agent_canvas, "get_canvas_core_pool", lambda: pool)
    patch(canvas_core_pool, "get_canvas_core_pool", lambda: pool)
    from novelvideo.api import freezone_server_workflow_start as start
    patch(start, "get_canvas_core_pool", lambda: pool)
    patch(config, "STATE_DIR", root / "index")
    queued = []

    async def enqueue(context, **kwargs):
        assert context is ctx
        queued.append(kwargs)

    patch(task_client, "enqueue_project_task", enqueue)
    store = ChatStore()
    patch(chat, "chat_store", store)
    if seed:
        canvas_store.save_canvas(root, "default", base_revision=None, build_payload=lambda _: {
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
    return SimpleNamespace(app=app, root=root, clock=clock, user=user, store=store,
                           pool=pool, queued=queued, ctx=ctx)


@pytest.fixture
def setup(monkeypatch, tmp_path):
    harness = _harness(tmp_path, monkeypatch.setattr, monkeypatch.setenv)
    with TestClient(harness.app) as client:
        harness.client = client
        yield harness


def create(setup, *, commands=DELETE, turn_id="t1", agent_id="main", canvas="default"):
    response = setup.client.post(BASE.replace("default", canvas) + "/confirmations", json={
        "commands": commands, "turn_id": turn_id, "agent_id": agent_id,
    })
    assert response.status_code == 200, response.text
    return response.json()["data"]


def directory(setup, agent_id="main"):
    return confirmations.confirmations_dir("owner", agent_id, setup.root)


def record(setup, created):
    return confirmations.read_confirmation(directory(setup), created["confirmation_id"])


def decide(setup, created, *, canvas="default", **overrides):
    stored = record(setup, created)
    body = {"decision": "confirmed", "via": "card", "turn_id": "t1",
            "command_hash": stored["command_hash"], **overrides}
    return setup.client.post(
        BASE.replace("default", canvas) + f"/confirmations/{created['confirmation_id']}/decision",
        json=body,
    )


def nodes(setup, *, canvas="default"):
    return [node["id"] for node in canvas_store.read_canvas(setup.root, canvas)["nodes"]]


def notices(setup, agent_id="main", *, canvas="default"):
    scope = ChatScope(kind="project", id="demo", surface="freezone", canvas_id=canvas,
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
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "targets_missing"


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


def runs(setup, *, canvas="default"):
    return workflow_runs.list_workflow_runs(project_dir=setup.root, canvas_id=canvas)


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
        commands = [{"type": "html_artifact", "action": "prepare", "client_id": "h1",
                     "position": {"x": 0, "y": 0}, "workflow_data": {"label": "页面"}}, *PAID]
        expected = {"node_id": "h1", "action": "html_artifact", "label": "html_artifact",
                    "reason": "mixed_commands"}
    response = setup.client.post(BASE + "/confirmations", json={"commands": commands})
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "canvas_open_required"
    assert response.json()["detail"]["blocked"] == [expected]
    assert list(directory(setup).glob("cc_*.json")) == []
    if reason == "mixed_commands":
        assert setup.pool.plan_inputs == []
        assert setup.pool.apply_calls == []


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


MIXED = [
    {"type": "create_node", "client_id": "c1", "node_type": "imageGenNode",
     "position": {"x": 300, "y": 0}, "data": {"label": "新海报"}},
    {"type": "create_edge", "source": "n3", "target": "c1", "link_type": "prompt_for"},
    {"type": "select_nodes", "node_ids": ["c1"], "focus": True},
    {"type": "run_workflow", "node_ids": ["c1"], "scope": "selection"},
]


def mixed_plan(*extra_actions):
    def plan(payload):
        actions = [{"command_index": 0, "node_id": payload["commands"][0]["node_ids"][0],
                    "action": "generate_image", "execution_mode": "task", "label": "新海报"},
                   *deepcopy(extra_actions)]
        return {"ok": True, "actions": actions, "levels": [[i] for i in range(len(actions))],
                "dependencies": {}, "already_completed": False}

    return plan


def created(setup):
    return [node_id for node_id in nodes(setup) if node_id not in {"n1", "n2", "n3"}]


@pytest.mark.parametrize("browser_open", [False, True])
def test_mixed_create_and_run_applies_edits_then_starts_server_run(
    setup, monkeypatch, browser_open,
):
    setup.pool.plan = mixed_plan()
    if browser_open:
        touch_canvas_presence(setup.root, "default", "browser", now=1000)
    confirmation = create(setup, commands=MIXED)
    assert confirmation["kinds"] == ["paid_generation"]
    assert confirmation["targets"] == [
        {"node_id": "c1", "title": "新海报", "node_type": "imageGenNode",
         "action": "run_workflow"},
    ]
    assert nodes(setup) == ["n1", "n2", "n3"]
    preview_id = setup.pool.plan_inputs[-1]["commands"][0]["node_ids"][0]
    if not browser_open:
        def presence_forbidden(*args, **kwargs):
            raise AssertionError("runnable decision must not consult browser presence")

        monkeypatch.setattr(routes, "canvas_browser_open", presence_forbidden)
    response = decide(setup, confirmation)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    real, = created(setup)
    assert real != preview_id
    assert data == {
        "confirmation_id": confirmation["confirmation_id"], "status": "running",
        "run_id": data["run_id"],
        "actions": [{"node_id": real, "action": "generate_image", "label": "新海报"}],
        "refused": [], "result": data["result"],
    }
    assert data["result"]["status"] == "applied"
    assert data["result"]["revision"] == 2
    assert data["result"]["receipt"]["created_node_ids"] == [real]
    assert setup.pool.plan_inputs[-1]["commands"] == [
        {"type": "run_workflow", "node_ids": [real], "scope": "selection"},
    ]
    canvas = canvas_store.read_canvas(setup.root, "default")
    assert next(node for node in canvas["nodes"] if node["id"] == real)["data"] == {
        "label": "新海报",
    }
    assert [(edge["source"], edge["target"]) for edge in canvas["edges"]] == [
        ("n1", "n2"), ("n3", real),
    ]
    run, = runs(setup)
    assert run["run_id"] == data["run_id"]
    assert run["owner_kind"] == "server"
    assert [(a["node_id"], a["action"], a["status"]) for a in run["actions"]] == [
        (real, "generate_image", "pending"),
    ]
    assert record(setup, confirmation)["outcome"] == {
        "status": "running", "run_id": data["run_id"],
    }
    assert [task["task_type"] for task in setup.queued] == ["freezone_workflow_drive"]
    assert list_pending_bridge_messages(
        project_id="proj", canvas_id="default", bridge_dir=directory(setup).parent,
    ) == []
    assert any(data["run_id"] in notice["content"] for notice in notices(setup))


def test_mixed_create_and_run_retry_applies_nothing_twice(setup):
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=MIXED)
    response = decide(setup, confirmation)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "running"
    before = (len(setup.pool.apply_calls), nodes(setup), len(runs(setup)), deepcopy(setup.queued))
    response = decide(setup, confirmation)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "already_handled"
    assert (len(setup.pool.apply_calls), nodes(setup), len(runs(setup)), setup.queued) == before


def test_mixed_edit_failure_starts_no_run(setup, monkeypatch):
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=MIXED)
    claim = confirmations.claim

    def fail_after_claim(*args, **kwargs):
        result = claim(*args, **kwargs)
        setup.pool.apply_fails = True
        return result

    monkeypatch.setattr(confirmations, "claim", fail_after_claim)
    response = decide(setup, confirmation)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data == {"confirmation_id": confirmation["confirmation_id"], "status": "executed",
                    "result": data["result"]}
    assert data["result"]["status"] == "validation_failed"
    assert data["result"]["receipt"]["errors"] == ["edges[0]: target node not found"]
    assert nodes(setup) == ["n1", "n2", "n3"]
    assert runs(setup) == []
    assert setup.queued == []
    stored = record(setup, confirmation)
    assert stored["status"] == "executed"
    assert stored["outcome"] == {"status": "validation_failed", "revision": 1}


def test_mixed_preview_failure_rejects_creation(setup):
    setup.pool.apply_fails = True
    response = setup.client.post(BASE + "/confirmations", json={"commands": MIXED})
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "invalid_agent_canvas_request", "message": "edges[0]: target node not found",
    }
    assert list(directory(setup).glob("cc_*.json")) == []
    assert setup.pool.plan_inputs == []


def test_mixed_request_on_never_saved_canvas_creates_confirmation(setup):
    setup.pool.plan = mixed_plan()
    response = setup.client.post(
        "/projects/proj/freezone/canvases/fresh/confirmations",
        json={"commands": [
            {"type": "create_node", "client_id": "c1", "node_type": "imageGenNode",
             "position": {"x": 0, "y": 0}, "data": {"label": "新海报"}},
            {"type": "run_workflow", "node_ids": ["c1"], "scope": "selection"},
        ]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["kinds"] == ["paid_generation"]
    assert len(list(directory(setup).glob("cc_*.json"))) == 1
    assert canvas_store.read_canvas(setup.root, "fresh") is None


def test_mixed_direct_commands_still_require_confirmation(setup):
    response = setup.client.post(BASE + "/agent-commands", json={"envelopes": [
        {"schema_version": "canvas_chat_commands.v1", "commands": MIXED},
    ]})
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "canvas_confirmation_required", "kinds": ["paid_generation"],
    }
    assert setup.pool.apply_calls == []
    assert nodes(setup) == ["n1", "n2", "n3"]


def test_mixed_metered_run_admits_recipe_once(setup, monkeypatch):
    from tests.recording_usage_meter import RecordingUsageMeter

    setup.pool.plan = mixed_plan()
    commands = deepcopy(MIXED)
    commands[0]["data"]["workflowCatalog"] = {"recipeId": "image-recipe"}
    enqueued = []

    async def enqueue(context, **kwargs):
        assert context is setup.ctx
        enqueued.append(kwargs)
        return SimpleNamespace(task_state=SimpleNamespace(task_id=f"recipe-task-{len(enqueued)}"))

    monkeypatch.setattr(routes, "get_task_backend", lambda: SimpleNamespace(
        enqueue_project_task=enqueue,
    ))
    with RecordingUsageMeter({"freezone_agent_recipe_result"}).registered() as meter:
        confirmation = create(setup, commands=commands)
        assert enqueued == []
        response = decide(setup, confirmation)
        assert response.status_code == 200, response.text
        assert response.json()["data"]["status"] == "running"
        real, = created(setup)
        task, = enqueued
        assert task["task_type"] == "freezone_agent_recipe_result"
        assert task["product_surface"] == "freezone_assistant"
        assert task["payload"]["product_kind"] == "recipe_result"
        assert task["payload"]["artifact_id"] == real
        action, = runs(setup)[0]["actions"]
        assert action["recipe_id"] == "image-recipe"
        assert action["generation_attempt_id"] == (
            f"canvas-confirmation:{confirmation['confirmation_id']}:{real}:generate_image"
        )
        response = decide(setup, confirmation)
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "already_handled"
        assert enqueued == [task]
        assert meter.calls == []


def test_mixed_partial_refusal_reports_refused_after_edits(setup):
    setup.pool.plan = mixed_plan({
        "command_index": 0, "node_id": "n2", "action": "auto_compose_video",
        "execution_mode": "task", "label": "Compose",
    })
    confirmation = create(setup, commands=MIXED)
    response = decide(setup, confirmation)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "running"
    assert data["refused"] == [{
        "node_id": "n2", "action": "auto_compose_video", "label": "Compose",
        "reason": "action_not_on_server", "code": "canvas_open_required",
    }]
    assert len(created(setup)) == 1
    assert data["result"]["status"] == "applied"


@pytest.mark.parametrize("reason,run", [
    ("invalid", {"status": "not_started", "code": "workflow_plan_invalid", "message": "环"}),
    ("blocked", {"status": "not_started", "code": "canvas_open_required",
                 "message": "这些动作需要打开画布才能运行：Compose", "blocked": [{
                     "node_id": "n2", "action": "auto_compose_video", "label": "Compose",
                     "reason": "action_not_on_server",
                 }]}),
])
def test_mixed_run_not_started_after_edits_reports_reason(setup, monkeypatch, reason, run):
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=MIXED)
    claim = confirmations.claim

    def replace_plan_after_claim(*args, **kwargs):
        result = claim(*args, **kwargs)
        if reason == "invalid":
            setup.pool.plan = {"ok": False, "code": "workflow_cycle", "message": "环"}
        else:
            setup.pool.plan = lambda payload: {
                "ok": True, "actions": [{
                    "command_index": 0, "node_id": "n2", "action": "auto_compose_video",
                    "execution_mode": "task", "label": "Compose",
                }], "levels": [[0]], "dependencies": {}, "already_completed": False,
            }
        return result

    monkeypatch.setattr(confirmations, "claim", replace_plan_after_claim)
    response = decide(setup, confirmation)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data == {"confirmation_id": confirmation["confirmation_id"], "status": "executed",
                    "result": data["result"], "run": run}
    assert data["result"]["status"] == "applied"
    assert len(created(setup)) == 1
    assert runs(setup) == []
    assert setup.queued == []
    stored = record(setup, confirmation)
    assert stored["status"] == "executed"
    assert stored["outcome"] == {"status": "applied", "revision": 2, "run": run}
    assert any("workflow run not started" in notice["content"] for notice in notices(setup))


FRESH = "user_owner_fresh"
FRESH_PLAN = [
    {"type": "create_node", "client_id": "c0", "node_type": "textAnnotationNode",
     "position": {"x": 0, "y": 0}, "data": {"label": "短诗"}},
    {"type": "create_node", "client_id": "c1", "node_type": "imageGenNode",
     "position": {"x": 300, "y": 0}, "data": {"label": "新海报"}},
    {"type": "create_edge", "source": "c0", "target": "c1", "link_type": "prompt_for"},
    {"type": "select_nodes", "node_ids": ["c1"], "focus": True},
    {"type": "run_workflow", "node_ids": ["c1"], "scope": "selection"},
]


def test_create_and_run_on_never_saved_canvas_applies_edits_then_starts_server_run(
    setup, monkeypatch,
):
    setup.pool.plan = mixed_plan()
    assert canvas_store.read_canvas(setup.root, FRESH) is None
    confirmation = create(setup, commands=FRESH_PLAN, canvas=FRESH)
    assert confirmation["kinds"] == ["paid_generation"]
    assert confirmation["targets"] == [
        {"node_id": "c1", "title": "新海报", "node_type": "imageGenNode",
         "action": "run_workflow"},
    ]
    assert canvas_store.read_canvas(setup.root, FRESH) is None

    def presence_forbidden(*args, **kwargs):
        raise AssertionError("runnable decision must not consult browser presence")

    monkeypatch.setattr(routes, "canvas_browser_open", presence_forbidden)
    response = decide(setup, confirmation, canvas=FRESH)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "running"
    run_id = data["run_id"]
    assert run_id
    assert data["result"]["status"] == "applied"
    canvas = canvas_store.read_canvas(setup.root, FRESH)
    assert canvas is not None
    assert len(canvas["nodes"]) == 2
    text_node, = [node for node in canvas["nodes"] if node["type"] == "textAnnotationNode"]
    image_node, = [node for node in canvas["nodes"] if node["type"] == "imageGenNode"]
    assert text_node["data"] == {"label": "短诗"}
    assert image_node["data"] == {"label": "新海报"}
    assert [(edge["source"], edge["target"]) for edge in canvas["edges"]] == [
        (text_node["id"], image_node["id"]),
    ]
    assert data["result"]["revision"] == canvas["revision"]
    assert data["actions"] == [
        {"node_id": image_node["id"], "action": "generate_image", "label": "新海报"},
    ]
    run, = runs(setup, canvas=FRESH)
    assert run["run_id"] == run_id
    assert run["owner_kind"] == "server"
    assert [(a["node_id"], a["action"], a["status"]) for a in run["actions"]] == [
        (image_node["id"], "generate_image", "pending"),
    ]
    assert [task["task_type"] for task in setup.queued] == ["freezone_workflow_drive"]
    assert record(setup, confirmation)["outcome"] == {"status": "running", "run_id": run_id}
    assert nodes(setup) == ["n1", "n2", "n3"]


def test_never_saved_canvas_retry_applies_nothing_twice(setup):
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=FRESH_PLAN, canvas=FRESH)
    response = decide(setup, confirmation, canvas=FRESH)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "running"
    before = (len(setup.pool.apply_calls), nodes(setup, canvas=FRESH),
              len(runs(setup, canvas=FRESH)), deepcopy(setup.queued))
    response = decide(setup, confirmation, canvas=FRESH)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "already_handled"
    assert (len(setup.pool.apply_calls), nodes(setup, canvas=FRESH),
            len(runs(setup, canvas=FRESH)), setup.queued) == before


@pytest.mark.parametrize("commands", [DELETE, PAID], ids=["delete", "paid"])
def test_never_saved_canvas_still_rejects_missing_targets(setup, commands):
    response = setup.client.post(
        BASE.replace("default", FRESH) + "/confirmations", json={"commands": commands},
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "targets_missing"
    assert list(directory(setup).glob("cc_*.json")) == []
    assert canvas_store.read_canvas(setup.root, FRESH) is None


def test_never_saved_canvas_in_inaccessible_project_is_refused(setup, monkeypatch):
    async def inaccessible(*args, **kwargs):
        raise HTTPException(404, "project not found")

    monkeypatch.setattr(routes, "_resolve_freezone_project", inaccessible)
    response = setup.client.post(
        "/projects/other/freezone/canvases/user_owner_fresh/confirmations",
        json={"commands": FRESH_PLAN},
    )
    assert response.status_code == 404, response.text
    assert list(directory(setup).glob("cc_*.json")) == []
    assert canvas_store.read_canvas(setup.root, FRESH) is None


def test_existing_canvas_confirmations_are_unchanged(setup):
    deletion = create(setup)
    assert deletion["kinds"] == ["delete_nodes"]
    assert deletion["targets"] == TARGETS
    paid = create(setup, commands=PAID)
    assert paid["kinds"] == ["paid_generation"]
    assert [target["node_id"] for target in paid["targets"]] == ["n1"]
    clearing = create(setup, commands=[{"type": "clear_canvas"}])
    assert clearing["kinds"] == ["clear_canvas"]
    assert [target["node_id"] for target in clearing["targets"]] == ["n1", "n2", "n3"]
    assert nodes(setup) == ["n1", "n2", "n3"]


# External agent key sessions: structure is written now, only paid generation waits.

EXTERNAL = {**AGENT, "external_agent_key_id": "test-external-key-id-not-a-secret"}
SETTINGS_IMAGE = {"label": "新海报", "model": "image-model", "aspectRatio": "16:9",
                  "size": "2K", "quality": "high", "count": 2}
SPLIT = [
    {"type": "create_node", "client_id": "c1", "node_type": "imageGenNode",
     "position": {"x": 300, "y": 0}, "data": SETTINGS_IMAGE},
    {"type": "create_edge", "source": "n3", "target": "c1", "link_type": "prompt_for"},
    {"type": "run_workflow", "node_ids": ["c1"], "scope": "selection"},
]
BASE_RESPONSE_KEYS = {"confirmation_id", "kinds", "targets", "expires_at", "browser_open"}


def external_create(setup, *, commands=SPLIT, canvas="default"):
    setup.user[0] = EXTERNAL
    return create(setup, commands=commands, turn_id=None, canvas=canvas)


def referenced_node_ids(record):
    return {node_id for command in record["commands"]
            for node_id in [*command.get("node_ids", []), command.get("node_id")] if node_id}


def test_external_key_paid_batch_writes_structure_before_confirmation(setup):
    setup.pool.plan = mixed_plan()
    confirmation = external_create(setup)
    real, = created(setup)
    canvas = canvas_store.read_canvas(setup.root, "default")
    assert next(node for node in canvas["nodes"] if node["id"] == real)["data"] == SETTINGS_IMAGE
    assert [(edge["source"], edge["target"]) for edge in canvas["edges"]] == [
        ("n1", "n2"), ("n3", real),
    ]
    assert confirmation["kinds"] == ["paid_generation"]
    assert confirmation["targets"] == [
        {"node_id": real, "title": "新海报", "node_type": "imageGenNode",
         "action": "run_workflow"},
    ]
    assert confirmation["written"] == {
        "revision": canvas["revision"],
        "nodes": [{"client_id": "c1", "node_id": real, "node_type": "imageGenNode",
                   "title": "新海报"}],
        "created_node_ids": [real],
        "created_edge_ids": [canvas["edges"][1]["id"]],
    }
    assert confirmation["generation_settings"] == [{
        "node_id": real, "title": "新海报", "node_type": "imageGenNode",
        "action": "run_workflow", "model": "image-model", "aspect_ratio": "16:9",
        "resolution": "2K", "quality": "high", "count": 2,
    }]
    stored = record(setup, confirmation)
    assert stored["status"] == "pending"
    assert stored["turn_id"] is None
    assert stored["kinds"] == ["paid_generation"]
    assert stored["commands"] == [
        {"type": "run_workflow", "node_ids": [real], "scope": "selection"},
    ]
    assert runs(setup) == []
    assert setup.queued == []


def test_external_key_confirm_runs_the_written_node_without_recreating_it(setup):
    setup.pool.plan = mixed_plan()
    confirmation = external_create(setup)
    real, = created(setup)
    applies = len(setup.pool.apply_calls)
    response = decide(setup, confirmation, via="conversation", turn_id=None)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data == {
        "confirmation_id": confirmation["confirmation_id"], "status": "running",
        "run_id": data["run_id"], "refused": [],
        "actions": [{"node_id": real, "action": "generate_image", "label": "新海报"}],
    }
    assert created(setup) == [real]
    assert len(setup.pool.apply_calls) == applies
    run, = runs(setup)
    assert [(a["node_id"], a["action"]) for a in run["actions"]] == [(real, "generate_image")]
    assert [task["task_type"] for task in setup.queued] == ["freezone_workflow_drive"]


def test_external_key_cancel_keeps_the_written_nodes(setup):
    setup.pool.plan = mixed_plan()
    confirmation = external_create(setup)
    before = canvas_store.read_canvas(setup.root, "default")
    response = decide(setup, confirmation, decision="refused", via="conversation", turn_id=None)
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {
        "confirmation_id": confirmation["confirmation_id"], "status": "refused",
        "applied": False,
    }
    after = canvas_store.read_canvas(setup.root, "default")
    assert (after["nodes"], after["edges"]) == (before["nodes"], before["edges"])
    assert len(created(setup)) == 1
    assert record(setup, confirmation)["status"] == "refused"
    assert runs(setup) == []
    assert setup.queued == []


def test_external_key_expiry_keeps_nodes_and_leaves_no_dangling_reference(setup):
    setup.pool.plan = mixed_plan()
    confirmation = external_create(setup)
    real, = created(setup)
    setup.clock[0] = confirmation["expires_at"]
    response = decide(setup, confirmation, via="conversation", turn_id=None)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "expired"
    stored = record(setup, confirmation)
    assert stored["status"] == "expired"
    on_canvas = set(nodes(setup))
    assert real in on_canvas
    assert referenced_node_ids(stored) <= on_canvas
    assert {target["node_id"] for target in stored["targets"]} <= on_canvas
    assert runs(setup) == []


def test_external_key_identical_resubmit_returns_the_same_confirmation(setup):
    setup.pool.plan = mixed_plan()
    first = external_create(setup)
    canvas = canvas_store.read_canvas(setup.root, "default")
    applies = len(setup.pool.apply_calls)
    second = external_create(setup)
    assert second == first
    again = canvas_store.read_canvas(setup.root, "default")
    assert (again["revision"], again["nodes"], again["edges"]) == (
        canvas["revision"], canvas["nodes"], canvas["edges"],
    )
    assert len(setup.pool.apply_calls) == applies
    assert len(list(directory(setup).glob("cc_*.json"))) == 1


def test_external_key_write_failure_creates_no_confirmation(setup, monkeypatch):
    setup.pool.plan = mixed_plan()

    async def fail_execution(**kwargs):
        raise HTTPException(409, {"code": "canvas_revision_conflict"})

    monkeypatch.setattr(routes, "execute_agent_canvas_envelopes", fail_execution)
    setup.user[0] = EXTERNAL
    response = setup.client.post(BASE + "/confirmations", json={
        "commands": SPLIT, "turn_id": None, "agent_id": "main",
    })
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "canvas_revision_conflict"
    assert list(directory(setup).glob("cc_*.json")) == []
    assert nodes(setup) == ["n1", "n2", "n3"]


@pytest.mark.parametrize("commands", [
    [*SPLIT[:2], {"type": "delete_nodes", "node_ids": ["n2"]}, SPLIT[2]],
    [SPLIT[0], {"type": "clear_canvas"}],
], ids=["delete", "clear"])
def test_external_key_destructive_batch_still_waits_whole(setup, commands):
    setup.pool.plan = mixed_plan()
    confirmation = external_create(setup, commands=commands)
    assert "written" not in confirmation
    assert nodes(setup) == ["n1", "n2", "n3"]
    assert record(setup, confirmation)["commands"] == commands


def test_external_key_paid_run_on_existing_node_lists_its_settings(setup):
    confirmation = external_create(setup, commands=PAID)
    assert "written" not in confirmation
    assert confirmation["generation_settings"] == [
        {"node_id": "n1", "title": "海报", "node_type": "imageGenNode",
         "action": "generate_image"},
    ]
    assert record(setup, confirmation)["commands"] == PAID


@pytest.mark.parametrize("user,turn_id", [
    (USER, "t1"), (AGENT, "t1"), (AGENT, None), (EXTERNAL, "t1"),
], ids=["browser", "agent-turn", "agent-turnless", "external-key-turn"])
def test_in_product_paid_batches_still_wait_whole(setup, user, turn_id):
    setup.pool.plan = mixed_plan()
    setup.user[0] = user
    confirmation = create(setup, commands=SPLIT, turn_id=turn_id)
    assert set(confirmation) == BASE_RESPONSE_KEYS
    assert nodes(setup) == ["n1", "n2", "n3"]
    stored = record(setup, confirmation)
    assert stored["commands"] == SPLIT
    assert "pre_applied" not in stored


def test_browser_executor_keeps_external_key_batches_whole(setup, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    confirmation = external_create(setup)
    assert "written" not in confirmation
    assert nodes(setup) == ["n1", "n2", "n3"]
    assert record(setup, confirmation)["commands"] == SPLIT


# External agent key sessions: concurrent and repeated identical batches write one set.


def external_post(setup, commands=SPLIT):
    return setup.client.post(BASE + "/confirmations", json={
        "commands": commands, "turn_id": None, "agent_id": "main",
    })


def concurrent_external_posts(setup, batches):
    setup.user[0] = EXTERNAL
    ready = Barrier(len(batches))

    def post(commands):
        ready.wait(timeout=30)
        return external_post(setup, commands)

    with ThreadPoolExecutor(len(batches)) as executor:
        return list(executor.map(post, batches))


def stored_records(setup):
    return [confirmations.read_confirmation(directory(setup), path.stem)
            for path in directory(setup).glob("cc_*.json")]


def edit_canvas(setup, change):
    canvas_store.save_canvas(setup.root, "default", base_revision=canvas_store.read_canvas(
        setup.root, "default")["revision"], build_payload=lambda old: change(deepcopy(old)))


def assert_one_written_set(setup, confirmation_ids):
    real, = created(setup)
    stored, = stored_records(setup)
    assert set(confirmation_ids) == {stored["id"]}
    assert stored["status"] == "pending"
    assert referenced_node_ids(stored) == {real}
    edges = canvas_store.read_canvas(setup.root, "default")["edges"]
    assert [(edge["source"], edge["target"]) for edge in edges] == [("n1", "n2"), ("n3", real)]
    return real


@pytest.mark.parametrize("workers", [2, 8])
def test_external_key_concurrent_identical_batches_write_one_set(setup, workers):
    setup.pool.plan = mixed_plan()
    setup.pool.apply_delay = 0.2
    responses = concurrent_external_posts(setup, [SPLIT] * workers)
    assert [response.status_code for response in responses] == [200] * workers, [
        response.text for response in responses]
    data = [response.json()["data"] for response in responses]
    assert all(item == data[0] for item in data)
    assert_one_written_set(setup, [item["confirmation_id"] for item in data])


def _run_processes(processes) -> None:
    started = []
    try:
        for process in processes:
            process.start()
            started.append(process)
        for process in started:
            process.join(timeout=120)
        for process in started:
            assert not process.is_alive()
            assert process.exitcode == 0
    finally:
        for process in started:
            if process.is_alive():
                process.terminate()
                process.join(timeout=10)


def _external_create_in_process(root: str, prefix: str, ready, result_path: str) -> None:
    try:
        harness = _harness(Path(root), setattr, os.environ.__setitem__, seed=False)
        harness.pool.plan = mixed_plan()
        harness.pool.id_prefix = prefix
        harness.pool.apply_delay = 0.3
        harness.user[0] = EXTERNAL
        with TestClient(harness.app) as client:
            ready.wait(timeout=60)
            response = client.post(BASE + "/confirmations", json={
                "commands": SPLIT, "turn_id": None, "agent_id": "main",
            })
        outcome = {"status": response.status_code, "body": response.json()}
    except Exception as exc:  # reported to the parent test as data
        outcome = {"status": "error", "error": repr(exc)}
    Path(result_path).write_text(json.dumps(outcome), encoding="utf-8")


@pytest.mark.parametrize("workers", [2, 8])
def test_external_key_identical_batches_across_processes_write_one_set(
    monkeypatch, tmp_path, workers,
):
    harness = _harness(tmp_path, monkeypatch.setattr, monkeypatch.setenv)
    context = multiprocessing.get_context("spawn")
    ready = context.Barrier(workers)
    results = [tmp_path / f"result-{index}.json" for index in range(workers)]
    _run_processes([
        context.Process(
            target=_external_create_in_process,
            args=(str(tmp_path), f"p{index}-", ready, str(path)),
        )
        for index, path in enumerate(results)
    ])
    outcomes = [json.loads(path.read_text(encoding="utf-8")) for path in results]
    assert [outcome["status"] for outcome in outcomes] == [200] * workers, outcomes
    assert_one_written_set(
        harness, [outcome["body"]["data"]["confirmation_id"] for outcome in outcomes],
    )


def test_external_key_concurrent_distinct_batches_each_get_their_own_set(setup):
    setup.pool.plan = mixed_plan()
    setup.pool.apply_delay = 0.2
    other = deepcopy(SPLIT)
    other[0]["position"] = {"x": 600, "y": 0}
    other[0]["data"] = {**SETTINGS_IMAGE, "label": "另一张海报"}
    responses = concurrent_external_posts(setup, [SPLIT, other])
    assert [response.status_code for response in responses] == [200, 200], [
        response.text for response in responses]
    ids = [response.json()["data"]["confirmation_id"] for response in responses]
    assert len(set(ids)) == 2
    written = set(created(setup))
    assert len(written) == 2
    stored = stored_records(setup)
    assert sorted(item["id"] for item in stored) == sorted(ids)
    assert set().union(*(referenced_node_ids(item) for item in stored)) == written


@pytest.mark.parametrize("error", [
    HTTPException(409, {"code": "canvas_revision_conflict"}),
    CanvasCoreError("canvas_core_timeout", "Canvas core call timed out"),
], ids=["http", "core"])
def test_external_key_write_failure_releases_the_batch_lock(setup, monkeypatch, error):
    setup.pool.plan = mixed_plan()
    monkeypatch.setattr(confirmations, "SPLIT_LOCK_WAIT_SECONDS", 0.5)
    real_execute = routes.execute_agent_canvas_envelopes
    calls = []

    async def fail_once(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise error
        return await real_execute(**kwargs)

    monkeypatch.setattr(routes, "execute_agent_canvas_envelopes", fail_once)
    setup.user[0] = EXTERNAL
    failed = external_post(setup)
    assert failed.status_code in {409, 503}, failed.text
    assert stored_records(setup) == []
    confirmation = external_create(setup)
    assert len(calls) == 2
    assert_one_written_set(setup, [confirmation["confirmation_id"]])


def test_external_key_stuck_write_gives_up_the_lock_after_the_hold_limit(setup, monkeypatch):
    setup.pool.plan = mixed_plan()
    monkeypatch.setattr(confirmations, "SPLIT_LOCK_HOLD_SECONDS", 0.2)
    setup.pool.apply_delay = 1.0
    setup.user[0] = EXTERNAL
    stuck = external_post(setup)
    assert stuck.status_code == 503, stuck.text
    assert stuck.json()["detail"]["code"] == "canvas_confirmation_timeout"
    setup.pool.apply_delay = 0.0
    confirmation = external_create(setup)
    assert_one_written_set(setup, [confirmation["confirmation_id"]])


def test_external_key_retry_after_record_failure_reuses_the_written_nodes(setup, monkeypatch):
    setup.pool.plan = mixed_plan()
    real_create = confirmations.create_confirmation

    def disk_full(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(confirmations, "create_confirmation", disk_full)
    setup.user[0] = EXTERNAL
    with pytest.raises(OSError, match="disk full"):
        external_post(setup)
    written, = created(setup)
    before = canvas_store.read_canvas(setup.root, "default")
    monkeypatch.setattr(confirmations, "create_confirmation", real_create)
    confirmation = external_create(setup)
    after = canvas_store.read_canvas(setup.root, "default")
    assert (after["revision"], after["nodes"], after["edges"]) == (
        before["revision"], before["nodes"], before["edges"],
    )
    assert assert_one_written_set(setup, [confirmation["confirmation_id"]]) == written
    assert [node["node_id"] for node in confirmation["written"]["nodes"]] == [written]
    assert record(setup, confirmation)["commands"] == [
        {"type": "run_workflow", "node_ids": [written], "scope": "selection"},
    ]


def _end_confirmation(setup, confirmation, how):
    if how == "refused":
        response = decide(setup, confirmation, decision="refused", via="conversation",
                          turn_id=None)
        assert response.status_code == 200, response.text
    elif how == "expired":
        setup.clock[0] = confirmation["expires_at"]
    else:
        response = decide(setup, confirmation, via="conversation", turn_id=None)
        assert response.status_code == 200, response.text
        assert response.json()["data"]["status"] == "running"


@pytest.mark.parametrize("how", ["refused", "expired", "confirmed"])
def test_external_key_resubmit_after_the_confirmation_ended_reuses_the_written_nodes(
    setup, how,
):
    setup.pool.plan = mixed_plan()
    first = external_create(setup)
    real, = created(setup)
    _end_confirmation(setup, first, how)
    before = canvas_store.read_canvas(setup.root, "default")
    second = external_create(setup)
    assert second["confirmation_id"] != first["confirmation_id"]
    assert second["written"] == first["written"]
    assert second["targets"] == first["targets"]
    assert created(setup) == [real]
    after = canvas_store.read_canvas(setup.root, "default")
    assert (after["nodes"], after["edges"]) == (before["nodes"], before["edges"])
    stored = record(setup, second)
    assert stored["status"] == "pending"
    assert stored["commands"] == [
        {"type": "run_workflow", "node_ids": [real], "scope": "selection"},
    ]
    assert [item["id"] for item in stored_records(setup)
            if item["status"] == "pending" and setup.clock[0] < item["expires_at"]] == [
        second["confirmation_id"]]


def _rename_written_node(real):
    def change(canvas):
        node = next(node for node in canvas["nodes"] if node["id"] == real)
        node["data"]["label"] = "用户改过的标题"
        return {**canvas, "revision": canvas["revision"] + 1}
    return change


def _delete_written_node(real):
    def change(canvas):
        return {**canvas, "revision": canvas["revision"] + 1,
                "nodes": [node for node in canvas["nodes"] if node["id"] != real],
                "edges": [edge for edge in canvas["edges"] if real not in {
                    edge["source"], edge["target"]}]}
    return change


def _delete_written_edge(real):
    def change(canvas):
        return {**canvas, "revision": canvas["revision"] + 1,
                "edges": [edge for edge in canvas["edges"] if edge["target"] != real]}
    return change


@pytest.mark.parametrize("change", [
    "node_edited", "node_deleted", "edge_deleted", "window_passed",
])
def test_external_key_resubmit_after_changes_writes_a_new_set(setup, change):
    setup.pool.plan = mixed_plan()
    first = external_create(setup)
    real, = created(setup)
    _end_confirmation(setup, first, "refused")
    if change == "window_passed":
        setup.clock[0] += 24 * 3600 + 1
    else:
        edit_canvas(setup, {
            "node_edited": _rename_written_node, "node_deleted": _delete_written_node,
            "edge_deleted": _delete_written_edge,
        }[change](real))
    second = external_create(setup)
    newer = [node_id for node_id in created(setup) if node_id != real]
    assert len(newer) == 1
    assert [node["node_id"] for node in second["written"]["nodes"]] == newer
    assert record(setup, second)["commands"] == [
        {"type": "run_workflow", "node_ids": newer, "scope": "selection"},
    ]


def test_external_key_written_batch_markers_are_cleaned_after_the_reuse_window(setup):
    setup.pool.plan = mixed_plan()
    first = external_create(setup)
    _end_confirmation(setup, first, "refused")
    assert len(list(directory(setup).glob("split_*.json"))) == 1
    confirmations.expire_due(directory(setup), now=1000 + 24 * 3600 - 1)
    assert len(list(directory(setup).glob("split_*.json"))) == 1
    confirmations.expire_due(directory(setup), now=1000 + 24 * 3600 + 1)
    assert list(directory(setup).glob("split_*.json")) == []


# Workflow draft delivery through paid canvas confirmations.


def _claimed_confirmation_draft(setup, monkeypatch, status="submitted"):
    draft = workflow_drafts.create_workflow_draft(
        project_dir=setup.root,
        project_id="proj",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "Create an ad"},
        compiled={
            "ok": True, "skill_id": "video-ad", "edge_count": 0,
            "plan": {
                "summary": "Ad", "inputs": {}, "phases": ["image"],
                "nodes": [{"id": "c1", "name": "Poster", "node_type": "imageGenNode",
                           "stage": "image"}],
                "edges": [],
            },
        },
        run_after_create=True,
    )
    scope = {"project_dir": setup.root, "canvas_id": "default", "draft_id": draft["draft_id"]}
    claimed, error = workflow_drafts.claim_workflow_draft_confirmation(
        **scope, revision=1, now=setup.clock[0],
    )
    assert error is None
    assert claimed is not None
    started_at = claimed["confirmation_started_at"]
    bound = workflow_drafts.bind_workflow_draft_task(
        **scope, task_id="task-1", root_task_id="task-1",
        expected_confirmation_started_at=started_at,
    )
    assert bound is not None
    if status == "submitted":
        workflow_drafts.finish_workflow_draft_confirmation(
            **scope, outcome="submitted", expected_task_id="task-1", expected_revision=1,
        )

    def get_task_for_project(ctx, task_type, index, beat_num=None, scope=None):
        return SimpleNamespace(task_id="task-1", status="running")

    monkeypatch.setattr(
        "novelvideo.task_state.get_task_manager",
        lambda: SimpleNamespace(get_task_for_project=get_task_for_project),
    )
    draft = _read_confirmation_draft(setup, draft)
    assert draft["status"] == status
    commands = deepcopy(MIXED)
    commands[0]["data"].update({
        "workflowInstanceId": draft["draft_id"], "workflowDraftRevision": 1,
        "workflowConfirmationTaskId": "task-1",
    })
    return draft, started_at, commands


def _read_confirmation_draft(setup, draft):
    stored, error = workflow_drafts.read_workflow_draft(
        project_dir=setup.root, canvas_id="default", draft_id=draft["draft_id"],
    )
    assert error is None
    assert stored is not None
    return stored


@pytest.mark.parametrize("status", ["confirming", "submitted"])
def test_paid_confirmation_refusal_releases_workflow_draft(setup, monkeypatch, status):
    draft, _, commands = _claimed_confirmation_draft(setup, monkeypatch, status)
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=commands)

    response = decide(setup, confirmation, decision="refused")

    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "refused"
    stored = _read_confirmation_draft(setup, draft)
    assert stored["status"] == "ready"
    assert stored["confirmation_started_at"] is None
    claimed, error = workflow_drafts.claim_workflow_draft_confirmation(
        project_dir=setup.root, canvas_id="default", draft_id=draft["draft_id"], revision=1,
    )
    assert error is None
    assert claimed is not None and claimed["status"] == "confirming"


@pytest.mark.parametrize("status", ["confirming", "submitted"])
def test_paid_confirmation_list_expiry_releases_workflow_draft(setup, monkeypatch, status):
    draft, _, commands = _claimed_confirmation_draft(setup, monkeypatch, status)
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=commands)
    setup.clock[0] = record(setup, confirmation)["expires_at"] + 1

    response = setup.client.get(BASE + "/confirmations")

    assert response.status_code == 200, response.text
    assert response.json()["data"]["confirmations"] == []
    assert record(setup, confirmation)["status"] == "expired"
    assert _read_confirmation_draft(setup, draft)["status"] == "ready"


@pytest.mark.parametrize("status", ["confirming", "submitted"])
def test_paid_confirmation_expired_decision_releases_workflow_draft(setup, monkeypatch, status):
    draft, _, commands = _claimed_confirmation_draft(setup, monkeypatch, status)
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=commands)
    setup.clock[0] = record(setup, confirmation)["expires_at"] + 1

    response = decide(setup, confirmation)

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "expired"
    assert _read_confirmation_draft(setup, draft)["status"] == "ready"


@pytest.mark.parametrize("status", ["confirming", "submitted"])
def test_paid_confirmation_edit_failure_releases_workflow_draft(setup, monkeypatch, status):
    draft, _, commands = _claimed_confirmation_draft(setup, monkeypatch, status)
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=commands)
    claim = confirmations.claim

    def fail_after_claim(*args, **kwargs):
        result = claim(*args, **kwargs)
        setup.pool.apply_fails = True
        return result

    monkeypatch.setattr(confirmations, "claim", fail_after_claim)

    response = decide(setup, confirmation)

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "executed"
    assert data["result"]["status"] == "validation_failed"
    assert created(setup) == []
    assert nodes(setup) == ["n1", "n2", "n3"]
    assert _read_confirmation_draft(setup, draft)["status"] == "ready"


@pytest.mark.parametrize("status", ["confirming", "submitted"])
def test_paid_confirmation_execution_error_releases_workflow_draft(setup, monkeypatch, status):
    draft, _, commands = _claimed_confirmation_draft(setup, monkeypatch, status)
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=commands)

    async def fail_execution(**kwargs):
        raise HTTPException(422, {"message": "Command rejected"})

    monkeypatch.setattr(routes, "execute_agent_canvas_envelopes", fail_execution)

    response = decide(setup, confirmation)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {"message": "Command rejected"}
    assert record(setup, confirmation)["status"] == "voided"
    assert _read_confirmation_draft(setup, draft)["status"] == "ready"


def test_paid_confirmation_success_confirms_workflow_draft(setup, monkeypatch):
    draft, _, commands = _claimed_confirmation_draft(setup, monkeypatch)
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=commands)

    response = decide(setup, confirmation)

    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "running"
    assert _read_confirmation_draft(setup, draft)["status"] == "confirmed"


def test_workflow_confirmation_runner_stops_after_refusal_release(setup, monkeypatch):
    from novelvideo.task_backend.runners.freezone import _run_freezone_workflow_confirm_async

    draft, started_at, commands = _claimed_confirmation_draft(setup, monkeypatch)
    setup.pool.plan = mixed_plan()
    confirmation = create(setup, commands=commands)
    response = decide(setup, confirmation, decision="refused")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "refused"
    envelope = {
        "payload": {
            "canvas_id": "default", "draft_id": draft["draft_id"], "revision": 1,
            "plan_digest": draft["plan_digest"], "confirmation_started_at": started_at,
        },
        "__run_task_id": "task-1",
    }

    async def wait_for_delivery():
        return await asyncio.wait_for(
            _run_freezone_workflow_confirm_async(envelope, SimpleNamespace(state_dir=setup.root)),
            timeout=3,
        )

    with pytest.raises(RuntimeError, match="not delivered"):
        asyncio.run(wait_for_delivery())


@pytest.mark.parametrize("receipt,expected_status", [
    pytest.param({
        "tool_call_status": "failed", "canvas_apply_status": "failed", "applied": False,
        "applied_count": 0, "created_node_ids": [], "errors": ["x"],
    }, "ready", id="nothing_applied"),
    pytest.param({
        "tool_call_status": "completed", "canvas_apply_status": "applied", "applied": True,
        "applied_count": 4, "created_node_ids": ["node-1"], "errors": [],
    }, "confirmed", id="success"),
    pytest.param({
        "tool_call_status": "failed", "canvas_apply_status": "partially_applied", "applied": False,
        "applied_count": 2, "created_node_ids": ["node-1"], "errors": ["x"],
    }, "submitted", id="partially_applied"),
])
def test_paid_confirmation_browser_receipt_updates_workflow_draft(
    setup, monkeypatch, receipt, expected_status,
):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    touch_canvas_presence(setup.root, "default", "browser", now=1000)
    draft, _, commands = _claimed_confirmation_draft(setup, monkeypatch)
    confirmation = create(setup, commands=commands)
    response = decide(setup, confirmation)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "submitted"
    bridge_key = data["bridge_key"]
    frames = list_pending_bridge_messages(
        project_id="proj", canvas_id="default", bridge_dir=directory(setup).parent,
    )
    assert len(frames) == 1
    assert frames[0]["envelope"]["confirmation_id"] == confirmation["confirmation_id"]

    async def project_state_dir(user, payload):
        return setup.root

    monkeypatch.setattr(chat, "_bridge_project_state_dir", project_state_dir)

    result = asyncio.run(chat.resolve_canvas_command_tool_result(
        chat.CanvasCommandToolResultIn(
            bridge_key=bridge_key, project_id="proj", canvas_id="default", turn_id="t1",
            **receipt,
        ),
        user=USER,
    ))

    assert result["ok"] is True
    assert result["data"]["canvas_apply_status"] == receipt["canvas_apply_status"]
    assert record(setup, confirmation)["status"] == "executed"
    assert _read_confirmation_draft(setup, draft)["status"] == expected_status

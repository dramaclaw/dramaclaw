# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Agent tools that list and create canvases, and the chat's widened write scope.

The plugin talks to the real freezone router through a fake ``urlopen``; canvas
rules run in the real Node worker. No media task is ever enqueued.
"""

import asyncio
import email.message
import hashlib
import io
import json
import re
import sys
import time
from http import HTTPStatus
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from jsonschema import Draft202012Validator

from canvas_core_requirements import CANVAS_CORE_BUNDLE, requires_canvas_core_bundle
from novelvideo import config
from novelvideo.api import freezone_server_workflow_host, freezone_server_workflow_start
from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import freezone as routes
from novelvideo.chat import agent_api_errors, dramaclaw_mcp, tool_policy
from novelvideo.freezone import agent_canvas, canvas_confirmations, canvas_core_pool
from novelvideo.freezone import canvas_command_bridge, canvas_creation, canvas_store
from novelvideo.freezone.canvas_core_pool import CanvasCorePool
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend import client as task_client
from test_freezone_plugin import _restore_tools_registry_modules as _restore_tools_registry_modules

pytestmark = requires_canvas_core_bundle

CREATE = "freezone_create_canvas"
LIST = "freezone_list_canvases"
AGENT = {
    "id": "u-alice", "username": "alice", "credential_kind": "agent_session",
    "scopes": ["projects:read", "projects:write"],
    "current_scope_kind": "project", "current_project_id": "proj",
}
LOCAL_AGENT = {"id": "u-alice", "username": "alice", "credential_kind": "local_trusted_agent"}
MODEL = {"id": "image-model", "apiModel": "image-model", "providerId": "openai"}
IMAGE = {"prompt": "A ship", "model": "image-model", "aspectRatio": "1:1", "size": "1K",
         "quality": "standard", "count": 1}
CREATE_PATH = "/api/v1/projects/proj/freezone/canvases:create"
VIEW_PATH = "/api/v1/projects/proj/freezone/canvases:agent-view"
LIST_PATH_RE = re.compile(r"/freezone/canvases(:agent-view)?$")


class _Response:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    def read(self, *_args):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _request_id(project, turn, name):
    key = json.dumps([project, turn, name.strip()], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _payload(value):
    return json.loads(value) if isinstance(value, str) else value


def _seed(root, canvas_id, *, name="Seed", creator="alice", metadata=None):
    return canvas_store.save_canvas(
        root, canvas_id, base_revision=None,
        build_payload=lambda _: {
            "schema_version": 2, "canvas_id": canvas_id, "project_id": "proj",
            "revision": 1, "nodes": [], "edges": [],
            "metadata": metadata if metadata is not None else {
                "canvas_origin": "user_created", "display_name": name,
                "creator_username": creator,
            },
        },
    ).payload


def _read(root, canvas_id):
    return canvas_store.read_canvas(root, canvas_id)


@pytest.fixture
def pool():
    worker = CanvasCorePool(CANVAS_CORE_BUNDLE, size=2)
    try:
        yield worker
    finally:
        worker.close()


@pytest.fixture
def agent(monkeypatch, tmp_path, pool):
    for name in ("tools", "tools.registry"):
        sys.modules.pop(name, None)
    ctx = ProjectContext(
        project_id="proj", project_name="demo", owner_type="user", owner_id="u-alice",
        owner_username="alice", requester_user_id="u-alice", requester_username="alice",
        requester_principals=(("user", "u-alice"),), effective_role="editor",
        home_node_id="node-a", output_dir=tmp_path / "output", state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime", is_home_node=False,
    )
    h = SimpleNamespace(
        ctx=ctx, root=ctx.state_dir, user=dict(AGENT), executor="server", requests=[],
        enqueued=[], pool=pool, monkeypatch=monkeypatch, tmp=tmp_path,
    )

    async def resolve(project, user, **kwargs):
        if project != "proj":
            raise HTTPException(404, "Project not found")
        return h.ctx, "alice", "demo", tmp_path / "output", str(tmp_path / "output")

    async def image_models(_user_id):
        return {"models": [MODEL]}

    async def video_models(_user_id):
        return {"models": []}

    async def enqueue(*args, **kwargs):
        h.enqueued.append((args, kwargs))
        raise AssertionError("no media task may be enqueued")

    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "_freezone_image_models_data", image_models)
    monkeypatch.setattr(routes, "_freezone_video_models_data", video_models)
    monkeypatch.setattr(routes, "get_task_backend", lambda: SimpleNamespace(
        enqueue_project_task=enqueue,
    ))
    monkeypatch.setattr(task_client, "enqueue_project_task", enqueue)
    for module in (
        canvas_creation, agent_canvas, freezone_server_workflow_start,
        freezone_server_workflow_host, canvas_core_pool,
    ):
        monkeypatch.setattr(module, "get_canvas_core_pool", lambda: h.pool)
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "index")
    for name, value in {
        "DRAMACLAW_AGENT_CANVAS_EXECUTOR": "server",
        "DRAMACLAW_CANVAS_PATCH_PUSH": "1",
        "DRAMACLAW_API_URL": "http://testserver",
        "DRAMACLAW_AGENT_TOKEN": "token",
        "DRAMACLAW_PROJECT_ID": "proj",
        "DRAMACLAW_CANVAS_ID": "default",
        "DRAMACLAW_TURN_ID": "turn-1",
        "DRAMACLAW_TOOL_MODE": "freezone_canvas",
        "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR": str(tmp_path / "bridge"),
        "SUPERTALE_OPENFILM_STUDIO_ENABLED": "1",
    }.items():
        monkeypatch.setenv(name, value)
    for name in (
        "DRAMACLAW_EXTERNAL_MCP", "DRAMACLAW_AGENT_PROFILE", "DRAMACLAW_AGENT_TOKEN_FILE",
        "DRAMACLAW_LOCAL_AGENT_TRUST",
    ):
        monkeypatch.delenv(name, raising=False)
    canvas_store.ensure_default_canvas(h.root, project_id="proj")

    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: h.user
    with TestClient(app) as client:
        def urlopen(request, timeout=None):
            parts = urlsplit(request.full_url)
            body = json.loads(request.data) if request.data else None
            h.requests.append(
                (request.get_method(), parts.path, dict(parse_qsl(parts.query)), body)
            )
            if parts.path == "/api/v1/config":
                return _Response(200, json.dumps({
                    "ok": True, "data": {"agent_canvas_executor": h.executor},
                }).encode())
            target = parts.path + (f"?{parts.query}" if parts.query else "")
            response = client.request(
                request.get_method(), target, content=request.data,
                headers={"Content-Type": "application/json"},
            )
            if response.status_code >= 400:
                raise HTTPError(
                    request.full_url, response.status_code,
                    HTTPStatus(response.status_code).phrase, email.message.Message(),
                    io.BytesIO(response.content),
                )
            return _Response(response.status_code, response.content)

        plugin = dramaclaw_mcp._load_plugin("freezone")
        monkeypatch.setattr(plugin, "urlopen", urlopen)
        h.plugin = plugin
        h.index = dramaclaw_mcp._tool_index(plugin)
        h.tools = {tool.name: tool for tool in dramaclaw_mcp.build_mcp_tools(h.index)}

        def call(name, args):
            result = asyncio.run(dramaclaw_mcp.call_tool(name, args, tool_index=h.index))
            Draft202012Validator(h.tools[name].outputSchema).validate(result.structuredContent)
            return result.structuredContent

        def handler(name, args):
            value = _payload(h.index[name][1](args))
            Draft202012Validator(h.tools[name].outputSchema).validate(value)
            return value

        def use_executor(value):
            h.executor = value
            plugin._AGENT_CANVAS_EXECUTOR_CACHE = None

        h.call = call
        h.handler = handler
        h.use_executor = use_executor
        yield h
    assert h.enqueued == []


def _posts(h, path=CREATE_PATH):
    return [body for method, request_path, _query, body in h.requests
            if method == "POST" and request_path == path]


def _created(h, name="Plan B"):
    result = h.call(CREATE, {"name": name})
    assert result["ok"] is True, result
    return result


# --- publishing -----------------------------------------------------------------


def test_tools_are_published_with_strict_inputs(agent):
    create = agent.tools[CREATE].inputSchema
    assert create["required"] == ["name"]
    assert create["additionalProperties"] is False
    assert create["properties"]["name"]["type"] == "string"
    assert create["properties"]["name"]["minLength"] == 1
    assert create["properties"]["name"]["maxLength"] == 100
    assert set(create["properties"]) == {"name", "project_id"}
    listing = agent.tools[LIST].inputSchema
    assert listing["required"] == []
    assert listing["additionalProperties"] is False
    assert set(listing["properties"]) == {"project_id"}
    for name in (CREATE, LIST):
        assert agent.tools[name].outputSchema["additionalProperties"] is False


def test_create_tool_is_a_canvas_write_and_list_is_not():
    assert CREATE in tool_policy.FREEZONE_CANVAS_WRITE_TOOLS
    for name, value in vars(tool_policy).items():
        if name.isupper() and isinstance(value, (set, frozenset)):
            assert LIST not in value, name


def test_lock_busy_keeps_its_code_through_the_shared_error_filter():
    result = agent_api_errors._http_error_result(
        503, json.dumps({"detail": {"code": "canvas_lock_busy", "message": "busy"}}),
        "Service Unavailable",
    )
    assert result["code"] == "canvas_lock_busy"
    assert result["error"] == "busy"


# --- create: success and idempotency --------------------------------------------


def test_create_records_this_chat_and_returns_a_link(agent):
    result = _created(agent)
    canvas_id = result["canvas_id"]
    assert result["status"] == "created"
    assert canvas_id.startswith("canvas_")
    assert result["project_id"] == "proj"
    assert "Plan B" in result["display_name"]
    assert isinstance(result["revision"], int)
    link = f"/projects/proj/freezone?canvas={canvas_id}"
    assert result["canvas_path"] == link
    assert canvas_id in result["agent_instruction"]
    assert link in result["agent_instruction"]
    assert "applied" not in result
    assert _posts(agent) == [{
        "name": "Plan B",
        "request_id": _request_id("proj", "turn-1", "Plan B"),
        "origin": {"chat_canvas_id": "default", "turn_id": "turn-1"},
    }]
    saved = _read(agent.root, canvas_id)
    assert saved["metadata"]["agent_origin"] == {
        "chat_canvas_id": "default", "turn_id": "turn-1",
    }
    assert saved["metadata"]["creator_username"] == "alice"


def test_same_turn_retry_returns_the_same_canvas(agent):
    first = _created(agent)
    again = agent.call(CREATE, {"name": "  Plan B "})
    assert again["ok"] is True
    assert again["status"] == "exists"
    assert again["canvas_id"] == first["canvas_id"]
    request_ids = {body["request_id"] for body in _posts(agent)}
    assert request_ids == {_request_id("proj", "turn-1", "Plan B")}
    owned = [item for item in canvas_store.list_canvases(agent.root)
             if item["id"] != "default"]
    assert [item["id"] for item in owned] == [first["canvas_id"]]


def test_next_turn_with_the_same_name_is_a_duplicate(agent, monkeypatch):
    first = _created(agent)
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-2")
    result = agent.call(CREATE, {"name": "Plan B"})
    assert result["ok"] is False
    assert result["status"] == "rejected"
    assert result["code"] == "duplicate_name"
    assert result["retryable"] is False
    assert result["existing_canvas_id"] == first["canvas_id"]
    assert result["rejection"]["existing_canvas_id"] == first["canvas_id"]
    assert first["canvas_id"] in result["agent_instruction"]
    assert "canvas_id" not in result
    assert len([i for i in canvas_store.list_canvases(agent.root) if i["id"] != "default"]) == 1


def test_without_a_turn_each_call_gets_a_fresh_request(agent, monkeypatch):
    monkeypatch.delenv("DRAMACLAW_TURN_ID")
    first = _created(agent)
    second = agent.call(CREATE, {"name": "Plan B"})
    assert second["code"] == "duplicate_name"
    assert second["existing_canvas_id"] == first["canvas_id"]
    ids = [body["request_id"] for body in _posts(agent)]
    assert len(ids) == 2 and ids[0] != ids[1]
    assert all(re.fullmatch(r"[0-9a-f]{32}", value) for value in ids)
    assert _posts(agent)[0]["origin"] == {"chat_canvas_id": "default", "turn_id": ""}
    assert _read(agent.root, first["canvas_id"])["metadata"]["agent_origin"] == {
        "chat_canvas_id": "default", "turn_id": "",
    }


def test_session_without_a_bound_canvas_sends_no_origin(agent, monkeypatch):
    for name in ("DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID", "DRAMACLAW_TURN_ID"):
        monkeypatch.delenv(name)
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    agent.user = dict(LOCAL_AGENT)
    result = agent.call(CREATE, {"name": "Outside plan", "project_id": "proj"})
    assert result["ok"] is True and result["status"] == "created"
    (body,) = _posts(agent)
    assert "origin" not in body
    assert re.fullmatch(r"[0-9a-f]{32}", body["request_id"])
    assert "agent_origin" not in _read(agent.root, result["canvas_id"])["metadata"]


# --- create: refusals -----------------------------------------------------------


def test_quota_reached_is_not_retryable(agent):
    for index in range(25):
        _seed(agent.root, f"canvas_seed_{index}", name=f"Seed {index}")
    result = agent.call(CREATE, {"name": "Plan B"})
    assert result["ok"] is False and result["status"] == "rejected"
    assert result["code"] == "quota_reached"
    assert result["rejection"] == {"code": "quota_reached", "limit": 25}
    assert result["retryable"] is False
    assert "25" in result["agent_instruction"]


def test_unknown_requester_quota_is_not_retryable(agent):
    from dataclasses import replace

    agent.ctx = replace(agent.ctx, requester_username="")
    result = agent.call(CREATE, {"name": "Plan B"})
    assert result["code"] == "quota_unknown"
    assert result["retryable"] is False


def test_blank_name_asks_for_a_real_name_with_an_example(agent):
    result = agent.call(CREATE, {"name": "   "})
    assert result["ok"] is False and result["status"] == "rejected"
    assert result["code"] == "name_required"
    assert result["retryable"] is True
    Draft202012Validator(agent.tools[CREATE].inputSchema).validate(result["example"])
    assert result["example"]["name"].strip()


def test_id_taken_is_not_retryable(agent):
    planned = agent.pool.call("plan_canvas_creation", {
        "project_id": "proj", "name": "Plan Z", "creator_username": "alice",
        "request_id": "probe", "save_source": "manual_save", "canvases": [],
        "env": {"locale": "en"},
    })["canvasId"]
    _seed(agent.root, planned, name="Unrelated", creator="bob")
    result = agent.call(CREATE, {"name": "Plan Z"})
    assert result["code"] == "id_taken"
    assert result["retryable"] is False
    assert result["rejection"]["canvas_id"] == planned


def test_overlong_name_is_refused_before_any_request(agent):
    result = agent.call(CREATE, {"name": "x" * 101})
    assert agent.requests == []
    assert result["ok"] is False
    assert result["error"] == "tool_arguments_invalid"
    assert result["retryable"] is True
    assert result["errors"][0]["path"] == "name"
    assert "100" in result["agent_instruction"]
    assert "keep the user's real values" in result["agent_instruction"]
    Draft202012Validator(agent.tools[CREATE].inputSchema).validate(result["example"])


def test_overlong_name_reaching_the_server_is_a_retryable_argument_error(agent):
    result = agent.handler(CREATE, {"name": "x" * 101})
    assert len(_posts(agent)) == 1
    assert result["ok"] is False
    assert result["code"] == "invalid_arguments"
    assert result["retryable"] is True
    Draft202012Validator(agent.tools[CREATE].inputSchema).validate(result["example"])


def test_lock_busy_is_retryable_with_the_same_call(agent, monkeypatch):
    _seed(agent.root, "canvas_seed", creator="bob")
    call = agent.pool.call

    def always_change(op, payload):
        result = call(op, payload)
        if op == "plan_canvas_creation":
            current = canvas_store.read_canvas(agent.root, "canvas_seed")
            canvas_store.save_canvas(
                agent.root, "canvas_seed", base_revision=current["revision"],
                build_payload=lambda existing: {
                    **existing, "revision": existing["revision"] + 1,
                    "metadata": {**existing["metadata"],
                                 "display_name": f"Changed {existing['revision']}"},
                },
            )
        return result

    monkeypatch.setattr(agent.pool, "call", always_change)
    result = agent.call(CREATE, {"name": "Plan B"})
    assert result["ok"] is False
    assert result["code"] == "canvas_lock_busy"
    assert result["retryable"] is True
    assert result["example"]["name"] == "Plan B"
    Draft202012Validator(agent.tools[CREATE].inputSchema).validate(result["example"])


@pytest.mark.parametrize("tool,args", [(CREATE, {"name": "Plan B"}), (LIST, {})])
def test_missing_canvas_core_is_not_retryable(agent, tool, args):
    agent.pool = CanvasCorePool(agent.tmp / "missing-canvas-core.mjs", size=1)
    try:
        result = agent.call(tool, args)
    finally:
        agent.pool.close()
    assert result["ok"] is False
    assert result["code"] == "canvas_core_unavailable"
    assert result["retryable"] is False


@pytest.mark.parametrize("tool,args", [(CREATE, {"name": "Plan B"}), (LIST, {})])
def test_token_bound_to_another_project_is_forbidden(agent, tool, args):
    agent.user = {**AGENT, "current_project_id": "other"}
    result = agent.call(tool, args)
    assert result["ok"] is False
    assert result["code"] == "forbidden"
    assert result["retryable"] is False


@pytest.mark.parametrize("tool,args", [
    (CREATE, {"name": "Plan B", "project_id": "ghost"}), (LIST, {"project_id": "ghost"}),
])
def test_unknown_project_is_not_found(agent, monkeypatch, tool, args):
    for name in ("DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID"):
        monkeypatch.delenv(name)
    agent.user = dict(LOCAL_AGENT)
    result = agent.call(tool, args)
    assert result["ok"] is False
    assert result["code"] == "not_found"
    assert result["retryable"] is False


@pytest.mark.parametrize("tool,args", [
    (CREATE, {"name": "Plan B", "project_id": "other"}), (LIST, {"project_id": "other"}),
])
def test_other_project_than_the_bound_one_is_refused_locally(agent, tool, args):
    result = agent.call(tool, args)
    assert result["ok"] is False
    assert result["code"] == "scope_mismatch"
    assert [r for r in agent.requests if r[1] != "/api/v1/config"] == []


@pytest.mark.parametrize("tool,args", [(CREATE, {"name": "Plan B"}), (LIST, {})])
def test_browser_executor_refuses_both_tools(agent, tool, args):
    agent.use_executor("browser")
    result = agent.call(tool, args)
    assert result["ok"] is False
    assert result["code"] == "canvas_server_executor_required"
    assert result["retryable"] is False
    assert [(method, path) for method, path, _q, _b in agent.requests] == [
        ("GET", "/api/v1/config"),
    ]
    assert [item["id"] for item in canvas_store.list_canvases(agent.root)] == ["default"]


# --- list -----------------------------------------------------------------------


def test_list_marks_canvases_created_by_this_chat(agent):
    created = _created(agent)
    _seed(agent.root, "canvas_bob", name="Bob plan", creator="bob")
    result = agent.call(LIST, {})
    assert result["ok"] is True
    assert result["status"] == "listed"
    assert result["project_id"] == "proj"
    assert result["bound_canvas_id"] == "default"
    rows = {row["canvas_id"]: row for row in result["canvases"]}
    assert set(rows) == {"default", "canvas_bob", created["canvas_id"]}
    assert result["count"] == 3
    mine = rows[created["canvas_id"]]
    assert set(mine) == {
        "canvas_id", "display_name", "kind", "creator_username", "created_by_viewer",
        "created_from_this_chat", "modified_at", "canvas_link_markdown",
    }
    # The listing labels the link with its own display name (the switcher label), and it
    # points at the same canvas as the link the creation result handed over.
    assert mine["canvas_link_markdown"] == _link(mine["display_name"], created["canvas_id"])
    target = f"](/projects/proj/freezone?canvas={created['canvas_id']})"
    assert mine["canvas_link_markdown"].endswith(target)
    assert created["canvas_link_markdown"].endswith(target)
    assert "canvas_link_markdown" not in rows["canvas_bob"]
    assert "canvas_link_markdown" not in rows["default"]
    assert "canvas_link_markdown" in result["agent_instruction"]
    assert (mine["created_by_viewer"], mine["created_from_this_chat"]) == (True, True)
    assert (rows["canvas_bob"]["created_by_viewer"],
            rows["canvas_bob"]["created_from_this_chat"]) == (False, False)
    assert result["quota"] == {"status": "available", "used": 1, "limit": 25}
    views = [(query, body) for method, path, query, body in agent.requests
             if method == "GET" and path == VIEW_PATH]
    assert views == [({"chat_canvas_id": "default"}, None)]


# --- widened write scope: 7 relaxed, 1 clarification, 3 strict ------------------


class Passed(BaseException):
    """Raised by the first call after a site's scope check."""


def _raise_passed(*_args, **_kwargs):
    raise Passed


COMMANDS = [{"type": "select_nodes", "node_ids": []}]
PAID = [{"type": "run_node_action", "node_id": "n1", "action": "generate_image"}]

STRICT_SITES = {
    "skill_studio_event": lambda p, project, canvas: p._emit_skill_studio_event(
        project, canvas, {"type": "probe"}),
    "skill_studio_progress": lambda p, project, canvas: p._emit_skill_studio_progress_event(
        project, canvas, {"type": "probe"}),
    "clarification_event": lambda p, project, canvas: p._emit_clarification_event(
        project, canvas, {"type": "probe"}),
}
# Nobody listens on a canvas this chat created, so a clarification there is
# answered with "no interface" instead of being sent there or to the bound canvas.
CLARIFY_SITES = {
    "request_user_clarification": lambda p, project, canvas:
        p._handle_request_user_clarification({"project_id": project, "canvas_id": canvas}),
}
RELAXED_SITES = {
    "create_confirmation": lambda p, project, canvas: p._create_canvas_confirmation(
        project, canvas, PAID),
    "approved_frontend_commands": lambda p, project, canvas:
        p._dispatch_mcp_approved_frontend_commands(
            project=project, canvas=canvas, commands=COMMANDS, slim_result=True),
    "frontend_commands": lambda p, project, canvas: p._dispatch_frontend_canvas_commands(
        project=project, canvas=canvas, commands=COMMANDS, slim_result=True),
    "decide_confirmation": lambda p, project, canvas: p._decide_canvas_confirmation(
        {"confirmation_id": "cc_probe", "project_id": project, "canvas_id": canvas},
        "confirmed"),
    "server_apply": lambda p, project, canvas: p._server_apply_canvas_commands(
        project, canvas, COMMANDS, slim_result=True),
    "canvas_context": lambda p, project, canvas: p._request_canvas_context_from_frontend(
        project=project, canvas=canvas, requests=[]),
    "studio_tool": lambda p, project, canvas: p._handle_studio_tool(
        {"project_id": project, "canvas_id": canvas, "node_id": "n"},
        tool_name="freezone_studio_get_film", method="GET", suffix="film"),
}
# Sites that read the real canvas list to recognise canvases this chat created.
LISTED_SITES = {**RELAXED_SITES, **CLARIFY_SITES}
SITES = {**STRICT_SITES, **CLARIFY_SITES, **RELAXED_SITES}
CLARIFY = "freezone_request_user_clarification"
NO_UI = "clarification_ui_unavailable"


@pytest.fixture
def seams(agent, monkeypatch):
    plugin = agent.plugin
    for name in (
        "put_pending_canvas_command", "canvas_command_bridge_key",
        "canvas_command_idempotency_key", "skill_studio_bridge_key",
        "clarification_bridge_key", "_resume_clarification", "_canvas_command_envelope",
    ):
        monkeypatch.setattr(plugin, name, _raise_passed, raising=False)
    original = plugin._request
    lookups = []
    failure = {"value": None}

    def request(method, path, **kwargs):
        if method == "GET" and LIST_PATH_RE.search(path):
            lookups.append(path)
            if isinstance(failure["value"], Exception):
                raise failure["value"]
            if failure["value"] is not None:
                return failure["value"]
            return original(method, path, **kwargs)
        raise Passed

    monkeypatch.setattr(plugin, "_request", request)
    plugin._AGENT_CANVAS_EXECUTOR_CACHE = (time.monotonic(), "server")
    _seed(agent.root, "canvas_b", name="From this chat",
          metadata={"canvas_origin": "user_created", "display_name": "B",
                    "creator_username": "alice",
                    "agent_origin": {"chat_canvas_id": "default", "turn_id": "turn-1"}})
    _seed(agent.root, "canvas_c", name="Somebody else's")
    _seed(agent.root, "canvas_d", name="Other chat",
          metadata={"canvas_origin": "user_created", "display_name": "D",
                    "creator_username": "alice",
                    "agent_origin": {"chat_canvas_id": "other-chat", "turn_id": "t"}})
    return SimpleNamespace(plugin=plugin, lookups=lookups, failure=failure)


def _site_outcome(seams, site, project, canvas):
    try:
        result = SITES[site](seams.plugin, project, canvas)
    except Passed:
        return "passed"
    payload = _payload(result)
    if payload.get("code") == NO_UI:
        return "no_ui"
    assert payload["code"] == "scope_mismatch", payload
    return "refused"


@pytest.mark.parametrize("site", sorted(SITES))
@pytest.mark.parametrize("canvas", ["default", "canvas_b", "canvas_c", "canvas_d", "canvas_ghost"])
def test_bound_scope_allows_only_canvases_this_chat_created(seams, site, canvas):
    expected = "refused"
    if canvas == "default" or (canvas == "canvas_b" and site in RELAXED_SITES):
        expected = "passed"
    elif canvas == "canvas_b" and site in CLARIFY_SITES:
        expected = "no_ui"
    assert _site_outcome(seams, site, "proj", canvas) == expected
    if canvas == "default" or site in STRICT_SITES:
        assert seams.lookups == []


@pytest.mark.parametrize("site", sorted(SITES))
def test_another_project_is_refused_without_a_lookup(seams, site):
    assert _site_outcome(seams, site, "other", "canvas_b") == "refused"
    assert seams.lookups == []


@pytest.mark.parametrize("site", sorted(LISTED_SITES))
@pytest.mark.parametrize("failure", [
    {"ok": False, "status": "failed", "status_code": 503, "error": "down"},
    RuntimeError("network down"),
])
def test_failed_lookup_fails_closed(seams, site, failure):
    seams.failure["value"] = failure
    assert _site_outcome(seams, site, "proj", "canvas_b") == "refused"


@pytest.mark.parametrize("site", sorted(LISTED_SITES))
def test_browser_executor_keeps_the_bound_canvas_only(seams, site):
    """The browser bridge only serves the bound canvas, so nothing is widened there."""
    seams.plugin._AGENT_CANVAS_EXECUTOR_CACHE = (time.monotonic(), "browser")
    assert _site_outcome(seams, site, "proj", "canvas_b") == "refused"
    assert seams.lookups == []


@pytest.mark.parametrize("site", sorted(SITES))
def test_project_level_session_may_name_any_canvas(seams, monkeypatch, site):
    monkeypatch.delenv("DRAMACLAW_CANVAS_ID")
    assert _site_outcome(seams, site, "proj", "canvas_c") == "passed"
    assert seams.lookups == []


# --- how a canvas outside this chat is refused ----------------------------------

# canvas_c was made in the browser, canvas_d by another chat, canvas_ghost does not exist.
OUT_OF_SCOPE = ("canvas_c", "canvas_d", "canvas_ghost")
STEER_TO_BOUND = (
    "Retry the same call with exactly", "omit project_id and canvas_id", "session defaults",
)


def _site_refusal(seams, site, project, canvas):
    try:
        result = SITES[site](seams.plugin, project, canvas)
    except Passed:
        pytest.fail(f"{site} let {project}/{canvas} through")
    payload = _payload(result)
    assert payload["ok"] is False and payload["code"] == "scope_mismatch", payload
    return payload


def _assert_not_usable_from_this_chat(payload, canvas):
    """Refused, not retryable, and nothing points the Agent at the bound canvas."""
    assert payload["status"] == "scope_mismatch"
    assert payload["retryable"] is False
    assert payload["next_action"] == "list_canvases_or_tell_user"
    # The bound canvas id is not handed over as a value to copy into a retry.
    assert "canvas_id" not in payload, payload
    assert canvas in payload["error"]
    instruction = payload["agent_instruction"]
    assert "freezone_list_canvases" in instruction
    assert "created_from_this_chat" in instruction
    assert "explicitly asks" in instruction
    for phrase in STEER_TO_BOUND:
        assert phrase not in instruction, instruction


def _assert_retry_with_bound_scope(payload):
    assert payload["status"] == "scope_mismatch"
    assert payload["retryable"] is True
    assert payload["next_action"] == "retry_with_bound_scope"
    assert payload["canvas_id"] == "default"
    assert payload["agent_instruction"].startswith("Retry the same call with exactly")


@pytest.mark.parametrize("site", sorted(LISTED_SITES))
@pytest.mark.parametrize("canvas", OUT_OF_SCOPE)
def test_canvas_outside_this_chat_is_refused_without_pointing_at_the_bound_canvas(
    seams, site, canvas,
):
    _assert_not_usable_from_this_chat(_site_refusal(seams, site, "proj", canvas), canvas)
    assert seams.lookups, "the decision comes from the real canvas list"


@pytest.mark.parametrize("site", sorted(LISTED_SITES))
@pytest.mark.parametrize("failure", [
    {"ok": False, "status": "failed", "status_code": 503, "error": "down"},
    RuntimeError("network down"),
])
def test_failed_lookup_refuses_without_pointing_at_the_bound_canvas(seams, site, failure):
    seams.failure["value"] = failure
    _assert_not_usable_from_this_chat(_site_refusal(seams, site, "proj", "canvas_b"), "canvas_b")


@pytest.mark.parametrize("site", sorted(SITES))
@pytest.mark.parametrize("canvas", ["default", "canvas_b", "canvas_d"])
def test_another_project_keeps_retry_with_bound_scope(seams, site, canvas):
    _assert_retry_with_bound_scope(_site_refusal(seams, site, "other", canvas))
    assert seams.lookups == []


@pytest.mark.parametrize("site", sorted(STRICT_SITES))
@pytest.mark.parametrize("canvas", ["canvas_b", *OUT_OF_SCOPE])
def test_strict_sites_keep_retry_with_bound_scope(seams, site, canvas):
    _assert_retry_with_bound_scope(_site_refusal(seams, site, "proj", canvas))
    assert seams.lookups == []


@pytest.mark.parametrize("site", sorted(LISTED_SITES))
@pytest.mark.parametrize("canvas", ["canvas_b", *OUT_OF_SCOPE])
def test_browser_executor_keeps_retry_with_bound_scope(seams, site, canvas):
    seams.plugin._AGENT_CANVAS_EXECUTOR_CACHE = (time.monotonic(), "browser")
    _assert_retry_with_bound_scope(_site_refusal(seams, site, "proj", canvas))
    assert seams.lookups == []


# --- stage 3 acceptance through MCP ---------------------------------------------


def _node_ids(root, canvas_id):
    return [node["id"] for node in _read(root, canvas_id)["nodes"]]


def test_harness_writes_and_confirms_on_the_bound_canvas(agent):
    """Baseline for the acceptance test: the bound canvas behaves as before."""
    written = agent.call("freezone_create_node", {
        "node_type": "textAnnotationNode", "data": {"title": "On A", "content": "a"},
    })
    assert written["ok"] is True, written
    assert len(_node_ids(agent.root, "default")) == 1
    image = agent.call("freezone_create_node", {
        "node_type": "imageGenNode", "data": IMAGE,
    })
    (node_id,) = image["created_node_ids"]
    paid = agent.call("freezone_run_node_action", {"node_id": node_id, "action": "generate_image"})
    assert paid["code"] == "canvas_confirmation_required", paid
    assert paid["canvas_apply_status"] == "awaiting_confirmation"


def test_chat_works_on_the_canvas_it_created(agent, monkeypatch):
    default_before = _read(agent.root, "default")
    created = _created(agent)
    b = created["canvas_id"]

    on_b = agent.call("freezone_create_node", {
        "canvas_id": b, "node_type": "textAnnotationNode",
        "data": {"title": "On B", "content": "b"},
    })
    assert on_b["ok"] is True, on_b
    assert len(_node_ids(agent.root, b)) == 1
    assert _read(agent.root, "default")["revision"] == default_before["revision"]

    no_id = agent.call("freezone_create_node", {
        "node_type": "textAnnotationNode", "data": {"title": "On A", "content": "a"},
    })
    assert no_id["ok"] is True, no_id
    assert len(_node_ids(agent.root, "default")) == 1
    assert len(_node_ids(agent.root, b)) == 1

    _seed(agent.root, "canvas_c", name="Not from this chat")
    for other in ("canvas_c", "canvas_ghost"):
        refused = agent.call("freezone_create_node", {
            "canvas_id": other, "node_type": "textAnnotationNode",
            "data": {"title": "No", "content": "no"},
        })
        assert refused["ok"] is False and refused["code"] == "scope_mismatch", refused
    assert _node_ids(agent.root, "canvas_c") == []
    assert _read(agent.root, "canvas_ghost") is None

    monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-2")
    image = agent.call("freezone_create_node", {
        "canvas_id": b, "node_type": "imageGenNode",
        "data": IMAGE,
    })
    assert image["ok"] is True, image
    (node_id,) = image["created_node_ids"]
    paid = agent.call("freezone_run_node_action", {
        "canvas_id": b, "node_id": node_id, "action": "generate_image",
    })
    assert paid["code"] == "canvas_confirmation_required", paid
    assert paid["canvas_apply_status"] == "awaiting_confirmation"
    record = canvas_confirmations.read_confirmation(
        canvas_confirmations.confirmations_dir("alice", "main", agent.root),
        paid["confirmation_id"],
    )
    assert record["canvas_id"] == b
    assert record["status"] == "pending"


def test_refusal_through_mcp_does_not_move_the_write_to_the_bound_canvas(agent):
    """A write aimed at a canvas outside this chat stays refused end to end."""
    default_before = _read(agent.root, "default")
    _seed(agent.root, "canvas_c", name="Made in the browser")
    _seed(agent.root, "canvas_d", name="Other chat",
          metadata={"canvas_origin": "user_created", "display_name": "D",
                    "creator_username": "alice",
                    "agent_origin": {"chat_canvas_id": "other-chat", "turn_id": "t"}})
    for canvas in OUT_OF_SCOPE:
        refused = agent.call("freezone_create_node", {
            "canvas_id": canvas, "node_type": "textAnnotationNode",
            "data": {"title": "Elsewhere", "content": "meant for another canvas"},
        })
        assert refused["ok"] is False and refused["code"] == "scope_mismatch", refused
        _assert_not_usable_from_this_chat(refused, canvas)
    assert _read(agent.root, "default")["revision"] == default_before["revision"]
    assert _node_ids(agent.root, "default") == []
    assert _node_ids(agent.root, "canvas_c") == []
    assert _node_ids(agent.root, "canvas_d") == []
    assert _read(agent.root, "canvas_ghost") is None

    other_project = agent.call("freezone_create_node", {
        "project_id": "other", "canvas_id": "canvas_c", "node_type": "textAnnotationNode",
        "data": {"title": "Elsewhere", "content": "wrong project"},
    })
    _assert_retry_with_bound_scope(other_project)


# --- clarification when no interface can answer it -------------------------------

QUESTION = {"questions": [{"id": "tone", "title": "Which tone?", "options": [
    {"id": "warm", "label": "Warm"}, {"id": "calm", "label": "Calm"},
]}]}


@pytest.fixture
def external(agent, monkeypatch):
    """An external MCP host: no product chat turn, so no card can be answered."""
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.delenv("DRAMACLAW_TURN_ID", raising=False)
    monkeypatch.setenv("DRAMACLAW_CLARIFICATION_RESULT_TIMEOUT_SECONDS", "3")
    return agent


def _pending_cards(h, canvas):
    return canvas_command_bridge.list_pending_bridge_messages(
        project_id="proj", canvas_id=canvas, kinds={"clarification_event"},
        bridge_dir=h.tmp / "bridge",
    )


def _timed(h, name, args):
    started = time.monotonic()
    result = h.call(name, args)
    return result, time.monotonic() - started


def _assert_no_ui(payload, canvas):
    assert payload["ok"] is False, payload
    assert payload["status"] == payload["code"] == NO_UI
    assert payload["tool_call_status"] == "completed"
    assert payload["clarification_status"] == "not_shown"
    assert payload["canvas_id"] == canvas
    assert payload["retryable"] is False
    assert payload["next_action"] == "continue_with_stated_assumptions_or_ask_in_conversation"
    for key in ("answers", "recommended_answers", "bridge_key", "questions"):
        assert key not in payload, payload
    instruction = payload["agent_instruction"]
    for phrase in (
        "Do not call freezone_request_user_clarification again",
        "Do not move this request to another canvas",
        "state the assumptions",
        "ask the user in this conversation",
        "Never choose generation settings",
        "more expensive",
        "confirmation_required",
    ):
        assert phrase in instruction, instruction
    for phrase in STEER_TO_BOUND:
        assert phrase not in instruction, instruction


def test_external_clarification_returns_at_once_without_leaving_a_card(external):
    result, seconds = _timed(external, CLARIFY, QUESTION)
    assert seconds < 2
    _assert_no_ui(result, "default")
    assert _pending_cards(external, "default") == []
    assert [method for method, *_ in external.requests if method != "GET"] == []


@pytest.mark.parametrize("external_host", [False, True])
def test_clarification_on_a_canvas_this_chat_created_stays_off_the_bound_canvas(
    agent, monkeypatch, external_host,
):
    if external_host:
        monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
        monkeypatch.delenv("DRAMACLAW_TURN_ID")
    monkeypatch.setenv("DRAMACLAW_CLARIFICATION_RESULT_TIMEOUT_SECONDS", "3")
    b = _created(agent)["canvas_id"]
    result, seconds = _timed(agent, CLARIFY, {"canvas_id": b, **QUESTION})
    assert seconds < 2
    _assert_no_ui(result, b)
    assert _pending_cards(agent, b) == []
    assert _pending_cards(agent, "default") == []


@pytest.mark.parametrize(("external_mcp", "turn_id"), [
    (None, "turn-1"),  # in-app Hermes or Codex with a product chat turn
    (None, None),  # in-app Hermes sessions do not always carry a turn id
    ("1", "turn-1"),  # in-app Codex sets DRAMACLAW_EXTERNAL_MCP for its MCP server
])
def test_clarification_with_a_listener_still_waits_on_the_card(
    agent, monkeypatch, external_mcp, turn_id,
):
    for name, value in (("DRAMACLAW_EXTERNAL_MCP", external_mcp), ("DRAMACLAW_TURN_ID", turn_id)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    monkeypatch.setenv("DRAMACLAW_CLARIFICATION_RESULT_TIMEOUT_SECONDS", "1")
    result = agent.call(CLARIFY, QUESTION)
    assert result["status"] == "clarification_frontend_timeout", result
    assert result["clarification_status"] == "pending_user_input"
    assert len(_pending_cards(agent, "default")) == 1


def test_external_agent_without_interface_builds_on_a_new_canvas(external):
    """List, create, ask (no interface), then write a text node on the new canvas."""
    default_before = _read(external.root, "default")
    listed = external.call(LIST, {})
    assert listed["ok"] is True, listed
    b = _created(external, "Autumn poem")["canvas_id"]

    asked, seconds = _timed(external, CLARIFY, {"canvas_id": b, **QUESTION})
    assert seconds < 2
    _assert_no_ui(asked, b)

    built = external.call("freezone_emit_canvas_command", {"canvas_id": b, "commands": [{
        "type": "create_node", "node_type": "textAnnotationNode", "client_id": "poem",
        "data": {"displayName": "Autumn", "content": "Leaves fall"},
    }]})
    assert built["ok"] is True, built
    (node,) = _read(external.root, b)["nodes"]
    assert node["type"] == "textAnnotationNode"
    assert node["data"]["displayName"] == "Autumn"
    assert node["data"]["content"] == "Leaves fall"
    assert _read(external.root, "default")["revision"] == default_before["revision"]
    assert _pending_cards(external, "default") == []
    assert _pending_cards(external, b) == []


ASK_BEFORE_CREATING = (
    "No canvas is needed to ask the user",
    "do not create one before they answer",
    "right before you prepare the workflow draft or write the nodes",
    "keep using it and do not create another",
)
GENERATION_SETTINGS = {"generation_media_types": ["image"]}


@pytest.mark.parametrize("bound_canvas", ["default", None])
def test_external_agent_asks_for_settings_before_creating_a_canvas(
    external, monkeypatch, bound_canvas,
):
    """A new generation request: ask first, with or without a bound canvas, and create nothing."""
    if bound_canvas is None:
        monkeypatch.delenv("DRAMACLAW_CANVAS_ID")
    asked, seconds = _timed(external, CLARIFY, GENERATION_SETTINGS)
    assert seconds < 2
    assert asked["status"] == asked["code"] == NO_UI, asked
    assert asked["retryable"] is False
    instruction = " ".join(asked["agent_instruction"].split())
    for phrase in ASK_BEFORE_CREATING:
        assert phrase in instruction, instruction
    assert _posts(external) == []
    assert [method for method, *_ in external.requests if method != "GET"] == []
    assert _pending_cards(external, "default") == []


def test_external_agent_on_a_canvas_it_created_keeps_using_it(external):
    b = _created(external, "Rainy street")["canvas_id"]
    asked = external.call(CLARIFY, {"canvas_id": b, **GENERATION_SETTINGS})
    _assert_no_ui(asked, b)
    instruction = " ".join(asked["agent_instruction"].split())
    assert "keep using it and do not create another" in instruction, instruction
    assert len(_posts(external)) == 1


@pytest.mark.parametrize(("external_mcp", "turn_id"), [
    (None, "turn-1"),
    (None, None),
    ("1", "turn-1"),
])
def test_in_product_no_interface_instruction_has_no_external_guidance(
    agent, monkeypatch, external_mcp, turn_id,
):
    """In-product chats still get the unchanged text on a canvas they created."""
    for name, value in (("DRAMACLAW_EXTERNAL_MCP", external_mcp), ("DRAMACLAW_TURN_ID", turn_id)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    monkeypatch.setenv("DRAMACLAW_CLARIFICATION_RESULT_TIMEOUT_SECONDS", "3")
    b = _created(agent)["canvas_id"]
    asked = agent.call(CLARIFY, {"canvas_id": b, **QUESTION})
    _assert_no_ui(asked, b)
    for phrase in ASK_BEFORE_CREATING:
        assert phrase not in asked["agent_instruction"]


# --- text node fields: displayName or title, plus content -------------------------


def _text_schema(h):
    return h.plugin._TEXT_ANNOTATION_DATA_SCHEMA


@pytest.mark.parametrize("data", [
    {"displayName": "Plan", "content": "body"},
    {"title": "Plan", "content": "body"},
])
def test_text_node_accepts_display_name_or_title(agent, data):
    written = agent.call("freezone_create_node", {"node_type": "textAnnotationNode", "data": data})
    assert written["ok"] is True, written
    (node,) = _read(agent.root, "default")["nodes"]
    assert node["data"]["displayName"] == "Plan"
    assert node["data"]["content"] == "body"


@pytest.mark.parametrize(("data", "paths"), [
    ({"content": "body"}, ["data"]),
    ({"displayName": "Plan"}, ["data.content"]),
    ({"title": "Plan", "content": "  "}, ["data.content"]),
    ({}, ["data.content", "data"]),
    (None, ["data"]),
])
def test_text_node_refusal_names_each_missing_field(agent, data, paths):
    args = {"node_type": "textAnnotationNode", "position": {"x": 40, "y": 60}}
    if data is not None:
        args["data"] = data
    refused = agent.call("freezone_create_node", args)
    assert refused["ok"] is False, refused
    assert refused["status"] == "invalid_command_schema"
    assert refused["retryable"] is True
    assert [error["path"] for error in refused["errors"]] == paths
    assert {error["problem"] for error in refused["errors"]} == {"missing_field"}
    for error in refused["errors"]:
        assert error["accepted"] and "example" in error, error
    assert "data" in refused["error"]
    assert refused["message"] == "; ".join(error["message"] for error in refused["errors"])
    example = refused["example"]
    Draft202012Validator(agent.tools["freezone_create_node"].inputSchema).validate(example)
    Draft202012Validator(_text_schema(agent)).validate(example["data"])
    assert {key: value for key, value in example.items() if key != "data"} == {
        key: value for key, value in args.items() if key != "data"
    }
    for key, value in (data or {}).items():
        if str(value).strip():
            assert example["data"][key] == value
    assert "keep the user's real values" in refused["agent_instruction"]
    assert "displayName" in refused["agent_instruction"]
    assert _node_ids(agent.root, "default") == []


def test_add_next_node_text_refusal_through_a_batch(agent):
    args = {"commands": [{
        "type": "add_next_node", "source_node_id": "n-src", "node_type": "textAnnotationNode",
        "client_id": "next", "data": {"content": "next step"},
    }]}
    refused = agent.call("freezone_emit_canvas_command", args)
    assert refused["ok"] is False, refused
    assert refused["status"] == "invalid_command_schema"
    assert refused["retryable"] is True
    assert [error["path"] for error in refused["errors"]] == ["commands[0].data"]
    example = refused["example"]
    Draft202012Validator(
        agent.tools["freezone_emit_canvas_command"].inputSchema
    ).validate(example)
    (command,) = example["commands"]
    Draft202012Validator(_text_schema(agent)).validate(command["data"])
    assert command["data"]["content"] == "next step"
    assert command["source_node_id"] == "n-src"
    assert command["client_id"] == "next"
    assert _node_ids(agent.root, "default") == []


# --- a ready link to the new canvas in product chat --------------------------------


def _link(display_name, canvas_id, project="proj"):
    label = re.sub(r"([\\`*_\[\]<>~|])", r"\\\1", display_name)
    return f"[{label}](/projects/{project}/freezone?canvas={canvas_id})"


def test_product_chat_gets_a_ready_markdown_link(agent):
    result = _created(agent, "Autumn poem")
    canvas_id = result["canvas_id"]
    path = f"/projects/proj/freezone?canvas={canvas_id}"
    assert result["canvas_path"] == path
    assert result["canvas_link_markdown"] == _link(result["display_name"], canvas_id)
    instruction = result["agent_instruction"]
    assert result["canvas_link_markdown"] in instruction
    assert "exactly as given" in instruction


def test_markdown_link_escapes_the_canvas_name(agent):
    result = _created(agent, "Plan [B] (draft) *v2*")
    canvas_id = result["canvas_id"]
    link = result["canvas_link_markdown"]
    assert link == _link(result["display_name"], canvas_id)
    assert link.endswith(f"](/projects/proj/freezone?canvas={canvas_id})")
    assert "\\[B\\]" in link and "\\*v2\\*" in link
    assert result["canvas_path"] == f"/projects/proj/freezone?canvas={canvas_id}"


def test_external_agent_keeps_the_plain_canvas_path(external):
    result = _created(external, "Autumn poem")
    canvas_id = result["canvas_id"]
    path = f"/projects/proj/freezone?canvas={canvas_id}"
    assert result["canvas_path"] == path
    assert "canvas_link_markdown" not in result
    assert path in result["agent_instruction"]
    assert "exactly as given" not in result["agent_instruction"]
    listed = external.call(LIST, {})
    assert listed["ok"] is True, listed
    assert all("canvas_link_markdown" not in row for row in listed["canvases"])


# --- node action catalog for a node id that is not on the canvas -------------------


def _context_posts(h, canvas):
    path = f"/api/v1/projects/proj/freezone/canvases/{canvas}/agent-context"
    return [body for method, request_path, _query, body in h.requests
            if method == "POST" and request_path == path]


def test_invented_node_id_on_a_new_canvas_is_refused_once(agent):
    b = _created(agent, "Autumn")["canvas_id"]
    invented = f"{b}:new-ginkgo-image"
    result = agent.call("freezone_get_node_action_catalog", {
        "canvas_id": b, "node_id": invented, "action": "generate_image",
    })
    assert result["ok"] is False, result
    assert result["status"] == result["code"] == "node_not_found"
    assert result["retryable"] is False
    assert result["node_id"] == invented
    assert result["canvas_id"] == b
    assert "freezone_summarize_canvas" in result["agent_instruction"]
    assert len(_context_posts(agent, b)) == 1
    assert _node_ids(agent.root, b) == []


def test_real_node_still_gets_its_action_catalog(agent):
    image = agent.call("freezone_create_node", {"node_type": "imageGenNode", "data": IMAGE})
    (node_id,) = image["created_node_ids"]
    result = agent.call("freezone_get_node_action_catalog", {"node_id": node_id})
    assert result["ok"] is True, result
    (response,) = result["responses"]
    assert response["type"] == "node_action_catalog"
    assert isinstance(response["data"], dict)
    missing = agent.call("freezone_get_node_action_catalog", {"node_id": "default:nope"})
    assert missing["code"] == "node_not_found", missing


# --- external key sessions: write the structure now, confirm only paid generation ---

EXTERNAL_KEY_ID = "test-external-key-id-not-a-secret"
CAT_BATCH = [
    {"type": "create_node", "client_id": "cat_prompt", "node_type": "textAnnotationNode",
     "data": {"displayName": "Prompt", "content": "An orange cat on a windowsill, watercolor",
              "semanticOutputRole": "input_text"},
     "position": {"x": 160, "y": 160}},
    {"type": "add_next_node", "source_node_id": "cat_prompt", "client_id": "cat_image",
     "node_type": "imageGenNode",
     "data": {"displayName": "Cat watercolor", "model": "image-model", "aspectRatio": "1:1",
              "size": "1K", "quality": "standard", "count": 1}},
    {"type": "create_edge", "source": "cat_prompt", "target": "cat_image",
     "link_type": "prompt_for"},
    {"type": "run_node_action", "node_id": "cat_image", "action": "generate_image"},
]


def _confirmation_record(h, confirmation_id):
    return canvas_confirmations.read_confirmation(
        canvas_confirmations.confirmations_dir("alice", "main", h.root), confirmation_id,
    )


def test_server_preflight_maps_a_next_node_to_its_own_client_id(agent):
    result = asyncio.run(freezone_server_workflow_start.check_server_workflow(
        ctx=agent.ctx, state_dir=agent.root, canvas_id="default", commands=CAT_BATCH,
    ))
    assert result["status"] == "runnable", result
    assert [action["action"] for action in result["plan"]["actions"]] == ["generate_image"]


def test_server_preflight_names_the_failing_command_by_its_batch_index(agent):
    commands = [CAT_BATCH[0], {"type": "run_node_action", "node_id": "cat_ghost",
                               "action": "generate_image"}]
    with pytest.raises(canvas_core_pool.CanvasCoreError) as raised:
        asyncio.run(freezone_server_workflow_start.check_server_workflow(
            ctx=agent.ctx, state_dir=agent.root, canvas_id="default", commands=commands,
        ))
    message = str(raised.value)
    assert "commands[1]" in message and "cat_ghost" in message, message
    assert "commands[0]" not in message, message


def test_in_product_batch_with_a_next_node_waits_whole_for_confirmation(agent):
    paid = agent.call("freezone_emit_canvas_command", {"commands": CAT_BATCH})
    assert paid["code"] == "canvas_confirmation_required", paid
    assert paid["confirmation_via"] == "conversation"
    for key in ("written", "generation_settings", "generation_summary"):
        assert key not in paid, paid
    assert "no canvas change was made" in paid["agent_instruction"]
    assert _node_ids(agent.root, "default") == []
    assert _confirmation_record(agent, paid["confirmation_id"])["commands"] == CAT_BATCH


def test_next_node_and_its_own_edge_command_leave_one_edge(agent):
    """add_next_node connects by default; a create_edge on the same pair must not add a twin."""
    written = agent.call("freezone_emit_canvas_command", {"commands": CAT_BATCH[:3]})
    assert written["ok"] is True, written
    canvas = _read(agent.root, "default")
    by_type = {node["type"]: node["id"] for node in canvas["nodes"]}
    assert [(edge["source"], edge["target"]) for edge in canvas["edges"]] == [
        (by_type["textAnnotationNode"], by_type["imageGenNode"]),
    ]


def test_external_key_batch_writes_nodes_and_defers_only_the_generation(external):
    external.user["external_agent_key_id"] = EXTERNAL_KEY_ID
    b = _created(external, "Cat")["canvas_id"]
    paid = external.call("freezone_emit_canvas_command", {"canvas_id": b, "commands": CAT_BATCH})
    assert paid["ok"] is True, paid
    assert paid["status"] == "confirmation_required", paid
    assert paid["code"] == "canvas_confirmation_required"
    assert paid["applied"] is False
    canvas = _read(external.root, b)
    by_type = {node["type"]: node["id"] for node in canvas["nodes"]}
    assert set(by_type) == {"textAnnotationNode", "imageGenNode"}
    text_id, image_id = by_type["textAnnotationNode"], by_type["imageGenNode"]
    assert [(edge["source"], edge["target"]) for edge in canvas["edges"]] == [
        (text_id, image_id),
    ]
    assert paid["written"]["created_edge_ids"] == [canvas["edges"][0]["id"]]
    assert {node["client_id"]: node["node_id"] for node in paid["written"]["nodes"]} == {
        "cat_prompt": text_id, "cat_image": image_id,
    }
    assert paid["written"]["revision"] == canvas["revision"]
    assert paid["targets"] == [{"node_id": image_id, "title": "Cat watercolor",
                                "node_type": "imageGenNode", "action": "generate_image"}]
    (settings,) = paid["generation_settings"]
    assert {key: settings[key] for key in (
        "model", "aspect_ratio", "resolution", "quality", "count",
    )} == {"model": "image-model", "aspect_ratio": "1:1", "resolution": "1K",
           "quality": "standard", "count": 1}
    for part in ("Cat watercolor", "image-model", "1:1", "1K", "standard"):
        assert part in paid["generation_summary"], paid["generation_summary"]
    instruction = paid["agent_instruction"]
    assert "no canvas change was made" not in instruction
    assert "freezone_confirm_canvas_action" in instruction
    assert _confirmation_record(external, paid["confirmation_id"])["commands"] == [
        {"type": "run_node_action", "node_id": image_id, "action": "generate_image"},
    ]

    again = external.call("freezone_emit_canvas_command", {"canvas_id": b, "commands": CAT_BATCH})
    assert again["confirmation_id"] == paid["confirmation_id"], again
    assert _read(external.root, b)["nodes"] == canvas["nodes"]

    cancelled = external.call("freezone_cancel_canvas_action", {
        "canvas_id": b, "confirmation_id": paid["confirmation_id"],
    })
    assert cancelled["ok"] is True, cancelled
    after = _read(external.root, b)
    assert (after["nodes"], after["edges"]) == (canvas["nodes"], canvas["edges"])


def test_external_key_typed_run_lists_the_generation_settings(external):
    external.user["external_agent_key_id"] = EXTERNAL_KEY_ID
    b = _created(external, "Ship")["canvas_id"]
    image = external.call("freezone_create_node", {
        "canvas_id": b, "node_type": "imageGenNode", "data": IMAGE,
    })
    (node_id,) = image["created_node_ids"]
    paid = external.call("freezone_run_node_action", {
        "canvas_id": b, "node_id": node_id, "action": "generate_image",
    })
    assert paid["code"] == "canvas_confirmation_required", paid
    assert "written" not in paid
    for part in ("image-model", "1:1", "1K", "standard"):
        assert part in paid["generation_summary"], paid["generation_summary"]


def test_external_host_without_a_key_marker_keeps_the_batch_whole(external):
    b = _created(external, "Cat")["canvas_id"]
    paid = external.call("freezone_emit_canvas_command", {"canvas_id": b, "commands": CAT_BATCH})
    assert paid["code"] == "canvas_confirmation_required", paid
    for key in ("written", "generation_settings", "generation_summary"):
        assert key not in paid, paid
    assert _node_ids(external.root, b) == []

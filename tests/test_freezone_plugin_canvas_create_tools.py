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
from novelvideo.freezone import canvas_creation, canvas_store
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
        "created_from_this_chat", "modified_at",
    }
    assert (mine["created_by_viewer"], mine["created_from_this_chat"]) == (True, True)
    assert (rows["canvas_bob"]["created_by_viewer"],
            rows["canvas_bob"]["created_from_this_chat"]) == (False, False)
    assert result["quota"] == {"status": "available", "used": 1, "limit": 25}
    views = [(query, body) for method, path, query, body in agent.requests
             if method == "GET" and path == VIEW_PATH]
    assert views == [({"chat_canvas_id": "default"}, None)]


# --- widened write scope: 7 relaxed, 4 strict -----------------------------------


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
SITES = {**STRICT_SITES, **RELAXED_SITES}


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
    assert payload["code"] == "scope_mismatch", payload
    return "refused"


@pytest.mark.parametrize("site", sorted(SITES))
@pytest.mark.parametrize("canvas", ["default", "canvas_b", "canvas_c", "canvas_d", "canvas_ghost"])
def test_bound_scope_allows_only_canvases_this_chat_created(seams, site, canvas):
    allowed = canvas == "default" or (canvas == "canvas_b" and site in RELAXED_SITES)
    assert _site_outcome(seams, site, "proj", canvas) == ("passed" if allowed else "refused")
    if canvas == "default" or site in STRICT_SITES:
        assert seams.lookups == []


@pytest.mark.parametrize("site", sorted(SITES))
def test_another_project_is_refused_without_a_lookup(seams, site):
    assert _site_outcome(seams, site, "other", "canvas_b") == "refused"
    assert seams.lookups == []


@pytest.mark.parametrize("site", sorted(RELAXED_SITES))
@pytest.mark.parametrize("failure", [
    {"ok": False, "status": "failed", "status_code": 503, "error": "down"},
    RuntimeError("network down"),
])
def test_failed_lookup_fails_closed(seams, site, failure):
    seams.failure["value"] = failure
    assert _site_outcome(seams, site, "proj", "canvas_b") == "refused"


@pytest.mark.parametrize("site", sorted(RELAXED_SITES))
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

"""Agent tools select the API executor without duplicating canvas mutations."""

import time
from pathlib import Path

import pytest

from test_freezone_plugin import _load_plugin_module
from test_freezone_plugin import _restore_tools_registry_modules as _restore_tools_registry_modules


@pytest.fixture
def agent(monkeypatch, tmp_path):
    plugin = _load_plugin_module(api_executor=True)
    monkeypatch.setenv("DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", str(tmp_path))
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "p")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "c")
    monkeypatch.setenv("DRAMACLAW_MCP_CANVAS_APPROVAL", "0")
    monkeypatch.delenv("DRAMACLAW_EXTERNAL_MCP", raising=False)
    monkeypatch.delenv("DRAMACLAW_AGENT_PROFILE", raising=False)
    monkeypatch.delenv("DRAMACLAW_TURN_ID", raising=False)
    monkeypatch.setattr(plugin, "_external_generation_parameter_preflight", lambda *_: None)
    monkeypatch.setattr(plugin, "wait_canvas_command_result", lambda *_, **__: pytest.fail("unexpected browser write"))
    calls = []
    receipt = {
        "tool_call_status": "completed", "canvas_apply_status": "applied",
        "applied": True, "cancelled": False, "errors": [], "applied_count": 1, "created_node_ids": ["new-node"],
        "command_results": [{"type": "create_node", "status": "applied"}],
    }
    context = {"ok": True, "tool_call_status": "completed", "canvas_context_status": "answered",
               "responses": [{"type": "node_detail", "node_id": "n"}], "errors": []}

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs.get("body")))
        if path == "/api/v1/config":
            return {"ok": True, "data": {"agent_canvas_executor": "server"}}
        if path.endswith("/presence"):
            assert method == "GET"
            return {"ok": True, "data": {"browser_open": False}}
        assert method == "POST"
        if path.endswith("agent-context"):
            return {"ok": True, "data": context}
        assert path.endswith("agent-commands")
        return {"ok": True, "data": {"status": "applied", "revision": 7, "receipt": receipt,
                                      "changes": {"created_node_ids": ["new-node"]}}}

    monkeypatch.setattr(plugin, "_request", request)
    return plugin, calls, context, tmp_path


CREATE = [{"type": "create_node", "node_type": "textAnnotationNode", "data": {"title": "Hello", "content": "hello"}}]


@pytest.mark.parametrize("slim", [False, True])
def test_structural_commands_post_once_without_bridge(agent, slim):
    plugin, calls, _, directory = agent
    result = plugin._emit_canvas_commands("p", "c", CREATE, slim_result=slim)
    assert result["ok"] is True
    assert result["canvas_apply_status"] == "applied"
    assert result["created_node_ids"] == ["new-node"]
    posts = [call for call in calls if call[0] == "POST"]
    assert posts == [("POST", "/api/v1/projects/p/freezone/canvases/c/agent-commands", {
        "envelopes": [{"schema_version": "canvas_chat_commands.v1", "project_id": "p",
                       "canvas_id": "c", "commands": CREATE}],
    })]
    if not slim:
        assert result["revision"] == 7 and result["receipt"]["applied"] is True
    assert not list(directory.iterdir())


@pytest.mark.parametrize("profile,turn_id,agent_id", [
    (None, "t1", "main"),
    ("freezone:agent-2", None, "agent-2"),
    ("freezone: ", " ", "main"),
])
def test_external_mcp_commands_post_marked_envelope(agent, monkeypatch, profile, turn_id, agent_id):
    plugin, calls, _, directory = agent
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    if profile is not None:
        monkeypatch.setenv("DRAMACLAW_AGENT_PROFILE", profile)
    if turn_id is not None:
        monkeypatch.setenv("DRAMACLAW_TURN_ID", turn_id)
    result = plugin._emit_canvas_commands("p", "c", CREATE)
    assert result["ok"] is True
    envelope = {
        "schema_version": "canvas_chat_commands.v1", "project_id": "p", "canvas_id": "c",
        "commands": CREATE, "external_mcp_command": True, "agent_id": agent_id,
    }
    if turn_id and turn_id.strip():
        envelope["turn_id"] = turn_id
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", "/api/v1/projects/p/freezone/canvases/c/agent-commands",
         {"envelopes": [envelope]})]
    assert not list(directory.iterdir())


@pytest.mark.parametrize("external", [False, True])
def test_confirmation_posts_only_after_confirm(agent, monkeypatch, external):
    plugin, calls, _, directory = agent
    if external:
        monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
        monkeypatch.setenv("DRAMACLAW_TURN_ID", "t1")
    monkeypatch.delenv("DRAMACLAW_MCP_CANVAS_APPROVAL")
    approval = plugin._emit_canvas_commands("p", "c", CREATE)
    assert approval["status"] == "approval_required"
    assert not [call for call in calls if call[0] == "POST"]
    assert not list(directory.glob("*.pending.json"))
    result = plugin._handle_confirm_canvas_action({"approval_id": approval["approval_id"]})
    assert result["ok"] is True
    assert result["canvas_apply_status"] == "applied"
    envelope = {
        "schema_version": "canvas_chat_commands.v1", "project_id": "p", "canvas_id": "c",
        "commands": CREATE,
    }
    if external:
        envelope.update(external_mcp_command=True, agent_id="main", turn_id="t1")
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", "/api/v1/projects/p/freezone/canvases/c/agent-commands",
         {"envelopes": [envelope]})]


def test_confirmed_workflow_draft_skips_second_confirmation(agent, monkeypatch):
    plugin, calls, _, _ = agent
    monkeypatch.delenv("DRAMACLAW_MCP_CANVAS_APPROVAL")
    result = plugin._emit_canvas_commands("p", "c", CREATE, require_canvas_receipt=True)
    assert result["applied"] is True
    assert len([call for call in calls if call[0] == "POST"]) == 1


@pytest.mark.parametrize("kind", ["run_node_action", "run_workflow"])
def test_host_commands_without_browser_fail_immediately(agent, monkeypatch, kind):
    plugin, calls, _, directory = agent
    monkeypatch.setattr(plugin, "_validate_write_commands_shape", lambda *_: None)
    monkeypatch.delenv("DRAMACLAW_MCP_CANVAS_APPROVAL")
    monkeypatch.setattr(plugin, "_resolve_canvas_generation_recommendations", lambda *_: pytest.fail("browser required before preflight"))
    started = time.monotonic()
    result = plugin._emit_canvas_commands("p", "c", [{"type": kind, "node_id": "n"}])
    assert time.monotonic() - started < 0.5
    assert result["code"] == "canvas_browser_required"
    assert result["canvas_apply_status"] == "browser_required"
    assert result["message"] == "需要打开画布才能运行"
    assert "retry" in result["agent_instruction"]
    assert not result["ok"]
    assert not list(directory.iterdir())
    assert not [call for call in calls if call[0] == "POST"]


@pytest.mark.parametrize("external", [False, True])
def test_host_commands_with_presence_use_existing_browser_dispatch(agent, monkeypatch, external):
    plugin, calls, _, directory = agent
    original_request = plugin._request

    def request(method, path, **kwargs):
        if path.endswith("/presence"):
            calls.append((method, path, None))
            return {"ok": True, "data": {"browser_open": True}}
        return original_request(method, path, **kwargs)

    monkeypatch.setattr(plugin, "_request", request)
    monkeypatch.setattr(plugin, "_external_mcp_agent_enabled", lambda: external)
    monkeypatch.setattr(plugin, "_validate_write_commands_shape", lambda *_: None)
    monkeypatch.setattr(plugin, "wait_canvas_command_result", lambda *_, **__: {"ok": True})
    assert plugin._emit_canvas_commands("p", "c", [{"type": "run_node_action", "node_id": "n"}])["ok"]
    frames = list(directory.glob("*.pending.json"))
    assert len(frames) == 1
    assert not [call for call in calls if call[0] == "POST"]


def test_read_posts_context_and_returns_data(agent):
    plugin, calls, context, directory = agent
    result = plugin._handle_node_detail({"project_id": "p", "canvas_id": "c", "node_id": "n"})
    assert result == context
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", "/api/v1/projects/p/freezone/canvases/c/agent-context",
         {"requests": [{"type": "node_detail", "node_id": "n"}]})]
    assert not list(directory.iterdir())


@pytest.mark.parametrize("project,canvas", [(None, "c"), ("p", None)])
def test_server_read_requires_resolvable_scope(agent, monkeypatch, project, canvas):
    plugin, calls, _, _ = agent
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID")
    monkeypatch.delenv("DRAMACLAW_CANVAS_ID")
    result = plugin._request_canvas_context_from_frontend(project=project, canvas=canvas, requests=[])
    assert not result["ok"]
    assert result["canvas_context_status"] == "failed"
    assert "project" in result["errors"][0] or "canvas" in result["errors"][0]
    assert not [call for call in calls if call[0] == "POST"]


@pytest.mark.parametrize("read", [False, True])
@pytest.mark.parametrize("status,code", [(409, "canvas_revision_conflict"), (422, "canvas_media_scope_mismatch"),
                                       (503, "canvas_core_timeout")])
def test_http_failures_preserve_server_code_and_message(agent, monkeypatch, read, status, code):
    plugin, _, _, directory = agent
    monkeypatch.setattr(plugin, "_agent_canvas_executor", lambda: "server")
    monkeypatch.setattr(plugin, "_request", lambda *_, **__: {
        "ok": False, "status_code": status, "code": code, "error": "server message",
        "current_revision": 8,
    })
    result = (plugin._request_canvas_context_from_frontend(project="p", canvas="c", requests=[])
              if read else plugin._server_apply_canvas_commands("p", "c", CREATE, slim_result=False))
    assert not result["ok"] and result["tool_call_status"] == "failed"
    assert result["code"] == code and result["errors"] == ["server message"]
    assert result["message"] == "server message"
    assert not list(directory.iterdir())


@pytest.mark.parametrize("fresh", [False, True])
def test_server_host_required_response_uses_presence(agent, monkeypatch, fresh):
    plugin, _, _, _ = agent

    def request(method, path, **kwargs):
        if path.endswith("/presence"):
            assert method == "GET"
            return {"ok": True, "data": {"browser_open": fresh}}
        return {"ok": True, "data": {"status": "host_required"}}

    monkeypatch.setattr(plugin, "_request", request)
    monkeypatch.setattr(plugin, "wait_canvas_command_result", lambda *_, **__: {"ok": True})
    result = plugin._server_apply_canvas_commands("p", "c", CREATE, slim_result=False)
    assert result["ok"] is fresh
    if not fresh:
        assert result["code"] == "canvas_browser_required"


def test_executor_lookup_caches_for_thirty_seconds_and_fails_closed(agent, monkeypatch):
    plugin, calls, _, _ = agent
    now = [100.0]
    monkeypatch.setattr(plugin.time, "monotonic", lambda: now[0])
    assert plugin._agent_canvas_executor() == "server"
    now[0] += 29
    assert plugin._agent_canvas_executor() == "server"
    assert len(calls) == 1
    now[0] += 2
    monkeypatch.setattr(plugin, "_request", lambda *_: (_ for _ in ()).throw(OSError("offline")))
    assert plugin._agent_canvas_executor() == "browser"
    monkeypatch.setattr(plugin, "_request", lambda *_: pytest.fail("cached fallback"))
    assert plugin._agent_canvas_executor() == "browser"


def test_removed_canvas_write_path_has_no_references():
    root = Path(__file__).resolve().parents[1]
    forbidden = ["_direct_apply_" + "canvas_commands", "_mcp_direct_" + "canvas_apply_enabled",
                 "DRAMACLAW_MCP_DIRECT_" + "CANVAS_APPLY"]
    for folder in ["src", ".hermes", "agent-kit", "frontend/src", "examples", "docs"]:
        for path in (root / folder).rglob("*"):
            if path.is_file() and path.suffix in {".py", ".ts", ".tsx", ".md", ".toml"}:
                content = path.read_text()
                assert not any(token in content for token in forbidden), str(path)


@pytest.mark.parametrize("read", [False, True])
def test_browser_executor_keeps_bridge_transport(agent, monkeypatch, read):
    plugin, calls, _, directory = agent

    def browser(method, path, **kwargs):
        calls.append((method, path, kwargs))
        assert method == "GET" and path == "/api/v1/config"
        return {"ok": True, "data": {"agent_canvas_executor": "browser"}}

    monkeypatch.setattr(plugin, "_request", browser)
    monkeypatch.setattr(plugin, "wait_canvas_command_result", lambda *_, **__: {"ok": True})
    monkeypatch.setattr(plugin, "wait_canvas_context_result", lambda *_, **__: {"ok": True})
    result = (plugin._handle_node_detail({"node_id": "n"}) if read
              else plugin._emit_canvas_commands("p", "c", CREATE))
    assert result["ok"]
    assert len(list(directory.glob("*.pending.json"))) == 1
    assert [method for method, *_ in calls] == ["GET"]


def test_read_scope_mismatch_precedes_executor_lookup(agent, monkeypatch):
    plugin, calls, _, directory = agent
    monkeypatch.setattr(plugin, "_request", lambda *_, **__: pytest.fail("scope mismatch must not call API"))
    result = plugin._request_canvas_context_from_frontend(project="other", canvas="c", requests=[])
    assert result["code"] == "scope_mismatch"
    assert not calls and not list(directory.iterdir())


@pytest.mark.parametrize("response", [{"ok": False}, {"ok": True, "data": None},
                                       {"ok": True, "data": {"agent_canvas_executor": "unknown"}}])
def test_executor_config_failure_uses_browser(agent, monkeypatch, response):
    plugin, _, _, _ = agent
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "server")
    monkeypatch.setattr(plugin, "_request", lambda *_: response)
    assert plugin._agent_canvas_executor() == "browser"


def test_confirmation_host_branch_requires_presence(agent):
    plugin, calls, _, _ = agent
    approval = plugin._create_mcp_canvas_approval(
        project="p", canvas="c", commands=[{"type": "run_workflow", "scope": "canvas"}],
        slim_result=False, reasons=["Run workflow"],
    )
    result = plugin._handle_confirm_canvas_action({"approval_id": approval["approval_id"]})
    assert result["code"] == "canvas_browser_required"
    assert not [call for call in calls if call[0] == "POST"]


@pytest.mark.parametrize("read", [False, True])
@pytest.mark.parametrize("status,detail", [
    (409, {"code": "canvas_revision_conflict", "message": "Conflict", "current_revision": 8}),
    (422, {"code": "canvas_media_scope_mismatch", "message": "Invalid media"}),
    (422, {"code": "invalid_agent_canvas_request", "message": "commands[1] (create_edge) is not a valid canvas command"}),
    (503, {"code": "canvas_core_timeout", "message": "Worker timed out"}),
])
def test_actual_http_errors_reach_canvas_tools(agent, monkeypatch, read, status, detail):
    import io
    import json
    from urllib.error import HTTPError

    plugin, _, _, _ = agent
    plugin = _load_plugin_module(api_executor=True)

    def failed(request, **kwargs):
        raise HTTPError(request.full_url, status, "HTTP failure", {}, io.BytesIO(json.dumps({"detail": detail}).encode()))

    monkeypatch.setenv("DRAMACLAW_API_URL", "http://127.0.0.1:8780")
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    monkeypatch.setattr(plugin, "urlopen", failed)
    monkeypatch.setattr(plugin, "_agent_canvas_executor", lambda: "server")
    result = (plugin._request_canvas_context_from_frontend(project="p", canvas="c", requests=[])
              if read else plugin._server_apply_canvas_commands("p", "c", CREATE, slim_result=False))
    assert not result["ok"] and result["tool_call_status"] == "failed"
    assert result["message"] == detail["message"]
    if status == 422:
        assert not result.get("retryable")
        assert "retry" not in result.get("agent_instruction", "").lower()
    assert result["code"] == detail["code"]
    assert result["errors"] == [detail["message"]]


@pytest.mark.parametrize("slim", [False, True])
def test_server_validation_failure_preserves_failed_receipt(agent, monkeypatch, slim):
    plugin, _, _, directory = agent
    receipt = {
        "tool_call_status": "failed", "canvas_apply_status": "failed", "applied": False,
        "cancelled": False, "errors": ["Missing node"], "created_node_ids": [],
        "command_results": [{"type": "validate", "status": "error", "error": "Missing node"}],
    }
    monkeypatch.setattr(plugin, "_request", lambda *_, **__: {
        "ok": True, "data": {"status": "validation_failed", "revision": 7, "receipt": receipt},
    })
    result = plugin._server_apply_canvas_commands("p", "c", CREATE, slim_result=slim)
    assert not result["ok"] and not result["applied"]
    assert result["tool_call_status"] == "failed" and result["canvas_apply_status"] == "failed"
    assert result["errors"] == ["Missing node"] and not result["created_node_ids"]
    assert result["revision"] == 7
    if not slim:
        assert result["receipt"] == receipt
    assert not list(directory.iterdir())


@pytest.mark.parametrize("response", [
    {"ok": False, "data": {"browser_open": True}},
    {"ok": True, "data": {"browser_open": False}},
    {"ok": True, "data": {"browser_open": 1}},
    {"ok": True, "data": None},
    None,
    OSError("offline"),
])
def test_presence_request_failure_requires_browser(agent, monkeypatch, response):
    plugin, calls, _, _ = agent

    def request(method, path):
        assert method == "GET"
        assert path == "/api/v1/projects/p/freezone/canvases/c/presence"
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(plugin, "_request", request)
    result = plugin._canvas_browser_required_error("p", "c")
    assert result["code"] == "canvas_browser_required"
    assert result["message"] == "需要打开画布才能运行"
    assert not calls


def test_presence_request_quotes_project_and_canvas(agent, monkeypatch):
    plugin, _, _, _ = agent
    calls = []

    def request(method, path):
        calls.append((method, path))
        return {"ok": True, "data": {"browser_open": True}}

    monkeypatch.setattr(plugin, "_request", request)
    assert plugin._canvas_browser_required_error("p /?", "c /?") is None
    assert calls == [("GET", "/api/v1/projects/p%20%2F%3F/freezone/canvases/c%20%2F%3F/presence")]

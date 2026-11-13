"""Agent tools select the API executor without duplicating canvas mutations."""

import json
from pathlib import Path

import pytest

from test_freezone_plugin import _assert_real_mcp_output, _load_plugin_module
from test_freezone_plugin import _restore_tools_registry_modules as _restore_tools_registry_modules


@pytest.fixture
def agent(monkeypatch, tmp_path):
    plugin = _load_plugin_module(api_executor=True)
    monkeypatch.setenv("DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", str(tmp_path))
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "p")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "c")
    monkeypatch.delenv("DRAMACLAW_EXTERNAL_MCP", raising=False)
    monkeypatch.delenv("DRAMACLAW_AGENT_PROFILE", raising=False)
    monkeypatch.delenv("DRAMACLAW_TURN_ID", raising=False)
    monkeypatch.setattr(plugin, "_external_generation_parameter_preflight", lambda *_: None)
    monkeypatch.setattr(plugin, "wait_canvas_command_result", lambda *_, **__: pytest.fail("unexpected browser write"))
    monkeypatch.setattr(plugin, "tool_error", lambda value: {"ok": False, "error": str(value)})
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
        if path == "/api/v1/projects/p/freezone/canvases":
            assert method == "GET"
            return {"ok": True, "data": [{"id": "c", "metadata": {}}]}
        assert method == "POST"
        if path.endswith("agent-context"):
            return {"ok": True, "data": context}
        if path.endswith("/confirmations"):
            return {"ok": True, "data": CONFIRMATION}
        if path.endswith("/decision"):
            if kwargs["body"]["decision"] == "refused":
                return {"ok": True, "data": {
                    "confirmation_id": CONFIRMATION_ID, "status": "refused", "applied": False,
                }}
            return {"ok": True, "data": {
                "confirmation_id": CONFIRMATION_ID, "status": "executed",
                "result": {"status": "applied", "revision": 7, "receipt": receipt,
                           "changes": {"created_node_ids": ["new-node"]}, "recompute_count": 1},
            }}
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


@pytest.mark.parametrize("command", [
    {"type": "run_node_action", "node_id": "n1", "action": "generate_image"},
    {"type": "run_workflow", "node_ids": ["n1"]},
])
def test_paid_runs_without_browser_create_confirmation(agent, monkeypatch, command):
    plugin, calls, _, directory = agent
    monkeypatch.setattr(plugin, "_resolve_canvas_generation_recommendations", lambda *_: None)
    result = plugin._emit_canvas_commands("p", "c", [command])
    assert result["code"] == "canvas_confirmation_required"
    assert result["canvas_apply_status"] == "awaiting_confirmation"
    assert result["confirmation_id"] == CONFIRMATION_ID
    assert calls == [
        ("GET", "/api/v1/config", None),
        ("POST", CONFIRMATION_PATH, {
            "agent_id": "main", "turn_id": None, "commands": [command],
        }),
    ]
    assert list(directory.iterdir()) == []


@pytest.mark.parametrize("commands,code,message,blocked", [
    ([{"type": "run_node_action", "node_id": "n1", "action": "run_matting_tool"}],
     "canvas_open_required", "这些动作需要打开画布才能运行：run_matting_tool",
     [{"node_id": "n1", "action": "run_matting_tool", "label": "run_matting_tool",
       "reason": "action_not_on_server"}]),
    ([{"type": "html_artifact", "action": "create", "title": "Preview", "html": "<p>Hello</p>"}],
     "canvas_browser_required", "需要打开画布才能运行", None),
    ([{"type": "run_node_action", "node_id": "n1", "action": "open_editor"}],
     "canvas_browser_required", "需要打开画布才能运行", None),
])
def test_free_ui_commands_require_open_canvas(agent, commands, code, message, blocked):
    plugin, calls, _, directory = agent
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": commands})
    assert result["ok"] is False
    assert result["code"] == code
    assert result["message"] == message
    assert result.get("blocked") == blocked
    if blocked is not None:
        assert result["canvas_apply_status"] == "not_applied"
        assert result["applied"] is False
        assert result["agent_instruction"] == (
            "These actions only run in the open canvas: run_matting_tool. "
            "Ask the user to open this canvas, then call the tool again afterwards. "
            "Do not retry on your own."
        )
    assert calls == [
        ("GET", "/api/v1/config", None),
        ("GET", "/api/v1/projects/p/freezone/canvases/c/presence", None),
    ]
    assert list(directory.iterdir()) == []


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
    result = plugin._emit_canvas_commands(
        "p", "c", [{"type": "run_node_action", "node_id": "n", "action": "open"}],
    )
    assert result["ok"]
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


CONFIRMATION_ID = "cc_" + "a" * 32
CONFIRMATION = {
    "confirmation_id": CONFIRMATION_ID,
    "kinds": ["delete_nodes"],
    "targets": [{"node_id": "n1", "title": "Sketch", "node_type": "imageGenNode",
                 "action": "delete_nodes"}],
    "expires_at": 1900001800.0,
    "browser_open": True,
}
DELETE = [{"type": "delete_nodes", "node_ids": ["n1"]}]
CONFIRMATION_PATH = "/api/v1/projects/p/freezone/canvases/c/confirmations"
CARD_INSTRUCTION = (
    "Nothing has been executed yet: no canvas change was made, no generation was submitted "
    "and no credits were spent. "
    "A confirmation card is now shown in the user's DramaClaw chat. Tell the user briefly "
    "what will happen, naming each target node by title and type. Then end your turn. "
    "Do not call freezone_confirm_canvas_action in this turn and never confirm on the user's "
    "behalf. The outcome arrives later as a canvas background result. If the user answers "
    "in the conversation instead, call freezone_confirm_canvas_action or "
    "freezone_cancel_canvas_action with this confirmation_id in that later turn. "
    "The confirmation expires in 30 minutes. "
    "Do not tell the user that anything was started, sent, submitted or done."
)
CONVERSATION_INSTRUCTION = (
    "Nothing has been executed yet: no canvas change was made, no generation was submitted "
    "and no credits were spent. "
    "Tell the user what will happen, naming each target node by title and type, and ask "
    "them to confirm. Only after the user explicitly confirms in a later message, call "
    "freezone_confirm_canvas_action with this confirmation_id; if they decline, call "
    "freezone_cancel_canvas_action. Never confirm on your own or in this same turn. "
    "The confirmation expires in 30 minutes; after that, ask again. "
    "Do not tell the user that anything was started, sent, submitted or done."
)


def _respond(agent, monkeypatch, suffix, response):
    plugin, calls, _, _ = agent
    original_request = plugin._request

    def request(method, path, **kwargs):
        if path.endswith(suffix):
            calls.append((method, path, kwargs.get("body")))
            return response
        return original_request(method, path, **kwargs)

    monkeypatch.setattr(plugin, "_request", request)


def _tool(plugin, name, args):
    handler = next(handler for tool, _schema, handler in plugin.TOOLS if tool == name)
    result = handler(args)
    structured = _assert_real_mcp_output(plugin, name, result)
    for key in (
        "confirmation_id", "kinds", "targets", "expires_at", "confirmation_via",
        "blocked", "run_id", "actions", "run_status",
    ):
        if key in result:
            assert structured[key] == result[key]
    return result


def _confirmation_result(data, via, instruction):
    return {
        "ok": True, "status": "confirmation_required", "code": "canvas_confirmation_required",
        "tool_call_status": "completed", "canvas_apply_status": "awaiting_confirmation",
        "applied": False, "project_id": "p", "canvas_id": "c",
        "confirmation_id": CONFIRMATION_ID, "kinds": data["kinds"], "targets": data["targets"],
        "expires_at": 1900001800.0, "confirmation_via": via,
        "message": "尚未执行：已创建待确认请求，用户确认后才会执行。",
        "agent_instruction": instruction,
    }


@pytest.mark.parametrize("browser_open,turn,via,instruction", [
    (True, "t1", "card", CARD_INSTRUCTION),
    (False, "t1", "conversation", CONVERSATION_INSTRUCTION),
    (True, None, "conversation", CONVERSATION_INSTRUCTION),
])
def test_delete_creates_confirmation_without_dispatch(
    agent, monkeypatch, browser_open, turn, via, instruction,
):
    plugin, calls, _, directory = agent
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.setenv("DRAMACLAW_AGENT_PROFILE", "freezone:main")
    if turn:
        monkeypatch.setenv("DRAMACLAW_TURN_ID", turn)
    data = {**CONFIRMATION, "browser_open": browser_open}
    _respond(agent, monkeypatch, "/confirmations", {"ok": True, "data": data})
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": DELETE})
    assert result == _confirmation_result(data, via, instruction)
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", CONFIRMATION_PATH, {"agent_id": "main", "turn_id": turn, "commands": DELETE}),
    ]
    assert list(directory.iterdir()) == []


def test_browser_delete_creates_confirmation_without_bridge(agent, monkeypatch):
    plugin, calls, _, directory = agent
    _respond(agent, monkeypatch, "/api/v1/config", {"ok": True, "data": {}})
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": DELETE})
    assert result == _confirmation_result(CONFIRMATION, "conversation", CONVERSATION_INSTRUCTION)
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", CONFIRMATION_PATH, {"agent_id": "main", "turn_id": None, "commands": DELETE}),
    ]
    assert list(directory.iterdir()) == []


@pytest.mark.parametrize("commands,kinds", [
    ([{"type": "clear_canvas"}], ["clear_canvas"]),
    ([{"type": "run_node_action", "node_id": "n1", "action": "generate_image"}],
     ["paid_generation"]),
])
def test_clear_and_paid_commands_create_confirmation(agent, monkeypatch, commands, kinds):
    plugin, calls, _, directory = agent
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "t1")
    _respond(agent, monkeypatch, "/presence", {"ok": True, "data": {"browser_open": True}})
    data = {**CONFIRMATION, "kinds": kinds}
    _respond(agent, monkeypatch, "/confirmations", {"ok": True, "data": data})
    instruction = CARD_INSTRUCTION
    if kinds == ["paid_generation"]:
        instruction = instruction.replace(
            "type. Then", "type. Say that it will consume credits; do not give any estimate. Then",
        )
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": commands})
    assert result == _confirmation_result(data, "card", instruction)
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", CONFIRMATION_PATH, {"agent_id": "main", "turn_id": "t1", "commands": commands}),
    ]
    assert list(directory.iterdir()) == []


def test_paid_conversation_mentions_credits_without_estimate(agent, monkeypatch):
    plugin, _, _, _ = agent
    _respond(agent, monkeypatch, "/presence", {"ok": True, "data": {"browser_open": True}})
    data = {**CONFIRMATION, "kinds": ["paid_generation"]}
    _respond(agent, monkeypatch, "/confirmations", {"ok": True, "data": data})
    result = _tool(plugin, "freezone_run_node_action", {
        "node_id": "n1", "action": "generate_image",
    })
    assert result == _confirmation_result(data, "conversation", CONVERSATION_INSTRUCTION.replace(
        "type, and", "type, say that it will consume credits without giving any estimate, and",
    ))


def test_paid_command_without_browser_creates_confirmation(agent):
    plugin, calls, _, directory = agent
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": [
        {"type": "run_node_action", "node_id": "n1", "action": "generate_image"},
    ]})
    assert result["code"] == "canvas_confirmation_required"
    assert result["confirmation_id"] == CONFIRMATION_ID
    assert calls == [
        ("GET", "/api/v1/config", None),
        ("POST", CONFIRMATION_PATH, {"agent_id": "main", "turn_id": None, "commands": [
            {"type": "run_node_action", "node_id": "n1", "action": "generate_image"},
        ]}),
    ]
    assert list(directory.iterdir()) == []


@pytest.mark.parametrize("command", [
    {"type": "delete_edges", "edge_ids": ["e1"]},
    {"type": "update_node_data", "node_id": "n1", "data": {"title": "Updated"}},
    {"type": "move_nodes", "positions": {"n1": {"x": 10, "y": 20}}},
    CREATE[0],
])
def test_other_structural_changes_apply_directly(agent, command):
    plugin, calls, _, directory = agent
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": [command]})
    assert result["ok"] is True
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", "/api/v1/projects/p/freezone/canvases/c/agent-commands", {
            "envelopes": [{"schema_version": "canvas_chat_commands.v1", "project_id": "p",
                           "canvas_id": "c", "commands": [command]}],
        }),
    ]
    assert list(directory.iterdir()) == []


def test_confirm_executes_via_decision_route(agent, monkeypatch):
    plugin, calls, _, directory = agent
    monkeypatch.setenv("DRAMACLAW_AGENT_PROFILE", "freezone:main")
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "t2")
    result = _tool(plugin, "freezone_confirm_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    assert result["ok"] is True
    assert result["canvas_apply_status"] == "applied"
    assert result["confirmation_id"] == CONFIRMATION_ID
    assert result["revision"] == 7
    assert result["created_node_ids"] == ["new-node"]
    assert result["command_count"] == 0
    assert calls == [("POST", f"{CONFIRMATION_PATH}/{CONFIRMATION_ID}/decision", {
        "decision": "confirmed", "via": "conversation", "agent_id": "main", "turn_id": "t2",
    })]
    assert list(directory.iterdir()) == []


def test_confirm_submitted_result(agent, monkeypatch):
    plugin, calls, _, _ = agent
    _respond(agent, monkeypatch, "/decision", {"ok": True, "data": {
        "confirmation_id": CONFIRMATION_ID, "status": "submitted", "bridge_key": "bridge-1",
    }})
    result = _tool(plugin, "freezone_confirm_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    assert result == {
        "ok": True, "status": "submitted", "tool_call_status": "completed",
        "canvas_apply_status": "submitted", "applied": False,
        "confirmation_id": CONFIRMATION_ID, "bridge_key": "bridge-1",
        "project_id": "p", "canvas_id": "c", "agent_instruction": (
            "The confirmed command was handed to the open canvas. Do not call it again. "
            "Read the canvas or wait for the canvas background result before reporting any outcome."
        ),
    }
    assert calls == [("POST", f"{CONFIRMATION_PATH}/{CONFIRMATION_ID}/decision", {
        "decision": "confirmed", "via": "conversation", "agent_id": "main", "turn_id": None,
    })]


def test_confirmation_targets_changed_http_error_is_readable(agent, monkeypatch):
    import json

    plugin, _, _, _ = agent
    _http_error_result = plugin._SHARED_API_ERRORS._http_error_result
    _respond(agent, monkeypatch, "/decision", _http_error_result(
        409, json.dumps({"detail": {"code": "targets_changed", "node_ids": ["n1"]}}),
        "Conflict",
    ))
    result = _tool(plugin, "freezone_confirm_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    assert result["status"] == "confirmation_failed"
    assert result["code"] == "targets_changed"
    assert result["applied"] is False
    assert result["agent_instruction"] == (
        "The target nodes changed, so the confirmation was voided and nothing "
        "was executed. Read the canvas again and ask the user again if it is still wanted."
    )


def test_confirmation_connection_failure_is_readable(agent, monkeypatch):
    plugin, _, _, _ = agent
    _respond(agent, monkeypatch, "/decision", {
        "ok": False, "status": "failed", "error": "connection refused",
    })
    result = _tool(plugin, "freezone_confirm_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    assert result["code"] == "confirmation_failed"
    assert result["message"] == "connection refused"


def test_cancel_refuses_via_decision_route(agent, monkeypatch):
    plugin, calls, _, _ = agent
    monkeypatch.setenv("DRAMACLAW_AGENT_PROFILE", "freezone:main")
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "t2")
    result = _tool(plugin, "freezone_cancel_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    assert result == {
        "ok": True, "status": "refused", "tool_call_status": "completed",
        "canvas_apply_status": "not_applied", "applied": False,
        "confirmation_id": CONFIRMATION_ID, "project_id": "p", "canvas_id": "c",
        "message": "已取消，未执行任何操作",
    }
    assert calls == [("POST", f"{CONFIRMATION_PATH}/{CONFIRMATION_ID}/decision", {
        "decision": "refused", "via": "conversation", "agent_id": "main", "turn_id": "t2",
    })]


@pytest.mark.parametrize("tool", [
    "freezone_confirm_canvas_action", "freezone_cancel_canvas_action",
])
@pytest.mark.parametrize("code,instruction", [
    ("expired", "The confirmation expired after 30 minutes and nothing was executed. "
     "Ask the user again only if it is still wanted; that creates a new confirmation."),
    ("user_reply_required", "The user has not answered yet. Wait for the user's next message; "
     "never confirm in the turn that requested the confirmation."),
    ("targets_changed", "The target nodes changed, so the confirmation was voided and nothing "
     "was executed. Read the canvas again and ask the user again if it is still wanted."),
    ("already_handled", "This confirmation was already decided. Do not retry."),
    ("canvas_open_required", "Ask the user to open this canvas, then call "
     "freezone_confirm_canvas_action again with the same confirmation_id within 30 minutes. "
     "Do not retry on your own. Blocked actions: Image generation, Workflow."),
    ("workflow_plan_invalid", "Nothing ran. Explain the server message and fix the canvas "
     "or ask the user. Do not retry unchanged."),
    ("workflow_already_running", "Another workflow run is active. Observe run_1 with "
     "freezone_observe_workflow_run. Confirm again only after it ends and only if still wanted."),
    ("canvas_browser_required", "Ask the user to open this canvas, then call "
     "freezone_confirm_canvas_action again with the same confirmation_id within 30 minutes. "
     "Do not retry on your own."),
    *[(code, "This confirmation cannot be used here and nothing was executed. Do not retry.")
      for code in ("turn_mismatch", "agent_mismatch", "not_found", "conversation_requires_agent",
                   "unknown_code")],
])
def test_confirmation_errors_preserve_code_and_instruction(
    agent, monkeypatch, tool, code, instruction,
):
    plugin, calls, _, _ = agent
    extra = {}
    if code == "canvas_open_required":
        extra = {"blocked": BLOCKED}
    elif code == "workflow_already_running":
        extra = {"run_id": "run_1"}
    _respond(agent, monkeypatch, "/decision", plugin._http_error_result(
        409, json.dumps({"detail": {"code": code, "message": "Decision failed", **extra}}),
        "Conflict",
    ))
    result = _tool(plugin, tool, {"confirmation_id": CONFIRMATION_ID})
    assert result == {
        "ok": False, "status": "confirmation_failed", "code": code,
        "tool_call_status": "failed", "canvas_apply_status": "not_applied", "applied": False,
        "confirmation_id": CONFIRMATION_ID, "project_id": "p", "canvas_id": "c",
        "errors": ["Decision failed"], "message": "Decision failed",
        "agent_instruction": instruction, **extra,
    }
    assert calls == [("POST", f"{CONFIRMATION_PATH}/{CONFIRMATION_ID}/decision", {
        "decision": "confirmed" if tool == "freezone_confirm_canvas_action" else "refused",
        "via": "conversation", "agent_id": "main", "turn_id": None,
    })]


@pytest.mark.parametrize("tool", [
    "freezone_confirm_canvas_action", "freezone_cancel_canvas_action",
])
@pytest.mark.parametrize("args", [{}, {"confirmation_id": ""}, {"confirmation_id": "  "}])
def test_confirmation_id_required_without_request(agent, tool, args):
    plugin, calls, _, _ = agent
    result = _tool(plugin, tool, args)
    assert result == {
        "ok": False, "status": "confirmation_id_required", "error": "confirmation_id is required",
    }
    assert calls == []


@pytest.mark.parametrize("tool", [
    "freezone_confirm_canvas_action", "freezone_cancel_canvas_action",
])
def test_decision_bound_scope_mismatch_without_request(agent, tool):
    plugin, calls, _, _ = agent
    result = _tool(plugin, tool, {"confirmation_id": CONFIRMATION_ID, "canvas_id": "other"})
    assert result["code"] == "scope_mismatch"
    # Only reads happen: the executor mode, then the canvas list that says which
    # canvases this chat created. Nothing is decided.
    assert calls == [
        ("GET", "/api/v1/config", None),
        ("GET", "/api/v1/projects/p/freezone/canvases", None),
    ]


@pytest.mark.parametrize("code", [
    "canvas_confirmation_not_needed", "invalid_agent_canvas_request", "targets_missing",
    "not_found",
])
def test_confirmation_create_failure_preserves_server_error(agent, monkeypatch, code):
    plugin, calls, _, directory = agent
    _respond(agent, monkeypatch, "/confirmations", {
        "ok": False, "status_code": 422, "code": code, "message": "Create failed",
    })
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": DELETE})
    assert result == {
        "ok": False, "tool_call_status": "failed", "canvas_apply_status": "failed",
        "applied": False, "errors": ["Create failed"], "message": "Create failed", "code": code,
    }
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", CONFIRMATION_PATH, {"agent_id": "main", "turn_id": None, "commands": DELETE}),
    ]
    assert list(directory.iterdir()) == []


def test_confirmation_policy_unavailable_fails_without_dispatch(agent, monkeypatch):
    plugin, calls, _, directory = agent
    monkeypatch.setattr(plugin, "confirmation_kinds", None, raising=False)
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": CREATE})
    assert result["ok"] is False
    assert "Canvas command bridge is unavailable" in result["error"]
    assert [call for call in calls if call[0] == "POST"] == []
    assert list(directory.iterdir()) == []


BLOCKED = [
    {"node_id": "n1", "action": "generate_image", "label": "Image generation",
     "reason": "action_parameters"},
    {"node_id": None, "action": "run_workflow", "label": "Workflow",
     "reason": "mixed_commands"},
]


@pytest.mark.parametrize("code,extra,instruction", [
    ("canvas_open_required", {"blocked": BLOCKED},
     "These actions only run in the open canvas: Image generation, Workflow. "
     "Ask the user to open this canvas, then call the tool again afterwards. "
     "Do not retry on your own."),
    ("workflow_plan_invalid", {}, "Nothing ran. Explain the server message and fix the canvas "
     "or ask the user. Do not retry unchanged."),
])
def test_creation_rejection_preserves_http_details(agent, monkeypatch, code, extra, instruction):
    plugin, calls, _, directory = agent
    _respond(agent, monkeypatch, "/confirmations", plugin._http_error_result(
        409, json.dumps({"detail": {"code": code, "message": "Cannot run", **extra}}),
        "Conflict",
    ))
    result = _tool(plugin, "freezone_emit_canvas_command", {"commands": DELETE})
    assert result == {
        "ok": False, "tool_call_status": "failed", "canvas_apply_status": "not_applied",
        "applied": False, "errors": ["Cannot run"], "message": "Cannot run", "code": code,
        "agent_instruction": instruction, **extra,
    }
    assert calls == [
        ("GET", "/api/v1/config", None),
        ("POST", CONFIRMATION_PATH, {"agent_id": "main", "turn_id": None, "commands": DELETE}),
    ]
    assert list(directory.iterdir()) == []


@pytest.mark.parametrize("status,extra,instruction", [
    ("running", {"run_id": "run_1", "actions": [
        {"node_id": "n1", "action": "generate_image", "label": "Image generation"},
    ]}, "The confirmed workflow is running on the server as run_1. "
     "Do not call the run tool again. To report progress or results, call "
     "freezone_observe_workflow_run with this run_id (wait_seconds up to 20; pass the previous "
     "observation_token as after). Report outcomes only from a terminal observation. "
     "Call freezone_cancel_workflow_run only if the user asks to stop it."),
    ("already_completed", {}, "Nothing ran: every target already has a current result. "
     "Do not call it again."),
])
def test_confirm_server_run_result(agent, monkeypatch, status, extra, instruction):
    plugin, calls, _, directory = agent
    _respond(agent, monkeypatch, "/decision", {"ok": True, "data": {
        "confirmation_id": CONFIRMATION_ID, "status": status, **extra,
    }})
    result = _tool(plugin, "freezone_confirm_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    assert result == {
        "ok": True, "status": status, "tool_call_status": "completed",
        "canvas_apply_status": "running" if status == "running" else "not_applied",
        "applied": False, "confirmation_id": CONFIRMATION_ID, "project_id": "p",
        "canvas_id": "c", "agent_instruction": instruction, **extra,
    }
    assert calls == [("POST", f"{CONFIRMATION_PATH}/{CONFIRMATION_ID}/decision", {
        "decision": "confirmed", "via": "conversation", "agent_id": "main", "turn_id": None,
    })]
    assert list(directory.iterdir()) == []


@pytest.mark.parametrize("refused", [[], [
    {"node_id": "n2", "action": "auto_compose_video", "label": "Compose",
     "reason": "action_not_on_server", "code": "canvas_open_required"},
    {"node_id": "n3", "action": "generate_text", "label": "",
     "reason": "recipe_required", "code": "canvas_open_required"},
]])
def test_running_decision_reports_only_nonempty_refusals(agent, monkeypatch, refused):
    plugin, _, _, _ = agent
    _respond(agent, monkeypatch, "/decision", {"ok": True, "data": {
        "confirmation_id": CONFIRMATION_ID, "status": "running", "run_id": "run_1",
        "actions": [], "refused": refused,
    }})
    result = _tool(plugin, "freezone_confirm_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    instruction = (
        "The confirmed workflow is running on the server as run_1. "
        "Do not call the run tool again. To report progress or results, call "
        "freezone_observe_workflow_run with this run_id (wait_seconds up to 20; pass the previous "
        "observation_token as after). Report outcomes only from a terminal observation. "
        "Call freezone_cancel_workflow_run only if the user asks to stop it."
    )
    if refused:
        instruction += (
            " These actions were not run because they need the open canvas: Compose, generate_text."
            " They are recorded as failed in this run. Tell the user; "
            "do not retry them on your own."
        )
    assert result == {
        "ok": True, "status": "running", "tool_call_status": "completed",
        "canvas_apply_status": "running", "applied": False, "confirmation_id": CONFIRMATION_ID,
        "project_id": "p", "canvas_id": "c", "run_id": "run_1", "actions": [],
        "agent_instruction": instruction, **({"refused": refused} if refused else {}),
    }


@pytest.mark.parametrize("run_status", ["cancelled", "completed"])
@pytest.mark.parametrize("args,path", [
    ({"run_id": "run_1"}, "/api/v1/projects/p/freezone/canvases/c/workflow-runs/run_1"),
    ({"project_id": "p /?", "canvas_id": "c /?", "run_id": "run /?"},
     "/api/v1/projects/p%20%2F%3F/freezone/canvases/c%20%2F%3F/workflow-runs/run%20%2F%3F"),
])
def test_cancel_workflow_run_patches_status(agent, monkeypatch, args, path, run_status):
    plugin, calls, _, _ = agent

    def request(method, request_path, **kwargs):
        calls.append((method, request_path, kwargs))
        return {"ok": True, "data": {"run_id": args["run_id"], "status": run_status}}

    monkeypatch.setattr(plugin, "_request", request)
    result = _tool(plugin, "freezone_cancel_workflow_run", args)
    assert result == {
        "ok": True, "status": "cancelled", "run_id": args["run_id"], "run_status": run_status,
    }
    assert calls == [("PATCH", path, {"body": {"status": "cancelled"}})]


@pytest.mark.parametrize("response", [
    {"ok": False, "message": "Run cannot be cancelled"},
    {"ok": False, "error": "Run cannot be cancelled"},
])
def test_cancel_workflow_run_failure_is_not_retryable(agent, monkeypatch, response):
    plugin, _, _, _ = agent
    monkeypatch.setattr(plugin, "_request", lambda *_, **__: response)
    result = _tool(plugin, "freezone_cancel_workflow_run", {"run_id": "run_1"})
    assert result == {
        "ok": False, "status": "workflow_cancellation_failed", "run_id": "run_1",
        "error": "Run cannot be cancelled", "retryable": False,
    }


@pytest.mark.parametrize("args", [{}, {"run_id": ""}, {"run_id": "  "}])
def test_cancel_workflow_run_requires_id(agent, args):
    plugin, calls, _, _ = agent
    result = _tool(plugin, "freezone_cancel_workflow_run", args)
    assert result == {
        "ok": False, "status": "invalid_workflow_cancellation", "error": "run_id is required",
        "retryable": False,
    }
    assert calls == []


def test_cancel_workflow_run_requires_scope(agent, monkeypatch):
    plugin, calls, _, _ = agent
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID")
    monkeypatch.delenv("DRAMACLAW_CANVAS_ID")
    result = _tool(plugin, "freezone_cancel_workflow_run", {"run_id": "run_1"})
    assert result["ok"] is False
    assert result["status"] == "workflow_draft_scope_required"
    assert result["retryable"] is False
    assert calls == []


def test_cancel_workflow_run_schema_matches_observe_scope(agent):
    plugin, _, _, _ = agent
    schemas = {name: schema for name, schema, _ in plugin.TOOLS}
    cancel = schemas["freezone_cancel_workflow_run"]["parameters"]
    observe = schemas["freezone_observe_workflow_run"]["parameters"]
    assert cancel == {
        "type": "object", "additionalProperties": False, "required": ["run_id"],
        "properties": {key: value for key, value in observe["properties"].items()
                       if key not in {"wait_seconds", "after"}},
    }


def test_cancel_workflow_run_timeout_is_not_retryable(agent, monkeypatch):
    plugin, _, _, _ = agent

    def timeout(*_args, **_kwargs):
        raise TimeoutError("Cancellation timed out")

    monkeypatch.setattr(plugin, "_request", timeout)
    result = _tool(plugin, "freezone_cancel_workflow_run", {"run_id": "run_1"})
    assert result == {
        "ok": False, "status": "workflow_cancellation_failed", "run_id": "run_1",
        "error": "Cancellation timed out", "retryable": False,
    }


def applied_edit_result():
    return {
        "status": "applied", "revision": 7,
        "receipt": {
            "tool_call_status": "completed", "canvas_apply_status": "applied",
            "applied": True, "cancelled": False, "errors": [], "applied_count": 1,
            "created_node_ids": ["new-node"],
            "command_results": [{"type": "create_node", "status": "applied"}],
        },
        "changes": {"created_node_ids": ["new-node"]}, "recompute_count": 0,
    }


def test_running_decision_after_edits_reports_applied_nodes(agent, monkeypatch):
    plugin, _, _, _ = agent
    actions = [{"node_id": "new-node", "action": "generate_image", "label": "新海报"}]
    _respond(agent, monkeypatch, "/decision", {"ok": True, "data": {
        "confirmation_id": CONFIRMATION_ID, "status": "running", "run_id": "run_1",
        "actions": actions, "refused": [], "result": applied_edit_result(),
    }})
    result = _tool(plugin, "freezone_confirm_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    assert result == {
        "ok": True, "status": "running", "tool_call_status": "completed",
        "canvas_apply_status": "running", "applied": True, "confirmation_id": CONFIRMATION_ID,
        "project_id": "p", "canvas_id": "c", "run_id": "run_1", "actions": actions,
        "revision": 7, "created_node_ids": ["new-node"],
        "agent_instruction": (
            "The confirmed workflow is running on the server as run_1. "
            "Do not call the run tool again. To report progress or results, call "
            "freezone_observe_workflow_run with this run_id (wait_seconds up to 20; "
            "pass the previous "
            "observation_token as after). Report outcomes only from a terminal observation. "
            "Call freezone_cancel_workflow_run only if the user asks to stop it."
        ),
    }


@pytest.mark.parametrize("run,instruction", [
    ({"status": "not_started", "code": "canvas_open_required",
      "message": "这些动作需要打开画布才能运行：Compose", "blocked": [{
          "node_id": "n2", "action": "auto_compose_video", "label": "Compose",
          "reason": "action_not_on_server",
      }]},
     "The canvas edits were applied, but the workflow run did not start because these actions "
     "only run in the open canvas: Compose. Ask the user to open this canvas and run them there. "
     "Do not call this confirmation again."),
    ({"status": "not_started", "code": "workflow_plan_invalid", "message": "环"},
     "The canvas edits were applied, but the workflow run did not start: 环. "
     "Explain this to the user. Do not call this confirmation again."),
])
def test_executed_decision_reports_run_not_started(agent, monkeypatch, run, instruction):
    plugin, _, _, _ = agent
    edit_result = applied_edit_result()
    edit_result["recompute_count"] = 1
    _respond(agent, monkeypatch, "/decision", {"ok": True, "data": {
        "confirmation_id": CONFIRMATION_ID, "status": "executed",
        "result": edit_result, "run": run,
    }})
    result = _tool(plugin, "freezone_confirm_canvas_action", {"confirmation_id": CONFIRMATION_ID})
    assert result["ok"] is True
    assert result["canvas_apply_status"] == "applied"
    assert result["revision"] == 7
    assert result["created_node_ids"] == ["new-node"]
    assert result["confirmation_id"] == CONFIRMATION_ID
    assert result["run"] == run
    assert result["agent_instruction"] == instruction


@pytest.mark.parametrize("args", [{"node_ids": ["n1"]}, {"scope": "canvas"}],
                         ids=["node_ids", "canvas"])
@pytest.mark.parametrize("via", ["card", "conversation"])
def test_run_workflow_confirmation_is_a_valid_tool_result(agent, monkeypatch, args, via):
    plugin, calls, _, _ = agent
    monkeypatch.setattr(plugin, "_resolve_canvas_generation_recommendations", lambda *_: None)
    if via == "card":
        monkeypatch.setenv("DRAMACLAW_TURN_ID", "t1")
    _respond(agent, monkeypatch, "/presence", {"ok": True, "data": {"browser_open": True}})
    _respond(agent, monkeypatch, "/freezone/canvases/c", {
        "ok": True, "data": {"nodes": [{"id": "n1"}]},
    })
    data = {**CONFIRMATION, "kinds": ["paid_generation"]}
    _respond(agent, monkeypatch, "/confirmations", {"ok": True, "data": data})
    if via == "card":
        instruction = CARD_INSTRUCTION.replace(
            "type. Then", "type. Say that it will consume credits; do not give any estimate. Then",
        )
    else:
        instruction = CONVERSATION_INSTRUCTION.replace(
            "type, and", "type, say that it will consume credits without giving any estimate, and",
        )

    result = _tool(plugin, "freezone_run_workflow", args)

    assert result == _confirmation_result(data, via, instruction)
    assert [call for call in calls if call[0] == "POST"] == [
        ("POST", CONFIRMATION_PATH, {
            "agent_id": "main", "turn_id": "t1" if via == "card" else None,
            "commands": [{"type": "run_workflow", "direction": "connected", **args}],
        }),
    ]


def test_every_tool_that_can_request_confirmation_accepts_the_pending_result(agent, monkeypatch):
    import ast
    import inspect

    from jsonschema import ValidationError

    plugin, _, _, _ = agent
    plugin_file = Path(plugin.__file__).resolve()
    module = ast.parse(plugin_file.read_text())
    references = {
        function.name: {node.id for node in ast.walk(function) if isinstance(node, ast.Name)}
        for function in module.body
        if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    def reaches_confirmation(function_name):
        pending = [function_name]
        visited = set()
        while pending:
            name = pending.pop()
            if name == "_create_canvas_confirmation":
                return True
            if name not in visited:
                visited.add(name)
                pending.extend(references.get(name, set()) - visited)
        return False

    tools = set()
    for name, _schema, bound in plugin.TOOLS:
        handler = inspect.getclosurevars(bound).nonlocals["handler"]
        if Path(handler.__code__.co_filename).resolve() != plugin_file:
            continue
        if reaches_confirmation(handler.__name__):
            tools.add(name)
    assert tools >= {
        "freezone_emit_canvas_command", "freezone_delete_nodes", "freezone_run_node_action",
        "freezone_run_workflow", "freezone_confirm_workflow_draft",
    }

    failures = []
    for kind, via, commands in [
        ("paid_generation", "card", [{"type": "run_workflow", "scope": "canvas"}]),
        ("delete_nodes", "conversation", DELETE),
        ("clear_canvas", "conversation", [{"type": "clear_canvas"}]),
    ]:
        if via == "card":
            monkeypatch.setenv("DRAMACLAW_TURN_ID", "t1")
        else:
            monkeypatch.delenv("DRAMACLAW_TURN_ID", raising=False)
        _respond(agent, monkeypatch, "/presence", {"ok": True, "data": {"browser_open": True}})
        data = {**CONFIRMATION, "kinds": [kind]}
        _respond(agent, monkeypatch, "/confirmations", {"ok": True, "data": data})
        payload = plugin._create_canvas_confirmation("p", "c", commands)
        assert payload["confirmation_via"] == via
        for name in sorted(tools):
            try:
                _assert_real_mcp_output(plugin, name, payload)
            except ValidationError as error:
                failures.append(f"{name} ({kind}, {via}): {error.message}")
    assert not failures, "\n".join(failures)


@pytest.mark.parametrize("name", ["freezone_run_workflow", "freezone_confirm_workflow_draft"])
def test_pending_confirmation_shape_is_not_a_loose_success(agent, monkeypatch, name):
    from jsonschema import Draft202012Validator, ValidationError

    from novelvideo.chat import dramaclaw_mcp

    plugin, _, _, _ = agent
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "t1")
    _respond(agent, monkeypatch, "/presence", {"ok": True, "data": {"browser_open": True}})
    data = {**CONFIRMATION, "kinds": ["paid_generation"]}
    _respond(agent, monkeypatch, "/confirmations", {"ok": True, "data": data})
    payload = plugin._create_canvas_confirmation(
        "p", "c", [{"type": "run_workflow", "scope": "canvas"}],
    )
    schema = {n: s for n, s, _h in plugin.TOOLS}[name]["output_schema"]
    validator = Draft202012Validator(schema)
    for key, value in [
        ("applied", True),
        ("canvas_apply_status", "applied"),
        ("confirmation_id", None),
        ("confirmation_id", ""),
        ("status", "submitted"),
        ("tool_call_status", "failed"),
    ]:
        mutated = {**payload, key: value}
        if value is None:
            mutated.pop(key)
        with pytest.raises(ValidationError):
            validator.validate(dramaclaw_mcp._normalize_structured_result(schema, mutated))
    validator.validate(dramaclaw_mcp._normalize_structured_result(schema, payload))

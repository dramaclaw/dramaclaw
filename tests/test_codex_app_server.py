from pathlib import Path
from contextlib import contextmanager
from importlib.metadata import distribution
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gzip
import json
import os
import sqlite3
import threading
from types import SimpleNamespace

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import backend_sdk, codex_app_server, dramaclaw_mcp, service
from novelvideo.chat.backend_sdk import (
    CodexThread,
    _start_codex_turn,
    _start_or_resume_codex_thread,
    control_codex_runtime,
)


def test_runtime_rejects_sdk_bundled_binary():
    with pytest.raises(RuntimeError, match="DramaClaw-patched Codex runtime"):
        codex_app_server._resolve_codex_bin(SimpleNamespace(codex_bin=None))


def test_control_rpc_uses_shared_app_server_for_lifecycle(monkeypatch, tmp_path):
    calls = []

    class FakeClient:
        def turn_interrupt(self, thread_id, turn_id):
            calls.append(("interrupt", thread_id, turn_id))

        def thread_archive(self, thread_id):
            calls.append(("archive", thread_id))

        def request(self, method, payload, *, response_model):
            calls.append((method, payload, response_model.__name__))

    @contextmanager
    def fake_shared_codex(_config):
        yield SimpleNamespace(_client=FakeClient())

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    common = {
        "codex_bin": tmp_path / "codex",
        "cwd": tmp_path,
        "env": {},
        "config_overrides": (),
        "thread_id": "thread-a",
    }

    assert control_codex_runtime(**common, operation="interrupt", turn_id="turn-a")
    assert control_codex_runtime(**common, operation="archive")
    assert control_codex_runtime(**common, operation="delete")
    assert calls == [
        ("interrupt", "thread-a", "turn-a"),
        ("archive", "thread-a"),
        (
            "thread/delete",
            {"threadId": "thread-a"},
            "ThreadDeleteResponse",
        ),
    ]


def test_legacy_log_sanitizer_removes_turn_secrets_from_sqlite(tmp_path):
    database = tmp_path / "logs_2.sqlite"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE logs(feedback_log_body TEXT)")
    connection.executemany(
        "INSERT INTO logs VALUES (?)",
        [
            (
                'responsesapi_client_metadata: Some({"dramaclaw_gateway_api_key": '
                '"gateway-secret", "dramaclaw_control_context_capability": '
                '"capability-secret"}), additional_context: {}',
            ),
            (
                r"client-metadata: {\"dramaclaw_gateway_api_key\":\"gateway-secret\","
                r"\"dramaclaw_control_context_capability\":\"capability-secret\"}",
            ),
            ("unrelated log row",),
        ],
    )
    connection.commit()
    connection.close()

    assert codex_app_server._sanitize_legacy_turn_metadata(tmp_path) == 2

    raw = database.read_bytes()
    assert b"gateway-secret" not in raw
    assert b"capability-secret" not in raw
    assert b"<redacted>" in raw
    assert codex_app_server._sanitize_legacy_turn_metadata(tmp_path) == 0


def test_control_socket_path_is_short_and_stable(monkeypatch, tmp_path):
    control_dir = tmp_path / "control"
    control_dir.mkdir()
    monkeypatch.setattr(codex_app_server, "_control_dir", lambda: control_dir)

    long_home = tmp_path / ("very-long-project-state-directory-" * 8)
    socket_path, lock_path, signature_path = codex_app_server._control_paths(long_home)
    repeated = codex_app_server._control_paths(long_home)

    assert (socket_path, lock_path, signature_path) == repeated
    assert socket_path.parent.parent == control_dir
    assert socket_path.name == "app-server.sock"
    assert lock_path.name == "node-runtime.lock"
    assert signature_path.name == "app-server.signature"
    assert socket_path.parent.stat().st_mode & 0o777 == 0o700


def test_control_files_use_system_tmp_while_logs_use_runtime(monkeypatch, tmp_path):
    runtime_root = tmp_path / "runtime"
    codex_home = tmp_path / "state" / ".codex-app-server"
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(runtime_root))

    socket_path, lock_path, signature_path = codex_app_server._control_paths(codex_home)
    log_path = codex_app_server._app_server_log_path(codex_home)

    expected_control_root = Path("/tmp") / f"claymore-{os.getuid()}"
    assert socket_path.parent.parent == expected_control_root
    assert lock_path.parent == socket_path.parent
    assert signature_path.parent == socket_path.parent
    assert log_path.parent == runtime_root / "codex" / "logs"
    assert not str(socket_path).startswith(str(codex_home))
    assert not str(log_path).startswith(str(codex_home))
    assert expected_control_root.stat().st_mode & 0o777 == 0o700
    assert socket_path.parent.stat().st_mode & 0o777 == 0o700
    assert len(os.fsencode(str(socket_path))) < 100
    assert (runtime_root / "codex" / "logs").stat().st_mode & 0o777 == 0o700


def test_control_socket_identity_changes_with_codex_home(monkeypatch, tmp_path):
    control_dir = tmp_path / "control"
    control_dir.mkdir()
    monkeypatch.setattr(codex_app_server, "_control_dir", lambda: control_dir)

    first = codex_app_server._control_paths(Path("/state/node-a/.codex"))[0]
    second = codex_app_server._control_paths(Path("/state/node-b/.codex"))[0]

    assert first != second


def test_runtime_signature_digest_does_not_embed_gateway_secret():
    signature = (
        "/usr/local/bin/codex",
        "/data/state/.codex-app-server",
        ('model_providers.dramaclaw_gateway.wire_api="responses"',),
        "super-secret-key",
        "http://gateway:3000/v1",
    )

    digest = codex_app_server._signature_digest(signature)

    assert len(digest) == 64
    assert "super-secret-key" not in digest


def test_missing_rollout_starts_a_replacement_thread():
    from openai_codex.errors import InvalidRequestError

    replacement = object()

    class FakeCodex:
        def thread_resume(self, thread_id, **options):
            raise InvalidRequestError(
                -32600,
                f"no rollout found for thread id {thread_id}",
            )

        def thread_start(self, **options):
            assert options == {"model": "DC-codex-agent-LLM"}
            return replacement

    result = _start_or_resume_codex_thread(
        FakeCodex(),
        "stale-thread",
        {"model": "DC-codex-agent-LLM"},
    )

    assert result is replacement


def test_resume_does_not_hide_non_stale_invalid_request():
    from openai_codex.errors import InvalidRequestError

    class FakeCodex:
        def thread_resume(self, thread_id, **options):
            raise InvalidRequestError(-32600, "permission profile is invalid")

        def thread_start(self, **options):
            raise AssertionError(
                "must not replace a valid thread on configuration errors"
            )

    with pytest.raises(InvalidRequestError, match="permission profile is invalid"):
        _start_or_resume_codex_thread(FakeCodex(), "thread-1", {})


def test_turn_metadata_is_sent_on_raw_turn_start():
    calls = []

    class FakeClient:
        def turn_start(self, thread_id, input_items, params=None):
            calls.append((thread_id, input_items, params))
            return SimpleNamespace(turn=SimpleNamespace(id="turn-1"))

    thread = SimpleNamespace(id="thread-1", _client=FakeClient())
    handle = _start_codex_turn(
        thread,
        "hello",
        {
            "dramaclaw_gateway_api_key": "turn-secret",
            "dramaclaw_control_context_capability": "signed-capability",
        },
    )

    assert handle.id == "turn-1"
    assert calls[0][0] == "thread-1"
    assert calls[0][1] == [{"type": "text", "text": "hello"}]
    assert calls[0][2] == {
        "responsesapiClientMetadata": {
            "dramaclaw_gateway_api_key": "turn-secret",
            "dramaclaw_control_context_capability": "signed-capability",
        }
    }


def test_codex_149_sdk_exposes_required_runtime_notifications():
    from importlib.metadata import version

    from openai_codex import Codex
    from openai_codex.client import CodexClient
    from openai_codex.generated.notification_registry import NOTIFICATION_MODELS

    # shared_codex() intentionally bridges onto these SDK internals so a
    # persistent App Server can serve lightweight per-turn client connections.
    assert all(
        hasattr(Codex, name) for name in ("metadata", "thread_start", "thread_resume")
    )
    assert all(
        hasattr(CodexClient, name)
        for name in ("initialize", "thread_start", "turn_start")
    )
    assert version("openai-codex-cli-bin") == "0.149.0"
    assert {
        "item/agentMessage/delta",
        "item/completed",
        "item/mcpToolCall/progress",
        "item/reasoning/summaryTextDelta",
        "item/started",
        "thread/tokenUsage/updated",
        "turn/completed",
        "turn/plan/updated",
        "turn/started",
    } <= NOTIFICATION_MODELS.keys()


def _responses_sse(*events: dict) -> bytes:
    chunks = []
    for event in events:
        event_type = event["type"]
        chunks.append(f"event: {event_type}\ndata: {json.dumps(event)}\n\n")
    return "".join(chunks).encode()


def _response_created(response_id: str) -> dict:
    return {"type": "response.created", "response": {"id": response_id}}


def _response_completed(response_id: str) -> dict:
    return {
        "type": "response.completed",
        "response": {
            "id": response_id,
            "usage": {
                "input_tokens": 0,
                "input_tokens_details": None,
                "output_tokens": 0,
                "output_tokens_details": None,
                "total_tokens": 0,
            },
        },
    }


@contextmanager
def _recording_responses_gateway(responses: list[bytes]):
    requests: list[dict] = []
    response_queue = iter(responses)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - stdlib handler callback
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            if self.headers.get("Content-Encoding", "").lower() == "gzip":
                raw = gzip.decompress(raw)
            requests.append(
                {
                    "path": self.path,
                    "headers": dict(self.headers),
                    "body": json.loads(raw),
                }
            )
            try:
                response = next(response_queue)
            except StopIteration:
                self.send_error(500, "unexpected extra Responses request")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, _format, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


@pytest.mark.asyncio
async def test_app_server_native_tool_search_preserves_gateway_event_chain(
    monkeypatch, tmp_path
):
    """Record the complete Responses Tool Search chain across App Server + MCP."""
    search_call_id = "search-call-1"
    tool_call_id = "mcp-call-1"
    tool_name = "dramaclaw_prepare_system_voices"
    namespace = "mcp__dramaclaw"
    scripted_responses = [
        _responses_sse(
            _response_created("response-1"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "tool_search_call",
                    "call_id": search_call_id,
                    "execution": "client",
                    "arguments": {
                        "query": (
                            "Prepare missing narrator and character reference voices from system "
                            "presets. This starts the agent-only system_voice_setup background "
                            "task and does not start episode TTS."
                        ),
                        "limit": 8,
                    },
                },
            },
            _response_completed("response-1"),
        ),
        _responses_sse(
            _response_created("response-2"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "call_id": tool_call_id,
                    "namespace": namespace,
                    "name": tool_name,
                    "arguments": json.dumps({"episode": 1, "confirmed": False}),
                },
            },
            _response_completed("response-2"),
        ),
        _responses_sse(
            _response_created("response-3"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": "message-1",
                    "content": [{"type": "output_text", "text": "需要用户确认。"}],
                },
            },
            _response_completed("response-3"),
        ),
    ]

    with _recording_responses_gateway(scripted_responses) as (gateway_url, requests):
        bundled_codex = Path(
            distribution("openai-codex-cli-bin").locate_file("codex_cli_bin/bin/codex")
        )
        assert bundled_codex.is_file(), "the pinned App Server binary is required"
        token_file = tmp_path / "turn.token"
        token_file.write_text("contract-test-token", encoding="utf-8")
        token_file.chmod(0o600)
        monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
        monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "native-tool-search-contract")
        env = {
            **os.environ,
            "CODEX_HOME": str(tmp_path / "codex-home"),
            "DRAMACLAW_CODEX_GATEWAY_BASE_URL": gateway_url,
            "DRAMACLAW_PROJECT_ID": "native-tool-search-contract",
            "DRAMACLAW_USERNAME": "local",
            "DRAMACLAW_AGENT_TOKEN_FILE": str(token_file),
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        mcp_servers = service._dramaclaw_mcp_servers()
        mcp_servers["dramaclaw"]["env_vars"].append("PYTHONPATH")
        client = backend_sdk.CodexClient(
            codex_bin=bundled_codex,
            cwd=tmp_path,
            env=env,
            model="DC-codex-agent-LLM",
            model_provider="dramaclaw_gateway",
            developer_instructions=service._codex_developer_instructions("default"),
            config_overrides=service._codex_gateway_config_overrides(gateway_url),
            thread_config_overrides=service._codex_mcp_config_overrides(mcp_servers),
            turn_metadata={"dramaclaw_gateway_api_key": "per-turn-contract-key"},
        )

        try:
            events = [
                event
                async for event in client.thread_start().stream(
                    "为第 1 集准备系统音色，但不要确认执行。"
                )
            ]
        finally:
            codex_app_server.stop_shared_codex_runtime()

    assert len(requests) == 3
    assert [request["path"] for request in requests] == ["/v1/responses"] * 3
    first, second, third = [request["body"] for request in requests]

    first_tool_names = [tool.get("name") for tool in first["tools"]]
    assert any(tool.get("type") == "tool_search" for tool in first["tools"])
    assert tool_name not in first_tool_names
    assert namespace not in first_tool_names

    second_history = second["input"]
    search_call = next(
        item for item in second_history if item.get("type") == "tool_search_call"
    )
    search_output = next(
        item for item in second_history if item.get("type") == "tool_search_output"
    )
    assert search_call["call_id"] == search_output["call_id"] == search_call_id
    assert second_history.index(search_call) < second_history.index(search_output)
    assert search_output["execution"] == "client"
    assert search_output["status"] == "completed"

    discovered_namespace = search_output["tools"][0]
    assert discovered_namespace["type"] == "namespace"
    assert discovered_namespace["name"] == namespace
    discovered_tool = next(
        tool for tool in discovered_namespace["tools"] if tool.get("name") == tool_name
    )
    expected_schema = dramaclaw_mcp.TOOLS[tool_name][0]
    assert discovered_tool["name"] == tool_name
    assert discovered_tool["parameters"] == expected_schema["parameters"]
    assert discovered_tool["defer_loading"] is True
    # Native Responses serializes the searched function's input contract in
    # tool_search_output. The output contract remains on MCP tools/list and
    # governs the structuredContent that App Server returns to the model.
    advertised_tool = next(
        tool for tool in await dramaclaw_mcp.list_tools() if tool.name == tool_name
    )
    assert advertised_tool.inputSchema == expected_schema["parameters"]
    assert advertised_tool.outputSchema == expected_schema["output_schema"]
    assert not {
        "dramaclaw_tool_search",
        "dramaclaw_tool_describe",
        "dramaclaw_tool_call",
    } & {tool["name"] for tool in discovered_namespace["tools"]}
    for request in (second, third):
        advertised_names = [tool.get("name") for tool in request["tools"]]
        assert tool_name not in advertised_names
        assert namespace not in advertised_names

    third_history = third["input"]
    concrete_call = next(
        item
        for item in third_history
        if item.get("type") == "function_call" and item.get("name") == tool_name
    )
    concrete_output = next(
        item for item in third_history if item.get("type") == "function_call_output"
    )
    assert concrete_call["call_id"] == concrete_output["call_id"] == tool_call_id
    assert third_history.index(concrete_call) < third_history.index(concrete_output)
    assert (
        third_history.index(search_call)
        < third_history.index(search_output)
        < third_history.index(concrete_call)
        < third_history.index(concrete_output)
    )
    tool_result = json.loads(concrete_output["output"].split("Output:\n", 1)[1])
    assert tool_result["ok"] is False
    assert tool_result["status"] == "failed"
    assert "system_voice_confirmation_required" in tool_result["error"]
    Draft202012Validator(advertised_tool.outputSchema).validate(tool_result)

    tool_events = [event for event in events if event.type == "tool_updated"]
    assert [event.name for event in tool_events] == [f"dramaclaw.{tool_name}"]
    assert tool_events[0].call_id == tool_call_id
    assert tool_events[0].structured == tool_result
    assert any(
        event.type == "complete" and event.text == "需要用户确认。" for event in events
    )


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_real_gateway_app_server_native_tool_search_calls_concrete_mcp(
    monkeypatch, tmp_path
):
    """Exercise the deployed Gateway, real App Server, and stdio MCP together.

    This is intentionally opt-in because it spends a real model request and
    requires a Gateway with Responses Tool Search enabled. It verifies the
    externally observable contract: the model reaches a scope-filtered
    concrete MCP tool, not the removed search/describe/call wrappers.
    """

    if os.environ.get("DRAMACLAW_NATIVE_TOOL_SEARCH_E2E", "").strip() != "1":
        pytest.skip("set DRAMACLAW_NATIVE_TOOL_SEARCH_E2E=1 for the live Gateway test")
    gateway_base_url = os.environ.get(
        "DRAMACLAW_NATIVE_TOOL_SEARCH_E2E_GATEWAY_URL", ""
    ).strip()
    gateway_api_key = os.environ.get(
        "DRAMACLAW_NATIVE_TOOL_SEARCH_E2E_GATEWAY_KEY", ""
    ).strip()
    if not gateway_base_url or not gateway_api_key:
        pytest.skip("a Tool Search-capable DramaClaw Gateway URL and key are required")

    bundled_codex = Path(
        distribution("openai-codex-cli-bin").locate_file("codex_cli_bin/bin/codex")
    )
    codex_bin = Path(os.environ.get("CODEX_BIN", "") or bundled_codex)
    if not codex_bin.is_file():
        pytest.skip("DramaClaw-patched Codex binary is unavailable")

    codex_home = tmp_path / "codex-home"
    token_file = tmp_path / "turn.token"
    token_file.write_text("e2e-agent-token", encoding="utf-8")
    token_file.chmod(0o600)
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    env = {
        **os.environ,
        "CODEX_HOME": str(codex_home),
        "DRAMACLAW_CODEX_GATEWAY_BASE_URL": gateway_base_url,
        "DRAMACLAW_PROJECT_ID": "native-tool-search-e2e",
        "DRAMACLAW_USERNAME": "local",
        "DRAMACLAW_AGENT_TOKEN_FILE": str(token_file),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    client = backend_sdk.CodexClient(
        codex_bin=codex_bin,
        cwd=tmp_path,
        env=env,
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions=service._codex_developer_instructions("default"),
        config_overrides=service._codex_gateway_config_overrides(gateway_base_url),
        thread_config_overrides=service._codex_mcp_config_overrides(
            service._dramaclaw_mcp_servers()
        ),
        turn_metadata={"dramaclaw_gateway_api_key": gateway_api_key},
    )

    try:
        events = [
            event
            async for event in client.thread_start().stream(
                "为第 1 集准备系统音色，但不要确认执行。使用原生 Tool Search 找到并调用"
                "唯一合适的 DramaClaw MCP 业务工具，然后简短报告确认要求。"
            )
        ]
    finally:
        codex_app_server.stop_shared_codex_runtime()

    completed_tools = [
        event
        for event in events
        if event.type == "tool_updated" and event.status == "completed"
    ]
    assert [event.name for event in completed_tools] == [
        "dramaclaw.dramaclaw_prepare_system_voices"
    ]
    assert completed_tools[0].call_id
    assert completed_tools[0].structured["ok"] is False
    assert (
        "system_voice_confirmation_required" in completed_tools[0].structured["error"]
    )
    assert all(
        name not in str(event.name or "")
        for event in events
        for name in (
            "dramaclaw_tool_search",
            "dramaclaw_tool_describe",
            "dramaclaw_tool_call",
        )
    )


def test_codex_native_approval_handler_fails_closed():
    assert codex_app_server._deny_unexpected_approval(
        "item/commandExecution/requestApproval", {"command": "echo unsafe"}
    ) == {"decision": "decline"}
    assert codex_app_server._deny_unexpected_approval(
        "item/fileChange/requestApproval", {"changes": []}
    ) == {"decision": "decline"}
    assert codex_app_server._deny_unexpected_approval("unknown/request", {}) == {}


def test_shared_codex_private_sdk_bridge_is_compatible(monkeypatch, tmp_path):
    from openai_codex.models import InitializeResponse, ServerInfo

    codex_bin = tmp_path / "codex"
    codex_bin.write_text("runtime placeholder", encoding="utf-8")
    codex_home = tmp_path / "codex-home"
    socket_path = tmp_path / "codex.sock"
    calls: list[str] = []

    class FakeClient:
        def start(self):
            calls.append("start")

        def initialize(self):
            calls.append("initialize")
            return InitializeResponse(
                userAgent="codex-app-server/0.149.0",
                serverInfo=ServerInfo(name="codex-app-server", version="0.149.0"),
            )

        def close(self):
            calls.append("close")

    monkeypatch.setattr(
        codex_app_server._RUNTIME,
        "ensure",
        lambda **_kwargs: socket_path,
    )
    monkeypatch.setattr(
        codex_app_server._UnixSocketCodexClient,
        "create",
        lambda _config, resolved_socket: (
            FakeClient()
            if resolved_socket == socket_path
            else pytest.fail("unexpected socket path")
        ),
    )
    config = SimpleNamespace(
        codex_bin=str(codex_bin),
        env={"CODEX_HOME": str(codex_home)},
        config_overrides=(),
    )

    with codex_app_server.shared_codex(config) as codex:
        assert codex.metadata.serverInfo.version == "0.149.0"
        assert calls == ["start", "initialize"]

    assert calls == ["start", "initialize", "close"]


@pytest.mark.asyncio
async def test_codex_stream_maps_structured_runtime_events(monkeypatch, tmp_path):
    from openai_codex.generated import v2_all as v2
    from openai_codex.models import Notification

    turn_in_progress = {"id": "turn-1", "items": [], "status": "inProgress"}
    usage = {
        "inputTokens": 10,
        "cachedInputTokens": 2,
        "outputTokens": 3,
        "reasoningOutputTokens": 1,
        "totalTokens": 13,
    }
    started_tool = {
        "type": "mcpToolCall",
        "id": "call-1",
        "server": "dramaclaw",
        "tool": "list_projects",
        "arguments": {"limit": 1},
        "status": "inProgress",
    }
    completed_tool = {
        **started_tool,
        "status": "completed",
        "result": {
            "content": [{"type": "text", "text": "ok"}],
            "structuredContent": {"projects": []},
        },
    }
    notifications = [
        Notification(
            method="turn/started",
            payload=v2.TurnStartedNotification.model_validate(
                {"threadId": "thread-1", "turn": turn_in_progress}
            ),
        ),
        Notification(
            method="turn/plan/updated",
            payload=v2.TurnPlanUpdatedNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "explanation": "Inspect the project",
                    "plan": [{"step": "List projects", "status": "inProgress"}],
                }
            ),
        ),
        Notification(
            method="item/reasoning/summaryTextDelta",
            payload=v2.ReasoningSummaryTextDeltaNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "reasoning-1",
                    "summaryIndex": 0,
                    "delta": "Checking available projects",
                }
            ),
        ),
        Notification(
            method="item/reasoning/textDelta",
            payload=v2.ReasoningTextDeltaNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "reasoning-1",
                    "contentIndex": 0,
                    "delta": "private chain of thought",
                }
            ),
        ),
        Notification(
            method="item/started",
            payload=v2.ItemStartedNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "startedAtMs": 1,
                    "item": started_tool,
                }
            ),
        ),
        Notification(
            method="item/mcpToolCall/progress",
            payload=v2.McpToolCallProgressNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "call-1",
                    "message": "Reading project index",
                }
            ),
        ),
        Notification(
            method="thread/tokenUsage/updated",
            payload=v2.ThreadTokenUsageUpdatedNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "tokenUsage": {
                        "last": usage,
                        "total": usage,
                        "modelContextWindow": 1000,
                    },
                }
            ),
        ),
        Notification(
            method="item/completed",
            payload=v2.ItemCompletedNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "completedAtMs": 2,
                    "item": completed_tool,
                }
            ),
        ),
        Notification(
            method="item/agentMessage/delta",
            payload=v2.AgentMessageDeltaNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "message-1",
                    "delta": "Done",
                }
            ),
        ),
        Notification(
            method="turn/completed",
            payload=v2.TurnCompletedNotification.model_validate(
                {
                    "threadId": "thread-1",
                    "turn": {"id": "turn-1", "items": [], "status": "completed"},
                }
            ),
        ),
    ]

    class FakeTurn:
        id = "turn-1"

        def stream(self):
            return iter(notifications)

        def interrupt(self):
            return None

    class FakeThread:
        id = "thread-1"

    @contextmanager
    def fake_shared_codex(_config):
        yield object()

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(
        "novelvideo.chat.backend_sdk._start_or_resume_codex_thread",
        lambda *_args, **_kwargs: FakeThread(),
    )
    monkeypatch.setattr(
        "novelvideo.chat.backend_sdk._start_codex_turn",
        lambda *_args, **_kwargs: FakeTurn(),
    )

    thread = CodexThread(
        codex_bin=None,
        cwd=tmp_path,
        env={},
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use DramaClaw MCP only.",
        config_overrides=(),
        thread_config={},
        turn_metadata={},
        thread_id=None,
    )
    events = [event async for event in thread.stream("List projects")]

    assert [event.type for event in events] == [
        "thread_started",
        "egress_submitted",
        "turn_started",
        "plan_update",
        "thought_delta",
        "tool_started",
        "tool_updated",
        "usage_update",
        "tool_updated",
        "assistant_delta",
        "turn_completed",
        "egress_disposition",
        "complete",
    ]
    plan = next(event for event in events if event.type == "plan_update")
    assert plan.entries == [{"status": "inProgress", "step": "List projects"}]
    thought = next(event for event in events if event.type == "thought_delta")
    assert thought.name == "reasoning_summary"
    started = next(event for event in events if event.type == "tool_started")
    assert started.name == "dramaclaw.list_projects"
    assert started.call_id == "call-1"
    assert started.input == {"limit": 1}
    completed = [event for event in events if event.type == "tool_updated"][-1]
    assert completed.status == "completed"
    assert completed.structured == {"projects": []}
    usage_event = next(event for event in events if event.type == "usage_update")
    assert usage_event.usage["last"]["inputTokens"] == 10
    turn_completed = next(event for event in events if event.type == "turn_completed")
    assert turn_completed.status == "completed"
    assert turn_completed.raw["method"] == "turn/completed"
    assert events[-1].text == "Done"


@pytest.mark.asyncio
async def test_codex_stream_times_out_before_first_runtime_progress(
    monkeypatch, tmp_path
):
    from openai_codex.generated import v2_all as v2
    from openai_codex.models import Notification

    released = threading.Event()
    interrupt_calls = []
    turn_started = Notification(
        method="turn/started",
        payload=v2.TurnStartedNotification.model_validate(
            {
                "threadId": "thread-timeout",
                "turn": {"id": "turn-timeout", "items": [], "status": "inProgress"},
            }
        ),
    )

    class FakeTurn:
        id = "turn-timeout"

        def stream(self):
            yield turn_started
            released.wait(timeout=2)

        def interrupt(self):
            interrupt_calls.append(self.id)
            released.set()

    class FakeThread:
        id = "thread-timeout"

    @contextmanager
    def fake_shared_codex(_config):
        yield object()

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(
        backend_sdk,
        "_start_or_resume_codex_thread",
        lambda *_args, **_kwargs: FakeThread(),
    )
    monkeypatch.setattr(
        backend_sdk,
        "_start_codex_turn",
        lambda *_args, **_kwargs: FakeTurn(),
    )
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_FIRST_PROGRESS_TIMEOUT", 0.05)
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_IDLE_TIMEOUT", 1.0)
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_TOTAL_TIMEOUT", 1.0)
    monkeypatch.setattr(backend_sdk, "CODEX_INTERRUPT_GRACE_TIMEOUT", 0.5)

    thread = CodexThread(
        codex_bin=None,
        cwd=tmp_path,
        env={},
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use DramaClaw MCP only.",
        config_overrides=(),
        thread_config={},
        turn_metadata={},
        thread_id=None,
    )
    events = [event async for event in thread.stream("Create workflow")]

    assert interrupt_calls == ["turn-timeout"]
    assert [event.type for event in events[-3:]] == [
        "turn_completed",
        "egress_disposition",
        "complete",
    ]
    assert events[-3].status == "timeout"
    assert events[-3].error["kind"] == "first-progress"
    assert events[-2].disposition == "timeout"
    assert events[-1].disposition == "timeout"
    assert events[-1].text == "Codex App Server 响应超时，请重试。"


def test_codex_first_progress_timeout_accepts_positive_environment_override(
    monkeypatch,
):
    monkeypatch.setenv("DRAMACLAW_CODEX_FIRST_PROGRESS_TIMEOUT_SECONDS", "420")
    assert (
        backend_sdk._positive_timeout_from_env(
            "DRAMACLAW_CODEX_FIRST_PROGRESS_TIMEOUT_SECONDS", 300.0
        )
        == 420.0
    )


@pytest.mark.parametrize("value", ["", "invalid", "0", "-1"])
def test_codex_first_progress_timeout_rejects_invalid_environment_override(
    monkeypatch,
    value,
):
    monkeypatch.setenv("DRAMACLAW_CODEX_FIRST_PROGRESS_TIMEOUT_SECONDS", value)
    assert (
        backend_sdk._positive_timeout_from_env(
            "DRAMACLAW_CODEX_FIRST_PROGRESS_TIMEOUT_SECONDS", 300.0
        )
        == 300.0
    )


@pytest.mark.asyncio
async def test_codex_stream_times_out_after_runtime_becomes_idle(monkeypatch, tmp_path):
    from openai_codex.generated import v2_all as v2
    from openai_codex.models import Notification

    released = threading.Event()
    interrupt_calls = []
    notifications = [
        Notification(
            method="turn/started",
            payload=v2.TurnStartedNotification.model_validate(
                {
                    "threadId": "thread-idle",
                    "turn": {"id": "turn-idle", "items": [], "status": "inProgress"},
                }
            ),
        ),
        Notification(
            method="item/agentMessage/delta",
            payload=v2.AgentMessageDeltaNotification.model_validate(
                {
                    "threadId": "thread-idle",
                    "turnId": "turn-idle",
                    "itemId": "message-idle",
                    "delta": "处理中",
                }
            ),
        ),
    ]

    class FakeTurn:
        id = "turn-idle"

        def stream(self):
            yield from notifications
            released.wait(timeout=2)

        def interrupt(self):
            interrupt_calls.append(self.id)
            released.set()

    class FakeThread:
        id = "thread-idle"

    @contextmanager
    def fake_shared_codex(_config):
        yield object()

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(
        backend_sdk,
        "_start_or_resume_codex_thread",
        lambda *_args, **_kwargs: FakeThread(),
    )
    monkeypatch.setattr(
        backend_sdk,
        "_start_codex_turn",
        lambda *_args, **_kwargs: FakeTurn(),
    )
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_FIRST_PROGRESS_TIMEOUT", 1.0)
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_IDLE_TIMEOUT", 0.05)
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_TOTAL_TIMEOUT", 1.0)
    monkeypatch.setattr(backend_sdk, "CODEX_INTERRUPT_GRACE_TIMEOUT", 0.5)

    thread = CodexThread(
        codex_bin=None,
        cwd=tmp_path,
        env={},
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use DramaClaw MCP only.",
        config_overrides=(),
        thread_config={},
        turn_metadata={},
        thread_id=None,
    )
    events = [event async for event in thread.stream("Create workflow")]

    assert interrupt_calls == ["turn-idle"]
    assert any(event.type == "assistant_delta" for event in events)
    assert events[-3].error["kind"] == "idle"
    assert events[-2].disposition == "timeout"
    assert events[-1].type == "complete"
    assert events[-1].disposition == "timeout"


@pytest.mark.asyncio
async def test_codex_stream_enforces_total_deadline_despite_continuous_progress(
    monkeypatch, tmp_path
):
    from openai_codex.generated import v2_all as v2
    from openai_codex.models import Notification

    released = threading.Event()
    interrupt_calls = []
    progress = Notification(
        method="item/agentMessage/delta",
        payload=v2.AgentMessageDeltaNotification.model_validate(
            {
                "threadId": "thread-total",
                "turnId": "turn-total",
                "itemId": "message-total",
                "delta": ".",
            }
        ),
    )

    class FakeTurn:
        id = "turn-total"

        def stream(self):
            while not released.wait(timeout=0.005):
                yield progress

        def interrupt(self):
            interrupt_calls.append(self.id)
            released.set()

    class FakeThread:
        id = "thread-total"

    @contextmanager
    def fake_shared_codex(_config):
        yield object()

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(
        backend_sdk,
        "_start_or_resume_codex_thread",
        lambda *_args, **_kwargs: FakeThread(),
    )
    monkeypatch.setattr(
        backend_sdk,
        "_start_codex_turn",
        lambda *_args, **_kwargs: FakeTurn(),
    )
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_FIRST_PROGRESS_TIMEOUT", 1.0)
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_IDLE_TIMEOUT", 1.0)
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_TOTAL_TIMEOUT", 0.05)
    monkeypatch.setattr(backend_sdk, "CODEX_INTERRUPT_GRACE_TIMEOUT", 0.5)

    thread = CodexThread(
        codex_bin=None,
        cwd=tmp_path,
        env={},
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use DramaClaw MCP only.",
        config_overrides=(),
        thread_config={},
        turn_metadata={},
        thread_id=None,
    )
    events = [event async for event in thread.stream("Create workflow")]

    assert interrupt_calls == ["turn-total"]
    assert sum(event.type == "assistant_delta" for event in events) > 1
    assert events[-3].error["kind"] == "total"
    assert events[-2].disposition == "timeout"
    assert events[-1].type == "complete"
    assert events[-1].disposition == "timeout"

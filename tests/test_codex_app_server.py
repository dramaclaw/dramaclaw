import asyncio
from pathlib import Path
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gzip
import json
import logging
import os
import sqlite3
import sys
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
from novelvideo.freezone.agent_canvas_metrics import metrics_snapshot


def _integration_codex_binary() -> Path:
    configured = os.environ.get("CODEX_BIN", "").strip()
    if configured:
        binary = Path(configured)
        assert binary.is_file(), "CODEX_BIN must point to the compiled runtime"
        return binary
    pytest.skip(
        "chat needs a Codex runtime that starts paginated threads; "
        "the SDK-bundled binary starts legacy ones (set CODEX_BIN)"
    )


def test_runtime_rejects_sdk_bundled_binary():
    with pytest.raises(RuntimeError, match="DramaClaw-patched Codex runtime"):
        codex_app_server._resolve_codex_bin(SimpleNamespace(codex_bin=None))


def test_windows_websocket_uses_preconnected_socket_and_closes_on_failure(
    monkeypatch, tmp_path
):
    from unittest.mock import Mock
    import websockets.sync.client

    stream = Mock()
    native_connect = Mock(return_value=stream)
    monkeypatch.setitem(
        sys.modules,
        "novelvideo.chat.codex_app_server_windows",
        SimpleNamespace(connect_unix_socket=native_connect),
    )
    monkeypatch.setattr(codex_app_server, "os", SimpleNamespace(name="nt"))
    handshake = Mock(side_effect=TimeoutError("handshake timed out"))
    monkeypatch.setattr(websockets.sync.client, "unix_connect", handshake)
    path = tmp_path / "codex.sock"
    with pytest.raises(TimeoutError, match="handshake timed out"):
        codex_app_server._connect_local_websocket(
            path, uri="ws://localhost/rpc", open_timeout=0.2
        )
    native_connect.assert_called_once_with(path, 0.2)
    assert handshake.call_args.args == ()
    assert handshake.call_args.kwargs["sock"] is stream
    assert 0 <= handshake.call_args.kwargs["open_timeout"] <= 0.2
    stream.close.assert_called_once()


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
    monkeypatch.setattr(codex_app_server, "attach_shared_codex", fake_shared_codex, raising=False)
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


def test_delete_treats_missing_thread_as_already_cleaned(monkeypatch, tmp_path):
    from openai_codex.errors import InvalidRequestError

    class FakeClient:
        def request(self, method, payload, *, response_model):
            raise InvalidRequestError(
                -32600,
                f"thread not found: {payload['threadId']}",
            )

    @contextmanager
    def fake_shared_codex(_config):
        yield SimpleNamespace(_client=FakeClient())

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)

    assert control_codex_runtime(
        codex_bin=tmp_path / "codex",
        cwd=tmp_path,
        env={},
        config_overrides=(),
        operation="delete",
        thread_id="stale-thread",
    )


def test_delete_does_not_hide_other_runtime_errors(monkeypatch, tmp_path):
    from openai_codex.errors import InvalidRequestError

    class FakeClient:
        def request(self, method, payload, *, response_model):
            raise InvalidRequestError(-32600, "permission profile is invalid")

    @contextmanager
    def fake_shared_codex(_config):
        yield SimpleNamespace(_client=FakeClient())

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)

    with pytest.raises(InvalidRequestError, match="permission profile is invalid"):
        control_codex_runtime(
            codex_bin=tmp_path / "codex",
            cwd=tmp_path,
            env={},
            config_overrides=(),
            operation="delete",
            thread_id="thread-a",
        )


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


def _recorded_thread_start(filename: str) -> dict:
    path = Path(__file__).parent / "fixtures" / "codex-0.162" / filename
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    start = next(record for record in records if record["msg"].get("method") == "thread/start")
    return next(
        record["msg"]["result"]
        for record in records
        if record["conn"] == start["conn"]
        and record["dir"] == "recv"
        and record["msg"].get("id") == start["msg"]["id"]
    )


class _StartedThreadClient:
    def __init__(self, result):
        self.result = result
        self.requests = []

    def request(self, method, params, *, response_model):
        self.requests.append((method, params))
        return response_model.model_validate(self.result)


def test_started_paginated_thread_is_returned_unchanged():
    recorded = _recorded_thread_start("02-thread-start-ce.jsonl")
    started = SimpleNamespace(id=recorded["thread"]["id"])
    client = _StartedThreadClient(recorded)
    codex = SimpleNamespace(_client=client, thread_start=lambda **options: started)

    assert _start_or_resume_codex_thread(codex, None, {}) is started
    assert client.requests == [
        (
            "thread/read",
            {"threadId": "01a1c513-4902-7a92-81fa-3d7461d47839", "includeTurns": False},
        )
    ]


@pytest.mark.parametrize("thread_id", [None, "stale-thread"])
def test_started_legacy_thread_is_refused(thread_id):
    from openai_codex.errors import InvalidRequestError
    from novelvideo.chat.backend_sdk import CodexThreadHistoryModeError

    recorded = _recorded_thread_start("11-legacy-history-thread.jsonl")
    started = SimpleNamespace(id=recorded["thread"]["id"])

    def thread_resume(thread_id, **options):
        raise InvalidRequestError(-32600, f"no rollout found for thread id {thread_id}")

    codex = SimpleNamespace(
        _client=_StartedThreadClient(recorded),
        thread_start=lambda **options: started,
        thread_resume=thread_resume,
    )

    with pytest.raises(CodexThreadHistoryModeError) as exc:
        _start_or_resume_codex_thread(codex, thread_id, {})

    assert str(exc.value) == (
        "Codex thread 01a1c514-0bb5-7850-8835-edda34372703 has history mode legacy; "
        "chat needs a Codex runtime that starts paginated threads (0.162 or newer)"
    )


@pytest.mark.parametrize("client", [None, SimpleNamespace(), SimpleNamespace(request=None)])
def test_start_without_a_callable_low_level_request_is_refused(client):
    from novelvideo.chat.backend_sdk import CodexThreadHistoryModeError

    codex = SimpleNamespace(thread_start=lambda **options: SimpleNamespace(id="thread-1"))
    if client is not None:
        codex._client = client

    with pytest.raises(CodexThreadHistoryModeError) as exc:
        _start_or_resume_codex_thread(codex, None, {})

    assert str(exc.value) == (
        "Codex thread thread-1 has history mode unknown (low-level request unavailable); "
        "chat needs a Codex runtime that starts paginated threads (0.162 or newer)"
    )


def test_missing_rollout_starts_a_replacement_thread():
    from openai_codex.errors import InvalidRequestError

    recorded = _recorded_thread_start("02-thread-start-ce.jsonl")
    replacement = SimpleNamespace(id=recorded["thread"]["id"])

    class FakeCodex:
        _client = _StartedThreadClient(recorded)

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


class _LoadedThreadClient:
    """Low-level App Server client fake recording the refresh sequence."""

    def __init__(self, status: str | None, *, archive_error: Exception | None = None):
        self.status = status
        self.archive_error = archive_error
        self.calls: list[tuple[str, str]] = []

    def thread_read(self, thread_id, include_turns=False):
        from openai_codex.errors import InvalidRequestError

        assert include_turns is False
        self.calls.append(("read", thread_id))
        if self.status is None:
            raise InvalidRequestError(-32600, f"thread not found: {thread_id}")
        status = SimpleNamespace(type=self.status)
        return SimpleNamespace(
            thread=SimpleNamespace(status=SimpleNamespace(root=status))
        )

    def thread_archive(self, thread_id):
        self.calls.append(("archive", thread_id))
        if self.archive_error is not None:
            raise self.archive_error

    def thread_unarchive(self, thread_id):
        self.calls.append(("unarchive", thread_id))


class _LoadedThreadCodex:
    def __init__(self, client):
        self._client = client
        self.calls = client.calls
        self.resumed = object()

    def thread_resume(self, thread_id, **options):
        self.calls.append(("resume", thread_id))
        self.options = options
        return self.resumed

    def thread_start(self, **options):
        raise AssertionError("a persisted thread must be resumed, not replaced")


def test_resume_drops_a_loaded_idle_thread_before_resuming():
    """A loaded thread keeps its MCP env; archive+unarchive forces a cold resume."""

    codex = _LoadedThreadCodex(_LoadedThreadClient("idle"))

    result = _start_or_resume_codex_thread(codex, "thread-1", {"model": "m"})

    assert result is codex.resumed
    assert codex.options == {"model": "m"}
    assert codex.calls == [
        ("read", "thread-1"),
        ("archive", "thread-1"),
        ("unarchive", "thread-1"),
        ("resume", "thread-1"),
    ]


@pytest.mark.parametrize("status", [None, "notLoaded"])
def test_resume_leaves_an_unloaded_thread_alone(status):
    codex = _LoadedThreadCodex(_LoadedThreadClient(status))

    assert _start_or_resume_codex_thread(codex, "thread-1", {}) is codex.resumed
    assert codex.calls == [("read", "thread-1"), ("resume", "thread-1")]


def test_resume_refuses_a_thread_with_a_turn_in_flight():
    from novelvideo.chat.backend_sdk import CodexThreadBusyError

    codex = _LoadedThreadCodex(_LoadedThreadClient("active"))

    with pytest.raises(CodexThreadBusyError, match="turn in flight"):
        _start_or_resume_codex_thread(codex, "thread-1", {})
    assert codex.calls == [("read", "thread-1")]


def test_resume_still_runs_when_the_loaded_thread_cannot_be_dropped(caplog):
    codex = _LoadedThreadCodex(
        _LoadedThreadClient("idle", archive_error=RuntimeError("archive unavailable"))
    )

    with caplog.at_level("WARNING", logger="novelvideo.chat.backend_sdk"):
        assert _start_or_resume_codex_thread(codex, "thread-1", {}) is codex.resumed
    assert codex.calls == [
        ("read", "thread-1"),
        ("archive", "thread-1"),
        ("resume", "thread-1"),
    ]
    assert "tool runtime may be stale" in caplog.text


def test_resume_without_a_low_level_client_keeps_the_plain_path():
    resumed = object()

    class FakeCodex:
        def thread_resume(self, thread_id, **options):
            return resumed

        def thread_start(self, **options):
            raise AssertionError("unexpected replacement")

    assert _start_or_resume_codex_thread(FakeCodex(), "thread-1", {}) is resumed


def test_resume_restores_an_archived_thread_before_retrying():
    """A refresh that archived but failed to unarchive must not strand the thread."""

    from openai_codex.errors import InvalidRequestError

    client = _LoadedThreadClient("notLoaded")
    codex = _LoadedThreadCodex(client)
    attempts = []

    def thread_resume(thread_id, **options):
        attempts.append(thread_id)
        codex.calls.append(("resume", thread_id))
        if len(attempts) == 1:
            raise InvalidRequestError(
                -32600,
                f"session {thread_id} is archived. Run `codex unarchive {thread_id}` first.",
            )
        return codex.resumed

    codex.thread_resume = thread_resume

    assert _start_or_resume_codex_thread(codex, "thread-1", {}) is codex.resumed
    assert codex.calls == [
        ("read", "thread-1"),
        ("resume", "thread-1"),
        ("unarchive", "thread-1"),
        ("resume", "thread-1"),
    ]


@pytest.mark.asyncio
async def test_stream_raises_codex_thread_busy_error_by_type(monkeypatch, tmp_path):
    """The chat route maps the busy error by type, so it must not be flattened."""

    from novelvideo.chat.backend_sdk import CodexThreadBusyError

    @contextmanager
    def fake_shared_codex(_config):
        yield object()

    def busy(*_args, **_kwargs):
        raise CodexThreadBusyError("Codex thread thread-1 still has a turn in flight")

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(
        "novelvideo.chat.backend_sdk._start_or_resume_codex_thread", busy
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
        thread_id="thread-1",
    )

    with pytest.raises(CodexThreadBusyError, match="turn in flight"):
        _ = [event async for event in thread.stream("continue")]


def test_chat_route_maps_busy_thread_onto_the_run_lock_message():
    from novelvideo.api.routes.chat import _chat_turn_busy_message
    from novelvideo.chat.backend_sdk import CodexThreadBusyError
    from novelvideo.chat.session_registry import CHAT_RUN_BUSY_MESSAGE

    assert (
        _chat_turn_busy_message(
            CodexThreadBusyError("thread-1 still has a turn in flight")
        )
        == CHAT_RUN_BUSY_MESSAGE
    )
    assert (
        _chat_turn_busy_message(RuntimeError(CHAT_RUN_BUSY_MESSAGE))
        == CHAT_RUN_BUSY_MESSAGE
    )
    assert _chat_turn_busy_message(RuntimeError("boom")) is None


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


@pytest.mark.parametrize("output_schema", [None, {"type": "object"}])
def test_turn_metadata_is_sent_on_raw_turn_start(output_schema):
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
        output_schema=output_schema,
    )

    assert handle.id == "turn-1"
    assert calls[0][0] == "thread-1"
    if output_schema is None:
        assert calls[0][1] == [{"type": "text", "text": "hello"}]
    else:
        text = calls[0][1][0]["text"]
        assert text.startswith("hello")
        assert "final response" in text
        assert "JSON object" in text
        assert json.dumps(output_schema, ensure_ascii=False) in text
    expected = {
        "responsesapiClientMetadata": {
            "dramaclaw_gateway_api_key": "turn-secret",
            "dramaclaw_control_context_capability": "signed-capability",
        }
    }
    if output_schema is not None:
        expected["outputSchema"] = output_schema
    assert calls[0][2] == expected


def test_output_schema_is_sent_even_without_turn_metadata():
    calls = []

    class FakeClient:
        def turn_start(self, thread_id, input_items, params=None):
            calls.append(params)
            return SimpleNamespace(turn=SimpleNamespace(id="turn-schema"))

    thread = SimpleNamespace(id="thread-schema", _client=FakeClient())
    schema = {"type": "object"}
    assert _start_codex_turn(thread, "hello", {}, schema).id == "turn-schema"
    assert calls == [{"outputSchema": schema}]


@pytest.mark.parametrize("output_schema", [None, {"type": "object"}])
def test_turn_images_follow_the_prompt_as_local_image_paths(output_schema, tmp_path):
    turns = []
    raw_starts = []

    class FakeClient:
        def turn_start(self, thread_id, input_items, params=None):
            raw_starts.append(input_items)
            return SimpleNamespace(turn=SimpleNamespace(id="turn-raw"))

    class FakeThread:
        id = "thread-images"
        _client = FakeClient()

        def turn(self, items):
            turns.append(items)
            return SimpleNamespace(id="turn-facade")

    first = tmp_path / "a.jpg"
    second = tmp_path / "b.jpg"
    _start_codex_turn(
        FakeThread(),
        "hello",
        {},
        output_schema,
        image_paths=[first, second],
    )

    if output_schema is None:
        from openai_codex._inputs import LocalImageInput, TextInput

        assert turns == [
            [
                TextInput("hello"),
                LocalImageInput(str(first)),
                LocalImageInput(str(second)),
            ]
        ]
    else:
        (items,) = raw_starts
        assert items[0]["type"] == "text"
        assert items[1:] == [
            {"type": "localImage", "path": str(first)},
            {"type": "localImage", "path": str(second)},
        ]


def test_gateway_config_disables_codex_native_image_generation():
    overrides = service._codex_gateway_config_overrides("https://gateway.invalid/v1")

    assert "features.image_generation=false" in overrides


def test_codex_149_sdk_exposes_required_runtime_notifications():
    from importlib.metadata import requires

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
    assert "openai-codex-cli-bin==0.149.0" in requires("openai-codex")
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


def _contract_codex_bin() -> Path:
    # Opt-in runtime smoke uses the exact public artifact without replacing the
    # SDK's installed binary. All Responses traffic below goes to a local stub.
    override = os.environ.get("DRAMACLAW_TEST_CODEX_BIN", "").strip()
    if override:
        return Path(override)
    return _integration_codex_binary()


@pytest.mark.parametrize("selection", ["test_override", "configured", "sdk"])
def test_contract_runtime_selection_preserves_both_overrides(
    monkeypatch, tmp_path, selection
):
    test_binary = tmp_path / "test-codex"
    configured_binary = tmp_path / "configured-codex"
    for binary in (test_binary, configured_binary):
        binary.touch()
    monkeypatch.delenv("DRAMACLAW_TEST_CODEX_BIN", raising=False)
    monkeypatch.delenv("CODEX_BIN", raising=False)
    if selection == "sdk":
        with pytest.raises(pytest.skip.Exception, match="paginated.*legacy"):
            _contract_codex_bin()
        return
    monkeypatch.setenv("CODEX_BIN", str(configured_binary))
    if selection == "test_override":
        monkeypatch.setenv("DRAMACLAW_TEST_CODEX_BIN", str(test_binary))
    assert (
        _contract_codex_bin()
        == {
            "test_override": test_binary,
            "configured": configured_binary,
        }[selection]
    )


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
    bundled_catalog = (
        Path(service.__file__).resolve().parents[3]
        / "deploy"
        / "codex"
        / "dramaclaw-model-catalog.json"
    )
    catalog = json.loads(bundled_catalog.read_text(encoding="utf-8"))
    for model in catalog["models"]:
        model["supports_search_tool"] = True
    native_catalog = tmp_path / "native-tool-search-models.json"
    native_catalog.write_text(json.dumps(catalog), encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_CODEX_MODEL_CATALOG_FILE", str(native_catalog))
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
        bundled_codex = _contract_codex_bin()
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
    expected_schema = dramaclaw_mcp._agent_tools()[tool_name][0]
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


@pytest.mark.asyncio
async def test_app_server_default_catalog_exposes_freezone_execution_tools(
    monkeypatch, tmp_path
):
    """Freezone write turns can call their execution entry without a search round."""
    default_catalog = (
        Path(service.__file__).resolve().parents[3]
        / "deploy"
        / "codex"
        / "dramaclaw-model-catalog.json"
    )
    monkeypatch.setenv("DRAMACLAW_CODEX_MODEL_CATALOG_FILE", str(default_catalog))
    scripted_responses = [
        _responses_sse(
            _response_created("response-compat"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": "message-compat",
                    "content": [{"type": "output_text", "text": "兼容模式正常。"}],
                },
            },
            _response_completed("response-compat"),
        )
    ]

    with _recording_responses_gateway(scripted_responses) as (gateway_url, requests):
        bundled_codex = _contract_codex_bin()
        token_file = tmp_path / "turn.token"
        token_file.write_text("contract-test-token", encoding="utf-8")
        token_file.chmod(0o600)
        monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
        env = {
            **os.environ,
            "CODEX_HOME": str(tmp_path / "codex-home"),
            "DRAMACLAW_CODEX_GATEWAY_BASE_URL": gateway_url,
            "DRAMACLAW_PROJECT_ID": "chat-compat-contract",
            "DRAMACLAW_USERNAME": "local",
            "DRAMACLAW_AGENT_TOKEN_FILE": str(token_file),
            "DRAMACLAW_ROOT": str(Path(__file__).resolve().parents[1]),
            "DRAMACLAW_TOOL_MODE": "freezone_canvas",
            "DRAMACLAW_CANVAS_ID": "canvas-a",
            "DRAMACLAW_AGENT_PROFILE": "freezone:main",
            "DRAMACLAW_CHAT_SURFACE": "freezone",
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        execution_prompt = "请执行当前画布里的现有音频节点。"
        mcp_servers = service._dramaclaw_mcp_servers(
            "freezone_canvas", prompt=execution_prompt
        )
        client = backend_sdk.CodexClient(
            codex_bin=bundled_codex,
            cwd=tmp_path,
            env=env,
            model="DC-codex-agent-LLM",
            model_provider="dramaclaw_gateway",
            developer_instructions=service._codex_developer_instructions(
                "freezone_canvas"
            ),
            config_overrides=service._codex_gateway_config_overrides(gateway_url),
            thread_config_overrides=service._codex_mcp_config_overrides(mcp_servers),
            turn_metadata={"dramaclaw_gateway_api_key": "per-turn-contract-key"},
        )

        try:
            events = [
                event async for event in client.thread_start().stream(execution_prompt)
            ]
        finally:
            codex_app_server.stop_shared_codex_runtime()

    assert len(requests) == 1
    tools = requests[0]["body"]["tools"]
    assert not any(tool.get("type") == "tool_search" for tool in tools)
    namespace_names = {
        str(member.get("name") or "")
        for tool in tools
        if tool.get("type") == "namespace"
        for member in tool.get("tools") or []
    }
    expected_execution_tools = {
        "freezone_cancel_canvas_action",
        "freezone_cancel_workflow_run",
        "freezone_confirm_canvas_action",
        "freezone_confirm_workflow_draft",
        "freezone_get_canvas_ontology",
        "freezone_get_node_action_catalog",
        "freezone_get_node_detail",
        "freezone_get_workflow",
        "freezone_observe_workflow_run",
        "freezone_request_user_clarification",
        "freezone_run_node_action",
        "freezone_run_workflow",
        "freezone_update_node_data",
    }
    assert namespace_names == expected_execution_tools
    assert not any(
        tool.get("name") == "mcp__dramaclaw_workflows"
        for tool in tools
        if tool.get("type") == "namespace"
    )
    assert any(
        event.type == "complete" and event.text == "兼容模式正常。" for event in events
    )


@pytest.mark.asyncio
async def test_app_server_exact_node_action_searches_only_batch_write_tool(
    monkeypatch, tmp_path
):
    """Exact node actions discover one atomic update-and-run entry."""
    monkeypatch.delenv("DRAMACLAW_CODEX_MODEL_CATALOG_FILE", raising=False)
    search_call_id = "search-batch-write"
    final_reply = "完成。"
    scripted_responses = [
        _responses_sse(
            _response_created("response-search"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "tool_search_call",
                    "call_id": search_call_id,
                    "execution": "client",
                    "arguments": {
                        "query": "update an existing node and run its exact action in one batch",
                        "limit": 5,
                    },
                },
            },
            _response_completed("response-search"),
        ),
        _responses_sse(
            _response_created("response-final"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": "message-final",
                    "content": [{"type": "output_text", "text": final_reply}],
                },
            },
            _response_completed("response-final"),
        ),
    ]

    with _recording_responses_gateway(scripted_responses) as (gateway_url, requests):
        bundled_codex = _contract_codex_bin()
        token_file = tmp_path / "turn.token"
        token_file.write_text("contract-test-token", encoding="utf-8")
        token_file.chmod(0o600)
        monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
        env = {
            **os.environ,
            "CODEX_HOME": str(tmp_path / "codex-home"),
            "DRAMACLAW_CODEX_GATEWAY_BASE_URL": gateway_url,
            "DRAMACLAW_PROJECT_ID": "focused-search-contract",
            "DRAMACLAW_USERNAME": "local",
            "DRAMACLAW_AGENT_TOKEN_FILE": str(token_file),
            "DRAMACLAW_ROOT": str(Path(__file__).resolve().parents[1]),
            "DRAMACLAW_TOOL_MODE": "freezone_canvas",
            "DRAMACLAW_CANVAS_ID": "canvas-a",
            "DRAMACLAW_AGENT_PROFILE": "freezone:main",
            "DRAMACLAW_CHAT_SURFACE": "freezone",
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        execution_prompt = (
            "请执行当前画布里的现有音频节点，先更新音乐参数，再运行 generate_audio。"
        )
        mcp_servers = service._dramaclaw_mcp_servers(
            "freezone_canvas", prompt=execution_prompt
        )
        client = backend_sdk.CodexClient(
            codex_bin=bundled_codex,
            cwd=tmp_path,
            env=env,
            model="DC-codex-agent-LLM",
            model_provider="dramaclaw_gateway",
            developer_instructions=service._codex_developer_instructions(
                "freezone_canvas"
            ),
            config_overrides=service._codex_gateway_config_overrides(
                gateway_url, native_tool_search=True
            ),
            thread_config_overrides=service._codex_mcp_config_overrides(mcp_servers),
            turn_metadata={"dramaclaw_gateway_api_key": "per-turn-contract-key"},
        )

        try:
            events = [
                event async for event in client.thread_start().stream(execution_prompt)
            ]
        finally:
            codex_app_server.stop_shared_codex_runtime()

    assert len(requests) == 2
    first, second = [request["body"] for request in requests]
    assert any(tool.get("type") == "tool_search" for tool in first["tools"])
    assert not any(tool.get("type") == "namespace" for tool in first["tools"])
    search_output = next(
        item for item in second["input"] if item.get("type") == "tool_search_output"
    )
    assert search_output["call_id"] == search_call_id
    assert [tool["name"] for tool in search_output["tools"]] == ["mcp__dramaclaw"]
    assert [
        tool["name"]
        for namespace in search_output["tools"]
        for tool in namespace["tools"]
    ] == ["freezone_emit_canvas_command"]
    assert any(
        event.type == "complete" and event.text == final_reply for event in events
    )


@pytest.mark.asyncio
async def test_public_patched_runtime_keeps_turn_key_out_of_metadata_and_disk(
    monkeypatch, tmp_path
):
    if not os.environ.get("DRAMACLAW_TEST_CODEX_BIN", "").strip():
        pytest.skip("set DRAMACLAW_TEST_CODEX_BIN to verify a public patched artifact")
    secret = "synthetic-native-runtime-test-key-not-a-real-credential"
    scripted = _responses_sse(
        _response_created("native-runtime-test"),
        {
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": "native-message",
                "content": [{"type": "output_text", "text": "native runtime OK"}],
            },
        },
        _response_completed("native-runtime-test"),
    )
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    with _recording_responses_gateway([scripted]) as (gateway_url, requests):
        client = backend_sdk.CodexClient(
            codex_bin=_contract_codex_bin(),
            cwd=tmp_path,
            env={
                **os.environ,
                "CODEX_HOME": str(tmp_path / "codex-home"),
                "DRAMACLAW_CODEX_GATEWAY_BASE_URL": gateway_url,
            },
            model="DC-codex-agent-LLM",
            model_provider="dramaclaw_gateway",
            developer_instructions="Reply briefly without tools.",
            config_overrides=service._codex_gateway_config_overrides(gateway_url),
            turn_metadata={"dramaclaw_gateway_api_key": secret},
        )
        try:
            events = [event async for event in client.thread_start().stream("Say OK")]
        finally:
            codex_app_server.stop_shared_codex_runtime()
    assert len(requests) == 1
    headers = {key.lower(): value for key, value in requests[0]["headers"].items()}
    assert headers.pop("authorization") == f"Bearer {secret}"
    assert secret not in json.dumps(headers)
    assert secret not in json.dumps(requests[0]["body"])
    assert any(
        event.type == "complete" and event.text == "native runtime OK"
        for event in events
    )
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert (
                secret.encode() not in path.read_bytes()
            ), f"Turn key persisted in {path.name}"


@pytest.mark.asyncio
async def test_public_patched_runtime_sends_context_separately_from_user_message(
    monkeypatch, tmp_path
):
    codex_bin = _contract_codex_bin()
    from novelvideo.chat.codex_protocol import context_entries

    scripted = _responses_sse(
        _response_created("context-turn"),
        {
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": "context-message",
                "content": [{"type": "output_text", "text": "OK"}],
            },
        },
        _response_completed("context-turn"),
    )
    additional_context = {
        **context_entries("dramaclaw-protocol", "PROTOCOL-MARKER-A", kind="application"),
        **context_entries("dramaclaw-execution-context", "EXECUTION-MARKER-B", kind="untrusted"),
    }
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    with _recording_responses_gateway([scripted]) as (gateway_url, requests):
        client = backend_sdk.CodexClient(
            codex_bin=codex_bin,
            cwd=tmp_path,
            env={
                **os.environ,
                "CODEX_HOME": str(tmp_path / "codex-home"),
                "DRAMACLAW_CODEX_GATEWAY_BASE_URL": gateway_url,
            },
            model="DC-codex-agent-LLM",
            model_provider="dramaclaw_gateway",
            developer_instructions="Reply briefly without tools.",
            config_overrides=service._codex_gateway_config_overrides(gateway_url),
            turn_metadata={"dramaclaw_gateway_api_key": "synthetic-context-test-key"},
            additional_context=additional_context,
            client_user_message_id="client-turn-1",
        )
        try:
            events = [event async for event in client.thread_start().stream("Say OK")]
        finally:
            codex_app_server.stop_shared_codex_runtime()
    assert any(event.type == "complete" and event.text == "OK" for event in events)
    assert len(requests) == 1
    messages = requests[0]["body"]["input"]
    text_parts = [
        (message.get("role"), part["text"])
        for message in messages
        for part in message.get("content", [])
        if "text" in part
    ]
    protocol = "<dramaclaw-protocol>PROTOCOL-MARKER-A</dramaclaw-protocol>"
    execution = (
        "<external_dramaclaw-execution-context>"
        "EXECUTION-MARKER-B</external_dramaclaw-execution-context>"
    )
    assert ("developer", protocol) in text_parts, text_parts
    assert ("user", execution) in text_parts, text_parts
    last_user = [message for message in messages if message.get("role") == "user"][-1]
    assert [part["text"] for part in last_user["content"] if "text" in part] == ["Say OK"]
    assert sorted(
        (role, text) for role, text in text_parts
        if "PROTOCOL-MARKER-A" in text or "EXECUTION-MARKER-B" in text
    ) == [("developer", protocol), ("user", execution)], text_parts


@pytest.mark.asyncio
async def test_public_patched_runtime_clear_keeps_thread_without_prior_history(
    monkeypatch, tmp_path
):
    from openai_codex import CodexConfig
    from novelvideo.chat.codex_protocol import ThreadTurnsPage

    codex_bin = _contract_codex_bin()
    scripted = [
        _responses_sse(
            _response_created(f"clear-turn-{index}"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": f"clear-message-{index}",
                    "content": [{"type": "output_text", "text": reply}],
                },
            },
            _response_completed(f"clear-turn-{index}"),
        )
        for index, reply in enumerate(["ONE-MARKER", "TWO-MARKER", "THREE"], 1)
    ]
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    with _recording_responses_gateway(scripted) as (gateway_url, requests):
        env = {
            **os.environ,
            "CODEX_HOME": str(tmp_path / "codex-home"),
            "DRAMACLAW_CODEX_GATEWAY_BASE_URL": gateway_url,
        }
        overrides = service._codex_gateway_config_overrides(gateway_url)
        client = backend_sdk.CodexClient(
            codex_bin=codex_bin,
            cwd=tmp_path,
            env=env,
            model="DC-codex-agent-LLM",
            model_provider="dramaclaw_gateway",
            developer_instructions="Reply briefly without tools.",
            config_overrides=overrides,
            turn_metadata={"dramaclaw_gateway_api_key": "synthetic-clear-test-key"},
        )
        config = CodexConfig(
            codex_bin=str(codex_bin), cwd=str(tmp_path), env=env, config_overrides=overrides
        )
        try:
            first = [event async for event in client.thread_start().stream("Say ONE-MARKER")]
            thread_id = next(event.thread_id for event in first if event.type == "thread_started")
            assert any(event.type == "complete" and event.text == "ONE-MARKER" for event in first)
            second = [
                event async for event in client.thread_resume(thread_id).stream("Say TWO-MARKER")
            ]
            assert any(event.type == "complete" and event.text == "TWO-MARKER" for event in second)
            assert backend_sdk.clear_codex_thread_history(
                codex_bin=codex_bin, cwd=tmp_path, env=env,
                config_overrides=overrides, thread_id=thread_id,
            ) == "reverted"
            with codex_app_server.shared_codex(config) as codex:
                page = codex._client.request(
                    "thread/turns/list", {"threadId": thread_id}, response_model=ThreadTurnsPage
                )
            assert page.data == []
            third = [
                event async for event in client.thread_resume(thread_id).stream("Say THREE")
            ]
            assert any(
                event.type == "complete" and event.text == "THREE" and event.thread_id == thread_id
                for event in third
            )
        finally:
            codex_app_server.stop_shared_codex_runtime()
    assert len(requests) == 3
    body = requests[2]["body"]

    def text_parts(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "text" and isinstance(item, str):
                    yield item
                else:
                    yield from text_parts(item)
        elif isinstance(value, list):
            for item in value:
                yield from text_parts(item)

    assert all(
        "ONE-MARKER" not in text and "TWO-MARKER" not in text for text in text_parts(body)
    )
    last_user = [message for message in body["input"] if message.get("role") == "user"][-1]
    assert [part["text"] for part in last_user["content"] if "text" in part] == ["Say THREE"]


@pytest.mark.asyncio
async def test_app_server_keeps_turn_images_as_file_paths_in_thread_history(
    monkeypatch, tmp_path
):
    from openai_codex import CodexConfig
    from PIL import Image

    from novelvideo.chat.turn_images import turn_image_files

    source = tmp_path / "output" / "projects" / "demo" / "shot.png"
    source.parent.mkdir(parents=True)
    Image.new("RGB", (2000, 1000), (40, 90, 160)).save(source)
    (turn_image,) = await turn_image_files([source], tmp_path / "output")
    scripted = _responses_sse(
        _response_created("image-turn"),
        {
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": "image-message",
                "content": [{"type": "output_text", "text": "看到了。"}],
            },
        },
        _response_completed("image-turn"),
    )
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    with _recording_responses_gateway([scripted]) as (gateway_url, requests):
        codex_bin = _contract_codex_bin()
        env = {
            **os.environ,
            "CODEX_HOME": str(tmp_path / "codex-home"),
            "DRAMACLAW_CODEX_GATEWAY_BASE_URL": gateway_url,
        }
        overrides = service._codex_gateway_config_overrides(gateway_url)
        client = backend_sdk.CodexClient(
            codex_bin=codex_bin,
            cwd=tmp_path,
            env=env,
            model="DC-codex-agent-LLM",
            model_provider="dramaclaw_gateway",
            developer_instructions="Reply briefly without tools.",
            config_overrides=overrides,
            turn_metadata={"dramaclaw_gateway_api_key": "image-turn-key"},
        )
        thread = client.thread_start()
        try:
            events = [
                event async for event in thread.stream("看这张", image_paths=[turn_image])
            ]
            config = CodexConfig(
                codex_bin=str(codex_bin),
                cwd=str(tmp_path),
                env=env,
                config_overrides=overrides,
            )
            with codex_app_server.shared_codex(config) as codex:
                stored = codex._client.thread_read(thread.id, include_turns=True)
        finally:
            codex_app_server.stop_shared_codex_runtime()

    assert any(event.type == "complete" and event.text == "看到了。" for event in events)
    # Codex encodes the file for the model request; that is transport only.
    (request,) = requests
    request_images = [
        part
        for item in request["body"]["input"]
        if item.get("role") == "user"
        for part in item.get("content", [])
        if part.get("type") == "input_image"
    ]
    assert len(request_images) == 1
    assert request_images[0]["image_url"].startswith("data:image/jpeg;base64,")
    # The thread history keeps the file path and never the encoded image.
    turns = stored.thread.model_dump(mode="json", by_alias=True)["turns"]
    user_items = [item for turn in turns for item in turn["items"] if item["type"] == "userMessage"]
    assert [item["content"] for item in user_items] == [
        [
            {"type": "text", "text": "看这张", "text_elements": []},
            {"type": "localImage", "path": str(turn_image), "detail": None},
        ]
    ]
    assert "data:" not in json.dumps(turns)


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

    bundled_codex = _integration_codex_binary()
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


@pytest.mark.parametrize("params", [None, {"input": "do-not-log"}])
@pytest.mark.parametrize(
    ("method", "expected"),
    [
        ("item/permissions/requestApproval", {"permissions": {}, "scope": "turn"}),
        (
            "mcpServer/elicitation/request",
            {"action": "decline", "content": None, "_meta": None},
        ),
        ("item/tool/requestUserInput", {"answers": {}}),
        (
            "item/tool/call",
            {
                "contentItems": [
                    {
                        "type": "inputText",
                        "text": "DramaClaw does not run client-side dynamic tools.",
                    }
                ],
                "success": False,
            },
        ),
        ("unknown/request", {}),
    ],
)
def test_codex_native_approval_handler_fails_closed(method, params, expected):
    assert codex_app_server._refuse_server_request(method, params) == expected


def test_codex_server_request_refusals_are_logged_and_counted(caplog):
    before = metrics_snapshot()
    with caplog.at_level(logging.WARNING, logger=codex_app_server.__name__):
        codex_app_server._refuse_server_request(
            "item/permissions/requestApproval", {"input": "do-not-log"}
        )
        codex_app_server._refuse_server_request("vendor/secret", {"input": "do-not-log"})
    after = metrics_snapshot()

    listed_key = "codex_server_request_refused.item/permissions/requestApproval"
    unlisted_key = "codex_server_request_refused.unlisted"
    assert after.get(listed_key, 0) - before.get(listed_key, 0) == 1
    assert after.get(unlisted_key, 0) - before.get(unlisted_key, 0) == 1
    secret_key = "codex_server_request_refused.vendor/secret"
    assert after.get(secret_key, 0) - before.get(secret_key, 0) == 0
    records = [record for record in caplog.records if record.name == codex_app_server.__name__]
    assert [record.getMessage() for record in records] == [
        "codex_server_request_refused method=item/permissions/requestApproval listed=true",
        "codex_server_request_refused method=vendor/secret listed=false",
    ]
    assert all(record.levelno == logging.WARNING for record in records)
    assert all("do-not-log" not in str(record.__dict__) for record in caplog.records)


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
        "item_delta",
        "thought_delta",
        "item_started",
        "tool_started",
        "tool_updated",
        "usage_update",
        "item_completed",
        "tool_updated",
        "item_delta",
        "assistant_delta",
        "turn_completed",
        "egress_disposition",
        "complete",
    ]
    assert [
        (event.item_id, event.name, event.summary_index)
        for event in events
        if event.type == "item_delta"
    ] == [("reasoning-1", "reasoning", 0), ("message-1", "text", None)]
    assert [event.item_id for event in events if event.type == "item_started"] == ["call-1"]
    assert [event.item_id for event in events if event.type == "item_completed"] == ["call-1"]
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
async def test_codex_stream_cancellation_detaches_without_interrupt(monkeypatch, tmp_path):
    from openai_codex import TurnHandle

    requests = []
    closed = threading.Event()
    streaming = asyncio.Event()

    class FakeClient:
        def register_turn_notifications(self, turn_id):
            pass

        def unregister_turn_notifications(self, turn_id):
            pass

        def next_turn_notification(self, turn_id):
            closed.wait(timeout=0.25)
            raise RuntimeError("app-server closed stdout")

        def turn_interrupt(self, thread_id, turn_id):
            requests.append(("turn/interrupt", {"threadId": thread_id, "turnId": turn_id}))

        def close(self):
            closed.set()

    client = FakeClient()

    @contextmanager
    def fake_shared_codex(_config):
        yield SimpleNamespace(_client=client)

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(
        backend_sdk,
        "_start_or_resume_codex_thread",
        lambda *args, **kwargs: SimpleNamespace(id="thread-detach"),
    )
    monkeypatch.setattr(
        backend_sdk,
        "_start_codex_turn",
        lambda *args, **kwargs: TurnHandle(client, "thread-detach", "turn-detach"),
    )
    monkeypatch.setattr(backend_sdk, "CODEX_INTERRUPT_GRACE_TIMEOUT", 0.5)
    thread = CodexThread(
        codex_bin=None,
        cwd=tmp_path,
        env={},
        model="fake-model",
        model_provider="fake-provider",
        developer_instructions="",
        config_overrides=(),
        thread_config={},
        turn_metadata={},
        thread_id=None,
    )

    async def consume():
        async for event in thread.stream("hello"):
            if event.type == "thread_started":
                streaming.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(streaming.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=0.5)

    assert requests == []
    assert closed.is_set() is True


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
@pytest.mark.parametrize(
    ("tool_name", "tool_delay", "expected_disposition", "progress_delay"),
    [
        ("freezone_finish_agent_catalog_draft", 0.4, "completed", None),
        ("freezone_create_node", 0.12, "completed", None),
        ("freezone_create_node", 0.55, "timeout", None),
        pytest.param(
            "freezone_create_node", 0.14, "completed", 0.12,
            id="canvas-deadline-must-not-shorten-later-idle-window",
        ),
    ],
)
async def test_codex_stream_tool_wait_deadlines(
    monkeypatch, tmp_path, tool_name, tool_delay, expected_disposition, progress_delay
):
    from openai_codex.generated import v2_all as v2
    from openai_codex.models import Notification

    delay = threading.Event()
    interrupt_calls = []
    started_tool = {
        "type": "mcpToolCall",
        "id": "call-confirm",
        "server": "dramaclaw",
        "tool": tool_name,
        "arguments": {"skill_studio_session_id": "studio-1"},
        "status": "inProgress",
    }
    completed_tool = {
        **started_tool,
        "status": "completed",
        "result": {
            "content": [{"type": "text", "text": "confirmed"}],
            "structuredContent": {
                "status": "skill_studio_frontend_result",
                "action": "confirm",
            },
        },
    }

    class FakeTurn:
        id = "turn-confirm"

        def stream(self):
            yield Notification(
                method="turn/started",
                payload=v2.TurnStartedNotification.model_validate(
                    {
                        "threadId": "thread-confirm",
                        "turn": {
                            "id": self.id,
                            "items": [],
                            "status": "inProgress",
                        },
                    }
                ),
            )
            yield Notification(
                method="item/started",
                payload=v2.ItemStartedNotification.model_validate(
                    {
                        "threadId": "thread-confirm",
                        "turnId": self.id,
                        "startedAtMs": 1,
                        "item": started_tool,
                    }
                ),
            )
            if progress_delay is not None:
                delay.wait(timeout=progress_delay)
                yield Notification(
                    method="item/reasoning/summaryTextDelta",
                    payload=v2.ReasoningSummaryTextDeltaNotification.model_validate({
                        "threadId": "thread-confirm", "turnId": self.id,
                        "itemId": "reasoning-confirm", "delta": "Still working",
                        "summaryIndex": 0,
                    }),
                )
            delay.wait(timeout=tool_delay)
            yield Notification(
                method="item/completed",
                payload=v2.ItemCompletedNotification.model_validate(
                    {
                        "threadId": "thread-confirm",
                        "turnId": self.id,
                        "completedAtMs": 2,
                        "item": completed_tool,
                    }
                ),
            )
            yield Notification(
                method="item/agentMessage/delta",
                payload=v2.AgentMessageDeltaNotification.model_validate(
                    {
                        "threadId": "thread-confirm",
                        "turnId": self.id,
                        "itemId": "message-confirm",
                        "delta": "已确认",
                    }
                ),
            )
            yield Notification(
                method="turn/completed",
                payload=v2.TurnCompletedNotification.model_validate(
                    {
                        "threadId": "thread-confirm",
                        "turn": {
                            "id": self.id,
                            "items": [],
                            "status": "completed",
                        },
                    }
                ),
            )

        def interrupt(self):
            interrupt_calls.append(self.id)
            delay.set()

    class FakeThread:
        id = "thread-confirm"

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
        backend_sdk, "_start_codex_turn", lambda *_args, **_kwargs: FakeTurn()
    )
    monkeypatch.setattr(backend_sdk, "CODEX_STREAM_FIRST_PROGRESS_TIMEOUT", 1.0)
    monkeypatch.setattr(
        backend_sdk, "CODEX_STREAM_IDLE_TIMEOUT", 0.18 if progress_delay is not None else 0.03
    )

    monkeypatch.setattr(
        backend_sdk, "canvas_command_result_timeout_seconds",
        lambda: 0.15 if progress_delay is not None else 0.2, raising=False,
    )
    monkeypatch.setattr(
        backend_sdk, "CANVAS_COMMAND_TIMEOUT_MARGIN_SECONDS",
        0.05 if progress_delay is not None else 0.1, raising=False,
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
    events = [event async for event in thread.stream("Create a skill")]

    assert events[-1].type == "complete"
    assert events[-2].disposition == expected_disposition
    if expected_disposition == "completed":
        assert events[-1].text == "已确认"
        assert interrupt_calls == []
    else:
        assert events[-1].disposition == "timeout"
        assert events[-3].error["kind"] == "idle"
        assert events[-3].error["elapsed_ms"] >= 250
        assert interrupt_calls == ["turn-confirm"]

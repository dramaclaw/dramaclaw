from pathlib import Path
from contextlib import contextmanager
import sqlite3
from types import SimpleNamespace

import pytest

from novelvideo.chat import codex_app_server
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

    assert control_codex_runtime(
        **common, operation="interrupt", turn_id="turn-a"
    )
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
                r'client-metadata: {\"dramaclaw_gateway_api_key\":\"gateway-secret\",'
                r'\"dramaclaw_control_context_capability\":\"capability-secret\"}',
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
    assert socket_path.parent == control_dir
    assert socket_path.suffix == ".sock"
    assert len(socket_path.name) < 32


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
        ("model_providers.dramaclaw_gateway.wire_api=\"responses\"",),
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
            raise AssertionError("must not replace a valid thread on configuration errors")

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
    assert all(hasattr(Codex, name) for name in ("metadata", "thread_start", "thread_resume"))
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

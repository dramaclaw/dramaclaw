"""Timeout diagnostics through the real adapter, mapper and public WebSocket route."""

import asyncio
from contextlib import asynccontextmanager, contextmanager
import socket
import threading
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import chat as routes
from novelvideo.chat import backend_sdk, codex_app_server, runtime_event_mapper
from novelvideo.chat.backend_sdk import CodexThread
from novelvideo.chat.store import ChatScope


@pytest.mark.parametrize(
    ("phase", "elapsed_ms", "expire_before_wait"),
    [
        ("first-progress", 300625, False),
        ("first-progress", 300625, True),
        ("idle", 301875, False),
        ("total", 1800625, False),
        ("user-input", 1800625, False),
    ],
)
async def test_timeout_elapsed_reaches_public_terminal_event(
    monkeypatch, tmp_path, phase, elapsed_ms, expire_before_wait
):
    from openai_codex.generated import v2_all as v2
    from openai_codex.models import Notification

    def no_network(*args, **kwargs):
        raise AssertionError("network forbidden in timeout diagnostic tests")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    released = threading.Event()
    interrupt_calls = []
    clock = SimpleNamespace(now=10000.0)
    started_at = clock.now
    real_loop = asyncio.get_running_loop()
    notifications = [
        Notification(
            method="turn/started",
            payload=v2.TurnStartedNotification.model_validate(
                {
                    "threadId": "thread-timeout",
                    "turn": {"id": "turn-timeout", "items": [], "status": "inProgress"},
                }
            ),
        )
    ]
    if phase in {"idle", "total"}:
        notifications.append(
            Notification(
                method="item/agentMessage/delta",
                payload=v2.AgentMessageDeltaNotification.model_validate(
                    {
                        "threadId": "thread-timeout",
                        "turnId": "turn-timeout",
                        "itemId": "message-timeout",
                        "delta": "working",
                    }
                ),
            )
        )
    elif phase == "user-input":
        notifications.append(
            Notification(
                method="item/started",
                payload=v2.ItemStartedNotification.model_validate(
                    {
                        "threadId": "thread-timeout",
                        "turnId": "turn-timeout",
                        "startedAtMs": 1,
                        "item": {
                            "type": "mcpToolCall",
                            "id": "call-confirm",
                            "server": "dramaclaw",
                            "tool": "freezone_request_user_clarification",
                            "arguments": {},
                            "status": "inProgress",
                        },
                    }
                ),
            )
        )

    class FakeTurn:
        id = "turn-timeout"

        def stream(self):
            yield from notifications
            if not released.wait(timeout=2):
                raise AssertionError("timeout must interrupt the fake turn")

        def interrupt(self):
            interrupt_calls.append(self.id)
            # Cleanup latency must not change the elapsed time at timeout detection.
            clock.now += 17
            released.set()

    @contextmanager
    def fake_shared_codex(_config):
        yield object()

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(
        backend_sdk,
        "_start_or_resume_codex_thread",
        lambda *args, **kwargs: SimpleNamespace(id="thread-timeout"),
    )
    monkeypatch.setattr(backend_sdk, "_start_codex_turn", lambda *a, **kw: FakeTurn())
    reads = 0
    event_count = 2 + len(notifications)  # thread_started + egress_submitted

    async def controlled_wait_for(awaitable, *, timeout):
        nonlocal reads
        if getattr(awaitable, "cr_code", None) is not asyncio.Queue.get.__code__:
            return await asyncio.wait_for(awaitable, timeout=timeout)
        if reads == event_count:
            awaitable.close()
            clock.now = started_at + elapsed_ms / 1000
            raise asyncio.TimeoutError
        result = await asyncio.wait_for(awaitable, timeout=2)
        reads += 1
        clock.now += 0.125
        if expire_before_wait and reads == event_count:
            clock.now = started_at + elapsed_ms / 1000
        return result

    # Replace only the adapter's view of asyncio; the real event loop keeps its clock.
    adapter_asyncio = SimpleNamespace(**vars(asyncio))
    adapter_asyncio.get_running_loop = lambda: SimpleNamespace(
        time=lambda: clock.now, call_soon_threadsafe=real_loop.call_soon_threadsafe
    )
    adapter_asyncio.wait_for = controlled_wait_for
    with monkeypatch.context() as adapter_patch:
        adapter_patch.setattr(backend_sdk, "asyncio", adapter_asyncio)
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
        events = [event async for event in thread.stream("diagnostic only")]

    assert interrupt_calls == ["turn-timeout"]
    assert ("thread-timeout", "turn-timeout") not in backend_sdk._LIVE_CODEX_TURNS
    assert (
        "thread-timeout",
        "turn-timeout",
    ) not in backend_sdk._INTERRUPTED_CODEX_TURNS
    terminal, disposition, complete = events[-3:]
    assert [event.type for event in events[-3:]] == [
        "turn_completed",
        "egress_disposition",
        "complete",
    ]
    assert terminal.status == "timeout"
    assert terminal.error["kind"] == phase
    assert terminal.error["elapsed_ms"] == elapsed_ms
    assert isinstance(terminal.error["elapsed_ms"], int)
    assert complete.error == terminal.error
    assert (
        terminal.disposition
        == disposition.disposition
        == complete.disposition
        == "timeout"
    )

    frames = []

    @asynccontextmanager
    async def fake_egress(**kwargs):
        yield None

    async def never(*args, **kwargs):
        await asyncio.Future()

    async def fake_context(*args):
        return SimpleNamespace(
            output_dir=tmp_path / "out",
            state_dir=tmp_path / "state",
            requester_user_id="user-local",
            project_id="project-local",
        )

    async def fake_stream(username, project, text, on_event, **kwargs):
        # Match service's existing lifecycle mapping, without starting a runtime or DB.
        await on_event(runtime_event_mapper.lifecycle_event(terminal))
        await on_event(
            {
                "type": "done",
                "message": {
                    "role": "assistant",
                    "content": complete.text,
                },
            }
        )

    class WebSocket:
        async def send_json(self, payload):
            frames.append(payload)

    monkeypatch.setattr(routes, "_project_context_for_scope", fake_context)
    monkeypatch.setattr(routes, "request_egress_scope", fake_egress)
    monkeypatch.setattr(
        routes.AgentExecutionContext,
        "from_project_scope",
        lambda **kwargs: SimpleNamespace(agent_profile="freezone:main"),
    )
    monkeypatch.setattr(routes.chat_service, "add_user_message", lambda *a, **kw: None)
    monkeypatch.setattr(routes.chat_service, "get_chat_backend_name", lambda: "codex")
    monkeypatch.setattr(routes.chat_service, "stream_assistant_reply", fake_stream)
    for name in (
        "_chat_heartbeat",
        "_interrupt_agent_on_disconnect",
        "_receive_bridge_results_during_turn",
        "_watch_pending_canvas_commands",
        "_watch_pending_canvas_context_requests",
        "_watch_pending_skill_studio_events",
        "_watch_pending_clarification_events",
    ):
        monkeypatch.setattr(routes, name, never)
    scope = ChatScope(
        kind="project", id="project-local", surface="freezone", canvas_id="canvas-local"
    )
    await routes._stream_project_turn(
        websocket=WebSocket(),
        user={"username": "user-local"},
        username="user-local",
        scope=scope,
        text="diagnostic only",
        attachments=[],
        turn_id="business-local",
        surface="freezone",
    )
    public_terminal = [
        frame for frame in frames if frame["type"] == "agent.turn.completed"
    ]
    assert public_terminal == [
        {
            "type": "agent.turn.completed",
            "scope": scope.to_dict(),
            "thread_id": "thread-timeout",
            "turn_id": "turn-timeout",
            "status": "timeout",
            "disposition": "timeout",
            "error": terminal.error,
        }
    ]
    assert public_terminal[0]["error"]["elapsed_ms"] == elapsed_ms
    assert frames[-1]["type"] == "chat.done"

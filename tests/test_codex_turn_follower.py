"""Reconnect to a persisted Codex turn without taking ownership of it."""

import asyncio
import json
import threading
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import httpx
from fastapi import FastAPI
from openai_codex.client import CodexClient as ProtocolClient

from novelvideo.api.routes import chat as routes
from novelvideo.chat import backend_sdk, codex_app_server, service
from novelvideo.chat.runtime_port import ChatBackendEvent
from novelvideo.chat.store import ChatScope, chat_store


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setattr(service, "_codex_thread_runtime_options", lambda: {})
    monkeypatch.setattr(service, "complete_pending_drain", lambda _: None)
    monkeypatch.setattr(service, "get_chat_backend_name", lambda: "codex")
    monkeypatch.setattr(service, "get_auth_session_port", lambda: SimpleNamespace(
        revoke_agent_session=AsyncMock(return_value=True),
    ))
    return ChatScope(kind="home")


def persist(scope, **extra):
    freezone = scope.kind == "freezone" or scope.surface == "freezone"
    profile = f"freezone:{scope.agent_id or 'main'}" if freezone else "main"
    key = service._codex_scope_key(
        str(scope.id or ""), agent_profile=profile, canvas_id=scope.canvas_id,
    )
    entry = {
        "thread_id": "thread-1", "turn_id": "turn-1", "business_turn_id": "business-1",
        "lock_key": service._chat_run_lock_key(service._chat_run_lock_project_for_turn(
            str(scope.id or ""), tool_mode="freezone_canvas" if freezone else "default",
            store_scope=scope,
        )), "started_at": 123.0,
        "token_file": None, "store_scope": scope.to_dict(), "agent_profile": profile,
        **extra,
    }
    service._set_active_codex_turn("test-user", key, entry)
    return key


def install_transport(monkeypatch, events):
    async def transport(**kwargs):
        assert kwargs == {"thread_id": "thread-1", "turn_id": "turn-1"}
        for event in events:
            yield event
    monkeypatch.setattr(service, "follow_codex_turn", transport, raising=False)


@pytest.mark.asyncio
async def test_no_entry_and_other_scope_entry_are_not_followed(runtime, monkeypatch):
    async def forbidden(**kwargs):
        pytest.fail("another scope's turn was followed")
        yield
    monkeypatch.setattr(service, "follow_codex_turn", forbidden, raising=False)
    frames = []
    async def emit(frame):
        frames.append(frame)
    assert await service.follow_active_codex_turn("test-user", runtime, emit) is False
    persist(ChatScope(kind="project", id="other"))
    assert await service.follow_active_codex_turn("test-user", runtime, emit) is False
    assert frames == []


@pytest.mark.asyncio
async def test_gap_items_then_live_frames_and_final_message(runtime, monkeypatch):
    persist(runtime)
    install_transport(monkeypatch, [
        ChatBackendEvent(type="turn_started", turn_id="turn-1", status="inProgress"),
        ChatBackendEvent(type="item_completed", item={
            "type": "agentMessage", "id": "gap", "text": "Earlier",
        }),
        ChatBackendEvent(type="item_started", item={
            "type": "agentMessage", "id": "live", "text": "",
        }),
        ChatBackendEvent(type="item_delta", item_id="live", name="text", text="Hello"),
        ChatBackendEvent(type="item_completed", item={
            "type": "agentMessage", "id": "live", "text": "Hello",
        }),
        ChatBackendEvent(type="plan_update", entries=[{"step": "Check", "status": "completed"}]),
        ChatBackendEvent(type="usage_update", usage={"total": 12}),
        ChatBackendEvent(type="tool_updated", name="echo_text", call_id="tool-1",
                         status="completed", text="OK"),
        ChatBackendEvent(type="turn_completed", status="completed", disposition="completed"),
    ])
    frames = []
    async def emit(frame):
        frames.append(frame)
    assert await service.follow_active_codex_turn("test-user", runtime, emit) is True
    assert [f["type"] for f in frames] == [
        "turn_started", "item", "item", "item_delta", "item", "plan_update",
        "usage_update", "tool_updated", "turn_completed", "done",
    ]
    assert [(f["item_id"], f["message_id"]) for f in frames if "item_id" in f] == [
        ("gap", "assistant:turn-1"), ("live", "assistant:turn-1"),
        ("live", "assistant:turn-1"), ("live", "assistant:turn-1"),
    ]
    assert frames[3]["text"] == "Hello"
    assert frames[-1] == {
        "type": "done", "turn_id": "business-1", "message": None,
    }
    assert service._load_active_codex_turns("test-user") == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("status,disposition", [
    ("completed", "completed"),
    ("interrupted", "cancelled"),
    ("failed", "failed"),
    ("interrupted", "interrupted"),
])
async def test_already_terminal(runtime, monkeypatch, status, disposition):
    persist(runtime)
    install_transport(monkeypatch, [ChatBackendEvent(
        type="turn_completed", status=status, disposition=disposition,
    )])
    frames = []
    async def emit(frame):
        frames.append(frame)
    assert await service.follow_active_codex_turn("test-user", runtime, emit) is True
    assert [f["type"] for f in frames] == ["turn_completed", "done"]
    assert frames[-1] == {"type": "done", "turn_id": "business-1", "message": None}
    assert service._load_active_codex_turns("test-user") == {}
    assert [m["content"] for m in chat_store.list_messages("test-user", runtime)] == (
        ["本轮请求已中断。"] if disposition == "interrupted" else []
    )


@pytest.mark.asyncio
async def test_attach_failure_finalizes_interrupted(runtime, monkeypatch):
    persist(runtime)
    async def missing(**kwargs):
        raise codex_app_server.CodexAppServerNotRunning("Codex app-server is not running")
        yield
    monkeypatch.setattr(service, "follow_codex_turn", missing, raising=False)
    frames = []
    async def emit(frame):
        frames.append(frame)
    assert await service.follow_active_codex_turn("test-user", runtime, emit) is True
    assert frames[-1] == {"type": "done", "turn_id": "business-1", "message": None}
    assert service._load_active_codex_turns("test-user") == {}
    assert [m["content"] for m in chat_store.list_messages("test-user", runtime)] == [
        "本轮请求已中断。",
    ]


@pytest.mark.asyncio
async def test_cancel_follower_keeps_entry_and_sends_no_finish_frames(runtime, monkeypatch):
    key = persist(runtime)
    ready, closed = asyncio.Event(), asyncio.Event()
    async def transport(**kwargs):
        try:
            yield ChatBackendEvent(type="item_started", item={
                "type": "agentMessage", "id": "live", "text": "",
            })
            ready.set()
            await asyncio.Event().wait()
        finally:
            closed.set()
    def forbidden(*args, **kwargs):
        pytest.fail("stopping a follower must not interrupt")
    monkeypatch.setattr(service, "follow_codex_turn", transport, raising=False)
    monkeypatch.setattr(service, "_control_codex_thread", forbidden)
    frames = []
    async def emit(frame):
        frames.append(frame)
    task = asyncio.create_task(service.follow_active_codex_turn("test-user", runtime, emit))
    await asyncio.wait_for(ready.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()
    assert [f["type"] for f in frames] == ["item"]
    assert service._load_active_codex_turns("test-user")[key]["turn_id"] == "turn-1"


@pytest.mark.asyncio
async def test_timeout_uses_claimed_entry(runtime, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CODEX_TURN_MAX_SECONDS", "3600")
    key = persist(runtime)
    async def transport(**kwargs):
        yield ChatBackendEvent(type="turn_started", status="inProgress")
        entry = service._load_active_codex_turns("test-user")[key]
        service._set_active_codex_turn("test-user", key, {**entry, "timeout_reason": "max_age"})
        yield ChatBackendEvent(type="turn_completed", status="interrupted", disposition="cancelled")
    monkeypatch.setattr(service, "follow_codex_turn", transport, raising=False)
    frames = []
    async def emit(frame):
        frames.append(frame)
    await service.follow_active_codex_turn("test-user", runtime, emit)
    assert frames[-1] == {"type": "done", "turn_id": "business-1", "message": None}
    assert service._load_active_codex_turns("test-user") == {}
    assert [m["content"] for m in chat_store.list_messages("test-user", runtime)] == [
        "本轮请求超过最长 60 分钟，已停止。",
    ]


class FixtureClient(ProtocolClient):
    """Replay the second connection, including notifications interleaved with RPC replies."""

    def __init__(self):
        super().__init__()
        path = (
            Path(__file__).parent / "fixtures/codex-0.162"
            / "08-thread-b-tools-reasoning-inflight-resume.jsonl"
        )
        self.rows = iter(json.loads(line) for line in path.read_text().splitlines()
                         if json.loads(line)["conn"] == "c4" and json.loads(line)["seq"] >= 195)
        self.requests = []
        self.closed = False

    def request(self, method, params, *, response_model):
        self.requests.append((method, params))
        sent = next(self.rows)
        assert sent["dir"] == "send"
        assert sent["msg"]["method"] == method
        assert sent["msg"]["params"] == params
        for row in self.rows:
            msg = row["msg"]
            if "method" in msg:
                self._router.route_notification(
                    self._coerce_notification(msg["method"], msg["params"])
                )
            elif msg.get("id") == sent["msg"]["id"]:
                return response_model.model_validate(msg["result"])
        pytest.fail("missing recorded reply")

    def next_turn_notification(self, turn_id):
        # Feed remaining notifications once the snapshot RPCs have returned.
        for row in self.rows:
            msg = row["msg"]
            if row["dir"] == "recv" and "method" in msg and "id" not in msg:
                self._router.route_notification(
                    self._coerce_notification(msg["method"], msg["params"])
                )
        return super().next_turn_notification(turn_id)

    def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_real_follower_replays_second_connection(monkeypatch, tmp_path):
    client = FixtureClient()
    @contextmanager
    def attach(config):
        try:
            yield SimpleNamespace(_client=client)
        finally:
            client.close()
    def forbidden(*args, **kwargs):
        pytest.fail("follower must only attach")
    monkeypatch.setattr(codex_app_server, "attach_shared_codex", attach)
    monkeypatch.setattr(codex_app_server, "shared_codex", forbidden)
    events = [event async for event in backend_sdk.follow_codex_turn(
        codex_bin=None, cwd=tmp_path, env={}, config_overrides=(),
        thread_id="01a1c513-9aae-7512-9f52-510de9a0715d",
        turn_id="01a1c513-9ad9-75e0-bf99-4ff3d12fff7b",
    )]
    assert [(e.type, e.item_id) for e in events[:3]] == [
        ("turn_started", None),
        ("item_completed", "01a1c513-9add-7ba3-b21b-7daa266ac87f"),
        ("item_completed", "call_81ab3db0133441cdb97eac18"),
    ]
    assert events[-1].type == "turn_completed"
    assert events[-1].status == "completed"
    final = next(
        e.item for e in events
        if e.type == "item_completed" and e.item["type"] == "agentMessage"
    )
    assert final["text"] == "Shell output: `fixture-shell-ok`; echo_text output: `fixture-mcp-ok`."
    assert not {"egress_submitted", "egress_disposition"} & {e.type for e in events}
    assert client.closed


class Socket:
    client = None
    def __init__(self):
        self.frames = asyncio.Queue()
        self.pending = []
        self.incoming = asyncio.Queue()
        self.sending = False
    async def accept(self):
        pass
    async def send_json(self, payload):
        assert not self.sending, "overlapping websocket sends"
        self.sending = True
        await asyncio.sleep(0)
        self.frames.put_nowait(payload)
        self.sending = False
    async def receive_json(self):
        value = await self.incoming.get()
        if value is None:
            from starlette.websockets import WebSocketDisconnect
            raise WebSocketDisconnect()
        return value
    async def receive(self):
        return {"type": "websocket.receive", "text": json.dumps(await self.receive_json())}
    async def frame(self, kind):
        for index, frame in enumerate(self.pending):
            if frame["type"] == kind:
                return self.pending.pop(index)
        async with asyncio.timeout(2):
            while True:
                frame = await self.frames.get()
                if frame["type"] == kind:
                    return frame
                self.pending.append(frame)


@pytest.mark.asyncio
@pytest.mark.parametrize("action", [
    "complete", "switch", "cancel", "busy", "disconnect", "bridge", "finish_race", "history",
])
async def test_websocket_follows_persisted_turn(runtime, monkeypatch, tmp_path, action):
    if action == "bridge":
        runtime = ChatScope(
            kind="project", id="project-1", surface="freezone",
            canvas_id="canvas-1", agent_id="main",
        )
        from novelvideo.freezone import canvas_command_bridge as bridge

        directory = tmp_path / "bridge"
        monkeypatch.setattr(
            routes, "_candidate_canvas_bridge_dirs_for_scope", lambda *a: [directory],
        )
        monkeypatch.setattr(routes, "_canvas_bridge_dir", lambda *a, **kw: directory)
        monkeypatch.setattr(routes, "_bridge_project_state_dir", AsyncMock(return_value=tmp_path))
        bridge.put_pending_canvas_command(
            key="command-1", project_id="project-1", canvas_id="canvas-1",
            commands=[{"type": "select_nodes", "node_ids": []}],
            envelope={"canvas_id": "canvas-1",
                      "commands": [{"type": "select_nodes", "node_ids": []}]},
            bridge_dir=directory,
        )
        bridge.put_pending_clarification_event(
            key="clarify-1", project_id="project-1", canvas_id="canvas-1", bridge_dir=directory,
            event={"type": "assistant.clarification.request", "clarification_id": "question-1",
                   "questions": [{"id": "style", "options": []}]},
        )
    key = persist(runtime)
    end = threading.Event()
    attached, closed = asyncio.Event(), asyncio.Event()
    interrupted = []
    async def transport(**kwargs):
        try:
            yield ChatBackendEvent(type="turn_started", turn_id="turn-1", status="inProgress")
            attached.set()
            while not end.is_set():
                await asyncio.sleep(0.001)
            if action == "history":
                yield ChatBackendEvent(type="item_completed", item={
                    "type": "agentMessage", "id": "after-history", "text": "Still streaming",
                })
            status = "interrupted" if interrupted else "completed"
            yield ChatBackendEvent(type="turn_completed", status=status,
                                   disposition="cancelled" if interrupted else "completed")
        finally:
            closed.set()
    def interrupt(operation, thread_id, turn_id):
        interrupted.append((operation, thread_id, turn_id))
        end.set()
        return True
    monkeypatch.setattr(service, "follow_codex_turn", transport, raising=False)
    monkeypatch.setattr(service, "_control_codex_thread", interrupt)
    monkeypatch.setattr(service, "_codex_thread_snapshot", lambda *a, **k: SimpleNamespace(
        status=SimpleNamespace(type="active"),
    ))
    monkeypatch.setattr(
        routes, "_authenticate_ws", AsyncMock(return_value={"username": "test-user"}),
    )
    monkeypatch.setattr(routes, "_reauthenticate_ws_event", AsyncMock(
        return_value={"username": "test-user"},
    ))
    monkeypatch.setattr(routes, "_scope_for_authenticated_user", lambda _: runtime)
    monkeypatch.setattr(routes, "_history", AsyncMock(return_value=SimpleNamespace(
        history=[], before=None, has_more=False,
    )))
    monkeypatch.setattr(routes, "register_chat_websocket", AsyncMock())
    monkeypatch.setattr(routes, "unregister_chat_websocket", AsyncMock())
    monkeypatch.setattr(routes, "_prewarm_chat_scope_if_available", AsyncMock())
    monkeypatch.setattr(routes, "_sync_running_agent_scope", AsyncMock())
    monkeypatch.setattr(routes, "_project_context_for_scope", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_require_ai_assistant_access", AsyncMock())
    if action == "finish_race":
        done_entered, release_done, next_started = asyncio.Event(), asyncio.Event(), asyncio.Event()
        class DelayedDoneSocket(Socket):
            async def send_json(self, payload):
                if payload["type"] == "chat.done" and payload["turn_id"] == "business-1":
                    self.sending = True
                    done_entered.set()
                    await release_done.wait()
                    self.sending = False
                await super().send_json(payload)

        @asynccontextmanager
        async def egress(**kwargs):
            yield None

        async def next_turn(*args, **kwargs):
            next_started.set()
            await args[3]({"type": "done", "message": None})

        monkeypatch.setattr(routes, "_stream_home_turn", routes._stream_home_turn_codex)
        monkeypatch.setattr(routes, "request_egress_scope", egress)
        monkeypatch.setattr(routes, "_requester_user_id_for_chat", AsyncMock(return_value="local"))
        monkeypatch.setattr(routes, "list_user_projects", lambda _: [])
        monkeypatch.setattr(service, "stream_assistant_reply", next_turn)
        socket = DelayedDoneSocket()
    else:
        socket = Socket()
    task = asyncio.create_task(routes.chat_ws(socket))
    try:
        frame = await socket.frame("scope.changed")
        assert frame["busy"] is True
        assert frame["turn_id"] == "business-1"
        frame = await socket.frame("agent.turn.started")
        assert frame["turn_id"] == "turn-1"
        await asyncio.wait_for(attached.wait(), 2)
        if action == "finish_race":
            end.set()
            await asyncio.wait_for(done_entered.wait(), 2)
            await socket.incoming.put({
                "type": "chat.message", "text": "next", "turn_id": "next-business",
            })
            await asyncio.wait_for(next_started.wait(), 2)
            release_done.set()
            assert (await socket.frame("chat.done"))["turn_id"] == "business-1"
            assert (await socket.frame("chat.done"))["turn_id"] == "next-business"
            return
        if action == "disconnect":
            await socket.incoming.put(None)
            await asyncio.wait_for(task, 2)
            assert closed.is_set()
            assert interrupted == []
            assert service._load_active_codex_turns("test-user")[key]["turn_id"] == "turn-1"
            return
        if action == "bridge":
            command = await socket.frame("canvas.command")
            clarification = await socket.frame("assistant.clarification.event")
            assert command["turn_id"] == clarification["turn_id"] == "business-1"
            assert command["bridge_key"] == "command-1"
            assert clarification["event"]["clarification_id"] == "question-1"
            await socket.incoming.put({
                "type": "canvas.command.result", "bridge_key": "command-1",
                "project_id": "project-1", "canvas_id": "canvas-1", "turn_id": "business-1",
                "canvas_apply_status": "applied", "applied": True,
            })
            await socket.incoming.put({
                "type": "assistant.clarification.result", "bridge_key": "clarify-1",
                "project_id": "project-1", "canvas_id": "canvas-1", "turn_id": "business-1",
                "answers": {"style": "ink"},
            })
            result = await asyncio.to_thread(
                bridge.wait_canvas_command_result, "command-1", 2, bridge_dir=directory,
            )
            assert result["canvas_apply_status"] == "applied"
            result = await asyncio.to_thread(
                bridge.wait_clarification_result, "clarify-1", 2, bridge_dir=directory,
            )
            assert result["answers"] == {"style": "ink"}
        if action == "switch":
            await socket.incoming.put({
                "type": "scope.set", "scope": {"kind": "project", "id": "other"},
            })
            assert (await socket.frame("scope.changed"))["scope"] == {
                "kind": "project", "id": "other", "surface": "director",
            }
            assert closed.is_set()
            assert interrupted == []
            assert service._load_active_codex_turns("test-user")[key]["turn_id"] == "turn-1"
            return
        if action == "busy":
            await socket.incoming.put({"type": "chat.message", "text": "hello", "turn_id": "new"})
            busy = await socket.frame("chat.busy")
            assert busy["active_turn_id"] == "business-1"
        if action == "history":
            await socket.incoming.put({
                "type": "scope.set", "scope": {"kind": "home"}, "history_before": "older",
            })
            page = await socket.frame("history.page")
            assert page["history"] == []
            assert page["has_more"] is False
            end.set()
            item = await socket.frame("chat.item")
            assert item["turn_id"] == "business-1"
            assert item["item_id"] == "after-history"
        if action == "cancel":
            app = FastAPI()
            app.include_router(routes.router)
            app.dependency_overrides[routes.get_api_user] = lambda: {"username": "test-user"}
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test",
            ) as client:
                response = await client.post("/chat/cancel", json={
                    "scope": {"kind": "home"}, "turn_id": "business-1",
                })
            assert response.status_code == 200
            assert response.json()["data"]["cancelled"] is True
            assert interrupted == [("interrupt", "thread-1", "turn-1")]
        else:
            end.set()
        done = await socket.frame("chat.done")
        assert done["turn_id"] == "business-1"
        assert done["message"] is None
        assert not {f["type"] for f in socket.pending} & {"assistant.delta", "assistant.message"}
        assert service._load_active_codex_turns("test-user") == {}
    finally:
        if action == "finish_race":
            release_done.set()
        await socket.incoming.put(None)
        await asyncio.wait_for(task, 2)
    assert closed.is_set()


@pytest.mark.asyncio
async def test_transport_cancellation_closes_connection_without_interrupt(monkeypatch, tmp_path):
    from openai_codex.errors import TransportClosedError

    waiting = threading.Event()
    class WaitingClient(FixtureClient):
        def next_turn_notification(self, turn_id):
            waiting.set()
            return ProtocolClient.next_turn_notification(self, turn_id)

        def close(self):
            super().close()
            self._router.fail_all(TransportClosedError("connection closed"))

        def turn_interrupt(self, *args):
            pytest.fail("closing a follower must not interrupt its turn")

    client = WaitingClient()
    @contextmanager
    def attach(config):
        try:
            yield SimpleNamespace(_client=client)
        finally:
            client.close()
    monkeypatch.setattr(codex_app_server, "attach_shared_codex", attach)
    async def consume():
        async for _ in backend_sdk.follow_codex_turn(
            codex_bin=None, cwd=tmp_path, env={}, config_overrides=(),
            thread_id="01a1c513-9aae-7512-9f52-510de9a0715d",
            turn_id="01a1c513-9ad9-75e0-bf99-4ff3d12fff7b",
        ):
            pass
    task = asyncio.create_task(consume())
    try:
        assert await asyncio.to_thread(waiting.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        assert client.closed
    finally:
        client.close()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)



"""Merged history through the chat socket and the shared Codex runtime."""

import asyncio
import logging
from contextlib import asynccontextmanager, contextmanager
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from codex_history_stub import HistoryClient
from novelvideo.api.routes import chat as routes
from novelvideo.chat import codex_app_server, service
from novelvideo.chat.codex_history import (
    HISTORY_CACHE,
    CodexHistoryCache,
    CodexHistoryUnavailable,
)
from novelvideo.chat.store import ChatScope, ChatStore


class RecordingWebSocket:
    def __init__(self):
        self.frames = []

    async def send_json(self, payload):
        self.frames.append(payload)


@pytest.fixture
def store(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setattr(service, "chat_run_lock_is_active", lambda *_: False)
    return ChatStore()


def install_reader(monkeypatch, count):
    client, cache, calls = HistoryClient(count), CodexHistoryCache(), []

    async def read(username, project, **kwargs):
        calls.append((username, project, kwargs))
        return cache.read_page(client, "thread-history-route", before=kwargs["before"])

    monkeypatch.setattr(service, "read_codex_scope_history", read, raising=False)
    return calls


def append_users(store, scope, count):
    return [store.append_message(
        "alice", scope, "user", f"user{index}", turn_id=f"business-{index:04d}"
    )["id"] for index in range(1, count + 1)]


@pytest.mark.asyncio
async def test_home_first_screen(store, monkeypatch):
    scope = ChatScope(kind="home")
    assert append_users(store, scope, 3) == [1, 2, 3]
    calls = install_reader(monkeypatch, 3)
    websocket = RecordingWebSocket()

    assert await routes._send_scope_changed(
        websocket, {"username": "alice"}, "alice", scope
    ) == scope

    assert len(websocket.frames) == 1
    frame = websocket.frames[0]
    assert set(frame) == {"type", "scope", "history", "before", "has_more", "busy"}
    assert frame["type"] == "scope.changed"
    assert frame["scope"] == {"kind": "home", "id": None}
    assert [(m["id"], m["role"]) for m in frame["history"]] == [
        (1, "user"), ("assistant:turn-0001", "assistant"),
        (2, "user"), ("assistant:turn-0002", "assistant"),
        (3, "user"), ("assistant:turn-0003", "assistant"),
    ]
    assert frame["before"] is None
    assert frame["has_more"] is False
    assert frame["busy"] is False
    assert calls == [("alice", "", {
        "agent_profile": "main", "canvas_id": None, "project_state_dir": None, "before": None,
    })]


def websocket_app(monkeypatch):
    effects = []

    async def authenticate(_websocket):
        return {"username": "alice"}

    async def reauthenticate(_websocket, *, original_user, **kwargs):
        return original_user

    async def register(*args, **kwargs):
        effects.append("register")

    async def sync(*args, **kwargs):
        effects.append("sync")

    async def prewarm(**kwargs):
        effects.append("prewarm")

    monkeypatch.setattr(routes, "_authenticate_ws", authenticate)
    monkeypatch.setattr(routes, "_scope_for_authenticated_user", lambda _: ChatScope(kind="home"))
    monkeypatch.setattr(routes, "_reauthenticate_ws_event", reauthenticate)
    monkeypatch.setattr(routes, "register_chat_websocket", register)
    monkeypatch.setattr(routes, "_sync_running_agent_scope", sync)
    monkeypatch.setattr(routes, "_prewarm_chat_scope_if_available", prewarm)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    return app, effects


def test_websocket_history_pages_have_every_message_once(store, monkeypatch):
    row_ids = append_users(store, ChatScope(kind="home"), 250)
    install_reader(monkeypatch, 250)
    app, effects = websocket_app(monkeypatch)
    with TestClient(app).websocket_connect("/api/v1/chat/ws") as websocket:
        first = websocket.receive_json()
        assert first["type"] == "scope.changed"
        assert sum(m["role"] == "assistant" for m in first["history"]) == 100
        assert first["has_more"] is True
        connect_effects = list(effects)
        assert connect_effects == ["register"]
        pages = [first]
        while pages[-1]["has_more"]:
            assert len(pages) < 5
            websocket.send_json({
                "type": "scope.set", "scope": {"kind": "home"},
                "history_before": pages[-1]["before"],
            })
            frame = websocket.receive_json()
            assert set(frame) == {"type", "scope", "history", "before", "has_more"}
            assert frame["type"] == "history.page"
            assert frame["scope"] == {"kind": "home"}
            pages.append(frame)
        assert effects == connect_effects
    assert [sum(m["role"] == "assistant" for m in p["history"]) for p in pages] == [100, 100, 50]
    ids = [m["id"] for page in pages for m in page["history"]]
    assert len(ids) == len(set(ids)) == 500
    assert set(ids) == set(row_ids) | {f"assistant:turn-{i:04d}" for i in range(1, 251)}
    assert pages[-1]["before"] is None


def test_invalid_cursor_keeps_socket_usable(store, monkeypatch, caplog):
    install_reader(monkeypatch, 3)
    app, effects = websocket_app(monkeypatch)
    with caplog.at_level(logging.WARNING, logger=routes.__name__):
        with TestClient(app).websocket_connect("/api/v1/chat/ws") as websocket:
            assert websocket.receive_json()["type"] == "scope.changed"
            websocket.send_json({
                "type": "scope.set", "scope": {"kind": "home"}, "history_before": "x",
            })
            assert websocket.receive_json() == {
                "type": "history.page", "scope": {"kind": "home"},
                "history": [], "before": None, "has_more": False,
            }
            assert effects == ["register"]
            websocket.send_json({"type": "scope.set", "scope": {"kind": "home"}})
            assert websocket.receive_json()["type"] == "scope.changed"
    warnings = [r.message for r in caplog.records if r.name == routes.__name__
                and r.levelno == logging.WARNING]
    assert warnings == ["Invalid history cursor scope=home cursor_length=1"]


@pytest.mark.asyncio
async def test_missing_project_page_and_disconnected_socket(store, monkeypatch):
    async def missing(*args):
        raise HTTPException(404, "missing")

    monkeypatch.setattr(routes, "_project_context_for_scope", missing)
    scope = ChatScope(kind="project", id="missing-project")
    websocket = RecordingWebSocket()
    assert await routes._send_history_page(
        websocket, {"username": "alice"}, "alice", scope, "x"
    ) is True
    assert websocket.frames == [{
        "type": "history.page", "scope": {"kind": "project", "id": "missing-project"},
        "history": [], "before": None, "has_more": False,
    }]

    class Disconnected:
        async def send_json(self, payload):
            raise WebSocketDisconnect(code=1006)

    assert await routes._send_history_page(
        Disconnected(), {"username": "alice"}, "alice", scope, "x"
    ) is False


@pytest.mark.asyncio
async def test_director_user_turn_and_history(store, monkeypatch, tmp_path):
    scope = ChatScope(kind="project", id="project-id", surface="director")
    project = SimpleNamespace(
        project_name="project-name", state_dir=tmp_path / "project-state",
        output_dir=tmp_path / "output", project_id="project-id",
        requester_user_id="alice", requester_username="alice", requester_principals=(),
    )

    async def context(*args):
        return project

    @asynccontextmanager
    async def egress(**kwargs):
        yield None

    async def never(*args, **kwargs):
        await asyncio.Future()

    async def stream(username, project, text, on_event, **kwargs):
        assert kwargs["store_scope"] is None
        await on_event({"type": "done", "message": {"role": "assistant", "content": "reply"}})

    monkeypatch.setattr(routes, "_project_context_for_scope", context)
    monkeypatch.setattr(routes, "request_egress_scope", egress)
    monkeypatch.setattr(service, "get_chat_backend_name", lambda: "codex")
    monkeypatch.setattr(service, "stream_assistant_reply", stream)
    for name in (
        "_chat_heartbeat", "_interrupt_agent_on_disconnect", "_receive_bridge_results_during_turn",
        "_watch_pending_canvas_commands", "_watch_pending_canvas_context_requests",
        "_watch_pending_skill_studio_events", "_watch_pending_clarification_events",
    ):
        monkeypatch.setattr(routes, name, never)
    await routes._stream_project_turn(
        websocket=RecordingWebSocket(), user={"username": "alice"}, username="alice",
        scope=scope, text="prompt context", user_text="user1", attachments=[],
        turn_id="business-0001",
    )
    storage = replace(scope, id="project-name", state_dir=str(project.state_dir))
    rows = store.list_messages("alice", storage)
    assert [(m["id"], m["role"], m["content"], m["turn_id"], m["media"]) for m in rows] == [
        (1, "user", "user1", "business-0001", []),
    ]
    assert (project.state_dir / "chat.db").exists()
    calls = install_reader(monkeypatch, 1)
    websocket = RecordingWebSocket()
    await routes._send_scope_changed(websocket, {"username": "alice"}, "alice", scope)
    assert [(m["id"], m["role"]) for m in websocket.frames[0]["history"]] == [
        (1, "user"), ("assistant:turn-0001", "assistant"),
    ]
    assert calls == [("alice", "project-id", {
        "agent_profile": "main", "canvas_id": None,
        "project_state_dir": project.state_dir, "before": None,
    })]


@pytest.mark.asyncio
async def test_service_without_backend_thread_or_runtime(store, monkeypatch, tmp_path):
    monkeypatch.setattr(service, "get_chat_backend_name", lambda: "hermes")
    assert await service.read_codex_scope_history("alice", "") is None
    monkeypatch.setattr(service, "get_chat_backend_name", lambda: "codex")
    assert await service.read_codex_scope_history("alice", "") is None
    service._set_codex_thread_id("alice", "", "thread-history-route")
    monkeypatch.setattr(service, "_codex_thread_runtime_options", lambda: None)
    with pytest.raises(CodexHistoryUnavailable):
        await service.read_codex_scope_history("alice", "")


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [RuntimeError("unavailable"), ValueError("bad cursor"),
                                  CodexHistoryUnavailable("unavailable")])
async def test_service_read_errors(store, monkeypatch, error):
    monkeypatch.setattr(service, "get_chat_backend_name", lambda: "codex")
    service._set_codex_thread_id("alice", "", "thread-history-route")
    monkeypatch.setattr(service, "_codex_thread_runtime_options", lambda: {})

    def fail(**kwargs):
        raise error

    monkeypatch.setattr(service, "read_codex_thread_history", fail, raising=False)
    expected = ValueError if isinstance(error, ValueError) else CodexHistoryUnavailable
    with pytest.raises(expected) as caught:
        await service.read_codex_scope_history("alice", "", before="cursor")
    if type(error) is RuntimeError:
        assert caught.value.__cause__ is error
    else:
        assert caught.value is error


@pytest.mark.asyncio
async def test_service_reads_fixture_pages_through_runtime(store, monkeypatch, tmp_path):
    monkeypatch.setattr(service, "get_chat_backend_name", lambda: "codex")
    service._set_codex_thread_id(
        "alice", "project-id", "thread-runtime-history", agent_profile="freezone:artist",
        canvas_id="canvas-1", project_state_dir=tmp_path,
    )
    client = HistoryClient(101)

    @contextmanager
    def shared(config):
        yield SimpleNamespace(_client=client)

    monkeypatch.setattr(codex_app_server, "shared_codex", shared)
    monkeypatch.setattr(service, "_codex_thread_runtime_options", lambda: {
        "codex_bin": tmp_path / "codex", "cwd": tmp_path, "env": {}, "config_overrides": (),
    })
    HISTORY_CACHE.invalidate("thread-runtime-history")
    try:
        first = await service.read_codex_scope_history(
            "alice", "project-id", agent_profile="freezone:artist", canvas_id="canvas-1",
            project_state_dir=tmp_path,
        )
        assert len(first.messages) == 100
        assert first.messages[0]["id"] == "assistant:turn-0002"
        last = await service.read_codex_scope_history(
            "alice", "project-id", agent_profile="freezone:artist", canvas_id="canvas-1",
            project_state_dir=tmp_path, before=first.before,
        )
        assert [(m["id"], m["content"]) for m in last.messages] == [
            ("assistant:turn-0001", "reply-0001"),
        ]
        assert last.before is None
    finally:
        HISTORY_CACHE.invalidate("thread-runtime-history")


@pytest.mark.asyncio
async def test_clear_invalidates_cached_items_with_unchanged_probe(store, monkeypatch, tmp_path):
    thread_id = "thread-clear-history"
    service._set_codex_thread_id("alice", "", thread_id)
    monkeypatch.setattr(service, "_clear_codex_thread_history", lambda _: "reverted")
    client = HistoryClient(1)
    HISTORY_CACHE.invalidate(thread_id)
    try:
        assert HISTORY_CACHE.read_page(client, thread_id).messages[0]["content"] == "reply-0001"
        client.text_size = 3
        assert await service.clear_codex_scope_thread("alice", "") == 1
        assert HISTORY_CACHE.read_page(client, thread_id).messages[0]["content"] == "xxx"
    finally:
        HISTORY_CACHE.invalidate(thread_id)

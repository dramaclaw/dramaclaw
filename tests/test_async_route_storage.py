from __future__ import annotations

import asyncio
import os
import time
from threading import get_ident
from types import SimpleNamespace

import pytest


@pytest.mark.anyio
async def test_chat_notification_uses_async_storage(monkeypatch) -> None:
    from novelvideo.api.routes import chat

    seen: list[tuple] = []

    async def fake_append_message(*args, **kwargs):
        seen.append((args, kwargs))
        return {"id": "message-1", "content": "通知"}

    monkeypatch.setattr(chat.chat_store, "append_message_async", fake_append_message)

    response = await chat.append_chat_notification(
        chat.ChatNotificationIn(
            scope=chat.ChatScopePayload(kind="home"),
            text="通知",
        ),
        user={"username": "alice"},
    )

    assert response["data"]["id"] == "message-1"
    assert seen


@pytest.mark.anyio
async def test_chat_assistant_turn_is_idempotent(monkeypatch, tmp_path) -> None:
    from novelvideo.chat.store import ChatScope, ChatStore

    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path))
    store = ChatStore()
    scope = ChatScope(kind="home")

    first, second = await asyncio.gather(
        store.append_message_async(
            "alice",
            scope,
            "assistant",
            "完成",
            turn_id="turn-1",
            idempotency_key="assistant:turn-1",
        ),
        store.append_message_async(
            "alice",
            scope,
            "assistant",
            "完成",
            turn_id="turn-1",
            idempotency_key="assistant:turn-1",
        ),
    )

    messages = await store.list_messages_async("alice", scope)
    assert first["id"] == second["id"]
    assert [(item["role"], item["content"]) for item in messages] == [
        ("assistant", "完成")
    ]


@pytest.mark.anyio
async def test_agent_summaries_sort_by_message_time_before_limit(tmp_path) -> None:
    from novelvideo.chat.store import ChatScope, ChatStore

    store = ChatStore()
    database_paths = []
    for index in range(1, 4):
        scope = ChatScope(
            kind="project",
            id="proj_demo",
            surface="freezone",
            canvas_id="default",
            agent_id=f"agent-{index}",
            state_dir=str(tmp_path),
        )
        store.append_message("alice", scope, "user", f"Agent {index}")
        database_paths.append(store.db_for("alice", scope))
        time.sleep(0.002)

    for database_path, forced_mtime in zip(database_paths, (300, 200, 100), strict=True):
        os.utime(database_path, (forced_mtime, forced_mtime))

    summaries = await store.list_freezone_canvas_agent_summaries_async(
        "alice",
        project_id="proj_demo",
        canvas_id="default",
        project_state_dir=tmp_path,
        limit=2,
    )

    assert [summary["id"] for summary in summaries] == ["agent-3", "agent-2"]


@pytest.mark.anyio
async def test_async_connection_closes_when_initialization_fails(
    monkeypatch,
    tmp_path,
) -> None:
    from novelvideo.chat import store as store_module
    from novelvideo.chat.store import ChatScope, ChatStore

    class FailingConnection:
        row_factory = None
        closed = False

        async def close(self) -> None:
            self.closed = True

    connection = FailingConnection()

    async def fake_connect(*args, **kwargs):
        del args, kwargs
        return connection

    async def fail_initialization(db) -> None:
        assert db is connection
        raise RuntimeError("schema initialization failed")

    store = ChatStore()
    monkeypatch.setattr(store_module.aiosqlite, "connect", fake_connect)
    monkeypatch.setattr(store, "_initialize_connection_async", fail_initialization)

    with pytest.raises(RuntimeError, match="schema initialization failed"):
        await store.connect_async(
            "alice",
            ChatScope(kind="home"),
            db_path=tmp_path / "chat.db",
        )

    assert connection.closed is True


@pytest.mark.anyio
async def test_workflow_run_creation_offloads_storage_from_event_loop(
    monkeypatch,
    tmp_path,
) -> None:
    from novelvideo.api.routes import freezone

    event_loop_thread_id = get_ident()
    storage_thread_ids: list[int] = []
    ctx = SimpleNamespace(project_id="proj_demo", state_dir=tmp_path)

    async def fake_resolve(project: str, user: dict, **kwargs):
        del project, user, kwargs
        return ctx, "alice", "demo", tmp_path, str(tmp_path)

    def fake_create_workflow_run(**kwargs):
        del kwargs
        storage_thread_ids.append(get_ident())
        return {"run_id": "run-1"}

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone, "create_workflow_run", fake_create_workflow_run)

    response = await freezone.create_canvas_workflow_run(
        "proj_demo",
        "default",
        body={"actions": [{"node_id": "image-1", "action": "generate_image"}]},
        user={"id": "u-alice", "username": "alice"},
    )

    assert response["data"]["run_id"] == "run-1"
    assert storage_thread_ids
    assert storage_thread_ids[0] != event_loop_thread_id

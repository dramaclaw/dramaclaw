import pytest
from fastapi import HTTPException
from types import SimpleNamespace

from novelvideo.chat import service as chat_service
from novelvideo.chat.store import ChatScope, ChatStore
from novelvideo.api.routes import chat as chat_routes


@pytest.mark.asyncio
async def test_clear_messages_preserves_other_canvas_agent_and_settings(tmp_path):
    store = ChatStore()
    first = ChatScope(
        kind="project",
        id="project-1",
        surface="freezone",
        canvas_id="canvas-1",
        agent_id="main",
        state_dir=str(tmp_path),
    )
    other_agent = ChatScope(
        kind="project",
        id="project-1",
        surface="freezone",
        canvas_id="canvas-1",
        agent_id="other",
        state_dir=str(tmp_path),
    )
    await store.append_message_async("alice", first, "user", "旧消息", turn_id="turn-1")
    await store.append_message_async("alice", other_agent, "user", "保留消息")
    db = await store.connect_async("alice", first)
    try:
        await db.execute(
            "INSERT INTO chat_ui_events(turn_id, event_type, payload_json, created_at) "
            "VALUES (?, ?, ?, ?)",
            ("turn-1", "test", "{}", "2026-01-01T00:00:00Z"),
        )
        await db.execute(
            "INSERT INTO chat_settings(key, value, updated_at) VALUES (?, ?, ?)",
            ("theme", "dark", "2026-01-01T00:00:00Z"),
        )
        await db.commit()
    finally:
        await db.close()

    assert await store.clear_messages_async("alice", first) == 1
    assert await store.list_messages_async("alice", first) == []
    assert len(await store.list_messages_async("alice", other_agent)) == 1
    db = await store.connect_async("alice", first)
    try:
        events = await (
            await db.execute("SELECT COUNT(*) FROM chat_ui_events")
        ).fetchone()
        setting = await (
            await db.execute("SELECT value FROM chat_settings WHERE key='theme'")
        ).fetchone()
        assert events[0] == 0
        assert setting[0] == "dark"
    finally:
        await db.close()


def test_reset_codex_scope_thread_preserves_other_scopes(tmp_path, monkeypatch):
    monkeypatch.setattr(
        chat_service,
        "_active_codex_turns_path",
        lambda _username: tmp_path / "active_codex_turns.json",
    )
    chat_service._set_codex_thread_id(
        "alice",
        "project-1",
        "thread-1",
        agent_profile="freezone:main",
        canvas_id="canvas-1",
        project_state_dir=tmp_path,
    )
    chat_service._set_codex_thread_id(
        "alice",
        "project-1",
        "thread-2",
        agent_profile="freezone:other",
        canvas_id="canvas-1",
        project_state_dir=tmp_path,
    )

    chat_service.reset_codex_scope_thread(
        "alice",
        "project-1",
        agent_profile="freezone:main",
        canvas_id="canvas-1",
        project_state_dir=tmp_path,
    )

    assert (
        chat_service._get_codex_thread_id(
            "alice",
            "project-1",
            agent_profile="freezone:main",
            canvas_id="canvas-1",
            project_state_dir=tmp_path,
        )
        is None
    )
    assert (
        chat_service._get_codex_thread_id(
            "alice",
            "project-1",
            agent_profile="freezone:other",
            canvas_id="canvas-1",
            project_state_dir=tmp_path,
        )
        == "thread-2"
    )


@pytest.mark.asyncio
async def test_clear_route_rejects_active_turn_before_mutating(monkeypatch):
    monkeypatch.setattr(chat_service, "get_chat_backend_name", lambda: "codex")

    def locked(*_args):
        raise RuntimeError("busy")

    monkeypatch.setattr(chat_service, "_acquire_chat_run_lock", locked)
    called = False

    def reset(*_args, **_kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(chat_service, "reset_codex_scope_thread", reset)
    with pytest.raises(HTTPException) as error:
        await chat_routes.clear_chat_scope(
            chat_routes.ClearChatRequest(scope={"kind": "home"}),
            user={"username": "alice"},
        )
    assert error.value.status_code == 409
    assert not called


@pytest.mark.asyncio
async def test_clear_route_requires_editor_before_mutating(monkeypatch):
    monkeypatch.setattr(chat_service, "get_chat_backend_name", lambda: "codex")
    roles = []

    async def resolve(*, user, project_id, required_role):
        roles.append(required_role)
        raise HTTPException(403, "forbidden")

    monkeypatch.setattr(chat_routes, "resolve_project_context", resolve)
    monkeypatch.setattr(
        chat_service, "_acquire_chat_run_lock", lambda *_: pytest.fail("mutated")
    )
    with pytest.raises(HTTPException) as error:
        await chat_routes.clear_chat_scope(
            chat_routes.ClearChatRequest(scope={"kind": "project", "id": "project-1"}),
            user={"username": "alice"},
        )
    assert error.value.status_code == 403
    assert roles == ["editor"]


@pytest.mark.asyncio
async def test_clear_route_holds_freezone_lock_until_clear_finishes(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(chat_service, "get_chat_backend_name", lambda: "codex")

    async def resolve(*, user, project_id, required_role):
        assert required_role == "editor"
        return SimpleNamespace(state_dir=tmp_path, project_name="project-1")

    monkeypatch.setattr(chat_routes, "resolve_project_context", resolve)
    acquired = []
    released = []
    monkeypatch.setattr(
        chat_service,
        "_acquire_chat_run_lock",
        lambda username, project: acquired.append((username, project)) or "lock-1",
    )
    monkeypatch.setattr(
        chat_service,
        "_release_chat_run_lock",
        lambda username, project, lock_id: released.append(
            (username, project, lock_id)
        ),
    )
    monkeypatch.setattr(
        chat_service, "reset_codex_scope_thread", lambda *_args, **_kwargs: None
    )

    async def clear(username, scope):
        assert acquired == [("alice", "freezone:project-1:canvas:canvas-1:agent:main")]
        assert released == []
        return 2

    monkeypatch.setattr(chat_routes.chat_store, "clear_messages_async", clear)
    result = await chat_routes.clear_chat_scope(
        chat_routes.ClearChatRequest(
            scope={
                "kind": "project",
                "id": "project-1",
                "surface": "freezone",
                "canvasId": "canvas-1",
                "agentId": "main",
            }
        ),
        user={"username": "alice"},
    )
    assert result["data"]["cleared_messages"] == 2
    assert released == [("alice", acquired[0][1], "lock-1")]

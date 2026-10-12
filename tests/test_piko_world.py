from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from fastapi import HTTPException, WebSocketDisconnect

from novelvideo.api.routes import piko as piko_routes
from novelvideo.piko.world import PikoCharacterStore, PikoWorldHub


class FakeWebSocket:
    def __init__(self) -> None:
        self.frames: list[dict] = []
        self.close_code: int | None = None

    async def send_json(self, payload: dict) -> None:
        self.frames.append(payload)

    async def close(self, code: int) -> None:
        self.close_code = code


@pytest.mark.asyncio
async def test_public_task_status_uses_project_scoped_requester_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = object()
    calls: list[tuple[object, object]] = []

    class Access:
        async def resolve_requester_principals(self, user_id: str):
            assert user_id == "user-a"
            return [SimpleNamespace(type="user", id=user_id)]

    class Registry:
        async def list_accessible_projects(self, principals):
            assert principals == [("user", "user-a")]
            return [SimpleNamespace(id="project-a", purged_at=None)]

    class Manager:
        def count_active_tasks_for_project_user_lane(self, ctx, queue_kind):
            calls.append((ctx, queue_kind))
            return 1

    async def resolve_context(**kwargs):
        assert kwargs["project_id"] == "project-a"
        return context

    monkeypatch.setattr(piko_routes, "get_project_access", lambda: Access())
    monkeypatch.setattr(piko_routes, "get_project_registry", lambda: Registry())
    monkeypatch.setattr(piko_routes, "get_task_manager", lambda: Manager())
    monkeypatch.setattr(piko_routes, "resolve_project_context", resolve_context)

    assert await piko_routes._public_task_status(
        {"id": "user-a", "username": "alice"}
    ) == "running"
    assert calls == [(context, None)]


def test_character_is_account_scoped_and_location_survives_restart(tmp_path: Path) -> None:
    path = tmp_path / "world.db"
    store = PikoCharacterStore(path)
    created = store.create_or_update("user-a", nickname="小花", gender="female")
    duplicate = store.create_or_update("user-a", nickname="小花花", gender="female")

    assert duplicate.id == created.id
    assert duplicate.nickname == "小花花"

    store.update_location(
        "user-a", scene_id="artisan-market", x=456.5, y=789.25, facing="west"
    )
    restored = PikoCharacterStore(path).get("user-a")
    assert restored is not None
    assert (restored.scene_id, restored.position_x, restored.position_y, restored.facing) == (
        "artisan-market",
        456.5,
        789.25,
        "west",
    )


@pytest.mark.asyncio
async def test_character_api_returns_the_authenticated_accounts_character(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = PikoCharacterStore(tmp_path / "world.db")
    monkeypatch.setattr(piko_routes, "character_store", store)

    result = await piko_routes.put_character(
        piko_routes.CharacterUpsertRequest(
            nickname="小花", gender="female", bio="喜欢在庭院散步。"
        ),
        {"id": "user-a", "username": "alice"},
    )
    assert result["character"]["nickname"] == "小花"
    assert result["character"]["bio"] == "喜欢在庭院散步。"
    assert "user_id" not in result["character"]
    assert await piko_routes.get_character({"id": "user-b", "username": "bob"}) == {
        "character": None
    }


@pytest.mark.asyncio
async def test_scene_chat_and_presence_are_broadcast_only_inside_scene(tmp_path: Path) -> None:
    store = PikoCharacterStore(tmp_path / "world.db")
    first = store.create_or_update("user-a", nickname="小花", gender="female")
    second = store.create_or_update(
        "user-b", nickname="小叶", gender="male", bio="喜欢在集市画画。"
    )
    outsider = store.create_or_update("user-c", nickname="小山", gender="male")
    store.update_location(
        "user-c", scene_id="artisan-market", x=100, y=200, facing="south"
    )
    outsider = store.get("user-c")
    assert outsider is not None

    hub = PikoWorldHub(store)
    first_socket, second_socket, outsider_socket = (
        FakeWebSocket(),
        FakeWebSocket(),
        FakeWebSocket(),
    )
    first_online = await hub.join(first_socket, user_id="user-a", character=first)  # type: ignore[arg-type]
    await hub.join(second_socket, user_id="user-b", character=second)  # type: ignore[arg-type]
    await hub.join(outsider_socket, user_id="user-c", character=outsider)  # type: ignore[arg-type]

    assert any(frame["type"] == "player.joined" for frame in first_socket.frames)
    joined_player = next(
        frame["player"] for frame in first_socket.frames if frame["type"] == "player.joined"
    )
    assert joined_player["bio"] == second.bio
    assert not any(frame["type"] == "player.joined" for frame in outsider_socket.frames)

    await hub.handle(first_online, {"type": "chat.send", "body": "大家好"})
    assert first_socket.frames[-1]["type"] == "chat.message"
    assert second_socket.frames[-1]["type"] == "chat.message"
    assert outsider_socket.frames[-1]["type"] == "world.snapshot"

    await hub.handle(
        first_online,
        {"type": "player.move", "x": 321, "y": 654, "facing": "east"},
    )
    assert second_socket.frames[-1]["type"] == "player.moved"
    assert outsider_socket.frames[-1]["type"] == "world.snapshot"

    await hub.handle(
        first_online,
        {
            "type": "scene.join",
            "scene_id": "artisan-market",
            "x": 111,
            "y": 222,
            "facing": "north",
        },
    )
    assert outsider_socket.frames[-1]["type"] == "player.joined"
    assert outsider_socket.frames[-1]["player"]["facing"] == "north"

    await hub.disconnect(first_socket)  # type: ignore[arg-type]
    restored = store.get("user-a")
    assert restored is not None
    assert (
        restored.scene_id,
        restored.position_x,
        restored.position_y,
        restored.facing,
    ) == ("artisan-market", 111, 222, "north")


@pytest.mark.asyncio
async def test_public_task_status_is_shared_only_with_players_in_the_same_scene(
    tmp_path: Path,
) -> None:
    store = PikoCharacterStore(tmp_path / "world.db")
    creator = store.create_or_update("user-a", nickname="小花", gender="female")
    observer = store.create_or_update("user-b", nickname="小叶", gender="male")
    outsider = store.create_or_update("user-c", nickname="小山", gender="male")
    store.update_location(
        "user-c", scene_id="artisan-market", x=100, y=200, facing="south"
    )
    outsider = store.get("user-c")
    assert outsider is not None
    hub = PikoWorldHub(store)
    creator_socket, observer_socket, outsider_socket = (
        FakeWebSocket(), FakeWebSocket(), FakeWebSocket()
    )

    creator_online = await hub.join(
        creator_socket,
        user_id="user-a",
        character=creator,
        public_task_status="running",
    )  # type: ignore[arg-type]
    await hub.join(
        observer_socket, user_id="user-b", character=observer
    )  # type: ignore[arg-type]
    await hub.join(
        outsider_socket, user_id="user-c", character=outsider
    )  # type: ignore[arg-type]

    assert observer_socket.frames[0]["players"][0]["task_status"] == "running"
    observer_socket.frames.clear()
    outsider_socket.frames.clear()
    await hub.update_public_task_status(creator_online, None)

    assert observer_socket.frames == [{
        "type": "player.task_status",
        "character_id": creator.id,
        "task_status": None,
    }]
    assert outsider_socket.frames == []


@pytest.mark.asyncio
async def test_private_chat_acceptance_and_messages_reach_only_the_two_players(
    tmp_path: Path,
) -> None:
    store = PikoCharacterStore(tmp_path / "world.db")
    first = store.create_or_update("user-a", nickname="小花", gender="female")
    second = store.create_or_update("user-b", nickname="小叶", gender="male")
    third = store.create_or_update("user-c", nickname="小山", gender="male")
    hub = PikoWorldHub(store)
    first_socket, second_socket, third_socket = FakeWebSocket(), FakeWebSocket(), FakeWebSocket()
    sender = await hub.join(first_socket, user_id="user-a", character=first)  # type: ignore[arg-type]
    recipient = await hub.join(second_socket, user_id="user-b", character=second)  # type: ignore[arg-type]
    await hub.join(third_socket, user_id="user-c", character=third)  # type: ignore[arg-type]
    second_socket.frames.clear()
    third_socket.frames.clear()

    await hub.handle(
        sender,
        {"type": "chat.request", "target_character_id": second.id},
    )

    assert second_socket.frames == [
        {
            "type": "chat.request",
            "request": {
                "id": second_socket.frames[0]["request"]["id"],
                "from_character_id": first.id,
                "from_nickname": "小花",
                "sent_at": second_socket.frames[0]["request"]["sent_at"],
            },
        }
    ]
    assert third_socket.frames == []
    assert first_socket.frames[-1]["type"] == "chat.request.sent"

    request_id = second_socket.frames[0]["request"]["id"]
    await hub.handle(
        recipient,
        {"type": "chat.request.respond", "request_id": request_id, "accepted": True},
    )
    assert first_socket.frames[-1] == {
        "type": "chat.request.responded",
        "request_id": request_id,
        "accepted": True,
        "peer": {"character_id": second.id, "nickname": "小叶"},
    }
    assert second_socket.frames[-1] == {
        "type": "chat.request.responded",
        "request_id": request_id,
        "accepted": True,
        "peer": {"character_id": first.id, "nickname": "小花"},
    }

    await hub.handle(
        sender,
        {"type": "chat.private.send", "target_character_id": second.id, "body": "你好"},
    )
    assert first_socket.frames[-1]["type"] == "chat.private.message"
    assert second_socket.frames[-1] == first_socket.frames[-1]
    assert second_socket.frames[-1]["message"]["body"] == "你好"
    assert third_socket.frames == []


async def open_private_chat(hub: PikoWorldHub, sender, recipient, recipient_socket) -> None:
    await hub.handle(
        sender, {"type": "chat.request", "target_character_id": recipient.character_id}
    )
    request_id = recipient_socket.frames[-1]["request"]["id"]
    await hub.handle(
        recipient,
        {"type": "chat.request.respond", "request_id": request_id, "accepted": True},
    )


@pytest.mark.asyncio
async def test_session_takeover_ends_private_chats_for_the_peer(tmp_path: Path) -> None:
    store = PikoCharacterStore(tmp_path / "world.db")
    first = store.create_or_update("user-a", nickname="小花", gender="female")
    second = store.create_or_update("user-b", nickname="小叶", gender="male")
    hub = PikoWorldHub(store)
    first_socket, second_socket, takeover_socket = (
        FakeWebSocket(), FakeWebSocket(), FakeWebSocket()
    )
    sender = await hub.join(first_socket, user_id="user-a", character=first)  # type: ignore[arg-type]
    recipient = await hub.join(second_socket, user_id="user-b", character=second)  # type: ignore[arg-type]
    await open_private_chat(hub, sender, recipient, second_socket)
    first_socket.frames.clear()

    # The same account enters from another tab; the old route then runs disconnect().
    takeover = await hub.join(takeover_socket, user_id="user-b", character=second)  # type: ignore[arg-type]
    await hub.disconnect(second_socket)  # type: ignore[arg-type]

    assert second_socket.close_code == 4001
    ended = [frame for frame in first_socket.frames if frame["type"] == "chat.private.ended"]
    assert ended == [{"type": "chat.private.ended", "character_id": second.id}]
    # The old socket's cleanup must not take the new connection offline.
    assert not any(frame["type"] == "player.left" for frame in first_socket.frames)
    await hub.handle(takeover, {"type": "chat.send", "body": "我回来了"})
    assert first_socket.frames[-1]["message"]["body"] == "我回来了"


class ScriptedWebSocket(FakeWebSocket):
    """A socket that replays client frames, running a hook before each one."""

    def __init__(self, script: list, *, then_idle: bool = False) -> None:
        super().__init__()
        self._then_idle = then_idle
        self.headers: dict[str, str] = {}
        self.query_params: dict[str, str] = {}
        self.cookies = {piko_routes.AUTH_COOKIE_NAME: "cookie"}
        self._script = list(script)

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        if not self._script:
            if self._then_idle:
                # Stay connected and silent, like a client that stops sending.
                await asyncio.Event().wait()
            raise WebSocketDisconnect()
        step = self._script.pop(0)
        if callable(step):
            step()
            return await self.receive_text()
        return step


class RecordingHub:
    def __init__(self) -> None:
        self.handled: list[dict] = []
        self.profiles: list[dict] = []
        self.disconnected = False

    async def join(self, websocket, **kwargs):
        return SimpleNamespace()

    async def update_public_task_status(self, player, status) -> None:
        return None

    async def update_profile(self, player, **profile) -> None:
        self.profiles.append(profile)

    async def handle(self, player, payload: dict) -> None:
        self.handled.append(payload)

    async def disconnect(self, websocket) -> None:
        self.disconnected = True


def install_world_route(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, verify
) -> RecordingHub:
    store = PikoCharacterStore(tmp_path / "world.db")
    store.create_or_update("user-a", nickname="小花", gender="female")
    hub = RecordingHub()

    async def no_task_status(user) -> None:
        return None

    monkeypatch.setattr(piko_routes, "character_store", store)
    monkeypatch.setattr(piko_routes, "world_hub", hub)
    monkeypatch.setattr(piko_routes, "_public_task_status", no_task_status)
    monkeypatch.setattr(piko_routes, "_verify_browser_session", verify)
    return hub


@pytest.mark.asyncio
@pytest.mark.parametrize("event_type", ["chat.send", "chat.private.send", "ping"])
async def test_revoked_session_is_disconnected_before_its_next_event(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, event_type: str
) -> None:
    state = {"revoked": False}

    async def verify(cookie):
        if state["revoked"]:
            raise HTTPException(status_code=401, detail="Invalid session")
        return {"id": "user-a", "username": "alice"}

    hub = install_world_route(monkeypatch, tmp_path, verify)
    socket = ScriptedWebSocket(
        [
            '{"type": "player.move", "x": 1, "y": 2, "facing": "south"}',
            lambda: state.update(revoked=True),
            '{"type": "%s", "body": "还能发吗"}' % event_type,
            '{"type": "chat.send", "body": "不应到达"}',
        ]
    )

    await piko_routes.piko_world_ws(socket)  # type: ignore[arg-type]

    assert [payload["type"] for payload in hub.handled] == ["player.move"]
    assert socket.frames[-1] == {"type": "error", "code": "unauthorized"}
    assert socket.close_code == 1008
    assert hub.disconnected


@pytest.mark.asyncio
async def test_session_handed_to_another_account_is_disconnected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = {"user": "user-a"}

    async def verify(cookie):
        return {"id": state["user"], "username": state["user"]}

    hub = install_world_route(monkeypatch, tmp_path, verify)
    socket = ScriptedWebSocket(
        [lambda: state.update(user="user-b"), '{"type": "chat.send", "body": "冒名"}']
    )

    await piko_routes.piko_world_ws(socket)  # type: ignore[arg-type]

    assert hub.handled == []
    assert socket.close_code == 1008


@pytest.mark.asyncio
async def test_auth_outage_drops_the_event_but_keeps_the_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = {"down": False}

    async def verify(cookie):
        if state["down"]:
            raise HTTPException(status_code=503, detail="Authentication service unavailable")
        return {"id": "user-a", "username": "alice"}

    hub = install_world_route(monkeypatch, tmp_path, verify)
    socket = ScriptedWebSocket(
        [
            lambda: state.update(down=True),
            '{"type": "chat.send", "body": "鉴权不可用"}',
            lambda: state.update(down=False),
            '{"type": "chat.send", "body": "恢复"}',
        ]
    )

    await piko_routes.piko_world_ws(socket)  # type: ignore[arg-type]

    assert [payload["body"] for payload in hub.handled] == ["恢复"]
    assert socket.close_code is None


@pytest.mark.asyncio
async def test_profile_refresh_updates_the_online_player_without_reconnecting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verify(cookie):
        return {"id": "user-a", "username": "alice"}

    hub = install_world_route(monkeypatch, tmp_path, verify)
    store = piko_routes.character_store
    socket = ScriptedWebSocket(
        [
            lambda: store.create_or_update(
                "user-a", nickname="小花花", gender="female", bio="换了名字"
            ),
            '{"type": "profile.refresh"}',
        ]
    )

    await piko_routes.piko_world_ws(socket)  # type: ignore[arg-type]

    assert hub.profiles == [{"nickname": "小花花", "bio": "换了名字"}]
    assert hub.handled == []
    assert socket.close_code is None


@pytest.mark.asyncio
async def test_profile_update_reaches_scene_peers_and_keeps_private_chats(
    tmp_path: Path,
) -> None:
    store = PikoCharacterStore(tmp_path / "world.db")
    first = store.create_or_update("user-a", nickname="小花", gender="female")
    second = store.create_or_update("user-b", nickname="小叶", gender="male")
    hub = PikoWorldHub(store)
    first_socket, second_socket = FakeWebSocket(), FakeWebSocket()
    sender = await hub.join(first_socket, user_id="user-a", character=first)  # type: ignore[arg-type]
    recipient = await hub.join(second_socket, user_id="user-b", character=second)  # type: ignore[arg-type]
    await open_private_chat(hub, sender, recipient, second_socket)
    first_socket.frames.clear()
    second_socket.frames.clear()

    await hub.update_profile(sender, nickname="小花花", bio="换了名字")

    assert first_socket.frames == []
    assert [frame["type"] for frame in second_socket.frames] == ["player.updated"]
    assert second_socket.frames[0]["player"]["nickname"] == "小花花"
    assert second_socket.frames[0]["player"]["bio"] == "换了名字"
    await hub.handle(
        sender,
        {"type": "chat.private.send", "target_character_id": second.id, "body": "还在"},
    )
    assert second_socket.frames[-1]["message"]["from_nickname"] == "小花花"
    await hub.update_profile(sender, nickname="小花花", bio="换了名字")
    assert [frame["type"] for frame in second_socket.frames].count("player.updated") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("event_type", ["player.move", "scene.join"])
async def test_revoked_client_cannot_stay_online_by_omitting_ping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, event_type: str
) -> None:
    state = {"revoked": False}

    async def verify(cookie):
        if state["revoked"]:
            raise HTTPException(status_code=401, detail="Invalid session")
        return {"id": "user-a", "username": "alice"}

    hub = install_world_route(monkeypatch, tmp_path, verify)
    # The recheck is due on the server's clock, not when the client chooses to ping.
    monkeypatch.setattr(piko_routes, "SESSION_RECHECK_SECONDS", 0.0)
    frame = '{"type": "%s", "scene_id": "artisan-market", "x": 1, "y": 2}' % event_type
    socket = ScriptedWebSocket([lambda: state.update(revoked=True), frame, frame])

    await piko_routes.piko_world_ws(socket)  # type: ignore[arg-type]

    assert hub.handled == []
    assert socket.frames[-1] == {"type": "error", "code": "unauthorized"}
    assert socket.close_code == 1008
    assert hub.disconnected


@pytest.mark.asyncio
async def test_silent_connection_is_closed_once_its_session_is_revoked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"count": 0}

    async def verify(cookie):
        calls["count"] += 1
        if calls["count"] > 2:
            raise HTTPException(status_code=403, detail="Access denied")
        return {"id": "user-a", "username": "alice"}

    hub = install_world_route(monkeypatch, tmp_path, verify)
    monkeypatch.setattr(piko_routes, "SESSION_RECHECK_SECONDS", 0.01)
    socket = ScriptedWebSocket([], then_idle=True)

    await asyncio.wait_for(piko_routes.piko_world_ws(socket), timeout=5)  # type: ignore[arg-type]

    assert calls["count"] == 3
    assert socket.close_code == 1008
    assert hub.disconnected


@pytest.mark.asyncio
async def test_prolonged_auth_outage_ends_the_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = {"down": False}

    async def verify(cookie):
        if state["down"]:
            raise HTTPException(status_code=503, detail="Authentication service unavailable")
        return {"id": "user-a", "username": "alice"}

    hub = install_world_route(monkeypatch, tmp_path, verify)
    monkeypatch.setattr(piko_routes, "SESSION_RECHECK_SECONDS", 0.0)
    monkeypatch.setattr(piko_routes, "SESSION_RETRY_SECONDS", 0.0)
    monkeypatch.setattr(piko_routes, "SESSION_MAX_UNVERIFIED_SECONDS", 0.05)
    move = '{"type": "player.move", "x": 1, "y": 2, "facing": "south"}'
    socket = ScriptedWebSocket(
        [lambda: state.update(down=True), move, move], then_idle=True
    )

    await asyncio.wait_for(piko_routes.piko_world_ws(socket), timeout=5)  # type: ignore[arg-type]

    # Movement survives a short outage; the connection does not survive a long one.
    assert [payload["type"] for payload in hub.handled] == ["player.move", "player.move"]
    assert socket.close_code == 1013
    assert all(frame.get("code") != "unauthorized" for frame in socket.frames)
    assert hub.disconnected

from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone

import fakeredis.aioredis
import pytest

from novelvideo.piko.distributed import CLIENT_STALE_SECONDS, DistributedPikoWorldHub
from novelvideo.piko.world import PikoCharacter


class FakeStore:
    def __init__(self) -> None:
        self.locations: list[tuple[str, str, float, float, str]] = []

    async def update_location(
        self, user_id: str, *, scene_id: str, x: float, y: float, facing: str
    ) -> None:
        self.locations.append((user_id, scene_id, x, y, facing))

    async def open_conversation(self, first_id: str, second_id: str) -> str:
        return "00000000-0000-0000-0000-000000000001"

    async def append_message(
        self, conversation_id: str, sender_id: str, body: str
    ) -> dict[str, str]:
        return {
            "id": "00000000-0000-0000-0000-000000000002",
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }


class FakeWebSocket:
    def __init__(self) -> None:
        self.frames: list[dict] = []
        self.close_code: int | None = None

    async def send_json(self, payload: dict) -> None:
        self.frames.append(payload)

    async def close(self, code: int) -> None:
        self.close_code = code


def character(number: int) -> PikoCharacter:
    now = datetime.now(timezone.utc).isoformat()
    return PikoCharacter(
        id=f"00000000-0000-0000-0000-{number:012d}",
        user_id=f"user-{number}",
        nickname=f"玩家{number}",
        gender="female" if number % 2 else "male",
        bio="",
        scene_id="welcome-courtyard",
        position_x=1270,
        position_y=480,
        facing="south",
        created_at=now,
        updated_at=now,
    )


async def wait_for_frame(socket: FakeWebSocket, event_type: str) -> dict:
    for _ in range(100):
        for frame in socket.frames:
            if frame.get("type") == event_type:
                return frame
        await asyncio.sleep(0.01)
    raise AssertionError(f"missing frame {event_type}: {socket.frames!r}")


def make_hub(server: fakeredis.FakeServer, store: FakeStore) -> DistributedPikoWorldHub:
    hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    hub.redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    return hub


async def open_private_chat(
    hub: DistributedPikoWorldHub,
    sender,
    sender_socket: FakeWebSocket,
    peer_hub: DistributedPikoWorldHub,
    peer,
    peer_socket: FakeWebSocket,
) -> None:
    await hub.handle(
        sender, {"type": "chat.request", "target_character_id": peer.character_id}
    )
    request = await wait_for_frame(peer_socket, "chat.request")
    await peer_hub.handle(
        peer,
        {
            "type": "chat.request.respond",
            "request_id": request["request"]["id"],
            "accepted": True,
        },
    )
    await wait_for_frame(sender_socket, "chat.request.responded")
    await wait_for_frame(peer_socket, "chat.request.responded")


async def crash(hub: DistributedPikoWorldHub, player) -> None:
    """Kill a server without disconnect(), then let its Redis presence lapse."""
    for task in (hub._pubsub_task, hub._heartbeat_task):
        if task:
            task.cancel()
    await asyncio.gather(
        *(task for task in (hub._pubsub_task, hub._heartbeat_task) if task),
        return_exceptions=True,
    )
    hub._players.clear()
    await hub.redis.delete(
        hub._route_key(player.character_id),
        hub._presence_key(player.user_id),
        hub._player_key(player.character_id),
    )
    await hub.redis.zadd(hub._room_key(player.instance_id), {player.character_id: 1})


@pytest.mark.asyncio
async def test_players_and_chat_cross_realtime_server_processes() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    second_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    first_hub.redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    second_hub.redis = fakeredis.aioredis.FakeRedis(
        server=server, decode_responses=True
    )
    first_socket, second_socket = FakeWebSocket(), FakeWebSocket()

    try:
        first = await first_hub.join(
            first_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        await second_hub.join(
            second_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        joined = await wait_for_frame(first_socket, "player.joined")
        assert joined["player"]["nickname"] == "玩家2"

        await first_hub.handle(first, {"type": "chat.send", "body": "跨进程你好"})
        first_message = await wait_for_frame(first_socket, "chat.message")
        second_message = await wait_for_frame(second_socket, "chat.message")
        assert first_message == second_message
        assert second_message["message"]["body"] == "跨进程你好"
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_public_task_status_crosses_realtime_server_processes() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    second_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    first_hub.redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    second_hub.redis = fakeredis.aioredis.FakeRedis(
        server=server, decode_responses=True
    )
    creator_socket, observer_socket = FakeWebSocket(), FakeWebSocket()

    try:
        creator = await first_hub.join(
            creator_socket,
            user_id="user-1",
            character=character(1),
            public_task_status="running",
        )  # type: ignore[arg-type]
        await second_hub.join(
            observer_socket, user_id="user-2", character=character(2)
        )  # type: ignore[arg-type]

        assert observer_socket.frames[0]["players"][0]["task_status"] == "running"
        observer_socket.frames.clear()
        await first_hub.update_public_task_status(creator, None)
        status = await wait_for_frame(observer_socket, "player.task_status")
        assert status == {
            "type": "player.task_status",
            "character_id": creator.character_id,
            "task_status": None,
        }
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_scene_change_broadcasts_and_persists_new_facing() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    second_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    first_hub.redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    second_hub.redis = fakeredis.aioredis.FakeRedis(
        server=server, decode_responses=True
    )
    first_socket, second_socket = FakeWebSocket(), FakeWebSocket()

    try:
        first = await first_hub.join(
            first_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        observer = replace(character(2), scene_id="artisan-market")
        await second_hub.join(
            second_socket, user_id="user-2", character=observer  # type: ignore[arg-type]
        )
        second_socket.frames.clear()

        await first_hub.handle(
            first,
            {
                "type": "scene.join",
                "scene_id": "artisan-market",
                "x": 111,
                "y": 222,
                "facing": "west",
            },
        )

        joined = await wait_for_frame(second_socket, "player.joined")
        assert joined["player"]["facing"] == "west"
        assert store.locations[-1] == ("user-1", "artisan-market", 111, 222, "west")
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_stale_browser_is_removed_and_broadcasts_player_left() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    second_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    first_hub.redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    second_hub.redis = fakeredis.aioredis.FakeRedis(
        server=server, decode_responses=True
    )
    stale_socket, observer_socket = FakeWebSocket(), FakeWebSocket()

    try:
        stale = await first_hub.join(
            stale_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        await second_hub.join(
            observer_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        observer_socket.frames.clear()
        stale.last_seen_at -= CLIENT_STALE_SECONDS + 1

        await first_hub._heartbeat_once()

        left = await wait_for_frame(observer_socket, "player.left")
        assert left["character_id"] == stale.character_id
        assert stale_socket.close_code == 1001
        assert (
            await first_hub.redis.get(first_hub._player_key(stale.character_id)) is None
        )
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_disconnect_ends_private_chats_for_the_online_peer() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub, second_hub = make_hub(server, store), make_hub(server, store)
    first_socket, second_socket = FakeWebSocket(), FakeWebSocket()

    try:
        first = await first_hub.join(
            first_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        second = await second_hub.join(
            second_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        await open_private_chat(
            first_hub, first, first_socket, second_hub, second, second_socket
        )

        await second_hub.disconnect(second_socket)  # type: ignore[arg-type]

        ended = await wait_for_frame(first_socket, "chat.private.ended")
        assert ended["character_id"] == second.character_id
        for player in (first, second):
            assert not await first_hub.redis.exists(
                first_hub._active_chat_key(player.character_id)
            )

        # The reconnected peer starts with an empty tray, so nothing may reach it.
        second_socket = FakeWebSocket()
        await second_hub.join(
            second_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        await first_hub.handle(
            first,
            {
                "type": "chat.private.send",
                "target_character_id": second.character_id,
                "body": "还在吗",
            },
        )
        await asyncio.sleep(0.05)
        for socket in (first_socket, second_socket):
            assert all(frame["type"] != "chat.private.message" for frame in socket.frames)
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_replaced_session_does_not_inherit_private_chats() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub, second_hub = make_hub(server, store), make_hub(server, store)
    first_socket, second_socket = FakeWebSocket(), FakeWebSocket()

    try:
        first = await first_hub.join(
            first_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        second = await second_hub.join(
            second_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        await open_private_chat(
            first_hub, first, first_socket, second_hub, second, second_socket
        )

        # The same character signs in on the other server before the old socket closes.
        await first_hub.join(
            FakeWebSocket(), user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )

        ended = await wait_for_frame(first_socket, "chat.private.ended")
        assert ended["character_id"] == second.character_id
        assert not await first_hub.redis.exists(
            first_hub._active_chat_key(first.character_id)
        )
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_crashed_server_players_leave_for_surviving_observers() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub, second_hub = make_hub(server, store), make_hub(server, store)
    observer_socket, crashed_socket = FakeWebSocket(), FakeWebSocket()

    try:
        observer = await first_hub.join(
            observer_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        crashed = await second_hub.join(
            crashed_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        await open_private_chat(
            first_hub, observer, observer_socket, second_hub, crashed, crashed_socket
        )
        observer_socket.frames.clear()
        await crash(second_hub, crashed)

        await first_hub._heartbeat_once()

        left = await wait_for_frame(observer_socket, "player.left")
        assert left["character_id"] == crashed.character_id
        ended = await wait_for_frame(observer_socket, "chat.private.ended")
        assert ended["character_id"] == crashed.character_id
        room = first_hub._room_key(observer.instance_id)
        assert await first_hub.redis.zrange(room, 0, -1) == [observer.character_id]

        # One announcement per departure, however many heartbeats follow.
        await first_hub._heartbeat_once()
        await asyncio.sleep(0.05)
        assert [frame["type"] for frame in observer_socket.frames].count("player.left") == 1
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_expiry_sweep_keeps_players_whose_connection_is_still_routed() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub, second_hub = make_hub(server, store), make_hub(server, store)
    observer_socket, skewed_socket = FakeWebSocket(), FakeWebSocket()

    try:
        observer = await first_hub.join(
            observer_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        skewed = await second_hub.join(
            skewed_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        observer_socket.frames.clear()
        room = first_hub._room_key(observer.instance_id)
        # A server on a lagging clock writes old scores but keeps its route alive.
        await first_hub.redis.zadd(room, {skewed.character_id: 1})

        await first_hub._heartbeat_once()
        await asyncio.sleep(0.05)

        assert all(frame["type"] != "player.left" for frame in observer_socket.frames)
        assert skewed.character_id in await first_hub.redis.zrange(room, 0, -1)
        snapshot = await first_hub._room_snapshot(
            observer.instance_id, exclude=observer.character_id
        )
        assert [player["character_id"] for player in snapshot] == [skewed.character_id]
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_private_message_to_an_unrouted_peer_ends_the_chat() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub, second_hub = make_hub(server, store), make_hub(server, store)
    first_socket, second_socket = FakeWebSocket(), FakeWebSocket()

    try:
        first = await first_hub.join(
            first_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        second = await second_hub.join(
            second_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        await open_private_chat(
            first_hub, first, first_socket, second_hub, second, second_socket
        )
        await crash(second_hub, second)

        await first_hub.handle(
            first,
            {
                "type": "chat.private.send",
                "target_character_id": second.character_id,
                "body": "还在吗",
            },
        )

        ended = await wait_for_frame(first_socket, "chat.private.ended")
        assert ended["character_id"] == second.character_id
        assert all(frame["type"] != "chat.private.message" for frame in first_socket.frames)
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_session_takeover_on_another_shard_leaves_the_previous_room() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub, second_hub = make_hub(server, store), make_hub(server, store)
    first_hub.scene_capacity = second_hub.scene_capacity = 2
    sockets = [FakeWebSocket() for _ in range(4)]

    try:
        # Two players fill shard 1, so the player and its observer land on shard 2.
        for number in (1, 2):
            await first_hub.join(
                sockets[number - 1],
                user_id=f"user-{number}",
                character=character(number),  # type: ignore[arg-type]
            )
        player = await first_hub.join(
            sockets[2], user_id="user-3", character=character(3)  # type: ignore[arg-type]
        )
        observer = await first_hub.join(
            sockets[3], user_id="user-4", character=character(4)  # type: ignore[arg-type]
        )
        assert player.instance_id == observer.instance_id == "welcome-courtyard:2"
        await first_hub.disconnect(sockets[0])  # type: ignore[arg-type]
        sockets[3].frames.clear()

        takeover_socket = FakeWebSocket()
        takeover = await second_hub.join(
            takeover_socket, user_id="user-3", character=character(3)  # type: ignore[arg-type]
        )

        assert takeover.instance_id == "welcome-courtyard:1"
        left = await wait_for_frame(sockets[3], "player.left")
        assert left["character_id"] == player.character_id
        old_room = first_hub._room_key(observer.instance_id)
        assert await first_hub.redis.zrange(old_room, 0, -1) == [observer.character_id]
        assert sockets[2].close_code == 4001
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_expiry_sweep_removes_a_leftover_member_without_ending_its_new_session() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub, second_hub = make_hub(server, store), make_hub(server, store)
    observer_socket, moved_socket, friend_socket = (FakeWebSocket() for _ in range(3))

    try:
        observer = await first_hub.join(
            observer_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        moved = await second_hub.join(
            moved_socket,
            user_id="user-2",
            character=replace(character(2), scene_id="artisan-market"),  # type: ignore[arg-type]
        )
        friend = await second_hub.join(
            friend_socket,
            user_id="user-3",
            character=replace(character(3), scene_id="artisan-market"),  # type: ignore[arg-type]
        )
        await open_private_chat(
            second_hub, moved, moved_socket, second_hub, friend, friend_socket
        )
        observer_socket.frames.clear()
        # An expired membership of the moved character lingers in the observer's room.
        old_room = first_hub._room_key(observer.instance_id)
        await first_hub.redis.zadd(old_room, {moved.character_id: 1})

        await first_hub._heartbeat_once()

        left = await wait_for_frame(observer_socket, "player.left")
        assert left["character_id"] == moved.character_id
        assert await first_hub.redis.zrange(old_room, 0, -1) == [observer.character_id]
        await asyncio.sleep(0.05)
        assert all(frame["type"] != "chat.private.ended" for frame in friend_socket.frames)
        assert await first_hub.redis.sismember(
            first_hub._active_chat_key(moved.character_id), friend.character_id
        )
        new_room = first_hub._room_key(moved.instance_id)
        assert moved.character_id in await first_hub.redis.zrange(new_room, 0, -1)
        assert await first_hub.redis.exists(first_hub._route_key(moved.character_id))
    finally:
        await first_hub.close()
        await second_hub.close()


@pytest.mark.asyncio
async def test_profile_update_crosses_processes_and_reaches_later_snapshots() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub, second_hub = make_hub(server, store), make_hub(server, store)
    first_socket, second_socket, late_socket = (FakeWebSocket() for _ in range(3))

    try:
        first = await first_hub.join(
            first_socket, user_id="user-1", character=character(1)  # type: ignore[arg-type]
        )
        await second_hub.join(
            second_socket, user_id="user-2", character=character(2)  # type: ignore[arg-type]
        )
        second_socket.frames.clear()

        await first_hub.update_profile(first, nickname="新名字", bio="新简介")

        updated = await wait_for_frame(second_socket, "player.updated")
        assert updated["player"]["nickname"] == "新名字"
        assert updated["player"]["bio"] == "新简介"
        assert all(frame["type"] != "player.updated" for frame in first_socket.frames)
        await second_hub.join(
            late_socket, user_id="user-3", character=character(3)  # type: ignore[arg-type]
        )
        snapshot = {
            player["character_id"]: player for player in late_socket.frames[0]["players"]
        }
        assert snapshot[first.character_id]["nickname"] == "新名字"
    finally:
        await first_hub.close()
        await second_hub.close()

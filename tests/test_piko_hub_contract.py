"""Run the same session lifecycle contract against both Piko backends."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from dataclasses import replace
import uuid

import fakeredis.aioredis
import pytest

from novelvideo.piko.distributed import DistributedPikoWorldHub
from novelvideo.piko.world import PikoCharacter, PikoCharacterStore, PikoWorldHub


class Socket:
    def __init__(self) -> None:
        self.frames: list[dict] = []
        self.close_code: int | None = None

    async def send_json(self, payload: dict) -> None:
        self.frames.append(payload)

    async def close(self, code: int) -> None:
        self.close_code = code


class AsyncStore:
    def __init__(self, characters: list[PikoCharacter]) -> None:
        self.characters = {character.user_id: character for character in characters}
        self.messages: list[str] = []
        self.message_ids: set[str] = set()
        self.locations: list[tuple[str, dict]] = []

    async def get(self, user_id: str) -> PikoCharacter | None:
        return self.characters.get(user_id)

    async def update_location(self, user_id, **kwargs) -> None:
        self.locations.append((user_id, kwargs))

    async def open_conversation(self, *args) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_OID, "/".join(sorted(args))))

    async def append_message(self, conversation_id: str, sender_id: str, body: str, *,
                             message_id: str | None = None, sent_at: str | None = None) -> dict[str, str]:
        identifier = message_id or str(uuid.uuid4())
        if identifier not in self.message_ids:
            self.message_ids.add(identifier)
            self.messages.append(body)
        return {"id": identifier, "sent_at": sent_at or datetime.now(timezone.utc).isoformat()}


async def wait_for_frame(socket: Socket, event: str) -> dict:
    async def wait() -> dict:
        while True:
            for frame in socket.frames:
                if frame.get("type") == event:
                    return frame
            await asyncio.sleep(0.01)
    return await asyncio.wait_for(wait(), timeout=3)


@pytest.fixture(params=["demo", "distributed"])
async def connected_world(request: pytest.FixtureRequest, tmp_path: Path):
    store = PikoCharacterStore(tmp_path / "world.db")
    characters = [store.create_or_update(name, nickname=name, gender="female") for name in ("alice", "bob")]
    if request.param == "demo":
        hub = PikoWorldHub(store)
    else:
        hub = DistributedPikoWorldHub(AsyncStore(characters), redis_url="redis://unused")
        hub.redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    sockets = [Socket(), Socket()]
    players = [await hub.join(socket, user_id=character.user_id, character=character)
               for socket, character in zip(sockets, characters)]
    try:
        yield SimpleNamespace(hub=hub, sockets=sockets, players=players, characters=characters)
    finally:
        if isinstance(hub, DistributedPikoWorldHub):
            await hub.close()
        else:
            for socket in list(hub._players):
                await hub.disconnect(socket)


@pytest.fixture
async def world(connected_world):
    hub, sockets, players, characters = (connected_world.hub, connected_world.sockets, connected_world.players, connected_world.characters)
    await hub.handle(players[0], {"type": "chat.request", "target_character_id": characters[1].id})
    incoming = await wait_for_frame(sockets[1], "chat.request")
    await hub.handle(players[1], {"type": "chat.request.respond", "request_id": incoming["request"]["id"], "accepted": True})
    for socket in sockets:
        await wait_for_frame(socket, "chat.request.responded")
        socket.frames.clear()
    return connected_world


@pytest.mark.parametrize("accepted", [True, False])
async def test_first_message_waits_for_acceptance_and_only_reaches_participants(connected_world, accepted):
    world = connected_world
    for socket in world.sockets:
        socket.frames.clear()
    await world.hub.handle(world.players[0], {
        "type": "chat.request", "target_character_id": world.characters[1].id,
        "body": "  首条消息 😀  ", "client_message_id": "first-request",
    })
    incoming = await wait_for_frame(world.sockets[1], "chat.request")
    sent = await wait_for_frame(world.sockets[0], "chat.request.sent")
    assert sent["client_message_id"] == "first-request"
    assert sent["message"]["body"] == "首条消息 😀"
    assert "body" not in incoming["request"]
    assert not any(frame.get("type") == "chat.private.message" for frame in world.sockets[1].frames)
    await world.hub.handle(world.players[1], {
        "type": "chat.request.respond", "request_id": incoming["request"]["id"], "accepted": accepted,
        "client_message_id": "respond-choice",
    })
    for socket in world.sockets:
        response = await wait_for_frame(socket, "chat.request.responded")
        assert response["accepted"] is accepted
        assert response["client_message_id"] == "respond-choice"
        if accepted:
            assert response["message"]["id"] == sent["message"]["id"]
            assert response["message"]["body"] == "首条消息 😀"
        else:
            assert "message" not in response
    if isinstance(world.hub, DistributedPikoWorldHub):
        assert world.hub.store.messages == (["首条消息 😀"] if accepted else [])


@pytest.mark.parametrize("body", [" ", "x" * 81, 123])
async def test_invalid_first_message_does_not_notify_the_recipient(connected_world, body):
    world = connected_world
    world.sockets[1].frames.clear()
    await world.hub.handle(world.players[0], {
        "type": "chat.request", "target_character_id": world.characters[1].id,
        "body": body, "client_message_id": "invalid-request",
    })
    rejected = await wait_for_frame(world.sockets[0], "error")
    assert rejected == {"type": "error", "code": "invalid_message", "client_message_id": "invalid-request"}
    assert not world.sockets[1].frames


async def test_sender_receipt_failure_does_not_disconnect_the_recipient(connected_world, monkeypatch):
    world = connected_world
    sender, receiver = world.sockets
    original = sender.send_json

    async def fail_receipt(payload):
        if payload.get("type") == "chat.request.sent":
            raise RuntimeError("Sender connection closed")
        await original(payload)

    monkeypatch.setattr(sender, "send_json", fail_receipt)
    await world.hub.handle(world.players[0], {
        "type": "chat.request", "target_character_id": world.characters[1].id, "body": "hello",
    })
    assert receiver in world.hub._players
    receiver.frames.clear()
    await world.hub.handle(world.players[1], {"type": "chat.send", "body": "still online", "client_message_id": "alive"})
    assert (await wait_for_frame(receiver, "chat.sent"))["client_message_id"] == "alive"


@pytest.mark.parametrize("accepted", [True, False])
async def test_pending_requests_accept_many_messages_without_repeating_the_invitation(connected_world, accepted):
    world = connected_world
    for socket in world.sockets:
        socket.frames.clear()
    target_id = world.characters[1].id
    await world.hub.handle(world.players[0], {"type": "chat.request", "target_character_id": target_id, "body": "first"})
    request = (await wait_for_frame(world.sockets[1], "chat.request"))["request"]
    for index in range(120):
        # Advance beyond the sender's cooldown without slowing the batch contract.
        world.players[0].last_private_chat_at = 0
        if isinstance(world.hub, DistributedPikoWorldHub):
            await world.hub.redis.delete(f"piko:v1:rate:private-chat:{world.characters[0].id}")
        await world.hub.handle(world.players[0], {
            "type": "chat.request.message", "request_id": request["id"], "target_character_id": target_id,
            "body": f"queued-{index}", "client_message_id": f"queued-client-{index}",
        })
    queued = [frame for frame in world.sockets[0].frames if frame.get("type") == "chat.request.message.sent"]
    assert len(queued) == 120
    assert len([frame for frame in world.sockets[1].frames if frame.get("type") == "chat.request"]) == 1
    assert not any(frame.get("type") == "chat.private.message" for frame in world.sockets[1].frames)
    await world.hub.handle(world.players[1], {"type": "chat.request.respond", "request_id": request["id"], "accepted": accepted})
    expected = ["first", *(f"queued-{index}" for index in range(120))]
    for socket in world.sockets:
        response = await wait_for_frame(socket, "chat.request.responded")
        if accepted:
            assert [message["body"] for message in response["messages"]] == expected
            assert len({message["id"] for message in response["messages"]}) == 121
        else:
            assert "messages" not in response
    if isinstance(world.hub, DistributedPikoWorldHub):
        assert world.hub.store.messages == (expected if accepted else [])
        assert not await world.hub.redis.exists(f"piko:v1:chat:request:messages:{request['id']}")


async def test_final_pending_send_after_acceptance_follows_the_active_private_session(connected_world):
    world = connected_world
    target_id = world.characters[1].id
    await world.hub.handle(world.players[0], {"type": "chat.request", "target_character_id": target_id, "body": "first"})
    request = (await wait_for_frame(world.sockets[1], "chat.request"))["request"]
    await world.hub.handle(world.players[1], {"type": "chat.request.respond", "request_id": request["id"], "accepted": True})
    await world.hub.handle(world.players[0], {
        "type": "chat.request.message", "request_id": request["id"], "target_character_id": target_id,
        "body": "acceptance won the race", "client_message_id": "raced-send",
    })
    assert (await wait_for_frame(world.sockets[1], "chat.private.message"))["message"]["body"] == "acceptance won the race"
    assert (await wait_for_frame(world.sockets[0], "chat.sent"))["client_message_id"] == "raced-send"


async def test_other_participant_cannot_append_to_the_senders_pending_request(connected_world):
    world = connected_world
    await world.hub.handle(world.players[0], {"type": "chat.request", "target_character_id": world.characters[1].id, "body": "authorized"})
    request = (await wait_for_frame(world.sockets[1], "chat.request"))["request"]
    await world.hub.handle(world.players[1], {
        "type": "chat.request.message", "request_id": request["id"], "target_character_id": world.characters[0].id,
        "body": "forged append", "client_message_id": "forged",
    })
    rejected = await wait_for_frame(world.sockets[1], "error")
    assert rejected["code"] == "chat_request_unavailable"
    await world.hub.handle(world.players[1], {"type": "chat.request.respond", "request_id": request["id"], "accepted": True})
    response = await wait_for_frame(world.sockets[1], "chat.request.responded")
    assert [message["body"] for message in response["messages"]] == ["authorized"]


async def test_pending_messages_share_the_private_chat_cooldown(connected_world):
    world = connected_world
    target_id = world.characters[1].id
    await world.hub.handle(world.players[0], {
        "type": "chat.request", "target_character_id": target_id, "body": "first",
    })
    request_id = (await wait_for_frame(world.sockets[1], "chat.request"))["request"]["id"]
    for identifier in ("queued", "too-fast"):
        await world.hub.handle(world.players[0], {
            "type": "chat.request.message", "request_id": request_id,
            "target_character_id": target_id, "body": identifier, "client_message_id": identifier,
        })
    error = await wait_for_frame(world.sockets[0], "error")
    assert error == {"type": "error", "code": "private_chat_cooldown", "client_message_id": "too-fast"}
    await world.hub.handle(world.players[1], {
        "type": "chat.request.respond", "request_id": request_id, "accepted": True,
    })
    response = await wait_for_frame(world.sockets[1], "chat.request.responded")
    assert [message["body"] for message in response["messages"]] == ["first", "queued"]


async def test_expired_pending_request_rejects_a_queued_send(connected_world):
    world = connected_world
    target_id = world.characters[1].id
    await world.hub.handle(world.players[0], {
        "type": "chat.request", "target_character_id": target_id, "body": "first",
    })
    request_id = (await wait_for_frame(world.sockets[1], "chat.request"))["request"]["id"]
    if isinstance(world.hub, DistributedPikoWorldHub):
        await world.hub.redis.delete(
            f"piko:v1:chat:request:{request_id}", f"piko:v1:chat:request:messages:{request_id}",
        )
    else:
        world.hub._pending_chat_requests[request_id].expires_at = 0
    await world.hub.handle(world.players[0], {
        "type": "chat.request.message", "request_id": request_id,
        "target_character_id": target_id, "body": "too late", "client_message_id": "expired",
    })
    error = await wait_for_frame(world.sockets[0], "error")
    assert error == {
        "type": "error", "code": "chat_request_unavailable",
        "request_id": request_id, "client_message_id": "expired",
    }
    if isinstance(world.hub, PikoWorldHub):
        assert request_id not in world.hub._pending_chat_requests
    await world.hub.handle(world.players[1], {
        "type": "chat.request.respond", "request_id": request_id,
        "accepted": True, "client_message_id": "expired-response",
    })
    response_error = await wait_for_frame(world.sockets[1], "error")
    assert response_error["code"] == "chat_request_unavailable"
    assert response_error["client_message_id"] == "expired-response"


async def test_failed_acceptance_preserves_pending_messages_for_retry(connected_world, monkeypatch):
    world = connected_world
    if not isinstance(world.hub, DistributedPikoWorldHub):
        pytest.skip("Distributed storage handoff")
    target_id = world.characters[1].id
    await world.hub.handle(world.players[0], {
        "type": "chat.request", "target_character_id": target_id, "body": "first",
    })
    request_id = (await wait_for_frame(world.sockets[1], "chat.request"))["request"]["id"]
    await world.hub.handle(world.players[0], {
        "type": "chat.request.message", "request_id": request_id,
        "target_character_id": target_id, "body": "second",
    })
    original = world.hub.store.append_message

    async def fail_second(*args, **kwargs):
        if args[2] == "second":
            raise RuntimeError("Simulated storage failure")
        return await original(*args, **kwargs)

    monkeypatch.setattr(world.hub.store, "append_message", fail_second)
    response = {
        "type": "chat.request.respond", "request_id": request_id, "accepted": True,
        "client_message_id": "accept-attempt",
    }
    await world.hub.handle(world.players[1], response)
    assert (await wait_for_frame(world.sockets[1], "error")) == {
        "type": "error", "code": "chat_request_failed",
        "request_id": request_id, "client_message_id": "accept-attempt",
    }
    assert world.sockets[1] in world.hub._players
    assert await world.hub.redis.exists(f"piko:v1:chat:request:{request_id}")
    assert await world.hub.redis.llen(f"piko:v1:chat:request:messages:{request_id}") == 2
    assert not await world.hub.redis.sismember(world.hub._active_chat_key(target_id), world.characters[0].id)
    monkeypatch.setattr(world.hub.store, "append_message", original)
    await world.hub.handle(world.players[1], response)
    accepted = await wait_for_frame(world.sockets[1], "chat.request.responded")
    assert accepted["client_message_id"] == "accept-attempt"
    assert [message["body"] for message in accepted["messages"]] == ["first", "second"]
    assert world.hub.store.messages == ["first", "second"]


@pytest.mark.parametrize("operation", ["open_conversation", "append_message"])
async def test_pending_send_during_distributed_acceptance_is_included_in_the_accepted_batch(connected_world, monkeypatch, operation):
    world = connected_world
    if not isinstance(world.hub, DistributedPikoWorldHub):
        pytest.skip("Distributed storage handoff")
    started, release = asyncio.Event(), asyncio.Event()
    original = getattr(world.hub.store, operation)

    async def delayed(*args, **kwargs):
        started.set()
        await release.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(world.hub.store, operation, delayed)
    await world.hub.handle(world.players[0], {"type": "chat.request", "target_character_id": world.characters[1].id, "body": "first"})
    request = (await wait_for_frame(world.sockets[1], "chat.request"))["request"]
    accepting = asyncio.create_task(world.hub.handle(world.players[1], {"type": "chat.request.respond", "request_id": request["id"], "accepted": True}))
    await asyncio.wait_for(started.wait(), 3)
    try:
        await asyncio.wait_for(world.hub.handle(world.players[0], {
            "type": "chat.request.message", "request_id": request["id"], "target_character_id": world.characters[1].id,
            "body": "while accepting",
        }), timeout=3)
    finally:
        release.set()
        await asyncio.wait_for(accepting, 3)
    response = await wait_for_frame(world.sockets[1], "chat.request.responded")
    assert [message["body"] for message in response["messages"]] == ["first", "while accepting"]


async def test_seated_pose_is_in_movement_and_join_snapshots_and_resets_on_standing(connected_world):
    world = connected_world
    for player in world.players:
        await world.hub.handle(player, {"type": "scene.join", "scene_id": "town-hall-interior", "x": 1572, "y": 815})
    world.sockets[1].frames.clear()
    await world.hub.handle(world.players[0], {"type": "player.move", "x": 1572, "y": 680, "facing": "south", "seat_id": "hall-west-seat"})
    seated = await wait_for_frame(world.sockets[1], "player.moved")
    assert seated["player"]["seat_id"] == "hall-west-seat"
    third = Socket()
    character = replace(world.characters[1], id=str(uuid.uuid4()), user_id="carol", scene_id="town-hall-interior")
    await world.hub.join(third, user_id="carol", character=character)
    snapshot = await wait_for_frame(third, "world.snapshot")
    assert next(player for player in snapshot["players"] if player["character_id"] == world.characters[0].id)["seat_id"] == "hall-west-seat"
    await world.hub.disconnect(world.sockets[0])
    if isinstance(world.hub, DistributedPikoWorldHub):
        saved = next(location for user, location in reversed(world.hub.store.locations) if user == world.characters[0].user_id)
        assert (saved["x"], saved["y"]) == (1572, 815)
    else:
        saved = world.hub.store.get(world.characters[0].user_id)
        assert (saved.position_x, saved.position_y) == (1572, 815)


async def test_pose_clears_on_standing_and_scene_change_and_rejects_foreign_seats(connected_world):
    world = connected_world
    player = world.players[0]
    await world.hub.handle(player, {"type": "player.move", "x": 1490, "y": 496, "facing": "south", "seat_id": "welcome-east-bench"})
    assert player.seat_id == "welcome-east-bench"
    await asyncio.sleep(0.11)
    await world.hub.handle(player, {"type": "player.move", "x": 1490, "y": 566, "facing": "south", "seat_id": None})
    assert player.seat_id is None
    await asyncio.sleep(0.11)
    await world.hub.handle(player, {"type": "player.move", "x": 999, "y": 999, "facing": "south", "seat_id": "hall-east-seat"})
    assert (player.x, player.y) == (1490, 566)
    await asyncio.sleep(0.11)
    await world.hub.handle(player, {"type": "player.move", "x": 1490, "y": 496, "facing": "south", "seat_id": "welcome-east-bench"})
    await world.hub.handle(player, {"type": "scene.join", "scene_id": "artisan-market", "x": 500, "y": 700})
    assert player.seat_id is None


async def test_closed_scene_cannot_be_joined_or_restored(connected_world):
    world = connected_world
    await world.hub.handle(world.players[0], {"type": "scene.join", "scene_id": "wind-garden-gate", "x": 1, "y": 2})
    rejected = await wait_for_frame(world.sockets[0], "error")
    assert rejected["code"] == "scene_not_open"
    assert world.players[0].scene_id == "welcome-courtyard"
    returning = replace(world.characters[0], scene_id="whispering-forest", position_x=20, position_y=30)
    player = await world.hub.join(Socket(), user_id=returning.user_id, character=returning)
    assert (player.scene_id, player.x, player.y) == ("welcome-courtyard", 1270, 480)


async def test_public_chat_has_a_six_second_server_cooldown(connected_world, monkeypatch):
    world = connected_world
    clock = [100.0]
    monkeypatch.setattr("novelvideo.piko.world.monotonic", lambda: clock[0])
    await world.hub.handle(world.players[0], {"type": "chat.send", "body": "first", "client_message_id": "public-first"})
    await wait_for_frame(world.sockets[0], "chat.sent")
    if isinstance(world.hub, DistributedPikoWorldHub):
        assert 5 <= await world.hub.redis.ttl(f"piko:v1:rate:scene-chat:{world.characters[0].id}") <= 6
    else:
        clock[0] += 5.999
        await world.hub.handle(world.players[0], {"type": "chat.send", "body": "too soon", "client_message_id": "public-early"})
        rejected = await wait_for_frame(world.sockets[0], "error")
        assert rejected["code"] == "chat_cooldown"
        world.sockets[0].frames.clear()
        clock[0] = 106.0
        await world.hub.handle(world.players[0], {"type": "chat.send", "body": "next", "client_message_id": "public-next"})
        assert (await wait_for_frame(world.sockets[0], "chat.sent"))["client_message_id"] == "public-next"


async def test_disconnect_ends_the_peers_private_session(world) -> None:
    await world.hub.disconnect(world.sockets[0])
    frame = await wait_for_frame(world.sockets[1], "chat.private.ended")
    assert frame["character_id"] == world.characters[0].id
    if isinstance(world.hub, DistributedPikoWorldHub):
        assert not await world.hub.redis.sismember(
            world.hub._active_chat_key(world.characters[1].id), world.characters[0].id
        )


async def test_shutdown_ends_private_sessions_and_clears_connected_players(world) -> None:
    await world.hub.close()
    assert not world.hub._players
    if isinstance(world.hub, DistributedPikoWorldHub):
        for character in world.characters:
            assert not await world.hub.redis.smembers(world.hub._active_chat_key(character.id))
    else:
        assert not world.hub._private_peers


async def test_replacement_ends_the_peers_private_session(world) -> None:
    replacement = Socket()
    await world.hub.join(replacement, user_id="alice", character=world.characters[0])
    await world.hub.disconnect(world.sockets[0])  # The old route's finally block.
    frame = await wait_for_frame(world.sockets[1], "chat.private.ended")
    assert frame["character_id"] == world.characters[0].id
    assert world.sockets[0].close_code == 4001


async def test_replaced_connection_cannot_broadcast_messages(world) -> None:
    await world.hub.join(Socket(), user_id="alice", character=world.characters[0])
    world.sockets[1].frames.clear()
    await world.hub.handle(world.players[0], {"type": "chat.send", "body": "stale connection"})
    assert not any(frame.get("type") == "chat.message" for frame in world.sockets[1].frames)


async def test_private_message_receipt_and_rate_rejection_are_correlated(world) -> None:
    await world.hub.handle(world.players[0], {
        "type": "chat.private.send", "target_character_id": world.characters[1].id,
        "body": "first", "client_message_id": "client-first",
    })
    receipt = await wait_for_frame(world.sockets[0], "chat.sent")
    assert receipt["client_message_id"] == "client-first"
    world.sockets[0].frames.clear()
    await world.hub.handle(world.players[0], {
        "type": "chat.private.send", "target_character_id": world.characters[1].id,
        "body": "second", "client_message_id": "client-second",
    })
    rejected = await wait_for_frame(world.sockets[0], "error")
    assert rejected == {"type": "error", "code": "private_chat_cooldown", "client_message_id": "client-second"}


async def test_ended_private_session_rejects_messages_with_their_identifier(world) -> None:
    await world.hub.disconnect(world.sockets[1])
    world.sockets[0].frames.clear()
    await world.hub.handle(world.players[0], {
        "type": "chat.private.send", "target_character_id": world.characters[1].id,
        "body": "still there?", "client_message_id": "client-ended",
    })
    rejected = await wait_for_frame(world.sockets[0], "error")
    assert rejected == {"type": "error", "code": "private_chat_unavailable", "client_message_id": "client-ended"}


async def test_profile_update_preserves_connection_and_existing_private_session(world) -> None:
    if isinstance(world.hub, DistributedPikoWorldHub):
        updated = replace(world.characters[0], nickname="Updated", bio="New bio")
        world.hub.store.characters["alice"] = updated
    else:
        world.hub.store.create_or_update("alice", nickname="Updated", gender="female", bio="New bio")
    await world.hub.handle(world.players[0], {"type": "profile.update"})
    updated_frame = await wait_for_frame(world.sockets[1], "player.updated")
    assert updated_frame["player"]["nickname"] == "Updated"
    assert updated_frame["player"]["bio"] == "New bio"
    assert world.sockets[0].close_code is None
    world.sockets[1].frames.clear()
    await world.hub.handle(world.players[0], {
        "type": "chat.private.send", "target_character_id": world.characters[1].id, "body": "after update",
    })
    message = await wait_for_frame(world.sockets[1], "chat.private.message")
    assert message["message"]["from_nickname"] == "Updated"


@pytest.mark.parametrize("accessory", ["dark-knight-mask", "red-bow", "diver-goggles", "bamboo-hat", "gary-snail", "wizard-hat"])
async def test_accessory_updates_reach_peers_movement_and_new_join_snapshots(connected_world, accessory):
    world = connected_world
    world.sockets[1].frames.clear()
    await world.hub.handle(world.players[0], {"type": "profile.update", "accessory_id": accessory})
    assert (await wait_for_frame(world.sockets[1], "player.updated"))["player"]["accessory_id"] == accessory
    await world.hub.handle(world.players[0], {"type": "player.move", "x": 1280, "y": 480, "facing": "south"})
    assert (await wait_for_frame(world.sockets[1], "player.moved"))["player"]["accessory_id"] == accessory
    third = Socket()
    character = replace(world.characters[1], id=str(uuid.uuid4()), user_id="carol")
    await world.hub.join(third, user_id="carol", character=character)
    snapshot = await wait_for_frame(third, "world.snapshot")
    assert next(player for player in snapshot["players"] if player["character_id"] == world.characters[0].id)["accessory_id"] == accessory
    world.sockets[1].frames.clear()
    await world.hub.handle(world.players[0], {"type": "profile.update", "accessory_id": None})
    assert (await wait_for_frame(world.sockets[1], "player.updated"))["player"]["accessory_id"] is None


@pytest.mark.parametrize("accessory", ["unknown", "../hat.png", {"id": "wizard-hat"}, 1])
async def test_invalid_equipment_cannot_replace_or_broadcast_the_current_selection(connected_world, accessory):
    world = connected_world
    await world.hub.handle(world.players[0], {"type": "profile.update", "accessory_id": "wizard-hat"})
    await wait_for_frame(world.sockets[1], "player.updated")
    world.sockets[1].frames.clear()
    await world.hub.handle(world.players[0], {"type": "profile.update", "accessory_id": accessory})
    assert (await wait_for_frame(world.sockets[0], "error"))["code"] == "invalid_accessory"
    assert world.players[0].accessory_id == "wizard-hat"
    assert not world.sockets[1].frames

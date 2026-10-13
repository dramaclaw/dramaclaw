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

    async def get(self, user_id: str) -> PikoCharacter | None:
        return self.characters.get(user_id)

    async def update_location(self, *args, **kwargs) -> None:
        pass

    async def open_conversation(self, *args) -> str:
        return str(uuid.uuid4())

    async def append_message(self, conversation_id: str, sender_id: str, body: str) -> dict[str, str]:
        self.messages.append(body)
        return {"id": str(uuid.uuid4()), "sent_at": datetime.now(timezone.utc).isoformat()}


async def wait_for_frame(socket: Socket, event: str) -> dict:
    async def wait() -> dict:
        while True:
            for frame in socket.frames:
                if frame.get("type") == event:
                    return frame
            await asyncio.sleep(0.01)
    return await asyncio.wait_for(wait(), timeout=3)


@pytest.fixture(params=["demo", "distributed"])
async def world(request: pytest.FixtureRequest, tmp_path: Path):
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
    await hub.handle(players[0], {"type": "chat.request", "target_character_id": characters[1].id})
    incoming = await wait_for_frame(sockets[1], "chat.request")
    await hub.handle(players[1], {"type": "chat.request.respond", "request_id": incoming["request"]["id"], "accepted": True})
    for socket in sockets:
        await wait_for_frame(socket, "chat.request.responded")
        socket.frames.clear()
    try:
        yield SimpleNamespace(hub=hub, sockets=sockets, players=players, characters=characters)
    finally:
        if isinstance(hub, DistributedPikoWorldHub):
            await hub.close()
        else:
            for socket in list(hub._players):
                await hub.disconnect(socket)


async def test_disconnect_ends_the_peers_private_session(world) -> None:
    await world.hub.disconnect(world.sockets[0])
    frame = await wait_for_frame(world.sockets[1], "chat.private.ended")
    assert frame["character_id"] == world.characters[0].id
    if isinstance(world.hub, DistributedPikoWorldHub):
        assert not await world.hub.redis.sismember(
            world.hub._active_chat_key(world.characters[1].id), world.characters[0].id
        )


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

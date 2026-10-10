from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import fakeredis.aioredis
import pytest

from novelvideo.piko.distributed import DistributedPikoWorldHub
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


@pytest.mark.asyncio
async def test_players_and_chat_cross_realtime_server_processes() -> None:
    server = fakeredis.FakeServer()
    store = FakeStore()
    first_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    second_hub = DistributedPikoWorldHub(store, redis_url="redis://unused")  # type: ignore[arg-type]
    first_hub.redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    second_hub.redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
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

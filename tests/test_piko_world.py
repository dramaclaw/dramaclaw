from __future__ import annotations

from pathlib import Path

import pytest

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

    await hub.disconnect(first_socket)  # type: ignore[arg-type]
    restored = store.get("user-a")
    assert restored is not None
    assert (restored.position_x, restored.position_y, restored.facing) == (321, 654, "east")


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

"""Small-scale, single-process realtime world state for Piko World."""

from __future__ import annotations

import asyncio
import json
import math
import sqlite3
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Any

from fastapi import WebSocket

from novelvideo import config

DEFAULT_SCENE_ID = "welcome-courtyard"
DEFAULT_X = 1270.0
DEFAULT_Y = 480.0
MAX_COORDINATE = 10000.0
CHAT_COOLDOWN_SECONDS = 3.0
CHAT_MAX_LENGTH = 80
PRIVATE_CHAT_COOLDOWN_SECONDS = 0.5


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _valid_coordinate(value: float) -> bool:
    return math.isfinite(value) and -MAX_COORDINATE <= value <= MAX_COORDINATE


@dataclass(frozen=True)
class PikoCharacter:
    id: str
    user_id: str
    nickname: str
    gender: str
    bio: str
    scene_id: str
    position_x: float
    position_y: float
    facing: str
    created_at: str
    updated_at: str

    def public_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("user_id", None)
        return data


class PikoCharacterStore:
    """SQLite persistence for one Piko character per authenticated account."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or Path(config.STATE_DIR) / "piko" / "world.db"
        self._lock = threading.RLock()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS piko_characters (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL UNIQUE,
                nickname TEXT NOT NULL,
                gender TEXT NOT NULL CHECK (gender IN ('male', 'female')),
                bio TEXT NOT NULL DEFAULT '',
                scene_id TEXT NOT NULL DEFAULT 'welcome-courtyard',
                position_x REAL NOT NULL DEFAULT 1270,
                position_y REAL NOT NULL DEFAULT 480,
                facing TEXT NOT NULL DEFAULT 'south',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        return connection

    @staticmethod
    def _character(row: sqlite3.Row | None) -> PikoCharacter | None:
        return PikoCharacter(**dict(row)) if row is not None else None

    def get(self, user_id: str) -> PikoCharacter | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM piko_characters WHERE user_id = ?", (user_id,)
            ).fetchone()
            return self._character(row)

    def create_or_update(
        self, user_id: str, *, nickname: str, gender: str, bio: str = ""
    ) -> PikoCharacter:
        now = _utc_now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO piko_characters (
                    id, user_id, nickname, gender, bio, scene_id,
                    position_x, position_y, facing, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'south', ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    nickname = excluded.nickname,
                    gender = excluded.gender,
                    bio = excluded.bio,
                    updated_at = excluded.updated_at
                """,
                (
                    str(uuid.uuid4()), user_id, nickname, gender, bio,
                    DEFAULT_SCENE_ID, DEFAULT_X, DEFAULT_Y, now, now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM piko_characters WHERE user_id = ?", (user_id,)
            ).fetchone()
            character = self._character(row)
            if character is None:  # pragma: no cover - protected by the upsert
                raise RuntimeError("Piko character upsert failed")
            return character

    def update_location(
        self, user_id: str, *, scene_id: str, x: float, y: float, facing: str
    ) -> None:
        if not _valid_coordinate(x) or not _valid_coordinate(y):
            return
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE piko_characters
                   SET scene_id = ?, position_x = ?, position_y = ?, facing = ?, updated_at = ?
                 WHERE user_id = ?
                """,
                (scene_id, x, y, facing, _utc_now(), user_id),
            )


@dataclass
class OnlinePlayer:
    character_id: str
    user_id: str
    nickname: str
    bio: str
    gender: str
    scene_id: str
    x: float
    y: float
    facing: str
    websocket: WebSocket
    instance_id: str = ""
    connection_token: str = ""
    last_chat_at: float = 0.0
    last_chat_request_at: float = 0.0
    last_private_chat_at: float = 0.0
    last_move_at: float = 0.0
    last_persist_at: float = 0.0

    def public_dict(self) -> dict[str, Any]:
        return {
            "character_id": self.character_id,
            "nickname": self.nickname,
            "bio": self.bio,
            "gender": self.gender,
            "scene_id": self.scene_id,
            "x": self.x,
            "y": self.y,
            "facing": self.facing,
        }


class PikoWorldHub:
    """In-memory scene rooms suitable for one API worker and small communities."""

    def __init__(self, store: PikoCharacterStore) -> None:
        self.store = store
        self._players: dict[WebSocket, OnlinePlayer] = {}
        self._pending_chat_requests: dict[str, tuple[WebSocket, WebSocket]] = {}
        self._private_peers: dict[WebSocket, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def join(
        self, websocket: WebSocket, *, user_id: str, character: PikoCharacter
    ) -> OnlinePlayer:
        player = OnlinePlayer(
            character_id=character.id,
            user_id=user_id,
            nickname=character.nickname,
            bio=character.bio,
            gender=character.gender,
            scene_id=character.scene_id,
            x=character.position_x,
            y=character.position_y,
            facing=character.facing,
            websocket=websocket,
            last_persist_at=monotonic(),
        )
        async with self._lock:
            replaced = [
                socket for socket, current in self._players.items()
                if current.user_id == user_id and socket is not websocket
            ]
            for socket in replaced:
                self._players.pop(socket, None)
            self._players[websocket] = player
            snapshot = [
                current.public_dict() for current in self._players.values()
                if current.scene_id == player.scene_id and current.websocket is not websocket
            ]
        for socket in replaced:
            await self._close_replaced(socket)
        await websocket.send_json({"type": "world.snapshot", "players": snapshot})
        await self._broadcast_scene(
            player.scene_id, {"type": "player.joined", "player": player.public_dict()},
            exclude=websocket,
        )
        return player

    async def handle(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        event_type = payload.get("type")
        if event_type == "player.move":
            await self._move(player, payload)
        elif event_type == "scene.join":
            await self._change_scene(player, payload)
        elif event_type == "chat.send":
            await self._chat(player, payload)
        elif event_type == "chat.request":
            await self._chat_request(player, payload)
        elif event_type == "chat.request.respond":
            await self._chat_request_response(player, payload)
        elif event_type == "chat.private.send":
            await self._private_chat(player, payload)
        elif event_type == "chat.private.end":
            await self._private_chat_end(player, payload)
        elif event_type == "ping":
            await player.websocket.send_json({"type": "pong"})

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            player = self._players.pop(websocket, None)
            self._pending_chat_requests = {
                request_id: pair
                for request_id, pair in self._pending_chat_requests.items()
                if websocket not in pair
            }
            peers = self._private_peers.pop(websocket, set())
            for peer_socket in peers:
                self._private_peers.get(peer_socket, set()).discard(websocket)
        if player is None:
            return
        for peer_socket in peers:
            try:
                await peer_socket.send_json(
                    {"type": "chat.private.ended", "character_id": player.character_id}
                )
            except Exception:  # noqa: BLE001 - disconnect cleanup is best effort
                pass
        self.store.update_location(
            player.user_id, scene_id=player.scene_id, x=player.x, y=player.y,
            facing=player.facing,
        )
        await self._broadcast_scene(
            player.scene_id,
            {"type": "player.left", "character_id": player.character_id},
        )

    async def _move(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        try:
            x, y = float(payload["x"]), float(payload["y"])
        except (KeyError, TypeError, ValueError):
            return
        facing = str(payload.get("facing") or player.facing)
        if not _valid_coordinate(x) or not _valid_coordinate(y):
            return
        if facing not in {"north", "south", "east", "west"}:
            return
        player.x, player.y, player.facing = x, y, facing
        await self._broadcast_scene(
            player.scene_id,
            {"type": "player.moved", "player": player.public_dict()},
            exclude=player.websocket,
        )
        now = monotonic()
        if now - player.last_persist_at >= 10:
            player.last_persist_at = now
            self.store.update_location(
                player.user_id, scene_id=player.scene_id, x=x, y=y, facing=facing
            )

    async def _change_scene(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        scene_id = str(payload.get("scene_id") or "").strip()
        if not scene_id or len(scene_id) > 80:
            return
        old_scene = player.scene_id
        if scene_id == old_scene:
            return
        await self._broadcast_scene(
            old_scene, {"type": "player.left", "character_id": player.character_id},
            exclude=player.websocket,
        )
        player.scene_id = scene_id
        try:
            x, y = float(payload["x"]), float(payload["y"])
            if _valid_coordinate(x) and _valid_coordinate(y):
                player.x, player.y = x, y
        except (KeyError, TypeError, ValueError):
            pass
        facing = str(payload.get("facing") or player.facing)
        if facing in {"north", "south", "east", "west"}:
            player.facing = facing
        async with self._lock:
            snapshot = [
                current.public_dict() for current in self._players.values()
                if current.scene_id == scene_id and current.websocket is not player.websocket
            ]
        await player.websocket.send_json({"type": "world.snapshot", "players": snapshot})
        await self._broadcast_scene(
            scene_id, {"type": "player.joined", "player": player.public_dict()},
            exclude=player.websocket,
        )

    async def _chat(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        body = str(payload.get("body") or "").strip()
        if not body or len(body) > CHAT_MAX_LENGTH:
            return
        now = monotonic()
        if now - player.last_chat_at < CHAT_COOLDOWN_SECONDS:
            await player.websocket.send_json(
                {"type": "error", "code": "chat_cooldown"}
            )
            return
        player.last_chat_at = now
        await self._broadcast_scene(
            player.scene_id,
            {
                "type": "chat.message",
                "message": {
                    "id": str(uuid.uuid4()),
                    "character_id": player.character_id,
                    "nickname": player.nickname,
                    "body": body,
                    "sent_at": _utc_now(),
                },
            },
        )

    async def _chat_request(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        target_id = str(payload.get("target_character_id") or "").strip()
        if not target_id or target_id == player.character_id:
            return
        now = monotonic()
        if now - player.last_chat_request_at < CHAT_COOLDOWN_SECONDS:
            await player.websocket.send_json(
                {"type": "error", "code": "chat_request_cooldown"}
            )
            return
        async with self._lock:
            target = next(
                (
                    current
                    for current in self._players.values()
                    if current.character_id == target_id
                    and current.scene_id == player.scene_id
                ),
                None,
            )
        if target is None:
            await player.websocket.send_json(
                {"type": "error", "code": "chat_request_target_unavailable"}
            )
            return
        request_id = str(uuid.uuid4())
        player.last_chat_request_at = now
        async with self._lock:
            self._pending_chat_requests[request_id] = (
                player.websocket,
                target.websocket,
            )
        try:
            await target.websocket.send_json(
                {
                    "type": "chat.request",
                    "request": {
                        "id": request_id,
                        "from_character_id": player.character_id,
                        "from_nickname": player.nickname,
                        "sent_at": _utc_now(),
                    },
                }
            )
            await player.websocket.send_json(
                {
                    "type": "chat.request.sent",
                    "request_id": request_id,
                    "target_character_id": target.character_id,
                }
            )
        except Exception:  # noqa: BLE001 - the target may disconnect mid-request
            async with self._lock:
                self._pending_chat_requests.pop(request_id, None)
            await self.disconnect(target.websocket)

    async def _chat_request_response(
        self, player: OnlinePlayer, payload: dict[str, Any]
    ) -> None:
        request_id = str(payload.get("request_id") or "").strip()
        accepted = payload.get("accepted") is True
        async with self._lock:
            pair = self._pending_chat_requests.get(request_id)
            if pair is None or pair[1] is not player.websocket:
                return
            self._pending_chat_requests.pop(request_id, None)
            sender_socket = pair[0]
            sender = self._players.get(sender_socket)
            if sender is None:
                return
            if accepted:
                self._private_peers.setdefault(sender_socket, set()).add(player.websocket)
                self._private_peers.setdefault(player.websocket, set()).add(sender_socket)
        frames = (
            (
                sender_socket,
                {
                    "character_id": player.character_id,
                    "nickname": player.nickname,
                },
            ),
            (
                player.websocket,
                {
                    "character_id": sender.character_id,
                    "nickname": sender.nickname,
                },
            ),
        )
        for socket, peer in frames:
            try:
                await socket.send_json(
                    {
                        "type": "chat.request.responded",
                        "request_id": request_id,
                        "accepted": accepted,
                        "peer": peer,
                    }
                )
            except Exception:  # noqa: BLE001 - the participant may disconnect
                pass

    async def _private_chat(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        target_id = str(payload.get("target_character_id") or "").strip()
        body = str(payload.get("body") or "").strip()
        if not target_id or not body or len(body) > CHAT_MAX_LENGTH:
            return
        now = monotonic()
        if now - player.last_private_chat_at < PRIVATE_CHAT_COOLDOWN_SECONDS:
            return
        async with self._lock:
            target_socket = next(
                (
                    socket
                    for socket, current in self._players.items()
                    if current.character_id == target_id
                    and socket in self._private_peers.get(player.websocket, set())
                ),
                None,
            )
            target = self._players.get(target_socket) if target_socket else None
        if target_socket is None or target is None:
            return
        player.last_private_chat_at = now
        frame = {
            "type": "chat.private.message",
            "message": {
                "id": str(uuid.uuid4()),
                "from_character_id": player.character_id,
                "to_character_id": target.character_id,
                "from_nickname": player.nickname,
                "body": body,
                "sent_at": _utc_now(),
            },
        }
        for socket in (player.websocket, target_socket):
            try:
                await socket.send_json(frame)
            except Exception:  # noqa: BLE001 - delivery to the other participant continues
                pass

    async def _private_chat_end(
        self, player: OnlinePlayer, payload: dict[str, Any]
    ) -> None:
        target_id = str(payload.get("target_character_id") or "").strip()
        async with self._lock:
            target_socket = next(
                (
                    socket
                    for socket, current in self._players.items()
                    if current.character_id == target_id
                    and socket in self._private_peers.get(player.websocket, set())
                ),
                None,
            )
            if target_socket is None:
                return
            self._private_peers.get(player.websocket, set()).discard(target_socket)
            self._private_peers.get(target_socket, set()).discard(player.websocket)
        try:
            await target_socket.send_json(
                {"type": "chat.private.ended", "character_id": player.character_id}
            )
        except Exception:  # noqa: BLE001 - the peer may already be gone
            pass

    async def _broadcast_scene(
        self, scene_id: str, payload: dict[str, Any], *, exclude: WebSocket | None = None
    ) -> None:
        async with self._lock:
            sockets = [
                current.websocket for current in self._players.values()
                if current.scene_id == scene_id and current.websocket is not exclude
            ]
        stale: list[WebSocket] = []
        for socket in sockets:
            try:
                await socket.send_json(payload)
            except Exception:  # noqa: BLE001 - a broadcast must survive one stale peer
                stale.append(socket)
        for socket in stale:
            await self.disconnect(socket)

    @staticmethod
    async def _close_replaced(websocket: WebSocket) -> None:
        try:
            await websocket.send_json({"type": "session.replaced"})
            await websocket.close(code=4001)
        except Exception:  # noqa: BLE001 - already disconnected
            pass


character_store = PikoCharacterStore()
world_hub = PikoWorldHub(character_store)


def parse_client_payload(raw: str) -> dict[str, Any] | None:
    if len(raw) > 2048:
        return None
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, dict) else None

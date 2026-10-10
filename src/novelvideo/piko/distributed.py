"""PostgreSQL + Redis backend for horizontally scalable Piko World servers."""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
import uuid
from datetime import datetime, timezone
from time import monotonic, time
from typing import Any

import asyncpg
import redis.asyncio as aioredis
from fastapi import WebSocket

from novelvideo.piko.world import (
    CHAT_COOLDOWN_SECONDS,
    CHAT_MAX_LENGTH,
    DEFAULT_SCENE_ID,
    DEFAULT_X,
    DEFAULT_Y,
    PRIVATE_CHAT_COOLDOWN_SECONDS,
    OnlinePlayer,
    PikoCharacter,
)

KEY_PREFIX = "piko:v1:"
EVENT_CHANNEL = f"{KEY_PREFIX}events"
PRESENCE_TTL_SECONDS = 30
ROOM_TTL_SECONDS = 60
CHAT_REQUEST_TTL_SECONDS = 300
ACTIVE_CHAT_TTL_SECONDS = 86400
HEARTBEAT_SECONDS = 10
CLIENT_STALE_SECONDS = 75
LOCATION_PERSIST_SECONDS = 10
MOVE_MIN_INTERVAL_SECONDS = 0.08


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _valid_coordinate(value: float) -> bool:
    return math.isfinite(value) and -10000 <= value <= 10000


def _as_iso(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


class DistributedCharacterStore:
    """Durable Piko data in the existing SuperTale control-plane PostgreSQL."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None
        self._pool_lock = asyncio.Lock()

    async def _get_pool(self) -> asyncpg.Pool:
        if self._pool is not None:
            return self._pool
        async with self._pool_lock:
            if self._pool is None:
                self._pool = await asyncpg.create_pool(
                    self._dsn,
                    min_size=1,
                    max_size=_env_int("PIKO_WORLD_PG_POOL_MAX", 10, minimum=1, maximum=50),
                    command_timeout=10,
                )
        return self._pool

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @staticmethod
    def _character(row: asyncpg.Record | None) -> PikoCharacter | None:
        if row is None:
            return None
        return PikoCharacter(
            id=str(row["id"]),
            user_id=str(row["user_id"]),
            nickname=row["nickname"],
            gender=row["gender"],
            bio=row["bio"],
            scene_id=row["scene_id"],
            position_x=float(row["position_x"]),
            position_y=float(row["position_y"]),
            facing=row["facing"],
            created_at=_as_iso(row["created_at"]),
            updated_at=_as_iso(row["updated_at"]),
        )

    async def get(self, user_id: str) -> PikoCharacter | None:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            """
            SELECT c.id, c.user_id, c.nickname, c.gender, c.bio,
                   l.scene_id, l.position_x, l.position_y, l.facing,
                   c.created_at, GREATEST(c.updated_at, l.updated_at) AS updated_at
              FROM piko_characters c
              JOIN piko_character_locations l ON l.character_id = c.id
             WHERE c.user_id = $1
            """,
            user_id,
        )
        return self._character(row)

    async def create_or_update(
        self, user_id: str, *, nickname: str, gender: str, bio: str = ""
    ) -> PikoCharacter:
        pool = await self._get_pool()
        async with pool.acquire() as connection, connection.transaction():
            character_id = await connection.fetchval(
                """
                INSERT INTO piko_characters (id, user_id, nickname, gender, bio)
                VALUES ($1::uuid, $2, $3, $4, $5)
                ON CONFLICT (user_id) DO UPDATE SET
                    nickname = EXCLUDED.nickname,
                    gender = EXCLUDED.gender,
                    bio = EXCLUDED.bio,
                    updated_at = now()
                RETURNING id
                """,
                str(uuid.uuid4()),
                user_id,
                nickname,
                gender,
                bio,
            )
            await connection.execute(
                """
                INSERT INTO piko_character_locations (
                    character_id, scene_id, position_x, position_y, facing
                ) VALUES ($1, $2, $3, $4, 'south')
                ON CONFLICT (character_id) DO NOTHING
                """,
                character_id,
                DEFAULT_SCENE_ID,
                DEFAULT_X,
                DEFAULT_Y,
            )
        character = await self.get(user_id)
        if character is None:  # pragma: no cover - protected by the transaction
            raise RuntimeError("Piko character upsert failed")
        return character

    async def update_location(
        self, user_id: str, *, scene_id: str, x: float, y: float, facing: str
    ) -> None:
        if not _valid_coordinate(x) or not _valid_coordinate(y):
            return
        pool = await self._get_pool()
        await pool.execute(
            """
            UPDATE piko_character_locations l
               SET scene_id = $2, position_x = $3, position_y = $4,
                   facing = $5, updated_at = now()
              FROM piko_characters c
             WHERE c.id = l.character_id AND c.user_id = $1
            """,
            user_id,
            scene_id,
            x,
            y,
            facing,
        )

    async def open_conversation(self, first_id: str, second_id: str) -> str:
        character_a, character_b = sorted((first_id, second_id))
        pool = await self._get_pool()
        async with pool.acquire() as connection, connection.transaction():
            value = await connection.fetchval(
                """
                INSERT INTO piko_chat_conversations (id, character_a_id, character_b_id)
                VALUES ($1::uuid, $2::uuid, $3::uuid)
                ON CONFLICT (character_a_id, character_b_id) DO UPDATE
                    SET updated_at = now()
                RETURNING id
                """,
                str(uuid.uuid4()),
                character_a,
                character_b,
            )
            await connection.executemany(
                """
                INSERT INTO piko_chat_participants (conversation_id, character_id)
                VALUES ($1, $2::uuid)
                ON CONFLICT DO NOTHING
                """,
                [(value, character_a), (value, character_b)],
            )
        return str(value)

    async def append_message(
        self, conversation_id: str, sender_id: str, body: str
    ) -> dict[str, str]:
        message_id = str(uuid.uuid4())
        sent_at = datetime.now(timezone.utc)
        pool = await self._get_pool()
        await pool.execute(
            """
            INSERT INTO piko_chat_messages (id, conversation_id, sender_character_id, body, sent_at)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
            """,
            message_id,
            conversation_id,
            sender_id,
            body,
            sent_at,
        )
        return {"id": message_id, "sent_at": sent_at.isoformat()}


class DistributedPikoWorldHub:
    """Cross-process rooms backed by Redis Pub/Sub and expiring presence records."""

    def __init__(self, store: DistributedCharacterStore, *, redis_url: str) -> None:
        self.store = store
        self.instance_id = os.environ.get("ST_WORKER_ID", "piko") + ":" + uuid.uuid4().hex[:10]
        self.scene_capacity = _env_int(
            "PIKO_WORLD_SCENE_CAPACITY", 100, minimum=10, maximum=500
        )
        self.max_scene_instances = _env_int(
            "PIKO_WORLD_MAX_SCENE_INSTANCES", 1000, minimum=1, maximum=10000
        )
        self.redis = aioredis.Redis.from_url(
            redis_url,
            decode_responses=True,
            socket_timeout=3,
            socket_connect_timeout=3,
            health_check_interval=20,
        )
        self._players: dict[WebSocket, OnlinePlayer] = {}
        self._players_by_character: dict[str, OnlinePlayer] = {}
        self._send_locks: dict[WebSocket, asyncio.Lock] = {}
        self._lock = asyncio.Lock()
        self._pubsub_task: asyncio.Task | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._pubsub_ready = asyncio.Event()

    @staticmethod
    def _player_key(character_id: str) -> str:
        return f"{KEY_PREFIX}player:{character_id}"

    @staticmethod
    def _route_key(character_id: str) -> str:
        return f"{KEY_PREFIX}connection:{character_id}"

    @staticmethod
    def _presence_key(user_id: str) -> str:
        return f"{KEY_PREFIX}online:user:{user_id}"

    @staticmethod
    def _room_key(room_id: str) -> str:
        return f"{KEY_PREFIX}room:{room_id}:players"

    @staticmethod
    def _active_chat_key(character_id: str) -> str:
        return f"{KEY_PREFIX}chat:active:{character_id}"

    async def _ensure_tasks(self) -> None:
        if self._pubsub_task is None or self._pubsub_task.done():
            self._pubsub_ready.clear()
            self._pubsub_task = asyncio.create_task(self._listen_events())
            await asyncio.wait_for(self._pubsub_ready.wait(), timeout=5)
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def join(
        self, websocket: WebSocket, *, user_id: str, character: PikoCharacter
    ) -> OnlinePlayer:
        await self._ensure_tasks()
        connection_token = f"{self.instance_id}:{uuid.uuid4().hex}"
        room_id = await self._allocate_room(character.scene_id, character.id)
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
            instance_id=room_id,
            connection_token=connection_token,
            last_persist_at=monotonic(),
        )
        async with self._lock:
            replaced = self._players_by_character.get(character.id)
            if replaced is not None:
                self._players.pop(replaced.websocket, None)
                self._send_locks.pop(replaced.websocket, None)
            self._players[websocket] = player
            self._players_by_character[character.id] = player
            self._send_locks[websocket] = asyncio.Lock()
        if replaced is not None:
            await self._close_replaced(replaced.websocket)

        previous = await self.redis.get(self._presence_key(user_id))
        await self._refresh_player(player)
        if previous:
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                old = json.loads(previous)
                old_instance = old.get("server_instance")
                if old_instance and old_instance != self.instance_id:
                    await self._publish(
                        "direct",
                        {"type": "session.replaced"},
                        target_character_id=character.id,
                        target_instance=old_instance,
                    )
        snapshot = await self._room_snapshot(room_id, exclude=character.id)
        await self._safe_send(websocket, {"type": "world.snapshot", "players": snapshot})
        await self._publish(
            "room",
            {"type": "player.joined", "player": player.public_dict()},
            room_id=room_id,
            exclude_character_id=character.id,
        )
        return player

    async def handle(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        player.last_seen_at = monotonic()
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
            await self._refresh_player(player)
            await self._safe_send(player.websocket, {"type": "pong"})

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            player = self._players.pop(websocket, None)
            self._send_locks.pop(websocket, None)
            if player is not None and self._players_by_character.get(player.character_id) is player:
                self._players_by_character.pop(player.character_id, None)
        if player is None:
            return
        removed = await self.redis.eval(
            """
            if redis.call('GET', KEYS[1]) ~= ARGV[1] then
                return 0
            end
            redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
            redis.call('ZREM', KEYS[4], ARGV[2])
            return 1
            """,
            4,
            self._route_key(player.character_id),
            self._presence_key(player.user_id),
            self._player_key(player.character_id),
            self._room_key(player.instance_id),
            player.connection_token,
            player.character_id,
        )
        if removed:
            await self.store.update_location(
                player.user_id,
                scene_id=player.scene_id,
                x=player.x,
                y=player.y,
                facing=player.facing,
            )
            await self._publish(
                "room",
                {"type": "player.left", "character_id": player.character_id},
                room_id=player.instance_id,
            )

    async def close(self) -> None:
        """Release background subscriptions during a graceful server shutdown."""
        async with self._lock:
            sockets = list(self._players)
        for websocket in sockets:
            await self.disconnect(websocket)
        tasks = [task for task in (self._pubsub_task, self._heartbeat_task) if task]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.redis.aclose()
        close_store = getattr(self.store, "close", None)
        if close_store is not None:
            await close_store()

    async def _move(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        now = monotonic()
        if now - player.last_move_at < MOVE_MIN_INTERVAL_SECONDS:
            return
        try:
            x, y = float(payload["x"]), float(payload["y"])
        except (KeyError, TypeError, ValueError):
            return
        facing = str(payload.get("facing") or player.facing)
        if not _valid_coordinate(x) or not _valid_coordinate(y):
            return
        if facing not in {"north", "south", "east", "west"}:
            return
        player.last_move_at = now
        player.x, player.y, player.facing = x, y, facing
        await self._refresh_player(player)
        await self._publish(
            "room",
            {"type": "player.moved", "player": player.public_dict()},
            room_id=player.instance_id,
            exclude_character_id=player.character_id,
        )
        if now - player.last_persist_at >= LOCATION_PERSIST_SECONDS:
            player.last_persist_at = now
            await self.store.update_location(
                player.user_id, scene_id=player.scene_id, x=x, y=y, facing=facing
            )

    async def _change_scene(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        scene_id = str(payload.get("scene_id") or "").strip()
        if not scene_id or len(scene_id) > 80 or scene_id == player.scene_id:
            return
        old_room = player.instance_id
        await self.redis.zrem(self._room_key(old_room), player.character_id)
        await self._publish(
            "room",
            {"type": "player.left", "character_id": player.character_id},
            room_id=old_room,
            exclude_character_id=player.character_id,
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
        player.instance_id = await self._allocate_room(scene_id, player.character_id)
        await self._refresh_player(player)
        await self.store.update_location(
            player.user_id,
            scene_id=scene_id,
            x=player.x,
            y=player.y,
            facing=player.facing,
        )
        snapshot = await self._room_snapshot(player.instance_id, exclude=player.character_id)
        await self._safe_send(
            player.websocket, {"type": "world.snapshot", "players": snapshot}
        )
        await self._publish(
            "room",
            {"type": "player.joined", "player": player.public_dict()},
            room_id=player.instance_id,
            exclude_character_id=player.character_id,
        )

    async def _chat(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        body = str(payload.get("body") or "").strip()
        if not body or len(body) > CHAT_MAX_LENGTH:
            return
        allowed = await self.redis.set(
            f"{KEY_PREFIX}rate:scene-chat:{player.character_id}",
            "1",
            ex=max(1, int(CHAT_COOLDOWN_SECONDS)),
            nx=True,
        )
        if not allowed:
            await self._safe_send(player.websocket, {"type": "error", "code": "chat_cooldown"})
            return
        await self._publish(
            "room",
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
            room_id=player.instance_id,
        )

    async def _chat_request(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        target_id = str(payload.get("target_character_id") or "").strip()
        if not target_id or target_id == player.character_id:
            return
        allowed = await self.redis.set(
            f"{KEY_PREFIX}rate:chat-request:{player.character_id}",
            "1",
            ex=max(1, int(CHAT_COOLDOWN_SECONDS)),
            nx=True,
        )
        if not allowed:
            await self._safe_send(
                player.websocket, {"type": "error", "code": "chat_request_cooldown"}
            )
            return
        target = await self._redis_player(target_id)
        if target is None or target.get("room_id") != player.instance_id:
            await self._safe_send(
                player.websocket,
                {"type": "error", "code": "chat_request_target_unavailable"},
            )
            return
        request_id = str(uuid.uuid4())
        request = {
            "id": request_id,
            "from_character_id": player.character_id,
            "from_nickname": player.nickname,
            "to_character_id": target_id,
            "sent_at": _utc_now(),
        }
        await self.redis.set(
            f"{KEY_PREFIX}chat:request:{request_id}",
            json.dumps(request, ensure_ascii=False),
            ex=CHAT_REQUEST_TTL_SECONDS,
        )
        await self._publish(
            "direct",
            {"type": "chat.request", "request": {k: v for k, v in request.items() if k != "to_character_id"}},
            target_character_id=target_id,
        )
        await self._safe_send(
            player.websocket,
            {
                "type": "chat.request.sent",
                "request_id": request_id,
                "target_character_id": target_id,
            },
        )

    async def _chat_request_response(
        self, player: OnlinePlayer, payload: dict[str, Any]
    ) -> None:
        request_id = str(payload.get("request_id") or "").strip()
        request_key = f"{KEY_PREFIX}chat:request:{request_id}"
        raw = await self.redis.get(request_key)
        if not raw:
            return
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            return
        if request.get("to_character_id") != player.character_id:
            return
        claimed = await self.redis.eval(
            """
            if redis.call('GET', KEYS[1]) ~= ARGV[1] then
                return 0
            end
            redis.call('DEL', KEYS[1])
            return 1
            """,
            1,
            request_key,
            raw,
        )
        if not claimed:
            return
        sender_id = str(request.get("from_character_id") or "")
        accepted = payload.get("accepted") is True
        sender = await self._redis_player(sender_id)
        if sender is None:
            return
        conversation_id = None
        if accepted:
            conversation_id = await self.store.open_conversation(sender_id, player.character_id)
            pipe = self.redis.pipeline(transaction=True)
            pipe.sadd(self._active_chat_key(sender_id), player.character_id)
            pipe.expire(self._active_chat_key(sender_id), ACTIVE_CHAT_TTL_SECONDS)
            pipe.sadd(self._active_chat_key(player.character_id), sender_id)
            pipe.expire(self._active_chat_key(player.character_id), ACTIVE_CHAT_TTL_SECONDS)
            await pipe.execute()
        common = {
            "type": "chat.request.responded",
            "request_id": request_id,
            "accepted": accepted,
            "conversation_id": conversation_id,
        }
        await self._publish(
            "direct",
            {**common, "peer": {"character_id": player.character_id, "nickname": player.nickname}},
            target_character_id=sender_id,
        )
        await self._publish(
            "direct",
            {
                **common,
                "peer": {
                    "character_id": sender_id,
                    "nickname": str(sender.get("nickname") or ""),
                },
            },
            target_character_id=player.character_id,
        )

    async def _private_chat(self, player: OnlinePlayer, payload: dict[str, Any]) -> None:
        target_id = str(payload.get("target_character_id") or "").strip()
        body = str(payload.get("body") or "").strip()
        if not target_id or not body or len(body) > CHAT_MAX_LENGTH:
            return
        if not await self.redis.sismember(self._active_chat_key(player.character_id), target_id):
            return
        allowed = await self.redis.set(
            f"{KEY_PREFIX}rate:private-chat:{player.character_id}",
            "1",
            px=max(100, int(PRIVATE_CHAT_COOLDOWN_SECONDS * 1000)),
            nx=True,
        )
        if not allowed:
            return
        conversation_id = await self.store.open_conversation(player.character_id, target_id)
        stored = await self.store.append_message(conversation_id, player.character_id, body)
        frame = {
            "type": "chat.private.message",
            "message": {
                "id": stored["id"],
                "conversation_id": conversation_id,
                "from_character_id": player.character_id,
                "to_character_id": target_id,
                "from_nickname": player.nickname,
                "body": body,
                "sent_at": stored["sent_at"],
            },
        }
        await self._publish(
            "direct", frame, target_character_ids=[player.character_id, target_id]
        )

    async def _private_chat_end(
        self, player: OnlinePlayer, payload: dict[str, Any]
    ) -> None:
        target_id = str(payload.get("target_character_id") or "").strip()
        if not target_id:
            return
        pipe = self.redis.pipeline(transaction=True)
        pipe.srem(self._active_chat_key(player.character_id), target_id)
        pipe.srem(self._active_chat_key(target_id), player.character_id)
        await pipe.execute()
        await self._publish(
            "direct",
            {"type": "chat.private.ended", "character_id": player.character_id},
            target_character_id=target_id,
        )

    async def _allocate_room(self, scene_id: str, character_id: str) -> str:
        cutoff = time() - PRESENCE_TTL_SECONDS
        for shard in range(1, self.max_scene_instances + 1):
            room_id = f"{scene_id}:{shard}"
            key = self._room_key(room_id)
            allocated = await self.redis.eval(
                """
                redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
                if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
                    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
                    redis.call('EXPIRE', KEYS[1], ARGV[5])
                    return 1
                end
                if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then
                    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
                    redis.call('EXPIRE', KEYS[1], ARGV[5])
                    return 1
                end
                return 0
                """,
                1,
                key,
                character_id,
                cutoff,
                time(),
                self.scene_capacity,
                ROOM_TTL_SECONDS,
            )
            if allocated:
                return room_id
        raise RuntimeError(f"Piko scene {scene_id!r} has no available instances")

    async def _refresh_player(self, player: OnlinePlayer) -> None:
        data = {
            **player.public_dict(),
            "user_id": player.user_id,
            "room_id": player.instance_id,
            "server_instance": self.instance_id,
        }
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        presence = json.dumps(
            {
                "character_id": player.character_id,
                "server_instance": self.instance_id,
                "room_id": player.instance_id,
            },
            separators=(",", ":"),
        )
        pipe = self.redis.pipeline(transaction=True)
        pipe.set(self._route_key(player.character_id), player.connection_token, ex=PRESENCE_TTL_SECONDS)
        pipe.set(self._presence_key(player.user_id), presence, ex=PRESENCE_TTL_SECONDS)
        pipe.set(self._player_key(player.character_id), encoded, ex=PRESENCE_TTL_SECONDS)
        pipe.zadd(self._room_key(player.instance_id), {player.character_id: time()})
        pipe.expire(self._room_key(player.instance_id), ROOM_TTL_SECONDS)
        await pipe.execute()

    async def _room_snapshot(
        self, room_id: str, *, exclude: str | None = None
    ) -> list[dict[str, Any]]:
        key = self._room_key(room_id)
        cutoff = time() - PRESENCE_TTL_SECONDS
        await self.redis.zremrangebyscore(key, "-inf", cutoff)
        character_ids = await self.redis.zrangebyscore(key, cutoff, "+inf")
        character_ids = [value for value in character_ids if value != exclude]
        if not character_ids:
            return []
        values = await self.redis.mget([self._player_key(value) for value in character_ids])
        players: list[dict[str, Any]] = []
        for value in values:
            if not value:
                continue
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                player = json.loads(value)
                if player.get("room_id") == room_id:
                    players.append(
                        {
                            key: player[key]
                            for key in (
                                "character_id",
                                "nickname",
                                "bio",
                                "gender",
                                "scene_id",
                                "x",
                                "y",
                                "facing",
                            )
                        }
                    )
        return players

    async def _redis_player(self, character_id: str) -> dict[str, Any] | None:
        raw = await self.redis.get(self._player_key(character_id))
        if not raw:
            return None
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) else None

    async def _publish(
        self,
        scope: str,
        payload: dict[str, Any],
        *,
        room_id: str | None = None,
        exclude_character_id: str | None = None,
        target_character_id: str | None = None,
        target_character_ids: list[str] | None = None,
        target_instance: str | None = None,
    ) -> None:
        envelope = {
            "scope": scope,
            "payload": payload,
            "room_id": room_id,
            "exclude_character_id": exclude_character_id,
            "target_character_id": target_character_id,
            "target_character_ids": target_character_ids,
            "target_instance": target_instance,
        }
        await self.redis.publish(
            EVENT_CHANNEL, json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
        )

    async def _listen_events(self) -> None:
        while True:
            pubsub = self.redis.pubsub(ignore_subscribe_messages=True)
            try:
                await pubsub.subscribe(EVENT_CHANNEL)
                self._pubsub_ready.set()
                while True:
                    # Poll below the Redis client's socket timeout. A blocking
                    # pubsub.listen() otherwise dies whenever the room is idle.
                    item = await pubsub.get_message(timeout=1.0)
                    if item is None or item.get("type") != "message":
                        continue
                    try:
                        envelope = json.loads(item["data"])
                    except (json.JSONDecodeError, TypeError):
                        continue
                    target_instance = envelope.get("target_instance")
                    if target_instance and target_instance != self.instance_id:
                        continue
                    async with self._lock:
                        players = list(self._players.values())
                    scope = envelope.get("scope")
                    if scope == "room":
                        recipients = [
                            player
                            for player in players
                            if player.instance_id == envelope.get("room_id")
                            and player.character_id != envelope.get("exclude_character_id")
                        ]
                    else:
                        targets = set(envelope.get("target_character_ids") or [])
                        if envelope.get("target_character_id"):
                            targets.add(envelope["target_character_id"])
                        recipients = [
                            player for player in players if player.character_id in targets
                        ]
                    for player in recipients:
                        if envelope.get("payload", {}).get("type") == "session.replaced":
                            await self._close_replaced(player.websocket)
                        else:
                            await self._safe_send(player.websocket, envelope["payload"])
            except asyncio.CancelledError:
                raise
            except Exception:
                # Redis may briefly reset an idle subscription. Keep the task
                # alive so existing browser sessions continue receiving events.
                await asyncio.sleep(1)
            finally:
                await pubsub.aclose()

    async def _heartbeat_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                await self._heartbeat_once()
        except asyncio.CancelledError:
            raise

    async def _heartbeat_once(self) -> None:
        """Refresh active clients and evict connections that stopped talking to us."""
        async with self._lock:
            players = list(self._players.values())
        cutoff = monotonic() - CLIENT_STALE_SECONDS
        for player in players:
            if player.last_seen_at <= cutoff:
                # Do not keep renewing Redis presence for a half-open browser socket.
                # Removing presence first also broadcasts player.left immediately.
                with contextlib.suppress(Exception):
                    await self.disconnect(player.websocket)
                with contextlib.suppress(Exception):
                    await player.websocket.close(code=1001)
                continue
            with contextlib.suppress(Exception):
                await self._refresh_player(player)

    async def _safe_send(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        lock = self._send_locks.get(websocket)
        if lock is None:
            return
        try:
            async with lock:
                await websocket.send_json(payload)
        except Exception:
            asyncio.create_task(self.disconnect(websocket))

    @staticmethod
    async def _close_replaced(websocket: WebSocket) -> None:
        try:
            await websocket.send_json({"type": "session.replaced"})
            await websocket.close(code=4001)
        except Exception:
            pass

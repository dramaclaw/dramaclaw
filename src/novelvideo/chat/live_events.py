"""Best-effort live chat event fan-out for server-originated messages."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

from novelvideo.chat.store import ChatScope


_connections: dict[tuple[str, str, str], set[WebSocket]] = defaultdict(set)
_connection_keys: dict[WebSocket, tuple[str, str, str]] = {}
_lock = asyncio.Lock()


def _scope_key(username: str, scope: ChatScope) -> tuple[str, str, str]:
    surface = scope.surface or ("director" if scope.kind == "project" else "")
    return username, str(scope.id or ""), surface


async def register_chat_websocket(
    websocket: WebSocket,
    *,
    username: str,
    scope: ChatScope,
) -> None:
    async with _lock:
        previous = _connection_keys.pop(websocket, None)
        if previous is not None:
            _connections[previous].discard(websocket)
            if not _connections[previous]:
                _connections.pop(previous, None)
        key = _scope_key(username, scope)
        _connections[key].add(websocket)
        _connection_keys[websocket] = key


async def unregister_chat_websocket(websocket: WebSocket) -> None:
    async with _lock:
        key = _connection_keys.pop(websocket, None)
        if key is None:
            return
        _connections[key].discard(websocket)
        if not _connections[key]:
            _connections.pop(key, None)


async def broadcast_project_chat_event(
    *,
    username: str,
    project_id: str,
    payload: dict[str, Any],
) -> None:
    key = (username, project_id, "director")
    async with _lock:
        sockets = list(_connections.get(key, ()))
    stale: list[WebSocket] = []
    for websocket in sockets:
        try:
            await websocket.send_json(payload)
        except Exception:
            stale.append(websocket)
    for websocket in stale:
        await unregister_chat_websocket(websocket)

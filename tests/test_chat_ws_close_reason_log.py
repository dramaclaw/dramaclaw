from __future__ import annotations

import logging

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import chat as chat_routes

COOKIE_SECRET = "session_cookie_canary_9f4a"
TOKEN_SECRET = "bearer_token_canary_7c2b"
BODY_SECRET = "private_chat_body_canary_3d1e"


class _WebSocket:
    client = ("127.0.0.1", 12345)
    cookies = {chat_routes.AUTH_COOKIE_NAME: COOKIE_SECRET}
    headers = {"authorization": f"Bearer {TOKEN_SECRET}"}

    def __init__(self, events):
        self.events = iter(events)
        self.sent = []
        self.close_codes = []

    async def accept(self):
        pass

    async def receive_json(self):
        return next(self.events)

    async def send_json(self, payload):
        self.sent.append(payload)

    async def close(self, code):
        self.close_codes.append(code)


@pytest.mark.parametrize(
    "failure_point,error,scope_kind",
    [
        ("scope_changed", RuntimeError("history store unavailable"), "home"),
        ("enforce_scope", HTTPException(403, "forbidden scope"), "home"),
        ("scope.set", HTTPException(401, "session expired"), "project"),
        ("chat.message", HTTPException(401, "session expired"), "project"),
    ],
    ids=["initial-history", "initial-scope", "scope-set-reauth", "message-reauth"],
)
async def test_unauthorized_ws_close_logs_reason(
    monkeypatch, caplog, failure_point, error, scope_kind,
):
    username = "close-log-user"
    user = {"id": "u1", "username": username}
    events = []
    if failure_point in {"scope.set", "chat.message"}:
        event = {"type": failure_point, "scope": {"kind": "project", "id": "proj"}}
        if failure_point == "chat.message":
            event["text"] = BODY_SECRET
        events.append(event)
    websocket = _WebSocket(events)

    async def authenticate(_websocket):
        return user

    async def send_scope_changed(_websocket, _user, _username, scope, _send_lock):
        if failure_point == "scope_changed":
            raise error
        return scope

    def enforce_scope(*args, **kwargs):
        if failure_point == "enforce_scope":
            raise error

    async def reject_reauthentication(*args, **kwargs):
        raise error

    async def follow_scope_turn(**kwargs):
        pass

    monkeypatch.setattr(chat_routes, "_authenticate_ws", authenticate)
    monkeypatch.setattr(chat_routes, "_send_scope_changed", send_scope_changed)
    monkeypatch.setattr(chat_routes, "_enforce_agent_chat_scope", enforce_scope)
    monkeypatch.setattr(chat_routes, "_reauthenticate_ws_event", reject_reauthentication)
    monkeypatch.setattr(chat_routes, "_follow_scope_turn", follow_scope_turn)
    caplog.set_level(logging.INFO, logger=chat_routes.logger.name)

    await chat_routes.chat_ws(websocket)

    assert websocket.sent == [{"type": "error", "message": "unauthorized"}]
    assert websocket.close_codes == [1008]
    for secret in (COOKIE_SECRET, TOKEN_SECRET, BODY_SECRET):
        assert secret not in caplog.text

    warnings = [
        record for record in caplog.records
        if record.name == chat_routes.logger.name and record.levelno == logging.WARNING
    ]
    assert len(warnings) == 1, "Closing an authenticated websocket must log one warning"
    warning, = warnings
    message = warning.getMessage()
    assert "chat websocket" in message.lower()
    assert username in message
    assert scope_kind in message
    assert type(error).__name__ in message
    if isinstance(error, HTTPException):
        assert str(error.status_code) in message
        assert error.detail in message
        assert not warning.exc_info
    else:
        assert str(error) in message
        assert warning.exc_info

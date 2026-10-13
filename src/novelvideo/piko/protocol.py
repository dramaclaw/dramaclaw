"""Shared wire limits and delivery receipts for both Piko World backends."""
from __future__ import annotations

import json
from typing import Any

CHAT_COOLDOWN_SECONDS = 3.0
CHAT_MAX_LENGTH = 80
PRIVATE_CHAT_COOLDOWN_SECONDS = 0.5
MAX_CLIENT_PAYLOAD_LENGTH = 2048


def message_body(payload: dict[str, Any]) -> str | None:
    value = payload.get("body")
    if not isinstance(value, str):
        return None
    body = value.strip()
    return body if body and len(body) <= CHAT_MAX_LENGTH else None


def client_message_id(payload: dict[str, Any]) -> str | None:
    value = payload.get("client_message_id")
    return value if isinstance(value, str) and 0 < len(value) <= 128 else None


def message_error(payload: dict[str, Any], code: str) -> dict[str, Any]:
    frame: dict[str, Any] = {"type": "error", "code": code}
    if identifier := client_message_id(payload):
        frame["client_message_id"] = identifier
    return frame


def message_receipt(payload: dict[str, Any], message_id: str) -> dict[str, Any] | None:
    identifier = client_message_id(payload)
    if identifier is None:
        return None  # Legacy clients still receive the original message echo.
    return {"type": "chat.sent", "client_message_id": identifier, "message_id": message_id}


def message_correlation(payload: dict[str, Any]) -> dict[str, str]:
    identifier = client_message_id(payload)
    return {"client_message_id": identifier} if identifier else {}


def private_session_ended(character_id: str) -> dict[str, str]:
    return {"type": "chat.private.ended", "character_id": character_id}


def parse_client_payload(raw: str) -> dict[str, Any] | None:
    if len(raw) > MAX_CLIENT_PAYLOAD_LENGTH:
        return None
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, dict) else None

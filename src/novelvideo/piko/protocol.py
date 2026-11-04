"""Shared wire limits and delivery receipts for both Piko World backends."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

CHAT_COOLDOWN_SECONDS = 6.0
CHAT_MAX_LENGTH = 80
CHAT_REQUEST_TTL_SECONDS = 300
PRIVATE_CHAT_COOLDOWN_SECONDS = 0.5
MAX_CLIENT_PAYLOAD_LENGTH = 2048
OPEN_SCENE_IDS = frozenset({
    "welcome-courtyard", "artisan-market", "town-hall-interior",
    "amber-wilds", "cloudtop-slope", "lantern-canal-street",
})
SCENE_SEATS = {
    "town-hall-interior": {"hall-west-seat", "hall-east-seat"},
    "welcome-courtyard": {"welcome-east-bench"},
    "artisan-market": {"market-west-bench", "market-east-bench"},
}
ACCESSORY_IDS = frozenset({
    "dark-knight-mask", "red-bow", "diver-goggles", "bamboo-hat", "gary-snail", "wizard-hat",
})


def valid_accessory_id(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value in ACCESSORY_IDS)


def valid_seat_id(scene_id: str, value: Any) -> bool:
    return value is None or (isinstance(value, str) and value in SCENE_SEATS.get(scene_id, ()))


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


def private_message(
    sender_id: str,
    target_id: str,
    nickname: str,
    body: str,
    *,
    message_id: str | None = None,
    sent_at: str | None = None,
) -> dict[str, str]:
    return {
        "id": message_id or str(uuid.uuid4()),
        "from_character_id": sender_id,
        "to_character_id": target_id,
        "from_nickname": nickname,
        "body": body,
        "sent_at": sent_at or datetime.now(timezone.utc).isoformat(),
    }


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

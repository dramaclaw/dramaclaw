"""Localizable runtime values shared by CE and EE task state adapters."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Union

__all__ = [
    "LocalizableMessage",
    "MessageLike",
    "has_localizable_log",
    "lmsg",
    "log_entry_payload",
    "log_entry_text",
    "log_lines_text",
    "message_payload",
    "message_text",
]


@dataclass(frozen=True)
class LocalizableMessage:
    code: str
    text: str
    params: Mapping[str, Any] | None = None

    def __str__(self) -> str:
        return self.text


MessageLike = Union[str, LocalizableMessage, None]


def lmsg(code: str, text: str, **params: Any) -> LocalizableMessage:
    return LocalizableMessage(code=code, text=text, params=params or None)


def message_text(value: MessageLike) -> str:
    if value is None:
        return ""
    if isinstance(value, LocalizableMessage):
        return value.text
    return str(value)


def message_payload(value: MessageLike) -> dict[str, Any] | None:
    if not isinstance(value, LocalizableMessage):
        return None
    payload: dict[str, Any] = {"code": value.code}
    if value.params:
        payload["params"] = dict(value.params)
    return payload


def log_entry_payload(value: MessageLike) -> Union[str, dict[str, Any]]:
    if not isinstance(value, LocalizableMessage):
        return message_text(value)
    entry: dict[str, Any] = {"text": value.text, "code": value.code}
    if value.params:
        entry["params"] = dict(value.params)
    return entry


def log_entry_text(entry: Any) -> str:
    if isinstance(entry, LocalizableMessage):
        return entry.text
    if isinstance(entry, dict):
        return str(entry.get("text") or "")
    return "" if entry is None else str(entry)


def log_lines_text(entries: Any) -> list[str]:
    if not isinstance(entries, (list, tuple)):
        return []
    return [log_entry_text(entry) for entry in entries]


def has_localizable_log(entries: Any) -> bool:
    if not isinstance(entries, (list, tuple)):
        return False
    return any(isinstance(entry, dict) and entry.get("code") for entry in entries)

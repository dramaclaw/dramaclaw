"""Localizable runtime copy for progress, logs and API messages.

The backend used to hand the frontend finished Chinese strings for task
progress, task logs and toast messages.  Those strings render as-is under the
English UI because there is nothing left for the translation layer to key on
(see #447, which fixed the same class of problem for task type labels and the
narrator voice panel).

The convention here mirrors what #447 settled on: the producer emits a stable
i18n ``code`` alongside the Chinese ``text``.  The frontend renders
``t(code, { defaultValue: text, ...params })``, so a client that predates the
code — or a call site not yet migrated — still shows the Chinese fallback
instead of a raw key.

Interpolation values stay in ``params`` rather than being baked into ``text``:
an English catalog entry needs the placeholders, not a pre-formatted Chinese
sentence.  ``text`` is still formatted eagerly so existing consumers, the
SQLite rows and the CE/EE task tables keep working untouched.
"""

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
    """A runtime string the frontend can translate.

    ``code``   stable i18n key, e.g. ``tasks.progress.script.start``.
    ``text``   Chinese fallback, already interpolated.
    ``params`` interpolation values for the catalog entry.
    """
    code: str
    text: str
    params: Mapping[str, Any] | None = None

    def __str__(self) -> str:
        # Any code path that still treats progress copy as a plain string keeps
        # working and keeps showing the Chinese fallback.
        return self.text


MessageLike = Union[str, LocalizableMessage, None]


def lmsg(code: str, text: str, **params: Any) -> LocalizableMessage:
    """Build a localizable message.

    ``text`` is the Chinese fallback and should already be interpolated by the
    caller; ``params`` carries the same values for the catalog entry.
    """
    return LocalizableMessage(code=code, text=text, params=params or None)


def message_text(value: MessageLike) -> str:
    """Chinese fallback for any message-like value."""
    if value is None:
        return ""
    if isinstance(value, LocalizableMessage):
        return value.text
    return str(value)


def message_payload(value: MessageLike) -> dict[str, Any] | None:
    """``{code, params}`` for a localizable message, or None for a plain string."""
    if not isinstance(value, LocalizableMessage):
        return None
    payload: dict[str, Any] = {"code": value.code}
    if value.params:
        payload["params"] = dict(value.params)
    return payload


def log_entry_payload(value: MessageLike) -> Union[str, dict[str, Any]]:
    """Serialize one log line for ``logs_json``.

    Plain strings stay plain strings so existing rows and untouched call sites
    are unaffected; localizable lines become ``{text, code, params}``.  The
    frontend accepts both shapes.
    """
    if not isinstance(value, LocalizableMessage):
        return message_text(value)
    entry: dict[str, Any] = {"text": value.text, "code": value.code}
    if value.params:
        entry["params"] = dict(value.params)
    return entry


def log_entry_text(entry: Any) -> str:
    """Chinese fallback for one *stored* log entry.

    Stored entries come back from ``logs_json`` as either a plain string
    (historic rows, call sites not migrated yet) or ``{text, code, params}``.
    """
    if isinstance(entry, LocalizableMessage):
        return entry.text
    if isinstance(entry, dict):
        return str(entry.get("text") or "")
    return "" if entry is None else str(entry)


def log_lines_text(entries: Any) -> list[str]:
    """Flatten stored log entries back to the public ``logs: string[]`` shape.

    The storage layer keeps structured entries so the code/params survive, but
    ``logs`` has always been a list of strings over the wire. Old frontends do
    ``logs.join("\n")``, so handing them objects would render
    ``[object Object]`` during a rolling deploy. Structured entries go out in a
    separate field instead (see ``logs_i18n`` in the tasks API).
    """
    if not isinstance(entries, (list, tuple)):
        return []
    return [log_entry_text(entry) for entry in entries]


def has_localizable_log(entries: Any) -> bool:
    """True when at least one stored entry carries an i18n code."""
    if not isinstance(entries, (list, tuple)):
        return False
    return any(isinstance(entry, dict) and entry.get("code") for entry in entries)

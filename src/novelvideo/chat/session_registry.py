"""Chat start locks and persisted Codex session and turn ownership."""

from __future__ import annotations

import json
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Callable
from typing import Any, ContextManager, TextIO

import portalocker

# Shown to the user when another turn of theirs is still running; the chat route
# maps every "busy" failure onto this one message (see routes/chat.py).
CHAT_RUN_BUSY_MESSAGE = "当前用户已有 AI 对话正在处理中，请稍后再试。"


_CHAT_RUN_LOCK_KEY = "active_chat_run"


@dataclass(frozen=True)
class ActiveChatTurn:
    turn_id: str | None


class ChatTurnBusyError(RuntimeError):
    def __init__(self, turn_id: str | None = None) -> None:
        super().__init__(CHAT_RUN_BUSY_MESSAGE)
        self.turn_id: str | None = turn_id


@dataclass
class ChatStartLock:
    file: TextIO | None


def _chat_run_lock_key(project: str) -> str:
    if project.startswith("freezone:"):
        return project
    return _CHAT_RUN_LOCK_KEY


def _chat_run_lock_project_for_turn(
    project: str,
    *,
    tool_mode: str,
    store_scope: Any | None = None,
) -> str:
    if tool_mode != "freezone_canvas":
        return project
    canvas_id = str(getattr(store_scope, "canvas_id", "") or "").strip()
    agent_id = str(getattr(store_scope, "agent_id", "") or "main").strip() or "main"
    if canvas_id:
        return f"freezone:{project}:canvas:{canvas_id}:agent:{agent_id}"
    return f"freezone:{project}:agent:{agent_id}"


def chat_run_lock_path(directory: Path, project: str) -> Path:
    digest = hashlib.sha256(_chat_run_lock_key(project).encode("utf-8")).hexdigest()
    return directory / f"{digest}.lock"


def _chat_start_lock_holder(lock_file: TextIO) -> str | None:
    try:
        lock_file.seek(0)
        return lock_file.read(4096).strip() or None
    except (OSError, UnicodeError, ValueError):
        return None


def acquire_chat_run_lock(path: Path, *, turn_id: str | None = None) -> ChatStartLock:
    lock_file = os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR, 0o600), "r+", encoding="utf-8")
    try:
        try:
            portalocker.lock(lock_file, portalocker.LOCK_EX | portalocker.LOCK_NB)
        except portalocker.exceptions.LockException:
            raise ChatTurnBusyError(turn_id=_chat_start_lock_holder(lock_file)) from None
        lock_file.seek(0)
        lock_file.truncate(0)
        lock_file.write(turn_id or "")
        lock_file.flush()
        return ChatStartLock(lock_file)
    except BaseException:
        lock_file.close()
        raise


def release_chat_run_lock(lock: ChatStartLock) -> None:
    lock_file, lock.file = lock.file, None
    if lock_file is not None:
        try:
            portalocker.unlock(lock_file)
        finally:
            lock_file.close()


def probe_chat_start_lock(path: Path) -> ActiveChatTurn | None:
    try:
        lock_file = path.open("r+", encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        try:
            portalocker.lock(lock_file, portalocker.LOCK_EX | portalocker.LOCK_NB)
        except portalocker.exceptions.LockException:
            return ActiveChatTurn(_chat_start_lock_holder(lock_file))
        portalocker.unlock(lock_file)
        return None
    finally:
        lock_file.close()


# Fixed, never bumped; protocol changes reach a live thread through turn context.
CODEX_SESSION_KEY_MARKER = "session"


def codex_scope_key(
    project: str,
    *,
    agent_profile: str = "main",
    canvas_id: str | None = None,
) -> str:
    """Keep thread identity tied to conversation scope with a fixed session marker."""
    normalized_project = str(project or "").strip()
    profile = str(agent_profile or "main").strip() or "main"
    if profile == "main":
        scope = (
            profile,
            "project" if normalized_project else "home",
            normalized_project or None,
            CODEX_SESSION_KEY_MARKER,
        )
        return json.dumps(scope, ensure_ascii=False, separators=(",", ":"))
    scoped_canvas = str(canvas_id or "").strip() or None
    if not profile.startswith("freezone"):
        scoped_canvas = None
    scope = (
        profile,
        "project" if normalized_project else "home",
        normalized_project or None,
        scoped_canvas,
        CODEX_SESSION_KEY_MARKER,
    )
    return json.dumps(scope, ensure_ascii=False, separators=(",", ":"))


def load_agent_session_state(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): str(value).strip()
        for key, value in payload.items()
        if str(value or "").strip()
    }


def save_agent_session_state(path: Path, payload: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(path)


def get_active_agent_session_id(path: Path, backend: str) -> str | None:
    payload = load_agent_session_state(path)
    active_backend = str(payload.get("backend", "") or "").strip()
    if active_backend != backend:
        return None
    return str(payload.get("thread_id", "") or "").strip() or None


def set_active_agent_session_id(
    path: Path, backend: str, thread_id: str, *, updated_at: str
) -> None:
    normalized = str(thread_id or "").strip()
    if not normalized:
        return
    save_agent_session_state(
        path,
        {"backend": backend, "thread_id": normalized, "updated_at": updated_at},
    )


def load_codex_session_state(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): str(value).strip()
        for key, value in payload.items()
        if str(key).strip() and str(value or "").strip()
    }


def save_codex_session_state(
    path: Path,
    payload: dict[str, str],
    *,
    write_json_atomic: Callable[[Path, dict[str, str]], None],
) -> None:
    write_json_atomic(path, payload)


def get_codex_thread_id(path: Path, scope_key: str) -> str | None:
    return load_codex_session_state(path).get(scope_key)


def set_codex_thread_id(
    path: Path,
    scope_key: str,
    thread_id: str,
    *,
    index_file_lock: Callable[[Path], ContextManager[Any]],
    write_json_atomic: Callable[[Path, dict[str, str]], None],
) -> None:
    normalized = str(thread_id or "").strip()
    if not normalized:
        return
    with index_file_lock(path):
        payload = load_codex_session_state(path)
        payload[scope_key] = normalized
        save_codex_session_state(path, payload, write_json_atomic=write_json_atomic)


def load_active_codex_turns(path: Path) -> dict[str, dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): value
        for key, value in payload.items()
        if isinstance(value, dict)
    }


def set_active_codex_turn(
    path: Path,
    scope_key: str,
    value: dict[str, Any] | None,
    *,
    load_state: Callable[[Path], dict[str, dict[str, Any]]] = load_active_codex_turns,
    index_file_lock: Callable[[Path], ContextManager[Any]],
    write_json_atomic: Callable[[Path, dict[str, dict[str, Any]]], None],
) -> None:
    with index_file_lock(path):
        payload = load_state(path)
        if value is None:
            payload.pop(scope_key, None)
        else:
            payload[scope_key] = value
        write_json_atomic(path, payload)


def clear_active_codex_turn_if_thread(
    path: Path,
    scope_key: str,
    thread_id: str,
    *,
    load_state: Callable[[Path], dict[str, dict[str, Any]]] = load_active_codex_turns,
    index_file_lock: Callable[[Path], ContextManager[Any]],
    write_json_atomic: Callable[[Path, dict[str, dict[str, Any]]], None],
) -> bool:
    """Remove an active turn only when it still belongs to ``thread_id``."""

    with index_file_lock(path):
        payload = load_state(path)
        active = payload.get(scope_key)
        if not isinstance(active, dict) or active.get("thread_id") != thread_id:
            return False
        payload.pop(scope_key, None)
        write_json_atomic(path, payload)
        return True


def mark_codex_turn_timeout(
    path: Path,
    scope_key: str,
    turn_id: str,
    *,
    index_file_lock: Callable[[Path], ContextManager[Any]],
    write_json_atomic: Callable[[Path, dict[str, Any]], None],
) -> bool:
    """Mark only the turn whose duration was checked, before interrupting it."""
    with index_file_lock(path):
        payload = load_active_codex_turns(path)
        entry = payload.get(scope_key)
        if entry is None or entry.get("turn_id") != turn_id:
            return False
        entry["timeout_reason"] = "max_duration"
        write_json_atomic(path, payload)
        return True


def claim_active_codex_turn(
    path: Path,
    scope_key: str,
    turn_id: str,
    *,
    index_file_lock: Callable[[Path], ContextManager[Any]],
    write_json_atomic: Callable[[Path, dict[str, Any]], None],
) -> dict[str, Any] | None:
    """Remove and return only the turn claimed by this finalizer."""
    with index_file_lock(path):
        payload = load_active_codex_turns(path)
        entry = payload.get(scope_key)
        if entry is None or entry.get("turn_id") != turn_id:
            return None
        del payload[scope_key]
        write_json_atomic(path, payload)
        return entry

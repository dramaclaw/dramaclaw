"""Project-scoped chat lock identity, ownership, and file lifecycle.

The application supplies the lock directory and process liveness callback;
this module does not depend on chat transport, Agent runtimes, or databases.
"""

from __future__ import annotations

import json
import hashlib
import os
import socket
import uuid
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Callable
from typing import Any, ContextManager

_CHAT_RUN_LOCK_KEY = "active_chat_run"
_CHAT_RUN_LOCK_TTL_SECONDS = 2 * 60
_CHAT_RUN_LOCK_MAX_SECONDS = 60 * 60
_CHAT_RUN_LOCK_HEARTBEAT_SECONDS = 30.0
_CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS = 5.0


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _parse_chat_run_lock(
    value: str | None,
) -> tuple[str | None, str | None, int | None, datetime | None, datetime | None]:
    if not value:
        return None, None, None, None, None
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return value, None, None, None, None
    if not isinstance(payload, dict):
        return None, None, None, None, None
    lock_id = payload.get("lock_id")
    owner_id = payload.get("owner_id")
    owner_pid = payload.get("owner_pid")
    started_at = payload.get("started_at")
    updated_at = payload.get("updated_at") or started_at
    return (
        str(lock_id).strip() or None if lock_id is not None else None,
        str(owner_id).strip() or None if owner_id is not None else None,
        int(owner_pid) if isinstance(owner_pid, int) else None,
        _parse_iso_datetime(str(started_at)) if started_at is not None else None,
        _parse_iso_datetime(str(updated_at)) if updated_at is not None else None,
    )


def _chat_run_lock_is_stale(
    started_at: datetime | None,
    updated_at: datetime | None = None,
) -> bool:
    now = datetime.now(timezone.utc)
    if started_at is not None:
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        if (now - started_at).total_seconds() > _CHAT_RUN_LOCK_MAX_SECONDS:
            return True
    heartbeat_at = updated_at or started_at
    if heartbeat_at is None:
        return False
    if heartbeat_at.tzinfo is None:
        heartbeat_at = heartbeat_at.replace(tzinfo=timezone.utc)
    return (now - heartbeat_at).total_seconds() > _CHAT_RUN_LOCK_TTL_SECONDS


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


def read_chat_run_lock_file(
    path: Path,
) -> tuple[str | None, str | None, int | None, datetime | None, datetime | None]:
    try:
        value = path.read_text(encoding="utf-8")
    except OSError:
        return None, None, None, None, None
    return _parse_chat_run_lock(value)


def remove_chat_run_lock_file(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def atomic_write_chat_run_lock_file(path: Path, payload: str) -> None:
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp_path.write_text(payload, encoding="utf-8")
        tmp_path.replace(path)
    finally:
        tmp_path.unlink(missing_ok=True)


def chat_run_lock_payload(lock_id: str, *, started_at: str | None = None) -> str:
    now = datetime.now(timezone.utc).isoformat()
    return json.dumps(
        {
            "lock_id": lock_id,
            "owner_id": f"{socket.gethostname()}:{os.getpid()}",
            "owner_pid": os.getpid(),
            "started_at": started_at or now,
            "updated_at": now,
        },
        ensure_ascii=False,
    )


def chat_run_lock_file_is_new(path: Path) -> bool:
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return (
        datetime.now(timezone.utc).timestamp() - mtime
        < _CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS
    )


def chat_run_lock_owner_is_active(
    owner_id: str | None,
    owner_pid: int | None,
    started_at: datetime | None,
    updated_at: datetime | None,
    *,
    pid_is_alive: Callable[[int | None], bool],
) -> bool:
    if started_at is None and updated_at is None:
        return False
    if _chat_run_lock_is_stale(started_at, updated_at):
        return False
    owner_host, separator, _owner_process = (owner_id or "").rpartition(":")
    if separator and owner_host == socket.gethostname():
        return pid_is_alive(owner_pid)
    return True


def acquire_chat_run_lock(
    path: Path,
    *,
    owner_is_active: Callable[
        [str | None, int | None, datetime | None, datetime | None], bool
    ],
) -> str:
    lock_id = uuid.uuid4().hex
    payload_bytes = chat_run_lock_payload(lock_id).encode("utf-8")
    for _attempt in range(3):
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            existing_lock_id, owner_id, owner_pid, started_at, updated_at = (
                read_chat_run_lock_file(path)
            )
            if not existing_lock_id and chat_run_lock_file_is_new(path):
                raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")
            if existing_lock_id and owner_is_active(
                owner_id, owner_pid, started_at, updated_at
            ):
                raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")
            remove_chat_run_lock_file(path)
            continue
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(payload_bytes)
            return lock_id
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            remove_chat_run_lock_file(path)
            raise
    raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")


def release_chat_run_lock(path: Path, lock_id: str) -> None:
    current_lock_id, *_ = read_chat_run_lock_file(path)
    if current_lock_id == lock_id:
        remove_chat_run_lock_file(path)


def heartbeat_chat_run_lock(
    path: Path,
    lock_id: str,
    *,
    atomic_write: Callable[[Path, str], None] = atomic_write_chat_run_lock_file,
) -> bool:
    current_lock_id, _owner_id, _owner_pid, started_at, _updated_at = (
        read_chat_run_lock_file(path)
    )
    if current_lock_id != lock_id:
        return False
    payload = chat_run_lock_payload(
        lock_id,
        started_at=started_at.isoformat() if started_at else None,
    )
    try:
        atomic_write(path, payload)
    except OSError:
        return False
    return True


def chat_run_lock_is_active(
    path: Path,
    *,
    owner_is_active: Callable[
        [str | None, int | None, datetime | None, datetime | None], bool
    ],
) -> bool:
    existing_lock_id, owner_id, owner_pid, started_at, updated_at = (
        read_chat_run_lock_file(path)
    )
    if existing_lock_id and owner_is_active(
        owner_id, owner_pid, started_at, updated_at
    ):
        return True
    remove_chat_run_lock_file(path)
    return False


def codex_scope_key(
    project: str,
    *,
    agent_profile: str = "main",
    canvas_id: str | None = None,
    main_protocol: str,
    freezone_protocol: str,
) -> str:
    """Keep thread identity tied to its tool protocol and conversation scope."""
    normalized_project = str(project or "").strip()
    profile = str(agent_profile or "main").strip() or "main"
    if profile == "main":
        scope = (
            profile,
            "project" if normalized_project else "home",
            normalized_project or None,
            main_protocol,
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
        freezone_protocol,
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


def reset_codex_scope_thread(
    path: Path,
    scope_key: str,
    *,
    index_file_lock: Callable[[Path], ContextManager[Any]],
    write_json_atomic: Callable[[Path, dict[str, str]], None],
) -> None:
    """Drop one scope's thread binding from the session index.

    This only touches the thread index. The matching active-turn record lives
    in a separate file, and clearing it stays with the caller (the
    ``chat.service`` wrapper does so) because the registry does not know the
    per-user active-turn path.
    """
    with index_file_lock(path):
        payload = load_codex_session_state(path)
        if scope_key in payload:
            payload.pop(scope_key)
            save_codex_session_state(path, payload, write_json_atomic=write_json_atomic)


def load_active_codex_turns(path: Path) -> dict[str, dict[str, str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): {str(k): str(v) for k, v in value.items()}
        for key, value in payload.items()
        if isinstance(value, dict)
    }


def set_active_codex_turn(
    path: Path,
    scope_key: str,
    value: tuple[str, str] | tuple[str, str, str] | None,
    *,
    load_state: Callable[[Path], dict[str, dict[str, str]]] = load_active_codex_turns,
    index_file_lock: Callable[[Path], ContextManager[Any]],
    write_json_atomic: Callable[[Path, dict[str, dict[str, str]]], None],
) -> None:
    with index_file_lock(path):
        payload = load_state(path)
        if value is None:
            payload.pop(scope_key, None)
        else:
            payload[scope_key] = {"thread_id": value[0], "turn_id": value[1]}
            if len(value) >= 3 and str(value[2]).strip():
                payload[scope_key]["business_turn_id"] = str(value[2]).strip()
        write_json_atomic(path, payload)

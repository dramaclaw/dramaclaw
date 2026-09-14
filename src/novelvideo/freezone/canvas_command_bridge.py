"""Durable Inbox/Outbox for frontend-executed Freezone canvas commands.

Hermes tools run on the backend, while Freezone canvas commands are applied by
the browser. SQLite is the transport source of truth; pending/result JSON files
remain as a temporary compatibility mirror for legacy workers.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from novelvideo.sqlite_pragmas import configure_sqlite_connection

BRIDGE_RESULT_TTL_SECONDS = 24 * 60 * 60
BRIDGE_DELIVERY_LEASE_SECONDS = 15
BRIDGE_PENDING_TTL_SECONDS = {
    "canvas_command": 75,
    "canvas_context": 45,
    "skill_studio_event": 10 * 60,
    "clarification_event": 10 * 60,
}
_BRIDGE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS canvas_command_messages (
    bridge_key          TEXT PRIMARY KEY,
    kind                TEXT NOT NULL,
    project_id          TEXT,
    canvas_id           TEXT,
    request_fingerprint TEXT,
    payload_json        TEXT NOT NULL,
    result_json         TEXT,
    status              TEXT NOT NULL,
    consumer_id         TEXT,
    delivery_attempts   INTEGER NOT NULL DEFAULT 0,
    lease_expires_at    REAL,
    created_at          REAL NOT NULL,
    updated_at          REAL NOT NULL,
    expires_at          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_command_messages_pending
ON canvas_command_messages(project_id, canvas_id, kind, status, created_at);
CREATE INDEX IF NOT EXISTS idx_canvas_command_messages_expiry
ON canvas_command_messages(expires_at);
"""
_TERMINAL_BRIDGE_STATUSES = {"applied", "failed", "cancelled", "expired"}
_BRIDGE_SCHEMA_READY_PATHS: set[Path] = set()
_BRIDGE_SCHEMA_LOCK = threading.Lock()


def _bridge_dir(bridge_dir: str | Path | None = None) -> Path:
    if bridge_dir:
        return Path(bridge_dir)
    root = os.environ.get("DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "").strip()
    if root:
        return Path(root)
    return Path(tempfile.gettempdir()) / "supertale_canvas_command_bridge"


def _bridge_db_path(bridge_dir: str | Path | None = None) -> Path:
    return _bridge_dir(bridge_dir) / "canvas_command_inbox.sqlite3"


@contextmanager
def _bridge_db(bridge_dir: str | Path | None = None):
    path = _bridge_db_path(bridge_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    database_existed = path.exists()
    conn = sqlite3.connect(path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    configure_sqlite_connection(conn, set_journal_mode=False)
    if not database_existed or path not in _BRIDGE_SCHEMA_READY_PATHS:
        with _BRIDGE_SCHEMA_LOCK:
            if not database_existed or path not in _BRIDGE_SCHEMA_READY_PATHS:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(_BRIDGE_SCHEMA_SQL)
                _BRIDGE_SCHEMA_READY_PATHS.add(path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _decode_bridge_json(value: Any) -> dict[str, Any] | None:
    try:
        decoded = json.loads(str(value or ""))
    except (TypeError, ValueError):
        return None
    return decoded if isinstance(decoded, dict) else None


def _terminal_status(result: dict[str, Any]) -> str:
    if result.get("canvas_apply_status") == "timeout":
        return "expired"
    if result.get("cancelled") is True:
        return "cancelled"
    if result.get("ok") is True and result.get("applied") is not False:
        return "applied"
    return "failed"


def _prune_bridge_rows(conn: sqlite3.Connection, *, now: float) -> int:
    shortest_ttl = min(BRIDGE_PENDING_TTL_SECONDS.values())
    expirable = conn.execute(
        """
        SELECT bridge_key, kind, request_fingerprint, created_at
          FROM canvas_command_messages
         WHERE status IN ('pending', 'delivered')
           AND created_at <= ?
        """,
        (now - shortest_ttl,),
    ).fetchall()
    for row in expirable:
        ttl = BRIDGE_PENDING_TTL_SECONDS.get(str(row["kind"]), 10 * 60)
        if float(row["created_at"]) + ttl > now:
            continue
        result = {
            "key": str(row["bridge_key"]),
            "bridge_key": str(row["bridge_key"]),
            "resolved_at": now,
            "ok": False,
            "tool_call_status": "failed",
            "canvas_apply_status": "timeout",
            "applied": False,
            "cancelled": True,
            "errors": ["Persistent canvas inbox message expired before completion."],
            **(
                {"request_fingerprint": str(row["request_fingerprint"])}
                if row["request_fingerprint"]
                else {}
            ),
        }
        conn.execute(
            """
            UPDATE canvas_command_messages
               SET status = 'expired', result_json = ?, updated_at = ?,
                   lease_expires_at = NULL
             WHERE bridge_key = ? AND status IN ('pending', 'delivered')
            """,
            (_canonical_json(result), now, row["bridge_key"]),
        )
    cursor = conn.execute(
        "DELETE FROM canvas_command_messages WHERE expires_at <= ?",
        (now,),
    )
    return max(int(cursor.rowcount or 0), 0)


def bridge_status_counts(*, bridge_dir: str | Path | None = None) -> dict[str, int]:
    """Return observable queue depth by durable transport status."""
    with _bridge_db(bridge_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        _prune_bridge_rows(conn, now=time.time())
        rows = conn.execute(
            "SELECT status, COUNT(*) AS count FROM canvas_command_messages GROUP BY status"
        ).fetchall()
    return {str(row["status"]): int(row["count"] or 0) for row in rows}


def read_bridge_message(
    key: str, *, bridge_dir: str | Path | None = None
) -> dict[str, Any] | None:
    with _bridge_db(bridge_dir) as conn:
        row = conn.execute(
            "SELECT * FROM canvas_command_messages WHERE bridge_key = ?",
            (key,),
        ).fetchone()
    if row is None:
        return None
    payload = _decode_bridge_json(row["payload_json"])
    if payload is None:
        return None
    return {
        **payload,
        "key": str(row["bridge_key"]),
        "kind": str(row["kind"]),
        "transport_status": str(row["status"]),
    }


def list_pending_bridge_messages(
    *,
    project_id: str,
    canvas_id: str,
    kinds: set[str] | None = None,
    created_after: float | None = None,
    limit: int = 100,
    bridge_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Read pending or redeliverable messages across API workers."""
    now = time.time()
    parameters: list[Any] = [project_id, canvas_id, now]
    where = (
        "project_id = ? AND canvas_id = ? AND "
        "(status = 'pending' OR (status = 'delivered' AND lease_expires_at <= ?))"
    )
    if kinds:
        placeholders = ",".join("?" for _ in kinds)
        where += f" AND kind IN ({placeholders})"
        parameters.extend(sorted(kinds))
    if created_after is not None:
        where += " AND created_at >= ?"
        parameters.append(float(created_after))
    parameters.append(max(1, min(int(limit), 500)))
    with _bridge_db(bridge_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        _prune_bridge_rows(conn, now=now)
        rows = conn.execute(
            f"SELECT * FROM canvas_command_messages WHERE {where} "
            "ORDER BY created_at ASC LIMIT ?",
            parameters,
        ).fetchall()
    items: list[dict[str, Any]] = []
    for row in rows:
        payload = _decode_bridge_json(row["payload_json"])
        if payload is None:
            continue
        items.append(
            {
                **payload,
                "key": str(row["bridge_key"]),
                "kind": str(row["kind"]),
                "transport_status": str(row["status"]),
                "created_at": float(row["created_at"]),
            }
        )
    return items


def mark_bridge_message_delivered(
    key: str,
    *,
    consumer_id: str,
    bridge_dir: str | Path | None = None,
) -> bool:
    now = time.time()
    with _bridge_db(bridge_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.execute(
            """
            UPDATE canvas_command_messages
               SET status = 'delivered', consumer_id = ?,
                   delivery_attempts = delivery_attempts + 1,
                   lease_expires_at = ?, updated_at = ?
             WHERE bridge_key = ?
               AND (status = 'pending' OR
                    (status = 'delivered' AND lease_expires_at <= ?))
            """,
            (
                consumer_id[:160],
                now + BRIDGE_DELIVERY_LEASE_SECONDS,
                now,
                key,
                now,
            ),
        )
        return int(cursor.rowcount or 0) == 1


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )


def canvas_command_bridge_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    commands: list[Any],
) -> str:
    payload = {
        "kind": "canvas_command",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "commands": commands,
        "nonce": time.time_ns(),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def canvas_command_idempotency_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    commands: list[Any],
) -> str:
    """Return a stable key for replaying the same workflow write.

    Ordinary canvas commands keep the nonce-bearing bridge key above so each
    user action remains independent. Workflow submissions pass an explicit
    ``workflowInstanceId`` in every create-node command and use this stable
    variant to make transport retries idempotent.
    """
    payload = {
        "kind": "canvas_command_idempotency",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "commands": commands,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def canvas_context_bridge_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    requests: list[Any],
) -> str:
    payload = {
        "kind": "canvas_context_request",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "requests": requests,
        "nonce": time.time_ns(),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def skill_studio_bridge_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    event: dict[str, Any],
) -> str:
    payload = {
        "kind": "skill_studio_event",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "event": event,
        "nonce": time.time_ns(),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def clarification_bridge_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    event: dict[str, Any],
) -> str:
    payload = {
        "kind": "clarification_event",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "event": event,
        "nonce": time.time_ns(),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def _path(kind: str, key: str, bridge_dir: str | Path | None = None) -> Path:
    safe_key = "".join(ch for ch in key if ch.isalnum() or ch in {"-", "_"})[:128]
    return _bridge_dir(bridge_dir) / f"{safe_key}.{kind}.json"


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(_canonical_json(data), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _unlink_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return


def _canvas_command_request_fingerprint(
    *,
    project_id: str | None,
    canvas_id: str | None,
    commands: list[Any],
) -> str:
    payload = {
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "commands": commands,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _put_pending_bridge_message(
    *,
    key: str,
    kind: str,
    project_id: str | None,
    canvas_id: str | None,
    payload: dict[str, Any],
    request_fingerprint: str | None = None,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    now = time.time()
    with _bridge_db(bridge_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        _prune_bridge_rows(conn, now=now)
        existing = conn.execute(
            "SELECT * FROM canvas_command_messages WHERE bridge_key = ?",
            (key,),
        ).fetchone()
        if existing is not None:
            existing_fingerprint = str(existing["request_fingerprint"] or "")
            if request_fingerprint and existing_fingerprint != request_fingerprint:
                return _canvas_command_idempotency_conflict(
                    key=key, project_id=project_id, canvas_id=canvas_id
                )
            if str(existing["status"]) in _TERMINAL_BRIDGE_STATUSES:
                return _decode_bridge_json(existing["result_json"])
            return None
        conn.execute(
            """
            INSERT INTO canvas_command_messages (
                bridge_key, kind, project_id, canvas_id, request_fingerprint,
                payload_json, status, created_at, updated_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
            """,
            (
                key,
                kind,
                project_id,
                canvas_id,
                request_fingerprint,
                _canonical_json(payload),
                now,
                now,
                now + BRIDGE_RESULT_TTL_SECONDS,
            ),
        )
    return None


def _read_durable_bridge_result(
    key: str, *, bridge_dir: str | Path | None = None
) -> dict[str, Any] | None:
    with _bridge_db(bridge_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        _prune_bridge_rows(conn, now=time.time())
        row = conn.execute(
            "SELECT status, result_json FROM canvas_command_messages WHERE bridge_key = ?",
            (key,),
        ).fetchone()
    if row is None or str(row["status"]) not in _TERMINAL_BRIDGE_STATUSES:
        return None
    return _decode_bridge_json(row["result_json"])


def _resolve_durable_bridge_message(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    now = time.time()
    with _bridge_db(bridge_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT * FROM canvas_command_messages WHERE bridge_key = ?",
            (key,),
        ).fetchone()
        if (
            existing is not None
            and str(existing["status"]) in _TERMINAL_BRIDGE_STATUSES
        ):
            persisted = _decode_bridge_json(existing["result_json"])
            return persisted if persisted is not None else result
        fingerprint = str(existing["request_fingerprint"] or "") if existing else ""
        payload = {
            "key": key,
            "bridge_key": key,
            "resolved_at": now,
            **({"request_fingerprint": fingerprint} if fingerprint else {}),
            **result,
        }
        if existing is None:
            conn.execute(
                """
                INSERT INTO canvas_command_messages (
                    bridge_key, kind, payload_json, result_json, status,
                    created_at, updated_at, expires_at
                ) VALUES (?, 'unknown', '{}', ?, ?, ?, ?, ?)
                """,
                (
                    key,
                    _canonical_json(payload),
                    _terminal_status(payload),
                    now,
                    now,
                    now + BRIDGE_RESULT_TTL_SECONDS,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE canvas_command_messages
                   SET result_json = ?, status = ?, updated_at = ?, expires_at = ?,
                       lease_expires_at = NULL
                 WHERE bridge_key = ?
                """,
                (
                    _canonical_json(payload),
                    _terminal_status(payload),
                    now,
                    now + BRIDGE_RESULT_TTL_SECONDS,
                    key,
                ),
            )
    return payload


@contextmanager
def _key_lock(key: str, bridge_dir: str | Path | None = None):
    directory = _bridge_dir(bridge_dir)
    directory.mkdir(parents=True, exist_ok=True)
    safe_key = "".join(ch for ch in key if ch.isalnum() or ch in {"-", "_"})[:128]
    lock_path = directory / f"{safe_key}.lock"
    with lock_path.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _canvas_command_idempotency_conflict(
    *, key: str, project_id: str | None, canvas_id: str | None
) -> dict[str, Any]:
    return {
        "ok": False,
        "status": "canvas_command_idempotency_conflict",
        "tool_call_status": "failed",
        "canvas_apply_status": "failed",
        "applied": False,
        "cancelled": False,
        "bridge_key": key,
        "project_id": project_id,
        "canvas_id": canvas_id,
        "errors": [
            "The bridge key is already bound to a different canvas command payload."
        ],
        "message": "Canvas command idempotency key conflicts with an existing operation.",
        "user_message": "画布操作的幂等标识与已有请求冲突，请重新发起操作。",
        "agent_instruction": "Do not retry this operation with the conflicting bridge key.",
    }


def put_pending_canvas_command(
    *,
    key: str,
    project_id: str | None,
    canvas_id: str | None,
    commands: list[Any],
    envelope: dict[str, Any],
    bridge_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Publish once, replaying a durable result for an identical stable key.

    Returning a dict means the operation already reached a terminal state, or
    the caller reused the key for a different payload. The existing durable
    result is never deleted during retry.
    """
    fingerprint = _canvas_command_request_fingerprint(
        project_id=project_id,
        canvas_id=canvas_id,
        commands=commands,
    )
    durable_payload = {
        "key": key,
        "kind": "canvas_command",
        "project_id": project_id,
        "canvas_id": canvas_id,
        "commands": commands,
        "envelope": envelope,
        "request_fingerprint": fingerprint,
        "created_at": time.time(),
    }
    durable_result = _put_pending_bridge_message(
        key=key,
        kind="canvas_command",
        project_id=project_id,
        canvas_id=canvas_id,
        payload=durable_payload,
        request_fingerprint=fingerprint,
        bridge_dir=bridge_dir,
    )
    if durable_result is not None:
        return durable_result
    with _key_lock(key, bridge_dir):
        existing_result = _read_json(_path("result", key, bridge_dir))
        if existing_result is not None:
            if existing_result.get("request_fingerprint") == fingerprint:
                return existing_result
            return _canvas_command_idempotency_conflict(
                key=key, project_id=project_id, canvas_id=canvas_id
            )

        pending_path = _path("pending", key, bridge_dir)
        existing_pending = _read_json(pending_path)
        if existing_pending is not None:
            if existing_pending.get("request_fingerprint") == fingerprint:
                return None
            return _canvas_command_idempotency_conflict(
                key=key, project_id=project_id, canvas_id=canvas_id
            )

        _write_json(pending_path, durable_payload)
    return None


def put_pending_canvas_context(
    *,
    key: str,
    project_id: str | None,
    canvas_id: str | None,
    requests: list[Any],
    envelope: dict[str, Any],
    bridge_dir: str | Path | None = None,
) -> None:
    payload = {
        "key": key,
        "kind": "canvas_context",
        "project_id": project_id,
        "canvas_id": canvas_id,
        "requests": requests,
        "envelope": envelope,
        "created_at": time.time(),
    }
    _put_pending_bridge_message(
        key=key,
        kind="canvas_context",
        project_id=project_id,
        canvas_id=canvas_id,
        payload=payload,
        bridge_dir=bridge_dir,
    )
    _unlink_if_exists(_path("result", key, bridge_dir))
    _write_json(_path("pending", key, bridge_dir), payload)


def put_pending_skill_studio_event(
    *,
    key: str,
    project_id: str | None,
    canvas_id: str | None,
    event: dict[str, Any],
    bridge_dir: str | Path | None = None,
) -> None:
    payload = {
        "key": key,
        "kind": "skill_studio_event",
        "project_id": project_id,
        "canvas_id": canvas_id,
        "event": event,
        "created_at": time.time(),
    }
    _put_pending_bridge_message(
        key=key,
        kind="skill_studio_event",
        project_id=project_id,
        canvas_id=canvas_id,
        payload=payload,
        bridge_dir=bridge_dir,
    )
    _unlink_if_exists(_path("result", key, bridge_dir))
    _write_json(_path("pending", key, bridge_dir), payload)


def put_pending_clarification_event(
    *,
    key: str,
    project_id: str | None,
    canvas_id: str | None,
    event: dict[str, Any],
    bridge_dir: str | Path | None = None,
) -> None:
    payload = {
        "key": key,
        "kind": "clarification_event",
        "project_id": project_id,
        "canvas_id": canvas_id,
        "event": event,
        "created_at": time.time(),
    }
    _put_pending_bridge_message(
        key=key,
        kind="clarification_event",
        project_id=project_id,
        canvas_id=canvas_id,
        payload=payload,
        bridge_dir=bridge_dir,
    )
    _unlink_if_exists(_path("result", key, bridge_dir))
    _write_json(_path("pending", key, bridge_dir), payload)


def resolve_canvas_command(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    with _key_lock(key, bridge_dir):
        return _resolve_canvas_command_locked(key, result, bridge_dir=bridge_dir)


def _resolve_canvas_command_locked(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    result_path = _path("result", key, bridge_dir)
    existing = _read_json(result_path)
    if existing is not None:
        # A background workflow reports "accepted" immediately, while the
        # browser continues executing it. A duplicate recovered approval may
        # later expire; that late cancellation must not overwrite the result
        # already consumed by the waiting tool call.
        _resolve_durable_bridge_message(key, existing, bridge_dir=bridge_dir)
        _unlink_if_exists(_path("pending", key, bridge_dir))
        return existing
    pending = _read_json(_path("pending", key, bridge_dir))
    proposed = {
        "key": key,
        "bridge_key": key,
        "resolved_at": time.time(),
        **(
            {"request_fingerprint": pending["request_fingerprint"]}
            if isinstance(pending, dict)
            and isinstance(pending.get("request_fingerprint"), str)
            else {}
        ),
        **result,
    }
    payload = _resolve_durable_bridge_message(key, proposed, bridge_dir=bridge_dir)
    _write_json(result_path, payload)
    _unlink_if_exists(_path("pending", key, bridge_dir))
    return payload


def resolve_canvas_context(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    return resolve_canvas_command(key, result, bridge_dir=bridge_dir)


def resolve_skill_studio_result(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    return resolve_canvas_command(key, result, bridge_dir=bridge_dir)


def resolve_clarification_result(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    return resolve_canvas_command(key, result, bridge_dir=bridge_dir)


def wait_canvas_command_result(
    key: str,
    timeout_seconds: float,
    poll_seconds: float = 0.2,
    *,
    bridge_dir: str | Path | None = None,
    timeout_result: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    deadline = time.time() + max(0.0, timeout_seconds)
    while True:
        durable_result = _read_durable_bridge_result(key, bridge_dir=bridge_dir)
        if durable_result is not None:
            return durable_result
        result = _read_json(_path("result", key, bridge_dir))
        if result is not None:
            return result
        if time.time() >= deadline:
            break
        time.sleep(max(0.05, poll_seconds))
    if timeout_result is not None:
        return resolve_canvas_command(key, timeout_result, bridge_dir=bridge_dir)
    return None


def wait_canvas_context_result(
    key: str,
    timeout_seconds: float,
    poll_seconds: float = 0.2,
    *,
    bridge_dir: str | Path | None = None,
    timeout_result: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    return wait_canvas_command_result(
        key,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
        bridge_dir=bridge_dir,
        timeout_result=timeout_result,
    )


def wait_skill_studio_result(
    key: str,
    timeout_seconds: float,
    poll_seconds: float = 0.2,
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    return wait_canvas_command_result(
        key,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
        bridge_dir=bridge_dir,
    )


def wait_clarification_result(
    key: str,
    timeout_seconds: float,
    poll_seconds: float = 0.2,
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    return wait_canvas_command_result(
        key,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
        bridge_dir=bridge_dir,
    )

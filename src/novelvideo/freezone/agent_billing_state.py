"""Durable confirmation and settlement state for billable Agent capabilities."""

from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from novelvideo.sqlite_pragmas import configure_sqlite_connection

QUOTE_TTL_SECONDS = 10 * 60

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS agent_billing_quotes (
    quote_id            TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    project_id          TEXT NOT NULL,
    canvas_id           TEXT NOT NULL,
    feature_key         TEXT NOT NULL,
    operation_kind      TEXT NOT NULL,
    operation_digest    TEXT NOT NULL,
    amount              REAL NOT NULL,
    price_version       TEXT NOT NULL,
    display             TEXT NOT NULL,
    status              TEXT NOT NULL,
    receipt_hash        TEXT,
    receipt_token       TEXT,
    created_at          REAL NOT NULL,
    expires_at          REAL NOT NULL,
    confirmed_at        REAL,
    consumed_at         REAL
);
CREATE INDEX IF NOT EXISTS idx_agent_billing_quotes_scope
ON agent_billing_quotes(user_id, project_id, canvas_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_billing_settlements (
    reservation_id      TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    canvas_id           TEXT NOT NULL,
    draft_id            TEXT NOT NULL,
    action              TEXT NOT NULL,
    metadata_json       TEXT NOT NULL,
    status              TEXT NOT NULL,
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     REAL NOT NULL,
    last_error          TEXT,
    created_at          REAL NOT NULL,
    updated_at          REAL NOT NULL,
    settled_at          REAL
);
CREATE INDEX IF NOT EXISTS idx_agent_billing_settlements_due
ON agent_billing_settlements(status, next_attempt_at);
"""


@contextmanager
def _connect(project_dir: Path):
    db_path = (Path(project_dir) / "data.db").resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    configure_sqlite_connection(conn)
    conn.executescript(_SCHEMA_SQL)
    quote_columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(agent_billing_quotes)").fetchall()
    }
    if "receipt_token" not in quote_columns:
        conn.execute("ALTER TABLE agent_billing_quotes ADD COLUMN receipt_token TEXT")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def operation_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _receipt_hash(receipt: str) -> str:
    return hashlib.sha256(receipt.encode("utf-8")).hexdigest()


def _quote_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "quote_id": row["quote_id"],
        "feature_key": row["feature_key"],
        "operation_kind": row["operation_kind"],
        "amount": float(row["amount"]),
        "required_credits": float(row["amount"]),
        "price_version": row["price_version"],
        "display": row["display"],
        "status": row["status"],
        "expires_at": float(row["expires_at"]),
    }


def create_billing_quote(
    *,
    project_dir: Path,
    user_id: str,
    project_id: str,
    canvas_id: str,
    feature_key: str,
    operation_kind: str,
    operation: Any,
    amount: float,
    price_version: str,
    display: str,
    ttl_seconds: int = QUOTE_TTL_SECONDS,
) -> dict[str, Any]:
    now = time.time()
    digest = operation_digest(operation)
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT * FROM agent_billing_quotes
            WHERE user_id = ? AND project_id = ? AND canvas_id = ?
              AND feature_key = ? AND operation_kind = ? AND operation_digest = ?
              AND amount = ? AND price_version = ?
              AND status IN ('quoted', 'confirmed') AND expires_at >= ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (
                user_id,
                project_id,
                canvas_id,
                feature_key,
                operation_kind,
                digest,
                float(amount),
                price_version,
                now,
            ),
        ).fetchone()
        if row is not None:
            return _quote_payload(row)
        quote_id = f"billing_quote_{uuid.uuid4().hex}"
        expires_at = now + max(int(ttl_seconds), 60)
        conn.execute(
            """
            INSERT INTO agent_billing_quotes (
                quote_id, user_id, project_id, canvas_id, feature_key,
                operation_kind, operation_digest, amount, price_version,
                display, status, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)
            """,
            (
                quote_id,
                user_id,
                project_id,
                canvas_id,
                feature_key,
                operation_kind,
                digest,
                float(amount),
                price_version,
                display,
                now,
                expires_at,
            ),
        )
        row = conn.execute(
            "SELECT * FROM agent_billing_quotes WHERE quote_id = ?", (quote_id,)
        ).fetchone()
        assert row is not None
        return _quote_payload(row)


def confirm_billing_quote(
    *,
    project_dir: Path,
    quote_id: str,
    user_id: str,
    project_id: str,
    canvas_id: str,
    expected_operation_kind: str | None = None,
) -> dict[str, Any]:
    now = time.time()
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM agent_billing_quotes WHERE quote_id = ?", (quote_id,)
        ).fetchone()
        if row is None:
            raise ValueError("billing quote not found")
        if (
            row["user_id"] != user_id
            or row["project_id"] != project_id
            or row["canvas_id"] != canvas_id
        ):
            raise ValueError("billing quote does not belong to this scope")
        if expected_operation_kind and row["operation_kind"] != expected_operation_kind:
            raise ValueError("billing quote does not match this confirmation action")
        if float(row["expires_at"]) < now:
            raise ValueError("billing quote expired")
        if row["status"] not in {"quoted", "confirmed"}:
            raise ValueError("billing quote is no longer awaiting confirmation")
        if row["status"] == "confirmed" and row["receipt_token"]:
            return {
                **_quote_payload(row),
                "status": "confirmed",
                "receipt": row["receipt_token"],
            }
        receipt = f"billing_receipt_{secrets.token_urlsafe(32)}"
        conn.execute(
            """
            UPDATE agent_billing_quotes
            SET status = 'confirmed', receipt_hash = ?, receipt_token = ?, confirmed_at = ?
            WHERE quote_id = ? AND status IN ('quoted', 'confirmed')
            """,
            (_receipt_hash(receipt), receipt, now, quote_id),
        )
        return {**_quote_payload(row), "status": "confirmed", "receipt": receipt}


def consume_billing_confirmation(
    *,
    project_dir: Path,
    quote_id: str,
    receipt: str,
    user_id: str,
    project_id: str,
    canvas_id: str,
    feature_key: str,
    operation_kind: str,
    operation: Any,
) -> dict[str, Any]:
    now = time.time()
    digest = operation_digest(operation)
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM agent_billing_quotes WHERE quote_id = ?", (quote_id,)
        ).fetchone()
        if row is None:
            raise ValueError("billing confirmation quote not found")
        matches = (
            row["user_id"] == user_id
            and row["project_id"] == project_id
            and row["canvas_id"] == canvas_id
            and row["feature_key"] == feature_key
            and row["operation_kind"] == operation_kind
            and row["operation_digest"] == digest
            and secrets.compare_digest(
                str(row["receipt_hash"] or ""), _receipt_hash(receipt)
            )
        )
        if not matches:
            raise ValueError(
                "billing confirmation receipt does not match this operation"
            )
        if float(row["expires_at"]) < now:
            raise ValueError("billing confirmation receipt expired")
        if row["status"] not in {"confirmed", "consumed"}:
            raise ValueError("billing confirmation receipt is not confirmed")
        if row["status"] == "confirmed":
            conn.execute(
                """
                UPDATE agent_billing_quotes
                SET status = 'consumed', consumed_at = ?
                WHERE quote_id = ? AND status = 'confirmed'
                """,
                (now, quote_id),
            )
        return {**_quote_payload(row), "status": "consumed"}


def enqueue_billing_settlement(
    *,
    project_dir: Path,
    reservation_id: str,
    project_id: str,
    canvas_id: str,
    draft_id: str,
    action: str,
    metadata: dict[str, Any],
) -> None:
    if not reservation_id:
        return
    now = time.time()
    with _connect(project_dir) as conn:
        conn.execute(
            """
            INSERT INTO agent_billing_settlements (
                reservation_id, project_id, canvas_id, draft_id, action,
                metadata_json, status, next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
            ON CONFLICT(reservation_id) DO UPDATE SET
                action = excluded.action,
                metadata_json = excluded.metadata_json,
                status = CASE
                    WHEN agent_billing_settlements.status IN ('settled', 'settled_projection_pending')
                        THEN agent_billing_settlements.status
                    ELSE 'pending'
                END,
                next_attempt_at = excluded.next_attempt_at,
                updated_at = excluded.updated_at
            """,
            (
                reservation_id,
                project_id,
                canvas_id,
                draft_id,
                action,
                json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
                now,
                now,
                now,
            ),
        )


def due_billing_settlements(
    *, project_dir: Path, limit: int = 50
) -> list[dict[str, Any]]:
    with _connect(project_dir) as conn:
        rows = conn.execute(
            """
            SELECT * FROM agent_billing_settlements
            WHERE status IN ('pending', 'settled_projection_pending')
              AND next_attempt_at <= ?
            ORDER BY next_attempt_at ASC LIMIT ?
            """,
            (time.time(), max(1, min(int(limit), 200))),
        ).fetchall()
    return [
        {
            **dict(row),
            "metadata": json.loads(row["metadata_json"] or "{}"),
        }
        for row in rows
    ]


def mark_billing_settlement_succeeded(
    *, project_dir: Path, reservation_id: str
) -> None:
    now = time.time()
    with _connect(project_dir) as conn:
        conn.execute(
            """
            UPDATE agent_billing_settlements
            SET status = 'settled_projection_pending', settled_at = ?, updated_at = ?, last_error = NULL
            WHERE reservation_id = ?
            """,
            (now, now, reservation_id),
        )


def mark_billing_settlement_projected(
    *, project_dir: Path, reservation_id: str
) -> None:
    """Finish an outbox item only after its local draft projection is durable."""
    now = time.time()
    with _connect(project_dir) as conn:
        conn.execute(
            """
            UPDATE agent_billing_settlements
            SET status = 'settled', updated_at = ?, last_error = NULL
            WHERE reservation_id = ? AND status = 'settled_projection_pending'
            """,
            (now, reservation_id),
        )


def mark_billing_settlement_failed(
    *, project_dir: Path, reservation_id: str, error: str
) -> None:
    now = time.time()
    with _connect(project_dir) as conn:
        row = conn.execute(
            "SELECT attempts FROM agent_billing_settlements WHERE reservation_id = ?",
            (reservation_id,),
        ).fetchone()
        attempts = int(row["attempts"] if row is not None else 0) + 1
        delay = min(15 * (2 ** min(attempts - 1, 8)), 3600)
        conn.execute(
            """
            UPDATE agent_billing_settlements
            SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE reservation_id = ?
            """,
            (attempts, now + delay, str(error)[:500], now, reservation_id),
        )

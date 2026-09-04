"""Durable CE-side identities for billable Agent product generation.

This store contains product execution evidence only. Prices, balances,
reservations and settlement remain owned by the external usage meter (EE).
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from typing import Any

from novelvideo.sqlite_pragmas import configure_sqlite_connection

SCHEMA_VERSION = "freezone_agent_product_operation.v1"
PRODUCT_TASK_TYPES = {
    "workflow_result": "freezone_agent_workflow_result",
    "recipe_result": "freezone_agent_recipe_result",
    "workflow_generate": "freezone_agent_workflow_generate",
    "recipe_generate": "freezone_agent_recipe_generate",
}
AGENT_PRODUCT_PRICE_REFERENCE = tuple(
    {
        "key": f"freezone.agent.{kind}",
        "label": label,
        "billing": "admin_configured",
        "reference_display": "由管理员配置，可显式设为免费",
        "charge_timing": "delivered_result",
    }
    for kind, label in (
        ("workflow_result", "Workflow 结果"),
        ("recipe_result", "Recipe 节点结果"),
        ("workflow_generate", "Workflow Skill 定义生成"),
        ("recipe_generate", "Recipe 定义生成"),
    )
)
PENDING_STATUSES = {"admitting", "reserved", "running", "accepted", "submitted"}
TERMINAL_STATUSES = {"delivered", "failed", "cancelled"}
OPERATION_ID_RE = re.compile(r"^agent_product_[a-zA-Z0-9_-]{1,96}$")


class AgentProductSettlementPending(RuntimeError):
    """The product may still arrive, so its credit reservation must stay open."""

    code = "AGENT_PRODUCT_SETTLEMENT_PENDING"

    def __init__(self, *, operation_id: str, status: str) -> None:
        self.operation_id = operation_id
        self.status = status
        super().__init__(
            f"agent product operation awaits late reconciliation: {status}"
        )


_SCHEMA_READY_PATHS: set[Path] = set()
_SCHEMA_READY_LOCK = threading.Lock()

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS freezone_agent_product_operations (
    operation_id          TEXT PRIMARY KEY,
    schema_version        TEXT NOT NULL,
    idempotency_key       TEXT NOT NULL UNIQUE,
    product_kind          TEXT NOT NULL,
    task_type             TEXT NOT NULL,
    project_id            TEXT NOT NULL,
    canvas_id             TEXT NOT NULL DEFAULT '',
    generation_session_id TEXT NOT NULL,
    artifact_id           TEXT NOT NULL DEFAULT '',
    status                TEXT NOT NULL,
    task_id               TEXT NOT NULL DEFAULT '',
    root_task_id          TEXT NOT NULL DEFAULT '',
    metadata_json         TEXT NOT NULL DEFAULT '{}',
    model_evidence_json   TEXT NOT NULL DEFAULT '{}',
    result_ref_json       TEXT NOT NULL DEFAULT '{}',
    created_at            REAL NOT NULL,
    updated_at            REAL NOT NULL,
    completed_at          REAL
);
CREATE INDEX IF NOT EXISTS idx_agent_product_session
ON freezone_agent_product_operations(generation_session_id, product_kind);
CREATE TABLE IF NOT EXISTS freezone_agent_generation_sessions (
    generation_session_id TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL,
    canvas_id             TEXT NOT NULL DEFAULT '',
    manifest_json         TEXT NOT NULL,
    draft_json            TEXT NOT NULL,
    created_at            REAL NOT NULL,
    updated_at            REAL NOT NULL
);
"""


def _db_path(project_dir: Path) -> Path:
    return Path(project_dir) / "data.db"


@contextmanager
def _connect(project_dir: Path):
    db_path = _db_path(project_dir).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    if db_path not in _SCHEMA_READY_PATHS:
        with _SCHEMA_READY_LOCK:
            if db_path not in _SCHEMA_READY_PATHS:
                configure_sqlite_connection(conn)
                conn.executescript(_SCHEMA_SQL)
                conn.commit()
                _SCHEMA_READY_PATHS.add(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return deepcopy(value)
    try:
        decoded = json.loads(str(value or "{}"))
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "schema_version": row["schema_version"],
        "operation_id": row["operation_id"],
        "idempotency_key": row["idempotency_key"],
        "product_kind": row["product_kind"],
        "task_type": row["task_type"],
        "project_id": row["project_id"],
        "canvas_id": row["canvas_id"],
        "generation_session_id": row["generation_session_id"],
        "artifact_id": row["artifact_id"],
        "status": row["status"],
        "task_id": row["task_id"],
        "root_task_id": row["root_task_id"],
        "metadata": _json_object(row["metadata_json"]),
        "model_evidence": _json_object(row["model_evidence_json"]),
        "result_ref": _json_object(row["result_ref_json"]),
        "created_at": float(row["created_at"]),
        "updated_at": float(row["updated_at"]),
        "completed_at": row["completed_at"],
    }


def create_agent_product_operation(
    *,
    project_dir: Path,
    project_id: str,
    product_kind: str,
    idempotency_key: str,
    generation_session_id: str,
    canvas_id: str = "",
    artifact_id: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    kind = str(product_kind or "").strip()
    task_type = PRODUCT_TASK_TYPES.get(kind)
    if task_type is None:
        raise ValueError("unsupported agent product kind")
    clean_key = str(idempotency_key or "").strip()
    clean_session = str(generation_session_id or "").strip()
    if not clean_key or not clean_session:
        raise ValueError("idempotency_key and generation_session_id are required")
    now = time.time()
    operation_id = f"agent_product_{uuid.uuid4().hex}"
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT * FROM freezone_agent_product_operations WHERE idempotency_key = ?",
            (clean_key,),
        ).fetchone()
        if existing is not None:
            payload = _payload(existing)
            if (
                payload["project_id"] != project_id
                or payload["product_kind"] != kind
                or payload["generation_session_id"] != clean_session
                or payload["artifact_id"] != str(artifact_id or "").strip()
            ):
                raise ValueError(
                    "agent product idempotency key is bound to another operation"
                )
            return payload
        conn.execute(
            """
            INSERT INTO freezone_agent_product_operations(
                operation_id, schema_version, idempotency_key, product_kind, task_type,
                project_id, canvas_id, generation_session_id, artifact_id, status,
                metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitting', ?, ?, ?)
            """,
            (
                operation_id,
                SCHEMA_VERSION,
                clean_key,
                kind,
                task_type,
                project_id,
                str(canvas_id or "").strip(),
                clean_session,
                str(artifact_id or "").strip(),
                json.dumps(metadata or {}, ensure_ascii=False, separators=(",", ":")),
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM freezone_agent_product_operations WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
    assert row is not None
    return _payload(row)


def read_agent_product_operation(
    *, project_dir: Path, operation_id: str
) -> dict[str, Any] | None:
    clean_id = str(operation_id or "").strip()
    if not OPERATION_ID_RE.match(clean_id):
        raise ValueError("invalid agent product operation id")
    with _connect(project_dir) as conn:
        row = conn.execute(
            "SELECT * FROM freezone_agent_product_operations WHERE operation_id = ?",
            (clean_id,),
        ).fetchone()
    return _payload(row) if row is not None else None


def bind_agent_product_task(
    *, project_dir: Path, operation_id: str, task_id: str, root_task_id: str
) -> dict[str, Any]:
    clean_task_id = str(task_id or "").strip()
    clean_root_id = str(root_task_id or "").strip()
    if not clean_task_id or not clean_root_id:
        raise ValueError("task identity is required")
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute(
            "SELECT * FROM freezone_agent_product_operations WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
        if current is None:
            raise ValueError("agent product operation not found")
        payload = _payload(current)
        if payload["task_id"] and payload["task_id"] != clean_task_id:
            raise ValueError("agent product operation is bound to another task")
        conn.execute(
            """
            UPDATE freezone_agent_product_operations
               SET task_id = ?, root_task_id = ?, status = 'reserved', updated_at = ?
             WHERE operation_id = ?
            """,
            (clean_task_id, clean_root_id, time.time(), operation_id),
        )
        row = conn.execute(
            "SELECT * FROM freezone_agent_product_operations WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
    assert row is not None
    return _payload(row)


def finish_agent_product_operation(
    *,
    project_dir: Path,
    operation_id: str,
    outcome: str,
    expected_task_id: str,
    model_evidence: dict[str, Any] | None = None,
    result_ref: dict[str, Any] | None = None,
) -> dict[str, Any]:
    status = str(outcome or "").strip()
    if status not in PENDING_STATUSES | TERMINAL_STATUSES:
        raise ValueError("invalid agent product operation outcome")
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute(
            "SELECT * FROM freezone_agent_product_operations WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
        if current is None:
            raise ValueError("agent product operation not found")
        payload = _payload(current)
        if payload["task_id"] != str(expected_task_id or "").strip():
            raise ValueError("agent product operation task identity mismatch")
        if payload["status"] in TERMINAL_STATUSES:
            if payload["status"] != status:
                raise ValueError(
                    "agent product operation already has another terminal outcome"
                )
            return payload
        evidence = model_evidence if isinstance(model_evidence, dict) else {}
        result = result_ref if isinstance(result_ref, dict) else {}
        if status == "delivered":
            if not evidence.get("model_call_id") or not evidence.get("executed_at"):
                raise ValueError(
                    "delivered result requires trusted model execution evidence"
                )
            if not result.get("kind") or not result.get("id"):
                raise ValueError(
                    "delivered result requires a durable product result reference"
                )
        now = time.time()
        conn.execute(
            """
            UPDATE freezone_agent_product_operations
               SET status = ?, model_evidence_json = ?, result_ref_json = ?,
                   updated_at = ?, completed_at = ?
             WHERE operation_id = ?
            """,
            (
                status,
                json.dumps(evidence, ensure_ascii=False, separators=(",", ":")),
                json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                now,
                now if status in TERMINAL_STATUSES else None,
                operation_id,
            ),
        )
        row = conn.execute(
            "SELECT * FROM freezone_agent_product_operations WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
    assert row is not None
    return _payload(row)


def save_agent_generation_session(
    *,
    project_dir: Path,
    generation_session_id: str,
    project_id: str,
    canvas_id: str,
    manifest: dict[str, Any],
    draft: dict[str, Any],
) -> dict[str, Any]:
    session_id = str(generation_session_id or "").strip()
    if not session_id:
        raise ValueError("generation_session_id is required")
    now = time.time()
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT project_id FROM freezone_agent_generation_sessions WHERE generation_session_id = ?",
            (session_id,),
        ).fetchone()
        if existing is not None and str(existing["project_id"]) != str(project_id):
            raise ValueError("generation session belongs to another project")
        conn.execute(
            """
            INSERT INTO freezone_agent_generation_sessions(
                generation_session_id, project_id, canvas_id, manifest_json,
                draft_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(generation_session_id) DO UPDATE SET
                canvas_id = excluded.canvas_id,
                manifest_json = excluded.manifest_json,
                draft_json = excluded.draft_json,
                updated_at = excluded.updated_at
            """,
            (
                session_id,
                project_id,
                canvas_id,
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
                json.dumps(draft, ensure_ascii=False, separators=(",", ":")),
                now,
                now,
            ),
        )
    return {
        "generation_session_id": session_id,
        "project_id": project_id,
        "canvas_id": canvas_id,
        "manifest": deepcopy(manifest),
        "draft": deepcopy(draft),
        "updated_at": now,
    }


def read_agent_generation_session(
    *, project_dir: Path, generation_session_id: str
) -> dict[str, Any] | None:
    session_id = str(generation_session_id or "").strip()
    if not session_id:
        raise ValueError("generation_session_id is required")
    with _connect(project_dir) as conn:
        row = conn.execute(
            "SELECT * FROM freezone_agent_generation_sessions WHERE generation_session_id = ?",
            (session_id,),
        ).fetchone()
    if row is None:
        return None
    return {
        "generation_session_id": session_id,
        "project_id": row["project_id"],
        "canvas_id": row["canvas_id"],
        "manifest": _json_object(row["manifest_json"]),
        "draft": _json_object(row["draft_json"]),
        "created_at": float(row["created_at"]),
        "updated_at": float(row["updated_at"]),
    }

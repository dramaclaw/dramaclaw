"""Project-local SQLite persistence for Freezone workflow drafts."""

from __future__ import annotations

import hashlib
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

from novelvideo.freezone.paths import CANVAS_ID_RE
from novelvideo.sqlite_pragmas import configure_sqlite_connection

SCHEMA_VERSION = "freezone_workflow_draft.v1"
DEFAULT_TTL_SECONDS = 24 * 60 * 60
DRAFT_ID_RE = re.compile(r"^workflow_draft_[a-zA-Z0-9_-]{1,80}$")
DRAFT_STATUSES = {"ready", "confirming", "submitted", "confirmed"}
CONFIRMATION_OUTCOMES = {"ready", "submitted", "confirmed"}

WORKFLOW_DRAFT_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS workflow_drafts (
    draft_id                 TEXT PRIMARY KEY,
    schema_version           TEXT NOT NULL,
    project_id               TEXT NOT NULL,
    canvas_id                TEXT NOT NULL,
    revision                 INTEGER NOT NULL,
    status                   TEXT NOT NULL,
    skill_id                 TEXT NOT NULL DEFAULT '',
    run_after_create         INTEGER NOT NULL DEFAULT 0,
    intent_json              TEXT NOT NULL,
    compiled_json            TEXT NOT NULL,
    preview_json             TEXT NOT NULL,
    last_changes_json        TEXT NOT NULL DEFAULT '{}',
    operation_id             TEXT NOT NULL DEFAULT '',
    task_id                  TEXT NOT NULL DEFAULT '',
    root_task_id             TEXT NOT NULL DEFAULT '',
    plan_digest              TEXT NOT NULL,
    created_at               REAL NOT NULL,
    updated_at               REAL NOT NULL,
    expires_at               REAL NOT NULL,
    confirmation_started_at  REAL,
    confirmed_at             REAL
);
CREATE INDEX IF NOT EXISTS idx_workflow_drafts_canvas_updated
ON workflow_drafts(canvas_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_drafts_expiry
ON workflow_drafts(expires_at);
"""

_SCHEMA_READY_PATHS: set[Path] = set()
_SCHEMA_READY_LOCK = threading.Lock()


def workflow_drafts_db_path(project_dir: Path) -> Path:
    return Path(project_dir) / "data.db"


def _configure_existing_connection(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")


@contextmanager
def _connect(project_dir: Path):
    db_path = workflow_drafts_db_path(project_dir).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    if db_path not in _SCHEMA_READY_PATHS:
        with _SCHEMA_READY_LOCK:
            if db_path not in _SCHEMA_READY_PATHS:
                configure_sqlite_connection(conn)
                conn.executescript(WORKFLOW_DRAFT_SCHEMA_SQL)
                columns = {
                    str(row[1])
                    for row in conn.execute("PRAGMA table_info(workflow_drafts)")
                }
                if "task_id" not in columns:
                    conn.execute(
                        "ALTER TABLE workflow_drafts ADD COLUMN task_id TEXT NOT NULL DEFAULT ''"
                    )
                if "operation_id" not in columns:
                    conn.execute(
                        "ALTER TABLE workflow_drafts ADD COLUMN operation_id TEXT NOT NULL DEFAULT ''"
                    )
                if "root_task_id" not in columns:
                    conn.execute(
                        "ALTER TABLE workflow_drafts ADD COLUMN root_task_id TEXT NOT NULL DEFAULT ''"
                    )
                conn.commit()
                _SCHEMA_READY_PATHS.add(db_path)
            else:
                _configure_existing_connection(conn)
    else:
        _configure_existing_connection(conn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _validate_scope(canvas_id: str, draft_id: str | None = None) -> None:
    if not CANVAS_ID_RE.match(canvas_id):
        raise ValueError(f"invalid canvas_id: {canvas_id!r}")
    if draft_id is not None and not DRAFT_ID_RE.match(draft_id):
        raise ValueError("invalid workflow draft id")


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return deepcopy(value)
    try:
        decoded = json.loads(str(value or "{}"))
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def _plan_preview(compiled: dict[str, Any]) -> dict[str, Any]:
    plan = compiled.get("plan") if isinstance(compiled.get("plan"), dict) else {}
    nodes = plan.get("nodes") if isinstance(plan.get("nodes"), list) else []
    phases = plan.get("phases") if isinstance(plan.get("phases"), list) else []
    preview_nodes: list[dict[str, Any]] = []
    recipe_pipelines: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        catalog = (
            data.get("workflowCatalog")
            if isinstance(data.get("workflowCatalog"), dict)
            else {}
        )
        primary_recipe_id = str(catalog.get("recipeId") or "").strip()
        primary_recipe_name = str(catalog.get("recipeName") or "").strip()
        raw_pipeline = (
            catalog.get("recipePipeline")
            if isinstance(catalog.get("recipePipeline"), list)
            else []
        )
        pipeline_steps: list[dict[str, Any]] = []
        if primary_recipe_id:
            pipeline_steps.append(
                {
                    "role": "primary",
                    "id": primary_recipe_id,
                    "name": primary_recipe_name or primary_recipe_id,
                    "version": catalog.get("recipeVersion"),
                }
            )
        for item in raw_pipeline:
            value = item if isinstance(item, dict) else {"id": item}
            recipe_id = str(value.get("id") or "").strip()
            if recipe_id:
                pipeline_steps.append(
                    {
                        "role": "supplemental",
                        "id": recipe_id,
                        "name": str(value.get("name") or recipe_id).strip(),
                        "version": value.get("version"),
                    }
                )
        node_name = str(
            node.get("name")
            or data.get("displayName")
            or data.get("title")
            or node.get("id")
            or ""
        ).strip()
        preview_nodes.append(
            {
                "id": str(node.get("id") or "").strip(),
                "name": node_name,
                "stage": str(node.get("stage") or "").strip(),
                "node_type": str(node.get("node_type") or "").strip(),
                **(
                    {"recipe_pipeline": deepcopy(pipeline_steps)}
                    if pipeline_steps
                    else {}
                ),
            }
        )
        if pipeline_steps:
            recipe_pipelines.append(
                {
                    "node_id": str(node.get("id") or "").strip(),
                    "node_name": node_name,
                    "steps": pipeline_steps,
                }
            )
    return {
        "planner": deepcopy(compiled.get("planner") or plan.get("planner") or {}),
        "preflight": deepcopy(compiled.get("preflight") or {}),
        "title": str(plan.get("summary") or "").strip(),
        "skill_id": str(compiled.get("skill_id") or "").strip(),
        "inputs": deepcopy(plan.get("inputs") or {}),
        "phases": [str(item).strip() for item in phases if str(item).strip()],
        "nodes": preview_nodes,
        "recipe_pipelines": recipe_pipelines,
        "node_count": len(preview_nodes),
        "edge_count": int(compiled.get("edge_count") or 0),
    }


def _payload_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "schema_version": row["schema_version"],
        "draft_id": row["draft_id"],
        "revision": int(row["revision"]),
        "status": row["status"],
        "project_id": row["project_id"],
        "canvas_id": row["canvas_id"],
        "skill_id": row["skill_id"],
        "run_after_create": bool(row["run_after_create"]),
        "intent": _json_object(row["intent_json"]),
        "compiled": _json_object(row["compiled_json"]),
        "preview": _json_object(row["preview_json"]),
        "plan_digest": row["plan_digest"],
        "last_changes": _json_object(row["last_changes_json"]),
        "operation_id": row["operation_id"],
        "task_id": row["task_id"],
        "root_task_id": row["root_task_id"],
        "created_at": float(row["created_at"]),
        "updated_at": float(row["updated_at"]),
        "expires_at": float(row["expires_at"]),
        "confirmation_started_at": row["confirmation_started_at"],
        "confirmed_at": row["confirmed_at"],
    }


def _read_draft(
    conn: sqlite3.Connection,
    *,
    canvas_id: str,
    draft_id: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM workflow_drafts WHERE canvas_id = ? AND draft_id = ?",
        (canvas_id, draft_id),
    ).fetchone()
    return _payload_from_row(row) if row is not None else None


def _write_draft(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO workflow_drafts (
            draft_id, schema_version, project_id, canvas_id, revision, status,
            skill_id, run_after_create, intent_json, compiled_json, preview_json,
            last_changes_json, operation_id, task_id, root_task_id,
            plan_digest, created_at, updated_at, expires_at,
            confirmation_started_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id) DO UPDATE SET
            revision = excluded.revision,
            status = excluded.status,
            skill_id = excluded.skill_id,
            run_after_create = excluded.run_after_create,
            intent_json = excluded.intent_json,
            compiled_json = excluded.compiled_json,
            preview_json = excluded.preview_json,
            last_changes_json = excluded.last_changes_json,
            operation_id = excluded.operation_id,
            task_id = excluded.task_id,
            root_task_id = excluded.root_task_id,
            plan_digest = excluded.plan_digest,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at,
            confirmation_started_at = excluded.confirmation_started_at,
            confirmed_at = excluded.confirmed_at
        """,
        (
            payload["draft_id"],
            payload["schema_version"],
            payload["project_id"],
            payload["canvas_id"],
            payload["revision"],
            payload["status"],
            payload.get("skill_id") or "",
            int(bool(payload.get("run_after_create"))),
            json.dumps(
                payload.get("intent") or {}, ensure_ascii=False, separators=(",", ":")
            ),
            json.dumps(
                payload.get("compiled") or {}, ensure_ascii=False, separators=(",", ":")
            ),
            json.dumps(
                payload.get("preview") or {}, ensure_ascii=False, separators=(",", ":")
            ),
            json.dumps(
                payload.get("last_changes") or {},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            payload.get("operation_id") or "",
            payload.get("task_id") or "",
            payload.get("root_task_id") or "",
            payload["plan_digest"],
            payload["created_at"],
            payload["updated_at"],
            payload["expires_at"],
            payload.get("confirmation_started_at"),
            payload.get("confirmed_at"),
        ),
    )


def _unavailable(error: str) -> dict[str, Any]:
    return {"ok": False, "status": "workflow_draft_unavailable", "error": error}


def create_workflow_draft(
    *,
    project_dir: Path,
    project_id: str,
    canvas_id: str,
    intent: dict[str, Any],
    compiled: dict[str, Any],
    run_after_create: bool = False,
    operation_id: str = "",
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> dict[str, Any]:
    _validate_scope(canvas_id)
    if not isinstance(intent, dict):
        raise ValueError("workflow draft intent must be an object")
    if not isinstance(compiled, dict) or not compiled.get("ok"):
        raise ValueError("workflow draft compiled plan is invalid")
    now = time.time()
    payload = {
        "schema_version": SCHEMA_VERSION,
        "draft_id": f"workflow_draft_{uuid.uuid4().hex}",
        "revision": 1,
        "status": "ready",
        "project_id": project_id,
        "canvas_id": canvas_id,
        "skill_id": str(compiled.get("skill_id") or "").strip(),
        "run_after_create": bool(run_after_create),
        "intent": deepcopy(intent),
        "compiled": deepcopy(compiled),
        "preview": _plan_preview(compiled),
        "plan_digest": _digest(compiled.get("plan")),
        "last_changes": {},
        "operation_id": str(operation_id or "").strip(),
        "task_id": "",
        "root_task_id": "",
        "created_at": now,
        "updated_at": now,
        "expires_at": now + max(int(ttl_seconds), 300),
        "confirmation_started_at": None,
        "confirmed_at": None,
    }
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        _write_draft(conn, payload)
    return deepcopy(payload)


def read_workflow_draft(
    *,
    project_dir: Path,
    canvas_id: str,
    draft_id: str,
) -> tuple[dict[str, Any] | None, str | None]:
    _validate_scope(canvas_id, draft_id)
    with _connect(project_dir) as conn:
        payload = _read_draft(conn, canvas_id=canvas_id, draft_id=draft_id)
    if payload is None:
        return None, "workflow draft not found"
    if (
        float(payload.get("expires_at") or 0) < time.time()
        and payload.get("status") == "ready"
    ):
        return None, "workflow draft expired"
    return payload, None


def patch_workflow_draft(
    *,
    project_dir: Path,
    canvas_id: str,
    draft_id: str,
    expected_revision: int,
    intent: dict[str, Any],
    compiled: dict[str, Any],
    last_changes: dict[str, Any] | None = None,
    run_after_create: bool | None = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    _validate_scope(canvas_id, draft_id)
    if not isinstance(intent, dict):
        return None, _unavailable("workflow draft intent must be an object")
    if not isinstance(compiled, dict) or not compiled.get("ok"):
        return None, _unavailable("workflow draft compiled plan is invalid")
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        payload = _read_draft(conn, canvas_id=canvas_id, draft_id=draft_id)
        if payload is None:
            return None, _unavailable("workflow draft not found")
        if float(payload.get("expires_at") or 0) < time.time():
            return None, _unavailable("workflow draft expired")
        if payload["status"] != "ready":
            return None, {
                "ok": False,
                "status": "workflow_draft_not_editable",
                "error": f"workflow draft cannot be patched while status is {payload['status']}",
            }
        current_revision = int(payload["revision"])
        if expected_revision != current_revision:
            return None, {
                "ok": False,
                "status": "workflow_draft_revision_conflict",
                "error": (
                    f"workflow draft revision changed: expected {expected_revision}, "
                    f"current {current_revision}"
                ),
                "current_revision": current_revision,
            }
        skill_id = str(compiled.get("skill_id") or "").strip()
        if skill_id != str(payload.get("skill_id") or ""):
            return None, {
                "ok": False,
                "status": "invalid_workflow_draft_patch",
                "error": "workflow draft skill_id cannot be changed",
                "unsupported_fields": ["skill_id"],
            }
        now = time.time()
        payload.update(
            {
                "revision": current_revision + 1,
                "intent": deepcopy(intent),
                "compiled": deepcopy(compiled),
                "preview": _plan_preview(compiled),
                "plan_digest": _digest(compiled.get("plan")),
                "last_changes": deepcopy(last_changes or {}),
                "updated_at": now,
                "expires_at": now + max(int(ttl_seconds), 300),
                "confirmation_started_at": None,
                "confirmed_at": None,
                "task_id": "",
                "root_task_id": "",
            }
        )
        if run_after_create is not None:
            payload["run_after_create"] = bool(run_after_create)
        _write_draft(conn, payload)
        return deepcopy(payload), None


def claim_workflow_draft_confirmation(
    *,
    project_dir: Path,
    canvas_id: str,
    draft_id: str,
    revision: int,
    now: float | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    _validate_scope(canvas_id, draft_id)
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        payload = _read_draft(conn, canvas_id=canvas_id, draft_id=draft_id)
        if payload is None:
            return None, _unavailable("workflow draft not found")
        claim_time = time.time() if now is None else float(now)
        expired = float(payload.get("expires_at") or 0) < claim_time
        if expired and payload["status"] == "ready":
            return None, _unavailable("workflow draft expired")
        current_revision = int(payload["revision"])
        if revision != current_revision:
            return None, {
                "ok": False,
                "status": "workflow_draft_revision_conflict",
                "error": (
                    f"workflow draft revision changed: expected {revision}, "
                    f"current {current_revision}"
                ),
                "current_revision": current_revision,
            }
        if payload["status"] == "confirmed":
            return None, {
                **public_workflow_draft(payload),
                "ok": False,
                "status": "workflow_draft_already_confirmed",
                "message": "该工作流方案已经创建，不会重复创建节点。",
            }
        if payload["status"] in {"confirming", "submitted"}:
            return None, {
                **public_workflow_draft(payload),
                "ok": False,
                "status": "workflow_draft_confirmation_in_progress",
                "message": "该工作流方案正在创建或已经提交，不会重复创建节点。",
            }
        now = claim_time
        payload.update(
            {
                "status": "confirming",
                "confirmation_started_at": now,
                "updated_at": now,
            }
        )
        _write_draft(conn, payload)
        return deepcopy(payload), None


def bind_workflow_draft_task(
    *,
    project_dir: Path,
    canvas_id: str,
    draft_id: str,
    task_id: str,
    root_task_id: str,
) -> dict[str, Any] | None:
    """Project the durable task identity onto its presentation draft."""
    _validate_scope(canvas_id, draft_id)
    clean_task_id = str(task_id or "").strip()
    clean_root_task_id = str(root_task_id or "").strip()
    if not clean_task_id or not clean_root_task_id:
        raise ValueError("workflow confirmation task identity is required")
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        payload = _read_draft(conn, canvas_id=canvas_id, draft_id=draft_id)
        if payload is None:
            return None
        existing = str(payload.get("task_id") or "")
        if existing and existing != clean_task_id:
            raise ValueError("workflow draft is bound to a different task")
        payload["task_id"] = clean_task_id
        payload["root_task_id"] = clean_root_task_id
        payload["updated_at"] = time.time()
        _write_draft(conn, payload)
        return deepcopy(payload)


def finish_workflow_draft_confirmation(
    *,
    project_dir: Path,
    canvas_id: str,
    draft_id: str,
    outcome: str,
    expected_task_id: str = "",
) -> dict[str, Any] | None:
    _validate_scope(canvas_id, draft_id)
    if outcome not in CONFIRMATION_OUTCOMES:
        raise ValueError(f"unsupported workflow draft confirmation outcome: {outcome}")
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        payload = _read_draft(conn, canvas_id=canvas_id, draft_id=draft_id)
        if payload is None:
            return None
        bound_task_id = str(payload.get("task_id") or "")
        if expected_task_id and expected_task_id != bound_task_id:
            raise ValueError("workflow draft confirmation task changed")
        current_status = str(payload.get("status") or "")
        # Browser delivery and task settlement race independently. Once the
        # browser has confirmed delivery, a late timeout/submitted callback
        # from the task runner must not move the presentation state backward.
        if current_status == "confirmed":
            return deepcopy(payload)
        # A submitted operation may still reconcile to confirmed. Returning it
        # to ready would incorrectly invite a duplicate confirmation attempt.
        if current_status == "submitted" and outcome == "ready":
            return deepcopy(payload)
        now = time.time()
        payload["status"] = outcome
        payload["updated_at"] = now
        if outcome == "confirmed":
            payload["confirmed_at"] = now
        elif outcome == "ready":
            payload["confirmation_started_at"] = None
        _write_draft(conn, payload)
        return deepcopy(payload)


def prune_expired_workflow_drafts(
    *,
    project_dir: Path,
    canvas_id: str | None = None,
    now: float | None = None,
) -> int:
    if canvas_id is not None:
        _validate_scope(canvas_id)
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        cutoff = time.time() if now is None else float(now)
        query = "SELECT * FROM workflow_drafts WHERE expires_at < ?"
        params: tuple[Any, ...] = (cutoff,)
        if canvas_id is not None:
            query += " AND canvas_id = ?"
            params = (cutoff, canvas_id)
        deleted = 0
        for row in conn.execute(query, params).fetchall():
            payload = _payload_from_row(row)
            if payload.get("status") in {"confirming", "submitted"}:
                continue
            cursor = conn.execute(
                "DELETE FROM workflow_drafts WHERE draft_id = ?", (payload["draft_id"],)
            )
            deleted += max(int(cursor.rowcount), 0)
        return deleted


def public_workflow_draft(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "status": "workflow_draft_ready",
        "schema_version": SCHEMA_VERSION,
        "draft_id": payload.get("draft_id"),
        "revision": payload.get("revision"),
        "draft_status": payload.get("status"),
        "skill_id": payload.get("skill_id"),
        "plan_digest": payload.get("plan_digest"),
        "run_after_create": bool(payload.get("run_after_create")),
        "preview": deepcopy(payload.get("preview") or {}),
        "last_changes": deepcopy(payload.get("last_changes") or {}),
        "expires_at": payload.get("expires_at"),
        "task_id": payload.get("task_id") or None,
        "root_task_id": payload.get("root_task_id") or None,
        "message": "工作流方案草稿已准备完成，可继续调整或确认创建。",
    }

"""Persistent execution records for Freezone canvas workflows."""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from novelvideo.freezone.paths import CANVAS_ID_RE
from novelvideo.sqlite_pragmas import configure_sqlite_connection

RUN_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")
IDEMPOTENCY_KEY_RE = re.compile(r"^[a-zA-Z0-9._:-]{1,160}$")
RUNNER_ID_RE = re.compile(r"^[a-zA-Z0-9._:-]{1,160}$")
RUN_STATUSES = {"running", "completed", "failed", "cancelled", "interrupted"}
NODE_STATUSES = {"pending", "running", "completed", "failed", "blocked", "skipped"}
NODE_PHASES = {
    "waiting_dependencies",
    "waiting_slot",
    "waiting_capacity",
    "preparing",
    "compiling_recipe",
    "submitting",
    "generating",
    "syncing_result",
    "retrying",
}
RESUMABLE_RUN_STATUSES = {"running", "failed", "interrupted"}
RESUMABLE_ACTION_STATUSES = {"pending", "running", "failed", "blocked"}
TERMINAL_RUN_STATUSES = {"completed", "failed", "cancelled", "interrupted"}
WORKFLOW_RUN_LEASE_SECONDS = 45
ACTIVE_TASK_STATUSES = {"pending", "starting", "submitting", "queued", "running"}
TERMINAL_TASK_STATUSES = {"completed", "failed", "cancelled"}
GENERATION_ACTIONS = {
    "generate_text",
    "generate_story_script",
    "generate_image",
    "generate_video",
    "generate_text_video",
    "generate_audio",
    "generate_3gs_world",
    "auto_compose_video",
}
NON_RETRYABLE_ERROR_MARKERS = {
    "401",
    "403",
    "invalid token",
    "model_not_found",
    "sensitivecontent",
    "privacyinformation",
    "audio_url is required",
    "quota has been exhausted",
}
RETRYABLE_ERROR_MARKERS = {
    "408",
    "429",
    "502",
    "503",
    "504",
    "timed out",
    "timeout",
    "econnreset",
    "connection reset",
    "bad_response_body",
}
REQUEST_ID_RE = re.compile(
    r"(?:request[_\s-]*id\s*[=:]\s*|request\s+id\s*:\s*)" r"([a-zA-Z0-9._:-]+)",
    re.IGNORECASE,
)
WORKFLOW_RUN_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id              TEXT PRIMARY KEY,
    schema_version      TEXT NOT NULL,
    project_id          TEXT NOT NULL,
    canvas_id           TEXT NOT NULL,
    status              TEXT NOT NULL,
    resumable           INTEGER NOT NULL DEFAULT 1,
    actor_id             TEXT,
    runner_id            TEXT,
    lease_expires_at     TEXT,
    idempotency_key      TEXT,
    metadata_json        TEXT NOT NULL DEFAULT '{}',
    created_at           TEXT NOT NULL,
    started_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    completed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_canvas_created
ON workflow_runs(canvas_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_canvas_status
ON workflow_runs(canvas_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_canvas_idempotency
ON workflow_runs(canvas_id, idempotency_key)
WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';

CREATE TABLE IF NOT EXISTS workflow_run_actions (
    run_id              TEXT NOT NULL,
    node_id             TEXT NOT NULL,
    action              TEXT NOT NULL,
    sequence_no         INTEGER NOT NULL,
    status              TEXT NOT NULL,
    phase               TEXT,
    updated_at           TEXT,
    error               TEXT,
    error_category      TEXT,
    retryable           INTEGER,
    error_request_id    TEXT,
    error_fingerprint   TEXT,
    user_error           TEXT,
    task_key             TEXT,
    task_type            TEXT,
    job_id               TEXT,
    retry_count          INTEGER NOT NULL DEFAULT 0,
    artifact_status      TEXT,
    recipe_id            TEXT,
    recipe_version       TEXT,
    generation_attempt_id TEXT,
    product_operation_id TEXT,
    PRIMARY KEY (run_id, node_id, action),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_actions_task_key
ON workflow_run_actions(task_key);
CREATE INDEX IF NOT EXISTS idx_workflow_run_actions_status
ON workflow_run_actions(run_id, status, sequence_no);
"""
_SCHEMA_READY_PATHS: set[Path] = set()
_SCHEMA_READY_LOCK = threading.Lock()


class WorkflowRunLeaseConflict(RuntimeError):
    """Raised when another live runner owns the canvas workflow lease."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _timestamp(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _lease_expires_at(now: datetime) -> str:
    return _timestamp(now + timedelta(seconds=WORKFLOW_RUN_LEASE_SECONDS))


def classify_workflow_error(error: str | None) -> tuple[str, bool]:
    normalized = str(error or "").strip().lower()
    if not normalized:
        return "unknown", False
    if (
        "invalidparameter" in normalized
        or "invalid parameter" in normalized
        or "parameter `content`" in normalized
        or "parameter video total duration" in normalized
    ):
        return "invalid_request", False
    if any(marker in normalized for marker in NON_RETRYABLE_ERROR_MARKERS):
        if "sensitivecontent" in normalized or "privacyinformation" in normalized:
            return "content_policy", False
        if "model_not_found" in normalized:
            return "model_unavailable", False
        if "quota has been exhausted" in normalized:
            return "quota_exhausted", False
        if "audio_url is required" in normalized:
            return "invalid_request", False
        return "authentication", False
    if any(marker in normalized for marker in RETRYABLE_ERROR_MARKERS):
        return "transient_upstream", True
    if "产物" in normalized and ("不存在" in normalized or "缺失" in normalized):
        return "artifact_missing", False
    return "execution", False


def workflow_error_diagnostics(error: str | None) -> dict[str, Any]:
    raw_error = str(error or "").strip()
    category, retryable = classify_workflow_error(raw_error)
    request_match = REQUEST_ID_RE.search(raw_error)
    request_id = request_match.group(1).rstrip(")}],;") if request_match else None
    normalized_message = re.sub(r"\s+", " ", raw_error).strip().lower()
    fingerprint = (
        f"request:{request_id.lower()}"
        if request_id
        else f"{category}:{normalized_message[:500]}"
    )
    if category == "authentication":
        user_message = "模型服务认证失败，请检查渠道地址和密钥后重试。"
    elif category == "model_unavailable":
        user_message = "当前渠道没有可用的目标模型，请更换模型或配置渠道。"
    elif category == "quota_exhausted":
        user_message = "当前模型渠道额度已用尽，请补充额度或切换渠道。"
    elif category == "content_policy":
        if "outputvideosensitivecontentdetected" in normalized_message:
            user_message = (
                "内容安全审核未通过（输出视频）：模型拒绝了本次生成结果，"
                "请调整敏感情节或画面描述后重试。"
            )
        elif "outputimagesensitivecontentdetected" in normalized_message:
            user_message = (
                "内容安全审核未通过（输出图片）：模型拒绝了本次生成结果，"
                "请调整敏感内容描述后重试。"
            )
        elif "inputimagesensitivecontentdetected" in normalized_message:
            user_message = (
                "内容安全审核未通过（输入图片）：如包含已获授权的真人，"
                "请开启真人素材审核后重试。"
            )
        else:
            user_message = (
                "内容安全审核未通过：模型拒绝了本次生成请求，"
                "请调整提示词或更换素材后重试。"
            )
    elif category == "invalid_request":
        if "video total duration" in normalized_message:
            user_message = "输入视频总时长超过当前模型限制，请缩短素材或拆分生成。"
        elif "audio_url is required" in normalized_message:
            user_message = (
                "当前音频模型需要参考音频，请上传样音或切换为无需样音的模型。"
            )
        else:
            user_message = "生成参数不符合当前模型要求，请调整节点参数后重试。"
    elif category == "artifact_missing":
        user_message = "任务已结束但没有找到有效产物，请重新生成该节点。"
    elif category == "transient_upstream":
        user_message = "上游模型服务暂时不可用，系统可稍后重试。"
    elif category == "unknown":
        user_message = "生成任务失败，但没有返回具体错误。"
    else:
        user_message = "节点生成失败，请检查节点输入和模型配置后重试。"
    return {
        "error_category": category,
        "retryable": retryable,
        "error_request_id": request_id,
        "error_fingerprint": fingerprint,
        "user_error": user_message,
    }


def _artifact_values(value: Any, *, key: str = "") -> list[tuple[str, str]]:
    values: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for child_key, child in value.items():
            values.extend(_artifact_values(child, key=str(child_key)))
    elif isinstance(value, list):
        for child in value:
            values.extend(_artifact_values(child, key=key))
    elif isinstance(value, str):
        lowered = key.lower()
        if lowered in {"url", "path", "content", "text"} or lowered.endswith(
            ("_url", "_path")
        ):
            values.append((lowered, value.strip()))
    return [
        (candidate_key, candidate) for candidate_key, candidate in values if candidate
    ]


def _is_output_artifact_key(key: str) -> bool:
    lowered = key.lower()
    if any(marker in lowered for marker in ("input", "source", "reference", "prompt")):
        return False
    return (
        lowered in {"url", "path"}
        or lowered.startswith(("output_", "result_"))
        or lowered.endswith(("_url", "_path"))
    )


def _validate_action_artifact(
    *,
    action: str,
    task_result: dict[str, Any] | None,
    history_record: dict[str, Any] | None,
    project_dir: Path,
) -> tuple[str, str | None]:
    if action not in GENERATION_ACTIONS:
        return "not_required", None
    sources = [
        task_result if isinstance(task_result, dict) else {},
        (
            history_record.get("result")
            if isinstance(history_record, dict)
            and isinstance(history_record.get("result"), dict)
            else {}
        ),
    ]
    candidates = [
        candidate for source in sources for candidate in _artifact_values(source)
    ]
    if action in {"generate_text", "generate_story_script"}:
        text_values = [value for key, value in candidates if key in {"content", "text"}]
        if text_values:
            return "valid", None
    media_candidates = [
        value for key, value in candidates if _is_output_artifact_key(key)
    ]
    if not media_candidates:
        return "unverified", None
    missing_local_paths: list[str] = []
    for value in media_candidates:
        lowered = value.lower()
        if lowered.startswith(
            ("http://", "https://", "blob:", "data:", "/static/", "/api/")
        ):
            return "valid", None
        path = Path(value)
        candidate_path = path if path.is_absolute() else project_dir / path
        if candidate_path.is_file() and candidate_path.stat().st_size > 0:
            return "valid", None
        missing_local_paths.append(value)
    if missing_local_paths:
        return "missing", f"任务完成但产物文件不存在：{missing_local_paths[0]}"
    return "unverified", None


def workflow_runs_db_path(project_dir: Path) -> Path:
    return Path(project_dir) / "data.db"


def _configure_existing_connection(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")


@contextmanager
def _connect(project_dir: Path):
    db_path = workflow_runs_db_path(project_dir).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    if db_path not in _SCHEMA_READY_PATHS:
        with _SCHEMA_READY_LOCK:
            if db_path not in _SCHEMA_READY_PATHS:
                configure_sqlite_connection(conn)
                conn.executescript(WORKFLOW_RUN_SCHEMA_SQL)
                columns = {
                    str(row[1])
                    for row in conn.execute("PRAGMA table_info(workflow_run_actions)")
                }
                for column in (
                    "recipe_id",
                    "recipe_version",
                    "generation_attempt_id",
                    "product_operation_id",
                ):
                    if column not in columns:
                        conn.execute(
                            f"ALTER TABLE workflow_run_actions ADD COLUMN {column} TEXT"
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


def _validate_scope(canvas_id: str, run_id: str | None = None) -> None:
    if not CANVAS_ID_RE.match(canvas_id):
        raise ValueError(f"invalid canvas_id: {canvas_id!r}")
    if run_id is not None and not RUN_ID_RE.match(run_id):
        raise ValueError(f"invalid run_id: {run_id!r}")


def _decode_metadata(value: Any) -> dict[str, Any]:
    try:
        decoded = json.loads(str(value or "{}"))
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _action_from_row(row: sqlite3.Row) -> dict[str, Any]:
    action: dict[str, Any] = {
        "node_id": row["node_id"],
        "action": row["action"],
        "status": row["status"],
        "phase": row["phase"],
        "updated_at": row["updated_at"],
        "error": row["error"],
        "task_key": row["task_key"],
        "task_type": row["task_type"],
        "job_id": row["job_id"],
        "retry_count": int(row["retry_count"] or 0),
        "recipe_id": row["recipe_id"],
        "recipe_version": row["recipe_version"],
        "generation_attempt_id": row["generation_attempt_id"],
        "product_operation_id": row["product_operation_id"],
    }
    for field in (
        "error_category",
        "error_request_id",
        "error_fingerprint",
        "user_error",
        "artifact_status",
    ):
        if row[field] is not None:
            action[field] = row[field]
    if row["retryable"] is not None:
        action["retryable"] = bool(row["retryable"])
    return action


def _read_run(
    conn: sqlite3.Connection,
    *,
    canvas_id: str,
    run_id: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM workflow_runs WHERE canvas_id = ? AND run_id = ?",
        (canvas_id, run_id),
    ).fetchone()
    if row is None:
        return None
    action_rows = conn.execute(
        """
        SELECT * FROM workflow_run_actions
        WHERE run_id = ?
        ORDER BY sequence_no ASC
        """,
        (run_id,),
    ).fetchall()
    return {
        "schema_version": row["schema_version"],
        "run_id": row["run_id"],
        "project_id": row["project_id"],
        "canvas_id": row["canvas_id"],
        "status": row["status"],
        "resumable": bool(row["resumable"]),
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "updated_at": row["updated_at"],
        "completed_at": row["completed_at"],
        "actor_id": row["actor_id"],
        "runner_id": row["runner_id"],
        "lease_expires_at": row["lease_expires_at"],
        "actions": [_action_from_row(action_row) for action_row in action_rows],
        "metadata": _decode_metadata(row["metadata_json"]),
    }


def _write_run(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    metadata = payload.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    idempotency_key = str(metadata.get("idempotency_key") or "").strip() or None
    conn.execute(
        """
        INSERT INTO workflow_runs (
            run_id, schema_version, project_id, canvas_id, status, resumable,
            actor_id, runner_id, lease_expires_at, idempotency_key, metadata_json,
            created_at, started_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
            status = excluded.status,
            resumable = excluded.resumable,
            actor_id = excluded.actor_id,
            runner_id = excluded.runner_id,
            lease_expires_at = excluded.lease_expires_at,
            idempotency_key = excluded.idempotency_key,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at
        """,
        (
            payload["run_id"],
            payload["schema_version"],
            payload["project_id"],
            payload["canvas_id"],
            payload["status"],
            int(bool(payload.get("resumable"))),
            payload.get("actor_id"),
            payload.get("runner_id"),
            payload.get("lease_expires_at"),
            idempotency_key,
            json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
            payload["created_at"],
            payload["started_at"],
            payload["updated_at"],
            payload.get("completed_at"),
        ),
    )
    for sequence_no, item in enumerate(payload.get("actions") or []):
        conn.execute(
            """
            INSERT INTO workflow_run_actions (
                run_id, node_id, action, sequence_no, status, phase, updated_at,
                error, error_category, retryable, error_request_id,
                error_fingerprint, user_error, task_key, task_type, job_id,
                retry_count, artifact_status, recipe_id, recipe_version,
                generation_attempt_id, product_operation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, node_id, action) DO UPDATE SET
                sequence_no = excluded.sequence_no,
                status = excluded.status,
                phase = excluded.phase,
                updated_at = excluded.updated_at,
                error = excluded.error,
                error_category = excluded.error_category,
                retryable = excluded.retryable,
                error_request_id = excluded.error_request_id,
                error_fingerprint = excluded.error_fingerprint,
                user_error = excluded.user_error,
                task_key = excluded.task_key,
                task_type = excluded.task_type,
                job_id = excluded.job_id,
                retry_count = excluded.retry_count,
                artifact_status = excluded.artifact_status
                ,recipe_id = excluded.recipe_id
                ,recipe_version = excluded.recipe_version
                ,generation_attempt_id = excluded.generation_attempt_id
                ,product_operation_id = excluded.product_operation_id
            """,
            (
                payload["run_id"],
                item["node_id"],
                item["action"],
                sequence_no,
                item["status"],
                item.get("phase"),
                item.get("updated_at"),
                item.get("error"),
                item.get("error_category"),
                (
                    int(bool(item["retryable"]))
                    if item.get("retryable") is not None
                    else None
                ),
                item.get("error_request_id"),
                item.get("error_fingerprint"),
                item.get("user_error"),
                item.get("task_key"),
                item.get("task_type"),
                item.get("job_id"),
                int(item.get("retry_count") or 0),
                item.get("artifact_status"),
                item.get("recipe_id"),
                item.get("recipe_version"),
                item.get("generation_attempt_id"),
                item.get("product_operation_id"),
            ),
        )


def _list_runs_in_transaction(
    conn: sqlite3.Connection,
    *,
    canvas_id: str,
    statuses: set[str] | None = None,
    limit: int = 0,
) -> list[dict[str, Any]]:
    parameters: list[Any] = [canvas_id]
    where = "canvas_id = ?"
    if statuses:
        placeholders = ",".join("?" for _ in statuses)
        where += f" AND status IN ({placeholders})"
        parameters.extend(sorted(statuses))
    sql = f"SELECT run_id FROM workflow_runs WHERE {where} ORDER BY created_at DESC"
    if limit > 0:
        sql += " LIMIT ?"
        parameters.append(limit)
    rows = conn.execute(sql, parameters).fetchall()
    return [
        run
        for row in rows
        if (run := _read_run(conn, canvas_id=canvas_id, run_id=row["run_id"]))
        is not None
    ]


def _normalize_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in actions:
        if not isinstance(item, dict):
            raise ValueError("each workflow action must be an object")
        node_id = str(item.get("node_id") or "").strip()
        action = str(item.get("action") or "").strip()
        if not node_id or not action:
            raise ValueError("each workflow action requires node_id and action")
        recipe_id = str(item.get("recipe_id") or "").strip()
        key = (node_id, action)
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            {
                "node_id": node_id,
                "action": action,
                "status": "pending",
                "phase": "waiting_dependencies",
                "updated_at": None,
                "error": None,
                "task_key": None,
                "task_type": None,
                "job_id": None,
                "retry_count": 0,
                "recipe_id": recipe_id or None,
                "recipe_version": str(item.get("recipe_version") or "").strip() or None,
                "generation_attempt_id": (
                    str(item.get("generation_attempt_id") or "").strip() or None
                ),
                "product_operation_id": None,
            }
        )
    if not normalized:
        raise ValueError("workflow run requires at least one action")
    return normalized


def bind_workflow_action_product_operation(
    *,
    project_dir: Path,
    canvas_id: str,
    run_id: str,
    node_id: str,
    action: str,
    operation_id: str,
) -> dict[str, Any]:
    _validate_scope(canvas_id, run_id)
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute(
            """
            SELECT product_operation_id FROM workflow_run_actions
             WHERE run_id = ? AND node_id = ? AND action = ?
            """,
            (run_id, node_id, action),
        ).fetchone()
        if current is None:
            raise ValueError("workflow action not found")
        existing = str(current["product_operation_id"] or "")
        if existing and existing != operation_id:
            raise ValueError("workflow action is bound to another product operation")
        conn.execute(
            """
            UPDATE workflow_run_actions SET product_operation_id = ?
             WHERE run_id = ? AND node_id = ? AND action = ?
            """,
            (operation_id, run_id, node_id, action),
        )
        payload = _read_run(conn, canvas_id=canvas_id, run_id=run_id)
    if payload is None:
        raise ValueError("workflow run not found")
    return payload


def create_workflow_run(
    *,
    project_dir: Path,
    project_id: str,
    canvas_id: str,
    actions: list[dict[str, Any]],
    actor_id: str = "",
    metadata: dict[str, Any] | None = None,
    idempotency_key: str = "",
    runner_id: str = "",
) -> dict[str, Any]:
    _validate_scope(canvas_id)
    checked_idempotency_key = idempotency_key.strip()
    if checked_idempotency_key and not IDEMPOTENCY_KEY_RE.match(
        checked_idempotency_key
    ):
        raise ValueError("invalid workflow run idempotency_key")
    checked_runner_id = runner_id.strip()
    if checked_runner_id and not RUNNER_ID_RE.match(checked_runner_id):
        raise ValueError("invalid workflow run runner_id")
    run_id = f"run_{uuid.uuid4().hex}"
    current = datetime.now(timezone.utc)
    now = _timestamp(current)
    normalized_actions = _normalize_actions(actions)
    run_metadata = dict(metadata or {})
    if checked_idempotency_key:
        run_metadata["idempotency_key"] = checked_idempotency_key
    payload: dict[str, Any] = {
        "schema_version": "freezone_workflow_run.v1",
        "run_id": run_id,
        "project_id": project_id,
        "canvas_id": canvas_id,
        "status": "running",
        "resumable": True,
        "created_at": now,
        "started_at": now,
        "updated_at": now,
        "completed_at": None,
        "actor_id": actor_id or None,
        "runner_id": checked_runner_id or None,
        "lease_expires_at": _lease_expires_at(current) if checked_runner_id else None,
        "actions": normalized_actions,
        "metadata": run_metadata,
    }
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        if checked_idempotency_key:
            existing_row = conn.execute(
                """
                SELECT run_id FROM workflow_runs
                WHERE canvas_id = ? AND idempotency_key = ?
                """,
                (canvas_id, checked_idempotency_key),
            ).fetchone()
            if existing_row is not None:
                existing = _read_run(
                    conn,
                    canvas_id=canvas_id,
                    run_id=existing_row["run_id"],
                )
                if existing is not None:
                    return existing
        existing_runs = _list_runs_in_transaction(conn, canvas_id=canvas_id)
        for existing in existing_runs:
            if existing.get("status") != "running":
                continue
            existing_runner_id = str(existing.get("runner_id") or "").strip()
            lease_expires_at = _parse_timestamp(existing.get("lease_expires_at"))
            if existing_runner_id and lease_expires_at and lease_expires_at > current:
                raise WorkflowRunLeaseConflict(
                    "another workflow runner is active on this canvas"
                )
        for existing in existing_runs:
            if existing.get("status") not in RESUMABLE_RUN_STATUSES:
                continue
            was_leased_running = existing.get("status") == "running" and bool(
                str(existing.get("runner_id") or "").strip()
            )
            existing["status"] = "interrupted" if was_leased_running else "cancelled"
            existing["resumable"] = was_leased_running
            existing["updated_at"] = now
            existing["completed_at"] = now
            existing_metadata = existing.get("metadata")
            existing_metadata = (
                existing_metadata if isinstance(existing_metadata, dict) else {}
            )
            if was_leased_running:
                existing_metadata["interrupt_reason"] = "runner_lease_expired"
            else:
                existing_metadata["superseded_by_run_id"] = run_id
            existing["metadata"] = existing_metadata
            _write_run(conn, existing)
        _write_run(conn, payload)
    return payload


def reconcile_workflow_runs_with_canvas_nodes(
    *,
    project_dir: Path,
    canvas_id: str,
    existing_node_ids: set[str],
    run_statuses: set[str] | None = None,
) -> list[str]:
    """Cancel resumable runs after all of their unfinished nodes are deleted."""
    _validate_scope(canvas_id)
    now = _now()
    cancelled: list[str] = []
    eligible_statuses = run_statuses or RESUMABLE_RUN_STATUSES
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        for payload in _list_runs_in_transaction(
            conn,
            canvas_id=canvas_id,
            statuses=eligible_statuses,
        ):
            actions = payload.get("actions")
            actions = actions if isinstance(actions, list) else []
            unfinished_node_ids = {
                str(item.get("node_id") or "")
                for item in actions
                if isinstance(item, dict)
                and item.get("status") in RESUMABLE_ACTION_STATUSES
                and str(item.get("node_id") or "")
            }
            if not unfinished_node_ids or unfinished_node_ids & existing_node_ids:
                continue
            payload["status"] = "cancelled"
            payload["resumable"] = False
            payload["updated_at"] = now
            payload["completed_at"] = now
            metadata = payload.get("metadata")
            metadata = metadata if isinstance(metadata, dict) else {}
            metadata["cancel_reason"] = "workflow_nodes_deleted"
            payload["metadata"] = metadata
            _write_run(conn, payload)
            cancelled.append(str(payload.get("run_id") or ""))
    return cancelled


def interrupt_stale_workflow_runs(
    *,
    project_dir: Path,
    canvas_id: str,
    stale_after_seconds: int,
    now: datetime | None = None,
) -> list[str]:
    """Mark running records without a recent runner heartbeat as interrupted."""
    _validate_scope(canvas_id)
    current = now or datetime.now(timezone.utc)
    cutoff = current - timedelta(seconds=max(stale_after_seconds, 1))
    interrupted: list[str] = []
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        for payload in _list_runs_in_transaction(
            conn,
            canvas_id=canvas_id,
            statuses={"running"},
        ):
            lease_expires_at = _parse_timestamp(payload.get("lease_expires_at"))
            updated_at = _parse_timestamp(payload.get("updated_at"))
            stale = (
                lease_expires_at <= current
                if lease_expires_at is not None
                else (updated_at or datetime.min.replace(tzinfo=timezone.utc)) <= cutoff
            )
            if not stale:
                continue
            timestamp = _timestamp(current)
            payload["status"] = "interrupted"
            payload["resumable"] = True
            payload["updated_at"] = timestamp
            payload["completed_at"] = timestamp
            metadata = payload.get("metadata")
            metadata = metadata if isinstance(metadata, dict) else {}
            metadata["interrupt_reason"] = "runner_heartbeat_expired"
            payload["metadata"] = metadata
            _write_run(conn, payload)
            interrupted.append(str(payload.get("run_id") or ""))
    return interrupted


def read_workflow_run(
    *, project_dir: Path, canvas_id: str, run_id: str
) -> dict[str, Any] | None:
    _validate_scope(canvas_id, run_id)
    with _connect(project_dir) as conn:
        return _read_run(conn, canvas_id=canvas_id, run_id=run_id)


def list_workflow_runs(
    *, project_dir: Path, canvas_id: str, limit: int = 20
) -> list[dict[str, Any]]:
    _validate_scope(canvas_id)
    with _connect(project_dir) as conn:
        return _list_runs_in_transaction(conn, canvas_id=canvas_id, limit=limit)


def prune_workflow_runs(
    *,
    project_dir: Path,
    canvas_id: str,
    retention_days: int = 30,
    max_terminal_records: int = 200,
    now: datetime | None = None,
) -> list[str]:
    """Delete old non-resumable workflow records while preserving recovery state."""
    _validate_scope(canvas_id)
    current = now or datetime.now(timezone.utc)
    cutoff = current - timedelta(days=max(retention_days, 1))
    removable: list[tuple[dict[str, Any], datetime]] = []
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        for payload in _list_runs_in_transaction(
            conn,
            canvas_id=canvas_id,
            statuses={"completed", "cancelled"},
        ):
            timestamp = (
                _parse_timestamp(payload.get("completed_at"))
                or _parse_timestamp(payload.get("updated_at"))
                or datetime.min.replace(tzinfo=timezone.utc)
            )
            removable.append((payload, timestamp))
        removable.sort(key=lambda item: item[1], reverse=True)
        deleted: list[str] = []
        for index, (payload, timestamp) in enumerate(removable):
            exceeds_limit = index >= max(max_terminal_records, 1)
            if timestamp > cutoff and not exceeds_limit:
                continue
            run_id = str(payload.get("run_id") or "")
            conn.execute("DELETE FROM workflow_runs WHERE run_id = ?", (run_id,))
            deleted.append(run_id)
    return deleted


def update_workflow_run(
    *,
    project_dir: Path,
    canvas_id: str,
    run_id: str,
    status: str | None = None,
    action_updates: list[dict[str, Any]] | None = None,
    runner_id: str = "",
) -> dict[str, Any] | None:
    _validate_scope(canvas_id, run_id)
    if status is not None and status not in RUN_STATUSES:
        raise ValueError(f"invalid workflow run status: {status!r}")
    checked_runner_id = runner_id.strip()
    if checked_runner_id and not RUNNER_ID_RE.match(checked_runner_id):
        raise ValueError("invalid workflow run runner_id")
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        payload = _read_run(conn, canvas_id=canvas_id, run_id=run_id)
        if payload is None:
            return None
        current_status = str(payload.get("status") or "")
        stored_runner_id = str(payload.get("runner_id") or "").strip()
        if (
            current_status == "running"
            and stored_runner_id
            and checked_runner_id != stored_runner_id
            and status != "cancelled"
        ):
            raise WorkflowRunLeaseConflict(
                "workflow run lease is owned by another runner"
            )
        if current_status == "cancelled":
            return payload
        if current_status in TERMINAL_RUN_STATUSES:
            # A heartbeat or delayed node callback may arrive after the final update.
            # Never reopen a terminal run; recovery starts a fresh run and explicitly
            # cancels the old failed/interrupted record.
            if status == "cancelled" and current_status in {"failed", "interrupted"}:
                now = _now()
                payload["status"] = "cancelled"
                payload["resumable"] = False
                payload["updated_at"] = now
                payload["completed_at"] = now
                _write_run(conn, payload)
            return payload
        now = _now()
        actions = payload.get("actions")
        actions = actions if isinstance(actions, list) else []
        by_key = {
            (str(item.get("node_id") or ""), str(item.get("action") or "")): item
            for item in actions
            if isinstance(item, dict)
        }
        for update in action_updates or []:
            if not isinstance(update, dict):
                raise ValueError("each workflow action update must be an object")
            node_id = str(update.get("node_id") or "").strip()
            action = str(update.get("action") or "").strip()
            node_status = str(update.get("status") or "").strip()
            if node_status not in NODE_STATUSES:
                raise ValueError(f"invalid workflow node status: {node_status!r}")
            item = by_key.get((node_id, action))
            if item is None:
                raise ValueError(f"workflow action not found: {node_id}:{action}")
            item["status"] = node_status
            item["updated_at"] = now
            item["error"] = str(update.get("error") or "").strip() or None
            if "phase" in update:
                phase = str(update.get("phase") or "").strip()
                if phase and phase not in NODE_PHASES:
                    raise ValueError(f"invalid workflow node phase: {phase!r}")
                item["phase"] = phase or None
            if node_status == "failed":
                item.update(workflow_error_diagnostics(item["error"]))
            else:
                for field in (
                    "error_category",
                    "retryable",
                    "error_request_id",
                    "error_fingerprint",
                    "user_error",
                ):
                    item.pop(field, None)
            for field in ("task_key", "task_type", "job_id"):
                if field not in update:
                    continue
                value = str(update.get(field) or "").strip()
                item[field] = value[:256] or None
            if "retry_count" in update:
                try:
                    item["retry_count"] = max(0, min(int(update["retry_count"]), 10))
                except (TypeError, ValueError):
                    raise ValueError("workflow retry_count must be an integer")
        if status is not None:
            payload["status"] = status
            if status in TERMINAL_RUN_STATUSES:
                payload["completed_at"] = now
                payload["resumable"] = status in {"failed", "interrupted"}
            if status == "cancelled":
                for item in actions:
                    if isinstance(item, dict) and item.get("status") not in {
                        "completed",
                        "skipped",
                    }:
                        item["status"] = "skipped"
                        item["updated_at"] = now
                        item["error"] = "workflow cancelled"
                metadata = payload.get("metadata")
                metadata = metadata if isinstance(metadata, dict) else {}
                metadata["cancel_requested_at"] = now
                payload["metadata"] = metadata
        if checked_runner_id and payload.get("status") == "running":
            payload["lease_expires_at"] = _lease_expires_at(datetime.now(timezone.utc))
        payload["updated_at"] = now
        _write_run(conn, payload)
        return payload


def reconcile_workflow_runs_with_tasks(
    *,
    project_dir: Path,
    canvas_id: str,
    tasks_by_key: dict[str, dict[str, Any]],
    generation_history: list[dict[str, Any]] | None = None,
) -> list[str]:
    """Reconcile persisted workflow actions with durable project task state."""
    _validate_scope(canvas_id)
    history_by_task_node: dict[tuple[str, str], dict[str, Any]] = {}
    for record in generation_history or []:
        if not isinstance(record, dict):
            continue
        task_key = str(record.get("task_key") or "").strip()
        node_id = str(record.get("node_id") or "").strip()
        if task_key and node_id:
            history_by_task_node.setdefault((task_key, node_id), record)

    changed_run_ids: list[str] = []
    timestamp = _now()
    with _connect(project_dir) as conn:
        conn.execute("BEGIN IMMEDIATE")
        for payload in _list_runs_in_transaction(conn, canvas_id=canvas_id):
            if payload.get("status") == "cancelled":
                continue
            actions = payload.get("actions")
            actions = actions if isinstance(actions, list) else []
            changed = False
            for item in actions:
                if not isinstance(item, dict) or item.get("status") in {
                    "completed",
                    "skipped",
                }:
                    continue
                task_key = str(item.get("task_key") or "").strip()
                task = tasks_by_key.get(task_key) if task_key else None
                if not isinstance(task, dict):
                    continue
                task_status = str(task.get("status") or "").strip().lower()
                if task_status in ACTIVE_TASK_STATUSES:
                    if item.get("status") != "running":
                        item["status"] = "running"
                        item["updated_at"] = timestamp
                        changed = True
                    continue
                if task_status not in TERMINAL_TASK_STATUSES:
                    continue
                if task_status in {"failed", "cancelled"}:
                    error = str(task.get("error") or "生成任务失败").strip()
                    updates = {
                        "status": "failed",
                        "error": error,
                        **workflow_error_diagnostics(error),
                    }
                else:
                    artifact_status, artifact_error = _validate_action_artifact(
                        action=str(item.get("action") or ""),
                        task_result=(
                            task.get("result")
                            if isinstance(task.get("result"), dict)
                            else None
                        ),
                        history_record=history_by_task_node.get(
                            (task_key, str(item.get("node_id") or ""))
                        ),
                        project_dir=project_dir,
                    )
                    if artifact_status == "missing":
                        updates = {
                            "status": "failed",
                            "error": artifact_error,
                            **workflow_error_diagnostics(artifact_error),
                            "artifact_status": artifact_status,
                        }
                    else:
                        updates = {
                            "status": "completed",
                            "error": None,
                            "artifact_status": artifact_status,
                        }
                if any(item.get(key) != value for key, value in updates.items()):
                    item.update(updates)
                    item["updated_at"] = timestamp
                    changed = True
            if not changed:
                continue
            action_statuses = {
                str(item.get("status") or "")
                for item in actions
                if isinstance(item, dict)
            }
            if action_statuses and action_statuses <= {"completed", "skipped"}:
                payload["status"] = "completed"
                payload["resumable"] = False
                payload["completed_at"] = timestamp
            elif "failed" in action_statuses and not action_statuses & {
                "running",
                "pending",
            }:
                payload["status"] = "failed"
                payload["resumable"] = True
                payload["completed_at"] = timestamp
            payload["updated_at"] = timestamp
            metadata = payload.get("metadata")
            metadata = metadata if isinstance(metadata, dict) else {}
            metadata["last_task_reconciliation_at"] = timestamp
            payload["metadata"] = metadata
            _write_run(conn, payload)
            changed_run_ids.append(str(payload.get("run_id") or ""))
    return changed_run_ids

"""项目级图片请求使用记录。"""

from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from novelvideo.config import OUTPUT_DIR, STATE_DIR
from novelvideo.sqlite_pragmas import configure_sqlite_connection
from novelvideo.sqlite_schema import ensure_sqlite_schema


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS image_request_usage (
    request_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model_name TEXT,
    task_type TEXT NOT NULL,
    scope TEXT NOT NULL,
    episode INTEGER,
    beat_num INTEGER,
    character_name TEXT,
    identity_name TEXT,
    status TEXT NOT NULL DEFAULT 'accepted',
    accepted_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_image_request_usage_scope
ON image_request_usage(task_type, scope, accepted_at DESC);
"""

_NON_BILLABLE_FAILURE_PATTERNS = (
    "%未返回图像数据%",
    "%模型未返回图像%",
)

_SCHEMA_COMPONENT = "image_request_usage"
# MIGRATION CONTRACT: increment this whenever _SCHEMA_SQL changes.
_SCHEMA_VERSION = 1


def get_image_request_usage_db_path(project_output_dir: str | Path) -> Path:
    project_output_dir = Path(project_output_dir).resolve()
    output_root = Path(OUTPUT_DIR).resolve()
    state_root = Path(STATE_DIR).resolve()
    try:
        rel = project_output_dir.relative_to(output_root)
    except ValueError:
        return (project_output_dir / "data.db").resolve()
    if len(rel.parts) >= 2:
        # Always anchor on user/project, even if a subdirectory was passed,
        # so image/video usage never gets split across multiple db files.
        from novelvideo.utils.project_paths import ProjectPaths

        user, project = rel.parts[0], rel.parts[1]
        ProjectPaths(user, project).bootstrap_from_legacy_output()
        return (state_root / user / project / "data.db").resolve()
    return (project_output_dir / "data.db").resolve()


def infer_project_output_dir(path_like: str | Path | None) -> Path | None:
    if not path_like:
        return None
    path = Path(path_like).resolve()
    output_root = Path(OUTPUT_DIR).resolve()
    state_root = Path(STATE_DIR).resolve()
    for parent in [path, *path.parents]:
        if (parent / "data.db").exists() or (parent / "project_config.json").exists():
            return parent
        try:
            rel = parent.relative_to(state_root)
            if len(rel.parts) >= 2:
                candidate = output_root / rel
                if candidate.exists():
                    return candidate
        except ValueError:
            pass
        if parent.name in {"grids", "frames", "sketches", "videos", "assets", "prompts"}:
            return parent.parent
    return None


def infer_episode_from_path(path_like: str | Path | None) -> int | None:
    if not path_like:
        return None
    path = str(path_like)
    match = re.search(r"/ep(\d{3})(?:/|$)", path)
    if match:
        return int(match.group(1))
    return None


@contextmanager
def _connect(project_output_dir: str | Path):
    db_path = get_image_request_usage_db_path(project_output_dir)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    ensure_sqlite_schema(
        db_path,
        component=_SCHEMA_COMPONENT,
        version=_SCHEMA_VERSION,
        initialize=lambda schema_conn: schema_conn.executescript(_SCHEMA_SQL),
    )
    conn = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
    configure_sqlite_connection(conn, set_journal_mode=False)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def record_image_request(
    *,
    project_output_dir: str | Path,
    request_id: str,
    provider: str,
    model_name: str,
    task_type: str,
    scope: str,
    episode: int | None = None,
    beat_num: int | None = None,
    character_name: str | None = None,
    identity_name: str | None = None,
) -> None:
    now = datetime.now().isoformat()
    with _connect(project_output_dir) as conn:
        conn.execute(
            """
            INSERT INTO image_request_usage (
                request_id, provider, model_name, task_type, scope,
                episode, beat_num, character_name, identity_name,
                status, accepted_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
            ON CONFLICT(request_id) DO NOTHING
            """,
            (
                request_id,
                provider,
                model_name,
                task_type,
                scope,
                episode,
                beat_num,
                character_name,
                identity_name,
                now,
                now,
            ),
        )


def update_image_request_status(
    *,
    project_output_dir: str | Path,
    request_id: str,
    status: str,
    error_message: str | None = None,
) -> None:
    now = datetime.now().isoformat()
    completed_at = now if status == "completed" else None
    with _connect(project_output_dir) as conn:
        conn.execute(
            """
            UPDATE image_request_usage
            SET status = ?,
                updated_at = ?,
                completed_at = COALESCE(?, completed_at),
                error_message = COALESCE(?, error_message)
            WHERE request_id = ?
            """,
            (
                status,
                now,
                completed_at,
                error_message,
                request_id,
            ),
        )


def _append_billable_usage_filter(where: list[str], params: list[object]) -> None:
    where.append(
        """
        NOT (
            status = 'failed' AND (
                COALESCE(error_message, '') LIKE ?
                OR COALESCE(error_message, '') LIKE ?
            )
        )
        """.strip()
    )
    params.extend(_NON_BILLABLE_FAILURE_PATTERNS)


def count_image_scope_attempts(
    *,
    project_output_dir: str | Path,
    task_type: str,
    scope: str,
    episode: int | None = None,
) -> int:
    where = ["task_type = ?", "scope = ?"]
    params: list[object] = [task_type, scope]
    if episode is not None:
        where.append("episode = ?")
        params.append(episode)
    _append_billable_usage_filter(where, params)

    with _connect(project_output_dir) as conn:
        row = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM image_request_usage
            WHERE {' AND '.join(where)}
            """,
            tuple(params),
        ).fetchone()
    return int(row[0] or 0) if row else 0


def get_image_scope_warning(
    *,
    project_output_dir: str | Path,
    task_type: str,
    scope: str,
    subject: str,
    episode: int | None = None,
) -> tuple[str, str] | None:
    attempt_count = count_image_scope_attempts(
        project_output_dir=project_output_dir,
        task_type=task_type,
        scope=scope,
        episode=episode,
    )
    next_attempt = attempt_count + 1
    if next_attempt >= 5:
        return (
            "negative",
            f"{subject} 已连续生成 {next_attempt} 次，建议先检查提示词/参考图后再继续。",
        )
    if next_attempt >= 3:
        return (
            "warning",
            f"{subject} 已连续生成 {next_attempt} 次，请确认是否还要继续生成。",
        )
    return None


def get_image_usage_summary(
    *,
    project_output_dir: str | Path,
    task_types: tuple[str, ...] | None = None,
    episode: int | None = None,
) -> dict:
    today = datetime.now().date().isoformat()
    where = []
    params: list[object] = []
    if task_types:
        placeholders = ", ".join("?" for _ in task_types)
        where.append(f"task_type IN ({placeholders})")
        params.extend(task_types)
    if episode is not None:
        where.append("episode = ?")
        params.append(episode)
    _append_billable_usage_filter(where, params)

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    today_sql = f"{where_sql} {'AND' if where_sql else 'WHERE'} substr(accepted_at, 1, 10) = ?"

    with _connect(project_output_dir) as conn:
        total_row = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM image_request_usage
            {where_sql}
            """,
            tuple(params),
        ).fetchone()
        today_row = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM image_request_usage
            {today_sql}
            """,
            (*params, today),
        ).fetchone()

    return {
        "total_requests": int(total_row[0] or 0) if total_row else 0,
        "today_requests": int(today_row[0] or 0) if today_row else 0,
    }

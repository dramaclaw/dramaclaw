"""任务状态持久化管理。

使用项目本地 SQLite 持久化任务状态，解决 worker 退出后无法获取结果的问题。

核心流程：
1. API 侧 reserve 任务状态（submitting）
2. broker 投递成功后进入队列（queued）
3. worker 开始执行后更新进度（running）
4. worker 完成/失败/取消时写入最终结果（completed/failed/cancelled）

关键改进：
- worker 完成时先写 SQLite，再退出
- 前端优先从 SQLite 读取最终结果
- worker 死亡不影响结果获取
"""

import json
import logging
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from novelvideo.config import OUTPUT_DIR, STATE_DIR
from novelvideo.project_context import ProjectContext, require_project_home_node
from novelvideo.sqlite_pragmas import configure_sqlite_connection
from novelvideo.task_backend.queues import normalize_queue_kind
from novelvideo.task_identity import (
    project_task_scope_from_key,
    project_task_state_key,
    task_scope_from_key,
    task_state_key,
)

logger = logging.getLogger(__name__)

ACTIVE_PROJECT_TASK_STATUSES = {"submitting", "queued", "running"}
TERMINAL_TASK_STATUSES = {"completed", "failed", "cancelled"}
_PROJECT_LANE_LIMIT_UNSET = object()
_CURRENT_PROJECT_TASK_ID: ContextVar[str | None] = ContextVar(
    "novelvideo_current_project_task_id",
    default=None,
)


@contextmanager
def project_task_run_context(task_id: str):
    """Bind project task state updates in this call stack to one Celery run."""
    token = _CURRENT_PROJECT_TASK_ID.set(str(task_id))
    try:
        yield
    finally:
        _CURRENT_PROJECT_TASK_ID.reset(token)


def get_current_project_task_id() -> str:
    return str(_CURRENT_PROJECT_TASK_ID.get() or "").strip()


def _queue_kind_from_metadata(metadata: dict | None, fallback: str | None = None) -> str:
    raw = None
    if metadata:
        raw = metadata.get("queue_kind")
    return normalize_queue_kind(str(raw) if raw is not None else fallback)


def _env_int(name: str, default: int, *, fallback_name: str | None = None) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None and fallback_name is not None:
        raw_value = os.environ.get(fallback_name)
    if raw_value is None:
        return default
    try:
        return max(1, int(raw_value))
    except (TypeError, ValueError):
        return default


_TASK_STATE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS task_states (
    task_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    queue_kind TEXT NOT NULL DEFAULT 'default',
    project_id TEXT NOT NULL DEFAULT '',
    requester_user_id TEXT NOT NULL DEFAULT '',
    owner_username TEXT NOT NULL DEFAULT '',
    project_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL,
    project TEXT NOT NULL,
    episode INTEGER NOT NULL,
    beat_num INTEGER,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0.0,
    current_task TEXT NOT NULL DEFAULT '',
    result_json TEXT,
    error TEXT,
    logs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT NOT NULL DEFAULT '',
    expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_states_user_updated
ON task_states(username, updated_at DESC);
"""

_TASK_STATE_COLUMN_UPGRADES = {
    "queue_kind": "ALTER TABLE task_states ADD COLUMN queue_kind TEXT NOT NULL DEFAULT 'default'",
    "project_id": "ALTER TABLE task_states ADD COLUMN project_id TEXT NOT NULL DEFAULT ''",
    "requester_user_id": (
        "ALTER TABLE task_states ADD COLUMN requester_user_id TEXT NOT NULL DEFAULT ''"
    ),
    "owner_username": "ALTER TABLE task_states ADD COLUMN owner_username TEXT NOT NULL DEFAULT ''",
    "project_name": "ALTER TABLE task_states ADD COLUMN project_name TEXT NOT NULL DEFAULT ''",
}


def compute_expiry(ttl_seconds: int | None) -> str | None:
    """按 TTL 计算过期时间。"""
    if ttl_seconds is None:
        return None
    return (
        datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    ).isoformat().replace("+00:00", "Z")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# inline 后端的 worker 与 API 同进程:早于本进程启动仍标记 ACTIVE 的
# inline 任务必然已中断(见 _sweep_interrupted_inline_tasks_once)。
_PROCESS_STARTED_AT = utc_now_iso()
if "." not in _PROCESS_STARTED_AT:
    # isoformat 在整秒时省略小数位;同秒内 "...:56Z" 字典序大于 "...:56.4Z",
    # 会把启动后同秒更新的活任务误判为过期,补齐小数位消除该反转。
    _PROCESS_STARTED_AT = _PROCESS_STARTED_AT.replace("Z", ".000000Z")


def parse_task_timestamp(value: str | None) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def get_project_task_db_path(username: str, project: str) -> Path:
    """获取项目级 task state SQLite 路径。"""
    from novelvideo.utils.project_paths import ProjectPaths

    ProjectPaths(username, project).bootstrap_from_legacy_output()
    return (Path(STATE_DIR) / username / project / "data.db").resolve()


def get_project_task_db_path_for_context(ctx: ProjectContext) -> Path:
    """Project-local task state DB path for project_id based execution."""
    return (Path(ctx.state_dir) / "data.db").resolve()


@dataclass
class TaskState:
    """任务状态数据类。

    Attributes:
        task_id: 任务唯一标识
        task_type: 任务类型（如 video_composer, script_writer）
        username: 用户名
        project: 项目名称
        episode: 集数
        beat_num: Beat 编号（可选，用于单 Beat 任务）
        scope: 任务作用域（可选，用于同集内多条并行任务）
        status: 任务状态 (submitting|queued|running|completed|failed|cancelled)
        progress: 进度 (0.0 - 1.0)
        current_task: 当前正在执行的子任务描述
        result: 任务结果（JSON 可序列化的字典）
        error: 错误信息
        logs: 最近 N 条日志
        created_at: 创建时间
        updated_at: 更新时间
        completed_at: 完成时间
    """

    task_id: str
    task_type: str
    queue_kind: str = "default"
    username: str = ""
    project: str = ""
    episode: int = 0
    project_id: str = ""
    requester_user_id: str = ""
    owner_username: str = ""
    project_name: str = ""
    beat_num: Optional[int] = None
    scope: Optional[str] = None

    status: str = "pending"  # legacy default; Celery path uses submitting|queued|running
    progress: float = 0.0
    current_task: str = ""
    result: Optional[dict] = None
    metadata: Optional[dict] = None
    error: Optional[str] = None
    logs: List[str] = field(default_factory=list)

    created_at: str = ""
    updated_at: str = ""
    completed_at: str = ""
    expires_at: str = ""

    def is_starting_stale(self, timeout_seconds: int) -> bool:
        if self.status != "starting":
            return False
        last_update = parse_task_timestamp(self.updated_at or self.created_at)
        if last_update is None:
            return False
        return (datetime.now(timezone.utc) - last_update).total_seconds() >= timeout_seconds


class TaskStateManager:
    """任务状态管理器 - 使用 SQLite 持久化。

    Key 设计:
        task:{task_type}:project:{project_id}:{episode}[:beat_num][:scope]

    TTL 策略:
        - submitting/queued/running: 无 TTL（由 worker/backend 维护）
        - completed/failed/cancelled: TTL = 1 小时（允许前端获取结果）
    """

    MAX_LOGS = 100  # 保留最近 100 条日志
    COMPLETED_TTL = 3600  # 完成后保留 1 小时

    def __init__(self) -> None:
        # 僵尸清扫按库只跑一次(见 _sweep_interrupted_inline_tasks_once)
        self._swept_dbs: set[str] = set()
        self._sweep_lock = threading.Lock()
    STARTING_TIMEOUT = _env_int(
        "NOVELVIDEO_TASK_STARTING_TIMEOUT",
        180,
    )

    @staticmethod
    def _merge_metadata_into_result(
        result: dict | None,
        metadata: dict | None,
    ) -> dict | None:
        """将任务 metadata 合并进 result_json，而不改表结构。"""
        if not metadata:
            return result
        if result is None:
            return {"task_metadata": metadata}
        if not isinstance(result, dict):
            return {"value": result, "task_metadata": metadata}
        merged = dict(result)
        merged["task_metadata"] = metadata
        return merged

    @staticmethod
    def _merge_task_metadata(existing: dict | None, incoming: dict | None) -> dict | None:
        if not existing:
            return incoming
        if not incoming:
            return existing
        return {**existing, **incoming}

    @staticmethod
    def _merge_logs(existing: List[str], incoming: List[str], max_logs: int) -> List[str]:
        """合并日志并消除尾部重叠。

        Actor 侧上传的通常是 `status.logs[-N:]`，不是纯增量。
        这里去掉 existing 后缀与 incoming 前缀的最大重叠部分，
        避免同一段 tail 反复落库。
        """
        if not incoming:
            return existing[-max_logs:]
        if not existing:
            return incoming[-max_logs:]

        max_overlap = min(len(existing), len(incoming))
        overlap = 0
        for size in range(max_overlap, 0, -1):
            if existing[-size:] == incoming[:size]:
                overlap = size
                break

        merged = existing + incoming[overlap:]
        return merged[-max_logs:]

    def _key(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ) -> str:
        return task_state_key(
            task_type,
            username,
            project,
            episode,
            beat_num=beat_num,
            scope=scope,
        )

    def _project_key(
        self,
        task_type: str,
        project_id: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ) -> str:
        return project_task_state_key(
            task_type,
            project_id,
            episode,
            beat_num=beat_num,
            scope=scope,
        )

    @contextmanager
    def _connect_path(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(db_path, timeout=5, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        configure_sqlite_connection(conn)
        conn.executescript(_TASK_STATE_SCHEMA_SQL)
        existing_columns = {
            str(row[1]) for row in conn.execute("PRAGMA table_info(task_states)").fetchall()
        }
        for column, sql in _TASK_STATE_COLUMN_UPGRADES.items():
            if column not in existing_columns:
                conn.execute(sql)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_states_project_updated "
            "ON task_states(project_id, updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_states_project_queue_status "
            "ON task_states(project_id, queue_kind, status)"
        )
        conn.commit()
        self._sweep_interrupted_inline_tasks_once(conn, db_path)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    @contextmanager
    def _connect(self, username: str, project: str):
        with self._connect_path(get_project_task_db_path(username, project)) as conn:
            yield conn

    @contextmanager
    def _connect_context(self, ctx: ProjectContext):
        require_project_home_node(ctx, operation="open project task state")
        with self._connect_path(get_project_task_db_path_for_context(ctx)) as conn:
            yield conn

    @staticmethod
    def _row_to_state(row) -> TaskState:
        result = json.loads(row["result_json"]) if row["result_json"] else None
        metadata = result.get("task_metadata") if isinstance(result, dict) else None
        logs = json.loads(row["logs_json"]) if row["logs_json"] else []
        project_id = row["project_id"] if "project_id" in row.keys() else ""
        if project_id:
            scope = project_task_scope_from_key(
                row["task_key"],
                task_type=row["task_type"],
                project_id=project_id,
                episode=row["episode"],
                beat_num=row["beat_num"],
            )
        else:
            scope = task_scope_from_key(
                row["task_key"],
                task_type=row["task_type"],
                username=row["username"],
                project=row["project"],
                episode=row["episode"],
                beat_num=row["beat_num"],
            )
        return TaskState(
            task_id=row["task_id"],
            task_type=row["task_type"],
            queue_kind=row["queue_kind"] if "queue_kind" in row.keys() else "default",
            project_id=project_id,
            requester_user_id=row["requester_user_id"] if "requester_user_id" in row.keys() else "",
            owner_username=row["owner_username"] if "owner_username" in row.keys() else "",
            project_name=row["project_name"] if "project_name" in row.keys() else "",
            username=row["username"],
            project=row["project"],
            episode=row["episode"],
            beat_num=row["beat_num"],
            scope=scope,
            status=row["status"],
            progress=row["progress"],
            current_task=row["current_task"],
            result=result,
            metadata=metadata,
            error=row["error"],
            logs=logs,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            completed_at=row["completed_at"],
            expires_at=row["expires_at"] if "expires_at" in row.keys() else "",
        )

    @staticmethod
    def _is_expired(expires_at: str | None) -> bool:
        expires = parse_task_timestamp(expires_at)
        if expires is None:
            return False
        return expires <= datetime.now(timezone.utc)

    def _delete_expired_key(self, task_key: str) -> None:
        username, project = self._project_from_task_key(task_key)
        with self._connect(username, project) as conn:
            conn.execute("DELETE FROM task_states WHERE task_key = ?", (task_key,))

    def _delete_expired_project_key(self, ctx: ProjectContext, task_key: str) -> None:
        with self._connect_context(ctx) as conn:
            conn.execute(
                "DELETE FROM task_states WHERE task_key = ? AND project_id = ?",
                (task_key, ctx.project_id),
            )

    @staticmethod
    def _project_from_task_key(task_key: str) -> tuple[str, str]:
        """从 task_key 中反解 username/project。"""
        parts = task_key.split(":")
        if len(parts) < 5:
            raise ValueError(f"Invalid task key: {task_key}")
        _, _task_type, username, project, *_rest = parts
        return username, project

    @staticmethod
    def _list_project_db_paths(username: str) -> list[Path]:
        project_db_paths: dict[str, Path] = {}
        for user_dir in (
            (Path(STATE_DIR) / username).resolve(),
            (Path(OUTPUT_DIR) / username).resolve(),
        ):
            if not user_dir.exists():
                continue
            for project_dir in user_dir.iterdir():
                if not project_dir.is_dir():
                    continue
                project_name = project_dir.name
                if project_name in project_db_paths:
                    continue
                db_path = project_dir / "data.db"
                if db_path.exists():
                    project_db_paths[project_name] = db_path
        return sorted(project_db_paths.values())

    def create_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        metadata: dict | None = None,
        status: str = "pending",
    ) -> TaskState:
        """创建新任务。

        在 Actor 的 __init__ 中调用，标记任务开始。

        Args:
            task_type: 任务类型（如 video_composer）
            username: 用户名
            project: 项目名称
            episode: 集数
            beat_num: Beat 编号（可选）
            scope: 任务作用域（可选，用于 mode_key、grid_index 等额外维度）
            metadata: 额外任务元数据（兼容旧调用方，写入 result_json.task_metadata）

        Returns:
            新创建的 TaskState
        """
        state = TaskState(
            task_id=str(uuid.uuid4()),
            task_type=task_type,
            username=username,
            project=project,
            episode=episode,
            beat_num=beat_num,
            scope=scope,
            status=status,
            result=self._merge_metadata_into_result(None, metadata),
            metadata=metadata,
            created_at=utc_now_iso(),
            updated_at=utc_now_iso(),
        )
        self._save(state)
        logger.info(f"Task created: {task_type}/{username}/{project}/{episode}")
        return state

    def create_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        metadata: dict | None = None,
        status: str = "queued",
        queue_kind: str = "default",
    ) -> TaskState:
        """Create a project_id based task state row.

        This is the canonical path for Celery/new API execution.
        """
        normalized_queue_kind = normalize_queue_kind(queue_kind)
        now = utc_now_iso()
        state = TaskState(
            task_id=str(uuid.uuid4()),
            task_type=task_type,
            queue_kind=normalized_queue_kind,
            project_id=ctx.project_id,
            requester_user_id=ctx.requester_user_id,
            owner_username=ctx.owner_username,
            project_name=ctx.project_name,
            username=ctx.requester_username,
            project=ctx.project_name,
            episode=episode,
            beat_num=beat_num,
            scope=scope,
            status=status,
            result=self._merge_metadata_into_result(None, metadata),
            metadata=metadata,
            created_at=now,
            updated_at=now,
        )
        ttl = self.COMPLETED_TTL if status in TERMINAL_TASK_STATUSES else None
        self._save_for_context(ctx, state, ttl=ttl)
        logger.info("Project task created: %s/%s/%s", task_type, ctx.project_id, episode)
        return state

    def reserve_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        metadata: dict | None = None,
        queue_kind: str = "default",
        project_lane_limit=_PROJECT_LANE_LIMIT_UNSET,
    ) -> tuple[TaskState, bool]:
        """Reserve an active project task slot atomically.

        The reservation is the product-layer idempotency lock. It prevents two
        concurrent HTTP requests from delivering the same business task twice.
        """
        task_key = project_task_state_key(
            task_type,
            ctx.project_id,
            episode,
            beat_num=beat_num,
            scope=scope,
        )
        from novelvideo.task_backend.limits import (
            ProjectTaskLimitExceeded,
            ProjectUserTaskLimitExceeded,
            project_lane_active_limit,
            project_user_lane_active_limit,
        )

        normalized_queue_kind = normalize_queue_kind(queue_kind)
        now = utc_now_iso()
        with self._connect_context(ctx) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ? AND project_id = ?",
                (task_key, ctx.project_id),
            ).fetchone()
            if row:
                if self._is_expired(row["expires_at"]):
                    conn.execute(
                        "DELETE FROM task_states WHERE task_key = ? AND project_id = ?",
                        (task_key, ctx.project_id),
                    )
                else:
                    existing = self._row_to_state(row)
                    if existing.status in ACTIVE_PROJECT_TASK_STATUSES:
                        return existing, False

            limit = (
                project_lane_active_limit(normalized_queue_kind)
                if project_lane_limit is _PROJECT_LANE_LIMIT_UNSET
                else project_lane_limit
            )
            if limit is not None:
                active = self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                    queue_kind=normalized_queue_kind,
                )
                if active >= limit:
                    raise ProjectTaskLimitExceeded(
                        project_id=ctx.project_id,
                        queue_kind=normalized_queue_kind,
                        limit=limit,
                        active=active,
                    )

            user_limit = project_user_lane_active_limit(normalized_queue_kind)
            if user_limit is not None:
                user_active = self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                    queue_kind=normalized_queue_kind,
                    requester_user_id=ctx.requester_user_id,
                )
                if user_active >= user_limit:
                    raise ProjectUserTaskLimitExceeded(
                        project_id=ctx.project_id,
                        requester_user_id=ctx.requester_user_id,
                        queue_kind=normalized_queue_kind,
                        limit=user_limit,
                        active=user_active,
                    )

            state = TaskState(
                task_id=str(uuid.uuid4()),
                task_type=task_type,
                queue_kind=normalized_queue_kind,
                project_id=ctx.project_id,
                requester_user_id=ctx.requester_user_id,
                owner_username=ctx.owner_username,
                project_name=ctx.project_name,
                username=ctx.requester_username,
                project=ctx.project_name,
                episode=episode,
                beat_num=beat_num,
                scope=scope,
                status="submitting",
                progress=0.0,
                current_task="任务正在投递",
                result=self._merge_metadata_into_result(None, metadata),
                metadata=metadata,
                created_at=now,
                updated_at=now,
            )
            self._save_on_connection(conn, task_key, state, None)
            return state, True

    def _count_active_project_tasks_on_connection(
        self,
        conn: sqlite3.Connection,
        *,
        project_id: str,
        queue_kind: str | None = None,
        requester_user_id: str | None = None,
    ) -> int:
        predicates = ["project_id = ?"]
        params: list[str] = [project_id]
        if queue_kind is not None:
            predicates.append("queue_kind = ?")
            params.append(normalize_queue_kind(queue_kind))
        if requester_user_id is not None:
            predicates.append("requester_user_id = ?")
            params.append(requester_user_id)
        placeholders = ",".join("?" for _ in ACTIVE_PROJECT_TASK_STATUSES)
        params.extend(ACTIVE_PROJECT_TASK_STATUSES)
        row = conn.execute(
            "SELECT COUNT(*) FROM task_states "
            f"WHERE {' AND '.join(predicates)} "
            f"AND status IN ({placeholders})",
            tuple(params),
        ).fetchone()
        return int(row[0]) if row else 0

    def update_progress(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        progress: float = None,
        current_task: str = None,
        logs: List[str] = None,
        metadata: dict | None = None,
    ):
        """更新任务进度（由 Actor 调用）。

        在 Actor 的 run 方法中定期调用，更新进度信息。

        Args:
            task_type: 任务类型
            username: 用户名
            project: 项目名称
            episode: 集数
            beat_num: Beat 编号（可选）
            scope: 任务作用域（可选）
            progress: 进度 (0.0 - 1.0)
            current_task: 当前子任务描述
            logs: 新增的日志列表
            metadata: 额外任务元数据（写入 result_json.task_metadata）
        """
        state = self.get_task(task_type, username, project, episode, beat_num, scope)
        if not state:
            # 任务记录丢失时重建状态
            logger.warning(
                f"Task state missing, recreating: {task_type}/{username}/{project}/{episode}"
            )
            state = self.create_task(
                task_type, username, project, episode, beat_num, scope, metadata=None
            )

        if state.status in {"completed", "failed"}:
            logger.warning(
                "Ignore progress update for terminal task: %s/%s/%s/%s status=%s",
                task_type,
                username,
                project,
                episode,
                state.status,
            )
            return

        state.status = "running"
        if progress is not None:
            state.progress = progress
        if current_task is not None:
            state.current_task = current_task
        if logs:
            state.logs = self._merge_logs(state.logs, logs, self.MAX_LOGS)
        if metadata is not None:
            state.metadata = self._merge_task_metadata(state.metadata, metadata)
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
        state.updated_at = utc_now_iso()
        self._save(state)

    def update_progress_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        progress: float = None,
        current_task: str = None,
        logs: List[str] = None,
        metadata: dict | None = None,
        status: str = "running",
        expected_task_id: str | None = None,
        queue_kind: str | None = None,
    ):
        expected_task_id = expected_task_id or _CURRENT_PROJECT_TASK_ID.get()
        state = self.get_task_for_project(ctx, task_type, episode, beat_num, scope)
        if not state:
            if expected_task_id:
                logger.warning(
                    "Ignore stale project task update for missing row: "
                    "%s/%s/%s expected_task_id=%s scope=%s",
                    task_type,
                    ctx.project_id,
                    episode,
                    expected_task_id,
                    scope,
                )
                return
            state = self.create_task_for_project(
                ctx,
                task_type,
                episode,
                beat_num,
                scope,
                metadata=metadata,
                status=status,
                queue_kind=_queue_kind_from_metadata(metadata, queue_kind),
            )
        if expected_task_id and state.task_id != expected_task_id:
            logger.warning(
                "Ignore stale project task update: %s/%s/%s expected_task_id=%s current_task_id=%s",
                task_type,
                ctx.project_id,
                episode,
                expected_task_id,
                state.task_id,
            )
            return
        if state.status in TERMINAL_TASK_STATUSES:
            logger.warning(
                "Ignore progress update for terminal project task: %s/%s/%s status=%s",
                task_type,
                ctx.project_id,
                episode,
                state.status,
            )
            return

        state.status = status
        if status in {"completed", "failed", "cancelled"} and not state.completed_at:
            state.completed_at = utc_now_iso()
        if progress is not None:
            state.progress = progress
        if current_task is not None:
            state.current_task = current_task
        if logs:
            state.logs = self._merge_logs(state.logs, logs, self.MAX_LOGS)
        if metadata is not None:
            state.metadata = self._merge_task_metadata(state.metadata, metadata)
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
        state.updated_at = utc_now_iso()
        ttl = self.COMPLETED_TTL if status in TERMINAL_TASK_STATUSES else None
        self._save_for_context(ctx, state, ttl=ttl)

    def complete_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        result: dict = None,
        progress: float | None = None,
        current_task: str | None = None,
        logs: List[str] | None = None,
        metadata: dict | None = None,
    ):
        """标记任务完成（由 Actor 在退出前调用）。

        关键：必须在 Actor 退出前调用，确保结果被持久化。

        Args:
            task_type: 任务类型
            username: 用户名
            project: 项目名称
            episode: 集数
            beat_num: Beat 编号（可选）
            scope: 任务作用域（可选）
            result: 任务结果
            progress: 最终进度
            current_task: 最终当前任务描述
            logs: 最终日志快照
            metadata: 额外任务元数据（兼容旧调用方，写入 result_json.task_metadata）
        """
        state = self.get_task(task_type, username, project, episode, beat_num, scope)
        if not state:
            # 即使记录丢失也要记录完成状态
            logger.warning(
                "Task state missing on complete, creating: %s/%s/%s/%s",
                task_type,
                username,
                project,
                episode,
            )
            state = self.create_task(
                task_type, username, project, episode, beat_num, scope, metadata=metadata
            )

        state.status = "completed"
        state.progress = 1.0 if progress is None else progress
        if current_task is not None:
            state.current_task = current_task
        if logs:
            state.logs = self._merge_logs(state.logs, logs, self.MAX_LOGS)
        merged_metadata = self._merge_task_metadata(state.metadata, metadata)
        state.result = self._merge_metadata_into_result(result, merged_metadata)
        state.error = None
        if merged_metadata is not None:
            state.metadata = merged_metadata
        state.completed_at = utc_now_iso()
        state.updated_at = utc_now_iso()
        self._save(state, ttl=self.COMPLETED_TTL)
        logger.info(f"Task completed: {task_type}/{username}/{project}/{episode}")

    def complete_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        result: dict = None,
        progress: float | None = None,
        current_task: str | None = None,
        logs: List[str] | None = None,
        metadata: dict | None = None,
        expected_task_id: str | None = None,
        queue_kind: str | None = None,
    ):
        expected_task_id = expected_task_id or _CURRENT_PROJECT_TASK_ID.get()
        state = self.get_task_for_project(ctx, task_type, episode, beat_num, scope)
        if not state:
            if expected_task_id:
                logger.warning(
                    "Ignore stale project task complete for missing row: "
                    "%s/%s/%s expected_task_id=%s scope=%s",
                    task_type,
                    ctx.project_id,
                    episode,
                    expected_task_id,
                    scope,
                )
                return
            state = self.create_task_for_project(
                ctx,
                task_type,
                episode,
                beat_num,
                scope,
                metadata=metadata,
                queue_kind=_queue_kind_from_metadata(metadata, queue_kind),
            )
        if expected_task_id and state.task_id != expected_task_id:
            logger.warning(
                "Ignore stale project task complete: "
                "%s/%s/%s expected_task_id=%s current_task_id=%s",
                task_type,
                ctx.project_id,
                episode,
                expected_task_id,
                state.task_id,
            )
            return
        if state.status == "cancelled":
            logger.warning(
                "Ignore complete update for cancelled project task: %s/%s/%s",
                task_type,
                ctx.project_id,
                episode,
            )
            return
        state.status = "completed"
        state.progress = 1.0 if progress is None else progress
        if current_task is not None:
            state.current_task = current_task
        if logs:
            state.logs = self._merge_logs(state.logs, logs, self.MAX_LOGS)
        merged_metadata = self._merge_task_metadata(state.metadata, metadata)
        state.result = self._merge_metadata_into_result(result, merged_metadata)
        state.error = None
        if merged_metadata is not None:
            state.metadata = merged_metadata
        state.completed_at = utc_now_iso()
        state.updated_at = utc_now_iso()
        self._save_for_context(ctx, state, ttl=self.COMPLETED_TTL)
        logger.info("Project task completed: %s/%s/%s", task_type, ctx.project_id, episode)

    def fail_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        error: str = None,
        progress: float | None = None,
        current_task: str | None = None,
        logs: List[str] | None = None,
        metadata: dict | None = None,
    ):
        """标记任务失败（由 Actor 在异常时调用）。

        Args:
            task_type: 任务类型
            username: 用户名
            project: 项目名称
            episode: 集数
            beat_num: Beat 编号（可选）
            scope: 任务作用域（可选）
            error: 错误信息
        """
        state = self.get_task(task_type, username, project, episode, beat_num, scope)
        if not state:
            # 即使记录丢失也要记录失败状态
            logger.warning(
                f"Task state missing on fail, creating: {task_type}/{username}/{project}/{episode}"
            )
            state = self.create_task(
                task_type, username, project, episode, beat_num, scope, metadata=metadata
            )

        state.status = "failed"
        if error is not None:
            state.error = error
        if progress is not None:
            state.progress = progress
        if current_task is not None:
            state.current_task = current_task
        if logs:
            state.logs = self._merge_logs(state.logs, logs, self.MAX_LOGS)
        if metadata is not None:
            state.metadata = self._merge_task_metadata(state.metadata, metadata)
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
        state.completed_at = utc_now_iso()
        state.updated_at = utc_now_iso()
        self._save(state, ttl=self.COMPLETED_TTL)
        logger.warning(f"Task failed: {task_type}/{username}/{project}/{episode}: {error}")

    def fail_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
        error: str = None,
        progress: float | None = None,
        current_task: str | None = None,
        logs: List[str] | None = None,
        metadata: dict | None = None,
        expected_task_id: str | None = None,
        queue_kind: str | None = None,
    ):
        expected_task_id = expected_task_id or _CURRENT_PROJECT_TASK_ID.get()
        state = self.get_task_for_project(ctx, task_type, episode, beat_num, scope)
        if not state:
            if expected_task_id:
                logger.warning(
                    "Ignore stale project task fail for missing row: "
                    "%s/%s/%s expected_task_id=%s scope=%s",
                    task_type,
                    ctx.project_id,
                    episode,
                    expected_task_id,
                    scope,
                )
                return
            state = self.create_task_for_project(
                ctx,
                task_type,
                episode,
                beat_num,
                scope,
                metadata=metadata,
                queue_kind=_queue_kind_from_metadata(metadata, queue_kind),
            )
        if expected_task_id and state.task_id != expected_task_id:
            logger.warning(
                "Ignore stale project task fail: %s/%s/%s expected_task_id=%s current_task_id=%s",
                task_type,
                ctx.project_id,
                episode,
                expected_task_id,
                state.task_id,
            )
            return
        if state.status == "cancelled":
            logger.warning(
                "Ignore fail update for cancelled project task: %s/%s/%s",
                task_type,
                ctx.project_id,
                episode,
            )
            return
        state.status = "failed"
        if error is not None:
            state.error = error
        if progress is not None:
            state.progress = progress
        if current_task is not None:
            state.current_task = current_task
        if logs:
            state.logs = self._merge_logs(state.logs, logs, self.MAX_LOGS)
        if metadata is not None:
            state.metadata = self._merge_task_metadata(state.metadata, metadata)
            state.result = self._merge_metadata_into_result(state.result, state.metadata)
        state.completed_at = utc_now_iso()
        state.updated_at = utc_now_iso()
        self._save_for_context(ctx, state, ttl=self.COMPLETED_TTL)
        logger.warning(
            "Project task failed: %s/%s/%s: %s",
            task_type,
            ctx.project_id,
            episode,
            error,
        )

    def get_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ) -> Optional[TaskState]:
        """获取任务状态（由前端调用）。

        Args:
            task_type: 任务类型
            username: 用户名
            project: 项目名称
            episode: 集数
            beat_num: Beat 编号（可选）
            scope: 任务作用域（可选）

        Returns:
            TaskState 或 None（如果不存在）
        """
        key = self._key(task_type, username, project, episode, beat_num, scope)
        with self._connect(username, project) as conn:
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ?",
                (key,),
            ).fetchone()

        if not row:
            return None
        if self._is_expired(row["expires_at"]):
            self._delete_expired_key(key)
            return None
        return self._row_to_state(row)

    def _sweep_interrupted_inline_tasks_once(self, conn, db_path: Path) -> None:
        """把进程启动前遗留的 ACTIVE inline 任务落为 failed(僵尸回收)。

        inline worker 随 API 进程消亡,这类任务不可能仍在执行;不回收会永久
        挡住去重守卫与并发限额。Celery/EE worker 独立于本进程,按 backend
        标记排除。挂在 _connect_path 上、按库记忆化只跑一次/进程,因此
        reserve/lane/legacy 等所有路径同样受益且无每次读写的写放大。
        时间戳按字符串比较:两侧均为 utc_now_iso 产物且保证含小数位。
        """
        key = str(db_path)
        with self._sweep_lock:
            if key in self._swept_dbs:
                return
        now = utc_now_iso()
        try:
            conn.execute(
                "UPDATE task_states SET status = 'failed', "
                "error = COALESCE(NULLIF(error, ''), ?), "
                "completed_at = ?, updated_at = ?, expires_at = ? "
                "WHERE status IN ('submitting', 'queued', 'running') "
                "AND updated_at < ? "
                "AND json_valid(result_json) "
                "AND json_extract(result_json, '$.task_metadata.backend') = 'inline'",
                (
                    "服务重启,任务已中断,请重新发起",
                    now,
                    now,
                    compute_expiry(self.COMPLETED_TTL),
                    _PROCESS_STARTED_AT,
                ),
            )
            conn.commit()
        except sqlite3.OperationalError as exc:
            # 清扫失败不能拖垮正常读写;不记忆化,下次连接重试。
            logger.warning("interrupted-inline sweep skipped for %s: %s", key, exc)
            return
        with self._sweep_lock:
            self._swept_dbs.add(key)

    def get_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ) -> Optional[TaskState]:
        key = self._project_key(task_type, ctx.project_id, episode, beat_num, scope)
        with self._connect_context(ctx) as conn:
            row = conn.execute(
                "SELECT * FROM task_states WHERE task_key = ? AND project_id = ?",
                (key, ctx.project_id),
            ).fetchone()

        if not row:
            return None
        if self._is_expired(row["expires_at"]):
            self._delete_expired_project_key(ctx, key)
            return None
        return self._row_to_state(row)

    def delete_task(
        self,
        task_type: str,
        username: str,
        project: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ):
        """删除任务状态。

        在重新启动任务或清理旧状态时调用。

        Args:
            task_type: 任务类型
            username: 用户名
            project: 项目名称
            episode: 集数
            beat_num: Beat 编号（可选）
            scope: 任务作用域（可选）
        """
        key = self._key(task_type, username, project, episode, beat_num, scope)
        with self._connect(username, project) as conn:
            conn.execute("DELETE FROM task_states WHERE task_key = ?", (key,))
        logger.debug(f"Task deleted: {key}")

    def delete_task_for_project(
        self,
        ctx: ProjectContext,
        task_type: str,
        episode: int,
        beat_num: int = None,
        scope: str | None = None,
    ):
        key = self._project_key(task_type, ctx.project_id, episode, beat_num, scope)
        with self._connect_context(ctx) as conn:
            conn.execute(
                "DELETE FROM task_states WHERE task_key = ? AND project_id = ?",
                (key, ctx.project_id),
            )
        logger.debug("Project task deleted: %s", key)

    def list_tasks_for_project(self, ctx: ProjectContext) -> List[TaskState]:
        tasks: list[TaskState] = []
        expired_keys: list[str] = []
        with self._connect_context(ctx) as conn:
            rows = conn.execute(
                "SELECT * FROM task_states WHERE project_id = ? ORDER BY updated_at DESC",
                (ctx.project_id,),
            ).fetchall()

            for row in rows:
                if self._is_expired(row["expires_at"]):
                    expired_keys.append(row["task_key"])
                    continue
                try:
                    tasks.append(self._row_to_state(row))
                except Exception as e:
                    logger.warning(
                        "Failed to parse project task state for key %s: %s",
                        row["task_key"],
                        e,
                    )

            if expired_keys:
                conn.executemany(
                    "DELETE FROM task_states WHERE task_key = ? AND project_id = ?",
                    [(key, ctx.project_id) for key in expired_keys],
                )

        tasks.sort(key=lambda task: task.updated_at or task.created_at or "", reverse=True)
        return tasks

    def count_active_tasks_for_project(self, ctx: ProjectContext) -> int:
        try:
            with self._connect_context(ctx) as conn:
                    return self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                )
        except Exception:
            return 0

    def count_active_tasks_for_project_lane(
        self,
        ctx: ProjectContext,
        queue_kind: str | None,
    ) -> int:
        try:
            with self._connect_context(ctx) as conn:
                return self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                    queue_kind=queue_kind,
                )
        except Exception:
            return 0

    def count_active_tasks_for_project_user_lane(
        self,
        ctx: ProjectContext,
        queue_kind: str | None,
    ) -> int:
        try:
            with self._connect_context(ctx) as conn:
                return self._count_active_project_tasks_on_connection(
                    conn,
                    project_id=ctx.project_id,
                    queue_kind=queue_kind,
                    requester_user_id=ctx.requester_user_id,
                )
        except Exception:
            return 0

    def list_tasks_for_user(self, username: str) -> List[TaskState]:
        """列出用户的所有任务。

        Args:
            username: 用户名

        Returns:
            按更新时间倒序排列的任务列表
        """
        tasks = []
        for db_path in self._list_project_db_paths(username):
            project = db_path.parent.name
            expired_keys = []
            with self._connect(username, project) as conn:
                rows = conn.execute(
                    "SELECT * FROM task_states WHERE username = ? ORDER BY updated_at DESC",
                    (username,),
                ).fetchall()

                for row in rows:
                    if self._is_expired(row["expires_at"]):
                        expired_keys.append(row["task_key"])
                        continue
                    try:
                        tasks.append(self._row_to_state(row))
                    except Exception as e:
                        logger.warning(f"Failed to parse task state for key {row['task_key']}: {e}")

                if expired_keys:
                    conn.executemany(
                        "DELETE FROM task_states WHERE task_key = ?",
                        [(key,) for key in expired_keys],
                    )

        tasks.sort(key=lambda task: task.updated_at or task.created_at or "", reverse=True)
        return tasks

    def count_active_tasks_for_user(self, username: str) -> int:
        """统计用户所有项目中活跃任务数（轻量级 COUNT 查询，不反序列化行数据）。"""
        count = 0
        for db_path in self._list_project_db_paths(username):
            project = db_path.parent.name
            try:
                with self._connect(username, project) as conn:
                    placeholders = ",".join("?" for _ in ACTIVE_PROJECT_TASK_STATUSES)
                    row = conn.execute(
                        "SELECT COUNT(*) FROM task_states "
                        f"WHERE username = ? AND status IN ({placeholders})",
                        (username, *ACTIVE_PROJECT_TASK_STATUSES),
                    ).fetchone()
                    count += row[0]
            except Exception:
                continue
        return count

    def _save(self, state: TaskState, ttl: int = None):
        """保存任务状态到 SQLite。

        Args:
            state: 任务状态
            ttl: 过期时间（秒），None 表示不过期
        """
        task_key = self._task_key_for_state(state)
        expires_at = compute_expiry(ttl)
        with self._connect(state.username, state.project) as conn:
            self._save_on_connection(conn, task_key, state, expires_at)

    def _save_for_context(self, ctx: ProjectContext, state: TaskState, ttl: int = None):
        state.project_id = state.project_id or ctx.project_id
        state.requester_user_id = state.requester_user_id or ctx.requester_user_id
        state.owner_username = state.owner_username or ctx.owner_username
        state.project_name = state.project_name or ctx.project_name
        state.username = state.username or ctx.requester_username
        state.project = state.project or ctx.project_name
        task_key = self._task_key_for_state(state)
        expires_at = compute_expiry(ttl)
        with self._connect_context(ctx) as conn:
            self._save_on_connection(conn, task_key, state, expires_at)

    @staticmethod
    def _task_key_for_state(state: TaskState) -> str:
        if state.project_id:
            return project_task_state_key(
                state.task_type,
                state.project_id,
                state.episode,
                beat_num=state.beat_num,
                scope=state.scope,
            )
        return task_state_key(
            state.task_type,
            state.username,
            state.project,
            state.episode,
            beat_num=state.beat_num,
            scope=state.scope,
        )

    @staticmethod
    def _save_on_connection(conn, task_key: str, state: TaskState, expires_at: str | None) -> None:
        conn.execute(
            """
            INSERT INTO task_states (
                task_key, task_id, task_type, queue_kind, project_id, requester_user_id,
                owner_username, project_name, username, project, episode, beat_num,
                status, progress, current_task, result_json, error, logs_json,
                created_at, updated_at, completed_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_key) DO UPDATE SET
                task_id = excluded.task_id,
                task_type = excluded.task_type,
                queue_kind = excluded.queue_kind,
                project_id = excluded.project_id,
                requester_user_id = excluded.requester_user_id,
                owner_username = excluded.owner_username,
                project_name = excluded.project_name,
                username = excluded.username,
                project = excluded.project,
                episode = excluded.episode,
                beat_num = excluded.beat_num,
                status = excluded.status,
                progress = excluded.progress,
                current_task = excluded.current_task,
                result_json = excluded.result_json,
                error = excluded.error,
                logs_json = excluded.logs_json,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                completed_at = excluded.completed_at,
                expires_at = excluded.expires_at
            """,
            (
                task_key,
                state.task_id,
                state.task_type,
                state.queue_kind,
                state.project_id,
                state.requester_user_id,
                state.owner_username,
                state.project_name,
                state.username,
                state.project,
                state.episode,
                state.beat_num,
                state.status,
                state.progress,
                state.current_task,
                (
                    json.dumps(state.result, ensure_ascii=False)
                    if state.result is not None
                    else None
                ),
                state.error,
                json.dumps(state.logs, ensure_ascii=False),
                state.created_at,
                state.updated_at,
                state.completed_at,
                expires_at,
            ),
        )


# 全局单例
_task_manager: Optional[TaskStateManager] = None


def get_task_manager() -> TaskStateManager:
    """获取 TaskStateManager 单例。

    Returns:
        TaskStateManager 实例
    """
    global _task_manager
    if _task_manager is None:
        _task_manager = TaskStateManager()
    return _task_manager

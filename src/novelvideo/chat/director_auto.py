"""Durable server-side coordinator for outer 虾导 episode auto mode."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sqlite3
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from novelvideo.chat import service as chat_service
from novelvideo.chat.live_events import broadcast_project_chat_event
from novelvideo.project_context import ProjectContext, resolve_project_context
from novelvideo.sqlite_pragmas import configure_sqlite_connection
from novelvideo.task_state import TaskState, get_task_manager


logger = logging.getLogger(__name__)

AUTO_TASK_TYPES = frozenset({
    "ingest_fast",
    "build_characters",
    "build_scenes",
    "build_props",
    "build_episodes",
    "identity_planner",
    "character_portrait",
    "identity_image",
    "content_rewriter",
    "script_writer",
    "literal_script_writer",
    "director_notes",
    "episode_scene_planner",
    "episode_prop_planner",
    "scene_reference_asset",
    "prop_reference_asset",
    "beat_video_prompt",
    "sketch_grid_generation",
    "sketch_generation",
    "sketch_regen",
    "grid_regenerate",
    "mainline_sketch_from_context",
    "mainline_frame_from_context",
    "ai_identity_detection",
    "global_optimize_video",
    "selected_regen",
    "render_plan",
    "system_voice_setup",
    "audio_generation",
    "indextts2_audio_generation",
    "audio_generation_indextts2",
    "single_video",
    "compose_episode",
})
ACTIVE_STATUSES = frozenset({"submitting", "queued", "pending", "running"})
TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
POLL_SECONDS = 1.5
INITIAL_GRACE_SECONDS = 5.0
LEASE_SECONDS = 45.0
HEARTBEAT_SECONDS = 10.0
_MISSING_CHARACTER_PORTRAIT_RE = re.compile(
    r"请先为角色[「“\"](?P<character>.+?)[」”\"]生成\s*Portrait（面部特写）"
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _timestamp(value: str | None) -> float:
    try:
        return datetime.fromisoformat(str(value or "").replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _state_root() -> Path:
    configured = os.environ.get("NOVELVIDEO_STATE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path(__file__).resolve().parents[3] / "state"


def _serialize_context(ctx: ProjectContext) -> str:
    data = asdict(ctx)
    for key in ("output_dir", "state_dir", "runtime_dir"):
        data[key] = str(data[key])
    data["requester_principals"] = [list(item) for item in ctx.requester_principals]
    return json.dumps(data, ensure_ascii=False)


def _deserialize_context(raw: str) -> ProjectContext:
    data = json.loads(raw)
    for key in ("output_dir", "state_dir", "runtime_dir"):
        data[key] = Path(data[key])
    data["requester_principals"] = tuple(tuple(item) for item in data["requester_principals"])
    return ProjectContext(**data)


@dataclass(frozen=True)
class DirectorAutoRun:
    run_id: str
    username: str
    project_id: str
    episode: int
    status: str
    activated_at: str
    updated_at: str
    context_json: str
    baseline_task_ids: tuple[str, ...]
    handled_task_ids: tuple[str, ...]
    recovery_keys: tuple[str, ...] = ()
    voice_policy: str = ""
    last_error: str = ""

    @property
    def context(self) -> ProjectContext:
        return _deserialize_context(self.context_json)


class DirectorAutoStore:
    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or (_state_root() / "director_auto.db")

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        configure_sqlite_connection(conn)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS director_auto_runs (
              run_id TEXT PRIMARY KEY,
              username TEXT NOT NULL,
              project_id TEXT NOT NULL,
              episode INTEGER NOT NULL,
              status TEXT NOT NULL,
              activated_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              context_json TEXT NOT NULL,
              baseline_task_ids_json TEXT NOT NULL,
              handled_task_ids_json TEXT NOT NULL,
              recovery_keys_json TEXT NOT NULL DEFAULT '[]',
              voice_policy TEXT NOT NULL DEFAULT '',
              last_error TEXT NOT NULL DEFAULT '',
              owner_token TEXT NOT NULL DEFAULT '',
              lease_expires_at REAL NOT NULL DEFAULT 0,
              UNIQUE(username, project_id)
            )
            """
        )
        columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(director_auto_runs)").fetchall()
        }
        if "recovery_keys_json" not in columns:
            conn.execute(
                "ALTER TABLE director_auto_runs "
                "ADD COLUMN recovery_keys_json TEXT NOT NULL DEFAULT '[]'"
            )
        if "voice_policy" not in columns:
            conn.execute(
                "ALTER TABLE director_auto_runs "
                "ADD COLUMN voice_policy TEXT NOT NULL DEFAULT ''"
            )
        if "owner_token" not in columns:
            conn.execute(
                "ALTER TABLE director_auto_runs "
                "ADD COLUMN owner_token TEXT NOT NULL DEFAULT ''"
            )
        if "lease_expires_at" not in columns:
            conn.execute(
                "ALTER TABLE director_auto_runs "
                "ADD COLUMN lease_expires_at REAL NOT NULL DEFAULT 0"
            )
        conn.commit()
        return conn

    @staticmethod
    def _row(row: sqlite3.Row | None) -> DirectorAutoRun | None:
        if row is None:
            return None
        return DirectorAutoRun(
            run_id=str(row["run_id"]),
            username=str(row["username"]),
            project_id=str(row["project_id"]),
            episode=int(row["episode"]),
            status=str(row["status"]),
            activated_at=str(row["activated_at"]),
            updated_at=str(row["updated_at"]),
            context_json=str(row["context_json"]),
            baseline_task_ids=tuple(json.loads(row["baseline_task_ids_json"] or "[]")),
            handled_task_ids=tuple(json.loads(row["handled_task_ids_json"] or "[]")),
            recovery_keys=tuple(json.loads(row["recovery_keys_json"] or "[]")),
            voice_policy=str(row["voice_policy"] or ""),
            last_error=str(row["last_error"] or ""),
        )

    def upsert(self, run: DirectorAutoRun) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO director_auto_runs(
                  run_id, username, project_id, episode, status, activated_at,
                  updated_at, context_json, baseline_task_ids_json,
                  handled_task_ids_json, recovery_keys_json, voice_policy, last_error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(username, project_id) DO UPDATE SET
                  run_id=excluded.run_id,
                  episode=excluded.episode,
                  status=excluded.status,
                  activated_at=excluded.activated_at,
                  updated_at=excluded.updated_at,
                  context_json=excluded.context_json,
                  baseline_task_ids_json=excluded.baseline_task_ids_json,
                  handled_task_ids_json=excluded.handled_task_ids_json,
                  recovery_keys_json=excluded.recovery_keys_json,
                  voice_policy=excluded.voice_policy,
                  last_error=excluded.last_error,
                  owner_token=CASE
                    WHEN director_auto_runs.run_id != excluded.run_id THEN ''
                    ELSE director_auto_runs.owner_token
                  END,
                  lease_expires_at=CASE
                    WHEN director_auto_runs.run_id != excluded.run_id THEN 0
                    ELSE director_auto_runs.lease_expires_at
                  END
                """,
                (
                    run.run_id,
                    run.username,
                    run.project_id,
                    run.episode,
                    run.status,
                    run.activated_at,
                    run.updated_at,
                    run.context_json,
                    json.dumps(list(run.baseline_task_ids)),
                    json.dumps(list(run.handled_task_ids)),
                    json.dumps(list(run.recovery_keys)),
                    run.voice_policy,
                    run.last_error,
                ),
            )

    def get(self, username: str, project_id: str) -> DirectorAutoRun | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM director_auto_runs WHERE username=? AND project_id=?",
                (username, project_id),
            ).fetchone()
        return self._row(row)

    def active(self) -> list[DirectorAutoRun]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM director_auto_runs WHERE status='running'"
            ).fetchall()
        return [run for row in rows if (run := self._row(row)) is not None]

    def claim_lease(
        self,
        run_id: str,
        owner_token: str,
        *,
        lease_seconds: float = LEASE_SECONDS,
        now: float | None = None,
    ) -> bool:
        """Atomically claim one running coordinator lease across API processes."""

        current = datetime.now(timezone.utc).timestamp() if now is None else float(now)
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE director_auto_runs
                SET owner_token=?, lease_expires_at=?
                WHERE run_id=? AND status='running'
                  AND (owner_token='' OR owner_token=? OR lease_expires_at<=?)
                """,
                (owner_token, current + lease_seconds, run_id, owner_token, current),
            )
            conn.commit()
            return cursor.rowcount == 1

    def renew_lease(
        self,
        run_id: str,
        owner_token: str,
        *,
        lease_seconds: float = LEASE_SECONDS,
        now: float | None = None,
    ) -> bool:
        current = datetime.now(timezone.utc).timestamp() if now is None else float(now)
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE director_auto_runs
                SET lease_expires_at=?
                WHERE run_id=? AND status='running' AND owner_token=?
                  AND lease_expires_at>?
                """,
                (current + lease_seconds, run_id, owner_token, current),
            )
            conn.commit()
            return cursor.rowcount == 1

    def owns_lease(
        self,
        run_id: str,
        owner_token: str,
        *,
        now: float | None = None,
    ) -> bool:
        current = datetime.now(timezone.utc).timestamp() if now is None else float(now)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT 1 FROM director_auto_runs
                WHERE run_id=? AND status='running' AND owner_token=?
                  AND lease_expires_at>?
                """,
                (run_id, owner_token, current),
            ).fetchone()
        return row is not None

    def update_if_owned(
        self,
        run: DirectorAutoRun,
        owner_token: str,
        *,
        now: float | None = None,
    ) -> bool:
        """Persist a worker transition only while its lease is still current."""

        current = datetime.now(timezone.utc).timestamp() if now is None else float(now)
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE director_auto_runs
                SET episode=?, status=?, activated_at=?, updated_at=?, context_json=?,
                    baseline_task_ids_json=?, handled_task_ids_json=?,
                    recovery_keys_json=?, voice_policy=?, last_error=?
                WHERE run_id=? AND status='running' AND owner_token=?
                  AND lease_expires_at>?
                """,
                (
                    run.episode,
                    run.status,
                    run.activated_at,
                    run.updated_at,
                    run.context_json,
                    json.dumps(list(run.baseline_task_ids)),
                    json.dumps(list(run.handled_task_ids)),
                    json.dumps(list(run.recovery_keys)),
                    run.voice_policy,
                    run.last_error,
                    run.run_id,
                    owner_token,
                    current,
                ),
            )
            conn.commit()
            return cursor.rowcount == 1

    def release_lease(self, run_id: str, owner_token: str) -> bool:
        """Release only the caller's lease; stale workers cannot release a new owner."""

        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE director_auto_runs
                SET owner_token='', lease_expires_at=0
                WHERE run_id=? AND owner_token=?
                """,
                (run_id, owner_token),
            )
            conn.commit()
            return cursor.rowcount == 1

    def force_release_lease(self, run_id: str) -> None:
        """User/control-plane path for intentionally stopping any current owner."""

        with self._connect() as conn:
            conn.execute(
                """
                UPDATE director_auto_runs
                SET owner_token='', lease_expires_at=0
                WHERE run_id=?
                """,
                (run_id,),
            )
            conn.commit()


def _relevant_tasks(run: DirectorAutoRun, tasks: Iterable[TaskState]) -> list[TaskState]:
    return [
        task
        for task in tasks
        if task.task_type in AUTO_TASK_TYPES
        and (task.episode in {0, run.episode})
    ]


def _task_label(task: TaskState) -> str:
    result = task.result if isinstance(task.result, dict) else {}
    scope_parts = [part.strip() for part in str(task.scope or "").split(":") if part.strip()]
    if task.task_type == "character_portrait":
        character = str(result.get("character_name") or "").strip()
        if not character and len(scope_parts) > 1:
            character = scope_parts[1]
        return f"{character}肖像" if character else "角色肖像"
    if task.task_type == "identity_image":
        character = str(result.get("character_name") or "").strip()
        identity = str(result.get("identity_name") or "").strip()
        if not character and len(scope_parts) > 1:
            character = scope_parts[1]
        if not identity and len(scope_parts) > 3:
            identity = scope_parts[3]
        if character and identity:
            return f"{character}「{identity}」身份图"
        return f"{character or identity or '角色'}身份图"
    if task.task_type == "single_video" and task.beat_num:
        return f"第 {task.episode} 集 Beat {task.beat_num} 视频"
    labels = {
        "ingest_fast": "项目摄入",
        "build_characters": "角色构建",
        "build_props": "道具构建",
        "build_episodes": "剧集规划",
        "identity_planner": "身份规划",
        "character_portrait": "角色肖像",
        "identity_image": "身份图生成",
        "script_writer": "剧本生成",
        "content_rewriter": "解说改写",
        "literal_script_writer": "解说稿生成",
        "director_notes": "导演说明",
        "build_scenes": "场景规划",
        "episode_scene_planner": "本集场景规划",
        "episode_prop_planner": "本集道具规划",
        "scene_reference_asset": "场景参考图",
        "prop_reference_asset": "道具参考图",
        "sketch_grid_generation": "草图网格",
        "sketch_generation": "草图生成",
        "sketch_regen": "草图重生成",
        "grid_regenerate": "草图网格重生成",
        "mainline_sketch_from_context": "草图生成",
        "mainline_frame_from_context": "首帧生成",
        "ai_identity_detection": "身份检测",
        "global_optimize_video": "全局优化",
        "selected_regen": "首帧生成",
        "render_plan": "渲染规划",
        "system_voice_setup": "系统声线准备",
        "audio_generation_indextts2": "音频生成",
        "indextts2_audio_generation": "音频生成",
        "audio_generation": "音频生成",
        "single_video": "视频生成",
        "compose_episode": "成片合成",
    }
    return labels.get(task.task_type, task.task_type)


def _missing_character_portrait(task: TaskState) -> str | None:
    """Return the exact missing character for the one safe auto-repair case."""

    if task.task_type != "identity_image" or task.status != "failed":
        return None
    match = _MISSING_CHARACTER_PORTRAIT_RE.search(str(task.error or ""))
    if match is None:
        return None
    character = match.group("character").strip()
    return character or None


class DirectorAutoCoordinator:
    def __init__(self, store: DirectorAutoStore | None = None) -> None:
        self.store = store or DirectorAutoStore()
        self.owner_token = uuid.uuid4().hex
        self._workers: dict[str, asyncio.Task[None]] = {}
        self._stopping = False

    async def start(
        self,
        *,
        username: str,
        ctx: ProjectContext,
        episode: int,
        voice_policy: str = "",
    ) -> DirectorAutoRun:
        tasks = await asyncio.to_thread(get_task_manager().list_tasks_for_project, ctx)
        now = _utc_now()
        run = DirectorAutoRun(
            run_id=uuid.uuid4().hex,
            username=username,
            project_id=ctx.project_id,
            episode=max(int(episode), 1),
            status="running",
            activated_at=now,
            updated_at=now,
            context_json=_serialize_context(ctx),
            # Adopt tasks already running when the user confirms auto mode;
            # only terminal history is baseline noise.
            baseline_task_ids=tuple(
                task.task_id for task in tasks if task.status in TERMINAL_STATUSES
            ),
            handled_task_ids=(),
            voice_policy=voice_policy if voice_policy in {"system", "custom"} else "",
        )
        await asyncio.to_thread(self.store.upsert, run)
        self._ensure_worker(run)
        await self._broadcast_status(run)
        return run

    async def pause(
        self,
        *,
        username: str,
        project_id: str,
        reason: str = "",
        terminal_task_id: str | None = None,
    ) -> DirectorAutoRun | None:
        run = await asyncio.to_thread(self.store.get, username, project_id)
        if run is None:
            return None
        updated = DirectorAutoRun(
            **{
                **asdict(run),
                "status": "paused",
                "updated_at": _utc_now(),
                "last_error": reason,
            }
        )
        await asyncio.to_thread(self.store.upsert, updated)
        await asyncio.to_thread(self.store.force_release_lease, run.run_id)
        await self._broadcast_status(updated, terminal_task_id=terminal_task_id)
        worker = self._workers.pop(run.run_id, None)
        if worker is not None and worker is not asyncio.current_task():
            worker.cancel()
        return updated

    async def suspend_for_confirmation(
        self,
        *,
        username: str,
        project_id: str,
        reason: str = "等待用户确认是否修改",
    ) -> DirectorAutoRun | None:
        """Suspend future auto steps without cancelling any queued/running task."""

        run = await asyncio.to_thread(self.store.get, username, project_id)
        if run is None:
            return None
        if run.status == "awaiting_confirmation":
            return run
        if run.status != "running":
            raise ValueError("本集自动当前未在运行，不能进入修改确认状态")
        updated = DirectorAutoRun(
            **{
                **asdict(run),
                "status": "awaiting_confirmation",
                "updated_at": _utc_now(),
                "last_error": reason,
            }
        )
        await asyncio.to_thread(self.store.upsert, updated)
        await asyncio.to_thread(self.store.force_release_lease, run.run_id)
        await self._broadcast_status(updated)
        worker = self._workers.pop(run.run_id, None)
        if worker is not None and worker is not asyncio.current_task():
            worker.cancel()
        return updated

    async def resume_suspended(
        self,
        *,
        username: str,
        project_id: str,
    ) -> DirectorAutoRun | None:
        """Resume the same durable run after the user declines a proposed change."""

        run = await asyncio.to_thread(self.store.get, username, project_id)
        if run is None:
            return None
        if run.status == "running":
            self._ensure_worker(run)
            return run
        if run.status != "awaiting_confirmation":
            raise ValueError("只有等待修改确认的本集自动任务可以恢复")
        updated = DirectorAutoRun(
            **{
                **asdict(run),
                "status": "running",
                "updated_at": _utc_now(),
                "last_error": "",
            }
        )
        await asyncio.to_thread(self.store.upsert, updated)
        self._ensure_worker(updated)
        await self._broadcast_status(updated)
        return updated

    async def get(self, *, username: str, project_id: str) -> DirectorAutoRun | None:
        return await asyncio.to_thread(self.store.get, username, project_id)

    async def resume(self) -> None:
        self._stopping = False
        for run in await asyncio.to_thread(self.store.active):
            self._ensure_worker(run)

    async def shutdown(self) -> None:
        self._stopping = True
        workers = list(self._workers.values())
        self._workers.clear()
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)

    def _ensure_worker(self, run: DirectorAutoRun) -> None:
        existing = self._workers.get(run.run_id)
        if existing is not None and not existing.done():
            return
        worker = asyncio.create_task(
            self._run_with_lease(run.run_id, run.username, run.project_id),
            name=f"director-auto:{run.project_id}:{run.episode}",
        )
        self._workers[run.run_id] = worker
        worker.add_done_callback(lambda _done, run_id=run.run_id: self._workers.pop(run_id, None))

    async def _run_with_lease(self, run_id: str, username: str, project_id: str) -> None:
        while not self._stopping:
            claimed = await asyncio.to_thread(
                self.store.claim_lease,
                run_id,
                self.owner_token,
            )
            if claimed:
                break
            run = await asyncio.to_thread(self.store.get, username, project_id)
            if run is None or run.run_id != run_id or run.status != "running":
                return
            await asyncio.sleep(HEARTBEAT_SECONDS)
        else:
            return
        parent = asyncio.current_task()
        heartbeat = asyncio.create_task(
            self._lease_heartbeat(run_id, parent),
            name=f"director-auto-heartbeat:{project_id}",
        )
        try:
            await self._run(run_id, username, project_id)
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            await asyncio.to_thread(
                self.store.release_lease,
                run_id,
                self.owner_token,
            )

    async def _lease_heartbeat(
        self,
        run_id: str,
        parent: asyncio.Task[None] | None,
    ) -> None:
        while not self._stopping:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            renewed = await asyncio.to_thread(
                self.store.renew_lease,
                run_id,
                self.owner_token,
            )
            if renewed:
                continue
            if parent is not None and not parent.done():
                parent.cancel()
            return

    async def _owns_run(self, run_id: str) -> bool:
        return await asyncio.to_thread(
            self.store.owns_lease,
            run_id,
            self.owner_token,
        )

    async def _update_owned(self, run: DirectorAutoRun) -> bool:
        return await asyncio.to_thread(
            self.store.update_if_owned,
            run,
            self.owner_token,
        )

    async def _pause_owned(
        self,
        *,
        run_id: str,
        username: str,
        project_id: str,
        reason: str = "",
        terminal_task_id: str | None = None,
    ) -> DirectorAutoRun | None:
        """Pause from a worker only if this coordinator still owns the run."""

        run = await asyncio.to_thread(self.store.get, username, project_id)
        if run is None or run.run_id != run_id:
            return None
        updated = DirectorAutoRun(
            **{
                **asdict(run),
                "status": "paused",
                "updated_at": _utc_now(),
                "last_error": reason,
            }
        )
        if not await self._update_owned(updated):
            return None
        await asyncio.to_thread(
            self.store.release_lease,
            run.run_id,
            self.owner_token,
        )
        await self._broadcast_status(updated, terminal_task_id=terminal_task_id)
        worker = self._workers.pop(run.run_id, None)
        if worker is not None and worker is not asyncio.current_task():
            worker.cancel()
        return updated

    async def _broadcast_status(
        self,
        run: DirectorAutoRun,
        *,
        terminal_task_id: str | None = None,
    ) -> None:
        await broadcast_project_chat_event(
            username=run.username,
            project_id=run.project_id,
            payload={
                "type": "director.auto.status",
                "scope": {"kind": "project", "id": run.project_id, "surface": "director"},
                "status": run.status,
                "episode": run.episode,
                "run_id": run.run_id,
                "message": run.last_error or None,
                "terminal_task_id": terminal_task_id,
                "voice_policy": run.voice_policy or None,
            },
        )

    async def _notify(self, run: DirectorAutoRun, text: str) -> dict[str, Any]:
        ctx = run.context
        message = await asyncio.to_thread(
            chat_service.add_assistant_message,
            run.username,
            run.project_id,
            text,
            [],
            project_dir=ctx.output_dir,
            project_state_dir=ctx.state_dir,
        )
        await broadcast_project_chat_event(
            username=run.username,
            project_id=run.project_id,
            payload={
                "type": "assistant.message",
                "scope": {"kind": "project", "id": run.project_id, "surface": "director"},
                "message": message,
            },
        )
        return message

    async def _agent_continue(
        self,
        run: DirectorAutoRun,
        *,
        final_delivery: bool = False,
        instruction: str | None = None,
    ) -> bool:
        stored_ctx = run.context
        try:
            ctx = await resolve_project_context(
                user={
                    "id": stored_ctx.requester_user_id,
                    "username": stored_ctx.requester_username,
                },
                project_id=run.project_id,
                required_role="editor",
            )
        except Exception as exc:  # noqa: BLE001
            await self._pause_owned(
                run_id=run.run_id,
                username=run.username,
                project_id=run.project_id,
                reason=f"项目权限校验失败：{exc}",
            )
            await self._notify(run, "本集自动已暂停：当前用户已无权继续修改该项目。")
            return False
        # A user-driven turn and a durable continuation share the same project
        # lock. Wait instead of treating ordinary chat activity as auto failure.
        for _ in range(120):
            if not chat_service.chat_run_lock_is_active(run.username, run.project_id):
                break
            latest = await asyncio.to_thread(self.store.get, run.username, run.project_id)
            if latest is None or latest.status != "running":
                return False
            await asyncio.sleep(0.5)
        else:
            await self._pause_owned(
                run_id=run.run_id,
                username=run.username,
                project_id=run.project_id,
                reason="等待虾导空闲超时",
            )
            await self._notify(run, "本集自动已暂停：虾导长时间处于忙碌状态。")
            return False
        prompt = instruction or (
            "第 {episode} 集成片合成已完成。请只读取并展示正式成片，然后简短收口；不要启动新的写任务。"
            if final_delivery
            else (
                "只继续第 {episode} 集的下一步。不得启动、修改或推进其他集；"
                "如果第 {episode} 集已经完成最终合成，只展示并收口。"
            )
        ).format(episode=run.episode)
        prompt += (
            "\n\n[DRAMACLAW_RUN_MODE]\nmode=episode_auto\n"
            "This is a durable server-owned continuation already confirmed by the user. "
            "Inspect current state and start at most one safe missing mainline task. Do not ask "
            "for per-step confirmation. Missing output with satisfied prerequisites should be generated. "
            "Pause for a current-step failure, destructive action, ambiguity, missing voice choice, or "
            "unmet prerequisite, except for one exact Portrait repair explicitly authorized in the "
            "instruction above.\n[/DRAMACLAW_RUN_MODE]"
        )
        if run.voice_policy == "system":
            prompt += (
                "\n\n[DRAMACLAW_VOICE_POLICY]\npolicy=system\n"
                "The user explicitly authorized system voices when starting this episode auto run. "
                "If the current next_step is voice_setup and voices are missing, call "
                "dramaclaw_prepare_system_voices(confirmed=true) without asking again. This only "
                "prepares voices; audio generation remains a later turn.\n[/DRAMACLAW_VOICE_POLICY]"
            )
        elif run.voice_policy == "custom":
            prompt += (
                "\n\n[DRAMACLAW_VOICE_POLICY]\npolicy=custom\n"
                "The user chose uploaded/recorded custom voices. Never substitute system voices. "
                "If required custom voices are still missing at voice_setup, call "
                "dramaclaw_control_episode_auto(action='pause'), then explain the missing items and "
                "ask the user to upload or record them in 虾塘. Do not start audio generation."
                "\n[/DRAMACLAW_VOICE_POLICY]"
            )
        turn_id = f"director-auto-{run.run_id}-{uuid.uuid4().hex[:10]}"
        saw_write = False

        async def on_event(event: dict[str, Any]) -> None:
            nonlocal saw_write
            if event.get("type") in {"tool_started", "tool_updated", "tool_update"}:
                name = str(event.get("name") or "")
                if name.startswith("dramaclaw_") and not name.startswith("dramaclaw_get"):
                    saw_write = True
            if event.get("type") == "assistant_message" and isinstance(event.get("message"), dict):
                await broadcast_project_chat_event(
                    username=run.username,
                    project_id=run.project_id,
                    payload={
                        "type": "assistant.message",
                        "scope": {"kind": "project", "id": run.project_id, "surface": "director"},
                        "turn_id": turn_id,
                        "message": event["message"],
                    },
                )

        try:
            await chat_service.stream_assistant_reply(
                run.username,
                run.project_id,
                prompt,
                on_event,
                project_dir=ctx.output_dir,
                project_state_dir=ctx.state_dir,
                surface="director",
                turn_id=turn_id,
                route_prompt="自动继续下一步",
            )
            return saw_write
        except Exception as exc:  # noqa: BLE001
            logger.exception("director auto continuation failed project=%s", run.project_id)
            await self._pause_owned(
                run_id=run.run_id,
                username=run.username,
                project_id=run.project_id,
                reason=str(exc),
            )
            await self._notify(run, "本集自动已暂停：虾导继续执行失败，请检查服务状态后重试。")
            return False

    async def _run(self, run_id: str, username: str, project_id: str) -> None:
        taskless_continuations = 0
        while not self._stopping:
            if not await self._owns_run(run_id):
                return
            run = await asyncio.to_thread(self.store.get, username, project_id)
            if run is None or run.run_id != run_id or run.status != "running":
                return
            tasks = await asyncio.to_thread(get_task_manager().list_tasks_for_project, run.context)
            relevant = _relevant_tasks(run, tasks)
            baseline = set(run.baseline_task_ids)
            handled = set(run.handled_task_ids)
            new_tasks = [task for task in relevant if task.task_id not in baseline]
            pending_new = [task for task in new_tasks if task.task_id not in handled]
            active = [task for task in pending_new if task.status in ACTIVE_STATUSES]
            if active:
                taskless_continuations = 0
                await asyncio.sleep(POLL_SECONDS)
                continue

            terminal = [
                task
                for task in pending_new
                if task.status in TERMINAL_STATUSES
            ]
            if terminal:
                if not await self._owns_run(run_id):
                    return
                handled.update(task.task_id for task in terminal)
                updated = DirectorAutoRun(
                    **{
                        **asdict(run),
                        "updated_at": _utc_now(),
                        "handled_task_ids": tuple(sorted(handled)),
                    }
                )
                if not await self._update_owned(updated):
                    return
                failures = [task for task in terminal if task.status != "completed"]
                if failures:
                    failed = failures[0]
                    reason = failed.error or failed.current_task or failed.status
                    character = _missing_character_portrait(failed)
                    recovery_key = f"missing-character-portrait:{character}" if character else ""
                    if (
                        len(failures) == 1
                        and character
                        and recovery_key not in set(updated.recovery_keys)
                    ):
                        if not await self._owns_run(run_id):
                            return
                        recovering = DirectorAutoRun(
                            **{
                                **asdict(updated),
                                "updated_at": _utc_now(),
                                "recovery_keys": tuple(
                                    sorted({*updated.recovery_keys, recovery_key})
                                ),
                            }
                        )
                        if not await self._update_owned(recovering):
                            return
                        await self._notify(
                            recovering,
                            f"检测到{_task_label(failed)}缺少前置肖像，正在自动补生成「{character}」肖像。",
                        )
                        if not await self._owns_run(run_id):
                            return
                        wrote = await self._agent_continue(
                            recovering,
                            instruction=(
                                f"自动修复第 {run.episode} 集身份图前置条件：失败信息明确指出角色"
                                f"「{character}」缺少 Portrait（面部特写）。请只读确认后，仅启动该角色"
                                "的一个 Portrait 生成任务；不要重试身份图，不要启动其他步骤，不要询问用户确认。"
                            ),
                        )
                        if wrote:
                            taskless_continuations = 0
                            await asyncio.sleep(POLL_SECONDS)
                            continue
                        latest = await asyncio.to_thread(self.store.get, username, project_id)
                        if latest is None or latest.status != "running":
                            return
                        await self._pause_owned(
                            run_id=run_id,
                            username=username,
                            project_id=project_id,
                            reason=f"无法自动补生成「{character}」肖像",
                            terminal_task_id=failed.task_id,
                        )
                        await self._notify(
                            recovering,
                            f"本集自动已暂停：未能启动「{character}」肖像生成，请检查角色肖像配置。",
                        )
                        return
                    await self._pause_owned(
                        run_id=run_id,
                        username=username,
                        project_id=project_id,
                        reason=reason,
                        terminal_task_id=failed.task_id,
                    )
                    await self._notify(
                        updated,
                        f"本集自动已暂停：{_task_label(failed)}{('已取消' if failed.status == 'cancelled' else '失败')}，{reason}。",
                    )
                    return
                compose = next((task for task in terminal if task.task_type == "compose_episode"), None)
                if len(terminal) == 1:
                    summary = f"✅ {_task_label(terminal[0])}已完成。"
                else:
                    summary = f"✅ 本批 {len(terminal)} 个任务已完成。"
                if compose is not None:
                    await self._notify(updated, f"{summary}正在展示第 {run.episode} 集成片。")
                    if not await self._owns_run(run_id):
                        return
                    await self._agent_continue(updated, final_delivery=True)
                    if not await self._owns_run(run_id):
                        return
                    completed = DirectorAutoRun(
                        **{**asdict(updated), "status": "completed", "updated_at": _utc_now()}
                    )
                    if not await self._update_owned(completed):
                        return
                    await self._broadcast_status(completed)
                    return
                await self._notify(updated, f"{summary}本集自动正在继续下一步。")
                if not await self._owns_run(run_id):
                    return
                await self._agent_continue(updated)
                taskless_continuations = 0
                await asyncio.sleep(POLL_SECONDS)
                continue

            activated_age = max(0.0, datetime.now(timezone.utc).timestamp() - _timestamp(run.activated_at))
            if not pending_new and activated_age >= INITIAL_GRACE_SECONDS:
                if chat_service.chat_run_lock_is_active(username, project_id):
                    await asyncio.sleep(POLL_SECONDS)
                    continue
                if taskless_continuations >= 3:
                    await self._pause_owned(
                        run_id=run_id,
                        username=username,
                        project_id=project_id,
                        reason="自动续跑未产生新的任务",
                    )
                    await self._notify(run, "本集自动已暂停：当前步骤没有产生新的生成任务，请检查前置条件。")
                    return
                taskless_continuations += 1
                if not await self._owns_run(run_id):
                    return
                wrote = await self._agent_continue(run)
                if not wrote:
                    latest = await asyncio.to_thread(self.store.get, username, project_id)
                    if latest is None or latest.status != "running":
                        return
                    await self._pause_owned(
                        run_id=run_id,
                        username=username,
                        project_id=project_id,
                        reason="自动续跑未产生写任务",
                    )
                    await self._notify(run, "本集自动已暂停：虾导没有启动新的生成步骤，请检查当前前置条件。")
                    return
                await asyncio.sleep(POLL_SECONDS)
                continue
            await asyncio.sleep(POLL_SECONDS)


coordinator = DirectorAutoCoordinator()

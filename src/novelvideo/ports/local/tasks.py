"""Local CE task and cancellation port implementations."""

from __future__ import annotations

import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import partial
import logging
import threading
import time
from typing import Any

from novelvideo.ports import get_cancellation_store
from novelvideo.ports.tasks import QueuedTask, cancel_key, display_metadata_for_task
from novelvideo.project_context import require_project_home_node
from novelvideo.task_backend.limits import (
    GlobalLaneQueueLimitExceeded,
    global_lane_concurrency,
    global_lane_queue_limit,
    project_lane_effective_active_limit,
)
from novelvideo.task_backend.queues import QUEUE_KINDS, normalize_queue_kind
from novelvideo.task_backend.run_core import run_project_task_core_sync
from novelvideo.task_backend.subprocesses import kill_task_processes
from novelvideo.task_state import ACTIVE_PROJECT_TASK_STATUSES, get_task_manager

logger = logging.getLogger(__name__)


@dataclass
class _InlineLaneJob:
    envelope: dict[str, Any]
    ctx: Any
    manager: Any
    run_task_id: str
    metadata: dict[str, Any]

    @property
    def project_id(self) -> str:
        return str(self.envelope.get("project_id") or "")


@dataclass
class _InlineLane:
    name: str
    concurrency: int
    queue_limit: int
    executor: ThreadPoolExecutor
    queued: deque[_InlineLaneJob] = field(default_factory=deque)
    active: int = 0
    last_started_project_id: str | None = None


class InlineTaskBackend:
    def __init__(self) -> None:
        self._background_tasks: set[asyncio.Task] = set()
        self._lanes: dict[str, _InlineLane] = {
            lane: _InlineLane(
                name=lane,
                concurrency=global_lane_concurrency(lane),
                queue_limit=global_lane_queue_limit(lane),
                executor=ThreadPoolExecutor(
                    max_workers=global_lane_concurrency(lane),
                    thread_name_prefix=f"inline-{lane}",
                ),
            )
            for lane in sorted(QUEUE_KINDS)
        }

    async def enqueue_project_task(
        self,
        ctx,
        *,
        task_type: str,
        queue_kind: str = "default",
        episode: int = 0,
        beat_num: int | None = None,
        scope: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> QueuedTask:
        require_project_home_node(ctx, operation="enqueue project task")
        manager = get_task_manager()
        payload = payload or {}
        lane_name = normalize_queue_kind(queue_kind)
        metadata = {
            "backend": "inline",
            "queue_kind": lane_name,
            "project_id": ctx.project_id,
            **display_metadata_for_task(task_type, payload),
        }
        project_lane_limit = project_lane_effective_active_limit(
            lane_name,
            eligible_user_count=1,
        )
        state, reserved = manager.reserve_task_for_project(
            ctx,
            task_type,
            episode,
            beat_num=beat_num,
            scope=scope,
            metadata=metadata,
            queue_kind=lane_name,
            project_lane_limit=project_lane_limit,
        )
        if not reserved and state.status in ACTIVE_PROJECT_TASK_STATUSES:
            existing_metadata = state.metadata or {}
            return QueuedTask(
                task_state=state,
                backend=str(existing_metadata.get("backend") or "inline"),
                queue=None,
                celery_id=None,
            )

        manager.update_progress_for_project(
            ctx,
            task_type,
            episode,
            beat_num=beat_num,
            scope=scope,
            progress=0.0,
            current_task="任务已进入队列",
            metadata=metadata,
            status="queued",
            expected_task_id=state.task_id,
        )
        envelope = {
            "project_id": ctx.project_id,
            "requester_user_id": ctx.requester_user_id,
            "task_type": task_type,
            "episode": episode,
            "beat_num": beat_num,
            "scope": scope,
            "queue_kind": lane_name,
            "payload": payload,
        }
        self._submit_lane_job(
            _InlineLaneJob(
                envelope=envelope,
                ctx=ctx,
                manager=manager,
                run_task_id=state.task_id,
                metadata=metadata,
            )
        )
        return QueuedTask(task_state=state, backend="inline")

    def lane_snapshot(self) -> dict[str, dict[str, int]]:
        return {
            name: {
                "active": lane.active,
                "queued": len(lane.queued),
                "concurrency": lane.concurrency,
            }
            for name, lane in sorted(self._lanes.items())
        }

    def _submit_lane_job(self, job: _InlineLaneJob) -> None:
        lane = self._lanes[normalize_queue_kind(job.envelope.get("queue_kind"))]
        if lane.active < lane.concurrency:
            self._start_lane_job(lane, job)
            return
        if len(lane.queued) >= lane.queue_limit:
            job.manager.fail_task_for_project(
                job.ctx,
                str(job.envelope["task_type"]),
                int(job.envelope.get("episode") or 0),
                beat_num=job.envelope.get("beat_num"),
                scope=job.envelope.get("scope"),
                error=f"{lane.name} lane queue is full",
                metadata=job.metadata,
                expected_task_id=job.run_task_id,
            )
            raise GlobalLaneQueueLimitExceeded(
                project_id=job.project_id,
                queue_kind=lane.name,
                limit=lane.queue_limit,
                queued=len(lane.queued),
            )
        lane.queued.append(job)

    def _start_lane_job(self, lane: _InlineLane, job: _InlineLaneJob) -> None:
        lane.active += 1
        lane.last_started_project_id = job.project_id
        task = asyncio.create_task(self._run_inline(lane, job))
        self._background_tasks.add(task)
        task.add_done_callback(
            lambda done, lane_name=lane.name: self._on_background_task_done(done, lane_name)
        )

    def _pop_next_lane_job(self, lane: _InlineLane) -> _InlineLaneJob | None:
        if not lane.queued:
            return None
        if len(lane.queued) == 1:
            return lane.queued.popleft()
        for index, job in enumerate(lane.queued):
            if job.project_id != lane.last_started_project_id:
                del lane.queued[index]
                return job
        return lane.queued.popleft()

    def _drain_lane(self, lane_name: str) -> None:
        lane = self._lanes[lane_name]
        while lane.active < lane.concurrency:
            job = self._pop_next_lane_job(lane)
            if job is None:
                return
            self._start_lane_job(lane, job)

    def _remove_queued_task(self, task_id: str) -> bool:
        for lane in self._lanes.values():
            for index, job in enumerate(lane.queued):
                if job.run_task_id == task_id:
                    del lane.queued[index]
                    return True
        return False

    async def _run_inline(
        self,
        lane: _InlineLane,
        job: _InlineLaneJob,
    ) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            lane.executor,
            partial(
                run_project_task_core_sync,
                job.envelope,
                job.ctx,
                job.manager,
                run_task_id=job.run_task_id,
                metadata=job.metadata,
            ),
        )

    def _on_background_task_done(self, task: asyncio.Task, lane_name: str) -> None:
        self._background_tasks.discard(task)
        lane = self._lanes[lane_name]
        lane.active = max(lane.active - 1, 0)
        if task.cancelled():
            self._drain_lane(lane_name)
            return
        try:
            exc = task.exception()
        except Exception:
            logger.exception("Inline project task background runner failed")
            return
        if exc is not None:
            logger.error(
                "Inline project task background runner failed",
                exc_info=(type(exc), exc, exc.__traceback__),
            )
        self._drain_lane(lane_name)

    async def cancel_project_task(self, ctx, task_state) -> bool:
        await get_cancellation_store().request_cancel(
            project_id=ctx.project_id,
            task_type=task_state.task_type,
            episode=task_state.episode,
            task_id=task_state.task_id,
            beat_num=task_state.beat_num,
            scope=task_state.scope,
        )
        self._remove_queued_task(task_state.task_id)
        get_task_manager().update_progress_for_project(
            ctx,
            task_state.task_type,
            task_state.episode,
            beat_num=task_state.beat_num,
            scope=task_state.scope,
            progress=task_state.progress,
            current_task="任务已取消",
            status="cancelled",
            expected_task_id=task_state.task_id,
        )
        # taskkill/killpg 是阻塞调用(Windows 上可达秒级),不得占事件循环
        await asyncio.get_running_loop().run_in_executor(
            None, kill_task_processes, task_state.task_id
        )
        return True


class InMemoryCancellationStore:
    def __init__(self) -> None:
        self._keys: dict[str, float] = {}
        self._lock = threading.Lock()

    async def request_cancel(
        self,
        *,
        project_id: str,
        task_type: str,
        episode: int,
        task_id: str,
        beat_num: int | None = None,
        scope: str | None = None,
        ttl_seconds: int = 86_400,
    ) -> None:
        key = cancel_key(
            project_id=project_id,
            task_type=task_type,
            episode=episode,
            task_id=task_id,
            beat_num=beat_num,
            scope=scope,
        )
        with self._lock:
            self._keys[key] = time.time() + max(int(ttl_seconds), 0)

    async def is_cancel_requested(
        self,
        *,
        project_id: str,
        task_type: str,
        episode: int,
        task_id: str,
        beat_num: int | None = None,
        scope: str | None = None,
    ) -> bool:
        key = cancel_key(
            project_id=project_id,
            task_type=task_type,
            episode=episode,
            task_id=task_id,
            beat_num=beat_num,
            scope=scope,
        )
        with self._lock:
            expires_at = self._keys.get(key)
            if expires_at is None:
                return False
            if expires_at < time.time():
                self._keys.pop(key, None)
                return False
            return True

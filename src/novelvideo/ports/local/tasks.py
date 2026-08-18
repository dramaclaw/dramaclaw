"""Local CE task and cancellation port implementations."""

from __future__ import annotations

import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import partial
import logging
import random
import threading
import time
from typing import Any

from novelvideo.ports import get_cancellation_store
from novelvideo.ports.authz import AuthzError
from novelvideo.ports.tasks import QueuedTask, cancel_key, display_metadata_for_task
from novelvideo.project_context import require_project_home_node
from novelvideo.task_backend.envelope import (
    InvalidTaskEnvelope,
    TaskAuthorityUnavailable,
)
from novelvideo.task_backend.limits import (
    GlobalLaneQueueLimitExceeded,
    global_lane_concurrency,
    global_lane_queue_limit,
    project_lane_effective_active_limit,
)
from novelvideo.task_backend.queues import QUEUE_KINDS, normalize_queue_kind
from novelvideo.task_backend.run_core import (
    feature_credit_reservation_id,
    refund_undelivered_feature_credit_reservation,
    run_project_task_core_sync,
)
from novelvideo.task_backend.subprocesses import kill_task_processes
from novelvideo.task_state import ACTIVE_PROJECT_TASK_STATUSES, get_task_manager

logger = logging.getLogger(__name__)

_AUTHZ_RETRY_MAX_RETRIES = 5
_AUTHZ_RETRY_BASE_DELAY = 2.0
_AUTHZ_RETRY_CAP_DELAY = 60.0
_AUTHZ_RETRY_SLEEP = asyncio.sleep
_AUTHZ_RETRY_RANDOM = random.random


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
    def __init__(self, *, producer=None, consumer=None) -> None:
        self._producer = producer
        self._consumer = consumer
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
        product_surface: str,
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
            "product_surface": product_surface,
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
            metadata={},
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
        if self._producer is not None:
            authz_failure: AuthzError | None = None
            envelope_failed = False
            try:
                signed = await self._producer.sign_top_level(
                    user_id=ctx.requester_user_id,
                    root_task_id=state.task_id,
                    task_type=task_type,
                    project_id=ctx.project_id,
                    payload={
                        "episode": episode,
                        "beat_num": beat_num,
                        "scope": scope,
                        "queue_kind": lane_name,
                        "payload": payload,
                    },
                )
            except AuthzError as exc:
                authz_failure = exc
                signed = None
            except Exception:
                envelope_failed = True
                signed = None
            if authz_failure is not None or envelope_failed or signed is None:
                safe_code = (
                    authz_failure.code
                    if authz_failure is not None
                    else "TASK_ENVELOPE_INVALID"
                )
                manager.fail_task_for_project(
                    ctx,
                    task_type,
                    episode,
                    beat_num=beat_num,
                    scope=scope,
                    error=(
                        str(authz_failure)
                        if authz_failure is not None
                        else "invalid task envelope"
                    ),
                    metadata={"error_code": safe_code},
                    expected_task_id=state.task_id,
                )
                if authz_failure is not None:
                    raise authz_failure from None
                raise InvalidTaskEnvelope from None
            envelope["task_envelope_v2"] = signed.to_dict()
        self._submit_lane_job(
            _InlineLaneJob(
                envelope=envelope,
                ctx=ctx,
                manager=manager,
                run_task_id=state.task_id,
                metadata=metadata,
            )
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
            lambda done, lane_name=lane.name: self._on_background_task_done(
                done, lane_name
            )
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
        consumer_failure: InvalidTaskEnvelope | TaskAuthorityUnavailable | None = None
        verified = None
        if self._consumer is None:
            consumer_failure = InvalidTaskEnvelope()
        else:
            for retry_index in range(_AUTHZ_RETRY_MAX_RETRIES + 1):
                try:
                    verified = await self._consumer.consume(
                        job.envelope,
                        expected_root_task_id=job.run_task_id,
                    )
                    break
                except InvalidTaskEnvelope as exc:
                    consumer_failure = exc
                    break
                except TaskAuthorityUnavailable as exc:
                    if retry_index >= _AUTHZ_RETRY_MAX_RETRIES:
                        consumer_failure = exc
                        break
                    upper_bound = min(
                        _AUTHZ_RETRY_CAP_DELAY,
                        _AUTHZ_RETRY_BASE_DELAY * (2**retry_index),
                    )
                    await _AUTHZ_RETRY_SLEEP(_AUTHZ_RETRY_RANDOM() * upper_bound)
        if consumer_failure is not None:
            settlement = consumer_failure.settlement
            if settlement is not None:
                # 预留发生在入队侧、退款发生在 run_core 里,而这里是两者之间。
                # 只有签名已验证的拒绝才带 settlement——未验证的信封不驱动资金。
                await refund_undelivered_feature_credit_reservation(
                    feature_credit_reservation_id(
                        job.metadata.get("billing_metadata") or {}
                    ),
                    metadata={
                        "source": "task_rejected_before_worker",
                        "error_code": consumer_failure.code,
                    },
                )
            job.manager.fail_task_for_project(
                job.ctx,
                str(job.envelope.get("task_type") or ""),
                int(job.envelope.get("episode") or 0),
                beat_num=job.envelope.get("beat_num"),
                scope=job.envelope.get("scope"),
                error=str(consumer_failure),
                metadata={"error_code": consumer_failure.code},
                expected_task_id=job.run_task_id,
            )
            return

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            lane.executor,
            partial(
                run_project_task_core_sync,
                verified,
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

    async def cancel_project_task(
        self,
        ctx,
        task_state,
        *,
        force: bool = False,
        acknowledge_no_refund: bool = False,
    ) -> dict:
        del force, acknowledge_no_refund
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
        return {
            "ok": True,
            "status": "cancelled",
            "refund_eligible": True,
            "refund_status": "not_applicable",
        }


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

"""Bounded synchronous work and observations for workflow read maintenance.

Cancelling an HTTP waiter must not free a slot while its thread is still running.
Only maintenance is shared; callers authorize and read their own response.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import copy_context
from functools import partial
from typing import Any, TypeVar

from fastapi import HTTPException

logger = logging.getLogger("novelvideo.api.workflow_reads")
T = TypeVar("T")


def _positive_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except ValueError:
        return default


class WorkflowReadBusy(HTTPException):
    def __init__(self) -> None:
        super().__init__(
            503,
            "Workflow status refresh is busy; retry shortly",
            headers={"Retry-After": "2"},
        )


def _observe(
    stage: str, started: float, *, queue_ms: float = 0, failed: bool = False
) -> None:
    duration_ms = (time.perf_counter() - started) * 1000
    level = (
        logging.INFO
        if duration_ms + queue_ms >= 1000 or os.getenv("ST_WORKFLOW_READ_TRACE") == "1"
        else logging.DEBUG
    )
    # Fixed stage names only: never log users, task results, paths or credentials.
    logger.log(
        level,
        "workflow_read stage=%s duration_ms=%.1f queue_ms=%.1f failed=%s pid=%s",
        stage,
        duration_ms,
        queue_ms,
        failed,
        os.getpid(),
    )


@contextmanager
def workflow_read_stage(stage: str):
    started = time.perf_counter()
    failed = True
    try:
        yield
        failed = False
    finally:
        _observe(stage, started, failed=failed)


class WorkflowReadExecutor:
    """Dedicated pool with a hard bound on running + queued work per process."""

    def __init__(self, *, workers: int = 4, queue_size: int = 8):
        self.capacity = workers + queue_size
        self._pool = ThreadPoolExecutor(
            max_workers=workers, thread_name_prefix="workflow-read"
        )
        self._lock = threading.Lock()
        self._outstanding = 0

    async def run(
        self, stage: str, function: Callable[..., T], *args: Any, **kwargs: Any
    ) -> T:
        submitted = time.perf_counter()
        with self._lock:
            if self._outstanding >= self.capacity:
                logger.warning(
                    "workflow_read stage=admission rejected=true pid=%s", os.getpid()
                )
                raise WorkflowReadBusy()
            self._outstanding += 1
            outstanding = self._outstanding
        logger.debug(
            "workflow_read stage=admission outstanding=%s capacity=%s pid=%s",
            outstanding,
            self.capacity,
            os.getpid(),
        )
        context = copy_context()

        def invoke():
            started = time.perf_counter()
            failed = True
            try:
                result = context.run(partial(function, *args, **kwargs))
                failed = False
                return result
            finally:
                _observe(
                    stage, started, queue_ms=(started - submitted) * 1000, failed=failed
                )

        def release(_future):
            with self._lock:
                self._outstanding -= 1

        try:
            future = self._pool.submit(invoke)
        except BaseException:
            release(None)
            raise
        future.add_done_callback(release)
        wrapped = asyncio.wrap_future(future)
        # Retrieve orphaned failures too, if the request has disconnected.
        wrapped.add_done_callback(
            lambda done: None if done.cancelled() else done.exception()
        )
        return await asyncio.shield(wrapped)

    def close(self) -> None:
        self._pool.shutdown(wait=True, cancel_futures=False)


_executor: WorkflowReadExecutor | None = None
_executor_lock = threading.Lock()


def workflow_read_executor() -> WorkflowReadExecutor:
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = WorkflowReadExecutor(
                workers=_positive_env("ST_WORKFLOW_READ_WORKERS", 4),
                queue_size=_positive_env("ST_WORKFLOW_READ_QUEUE_SIZE", 8),
            )
        return _executor


class WorkflowReadMaintenance:
    """Event-loop-local single flight, bounded independently of HTTP waiters."""

    def __init__(self):
        self._tasks: dict[tuple[str, str, str], asyncio.Task] = {}

    async def run(
        self, key: tuple[str, str, str], work: Callable[[], Awaitable[None]]
    ) -> None:
        task = self._tasks.get(key)
        if task is None:
            if len(self._tasks) >= workflow_read_executor().capacity:
                logger.warning(
                    "workflow_read stage=maintenance_admission rejected=true pid=%s",
                    os.getpid(),
                )
                raise WorkflowReadBusy()

            async def maintain():
                try:
                    with workflow_read_stage("maintenance"):
                        await work()
                finally:
                    self._tasks.pop(key, None)

            task = asyncio.create_task(maintain(), name="workflow-read-maintenance")
            task.add_done_callback(
                lambda done: None if done.cancelled() else done.exception()
            )
            self._tasks[key] = task
        await asyncio.shield(task)

    async def drain(self) -> None:
        await asyncio.gather(*list(self._tasks.values()), return_exceptions=True)


def workflow_read_maintenance() -> WorkflowReadMaintenance:
    # Loop ownership avoids sharing futures across TestClient loops or ASGI apps.
    loop = asyncio.get_running_loop()
    maintenance = getattr(loop, "_workflow_read_maintenance", None)
    if maintenance is None:
        maintenance = WorkflowReadMaintenance()
        loop._workflow_read_maintenance = maintenance
    return maintenance


async def shutdown_workflow_reads() -> None:
    global _executor
    await workflow_read_maintenance().drain()
    with _executor_lock:
        executor, _executor = _executor, None
    if executor is not None:
        await asyncio.to_thread(executor.close)


async def observe_workflow_event_loop() -> None:
    while True:
        started = time.perf_counter()
        await asyncio.sleep(10)
        lag_ms = max(0, (time.perf_counter() - started - 10) * 1000)
        if lag_ms >= 100 or os.getenv("ST_WORKFLOW_READ_TRACE") == "1":
            logger.info(
                "workflow_read event_loop_lag_ms=%.1f pid=%s", lag_ms, os.getpid()
            )

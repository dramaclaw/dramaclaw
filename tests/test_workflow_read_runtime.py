from __future__ import annotations

import asyncio
import threading

import pytest

from novelvideo.api.workflow_reads import (
    WorkflowReadBusy,
    WorkflowReadExecutor,
    WorkflowReadMaintenance,
)


async def _event(event: threading.Event) -> None:
    async with asyncio.timeout(2):
        while not event.is_set():
            await asyncio.sleep(0.001)


async def test_cancelled_request_keeps_slot_until_thread_finishes():
    executor = WorkflowReadExecutor(workers=1, queue_size=0)
    started, release = threading.Event(), threading.Event()

    def slow_read():
        started.set()
        assert release.wait(2)

    waiter = asyncio.create_task(executor.run("task_batch", slow_read))
    try:
        await _event(started)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        with pytest.raises(WorkflowReadBusy) as caught:
            await executor.run("task_batch", lambda: None)
        assert caught.value.status_code == 503
        assert caught.value.headers["Retry-After"] == "2"
        # The event loop remains available despite the blocked database thread.
        await asyncio.wait_for(asyncio.sleep(0), timeout=0.1)
    finally:
        release.set()
        await asyncio.to_thread(executor.close)


async def test_queue_is_bounded_and_exception_releases_capacity():
    executor = WorkflowReadExecutor(workers=1, queue_size=1)
    started, release = threading.Event(), threading.Event()

    def blocking():
        started.set()
        assert release.wait(2)

    first = asyncio.create_task(executor.run("first", blocking))
    second = None
    try:
        await _event(started)
        second = asyncio.create_task(executor.run("queued", lambda: 2))
        await asyncio.sleep(0)
        with pytest.raises(WorkflowReadBusy):
            await executor.run("excess", lambda: 3)
        release.set()
        assert await second == 2
        await first

        def broken():
            raise ValueError("unavailable")

        with pytest.raises(ValueError):
            await executor.run("broken", broken)
        assert await executor.run("recovered", lambda: 4) == 4
    finally:
        release.set()
        await asyncio.gather(
            first, *([second] if second else []), return_exceptions=True
        )
        await asyncio.to_thread(executor.close)


async def test_same_canvas_shares_maintenance_after_one_waiter_cancels():
    maintenance = WorkflowReadMaintenance()
    started, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def work():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()

    key = ("project", "/state/project", "canvas")
    first = asyncio.create_task(maintenance.run(key, work))
    await started.wait()
    second = asyncio.create_task(maintenance.run(key, work))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert calls == 1
    assert not second.done()
    release.set()
    await second
    await maintenance.run(key, work)
    assert calls == 2


async def test_different_projects_and_canvases_do_not_share_maintenance():
    maintenance = WorkflowReadMaintenance()
    seen = []

    async def work(key):
        seen.append(key)
        await asyncio.sleep(0)

    keys = [
        ("p1", "/state/p1", "a"),
        ("p1", "/state/p1", "b"),
        ("p2", "/state/p2", "a"),
    ]
    await asyncio.gather(
        *(maintenance.run(key, lambda key=key: work(key)) for key in keys)
    )
    assert sorted(seen) == sorted(keys)


async def test_shutdown_drains_maintenance_after_http_waiter_disconnects(monkeypatch):
    from novelvideo.api import workflow_reads

    executor = WorkflowReadExecutor(workers=1, queue_size=0)
    monkeypatch.setattr(workflow_reads, "_executor", executor)
    started, release = threading.Event(), threading.Event()
    completed = []

    def blocking():
        started.set()
        assert release.wait(2)
        completed.append(True)

    async def work():
        await executor.run("task_batch", blocking)

    waiter = asyncio.create_task(
        workflow_reads.workflow_read_maintenance().run(
            ("project", "/state/project", "canvas"),
            work,
        )
    )
    await _event(started)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    shutdown = asyncio.create_task(workflow_reads.shutdown_workflow_reads())
    await asyncio.sleep(0)
    assert not shutdown.done()
    release.set()
    await asyncio.wait_for(shutdown, timeout=2)
    assert completed == [True]
    assert workflow_reads._executor is None

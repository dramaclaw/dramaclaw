"""Inline liveness follows owner locks; legacy rows retain restart reconciliation."""

import asyncio
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from inline_task_owner_helper import inline_owner_process, task_context
from novelvideo import task_state
from novelvideo.ports.local.tasks import InlineTaskBackend
from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskStateManager

pytestmark = pytest.mark.m07

_ANCIENT = "2000-01-01T00:00:00.000000Z"


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_reconcile",
        project_name="demo",
        owner_type="user",
        owner_id="owner",
        owner_username="alice",
        requester_user_id="editor",
        requester_username="bob",
        requester_principals=(("user", "editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def _before_process_start_within_celery_ttl() -> str:
    """早于本进程启动、但未过 celery 的 40min TTL(CELERY_STALE_TTL)。

    用来把两条轴分开:落在这个窗口里的 celery 行,只有「进程启动时间」那条
    规则会碰它——而它不该碰。
    """
    stamp = (
        datetime.now(timezone.utc) - timedelta(minutes=39)
    ).isoformat().replace("+00:00", "Z")
    if "." not in stamp:
        stamp = stamp.replace("Z", ".000000Z")
    return stamp


def _backdate(
    manager: TaskStateManager,
    ctx: ProjectContext,
    task_id: str,
    when: str = _ANCIENT,
) -> None:
    with manager._connect_context(ctx) as conn:
        conn.execute(
            "UPDATE task_states SET updated_at = ?, created_at = ? WHERE task_id = ?",
            (when, when, task_id),
        )


def _restarted() -> TaskStateManager:
    """清扫按库记忆化在 manager 实例上;新实例 = 模拟重启后的进程。"""
    return TaskStateManager()


def test_stale_inline_running_task_is_failed_on_read(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_1", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_1")
    _backdate(manager, ctx, created.task_id)
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "failed"
    assert "重启" in (listed[0].error or "")

    fetched = manager.get_task_for_project(ctx, "ingest_fast", 0, scope="job_1")
    assert fetched is not None
    assert fetched.status == "failed"


def test_stale_celery_running_task_is_untouched(tmp_path: Path) -> None:
    """celery 行早于进程启动也不该被这条规则碰(它有自己的 TTL 轴)。"""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_celery", metadata={"backend": "celery"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_celery")
    _backdate(manager, ctx, created.task_id, when=_before_process_start_within_celery_ttl())
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "running"


def test_fresh_inline_running_task_is_untouched(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_fresh", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_fresh")

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "running"


def test_stale_inline_task_unblocks_reservation(tmp_path: Path) -> None:
    """准入闸(reserve)也必须看不到僵尸,否则重启后重试提交仍被去重守卫拒绝。"""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_r", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_r")
    _backdate(manager, ctx, created.task_id)
    manager = _restarted()

    state, reserved = manager.reserve_task_for_project(
        ctx, "ingest_fast", 0, scope="job_r", metadata={"backend": "inline"}
    )

    assert reserved is True
    assert state.task_id != created.task_id


def test_sweep_runs_once_per_db_by_design(tmp_path: Path) -> None:
    """清扫按库记忆化:进程启动后新出现的'过期'行不再被扫(启动前遗留才是僵尸)。"""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    first = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_a", metadata={"backend": "inline"}
    )
    _backdate(manager, ctx, first.task_id)
    manager = _restarted()
    assert manager.list_tasks_for_project(ctx)[0].status == "failed"

    second = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_b", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_b")
    _backdate(manager, ctx, second.task_id)

    statuses = {t.scope: t.status for t in manager.list_tasks_for_project(ctx)}
    assert statuses["job_b"] == "running"


def test_stale_inline_task_no_longer_blocks_active_count(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_2", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_2")
    _backdate(manager, ctx, created.task_id)
    manager = _restarted()

    assert manager.count_active_tasks_for_project(ctx) == 0


@pytest.mark.parametrize("status", ["submitting", "queued", "running"])
def test_inline_owner_liveness_across_processes(tmp_path, status):
    ctx = task_context(tmp_path)
    manager = TaskStateManager()
    with inline_owner_process(tmp_path, status) as owner:
        # A new manager performs its automatic connection sweep while the sibling is live.
        sibling = manager.get_task_for_project(ctx, "freezone_workflow_drive", 0, scope="sibling")
        assert sibling.status == status
        assert manager.sweep_stale_tasks_for_project(ctx) == 0
        owner.kill()
        owner.wait(timeout=10)
        # The same manager must detect the death without another process restart.
        assert manager.sweep_stale_tasks_for_project(ctx) == 1
        sibling = manager.get_task_for_project(ctx, "freezone_workflow_drive", 0, scope="sibling")
        assert sibling.status == "failed"
        assert sibling.error == "服务重启,任务已中断,请重新发起"


def test_missing_inline_owner_lock_is_failed_even_with_fresh_timestamp(tmp_path):
    ctx = task_context(tmp_path)
    manager = TaskStateManager()
    manager.reserve_task_for_project(
        ctx, "freezone_workflow_drive", 0,
        metadata={"backend": "inline", "inline_owner": "missing"},
    )
    assert manager.sweep_stale_tasks_for_project(ctx) == 1
    state = manager.get_task_for_project(ctx, "freezone_workflow_drive", 0)
    assert state.status == "failed"
    assert state.error == "服务重启,任务已中断,请重新发起"


@pytest.mark.asyncio
async def test_inline_reservation_contains_live_process_owner(tmp_path, monkeypatch):
    ctx = task_context(tmp_path)
    manager = TaskStateManager()
    monkeypatch.setattr("novelvideo.ports.local.tasks.get_task_manager", lambda: manager)
    signing = asyncio.Event()

    class PendingProducer:
        async def sign_top_level(self, **kwargs):
            signing.set()
            await asyncio.Event().wait()

    backend = InlineTaskBackend(producer=PendingProducer())
    pending = asyncio.create_task(backend.enqueue_project_task(
        ctx, task_type="freezone_workflow_drive", product_surface="freezone_assistant",
    ))
    try:
        await asyncio.wait_for(signing.wait(), timeout=5)
        state = manager.get_task_for_project(ctx, "freezone_workflow_drive", 0)
        assert state.status == "submitting"
        assert state.metadata.get("backend") == "inline"
        token = state.metadata["inline_owner"]
        assert isinstance(token, str) and token
        lock_path = ctx.state_dir / "inline-owners" / f"{token}.lock"
        probe = """
import sys
import portalocker
with open(sys.argv[1], 'r+') as lock:
    try:
        portalocker.lock(lock, portalocker.LOCK_EX | portalocker.LOCK_NB)
    except portalocker.LockException:
        print('locked')
    else:
        portalocker.unlock(lock)
        print('unlocked')
"""
        result = subprocess.run(
            [sys.executable, "-c", probe, str(lock_path)], text=True, capture_output=True,
            timeout=10, env={**os.environ, "PYTHONPATH": "src:."}, check=True,
        )
        assert result.stdout == "locked\n"
        _backdate(manager, ctx, state.task_id)
        assert TaskStateManager().sweep_stale_tasks_for_project(ctx) == 0
        own = manager.get_task_for_project(ctx, "freezone_workflow_drive", 0)
        assert own.status == "submitting"
        with inline_owner_process(tmp_path) as sibling:
            assert manager.sweep_stale_tasks_for_project(ctx) == 0
            sibling.kill()
            sibling.wait(timeout=10)
            assert manager.sweep_stale_tasks_for_project(ctx) == 1
            own = manager.get_task_for_project(ctx, "freezone_workflow_drive", 0)
            assert own.status == "submitting"
    finally:
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending


def test_legacy_inline_owner_uses_process_start_timestamp(tmp_path, monkeypatch):
    ctx = task_context(tmp_path)
    manager = TaskStateManager()
    monkeypatch.setattr(task_state, "_PROCESS_STARTED_AT", "2026-01-01T00:00:00.000000Z")
    monkeypatch.setattr(task_state, "utc_now_iso", lambda: "2025-12-31T23:59:59.000000Z")
    manager.reserve_task_for_project(ctx, "legacy", 0, metadata={"backend": "inline"})
    monkeypatch.setattr(task_state, "utc_now_iso", lambda: "2026-01-01T00:00:01.000000Z")
    manager.reserve_task_for_project(ctx, "fresh", 0, metadata={"backend": "inline"})
    assert manager.sweep_stale_tasks_for_project(ctx) == 1
    assert manager.get_task_for_project(ctx, "legacy", 0).status == "failed"
    assert manager.get_task_for_project(ctx, "fresh", 0).status == "submitting"

"""服务重启后 inline 任务的僵尸回收。

inline 后端的 worker 随 API 进程消亡:进程启动时间之前仍标记
submitting/queued/running 的 inline 任务必然已中断,读取路径应将其
落为 failed,避免僵尸任务永久挡住新任务(去重守卫/并发限额)。
Celery/EE worker 独立于 API 进程,同规则绝不适用。
"""

from pathlib import Path

import pytest

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


def _backdate(manager: TaskStateManager, ctx: ProjectContext, task_id: str) -> None:
    with manager._connect_context(ctx) as conn:
        conn.execute(
            "UPDATE task_states SET updated_at = ?, created_at = ? WHERE task_id = ?",
            (_ANCIENT, _ANCIENT, task_id),
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
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_celery", metadata={"backend": "celery"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_celery")
    _backdate(manager, ctx, created.task_id)
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

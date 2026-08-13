"""celery/EE 僵尸回收:按 40 分钟 TTL,不按进程启动时间。

celery worker 独立于 API 进程,被杀后任务永远停在 running,永久占住该
task_key 的去重守卫与并发额度,既无回收也无告警。inline 那一轴(早于本进程
启动即必然中断)对它不成立,所以另立一条 TTL 轴:
40min = task_time_limit 35min(EE celery_app.py:53)+ 5min 余量。

inline 轴的行为在 test_task_state_restart_reconcile.py,本文件只钉 TTL 轴,
并逐条钉住它**不许**外溢到 inline 行与终态行。
"""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from novelvideo import task_state as task_state_module
from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskStateManager

pytestmark = pytest.mark.m07

_ANCIENT = "2000-01-01T00:00:00.000000Z"


def _minutes_ago(minutes: int) -> str:
    """与 utc_now_iso() 同形(task_state.py:141-142),小数位不省略。"""
    stamp = (
        datetime.now(timezone.utc) - timedelta(minutes=minutes)
    ).isoformat().replace("+00:00", "Z")
    if "." not in stamp:
        stamp = stamp.replace("Z", ".000000Z")
    return stamp


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_celery_ttl",
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


def _backdate(
    manager: TaskStateManager,
    ctx: ProjectContext,
    task_id: str,
    minutes: int,
) -> None:
    stamp = _minutes_ago(minutes)
    with manager._connect_context(ctx) as conn:
        conn.execute(
            "UPDATE task_states SET updated_at = ?, created_at = ? WHERE task_id = ?",
            (stamp, stamp, task_id),
        )


def _restarted() -> TaskStateManager:
    """清扫按库记忆化在 manager 实例上;新实例 = 模拟新进程首次连接。"""
    return TaskStateManager()


def _running_celery_task(
    manager: TaskStateManager,
    ctx: ProjectContext,
    scope: str,
) -> str:
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope=scope, metadata={"backend": "celery"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope=scope)
    return created.task_id


def test_celery_running_task_past_ttl_is_failed(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    task_id = _running_celery_task(manager, ctx, "job_stale")
    _backdate(manager, ctx, task_id, minutes=41)
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "failed"
    assert listed[0].error


def test_celery_running_task_within_ttl_is_untouched(tmp_path: Path) -> None:
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    task_id = _running_celery_task(manager, ctx, "job_fresh")
    _backdate(manager, ctx, task_id, minutes=39)
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "running"


def test_celery_zombie_no_longer_blocks_reservation(tmp_path: Path) -> None:
    """这就是现网症状:僵尸行占住去重守卫,该业务任务再也投不出去。"""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    task_id = _running_celery_task(manager, ctx, "job_reserve")
    _backdate(manager, ctx, task_id, minutes=41)
    manager = _restarted()

    state, reserved = manager.reserve_task_for_project(
        ctx, "ingest_fast", 0, scope="job_reserve", metadata={"backend": "celery"}
    )

    assert reserved is True
    assert state.task_id != task_id


def test_ttl_axis_does_not_reach_inline_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TTL 轴只认 celery。inline 仍只由进程启动时间那一轴判(不变量 10)。

    倒填进程启动时间,使 41 分钟前的 inline 行**晚于**进程启动 —— inline 轴
    不该动它,若 TTL 轴漏写 backend 过滤就会把它扫掉。
    """
    monkeypatch.setattr(task_state_module, "_PROCESS_STARTED_AT", _ANCIENT)
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_inline", metadata={"backend": "inline"}
    )
    manager.update_progress_for_project(ctx, "ingest_fast", 0, progress=0.1, scope="job_inline")
    _backdate(manager, ctx, created.task_id, minutes=41)
    manager = _restarted()

    listed = manager.list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].status == "running"


def test_terminal_celery_row_past_ttl_is_untouched(tmp_path: Path) -> None:
    """回收只针对在途状态;已完成的行不许被改写成 failed。"""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="job_done", metadata={"backend": "celery"}
    )
    manager.complete_task_for_project(
        ctx, "ingest_fast", 0, result={"ok": True}, scope="job_done"
    )
    _backdate(manager, ctx, created.task_id, minutes=41)
    manager = _restarted()

    fetched = manager.get_task_for_project(ctx, "ingest_fast", 0, scope="job_done")

    assert fetched is not None
    assert fetched.status == "completed"

"""inline 任务按持有文件锁的进程 owner 回收，存活任务不受时间戳影响。"""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import select
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from novelvideo import config, task_state as task_state_module
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


@pytest.fixture
def owner_process(tmp_path, monkeypatch):
    runtime = tmp_path / "owners_runtime"
    monkeypatch.setattr(config, "RUNTIME_DIR", str(runtime))
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import json, time; from novelvideo.task_owner import current_owner; "
            "print(json.dumps(current_owner()), flush=True); time.sleep(60)",
        ],
        env={**os.environ, "NOVELVIDEO_RUNTIME_DIR": str(runtime)},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert select.select([child.stdout], [], [], 10)[0], "owner 子进程未就绪"
        line = child.stdout.readline()
        if not line:
            raise AssertionError(child.stderr.read())
        yield child, json.loads(line), runtime
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)
        child.stdout.close()
        child.stderr.close()


def _kill(child):
    os.kill(child.pid, signal.SIGKILL)
    assert child.wait(timeout=10) == -signal.SIGKILL


def _inline_task(manager, ctx, owner=None, status="running", error=""):
    metadata = {"backend": "inline"}
    if owner is not None:
        metadata["owner"] = owner
    created = manager.create_task_for_project(ctx, "ingest_fast", 0, metadata=metadata)
    with manager._connect_path(ctx.state_dir / "data.db", skip_auto_sweep=True) as conn:
        conn.execute(
            "UPDATE task_states SET status = ?, error = ? WHERE task_id = ?",
            (status, error, created.task_id),
        )
    return created


def test_real_owner_lock_released_on_sigkill(owner_process):
    from novelvideo.task_owner import owner_alive

    child, owner, runtime = owner_process
    lock_file = runtime / "task_owners" / f"{owner['token']}.lock"
    assert owner["host"] == socket.gethostname()
    assert owner["pid"] == child.pid
    assert len(owner["token"]) == 32
    assert lock_file.parent.stat().st_mode & 0o777 == 0o700
    assert owner_alive(owner) is True

    _kill(child)

    assert owner_alive(owner) is False
    assert lock_file.exists() is False
    assert owner_alive(owner) is False


@pytest.mark.parametrize("status", ["submitting", "queued", "running"])
def test_dead_owner_fails_even_fresh_inline_row(tmp_path, owner_process, status):
    child, owner, _ = owner_process
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = _inline_task(manager, ctx, owner, status=status)
    _kill(child)

    listed = TaskStateManager().list_tasks_for_project(ctx)

    assert len(listed) == 1
    assert listed[0].task_id == created.task_id
    assert listed[0].status == "failed"
    assert listed[0].error == "执行该任务的服务进程已退出,任务已中断,请重新发起"
    assert listed[0].completed_at
    assert listed[0].expires_at


def test_live_owner_keeps_ancient_inline_row_running(tmp_path, owner_process):
    _, owner, _ = owner_process
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = _inline_task(manager, ctx, owner)
    with manager._connect_path(ctx.state_dir / "data.db", skip_auto_sweep=True) as conn:
        conn.execute(
            "UPDATE task_states SET updated_at = ? WHERE task_id = ?",
            (_ANCIENT, created.task_id),
        )

    listed = TaskStateManager().list_tasks_for_project(ctx)

    assert listed[0].status == "running"
    assert listed[0].updated_at == "2000-01-01T00:00:00.000000Z"
    assert listed[0].error == ""


@pytest.mark.parametrize("owner", [None, {}, {"host": "remote", "pid": 1, "token": "../bad"}])
def test_missing_or_malformed_owner_is_failed(tmp_path, owner):
    ctx = _ctx(tmp_path)
    _inline_task(TaskStateManager(), ctx, owner)

    listed = TaskStateManager().list_tasks_for_project(ctx)

    assert listed[0].status == "failed"
    assert listed[0].error == "执行该任务的服务进程已退出,任务已中断,请重新发起"


def test_foreign_host_owner_is_untouched(tmp_path):
    from novelvideo.task_owner import owner_alive

    owner = {"host": socket.gethostname() + "-other", "pid": 123, "token": "a" * 32}
    ctx = _ctx(tmp_path)
    _inline_task(TaskStateManager(), ctx, owner)

    assert owner_alive(owner) is None
    assert TaskStateManager().list_tasks_for_project(ctx)[0].status == "running"


def test_dead_owner_unblocks_reservation_and_active_count(tmp_path):
    ctx = _ctx(tmp_path)
    created = _inline_task(TaskStateManager(), ctx)
    manager = TaskStateManager()

    assert manager.count_active_tasks_for_project(ctx) == 0
    state, reserved = manager.reserve_task_for_project(ctx, "ingest_fast", 0)

    assert reserved is True
    assert state.task_id != created.task_id


def test_inline_sweep_preserves_existing_error(tmp_path):
    ctx = _ctx(tmp_path)
    _inline_task(TaskStateManager(), ctx, error="先前错误")

    listed = TaskStateManager().list_tasks_for_project(ctx)

    assert listed[0].status == "failed"
    assert listed[0].error == "先前错误"


def test_inline_owner_axis_does_not_reach_celery(tmp_path):
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    created = manager.create_task_for_project(
        ctx, "ingest_fast", 0, metadata={"backend": "celery"}
    )
    stamp = (datetime.now(timezone.utc) - timedelta(minutes=39)).isoformat()
    with manager._connect_path(ctx.state_dir / "data.db", skip_auto_sweep=True) as conn:
        conn.execute(
            "UPDATE task_states SET status = 'running', updated_at = ? WHERE task_id = ?",
            (stamp.replace("+00:00", "Z"), created.task_id),
        )

    assert TaskStateManager().list_tasks_for_project(ctx)[0].status == "running"


def test_throttle_rechecks_and_notices_owner_death(tmp_path, monkeypatch, owner_process):
    child, owner, _ = owner_process
    ctx = _ctx(tmp_path)
    _inline_task(TaskStateManager(), ctx, owner)
    clock = [10.0]
    monkeypatch.setattr(
        task_state_module, "time", SimpleNamespace(monotonic=lambda: clock[0]), raising=False
    )
    manager = TaskStateManager()
    original = manager._sweep_stale_tasks_on_connection
    calls = []

    def tracked(conn):
        calls.append(clock[0])
        return original(conn)

    monkeypatch.setattr(manager, "_sweep_stale_tasks_on_connection", tracked)
    assert manager.list_tasks_for_project(ctx)[0].status == "running"
    _kill(child)
    clock[0] = 11.9
    assert manager.list_tasks_for_project(ctx)[0].status == "running"
    assert calls == [10.0]
    clock[0] = 12.0

    assert manager.list_tasks_for_project(ctx)[0].status == "failed"
    assert calls == [10.0, 12.0]
    assert TaskStateManager.SWEEP_INTERVAL_SECONDS == 2.0


def test_idle_auto_sweep_is_read_only_under_write_lock(tmp_path, monkeypatch, owner_process):
    _, owner, _ = owner_process
    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    _inline_task(manager, ctx, owner)
    manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="finished", metadata={"backend": "inline"}
    )
    manager.complete_task_for_project(ctx, "ingest_fast", 0, scope="finished")
    manager.create_task_for_project(
        ctx, "ingest_fast", 0, scope="live_celery", metadata={"backend": "celery"}
    )
    db_path = ctx.state_dir / "data.db"
    with manager._connect_path(db_path, skip_auto_sweep=True) as conn:
        before = conn.execute("SELECT * FROM task_states ORDER BY task_key").fetchall()

    configure = task_state_module.configure_sqlite_connection

    def short_timeout(conn, **kwargs):
        configure(conn, **kwargs)
        conn.execute("PRAGMA busy_timeout = 50")

    monkeypatch.setattr(task_state_module, "configure_sqlite_connection", short_timeout)
    clock = [10.0]
    monkeypatch.setattr(task_state_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    manager = TaskStateManager()
    writer = sqlite3.connect(db_path)
    try:
        writer.execute("BEGIN IMMEDIATE")
        for stamp in (10.0, 12.0):
            clock[0] = stamp
            started = time.monotonic()
            with manager._connect_context(ctx) as conn:
                after = conn.execute("SELECT * FROM task_states ORDER BY task_key").fetchall()
                assert not conn.in_transaction
            assert time.monotonic() - started < 1.0
            assert after == before
            assert manager._last_sweep_at[str(db_path.resolve())] == stamp
    finally:
        writer.rollback()
        writer.close()


def test_failed_auto_sweep_does_not_advance_clock(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    _inline_task(TaskStateManager(), ctx)
    manager = TaskStateManager()
    original = manager._sweep_stale_tasks_on_connection
    calls = []

    def fail_once(conn):
        calls.append(1)
        return None if len(calls) == 1 else original(conn)

    monkeypatch.setattr(manager, "_sweep_stale_tasks_on_connection", fail_once)
    assert manager.list_tasks_for_project(ctx)[0].status == "running"
    assert manager.list_tasks_for_project(ctx)[0].status == "failed"
    assert calls == [1, 1]


@pytest.mark.parametrize("replacement", [False, True])
def test_inline_sweep_compare_and_set(tmp_path, monkeypatch, replacement):
    from novelvideo.task_owner import current_owner

    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    _inline_task(manager, ctx, current_owner())

    def finish_before_update(owner):
        with manager._connect_path(ctx.state_dir / "data.db", skip_auto_sweep=True) as conn:
            if replacement:
                conn.execute("UPDATE task_states SET task_id = 'replacement'")
            else:
                conn.execute("UPDATE task_states SET status = 'completed', error = 'done'")
        return False

    monkeypatch.setattr(task_state_module, "owner_alive", finish_before_update)

    assert manager.sweep_stale_tasks_for_project(ctx) == 0
    listed = manager.list_tasks_for_project(ctx)
    if replacement:
        assert listed[0].task_id == "replacement"
        assert listed[0].status == "running"
    else:
        assert listed[0].status == "completed"
        assert listed[0].error == "done"

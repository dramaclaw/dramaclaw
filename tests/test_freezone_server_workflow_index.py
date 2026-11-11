"""Workflow recovery fails a dead process's tasks before it enqueues the next drive."""

from datetime import datetime, timezone

import pytest

from inline_task_owner_helper import task_context
from novelvideo import config, project_context, task_state
from novelvideo.freezone import server_workflow_index as index
from novelvideo.freezone import workflow_runs as store


@pytest.mark.asyncio
@pytest.mark.parametrize("leased", [False, True])
async def test_recovery_sweeps_project_before_enqueueing_next_drive(tmp_path, monkeypatch, leased):
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "index")
    ctx = task_context(tmp_path)
    manager = task_state.TaskStateManager()
    monkeypatch.setattr(task_state, "_task_manager", manager)
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    scope = dict(project_dir=ctx.state_dir, canvas_id="default")
    run = store.create_workflow_run(
        **scope, project_id=ctx.project_id, owner_kind="server",
        actions=[{"node_id": "one", "action": "save"}], now=now,
    )
    scope["run_id"] = run["run_id"]
    if leased:
        store.acquire_server_workflow_run(**scope, runner_id="drive", now=now)
    index.register_server_workflow_run(
        project_id=ctx.project_id, state_dir=ctx.state_dir, canvas_id="default",
        run_id=run["run_id"], requester={"user_id": "requester", "username": "requester"},
    )
    manager.reserve_task_for_project(
        ctx, "freezone_workflow_drive", 0, scope="dead",
        metadata={"backend": "inline", "inline_owner": "missing"},
    )

    resolved = []

    async def resolve(**kwargs):
        resolved.append(kwargs["project_id"])
        return ctx

    monkeypatch.setattr(project_context, "resolve_project_context", resolve)
    enqueued = []

    async def enqueue(context, **kwargs):
        assert context == ctx
        enqueued.append(manager.get_task_for_project(
            ctx, "freezone_workflow_drive", 0, scope="dead",
        ).status)

    result = await index.sweep_server_workflow_runs(now=now, enqueue=enqueue)
    status = manager.get_task_for_project(ctx, "freezone_workflow_drive", 0, scope="dead").status
    if leased:
        # A live drive holds the lease: nothing is decided, resolved or swept.
        assert result == [{"run_id": run["run_id"], "action": "skipped"}]
        assert (resolved, enqueued, status) == ([], [], "submitting")
    else:
        # The dead process's task is failed before the next drive is enqueued.
        assert result == [{"run_id": run["run_id"], "action": "enqueued"}]
        assert (resolved, enqueued, status) == ([ctx.project_id], ["failed"], "failed")


@pytest.mark.asyncio
async def test_recovery_still_enqueues_when_task_sweep_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "index")
    ctx = task_context(tmp_path)
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    run = store.create_workflow_run(
        project_dir=ctx.state_dir, canvas_id="default", project_id=ctx.project_id,
        owner_kind="server", actions=[{"node_id": "one", "action": "save"}], now=now,
    )
    index.register_server_workflow_run(
        project_id=ctx.project_id, state_dir=ctx.state_dir, canvas_id="default",
        run_id=run["run_id"], requester={"user_id": "requester", "username": "requester"},
    )

    class BrokenSweep:
        def sweep_stale_tasks_for_project(self, context):
            raise RuntimeError("sweep unavailable")

    async def resolve(**kwargs):
        return ctx

    monkeypatch.setattr(task_state, "_task_manager", BrokenSweep())
    monkeypatch.setattr(project_context, "resolve_project_context", resolve)
    enqueued = []

    async def enqueue(context, **kwargs):
        enqueued.append(kwargs["scope"])

    result = await index.sweep_server_workflow_runs(now=now, enqueue=enqueue)
    assert result == [{"run_id": run["run_id"], "action": "enqueued"}]
    assert enqueued == [f"{run['run_id']}:d1"]

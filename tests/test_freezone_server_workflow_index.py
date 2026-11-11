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


@pytest.mark.asyncio
@pytest.mark.parametrize("delivered,elapsed,broken,expected", [
    (False, 180, False, "awaiting_delivery"), (True, 180, False, "unregistered"),
    (False, 3601, False, "unregistered"), (False, 180, True, "awaiting_delivery"),
])
async def test_terminal_recovery_keeps_pending_delivery(
    tmp_path, monkeypatch, caplog, delivered, elapsed, broken, expected,
):
    from datetime import timedelta
    from novelvideo.api import freezone_server_workflow_host as host
    from novelvideo.api.routes import freezone as routes
    from novelvideo.freezone import agent_product_operations as products

    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "index")
    ctx = task_context(tmp_path)
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    run = store.create_workflow_run(
        project_dir=tmp_path, canvas_id="default", project_id=ctx.project_id,
        owner_kind="server", actions=[{"node_id": "one", "action": "generate_image"}], now=now,
    )
    scope = dict(project_dir=tmp_path, canvas_id="default", run_id=run["run_id"])
    operation = products.create_agent_product_operation(
        project_dir=tmp_path, project_id=ctx.project_id, product_kind="recipe_result",
        idempotency_key="delivery", generation_session_id=run["run_id"], canvas_id="default",
    )
    operation_id = operation["operation_id"]
    store.bind_workflow_action_product_operation(
        **scope, node_id="one", action="generate_image", operation_id=operation_id,
    )
    products.bind_agent_product_task(
        project_dir=tmp_path, operation_id=operation_id, task_id="product-task",
        root_task_id="product-task",
    )
    store.update_workflow_run(
        **scope, status="completed", owner_kind="server", now=now, action_updates=[{
            "node_id": "one", "action": "generate_image", "status": "completed",
            "result": {"output_url": "/static/image.png"},
        }],
    )
    index.register_server_workflow_run(
        project_id=ctx.project_id, state_dir=tmp_path, canvas_id="default", run_id=run["run_id"],
        requester={"user_id": "requester", "username": "requester"},
    )
    maintained, cleared = [], []

    async def resolve(**kwargs):
        return ctx

    async def maintain(context, canvas_id):
        maintained.append((context, canvas_id))
        if broken:
            raise RuntimeError("delivery unavailable")
        if delivered:
            products.bind_agent_product_model_execution(
                project_dir=tmp_path, operation_id=operation_id, model_call_id="compile",
                executed_at=1.0, source="server_recipe_compiler", compile_mode="model",
            )
            products.finish_agent_product_operation(
                project_dir=tmp_path, operation_id=operation_id, outcome="delivered",
                expected_task_id="product-task",
                result_ref={"kind": "recipe_result", "id": "image"},
            )

    async def clear(**kwargs):
        cleared.append(kwargs)

    monkeypatch.setattr(project_context, "resolve_project_context", resolve)
    monkeypatch.setattr(routes, "maintain_server_workflow_canvas", maintain, raising=False)
    monkeypatch.setattr(host, "clear_server_generation_markers", clear)
    assert await index.sweep_server_workflow_runs(now=now + timedelta(seconds=elapsed)) == [
        {"run_id": run["run_id"], "action": expected},
    ]
    assert maintained == [(ctx, "default")]
    assert cleared == [{"ctx": ctx, "canvas_id": "default", "run_id": run["run_id"]}]
    assert [entry["run_id"] for entry in index.list_server_workflow_runs()] == (
        [run["run_id"]] if expected == "awaiting_delivery" else []
    )
    if elapsed > 3600:
        assert f"run_id={run['run_id']}" in caplog.text
        assert "pending=1" in caplog.text

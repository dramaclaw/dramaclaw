import asyncio
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.project_context import ProjectContext
from novelvideo.ports import registry
from novelvideo.ports.local.project import AllowAllProjectAccess
from novelvideo.ports.local.tasks import InlineTaskBackend, InMemoryCancellationStore
from novelvideo.task_backend.cancel import TaskCancelled, is_cancel_requested
from novelvideo.task_backend.limits import project_lane_effective_active_limit
from novelvideo.task_backend.queues import QUEUE_KINDS
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import TaskStateManager, get_task_manager

pytestmark = pytest.mark.m07


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_m07",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="alice",
        requester_user_id="editor_1",
        requester_username="bob",
        requester_principals=(("user", "editor_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "alice" / "demo",
        state_dir=tmp_path / "state" / "alice" / "demo",
        runtime_dir=tmp_path / "runtime" / "alice" / "demo",
        is_home_node=True,
    )


async def _first_sse_event(response):
    gen = response.body_iterator
    try:
        return await asyncio.wait_for(gen.__anext__(), timeout=3.0)
    finally:
        aclose = getattr(gen, "aclose", None)
        if aclose is not None:
            await aclose()


async def _single_sse_event_and_closed(response):
    gen = response.body_iterator
    event = await asyncio.wait_for(gen.__anext__(), timeout=3.0)
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(gen.__anext__(), timeout=3.0)
    return event


async def _install_project_context(monkeypatch, ctx: ProjectContext) -> None:
    from novelvideo.api.routes import tasks

    async def fake_resolve_project_context(**kwargs):
        assert kwargs["project_id"] == ctx.project_id
        return ctx

    monkeypatch.setattr(tasks, "resolve_project_context", fake_resolve_project_context)


def test_tasks_routes_are_covered_by_openapi_contract():
    from novelvideo.api.routes import pipeline
    from novelvideo.api.routes.tasks import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.include_router(pipeline.router, prefix="/api/v1")

    paths = app.openapi()["paths"]
    expected = {
        ("get", "/api/v1/projects/{project}/tasks"),
        ("get", "/api/v1/projects/{project}/tasks/limits"),
        ("delete", "/api/v1/projects/{project}/tasks/completed"),
        ("get", "/api/v1/projects/{project}/tasks/{task_type}/{episode}"),
        ("get", "/api/v1/projects/{project}/tasks/stream"),
        ("get", "/api/v1/projects/{project}/tasks/{task_type}/{episode}/stream"),
        ("delete", "/api/v1/projects/{project}/tasks/{task_type}/{episode}"),
        ("get", "/api/v1/projects/{project}/pipeline/status"),
    }

    for method, path in expected:
        operation = paths[path][method]
        assert "responses" in operation
        assert any(status in operation["responses"] for status in ("200", "204"))


@pytest.fixture(autouse=True)
def _task_ports(monkeypatch):
    monkeypatch.setattr(registry, "_PORTS", dict(registry._PORTS))
    monkeypatch.setattr(registry, "_BOOTSTRAPPED", registry._BOOTSTRAPPED)
    registry.register_port("cancellation_store", InMemoryCancellationStore())


@pytest.mark.asyncio
async def test_ce_generation_submit_returns_inline_backend(monkeypatch, tmp_path):
    from novelvideo.api.routes import episodes
    from novelvideo.api.schemas import EpisodePlanRequest

    ctx = _ctx(tmp_path)
    Path(ctx.output_dir).mkdir(parents=True, exist_ok=True)
    (Path(ctx.output_dir) / "novel.txt").write_text("剧本文本", encoding="utf-8")

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username=ctx.owner_username,
            project_name=ctx.project_name,
            project_dir=Path(ctx.output_dir),
            output_dir=str(ctx.output_dir),
            state_dir=str(ctx.state_dir),
            runtime_dir=str(ctx.runtime_dir),
        )

    class FakeBackend:
        async def enqueue_project_task(self, ctx_arg, **kwargs):
            assert ctx_arg is ctx
            return SimpleNamespace(
                task_state=SimpleNamespace(task_id="inline-task-1"),
                backend="inline",
                queue=None,
            )

    monkeypatch.setattr(episodes, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(episodes, "get_task_backend", lambda: FakeBackend())

    response = await episodes.plan_episodes(
        project="proj_m07",
        body=EpisodePlanRequest(target_episodes=2),
        user={"username": "bob"},
    )

    assert response["ok"] is True
    assert response["backend"] == "inline"
    assert response["task_id"] == "inline-task-1"


@pytest.mark.asyncio
async def test_task_list_and_project_stream_task_updated_share_serialized_fields(
    monkeypatch,
    tmp_path,
):
    from novelvideo.api.routes import tasks

    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    await _install_project_context(monkeypatch, ctx)
    monkeypatch.setattr(tasks, "get_task_manager", lambda: manager)
    task = manager.create_task_for_project(
        ctx,
        "single_video",
        1,
        beat_num=2,
        metadata={"display_name": "Beat 2", "error_code": "E_M07"},
        status="running",
        queue_kind="video",
    )
    manager.update_progress_for_project(
        ctx,
        task.task_type,
        task.episode,
        beat_num=task.beat_num,
        progress=0.42,
        current_task="rendering",
        logs=["queued", "rendering"],
        expected_task_id=task.task_id,
    )

    list_response = await tasks.list_project_tasks(ctx.project_id, user={"username": "bob"})
    list_payload = list_response["data"][0]
    stream_response = await tasks.stream_project_tasks(
        project=ctx.project_id,
        request=None,  # type: ignore[arg-type]
        interval=0.5,
        heartbeat_sec=1.0,
        snapshot=True,
        user={"username": "bob"},
    )
    stream_event = await _first_sse_event(stream_response)
    stream_payload = json.loads(stream_event["data"])

    expected_fields = {
        "task_key",
        "task_id",
        "task_type",
        "project",
        "project_id",
        "episode",
        "beat_num",
        "scope",
        "status",
        "progress",
        "current_task",
        "result",
        "metadata",
        "error",
        "logs",
        "task_type_label",
        "display_name",
        "created_at",
        "updated_at",
        "completed_at",
        "expires_at",
    }
    assert stream_event["event"] == "task_updated"
    assert set(list_payload) == set(stream_payload)
    assert expected_fields <= set(list_payload)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "progress", "current_task", "expected_event"),
    [
        ("running", 0.25, "working", "running"),
        ("completed", 1.0, "完成", "completed"),
        ("failed", 0.7, "failed", "failed"),
        ("cancelled", 0.2, "cancelled", "cancelled"),
    ],
)
async def test_single_task_stream_uses_effective_status_and_closes_on_terminal(
    monkeypatch,
    tmp_path,
    status,
    progress,
    current_task,
    expected_event,
):
    from novelvideo.api.routes import tasks

    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    await _install_project_context(monkeypatch, ctx)
    monkeypatch.setattr(tasks, "get_task_manager", lambda: manager)
    task = manager.create_task_for_project(
        ctx,
        f"m07_{status}",
        1,
        status="queued",
        metadata={"error_code": "E_TERMINAL"},
    )
    if status in {"completed", "failed", "cancelled"}:
        manager.update_progress_for_project(
            ctx,
            task.task_type,
            task.episode,
            progress=progress,
            current_task=current_task,
            logs=[status],
            status=status,
            metadata={"error_code": "E_TERMINAL"},
            expected_task_id=task.task_id,
        )
        stored = manager.get_task_for_project(ctx, task.task_type, task.episode)
        assert stored is not None
        stored.result = {
            "ok": status == "completed",
            "task_metadata": {"error_code": "E_TERMINAL"},
        }
        stored.metadata = {"error_code": "E_TERMINAL"}
        stored.error = "boom" if status == "failed" else None
        manager._save_for_context(ctx, stored)
    else:
        manager.update_progress_for_project(
            ctx,
            task.task_type,
            task.episode,
            progress=progress,
            current_task=current_task,
            logs=["working"],
            expected_task_id=task.task_id,
        )

    response = await tasks.stream_project_task(
        project=ctx.project_id,
        task_type=task.task_type,
        episode=task.episode,
        request=None,  # type: ignore[arg-type]
        beat_num=None,
        scope=None,
        interval=0.5,
        user={"username": "bob"},
    )
    if expected_event in {"completed", "failed", "cancelled"}:
        event = await _single_sse_event_and_closed(response)
    else:
        event = await _first_sse_event(response)
    payload = json.loads(event["data"])

    assert event["event"] == expected_event
    assert {"status", "progress", "current_task", "logs"} <= set(payload)
    if expected_event in {"completed", "failed", "cancelled"}:
        assert {"result", "error", "error_code"} <= set(payload)


@pytest.mark.asyncio
async def test_single_task_stream_missing_task_returns_structured_error(
    monkeypatch,
    tmp_path,
):
    from novelvideo.api.routes import tasks

    ctx = _ctx(tmp_path)
    await _install_project_context(monkeypatch, ctx)
    monkeypatch.setattr(tasks, "get_task_manager", lambda: TaskStateManager())
    monkeypatch.setattr(tasks, "_TASK_NOT_FOUND_GRACE_S", 0.0)

    response = await tasks.stream_project_task(
        project=ctx.project_id,
        task_type="missing",
        episode=1,
        request=None,  # type: ignore[arg-type]
        beat_num=None,
        scope=None,
        interval=0.5,
        user={"username": "bob"},
    )
    event = await _single_sse_event_and_closed(response)

    assert event["event"] == "error"
    assert json.loads(event["data"]) == {"error": "Task not found"}


@pytest.mark.asyncio
async def test_clear_completed_deletes_only_effective_completed_tasks(monkeypatch, tmp_path):
    from novelvideo.api.routes import tasks

    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    await _install_project_context(monkeypatch, ctx)
    monkeypatch.setattr(tasks, "get_task_manager", lambda: manager)

    completed = manager.create_task_for_project(ctx, "m07_completed", 1, status="completed")
    effective = manager.create_task_for_project(ctx, "m07_stale_running", 1, status="running")
    manager.update_progress_for_project(
        ctx,
        effective.task_type,
        effective.episode,
        progress=1.0,
        current_task="完成",
        expected_task_id=effective.task_id,
    )
    protected = [
        manager.create_task_for_project(ctx, "m07_running", 1, status="running"),
        manager.create_task_for_project(ctx, "m07_failed", 1, status="failed"),
        manager.create_task_for_project(ctx, "m07_cancelled", 1, status="cancelled"),
    ]

    response = await tasks.clear_project_completed_tasks(ctx.project_id, user={"username": "bob"})

    assert response == {"ok": True, "data": {"deleted": 2}}
    assert manager.get_task_for_project(ctx, completed.task_type, completed.episode) is None
    assert manager.get_task_for_project(ctx, effective.task_type, effective.episode) is None
    for task in protected:
        assert manager.get_task_for_project(ctx, task.task_type, task.episode) is not None


@pytest.mark.asyncio
async def test_task_limits_shape_and_ce_single_eligible_user(monkeypatch, tmp_path):
    from novelvideo.api.routes import tasks

    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    await _install_project_context(monkeypatch, ctx)
    monkeypatch.setattr(tasks, "get_task_manager", lambda: manager)
    monkeypatch.setattr(tasks, "get_project_access", lambda: AllowAllProjectAccess())
    manager.create_task_for_project(ctx, "freezone_edit", 0, scope="job_1", queue_kind="default")
    manager.create_task_for_project(ctx, "freezone_edit", 0, scope="job_2", queue_kind="default")
    manager.create_task_for_project(ctx, "single_video", 1, beat_num=1, queue_kind="video")

    response = await tasks.get_project_task_limits(ctx.project_id, user={"username": "bob"})

    assert response["ok"] is True
    assert set(response["data"]) == set(QUEUE_KINDS)
    expected_fields = {
        "limit",
        "active",
        "remaining",
        "user_limit",
        "user_active",
        "user_remaining",
    }
    for queue_kind, payload in response["data"].items():
        assert set(payload) == expected_fields
        assert payload["limit"] == project_lane_effective_active_limit(
            queue_kind,
            eligible_user_count=1,
        )
    assert response["data"]["default"]["active"] == 2
    assert response["data"]["video"]["active"] == 1


@pytest.mark.asyncio
async def test_pipeline_status_returns_m07_shape_and_step_map(monkeypatch, tmp_path):
    from novelvideo.api.routes import pipeline

    ctx = _ctx(tmp_path)

    class FakeStore:
        def get_all_characters(self):
            return []

        def get_all_episodes(self):
            return []

        def get_episode(self, episode):
            return None

        async def get_beats_as_dicts(self, episode):
            return []

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        assert project == ctx.project_id
        return SimpleNamespace(
            ctx=ctx,
            username=ctx.owner_username,
            project_name=ctx.project_name,
            project_dir=ctx.output_dir,
        )

    monkeypatch.setattr(pipeline, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(pipeline, "_user_has_configured", lambda *_: False)
    monkeypatch.setattr(pipeline, "get_task_manager", lambda: TaskStateManager())

    response = await pipeline.pipeline_status(
        project=ctx.project_id,
        user={"username": "bob"},
        store=FakeStore(),
    )

    assert response["ok"] is True
    data = response["data"]
    assert {"global", "current_episode", "episode_status", "next_step", "next_step_name"} <= set(
        data
    )
    assert data["current_episode"] is None
    assert data["episode_status"] is None
    task_type, step_name = pipeline._STEP_MAP["ingest"]
    assert data["next_step"] == task_type
    assert data["next_step_name"] == step_name


def test_m07_http_coverage_exercises_task_center_routes(monkeypatch, tmp_path):
    from novelvideo.api.routes import pipeline, tasks

    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    running = manager.create_task_for_project(ctx, "m07_http", 1, status="running")
    manager.update_progress_for_project(
        ctx,
        running.task_type,
        running.episode,
        progress=0.2,
        current_task="working",
        expected_task_id=running.task_id,
    )
    manager.create_task_for_project(ctx, "m07_done", 1, status="completed")

    async def fake_resolve_project_context(**kwargs):
        assert kwargs["project_id"] == ctx.project_id
        return ctx

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        assert project == ctx.project_id
        return SimpleNamespace(
            ctx=ctx,
            username=ctx.owner_username,
            project_name=ctx.project_name,
            project_dir=ctx.output_dir,
        )

    class FakeStore:
        def get_all_characters(self):
            return []

        def get_all_episodes(self):
            return []

        def get_episode(self, episode):
            return None

        async def get_beats_as_dicts(self, episode):
            return []

    class FakeBackend:
        async def cancel_project_task(self, ctx_arg, task_state):
            assert ctx_arg is ctx
            manager.update_progress_for_project(
                ctx_arg,
                task_state.task_type,
                task_state.episode,
                beat_num=task_state.beat_num,
                scope=task_state.scope,
                progress=task_state.progress,
                current_task="任务已取消",
                status="cancelled",
                expected_task_id=task_state.task_id,
            )
            return True

    monkeypatch.setattr(tasks, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(tasks, "get_task_manager", lambda: manager)
    monkeypatch.setattr(tasks, "get_task_backend", lambda: FakeBackend())
    monkeypatch.setattr(tasks, "get_project_access", lambda: AllowAllProjectAccess())
    monkeypatch.setattr(pipeline, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(pipeline, "get_task_manager", lambda: manager)
    monkeypatch.setattr(pipeline, "_user_has_configured", lambda *_: False)

    app = FastAPI()
    app.include_router(tasks.router, prefix="/api/v1")
    app.include_router(pipeline.router, prefix="/api/v1")
    user = {"id": "local", "user_id": "local", "username": "bob", "role": "owner"}
    for dep in (
        tasks.get_api_user,
        tasks.get_api_user_or_query,
        pipeline.get_api_user,
    ):
        app.dependency_overrides[dep] = lambda user=user: user
    app.dependency_overrides[pipeline.get_sqlite_store] = lambda: FakeStore()
    client = TestClient(app)

    assert client.get(f"/api/v1/projects/{ctx.project_id}/tasks").status_code == 200
    assert client.get(f"/api/v1/projects/{ctx.project_id}/tasks/limits").status_code == 200
    assert (
        client.get(f"/api/v1/projects/{ctx.project_id}/tasks/m07_http/1").status_code
        == 200
    )
    with client.stream(
        "GET",
        f"/api/v1/projects/{ctx.project_id}/tasks/stream",
        params={"snapshot": "true", "interval": "0.5", "heartbeat_sec": "1"},
    ) as response:
        assert response.status_code == 200
        assert next(response.iter_lines()).startswith("event: task_updated")
    with client.stream(
        "GET",
        f"/api/v1/projects/{ctx.project_id}/tasks/m07_http/1/stream",
        params={"interval": "0.5"},
    ) as response:
        assert response.status_code == 200
        assert next(response.iter_lines()).startswith("event: running")
    assert (
        client.delete(f"/api/v1/projects/{ctx.project_id}/tasks/m07_http/1").status_code
        == 200
    )
    assert client.delete(f"/api/v1/projects/{ctx.project_id}/tasks/completed").status_code == 200
    assert client.get(f"/api/v1/projects/{ctx.project_id}/pipeline/status").status_code == 200


class _FakeTaskBackend:
    def __init__(self, backend: str):
        self.backend = backend
        self.calls = []

    async def cancel_project_task(self, ctx, task_state):
        self.calls.append({"ctx": ctx, "task_id": task_state.task_id})
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
        return True


@pytest.mark.asyncio
async def test_m07_task_backend_read_and_stream_shapes_are_ce_ee_isomorphic(
    monkeypatch,
    tmp_path,
):
    from novelvideo.api.routes import tasks

    async def collect(backend: str):
        ctx = _ctx(tmp_path / backend)
        fake_backend = _FakeTaskBackend(backend)
        await _install_project_context(monkeypatch, ctx)
        monkeypatch.setattr(tasks, "get_task_backend", lambda: fake_backend)
        task = get_task_manager().create_task_for_project(
            ctx,
            "m07_shape",
            1,
            status="running",
            metadata={"backend": backend},
        )

        cancel_response = await tasks.cancel_project_task_route(
            ctx.project_id,
            task.task_type,
            task.episode,
            beat_num=None,
            scope=None,
            user={"username": "bob"},
        )
        list_response = await tasks.list_project_tasks(ctx.project_id, user={"username": "bob"})
        project_stream = await tasks.stream_project_tasks(
            project=ctx.project_id,
            request=None,  # type: ignore[arg-type]
            interval=0.5,
            heartbeat_sec=1.0,
            snapshot=True,
            user={"username": "bob"},
        )
        project_event = await _first_sse_event(project_stream)
        task_stream = await tasks.stream_project_task(
            project=ctx.project_id,
            task_type=task.task_type,
            episode=task.episode,
            request=None,  # type: ignore[arg-type]
            beat_num=None,
            scope=None,
            interval=0.5,
            user={"username": "bob"},
        )
        task_event = await _single_sse_event_and_closed(task_stream)

        assert fake_backend.calls == [{"ctx": ctx, "task_id": task.task_id}]
        return {
            "cancel_keys": sorted(cancel_response),
            "list_item_keys": sorted(list_response["data"][0]),
            "project_event": project_event["event"],
            "project_payload_keys": sorted(json.loads(project_event["data"])),
            "task_event": task_event["event"],
            "task_payload_keys": sorted(json.loads(task_event["data"])),
        }

    inline_summary = await collect("inline")
    celery_summary = await collect("celery")

    assert inline_summary == celery_summary
    assert inline_summary["cancel_keys"] == ["message", "ok"]
    assert inline_summary["project_event"] == "task_updated"
    assert inline_summary["task_event"] == "cancelled"
    assert inline_summary["task_payload_keys"] == [
        "current_task",
        "error",
        "error_code",
        "logs",
        "progress",
        "result",
        "status",
    ]


@pytest.mark.asyncio
async def test_inline_cancel_is_cooperative_runner_stop(tmp_path):
    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend()
    task_type = "m07_cooperative_cancel"
    observed_cancel = False
    runner_started = threading.Event()

    def runner(envelope, run_ctx):
        nonlocal observed_cancel
        runner_started.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            cancelled = asyncio.run(
                is_cancel_requested(
                    project_id=envelope["project_id"],
                    task_type=envelope["task_type"],
                    episode=envelope["episode"],
                    task_id=envelope["__run_task_id"],
                    beat_num=envelope.get("beat_num"),
                    scope=envelope.get("scope"),
                )
            )
            if cancelled:
                observed_cancel = True
                raise TaskCancelled()
            time.sleep(0.02)
        raise AssertionError("runner did not observe cancel flag")

    register_project_task_runner(task_type, runner)

    queued = await backend.enqueue_project_task(ctx, task_type=task_type, episode=1)
    assert await asyncio.to_thread(runner_started.wait, 3) is True
    await backend.cancel_project_task(ctx, queued.task_state)
    assert (
        await is_cancel_requested(
            project_id=ctx.project_id,
            task_type=queued.task_state.task_type,
            episode=queued.task_state.episode,
            task_id=queued.task_state.task_id,
            beat_num=queued.task_state.beat_num,
            scope=queued.task_state.scope,
        )
        is True
    )

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and not observed_cancel:
        await asyncio.sleep(0.02)

    task = get_task_manager().get_task_for_project(ctx, task_type, 1)
    assert observed_cancel is True
    assert task is not None
    assert task.status == "cancelled"


@pytest.mark.asyncio
async def test_inline_backend_runs_sync_core_outside_active_event_loop(monkeypatch, tmp_path):
    from novelvideo.ports.local import tasks as local_tasks

    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend()
    observed = threading.Event()

    def fake_run_project_task_core_sync(*args, **kwargs):
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        observed.set()
        return {"ok": True}

    monkeypatch.setattr(
        local_tasks,
        "run_project_task_core_sync",
        fake_run_project_task_core_sync,
    )

    await backend.enqueue_project_task(ctx, task_type="m07_no_asyncio_run_in_loop", episode=1)

    assert await asyncio.to_thread(observed.wait, 3) is True

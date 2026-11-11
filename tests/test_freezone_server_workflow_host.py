# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""In-process request authorization identity and durable canvas writes."""

import asyncio
import json
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from novelvideo.api.freezone_server_workflow_host import (
    InProcessActionHost,
    build_server_action_runner,
)
from novelvideo.api.routes import freezone as routes
from novelvideo.api.routes import tasks as task_routes
from novelvideo.api.schemas import FreezoneGenRequest, FreezoneRecipeCompileRequest
from novelvideo.freezone import canvas_store
from novelvideo.freezone.paths import freezone_root
from novelvideo.freezone.server_workflow_actions import ActionLeaseLost, ServerActionHttpError

TASK = {"task_key": "freezone_gen:project:j1", "task_type": "freezone_gen", "job_id": "j1"}


@pytest.fixture
def context(tmp_path):
    return SimpleNamespace(
        project_id="project", requester_user_id="requester-id", requester_username="",
        state_dir=tmp_path, output_dir=tmp_path / "output",
    )


@pytest.fixture
def host(context):
    return InProcessActionHost(ctx=context, canvas_id="default", assert_lease=lambda: None)


async def test_gen_request_narrows_response_and_preserves_requester(host, monkeypatch):
    received = []

    async def gen(project, body, user):
        received.append((project, body, user))
        return {"ok": True, "extra": "drop", "data": {**TASK, "extra": "drop"}}

    monkeypatch.setattr(routes, "freezone_gen", gen)
    assert await host.request("POST", "projects/project/freezone/gen", {"prompt": "A ship"}) == TASK
    project, body, user = received[0]
    assert project == "project"
    assert isinstance(body, FreezoneGenRequest)
    assert body.prompt == "A ship"
    assert user == {"id": "requester-id", "user_id": "requester-id", "username": ""}
    assert "scopes" not in user


@pytest.mark.parametrize("path,handler,data,expected", [
    ("freezone/recipes/compile", "compile_freezone_recipe",
     {"prompt": "Compiled", "compile_mode": "model", "recipe_ids": ["r"], "extra": 1},
     {"prompt": "Compiled", "compile_mode": "model", "recipe_ids": ["r"]}),
    ("freezone/recipes/generate-text", "generate_freezone_recipe_text",
     {"content": "Hello", "extra": 1}, {"content": "Hello"}),
])
async def test_recipe_requests(host, monkeypatch, path, handler, data, expected):
    async def request(body, user):
        assert isinstance(body, FreezoneRecipeCompileRequest)
        assert body.recipe_id == "r"
        assert "scopes" not in user
        return {"ok": True, "data": data}

    monkeypatch.setattr(routes, handler, request)
    assert await host.request("POST", path, {"recipe_id": "r", "node_kind": "text"}) == expected


async def test_http_and_validation_errors(host, monkeypatch):
    async def bad(*args):
        raise HTTPException(400, "bad")

    monkeypatch.setattr(routes, "freezone_gen", bad)
    with pytest.raises(ServerActionHttpError, match="^HTTP 400: bad$"):
        await host.request("POST", "projects/project/freezone/gen", {"prompt": "A ship"})
    with pytest.raises(ServerActionHttpError, match="^HTTP 422:"):
        await host.request("POST", "projects/project/freezone/gen", {})


@pytest.mark.parametrize("method,path", [
    ("POST", "unknown"), ("POST", "projects/foreign/freezone/gen"),
    ("GET", "projects/project/freezone/gen"),
])
async def test_rejects_unmapped_requests(host, method, path):
    with pytest.raises(ServerActionHttpError, match=path):
        await host.request(method, path, {"prompt": "A ship"})


async def test_real_canvas_patch_events_idempotency_and_lease(context):
    root = context.state_dir
    canvas = canvas_store.ensure_default_canvas(root, project_id="project").payload
    canvas["nodes"] = [{"id": "n", "type": "imageGenNode", "position": {"x": 0, "y": 0},
                        "data": {"prompt": "A ship"}}]
    canvas_store.atomic_write_json(canvas_store.canvas_path(root, "default"), canvas)
    held = True

    def lease():
        if not held:
            raise RuntimeError("lease lost")

    host = InProcessActionHost(ctx=context, canvas_id="default", assert_lease=lease)
    await host.patch_node("n", {"imageUrl": "/api/projects/project/static/fz/a.png"})
    saved = canvas_store.read_canvas(root, "default")
    assert saved["revision"] == canvas["revision"] + 1
    assert saved["save_source"] == "workflow_result"
    assert saved["nodes"][0]["data"]["imageUrl"] == "/api/projects/project/static/fz/a.png"
    events_path = freezone_root(root) / "_canvas_events/default.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()]
    assert [e["event_type"] for e in events] == ["canvas.saved"]
    assert events[0]["payload"]["save_source"] == "workflow_result"
    await host.patch_node("n", {"imageUrl": "/api/projects/project/static/fz/a.png"})
    await host.patch_node("missing", {"content": "ignored"})
    assert canvas_store.read_canvas(root, "default")["revision"] == saved["revision"]
    assert len(events_path.read_text().splitlines()) == 1
    held = False
    with pytest.raises(ActionLeaseLost):
        await host.patch_node("n", {"prompt": "Never saved"})
    assert host.lease_held() is False
    assert canvas_store.read_canvas(root, "default") == saved


async def test_concurrent_patches_from_one_host_all_land(host, context, monkeypatch):
    root = context.state_dir
    canvas = canvas_store.ensure_default_canvas(root, project_id="project").payload
    canvas["nodes"] = [{
        "id": f"n{i}", "type": "imageGenNode", "position": {"x": 0, "y": 0},
        "data": {"prompt": "A ship"},
    } for i in range(6)]
    canvas_store.atomic_write_json(canvas_store.canvas_path(root, "default"), canvas)
    save = canvas_store.save_canvas

    async def read_canvas():
        return canvas_store.read_canvas(root, "default")

    async def save_canvas(*args, **kwargs):
        await asyncio.sleep(0)
        return save(*args, **kwargs)

    monkeypatch.setattr(host, "read_canvas", read_canvas)
    monkeypatch.setattr(canvas_store, "save_canvas_async", save_canvas)
    await asyncio.gather(*(host.patch_node(
        f"n{i}", {"imageUrl": f"/api/projects/project/static/fz/{i}.png"},
    ) for i in range(6)))

    saved = canvas_store.read_canvas(root, "default")
    assert saved["revision"] == canvas["revision"] + 6
    assert {node["id"]: node["data"]["imageUrl"] for node in saved["nodes"]} == {
        "n0": "/api/projects/project/static/fz/0.png",
        "n1": "/api/projects/project/static/fz/1.png",
        "n2": "/api/projects/project/static/fz/2.png",
        "n3": "/api/projects/project/static/fz/3.png",
        "n4": "/api/projects/project/static/fz/4.png",
        "n5": "/api/projects/project/static/fz/5.png",
    }


async def test_lane_capacity(host, monkeypatch):
    async def limits(project, user):
        assert project == "project"
        assert user["id"] == "requester-id"
        return {"ok": True, "data": {
            "image": {"remaining": 4, "user_remaining": 2},
            "video": {"remaining": None, "user_remaining": 3},
            "text": {"remaining": None, "user_remaining": None},
        }}

    monkeypatch.setattr(task_routes, "get_project_task_limits", limits)
    assert await host.lane_capacity("image") == 2
    assert await host.lane_capacity("video") == 3
    assert await host.lane_capacity("text") is None
    assert await host.lane_capacity("unknown") is None


def test_build_runner(context):
    runner = build_server_action_runner(
        ctx=context, run={"canvas_id": "default", "run_id": "run-1"},
        runner_id="runner", assert_lease=lambda: None,
    )
    assert runner.supports("generate_image") is True


async def test_revision_retry_preserves_concurrent_edit(host, context, monkeypatch):
    root = context.state_dir
    canvas = canvas_store.ensure_default_canvas(root, project_id="project").payload
    canvas["nodes"] = [{"id": "n", "type": "imageGenNode", "position": {"x": 0, "y": 0},
                        "data": {"prompt": "Original"}}]
    canvas_store.atomic_write_json(canvas_store.canvas_path(root, "default"), canvas)
    save = canvas_store.save_canvas_async
    concurrent_edit = True

    async def conflict_once(*args, **kwargs):
        nonlocal concurrent_edit
        if concurrent_edit:
            concurrent_edit = False
            latest = canvas_store.read_canvas(root, "default")
            latest["nodes"][0]["data"]["prompt"] = "Edited"
            latest["revision"] += 1
            canvas_store.atomic_write_json(canvas_store.canvas_path(root, "default"), latest)
        return await save(*args, **kwargs)

    monkeypatch.setattr(canvas_store, "save_canvas_async", conflict_once)
    await host.patch_node("n", {"generationOwner": None})
    saved = canvas_store.read_canvas(root, "default")
    assert saved["revision"] == canvas["revision"] + 2
    assert saved["nodes"][0]["data"] == {"prompt": "Edited", "generationOwner": None}


async def test_task_lookup_and_result_url(host, context, monkeypatch):
    from novelvideo.api import freezone_server_workflow_host as host_module

    def get_task(ctx, task_type, episode, *, beat_num, scope):
        assert ctx is context
        assert (task_type, episode, beat_num, scope) == ("freezone_gen", 0, None, "j1")
        return SimpleNamespace(status="completed", result={"output_url": "/static/a.png"},
                               error=None)

    monkeypatch.setattr(host_module, "get_task_manager", lambda: SimpleNamespace(
        get_task_for_project=get_task,
    ))
    assert await host.task_status(TASK) == {
        "status": "completed", "result": {"output_url": "/static/a.png"}, "error": None,
    }

    async def job_result(project, task_type, job_id, user):
        assert (project, task_type, job_id) == ("project", "freezone_gen", "j1")
        assert "scopes" not in user
        return {"ok": True, "data": {"url": "/static/a.png", "size": 12}}

    monkeypatch.setattr(routes, "freezone_job_result", job_result)
    assert await host.job_result_url(TASK) == "/static/a.png"
    assert await host.job_result(TASK) == {"url": "/static/a.png", "size": 12}

    async def missing(*args):
        raise HTTPException(404, "not found")

    monkeypatch.setattr(routes, "freezone_job_result", missing)
    assert await host.job_result_url(TASK) is None
    assert await host.job_result(TASK) is None


async def test_clear_generation_markers_only_for_this_run(context):
    from novelvideo.api.freezone_server_workflow_host import clear_server_generation_markers

    root = context.state_dir
    canvas = canvas_store.ensure_default_canvas(root, project_id="project").payload
    canvas["nodes"] = [{
        "id": node_id, "type": "imageGenNode", "position": {"x": 0, "y": 0},
        "data": {"generationRunId": run_id, "generationOwner": "server", "isGenerating": True,
                 "prompt": "A ship"},
    } for node_id, run_id in (("one", "run-1"), ("two", "run-2"), ("three", None))]
    original = json.loads(json.dumps(canvas["nodes"]))
    canvas_store.atomic_write_json(canvas_store.canvas_path(root, "default"), canvas)
    await clear_server_generation_markers(ctx=context, canvas_id="default", run_id="run-1")
    saved = canvas_store.read_canvas(root, "default")
    assert saved["save_source"] == "workflow_result"
    assert saved["nodes"][0]["data"] == {
        "prompt": "A ship", "isGenerating": False, "generationStartedAt": None,
        "generationTaskKey": None, "generationTaskType": None, "generationTaskJobId": None,
        "generationOwner": None, "generationRunId": None}
    assert saved["nodes"][1:] == original[1:]


async def test_request_isolates_drive_usage_context(host, monkeypatch):
    from novelvideo.llm_instrumentation import get_llm_user_context
    from tests.recording_usage_meter import RecordingUsageMeter

    async def gen(project, body, user):
        assert get_llm_user_context() is None
        return {"ok": True, "data": TASK}

    monkeypatch.setattr(routes, "freezone_gen", gen)
    with RecordingUsageMeter().registered() as meter:
        meter.set_llm_usage_context("drive-user", "project")
        try:
            assert await host.request(
                "POST", "projects/project/freezone/gen", {"prompt": "A ship"},
            ) == TASK
            assert get_llm_user_context() == "drive-user"
        finally:
            meter.clear_llm_usage_context()


async def test_media_link_is_scoped_to_handler(host, monkeypatch):
    from novelvideo.freezone import workflow_runs as store

    seen = []
    link = {"run_id": "run-1", "node_id": "n", "generation_attempt_id": "attempt-1"}

    async def gen(project, body, user):
        seen.append(store.get_server_workflow_media_link())
        return {"ok": True, "data": TASK}

    async def recipe(body, user):
        seen.append(store.get_server_workflow_media_link())
        return {"ok": True, "data": {
            "prompt": "Compiled", "content": "Text", "compile_mode": "model",
        }}

    monkeypatch.setattr(routes, "freezone_gen", gen)
    monkeypatch.setattr(routes, "compile_freezone_recipe", recipe)
    monkeypatch.setattr(routes, "generate_freezone_recipe_text", recipe)
    assert store.get_server_workflow_media_link() is None
    await host.request("POST", "projects/project/freezone/gen", {"prompt": "A ship"},
                       media_link=link)
    assert store.get_server_workflow_media_link() is None
    await host.request("POST", "projects/project/freezone/gen", {"prompt": "A ship"})
    for path in ("freezone/recipes/compile", "freezone/recipes/generate-text"):
        await host.request("POST", path, {"recipe_id": "r", "node_kind": "text"})
    assert seen == [link, None, None, None]
    assert store.get_server_workflow_media_link() is None


async def test_media_link_clears_after_handler_error(host, monkeypatch):
    from novelvideo.freezone import workflow_runs as store

    async def gen(project, body, user):
        assert store.get_server_workflow_media_link() == {
            "run_id": "run-1", "node_id": "n", "generation_attempt_id": "attempt-1",
        }
        raise HTTPException(409, "rejected")

    monkeypatch.setattr(routes, "freezone_gen", gen)
    with pytest.raises(ServerActionHttpError, match="HTTP 409: rejected"):
        await host.request("POST", "projects/project/freezone/gen", {"prompt": "A ship"},
                           media_link={"run_id": "run-1", "node_id": "n",
                                       "generation_attempt_id": "attempt-1"})
    assert store.get_server_workflow_media_link() is None


@pytest.mark.parametrize("audio", [False, True])
async def test_real_media_route_takeover_never_reserves_again(context, monkeypatch, audio):
    from novelvideo.api import freezone_server_workflow_host as host_module
    from novelvideo.freezone import workflow_runs as store
    from novelvideo.freezone.canvas_core_pool import CanvasCorePool
    from novelvideo.freezone.server_workflow_actions import WorkflowActionRunner
    from novelvideo.ports import get_usage_meter
    from tests.recording_usage_meter import RecordingUsageMeter
    from tests.test_server_workflow_actions import BUNDLE

    canvas = canvas_store.ensure_default_canvas(context.state_dir, project_id="project").payload
    canvas["nodes"] = [{"id": "n", "type": "imageGenNode", "position": {"x": 0, "y": 0},
                        "data": {"prompt": "A ship", "model": "image-model"}}]
    canvas_store.atomic_write_json(canvas_store.canvas_path(context.state_dir, "default"), canvas)
    if audio:
        canvas["nodes"][0].update(type="audioNode", data={"text": "Hello", "audioUrl": None,
                                                        "speechMode": "preset"})
        canvas_store.atomic_write_json(
            canvas_store.canvas_path(context.state_dir, "default"), canvas,
        )
    run = store.create_workflow_run(
        project_dir=context.state_dir, project_id="project", canvas_id="default",
        owner_kind="server", actions=[{
            "node_id": "n", "action": "generate_audio" if audio else "generate_image",
            "generation_attempt_id": "attempt-1",
        }],
    )
    task_type = "freezone_audio_speech" if audio else "freezone_gen"
    canvas_id = "default"
    tasks, enqueued = {}, []
    model = {"id": "image-model", "apiModel": "image-model", "providerId": "openai"}

    async def resolve(project, user):
        assert user["id"] == "requester-id"
        return context, "", project, context.state_dir, str(context.output_dir)

    async def catalog(media_type, *, requester_user_id):
        assert (media_type, requester_user_id) == ("image", "requester-id")
        return [model]

    async def image_models(user_id):
        assert user_id == "requester-id"
        return {"models": [model]}

    async def enqueue(ctx, *, task_type, scope, **kwargs):
        assert ctx.requester_user_id == "requester-id"
        await get_usage_meter().reserve_feature_start_credits(
            user_id=ctx.requester_user_id, feature_key="speech" if audio else "image",
            product_surface="freezone",
            project_id=ctx.project_id, task_type=task_type, task_id="media-task",
        )
        enqueued.append(task_type)
        state = SimpleNamespace(
            task_id="media-task", status="completed", error=None,
            result={"output_url": "/static/a.png"},
            metadata={"backend": "celery", "queue": "default"},
        )
        tasks[scope] = state
        return SimpleNamespace(task_state=state, backend="celery", queue="default")

    manager = SimpleNamespace(get_task_for_project=lambda ctx, task_type, episode, **kw:
                              tasks.get(kw["scope"]))
    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "_scoped_media_model_catalog", catalog)
    monkeypatch.setattr(routes, "_media_model_catalog_is_authoritative", lambda: True)
    monkeypatch.setattr(routes, "_freezone_image_models_data", image_models)
    monkeypatch.setattr(routes, "get_task_backend", lambda: SimpleNamespace(
        enqueue_project_task=enqueue,
    ))
    monkeypatch.setattr(routes, "get_task_manager", lambda: manager)
    monkeypatch.setattr(host_module, "get_task_manager", lambda: manager)
    async def projection(**kwargs):
        return {}

    async def job_result(*args):
        return {"ok": True, "data": {"url": "/static/a.mp3"}}

    if audio:
        monkeypatch.setattr(routes, "_task_projection_payload", projection)
        monkeypatch.setattr(routes, "freezone_job_result", job_result)
    host = InProcessActionHost(ctx=context, canvas_id=canvas_id, assert_lease=lambda: None)
    pool = CanvasCorePool(BUNDLE, size=1)

    async def core(op, payload):
        return await asyncio.to_thread(pool.call_value, op, payload)

    def runner():
        return WorkflowActionRunner(
            host=host, project_id="project", canvas_id=canvas_id, run_id=run["run_id"],
            core_call=core,
        )

    async def died(task):
        raise RuntimeError("drive died before acceptance")

    async def ignore(value):
        pass

    args = dict(node_id="n", action="generate_audio" if audio else "generate_image",
                generation_attempt_id="attempt-1",
                on_phase=ignore, should_stop=lambda: False)
    try:
        with RecordingUsageMeter({task_type}).registered() as meter:
            with pytest.raises(RuntimeError, match="drive died before acceptance"):
                await runner().run_action(**args, existing_task=None, on_accepted=died)
            row = store.read_workflow_run(
                project_dir=context.state_dir, canvas_id=canvas_id, run_id=run["run_id"],
            )["actions"][0]
            assert row["job_id"] is not None
            assert enqueued == [task_type]
            assert [name for name, _ in meter.calls if name == "reserve_feature_start_credits"] == [
                "reserve_feature_start_credits",
            ]
            meter.calls.clear()
            task = {key: row[key] for key in ("task_key", "task_type", "job_id")}
            result = await runner().run_action(**args, existing_task=task, on_accepted=ignore)
            assert result["status"] == "completed"
            assert result["artifact"] == ({"audio_url": "/static/a.mp3"} if audio
                                          else {"output_url": "/static/a.png"})
            assert enqueued == [task_type]
            assert [name for name, _ in meter.calls if name in {
                "reserve_current_model_call_credit", "reserve_feature_start_credits",
            }] == []
    finally:
        pool.close()


@pytest.mark.parametrize("outcome", ["pending", "delivered", "missing"])
async def test_interrupted_product_refunds_once(host, context, monkeypatch, outcome):
    from novelvideo.freezone import agent_product_operations as products
    from tests.recording_usage_meter import RecordingUsageMeter

    operation = products.create_agent_product_operation(
        project_dir=context.state_dir, project_id="project", product_kind="recipe_result",
        idempotency_key="text-interruption", generation_session_id="text-run", canvas_id="default",
    )
    operation_id = operation["operation_id"]
    products.bind_agent_product_task(
        project_dir=context.state_dir, operation_id=operation_id,
        task_id="text-product-task", root_task_id="text-product-task",
    )
    if outcome == "delivered":
        products.bind_agent_product_model_execution(
            project_dir=context.state_dir, operation_id=operation_id, model_call_id="text-call",
            executed_at=1.0, source="server_recipe_compiler", compile_mode="model",
        )
        products.finish_agent_product_operation(
            project_dir=context.state_dir, operation_id=operation_id, outcome="delivered",
            expected_task_id="text-product-task",
            result_ref={"kind": "recipe_result", "id": "text"},
        )
    task = SimpleNamespace(task_id="text-product-task", status="running", progress=0,
                           metadata={"feature_credit_reservation_id": "text-reservation"})
    terminalized = []

    class Manager:
        def get_task_for_project(self, ctx, task_type, episode, *, scope):
            assert (ctx, task_type, episode, scope) == (
                context, "freezone_agent_recipe_result", 0, operation_id,
            )
            return task

        def fail_task_for_project(self, *args, metadata, **kwargs):
            task.status = "failed"
            task.metadata.update(metadata)
            terminalized.append(task.status)

    monkeypatch.setattr(products, "get_task_manager", lambda: Manager())
    target = "agent_product_missing" if outcome == "missing" else operation_id
    before = products.read_agent_product_operation(
        project_dir=context.state_dir, operation_id=operation_id,
    )
    with RecordingUsageMeter().registered() as meter:
        await host.fail_product_operation(target)
        after = products.read_agent_product_operation(
            project_dir=context.state_dir, operation_id=operation_id,
        )
        if outcome == "pending":
            assert after["status"] == "failed"
            assert (task.status, task.metadata["settlement_status"]) == ("failed", "refunded")
            assert terminalized == ["failed"]
            expected = [("settle_cancelled_feature_credit_reservation", {
                "reservation_id": "text-reservation", "metadata": {
                    "source": "agent_product_failed", "operation_id": operation_id,
                    "business_outcome": "failed",
                },
            })]
        else:
            assert after == before
            assert task.status == "running"
            assert terminalized == []
            expected = []
        assert meter.calls == expected
        await host.fail_product_operation(target)
        assert meter.calls == expected
        assert terminalized == (["failed"] if outcome == "pending" else [])


async def test_text_takeover_uses_host_without_reserving_credit(context, monkeypatch):
    from datetime import datetime, timedelta, timezone
    from novelvideo.freezone import workflow_runs as store
    from novelvideo.freezone.server_workflow_driver import drive_server_workflow_run
    from tests.recording_usage_meter import RecordingUsageMeter

    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    run = store.create_workflow_run(
        project_dir=context.state_dir, project_id="project", canvas_id="default",
        owner_kind="server", actions=[{"node_id": "text", "action": "generate_text"}], now=now,
    )
    scope = dict(project_dir=context.state_dir, canvas_id="default", run_id=run["run_id"])
    store.acquire_server_workflow_run(**scope, runner_id="dead", now=now)
    store.update_workflow_run(
        **scope, owner_kind="server", runner_id="dead", now=now, action_updates=[{
            "node_id": "text", "action": "generate_text",
            "status": "running", "phase": "generating",
        }],
    )
    canvas = canvas_store.ensure_default_canvas(context.state_dir, project_id="project").payload
    canvas["nodes"] = [{"id": "text", "type": "textAnnotationNode", "position": {"x": 0, "y": 0},
                        "data": {"generationRunId": run["run_id"], "generationOwner": "server",
                                 "isGenerating": True, "content": "Previous content"}}]
    canvas_store.atomic_write_json(canvas_store.canvas_path(context.state_dir, "default"), canvas)

    async def limits(project, user):
        return {"data": {"default": {"remaining": 1}}}

    monkeypatch.setattr(task_routes, "get_project_task_limits", limits)

    async def no_core(op, payload):
        raise AssertionError("an interrupted request must not be built again")

    def factory(acquired, guard):
        runner = build_server_action_runner(
            ctx=context, run=acquired, runner_id="takeover", assert_lease=guard,
        )
        runner.core_call = no_core
        return runner

    with RecordingUsageMeter().registered() as meter:
        result = await drive_server_workflow_run(
            **scope, runner_id="takeover", action_runner_factory=factory,
            now=lambda: now + timedelta(seconds=181),
        )
        assert result["status"] == "failed"
        assert store.read_workflow_run(**scope)["actions"][0]["error"] == (
            "文本生成在接管前已发出，结果未知；为避免重复调用已停止，请重新发起"
        )
        assert meter.calls == []
    assert canvas_store.read_canvas(context.state_dir, "default")["nodes"][0]["data"] == {
        "content": "Previous content", "isGenerating": False, "generationStartedAt": None,
        "generationTaskKey": None, "generationTaskType": None, "generationTaskJobId": None,
        "generationOwner": None, "generationRunId": None,
    }


@pytest.mark.parametrize("path,handler,model,body", [
    ("audio/speech", "freezone_audio_speech", "FreezoneAudioSpeechRequest", {"text": "Hello"}),
    ("audio/eleven-music", "freezone_audio_eleven_music", "FreezoneAudioMusicRequest",
     {"input": "Calm piano"}),
    ("text/translate", "freezone_text_translate", "FreezoneTextTranslateRequest",
     {"text": "Hello"}),
])
@pytest.mark.parametrize("json_response", [False, True])
async def test_audio_transport_dispatch(
    host, monkeypatch, path, handler, model, body, json_response,
):
    from starlette.responses import JSONResponse

    async def submit(project, parsed, user):
        assert project == "project"
        assert type(parsed).__name__ == model
        assert parsed.model_dump().items() >= body.items()
        assert user == {"id": "requester-id", "user_id": "requester-id", "username": ""}
        result = {"ok": True, "data": {**TASK, "extra": "drop"}}
        return JSONResponse(result) if json_response else result

    monkeypatch.setattr(routes, handler, submit)
    assert await host.request("POST", f"projects/project/freezone/{path}", body) == TASK


@pytest.mark.parametrize("returned", [False, True])
async def test_audio_transport_structured_error(host, monkeypatch, returned):
    from starlette.responses import JSONResponse

    async def submit(*args):
        body = {"ok": False, "code": "voice_required", "error": "请先配置或选择声线"}
        if returned:
            return JSONResponse(body, status_code=409)
        raise HTTPException(409, body)

    monkeypatch.setattr(routes, "freezone_audio_speech", submit)
    with pytest.raises(ServerActionHttpError) as caught:
        await host.request("POST", "projects/project/freezone/audio/speech", {"text": "Hello"})
    assert str(caught.value) == ("HTTP 409: 请先配置或选择声线" if returned else
                                "HTTP 409: voice_required")
    assert caught.value.status_code == 409
    assert caught.value.info == {
        "name": "HttpError", "message": "请先配置或选择声线", "status": 409,
        "display": "请先配置或选择声线", "details": None, "requestId": None,
        "referenceIssues": [],
    }

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
        return {"ok": True, "url": "/static/a.png"}

    monkeypatch.setattr(routes, "freezone_job_result", job_result)
    assert await host.job_result_url(TASK) == "/static/a.png"

    async def missing(*args):
        raise HTTPException(404, "not found")

    monkeypatch.setattr(routes, "freezone_job_result", missing)
    assert await host.job_result_url(TASK) is None


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

"""Server workflow admission uses the browser's durable Recipe bindings."""

from copy import deepcopy
from datetime import datetime, timezone
import sqlite3
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from novelvideo.api import freezone_server_workflow_start as start
from novelvideo.api.routes import freezone as routes
from novelvideo import config
from novelvideo.freezone import canvas_store, workflow_runs
from novelvideo.freezone.agent_product_operations import read_agent_product_operation
from novelvideo.ports.local.usage import NoOpUsageMeter
from novelvideo.ports.registry import register_port
from tests.recording_usage_meter import RecordingUsageMeter


@pytest.fixture
def setup(tmp_path, monkeypatch):
    ctx = SimpleNamespace(project_id="project", requester_user_id="initiator",
                          requester_username="", state_dir=tmp_path, output_dir=tmp_path)
    canvas = canvas_store.ensure_default_canvas(tmp_path, project_id="project").payload
    canvas["nodes"] = [
        {"id": node_id, "type": kind, "position": {"x": 0, "y": 0}, "data": {
            "workflowCatalog": {"recipeId": f" {recipe} ", "recipeVersion": " 1.2.0 "},
        }} for node_id, kind, recipe in (
            ("image", "imageGenNode", "image-recipe"), ("text", "textNode", "text-recipe"),
        )
    ]
    canvas_store.atomic_write_json(canvas_store.canvas_path(tmp_path, "default"), canvas)
    plan = {"ok": True, "actions": [
        {"node_id": "image", "action": "generate_image", "label": "Image"},
        {"node_id": "text", "action": "generate_text", "label": "Text"},
    ], "levels": [[0, 1]], "dependencies": {}}
    queued = []

    async def enqueue(context, **kwargs):
        assert context.requester_user_id == "initiator"
        queued.append(kwargs)
        return SimpleNamespace(task_state=SimpleNamespace(task_id=f"recipe-task-{len(queued)}"))

    async def drive(context, **kwargs):
        assert context.requester_user_id == "initiator"
        queued.append({"task_type": "freezone_workflow_drive", **kwargs})

    async def catalog(_user_id):
        return []

    monkeypatch.setattr(routes, "get_task_backend", lambda: SimpleNamespace(
        enqueue_project_task=enqueue,
    ))
    monkeypatch.setattr(start, "enqueue_server_workflow_drive", drive)
    monkeypatch.setattr(start, "get_canvas_core_pool", lambda: SimpleNamespace(
        call=lambda op, payload: deepcopy(plan),
    ))
    monkeypatch.setattr(routes, "_freezone_image_models_data", catalog)
    monkeypatch.setattr(routes, "_freezone_video_models_data", catalog)
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "index")
    with RecordingUsageMeter({"freezone_agent_recipe_result"}).registered() as meter:
        yield SimpleNamespace(ctx=ctx, root=tmp_path, canvas=canvas, plan=plan,
                              queued=queued, meter=meter)


async def check(setup):
    return await start.check_server_workflow(
        ctx=setup.ctx, state_dir=setup.root, canvas_id="default",
        commands=[{"type": "run_workflow", "scope": "canvas"}], locale="en",
    )


async def launch(setup):
    return await start.start_server_workflow_run(
        ctx=setup.ctx, state_dir=setup.root, canvas_id="default", plan=setup.plan,
        confirmation={"id": "confirmation-1", "agent_id": "main", "username": ""},
        actor_id="initiator", now=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


async def test_metered_image_and_text_are_runnable(setup):
    assert (await check(setup))["status"] == "runnable"


async def test_metered_text_requires_recipe_before_creation(setup):
    setup.canvas["nodes"][1]["data"] = {}
    canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"), setup.canvas)
    result = await check(setup)
    assert result["status"] == "blocked"
    assert result["blocked"] == [{"node_id": "text", "action": "generate_text",
                                  "label": "Text", "reason": "recipe_required"}]
    with pytest.raises(HTTPException) as caught:
        await launch(setup)
    assert caught.value.status_code == 400
    assert caught.value.detail == (
        "model workflow actions require recipe_id and generation_attempt_id"
    )
    assert workflow_runs.list_workflow_runs(project_dir=setup.root, canvas_id="default") == []


async def test_metered_start_admits_recipe_actions_once_before_drive(setup):
    run = await launch(setup)
    assert [{key: action[key] for key in (
        "node_id", "action", "recipe_id", "recipe_version", "generation_attempt_id",
    )} for action in run["actions"]] == [
        {"node_id": "image", "action": "generate_image", "recipe_id": "image-recipe",
         "recipe_version": "1.2.0", "generation_attempt_id":
             "canvas-confirmation:confirmation-1:image:generate_image"},
        {"node_id": "text", "action": "generate_text", "recipe_id": "text-recipe",
         "recipe_version": "1.2.0", "generation_attempt_id":
             "canvas-confirmation:confirmation-1:text:generate_text"},
    ]
    operation_ids = [a["product_operation_id"] for a in run["actions"]]
    assert all(operation_ids)
    assert [item["task_type"] for item in setup.queued] == [
        "freezone_agent_recipe_result", "freezone_agent_recipe_result", "freezone_workflow_drive",
    ]
    assert [item["scope"] for item in setup.queued[:2]] == operation_ids
    for operation_id, task_id in zip(operation_ids, ["recipe-task-1", "recipe-task-2"]):
        operation = read_agent_product_operation(project_dir=setup.root, operation_id=operation_id)
        assert operation["task_id"] == task_id
    assert (await launch(setup))["actions"] == run["actions"]
    assert len(setup.queued) == 3
    with sqlite3.connect(setup.root / "data.db") as conn:
        assert conn.execute(
            "SELECT count(*) FROM freezone_agent_product_operations",
        ).fetchone() == (2,)


async def test_enqueue_rejection_fails_run_and_operation_without_drive(setup, monkeypatch):
    async def reject(*args, **kwargs):
        raise RuntimeError("recipe admission rejected")

    monkeypatch.setattr(routes, "get_task_backend", lambda: SimpleNamespace(
        enqueue_project_task=reject,
    ))
    with pytest.raises(RuntimeError, match="^recipe admission rejected$"):
        await launch(setup)
    runs = workflow_runs.list_workflow_runs(project_dir=setup.root, canvas_id="default")
    assert [run["status"] for run in runs] == ["failed"]
    with sqlite3.connect(setup.root / "data.db") as conn:
        assert conn.execute(
            "SELECT status, task_id FROM freezone_agent_product_operations",
        ).fetchall() == [("failed", "")]
    assert setup.queued == []


async def test_noop_start_keeps_attempt_identity_without_operations(setup):
    register_port("usage_meter", NoOpUsageMeter())
    run = await launch(setup)
    assert [a["generation_attempt_id"] for a in run["actions"]] == [
        "canvas-confirmation:confirmation-1:image:generate_image",
        "canvas-confirmation:confirmation-1:text:generate_text",
    ]
    assert [a["product_operation_id"] for a in run["actions"]] == [None, None]
    assert [q["task_type"] for q in setup.queued] == ["freezone_workflow_drive"]

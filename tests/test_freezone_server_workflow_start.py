"""Server workflow admission uses the browser's durable Recipe bindings."""

from copy import deepcopy
from datetime import datetime, timezone
import sqlite3
from types import SimpleNamespace

import pytest

from novelvideo.api import freezone_server_workflow_start as start
from novelvideo.api.routes import freezone as routes
from novelvideo import config
from novelvideo.freezone import canvas_store, workflow_runs
from novelvideo.freezone.agent_product_operations import (
    list_agent_product_operations_for_session,
    read_agent_product_operation,
)
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
        {"command_index": 0, "node_id": "image", "action": "generate_image",
         "label": "Image", "execution_mode": "task"},
        {"command_index": 0, "node_id": "text", "action": "generate_text",
         "label": "Text", "execution_mode": "inline"},
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


async def launch(setup, **kwargs):
    return await start.start_server_workflow_run(
        ctx=setup.ctx, state_dir=setup.root, canvas_id="default", plan=setup.plan,
        confirmation={"id": "confirmation-1", "agent_id": "main", "username": ""},
        actor_id="initiator", now=datetime(2026, 1, 1, tzinfo=timezone.utc), **kwargs,
    )


async def test_metered_image_and_text_are_runnable(setup):
    assert (await check(setup))["status"] == "runnable"


async def test_metered_text_requires_recipe_before_creation(setup):
    setup.canvas["nodes"][1]["data"] = {}
    canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"), setup.canvas)
    result = await check(setup)
    assert result["status"] == "runnable"
    assert result["refused"] == [{"node_id": "text", "action": "generate_text",
                                  "label": "Text", "reason": "recipe_required"}]
    assert workflow_runs.list_workflow_runs(project_dir=setup.root, canvas_id="default") == []


async def test_parameters_do_not_refuse_server_actions(setup):
    setup.plan["actions"][0]["parameters"] = {"prompt": "A tree"}
    assert await check(setup) == {"status": "runnable", "plan": setup.plan, "refused": []}


async def test_partial_unsupported_batch_is_runnable(setup):
    setup.plan["actions"][1]["action"] = "auto_compose_video"
    assert await check(setup) == {"status": "runnable", "plan": setup.plan, "refused": [
        {"node_id": "text", "action": "auto_compose_video", "label": "Text",
         "reason": "action_not_on_server"},
    ]}


async def test_every_action_unsupported_is_blocked(setup):
    setup.plan["actions"] = [dict(setup.plan["actions"][0], action="auto_compose_video")]
    assert await check(setup) == {"status": "blocked", "plan": setup.plan, "blocked": [
        {"node_id": "image", "action": "auto_compose_video", "label": "Image",
         "reason": "action_not_on_server"},
    ]}


async def test_empty_plan_is_runnable(setup):
    setup.plan.update(actions=[], levels=[])
    assert await check(setup) == {"status": "runnable", "plan": setup.plan, "refused": []}


@pytest.mark.parametrize("ordinary_image", [False, True])
async def test_start_refused_recipe_keeps_rows_filters_admission_and_invalidation(
    setup, monkeypatch, ordinary_image,
):
    setup.plan["actions"][0].update(parameters={"prompt": "A tree"},
                                     invalidation_reason="upstream_changed")
    setup.plan["actions"][1]["invalidation_reason"] = "upstream_changed"
    if ordinary_image:
        setup.canvas["nodes"][0]["data"] = {}
        canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"),
                                       setup.canvas)
    refused = [{"node_id": "text", "action": "generate_text", "label": "Text",
                "reason": "recipe_required"}]
    admission = routes.admit_canvas_workflow_run_actions
    payloads = []

    async def admit(**kwargs):
        payloads.append(deepcopy(kwargs.get("actions", kwargs.get("run", {}).get("actions"))))
        return await admission(**kwargs)

    monkeypatch.setattr(routes, "admit_canvas_workflow_run_actions", admit)
    run = await launch(setup, refused=refused)
    assert [(a["node_id"], a["action"], a["status"]) for a in run["actions"]] == [
        ("image", "generate_image", "pending"), ("text", "generate_text", "pending"),
    ]
    assert run["metadata"]["action_manifest"] == [
        {"command_index": 0, "node_id": "image", "action": "generate_image", "label": "Image",
         "execution_mode": "task", "parameters": {"prompt": "A tree"}},
        {"command_index": 0, "node_id": "text", "action": "generate_text", "label": "Text",
         "execution_mode": "inline", "refusal": {
             "code": "canvas_open_required", "reason": "recipe_required"}},
    ]
    expected_action = {"node_id": "image", "action": "generate_image",
                       "generation_attempt_id":
                           "canvas-confirmation:confirmation-1:image:generate_image"}
    if not ordinary_image:
        expected_action.update(recipe_id="image-recipe", recipe_version="1.2.0")
    assert payloads[0] == [expected_action]
    assert [[(a["node_id"], a["action"]) for a in rows] for rows in payloads] == [
        [("image", "generate_image")], [("image", "generate_image")],
    ]
    assert [{key: row[key] for key in expected_action} for row in payloads[1]] == [expected_action]
    assert payloads[1][0]["product_operation_id"] is None
    assert run["actions"][1]["product_operation_id"] is None
    operations = list_agent_product_operations_for_session(
        project_dir=setup.root, generation_session_id=run["run_id"],
    )
    assert [(op["artifact_id"], op["product_kind"]) for op in operations] == (
        [] if ordinary_image else [("image", "recipe_result")]
    )
    assert [q["task_type"] for q in setup.queued] == (
        ["freezone_workflow_drive"] if ordinary_image else
        ["freezone_agent_recipe_result", "freezone_workflow_drive"]
    )
    assert setup.meter.calls == []
    canvas = canvas_store.read_canvas(setup.root, "default")
    assert canvas["nodes"][0]["data"]["workflowResultStale"] is True
    assert "workflowResultStale" not in canvas["nodes"][1]["data"]


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


@pytest.mark.parametrize('enqueue_fails', [False, True])
async def test_start_counts_only_successfully_enqueued_drives(setup, monkeypatch, enqueue_fails):
    register_port('usage_meter', NoOpUsageMeter())
    if enqueue_fails:
        async def full(*args, **kwargs):
            raise RuntimeError('queue is full')

        monkeypatch.setattr(start, 'enqueue_server_workflow_drive', full)
    run = await launch(setup)
    persisted = workflow_runs.read_workflow_run(
        project_dir=setup.root, canvas_id='default', run_id=run['run_id'],
    )
    metadata = persisted['metadata']
    assert metadata.get('drive_generation', 0) == (0 if enqueue_fails else 1)
    assert metadata.get('drive_enqueue_failures', 0) == (1 if enqueue_fails else 0)
    if enqueue_fails:
        assert metadata['drive_last_enqueue_error'] == 'RuntimeError'
    else:
        assert setup.queued[0]['attempt'] == 1


@pytest.mark.parametrize('enqueue_fails', [False, True])
async def test_start_survives_drive_accounting_failure(setup, monkeypatch, caplog, enqueue_fails):
    register_port('usage_meter', NoOpUsageMeter())

    def broken(**kwargs):
        raise RuntimeError('private diagnostic must not be logged')

    if enqueue_fails:
        async def full(*args, **kwargs):
            raise RuntimeError('queue is full')

        monkeypatch.setattr(start, 'enqueue_server_workflow_drive', full)
    helper = ('record_server_workflow_drive_enqueue_failed' if enqueue_fails else
              'acknowledge_server_workflow_drive')
    monkeypatch.setattr(start, helper, broken, raising=False)
    run = await launch(setup)
    assert run['status'] == 'running'
    assert any(f"run_id={run['run_id']}" in record.getMessage()
               and record.levelname in {'WARNING', 'ERROR'} for record in caplog.records)
    assert 'private diagnostic' not in caplog.text


async def test_audio_translate_on_text_is_refused(setup):
    setup.plan["actions"] = [dict(setup.plan["actions"][1], action="translate_text")]
    assert await check(setup) == {"status": "blocked", "plan": setup.plan, "blocked": [{
        "node_id": "text", "action": "translate_text", "label": "Text",
        "reason": "action_not_on_server",
    }]}


async def test_image_audio_translate_batch_is_runnable(setup):
    setup.canvas["nodes"][1]["type"] = "audioNode"
    canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"), setup.canvas)
    setup.plan["actions"] = [setup.plan["actions"][0],
                             dict(setup.plan["actions"][1], action="generate_audio"),
                             dict(setup.plan["actions"][1], action="translate_text")]
    register_port("usage_meter", NoOpUsageMeter())
    assert await check(setup) == {"status": "runnable", "plan": setup.plan, "refused": []}
    actions = start._server_run_actions(setup.canvas, setup.plan, "confirmation")
    assert actions == [
        {"node_id": "image", "action": "generate_image", "recipe_id": "image-recipe",
         "recipe_version": "1.2.0", "generation_attempt_id": "confirmation:image:generate_image"},
        {"node_id": "text", "action": "generate_audio", "recipe_id": "text-recipe",
         "recipe_version": "1.2.0", "generation_attempt_id": "confirmation:text:generate_audio"},
        {"node_id": "text", "action": "translate_text", "recipe_id": "text-recipe",
         "recipe_version": "1.2.0", "generation_attempt_id": "confirmation:text:translate_text"},
    ]


@pytest.mark.parametrize("data,reason", [
    ({}, None), ({"count": 2}, "video_count"),
    ({"storyRole": "start", "continuityMode": "auto"}, "video_story_continuity"),
])
async def test_video_check_support_and_manifest_refusals(setup, data, reason):
    node = setup.canvas["nodes"][1]
    node.update(type="videoNode", data=data)
    setup.plan["actions"][1].update(action="generate_video", label="Video", execution_mode="task")
    canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"), setup.canvas)
    assert await check(setup) == {"status": "runnable", "plan": setup.plan, "refused": ([{
        "node_id": "text", "action": "generate_video", "label": "Video", "reason": reason,
    }] if reason else [])}


async def test_image_tool_support_attempt_and_no_source_invalidation(setup):
    setup.canvas["nodes"][0].update(type="imageNode", data={"imageUrl": "/static/a.png"})
    canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"), setup.canvas)
    setup.plan["actions"] = [dict(setup.plan["actions"][0], action="run_outpaint_tool",
                                  invalidation_reason="upstream_changed")]
    setup.plan["levels"] = [[0]]
    assert await check(setup) == {"status": "runnable", "plan": setup.plan, "refused": []}
    run = await launch(setup)
    assert run["actions"][0]["generation_attempt_id"] == (
        "canvas-confirmation:confirmation-1:image:run_outpaint_tool"
    )
    assert canvas_store.read_canvas(setup.root, "default")["nodes"] == setup.canvas["nodes"]
    assert [q["task_type"] for q in setup.queued] == ["freezone_workflow_drive"]


async def test_image_tool_batch_refuses_scene_matting_and_text_source(setup):
    names = ["run_outpaint_tool", "run_scene360_tool", "run_matting_tool"]
    setup.plan["actions"] = [dict(setup.plan["actions"][0], action=name) for name in names] + [
        dict(setup.plan["actions"][1], action="run_upscale_tool"),
    ]
    result = await check(setup)
    assert result["status"] == "runnable"
    assert [(r["action"], r["reason"]) for r in result["refused"]] == [
        (name, "action_not_on_server") for name in [
            "run_scene360_tool", "run_matting_tool", "run_upscale_tool",
        ]
    ]


@pytest.mark.parametrize("node_type,catalog,metered,reason", [
    ("threeDWorldNode", {}, False, None),
    ("threeDWorldNode", "invalid", False, None),
    ("imageGenNode", {}, False, "action_not_on_server"),
    ("threeDWorldNode", {"recipeId": " world "}, False, "world_recipe"),
    ("threeDWorldNode", {"recipeId": " world "}, True, "world_recipe"),
])
async def test_world_admission_and_attempt(setup, node_type, catalog, metered, reason):
    setup.canvas["nodes"][1].update(type=node_type, data={"workflowCatalog": catalog})
    setup.plan["actions"][1].update(action="generate_3gs_world")
    canvas_store.atomic_write_json(canvas_store.canvas_path(setup.root, "default"), setup.canvas)
    if not metered:
        register_port("usage_meter", NoOpUsageMeter())
    result = await check(setup)
    assert result == {"status": "runnable", "plan": setup.plan, "refused": ([{
        "node_id": "text", "action": "generate_3gs_world", "label": "Text", "reason": reason,
    }] if reason else [])}
    actions = start._server_run_actions(setup.canvas, setup.plan, "confirmation")
    assert actions[1]["generation_attempt_id"] == "confirmation:text:generate_3gs_world"

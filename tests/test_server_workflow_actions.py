# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Server actions exercise the actual canvas worker without provider calls."""

import asyncio
from copy import deepcopy
from pathlib import Path
import shutil

import pytest

from novelvideo.freezone.canvas_core_pool import CanvasCorePool
from novelvideo.freezone.server_workflow_actions import (
    ActionLeaseLost,
    ServerActionHttpError,
    WorkflowActionRunner,
)
from novelvideo.freezone.workflow_runs import create_workflow_run, update_workflow_run

BUNDLE = Path(__file__).resolve().parents[1] / "frontend/dist-canvas-server/canvas-core-worker.mjs"
pytestmark = pytest.mark.skipif(
    not BUNDLE.is_file() or shutil.which("node") is None,
    reason="Build frontend with pnpm run build:canvas-server and put Node 22 on PATH",
)
TASK = {"task_key": "freezone_gen:project:j1", "task_type": "freezone_gen", "job_id": "j1"}
URL = "/api/projects/project/static/fz/a.png"
CLEAR = {
    "isGenerating": False, "generationStartedAt": None, "generationTaskKey": None,
    "generationTaskType": None, "generationTaskJobId": None,
    "generationOwner": None, "generationRunId": None,
}


class FakeHost:
    locale = "zh"

    def __init__(self):
        self.canvas = {"nodes": [{"id": "n", "type": "imageGenNode",
                                "position": {"x": 0, "y": 0}, "data": {"prompt": "A ship"}}],
                       "edges": []}
        self.patches = []
        self.requests = []
        self.responses = [TASK]
        self.media_links = []
        self.statuses = [{"status": "running"},
                         {"status": "completed", "result": {"output_url": URL}}]
        self.fallback = "/api/projects/project/static/fz/fallback.png"
        self.held = True
        self.lose_on_outcome = False
        self.stopped = False
        self.clock = 0.0

    @property
    def data(self):
        return self.canvas["nodes"][0]["data"]

    def lease_held(self):
        return self.held

    async def catalogs(self):
        return {"image": {"models": [{"id": "image-model", "model": "image-model",
                                     "provider": "openai", "label": "Image"}]}}

    async def read_canvas(self):
        return deepcopy(self.canvas)

    async def patch_node(self, node_id, patch):
        if self.lose_on_outcome and patch.get("isGenerating") is False:
            self.held = False
            raise ActionLeaseLost()
        self.patches.append(deepcopy(patch))
        self.data.update(patch)

    async def request(self, method, path, body, *, media_link=None):
        self.requests.append({"method": method, "path": path, "body": deepcopy(body)})
        self.media_links.append(media_link)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    async def task_status(self, task):
        assert task == TASK
        return self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]

    async def job_result_url(self, task):
        assert task == TASK
        return self.fallback

    async def lane_capacity(self, lane):
        return 2 if lane == "image" else None

    async def sleep(self, seconds):
        self.clock += seconds


@pytest.fixture
def setup_runner():
    pool = CanvasCorePool(BUNDLE, size=1)
    host = FakeHost()

    async def core_call(op, payload):
        return await asyncio.to_thread(pool.call, op, payload)

    runner = WorkflowActionRunner(
        host=host, project_id="project", canvas_id="default", run_id="run-1",
        core_call=core_call, sleep=host.sleep, monotonic=lambda: host.clock,
        now_ms=lambda: 0, poll_seconds=2, task_timeout_seconds=4,
    )
    phases, accepted = [], []

    async def on_phase(value):
        phases.append(value)

    async def on_accepted(value):
        accepted.append(value)

    async def run(action="generate_image", existing_task=None, should_stop=None, **kwargs):
        return await runner.run_action(
            node_id="n", action=action, existing_task=existing_task,
            on_accepted=on_accepted, on_phase=on_phase,
            should_stop=should_stop or (lambda: host.stopped), **kwargs,
        )

    yield host, runner, run, phases, accepted
    pool.close()


def assert_cleared(host):
    assert host.data["isGenerating"] is False
    assert host.data["generationOwner"] is None
    assert host.data["generationRunId"] is None


def assert_durable(tmp_path, action, artifact):
    run = create_workflow_run(
        project_dir=tmp_path, project_id="project", canvas_id="default",
        actions=[{"node_id": "n", "action": action}], owner_kind="server", runner_id="runner",
    )
    updated = update_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"],
        owner_kind="server", runner_id="runner",
        action_updates=[{"node_id": "n", "action": action,
                         "status": "completed", "result": artifact}],
    )
    assert updated["actions"][0]["status"] == "completed"


async def test_image_prompt_and_durable_result(setup_runner, tmp_path):
    host, _, run, phases, accepted = setup_runner
    result = await run()
    assert result == {"status": "completed", "artifact": {"output_url": URL},
                      "output": {**TASK, "imageUrl": URL, "imageUrls": [URL]}}
    assert len(host.requests) == 1
    assert host.requests[0]["path"] == "projects/project/freezone/gen"
    assert host.requests[0]["body"]["prompt"] == "A ship"
    assert phases == ["submitting", "generating"]
    assert accepted == [TASK]
    assert host.data["imageUrl"] == URL
    assert {key: host.data[key] for key in (
        "workflowResultStale", "workflowInvalidatedAt", "workflowInvalidationReason",
        "workflowGeneratedAt",
    )} == {"workflowResultStale": False, "workflowInvalidatedAt": None,
           "workflowInvalidationReason": None, "workflowGeneratedAt": "1970-01-01T00:00:00.000Z"}
    assert host.patches[0]["generationOwner"] == "server"
    assert host.patches[0]["generationRunId"] == "run-1"
    assert_cleared(host)
    assert_durable(tmp_path, "generate_image", result["artifact"])


async def test_image_recipe(setup_runner):
    host, _, run, phases, _ = setup_runner
    host.data["workflowCatalog"] = {"recipeId": "r"}
    host.responses.insert(0, {"prompt": "Compiled", "compile_mode": "model", "recipe_ids": ["r"]})
    assert (await run())["status"] == "completed"
    assert [r["path"] for r in host.requests] == [
        "freezone/recipes/compile", "projects/project/freezone/gen",
    ]
    assert host.requests[1]["body"]["prompt"] == "Compiled"
    assert phases == ["compiling_recipe", "submitting", "generating"]
    assert any(p.get("workflowRecipeCompiledPrompt") == "Compiled" for p in host.patches)
    assert host.data["workflowRecipeCompiledAt"] == "1970-01-01T00:00:00.000Z"


@pytest.mark.parametrize("recipe", [True, False])
async def test_request_error_clears_node(setup_runner, recipe):
    host, _, run, _, _ = setup_runner
    if recipe:
        host.data["workflowCatalog"] = {"recipeId": "r"}
    host.responses = [ServerActionHttpError("HTTP 400: bad recipe")]
    assert await run() == {"status": "failed", "error": "HTTP 400: bad recipe"}
    assert len(host.requests) == 1
    assert_cleared(host)


async def test_resume_never_submits(setup_runner):
    host, _, run, phases, accepted = setup_runner
    host.data.update({"generationTaskKey": TASK["task_key"], "generationRunId": "run-1"})
    assert (await run(existing_task=TASK))["artifact"] == {"output_url": URL}
    assert host.requests == []
    assert phases == ["generating"]
    assert accepted == []
    assert_cleared(host)


async def test_failed_task(setup_runner):
    host, _, run, _, _ = setup_runner
    host.statuses = [{"status": "failed", "error": "HTTP 503: upstream busy"}]
    assert await run() == {"status": "failed", "error": "HTTP 503: upstream busy"}
    assert "workflowGeneratedAt" not in host.data
    assert "workflowResultStale" not in host.data
    assert "workflowInvalidatedAt" not in host.data
    assert "workflowInvalidationReason" not in host.data
    assert host.data["generationError"] == "HTTP 503: upstream busy"
    assert host.data["generationErrorDetails"] == "HTTP 503: upstream busy"
    assert_cleared(host)


async def test_fallback_url_is_durable(setup_runner, tmp_path):
    host, _, run, _, _ = setup_runner
    host.statuses = [{"status": "completed", "result": {}}]
    result = await run()
    assert result["status"] == "completed"
    assert result["artifact"] == {"output_url": host.fallback}
    assert host.data["imageUrl"] == host.fallback
    assert_durable(tmp_path, "generate_image", result["artifact"])


@pytest.mark.parametrize("held", [True, False])
async def test_cancel_while_waiting(setup_runner, held):
    host, _, run, _, _ = setup_runner

    async def status(task):
        host.stopped = True
        host.held = held
        return {"status": "running"}

    host.task_status = status
    assert await run() == {"status": "stopped"}
    if held:
        assert host.patches[-1] == CLEAR
    else:
        assert host.patches[-1] == {
            "generationTaskKey": TASK["task_key"], "generationTaskType": "freezone_gen",
            "generationTaskJobId": "j1",
        }


async def test_outcome_lease_loss_has_no_followup_write(setup_runner):
    host, _, run, _, _ = setup_runner
    host.lose_on_outcome = True
    assert await run() == {"status": "stopped"}
    assert host.patches[-1] == {
        "generationTaskKey": TASK["task_key"], "generationTaskType": "freezone_gen",
        "generationTaskJobId": "j1",
    }


async def test_timeout_with_injected_clock(setup_runner):
    host, _, run, _, _ = setup_runner
    host.statuses = [None]
    assert await run() == {"status": "failed", "error": "图片生成超时"}
    assert_cleared(host)


async def test_text_and_durable_result(setup_runner, tmp_path):
    host, _, run, phases, accepted = setup_runner
    host.canvas["nodes"][0]["type"] = "textAnnotationNode"
    host.data.update({"content": "Write", "workflowCatalog": {"recipeId": "r"}})
    host.responses = [{"content": "Hello"}]
    result = await run("generate_text", existing_task=TASK)
    assert result == {"status": "completed", "output": {"content": "Hello"},
                      "artifact": {"content": "Hello"}}
    assert [r["path"] for r in host.requests] == ["freezone/recipes/generate-text"]
    assert host.data["content"] == "Hello"
    assert {key: host.data[key] for key in (
        "workflowResultStale", "workflowInvalidatedAt", "workflowInvalidationReason",
        "workflowGeneratedAt",
    )} == {"workflowResultStale": False, "workflowInvalidatedAt": None,
           "workflowInvalidationReason": None, "workflowGeneratedAt": "1970-01-01T00:00:00.000Z"}
    assert phases == ["generating"]
    assert accepted == []
    assert_cleared(host)
    assert_durable(tmp_path, "generate_text", result["artifact"])


async def test_text_missing_recipe(setup_runner):
    host, _, run, _, _ = setup_runner
    host.canvas["nodes"][0]["type"] = "textAnnotationNode"
    assert await run("generate_text") == {"status": "failed", "error": "文本节点缺少 Recipe"}
    assert host.requests == []


async def test_supported_actions_and_capacity(setup_runner):
    _, runner, _, _, _ = setup_runner
    assert runner.supports("generate_image") is True
    assert runner.supports("generate_text") is True
    assert runner.supports("generate_video") is False
    assert runner.supports("run_skill") is False
    assert await runner.lane_capacity("image") == 2
    assert await runner.lane_capacity("unknown") is None


@pytest.mark.parametrize("existing", [False, True])
async def test_workflow_variants_share_one_task(setup_runner, existing):
    host, _, run, _, _ = setup_runner
    host.data["count"] = 4
    host.statuses = [{"status": "completed", "result": {"output_urls": [URL, "/static/b.png"]}}]
    result = await run(existing_task=TASK if existing else None)
    assert result["status"] == "completed"
    assert result["artifact"] == {"output_urls": [URL, "/static/b.png"]}
    assert host.data["generationBatch"] == [URL, "/static/b.png"]
    if existing:
        assert host.requests == []
    else:
        assert len(host.requests) == 1
        assert host.requests[0]["body"]["variant_count"] == 4


@pytest.mark.parametrize("owned", [True, False])
async def test_cancel_before_start_only_clears_this_run(setup_runner, owned):
    host, _, run, _, _ = setup_runner
    host.stopped = True
    host.data["generationRunId"] = "run-1" if owned else "another-run"
    assert await run(existing_task=TASK) == {"status": "stopped"}
    assert host.requests == []
    assert host.patches == [CLEAR] if owned else host.patches == []


async def test_text_http_failure_clears_owner(setup_runner):
    host, _, run, _, _ = setup_runner
    host.canvas["nodes"][0]["type"] = "textAnnotationNode"
    host.data.update({"content": "Original", "workflowCatalog": {"recipeId": "r"}})
    host.responses = [ServerActionHttpError("HTTP 400: bad recipe")]
    assert await run("generate_text") == {"status": "failed", "error": "HTTP 400: bad recipe"}
    assert "workflowGeneratedAt" not in host.data
    assert "workflowResultStale" not in host.data
    assert host.data["content"] == "Original"
    assert host.data["generationError"] == "HTTP 400: bad recipe"
    assert_cleared(host)


@pytest.mark.parametrize("action", ["generate_image", "generate_text"])
@pytest.mark.parametrize("operation_id", ["operation-1", None])
async def test_core_product_operation_payload(setup_runner, action, operation_id):
    host, runner, _, _, _ = setup_runner
    host.data["workflowCatalog"] = {"recipeId": "r"}
    if action == "generate_image":
        host.responses.insert(0, {"prompt": "Compiled", "compile_mode": "model",
                                  "recipe_ids": ["r"]})
    else:
        host.canvas["nodes"][0]["type"] = "textAnnotationNode"
        host.responses = [{"content": "A story"}]
    payloads = []
    core = runner.core_call

    async def capture(op, payload):
        if op in {"image_generation_request", "recipe_compile_request", "text_generation_request"}:
            payloads.append((op, deepcopy(payload["env"]["productOperation"])))
        return await core(op, payload)

    async def accepted(task):
        pass

    async def phase(value):
        pass

    runner.core_call = capture
    result = await runner.run_action(
        node_id="n", action=action, existing_task=None, on_accepted=accepted,
        on_phase=phase, should_stop=lambda: False,
        **({"product_operation_id": operation_id, "generation_attempt_id": "attempt-1"}
           if operation_id else {}),
    )
    assert result["status"] == "completed"
    expected = ({"projectId": "project", "operationId": "operation-1",
                 "generationAttemptId": "attempt-1"} if operation_id else None)
    assert payloads == ([("image_generation_request", expected),
                         ("recipe_compile_request", expected),
                         ("image_generation_request", expected)] if action == "generate_image"
                        else [("text_generation_request", expected)])


@pytest.mark.parametrize("recipe", [False, True])
async def test_image_submission_media_link(setup_runner, recipe):
    host, _, run, _, _ = setup_runner
    if recipe:
        host.data["workflowCatalog"] = {"recipeId": "r"}
        host.responses.insert(0, {
            "prompt": "Compiled", "compile_mode": "model", "recipe_ids": ["r"],
        })
    assert (await run(
        generation_attempt_id="attempt-1", product_operation_id="operation-1" if recipe else None,
    ))["status"] == "completed"
    assert host.media_links == ([None, None] if recipe else [{
        "run_id": "run-1", "node_id": "n", "generation_attempt_id": "attempt-1",
    }])


@pytest.mark.parametrize("recipe", [False, True])
@pytest.mark.parametrize("errors", [[], ["HTTP 503: workflow media submission is still starting",
                                       "HTTP 503: workflow media submission is being recovered"]])
async def test_missing_takeover_task_resubmits_identical_request(setup_runner, recipe, errors):
    host, _, run, _, accepted = setup_runner
    # A stale compiled prompt must never override the ordinary node's fallback prompt.
    host.data["workflowRecipeCompiledPrompt"] = "Old compiled prompt"
    if recipe:
        host.data["workflowCatalog"] = {"recipeId": "r"}
        host.responses.insert(0, {
            "prompt": "Compiled", "compile_mode": "model", "recipe_ids": ["r"],
        })
    kwargs = {"generation_attempt_id": "attempt-1",
              "product_operation_id": "operation-1" if recipe else None}
    assert (await run(**kwargs))["status"] == "completed"
    first = deepcopy(host.requests[-1])
    assert first["body"]["prompt"] == ("Compiled" if recipe else "A ship")
    host.requests.clear()
    host.media_links.clear()
    accepted.clear()
    host.statuses = [None, {"status": "completed", "result": {"output_url": URL}}]
    host.responses = [*(ServerActionHttpError(e) for e in errors), TASK]
    assert (await run(existing_task=TASK, **kwargs))["artifact"] == {"output_url": URL}
    assert host.requests == [first] * (len(errors) + 1)
    assert accepted == [TASK]
    link = None if recipe else {
        "run_id": "run-1", "node_id": "n", "generation_attempt_id": "attempt-1",
    }
    assert host.media_links == [link] * (len(errors) + 1)
    assert host.clock == 2 + len(errors) * 2


@pytest.mark.parametrize("error,expected", [
    ("HTTP 409: changed claim", "HTTP 409: changed claim"),
    ("HTTP 503: upstream busy", "HTTP 503: upstream busy"),
    ("HTTP 503: workflow media submission is still starting", "图片生成超时"),
])
async def test_missing_takeover_task_submission_errors(setup_runner, error, expected):
    host, _, run, _, _ = setup_runner
    host.statuses = [None]
    host.responses = [ServerActionHttpError(error)] * 4
    assert await run(existing_task=TASK, generation_attempt_id="attempt-1") == {
        "status": "failed", "error": expected,
    }

# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Server actions exercise the actual canvas worker without provider calls."""

import asyncio
from copy import deepcopy
import subprocess
import uuid

import pytest

from novelvideo.freezone.canvas_core_pool import CanvasCorePool
from novelvideo.freezone.server_workflow_actions import (
    ActionLeaseLost,
    ServerActionHttpError,
    WorkflowActionRunner,
)
from novelvideo.freezone.workflow_runs import create_workflow_run, update_workflow_run

from tests.canvas_core_requirements import CANVAS_CORE_BUNDLE as BUNDLE
from tests.canvas_core_requirements import requires_canvas_core_bundle

pytestmark = requires_canvas_core_bundle
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
        self.patch_nodes = []
        self.additions = []
        self.requests = []
        self.task = TASK
        self.responses = [TASK]
        self.result = {}
        self.result_tasks = []
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

    async def catalogs(self, *, video=False):
        return {"image": {"models": [{"id": "image-model", "model": "image-model",
                                     "provider": "openai", "label": "Image"}]}}

    async def read_canvas(self):
        return deepcopy(self.canvas)

    async def patch_node(self, node_id, patch):
        if self.lose_on_outcome and patch.get("isGenerating") is False:
            self.held = False
            raise ActionLeaseLost()
        self.patch_nodes.append(node_id)
        self.patches.append(deepcopy(patch))
        next(n["data"] for n in self.canvas["nodes"] if n["id"] == node_id).update(patch)

    async def add_nodes(self, nodes, edges):
        self.additions.append(deepcopy((nodes, edges)))
        self.canvas["nodes"].extend(deepcopy(nodes))
        self.canvas["edges"].extend(deepcopy(edges))

    async def request(self, method, path, body, *, media_link=None):
        self.requests.append({"method": method, "path": path, "body": deepcopy(body)})
        self.media_links.append(media_link)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    async def task_status(self, task):
        assert task == self.task
        return self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]

    async def job_result(self, task):
        self.result_tasks.append(task)
        return deepcopy(self.result)

    async def job_result_url(self, task):
        assert task == self.task
        return self.fallback

    async def lane_capacity(self, lane):
        return 2 if lane == "image" else None

    async def sleep(self, seconds):
        self.clock += seconds


@pytest.fixture(scope="session")
def source_bundle(tmp_path_factory):
    directory = tmp_path_factory.mktemp("image-tool-worker")
    subprocess.run([
        "./node_modules/.bin/vite", "build", "--config", "vite.canvas-server.config.ts",
        "--outDir", str(directory),
    ], cwd=BUNDLE.parents[1], check=True, capture_output=True)
    return directory / "canvas-core-worker.mjs"


@pytest.fixture
def setup_runner(source_bundle):
    pool = CanvasCorePool(source_bundle, size=1)
    host = FakeHost()

    async def core_call(op, payload):
        return await asyncio.to_thread(pool.call_value, op, payload)

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
    assert runner.supports("generate_video") is True
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
        "run_id": "run-1", "canvas_id": "default", "node_id": "n",
        "generation_attempt_id": "attempt-1",
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
        "run_id": "run-1", "canvas_id": "default", "node_id": "n",
        "generation_attempt_id": "attempt-1",
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


@pytest.mark.parametrize("owner,held", [("run-1", True), ("other-run", True), ("run-1", False)])
async def test_interrupt_action_clears_only_owned_node(setup_runner, owner, held, caplog):
    import logging

    host, runner, _, _, _ = setup_runner
    host.data.update({"generationRunId": owner, "generationOwner": "server",
                      "isGenerating": True, "generationTaskKey": "old-task"})
    original = deepcopy(host.data)
    host.held = held
    failed = []

    async def fail(operation_id):
        failed.append(operation_id)

    host.fail_product_operation = fail
    with caplog.at_level(logging.INFO):
        await runner.interrupt_action(
            node_id="n", action="generate_text", product_operation_id="agent_product_text",
        )
    assert host.data == ({**original, **CLEAR} if owner == "run-1" and held else original)
    assert host.requests == []
    assert failed == (["agent_product_text"] if held else [])
    if held:
        assert "Server workflow text interrupted run_id=run-1 node_id=n" in caplog.text


@pytest.mark.parametrize("status", ["failed", "cancelled"])
@pytest.mark.parametrize("matching", [True, False])
async def test_terminal_image_clears_only_matching_task_descriptor(setup_runner, status, matching):
    host, _, run, _, _ = setup_runner
    descriptor = {
        "generationTaskKey": TASK["task_key"] if matching else "another-task",
        "generationTaskType": "freezone_gen", "generationTaskJobId": "j1" if matching else "other",
    }
    host.data.update({**descriptor, "generationRunId": "run-1", "isGenerating": True})
    host.statuses = [{"status": status, "error": "Image task ended"}]
    await run(existing_task=TASK)
    assert {key: host.data[key] for key in descriptor} == ({
        "generationTaskKey": None, "generationTaskType": None, "generationTaskJobId": None,
    } if matching else descriptor)
    assert host.requests == []


async def test_completed_image_patch_stays_unchanged(setup_runner):
    host, _, run, _, _ = setup_runner
    host.data.update({"generationTaskKey": TASK["task_key"], "generationTaskType": "freezone_gen",
                      "generationTaskJobId": "j1", "generationRunId": "run-1"})
    host.statuses = [{"status": "completed", "result": {"output_url": URL}}]
    assert (await run(existing_task=TASK))["status"] == "completed"
    assert host.patches == [{
        "imageUrl": URL, "previewImageUrl": URL, "isGenerating": False,
        "generationStartedAt": None, "generationTaskKey": None, "generationTaskType": None,
        "generationTaskJobId": None, "generationError": None, "generationErrorDetails": None,
        "generationErrorRequestId": None, "generationOwner": None, "generationRunId": None,
        "workflowResultStale": False, "workflowInvalidatedAt": None,
        "workflowInvalidationReason": None, "workflowGeneratedAt": "1970-01-01T00:00:00.000Z",
    }]


AUDIO_URL = "/api/projects/project/static/fz/audio.mp3"
AUDIO_TASK = {"task_key": "freezone_audio_speech:project:j1",
              "task_type": "freezone_audio_speech", "job_id": "j1"}
TRANSLATE_TASK = {"task_key": "freezone_text_translate:project:j1",
                  "task_type": "freezone_text_translate", "job_id": "j1"}
MISSING_NARRATION = (
    "旁白节点缺少上游生成的文本，已停止提交 TTS 请求；请先完成剧本/Beat 文本生成后重试。"
)
SPEECH_BODY = {
    "canvas_id": "default", "node_id": "n", "text": "Hello", "speech_mode": "preset",
    "preset_model": "edge-tts", "preset_voice": "Serena", "emotion_prompt": "",
    "voice_ref": {"scope": "project_narrator", "character_name": "", "identity_id": "",
                  "slot": "", "voice_id": ""},
}


def audio_host(host, *, translate=False):
    host.canvas["nodes"][0].update(type="audioNode", data={
        "text": "Hello", "audioUrl": None, "speechMode": "preset",
    })
    host.task = TRANSLATE_TASK if translate else AUDIO_TASK
    host.responses = [host.task]
    host.statuses = [{"status": "completed", "result": {"output_url": "ignored"}}]
    host.result = {"translated_text": "你好"} if translate else {"url": AUDIO_URL}


async def test_audio_speech_submission_and_artifact(setup_runner, tmp_path):
    host, runner, run, phases, accepted = setup_runner
    audio_host(host)
    assert runner.supports("generate_audio") is True
    result = await run("generate_audio", generation_attempt_id="attempt-1")
    assert result == {"status": "completed", "output": {"audioUrl": AUDIO_URL},
                      "artifact": {"audio_url": AUDIO_URL}}
    assert host.requests == [{"method": "POST", "path": "projects/project/freezone/audio/speech",
                              "body": SPEECH_BODY}]
    assert host.media_links == [{"run_id": "run-1", "canvas_id": "default", "node_id": "n",
                                 "generation_attempt_id": "attempt-1"}]
    assert accepted == [AUDIO_TASK]
    assert phases == ["submitting", "generating"]
    assert {"generationTaskKey": AUDIO_TASK["task_key"],
            "generationTaskType": AUDIO_TASK["task_type"],
            "generationTaskJobId": "j1"} in host.patches
    assert host.result_tasks == [AUDIO_TASK]
    assert host.data["audioUrl"] == AUDIO_URL
    assert_cleared(host)
    assert_durable(tmp_path, "generate_audio", result["artifact"])


@pytest.mark.parametrize("task_result,expected", [
    pytest.param({"url": AUDIO_URL, "duration_ms": 4321}, 4321, id="positive-int"),
    pytest.param({"duration_ms": 1500.4}, 1500, id="positive-float"),
    pytest.param({"duration_ms": 0}, None, id="zero"),
    pytest.param({}, None, id="missing"),
    pytest.param({"duration_ms": True}, None, id="boolean"),
    pytest.param({"duration_ms": "4321"}, None, id="string"),
    pytest.param({"duration_ms": -5}, None, id="negative"),
])
async def test_audio_duration_from_task_result(setup_runner, task_result, expected):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.statuses = [{"status": "completed", "result": task_result}]
    result = await run("generate_audio")
    assert result["status"] == "completed"
    assert host.data["durationMs"] == expected


async def test_audio_stop_during_submission_keeps_accepted_task(setup_runner):
    host, _, run, _, accepted = setup_runner
    audio_host(host)
    submit = host.request

    async def request_then_stop(*args, **kwargs):
        response = await submit(*args, **kwargs)
        host.stopped = True
        return response

    host.request = request_then_stop
    result = await run("generate_audio", generation_attempt_id="attempt-1")
    assert result["status"] != "completed"
    assert accepted == [AUDIO_TASK]


async def test_audio_music(setup_runner):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.data.update(audioKind="music", text="Calm piano", musicLengthMs=12000)
    host.task = {**AUDIO_TASK, "task_type": "freezone_audio_eleven_music",
                 "task_key": "freezone_audio_eleven_music:project:j1"}
    host.responses = [host.task]
    assert (await run("generate_audio"))["output"] == {"audioUrl": AUDIO_URL}
    assert host.requests == [{"method": "POST",
                              "path": "projects/project/freezone/audio/eleven-music", "body": {
                                  "canvas_id": "default", "node_id": "n", "input": "Calm piano",
                                  "music_length_ms": 12000, "force_instrumental": True,
                                  "respect_sections_durations": True}}]
    assert host.result_tasks == [host.task]
    assert_cleared(host)


# The submitted text goes through the shared request builder, which puts each
# speakable line in its own paragraph exactly as the browser submission does.
@pytest.mark.parametrize("data,expected,body_text", [
    ({"content": " Content ", "text": "Text"}, "Content", "Content"),
    ({"text": " Spoken words "}, "Spoken words", "Spoken words"),
    ({"scriptResult": {"rows": [
        {"narration": " First ", "voiceover": "ignored"}, {"voiceover": "Second"},
        {"dialogue": "Third"}, {}, None,
    ]}}, "First\nSecond\nThird", "First\n\nSecond\n\nThird"),
])
async def test_audio_hydrates_incoming_edge_order(setup_runner, data, expected, body_text):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.data["text"] = " "
    host.canvas["nodes"] += [
        {"id": "last", "type": "textAnnotationNode", "position": {"x": 0, "y": 0},
         "data": {"content": "Last"}},
        {"id": "empty", "type": "textAnnotationNode", "position": {"x": 0, "y": 0}, "data": {}},
        {"id": "first", "type": "scriptNode", "position": {"x": 0, "y": 0}, "data": data},
    ]
    host.canvas["edges"] = [{"id": name, "source": name, "target": "n"}
                               for name in ("empty", "first", "last")]
    assert (await run("generate_audio"))["status"] == "completed"
    assert host.patches[0] == {"text": expected}
    assert host.requests[0]["body"]["text"] == body_text


async def test_audio_missing_narration_fails_without_submission(setup_runner):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.data["text"] = ""
    assert await run("generate_audio") == {"status": "failed", "error": MISSING_NARRATION}
    assert host.requests == []
    assert host.data["generationOwner"] is None
    assert host.data["generationRunId"] is None


async def test_audio_missing_voice_skips_without_submission(setup_runner):
    host, _, run, _, accepted = setup_runner
    audio_host(host)
    host.data.update(voicePolicyConfirmed=True, voiceAvailable=False)
    assert await run("generate_audio") == {
        "status": "skipped", "output": {"skipped": True, "reason": "missing_custom_voice"},
    }
    assert host.requests == []
    assert accepted == []
    assert_cleared(host)


@pytest.mark.parametrize("source", ["submission", "task"])
async def test_audio_voice_prerequisite_skips(setup_runner, source):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    if source == "submission":
        # Set public error attributes so this fixture also runs against the pre-step runner.
        error = ServerActionHttpError("HTTP 409: 请先配置或选择声线")
        error.status_code = 409
        error.info = {"name": "HttpError", "message": "请先配置或选择声线", "status": 409,
                      "display": "请先配置或选择声线", "details": None,
                      "requestId": None, "referenceIssues": []}
        host.responses = [error]
    else:
        host.statuses = [{"status": "failed", "error": "请先配置或选择声线"}]
    assert await run("generate_audio") == {"status": "skipped", "output": {
        "skipped": True, "reason": "missing_custom_voice",
        "agent_instruction": "未选择自定义声线，本音频节点已跳过，继续其它工作流节点。",
    }}
    assert host.data["voiceAvailable"] is False
    assert host.data["generationError"] == "未选择可用自定义声线，已跳过生成"
    assert host.data["generationTaskKey"] is None
    assert_cleared(host)


@pytest.mark.parametrize("recipe", [False, True, "literal"])
async def test_audio_recipe_and_product_operation(setup_runner, recipe):
    host, _, run, phases, _ = setup_runner
    audio_host(host)
    if recipe:
        host.data.update(workflowCatalog={"recipeId": "drama-shot-voice" if recipe == "literal"
                                         else "r"}, voiceAvailable=True,
                         voiceRef={"scope": "user_custom", "voiceId": "voice-1"})
    if recipe is True:
        host.responses.insert(0, {"prompt": "Compiled narration", "compile_mode": "model",
                                  "recipe_ids": ["r"]})
    assert (await run("generate_audio", generation_attempt_id="attempt-1",
                      product_operation_id="operation-1" if recipe else None)
            )["status"] == "completed"
    assert host.media_links == ([None, None] if recipe is True else [None] if recipe else [{
        "run_id": "run-1", "canvas_id": "default", "node_id": "n",
        "generation_attempt_id": "attempt-1",
    }])
    if recipe:
        assert host.requests[-1]["body"]["product_operation_id"] == "operation-1"
        assert host.requests[-1]["body"]["generation_attempt_id"] == "attempt-1"
    if recipe is True:
        assert host.requests[0]["path"] == "freezone/recipes/compile"
        assert host.requests[0]["body"]["product_operation_id"] == "operation-1"
        assert host.data["workflowRecipeCompiledPrompt"] == "Compiled narration"
        assert phases == ["compiling_recipe", "submitting", "generating"]
    else:
        assert [r["path"] for r in host.requests] == ["projects/project/freezone/audio/speech"]


@pytest.mark.parametrize("action", ["generate_audio", "translate_text"])
async def test_audio_takeover_existing_task_never_submits(setup_runner, action):
    host, _, run, phases, accepted = setup_runner
    audio_host(host, translate=action == "translate_text")
    host.data.update(isGenerating=True, generationOwner="server", generationRunId="run-1",
                     generationTaskKey=host.task["task_key"])
    host.data["text"] = ""  # Existing tasks require neither hydration nor a valid new request.
    assert (await run(action, existing_task=host.task))["status"] == "completed"
    assert host.requests == []
    assert host.result_tasks == [host.task]
    assert accepted == []
    assert phases == ["generating"]
    assert host.data["generationOwner"] is None


@pytest.mark.parametrize("action", ["generate_audio", "translate_text"])
@pytest.mark.parametrize("recipe", [False, True])
@pytest.mark.parametrize("recovering", [False, True])
async def test_audio_missing_task_resubmits_identical_body(
    setup_runner, action, recipe, recovering,
):
    host, _, run, _, accepted = setup_runner
    audio_host(host, translate=action == "translate_text")
    if recipe and action == "generate_audio":
        host.data.update(workflowCatalog={"recipeId": "r"}, voiceAvailable=True,
                         voiceRef={"scope": "user_custom", "voiceId": "voice-1"})
        host.responses.insert(0, {"prompt": "New narration", "compile_mode": "model",
                                  "recipe_ids": ["r"]})
    kwargs = {"generation_attempt_id": "attempt-1",
              "product_operation_id": "operation-1" if recipe and action == "generate_audio"
              else None}
    assert (await run(action, **kwargs))["status"] == "completed"
    first = deepcopy(host.requests[-1])
    host.requests.clear()
    accepted.clear()
    if action == "translate_text":
        host.data["text"] = "Hello"
    host.statuses = [None, {"status": "completed", "result": {}}]
    host.responses = ([
        ServerActionHttpError("HTTP 503: workflow media submission is still starting"),
        ServerActionHttpError("HTTP 503: workflow media submission is being recovered"),
    ]
                      if recovering else []) + [host.task]
    assert (await run(action, existing_task=host.task, **kwargs))["status"] == "completed"
    assert host.requests == [first] * (3 if recovering else 1)
    assert accepted == [host.task]


@pytest.mark.parametrize("status,error", [
    ("failed", "Audio failed"), ("cancelled", "任务已取消"), ("running", "音频生成超时"),
])
async def test_audio_terminal_failure_clears_stale_descriptor(setup_runner, status, error):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.statuses = [{"status": status, "error": "Audio failed" if status == "failed" else None}]
    assert await run("generate_audio") == {"status": "failed", "error": error}
    assert host.data["generationTaskKey"] is None
    assert host.data["generationTaskType"] is None
    assert host.data["generationTaskJobId"] is None
    assert_cleared(host)


async def test_audio_translate_writes_only_text(setup_runner, tmp_path):
    host, runner, run, phases, accepted = setup_runner
    audio_host(host, translate=True)
    assert runner.supports("translate_text") is True
    assert await run("translate_text", generation_attempt_id="attempt-1") == {
        "status": "completed", "output": {"text": "你好"}, "artifact": {"content": "你好"},
    }
    assert host.requests == [{"method": "POST", "path": "projects/project/freezone/text/translate",
                              "body": {"text": "Hello", "node_type": "audio",
                                       "canvas_id": "default", "node_id": "n"}}]
    assert host.media_links == [{"run_id": "run-1", "canvas_id": "default", "node_id": "n",
                                 "generation_attempt_id": "attempt-1"}]
    assert host.patches == [{"text": "你好", "generationOwner": None, "generationRunId": None}]
    assert host.result_tasks == [TRANSLATE_TASK]
    assert accepted == [TRANSLATE_TASK]
    assert phases == ["submitting", "generating"]
    assert_durable(tmp_path, "translate_text", {"content": "你好"})


@pytest.mark.parametrize("data", [{}, {"translated_text": ""}, {"translated_text": None},
                                  {"translated_text": 4}, {"translated_text": "   "}])
async def test_audio_translate_missing_result_fails(setup_runner, data):
    host, _, run, _, _ = setup_runner
    audio_host(host, translate=True)
    host.result = data
    assert await run("translate_text") == {"status": "failed", "error": "翻译任务未返回译文"}
    assert host.data["text"] == "Hello"
    assert host.data["generationOwner"] is None
    assert not any("generationTaskKey" in p for p in host.patches)


async def test_audio_translate_defensively_refuses_text_node(setup_runner):
    host, _, run, _, _ = setup_runner
    host.canvas["nodes"][0]["type"] = "textAnnotationNode"
    assert await run("translate_text") == {
        "status": "failed", "error": "Unsupported server action: translate_text",
    }
    assert host.requests == []


async def test_audio_recipe_submission_uses_captured_snapshot(setup_runner):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.data.update(workflowCatalog={"recipeId": "r"}, voiceAvailable=True,
                     voiceRef={"scope": "user_custom", "voiceId": "voice-1"})
    host.responses.insert(0, {"prompt": "New narration", "compile_mode": "model",
                              "recipe_ids": ["r"]})
    request = host.request

    async def edit_during_compile(method, path, body, **kwargs):
        result = await request(method, path, body, **kwargs)
        if path == "freezone/recipes/compile":
            host.data["text"] = "Changed during compilation"
        return result

    host.request = edit_during_compile
    assert (await run("generate_audio"))["status"] == "completed"
    assert host.requests[-1]["body"]["text"] == "Hello"
    assert host.data["text"] == "Hello"


async def test_audio_busy_refusal_clears_owner(setup_runner):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.data.update(isGenerating=True, generationOwner="server", generationRunId="run-1")
    assert await run("generate_audio") == {
        "status": "failed", "error": "Audio generation is already in progress.",
    }
    assert host.requests == []
    assert host.data["generationOwner"] is None
    assert host.data["generationRunId"] is None


async def test_audio_compile_failure_clears_node(setup_runner):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.data.update(workflowCatalog={"recipeId": "r"}, voiceAvailable=True,
                     voiceRef={"scope": "user_custom", "voiceId": "voice-1"})
    host.responses = [ServerActionHttpError("HTTP 400: bad recipe")]
    assert await run("generate_audio") == {"status": "failed", "error": "HTTP 400: bad recipe"}
    assert [r["path"] for r in host.requests] == ["freezone/recipes/compile"]
    assert_cleared(host)


VIDEO_URL = "/static/new.mp4"
VIDEO_TASK = {"task_key": "freezone_video_gen:project:j1",
              "task_type": "freezone_video_gen", "job_id": "j1"}
VIDEO_MODEL = {
    "id": "video-model", "apiModel": "video-model", "providerId": "seedance",
    "supportedModes": ["text_to_video", "image_to_video", "keyframe", "video_edit",
                       "video_extend", "all_reference"],
    "referenceImageMax": 9, "referenceVideoMax": 1, "referenceAudioMax": 1,
}
OPEN_VIDEO = "工作流动作 generate_video 需要打开画布运行"
CURRENT = {"workflowResultStale": False, "workflowInvalidatedAt": None,
           "workflowInvalidationReason": None, "workflowGeneratedAt": "1970-01-01T00:00:00.000Z"}


def video_host(host, *, upscale=False):
    host.canvas["nodes"][0].update(type="videoNode", data={
        "prompt": "A ship", "model": "video-model", "genMode": "textToVideo",
        "videoUrl": "/static/old.mp4", "workflowResultStale": True,
    })
    host.task = VIDEO_TASK
    if upscale:
        host.data.update(isUpscaleNode=True, upscaleSourceUrl="/static/source.mp4?version=1")
        host.task = {**VIDEO_TASK, "task_key": "freezone_video_upscale:project:j1",
                     "task_type": "freezone_video_upscale"}
    host.responses = [host.task]
    host.statuses = [{"status": "running"},
                     {"status": "completed", "result": {"output_url": VIDEO_URL}}]

    async def catalogs(*, video=False):
        assert video is True
        return {"video": {"models": [VIDEO_MODEL]}, "camera_templates": []}

    host.catalogs = catalogs


@pytest.mark.parametrize("upscale", [False, True])
async def test_video_submission_fresh_result_and_owner(setup_runner, upscale, caplog):
    import logging

    host, _, run, phases, accepted = setup_runner
    video_host(host, upscale=upscale)
    if upscale:
        host.data["upscaleEnhancementModel"] = "topaz"
    with caplog.at_level(logging.INFO):
        result = await run("generate_video", generation_attempt_id="attempt-1")
    assert result == {"status": "completed", "output": {"videoUrl": VIDEO_URL},
                      "artifact": {"output_url": VIDEO_URL}}
    assert [r["path"] for r in host.requests] == [
        "projects/project/freezone/video/" + ("upscale" if upscale else "gen"),
    ]
    if upscale:
        assert host.requests[0]["body"]["enhancement_model"] == "topaz"
    assert host.requests[0]["body"]["canvas_id"] == "default"
    assert host.requests[0]["body"]["node_id"] == "n"
    assert host.media_links == [{"run_id": "run-1", "canvas_id": "default", "node_id": "n",
                                 "generation_attempt_id": "attempt-1"}]
    assert phases == ["submitting", "generating"]
    assert accepted == [host.task]
    assert host.patches[0]["generationOwner"] == "server"
    assert host.patches[0]["generationStartedAt"] == 0
    assert host.patches[0]["isGenerating"] is True
    assert {"generationTaskKey": host.task["task_key"],
            "generationTaskType": host.task["task_type"], "generationTaskJobId": "j1"} in (
                host.patches
            )
    assert ({"generationBatch": None} in host.patches) is (not upscale)
    assert {k: host.patches[-1][k] for k in CURRENT} == CURRENT
    assert_cleared(host)
    mode = "upscale" if upscale else "textToVideo"
    assert [r.getMessage() for r in caplog.records if "Server workflow video" in r.getMessage()] == [
        f"Server workflow video started run_id=run-1 node_id=n mode={mode} outcome=started",
        f"Server workflow video ended run_id=run-1 node_id=n mode={mode} outcome=completed",
    ]


@pytest.mark.parametrize("upscale", [False, True])
async def test_video_takeover_no_submission_or_compile(setup_runner, upscale):
    host, _, run, phases, accepted = setup_runner
    video_host(host, upscale=upscale)
    host.data.update(workflowCatalog={"recipeId": "r"}, workflowRecipeCompiledPrompt="Compiled",
                     isGenerating=True, generationOwner="server", generationRunId="run-1")
    assert (await run("generate_video", existing_task=host.task))["artifact"] == {
        "output_url": VIDEO_URL,
    }
    assert host.requests == []
    assert phases == ["generating"]
    assert accepted == []
    assert_cleared(host)


async def test_video_own_run_busy_without_task_submits_once(setup_runner):
    host, runner, run, _, accepted = setup_runner
    video_host(host)
    host.data.update(isGenerating=True, generationOwner="server", generationRunId="run-1")
    core_call = runner.core_call

    async def inspect_request(op, payload):
        if op == "video_generation_request":
            assert payload["canvas"]["nodes"][0]["data"]["isGenerating"] is True
            assert payload["env"]["is_generating"] is False
        return await core_call(op, payload)

    runner.core_call = inspect_request
    assert await run("generate_video") == {
        "status": "completed", "output": {"videoUrl": VIDEO_URL},
        "artifact": {"output_url": VIDEO_URL},
    }
    assert len(host.requests) == 1
    assert accepted == [host.task]
    assert_cleared(host)


@pytest.mark.parametrize("owner,run_id", [(None, None), (None, "run-1"),
                                           ("server", "another-run")])
async def test_video_foreign_busy_refused_without_effects(setup_runner, owner, run_id):
    host, runner, run, _, _ = setup_runner
    video_host(host)
    host.data.update(isGenerating=True, generationOwner=owner, generationRunId=run_id)
    before = deepcopy(host.canvas)
    core_call = runner.core_call

    async def inspect_request(op, payload):
        if op == "video_generation_request":
            assert "is_generating" not in payload["env"]
        return await core_call(op, payload)

    runner.core_call = inspect_request
    assert await run("generate_video") == {
        "status": "failed", "error": "Video generation is already running.",
    }
    assert host.canvas == before
    assert host.patches == []
    assert host.requests == []


async def test_video_recipe_metadata_and_operation(setup_runner):
    host, _, run, phases, _ = setup_runner
    video_host(host)
    host.data["workflowCatalog"] = {"recipeId": "r"}
    host.responses.insert(0, {"prompt": "Compiled video", "compile_mode": "model",
                              "recipe_ids": ["r"]})
    assert (await run("generate_video", product_operation_id="operation-1",
                      generation_attempt_id="attempt-1"))["status"] == "completed"
    assert [r["path"] for r in host.requests] == [
        "freezone/recipes/compile", "projects/project/freezone/video/gen",
    ]
    assert host.requests[-1]["body"]["prompt"] == "Compiled video"
    assert host.requests[-1]["body"]["product_operation_id"] == "operation-1"
    assert host.requests[-1]["body"]["generation_attempt_id"] == "attempt-1"
    assert host.data["workflowRecipeCompiledPrompt"] == "Compiled video"
    assert host.data["workflowRecipeCompiledAt"] == "1970-01-01T00:00:00.000Z"
    assert host.media_links == [None, None]
    assert phases == ["compiling_recipe", "submitting", "generating"]


@pytest.mark.parametrize("upscale", [False, True])
async def test_video_builder_refusal_before_start(setup_runner, upscale):
    host, _, run, _, _ = setup_runner
    video_host(host, upscale=upscale)
    if upscale:
        host.data["upscaleSourceUrl"] = ""
    else:
        host.data["genMode"] = "videoExtend"
    assert await run("generate_video") == {"status": "failed", "error": (
        "缺少高清视频源" if upscale else "An upstream source video is required."
    )}
    assert host.patches == []
    assert host.requests == []


async def test_video_refusal_after_compile_clears_loading(setup_runner):
    host, _, run, _, _ = setup_runner
    video_host(host)
    host.data["prompt"] = ""
    host.data["workflowCatalog"] = {"recipeId": "r"}
    host.responses = [{"prompt": "", "compile_mode": "model", "recipe_ids": ["r"]}]
    assert await run("generate_video") == {
        "status": "failed", "error": "A video prompt or upstream text is required.",
    }
    assert [r["path"] for r in host.requests] == ["freezone/recipes/compile"]
    assert_cleared(host)


@pytest.mark.parametrize("upscale", [False, True])
@pytest.mark.parametrize("status,message", [
    ("failed", "Video failed"), ("cancelled", "任务已取消"), ("running", "视频生成超时"),
])
async def test_video_terminal_failures(setup_runner, upscale, status, message):
    host, _, run, _, _ = setup_runner
    video_host(host, upscale=upscale)
    host.statuses = [{"status": status, "error": message if status == "failed" else None}]
    assert await run("generate_video") == {"status": "failed", "error": message}
    assert host.data["workflowResultStale"] is True
    assert "workflowGeneratedAt" not in host.data
    if status == "failed":
        assert host.data["generationError"] == "Video failed"
    if status != "running":
        assert host.data["generationTaskKey"] is None
        assert_cleared(host)
    assert host.data["generationOwner"] is None


@pytest.mark.parametrize("matching", [False, True])
async def test_video_failure_clears_only_matching_descriptor(setup_runner, matching):
    host, _, run, _, _ = setup_runner
    video_host(host)
    key = host.task["task_key"] if matching else "another-task"
    host.data.update(generationTaskKey=key)
    host.statuses = [{"status": "failed", "error": "Video failed"}]
    assert (await run("generate_video", existing_task=host.task))["status"] == "failed"
    assert host.data["generationTaskKey"] == (None if matching else key)


@pytest.mark.parametrize("stage", ["compile", "submit"])
async def test_video_http_error_info_is_preserved(setup_runner, stage):
    host, _, run, _, _ = setup_runner
    video_host(host)
    if stage == "compile":
        host.data["workflowCatalog"] = {"recipeId": "r"}
    host.responses = [ServerActionHttpError("HTTP 400: rejected", info={
        "name": "HttpError", "message": "rejected", "status": 400, "display": "Video rejected",
        "details": "Reference invalid", "requestId": "request-1", "referenceIssues": [],
    })]
    assert await run("generate_video") == {"status": "failed", "error": "Video rejected"}
    if stage == "compile":
        assert host.data["generationError"] == "Video rejected"
        assert "generationErrorDetails" not in host.patches[-1]
        assert "generationErrorRequestId" not in host.patches[-1]
    else:
        assert host.data["generationErrorDetails"] == "Reference invalid"
        assert host.data["generationErrorRequestId"] == "request-1"
    assert_cleared(host)


@pytest.mark.parametrize("data,edges", [
    ({"count": 2}, []),
    ({"storySegmentId": "segment", "continuityMode": "auto"}, []),
    ({"continuityMode": "independent"}, [
        {"id": "choice", "type": "storyChoiceEdge", "source": "other", "target": "n"},
    ]),
])
async def test_video_runtime_refusal_has_no_effects(setup_runner, data, edges):
    host, _, run, _, _ = setup_runner
    video_host(host)
    host.data.update(data)
    host.canvas["edges"] = edges
    assert await run("generate_video") == {"status": "failed", "error": OPEN_VIDEO}
    assert host.patches == []
    assert host.requests == []


async def test_video_trim_requires_browser_without_writes(setup_runner):
    host, _, run, _, _ = setup_runner
    video_host(host)
    host.data.update(genMode="allReference", isExtendMode=True, extendStartMs=1000,
                     extendEndMs=3000)
    host.canvas["nodes"].append({"id": "source", "type": "videoNode",
                                 "position": {"x": 0, "y": 0},
                                 "data": {"videoUrl": "/static/source.mp4", "durationMs": 8000}})
    host.canvas["edges"] = [{"id": "ref", "source": "source", "target": "n"}]
    assert await run("generate_video") == {"status": "failed", "error": OPEN_VIDEO}
    assert host.patches == []
    assert host.requests == []


@pytest.mark.parametrize("upscale", [False, True])
async def test_video_job_result_fallback(setup_runner, upscale):
    host, _, run, _, _ = setup_runner
    video_host(host, upscale=upscale)
    host.statuses = [{"status": "completed", "result": {"video_url": ""}}]
    host.fallback = VIDEO_URL
    assert (await run("generate_video"))["artifact"] == {"output_url": VIDEO_URL}


@pytest.mark.parametrize("kind", ["completed", "skipped", "failed"])
async def test_audio_result_freshness(setup_runner, kind):
    host, _, run, _, _ = setup_runner
    audio_host(host)
    host.data["workflowResultStale"] = True
    if kind == "skipped":
        host.data.update(voicePolicyConfirmed=True, voiceAvailable=False)
    elif kind == "failed":
        host.statuses = [{"status": "failed", "error": "Audio failed"}]
    assert (await run("generate_audio"))["status"] == kind
    if kind == "failed":
        assert host.data["workflowResultStale"] is True
        assert "workflowGeneratedAt" not in host.patches[-1]
    else:
        assert {k: host.patches[-1][k] for k in CURRENT} == CURRENT


async def test_wait_timeout_marks_timeout(setup_runner):
    from novelvideo.freezone.server_workflow_actions import _ActionExecution

    host, runner, _, _, _ = setup_runner
    host.statuses = [None]
    execution = _ActionExecution(runner, "n", None, None, lambda: False, None, None)
    assert await execution.wait_task(TASK, timeout_message="Timeout", failed_message="Failed") == {
        "kind": "failed", "message": "Timeout", "timed_out": True,
    }


@pytest.mark.parametrize("count,expected", [
    (None, None), (1, None), (2, "video_count"), (2.5, "video_count"), (True, None),
])
def test_video_count_refusal(count, expected):
    from novelvideo.freezone.server_workflow_actions import server_action_refusal

    assert server_action_refusal("generate_video", {
        "id": "n", "type": "videoNode", "data": {"count": count},
    }, []) == expected


@pytest.mark.parametrize("mode", ["auto", "independent", "other", None])
@pytest.mark.parametrize("story", ["segment", "start", "source", "target", "none"])
def test_video_continuity_refusal(mode, story):
    from novelvideo.freezone.server_workflow_actions import server_action_refusal

    data = {"continuityMode": mode}
    if story == "segment":
        data["storySegmentId"] = "segment"
    if story == "start":
        data["storyRole"] = "start"
    edges = [{"type": "storyChoiceEdge", "source": "n" if story == "source" else "other",
              "target": "n" if story == "target" else "other"}]
    node = {"id": "n", "type": "videoNode", "data": data}
    assert server_action_refusal("generate_video", node, edges) == (
        "video_story_continuity" if mode in {"auto", "independent"} and story != "none" else None
    )
    assert server_action_refusal("generate_image", node, edges) is None
    assert server_action_refusal("generate_video", {**node, "type": "imageGenNode"}, edges) is None


TOOL_CHILD = str(uuid.uuid5(uuid.NAMESPACE_URL, "workflow-image-tool:run-1:tool-attempt"))


@pytest.mark.parametrize("action,route,mode", [
    ("run_outpaint_tool", "outpaint", None),
    ("run_upscale_tool", "upscale", None),
    ("run_grid_multi_camera", "template-edit", "multi_camera_nine_grid"),
    ("run_grid_plot_four", "template-edit", "story_pitch_four_grid"),
    ("run_grid_face_three_view", "template-edit", "character_face_three_view"),
    ("run_grid_product_three_view", "template-edit", "product_three_view"),
    ("run_grid_serial_storyboard_25", "template-edit", "storyboard_25_grid"),
    ("run_grid_cinematic_light_correction", "template-edit", "cinematic_light_correction"),
    ("run_grid_character_three_view", "template-edit", "character_three_view_generation"),
    ("run_grid_scene_setting_sheet", "template-edit", "scene_setting_sheet"),
    ("run_grid_frame_projection_3s_later", "template-edit", "image_projection_after_3s"),
    ("run_grid_frame_projection_5s_earlier", "template-edit", "image_projection_before_5s"),
])
async def test_image_tool_happy_path(setup_runner, tmp_path, action, route, mode):
    host, runner, run, phases, accepted = setup_runner
    host.data.update(imageUrl=URL, aspectRatio="16:9", workflowResultStale=True)
    source = deepcopy(host.canvas["nodes"][0])
    patch = host.patch_node

    async def ordered_patch(node_id, data):
        if data.get("generationTaskKey"):
            assert accepted == [TASK]
        await patch(node_id, data)

    host.patch_node = ordered_patch
    built = await runner.core_call("image_tool_request", {
        "canvas": await host.read_canvas(), "node_id": "n", "action": action,
        "env": {"locale": "zh", "project": "project", "now_ms": 0,
                "image_models": (await host.catalogs())["image"]},
    })
    result = await run(action, generation_attempt_id="tool-attempt")
    assert result == {"status": "completed", "output": {
        "nodeId": TOOL_CHILD, "imageUrl": URL, "previewImageUrl": URL,
        "task_key": TASK["task_key"], "job_id": TASK["job_id"],
    }, "artifact": {"output_url": URL}}
    assert host.canvas["nodes"][0] == source
    assert set(host.patch_nodes) == {TOOL_CHILD}
    assert len(host.additions) == 1
    nodes, edges = host.additions[0]
    assert len(nodes) == len(edges) == 1
    assert nodes[0]["id"] == TOOL_CHILD
    assert nodes[0]["type"] == "exportImageNode"
    assert nodes[0]["data"].items() >= {
        **built["child"]["data"], "generationOwner": "server", "generationRunId": "run-1",
    }.items()
    assert (edges[0]["source"], edges[0]["target"]) == ("n", TOOL_CHILD)
    assert host.requests == [{"method": "POST", "path": f"projects/project/freezone/{route}",
                              "body": built["body"]}]
    if mode:
        assert host.requests[0]["body"]["mode"] == mode
    assert host.media_links == [{"run_id": "run-1", "canvas_id": "default", "node_id": "n",
                                 "generation_attempt_id": "tool-attempt"}]
    child = host.canvas["nodes"][1]["data"]
    assert child["imageUrl"] == URL
    assert child["generationOwner"] is None and child["generationRunId"] is None
    assert child["isGenerating"] is False
    assert "workflowResultStale" not in child
    assert phases == ["submitting", "generating"]
    assert_durable(tmp_path, action, result["artifact"])
    # Same run and attempt reuses the child even if the runner is re-entered.
    accepted.clear()
    host.responses = [TASK]
    host.statuses = [{"status": "completed", "result": {"output_url": URL}}]
    assert (await run(action, generation_attempt_id="tool-attempt"))["output"]["nodeId"] == TOOL_CHILD
    assert len(host.additions) == 1


@pytest.mark.parametrize("fallback", ["/static/fallback.png", None, ""])
async def test_image_tool_job_result_fallback(setup_runner, fallback):
    host, _, run, _, _ = setup_runner
    host.data["imageUrl"] = URL
    host.statuses = [{"status": "completed", "result": {}}]
    host.fallback = fallback
    result = await run("run_outpaint_tool", generation_attempt_id="tool-attempt")
    if fallback:
        assert result["artifact"] == {"output_url": fallback}
    else:
        assert result == {"status": "failed", "error": "任务已结束但没有返回图片"}
        assert host.canvas["nodes"][1]["data"]["generationError"] == result["error"]
    assert set(host.patch_nodes) == {TOOL_CHILD}


@pytest.mark.parametrize("action,message", [
    ("run_outpaint_tool", "目标节点没有可用于扩图的图片"),
    ("run_upscale_tool", "目标节点没有可用于高清放大的图片"),
    ("run_grid_plot_four", "目标节点没有可用于生成的图片"),
])
async def test_image_tool_missing_source_has_no_effects(setup_runner, action, message):
    host, _, run, _, _ = setup_runner
    assert await run(action, generation_attempt_id="tool-attempt") == {
        "status": "failed", "error": message,
    }
    assert host.patches == host.additions == host.requests == []


@pytest.mark.parametrize("failure", ["http", "failed", "cancelled"])
async def test_image_tool_failure_on_child(setup_runner, failure):
    host, _, run, _, _ = setup_runner
    host.data["imageUrl"] = URL
    message = "HTTP 400: refused" if failure == "http" else (
        "task failed" if failure == "failed" else "任务已取消"
    )
    if failure == "http":
        host.responses = [ServerActionHttpError(message)]
    else:
        host.statuses = [{"status": failure}]
    assert await run("run_outpaint_tool", generation_attempt_id="tool-attempt") == {
        "status": "failed", "error": message,
    }
    child = host.canvas["nodes"][1]["data"]
    assert child["generationError"] == message
    assert child["isGenerating"] is False
    assert child["generationOwner"] is None
    if failure != "http":
        assert child["generationTaskKey"] is None
    assert set(host.patch_nodes) == {TOOL_CHILD}


@pytest.mark.parametrize("has_task", [False, True])
async def test_image_tool_takeover(setup_runner, has_task):
    host, _, run, phases, accepted = setup_runner
    host.data["imageUrl"] = URL
    host.canvas["nodes"].append({"id": TOOL_CHILD, "type": "exportImageNode",
        "position": {"x": 400, "y": 0}, "data": {
            "generationRunId": "run-1", "generationOwner": "server", "isGenerating": True,
        }})
    result = await run("run_outpaint_tool", existing_task=TASK if has_task else None,
                       generation_attempt_id="tool-attempt")
    assert result["status"] == "completed"
    assert host.additions == []
    assert len(host.requests) == (0 if has_task else 1)
    assert accepted == ([] if has_task else [TASK])
    if not has_task:
        assert host.patches[0] == {"isGenerating": True, "generationStartedAt": 0,
            "generationError": None, "generationOwner": "server", "generationRunId": "run-1"}
    assert set(host.patch_nodes) == {TOOL_CHILD}


async def test_image_tool_stop_during_wait_clears_child(setup_runner):
    host, _, run, _, _ = setup_runner
    host.data["imageUrl"] = URL

    async def stop(task):
        host.stopped = True
        return {"status": "running"}

    host.task_status = stop
    assert await run("run_outpaint_tool", generation_attempt_id="tool-attempt") == {
        "status": "stopped",
    }
    assert host.patches[-1] == CLEAR
    assert set(host.patch_nodes) == {TOOL_CHILD}


WORLD_TASK = {"task_key": "world:project:j1", "task_type": "freezone_image_to_3gs", "job_id": "j1"}
WORLD_URL = "/api/projects/project/static/world.sog"


def world_canvas(host, data=None, source_data=None):
    host.canvas = {"nodes": [
        {"id": "n", "type": "threeDWorldNode", "position": {"x": 0, "y": 0},
         "data": data or {}},
        {"id": "image", "type": "imageGenNode", "position": {"x": 0, "y": 0},
         "data": {"imageUrl": URL} if source_data is None else source_data},
    ], "edges": [{"id": "edge", "source": "image", "target": "n"}]}
    host.task = WORLD_TASK
    host.responses = [WORLD_TASK]
    host.statuses = [{"status": "completed", "result": {"ply_url": WORLD_URL}}]


@pytest.mark.parametrize("pano", [False, True])
async def test_world_happy_path(setup_runner, tmp_path, pano, caplog):
    import logging

    host, runner, run, phases, accepted = setup_runner
    world_canvas(host, {"plyKind": "pano"} if pano else {})
    source = deepcopy(host.canvas["nodes"][1])
    patch_node = host.patch_node

    async def ordered_patch(node_id, patch):
        if "taskKey" in patch and patch["taskKey"]:
            assert accepted == [WORLD_TASK]
        await patch_node(node_id, patch)

    host.patch_node = ordered_patch
    with caplog.at_level(logging.INFO):
        result = await run("generate_3gs_world", generation_attempt_id="attempt")
    kind = "pano" if pano else "master"
    assert host.requests == [{"method": "POST", "path": "projects/project/freezone/image-to-3gs",
                              "body": {"source_url": URL, "source_kind": kind,
                                       "canvas_id": "default", "node_id": "n"}}]
    assert host.media_links == [{"run_id": "run-1", "canvas_id": "default", "node_id": "n",
                                 "generation_attempt_id": "attempt"}]
    start, accepted_patch, done = host.patches
    assert start.items() >= {"isGenerating": True, "generationOwner": "server",
                             "generationRunId": "run-1", "sourceNodeId": "image",
                             "plyKind": kind, "previewImageUrl": URL}.items()
    assert accepted_patch == {"taskKey": WORLD_TASK["task_key"],
                              "generationTaskKey": WORLD_TASK["task_key"],
                              "generationTaskType": WORLD_TASK["task_type"],
                              "generationTaskJobId": "j1"}
    assert phases == ["submitting", "generating"]
    assert host.data["plyUrl"] == WORLD_URL
    generated = next(s for s in host.data["sources"] if s["id"].startswith("generated-sog:"))
    assert generated["id"] == host.data["activeSourceId"] == f"generated-sog:{kind}:0"
    assert generated["label"] == ("360 3DGS" if pano else "图片 3DGS")
    assert done.items() >= {"workflowResultStale": False, "workflowGeneratedAt": "1970-01-01T00:00:00.000Z"}.items()
    assert_cleared(host)
    output = {"plyUrl": WORLD_URL, **({"panoUrl": URL} if pano else {})}
    assert result == {"status": "completed", "output": output, "artifact": {"output_url": WORLD_URL}}
    if pano:
        assert start["sources"][0]["pano_url"] == start["panoUrl"] == URL
        assert host.data["panoUrl"] == URL
    assert host.canvas["nodes"][1] == source
    assert set(host.patch_nodes) == {"n"}
    assert_durable(tmp_path, "generate_3gs_world", result["artifact"])
    logs = [r.getMessage() for r in caplog.records if r.name.endswith("server_workflow_actions")]
    assert logs == ["run_id=run-1 node_id=n action=generate_3gs_world outcome=started",
                    "run_id=run-1 node_id=n action=generate_3gs_world outcome=completed"]


@pytest.mark.parametrize("failure,message", [
    ("failed", "Sharp3DUnavailable: SHARP unavailable"), ("cancelled", "任务已取消"),
    ("missing", "未能在 task.result 中找到 3D 世界地址"), ("http", "HTTP 503: unavailable"),
])
async def test_world_failures(setup_runner, failure, message):
    host, _, run, _, _ = setup_runner
    world_canvas(host, {"plyUrl": "/static/old.sog"})
    if failure == "http":
        host.responses = [ServerActionHttpError(message)]
    elif failure == "missing":
        host.statuses = [{"status": "completed", "result": {}}]
    else:
        host.statuses = [{"status": failure, "error": message if failure == "failed" else None}]
    assert await run("generate_3gs_world") == {"status": "failed", "error": message}
    assert host.data["errorMessage"] == f"生成失败: {message}"
    assert host.data["taskKey"] is None
    assert_cleared(host)
    if failure in {"failed", "cancelled"}:
        assert all(host.data[key] is None for key in (
            "generationTaskKey", "generationTaskType", "generationTaskJobId"))
    elif failure == "missing":
        assert host.data["generationTaskKey"] == WORLD_TASK["task_key"]
    assert set(host.patch_nodes) == {"n"}


@pytest.mark.parametrize("case,message", [
    ("no_upstream", "3D 世界节点没有可用的上游图片"),
    ("text", "文生 3D 模型尚未对接，请连接图片节点"),
    ("missing_url", "3D 世界节点没有可用的上游图片"),
    ("inline", "上游图片没有可用的地址"),
    ("busy", "节点正在生成中"),
])
async def test_world_guards_without_submission(setup_runner, case, message):
    host, _, run, _, _ = setup_runner
    world_canvas(host)
    if case == "no_upstream":
        host.canvas["edges"] = []
    elif case == "text":
        host.canvas["nodes"][1].update(type="textAnnotationNode", data={"content": "A world"})
    elif case == "missing_url":
        host.canvas["nodes"][1]["data"] = {}
    elif case == "inline":
        host.canvas["nodes"][1]["data"]["imageUrl"] = "data:image/png;base64,AA=="
    else:
        host.data["isGenerating"] = True
    assert await run("generate_3gs_world") == {"status": "failed", "error": message}
    assert host.requests == []
    assert host.patches == ([{"errorMessage": message}] if case == "text" else [])


@pytest.mark.parametrize("has_task", [False, True])
async def test_world_takeover(setup_runner, has_task):
    host, _, run, phases, accepted = setup_runner
    world_canvas(host)
    if has_task:
        host.data.update(isGenerating=True, generationOwner="server", generationRunId="run-1",
                         sourceNodeId="image", plyKind="master")
        host.statuses.insert(0, {"status": "running"})
        result = await run("generate_3gs_world", existing_task=WORLD_TASK)
        assert host.requests == accepted == []
        assert len(host.patches) == 1
        assert phases == ["generating"]
    else:
        patch = host.patch_node

        async def stop_after_start(node_id, value):
            await patch(node_id, value)
            if value.get("isGenerating"):
                raise ActionLeaseLost()

        host.patch_node = stop_after_start
        assert await run("generate_3gs_world") == {"status": "stopped"}
        assert host.requests == []
        assert host.data["sourceNodeId"] == "image"
        host.patch_node = patch
        result = await run("generate_3gs_world")
        assert host.requests[0]["body"] == {"source_url": URL, "source_kind": "master",
                                            "canvas_id": "default", "node_id": "n"}
        assert len(host.requests) == 1
    assert result["output"] == {"plyUrl": WORLD_URL}


async def test_world_takeover_rebuilds_identical_body(setup_runner):
    host, _, run, _, _ = setup_runner
    world_canvas(host, {"plyKind": "pano"})
    request = host.request

    async def lost_acceptance(*args, **kwargs):
        await request(*args, **kwargs)
        raise ActionLeaseLost()

    host.request = lost_acceptance
    assert await run("generate_3gs_world") == {"status": "stopped"}
    first = deepcopy(host.requests[0])
    host.request = request
    host.responses = [WORLD_TASK]
    assert (await run("generate_3gs_world"))["status"] == "completed"
    assert host.requests == [first, first]


async def test_world_poll_timeout_only_clears_owner(setup_runner):
    host, _, run, _, _ = setup_runner
    world_canvas(host, {"generationOwner": "server", "generationRunId": "run-1",
                        "isGenerating": True, "taskKey": WORLD_TASK["task_key"]})
    before = deepcopy(host.data)
    host.statuses = [{"status": "running"}]
    assert await run("generate_3gs_world", existing_task=WORLD_TASK) == {
        "status": "failed", "error": "3D 世界生成超时"}
    assert host.patches == [{"generationOwner": None, "generationRunId": None}]
    assert host.data == {**before, **host.patches[0]}


async def test_world_stop_during_wait(setup_runner):
    host, _, run, _, _ = setup_runner
    world_canvas(host)
    host.statuses = [{"status": "running"}]

    async def stop(seconds):
        host.stopped = True

    host.sleep = stop
    setup_runner[1].sleep = stop
    assert await run("generate_3gs_world") == {"status": "stopped"}
    assert host.patches[-1] == {**CLEAR, "taskKey": None}


async def test_world_product_operation_refused_without_effects(setup_runner):
    host, _, run, _, _ = setup_runner
    world_canvas(host)
    assert await run("generate_3gs_world", product_operation_id="recipe") == {
        "status": "failed", "error": "工作流动作 generate_3gs_world 需要打开画布运行"}
    assert host.patches == host.requests == []


async def test_finalize_run_filters_images_and_applies_worker_changes():
    host = FakeHost()
    calls = []
    edge = {'id': 'attached', 'source': 'n', 'target': 'video',
            'data': {'link_type': 'media_input_for', 'edgeKind': 'story_frame_reference'}}

    async def core(op, payload):
        calls.append((op, payload))
        return {'ok': True, 'edges': [edge], 'node_patches': [
            {'node_id': 'n', 'patch': {'prompt': 'Synced'}}], 'warnings': ['target_changed']}

    async def catalogs(*, video=False):
        assert video is True
        return {'image': {'models': []}, 'video': {'models': [{'id': 'v', 'referenceImageMax': 2}]},
                'camera_templates': []}

    host.catalogs = catalogs
    runner = WorkflowActionRunner(host=host, project_id='project', canvas_id='default',
                                  run_id='run-1', core_call=core)
    actions = [{'node_id': node, 'action': action, 'status': status} for node, action, status in [
        ('n', 'generate_image', 'completed'), ('failed', 'generate_image', 'failed'),
        ('skip', 'generate_image', 'skipped'), ('text', 'generate_text', 'completed'),
        ('n', 'generate_image', 'completed'), ('second', 'generate_image', 'completed'),
    ]]
    before = deepcopy(host.canvas)
    assert await runner.finalize_run(actions) == ['target_changed']
    assert calls == [('story_attach', {'canvas': before, 'image_node_ids': ['n', 'second'],
                                      'env': {'locale': 'zh', 'catalogs': {'video': {
                                          'models': [{'id': 'v', 'referenceImageMax': 2}]}}}})]
    assert host.additions == [([], [edge])]
    assert host.patch_nodes == ['n']
    assert host.patches == [{'prompt': 'Synced'}]


async def test_finalize_run_without_completed_images_does_not_read_canvas():
    host = FakeHost()
    async def unexpected(*args):
        pytest.fail('no completed images must do no I/O')
    host.read_canvas = unexpected
    runner = WorkflowActionRunner(host=host, project_id='project', canvas_id='default',
                                  run_id='run-1', core_call=unexpected)
    assert await runner.finalize_run([
        {'node_id': 'n', 'action': 'generate_image', 'status': 'failed'},
        {'node_id': 'n', 'action': 'generate_image', 'status': 'skipped'},
        {'node_id': 'text', 'action': 'generate_text', 'status': 'completed'},
    ]) == []


async def test_image_outcome_reports_unapplied_auto_commit(setup_runner):
    host, _, run, _, _ = setup_runner
    host.data.update(preset_managed=True, autoCommitOnGenerate=True)
    result = await run()
    assert result['status'] == 'completed'
    assert result['output']['auto_commit_not_applied'] is True
    assert all('commit' not in request['path'] for request in host.requests)

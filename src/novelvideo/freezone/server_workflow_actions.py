# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Execute server-owned canvas actions through the canvas worker contract."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
import time
import uuid
from typing import Any, Protocol


logger = logging.getLogger(__name__)


class ServerActionHttpError(Exception):
    """A user-facing failure from an in-process generation request."""

    def __init__(self, message: str, *, status_code: int | None = None, info: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.info = info


class ActionLeaseLost(Exception):
    """The action host no longer permits this runner to write."""


class ActionHost(Protocol):
    locale: str

    def lease_held(self) -> bool: ...
    async def catalogs(self, *, video: bool = False) -> dict: ...
    async def read_canvas(self) -> dict: ...
    async def patch_node(self, node_id: str, patch: dict) -> None: ...
    async def add_nodes(self, nodes: list[dict], edges: list[dict]) -> None: ...
    async def request(
        self, method: str, path: str, body: dict, *, media_link: dict[str, str] | None = None,
    ) -> dict: ...
    async def task_status(self, task: dict) -> dict | None: ...
    async def job_result(self, task: dict) -> dict | None: ...
    async def job_result_url(self, task: dict) -> str | None: ...
    async def lane_capacity(self, lane: str) -> int | None: ...
    async def fail_product_operation(self, operation_id: str) -> None: ...


IMAGE_TOOL_SERVER_ACTIONS = frozenset({
    "run_outpaint_tool", "run_upscale_tool",
    "run_grid_multi_camera", "run_grid_plot_four", "run_grid_face_three_view",
    "run_grid_product_three_view", "run_grid_serial_storyboard_25",
    "run_grid_cinematic_light_correction", "run_grid_character_three_view",
    "run_grid_scene_setting_sheet", "run_grid_frame_projection_3s_later",
    "run_grid_frame_projection_5s_earlier",
})
IMAGE_TOOL_NODE_TYPES = frozenset({"imageGenNode", "uploadNode", "imageNode", "exportImageNode"})

SERVER_WORKFLOW_ACTIONS = IMAGE_TOOL_SERVER_ACTIONS | frozenset({
    "generate_image", "generate_text", "generate_audio", "translate_text", "generate_video",
    "generate_3gs_world",
})


def server_action_supported(action: str, node_type: str | None) -> bool:
    return action in SERVER_WORKFLOW_ACTIONS and (
        (action not in IMAGE_TOOL_SERVER_ACTIONS or node_type in IMAGE_TOOL_NODE_TYPES)
        and (action != "translate_text" or node_type == "audioNode")
        and (action != "generate_video" or node_type == "videoNode")
        and (action != "generate_3gs_world" or node_type == "threeDWorldNode")
    )


def server_action_refusal(action: str, node: dict, edges: list[dict]) -> str | None:
    if action == "generate_3gs_world" and node.get("type") == "threeDWorldNode":
        catalog = (node.get("data") or {}).get("workflowCatalog")
        if isinstance(catalog, dict) and str(catalog.get("recipeId") or "").strip():
            return "world_recipe"
    if action != "generate_video" or node.get("type") != "videoNode":
        return None
    data = node.get("data") or {}
    count = data.get("count")
    if isinstance(count, (int, float)) and not isinstance(count, bool) and count > 1:
        return "video_count"
    story = (
        bool(data.get("storySegmentId")) or data.get("storyRole") == "start"
        or any(edge.get("type") == "storyChoiceEdge" and node.get("id") in {
            edge.get("source"), edge.get("target"),
        } for edge in edges)
    )
    if story and data.get("continuityMode") in {"auto", "independent"}:
        return "video_story_continuity"
    return None


_CLEAR_OWNER = {"generationOwner": None, "generationRunId": None}
CLEAR_GENERATION = {
    "isGenerating": False,
    "generationStartedAt": None,
    "generationTaskKey": None,
    "generationTaskType": None,
    "generationTaskJobId": None,
    **_CLEAR_OWNER,
}


class _ActionStopped(Exception):
    pass


def _nonempty_text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _narration_text(data: dict) -> str:
    direct = _nonempty_text(data.get("content")) or _nonempty_text(data.get("text"))
    if direct:
        return direct
    script = data.get("scriptResult")
    rows = script.get("rows") if isinstance(script, dict) else None
    if not isinstance(rows, list):
        return ""
    lines = []
    for row in rows:
        if isinstance(row, dict):
            text = (_nonempty_text(row.get("narration")) or _nonempty_text(row.get("voiceover"))
                    or _nonempty_text(row.get("dialogue")))
            if text:
                lines.append(text)
    return "\n".join(lines)


class WorkflowActionRunner:
    def __init__(
        self, *, host: ActionHost, project_id: str, canvas_id: str, run_id: str,
        core_call: Callable[[str, dict], Awaitable[Any]], sleep=asyncio.sleep,
        monotonic=time.monotonic, now_ms=lambda: time.time() * 1000,
        poll_seconds: float = 2.0, task_timeout_seconds: float = 1800.0,
    ):
        self.host = host
        self.project_id = project_id
        self.canvas_id = canvas_id
        self.run_id = run_id
        self.core_call = core_call
        self.sleep = sleep
        self.monotonic = monotonic
        self.now_ms = now_ms
        self.poll_seconds = poll_seconds
        self.task_timeout_seconds = task_timeout_seconds

    def supports(self, action: str) -> bool:
        return action in SERVER_WORKFLOW_ACTIONS

    async def lane_capacity(self, lane: str) -> int | None:
        return await self.host.lane_capacity(lane)

    async def finalize_run(self, actions: list[dict]) -> list[str]:
        image_ids = list(dict.fromkeys(
            item["node_id"] for item in actions
            if item["action"] == "generate_image" and item["status"] == "completed"
        ))
        if not image_ids:
            return []
        if not self.host.lease_held():
            raise ActionLeaseLost()
        # Reference limits follow the requester's video catalog, like the browser.
        catalogs = await self.host.catalogs(video=True)
        canvas = await self.host.read_canvas()
        attached = await self.core_call("story_attach", {
            "canvas": canvas, "image_node_ids": image_ids,
            "env": {"locale": self.host.locale, "catalogs": {"video": catalogs["video"]}},
        })
        if not self.host.lease_held():
            raise ActionLeaseLost()
        await self.host.add_nodes([], attached["edges"])
        for item in attached["node_patches"]:
            await self.host.patch_node(item["node_id"], item["patch"])
        logger.info("Story attachment run_id=%s edges=%d patches=%d", self.run_id,
                    len(attached["edges"]), len(attached["node_patches"]))
        return attached["warnings"]

    async def interrupt_action(
        self, *, node_id: str, action: str, product_operation_id: str | None,
    ) -> None:
        if not self.host.lease_held():
            return
        canvas = await self.host.read_canvas()
        data = next((node.get("data") or {} for node in canvas["nodes"]
                     if node["id"] == node_id), {})
        if data.get("generationRunId") == self.run_id:
            await self.host.patch_node(node_id, dict(CLEAR_GENERATION))
        if product_operation_id:
            await self.host.fail_product_operation(product_operation_id)
        logger.info("Server workflow text interrupted run_id=%s node_id=%s", self.run_id, node_id)

    async def run_action(
        self, *, node_id: str, action: str, existing_task: dict | None,
        on_accepted: Callable[[dict], Awaitable[None]],
        on_phase: Callable[[str], Awaitable[None]], should_stop: Callable[[], bool],
        product_operation_id: str | None = None, generation_attempt_id: str | None = None,
    ) -> dict:
        product_operation = ({
            "projectId": self.project_id, "operationId": product_operation_id,
            "generationAttemptId": generation_attempt_id,
        } if product_operation_id else None)
        execution = _ActionExecution(
            self, node_id, on_accepted, on_phase, should_stop, product_operation,
            generation_attempt_id,
        )
        try:
            execution.check()
            if action == "generate_image":
                return await execution.image(existing_task)
            if action == "generate_video":
                return await execution.video(existing_task)
            if action == "generate_text":
                return await execution.text()
            if action == "generate_audio":
                return await execution.audio(existing_task)
            if action in {"translate_text", "generate_3gs_world"} or action in IMAGE_TOOL_SERVER_ACTIONS:
                canvas = await self.host.read_canvas()
                node_type = next((node.get("type") for node in canvas["nodes"]
                                  if node["id"] == node_id), None)
                if server_action_supported(action, node_type):
                    if action in IMAGE_TOOL_SERVER_ACTIONS:
                        return await execution.image_tool(action, existing_task)
                    if action == "generate_3gs_world":
                        return await execution.world(existing_task)
                    return await execution.audio_translate(existing_task)
            return {"status": "failed", "error": f"Unsupported server action: {action}"}
        except _ActionStopped:
            try:
                if self.host.lease_held():
                    target_id = execution.child_node_id if action in IMAGE_TOOL_SERVER_ACTIONS else node_id
                    if target_id is not None:
                        data = await execution.node_data(target_id)
                        if execution.started or data.get("generationRunId") == self.run_id:
                            await self.host.patch_node(target_id, {
                                **CLEAR_GENERATION,
                                **({"taskKey": None} if action == "generate_3gs_world" else {}),
                            })
            except ActionLeaseLost:
                pass
            return {"status": "stopped"}
        except ActionLeaseLost:
            return {"status": "stopped"}


class _ActionExecution:
    """Per-call state; concurrent actions never share cancellation or ownership state."""

    def __init__(
        self, runner, node_id, on_accepted, on_phase, should_stop, product_operation,
        generation_attempt_id,
    ):
        self.runner = runner
        self.host = runner.host
        self.node_id = node_id
        self.on_accepted = on_accepted
        self.on_phase = on_phase
        self.should_stop = should_stop
        self.started = False
        self.product_operation = product_operation
        self.generation_attempt_id = generation_attempt_id
        self.child_node_id = None
        self.media_link = ({
            "run_id": runner.run_id, "canvas_id": runner.canvas_id, "node_id": node_id,
            "generation_attempt_id": generation_attempt_id,
        } if generation_attempt_id and not product_operation else None)

    def check(self):
        if self.should_stop():
            raise _ActionStopped()

    async def node_data(self, node_id=None):
        canvas = await self.host.read_canvas()
        return next((node["data"] for node in canvas["nodes"]
                     if node["id"] == (node_id or self.node_id)), {})

    async def core(self, op, payload):
        self.check()
        if op in {"audio_generation_patch", "audio_translate_patch", "video_generation_patch",
                  "image_tool_patch", "world_generation_patch"}:
            payload = {"locale": self.host.locale, **payload}
        result = await self.runner.core_call(op, payload)
        self.check()
        return result

    async def patch(self, patch):
        self.check()
        await self.host.patch_node(self.node_id, patch)

    async def phase(self, phase):
        self.check()
        await self.on_phase(phase)
        self.check()

    async def request(self, request, *, media_link=None):
        self.check()
        return await self.host.request(
            request["method"], request["path"], request["body"], media_link=media_link,
        )

    async def start(self, op, phase="start"):
        patch = await self.core(op, {"phase": phase, "started_at_ms": self.runner.now_ms()})
        await self.patch({**patch, "generationOwner": "server",
                          "generationRunId": self.runner.run_id})
        self.started = True

    async def patch_child(self, patch):
        self.check()
        await self.host.patch_node(self.child_node_id, patch)

    async def image_tool(self, action, existing_task):
        kind = "stopped"
        logger.info(
            "run_id=%s node_id=%s action=%s outcome=started",
            self.runner.run_id, self.node_id, action,
        )
        try:
            result = await self.image_tool_execute(action, existing_task)
            kind = result["status"]
            return result
        finally:
            logger.info(
                "run_id=%s node_id=%s action=%s outcome=%s",
                self.runner.run_id, self.node_id, action, kind,
            )

    async def image_tool_execute(self, action, existing_task):
        deadline = self.runner.monotonic() + self.runner.task_timeout_seconds
        canvas = await self.host.read_canvas()
        built = await self.core("image_tool_request", {
            "canvas": canvas, "node_id": self.node_id, "action": action,
            "env": {"locale": self.host.locale, "project": self.runner.project_id,
                    "image_models": (await self.host.catalogs())["image"],
                    "now_ms": self.runner.now_ms()},
        })
        if built["ok"] is False:
            return {"status": "failed", "error": built["message"]}
        self.child_node_id = str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"workflow-image-tool:{self.runner.run_id}:{self.generation_attempt_id}",
        ))
        child = next((node for node in canvas["nodes"] if node["id"] == self.child_node_id), None)
        if child is None:
            placed = await self.core("image_tool_place", {
                "canvas": canvas, "locale": self.host.locale, "child_node_id": self.child_node_id,
                "child": {**built["child"], "data": {
                    **built["child"]["data"], "generationOwner": "server",
                    "generationRunId": self.runner.run_id,
                }}, "edge": built["edge"],
            })
            self.check()
            await self.host.add_nodes([placed["node"]], [placed["edge"]] if placed["edge"] else [])
            self.started = True
        elif existing_task is None:
            await self.patch_child({
                "isGenerating": True, "generationStartedAt": self.runner.now_ms(),
                "generationError": None, "generationOwner": "server",
                "generationRunId": self.runner.run_id,
            })
            self.started = True
        task = existing_task
        try:
            if task is None or await self.host.task_status(task) is None:
                await self.phase("submitting")
                task = await self.submit_task(
                    {"method": "POST", "path": built["route"], "body": built["body"]},
                    deadline=deadline, timeout_message="图片生成超时",
                )
                await self.on_accepted(task)
                await self.patch_child(await self.core("image_tool_patch", {
                    "phase": "accepted", "task": task,
                }))
        except ServerActionHttpError as exc:
            return await self.image_tool_failure(str(exc), task, "failed")
        await self.phase("generating")
        outcome = await self.wait_task(
            task, timeout_message="图片生成超时", failed_message="task failed",
        )
        if outcome["kind"] != "completed":
            return await self.image_tool_failure(outcome["message"], task, outcome["kind"])
        resolution = await self.core("image_tool_patch", {
            "phase": "output_resolution", "result": outcome.get("result") or None, "task": task,
        })
        url = (await self.host.job_result_url(task) if resolution["kind"] == "fetch_job_result"
               else resolution["url"])
        # Server actions require a usable result; the browser accepts an empty URL.
        if not url:
            return await self.image_tool_failure("任务已结束但没有返回图片", task, "completed")
        await self.patch_child({**await self.core("image_tool_patch", {
            "phase": "success", "action": action, "url": url,
        }), **_CLEAR_OWNER})
        result = await self.core("image_tool_patch", {
            "phase": "action_result", "action": action, "child_node_id": self.child_node_id,
            "url": url, "task": task,
        })
        return {"status": "completed", "output": result["output"], "artifact": {"output_url": url}}

    async def image_tool_failure(self, message, task, kind):
        data = await self.node_data(self.child_node_id)
        clear_task = ({
            "generationTaskKey": None, "generationTaskType": None, "generationTaskJobId": None,
        } if kind in {"failed", "cancelled"} and task
            and data.get("generationTaskKey") == task["task_key"] else {})
        await self.patch_child({**await self.core("image_tool_patch", {
            "phase": "failure", "message": message,
        }), **_CLEAR_OWNER, **clear_task})
        return {"status": "failed", "error": message}

    async def world(self, existing_task):
        kind = "stopped"
        logger.info(
            "run_id=%s node_id=%s action=generate_3gs_world outcome=started",
            self.runner.run_id, self.node_id,
        )
        try:
            result = await self.world_execute(existing_task)
            kind = result["status"]
            return result
        finally:
            logger.info(
                "run_id=%s node_id=%s action=generate_3gs_world outcome=%s",
                self.runner.run_id, self.node_id, kind,
            )

    async def world_execute(self, existing_task):
        if self.product_operation:
            return {"status": "failed", "error": "工作流动作 generate_3gs_world 需要打开画布运行"}
        deadline = self.runner.monotonic() + self.runner.task_timeout_seconds
        canvas = await self.host.read_canvas()
        data = next((n["data"] for n in canvas["nodes"] if n["id"] == self.node_id), {})
        selected = await self.core("world_generation_upstream", {
            "canvas": canvas, "node_id": self.node_id, "env": {"locale": self.host.locale},
        })
        owned = existing_task is not None or (
            data.get("generationOwner") == "server"
            and data.get("generationRunId") == self.runner.run_id
        )
        upstream = selected["upstream"]
        built = await self.core("world_generation_request", {
            "node_id": self.node_id, "node_data": data, "source_node": selected["sourceNode"],
            "upstream": {"node_id": upstream["nodeId"], "kind": upstream["kind"]}
            if upstream else None,
            "env": {"locale": self.host.locale, "project": self.runner.project_id,
                    "canvas_id": self.runner.canvas_id, "blocked": False,
                    "is_generating": False if owned else data.get("isGenerating") is True,
                    "product_operation": None},
        })
        if built["ok"] is False:
            patches = built["patches"]
            for index, patch in enumerate(patches):
                clear = (_CLEAR_OWNER if index == len(patches) - 1
                         and data.get("generationOwner") == "server"
                         and data.get("generationRunId") == self.runner.run_id else {})
                await self.patch({**patch, **clear})
            # Browser silent guards publish empty success; report that no task was submitted.
            messages = {
                "generation_in_progress": "节点正在生成中",
                "no_upstream": "3D 世界节点没有可用的上游图片",
                "missing_source_node": "3D 世界节点没有可用的上游图片",
                "missing_source_url": "上游图片没有可用的地址",
                "inline_media_reference": "上游图片没有可用的地址",
            }
            return {"status": "failed", "error": (
                patches[-1].get("errorMessage") if patches else None
            ) or messages.get(built["code"], built["code"])}
        prepared = {
            "source_node_id": built["sourceNodeId"], "source_url": built["sourceUrl"],
            "source_kind": built["sourceKind"], "raw_pano_source": built["rawPanoSource"],
            "request": built["request"],
        }
        if existing_task is None:
            await self.patch({**await self.core("world_generation_patch", {
                "phase": "start", "prepared_request": prepared, "node_data": data,
                "started_at_ms": self.runner.now_ms(),
            }), "generationOwner": "server", "generationRunId": self.runner.run_id})
            self.started = True
        task = existing_task
        try:
            if task is None or await self.host.task_status(task) is None:
                await self.phase("submitting")
                task = await self.submit_task(
                    built["request"], deadline=deadline, timeout_message="3D 世界生成超时",
                )
                await self.on_accepted(task)
                await self.patch(await self.core("world_generation_patch", {
                    "phase": "accepted", "task": task,
                }))
        except ServerActionHttpError as exc:
            return await self.world_failure(str(exc), task, "failed")
        await self.phase("generating")
        outcome = await self.wait_task(
            task, timeout_message="3D 世界生成超时", failed_message="task failed",
        )
        if outcome.get("timed_out"):
            await self.patch(dict(_CLEAR_OWNER))
            return {"status": "failed", "error": "3D 世界生成超时"}
        if outcome["kind"] != "completed":
            return await self.world_failure(outcome["message"], task, outcome["kind"])
        labels = await self.core("world_generation_patch", {"phase": "labels"})
        sources = (await self.node_data()).get("sources")
        done = await self.core("world_generation_patch", {
            "phase": "success", "result": outcome.get("result") or None,
            "generated_id": f"generated-sog:{built['sourceKind']}:{int(self.runner.now_ms())}",
            "source_kind": built["sourceKind"], "raw_pano_source": built["rawPanoSource"],
            "current_sources": sources if isinstance(sources, list) else [], "labels": labels,
        })
        if done["kind"] == "missing_world_url":
            return await self.world_failure(done["message"], task, "completed")
        await self.patch({**done["patch"], **_CLEAR_OWNER, **self.current_result_patch()})
        # The browser action_result can publish stored URLs; return only this run's output.
        url = done["output"].get("plyUrl")
        return {"status": "completed", "output": done["output"],
                **({"artifact": {"output_url": url}} if url else {})}

    async def world_failure(self, message, task, kind):
        failed = await self.core("world_generation_patch", {
            "phase": "failure", "outcome": {"kind": "failed", "message": message},
        })
        data = await self.node_data()
        clear_task = ({
            "generationTaskKey": None, "generationTaskType": None, "generationTaskJobId": None,
        } if kind in {"failed", "cancelled"} and task
            and data.get("generationTaskKey") == task["task_key"] else {})
        await self.patch({**failed["patches"][0], **_CLEAR_OWNER, **clear_task})
        return {"status": "failed", "error": message}

    async def image(self, existing_task):
        deadline = self.runner.monotonic() + self.runner.task_timeout_seconds
        canvas = await self.host.read_canvas()
        self.check()
        data = next((n["data"] for n in canvas["nodes"] if n["id"] == self.node_id), {})
        env = {"locale": self.host.locale, "project": self.runner.project_id,
               "canvasId": self.runner.canvas_id, "catalogs": await self.host.catalogs(),
               "executionSource": "workflow", "productOperation": self.product_operation}
        payload = {"canvas": canvas, "node_id": self.node_id, "env": env}
        built = await self.core("image_generation_request", payload)
        compile_input = built["compile_input"]
        if compile_input.get("ok") is False:
            return {"status": "failed", "error": compile_input["message"]}
        if not existing_task:
            await self.start("image_generation_patch")
        plan = await self.core("recipe_compile_request", {
            "node_id": self.node_id, "node_data": data, "compile_input": compile_input,
            "env": {"executionSource": "workflow", "productOperation": self.product_operation,
                    "locale": self.host.locale},
        })
        if existing_task:
            prompt = (
                data.get("workflowRecipeCompiledPrompt") or compile_input["fallbackPrompt"]
                if plan["kind"] == "request" else plan["prompt"]
            )
        elif plan["kind"] == "request":
            await self.phase("compiling_recipe")
            try:
                response = await self.request(plan["request"])
            except ServerActionHttpError as exc:
                return await self.image_outcome(
                    {"kind": "compile_failed", "message": str(exc)}, None, 1,
                )
            compiled = await self.core("recipe_compile_result", {
                "request_body": plan["request"]["body"], "data": response,
            })
            compiled_at = datetime.fromtimestamp(
                self.runner.now_ms() / 1000, timezone.utc,
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            await self.patch(await self.core("image_generation_patch", {
                "phase": "compile_metadata", "metadata": compiled["metadata"],
                "compiled_at": compiled_at,
            }))
            prompt = compiled["prompt"]
        else:
            prompt = plan["prompt"]
        env["prompt"] = prompt
        request = (await self.core("image_generation_request", payload))["request"]
        task = existing_task
        needs_submission = task is None or await self.host.task_status(task) is None
        if not request["ok"] and needs_submission:
            return await self.image_outcome(
                {"kind": "failed", "message": request["message"]}, None, 1,
            )
        total = request["requests"][0]["body"].get("variant_count", 1) if request["ok"] else 1
        if needs_submission:
            gen_request = request["requests"][0]
            await self.phase("submitting")
            await self.patch(await self.core("image_generation_patch", {
                "phase": "submit", "started_at_ms": self.runner.now_ms(),
            }))
            try:
                task = await self.submit_task(
                    gen_request, deadline=deadline, timeout_message="图片生成超时",
                )
            except ServerActionHttpError as exc:
                return await self.image_outcome(
                    {"kind": "failed", "message": str(exc)}, None, total,
                )
            # Persist acceptance before observing a cancellation that arrived during submission.
            await self.on_accepted(task)
            await self.patch(await self.core("image_generation_patch", {
                "phase": "accepted", "task": task,
            }))
        await self.phase("generating")
        outcome = await self.wait_task(
            task, timeout_message="图片生成超时", failed_message="图片生成失败",
        )
        result = outcome.get("result") or {}
        if outcome["kind"] == "completed" and not any(result.get(key) for key in (
            "output_url", "image_url", "url", "output_urls",
        )):
            outcome["fallbackUrl"] = await self.host.job_result_url(task)
            self.check()
        return await self.image_outcome(outcome, task, total)

    async def video(self, existing_task):
        canvas = await self.host.read_canvas()
        node = next((n for n in canvas["nodes"] if n["id"] == self.node_id), {})
        data = node.get("data") or {}
        upscale = data.get("isUpscaleNode") is True
        mode = "upscale" if upscale else data.get("genMode")
        kind = "stopped"
        logger.info(
            "Server workflow video started run_id=%s node_id=%s mode=%s outcome=started",
            self.runner.run_id, self.node_id, mode,
        )
        try:
            if server_action_refusal("generate_video", node, canvas.get("edges", [])):
                result = {"status": "failed", "error": "工作流动作 generate_video 需要打开画布运行"}
            elif upscale:
                result = await self.video_upscale(existing_task)
            else:
                result = await self.video_generate(existing_task, canvas, data)
            kind = result["status"]
            return result
        finally:
            logger.info(
                "Server workflow video ended run_id=%s node_id=%s mode=%s outcome=%s",
                self.runner.run_id, self.node_id, mode, kind,
            )

    async def video_payload(self, canvas, existing_task):
        data = next((n["data"] for n in canvas["nodes"] if n["id"] == self.node_id), {})
        catalogs = await self.host.catalogs(video=True)
        env = {
            "locale": self.host.locale, "project": self.runner.project_id,
            "canvasId": self.runner.canvas_id, "catalogs": catalogs,
            "camera_templates": catalogs.get("camera_templates"),
            "executionSource": "workflow", "productOperation": self.product_operation,
        }
        # Bypass only a recovered task or this run's persisted start flag.
        if existing_task is not None or (
            data.get("generationOwner") == "server"
            and data.get("generationRunId") == self.runner.run_id
        ):
            env["is_generating"] = False
        return {"canvas": canvas, "node_id": self.node_id, "env": env}

    async def video_error(self, message, *, name="Error", info=None):
        return info if info is not None else await self.core("generation_error_describe", {
            "locale": self.host.locale,
            "failure": {"kind": "thrown", "name": name, "message": message},
            "fallback_message": "视频生成失败",
        })

    async def video_generate(self, existing_task, canvas, data):
        deadline = self.runner.monotonic() + self.runner.task_timeout_seconds
        payload = await self.video_payload(canvas, existing_task)
        built = await self.core("video_generation_request", payload)
        compile_input = built["compile_input"]
        if compile_input.get("ok") is False:
            return {"status": "failed", "error": compile_input["message"]}
        if built["trim_requirement"] is not None:
            return {"status": "failed", "error": "工作流动作 generate_video 需要打开画布运行"}
        request = built["request"]
        # Browser guards can silently finish; the server must report absence of a submission.
        if not request["ok"] and request["code"] != "no_effective_prompt":
            return {"status": "failed", "error": request["message"]}
        if request["ok"] and len(request["requests"]) != 1:
            return {"status": "failed", "error": "工作流动作 generate_video 需要打开画布运行"}
        if not existing_task:
            await self.start("video_generation_patch")
        plan = await self.core("recipe_compile_request", {
            "node_id": self.node_id, "node_data": data, "compile_input": compile_input,
            "env": {"executionSource": "workflow", "productOperation": self.product_operation,
                    "locale": self.host.locale},
        })
        if existing_task:
            prompt = (
                data.get("workflowRecipeCompiledPrompt") or compile_input["fallbackPrompt"]
                if plan["kind"] == "request" else plan["prompt"]
            )
        elif plan["kind"] == "request":
            await self.phase("compiling_recipe")
            try:
                response = await self.request(plan["request"])
            except ServerActionHttpError as exc:
                info = await self.video_error(str(exc), info=exc.info)
                await self.patch({**await self.core("video_generation_patch", {
                    "phase": "failure", "error": info,
                }), **_CLEAR_OWNER})
                return {"status": "failed", "error": info["display"]}
            compiled = await self.core("recipe_compile_result", {
                "request_body": plan["request"]["body"], "data": response,
            })
            await self.patch(await self.core("video_generation_patch", {
                "phase": "compile_metadata", "metadata": compiled["metadata"],
                "compiled_at": self.current_result_patch()["workflowGeneratedAt"],
            }))
            prompt = compiled["prompt"]
        else:
            prompt = plan["prompt"]
        payload["env"]["prompt"] = prompt
        request = (await self.core("video_generation_request", payload))["request"]
        if not request["ok"] or len(request["requests"]) != 1:
            await self.patch({"isGenerating": False, "generationStartedAt": None, **_CLEAR_OWNER})
            return {"status": "failed", "error": request["message"] if not request["ok"]
                    else "工作流动作 generate_video 需要打开画布运行"}
        task = existing_task
        if task is None or await self.host.task_status(task) is None:
            await self.phase("submitting")
            await self.patch(await self.core("video_generation_patch", {"phase": "submit"}))
            try:
                task = await self.submit_task(
                    request["requests"][0], deadline=deadline, timeout_message="视频生成超时",
                )
            except ServerActionHttpError as exc:
                return await self.video_outcome({
                    "kind": "failed", "error": await self.video_error(str(exc), info=exc.info),
                }, task, data)
            # Persist acceptance before observing a stop that arrived during submission.
            await self.on_accepted(task)
            await self.patch(await self.core("video_generation_patch", {
                "phase": "accepted", "task": task,
            }))
        await self.phase("generating")
        outcome = await self.wait_task(
            task, timeout_message="视频生成超时", failed_message="视频生成失败",
        )
        if outcome["kind"] == "completed":
            result = outcome.get("result") or {}
            fallback = None
            if not any(isinstance(result.get(key), str) and result[key] for key in (
                "video_url", "output_url", "url",
            )):
                fallback = await self.host.job_result_url(task)
            outcome = {"kind": "completed", "result": result or None, "fallbackUrl": fallback}
        elif outcome.get("timed_out"):
            outcome = {"kind": "poll_timeout"}
        elif outcome["kind"] == "failed":
            outcome = {"kind": "failed", "error": await self.video_error(
                outcome["message"], name="TaskCompletionError",
            )}
        else:
            outcome = {"kind": "cancelled"}
        return await self.video_outcome(outcome, task, data)

    async def clear_dead_video_task(self, task, kind):
        data = await self.node_data()
        if (kind in {"failed", "cancelled"} and task
                and data.get("generationTaskKey") == task["task_key"]):
            await self.patch({"generationTaskKey": None, "generationTaskType": None,
                              "generationTaskJobId": None})

    async def video_outcome(self, outcome, task, data):
        run = await self.core("video_generation_patch", {
            "phase": "run_outcome", "run_index": 0, "total": 1, "completed_urls": [],
            "outcome": outcome,
        })
        urls = run["completedUrls"]
        current = self.current_result_patch() if urls else {}
        await self.patch({**(run["patch"] or {}), **_CLEAR_OWNER, **current})
        settle = await self.core("video_generation_patch", {
            "phase": "settle", "completed_urls": urls,
            "run_errors": [run["runError"]] if run["runError"] else [], "total": 1,
            "supports_human_review": False, "human_review": bool(data.get("humanReview")),
        })
        if settle["patch"] is not None:
            await self.patch(settle["patch"])
        await self.clear_dead_video_task(task, outcome["kind"])
        if urls:
            return {"status": "completed", "output": {"videoUrl": urls[0]},
                    "artifact": {"output_url": urls[0]}}
        # The browser action_result can publish an older videoUrl; use only this run's URLs.
        return {"status": "failed", "error": (await self.node_data()).get("generationError") or (
            "视频生成超时" if outcome["kind"] == "poll_timeout" else
            "任务已取消" if outcome["kind"] == "cancelled" else "视频生成失败"
        )}

    async def video_upscale(self, existing_task):
        deadline = self.runner.monotonic() + self.runner.task_timeout_seconds
        payload = await self.video_payload(await self.host.read_canvas(), existing_task)
        request = (await self.core("video_generation_request", payload))["request"]
        if not request["ok"]:
            return {"status": "failed", "error": "缺少高清视频源"
                    if request["code"] == "missing_upscale_source" else request["message"]}
        if len(request["requests"]) != 1:
            return {"status": "failed", "error": "工作流动作 generate_video 需要打开画布运行"}
        if not existing_task:
            await self.start("video_generation_patch", phase="upscale_start")
        task = existing_task
        try:
            if task is None or await self.host.task_status(task) is None:
                await self.phase("submitting")
                task = await self.submit_task(
                    request["requests"][0], deadline=deadline, timeout_message="视频生成超时",
                )
                await self.on_accepted(task)
                await self.patch(await self.core("video_generation_patch", {
                    "phase": "upscale_accepted", "task": task,
                }))
        except ServerActionHttpError as exc:
            return await self.video_upscale_outcome({"kind": "failed", "message": str(exc)}, task)
        await self.phase("generating")
        outcome = await self.wait_task(
            task, timeout_message="视频生成超时", failed_message="视频增强失败",
        )
        if outcome["kind"] == "completed":
            result = outcome.get("result") or {}
            fallback = "" if result.get("output_url") else (await self.host.job_result_url(task) or "")
            outcome = {"kind": "completed", "result": result or None, "fallbackUrl": fallback}
        elif outcome.get("timed_out"):
            outcome = {"kind": "poll_timeout"}
        else:
            outcome = {"kind": "failed", "message": "任务已取消" if outcome["kind"] == "cancelled"  # i18n-exempt
                       else outcome["message"]}
        return await self.video_upscale_outcome(outcome, task)

    async def video_upscale_outcome(self, outcome, task):
        patch = await self.core("video_generation_patch", {
            "phase": "upscale_outcome", "outcome": outcome,
        })
        url = ((outcome.get("result") or {}).get("output_url") or outcome.get("fallbackUrl")
               if outcome["kind"] == "completed" else None)
        current = self.current_result_patch() if url else {}
        await self.patch({**(patch or {}), **_CLEAR_OWNER, **current})
        await self.clear_dead_video_task(task, outcome["kind"])
        if url:
            return {"status": "completed", "output": {"videoUrl": url},
                    "artifact": {"output_url": url}}
        # Unlike the browser subscriber, a failed upscale is a failed server action.
        return {"status": "failed", "error": (await self.node_data()).get("generationError") or (
            "视频生成超时" if outcome["kind"] == "poll_timeout" else "视频增强失败"
        )}

    async def wait_task(self, task, *, timeout_message, failed_message):
        started = self.runner.monotonic()
        while True:
            self.check()
            if self.runner.monotonic() - started > self.runner.task_timeout_seconds:
                return {"kind": "failed", "message": timeout_message, "timed_out": True}
            status = await self.host.task_status(task)
            self.check()
            if status:
                if status["status"] == "completed":
                    return {"kind": "completed", "result": status.get("result")}
                if status["status"] in {"failed", "cancelled"}:
                    kind = status["status"]
                    fallback = "任务已取消" if kind == "cancelled" else failed_message
                    return {"kind": kind, "message": status.get("error") or fallback}
            self.check()
            await self.runner.sleep(self.runner.poll_seconds)

    async def submit_task(self, request, *, deadline, timeout_message):
        while True:
            self.check()
            if self.runner.monotonic() > deadline:
                raise ServerActionHttpError(timeout_message)
            try:
                response = await self.request(request, media_link=self.media_link)
                return {key: response[key] for key in ("task_key", "task_type", "job_id")}
            except ServerActionHttpError as exc:
                if str(exc) not in {
                    "HTTP 503: workflow media submission is still starting",
                    "HTTP 503: workflow media submission is being recovered",
                }:
                    raise
                await self.runner.sleep(self.runner.poll_seconds)

    async def audio_translate(self, existing_task):
        deadline = self.runner.monotonic() + self.runner.task_timeout_seconds
        task = existing_task
        try:
            if task is None or await self.host.task_status(task) is None:
                built = await self.core("audio_translate_request", {
                    "canvas": await self.host.read_canvas(), "node_id": self.node_id,
                    "env": {"locale": self.host.locale, "project": self.runner.project_id,
                            "canvas_id": self.runner.canvas_id, "product_operation": None},
                })
                if not built["ok"]:
                    raise ServerActionHttpError(built["message"])
                await self.phase("submitting")
                task = await self.submit_task(
                    built["request"], deadline=deadline, timeout_message="翻译任务超时",
                )
                await self.on_accepted(task)
            await self.phase("generating")
            outcome = await self.wait_task(
                task, timeout_message="翻译任务超时", failed_message="翻译任务失败",
            )
            if outcome["kind"] != "completed":
                raise ServerActionHttpError(outcome["message"])
            data = await self.host.job_result(task)
            self.check()
            text = (data or {}).get("translated_text")
            if not _nonempty_text(text):
                raise ServerActionHttpError("翻译任务未返回译文")
        except ServerActionHttpError as exc:
            result = await self.core("audio_translate_patch", {
                "phase": "action_result", "error": str(exc),
            })
            await self.patch(dict(_CLEAR_OWNER))
            return {"status": "failed", "error": result["error"]}
        patch = await self.core("audio_translate_patch", {
            "phase": "result", "translated_text": text,
        })
        await self.patch({**patch, **_CLEAR_OWNER})
        result = await self.core("audio_translate_patch", {"phase": "action_result", "text": text})
        return {"status": "completed", "output": result["output"], "artifact": {"content": text}}

    async def audio(self, existing_task):
        result = await self.audio_execute(existing_task)
        current = self.current_result_patch() if result["status"] in {"completed", "skipped"} else {}
        await self.patch({**_CLEAR_OWNER, **current})
        return result

    async def audio_execute(self, existing_task):
        deadline = self.runner.monotonic() + self.runner.task_timeout_seconds
        task = existing_task
        needs_submission = task is None or await self.host.task_status(task) is None
        if needs_submission:
            canvas = await self.host.read_canvas()
            data = next((n["data"] for n in canvas["nodes"] if n["id"] == self.node_id), {})
            if not existing_task and not _nonempty_text(data.get("text")):
                nodes = {node["id"]: node for node in canvas["nodes"]}
                text = next((text for edge in canvas["edges"]
                             if edge["target"] == self.node_id
                             and (text := _narration_text(
                                 (nodes.get(edge["source"]) or {}).get("data") or {},
                             ))), "")
                if not text:
                    return {"status": "failed", "error": (
                        "旁白节点缺少上游生成的文本，已停止提交 TTS 请求；"
                        "请先完成剧本/Beat 文本生成后重试。"
                    )}
                await self.patch({"text": text})
            repair = await self.core("audio_generation_patch", {
                "phase": "repair", "node_data": await self.node_data(),
                "now_iso": self.current_result_patch()["workflowGeneratedAt"],
            })
            if repair:
                await self.patch(repair)
            canvas = await self.host.read_canvas()
            data = next((n["data"] for n in canvas["nodes"] if n["id"] == self.node_id), {})
            if existing_task:
                # Reconstruct a lost submission, bypassing only its own persisted busy flag.
                data["isGenerating"] = False
            env = {"locale": self.host.locale, "project": self.runner.project_id,
                   "canvasId": self.runner.canvas_id, "productOperation": self.product_operation,
                   "is_generating": False}
            payload = {"canvas": canvas, "node_id": self.node_id, "env": env}
            built = await self.core("audio_generation_request", payload)
            decision = built["compile_input"]
            if decision["kind"] in {"skip", "refuse"}:
                if decision.get("patch"):
                    await self.patch({**decision["patch"], **_CLEAR_OWNER})
                if decision["kind"] == "skip":
                    return {"status": "skipped", "output": decision["output"]}
                return {"status": "failed", "error": decision["message"]}
            if not existing_task:
                await self.start("audio_generation_patch")
            try:
                env.update(prompt=decision.get("prompt", ""), compile_mode=None, recipe_ids=[])
                if decision["kind"] == "compile":
                    plan = await self.core("recipe_compile_request", {
                        "node_id": self.node_id, "node_data": data,
                        "compile_input": decision["input"],
                        "env": {"executionSource": "workflow",
                                "productOperation": self.product_operation,
                                "locale": self.host.locale},
                    })
                    if plan["kind"] == "skip":
                        env["prompt"] = plan["prompt"]
                    elif existing_task:
                        env.update(
                            prompt=data.get("workflowRecipeCompiledPrompt")
                            or decision["input"]["fallbackPrompt"],
                            compile_mode=data.get("workflowRecipeCompileMode"),
                            recipe_ids=data.get("workflowRecipeIds") or [],
                        )
                    else:
                        await self.phase("compiling_recipe")
                        response = await self.request(plan["request"])
                        compiled = await self.core("recipe_compile_result", {
                            "request_body": plan["request"]["body"], "data": response,
                        })
                        await self.patch(await self.core("audio_generation_patch", {
                            **payload, "phase": "compile_metadata",
                            "metadata": compiled["metadata"],
                            "compiled_at": self.current_result_patch()["workflowGeneratedAt"],
                        }))
                        env.update(
                            prompt=compiled["prompt"], compile_mode=compiled["metadata"]["mode"],
                            recipe_ids=compiled["metadata"]["recipeIds"],
                        )
                request = (await self.core("audio_generation_request", payload))["request"]
                if not request["ok"]:
                    raise ServerActionHttpError(request["message"])
                await self.phase("submitting")
                task = await self.submit_task(
                    request["requests"][0], deadline=deadline, timeout_message="音频生成超时",
                )
                # Persist acceptance before observing a cancellation that arrived during submission.
                await self.on_accepted(task)
                await self.patch(await self.core("audio_generation_patch", {
                    "phase": "accepted", "task": task,
                }))
            except ServerActionHttpError as exc:
                return await self.audio_failure(str(exc), exc.info)
        await self.phase("generating")
        outcome = await self.wait_task(
            task, timeout_message="音频生成超时", failed_message="音频生成失败",
        )
        if outcome["kind"] != "completed":
            return await self.audio_failure(outcome["message"])
        result = await self.host.job_result(task)
        self.check()
        return await self.audio_outcome({
            "kind": "completed", "url": (result or {}).get("url") or "",
        })

    async def audio_failure(self, message, info=None):
        info = info or {"name": "Error", "message": message, "status": None,
                        "display": message, "details": None, "requestId": None,
                        "referenceIssues": []}
        prerequisite = await self.core("audio_generation_patch", {
            "phase": "voice_prerequisite", "error": info,
        })
        return await self.audio_outcome({
            "kind": "failed", "message": message, "isError": True,
            "voicePrerequisite": prerequisite,
        })

    async def audio_outcome(self, outcome):
        patched = await self.core("audio_generation_patch", {
            "phase": "outcome", "outcome": outcome,
        })
        for patch in patched["patches"]:
            await self.patch({**patch, **_CLEAR_OWNER})
        hook = ({"hook_output": patched["hookOutput"]} if "hookOutput" in patched
                else {"hook_error": patched["hookError"]})
        result = await self.core("audio_generation_patch", {
            "phase": "action_result", "latest_node_data": await self.node_data(), **hook,
        })
        if result["status"] == "error":
            return {"status": "failed", "error": result["error"]}
        if result["output"].get("skipped"):
            return {"status": "skipped", "output": result["output"]}
        return {"status": "completed", "output": result["output"],
                "artifact": {"audio_url": result["output"].get("audioUrl", "")}}

    def current_result_patch(self):
        return {
            "workflowResultStale": False, "workflowInvalidatedAt": None,
            "workflowInvalidationReason": None,
            "workflowGeneratedAt": datetime.fromtimestamp(
                self.runner.now_ms() / 1000, timezone.utc,
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }

    async def image_outcome(self, outcome, task, total):
        data = await self.node_data()
        clear_task = ({
            "generationTaskKey": None, "generationTaskType": None, "generationTaskJobId": None,
        } if (
            outcome["kind"] in {"failed", "cancelled"}
            and task and data.get("generationTaskKey") == task["task_key"]
        ) else {})
        patch = await self.core("image_generation_patch", {
            "phase": "outcome", "locale": self.host.locale, "node_id": self.node_id,
            "node_data": data, "task_key": task["task_key"] if task else None,
            "first_accepted_task": task, "run_index": 0, "total": total,
            "completed_urls": [], "attach_story_frame": False, "outcome": outcome,
        })
        auto_commit = any(effect.get("kind") == "commit_node"
                          for effect in patch.get("effects", []))
        if auto_commit:
            logger.warning("Auto commit not applied run_id=%s node_id=%s",
                           self.runner.run_id, self.node_id)
        if patch.get("error"):
            settled = [{"status": "rejected", "message": patch["error"]["message"]}]
        else:
            settled = [{"status": "fulfilled",
                        "value": "ignored" if patch["action"] == "ignore" else "completed"}]
        settle = await self.core("image_generation_patch", {
            "phase": "settle", "locale": self.host.locale, "settled": settled,
            "completed_urls": patch.get("completedUrls", []),
            "accepted_refs": [task] if task else [], "completion_mode": "completed",
        })
        result = await self.core("image_generation_patch", {
            "phase": "action_result", "settle_outcome": settle, "settled": settled,
        })
        if patch["action"] == "write":
            current = self.current_result_patch() if result["status"] != "error" else {}
            await self.patch({**patch["patch"], **_CLEAR_OWNER, **current, **clear_task})
        if settle["kind"] == "no_result":
            await self.patch({**settle["patch"], **_CLEAR_OWNER, **clear_task})
        elif patch["action"] != "write" and clear_task:
            await self.patch({**clear_task, **_CLEAR_OWNER})
        if result["status"] == "error":
            return {"status": "failed", "error": result["error"]}
        artifact = ({"output_url": outcome["fallbackUrl"]} if outcome.get("fallbackUrl")
                    else outcome.get("result") or {})
        return {"status": "completed", "output": {
            **result.get("output", {}), **({"auto_commit_not_applied": True} if auto_commit else {}),
        }, "artifact": artifact}

    async def text(self):
        canvas = await self.host.read_canvas()
        self.check()
        data = next((n["data"] for n in canvas["nodes"] if n["id"] == self.node_id), {})
        request = await self.core("text_generation_request", {
            "canvas": canvas, "node_id": self.node_id, "node_data": data,
            "env": {"locale": self.host.locale, "productOperation": self.product_operation},
        })
        if not request["ok"]:
            return {"status": "failed", "error": request["message"]}
        await self.start("text_generation_patch")
        await self.phase("generating")
        try:
            response = await self.request(request["requests"][0])
            outcome = {"kind": "completed", "content": response["content"]}
        except ServerActionHttpError as exc:
            outcome = {"kind": "failed", "message": str(exc), "isError": True}
        patch = await self.core("text_generation_patch", {"phase": "outcome", "outcome": outcome})
        current = self.current_result_patch() if "error" not in patch else {}
        await self.patch({**patch["patch"], **_CLEAR_OWNER, **current})
        if "error" in patch:
            return {"status": "failed", "error": patch["error"]["message"]}
        return {"status": "completed", "output": patch["output"],
                "artifact": {"content": outcome["content"]}}

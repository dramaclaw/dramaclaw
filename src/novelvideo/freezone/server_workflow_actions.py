# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Execute server-owned image and text actions through the canvas worker contract."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
import time
from typing import Protocol


class ServerActionHttpError(Exception):
    """A user-facing failure from an in-process generation request."""


class ActionLeaseLost(Exception):
    """The action host no longer permits this runner to write."""


class ActionHost(Protocol):
    locale: str

    def lease_held(self) -> bool: ...
    async def catalogs(self) -> dict: ...
    async def read_canvas(self) -> dict: ...
    async def patch_node(self, node_id: str, patch: dict) -> None: ...
    async def request(
        self, method: str, path: str, body: dict, *, media_link: dict[str, str] | None = None,
    ) -> dict: ...
    async def task_status(self, task: dict) -> dict | None: ...
    async def job_result_url(self, task: dict) -> str | None: ...
    async def lane_capacity(self, lane: str) -> int | None: ...


SERVER_WORKFLOW_ACTIONS = frozenset({"generate_image", "generate_text"})

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


class WorkflowActionRunner:
    def __init__(
        self, *, host: ActionHost, project_id: str, canvas_id: str, run_id: str,
        core_call: Callable[[str, dict], Awaitable[dict]], sleep=asyncio.sleep,
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
            if action == "generate_text":
                return await execution.text()
            return {"status": "failed", "error": f"Unsupported server action: {action}"}
        except _ActionStopped:
            try:
                if self.host.lease_held():
                    data = await execution.node_data()
                    if execution.started or data.get("generationRunId") == self.run_id:
                        await self.host.patch_node(node_id, dict(CLEAR_GENERATION))
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
        self.media_link = ({
            "run_id": runner.run_id, "node_id": node_id,
            "generation_attempt_id": generation_attempt_id,
        } if generation_attempt_id and not product_operation else None)

    def check(self):
        if self.should_stop():
            raise _ActionStopped()

    async def node_data(self):
        canvas = await self.host.read_canvas()
        return next((node["data"] for node in canvas["nodes"]
                     if node["id"] == self.node_id), {})

    async def core(self, op, payload):
        self.check()
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

    async def start(self, op):
        patch = await self.core(op, {"phase": "start", "started_at_ms": self.runner.now_ms()})
        await self.patch({**patch, "generationOwner": "server",
                          "generationRunId": self.runner.run_id})
        self.started = True

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
            while True:
                self.check()
                if self.runner.monotonic() > deadline:
                    return await self.image_outcome(
                        {"kind": "failed", "message": "图片生成超时"}, None, total,
                    )
                try:
                    response = await self.request(gen_request, media_link=self.media_link)
                    break
                except ServerActionHttpError as exc:
                    if str(exc) not in {
                        "HTTP 503: workflow media submission is still starting",
                        "HTTP 503: workflow media submission is being recovered",
                    }:
                        return await self.image_outcome(
                            {"kind": "failed", "message": str(exc)}, None, total,
                        )
                    await self.runner.sleep(self.runner.poll_seconds)
            task = {key: response[key] for key in ("task_key", "task_type", "job_id")}
            # Persist acceptance before observing a cancellation that arrived during submission.
            await self.on_accepted(task)
            await self.patch(await self.core("image_generation_patch", {
                "phase": "accepted", "task": task,
            }))
        await self.phase("generating")
        outcome = await self.wait(task)
        return await self.image_outcome(outcome, task, total)

    async def wait(self, task):
        started = self.runner.monotonic()
        while True:
            self.check()
            if self.runner.monotonic() - started > self.runner.task_timeout_seconds:
                return {"kind": "failed", "message": "图片生成超时"}
            status = await self.host.task_status(task)
            self.check()
            if status:
                if status["status"] == "completed":
                    result = status.get("result")
                    outcome = {"kind": "completed", "result": result}
                    if not any((result or {}).get(key) for key in (
                        "output_url", "image_url", "url", "output_urls",
                    )):
                        outcome["fallbackUrl"] = await self.host.job_result_url(task)
                    self.check()
                    return outcome
                if status["status"] in {"failed", "cancelled"}:
                    kind = status["status"]
                    fallback = "任务已取消" if kind == "cancelled" else "图片生成失败"
                    return {"kind": kind, "message": status.get("error") or fallback}
            self.check()
            await self.runner.sleep(self.runner.poll_seconds)

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
        patch = await self.core("image_generation_patch", {
            "phase": "outcome", "locale": self.host.locale, "node_id": self.node_id,
            "node_data": data, "task_key": task["task_key"] if task else None,
            "first_accepted_task": task, "run_index": 0, "total": total,
            "completed_urls": [], "attach_story_frame": False, "outcome": outcome,
        })
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
            await self.patch({**patch["patch"], **_CLEAR_OWNER, **current})
        if settle["kind"] == "no_result":
            await self.patch({**settle["patch"], **_CLEAR_OWNER})
        if result["status"] == "error":
            return {"status": "failed", "error": result["error"]}
        artifact = ({"output_url": outcome["fallbackUrl"]} if outcome.get("fallbackUrl")
                    else outcome.get("result") or {})
        return {"status": "completed", "output": result.get("output", {}), "artifact": artifact}

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

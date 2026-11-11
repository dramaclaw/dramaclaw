# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Project-bound in-process API host for server workflow actions."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import contextvars
from copy import deepcopy
from functools import partial
from pathlib import Path
from urllib.parse import quote
import uuid

from fastapi import HTTPException
from pydantic import ValidationError

from novelvideo.api.schemas import (
    CanvasPayload,
    FreezoneGenRequest,
    FreezoneJobAcceptedResponse,
    FreezoneRecipeCompileRequest,
    FreezoneRecipeCompileResponse,
    FreezoneRecipeTextGenerateResponse,
)
from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_core_pool import get_canvas_core_pool
from novelvideo.freezone.canvas_ui_locale import recorded_ui_locale
from novelvideo.freezone.workflow_runs import server_workflow_media_link
from novelvideo.freezone.server_workflow_actions import (
    ActionLeaseLost,
    CLEAR_GENERATION,
    ServerActionHttpError,
    WorkflowActionRunner,
)
from novelvideo.ports import get_usage_meter
from novelvideo.project_context import ProjectContext
from novelvideo.task_state import get_task_manager


class InProcessActionHost:
    def __init__(
        self, *, ctx: ProjectContext, canvas_id: str, assert_lease: Callable[[], None],
    ):
        from novelvideo.api.routes import freezone as routes

        self.ctx = ctx
        self.canvas_id = canvas_id
        self.assert_lease = assert_lease
        self._patch_lock = asyncio.Lock()
        self.user = {"id": ctx.requester_user_id, "user_id": ctx.requester_user_id,
                     "username": ctx.requester_username}
        self.canvas_project_dir = routes._canvas_state_project_dir(ctx, Path(ctx.output_dir))
        self.locale = recorded_ui_locale(self.canvas_project_dir) or "zh"

    def lease_held(self) -> bool:
        try:
            self.assert_lease()
        except Exception:
            return False
        return True

    def _assert_write_lease(self) -> None:
        try:
            self.assert_lease()
        except Exception as exc:
            raise ActionLeaseLost() from exc

    async def catalogs(self) -> dict:
        from novelvideo.api.routes import freezone as routes

        return {"image": await routes._freezone_image_models_data(self.ctx.requester_user_id)}

    async def read_canvas(self) -> dict:
        canvas = await asyncio.to_thread(
            canvas_store.read_canvas, self.canvas_project_dir, self.canvas_id,
        )
        return canvas or {"nodes": [], "edges": []}

    async def patch_node(self, node_id: str, patch: dict) -> None:
        from novelvideo.api.routes import freezone as routes

        self._assert_write_lease()
        build_payload = partial(
            routes._canvas_payload_builder, project=self.ctx.project_id,
            canvas_id=self.canvas_id, user=self.user, ctx=self.ctx,
        )
        after_save = partial(
            routes._after_canvas_save, project=self.ctx.project_id, canvas_id=self.canvas_id,
            canvas_project_dir=self.canvas_project_dir, user=self.user,
        )
        async with self._patch_lock:
            for attempt in range(3):
                canvas = await self.read_canvas()
                nodes = deepcopy(canvas["nodes"])
                node = next((node for node in nodes if node.get("id") == node_id), None)
                if node is None:
                    return
                data = node.get("data") or {}
                merged = {**data, **patch}
                if merged == data:
                    return
                node["data"] = merged
                fields = {key: value for key, value in canvas.items()
                          if key in CanvasPayload.model_fields}
                fields.update(
                    nodes=nodes, base_revision=canvas.get("revision"),
                    save_source="workflow_result", client_save_id=str(uuid.uuid4()),
                )
                body = CanvasPayload(**fields)
                self._assert_write_lease()
                try:
                    saved = await canvas_store.save_canvas_async(
                        self.canvas_project_dir, self.canvas_id,
                        base_revision=body.base_revision, save_source=body.save_source,
                        client_save_id=body.client_save_id,
                        request_hash=canvas_store.canvas_request_hash(
                            body.model_dump(exclude={"client_save_id"}, exclude_none=True),
                        ),
                        build_payload=build_payload(body),
                    )
                except canvas_store.CanvasRevisionConflict:
                    if attempt == 2:
                        raise
                    continue
                await after_save(body, saved)
                return

    async def request(
        self, method: str, path: str, body: dict, *, media_link: dict[str, str] | None = None,
    ) -> dict:
        from novelvideo.api.routes import freezone as routes

        gen_path = f"projects/{quote(self.ctx.project_id, safe='')}/freezone/gen"
        if method != "POST":
            raise ServerActionHttpError(f"Unsupported action request: {method} {path}")
        if path == gen_path:
            request_model = FreezoneGenRequest
            response_model = FreezoneJobAcceptedResponse
            handler = partial(routes.freezone_gen, self.ctx.project_id)
        elif path == "freezone/recipes/compile":
            request_model = FreezoneRecipeCompileRequest
            response_model = FreezoneRecipeCompileResponse
            handler = routes.compile_freezone_recipe
        elif path == "freezone/recipes/generate-text":
            request_model = FreezoneRecipeCompileRequest
            response_model = FreezoneRecipeTextGenerateResponse
            handler = routes.generate_freezone_recipe_text
        else:
            raise ServerActionHttpError(f"Unsupported action request: {method} {path}")
        try:
            parsed = request_model(**body)
        except ValidationError as exc:
            raise ServerActionHttpError(f"HTTP 422: {exc}") from exc

        async def request_in_usage_context():
            get_usage_meter().clear_llm_usage_context()
            with server_workflow_media_link(media_link):
                return await handler(parsed, self.user)

        try:
            response = await asyncio.create_task(
                request_in_usage_context(), context=contextvars.copy_context(),
            )
        except HTTPException as exc:
            detail = exc.detail
            if isinstance(detail, dict):
                detail = detail.get("message") or detail.get("code") or str(detail)
            raise ServerActionHttpError(f"HTTP {exc.status_code}: {detail}") from exc
        return response_model.model_validate(response).model_dump()["data"]

    async def task_status(self, task: dict) -> dict | None:
        state = await asyncio.to_thread(
            get_task_manager().get_task_for_project, self.ctx, task["task_type"], 0,
            beat_num=None, scope=task["job_id"],
        )
        if state is None:
            return None
        return {"status": state.status, "result": state.result, "error": state.error}

    async def job_result_url(self, task: dict) -> str | None:
        from novelvideo.api.routes import freezone as routes

        try:
            result = await routes.freezone_job_result(
                self.ctx.project_id, task["task_type"], task["job_id"], self.user,
            )
        except HTTPException:
            return None
        return result.get("url")

    async def lane_capacity(self, lane: str) -> int | None:
        from novelvideo.api.routes.tasks import get_project_task_limits

        response = await get_project_task_limits(self.ctx.project_id, self.user)
        limits = response["data"].get(lane, {})
        remaining = [limits[key] for key in ("remaining", "user_remaining")
                     if limits.get(key) is not None]
        return min(remaining) if remaining else None


def build_server_action_runner(
    *, ctx: ProjectContext, run: dict, runner_id: str, assert_lease: Callable[[], None],
) -> WorkflowActionRunner:
    async def core_call(op: str, payload: dict) -> dict:
        return await asyncio.to_thread(get_canvas_core_pool().call, op, payload)

    return WorkflowActionRunner(
        host=InProcessActionHost(ctx=ctx, canvas_id=run["canvas_id"], assert_lease=assert_lease),
        project_id=ctx.project_id, canvas_id=run["canvas_id"], run_id=run["run_id"],
        core_call=core_call,
    )


async def clear_server_generation_markers(
    *, ctx: ProjectContext, canvas_id: str, run_id: str,
) -> None:
    host = InProcessActionHost(ctx=ctx, canvas_id=canvas_id, assert_lease=lambda: None)
    canvas = await host.read_canvas()
    for node in canvas["nodes"]:
        if (node.get("data") or {}).get("generationRunId") == run_id:
            await host.patch_node(node["id"], dict(CLEAR_GENERATION))

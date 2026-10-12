"""Read-only prompt preview: what each pipeline step would send to its model."""

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Query

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import (
    resolve_project_scope,
    sqlite_store_for_context_scope,
    sqlite_store_scope,
)
from novelvideo.project_config import load_project_config_file_from_state_dir
from novelvideo.prompt_preview.registry import PreviewScope, all_steps, get_step
from novelvideo.prompt_preview.types import PromptPreview

router = APIRouter()
_log = logging.getLogger(__name__)


@asynccontextmanager
async def _scope(project: str, user: dict, episode: int | None) -> AsyncIterator[PreviewScope]:
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    store_scope = (
        sqlite_store_for_context_scope(resolved.ctx, load_graph_state=False)
        if resolved.ctx
        else sqlite_store_scope(resolved.username, resolved.project_name, load_graph_state=False)
    )
    async with store_scope as store:
        yield PreviewScope(
            project_dir=resolved.project_dir,
            state_dir=resolved.state_dir,
            store=store,
            config=load_project_config_file_from_state_dir(resolved.state_dir),
            episode=episode,
        )


@router.get("/projects/{project}/prompt-preview/steps")
async def list_prompt_preview_steps(
    project: str,
    episode: int | None = Query(None),
    user: dict = Depends(get_api_user),
):
    """Steps in pipeline order, each with its previewable targets."""
    items = []
    async with _scope(project, user, episode) as scope:
        for spec in all_steps():
            targets = []
            if spec.targets_fn and (episode is not None or not spec.needs_episode):
                try:
                    targets = [{"id": t.id, "label": t.label} for t in await spec.targets_fn(scope)]
                except Exception:
                    _log.exception("prompt-preview targets failed: %s", spec.step)
            items.append(
                {
                    "step": spec.step,
                    "label": spec.label,
                    "model_kind": spec.model_kind,
                    "supported": spec.supported,
                    "needs_episode": spec.needs_episode,
                    "targets": targets,
                }
            )
    return {"ok": True, "data": {"steps": items}}


@router.get("/projects/{project}/prompt-preview/{step}")
async def get_prompt_preview(
    project: str,
    step: str,
    episode: int | None = Query(None),
    target: str = Query(""),
    user: dict = Depends(get_api_user),
):
    spec = get_step(step)
    if spec is None:
        return {"ok": False, "error": f"unknown step: {step}"}
    if not spec.supported or spec.build_fn is None:
        preview = PromptPreview(
            step=step,
            model_kind=spec.model_kind,
            supported=False,
            note="该步骤暂不支持预览 / Preview is not available for this step yet",
        )
        return {"ok": True, "data": preview.to_dict()}
    if spec.needs_episode and episode is None:
        return {"ok": False, "error": "episode is required for this step"}
    async with _scope(project, user, episode) as scope:
        try:
            preview = await spec.build_fn(scope, target)
        except Exception:
            _log.exception("prompt-preview build failed: %s/%s", step, target)
            return {"ok": False, "error": "failed to build prompt preview"}
    return {"ok": True, "data": preview.to_dict()}

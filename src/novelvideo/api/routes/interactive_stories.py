"""Agent-facing interactive-story routes backed by the Freezone canvas store."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import resolve_project_scope
from novelvideo.interactive_story.models import (
    CreateInteractiveStoryRequest,
    GetInteractiveStoryRequest,
    StoryPatchV2,
    ValidateInteractiveStoryRequest,
)
from novelvideo.interactive_story.service import (
    InteractiveStoryService,
    InteractiveStoryServiceError,
)
from novelvideo.utils.async_ops import call_blocking

router = APIRouter()


def _actor_id(user: dict) -> str:
    return str(user.get("id") or user.get("user_id") or user.get("username") or "")


async def _service(
    project: str,
    user: dict,
    *,
    required_role: str,
) -> InteractiveStoryService:
    resolved = await resolve_project_scope(project, user, required_role=required_role)
    return InteractiveStoryService(
        resolved.ctx.state_dir,
        project_id=resolved.ctx.project_id,
        actor_id=_actor_id(user),
    )


def _error_response(exc: InteractiveStoryServiceError) -> JSONResponse:
    status_code = {
        "story_not_found": 404,
        "story_already_exists": 409,
        "story_id_conflict": 409,
        "revision_conflict": 409,
        "idempotency_conflict": 409,
        "invalid_story": 422,
        "canvas_write_failed": 503,
    }.get(exc.code, 500)
    return JSONResponse(
        status_code=status_code,
        content=exc.to_contract().model_dump(mode="json"),
    )


def _require_story_id(path_story_id: str, body_story_id: str) -> None:
    if path_story_id != body_story_id:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "story_id_mismatch",
                "path_story_id": path_story_id,
                "body_story_id": body_story_id,
            },
        )


@router.post("/projects/{project}/interactive-stories", tags=["interactive-story"])
async def create_interactive_story(
    project: str,
    body: CreateInteractiveStoryRequest,
    user: dict = Depends(get_api_user),
):
    service = await _service(project, user, required_role="editor")
    try:
        return await call_blocking(service.create, body)
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)


@router.get(
    "/projects/{project}/interactive-stories/{story_id}", tags=["interactive-story"]
)
async def get_interactive_story(
    project: str,
    story_id: str,
    canvas_id: str = Query(default="default"),
    user: dict = Depends(get_api_user),
):
    service = await _service(project, user, required_role="viewer")
    try:
        return await call_blocking(
            service.get,
            GetInteractiveStoryRequest(canvas_id=canvas_id, story_id=story_id),
        )
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)


@router.patch(
    "/projects/{project}/interactive-stories/{story_id}", tags=["interactive-story"]
)
async def patch_interactive_story(
    project: str,
    story_id: str,
    body: StoryPatchV2,
    user: dict = Depends(get_api_user),
):
    _require_story_id(story_id, body.story_id)
    service = await _service(project, user, required_role="editor")
    try:
        return await call_blocking(service.patch, body)
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)


@router.post(
    "/projects/{project}/interactive-stories/{story_id}/validate",
    tags=["interactive-story"],
)
async def validate_interactive_story(
    project: str,
    story_id: str,
    body: ValidateInteractiveStoryRequest,
    user: dict = Depends(get_api_user),
):
    _require_story_id(story_id, body.story_id)
    service = await _service(project, user, required_role="viewer")
    try:
        return await call_blocking(service.validate, body)
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)

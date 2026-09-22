"""Agent-facing interactive-story routes backed by the Freezone canvas store."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import resolve_project_scope
from novelvideo.freezone.canvas_events import append_canvas_event, canvas_event_actor
from novelvideo.interactive_story.models import (
    ConfirmInteractiveStoryStagesRequest,
    ConfirmStoryOutlineRequest,
    CreateInteractiveStoryRequest,
    GetInteractiveStoryRequest,
    SaveStoryOutlineRequest,
    StoryPatchV2,
    ValidateInteractiveStoryRequest,
)
from novelvideo.interactive_story.service import (
    AGENT_CREATE_SAVE_SOURCE,
    AGENT_OUTLINE_SAVE_SOURCE,
    AGENT_PATCH_SAVE_SOURCE,
    AGENT_STAGE_CONFIRM_SAVE_SOURCE,
    InteractiveStoryService,
    InteractiveStoryServiceError,
    USER_OUTLINE_CONFIRM_SAVE_SOURCE,
)
from novelvideo.utils.async_ops import call_blocking

router = APIRouter()
logger = logging.getLogger(__name__)


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
        "outline_not_found": 404,
        "outline_not_confirmed": 409,
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


async def _record_story_save(service, body, result, user: dict, save_source: str) -> None:
    if result.idempotent:
        return
    try:
        await call_blocking(
            append_canvas_event,
            project_dir=service.project_dir,
            project_id=service.project_id,
            canvas_id=body.canvas_id,
            event_type="canvas.saved",
            actor=canvas_event_actor(user),
            payload={
                "revision": result.revision,
                "base_revision": body.base_revision,
                "client_save_id": body.idempotency_key,
                "save_source": save_source,
                "story_id": result.story_id,
            },
        )
    except OSError:
        logger.warning("story saved but canvas event append failed", exc_info=True)


async def _record_outline_save(service, body, result, user: dict, save_source: str) -> None:
    """Mirror the story save event so outline writes stay observable too."""
    if result.idempotent:
        return
    try:
        await call_blocking(
            append_canvas_event,
            project_dir=service.project_dir,
            project_id=service.project_id,
            canvas_id=body.canvas_id,
            event_type="canvas.saved",
            actor=canvas_event_actor(user),
            payload={
                "revision": result.revision,
                "base_revision": body.base_revision,
                "client_save_id": body.idempotency_key,
                "save_source": save_source,
                "outline_id": result.outline_id,
            },
        )
    except OSError:
        logger.warning("outline saved but canvas event append failed", exc_info=True)


@router.post("/projects/{project}/interactive-stories", tags=["interactive-story"])
async def create_interactive_story(
    project: str,
    body: CreateInteractiveStoryRequest,
    user: dict = Depends(get_api_user),
):
    service = await _service(project, user, required_role="editor")
    try:
        result = await call_blocking(service.create, body)
        await _record_story_save(service, body, result, user, AGENT_CREATE_SAVE_SOURCE)
        return result
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
        result = await call_blocking(service.patch, body)
        await _record_story_save(service, body, result, user, AGENT_PATCH_SAVE_SOURCE)
        return result
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


@router.get(
    "/projects/{project}/interactive-story-outline", tags=["interactive-story"]
)
async def get_interactive_story_outline(
    project: str,
    canvas_id: str = Query(default="default"),
    user: dict = Depends(get_api_user),
):
    service = await _service(project, user, required_role="viewer")
    try:
        return await call_blocking(service.get_outline, canvas_id)
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)


@router.get(
    "/projects/{project}/interactive-story-progress", tags=["interactive-story"]
)
async def get_interactive_story_progress(
    project: str,
    canvas_id: str = Query(default="default"),
    user: dict = Depends(get_api_user),
):
    """Read-only stage progress derived from canvas evidence; writes nothing."""
    service = await _service(project, user, required_role="viewer")
    try:
        return await call_blocking(service.progress, canvas_id)
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)


@router.post(
    "/projects/{project}/interactive-stories/{story_id}/stage-confirmations",
    tags=["interactive-story"],
)
async def confirm_interactive_story_stages(
    project: str,
    story_id: str,
    body: ConfirmInteractiveStoryStagesRequest,
    user: dict = Depends(get_api_user),
):
    """Persist an explicit user confirmation or reopen decision for manual stages."""
    _require_story_id(story_id, body.story_id)
    service = await _service(project, user, required_role="editor")
    try:
        result = await call_blocking(service.confirm_stages, body)
        await _record_story_save(
            service, body, result, user, AGENT_STAGE_CONFIRM_SAVE_SOURCE
        )
        return result
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)


@router.put(
    "/projects/{project}/interactive-story-outline", tags=["interactive-story"]
)
async def save_interactive_story_outline(
    project: str,
    body: SaveStoryOutlineRequest,
    user: dict = Depends(get_api_user),
):
    service = await _service(project, user, required_role="editor")
    try:
        result = await call_blocking(service.save_outline, body)
        await _record_outline_save(service, body, result, user, AGENT_OUTLINE_SAVE_SOURCE)
        return result
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)


@router.post(
    "/projects/{project}/interactive-story-outline/confirm", tags=["interactive-story"]
)
async def confirm_interactive_story_outline(
    project: str,
    body: ConfirmStoryOutlineRequest,
    user: dict = Depends(get_api_user),
):
    service = await _service(project, user, required_role="editor")
    try:
        result = await call_blocking(service.confirm_outline, body)
        await _record_outline_save(
            service, body, result, user, USER_OUTLINE_CONFIRM_SAVE_SOURCE
        )
        return result
    except InteractiveStoryServiceError as exc:
        return _error_response(exc)

"""Project-scoped HTTP endpoints for the durable hybrid drama runner."""

from __future__ import annotations

import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from novelvideo.api.auth import get_api_user, require_project_scope
from novelvideo.api.deps import resolve_project_scope, sqlite_store_for_context_scope
from novelvideo.hybrid_drama.api_service import (
    assemble_run,
    finalize_run,
    get_run_status,
    poll_run,
    prepare_run,
    review_run_candidate,
    submit_prepared_run,
)

router = APIRouter(prefix="/projects/{project}/hybrid-drama/runs")


class PrepareRunBody(BaseModel):
    episode_number: int = Field(gt=0)
    beat_number: int = Field(gt=0)
    max_cost_usd: str = Field(min_length=1)
    run_id: str = Field(min_length=1, max_length=64)


class SubmitRunBody(BaseModel):
    max_attempts: int = Field(default=1, ge=1)
    manual_retry: bool = False


class ReviewCandidateBody(BaseModel):
    candidate_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    decision: Literal["adopt", "repair", "more-evidence"]
    evidence: dict[str, Any]


class FinalizeRunBody(BaseModel):
    media_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    review: dict[str, Any]


def _provider_api_key() -> str:
    key = os.environ.get("BYTEPLUS_MODEL_ARK_API_KEY") or os.environ.get("ARK_API_KEY")
    if not key or not key.strip(" \t\r\n\"'"):
        raise HTTPException(
            status_code=503,
            detail="BYTEPLUS_MODEL_ARK_API_KEY or ARK_API_KEY is required",
        )
    return key.strip(" \t\r\n\"'")


@router.post("/prepare")
async def prepare_hybrid_run(
    project: str,
    body: PrepareRunBody,
    user: dict = Depends(require_project_scope("projects:write")),
) -> dict[str, Any]:
    resolved = await resolve_project_scope(project, user, required_role="editor")
    try:
        async with sqlite_store_for_context_scope(resolved.ctx) as store:
            result = await prepare_run(
                resolved,
                store,
                episode_number=body.episode_number,
                beat_number=body.beat_number,
                max_cost_usd=body.max_cost_usd,
                run_id=body.run_id,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": result}


@router.post("/{run_id}/submit")
async def submit_hybrid_run(
    project: str,
    run_id: str,
    body: SubmitRunBody = SubmitRunBody(),
    user: dict = Depends(require_project_scope("projects:write")),
) -> dict[str, Any]:
    resolved = await resolve_project_scope(project, user, required_role="editor")
    try:
        result = await submit_prepared_run(
            resolved,
            run_id,
            max_attempts=body.max_attempts,
            manual_retry=body.manual_retry,
            api_key=_provider_api_key(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": result}


@router.post("/{run_id}/poll")
async def poll_hybrid_run(
    project: str,
    run_id: str,
    user: dict = Depends(require_project_scope("projects:write")),
) -> dict[str, Any]:
    resolved = await resolve_project_scope(project, user, required_role="editor")
    try:
        result = await poll_run(resolved, run_id, api_key=_provider_api_key())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": result}


@router.post("/{run_id}/review")
async def review_hybrid_candidate(
    project: str,
    run_id: str,
    body: ReviewCandidateBody,
    user: dict = Depends(require_project_scope("projects:write")),
) -> dict[str, Any]:
    resolved = await resolve_project_scope(project, user, required_role="editor")
    try:
        result = await review_run_candidate(
            resolved,
            run_id,
            candidate_sha256=body.candidate_sha256,
            decision=body.decision,
            evidence=body.evidence,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": result}


@router.post("/{run_id}/assemble")
async def assemble_hybrid_run(
    project: str,
    run_id: str,
    user: dict = Depends(require_project_scope("projects:write")),
) -> dict[str, Any]:
    resolved = await resolve_project_scope(project, user, required_role="editor")
    try:
        result = await assemble_run(resolved, run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": result}


@router.post("/{run_id}/finalize")
async def finalize_hybrid_run(
    project: str,
    run_id: str,
    body: FinalizeRunBody,
    user: dict = Depends(require_project_scope("projects:write")),
) -> dict[str, Any]:
    resolved = await resolve_project_scope(project, user, required_role="editor")
    try:
        result = await finalize_run(
            resolved,
            run_id,
            media_sha256=body.media_sha256,
            review=body.review,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": result}


@router.get("/{run_id}/status")
async def hybrid_run_status(
    project: str,
    run_id: str,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    try:
        result = get_run_status(resolved, run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": result}

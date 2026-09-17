"""Author publication management and anonymous, manifest-scoped playback."""

import hashlib
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes._project_audit import emit_project_audit
from novelvideo.api.deps import resolve_project_scope
from novelvideo.interactive_story.publication import (
    PublicationError,
    public_version,
    player_version,
)
from novelvideo.utils.async_ops import call_blocking
from novelvideo.interactive_story.publication_storage import (
    invoke_active,
    project_store,
    public_store,
)

router = APIRouter()


class PrepareBody(BaseModel):
    canvas_id: str
    group_id: str
    revision: int = Field(ge=1)
    request_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    cover: str | None = None
    cover_mode: Literal["landscape", "portrait"] = "landscape"
    cover_position_x: float = Field(default=50, ge=0, le=100)
    cover_position_y: float = Field(default=50, ge=0, le=100)


class ActivateBody(BaseModel):
    version: str | None = None
    listed: bool = True


async def scope(project, canvas, group, user):
    resolved = await resolve_project_scope(project, user, required_role="editor")
    owner = hashlib.sha256(
        f"{Path(resolved.ctx.state_dir).resolve()}:{canvas}:{group}".encode()
    ).hexdigest()
    return resolved, owner


async def invoke(fn, *args):
    try:
        return await call_blocking(fn, *args)
    except PublicationError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from exc


async def invoke_mutation(store, operation, *args):
    try:
        return await invoke_active(store, operation, *args)
    except PublicationError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from exc


async def resolve_public_store(public_id):
    try:
        return await public_store(public_id)
    except PublicationError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from exc


def presentation(store, work):
    with store.locked():
        work = store.read(work["public_id"])
        return {
            "public_id": work["public_id"],
            "active_version": work["active_version"],
            "listed": work["listed"],
            "versions": [
                public_version(store.version(work["public_id"], v))
                for v in reversed(work["versions"])
            ],
        }


@router.get("/projects/{project}/canvases/{canvas}/stories/{group}/publication")
async def get_publication(
    project: str, canvas: str, group: str, user: dict = Depends(get_api_user)
):
    resolved, owner = await scope(project, canvas, group, user)
    store = await invoke(
        project_store,
        getattr(resolved.ctx, "project_id", project),
        Path(resolved.ctx.state_dir),
    )
    work = await invoke(store.work, owner, getattr(resolved.ctx, "project_id", project))
    return {"ok": True, "data": await invoke(presentation, store, work)}


@router.post(
    "/projects/{project}/canvases/{canvas}/stories/{group}/publication/prepare"
)
async def prepare(
    project: str,
    canvas: str,
    group: str,
    body: PrepareBody,
    background: BackgroundTasks,
    user: dict = Depends(get_api_user),
):
    if body.canvas_id != canvas or body.group_id != group or not body.title.strip():
        raise HTTPException(422, detail={"code": "invalid_request"})
    resolved, owner = await scope(project, canvas, group, user)
    store = await invoke(
        project_store,
        getattr(resolved.ctx, "project_id", project),
        Path(resolved.ctx.state_dir),
    )
    result = await invoke_mutation(
        store,
        store.prepare,
        owner,
        Path(resolved.ctx.state_dir),
        resolved.project_dir,
        project,
        body.model_dump(),
        getattr(resolved.ctx, "project_id", project),
    )
    if "_canvas" in result:
        background.add_task(store.finish, result)
    return {"ok": True, "data": public_version(result)}


@router.get(
    "/projects/{project}/canvases/{canvas}/stories/{group}/publication/{public_id}/versions/{version}"
)
async def preview(
    project: str,
    canvas: str,
    group: str,
    public_id: str,
    version: str,
    user: dict = Depends(get_api_user),
):
    resolved, owner = await scope(project, canvas, group, user)
    store = await invoke(
        project_store,
        getattr(resolved.ctx, "project_id", project),
        Path(resolved.ctx.state_dir),
    )
    await invoke(store.owned, public_id, owner)
    return {
        "ok": True,
        "data": public_version(await invoke(store.version, public_id, version)),
    }


@router.get(
    "/projects/{project}/canvases/{canvas}/stories/{group}/publication/{public_id}/versions/{version}/media/{asset}"
)
async def preview_media(
    project: str,
    canvas: str,
    group: str,
    public_id: str,
    version: str,
    asset: str,
    user: dict = Depends(get_api_user),
):
    resolved, owner = await scope(project, canvas, group, user)
    store = await invoke(
        project_store,
        getattr(resolved.ctx, "project_id", project),
        Path(resolved.ctx.state_dir),
    )
    await invoke(store.owned, public_id, owner)
    release = await invoke(store.version, public_id, version)
    return media_response(store, release, asset)


@router.post(
    "/projects/{project}/canvases/{canvas}/stories/{group}/publication/{public_id}/activate"
)
async def activate(
    project: str,
    canvas: str,
    group: str,
    public_id: str,
    body: ActivateBody,
    user: dict = Depends(get_api_user),
):
    resolved, owner = await scope(project, canvas, group, user)
    store = await invoke(
        project_store,
        getattr(resolved.ctx, "project_id", project),
        Path(resolved.ctx.state_dir),
    )
    work = await invoke_mutation(
        store, store.activate, public_id, owner, body.version, body.listed
    )
    await emit_project_audit(
        action="story_publication.activate"
        if body.version
        else "story_publication.set_availability",
        ctx=resolved.ctx,
        metadata={
            "public_id": public_id,
            "active_version": work["active_version"],
            "listed": work["listed"],
        },
    )
    return {"ok": True, "data": await invoke(presentation, store, work)}


@router.get("/public-stories/{public_id}")
@router.get("/public-stories/{public_id}/versions/{version}")
async def public_story(public_id: str, version: str | None = None):
    store = await resolve_public_store(public_id)
    return JSONResponse(
        player_version(await invoke(store.public, public_id, version)),
        headers={"Cache-Control": "no-store"},
    )


def media_response(store, release, asset):
    if asset not in release.get("assets", {}):
        raise HTTPException(404)
    path = store.directory(release["public_id"]) / release["version"] / "media" / asset
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(
        path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    )


@router.get("/public-stories/{public_id}/versions/{version}/media/{asset}")
async def public_media(public_id: str, version: str, asset: str):
    store = await resolve_public_store(public_id)
    release = await invoke(store.public, public_id, version)
    return media_response(store, release, asset)

"""Authorized, home-node-only HTML artifact APIs."""
from __future__ import annotations

from pathlib import Path
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from novelvideo.api.auth import get_api_user
from novelvideo.freezone.html_artifacts import ArtifactConflict, ArtifactStore, MAX_HTML_BYTES
from novelvideo.project_context import require_project_home_node, resolve_project_context

router = APIRouter(prefix='/projects/{project}/freezone/html-artifacts', tags=['freezone-html-artifacts'])


class ArtifactBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    html: str = Field(max_length=MAX_HTML_BYTES)


class UpdateBody(ArtifactBody):
    base_version: int = Field(ge=1, strict=True)


class RestoreBody(BaseModel):
    version: int = Field(ge=1, strict=True)
    base_version: int = Field(ge=1, strict=True)


async def _store(project: str, user: dict, role: str) -> ArtifactStore:
    ctx = await resolve_project_context(user=user, project_id=project, required_role=role)
    require_project_home_node(ctx, operation='access HTML artifact files')
    return ArtifactStore(Path(ctx.output_dir), project_id=ctx.project_id, owner_username=ctx.owner_username, project_name=ctx.project_name)


async def _call(fn, *args, **kwargs):
    try:
        return await run_in_threadpool(fn, *args, **kwargs)
    except ArtifactConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, 'Artifact or revision not found') from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except sqlite3.OperationalError as exc:
        raise HTTPException(503, 'Artifact storage temporarily unavailable; retry after reloading') from exc


def _data(value):
    return {'ok': True, 'data': value}


@router.post('')
async def create(project: str, body: ArtifactBody, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'editor')
    return _data(await _call(store.create, title=body.title, html=body.html))


@router.get('')
async def list_artifacts(project: str, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'viewer')
    return _data({'artifacts': await _call(store.list)})


@router.get('/{artifact_id}')
async def get(project: str, artifact_id: str, version: Annotated[int | None, Query(ge=1)] = None, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'viewer')
    return _data(await _call(store.get, artifact_id, version))


@router.put('/{artifact_id}')
async def update(project: str, artifact_id: str, body: UpdateBody, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'editor')
    return _data(await _call(store.update, artifact_id, title=body.title, html=body.html, base_version=body.base_version))


@router.get('/{artifact_id}/versions')
async def versions(project: str, artifact_id: str, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'viewer')
    return _data({'versions': await _call(store.versions, artifact_id)})


@router.post('/{artifact_id}/restore')
async def restore(project: str, artifact_id: str, body: RestoreBody, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'editor')
    return _data(await _call(store.restore, artifact_id, version=body.version, base_version=body.base_version))


@router.get('/{artifact_id}/preview')
async def preview(project: str, artifact_id: str, version: Annotated[int | None, Query(ge=1)] = None, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'viewer')
    return _data(await _call(store.preview, artifact_id, version))


@router.get('/{artifact_id}/export')
async def export(project: str, artifact_id: str, version: Annotated[int | None, Query(ge=1)] = None, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'viewer')
    content = await _call(store.export, artifact_id, version)
    return Response(content, media_type='application/zip', headers={'Content-Disposition': f'attachment; filename="html-artifact-{artifact_id}.zip"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

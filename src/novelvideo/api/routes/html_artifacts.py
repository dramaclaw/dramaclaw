"""Authorized, home-node-only HTML artifact APIs."""
from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from urllib.parse import quote
from pydantic import BaseModel, Field, model_validator
from starlette.concurrency import run_in_threadpool

from novelvideo.api.auth import get_api_user
from novelvideo.freezone.canvas_lock import CanvasLockBusy
from novelvideo.freezone.html_artifacts import ArtifactConflict, ArtifactStore, MAX_HTML_BYTES
from novelvideo.freezone.history import append_generation_history, build_node_history_record
from novelvideo.project_context import require_project_home_node, resolve_project_context

router = APIRouter(prefix='/projects/{project}/freezone/html-artifacts', tags=['freezone-html-artifacts'])


class NodeScope(BaseModel):
    canvas_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    node_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,128}$")

    @model_validator(mode='after')
    def complete_scope(self):
        if bool(self.canvas_id) != bool(self.node_id):
            raise ValueError('canvas_id and node_id must be supplied together')
        return self


class HistoryBody(NodeScope):
    version: int = Field(ge=1, strict=True)


class ArtifactBody(NodeScope):
    title: str = Field(min_length=1, max_length=200)
    html: str = Field(max_length=MAX_HTML_BYTES)


class UpdateBody(ArtifactBody):
    base_version: int = Field(ge=1, strict=True)


class RestoreBody(NodeScope):
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
    except (CanvasLockBusy, OSError) as exc:
        raise HTTPException(503, 'Artifact storage temporarily unavailable; retry after reloading') from exc


async def _with_history(store, artifact, scope):
    if not scope.node_id:
        return artifact
    try:
        record = build_node_history_record(
            task_type='freezone_html_artifact',
            job_id=f"{artifact['id']}:v{artifact['version']}",
            task_key=f"html:{artifact['id']}:{artifact['version']}",
            status='completed', media_type='html',
            result={'artifact_id': artifact['id'], 'version': artifact['version'], 'title': artifact['title']},
        )
        await run_in_threadpool(append_generation_history, project_dir=store.project_dir,
                                canvas_id=scope.canvas_id, node_id=scope.node_id, record=record)
    except OSError:
        # Source is saved: do not invite a duplicate create/update on retry.
        return {**artifact, 'warnings': ['网页已保存，但节点历史记录失败，请稍后重试。']}
    return artifact


def _data(value):
    return {'ok': True, 'data': value}


@router.post('')
async def create(project: str, body: ArtifactBody, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'editor')
    return _data(await _with_history(store, await _call(store.create, title=body.title, html=body.html), body))


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
    return _data(await _with_history(store, await _call(store.update, artifact_id, title=body.title, html=body.html, base_version=body.base_version), body))


@router.get('/{artifact_id}/versions')
async def versions(project: str, artifact_id: str, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'viewer')
    return _data({'versions': await _call(store.versions, artifact_id)})


@router.post('/{artifact_id}/restore')
async def restore(project: str, artifact_id: str, body: RestoreBody, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'editor')
    return _data(await _with_history(store, await _call(store.restore, artifact_id, version=body.version, base_version=body.base_version), body))


@router.get('/{artifact_id}/preview')
async def preview(project: str, artifact_id: str, version: Annotated[int | None, Query(ge=1)] = None, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'viewer')
    return _data(await _call(store.preview, artifact_id, version))


@router.get('/{artifact_id}/export')
async def export(project: str, artifact_id: str, version: Annotated[int | None, Query(ge=1)] = None, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'viewer')
    path = await _call(store.export_file, artifact_id, version)
    relative = path.relative_to(store.project_dir).as_posix()
    return _data({'download_url': '/api/v1/projects/' + quote(store.project_id, safe='') + '/files/' + quote(relative, safe='/')})


@router.post('/{artifact_id}/node-history')
async def record_node_history(project: str, artifact_id: str, body: HistoryBody, user: dict = Depends(get_api_user)):
    store = await _store(project, user, 'editor')
    if not body.node_id:
        raise HTTPException(400, 'Node scope is required')
    artifact = await _call(store.get, artifact_id, body.version)
    return _data(await _with_history(store, artifact, body))

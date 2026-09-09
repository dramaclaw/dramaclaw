"""Requester-scoped external Skill conversion jobs and candidate installation."""
from __future__ import annotations

import fcntl
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from novelvideo.api.deps import get_api_user
from novelvideo.api.routes.freezone import _resolve_freezone_project
from novelvideo.freezone.skill_import import (
    bind_task, create_record, get_record, public_record, read_source, record_path, save_record,
)
from novelvideo.ports import get_task_backend

router = APIRouter(prefix='/projects/{project}/freezone/skill-imports', tags=['freezone-agent-config'])


class SourceFile(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(max_length=2796210)


class ImportRequest(BaseModel):
    files: list[SourceFile] = Field(min_length=1, max_length=20)
    batch_name: str = Field(default='', max_length=200)


class InstallRequest(BaseModel):
    bundle: dict | None = None
    acknowledge_warnings: bool = False


async def scope(project, user):
    ctx, *_ = await _resolve_freezone_project(project, user)
    return ctx, Path(ctx.state_dir), ctx.requester_username


def read_item(root, username, import_id):
    try:
        return get_record(root, username, import_id)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, 'Skill import not found') from None


def reconcile(ctx, root, username, record):
    from novelvideo.task_state import get_task_manager
    if record['status'] in {'queued', 'running'} and record.get('task_id'):
        state = get_task_manager().get_task_for_project(ctx, 'freezone_skill_import', 0, scope=record['id'])
        if state and state.task_id == record['task_id'] and state.status in {'failed', 'cancelled'}:
            record.update(status='failed', error=f'Background task {state.status}')
            save_record(root, username, record)
    return record


async def enqueue(ctx, root, username, record):
    try:
        queued = await get_task_backend().enqueue_project_task(
            ctx, product_surface='freezone', task_type='freezone_skill_import',
            queue_kind='default', episode=0, scope=record['id'],
            payload={'import_id': record['id'], 'username': username,
                     'name': record['name'], 'display_name': record['name'],
                     'display_name_user_content': True, 'task_label': '外部 Skill 转换',
                     'batch_id': record['batch_id']})
        # The local backend may already have started the worker; don't overwrite its state.
        latest = bind_task(root, username, record['id'], queued.task_state.task_id)
        return public_record(latest)
    except Exception:
        record.update(status='failed', stage='enqueue', error='Unable to enqueue conversion task')
        save_record(root, username, record)
        raise


@router.post('')
async def submit(project: str, payload: ImportRequest, user: dict = Depends(get_api_user)):
    ctx, root, username = await scope(project, user)
    if sum(len(item.content_base64) for item in payload.files) > 10 * 1024 * 1024 * 4 // 3 + 100:
        raise HTTPException(400, 'Batch exceeds 10 MiB')
    try:
        sources = [read_source(item.name, item.content_base64) for item in payload.files]
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    batch_id = uuid.uuid4().hex
    records = [create_record(root, username, source, batch_id, payload.batch_name) for source in sources]
    items = []
    for record in records:
        try:
            items.append(await enqueue(ctx, root, username, record))
        except Exception:
            items.append(public_record(get_record(root, username, record['id'])))
    return {'ok': True, 'data': {'batch_id': batch_id, 'items': items}}


@router.get('')
async def listing(project: str, user: dict = Depends(get_api_user)):
    ctx, root, username = await scope(project, user)
    folder = record_path(root, username, '0' * 32).parent
    items = [public_record(reconcile(ctx, root, username, get_record(root, username, p.stem))) for p in folder.glob('*.json')]
    return {'ok': True, 'data': {'items': sorted(items, key=lambda item: item['created_at'], reverse=True)}}


@router.get('/{import_id}')
async def detail(project: str, import_id: str, user: dict = Depends(get_api_user)):
    ctx, root, username = await scope(project, user)
    return {'ok': True, 'data': public_record(reconcile(ctx, root, username, read_item(root, username, import_id)))}


@router.post('/{import_id}/retry')
async def retry(project: str, import_id: str, user: dict = Depends(get_api_user)):
    ctx, root, username = await scope(project, user)
    read_item(root, username, import_id)
    with record_path(root, username, import_id).with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(409, 'Import is already being updated') from None
        record = reconcile(ctx, root, username, read_item(root, username, import_id))
        if record['status'] not in {'failed', 'needs_review', 'ready'}:
            raise HTTPException(409, 'Only failed or needs-review conversions can be retried')
        structure_failed = (record.get('quality_report') or {}).get('structure', {}).get('status') == 'failed'
        if record['status'] in {'needs_review', 'ready'} and not structure_failed and not record.get('error'):
            # Explicit regeneration revisits semantic choices; transport failures resume checkpoints.
            record['checkpoints'] = {}
        record.pop('validation_candidate', None)
        record.pop('quality_report', None)
        record.update(status='queued', stage='queued', error=None)
        save_record(root, username, record)
        return {'ok': True, 'data': await enqueue(ctx, root, username, record)}


@router.post('/{import_id}/install')
async def install(project: str, import_id: str, payload: InstallRequest, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.agent_bundle_store import install_agent_bundle
    _, root, username = await scope(project, user)
    # Serialize installs of one candidate across API worker processes.
    path = record_path(root, username, import_id)
    read_item(root, username, import_id)
    with path.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(409, 'Import is already being updated') from None
        record = read_item(root, username, import_id)
        if record['status'] == 'installed':
            return {'ok': True, 'data': public_record(record)}
        if record['status'] not in {'ready', 'needs_review'}:
            raise HTTPException(409, 'Conversion has no installable candidate')
        if (record['warnings'] or record['status'] == 'needs_review') and not payload.acknowledge_warnings:
            raise HTTPException(409, 'Review conversion warnings and acknowledge them before installing')
        bundle = payload.bundle if payload.bundle is not None else record['bundle']
        from novelvideo.freezone.skill_import_contracts import install_quality_errors
        issues = install_quality_errors(record, bundle or {})
        if issues:
            raise HTTPException(409, '; '.join(issues))
        try:
            result = install_agent_bundle(username=username, payload=bundle or {})
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        record.update(status='installed', stage='done', bundle=bundle, installation=result)
        save_record(root, username, record)
    return {'ok': True, 'data': public_record(record)}


@router.post('/{import_id}/validate')
async def validate_draft(project: str, import_id: str, payload: InstallRequest, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.agent_bundle_store import validate_agent_bundle
    ctx, root, username = await scope(project, user)
    read_item(root, username, import_id)
    with record_path(root, username, import_id).with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(409, 'Import is already being updated') from None
        record = reconcile(ctx, root, username, read_item(root, username, import_id))
        if record['status'] not in {'ready', 'needs_review', 'failed'}:
            raise HTTPException(409, 'Wait for conversion to finish before validating a draft')
        try:
            bundle = validate_agent_bundle(payload.bundle or record.get('bundle') or {}, username=username)['bundle']
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        record.update(validation_candidate=bundle, bundle=bundle, status='queued', stage='queued', error=None)
        record.pop('quality_report', None)
        save_record(root, username, record)
        return {'ok': True, 'data': await enqueue(ctx, root, username, record)}

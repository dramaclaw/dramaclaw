import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException

from inline_task_owner_helper import task_context
from novelvideo.freezone import workflow_runs as store
from novelvideo.task_backend.runners import freezone


def test_drive_runner_registration():
    from novelvideo.task_backend.registry import (
        get_project_task_runner,
        project_task_requires_home_node,
    )

    assert get_project_task_runner('freezone_workflow_drive') is not None
    assert project_task_requires_home_node('freezone_workflow_drive') is True


@pytest.mark.asyncio
async def test_drive_task_factory_and_result(tmp_path, monkeypatch):
    ctx = SimpleNamespace(state_dir=tmp_path)
    run = store.create_workflow_run(
        project_dir=tmp_path, project_id='project', canvas_id='default', owner_kind='server',
        actions=[{'node_id': 'one', 'action': 'save'}],
    )
    seen = []

    class Runner:
        def supports(self, action):
            return True

        async def run_action(self, **kwargs):
            return {'status': 'completed', 'output': {}}

    def factory(context, acquired, runner_id, assert_lease):
        assert_lease()
        seen.append((context, acquired['run_id'], runner_id))
        return Runner()

    monkeypatch.setattr(freezone, '_server_action_runner_factory', factory)
    result = await freezone._run_freezone_workflow_drive_async({
        '__run_task_id': 'task-1', 'payload': {'canvas_id': 'default', 'run_id': run['run_id']},
    }, ctx)
    assert result == {
        'status': 'completed', 'run_id': run['run_id'], 'runner_id': 'drive:task-1',
        'took_over': False,
    }
    assert seen == [(ctx, run['run_id'], 'drive:task-1')]


@pytest.mark.asyncio
@pytest.mark.parametrize('payload', [
    {}, {'canvas_id': 'default'}, {'run_id': 'run_x'}, 'invalid', ['invalid'],
])
async def test_drive_task_rejects_incomplete_payload(tmp_path, payload):
    with pytest.raises(ValueError, match='canvas_id|run_id'):
        await freezone._run_freezone_workflow_drive_async(
            {'__run_task_id': 'task-1', 'payload': payload}, SimpleNamespace(state_dir=tmp_path),
        )


@pytest.fixture
def indexed(tmp_path, monkeypatch):
    from novelvideo import config
    from novelvideo.freezone import server_workflow_index as index

    monkeypatch.setattr(config, 'STATE_DIR', tmp_path / 'index')
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    run = store.create_workflow_run(
        project_dir=tmp_path, project_id='project', canvas_id='default', owner_kind='server',
        actions=[{'node_id': 'one', 'action': 'save'}], now=now,
    )
    entry = dict(
        project_id='project', state_dir=str(tmp_path), canvas_id='default',
        run_id=run['run_id'], requester={'user_id': 'requester', 'username': 'requester'},
    )
    index.register_server_workflow_run(**entry)
    return index, now, entry


@pytest.mark.asyncio
async def test_sweep_generations_and_terminal_cleanup(indexed, monkeypatch):
    from novelvideo import project_context

    index, now, entry = indexed
    ctx = task_context(Path(entry['state_dir']))
    resolved = []

    async def resolve(**kwargs):
        resolved.append(kwargs)
        return ctx

    monkeypatch.setattr(project_context, 'resolve_project_context', resolve)
    queued = []

    async def enqueue(context, **kwargs):
        assert context is ctx
        queued.append(kwargs)

    assert (await index.sweep_server_workflow_runs(now=now, enqueue=enqueue))[0][
        'action'
    ] == 'enqueued'
    assert (await index.sweep_server_workflow_runs(now=now, enqueue=enqueue))[0][
        'action'
    ] == 'skipped'
    await index.sweep_server_workflow_runs(
        now=now + timedelta(seconds=180), enqueue=enqueue,
    )
    run_id = entry['run_id']
    assert queued == [{
        'task_type': 'freezone_workflow_drive', 'product_surface': 'freezone_assistant',
        'queue_kind': 'default', 'scope': f'{run_id}:d{n}',
        'payload': {'canvas_id': 'default', 'run_id': run_id},
    } for n in (1, 2)]
    assert resolved[0] == {
        'user': {'id': 'requester', 'username': 'requester'},
        'project_id': 'project', 'required_role': 'editor',
    }
    store.update_workflow_run(
        project_dir=Path(entry['state_dir']), canvas_id='default', run_id=run_id,
        status='cancelled',
    )
    assert await index.sweep_server_workflow_runs(now=now, enqueue=enqueue) == [
        {'run_id': run_id, 'action': 'unregistered'},
    ]
    assert index.list_server_workflow_runs() == []


@pytest.mark.asyncio
async def test_sweep_access_lost(indexed, monkeypatch):
    from novelvideo import project_context

    index, now, entry = indexed

    async def resolve(**kwargs):
        raise HTTPException(403, 'access lost')

    monkeypatch.setattr(project_context, 'resolve_project_context', resolve)
    result = await index.sweep_server_workflow_runs(now=now)
    assert result == [{'run_id': entry['run_id'], 'action': 'failed'}]
    assert index.list_server_workflow_runs() == []
    assert store.read_workflow_run(
        project_dir=Path(entry['state_dir']), canvas_id='default', run_id=entry['run_id'],
    )['status'] == 'failed'


def test_index_corrupt_file_and_idempotent_registration(indexed):
    from novelvideo import config

    index, _, entry = indexed
    index.register_server_workflow_run(**entry)
    assert index.list_server_workflow_runs() == [entry]
    (config.STATE_DIR / 'server_workflow_runs.json').write_text('{broken')
    assert index.list_server_workflow_runs() == []


@pytest.mark.asyncio
async def test_app_sweeper_lifecycle(monkeypatch):
    from novelvideo.api import app
    from novelvideo.freezone import server_workflow_index as index

    entered, stopped = asyncio.Event(), asyncio.Event()

    async def sweep():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(index, 'run_server_workflow_sweeper', sweep)
    application = FastAPI()
    app._start_server_workflow_sweeper(application)
    await asyncio.wait_for(entered.wait(), 2)
    await app._stop_server_workflow_sweeper(application)
    assert stopped.is_set() is True
    assert application.state.server_workflow_sweeper.cancelled() is True


@pytest.mark.asyncio
async def test_sweep_enqueue_error_is_retried_in_next_window(indexed, monkeypatch):
    from novelvideo import project_context

    index, now, entry = indexed

    async def resolve(**kwargs):
        return task_context(Path(entry['state_dir']))

    async def full(context, **kwargs):
        raise RuntimeError('lane is full')

    monkeypatch.setattr(project_context, 'resolve_project_context', resolve)
    assert await index.sweep_server_workflow_runs(now=now, enqueue=full) == [
        {'run_id': entry['run_id'], 'action': 'skipped'},
    ]
    assert index.list_server_workflow_runs() == [entry]
    queued = []

    async def enqueue(context, **kwargs):
        queued.append(kwargs['scope'])

    await index.sweep_server_workflow_runs(now=now, enqueue=enqueue)
    assert queued == []
    await index.sweep_server_workflow_runs(
        now=now + timedelta(seconds=180), enqueue=enqueue,
    )
    assert queued == [f"{entry['run_id']}:d2"]


@pytest.mark.asyncio
@pytest.mark.parametrize('elapsed,access,clear_error,expected', [
    (179, True, False, 'skipped'),
    (180, True, False, 'unregistered'),
    (180, False, False, 'unregistered'),
    (180, True, True, 'skipped'),
])
async def test_terminal_sweep_cleans_after_driver_lease(
    indexed, monkeypatch, elapsed, access, clear_error, expected,
):
    from novelvideo import project_context
    from novelvideo.api import freezone_server_workflow_host as host

    index, now, entry = indexed
    scope = dict(project_dir=Path(entry['state_dir']), canvas_id='default', run_id=entry['run_id'])
    store.acquire_server_workflow_run(**scope, runner_id='driver', now=now)
    store.update_workflow_run(**scope, status='cancelled', now=now)
    ctx = task_context(Path(entry['state_dir']))
    cleared, resolved = [], []

    async def resolve(**kwargs):
        resolved.append(kwargs)
        if not access:
            raise HTTPException(403, 'access lost')
        return ctx

    async def clear(**kwargs):
        cleared.append(kwargs)
        if clear_error:
            raise RuntimeError('write unavailable')

    monkeypatch.setattr(project_context, 'resolve_project_context', resolve)
    monkeypatch.setattr(host, 'clear_server_generation_markers', clear, raising=False)
    assert await index.sweep_server_workflow_runs(now=now + timedelta(seconds=elapsed)) == [
        {'run_id': entry['run_id'], 'action': expected}]
    assert index.list_server_workflow_runs() == ([entry] if expected == 'skipped' else [])
    assert cleared == ([dict(ctx=ctx, canvas_id='default', run_id=entry['run_id'])]
                       if elapsed >= 180 and access else [])
    assert resolved == ([{
        'user': {'id': 'requester', 'username': 'requester'},
        'project_id': 'project', 'required_role': 'editor',
    }] if elapsed >= 180 else [])


@pytest.mark.asyncio
async def test_sweeper_uses_shared_enqueue_helper(indexed, monkeypatch):
    from novelvideo import project_context

    index, now, entry = indexed
    ctx = task_context(Path(entry['state_dir']))
    queued = []

    async def resolve(**kwargs):
        return ctx

    async def enqueue(context, **kwargs):
        queued.append((context, kwargs))

    monkeypatch.setattr(project_context, 'resolve_project_context', resolve)
    monkeypatch.setattr(index, 'enqueue_server_workflow_drive', enqueue, raising=False)
    async def unexpected_enqueue(*args, **kwargs):
        raise AssertionError('sweeper must use the shared enqueue helper')

    from novelvideo.task_backend import client
    monkeypatch.setattr(client, 'enqueue_project_task', unexpected_enqueue)
    assert await index.sweep_server_workflow_runs(now=now) == [
        {'run_id': entry['run_id'], 'action': 'enqueued'}]
    assert queued == [(ctx, {
        'canvas_id': 'default', 'run_id': entry['run_id'], 'generation': 1, 'enqueue': None})]


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['completed', 'failed', 'cancelled'])
async def test_drive_confirmation_terminal_notice_once(tmp_path, monkeypatch, status):
    from novelvideo.api.routes import chat
    from novelvideo.freezone import canvas_confirmations as confirmations
    from novelvideo.freezone import server_workflow_driver as driver

    directory = confirmations.confirmations_dir('requester', 'main', tmp_path)
    record = confirmations.create_confirmation(
        directory, project_id='project', canvas_id='default', agent_id='main',
        username='requester', turn_id='t1', now=1000,
        commands=[{'type': 'run_workflow', 'scope': 'canvas'}], targets=[])
    run = store.create_workflow_run(
        project_dir=tmp_path, project_id='project', canvas_id='default', owner_kind='server',
        actions=[{'node_id': 'one', 'action': 'save'}],
        metadata={'confirmation': {'id': record['id'], 'username': 'requester', 'agent_id': 'main'},
                  'requester': {'user_id': 'requester-id', 'username': 'requester'}})
    scope = dict(project_dir=tmp_path, canvas_id='default', run_id=run['run_id'])
    store.update_workflow_run(
        **scope, status=status, owner_kind="server",
        action_updates=[{'node_id': 'one', 'action': 'save', 'status': 'completed'}])
    acquired = [True]

    async def drive(**kwargs):
        return {'status': status, 'run_id': run['run_id'], 'acquired': acquired[0]}

    notices = []

    async def notice(user, saved, kind, detail=''):
        notices.append((user, saved['id'], kind, detail))

    monkeypatch.setattr(driver, 'drive_server_workflow_run', drive)
    monkeypatch.setattr(chat, 'append_canvas_confirmation_notice', notice)
    envelope = {'__run_task_id': 'task-1',
                'payload': {'canvas_id': 'default', 'run_id': run['run_id']}}
    result = await freezone._run_freezone_workflow_drive_async(
        envelope, SimpleNamespace(state_dir=tmp_path))
    assert result['status'] == status
    assert notices == [({'id': 'requester-id', 'username': 'requester'}, record['id'],
                        f'run_{status}', f"{run['run_id']}: 1 completed, 0 failed")]
    acquired[0] = False
    await freezone._run_freezone_workflow_drive_async(envelope, SimpleNamespace(state_dir=tmp_path))
    assert notices == [({'id': 'requester-id', 'username': 'requester'}, record['id'],
                        f'run_{status}', f"{run['run_id']}: 1 completed, 0 failed")]


@pytest.mark.asyncio
@pytest.mark.parametrize("status,acquired,broken,expected", [
    ("completed", True, False, True), ("failed", True, False, True),
    ("cancelled", True, False, True), ("running", True, False, False),
    ("completed", False, False, False), ("completed", True, True, True),
])
async def test_drive_delivers_terminal_result(
    tmp_path, monkeypatch, status, acquired, broken, expected,
):
    from novelvideo.api.routes import freezone as routes
    from novelvideo.freezone import server_workflow_driver as driver

    ctx = task_context(tmp_path)
    result = {"status": status, "acquired": acquired, "run_id": "run_delivery"}
    delivered = []

    async def drive(**kwargs):
        return result

    async def maintain(context, canvas_id):
        delivered.append((context, canvas_id))
        if broken:
            raise RuntimeError("delivery unavailable")

    monkeypatch.setattr(driver, "drive_server_workflow_run", drive)
    monkeypatch.setattr(routes, "maintain_server_workflow_canvas", maintain, raising=False)
    returned = await freezone._run_freezone_workflow_drive_async({
        "__run_task_id": "delivery-task",
        "payload": {"canvas_id": "default", "run_id": "run_delivery"},
    }, ctx)
    assert returned == {"status": status, "acquired": acquired, "run_id": "run_delivery"}
    assert delivered == ([(ctx, "default")] if expected else [])

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException

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
    ctx = SimpleNamespace(project_id='project')
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
        return SimpleNamespace(project_id='project')

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

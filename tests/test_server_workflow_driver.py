import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from novelvideo.freezone import workflow_runs as store


class Clock:
    def __init__(self):
        self.value = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.delays = []
        self.ticks = asyncio.Queue()
        self.polls = asyncio.Queue()

    def now(self):
        return self.value

    def advance(self, seconds):
        self.value += timedelta(seconds=seconds)

    async def sleep(self, seconds):
        if seconds == 5.0:
            await self.polls.put(True)
            await self.ticks.get()
        else:
            self.delays.append(seconds)
            self.advance(seconds)
            await asyncio.sleep(0)


class FakeRunner:
    def __init__(self, scope, *, scripts=None, supported=True, capacity=None):
        self.scope = scope
        self.scripts = scripts or {}
        self.supported = supported
        self.capacity = list(capacity or [1])
        self.calls = []
        self.started = asyncio.Queue()
        self.release = None
        self.stopped = False
        self.snapshots = []
        self.node_snapshots = {}

    def supports(self, action):
        return self.supported

    async def lane_capacity(self, lane):
        value = self.capacity[0]
        if len(self.capacity) > 1:
            self.capacity.pop(0)
        self.snapshots.append(await asyncio.to_thread(store.read_workflow_run, **self.scope))
        return value

    async def run_action(self, *, node_id, action, existing_task, on_accepted,
                         on_phase, should_stop):
        self.calls.append((node_id, existing_task))
        self.snapshots.append(await asyncio.to_thread(store.read_workflow_run, **self.scope))
        self.node_snapshots[node_id] = self.snapshots[-1]
        if existing_task is None:
            await on_accepted({
                'task_key': f'task:{node_id}', 'task_type': 'freezone_gen', 'job_id': node_id,
            })
        await on_phase('generating')
        await self.started.put(node_id)
        if self.release is not None:
            try:
                await self.release.wait()
            finally:
                self.stopped = should_stop()
        if should_stop():
            return {'status': 'stopped'}
        outcomes = self.scripts.get(node_id)
        return outcomes.pop(0) if outcomes else {
            'status': 'completed', 'output': {'url': '/static/x.png'},
        }


def setup_run(tmp_path, clock, actions=None, levels=None):
    actions = actions or [
        {'node_id': 'one', 'action': 'generate_image'},
        {'node_id': 'two', 'action': 'generate_image'},
        {'node_id': 'three', 'action': 'generate_image'},
    ]
    run = store.create_workflow_run(
        project_dir=tmp_path, project_id='project', canvas_id='default',
        actions=actions, metadata={'levels': levels or [[0, 1], [2]]},
        owner_kind='server', now=clock.now(),
    )
    return dict(project_dir=tmp_path, canvas_id='default', run_id=run['run_id'])


async def drive(scope, clock, runner, runner_id='driver'):
    from novelvideo.freezone.server_workflow_driver import drive_server_workflow_run

    return await drive_server_workflow_run(
        **scope, runner_id=runner_id, action_runner_factory=lambda run, guard: runner,
        now=clock.now, sleep=clock.sleep,
    )


@pytest.mark.asyncio
async def test_levels_and_task_identity(tmp_path):
    clock = Clock()
    scope = setup_run(tmp_path, clock)
    runner = FakeRunner(scope)
    result = await drive(scope, clock, runner)
    assert result['status'] == 'completed'
    run = store.read_workflow_run(**scope)
    assert run['status'] == 'completed'
    assert [a['status'] for a in run['actions']] == ['completed'] * 3
    assert run['actions'][0]['task_key'] == 'task:one'
    assert run['actions'][0]['task_type'] == 'freezone_gen'
    assert run['actions'][0]['job_id'] == 'one'
    assert [a['status'] for a in runner.node_snapshots['three']['actions'][:2]] == [
        'completed', 'completed',
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize('error, expected', [('HTTP 503', 'completed'), ('HTTP 401', 'failed')])
async def test_retry_or_final_failure(tmp_path, error, expected):
    clock = Clock()
    scope = setup_run(tmp_path, clock, levels=[[0], [1, 2]])
    runner = FakeRunner(scope, scripts={'one': [{'status': 'failed', 'error': error}]})
    result = await drive(scope, clock, runner)
    run = store.read_workflow_run(**scope)
    assert result['status'] == expected
    if expected == 'completed':
        assert run['actions'][0]['retry_count'] == 1
        assert clock.delays == [1.0]
        assert runner.calls[:2] == [('one', None), ('one', None)]
        assert runner.node_snapshots['one']['actions'][0]['task_key'] is None
    else:
        assert [a['status'] for a in run['actions']] == ['failed', 'blocked', 'blocked']


@pytest.mark.asyncio
async def test_completion_stores_the_runner_artifact(tmp_path):
    clock = Clock()
    scope = setup_run(tmp_path, clock, actions=[{'node_id': 'one', 'action': 'generate_image'}],
                      levels=[[0]])
    runner = FakeRunner(scope, scripts={'one': [{
        'status': 'completed', 'output': {'task_key': 'task:one', 'imageUrl': 'x'},
        'artifact': {'output_url': '/api/projects/project/static/one.png'},
    }]})
    assert (await drive(scope, clock, runner))['status'] == 'completed'
    action = store.read_workflow_run(**scope)['actions'][0]
    assert (action['status'], action['artifact_status']) == ('completed', 'valid')


@pytest.mark.asyncio
async def test_unsupported(tmp_path):
    clock = Clock()
    scope = setup_run(tmp_path, clock)
    result = await drive(scope, clock, FakeRunner(scope, supported=False))
    assert result['status'] == 'failed'
    assert store.read_workflow_run(**scope)['actions'][0]['error'] == (
        '工作流动作 generate_image 需要打开画布运行'
    )


@pytest.mark.asyncio
async def test_takeover_resumes_submitted_task(tmp_path):
    clock = Clock()
    scope = setup_run(tmp_path, clock)
    store.acquire_server_workflow_run(**scope, runner_id='dead', now=clock.now())
    store.update_workflow_run(
        **scope, owner_kind='server', runner_id='dead', now=clock.now(),
        action_updates=[{'node_id': 'one', 'action': 'generate_image', 'status': 'running',
                         'task_key': 'task:original', 'task_type': 'freezone_gen',
                         'job_id': 'job'}],
    )
    clock.advance(181)
    runner = FakeRunner(scope)
    result = await drive(scope, clock, runner)
    assert result['took_over'] is True
    assert store.read_workflow_run(**scope)['metadata']['takeover_count'] == 1
    assert ('one', {
        'task_key': 'task:original', 'task_type': 'freezone_gen', 'job_id': 'job',
    }) in runner.calls
    action = store.read_workflow_run(**scope)['actions'][0]
    assert action['task_key'] == 'task:original'


@pytest.mark.asyncio
async def test_live_driver_supersedes_second(tmp_path):
    clock = Clock()
    scope = setup_run(tmp_path, clock)
    store.acquire_server_workflow_run(**scope, runner_id='first', now=clock.now())
    before = store.read_workflow_run(**scope)
    result = await drive(scope, clock, FakeRunner(scope), runner_id='second')
    assert result['status'] == 'superseded'
    assert store.read_workflow_run(**scope) == before


@pytest.mark.asyncio
@pytest.mark.parametrize('mode, expected', [('cancel', 'cancelled'), ('takeover', 'lease_lost')])
async def test_stop_during_action(tmp_path, mode, expected):
    clock = Clock()
    scope = setup_run(tmp_path, clock, levels=[[0], [1, 2]])
    runner = FakeRunner(scope)
    runner.release = asyncio.Event()
    task = asyncio.create_task(drive(scope, clock, runner))
    try:
        assert await asyncio.wait_for(runner.started.get(), 2) == 'one'
        if mode == 'cancel':
            store.update_workflow_run(**scope, status='cancelled', now=clock.now())
        else:
            clock.advance(181)
            store.acquire_server_workflow_run(**scope, runner_id='replacement', now=clock.now())
        before = store.read_workflow_run(**scope)
        await clock.ticks.put(True)
        result = await asyncio.wait_for(task, 2)
        assert result['status'] == expected
        assert runner.stopped is True
        assert store.read_workflow_run(**scope) == before
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('action, limit', [('generate_video', 3), ('generate_3gs_world', 1)])
async def test_lane_limits(tmp_path, action, limit):
    clock = Clock()
    scope = setup_run(tmp_path, clock, actions=[
        {'node_id': str(n), 'action': action} for n in range(4)
    ], levels=[[0, 1, 2, 3]])
    runner = FakeRunner(scope)
    runner.release = asyncio.Event()
    task = asyncio.create_task(drive(scope, clock, runner))
    try:
        for _ in range(limit):
            await asyncio.wait_for(runner.started.get(), 2)
        assert len(runner.calls) == limit
        runner.release.set()
        assert (await asyncio.wait_for(task, 2))['status'] == 'completed'
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_capacity_wait(tmp_path):
    clock = Clock()
    scope = setup_run(tmp_path, clock, levels=[[0], [1, 2]])
    runner = FakeRunner(scope, capacity=[0, 1])
    assert (await drive(scope, clock, runner))['status'] == 'completed'
    assert runner.snapshots[1]['actions'][0]['phase'] == 'waiting_capacity'
    assert clock.delays == [2.0]


@pytest.mark.asyncio
async def test_stalled_factory_cannot_write_past_lease(tmp_path):
    from novelvideo.freezone.server_workflow_driver import drive_server_workflow_run

    clock = Clock()
    scope = setup_run(tmp_path, clock)

    def factory(run, guard):
        clock.advance(181)
        guard()
        raise AssertionError('expired factory continued')

    result = await drive_server_workflow_run(
        **scope, runner_id='driver', action_runner_factory=factory,
        now=clock.now, sleep=clock.sleep,
    )
    assert result['status'] == 'lease_lost'
    assert [a['status'] for a in store.read_workflow_run(**scope)['actions']] == [
        'pending', 'pending', 'pending',
    ]


@pytest.mark.asyncio
async def test_heartbeat_keeps_blocked_action_alive_until_action_timeout(tmp_path):
    clock = Clock()
    scope = setup_run(tmp_path, clock, levels=[[0], [1, 2]])
    runner = FakeRunner(scope)
    runner.release = asyncio.Event()
    task = asyncio.create_task(drive(scope, clock, runner))
    try:
        await asyncio.wait_for(runner.started.get(), 2)
        await asyncio.wait_for(clock.polls.get(), 2)
        for _ in range(29):
            clock.advance(60)
            await clock.ticks.put(True)
            await asyncio.wait_for(clock.polls.get(), 2)
        run = store.read_workflow_run(**scope)
        assert run['status'] == 'running'
        assert run['lease_expires_at'] == '2026-01-01T00:32:00Z'
        clock.advance(60)
        await clock.ticks.put(True)
        assert (await asyncio.wait_for(task, 2))['status'] == 'failed'
        run = store.read_workflow_run(**scope)
        assert run['actions'][0]['error'] == 'workflow action timed out'
        assert [a['status'] for a in run['actions']] == ['failed', 'blocked', 'blocked']
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('levels', [None, [[0]], [[-1], [0], [1]], [[True], [1], [2]]])
async def test_invalid_levels_fall_back_to_stored_order(tmp_path, levels):
    clock = Clock()
    scope = setup_run(tmp_path, clock)
    # Metadata is input at creation, not a driver implementation detail.
    store.update_workflow_run(**scope, status='cancelled', now=clock.now())
    run = store.create_workflow_run(
        project_dir=tmp_path, project_id='project', canvas_id='default', owner_kind='server',
        actions=[{'node_id': str(n), 'action': 'save'} for n in range(3)],
        metadata={'levels': levels}, now=clock.now(),
    )
    scope['run_id'] = run['run_id']
    runner = FakeRunner(scope)
    assert (await drive(scope, clock, runner))['status'] == 'completed'
    assert runner.calls == [('0', None), ('1', None), ('2', None)]


@pytest.mark.parametrize('error, retryable', [
    ('recipe attempt ended (failed); HTTP 503', False),
    ('HTTP 403', False), ('queue is full', True), ('HTTP 429', True),
    ('model_not_found HTTP 503', False), ('timed out', False),
])
def test_browser_retry_markers(error, retryable):
    from novelvideo.freezone.server_workflow_driver import is_retryable_workflow_action_error

    assert is_retryable_workflow_action_error(error) is retryable


async def test_drive_metrics_takeover_and_unacquired_replay(tmp_path, caplog):
    import logging

    from novelvideo.freezone import agent_canvas_metrics as metrics

    clock = Clock()
    scope = setup_run(tmp_path, clock, actions=[
        {"node_id": "one", "action": "generate_image"}
    ], levels=[[0]])
    store.acquire_server_workflow_run(**scope, runner_id="previous", now=clock.now())
    clock.advance(181)
    runner = FakeRunner(scope, scripts={"one": [{"status": "failed", "error": "HTTP 503"}]})
    before = metrics.metrics_snapshot()
    observed = metrics.observations_snapshot().get("workflow_run.drive_ms", {})
    with caplog.at_level(logging.INFO, logger="novelvideo.freezone.server_workflow_driver"):
        result = await drive(scope, clock, runner)
    assert result == {
        "status": "completed", "run_id": scope["run_id"], "runner_id": "driver", "took_over": True
    }
    after = metrics.metrics_snapshot()
    assert after["workflow_run.takeover"] - before.get("workflow_run.takeover", 0) == 1
    assert (
        after["workflow_run.drive.completed"] - before.get("workflow_run.drive.completed", 0) == 1
    )
    timing = metrics.observations_snapshot()["workflow_run.drive_ms"]
    assert timing["count"] == observed.get("count", 0) + 1
    assert timing["total"] == observed.get("total", 0.0) + 1000.0
    assert caplog.records[-1].getMessage() == (
        f"Server workflow drive ended run_id={scope['run_id']} status=completed "
        "took_over=True duration_ms=1000"
    )
    replay = await drive(scope, clock, runner)
    assert replay == {
        "status": "completed", "run_id": scope["run_id"], "runner_id": "driver",
        "took_over": False, "acquired": False,
    }
    assert metrics.metrics_snapshot() == after
    assert metrics.observations_snapshot()["workflow_run.drive_ms"] == timing

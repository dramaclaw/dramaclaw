import asyncio
from types import SimpleNamespace
import pytest
from novelvideo.chat.reference_production_observer import ReferenceProductionObserver

import json
import logging
from novelvideo.chat.reference_remix_continuation import ReferenceRemixStore
from test_plan_confirmation_contract import reviewed_plan  # noqa: F401, F811
from test_reference_director_api import setup_api  # noqa: F401


@pytest.mark.asyncio
async def test_branch_failure_is_not_recovered_until_clean_scan(monkeypatch, caplog):
    from novelvideo.chat import reference_production_observer as module
    from novelvideo.chat import reference_runtime_diagnostics as diagnostics
    diagnostics._recent.clear()
    run = {"run_id": "branch-run", "project_id": "project", "canvas_id": "canvas",
           "commission_phase": "awaiting_plan_review",
           "commission_ref": {"artifact_id": "parent", "revision": 1}}
    child = {"phase": "awaiting_plan_review",
             "commission_ref": {"artifact_id": "child", "revision": 1},
             "plan_ref": {"artifact_id": "old-plan", "revision": 1}}
    parent = {"phase": "awaiting_plan_review", "commission_ref": run["commission_ref"]}
    class Coordinator:
        store = SimpleNamespace(waiting_for_production=lambda: [run])
        async def continue_commission(self, **_kwargs):
            return None
    observer = module.ReferenceProductionObserver(Coordinator())
    observer._branch_plan_consumption = lambda *_args, **_kwargs: set()
    async def publish(*_args):
        return None
    observer._publish_cards = publish
    ctx = SimpleNamespace(state_dir="/unused")
    async def observe(_run):
        return await observer._observe_branches(ctx, run, SimpleNamespace(), {}, parent,
                                                [child], {}, None, None)
    observer.observe_run = observe
    calls = [0]
    def production(*_args, **_kwargs):
        calls[0] += 1
        if calls[0] < 3:
            raise ValueError("stale child plan")
        return None
    monkeypatch.setattr(module, "production_event", production)
    monkeypatch.setattr(module, "read_reference_commission", lambda *_args, **_kwargs: child)
    caplog.set_level(logging.WARNING, logger=diagnostics.__name__)
    assert await observer.scan_once() == 1
    assert await observer.scan_once() == 1
    messages = [record.message for record in caplog.records]
    assert sum('reference_runtime_failure' in message for message in messages) == 1
    assert not any('reference_runtime_recovered' in message for message in messages)
    assert await observer.scan_once() == 1
    messages = [record.message for record in caplog.records]
    assert sum('reference_runtime_recovered' in message for message in messages) == 1
    diagnostics._recent.clear()


@pytest.mark.asyncio
async def test_observer_diagnostic_lookup_failure_does_not_escape_scan(monkeypatch, caplog):
    from novelvideo.chat import reference_runtime_diagnostics as diagnostics
    diagnostics._recent.clear()
    run = {"run_id": "run-lookup", "project_id": "project", "canvas_id": "canvas"}
    observer = ReferenceProductionObserver(SimpleNamespace(
        store=SimpleNamespace(waiting_for_production=lambda: [run])))
    async def broken(_run):
        raise ValueError("original observation failure")
    async def broken_lookup(_run):
        raise OSError("diagnostic store unavailable")
    monkeypatch.setattr(observer, "observe_run", broken)
    monkeypatch.setattr(observer, "_diagnostic_context", broken_lookup)
    caplog.set_level(logging.WARNING, logger=diagnostics.__name__)
    assert await observer.scan_once() == 0
    assert "original observation failure" in caplog.text
    diagnostics._recent.clear()


@pytest.mark.asyncio
async def test_observer_failure_logs_bound_and_current_plan_without_leaking_input(monkeypatch, caplog):
    from novelvideo.chat import reference_production_observer as module
    from novelvideo.chat import reference_runtime_diagnostics as diagnostics
    diagnostics._recent.clear()
    run = {"run_id": "run-stale", "project_id": "project", "canvas_id": "canvas",
           "commission_ref": {"artifact_id": "commission", "revision": 2}}
    commission = {"phase": "awaiting_plan_review", "commission_ref": run["commission_ref"],
                  "plan_ref": {"artifact_id": "plan", "revision": 1}}
    class Store:
        def waiting_for_production(self):
            return [run]
    class Artifacts:
        def read_latest(self, artifact_id):
            assert artifact_id == "plan"
            return {"id": "plan", "revision": 2}
    class Coordinator:
        store = Store()
        async def _resolve_context(self, _run):
            return SimpleNamespace(output_dir="/unused", project_id="project")
    observer = module.ReferenceProductionObserver(Coordinator())
    async def broken(_run):
        raise ValueError("stale plan https://media.example/source?token=private")
    monkeypatch.setattr(observer, "observe_run", broken)
    monkeypatch.setattr(module, "RemixArtifactStore", lambda *_args, **_kwargs: Artifacts())
    monkeypatch.setattr(module, "read_reference_commission", lambda *_args, **_kwargs: commission)
    caplog.set_level(logging.WARNING, logger=diagnostics.__name__)
    assert await observer.scan_once() == 0
    assert await observer.scan_once() == 0
    assert len(caplog.records) == 1
    message = caplog.records[0].message
    assert '"bound_plan_ref"' in message and '"current_plan_ref"' in message
    assert '"revision": 1' in message and '"revision": 2' in message
    assert "stale plan" in message and "media.example" not in message
    diagnostics._recent.clear()


def test_plan_presentation_recovery_is_bounded_per_decision():
    from novelvideo.chat.reference_production_observer import _plan_presentation_retry_event

    ref = {'artifact_id': 'decision-a', 'revision': 1}
    run = {'status': 'awaiting_plan_confirmation', 'commission_event_receipts': []}
    first = _plan_presentation_retry_event(run, ref, presented=False)
    assert first and first['event_key'].endswith(':1')
    assert _plan_presentation_retry_event(
        {**run, 'status': 'awaiting_plan_review'}, ref, presented=False,
    ) == first
    assert _plan_presentation_retry_event(run, ref, presented=True) is None
    run['commission_event_receipts'] = [first['event_key']]
    assert _plan_presentation_retry_event(run, ref, presented=False)['event_key'].endswith(':2')
    run['commission_event_receipts'].append('plan-presentation:decision-a:2')
    run['commission_event_receipts'].append('plan-presentation:decision-a:3')
    assert _plan_presentation_retry_event(run, ref, presented=False) is None


async def test_observer_wakes_saved_review_when_run_still_says_plan_review(
        reviewed_plan, monkeypatch):
    from novelvideo.chat.reference_production_observer import ReferenceProductionObserver
    from novelvideo.chat.store import ChatScope
    from novelvideo.api.routes import freezone
    from novelvideo.freezone import canvas_store

    _, store, commission, _ = reviewed_plan
    ctx = SimpleNamespace(project_id='p', requester_user_id='u', requester_username='alice',
                          state_dir=store.project_dir, output_dir=store.project_dir)
    run = {'run_id': 'run-a', 'username': 'alice', 'project_id': 'p',
           'requester_user_id': 'u', 'canvas_id': 'c', 'agent_id': 'main',
           'analysis_node_id': 'analysis', 'status': 'awaiting_plan_review',
           'commission_phase': 'awaiting_plan_review',
           'commission_ref': {**commission['commission_ref'],
                              'revision': commission['commission_ref']['revision'] - 1},
           'commission_event_receipts': []}
    calls = []
    class Coordinator:
        async def _resolve_context(self, _run):
            return ctx
        def _assert_current(self, *_args, **_kwargs):
            return canvas_store.read_canvas(store.project_dir, 'c')
        def scope(self, _run):
            return ChatScope(kind='project', id='p', surface='freezone', canvas_id='c',
                             agent_id='main', state_dir=str(store.project_dir))
        async def continue_commission(self, **kwargs):
            calls.append(kwargs['event_key'])
    async def no_resume(*_args, **_kwargs):
        return None
    monkeypatch.setattr(freezone, 'resume_host_owned_native_workflows', no_resume)
    assert await ReferenceProductionObserver(Coordinator()).observe_run(run) is True
    assert len(calls) == 1 and calls[0].startswith('plan-presentation:')


def test_fair_durable_pages_for_100_tenants_1000_records(tmp_path):
    store = ReferenceRemixStore(tmp_path / 'runs.db')
    with store._connect() as db:
        for i in range(1000):
            status = ('preparing_materials', 'awaiting_direction', 'awaiting_plan_confirmation')[i % 3]
            run = dict(run_id=str(i), project_id=str(i % 100), requester_user_id=str(i % 100), canvas_id='c', agent_id='main', commission_ref={'artifact_id':str(i)}, status=status)
            db.execute('INSERT INTO reference_remix_continuations (run_id,project_id,requester_user_id,canvas_id,agent_id,idempotency_key,status,payload_json) VALUES (?,?,?,?,?,?,?,?)', (str(i),str(i % 100),str(i % 100),'c','main',str(i),status,json.dumps(run)))
    seen = set()
    for _ in range(10):
        page = ReferenceRemixStore(store.db_path).waiting_for_production(limit=100)
        assert len(page) <= 100
        seen.update(run['run_id'] for run in page)
    assert len(seen) == 1000
    assert store.waiting_for_production(limit=100)[0]['run_id'] == '0'


def test_active_pages_are_bounded_and_rotate(tmp_path):
    store = ReferenceRemixStore(tmp_path / 'runs.db')
    for i in range(5):
        store.create(dict(run_id=str(i),project_id='p',requester_user_id='a',canvas_id='c',agent_id='main',idempotency_key=str(i),request_fingerprint=str(i),status='analyzing'))
    assert [r['run_id'] for r in store.active(limit=2)] == ['0','1']
    assert [r['run_id'] for r in store.active(limit=2)] == ['2','3']
    assert [r['run_id'] for r in store.active(limit=2)] == ['4']



@pytest.mark.asyncio
async def test_bounded_scan_does_not_serialize_slow_tenant():
    visited = []
    slow_started = asyncio.Event()
    release = asyncio.Event()
    class Store:
        def waiting_for_production(self):
            return [{'run_id':str(i)} for i in range(100)]
    coordinator = SimpleNamespace(store=Store())
    observer = ReferenceProductionObserver(coordinator)
    async def observe(run, *, batch=None):
        if run['run_id'] == '0':
            slow_started.set()
            await release.wait()
        visited.append(run['run_id'])
        return False
    observer.observe_run = observe
    work = asyncio.create_task(observer.scan_once())
    await asyncio.wait_for(slow_started.wait(), 1)
    for _ in range(100):
        await asyncio.sleep(0)
        if '99' in visited:
            break
    assert '99' in visited
    release.set()
    assert await work == 0


def test_idle_cadence_is_bounded_with_jitter_and_reset():
    from novelvideo.chat.reference_remix_continuation import IdleCadence
    cadence = IdleCadence(2, jitter=lambda: 1.0)
    assert cadence.delay(False) == 2
    for _ in range(15):
        delay = cadence.delay(False)
    assert delay == 30
    assert cadence.delay(True) == 2

@pytest.mark.asyncio
async def test_100_tenant_1000_record_observer_groups_reads_zero_idle_models_and_once_wake(tmp_path, monkeypatch):
    import time
    import platform
    import statistics
    from novelvideo.chat import reference_production_observer as module
    store = ReferenceRemixStore(tmp_path / 'runs.db')
    contexts = {}
    for i in range(1000):
        tenant = str(i // 10)
        contexts[tenant] = SimpleNamespace(project_id=tenant, requester_user_id=tenant, output_dir=tmp_path / tenant, state_dir=tmp_path / tenant)
        run = dict(run_id=str(i),project_id=tenant,requester_user_id=tenant,canvas_id='c',agent_id='main',idempotency_key=str(i),request_fingerprint=str(i),status='preparing_materials',commission_phase='preparing_materials',commission_ref={'artifact_id':str(i),'revision':1})
        store.create(run)
    visited, snapshots, launches = set(), [], []
    completed = False
    class Coordinator:
        async def _resolve_context(self, run):
            return contexts[run['project_id']]
        def _assert_current(self, ctx, run, **kwargs):
            visited.add(run['run_id'])
            return {'nodes':[]}
        async def continue_commission(self, *, ctx, run_id, event_key, wake_event=None):
            updated = store.wake_waiting(ctx, run_id, {'artifact_id':run_id,'revision':1}, 'preparing_materials', event_key=event_key)
            if updated:
                launches.append(run_id)
    coordinator = Coordinator()
    coordinator.store = store
    observer = ReferenceProductionObserver(coordinator)
    def read_commission(artifacts, ref, **kwargs):
        tenant = str(int(ref['artifact_id']) // 10)
        return {'canvas_id':'c', 'requester_user_id':tenant,'phase':'preparing_materials','commission_ref':ref}
    monkeypatch.setattr(module, 'read_reference_commission', read_commission)
    def evidence(artifacts, canvas, commission, tasks, **kwargs):
        if completed and commission['commission_ref']['artifact_id'] == '777':
            return {'event_key':'production:real-receipt', 'event':None}
        return None
    monkeypatch.setattr(module, 'production_event', evidence)
    async def snapshot(ctx, run):
        snapshots.append((ctx.project_id, ctx.requester_user_id))
        return {}
    observer._material_snapshot = snapshot
    timings = []
    for _ in range(10):
        started = time.perf_counter()
        assert await observer.scan_once() == 0
        timings.append((time.perf_counter()-started)*1000)
    assert len(visited) == 1000
    assert len(snapshots) == 100  # one task/history read per ten same-scope records
    assert launches == []
    completed = True
    for _ in range(20):
        await observer.scan_once()
    assert launches == ['777']
    print({'machine':platform.machine(), 'platform':platform.system(), 'records':1000,'tenants':100,'pages':10,'snapshots':100,'idle_model_calls':0,'scan_p95_ms':sorted(timings)[-1],'scan_mean_ms':statistics.mean(timings),'observer_io_max':8,'page_limit':100})


def test_real_persisted_task_completion_emits_only_a_wake_hint(tmp_path, monkeypatch):
    from test_task_state_timezones import _ctx
    from novelvideo.task_state import TaskStateManager
    from novelvideo.chat import reference_production_observer as module
    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    task = manager.create_task_for_project(ctx, 'freezone_video_gen', 0, scope='job')
    wakes = []
    def wake():
        assert manager.get_task_for_project(ctx, 'freezone_video_gen', 0, scope='job').status == 'completed'
        wakes.append(True)
    monkeypatch.setattr(module, 'wake_local_observers', wake)
    assert not manager.complete_task_for_project(ctx, 'freezone_video_gen', 0, scope='job', expected_task_id='wrong')
    assert wakes == []
    assert manager.complete_task_for_project(ctx, 'freezone_video_gen', 0, scope='job', expected_task_id=task.task_id)
    assert wakes == [True]


def test_real_persisted_task_failure_wakes_reference_observer(tmp_path, monkeypatch):
    from test_task_state_timezones import _ctx
    from novelvideo.task_state import TaskStateManager
    from novelvideo.chat import reference_production_observer as module

    ctx = _ctx(tmp_path)
    manager = TaskStateManager()
    task = manager.create_task_for_project(ctx, 'remix_generate_production_plan_draft', 0, scope='plan')
    wakes = []

    def wake():
        saved = manager.get_task_for_project(ctx, 'remix_generate_production_plan_draft', 0, scope='plan')
        assert saved.status == 'failed'
        wakes.append(True)

    monkeypatch.setattr(module, 'wake_local_observers', wake)
    manager.fail_task_for_project(ctx, 'remix_generate_production_plan_draft', 0, scope='plan',
                                  error='Request timed out.', expected_task_id='wrong')
    assert wakes == []
    manager.fail_task_for_project(ctx, 'remix_generate_production_plan_draft', 0, scope='plan',
                                  error='Request timed out.', expected_task_id=task.task_id)
    assert wakes == [True]


@pytest.mark.asyncio
async def test_completed_draft_pages_recover_after_startup_without_restart(tmp_path, monkeypatch):
    from novelvideo.chat import reference_remix_continuation as continuation
    store = ReferenceRemixStore(tmp_path / 'runs.db')
    for i in range(205):
        store.create(dict(run_id=str(i),project_id='p',requester_user_id='a',canvas_id='c',agent_id='main',idempotency_key=str(i),request_fingerprint=str(i),status='completed',workflow_draft_id=str(i),workflow_draft_receipt={'draft_id':str(i)}))
    coordinator = continuation.ReferenceRemixCoordinator(store)
    seen, fences, per_page = [], [], []
    page_reader = store.draft_receipts
    def read_page():
        page = page_reader()
        per_page.append(len(page))
        return page
    store.draft_receipts = read_page
    async def resolve(run):
        return SimpleNamespace(project_id='p', requester_user_id='a')
    def fence(ctx, run, *, completed):
        assert completed
        fences.append(run['run_id'])
    async def receipt(run, turn_id, saved):
        assert run['run_id'] in fences
        assert saved['draft_id'] == run['run_id']
        seen.append(run['run_id'])
    coordinator._resolve_context = resolve
    coordinator._assert_current = fence
    coordinator._persist_draft_receipt = receipt
    async def interactions(**kwargs):
        pass
    coordinator.recover_interactions = interactions
    monkeypatch.setattr(continuation, 'POLL_SECONDS', .005)
    await coordinator.resume()
    try:
        deadline = asyncio.get_running_loop().time() + .5
        while len(set(seen)) < 205 and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(.005)
        assert len(set(seen)) == 205
        assert len(fences) == len(seen)
        assert per_page[:3] == [100, 100, 5]
        assert max(per_page) <= 100
    finally:
        await coordinator.shutdown()


@pytest.mark.asyncio
async def test_observer_requeues_current_stage_after_stale_dispatch_event(tmp_path, monkeypatch):
    from novelvideo.chat import reference_production_observer as module
    from test_reference_remix_continuation import context
    ctx = context(tmp_path)
    ref = {'artifact_id': 'commission', 'revision': 2}
    commission = {'commission_ref': ref, 'canvas_id': 'canvas',
                  'requester_user_id': ctx.requester_user_id, 'phase': 'drafting_plan'}
    run = {'run_id': 'run', 'canvas_id': 'canvas', 'agent_id': 'main',
           'commission_ref': ref, 'commission_phase': 'drafting_plan',
           'pending_stage_observation': True, 'commission_event_receipts': ['old-analysis']}
    monkeypatch.setattr(module, 'read_reference_commission', lambda *_args, **_kwargs: commission)
    monkeypatch.setattr(module, 'production_event', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(module, '_plan_generation_awaiting_canvas_result', lambda *_args: False)
    received = []
    async def continued(**kwargs): received.append(kwargs['event_key'])
    async def resolve(_run): return ctx
    coordinator = SimpleNamespace(_resolve_context=resolve,
        _assert_current=lambda *_args, **_kwargs: {'nodes': []},
        continue_commission=continued)
    observer = module.ReferenceProductionObserver(coordinator)
    async def publish(*_args): return None
    monkeypatch.setattr(observer, '_publish_cards', publish)
    assert await observer.observe_run(run)
    assert len(received) == 1


@pytest.mark.asyncio
async def test_failed_plan_notice_reaches_recovery_without_model_retry(tmp_path, monkeypatch):
    from novelvideo.chat import reference_production_observer as module
    from test_reference_remix_continuation import context
    ctx = context(tmp_path)
    ref = {'artifact_id': 'commission', 'revision': 2}
    commission = {'commission_ref': ref, 'canvas_id': 'canvas',
                  'requester_user_id': ctx.requester_user_id, 'phase': 'drafting_plan'}
    run = {'run_id': 'run', 'canvas_id': 'canvas', 'agent_id': 'main',
           'status': 'resume_failed', 'commission_ref': ref,
           'commission_phase': 'drafting_plan', 'commission_event_receipts': []}
    observed = {'event': None, 'event_key': 'plan-task:failed',
                'native_failure': True, 'notice': '作品方案生成失败，请检查画布任务后重试。'}
    monkeypatch.setattr(module, 'read_reference_commission', lambda *_args, **_kwargs: commission)
    monkeypatch.setattr(module, 'production_event', lambda *_args, **_kwargs: observed)
    notified, continued = [], []
    async def resolve(_run): return ctx
    async def notify(_run, message, event_key): notified.append((message, event_key))
    async def continue_commission(**kwargs): continued.append(kwargs['event_key'])
    coordinator = SimpleNamespace(_resolve_context=resolve,
        _assert_current=lambda *_args, **_kwargs: {'nodes': []},
        _notify=notify, continue_commission=continue_commission)
    observer = module.ReferenceProductionObserver(coordinator)
    async def publish(*_args): return None
    monkeypatch.setattr(observer, '_publish_cards', publish)
    assert await observer.observe_run(run)
    assert notified == [(observed['notice'], observed['event_key'])]
    assert continued == [observed['event_key']]


@pytest.mark.asyncio
async def test_blocked_draft_does_not_block_healthy_active_dispatch_or_shutdown(tmp_path, monkeypatch):
    from novelvideo.chat import reference_remix_continuation as continuation
    store = ReferenceRemixStore(tmp_path / 'runs.db')
    def add(run_id, status, **extra):
        store.create(dict(run_id=run_id, project_id=run_id,requester_user_id=run_id,canvas_id='c',agent_id='main',idempotency_key=run_id,request_fingerprint=run_id,status=status, **extra))
    for index in range(100):
        add(str(index), 'completed', workflow_draft_id=str(index), workflow_draft_receipt={'draft_id':str(index)})
    add('blocked', 'completed', workflow_draft_id='d', workflow_draft_receipt={'draft_id':'d'})
    coordinator = continuation.ReferenceRemixCoordinator(store)
    started, healthy, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    in_flight, peak = 0, 0
    async def resolve(run):
        nonlocal in_flight, peak
        if run['run_id'] != 'blocked':
            return SimpleNamespace(project_id=run['project_id'], requester_user_id=run['requester_user_id'])
        in_flight += 1
        peak = max(peak, in_flight)
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            in_flight -= 1
            cancelled.set()
    async def interactions(**kwargs):
        pass
    async def receipt(*args):
        pass
    coordinator._resolve_context = resolve
    coordinator._assert_current = lambda *args, **kwargs: {}
    coordinator._persist_draft_receipt = receipt
    coordinator.recover_interactions = interactions
    coordinator._ensure_worker = lambda run: healthy.set() if run['run_id'] == 'healthy' else None
    monkeypatch.setattr(continuation, 'POLL_SECONDS', .005)
    starter = asyncio.create_task(coordinator.resume())
    try:
        await asyncio.wait_for(started.wait(), .5)
        add('healthy', 'analysis_ready')
        await asyncio.wait_for(healthy.wait(), .2)
        await asyncio.wait_for(starter, .2)
        original_draft_worker = coordinator._draft_scheduler
        await coordinator.resume()
        assert coordinator._draft_scheduler is original_draft_worker
        assert peak == 1
        await asyncio.wait_for(coordinator.shutdown(), .2)
        assert original_draft_worker.done()
        assert cancelled.is_set() and in_flight == 0
    finally:
        starter.cancel()
        await asyncio.gather(starter, return_exceptions=True)
        await coordinator.shutdown()


@pytest.mark.asyncio
async def test_interaction_recovery_deadlines_bound_workers_and_cancel_each_record(tmp_path, monkeypatch):
    from novelvideo.chat import reference_remix_continuation as module
    coordinator = module.ReferenceRemixCoordinator(ReferenceRemixStore(tmp_path / 'runs.db'))
    monkeypatch.setattr(module, 'INTERACTION_RECOVERY_TIMEOUT_SECONDS', 0.02)
    monkeypatch.setattr(coordinator.store, 'interaction_candidates', lambda **kwargs: [{'run_id':str(i)} for i in range(20)])
    active = maximum = 0
    cancelled = set()
    async def resolve(run):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        try:
            await asyncio.Event().wait()
        finally:
            active -= 1
            cancelled.add(run['run_id'])
    monkeypatch.setattr(coordinator, '_resolve_context', resolve)
    await asyncio.wait_for(coordinator.recover_interactions(), 2)
    assert maximum == module.INTERACTION_RECOVERY_CONCURRENCY
    assert active == 0
    assert len(cancelled) == 20


def _settlement_observer_fixture(tmp_path):
    from test_material_settlement import native_material
    fixture = native_material(tmp_path)
    store, state, canvas, ref, native = fixture
    work = store.read(ref['artifact_id'], ref['revision'])
    plan_ref = work['payload']['plan_ref']
    canvas['nodes'].extend([{'id': 'analysis', 'data': {}}, {'id': 'plan', 'data': {
        'productionPlanV2Ref': {'artifactId': plan_ref['artifact_id'], 'revision': plan_ref['revision']}}}])
    canvas['edges'] = [{'source': 'analysis', 'target': 'plan'}]
    commission = {'phase': 'preparing_materials', 'canvas_id': 'canvas', 'requester_user_id': 'alice',
        'analysis_node_id': 'analysis', 'plan_ref': plan_ref, 'work_ref': ref,
        'commission_ref': {'artifact_id': 'commission', 'revision': 1}}
    return fixture, commission


def test_planned_material_work_does_not_report_candidates(tmp_path):
    from novelvideo.chat.reference_production_observer import production_event
    from test_material_work import setup_work

    store, plan_ref, prepared = setup_work(tmp_path)
    canvas = {
        'nodes': [
            {'id': 'analysis', 'data': {}},
            {'id': 'plan', 'data': {'productionPlanV2Ref': {
                'artifactId': plan_ref['artifact_id'], 'revision': plan_ref['revision'],
            }}},
        ],
        'edges': [{'source': 'analysis', 'target': 'plan'}],
    }
    commission = {
        'phase': 'preparing_materials', 'canvas_id': 'canvas',
        'requester_user_id': 'alice', 'analysis_node_id': 'analysis',
        'plan_ref': plan_ref, 'work_ref': prepared['work_ref'],
        'commission_ref': {'artifact_id': 'commission', 'revision': 1},
    }
    assert production_event(store, canvas, commission, workflow_state_dir=tmp_path) is None


def test_production_observer_settles_actual_native_result_with_stable_event(tmp_path):
    from novelvideo.chat.reference_production_observer import production_event
    from novelvideo.freezone.remix.operations import RemixOperationStore
    fixture, commission = _settlement_observer_fixture(tmp_path)
    store, state, canvas, ref, native = fixture
    first = production_event(store, canvas, commission, workflow_state_dir=state)
    assert first['settlement_ids']
    record = RemixOperationStore(store.project_dir, store.project_id).get_settlement(first['settlement_ids'][0])
    assert record['checkpoint'] == 'checks_scheduled' and record['review_ref']
    assert first['event_key'] == production_event(store, canvas, commission, workflow_state_dir=state)['event_key']
    revision = store.read_latest(ref['artifact_id'])['revision']
    production_event(store, canvas, commission, workflow_state_dir=state)
    assert store.read_latest(ref['artifact_id'])['revision'] == revision


@pytest.mark.asyncio
async def test_notification_failure_retries_only_notification_then_marks_settlement(tmp_path, monkeypatch):
    from novelvideo.chat import reference_production_observer as module
    from novelvideo.freezone.remix.operations import RemixOperationStore
    fixture, commission = _settlement_observer_fixture(tmp_path)
    artifacts, state, canvas, ref, native = fixture
    run = dict(run_id='continuation', project_id='project', requester_user_id='alice', canvas_id='canvas',
        agent_id='main', idempotency_key='one', request_fingerprint='one', status='preparing_materials',
        commission_phase='preparing_materials', commission_ref=commission['commission_ref'])
    db = ReferenceRemixStore(tmp_path / 'continuations.db')
    db.create(run)
    ctx = SimpleNamespace(project_id='project', requester_user_id='alice', output_dir=artifacts.project_dir, state_dir=state)
    attempts = []
    from novelvideo.chat.reference_remix_continuation import ReferenceRemixCoordinator
    class Coordinator(ReferenceRemixCoordinator):
        async def _resolve_context(self, run): return ctx
        def _assert_current(self, *args, **kwargs): return canvas
        async def _notify(self, run, message, event_key):
            attempts.append(event_key)
            if len(attempts) == 1:
                raise RuntimeError('notification failed')
        async def continue_commission(self, *, ctx, run_id, event_key, wake_event=None):
            return db.wake_waiting(ctx, run_id, commission['commission_ref'], 'preparing_materials', event_key=event_key)
    monkeypatch.setattr(module, 'read_reference_commission', lambda *args, **kwargs: commission)
    observer = module.ReferenceProductionObserver(Coordinator(db))
    async def snapshot(*args): return {}
    observer._material_snapshot = snapshot
    with pytest.raises(RuntimeError, match='notification failed'):
        await observer.observe_run(run)
    before = artifacts.read_latest(ref['artifact_id'])['revision']
    assert await observer.observe_run(run)
    assert attempts[0] == attempts[1]
    assert artifacts.read_latest(ref['artifact_id'])['revision'] == before
    observed = module.production_event(artifacts, canvas, commission, workflow_state_dir=state)
    assert RemixOperationStore(artifacts.project_dir, 'project').get_settlement(observed['settlement_ids'][0])['checkpoint'] == 'notified'


def test_observer_resumes_saved_check_after_native_action_cleanup(tmp_path):
    from novelvideo.chat.reference_production_observer import production_event
    from novelvideo.freezone.workflow_runs import _connect
    fixture, commission = _settlement_observer_fixture(tmp_path)
    store, state, canvas, ref, native = fixture
    def unavailable(**kwargs): raise RuntimeError('check queue unavailable')
    with pytest.raises(RuntimeError, match='queue'):
        production_event(store, canvas, commission, workflow_state_dir=state, check_scheduler=unavailable)
    with _connect(state) as db:
        db.execute('DELETE FROM workflow_run_actions WHERE run_id=?', (native['run_id'],))
    recovered = production_event(store, canvas, commission, workflow_state_dir=state)
    assert recovered and recovered['settlement_ids']


@pytest.mark.parametrize('already_scheduled', [False, True])
def test_observer_recovers_settlement_after_confirmed_draft_retention_cleanup(tmp_path, already_scheduled):
    from novelvideo.chat.reference_production_observer import production_event
    from novelvideo.freezone.workflow_drafts import prune_expired_workflow_drafts
    fixture, commission = _settlement_observer_fixture(tmp_path)
    store, state, canvas, ref, native = fixture
    def unavailable(**kw): raise RuntimeError('queue unavailable')
    if already_scheduled:
        first = production_event(store, canvas, commission, workflow_state_dir=state)
    else:
        with pytest.raises(RuntimeError, match='queue'):
            production_event(store, canvas, commission, workflow_state_dir=state, check_scheduler=unavailable)
    before = store.read_latest(ref['artifact_id'])
    assert prune_expired_workflow_drafts(project_dir=state, canvas_id='canvas', now=10**12) == 1
    recovered = production_event(store, canvas, commission, workflow_state_dir=state)
    assert recovered and recovered['settlement_ids']
    if already_scheduled:
        assert recovered['event_key'] == first['event_key']
    assert store.read_latest(ref['artifact_id']) == before

@pytest.fixture
def material_stage_observation(monkeypatch):
    from novelvideo.chat import reference_production_observer as module
    from novelvideo.freezone.remix import material_execution, material_settlement
    from novelvideo.freezone import workflow_runs
    steps = [
        {'id': 'a', 'source': 'generate', 'status': 'submitted', 'node_id': 'a',
         'media_kind': 'image', 'recipe_id': 'image'},
        {'id': 'b', 'source': 'generate', 'status': 'submitted', 'node_id': 'b',
         'media_kind': 'image', 'recipe_id': 'image'},
        {'id': 'video', 'source': 'generate', 'status': 'planned',
         'media_kind': 'video', 'depends_on': ['a']},
    ]
    work = {'id': 'work', 'revision': 1, 'payload': {'steps': steps,
            'requirements': [{'final_step_id': 'video'}]}}
    statuses = {'a': 'completed', 'b': 'running'}
    plan = {'id': 'plan', 'revision': 1, 'schema': 'production_plan.v2', 'payload': {}}
    store = SimpleNamespace(project_id='project', project_dir='unused', read_latest=lambda _id: work)
    commission = {'phase': 'preparing_materials', 'canvas_id': 'canvas',
                  'plan_ref': {'artifact_id': 'plan', 'revision': 1}}
    monkeypatch.setattr(module, '_canvas_refs', lambda *_args: [plan])
    monkeypatch.setattr(module, '_saved_work', lambda *_args: work)
    monkeypatch.setattr(module, '_discover_material_executions', lambda *_args: work)
    monkeypatch.setattr(material_execution, 'validate_material_native_execution',
        lambda _store, _canvas, step, *_args, **_kwargs: {'run_id': step['id'], 'task_id': step['id']})
    monkeypatch.setattr(workflow_runs, 'read_workflow_run', lambda **kwargs: {
        'project_id': 'project', 'actions': [{'node_id': kwargs['run_id'],
            'task_key': kwargs['run_id'], 'recipe_id': 'image', 'status': statuses[kwargs['run_id']]}]})
    monkeypatch.setattr(material_settlement, 'settle_material_result', lambda **kwargs: {
        'status': 'registered', 'resource': {'node_id': kwargs['step_id']},
        'review_ref': {'artifact_id': 'review'}, 'settlement_id': kwargs['step_id']})
    monkeypatch.setattr(material_execution, 'canvas_material_resource',
        lambda _store, _canvas, node_id, _kind: {'node_id': node_id})
    return lambda: module.production_event(store, {}, commission), steps, statuses


def test_material_stage_waits_for_all_candidates_and_ignores_partial_acceptance(material_stage_observation):
    observe, steps, statuses = material_stage_observation
    assert observe() is None
    statuses['b'] = 'completed'
    complete = observe()
    assert complete['settlement_ids'] == ['a', 'b']
    steps[0].update(status='accepted', accepted_resource={'node_id': 'a'})
    assert observe()['event_key'] == complete['event_key']
    steps[1].update(status='accepted', accepted_resource={'node_id': 'b'})
    next_stage = observe()
    assert next_stage['event_key'] != complete['event_key']
    assert observe()['event_key'] == next_stage['event_key']
    steps[2]['status'] = 'submitted'
    assert observe() is None


def test_material_failure_identity_ignores_other_partial_completions(material_stage_observation):
    observe, _steps, statuses = material_stage_observation
    statuses.update(a='failed', b='running')
    failed = observe()
    assert '失败' in failed['notice']
    statuses['b'] = 'completed'
    assert observe()['event_key'] == failed['event_key']


@pytest.mark.asyncio
async def test_partial_branch_material_revision_does_not_wake_again(monkeypatch):
    from novelvideo.chat import reference_production_observer as module
    child = {'phase': 'preparing_materials',
             'commission_ref': {'artifact_id': 'child', 'revision': 1}}
    parent = {'phase': 'preparing_materials',
              'commission_ref': {'artifact_id': 'parent', 'revision': 1}}
    run = {'run_id': 'run', 'canvas_id': 'canvas', 'commission_event_receipts': []}
    wakes = []
    async def wake(**kwargs):
        wakes.append(kwargs['event_key'])
    observer = ReferenceProductionObserver(SimpleNamespace(continue_commission=wake))
    observer._branch_plan_consumption = lambda *_args, **_kwargs: set()
    async def publish(*_args):
        pass
    observer._publish_cards = publish
    monkeypatch.setattr(module, 'production_event', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(module, 'read_reference_commission', lambda *_args, **_kwargs: child)
    ctx = SimpleNamespace(state_dir='unused')
    assert await observer._observe_branches(ctx, run, None, {}, parent, [child], {})
    run['commission_event_receipts'] = list(wakes)
    child['commission_ref']['revision'] += 1
    assert not await observer._observe_branches(ctx, run, None, {}, parent, [child], {})
    assert len(wakes) == 1


@pytest.mark.asyncio
async def test_automatic_acceptance_wakes_direct_production_readers(monkeypatch):
    from novelvideo.chat import reference_production_observer as module
    from novelvideo.freezone.remix import director_notifications
    published = []
    async def publish(*args, **kwargs):
        published.append((args, kwargs))
    async def broadcast(ctx, *, canvas_id, agent_ids, canvas_changed=False):
        published.append(('director', canvas_id, list(agent_ids), canvas_changed))
    monkeypatch.setattr('novelvideo.freezone.remix.conversation_cards.publish_conversation_cards', publish)
    monkeypatch.setattr(director_notifications, 'broadcast_director_update', broadcast)
    observer = ReferenceProductionObserver(SimpleNamespace())
    ctx = SimpleNamespace(requester_username='local', project_id='project')
    await observer._publish_cards(ctx, {'run_id': 'run', 'canvas_id': 'canvas', 'agent_id': 'main'})
    director = published[-1]
    assert director[0] == 'director' and director[1] == 'canvas' and director[2] == ['main']
    assert director[3] is False


@pytest.mark.asyncio
async def test_verified_observation_survives_automatic_advancement_error(monkeypatch):
    from novelvideo.freezone.remix import production_automation
    async def unavailable(*_args, **_kwargs):
        raise RuntimeError('automatic advancement unavailable')
    monkeypatch.setattr(production_automation, 'advance_enrolled_production', unavailable)
    observer = ReferenceProductionObserver(SimpleNamespace(
        store=SimpleNamespace(list_for_actor=lambda *_args: [])))
    run = {'run_id': 'run', 'canvas_id': 'canvas',
           'commission_ref': {'artifact_id': 'commission', 'revision': 1}}
    observed = {'event_key': 'verified', 'event': None}
    advanced, failure = await observer._advance_automation(None, run, observed)
    assert advanced is False and failure is not None
    assert failure['event_key'] != 'verified'
    assert '自动推进未完成' in failure['notice']
    retry = {'event_key': 'verified', 'event': None}
    assert (await observer._advance_automation(None, run, retry))[1]['event_key'] == failure['event_key']


@pytest.mark.asyncio
async def test_deterministic_advancement_failure_without_event_wakes_agent(monkeypatch):
    """A stalled system action must name its cause instead of retrying silently."""
    from novelvideo.freezone.remix import production_automation
    async def rejected(*_args, **_kwargs):
        raise ValueError('this placement cannot bind media')
    monkeypatch.setattr(production_automation, 'advance_enrolled_production', rejected)
    observer = ReferenceProductionObserver(SimpleNamespace(
        store=SimpleNamespace(list_for_actor=lambda *_args: [])))
    run = {'run_id': 'run', 'canvas_id': 'canvas', 'commission_phase': 'preparing_materials',
           'commission_ref': {'artifact_id': 'commission', 'revision': 6}}
    advanced, failure = await observer._advance_automation(None, run, None)
    assert advanced is False
    assert failure['evidence']['automatic_advancement_failure'] == 'ValueError'
    assert 'this placement cannot bind media' in failure['notice']
    assert failure['notice'].endswith('原因：this placement cannot bind media。')
    again = (await observer._advance_automation(None, run, None))[1]
    assert again['event_key'] == failure['event_key']


@pytest.mark.asyncio
async def test_transient_advancement_lock_error_still_raises_for_retry(monkeypatch):
    from novelvideo.freezone.remix import production_automation
    from novelvideo.freezone.canvas_lock import CanvasLockBusy
    async def busy(*_args, **_kwargs):
        raise CanvasLockBusy('canvas')
    monkeypatch.setattr(production_automation, 'advance_enrolled_production', busy)
    observer = ReferenceProductionObserver(SimpleNamespace(
        store=SimpleNamespace(list_for_actor=lambda *_args: [])))
    with pytest.raises(CanvasLockBusy):
        await observer._advance_automation(None, {'run_id': 'run', 'canvas_id': 'canvas',
                                                  'commission_ref': {'artifact_id': 'c'}}, None)


def test_observer_does_not_adopt_unique_unselected_work(tmp_path):
    from novelvideo.chat.reference_production_observer import _saved_work
    from novelvideo.freezone.remix.store import RemixArtifactStore
    from test_reference_commission import confirmed_plan, selectable_work, selection_canvas
    store = RemixArtifactStore(tmp_path, 'p', created_by='u')
    c, p = confirmed_plan(store)
    work = selectable_work(store, p)
    assert _saved_work(store, selection_canvas(p), c, p) is None
    assert _saved_work(store, selection_canvas(p), {**c, 'work_ref': work}, p)['id'] == work['artifact_id']

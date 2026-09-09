import base64
import io
import zipfile

import pytest

from novelvideo.freezone.skill_import import read_source, record_path


def test_markdown_source():
    source = read_source('story.md', base64.b64encode(b'# Story\nUseful method').decode())
    assert 'Useful method' in source['text']
    assert source['warnings'] == []


def test_zip_traversal_rejected():
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('../SKILL.md', 'bad')
    with pytest.raises(ValueError):
        read_source('skill.zip', base64.b64encode(data.getvalue()).decode())


def test_scope_isolation(tmp_path):
    assert record_path(tmp_path, 'alice', 'a' * 32) != record_path(tmp_path, 'bob', 'a' * 32)
    with pytest.raises(ValueError):
        record_path(tmp_path, 'alice', '../x')


def test_zip_requires_one_skill_and_preserves_references():
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('demo/SKILL.md', '# Method')
        archive.writestr('demo/references/style.md', 'Concrete writing advice')
        archive.writestr('demo/scripts/run.py', 'DO NOT EXECUTE')
    result = read_source('demo.zip', base64.b64encode(data.getvalue()).decode())
    assert 'Concrete writing advice' in result['text']
    assert 'DO NOT EXECUTE' not in result['text']
    assert result['warnings']


def test_zip_symlink_rejected():
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        entry = zipfile.ZipInfo('SKILL.md')
        entry.external_attr = 0o120777 << 16
        archive.writestr(entry, '/etc/passwd')
    with pytest.raises(ValueError):
        read_source('demo.zip', base64.b64encode(data.getvalue()).decode())


@pytest.mark.asyncio
async def test_conversion_repairs_and_checkpoints(tmp_path, monkeypatch):
    import json
    from novelvideo.freezone import skill_import as module
    from test_freezone_agent_bundle import _bundle_payload
    from test_skill_import_quality import design_fixture, review_fixture
    monkeypatch.setattr('novelvideo.freezone.agent_config_store.list_user_agent_config_items', lambda *args: [])
    record = module.create_record(tmp_path, 'alice', read_source('x.md', base64.b64encode(b'Check citations').decode()), 'batch')
    responses = [design_fixture(), {}, _bundle_payload(), review_fixture()]
    calls = []
    async def generate(prompt):
        calls.append(prompt)
        return json.dumps(responses.pop(0))
    result = await module.convert_record(tmp_path, 'alice', record['id'], generate)
    assert result['status'] == 'ready'
    assert 'repair_issues' in calls[2]
    assert result['quality_report']['validated']
    assert 'checkpoints' not in result and 'source' not in result
    assert module.get_record(tmp_path, 'alice', record['id'])['checkpoints']
    with pytest.raises(FileNotFoundError):
        module.get_record(tmp_path, 'bob', record['id'])


@pytest.mark.asyncio
async def test_unsupported_skill_needs_review(tmp_path, monkeypatch):
    import json
    from novelvideo.freezone import skill_import as module
    from test_freezone_agent_bundle import _bundle_payload
    from test_skill_import_quality import design_fixture, blocker_fixture
    monkeypatch.setattr('novelvideo.freezone.agent_config_store.list_user_agent_config_items', lambda *args: [])
    record = module.create_record(tmp_path, 'alice', read_source('x.md', base64.b64encode(b'Check citations').decode()), 'batch')
    responses = [design_fixture(), _bundle_payload(), blocker_fixture(), _bundle_payload(), blocker_fixture(), _bundle_payload(), blocker_fixture()]
    async def generate(prompt): return json.dumps(responses.pop(0))
    result = await module.convert_record(tmp_path, 'alice', record['id'], generate)
    assert result['status'] == 'needs_review'
    assert not result['quality_report']['validated']
    assert any('Citation checking' in b for b in result['quality_report']['blockers'])


def test_reused_recipe_cannot_change_method():
    from novelvideo.freezone.skill_import import validate_reused_recipes, validate_analysis
    from novelvideo.freezone.agent_bundle_store import validate_agent_bundle
    from test_freezone_agent_bundle import _bundle_payload
    bundle = validate_agent_bundle(_bundle_payload())['bundle']
    import copy
    changed = copy.deepcopy(bundle)
    changed['recipes'][0]['system_prompt'] = 'Different method'
    with pytest.raises(ValueError, match='differs from catalog'):
        validate_reused_recipes(changed, bundle['recipes'])
    with pytest.raises(ValueError):
        validate_analysis({'source_mapping': ['x'], 'unsupported_dependencies': 'silently ignore'})


@pytest.mark.asyncio
async def test_api_install_requires_review_and_is_idempotent(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from novelvideo.api.routes import skill_imports as routes
    from novelvideo.freezone import skill_import as module
    from test_freezone_agent_bundle import _bundle_payload
    monkeypatch.setattr('novelvideo.freezone.agent_config_store.list_user_agent_config_items', lambda *args: [])
    async def scope(project, user):
        return SimpleNamespace(), tmp_path, user['username']
    monkeypatch.setattr(routes, 'scope', scope)
    record = module.create_record(tmp_path, 'alice', read_source('x.md', base64.b64encode(b'Method').decode()), 'b')
    record.update(status='needs_review', warnings=['Script unsupported'], bundle=_bundle_payload())
    from novelvideo.freezone.skill_import_contracts import content_hash
    record['quality_report'] = {'version': 3, 'validated': True, 'blockers': [],
        'bundle_sha256': content_hash(record['bundle']),
        **{k: {'status': 'passed'} for k in ['structure', 'coverage']}}

    module.save_record(tmp_path, 'alice', record)
    calls = []
    monkeypatch.setattr('novelvideo.freezone.agent_bundle_store.install_agent_bundle', lambda **kwargs: calls.append(kwargs) or {'installed_skill': 'x'})
    with pytest.raises(HTTPException) as exc:
        await routes.install('p', record['id'], routes.InstallRequest(), {'username': 'alice'})
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        await routes.detail('p', record['id'], {'username': 'bob'})
    assert exc.value.status_code == 404
    result = await routes.install('p', record['id'], routes.InstallRequest(acknowledge_warnings=True), {'username': 'alice'})
    assert result['data']['status'] == 'installed'
    await routes.install('p', record['id'], routes.InstallRequest(), {'username': 'alice'})
    assert len(calls) == 1


def test_runner_failure_is_recorded(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from novelvideo.freezone import skill_import as module
    from novelvideo.task_backend.runners import skill_import as runner
    monkeypatch.setattr('novelvideo.freezone.agent_config_store.list_user_agent_config_items', lambda *args: [])
    record = module.create_record(tmp_path, 'alice', read_source('x.md', base64.b64encode(b'Method').decode()), 'b')
    def fail(envelope, coro):
        coro.close()
        raise RuntimeError('provider unavailable')
    monkeypatch.setattr(runner, '_run_cancellable', fail)
    with pytest.raises(RuntimeError):
        runner.run_skill_import({'payload': {'import_id': record['id'], 'username': 'alice'}}, SimpleNamespace(state_dir=tmp_path, requester_username='alice'))
    assert module.get_record(tmp_path, 'alice', record['id'])['status'] == 'failed'


def test_bundle_install_rolls_back_new_recipes(tmp_path, monkeypatch):
    from novelvideo.freezone import agent_config_store, agent_bundle_store
    from test_freezone_agent_bundle import _bundle_payload
    monkeypatch.setattr(agent_config_store, 'OUTPUT_DIR', tmp_path)
    original = agent_bundle_store.save_user_agent_config_item
    def fail_skill(**kwargs):
        if kwargs['kind'] == 'skills':
            raise OSError('disk full')
        return original(**kwargs)
    monkeypatch.setattr(agent_bundle_store, 'save_user_agent_config_item', fail_skill)
    with pytest.raises(OSError):
        agent_bundle_store.install_agent_bundle(username='alice', payload=_bundle_payload())
    assert not list(agent_config_store.user_agent_config_dir('alice', 'recipes').glob('*.json'))


@pytest.mark.asyncio
async def test_submission_keeps_worker_progress_and_retry_reconciles_cancel(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from novelvideo.api.routes import skill_imports as routes
    from novelvideo.freezone import skill_import as module
    monkeypatch.setattr('novelvideo.freezone.agent_config_store.list_user_agent_config_items', lambda *args: [])
    ctx = SimpleNamespace()
    async def scope(project, user):
        return ctx, tmp_path, user['username']
    monkeypatch.setattr(routes, 'scope', scope)
    calls = []
    class Backend:
        async def enqueue_project_task(self, context, **kwargs):
            calls.append(kwargs)
            record = module.get_record(tmp_path, 'alice', kwargs['scope'])
            record.update(status='running', stage='analyzing')
            module.save_record(tmp_path, 'alice', record)
            return SimpleNamespace(task_state=SimpleNamespace(task_id=f'task-{len(calls)}'))
    monkeypatch.setattr(routes, 'get_task_backend', lambda: Backend())
    result = await routes.submit('p', routes.ImportRequest(files=[routes.SourceFile(name='x.md', content_base64=base64.b64encode(b'Method').decode())]), {'username': 'alice'})
    item = result['data']['items'][0]
    assert item['status'] == 'running'
    assert item['stage'] == 'analyzing'
    assert calls[0]['task_type'] == 'freezone_skill_import'
    manager = SimpleNamespace(get_task_for_project=lambda *args, **kwargs: SimpleNamespace(task_id='task-1', status='cancelled'))
    monkeypatch.setattr('novelvideo.task_state.get_task_manager', lambda: manager)
    retried = await routes.retry('p', item['id'], {'username': 'alice'})
    assert retried['data']['task_id'] == 'task-2'
    assert len(calls) == 2


def test_concurrent_bundle_installs_preserve_distinct_recipe_methods(tmp_path, monkeypatch):
    import copy
    from concurrent.futures import ThreadPoolExecutor
    from novelvideo.freezone import agent_config_store, agent_bundle_store
    from test_freezone_agent_bundle import _bundle_payload
    monkeypatch.setattr(agent_config_store, 'OUTPUT_DIR', tmp_path)
    first = _bundle_payload()
    second = copy.deepcopy(first)
    second['id'] = second['skill']['id'] = 'different-skill'
    second['recipes'][0]['system_prompt'] = 'A completely different method'
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda bundle: agent_bundle_store.install_agent_bundle(username='alice', payload=bundle), [first, second]))
    assert len({result['installed_skill'] for result in results}) == 2
    recipes = agent_config_store.list_user_agent_config_items('alice', 'recipes')
    methods = {item['system_prompt'] for item in recipes}
    assert first['recipes'][0]['system_prompt'] in methods
    assert second['recipes'][0]['system_prompt'] in methods

def test_conversion_prompt_pins_bundle_schema_version():
    from novelvideo.freezone.skill_import_quality import bundle_schemas
    assert bundle_schemas()['bundle']['properties']['schema_version']['const'] == 'dramaclaw.skill-bundle.v1'


def test_missing_relative_resource_is_reported():
    result = read_source('SKILL.md', base64.b64encode(b'Use [rules](references/rules.md) before writing.').decode())
    assert result['resources'] == ['SKILL.md']
    assert any('references/rules.md' in warning for warning in result['warnings'])


@pytest.mark.asyncio
async def test_api_install_returns_conflict_without_blocking_on_busy_import(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from novelvideo.api.routes import skill_imports as routes
    from novelvideo.freezone import skill_import as module
    monkeypatch.setattr('novelvideo.freezone.agent_config_store.list_user_agent_config_items', lambda *args: [])
    async def scope(project, user):
        return SimpleNamespace(), tmp_path, user['username']
    monkeypatch.setattr(routes, 'scope', scope)
    record = module.create_record(tmp_path, 'alice', read_source('x.md', base64.b64encode(b'Method').decode()), 'b')
    def busy_lock(file, flags):
        assert flags & routes.fcntl.LOCK_NB, 'Blocking lock could deadlock the event loop'
        raise BlockingIOError('busy')
    monkeypatch.setattr(routes.fcntl, 'flock', busy_lock)
    with pytest.raises(HTTPException) as exc:
        await routes.install('p', record['id'], routes.InstallRequest(), {'username': 'alice'})
    assert exc.value.status_code == 409
    assert module.get_record(tmp_path, 'alice', record['id'])['status'] == record['status']

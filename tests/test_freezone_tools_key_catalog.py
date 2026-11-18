"""Key-owned catalog contracts for the Freezone tools MCP entry point."""

from contextlib import asynccontextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
import pytest

from test_workflow_mcp import _catalog_tool_payload
from test_workflow_mcp import workflow_catalog_api  # noqa: F401 - shared pytest fixture
from test_freezone_plugin import _load_plugin_module
from novelvideo.freezone.agent_workflows import catalog

ROOT = Path(__file__).resolve().parents[1]
IDENTITY_ENV = (
    'DRAMACLAW_AGENT_KEY', 'DRAMACLAW_AGENT_KEY_FILE', 'DRAMACLAW_AGENT_TOKEN',
    'DRAMACLAW_AGENT_TOKEN_FILE', 'DRAMACLAW_PROJECT_ID', 'DRAMACLAW_CANVAS_ID',
    'DRAMACLAW_TURN_ID', 'DRAMACLAW_USERNAME', 'DRAMACLAW_USER', 'ST_LOCAL_USERNAME',
    'DRAMACLAW_LOCAL_AGENT_TRUST',
)
TOOLS_ENV = {
    'DRAMACLAW_EXTERNAL_MCP': '1', 'DRAMACLAW_CHAT_SURFACE': 'freezone',
    'DRAMACLAW_TOOL_MODE': 'freezone_canvas', 'DRAMACLAW_AGENT_PROFILE': 'freezone:main',
    'ST_EDITION': 'ce',
}


@pytest.fixture
def tools_catalog_api(workflow_catalog_api):  # noqa: F811 - fixture argument
    api = workflow_catalog_api
    for user, kinds in api.catalogs.items():
        for kind, items in kinds.items():
            item = items[-1]
            if kind == 'skills':
                item['allowed_recipe_ids'] = [f'private-{user}']
            folder = api.output / user / '_account/freezone/agent_config' / kind
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f'private-{user}.json').write_text(json.dumps(item))
    return api


@pytest.fixture
def tools_session(tools_catalog_api, tmp_path):
    @asynccontextmanager
    async def connect(**overrides):
        env = {k: v for k, v in os.environ.items() if k not in IDENTITY_ENV}
        env.update(TOOLS_ENV)
        env.update({
            'PYTHONPATH': str(ROOT / 'src'), 'PYTHONDONTWRITEBYTECODE': '1',
            'DRAMACLAW_API_URL': tools_catalog_api.url,
            'NOVELVIDEO_OUTPUT_DIR': str(tools_catalog_api.output),
            **dict.fromkeys(('DRAMACLAW_USERNAME', 'DRAMACLAW_USER', 'ST_LOCAL_USERNAME'), 'relay-user'),
        })
        for name, value in overrides.items():
            if value is None:
                env.pop(name, None)
            else:
                env[name] = value
        params = StdioServerParameters(command=sys.executable,
            args=['-m', 'novelvideo.chat.dramaclaw_mcp'], cwd=str(tmp_path), env=env)
        async with stdio_client(params) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                yield session
    return connect


def plan_for(user):
    return {
        'schema_version': 'freezone_workflow_plan.v1',
        'workflow_type': f'dynamic.private-{user}', 'skill': {'id': f'private-{user}'},
        'summary': 'Create a landscape image',
        'nodes': [{'id': 'image', 'node_type': 'imageGenNode', 'stage': 'image',
                   'data': {'prompt': 'A mountain landscape', 'workflowCatalog': {
                       'skillId': f'private-{user}', 'recipeId': f'private-{user}',
                   }}}],
        'edges': [],
    }


@pytest.mark.parametrize('owner', ['alice', 'bob'])
async def test_tools_agent_key_owns_catalog(tools_session, tools_catalog_api, owner):
    peer = 'bob' if owner == 'alice' else 'alice'
    async with tools_session(DRAMACLAW_AGENT_KEY=f'test-key-{owner}') as session:
        results = {user: _catalog_tool_payload(await session.call_tool(
            'freezone_get_workflow_skill', {'skill_id': f'private-{user}'}))
            for user in (owner, peer, 'relay-user')}
    assert {user: result['ok'] for user, result in results.items()} == {
        owner: True, peer: False, 'relay-user': False}
    for kind in ('skills', 'recipes'):
        assert ('GET', f'/api/v1/freezone/agent-config/{kind}', owner) in tools_catalog_api.requests


@pytest.mark.parametrize('owner', ['alice', 'bob'])
async def test_tools_plan_precheck_uses_key_catalog(tools_session, tools_catalog_api, owner):
    peer = 'bob' if owner == 'alice' else 'alice'
    with catalog.workflow_catalog_items_scope(tools_catalog_api.catalogs[owner]):
        assert catalog.validate_agent_workflow_plan(plan_for(owner))['ok'] is True
    async with tools_session(DRAMACLAW_AGENT_KEY=f'test-key-{owner}') as session:
        results = {user: _catalog_tool_payload(await session.call_tool(
            'freezone_prepare_workflow_plan_draft', {
                'project_id': 'project-a', 'canvas_id': 'canvas-a', 'plan': plan_for(user),
            })) for user in (owner, peer)}
    assert results[peer]['status'] == 'invalid_dynamic_workflow_plan'
    assert results[owner]['status'] != 'invalid_dynamic_workflow_plan'
    # Only the owner's plan gets past validation into runtime preflight.
    assert [path for _, path, _ in tools_catalog_api.requests
            if path.endswith('/tasks/limits')] == ['/api/v1/projects/project-a/tasks/limits']


@pytest.mark.parametrize('username', [None, 'alice', 'bob', 'relay-user'])
@pytest.mark.parametrize('key_source', ['env', 'file'])
async def test_tools_key_ignores_relay_username(tools_session, tools_catalog_api, tmp_path, username, key_source):
    credentials = {'DRAMACLAW_AGENT_KEY': 'test-key-alice'}
    if key_source == 'file':
        path = tmp_path / 'key'
        path.write_text('test-key-alice')
        credentials = {'DRAMACLAW_AGENT_KEY_FILE': str(path)}
    overrides = dict.fromkeys(('DRAMACLAW_USERNAME', 'DRAMACLAW_USER', 'ST_LOCAL_USERNAME'), username)
    async with tools_session(**overrides, **credentials) as session:
        results = {user: _catalog_tool_payload(await session.call_tool(
            'freezone_get_workflow_skill', {'skill_id': f'private-{user}'}))
            for user in ('alice', 'bob')}
    assert {user: result['ok'] for user, result in results.items()} == {'alice': True, 'bob': False}
    for kind in ("skills", "recipes"):
        assert ("GET", f"/api/v1/freezone/agent-config/{kind}", "alice") in tools_catalog_api.requests


@pytest.mark.parametrize('failure', ['catalog-500', 'exchange-401'])
@pytest.mark.parametrize('skill', ['private-relay-user', 'text-to-image-video'])
async def test_tools_key_catalog_fails_closed(tools_session, tools_catalog_api, failure, skill):
    tools_catalog_api.fail = failure == 'catalog-500'
    key = 'test-key-alice' if failure == 'catalog-500' else 'test-key-unknown'
    async with tools_session(DRAMACLAW_AGENT_KEY=key) as session:
        response = await session.call_tool('freezone_get_workflow_skill', {'skill_id': skill})
        result = _catalog_tool_payload(response)
    assert result['ok'] is False
    assert result['status'] == 'catalog_read_failed'
    text = ''.join(c.text for c in response.content if hasattr(c, 'text'))
    assert 'private-relay-user' not in text
    assert all(secret not in text for secret in (key, 'session-alice', 'session-bob'))


@pytest.mark.parametrize('key', [None, 'test-key-alice'])
async def test_tools_reject_model_supplied_username(tools_session, tools_catalog_api, key):
    async with tools_session(DRAMACLAW_AGENT_KEY=key, DRAMACLAW_PROJECT_ID='project-a') as session:
        result = _catalog_tool_payload(await session.call_tool('freezone_get_workflow_skill', {
            'skill_id': 'private-bob', 'username': 'bob',
        }))
    assert result['ok'] is False
    assert result['status'] == 'tool_arguments_invalid'
    assert tools_catalog_api.requests == []


def mode_env(mode, tmp_path):
    env = {'DRAMACLAW_LOCAL_AGENT_TRUST': '1', 'DRAMACLAW_PROJECT_ID': 'project-a',
           'DRAMACLAW_CANVAS_ID': 'canvas-a'}
    if mode != 'local':
        env['DRAMACLAW_AGENT_TOKEN'] = 'test-turn-token'
    if mode in ('token-and-key', 'token-file-and-key'):
        env['DRAMACLAW_AGENT_KEY'] = 'test-key-alice'
    if mode == 'token-file-and-key':
        path = tmp_path / 'token'
        path.write_text('test-turn-token')
        env.pop('DRAMACLAW_AGENT_TOKEN')
        env['DRAMACLAW_AGENT_TOKEN_FILE'] = str(path)
    return env


@pytest.mark.parametrize('mode', ['local', 'token', 'token-and-key', 'token-file-and-key'])
async def test_tools_non_key_mode_keeps_local_catalog(tools_session, tools_catalog_api, tmp_path, mode):
    async with tools_session(**mode_env(mode, tmp_path)) as session:
        result = _catalog_tool_payload(await session.call_tool(
            'freezone_get_workflow_skill', {'skill_id': 'private-relay-user'}))
    assert result['ok'] is True
    assert tools_catalog_api.requests == []


@pytest.mark.parametrize('handler', ['prepare', 'patch', 'clarification-intent', 'clarification-plan'])
@pytest.mark.parametrize('mode', ['key', 'local', 'token', 'token-and-key', 'token-file-and-key'])
def test_plugin_catalog_at_compile_boundary(monkeypatch, tmp_path, tools_catalog_api, handler, mode):
    for name in IDENTITY_ENV:
        monkeypatch.delenv(name, raising=False)
    env = TOOLS_ENV | {
        'DRAMACLAW_USERNAME': 'relay-user', 'DRAMACLAW_USER': 'relay-user',
        'ST_LOCAL_USERNAME': 'relay-user',
        'NOVELVIDEO_OUTPUT_DIR': str(tools_catalog_api.output),
        'DRAMACLAW_API_URL': tools_catalog_api.url,
    }
    env.update({'DRAMACLAW_AGENT_KEY': 'test-key-alice'} if mode == 'key' else mode_env(mode, tmp_path))
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    from novelvideo.freezone import agent_config_store
    monkeypatch.setattr(agent_config_store, 'OUTPUT_DIR', tools_catalog_api.output)
    plugin = _load_plugin_module()
    calls = []
    observed = []
    owner = 'alice' if mode == 'key' else 'relay-user'
    intent = {'skill_id': f'private-{owner}', 'user_goal': 'Create a landscape image'}
    draft = {'status': 'ready', 'revision': 1, 'intent': intent, 'run_after_create': False}
    if handler == 'clarification-plan':
        draft['intent'] = {'schema_version': 'freezone_workflow_plan_draft.v1', 'plan': plan_for(owner)}

    def request(method, path, **kwargs):
        calls.append((method, path))
        if path.startswith('/api/v1/freezone/agent-config/'):
            assert method == 'GET'
            return {'ok': True, 'data': deepcopy(tools_catalog_api.catalogs['alice'][path.rsplit('/', 1)[-1]])}
        if method == 'GET' and path.endswith('/workflow-drafts/draft-a'):
            return {'ok': True, 'data': deepcopy(draft)}
        raise AssertionError((method, path))

    def observe_catalog(value):
        # Inspect the real catalog at the compilation boundary, then stop before persistence.
        observed.append({user: catalog.validate_agent_workflow_plan(plan_for(user))['ok']
                         for user in ('alice', 'bob', 'relay-user')})
        return {'ok': False, 'status': 'test_compile_boundary_reached'}

    monkeypatch.setattr(plugin, '_request', request)
    monkeypatch.setattr(plugin, 'compile_workflow_intent', observe_catalog)
    monkeypatch.setattr(plugin, 'validate_agent_workflow_plan', observe_catalog)
    args = {'project_id': 'project-a', 'canvas_id': 'canvas-a'}
    if handler == 'prepare':
        result = plugin._handle_prepare_workflow_draft({**args, 'intent': intent})
    elif handler == 'patch':
        result = plugin._handle_patch_workflow_draft({
            **args, 'draft_id': 'draft-a', 'expected_revision': 1,
            'changes': {'user_goal': 'Create a forest image'},
        })
    else:
        monkeypatch.setattr(plugin, '_clarification_listener_available', lambda: True)
        monkeypatch.setattr(plugin, '_resume_clarification', lambda *a, **kw: None)
        monkeypatch.setattr(plugin, 'read_clarification_turn_context', None)
        monkeypatch.setattr(plugin, '_emit_clarification_event', lambda *a, **kw: {
            'ok': True, 'status': 'clarification_frontend_result',
            'clarification_status': 'answered', 'answers': {'image_variants_per_node': {'option_ids': ['1']}},
        })
        result = plugin._handle_request_user_clarification({
            **args, 'workflow_draft_id': 'draft-a', 'workflow_expected_revision': 1,
            'generation_required_choices': {'image': ['count']},
        })
    assert result['status'] == 'test_compile_boundary_reached'
    assert observed == [{user: user == owner for user in ('alice', 'bob', 'relay-user')}]
    catalog_calls = [(method, path) for method, path in calls if '/agent-config/' in path]
    if mode == 'key':
        assert set(catalog_calls) == {('GET', f'/api/v1/freezone/agent-config/{kind}')
                                      for kind in ('skills', 'recipes')}
    else:
        assert catalog_calls == []
    assert catalog._REQUEST_CATALOG.get() is None

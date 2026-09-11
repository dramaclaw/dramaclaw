from test_freezone_plugin import _load_plugin_module
from test_freezone_plugin import _restore_tools_registry_modules as _restore_tools_registry_modules


def test_html_artifact_is_not_exposed_as_a_standalone_agent_tool():
    plugin = _load_plugin_module()
    from novelvideo.chat import hermes_sdk, service

    tool_names = {name for name, _schema, _handler in plugin.TOOLS}
    assert 'freezone_html_artifact' not in tool_names
    assert not hermes_sdk._is_freezone_canvas_write_tool('freezone_html_artifact')
    assert 'freezone_html_artifact' not in service._FREEZONE_CANVAS_WRITE_TOOLS


def test_html_node_actions_keep_correct_read_write_classification():
    from types import SimpleNamespace
    from novelvideo.chat.service import _codex_freezone_is_write_event

    for action in ('read_source', 'history'):
        assert not _codex_freezone_is_write_event(
            SimpleNamespace(name='freezone_run_node_action', input={'action': action})
        )
    for action in ('update_source', 'restore', 'generate_html'):
        assert _codex_freezone_is_write_event(
            SimpleNamespace(name='freezone_run_node_action', input={'action': action})
        )


def test_direct_mcp_mode_routes_html_through_frontend(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setattr(plugin, '_resolve_canvas_scope_for_write', lambda p,c: (p,c,None))
    monkeypatch.setattr(plugin, '_external_generation_parameter_preflight', lambda *a: None)
    monkeypatch.setattr(plugin, '_external_mcp_agent_enabled', lambda: True)
    monkeypatch.setattr(plugin, '_mcp_direct_canvas_apply_enabled', lambda: True)
    monkeypatch.setattr(plugin, '_mcp_canvas_approval_enabled', lambda: False)
    monkeypatch.setattr(plugin, '_direct_apply_canvas_commands', lambda *a,**k: (_ for _ in ()).throw(AssertionError('HTML must never use server direct apply')))
    dispatched = []
    monkeypatch.setattr(plugin, '_dispatch_mcp_approved_frontend_commands', lambda **k: dispatched.append(k) or {'ok':True})
    plugin._emit_canvas_commands('p','c',[{'type':'html_artifact','action':'create','title':'Hello','html':'hello'}])
    assert dispatched[0]['commands'][0]['type'] == 'html_artifact'


def test_html_read_request_with_negative_write_instruction():
    from novelvideo.chat.service import _freezone_canvas_write_requested
    assert not _freezone_canvas_write_requested("读取画布网页的源码和历史，不要写入。")
    assert not _freezone_canvas_write_requested("列出项目网页，不要修改网页。")
    assert _freezone_canvas_write_requested("创建一个网页，不要修改已有网页。")


def test_html_create_schema_discovery_uses_generic_creation(monkeypatch):
    plugin = _load_plugin_module()
    schemas = {name: schema for name, schema, _ in plugin.TOOLS}
    discover = schemas['freezone_get_node_create_schema']['parameters']
    from jsonschema import Draft202012Validator
    Draft202012Validator(discover).validate({'node_type': 'htmlArtifactNode'})
    requests = []
    monkeypatch.setattr(plugin, '_request_canvas_context_from_frontend', lambda **kwargs: requests.append(kwargs) or {'ok': True})
    result = plugin._handle_node_create_schema({'project_id': 'p', 'canvas_id': 'c', 'node_type': 'htmlArtifactNode'})
    assert result['ok'] is True
    assert requests[0]['requests'] == [{'type': 'node_create_schema', 'node_type': 'htmlArtifactNode'}]
    assert 'htmlArtifactNode' in plugin._AGENT_CREATABLE_NODE_TYPE_VALUES
    error = plugin._validate_write_commands_shape('p', 'c', [{'type': 'create_node', 'node_type': 'htmlArtifactNode'}])
    assert error is None


def test_html_read_node_actions_use_read_only_context_bridge(monkeypatch):
    plugin = _load_plugin_module()
    requests = []
    monkeypatch.setattr(plugin, '_request_canvas_context_from_frontend', lambda **kwargs: requests.append(kwargs) or {'ok': True})

    result = plugin._handle_run_node_action({
        'project_id': 'p',
        'canvas_id': 'c',
        'node_id': 'web-1',
        'action': 'read_source',
        'parameters': {'version': 2},
    })

    assert result['ok'] is True
    assert requests == [{
        'project': 'p',
        'canvas': 'c',
        'requests': [{
            'type': 'node_action_read',
            'node_id': 'web-1',
            'action': 'read_source',
            'parameters': {'version': 2},
        }],
    }]
    from jsonschema import Draft202012Validator
    Draft202012Validator(plugin._output_schema('freezone_run_node_action')).validate({
        'ok': True,
        'status': 'node_action_read',
        'tool_call_status': 'completed',
        'canvas_context_status': 'resolved',
        'bridge_key': 'bridge',
        'project_id': 'p',
        'canvas_id': 'c',
        'errors': [],
        'responses': [{
            'type': 'node_action_read',
            'node_id': 'web-1',
            'action': 'read_source',
            'data': {'artifact_id': 'a1', 'version': 2, 'html': '<html></html>'},
        }],
    })


def test_html_batch_rejects_invalid_create_fields():
    plugin = _load_plugin_module()
    base = {'type': 'html_artifact', 'action': 'create', 'title': 'Page', 'html': '<h1>Hello</h1>'}
    for field, value in [('action', 'read'), ('title', ''), ('html', None), ('client_id', ''), ('client_id', 12), ('reference_node_ids', 'image'), ('reference_node_ids', ['']), ('reference_node_ids', [42])]:
        error = plugin._validate_write_commands_shape('p', 'c', [{**base, field: value}])
        assert error is not None, (field, value)
        assert error['status'] == 'invalid_command_schema'
        assert field in error['error']


def test_html_batch_update_and_restore_require_explicit_versions():
    plugin = _load_plugin_module()
    for command in [
        {'type': 'html_artifact', 'action': 'update', 'artifact_id': 'a', 'title': 'Page', 'html': 'hi'},
        {'type': 'html_artifact', 'action': 'restore', 'artifact_id': 'a', 'base_version': 2},
        {'type': 'html_artifact', 'action': 'restore', 'artifact_id': 'a', 'base_version': True, 'version': 1},
    ]:
        error = plugin._validate_write_commands_shape('p', 'c', [command])
        assert error is not None
        assert error['status'] == 'invalid_command_schema'


def test_compiled_workflow_prepare_is_gated_from_public_html_writes(monkeypatch):
    plugin = _load_plugin_module()
    from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
    built = build_workflow_graph_commands({'plan': {'nodes': [{'id': 'page', 'node_type': 'htmlArtifactNode', 'prompt': 'Build a page', 'data': {'workflowCatalog': {'recipeId': 'html'}}}], 'edges': []}})
    assert built['ok'], built
    command = next(command for command in built['commands'] if command['type'] == 'html_artifact')
    monkeypatch.setattr(plugin, '_resolve_canvas_scope_for_write', lambda p, c: (p, c, None))
    monkeypatch.setattr(plugin, '_external_generation_parameter_preflight', lambda *a: None)
    monkeypatch.setattr(plugin, '_external_mcp_agent_enabled', lambda: False)
    monkeypatch.setattr(plugin, '_mcp_direct_canvas_apply_enabled', lambda: False)
    dispatched = []
    monkeypatch.setattr(plugin, '_dispatch_frontend_canvas_commands', lambda **kwargs: dispatched.append(kwargs) or {'ok': True})
    assert plugin._emit_canvas_commands('p', 'c', [command])['status'] == 'invalid_command_schema'
    assert not dispatched
    result = plugin._emit_canvas_commands('p', 'c', built['commands'], allow_dynamic_workflow_batch=True)
    assert result['ok'], result
    assert dispatched[0]['commands'] == built['commands']


def test_trusted_prepare_rejects_embedded_artifact_source(monkeypatch):
    plugin = _load_plugin_module()
    command = {'type': 'html_artifact', 'action': 'prepare', 'client_id': 'page', 'workflow_data': {'prompt': 'Build', 'workflowInstanceId': 'w', 'workflowPlanNodeId': 'p', 'workflowCatalog': {'recipeId': 'html'}, 'html': '<html></html>'}}
    error = plugin._validate_write_commands_shape('p', 'c', [command], allow_workflow_prepare=True)
    assert error['status'] == 'invalid_command_schema'
    assert 'workflow_data' in error['error']


def test_html_recipe_catalog_search_exposes_format_and_execution_node(monkeypatch):
    plugin = _load_plugin_module()
    recipe = {'id': 'page-craft', 'name': 'Page craft', 'output_kind': 'text', 'output_format': 'html'}
    monkeypatch.setattr(plugin, '_request', lambda *a, **k: {'ok': True, 'data': [recipe]})
    result = plugin._handle_list_agent_catalog({'kind': 'recipes', 'query': 'html'})
    assert result['count'] == 1
    assert result['items'][0]['output_format'] == 'html'
    assert result['items'][0]['node_type'] == 'htmlArtifactNode'
    from test_freezone_plugin import _assert_real_mcp_output
    structured = _assert_real_mcp_output(plugin, 'freezone_list_agent_catalog', result)
    assert structured['items'][0]['node_type'] == 'htmlArtifactNode'
    result = plugin._handle_list_agent_catalog({'kind': 'recipes', 'query': 'htmlArtifactNode'})
    assert result['count'] == 1


def test_skill_studio_schemas_advertise_html_recipe_and_stage_format():
    import pytest
    from jsonschema import Draft202012Validator, ValidationError
    plugin = _load_plugin_module()
    stage = {'id': 'page', 'recipe_id': 'page-craft', 'reuse': 'new', 'output_kind': 'text', 'output_format': 'html'}
    recipe = {'id': 'page-craft', 'name': 'Page craft', 'output_kind': 'text', 'output_format': 'html', 'action_keys': ['page'], 'system_prompt': 'Prepare webpage instructions', 'must_have_items': [], 'planning_prompt': 'Build page', 'result_summary': 'A webpage', 'requires_source_media': True}
    for schema, value in [(plugin._SKILL_STUDIO_DRAFT_OUTLINE_STAGE_SCHEMA, stage), (plugin._SKILL_STUDIO_RECIPE_SCHEMA, recipe)]:
        assert schema['properties']['output_format']['enum'] == ['html']
        Draft202012Validator(schema).validate(value)
        with pytest.raises(ValidationError):
            Draft202012Validator(schema).validate({**value, 'output_format': 'markdown'})
        with pytest.raises(ValidationError):
            Draft202012Validator(schema).validate({**value, 'output_kind': 'image'})

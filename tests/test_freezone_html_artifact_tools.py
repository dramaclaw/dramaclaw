from test_freezone_plugin import _load_plugin_module


def test_html_writes_use_confirmed_frontend_bridge(monkeypatch):
    plugin = _load_plugin_module()
    calls = []
    monkeypatch.setattr(plugin, '_emit_canvas_commands', lambda project, canvas, commands: calls.append((project, canvas, commands)) or {'ok': True})
    monkeypatch.setattr(plugin, '_request', lambda *a, **k: (_ for _ in ()).throw(AssertionError('must not write directly')))
    plugin._handle_html_artifact({'action': 'create', 'project_id': 'p', 'canvas_id': 'c', 'title': 'Page', 'html': '<h1>Hello</h1>', 'reference_node_ids': ['image1']})
    assert calls == [('p', 'c', [{'type': 'html_artifact', 'action': 'create', 'title': 'Page', 'html': '<h1>Hello</h1>', 'reference_node_ids': ['image1']}])]
    assert plugin._requires_frontend_canvas_executor(calls[0][2])
    assert plugin._approval_required_for_commands(calls[0][2])[0]


def test_read_version_uses_scoped_authenticated_request(monkeypatch):
    plugin = _load_plugin_module()
    calls = []
    monkeypatch.setattr(plugin, '_request', lambda *a, **k: calls.append((a,k)) or {'ok':True, 'data': {'id':'abc','version':2,'html':'hello'}})
    result = plugin._handle_html_artifact({'action':'read','project_id':'p/q','artifact_id':'abc','version':2})
    assert calls == [(('GET','/api/v1/projects/p%2Fq/freezone/html-artifacts/abc'), {'query':{'version':2}})]
    assert result['html'] == 'hello'
    from jsonschema import Draft202012Validator
    Draft202012Validator(plugin._output_schema('freezone_html_artifact')).validate(result)


def test_update_requires_explicit_base_version(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setattr(plugin, '_emit_canvas_commands', lambda *a: (_ for _ in ()).throw(AssertionError('must reject')))
    result = plugin._handle_html_artifact({'action':'update','project_id':'p','canvas_id':'c','artifact_id':'abc','title':'Page','html':'hello'})
    assert 'base_version' in str(result)


def test_list_and_history_preserve_api_envelopes(monkeypatch):
    plugin = _load_plugin_module()
    calls = []
    monkeypatch.setattr(plugin, '_request', lambda *a, **k: calls.append((a,k)) or {'ok':True, 'data':{'versions':[{'version':2}]}})
    plugin._handle_html_artifact({'action':'list','project_id':'p'})
    result = plugin._handle_html_artifact({'action':'history','project_id':'p','artifact_id':'abc'})
    assert [call[0][1] for call in calls] == ['/api/v1/projects/p/freezone/html-artifacts','/api/v1/projects/p/freezone/html-artifacts/abc/versions']
    assert result['versions'] == [{'version':2}]
    from jsonschema import Draft202012Validator
    Draft202012Validator(plugin._output_schema('freezone_html_artifact')).validate(result)


def test_restore_uses_new_base_version_in_same_identity(monkeypatch):
    plugin = _load_plugin_module()
    calls = []
    monkeypatch.setattr(plugin, '_emit_canvas_commands', lambda *a: calls.append(a) or {'ok':True})
    plugin._handle_html_artifact({'action':'restore','project_id':'p','canvas_id':'c','artifact_id':'abc','version':1,'base_version':4})
    assert calls[0][2] == [{'type':'html_artifact','action':'restore','artifact_id':'abc','version':1,'base_version':4}]


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


def test_html_tool_receipts_get_canvas_timeout_and_success_classification():
    from novelvideo.chat import hermes_sdk, service
    from types import SimpleNamespace
    assert hermes_sdk._is_freezone_canvas_write_tool('freezone_html_artifact')
    event = SimpleNamespace(name='freezone_html_artifact',status='completed',error=None,structured={'ok':True,'canvas_apply_status':'applied','applied':True,'project_id':'p','canvas_id':'c','bridge_key':'b'},output=None)
    assert service._codex_freezone_write_result_succeeded(event)
    event.structured = {'ok':True,'data':{'id':'a1','html':'hello'}}
    assert not service._codex_freezone_write_result_succeeded(event)

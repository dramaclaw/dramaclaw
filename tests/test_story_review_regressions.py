import asyncio
import json

from jsonschema import Draft202012Validator

from novelvideo.chat import dramaclaw_mcp
from novelvideo.chat.hermes_sdk import _story_tool_receipt


def test_nested_acp_receipt():
    receipt = {'ok': False, 'code': 'revision_conflict', 'current_revision': 3}
    assert _story_tool_receipt([{'type': 'content', 'content': {
        'type': 'text', 'text': json.dumps(receipt)}}]) == receipt


def test_patch_feedback_path_selects_actual_operation(monkeypatch):
    monkeypatch.setenv('DRAMACLAW_PROJECT_ID', 'p')
    monkeypatch.setenv('DRAMACLAW_CANVAS_ID', 'c')
    monkeypatch.setenv('DRAMACLAW_CHAT_SURFACE', 'freezone')
    schema = {t.name: t.inputSchema for t in asyncio.run(
        dramaclaw_mcp.list_tools())}['dramaclaw_patch_interactive_story']
    args = {'story_id': 's', 'base_revision': 1, 'idempotency_key': 'test-12345',
            'operations': [{'op': 'add_choice', 'choice': {
                'id': 'c', 'source_segment_id': 'a', 'target_segment_id': 'b',
                'mode': 'automatic', 'text': '', 'order': 0, 'feedback_text': 'drop'}}]}
    details = dramaclaw_mcp._validation_error_details(
        list(Draft202012Validator(schema).iter_errors(args)))
    assert len(details) == 1
    assert details[0]['path'] == 'operations.0.choice.feedback_text'
    assert 'Keep effects unchanged' in details[0]['message']


def test_plugin_receipt_roundtrip_after_scalar_coercion(monkeypatch, tmp_path):
    from novelvideo.chat.hermes_sdk import _load_recent_freezone_tool_result
    plugin = dramaclaw_mcp._plugin('freezone')
    monkeypatch.setenv('DRAMACLAW_FREEZONE_TOOL_RESULT_DIR', str(tmp_path))
    name = 'freezone_test_receipt'
    schema = {'parameters': {'properties': {
        'count': {'type': 'integer'}, 'enabled': {'type': 'boolean'},
        'label': {'type': 'string'}}}}
    monkeypatch.setattr(dramaclaw_mcp, '_plugin_tools', lambda _: {name: (schema, None)})
    receipt = {'ok': True, 'revision': 2}
    writer = plugin._bind_structured_result_input(
        lambda args: plugin._record_structured_tool_result(name, receipt))
    writer({'count': 2, 'enabled': True, 'label': '2'})
    # A newer same-name call must not replace the matching call's receipt.
    receipt = {'ok': True, 'revision': 3}
    writer({'count': 3, 'enabled': True, 'label': '2'})
    recovered = _load_recent_freezone_tool_result(str(tmp_path), name,
        tool_input={'count': '2', 'enabled': 'true', 'label': '2'})
    assert recovered == {'ok': True, 'revision': 2}
    assert _story_tool_receipt([{'type': 'content', 'content': {
        'type': 'text', 'text': json.dumps(recovered)}}]) == recovered
    assert _load_recent_freezone_tool_result(str(tmp_path), name,
        tool_input={'count': '2', 'enabled': 'true', 'label': 2}) is None


def test_fastapi_path_matches_arguments(monkeypatch):
    monkeypatch.setenv('DRAMACLAW_PROJECT_ID', 'p')
    result = dramaclaw_mcp._structured_tool_result('dramaclaw_create_interactive_story',
        json.dumps({'ok': False, 'error': 'invalid', 'data': {'detail': [
            {'loc': ['body', 'story', 'title'], 'msg': 'required', 'input': 'secret'}]}}))
    assert result.structuredContent['details'] == [
        {'path': 'story.title', 'message': 'required'}]
    assert 'secret' not in result.content[0].text

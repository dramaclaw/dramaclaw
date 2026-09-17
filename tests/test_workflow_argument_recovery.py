from copy import deepcopy

import pytest
from mcp import types

from novelvideo.chat import workflow_mcp
from novelvideo.freezone.workflow_schema import normalize_workflow_tool_arguments


@pytest.mark.parametrize("name", ["workflow_intent_compile", "freezone_prepare_workflow_draft"])
def test_repairs_contiguous_items_and_optional_null_duration_without_mutation(name):
    args = {"intent": {
        "items[1]": {"id": "video", "duration_seconds": 5},
        "items[0]": {"id": "text", "duration_seconds": None},
        "planner": {"units": [{"title": "shot", "duration_seconds": None}]},
    }}
    original = deepcopy(args)
    result = normalize_workflow_tool_arguments(name, args)
    assert result["intent"]["items"] == [{"id": "text"}, {"id": "video", "duration_seconds": 5}]
    assert result["intent"]["planner"]["units"] == [{"title": "shot"}]
    assert args == original


@pytest.mark.parametrize("name", ["workflow_intent_compile", "freezone_prepare_workflow_draft"])
def test_canonicalizes_unambiguous_generation_input_scalar_types(name):
    args = {"intent": {"inputs": {
        "image_variants_per_node": "1",
        "video_variants_per_node": "4",
        "video_duration_seconds": "5.5",
        "video_generate_audio": "false",
        "skill_specific_value": "1",
    }}}
    original = deepcopy(args)

    result = normalize_workflow_tool_arguments(name, args)

    assert result["intent"]["inputs"] == {
        "image_variants_per_node": 1,
        "video_variants_per_node": 4,
        "video_duration_seconds": 5.5,
        "video_generate_audio": False,
        "skill_specific_value": "1",
    }
    assert args == original


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("image_variants_per_node", "1.0"),
        ("video_variants_per_node", "-1"),
        ("image_variants_per_node", "9" * 5000),
        ("video_duration_seconds", "5 seconds"),
        ("video_duration_seconds", "9" * 5000),
        ("video_generate_audio", "False"),
    ],
)
def test_does_not_guess_ambiguous_generation_input_scalar_types(key, value):
    args = {"intent": {"inputs": {key: value}}}
    assert normalize_workflow_tool_arguments("workflow_intent_compile", args) == args


@pytest.mark.parametrize("intent", [
    {"items[1]": {}},
    {"items": [], "items[0]": {}},
    {"items[01]": {}},
    {"items": [{"duration_seconds": "5", "id": None}]},
])
def test_ambiguous_or_semantic_values_are_not_repaired(intent):
    args = {"intent": intent}
    assert normalize_workflow_tool_arguments("workflow_intent_compile", args) == args


@pytest.mark.asyncio
async def test_compile_boundary_normalizes_before_validating(monkeypatch):
    seen = []

    def compile_intent(intent):
        seen.append(intent)
        return {"ok": False, "status": "sentinel", "error": "compiler reached"}

    monkeypatch.setattr(workflow_mcp, "compile_workflow_intent", compile_intent)
    result = await workflow_mcp.call_tool("workflow_intent_compile", {"intent": {
        "skill_id": "test", "user_goal": "test",
        "items[0]": {"id": "text", "title": "Text", "recipe_id": "general-text",
                     "duration_seconds": None},
    }})
    assert result.structuredContent["status"] == "sentinel"
    assert "duration_seconds" not in seen[0]["items"][0]


@pytest.mark.asyncio
async def test_compile_boundary_canonicalizes_generation_counts_before_validation(monkeypatch):
    seen = []

    def compile_intent(intent):
        seen.append(intent)
        return {"ok": False, "status": "sentinel", "error": "compiler reached"}

    monkeypatch.setattr(workflow_mcp, "compile_workflow_intent", compile_intent)
    result = await workflow_mcp.call_tool("workflow_intent_compile", {"intent": {
        "skill_id": "test",
        "user_goal": "test",
        "inputs": {
            "image_variants_per_node": "1",
            "video_variants_per_node": "2",
        },
    }})

    assert result.structuredContent["status"] == "sentinel"
    assert seen[0]["inputs"] == {
        "image_variants_per_node": 1,
        "video_variants_per_node": 2,
    }


@pytest.mark.asyncio
async def test_compile_boundary_rejects_oversized_generation_count_without_crashing(
    monkeypatch,
):
    def must_not_compile(_intent):
        raise AssertionError("invalid input reached compiler")

    monkeypatch.setattr(workflow_mcp, "compile_workflow_intent", must_not_compile)
    result = await workflow_mcp.call_tool("workflow_intent_compile", {"intent": {
        "skill_id": "test",
        "user_goal": "test",
        "inputs": {"image_variants_per_node": "9" * 5000},
    }})

    assert result.isError
    assert result.structuredContent["status"] == "tool_arguments_invalid"


@pytest.mark.asyncio
async def test_compile_boundary_rejects_conflict_without_calling_compiler(monkeypatch):
    def must_not_compile(_intent):
        raise AssertionError("invalid input reached compiler")

    monkeypatch.setattr(workflow_mcp, "compile_workflow_intent", must_not_compile)
    result = await workflow_mcp.call_tool("workflow_intent_compile", {"intent": {
        "skill_id": "test", "user_goal": "test", "items": [], "items[0]": {},
    }})
    assert result.isError
    assert result.structuredContent["status"] == "tool_arguments_invalid"
    assert "intent" in result.structuredContent["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize("adapter", ["workflow", "dramaclaw"])
async def test_sdk_boundary_repairs_before_validation_but_keeps_required_fields(monkeypatch, adapter):
    import json
    from novelvideo.chat import dramaclaw_mcp
    from novelvideo.freezone.workflow_schema import workflow_intent_json_schema

    seen = []
    if adapter == "workflow":
        server = workflow_mcp.SERVER
        name = "workflow_intent_compile"

        def compiler(intent):
            seen.append(intent)
            return {"ok": False, "status": "sentinel", "error": "compiler reached"}

        monkeypatch.setattr(workflow_mcp, "compile_workflow_intent", compiler)
    else:
        server = dramaclaw_mcp.SERVER
        name = "freezone_prepare_workflow_draft"
        monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
        monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
        real_schema = dramaclaw_mcp._agent_tools()[name][0]

        def handler(args):
            seen.append(args["intent"])
            return json.dumps({"ok": False, "status": "sentinel", "error": "handler reached"})

        monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", lambda: {name: ({
            **real_schema,
            "parameters": {"type": "object", "properties": {
                "intent": workflow_intent_json_schema(),
            }, "required": ["intent"], "additionalProperties": False},
        }, handler)})

    sdk_handler = server.request_handlers[types.CallToolRequest]
    response = await sdk_handler(types.CallToolRequest(method="tools/call", params=types.CallToolRequestParams(
        name=name, arguments={"intent": {"skill_id": "test", "user_goal": "test",
            "items[0]": {"id": "a", "title": "A", "recipe_id": "general-text",
                         "duration_seconds": None}}},
    )))
    assert len(seen) == 1, response
    assert seen[0]["items"] == [{"id": "a", "title": "A", "recipe_id": "general-text"}]
    response = await sdk_handler(types.CallToolRequest(method="tools/call", params=types.CallToolRequestParams(
        name=name, arguments={"intent": {"skill_id": "test"}},
    )))
    assert len(seen) == 1
    assert response.root.isError


@pytest.mark.asyncio
@pytest.mark.parametrize('adapter', ['workflow', 'dramaclaw'])
async def test_html_missing_prompt_reports_repair_without_changing_node_type(monkeypatch, adapter):
    import json
    from novelvideo.chat import dramaclaw_mcp
    from novelvideo.freezone.workflow_schema import workflow_plan_json_schema

    plan = {'schema_version': 'freezone_workflow_plan.v1', 'skill': {'id': 'page'},
            'nodes': [{'id': 'page', 'node_type': 'htmlArtifactNode',
                       'data': {'workflowCatalog': {'recipeId': 'page-recipe'}}}], 'edges': []}
    if adapter == 'workflow':
        result = await workflow_mcp.call_tool('workflow_graph_compile', {'plan': plan})
        payload = result.structuredContent
    else:
        monkeypatch.setenv('DRAMACLAW_TOOL_MODE', 'freezone_canvas')
        monkeypatch.setenv('DRAMACLAW_PROJECT_ID', 'project-a')
        name = 'freezone_prepare_workflow_plan_draft'
        schema = dramaclaw_mcp._agent_tools()[name][0]
        def must_not_run(_args):
            raise AssertionError('Invalid HTML reached handler')
        monkeypatch.setattr(dramaclaw_mcp, '_agent_tools', lambda: {name: ({**schema,
            'parameters': {'type': 'object', 'properties': {'plan': workflow_plan_json_schema()}, 'required': ['plan']}}, must_not_run)})
        result = await dramaclaw_mcp.call_tool(name, {'plan': plan})
        payload = json.loads(result.content[0].text)
    text = json.dumps(payload)
    assert 'plan.nodes[0].prompt' in text
    assert 'data.prompt' in text
    assert 'Keep node_type=htmlArtifactNode' in text
    assert plan['nodes'][0]['node_type'] == 'htmlArtifactNode'
    assert 'prompt' not in plan['nodes'][0]['data']

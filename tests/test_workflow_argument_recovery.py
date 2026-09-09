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

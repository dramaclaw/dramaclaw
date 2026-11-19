import pytest
from jsonschema import Draft202012Validator

from codex_schema_compaction import codex_tool_parameters, prepared_size
from novelvideo.chat import interactive_story_mcp, workflow_mcp
from test_canvas_command_schema_publication import PROFILES, _load


@pytest.mark.asyncio
async def test_external_codex_retains_core_workflow_and_story_arguments(monkeypatch):
    monkeypatch.delenv("DRAMACLAW_CODEX_COMPACT_SCHEMAS", raising=False)
    _, full = _load(PROFILES["freezone"])
    monkeypatch.setenv("DRAMACLAW_CODEX_COMPACT_SCHEMAS", "1")
    _, main = _load(PROFILES["freezone"])
    workflow = {tool.name: tool for tool in await workflow_mcp.list_tools()}
    story = {tool.name: tool for tool in await interactive_story_mcp.list_tools()}
    cases = {
        "freezone_prepare_workflow": main,
        "freezone_prepare_workflow_plan_draft": main,
        "workflow_graph_compile": workflow,
        "dramaclaw_create_interactive_story": story,
        "dramaclaw_patch_interactive_story": story,
    }

    for name, tools in cases.items():
        published = tools[name].inputSchema
        Draft202012Validator.check_schema(published)
        assert prepared_size(published) < 4900, name
        root = codex_tool_parameters(published)["properties"]
        if "plan" in root:
            plan = root["plan"]["properties"]
            assert plan["skill"]["properties"].keys() >= {"id", "version"}
            assert plan["nodes"]["items"]["properties"].keys() >= {"id", "node_type"}
            assert plan["edges"]["items"]["properties"].keys() >= {
                "source",
                "target",
                "link_type",
            }
        if "intent" in root:
            intent = root["intent"]["properties"]
            assert intent["items"]["items"]["properties"].keys() >= {"id", "recipe_id"}
        if "story" in root:
            segments = root["story"]["properties"]["segments"]["items"]["properties"]
            assert segments["media"]["properties"].keys() >= {"source", "asset_id"}
        if "operations" in root:
            operations = root["operations"]["items"]
            assert {"add_segment", "update_choice"} <= set(
                operations["properties"]["op"]["enum"]
            )
            assert operations["properties"].keys() >= {
                "op",
                "segment",
                "choice",
                "changes",
            }

    assert (
        main["freezone_create_node"].inputSchema
        == full["freezone_create_node"].inputSchema
    )

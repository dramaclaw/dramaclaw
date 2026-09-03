from __future__ import annotations

import asyncio
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import time

import pytest
from jsonschema import Draft202012Validator
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from novelvideo.chat import dramaclaw_mcp

CE_ROOT = Path(__file__).resolve().parents[1]


def test_external_mcp_ready_draft_honors_explicit_create_without_changing_plugin():
    original = {
        "ok": True,
        "status": "workflow_draft_ready",
        "draft_id": "draft-a",
        "revision": 1,
        "agent_instruction": "Wait for user confirmation.",
    }

    adapted = json.loads(
        dramaclaw_mcp._adapt_external_agent_tool_result(
            "freezone_prepare_workflow_draft",
            json.dumps(original),
        )
    )

    assert original["agent_instruction"] == "Wait for user confirmation."
    assert "call freezone_confirm_workflow_draft exactly once now" in adapted[
        "agent_instruction"
    ]
    assert "without asking for another confirmation" in adapted["agent_instruction"]


def test_external_mcp_ready_draft_preserves_nested_billing_instruction():
    original = {
        "ok": True,
        "status": "workflow_draft_ready",
        "draft_id": "draft-b",
        "revision": 2,
        "agent_instruction": "展示规划费用，并说明媒体节点另行计费。",
        "billing": {"agent_credit_estimate": {"display": "约 12 积分"}},
    }

    adapted = json.loads(
        dramaclaw_mcp._adapt_external_agent_tool_result(
            "freezone_prepare_workflow_draft",
            json.dumps(original, ensure_ascii=False),
        )
    )

    assert "展示规划费用" in adapted["agent_instruction"]
    assert "Preserve and clearly display" in adapted["agent_instruction"]
    assert "Do not invent or mention credits" not in adapted["agent_instruction"]


def test_external_mcp_plan_draft_keeps_custom_topology_in_the_draft_flow():
    original = {
        "ok": True,
        "status": "workflow_draft_ready",
        "draft_id": "draft-plan",
        "revision": 1,
        "agent_instruction": "Present the exact custom topology preview.",
    }

    adapted = json.loads(
        dramaclaw_mcp._adapt_external_agent_tool_result(
            "freezone_prepare_workflow_plan_draft",
            json.dumps(original),
        )
    )

    assert "call freezone_confirm_workflow_draft exactly once" in adapted[
        "agent_instruction"
    ]
    assert "prepare a new complete Plan draft" in adapted["agent_instruction"]
    assert "patch this draft" not in adapted["agent_instruction"]


def test_plugin_reads_turn_token_file_lazily(monkeypatch, tmp_path):
    token_file = tmp_path / "turn.token"
    token_file.write_text("first-token", encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("DRAMACLAW_AGENT_TOKEN", raising=False)

    assert dramaclaw_mcp.PLUGIN._request_headers("test")["Authorization"] == (
        "Bearer first-token"
    )
    token_file.write_text("second-token", encoding="utf-8")
    assert dramaclaw_mcp.PLUGIN._request_headers("test")["Authorization"] == (
        "Bearer second-token"
    )


def test_freezone_handler_reads_rotating_turn_token_file(monkeypatch, tmp_path):
    token_file = tmp_path / "turn.token"
    token_file.write_text("first-token", encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://127.0.0.1:8780")
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("DRAMACLAW_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("DRAMACLAW_LOCAL_AGENT_TRUST", raising=False)
    freezone_plugin = dramaclaw_mcp.PLUGINS[1]
    seen_authorization = []

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return BytesIO(b'{"ok": true, "data": []}').read()

    def fake_urlopen(request, **_kwargs):
        seen_authorization.append(request.get_header("Authorization"))
        return FakeResponse()

    monkeypatch.setattr(freezone_plugin, "urlopen", fake_urlopen)

    freezone_plugin._handle_list_agent_catalog({"kind": "skills"})
    token_file.write_text("second-token", encoding="utf-8")
    freezone_plugin._handle_list_agent_catalog({"kind": "skills"})

    assert seen_authorization == ["Bearer first-token", "Bearer second-token"]


@pytest.mark.asyncio
async def test_project_scope_lists_concrete_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.delenv("DRAMACLAW_MCP_TOOL_DISCOVERY", raising=False)

    tools = await dramaclaw_mcp.list_tools()

    names = {tool.name for tool in tools}
    assert names == set(dramaclaw_mcp.TOOLS)
    assert names.isdisjoint(dramaclaw_mcp.BRIDGE_TOOL_NAMES)

    schemas = {tool.name: tool.outputSchema for tool in tools}
    assert all(schema is not None for schema in schemas.values())
    assert len({schema["title"] for schema in schemas.values()}) == len(schemas)
    assert len({tuple(schema["properties"]) for schema in schemas.values()}) >= 70
    for name, schema in schemas.items():
        Draft202012Validator.check_schema(schema)
        assert schema["x-dramaclaw-tool"] == name
        assert schema["required"] == ["ok", "status", "data"]
        assert schema["additionalProperties"] is False
        assert all(property_schema for property_schema in schema["properties"].values())

    for plugin in dramaclaw_mcp.PLUGINS:
        plugin_tool_names = {name for name, _schema, _handler in plugin.TOOLS}
        assert set(plugin._RESULT_FIELDS) == plugin_tool_names


@pytest.mark.asyncio
async def test_home_scope_lists_only_concrete_project_collection_tools(monkeypatch):
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID", raising=False)
    monkeypatch.delenv("DRAMACLAW_MCP_TOOL_DISCOVERY", raising=False)

    tools = await dramaclaw_mcp.list_tools()

    assert {tool.name for tool in tools} == dramaclaw_mcp.HOME_TOOL_NAMES
    assert {tool.name for tool in tools}.isdisjoint(dramaclaw_mcp.BRIDGE_TOOL_NAMES)


@pytest.mark.asyncio
async def test_freezone_lists_concrete_hermes_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    monkeypatch.delenv("DRAMACLAW_MCP_TOOL_DISCOVERY", raising=False)

    tools = await dramaclaw_mcp.list_tools()
    names = {tool.name for tool in tools}

    assert "freezone_create_node" in names
    assert "freezone_emit_canvas_command" in names
    assert "freezone_prepare_workflow_plan_draft" in names
    assert "freezone_create_workflow_graph" not in names
    assert "freezone_create_workflow_from_intent" not in names
    assert "dramaclaw_tool_call" not in names
    tools_by_name = {tool.name: tool for tool in tools}
    assert (
        tools_by_name["freezone_prepare_workflow_plan_draft"].outputSchema
        == dramaclaw_mcp._WORKFLOW_DRAFT_OUTPUT_SCHEMA
    )


@pytest.mark.asyncio
async def test_codex_bridge_lists_only_function_compatible_discovery_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_MCP_TOOL_DISCOVERY", "bridge")

    tools = await dramaclaw_mcp.list_tools()

    assert {tool.name for tool in tools} == dramaclaw_mcp.BRIDGE_TOOL_NAMES


@pytest.mark.asyncio
async def test_codex_bridge_search_describe_and_call(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_MCP_TOOL_DISCOVERY", "bridge")
    schema, _handler = dramaclaw_mcp.TOOLS["dramaclaw_render_first_frames"]
    calls = []
    monkeypatch.setitem(
        dramaclaw_mcp.TOOLS,
        "dramaclaw_render_first_frames",
        (schema, lambda arguments: calls.append(arguments) or '{"ok":true}'),
    )

    search = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_SEARCH_NAME, {"query": "首帧生成"}
    )
    search_payload = json.loads(search.content[0].text)
    assert "dramaclaw_render_first_frames" in {
        item["name"] for item in search_payload["tools"]
    }

    describe = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_DESCRIBE_NAME,
        {"tool_name": "dramaclaw_render_first_frames"},
    )
    describe_payload = json.loads(describe.content[0].text)
    assert describe_payload["tool"]["input_schema"] == schema["parameters"]
    assert describe_payload["tool"]["output_schema"]["x-dramaclaw-tool"] == (
        "dramaclaw_render_first_frames"
    )

    result = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_CALL_NAME,
        {
            "tool_name": "dramaclaw_render_first_frames",
            "arguments": {"episode": 1},
        },
    )
    bridge_payload = json.loads(result.content[0].text)
    assert bridge_payload["ok"] is True
    assert bridge_payload["tool_name"] == "dramaclaw_render_first_frames"
    assert bridge_payload["result"]["data"] == {"ok": True}
    assert calls == [{"episode": 1}]


@pytest.mark.asyncio
async def test_codex_bridge_discovers_and_describes_every_project_tool(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_MCP_TOOL_DISCOVERY", "bridge")

    for tool_name, (schema, _handler) in dramaclaw_mcp.TOOLS.items():
        search = await dramaclaw_mcp.call_tool(
            dramaclaw_mcp.TOOL_SEARCH_NAME,
            {"query": tool_name, "limit": 1},
        )
        search_payload = json.loads(search.content[0].text)
        assert search_payload["tools"][0]["name"] == tool_name

        describe = await dramaclaw_mcp.call_tool(
            dramaclaw_mcp.TOOL_DESCRIBE_NAME,
            {"tool_name": tool_name},
        )
        describe_payload = json.loads(describe.content[0].text)
        assert describe_payload["tool"]["name"] == tool_name
        assert describe_payload["tool"]["input_schema"] == schema["parameters"]


@pytest.mark.asyncio
async def test_codex_bridge_handles_concurrent_searches(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_MCP_TOOL_DISCOVERY", "bridge")
    queries = ["项目", "状态", "首帧", "视频", "音频", "角色", "画布", "工作流"] * 10

    results = await asyncio.gather(
        *(
            dramaclaw_mcp.call_tool(
                dramaclaw_mcp.TOOL_SEARCH_NAME,
                {"query": query, "limit": 6},
            )
            for query in queries
        )
    )

    assert len(results) == 80
    assert all(json.loads(result.content[0].text)["tools"] for result in results)


@pytest.mark.asyncio
async def test_codex_bridge_rejects_unknown_and_nested_calls(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_MCP_TOOL_DISCOVERY", "bridge")

    unknown = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_DESCRIBE_NAME,
        {"tool_name": "dramaclaw_not_real"},
    )
    nested = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_CALL_NAME,
        {"tool_name": dramaclaw_mcp.TOOL_SEARCH_NAME, "arguments": {}},
    )

    assert unknown.isError is True
    assert nested.isError is True
    assert json.loads(unknown.content[0].text)["error"] == "unknown_dramaclaw_tool"
    assert json.loads(nested.content[0].text)["error"] == "unknown_dramaclaw_tool"


@pytest.mark.asyncio
async def test_codex_bridge_keeps_home_and_freezone_scope_filters(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_MCP_TOOL_DISCOVERY", "bridge")
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID", raising=False)

    home_search = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_SEARCH_NAME, {"query": ""}
    )
    home_payload = json.loads(home_search.content[0].text)
    assert {item["name"] for item in home_payload["tools"]} == (
        dramaclaw_mcp.HOME_TOOL_NAMES
    )

    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    denied = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_CALL_NAME,
        {
            "tool_name": "dramaclaw_render_first_frames",
            "arguments": {"episode": 1},
        },
    )
    assert denied.isError is True
    assert json.loads(denied.content[0].text)["error"] == "unknown_dramaclaw_tool"


async def test_codex_bridge_completes_real_mcp_handshake():
    env = {
        **os.environ,
        "DRAMACLAW_MCP_TOOL_DISCOVERY": "bridge",
        "DRAMACLAW_PROJECT_ID": "project-a",
        "DRAMACLAW_USERNAME": "local",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "novelvideo.chat.dramaclaw_mcp"],
        env=env,
        cwd=str(CE_ROOT),
    )

    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tools = await session.list_tools()
            search = await session.call_tool(
                dramaclaw_mcp.TOOL_SEARCH_NAME, {"query": "首帧生成"}
            )

    assert {tool.name for tool in tools.tools} == dramaclaw_mcp.BRIDGE_TOOL_NAMES
    payload = json.loads(search.content[0].text)
    assert "dramaclaw_render_first_frames" in {
        item["name"] for item in payload["tools"]
    }


async def test_concrete_tool_completes_real_mcp_output_contract_round_trip():
    env = {
        **os.environ,
        "DRAMACLAW_PROJECT_ID": "project-a",
        "DRAMACLAW_USERNAME": "local",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    env.pop("DRAMACLAW_MCP_TOOL_DISCOVERY", None)
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "novelvideo.chat.dramaclaw_mcp"],
        env=env,
        cwd=str(CE_ROOT),
    )

    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tools = {tool.name: tool for tool in (await session.list_tools()).tools}
            result = await session.call_tool(
                "dramaclaw_prepare_system_voices",
                {"episode": 1, "confirmed": False},
            )

    tool = tools["dramaclaw_prepare_system_voices"]
    assert tool.outputSchema["x-dramaclaw-tool"] == tool.name
    assert result.structuredContent is not None
    Draft202012Validator(tool.outputSchema).validate(result.structuredContent)
    assert result.structuredContent["ok"] is False
    assert result.isError is True


def test_freezone_profile_defaults_tool_mode(monkeypatch):
    monkeypatch.delenv("DRAMACLAW_TOOL_MODE", raising=False)
    monkeypatch.setenv("DRAMACLAW_AGENT_PROFILE", "freezone:main")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "default")
    monkeypatch.delenv("DRAMACLAW_CHAT_SURFACE", raising=False)
    assert dramaclaw_mcp._freezone_canvas_mode()


@pytest.mark.asyncio
async def test_list_resources_exposes_only_skill_markdown(monkeypatch, tmp_path):
    skills = tmp_path / ".agents" / "skills" / "workflows"
    (skills / "references").mkdir(parents=True)
    (skills / "SKILL.md").write_text("# Workflow\n", encoding="utf-8")
    (skills / "references" / "guide.md").write_text("# Guide\n", encoding="utf-8")
    (skills / "secret.txt").write_text("no", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("DRAMACLAW_SKILLS_DIR", raising=False)

    resources = await dramaclaw_mcp.list_resources()

    assert {resource.name for resource in resources} == {
        "workflows/SKILL.md",
        "workflows/references/guide.md",
    }


@pytest.mark.asyncio
async def test_read_resource_remaps_stale_workspace_uri_to_current_skills_root(
    monkeypatch, tmp_path
):
    current_root = tmp_path / "current" / ".agents" / "skills"
    current_skill = current_root / "dramaclaw-workflows" / "SKILL.md"
    current_skill.parent.mkdir(parents=True)
    current_skill.write_text("# Current workflow skill\n", encoding="utf-8")
    stale_skill = (
        tmp_path
        / "retired"
        / ".agents"
        / "skills"
        / "dramaclaw-workflows"
        / "SKILL.md"
    )
    monkeypatch.setenv("DRAMACLAW_SKILLS_DIR", str(current_root))

    content = await dramaclaw_mcp.read_resource(stale_skill.as_uri())

    assert content == "# Current workflow skill\n"


@pytest.mark.asyncio
async def test_read_resource_accepts_codex_agent_root_relative_skill_path(
    monkeypatch, tmp_path
):
    current_root = tmp_path / "current" / ".agents" / "skills"
    current_skill = current_root / "dramaclaw-workflows" / "SKILL.md"
    current_skill.parent.mkdir(parents=True)
    current_skill.write_text("# Current workflow skill\n", encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_SKILLS_DIR", str(current_root))

    content = await dramaclaw_mcp.read_resource(
        "/.agents/skills/dramaclaw-workflows/SKILL.md"
    )

    assert content == "# Current workflow skill\n"


@pytest.mark.asyncio
async def test_read_resource_rejects_existing_file_from_another_workspace(
    monkeypatch, tmp_path
):
    current_root = tmp_path / "current" / ".agents" / "skills"
    current_skill = current_root / "dramaclaw-workflows" / "SKILL.md"
    current_skill.parent.mkdir(parents=True)
    current_skill.write_text("# Current workflow skill\n", encoding="utf-8")
    foreign_skill = (
        tmp_path
        / "other-user"
        / ".agents"
        / "skills"
        / "dramaclaw-workflows"
        / "SKILL.md"
    )
    foreign_skill.parent.mkdir(parents=True)
    foreign_skill.write_text("# Foreign private skill\n", encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_SKILLS_DIR", str(current_root))

    with pytest.raises(ValueError, match="different agent workspace"):
        await dramaclaw_mcp.read_resource(foreign_skill.as_uri())


def test_home_scope_only_discovers_project_collection_tools(monkeypatch):
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID", raising=False)

    assert set(dramaclaw_mcp._available_tools()) == dramaclaw_mcp.HOME_TOOL_NAMES
    matches = dramaclaw_mcp._search_tools("项目列表", 12)
    assert {match["name"] for match in matches} <= dramaclaw_mcp.HOME_TOOL_NAMES
    assert matches[0]["name"] == "dramaclaw_get"


def test_project_scope_can_discover_production_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.delenv("DRAMACLAW_TOOL_MODE", raising=False)

    available = dramaclaw_mcp._available_tools()
    matches = dramaclaw_mcp._search_tools("首帧生成", 6)

    assert set(available) == set(dramaclaw_mcp.TOOLS)
    assert "dramaclaw_render_first_frames" in {match["name"] for match in matches}


def test_freezone_scope_hides_mainline_write_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")

    available = dramaclaw_mcp._available_tools()
    denied = dramaclaw_mcp.PLUGIN.FREEZONE_DENIED_MAINLINE_WRITE_TOOLS

    assert set(available).isdisjoint(denied)
    assert "dramaclaw_save_freezone_canvas" not in available
    assert "freezone_emit_canvas_command" in available


@pytest.mark.asyncio
async def test_freezone_scope_rejects_direct_mainline_write_call(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")

    with pytest.raises(ValueError, match="unknown DramaClaw tool"):
        await dramaclaw_mcp.call_tool(
            "dramaclaw_render_first_frames",
            {"episode": 1},
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("wrapper_name", sorted(dramaclaw_mcp.BRIDGE_TOOL_NAMES))
async def test_legacy_bridge_wrappers_are_unavailable(monkeypatch, wrapper_name):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")

    with pytest.raises(ValueError, match="unknown DramaClaw tool"):
        await dramaclaw_mcp.call_tool(wrapper_name, {})


@pytest.mark.asyncio
async def test_tool_call_validates_and_dispatches_existing_handler(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    schema, _handler = dramaclaw_mcp.TOOLS["dramaclaw_render_first_frames"]
    calls = []
    monkeypatch.setitem(
        dramaclaw_mcp.TOOLS,
        "dramaclaw_render_first_frames",
        (schema, lambda arguments: calls.append(arguments) or '{"ok":true}'),
    )

    invalid = await dramaclaw_mcp.call_tool("dramaclaw_render_first_frames", {})
    invalid_payload = json.loads(invalid.content[0].text)
    assert invalid_payload["ok"] is False
    assert invalid_payload["error"] == "tool_arguments_invalid"
    assert calls == []

    valid = await dramaclaw_mcp.call_tool(
        "dramaclaw_render_first_frames", {"episode": 1}
    )
    assert json.loads(valid.content[0].text) == {"ok": True}
    assert calls == [{"episode": 1}]


@pytest.mark.asyncio
async def test_native_tool_call_does_not_block_mcp_event_loop(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    schema, _handler = dramaclaw_mcp.TOOLS["dramaclaw_render_first_frames"]

    def blocking_handler(_arguments):
        time.sleep(0.2)
        return '{"ok":true}'

    monkeypatch.setitem(
        dramaclaw_mcp.TOOLS,
        "dramaclaw_render_first_frames",
        (schema, blocking_handler),
    )
    call = asyncio.create_task(
        dramaclaw_mcp.call_tool(
            "dramaclaw_render_first_frames",
            {"episode": 1},
        )
    )

    await asyncio.sleep(0.05)
    assert call.done() is False
    result = await call
    assert json.loads(result.content[0].text) == {"ok": True}

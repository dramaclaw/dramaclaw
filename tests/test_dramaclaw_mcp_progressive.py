from __future__ import annotations

import json

import pytest

from novelvideo.chat import dramaclaw_mcp


@pytest.mark.asyncio
async def test_list_tools_exposes_only_progressive_bridge(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")

    tools = await dramaclaw_mcp.list_tools()

    assert {tool.name for tool in tools} == dramaclaw_mcp.BRIDGE_TOOL_NAMES
    assert len(tools) == 3


def test_home_scope_only_discovers_project_collection_tools(monkeypatch):
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID", raising=False)

    assert set(dramaclaw_mcp._available_tools()) == dramaclaw_mcp.HOME_TOOL_NAMES
    matches = dramaclaw_mcp._search_tools("项目列表", 12)
    assert {match["name"] for match in matches} <= dramaclaw_mcp.HOME_TOOL_NAMES
    assert matches[0]["name"] == "dramaclaw_get"


def test_project_scope_can_discover_production_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")

    available = dramaclaw_mcp._available_tools()
    matches = dramaclaw_mcp._search_tools("首帧生成", 6)

    assert set(available) == set(dramaclaw_mcp.TOOLS)
    assert "dramaclaw_render_first_frames" in {match["name"] for match in matches}


@pytest.mark.asyncio
async def test_describe_rejects_project_tool_from_home(monkeypatch):
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID", raising=False)

    result = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_DESCRIBE_NAME,
        {"tool_name": "dramaclaw_render_first_frames"},
    )
    payload = json.loads(result[0].text)

    assert payload == {
        "ok": False,
        "error": "tool_not_available_in_scope",
        "scope": "home",
        "tool_name": "dramaclaw_render_first_frames",
    }


@pytest.mark.asyncio
async def test_describe_returns_one_exact_underlying_schema(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")

    result = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_DESCRIBE_NAME,
        {"tool_name": "dramaclaw_render_first_frames"},
    )
    payload = json.loads(result[0].text)

    assert payload["ok"] is True
    assert payload["tool"]["name"] == "dramaclaw_render_first_frames"
    assert payload["tool"]["input_schema"]["type"] == "object"


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

    invalid = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_CALL_NAME,
        {
            "tool_name": "dramaclaw_render_first_frames",
            "arguments": {},
        },
    )
    invalid_payload = json.loads(invalid[0].text)
    assert invalid_payload["ok"] is False
    assert invalid_payload["error"] == "tool_arguments_invalid"
    assert calls == []

    valid = await dramaclaw_mcp.call_tool(
        dramaclaw_mcp.TOOL_CALL_NAME,
        {
            "tool_name": "dramaclaw_render_first_frames",
            "arguments": {"episode": 1},
        },
    )
    assert json.loads(valid[0].text) == {"ok": True}
    assert calls == [{"episode": 1}]

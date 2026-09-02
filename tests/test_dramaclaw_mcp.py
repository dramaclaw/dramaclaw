from __future__ import annotations

import asyncio

from novelvideo.chat import dramaclaw_mcp


def test_mcp_bridge_exposes_interactive_story_plugin_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_CHAT_SURFACE", "freezone")
    expected = {
        "dramaclaw_create_interactive_story",
        "dramaclaw_get_interactive_story",
        "dramaclaw_patch_interactive_story",
        "dramaclaw_validate_interactive_story",
    }

    assert expected <= dramaclaw_mcp.TOOLS.keys()
    listed = {tool.name: tool for tool in asyncio.run(dramaclaw_mcp.list_tools())}
    assert expected <= listed.keys()
    assert listed["dramaclaw_patch_interactive_story"].inputSchema["required"] == [
        "story_id",
        "base_revision",
        "idempotency_key",
        "operations",
    ]
    assert listed["dramaclaw_validate_interactive_story"].inputSchema["required"] == [
        "story_id"
    ]

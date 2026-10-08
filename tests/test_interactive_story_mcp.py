from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from novelvideo.chat import (
    dramaclaw_mcp,
    hermes_sdk,
    interactive_story_mcp,
    story_tools,
)
from novelvideo.chat import service as chat_service
from novelvideo.chat.runtime_event_evidence import _codex_freezone_tool_name


@pytest.fixture(autouse=True)
def bound_scope(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    # Native plugin tests install their own registry adapters. Keep this MCP
    # contract comparison from caching those adapters in other test modules.
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_CACHE", {})
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_TOOL_CACHE", {})
    monkeypatch.delitem(sys.modules, "tools.registry", raising=False)
    monkeypatch.delitem(sys.modules, "tools", raising=False)
    dramaclaw_mcp._install_hermes_registry_shim()


def test_native_hermes_bundles_match_the_shared_source():
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        [
            sys.executable,
            str(root / "scripts/sync_interactive_story_tools.py"),
            "--check",
        ],
        check=True,
    )


@pytest.mark.asyncio
async def test_independent_story_server_loads_no_hermes_plugins(monkeypatch):
    def unexpected(*args):
        raise AssertionError("independent story MCP loaded a Hermes plugin")

    monkeypatch.setattr(dramaclaw_mcp, "_load_plugin", unexpected)
    monkeypatch.setattr(dramaclaw_mcp, "_agent_tools", unexpected)
    tools = await interactive_story_mcp.list_tools()
    assert {tool.name for tool in tools} == story_tools.STORY_TOOL_NAMES
    assert len(tools) == 9
    monkeypatch.setattr(
        interactive_story_mcp,
        "_request",
        lambda *a, **kw: {
            "ok": True,
            "data": {"nodes": [], "edges": [], "revision": 7},
        },
    )
    result = await interactive_story_mcp.call_tool("dramaclaw_get_freezone_canvas", {})
    assert result.isError is False
    assert result.structuredContent["canvas_id"] == "canvas-a"
    assert result.structuredContent["revision"] == 7


def test_story_server_runs_with_canvas_and_legacy_runtime_imports_blocked(tmp_path):
    root = Path(__file__).resolve().parents[1]
    script = """
import asyncio
import importlib.abc
import sys

BLOCKED = ('novelvideo.chat.dramaclaw_mcp', 'novelvideo.chat.workflow_mcp',
           'novelvideo.freezone', 'tools')

class RejectHostImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if any(fullname == name or fullname.startswith(name + '.') for name in BLOCKED):
            raise AssertionError('unexpected host dependency: ' + fullname)

sys.meta_path.insert(0, RejectHostImports())
from novelvideo.chat import interactive_story_mcp

calls = []
def request(*args, **kwargs):
    calls.append(args)
    return {'ok': True, 'data': {'nodes': [], 'edges': [], 'revision': 7}}
interactive_story_mcp._request = request

async def run():
    assert len(await interactive_story_mcp.list_tools()) == 9
    result = await interactive_story_mcp.call_tool('dramaclaw_get_freezone_canvas', {})
    assert not result.isError
    assert result.structuredContent['revision'] == 7
    assert len(calls) == 1
    invalid = await interactive_story_mcp.call_tool('dramaclaw_patch_interactive_story', {
        'story_id': 'story-a', 'base_revision': 7, 'idempotency_key': 'patch-a',
        'operations': [{'op': 'update_story_metadata', 'changes': {'title': 123}}],
    })
    assert invalid.isError and invalid.structuredContent['retryable']
    assert invalid.structuredContent['details']
    assert len(calls) == 1
    assert not any(any(name == prefix or name.startswith(prefix + '.') for prefix in BLOCKED)
                   for name in sys.modules)

asyncio.run(run())
"""
    subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        env={
            **os.environ,
            "PYTHONPATH": str(root / "src"),
            "DRAMACLAW_PROJECT_ID": "project-a",
            "DRAMACLAW_CANVAS_ID": "canvas-a",
            "PYTHONDONTWRITEBYTECODE": "1",
        },
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize("plugin_name", ["freezone", "dramaclaw"])
def test_excluded_plugins_skip_story_loading_and_keep_mode_specific_caches(
    monkeypatch, plugin_name
):
    import importlib.util

    original = importlib.util.spec_from_file_location
    story_loads = []

    def reject_story(name, location, *args, **kwargs):
        if Path(location).name == "interactive_story.py":
            story_loads.append(location)
            raise AssertionError("excluded MCP tried to load story definitions")
        return original(name, location, *args, **kwargs)

    monkeypatch.setattr(importlib.util, "spec_from_file_location", reject_story)
    monkeypatch.setattr(dramaclaw_mcp, "_EXCLUDE_STORY_TOOLS", True)
    excluded = dramaclaw_mcp._plugin_tools(plugin_name)
    story_only_names = story_tools.STORY_TOOL_NAMES - {"dramaclaw_get_freezone_canvas"}
    assert not set(excluded) & story_only_names
    assert story_loads == []
    expected = (
        "freezone_prepare_workflow_plan_draft"
        if plugin_name == "freezone"
        else "dramaclaw_get"
    )
    assert expected in excluded

    # Only the canvas provider includes stories, even without the split flag.
    monkeypatch.setattr(importlib.util, "spec_from_file_location", original)
    monkeypatch.setattr(dramaclaw_mcp, "_EXCLUDE_STORY_TOOLS", False)
    native = set(dramaclaw_mcp._plugin_tools(plugin_name))
    if plugin_name == "freezone":
        assert story_tools.STORY_TOOL_NAMES <= native
    else:
        assert not story_only_names & native
        assert "dramaclaw_get_freezone_canvas" in native


@pytest.mark.asyncio
async def test_native_and_independent_story_contracts_are_identical():
    native = dramaclaw_mcp._plugin_tools("freezone")
    for tool in await interactive_story_mcp.list_tools():
        assert tool.inputSchema == native[tool.name][0]["parameters"]
        assert tool.outputSchema == native[tool.name][0]["output_schema"]


@pytest.mark.parametrize("name", sorted(story_tools.STORY_TOOL_NAMES))
@pytest.mark.parametrize(
    "scope", ["project_override", "canvas_override", "missing_canvas"]
)
def test_every_story_handler_rejects_scope_before_http(monkeypatch, name, scope):
    calls = []
    monkeypatch.setattr(
        interactive_story_mcp, "_request", lambda *a, **kw: calls.append(a)
    )
    args = {"story_id": "story-a"}
    if scope == "project_override":
        args["project_id"] = "project-b"
    elif scope == "canvas_override":
        args["canvas_id"] = "canvas-b"
    else:
        monkeypatch.delenv("DRAMACLAW_CANVAS_ID")
    handler = interactive_story_mcp._tools()[name][1]
    result = json.loads(handler(args))
    assert result["ok"] is False
    assert "bound" in result["error"]
    assert calls == []


@pytest.mark.asyncio
async def test_story_schema_rejection_preserves_correction_details_without_http(
    monkeypatch,
):
    calls = []
    monkeypatch.setattr(
        interactive_story_mcp, "_request", lambda *a, **kw: calls.append(a)
    )
    result = await interactive_story_mcp.call_tool(
        "dramaclaw_patch_interactive_story",
        {
            "story_id": "story-a",
            "base_revision": 7,
            "idempotency_key": "patch-key-a",
            "operations": [{"op": "update_story_metadata", "changes": {"title": 123}}],
        },
    )
    assert result.isError is True
    assert result.structuredContent["retryable"] is True
    assert result.structuredContent["details"]
    assert "operations.0" in result.structuredContent["path"]
    assert calls == []


@pytest.mark.asyncio
async def test_story_write_retains_revision_idempotency_and_refresh_receipt(
    monkeypatch,
):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs["body"]))
        return {
            "ok": True,
            "data": {
                "project_id": "project-a",
                "canvas_id": "canvas-a",
                "story_id": "story-a",
                "revision": 8,
                "refresh_canvas": True,
                "idempotent": False,
            },
        }

    monkeypatch.setattr(interactive_story_mcp, "_request", request)
    args = {
        "story_id": "story-a",
        "base_revision": 7,
        "idempotency_key": "patch-key-a",
        "operations": [
            {"op": "update_story_metadata", "changes": {"title": "New title"}}
        ],
    }
    result = await interactive_story_mcp.call_tool(
        "dramaclaw_patch_interactive_story", args
    )
    assert result.isError is False
    assert result.structuredContent["revision"] == 8
    assert result.structuredContent["refresh_canvas"] is True
    assert calls == [
        (
            "PATCH",
            "/api/v1/projects/project-a/interactive-stories/story-a",
            {
                **args,
                "canvas_id": "canvas-a",
            },
        )
    ]


def test_story_http_reads_token_lazily_and_refuses_removed_file(monkeypatch, tmp_path):
    token_file = tmp_path / "turn.token"
    token_file.write_text("turn-one")
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://127.0.0.1:8780")
    calls = []

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"ok":true}'

    def send(request, **kwargs):
        calls.append(request.get_header("Authorization"))
        return Response()

    monkeypatch.setattr(interactive_story_mcp, "urlopen", send)
    path = "/api/v1/projects/project-a/interactive-story-progress"
    assert interactive_story_mcp._request("GET", path)["ok"]
    token_file.write_text("turn-two")
    assert interactive_story_mcp._request("GET", path)["ok"]
    token_file.unlink()
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
    with pytest.raises(ValueError, match="token"):
        interactive_story_mcp._request("GET", path)
    assert calls == ["Bearer turn-one", "Bearer turn-two"]


def test_story_http_sanitizes_conflict_and_omits_server_only_fields(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", "test-turn-token")
    monkeypatch.delenv("DRAMACLAW_AGENT_TOKEN_FILE", raising=False)
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://127.0.0.1:8780")

    def send(*args, **kwargs):
        body = json.dumps(
            {
                "detail": {
                    "code": "revision_conflict",
                    "current_revision": 9,
                    "story_id": "story-a",
                    "retryable": True,
                    "server_secret": "hidden",
                }
            }
        )
        raise HTTPError(
            "http://localhost", 409, "Conflict", {}, io.BytesIO(body.encode())
        )

    monkeypatch.setattr(interactive_story_mcp, "urlopen", send)
    result = interactive_story_mcp._request(
        "PATCH", "/api/v1/projects/project-a/interactive-stories/story-a"
    )
    assert result["code"] == "revision_conflict"
    assert result["current_revision"] == 9
    assert result["story_id"] == "story-a"
    assert "hidden" not in json.dumps(result)


@pytest.mark.parametrize(
    "name",
    [
        "dramaclaw_create_interactive_story",
        "dramaclaw_patch_interactive_story",
        "dramaclaw_save_interactive_story_outline",
        "dramaclaw_confirm_interactive_story_stages",
    ],
)
def test_new_server_namespace_preserves_write_policy_and_event_names(name):
    qualified = f"dramaclaw_interactive_story.{name}"
    assert hermes_sdk._is_dramaclaw_write_tool(qualified)
    assert hermes_sdk._is_freezone_canvas_write_tool(qualified)
    assert _codex_freezone_tool_name(SimpleNamespace(name=qualified)) == name


def test_codex_passes_only_turn_scope_to_story_mcp(tmp_path):
    from novelvideo.chat.backend_sdk import CodexClient

    servers = chat_service._dramaclaw_mcp_servers("freezone_canvas")
    env = {
        "DRAMACLAW_API_URL": "http://127.0.0.1:8780",
        "DRAMACLAW_AGENT_TOKEN_FILE": "/tmp/current-turn.token",
        "DRAMACLAW_PROJECT_ID": "project-a",
        "DRAMACLAW_CANVAS_ID": "canvas-a",
        "MODEL_API_KEY": "do-not-forward",
        "DRAMACLAW_USERNAME": "alice",
    }
    client = CodexClient(
        codex_bin=Path("/usr/local/bin/codex"),
        cwd=tmp_path,
        env=env,
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use interactive-story MCP.",
        config_overrides=chat_service._codex_mcp_config_overrides(servers),
    )
    config = client.thread_start()._thread_config
    assert config["mcp_servers.dramaclaw_interactive_story.env"] == {
        key: env[key]
        for key in (
            "DRAMACLAW_API_URL",
            "DRAMACLAW_AGENT_TOKEN_FILE",
            "DRAMACLAW_PROJECT_ID",
            "DRAMACLAW_CANVAS_ID",
        )
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("server", ["dramaclaw", "dramaclaw_interactive_story"])
async def test_real_stdio_servers_own_disjoint_story_tools(tmp_path, server):
    root = Path(__file__).resolve().parents[1]
    config = chat_service._dramaclaw_mcp_servers("freezone_canvas")[server]
    params = StdioServerParameters(
        command=sys.executable,
        args=config["args"],
        cwd=str(tmp_path),
        env={
            **os.environ,
            "PYTHONPATH": str(root / "src"),
            "DRAMACLAW_ROOT": str(root) if server == "dramaclaw" else str(tmp_path),
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            initialized = await session.initialize()
            assert initialized.serverInfo.name == server
            listed = await session.list_tools()
            names = {tool.name for tool in listed.tools}
            if server == "dramaclaw":
                assert not names & story_tools.STORY_TOOL_NAMES
                assert "freezone_prepare_workflow_plan_draft" in names
            else:
                assert names == story_tools.STORY_TOOL_NAMES
                result = await session.call_tool(
                    "dramaclaw_get_interactive_story",
                    {
                        "story_id": "story-a",
                        "canvas_id": "other-canvas",
                    },
                )
                assert result.isError is True
                assert "bound" in result.structuredContent["error"]

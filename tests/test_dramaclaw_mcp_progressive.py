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

    tools = await dramaclaw_mcp.list_tools()

    names = {tool.name for tool in tools}
    assert names == set(dramaclaw_mcp.TOOLS)

    schemas = {tool.name: tool.outputSchema for tool in tools}
    assert all(schema is not None for schema in schemas.values())
    assert len({schema["title"] for schema in schemas.values()}) == len(schemas)
    assert len({tuple(schema["properties"]) for schema in schemas.values()}) >= 70
    for name, schema in schemas.items():
        Draft202012Validator.check_schema(schema)
        assert schema["x-dramaclaw-tool"] == name
        assert schema["required"] == ["ok", "status"]
        assert "data" not in schema["properties"]
        assert schema["additionalProperties"] is False
        assert all(property_schema for property_schema in schema["properties"].values())

    for plugin in dramaclaw_mcp.PLUGINS:
        plugin_tool_names = {name for name, _schema, _handler in plugin.TOOLS}
        assert set(plugin._RESULT_FIELDS) == plugin_tool_names


def test_every_public_tool_rejects_an_arbitrary_success_envelope():
    for name, (tool, _handler) in dramaclaw_mcp.TOOLS.items():
        output_schema = tool["output_schema"]
        errors = list(
            Draft202012Validator(output_schema).iter_errors(
                {"ok": True, "status": "completed", "data": {"anything": "goes"}}
            )
        )
        assert errors, f"{name} accepted a success result without its business fields"


@pytest.mark.asyncio
async def test_real_list_tasks_handler_exposes_and_requires_task_fields(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setattr(
        dramaclaw_mcp.PLUGIN,
        "_request",
        lambda *_args, **_kwargs: {
            "ok": True,
            "data": [{"id": "task-1"}],
        },
    )

    result = await dramaclaw_mcp.call_tool("dramaclaw_list_tasks", {})

    assert result.structuredContent == {
        "ok": True,
        "status": "completed",
        "tasks": [{"id": "task-1"}],
        "count": 1,
    }
    schema = dramaclaw_mcp.TOOLS["dramaclaw_list_tasks"][0]["output_schema"]
    missing_count = dict(result.structuredContent)
    missing_count.pop("count")
    assert list(Draft202012Validator(schema).iter_errors(missing_count))


@pytest.mark.asyncio
async def test_real_core_handlers_match_their_endpoint_output_contracts(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.delenv("DRAMACLAW_TOOL_MODE", raising=False)

    def fake_request(method, path, *, query=None, body=None):
        del query, body
        if path == "/api/v1/freezone/skills":
            return {"ok": True, "data": [{"id": "skill-1"}]}
        if path.endswith("/freezone/skills/skill-1/run"):
            return {"run_id": "run-1", "status": "queued"}
        if path.endswith("/freezone/skills/runs/run-1/result"):
            return {"run_id": "run-1", "status": "done", "outputs": []}
        if path.endswith("/freezone/canvases:from-preset"):
            return {"ok": True, "data": {"canvas_id": "canvas-a", "reused": True}}
        if path.endswith("/freezone/canvases"):
            return {"ok": True, "data": [{"canvas_id": "canvas-a"}]}
        if path.endswith("/freezone/canvases/canvas-a"):
            if method == "GET":
                return {
                    "ok": True,
                    "data": {"nodes": [], "edges": [], "revision": 2},
                }
            if method == "PUT":
                return {
                    "ok": True,
                    "data": {"saved": True, "revision": 3, "client_save_id": "save-1"},
                }
            return {"ok": True, "data": {"deleted": True}}
        if path.endswith("/pipeline/status"):
            return {
                "ok": True,
                "data": {
                    "project": "project-a",
                    "global": {"ingested": True},
                    "current_episode": 1,
                    "episode_status": {},
                    "next_step": "script_writer",
                    "next_step_name": "生成脚本",
                },
            }
        if path.endswith("/tasks/script_writer/1"):
            return {
                "ok": True,
                "data": {"task_id": "task-1", "task_type": "script_writer", "episode": 1},
            }
        if path.endswith("/episodes/1/script"):
            return {"ok": True, "data": {"episode": 1, "beats": []}}
        raise AssertionError(f"unexpected request: {method} {path}")

    monkeypatch.setattr(dramaclaw_mcp.PLUGIN, "_request", fake_request)
    cases = [
        ("dramaclaw_list_freezone_skills", {}, {"skills", "count"}),
        (
            "dramaclaw_run_freezone_skill",
            {"skill_id": "skill-1"},
            {"run_id", "status"},
        ),
        (
            "dramaclaw_get_freezone_skill_result",
            {"run_id": "run-1"},
            {"run_id", "status", "outputs"},
        ),
        ("dramaclaw_list_freezone_canvases", {}, {"canvases", "count"}),
        (
            "dramaclaw_get_freezone_canvas",
            {"canvas_id": "canvas-a"},
            {"canvas_id", "nodes", "edges", "revision"},
        ),
        (
            "dramaclaw_save_freezone_canvas",
            {
                "canvas_id": "canvas-a",
                "payload": {
                    "nodes": [],
                    "edges": [],
                    "viewport": None,
                    "metadata": {},
                    "base_revision": 2,
                    "client_save_id": "save-1",
                },
            },
            {"canvas_id", "saved", "revision", "client_save_id"},
        ),
        (
            "dramaclaw_delete_freezone_canvas",
            {"canvas_id": "canvas-a"},
            {"canvas_id", "deleted"},
        ),
        (
            "dramaclaw_create_freezone_canvas_from_preset",
            {"preset": {"scope": "blank"}},
            {"canvas_id"},
        ),
        ("dramaclaw_pipeline_status", {}, {"project", "global", "next_step"}),
        (
            "dramaclaw_get_task",
            {"task_type": "script_writer", "episode": 1},
            {"task", "task_id", "task_type", "episode", "status"},
        ),
        ("dramaclaw_get_episode_script", {"episode": 1}, {"script"}),
    ]

    for tool_name, arguments, required_fields in cases:
        result = await dramaclaw_mcp.call_tool(tool_name, arguments)
        assert result.isError is False, tool_name
        assert required_fields <= set(result.structuredContent), tool_name


@pytest.mark.asyncio
async def test_real_handler_failure_uses_the_shared_error_contract(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")

    result = await dramaclaw_mcp.call_tool(
        "dramaclaw_get_task", {"episode": 1, "task_type": ""}
    )

    assert result.isError is True
    assert result.structuredContent["ok"] is False
    assert result.structuredContent["error"]
    schema = dramaclaw_mcp.TOOLS["dramaclaw_get_task"][0]["output_schema"]
    Draft202012Validator(schema).validate(result.structuredContent)


@pytest.mark.asyncio
async def test_real_scene_images_handler_matches_its_mcp_output_contract(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setattr(
        dramaclaw_mcp.PLUGIN,
        "_request",
        lambda *_args, **_kwargs: {
            "ok": True,
            "data": [
                {
                    "name": "天台",
                    "scene_type": "exterior",
                    "master_url": "/static/scenes/roof.png",
                }
            ],
        },
    )

    result = await dramaclaw_mcp.call_tool("dramaclaw_get_scene_images", {})

    assert result.isError is False
    assert result.structuredContent["count"] == 1
    assert result.structuredContent["image_count"] == 1
    assert result.structuredContent["scenes"][0]["images"] == [
        {"kind": "master", "url": "/static/scenes/roof.png"}
    ]
    assert "images" not in result.structuredContent
    schema = dramaclaw_mcp.TOOLS["dramaclaw_get_scene_images"][0]["output_schema"]
    Draft202012Validator(schema).validate(result.structuredContent)


@pytest.mark.asyncio
async def test_real_episode_image_handlers_preserve_project_scope_in_mcp_contract(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")

    def fake_request(_method, path, **_kwargs):
        if path.endswith("/sketch-candidates"):
            return {
                "ok": True,
                "data": {
                    "candidate_count": 1,
                    "candidates": [{"url": "/static/candidate.png", "stale": False}],
                },
            }
        return {
            "ok": True,
            "data": [{
                "beat_number": 1,
                "sketch_url": "/static/sketch.png",
                "frame_url": "/static/frame.png",
            }],
        }

    monkeypatch.setattr(dramaclaw_mcp.PLUGIN, "_request", fake_request)
    cases = [
        ("dramaclaw_get_sketches", {"episode": 1}, "sketches"),
        ("dramaclaw_get_first_frames", {"episode": 1}, "frames"),
        ("dramaclaw_get_sketch_candidates", {"episode": 1, "beat": 1}, "candidates"),
    ]
    for tool_name, arguments, collection_field in cases:
        result = await dramaclaw_mcp.call_tool(tool_name, arguments)
        assert result.isError is False
        assert result.structuredContent["project_id"] == "project-a"
        assert result.structuredContent[collection_field]
        schema = dramaclaw_mcp.TOOLS[tool_name][0]["output_schema"]
        Draft202012Validator(schema).validate(result.structuredContent)


@pytest.mark.asyncio
async def test_real_final_video_handler_models_single_and_collection_results(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")

    def fake_request(_method, path, **_kwargs):
        if path.endswith("/episodes/1/final"):
            return {
                "ok": True,
                "data": {"exists": True, "video_url": "/static/episode-1.mp4"},
            }
        if path.endswith("/episodes/2/final"):
            return {"ok": True, "data": {"exists": False, "video_url": None}}
        raise AssertionError(path)

    monkeypatch.setattr(dramaclaw_mcp.PLUGIN, "_request", fake_request)
    found = await dramaclaw_mcp.call_tool("dramaclaw_get_final_video", {"episode": 1})
    assert found.structuredContent["status"] == "final_video_result"
    assert found.structuredContent["project_id"] == "project-a"
    assert found.structuredContent["exists"] is True
    assert found.structuredContent["video_url"] == "/static/episode-1.mp4"
    assert found.structuredContent["ui_spec"] is not None

    missing = await dramaclaw_mcp.call_tool("dramaclaw_get_final_video", {"episode": 2})
    assert missing.structuredContent["status"] == "final_video_result"
    assert missing.structuredContent["exists"] is False
    assert missing.structuredContent["video_url"] is None
    assert missing.structuredContent["ui_spec"] is None

    collection = await dramaclaw_mcp.call_tool(
        "dramaclaw_get_final_video", {"episode_indices": [1, 2]}
    )
    assert collection.structuredContent["status"] == "final_video_collection"
    assert collection.structuredContent["episodes"] == [1]
    assert collection.structuredContent["count"] == 1
    assert collection.structuredContent["ui_spec"] is not None

    empty = await dramaclaw_mcp.call_tool(
        "dramaclaw_get_final_video", {"episode_indices": [2]}
    )
    assert empty.structuredContent["status"] == "final_video_collection"
    assert empty.structuredContent["episodes"] == []
    assert empty.structuredContent["ui_spec"] is None


@pytest.mark.asyncio
async def test_real_clarification_results_preserve_frontend_answers_and_retry_fields(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    freezone_plugin = dramaclaw_mcp.PLUGINS[1]
    monkeypatch.setattr(
        freezone_plugin, "clarification_bridge_key", lambda **_kwargs: "clarify-1"
    )
    monkeypatch.setattr(
        freezone_plugin, "put_pending_clarification_event", lambda **_kwargs: None
    )
    monkeypatch.setattr(
        freezone_plugin,
        "wait_clarification_result",
        lambda *_args, **_kwargs: {
            "ok": True,
            "status": "clarification_frontend_result",
            "tool_call_status": "completed",
            "clarification_status": "answered",
            "bridge_key": "clarify-1",
            "answers": {"scope": {"option_ids": ["workflow"]}},
        },
    )
    question = {
        "clarification_id": "clarify-1",
        "questions": [{
            "id": "scope",
            "title": "主要做什么？",
            "options": [{"id": "workflow", "label": "工作流"}],
        }],
    }
    answered = await dramaclaw_mcp.call_tool(
        "freezone_request_user_clarification", question
    )
    assert answered.structuredContent["answers"]["scope"]["option_ids"] == ["workflow"]

    monkeypatch.setattr(
        freezone_plugin, "wait_clarification_result", lambda *_args, **_kwargs: None
    )
    timed_out = await dramaclaw_mcp.call_tool(
        "freezone_request_user_clarification", question
    )
    assert timed_out.isError is True
    assert timed_out.structuredContent["status"] == "clarification_frontend_timeout"
    assert timed_out.structuredContent["clarification_status"] == "pending_user_input"
    assert timed_out.structuredContent["bridge_key"] == "clarify-1"

    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    rejected = await dramaclaw_mcp.call_tool(
        "freezone_request_user_clarification",
        {"questions": [{
            "id": "generation_settings",
            "title": "生成设置",
            "options": [{"id": "default", "label": "默认"}],
        }]},
    )
    assert rejected.isError is True
    assert rejected.structuredContent["required_question_ids"]["image"]
    assert rejected.structuredContent["required_question_ids"]["video"]


@pytest.mark.asyncio
async def test_real_skill_studio_results_match_mcp_contract(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    freezone_plugin = dramaclaw_mcp.PLUGINS[1]
    freezone_plugin._PENDING_SKILL_STUDIO_DRAFTS.clear()
    bridge_counter = iter(range(20))
    monkeypatch.setattr(
        freezone_plugin,
        "skill_studio_bridge_key",
        lambda **_kwargs: f"skill-studio-{next(bridge_counter)}",
    )
    monkeypatch.setattr(
        freezone_plugin, "put_pending_skill_studio_event", lambda **_kwargs: None
    )
    def frontend_result(key, **_kwargs):
        return {
            "ok": True,
            "status": "skill_studio_frontend_result",
            "tool_call_status": "completed",
            "skill_studio_status": "answered",
            "bridge_key": key,
            "action": "submit",
            "selections": {"scope": "planning"},
        }
    monkeypatch.setattr(freezone_plugin, "wait_skill_studio_result", frontend_result)
    base = {"skill_studio_session_id": "studio-1"}
    progress_calls = [
        (
            "freezone_put_agent_catalog_draft_outline",
            {**base, "reuse_goal": "视频工作流", "catalog_checked": True},
        ),
        ("freezone_begin_agent_catalog_draft", {**base, "mode": "create"}),
        ("freezone_put_agent_catalog_skill", {**base, "skill": {"id": "video-skill"}}),
        (
            "freezone_put_agent_catalog_recipe",
            {**base, "index": 0, "recipe": {"id": "video-recipe"}},
        ),
        (
            "freezone_patch_agent_catalog_draft",
            {
                **base,
                "target": "skill",
                "patch": [{"op": "add", "path": "/description", "value": "更新"}],
            },
        ),
    ]
    for tool_name, arguments in progress_calls:
        _schema, handler = dramaclaw_mcp.TOOLS[tool_name]
        result = dramaclaw_mcp._structured_tool_result(tool_name, handler(arguments))
        assert result.structuredContent["status"] == "skill_studio_progress_event_emitted", (
            tool_name,
            result.structuredContent,
        )
        assert result.structuredContent["skill_studio_status"] == "draft_progress"
        assert result.structuredContent["bridge_key"]

    presented_handler = dramaclaw_mcp.TOOLS["freezone_present_agent_catalog_draft"][1]
    presented = dramaclaw_mcp._structured_tool_result(
        "freezone_present_agent_catalog_draft",
        presented_handler({**base, "skill": {"id": "video-skill"}, "recipes": []}),
    )
    assert presented.structuredContent["status"] == "skill_studio_frontend_result"
    assert presented.structuredContent["selections"] == {"scope": "planning"}

    monkeypatch.setattr(
        freezone_plugin, "wait_skill_studio_result", lambda *_args, **_kwargs: None
    )
    timed_out = dramaclaw_mcp._structured_tool_result(
        "freezone_present_agent_catalog_draft",
        presented_handler({**base, "skill": {"id": "video-skill"}, "recipes": []}),
    )
    assert timed_out.isError is True
    assert timed_out.structuredContent["status"] == "skill_studio_frontend_timeout"
    assert timed_out.structuredContent["skill_studio_status"] == "pending_user_input"

    monkeypatch.setattr(freezone_plugin, "wait_skill_studio_result", frontend_result)
    finished_handler = dramaclaw_mcp.TOOLS["freezone_finish_agent_catalog_draft"][1]
    finished = dramaclaw_mcp._structured_tool_result(
        "freezone_finish_agent_catalog_draft", finished_handler(base)
    )
    assert finished.structuredContent["status"] == "skill_studio_frontend_result"
    assert finished.structuredContent["action"] == "submit"


@pytest.mark.asyncio
async def test_real_delete_nodes_empty_canvas_noop_matches_mcp_contract(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    freezone_plugin = dramaclaw_mcp.PLUGINS[1]
    monkeypatch.setattr(
        freezone_plugin,
        "_request",
        lambda *_args, **_kwargs: {"ok": True, "data": {"nodes": [], "edges": []}},
    )

    result = await dramaclaw_mcp.call_tool(
        "freezone_delete_nodes", {"scope": "canvas"}
    )

    assert result.isError is False
    assert result.structuredContent["canvas_apply_status"] == "already_empty"
    assert result.structuredContent["deleted_node_count"] == 0
    assert result.structuredContent["applied"] is True
    schema = dramaclaw_mcp.TOOLS["freezone_delete_nodes"][0]["output_schema"]
    Draft202012Validator(schema).validate(result.structuredContent)


@pytest.mark.asyncio
async def test_home_scope_lists_only_concrete_project_collection_tools(monkeypatch):
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID", raising=False)

    tools = await dramaclaw_mcp.list_tools()

    assert {tool.name for tool in tools} == dramaclaw_mcp.HOME_TOOL_NAMES


@pytest.mark.asyncio
async def test_freezone_lists_concrete_hermes_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")

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
async def test_concrete_tool_completes_real_mcp_output_contract_round_trip():
    env = {
        **os.environ,
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


def test_home_scope_only_exposes_project_collection_tools(monkeypatch):
    monkeypatch.delenv("DRAMACLAW_PROJECT_ID", raising=False)

    assert set(dramaclaw_mcp._available_tools()) == dramaclaw_mcp.HOME_TOOL_NAMES


def test_project_scope_exposes_production_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.delenv("DRAMACLAW_TOOL_MODE", raising=False)

    available = dramaclaw_mcp._available_tools()

    assert set(available) == set(dramaclaw_mcp.TOOLS)


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
@pytest.mark.parametrize(
    "wrapper_name",
    ["dramaclaw_tool_search", "dramaclaw_tool_describe", "dramaclaw_tool_call"],
)
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
        (
            schema,
            lambda arguments: calls.append(arguments)
            or json.dumps(
                {
                    "ok": True,
                    "episode": 1,
                    "batch_id": "batch-1",
                    "requested": [1],
                    "started": [1],
                }
            ),
        ),
    )

    invalid = await dramaclaw_mcp.call_tool("dramaclaw_render_first_frames", {})
    invalid_payload = json.loads(invalid.content[0].text)
    assert invalid_payload["ok"] is False
    assert invalid_payload["error"] == "tool_arguments_invalid"
    assert calls == []

    valid = await dramaclaw_mcp.call_tool(
        "dramaclaw_render_first_frames", {"episode": 1}
    )
    assert json.loads(valid.content[0].text)["ok"] is True
    assert calls == [{"episode": 1}]


@pytest.mark.asyncio
async def test_native_tool_call_does_not_block_mcp_event_loop(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    schema, _handler = dramaclaw_mcp.TOOLS["dramaclaw_render_first_frames"]

    def blocking_handler(_arguments):
        time.sleep(0.2)
        return json.dumps(
            {
                "ok": True,
                "episode": 1,
                "batch_id": "batch-1",
                "requested": [1],
                "started": [1],
            }
        )

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
    assert json.loads(result.content[0].text)["ok"] is True

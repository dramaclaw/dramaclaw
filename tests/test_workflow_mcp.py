from __future__ import annotations

import json

import pytest

from novelvideo.chat import workflow_mcp
from novelvideo.freezone.agent_workflows import registry
from novelvideo.freezone.agent_workflows import catalog
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands


@pytest.mark.asyncio
async def test_standalone_workflow_mcp_exposes_portable_tools_and_resources():
    tools = await workflow_mcp.list_tools()
    templates = await workflow_mcp.list_resource_templates()

    assert {tool.name for tool in tools} == {
        "workflow_catalog_search",
        "workflow_skill_get",
        "workflow_recipe_get",
        "workflow_intent_compile",
        "workflow_graph_compile",
    }
    assert {template.uriTemplate for template in templates} == {
        "dramaclaw-workflow://skills/{skill_id}",
        "dramaclaw-workflow://recipes/{recipe_id}",
    }

    schemas = {tool.name: tool.inputSchema for tool in tools}
    plan_schema = schemas["workflow_graph_compile"]["properties"]["plan"]
    intent_schema = schemas["workflow_intent_compile"]["properties"]["intent"]
    assert plan_schema["properties"]["schema_version"]["enum"] == [
        "freezone_workflow_plan.v1"
    ]
    assert plan_schema["properties"]["nodes"]["items"]["anyOf"]
    assert "groups" in plan_schema["properties"]
    assert intent_schema["properties"]["schema_version"]["enum"] == [
        "freezone_workflow_intent.v1"
    ]


@pytest.mark.asyncio
async def test_recipe_resource_reads_one_exact_definition(monkeypatch):
    monkeypatch.setattr(
        workflow_mcp,
        "get_catalog_item",
        lambda **_kwargs: {"id": "recipe-a", "name": "Recipe A"},
    )

    payload = json.loads(
        await workflow_mcp.read_resource("dramaclaw-workflow://recipes/recipe-a")
    )

    assert payload == {
        "ok": True,
        "recipe": {"id": "recipe-a", "name": "Recipe A"},
    }


def test_catalog_search_is_compact_and_progressive(monkeypatch):
    monkeypatch.setattr(
        registry,
        "list_user_agent_config_items",
        lambda _username, _kind: [
            {
                "id": "video-recipe",
                "name": "Video Recipe",
                "description": "Create a video",
                "enabled": True,
                "output_kind": "video",
                "action_keys": ["video.generate"],
                "system_prompt": "large prompt must remain progressively loaded",
            }
        ],
    )

    results = registry.search_catalog(
        username="agent-a", kind="recipes", query="video", limit=10
    )

    assert results == [
        {
            "id": "video-recipe",
            "name": "Video Recipe",
            "version": None,
            "description": "Create a video",
            "output_kind": "video",
            "requires_source_media": False,
            "action_keys": ["video.generate"],
        }
    ]
    assert "system_prompt" not in results[0]


def test_shared_catalog_uses_standard_username_environment(monkeypatch):
    monkeypatch.delenv("ST_EDITION", raising=False)
    monkeypatch.setenv("DRAMACLAW_USERNAME", "agent-a")
    monkeypatch.delenv("DRAMACLAW_USER", raising=False)

    assert catalog._catalog_username() == "agent-a"


def test_graph_compiler_emits_one_grouped_canvas_batch():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.text-image-video",
                "title": "文生视频测试工作流",
                "nodes": [
                    {
                        "id": "prompt",
                        "node_type": "textAnnotationNode",
                        "data": {
                            "title": "测试提示词",
                            "text": "夜晚的未来城市",
                        },
                    },
                    {
                        "id": "frame",
                        "node_type": "imageGenNode",
                        "title": "测试首帧",
                        "prompt": "霓虹灯下的未来城市首帧",
                    },
                    {"id": "video", "node_type": "videoNode", "title": "测试视频"},
                ],
                "edges": [
                    {"source": "prompt", "target": "frame", "link_type": "prompt_for"},
                    {"source": "frame", "target": "video", "link_type": "media_input_for"},
                ],
                "group": {
                    "label": "文生视频测试工作流",
                    "node_ids": ["prompt", "frame", "video"],
                },
            }
        }
    )

    assert result["ok"] is True
    command_types = [command["type"] for command in result["commands"]]
    assert command_types == [
        "create_node",
        "create_node",
        "create_node",
        "create_edge",
        "create_edge",
        "group_nodes",
        "layout_nodes",
        "select_nodes",
    ]
    assert result["commands"][0]["data"]["title"] == "测试提示词"
    assert result["commands"][1]["data"]["prompt"] == "霓虹灯下的未来城市首帧"
    assert result["commands"][0]["data"]["content"] == "夜晚的未来城市"
    assert result["commands"][5]["label"] == "文生视频测试工作流"


def test_graph_compiler_prefers_canonical_run_after_create_flag():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "prompt",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "content": "只创建，不执行",
                    }
                ],
                "edges": [],
            },
            "run_after_create": False,
            "runAfterCreate": True,
        }
    )

    assert result["ok"] is True
    assert result["run_after_create"] is False
    assert "run_workflow" not in [command["type"] for command in result["commands"]]


def test_graph_compiler_replaces_empty_nested_prompt_with_portable_prompt():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "frame",
                        "node_type": "imageGenNode",
                        "prompt": "未来城市首帧",
                        "data": {"prompt": ""},
                    }
                ],
                "edges": [],
            }
        }
    )

    assert result["ok"] is True
    assert result["commands"][0]["data"]["prompt"] == "未来城市首帧"

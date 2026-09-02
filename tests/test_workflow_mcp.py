from __future__ import annotations

import json

import pytest
from jsonschema import Draft202012Validator, ValidationError

from novelvideo.chat import workflow_mcp
from novelvideo.freezone.agent_workflows import registry
from novelvideo.freezone.agent_workflows import catalog
from novelvideo.freezone.agent_workflows.graph import (
    build_workflow_graph_commands,
    validate_workflow_graph_commands,
)


def _result_payload(result):
    content = result.content if hasattr(result, "content") else result
    return json.loads(content[0].text)


@pytest.mark.asyncio
async def test_standalone_workflow_mcp_exposes_portable_tools_and_resources():
    tools = await workflow_mcp.list_tools()
    templates = await workflow_mcp.list_resource_templates()

    assert {tool.name for tool in tools} == {
        "workflow_catalog_search",
        "workflow_skill_get",
        "workflow_recipe_get",
        "workflow_skill_reference_get",
        "workflow_intent_compile",
        "workflow_graph_compile",
    }
    assert {template.uriTemplate for template in templates} == {
        "dramaclaw-workflow://skills/{skill_id}",
        "dramaclaw-workflow://recipes/{recipe_id}",
        "dramaclaw-workflow://skills/{skill_id}/references/{reference}",
    }

    schemas = {tool.name: tool.inputSchema for tool in tools}
    assert schemas["workflow_skill_get"]["properties"]["compact"]["type"] == "boolean"
    plan_schema = schemas["workflow_graph_compile"]["properties"]["plan"]
    intent_schema = schemas["workflow_intent_compile"]["properties"]["intent"]
    assert plan_schema["properties"]["schema_version"]["enum"] == [
        "freezone_workflow_plan.v1"
    ]
    assert plan_schema["properties"]["nodes"]["items"]["anyOf"]
    recipe_node_schema = plan_schema["properties"]["nodes"]["items"]["anyOf"][0]
    assert recipe_node_schema["properties"]["node_type"]["enum"] == [
        "textAnnotationNode",
        "scriptNode",
        "beatContextNode",
        "imageGenNode",
        "videoNode",
        "audioNode",
    ]
    assert recipe_node_schema["required"] == ["id", "node_type", "data"]
    assert recipe_node_schema["additionalProperties"] is False
    assert plan_schema["properties"]["edges"]["items"]["required"] == [
        "source",
        "target",
        "link_type",
    ]
    assert plan_schema["additionalProperties"] is False
    assert "groups" in plan_schema["properties"]
    assert plan_schema["properties"]["expected_node_count"]["maximum"] == 200
    assert (
        "videoNode" in plan_schema["properties"]["expected_node_counts"]["properties"]
    )
    catalog_schema = plan_schema["properties"]["nodes"]["items"]["anyOf"][0][
        "properties"
    ]["data"]["properties"]["workflowCatalog"]
    assert catalog_schema["properties"]["confirmedInputs"]["type"] == "object"
    assert catalog_schema["properties"]["inputStrategy"]["type"] == "object"
    assert catalog_schema["properties"]["promptBuilder"]["type"] == "object"
    assert catalog_schema["properties"]["promptStrategy"]["enum"] == [
        "template",
        "user_message",
        "previous_output",
        "llm_refine",
    ]
    assert intent_schema["properties"]["schema_version"]["enum"] == [
        "freezone_workflow_intent.v1"
    ]


@pytest.mark.asyncio
async def test_graph_compile_accepts_canonical_plan_fields():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "video-tutorial", "version": 1},
            "nodes": [
                {
                    "id": "input",
                    "node_type": "textAnnotationNode",
                    "data": {
                        "stage": "input",
                        "text": "用户提供的固定文案",
                    },
                },
                {
                    "id": "image",
                    "node_type": "imageGenNode",
                    "data": {
                        "prompt": "未来城市雨夜",
                        "workflowCatalog": {"recipeId": "general-image"},
                    },
                }
            ],
            "edges": [
                {"source": "input", "target": "image", "link_type": "prompt_for"}
            ],
        }
    }
    graph_tool = next(
        tool
        for tool in await workflow_mcp.list_tools()
        if tool.name == "workflow_graph_compile"
    )
    Draft202012Validator(graph_tool.inputSchema).validate(arguments)

    result = await workflow_mcp.call_tool("workflow_graph_compile", arguments)

    payload = _result_payload(result)
    assert payload["ok"] is True, payload
    assert payload["commands"][0]["node_type"] == "textAnnotationNode"
    assert payload["commands"][1]["node_type"] == "imageGenNode"
    assert payload["commands"][2]["link_type"] == "prompt_for"


@pytest.mark.asyncio
async def test_graph_compile_rejects_nested_execution_policy():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "video-tutorial", "version": 1},
            "run_after_create": True,
            "nodes": [
                {"id": "input", "node_type": "textAnnotationNode", "data": {"stage": "input", "text": "文案"}},
                {"id": "image", "node_type": "imageGenNode", "data": {"prompt": "雨夜城市", "workflowCatalog": {"recipeId": "general-image"}}},
            ],
            "edges": [{"source": "input", "target": "image", "link_type": "prompt_for"}],
        }
    }
    graph_tool = next(
        tool
        for tool in await workflow_mcp.list_tools()
        if tool.name == "workflow_graph_compile"
    )
    with pytest.raises(ValidationError):
        Draft202012Validator(graph_tool.inputSchema).validate(arguments)


@pytest.mark.asyncio
async def test_graph_compile_explains_how_to_connect_independent_branches():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "short-drama-quick", "version": 1},
            "nodes": [
                {
                    "id": "beat-01-input",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                    "data": {"text": "第一段"},
                },
                {
                    "id": "beat-01-image",
                    "node_type": "imageGenNode",
                    "data": {"workflowCatalog": {"recipeId": "general-image"}},
                },
                {
                    "id": "beat-02-input",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                    "data": {"text": "第二段"},
                },
                {
                    "id": "beat-02-image",
                    "node_type": "imageGenNode",
                    "data": {"workflowCatalog": {"recipeId": "general-image"}},
                },
            ],
            "edges": [
                {
                    "source": "beat-01-input",
                    "target": "beat-01-image",
                    "link_type": "prompt_for",
                },
                {
                    "source": "beat-02-input",
                    "target": "beat-02-image",
                    "link_type": "prompt_for",
                },
            ],
        }
    }

    result = await workflow_mcp.call_tool("workflow_graph_compile", arguments)

    payload = _result_payload(result)
    assert payload["ok"] is False
    assert "公共输入根节点" in payload["agent_instruction"]
    assert "不要要求用户补充内部连线" in payload["agent_instruction"]
    assert "不要为了" in payload["agent_instruction"]


@pytest.mark.asyncio
async def test_graph_compile_rejects_edge_guessing_and_directs_catalog_lookup():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "short-drama-quick", "version": 1},
            "nodes": [
                {
                    "id": "input-root",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                    "data": {"text": "公共输入"},
                },
                {
                    "id": "beat-image",
                    "node_type": "imageGenNode",
                    "data": {"workflowCatalog": {"recipeId": "general-image"}},
                },
            ],
            "edges": [
                {
                    "source": "input-root",
                    "target": "beat-image",
                    "link_type": "context_for",
                }
            ],
        }
    }

    result = await workflow_mcp.call_tool("workflow_graph_compile", arguments)

    payload = _result_payload(result)
    assert payload["ok"] is False
    assert "freezone_get_link_type_catalog" in payload["agent_instruction"]
    assert "禁止继续猜测" in payload["agent_instruction"]
    assert "立即用同一份计划提交工作流创建" in payload["agent_instruction"]


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


@pytest.mark.asyncio
async def test_skill_reference_is_resolved_without_exposing_a_filesystem_path():
    result = await workflow_mcp.call_tool(
        "workflow_skill_reference_get",
        {"skill_id": "short-drama-quick", "reference": "custom-topology.md"},
    )
    payload = _result_payload(result)
    assert payload["ok"] is True
    assert "filesystem" not in payload["content"]
    assert payload["reference"] == "custom-topology.md"

    resource = await workflow_mcp.read_resource(
        "dramaclaw-workflow://skills/short-drama-quick/references/custom-topology.md"
    )
    assert json.loads(resource)["status"] == "workflow_reference_ready"


@pytest.mark.asyncio
async def test_skill_reference_rejects_path_traversal():
    result = await workflow_mcp.call_tool(
        "workflow_skill_reference_get",
        {"skill_id": "short-drama-quick", "reference": "../../secret"},
    )
    payload = _result_payload(result)
    assert payload["ok"] is False
    assert payload["status"] == "workflow_reference_not_found"


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
                    {
                        "source": "frame",
                        "target": "video",
                        "link_type": "media_input_for",
                    },
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


def test_graph_compiler_derives_text_title_from_nested_display_name():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "input-root",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "data": {
                            "displayName": "公共输入",
                            "text": "九个 Beat 的共享创作要求",
                        },
                    }
                ],
                "edges": [],
            }
        }
    )

    assert result["ok"] is True
    command = result["commands"][0]
    assert command["data"]["title"] == "公共输入"
    assert command["data"]["content"] == "九个 Beat 的共享创作要求"


def test_graph_compiler_completes_structural_text_node_canvas_fields():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "input-root",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "data": {"displayName": "公共输入"},
                    }
                ],
                "edges": [],
            }
        }
    )

    assert result["ok"] is True
    command = result["commands"][0]
    assert command["data"]["title"] == "公共输入"
    assert command["data"]["content"] == "公共输入"
    assert validate_workflow_graph_commands(result["commands"]) == []


def test_compiled_command_validator_reports_canvas_contract_paths():
    errors = validate_workflow_graph_commands(
        [
            {
                "type": "create_node",
                "client_id": "input-root",
                "node_type": "textAnnotationNode",
                "position": {"x": 80, "y": 80},
                "data": {"displayName": "公共输入", "content": ""},
            },
            {
                "type": "create_edge",
                "source": "input-root",
                "target": "missing-node",
                "link_type": "prompt_for",
            },
        ]
    )

    assert {error["path"] for error in errors} == {
        "commands[0].data.title",
        "commands[0].data.content",
        "commands[1].target",
    }


def test_graph_compiler_ignores_removed_run_after_create_alias():
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


def test_graph_compiler_marks_portable_input_nodes_as_non_executable():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "request",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "data": {"content": "用户提供的剧本事实"},
                    }
                ],
                "edges": [],
            }
        }
    )

    assert result["ok"] is True
    assert result["commands"][0]["data"]["workflowCatalogRole"] == "user_input"

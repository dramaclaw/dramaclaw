from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.shared.exceptions import McpError

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
@pytest.mark.parametrize("uri", [
    "file:///tmp/workspace/.agents/skills/dramaclaw-workflows/SKILL.md",
    "dramaclaw-workflow://unknown/x",
])
async def test_unsupported_resource_uri_names_valid_uris_and_is_not_retryable(uri):
    with pytest.raises(ValueError) as exc:
        await workflow_mcp.read_resource(uri)
    assert str(exc.value) == (
        "unsupported workflow resource URI; not retryable on this server. This server reads only "
        "dramaclaw-workflow://skills/{skill_id}, dramaclaw-workflow://recipes/{recipe_id} and "
        "dramaclaw-workflow://skills/{skill_id}/references/{reference}. Read file:// Agent Skill "
        "files with the server and uri from the Skill locator (dramaclaw in the DramaClaw Codex "
        "runtime)."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("username", ["alice", "bob"])
async def test_workflow_resources_real_stdio_protocol_and_private_isolation(
    tmp_path, username
):
    root = Path(__file__).resolve().parents[1]
    output = tmp_path / "output"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    builtin = root / "src/novelvideo/freezone/agent_catalog/builtins"
    for user in ("alice", "bob"):
        for kind, source in (
            ("skills", "text-to-image-video"),
            ("recipes", "general-image"),
        ):
            folder = output / user / "_account/freezone/agent_config" / kind
            folder.mkdir(parents=True)
            item = json.loads((builtin / kind / f"{source}.json").read_text())
            item.update(id=f"private-{user}", name=f"{user} private")
            (folder / f"private-{user}.json").write_text(json.dumps(item))
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "novelvideo.chat.workflow_mcp"],
        cwd=str(workspace),
        env={
            **_workflow_env(),
            "PYTHONPATH": str(root / "src"),
            "ST_EDITION": "ce",
            "DRAMACLAW_USERNAME": username,
            "NOVELVIDEO_OUTPUT_DIR": str(output),
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )
    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            initialized = await session.initialize()
            assert initialized.capabilities.resources is not None
            assert initialized.capabilities.resources.subscribe is False
            assert initialized.capabilities.resources.listChanged is False
            listed = await session.list_resources()
            assert listed.resources == []
            assert listed.nextCursor is None
            templates = await session.list_resource_templates()
            assert len(templates.resourceTemplates) == 3
            assert len((await session.list_tools()).tools) == 6
            for kind in ("skills", "recipes"):
                search = await session.call_tool(
                    "workflow_catalog_search", {"kind": kind, "query": "private"}
                )
                items = _result_payload(search)["items"]
                assert {item["id"] for item in items} == {f"private-{username}"}
                result = await session.read_resource(
                    f"dramaclaw-workflow://{kind}/private-{username}"
                )
                payload = json.loads(result.contents[0].text)
                item = payload["skill" if kind == "skills" else "recipe"]
                assert item["name"] == f"{username} private"
                peer = "bob" if username == "alice" else "alice"
                with pytest.raises(McpError):
                    await session.read_resource(
                        f"dramaclaw-workflow://{kind}/private-{peer}"
                    )
            reference = await session.read_resource(
                "dramaclaw-workflow://skills/short-drama-quick/references/custom-topology.md"
            )
            assert (
                json.loads(reference.contents[0].text)["status"]
                == "workflow_reference_ready"
            )
            with pytest.raises(McpError) as exc:
                await session.read_resource(
                    "file:///tmp/workspace/.agents/skills/dramaclaw-workflows/SKILL.md"
                )
            assert exc.value.error.message == (
                "unsupported workflow resource URI; not retryable on this server. "
                "This server reads only dramaclaw-workflow://skills/{skill_id}, "
                "dramaclaw-workflow://recipes/{recipe_id} and "
                "dramaclaw-workflow://skills/{skill_id}/references/{reference}. "
                "Read file:// Agent Skill files with the server and uri from the Skill locator "
                "(dramaclaw in the DramaClaw Codex runtime)."
            )


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
    output_schemas = {tool.name: tool.outputSchema for tool in tools}
    assert (
        len({json.dumps(schema, sort_keys=True) for schema in output_schemas.values()})
        == 6
    )
    assert all(
        branch["additionalProperties"] is False
        for schema in output_schemas.values()
        for branch in schema["oneOf"]
    )
    assert "compact" not in schemas["workflow_skill_get"]["properties"]
    plan_schema = schemas["workflow_graph_compile"]["properties"]["plan"]
    intent_schema = schemas["workflow_intent_compile"]["properties"]["intent"]
    assert plan_schema["properties"]["schema_version"]["enum"] == [
        "freezone_workflow_plan.v1"
    ]
    assert plan_schema["properties"]["nodes"]["items"]["anyOf"]
    edge_description = plan_schema["properties"]["edges"]["description"]
    assert "dependency_for only controls execution order" in edge_description
    assert "does not consume the source output" in edge_description
    assert "prompt_for" in edge_description
    assert "context_for" in edge_description
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
    assert next(
        template.description for template in templates
        if template.uriTemplate == "dramaclaw-workflow://skills/{skill_id}"
    ) == (
        "One Workflow catalog Skill selected by workflow_catalog_search; "
        "not the dramaclaw-workflows Agent Skill file"
    )


def canonical_plan():
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": "video-tutorial", "version": 1},
        "nodes": [
            {
                "id": "input",
                "node_type": "textAnnotationNode",
                "stage": "input",
                "data": {"text": "用户提供的固定文案"},
            },
            {
                "id": "image",
                "node_type": "imageGenNode",
                "data": {
                    "prompt": "未来城市雨夜",
                    "workflowCatalog": {"recipeId": "general-image"},
                },
            },
        ],
        "edges": [{"source": "input", "target": "image", "link_type": "prompt_for"}],
    }


@pytest.mark.asyncio
async def test_graph_compile_accepts_canonical_plan_fields():
    arguments = {"plan": canonical_plan()}
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
async def test_graph_compile_normalizes_agent_resource_aliases():
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
                        "title": "用户需求",
                        "prompt": "用户提供的固定文案",
                        "workflowCatalog": {},
                    },
                },
                {
                    "id": "image",
                    "node_type": "imageGenNode",
                    "data": {
                        "prompt": "未来城市雨夜",
                        "workflowCatalog": {"recipeId": "general-image"},
                    },
                },
            ],
            "edges": [
                {"source": "input", "target": "image", "link_type": "prompt_for"}
            ],
            "groups": [
                {"id": "episode-1", "label": "第一集", "node_ids": ["input", "image"]}
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
    assert payload["commands"][0]["data"]["content"] == "用户提供的固定文案"
    assert payload["commands"][0]["data"]["workflowCatalogRole"] == "user_input"
    assert "stage" not in payload["commands"][0]["data"]
    assert any(command["type"] == "group_nodes" for command in payload["commands"])


@pytest.mark.asyncio
async def test_every_workflow_tool_validates_its_real_call_result(monkeypatch):
    monkeypatch.setattr(workflow_mcp, "search_catalog", lambda **_kwargs: [])
    monkeypatch.setattr(
        workflow_mcp,
        "get_workflow_skill",
        lambda _args: {
            "ok": True,
            "status": "workflow_skill_ready",
            "schema_version": "freezone_workflow_skill_package.v1",
            "skill_id": "skill-a",
            "skill": {},
            "available_recipes": [],
        },
    )
    monkeypatch.setattr(
        workflow_mcp, "get_catalog_item", lambda **_kwargs: {"id": "recipe-a"}
    )
    monkeypatch.setattr(
        workflow_mcp,
        "_read_skill_reference",
        lambda *_args: {
            "ok": True,
            "status": "workflow_reference_ready",
            "skill_id": "skill-a",
            "reference": "integration.md",
            "content": "contract",
        },
    )
    monkeypatch.setattr(
        workflow_mcp,
        "compile_workflow_intent",
        lambda _intent: {
            "ok": True,
            "status": "workflow_plan_ready",
            "skill_id": "skill-a",
            "plan": {},
        },
    )
    monkeypatch.setattr(
        workflow_mcp,
        "validate_agent_workflow_plan",
        lambda _plan: {"ok": True, "status": "workflow_plan_valid"},
    )
    monkeypatch.setattr(
        workflow_mcp,
        "build_workflow_graph_commands",
        lambda _args: {
            "ok": True,
            "status": "workflow_graph_commands_created",
            "schema_version": "canvas_chat_commands.v1",
            "workflow_instance_id": "workflow-a",
            "commands": [],
        },
    )
    calls = {
        "workflow_catalog_search": {"kind": "skills"},
        "workflow_skill_get": {"skill_id": "skill-a"},
        "workflow_recipe_get": {"recipe_id": "recipe-a"},
        "workflow_skill_reference_get": {
            "skill_id": "skill-a",
            "reference": "integration.md",
        },
        "workflow_intent_compile": {"intent": {}},
        "workflow_graph_compile": {"plan": {}},
    }
    tools = {tool.name: tool for tool in await workflow_mcp.list_tools()}

    for name, arguments in calls.items():
        result = await workflow_mcp.call_tool(name, arguments)
        Draft202012Validator(tools[name].outputSchema).validate(
            result.structuredContent
        )


@pytest.mark.asyncio
async def test_graph_compile_rejects_nested_execution_policy():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "video-tutorial", "version": 1},
            "run_after_create": True,
            "nodes": [
                {
                    "id": "input",
                    "node_type": "textAnnotationNode",
                    "data": {"stage": "input", "text": "文案"},
                },
                {
                    "id": "image",
                    "node_type": "imageGenNode",
                    "data": {
                        "prompt": "雨夜城市",
                        "workflowCatalog": {"recipeId": "general-image"},
                    },
                },
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
    assert "dependency_for only controls execution order" in payload["content"]
    assert "must not use dependency_for" in payload["content"]
    assert "context_for" in payload["content"]
    assert "prompt_for" in payload["content"]
    assert "media_input_for" in payload["content"]
    assert 'skill: {"id":"<selected skill_id>"' in payload["content"]
    assert "generation_answers" in payload["content"]
    assert "reserved for recipe-less" in payload["content"]
    assert "accepts_external_media" in payload["content"]
    assert "replacement anchor" in payload["content"]
    assert "preserve explicit media/result node counts" in payload["content"]

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
    assert payload["status"] == "tool_arguments_invalid"


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
            "node_type": "videoNode",
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


def test_hosted_catalog_uses_bound_root_and_user_from_project_workspace(tmp_path):
    """Both MCPs must see API-owned private catalogs, not cwd/output or peers."""
    import os
    import subprocess
    import sys
    from pathlib import Path
    from novelvideo.chat import service, backend_sdk

    root = Path(__file__).resolve().parents[1]
    output = tmp_path / "api-output"
    workspace = tmp_path / "project-agent-workspace"
    workspace.mkdir()
    base = json.loads((root / "src/novelvideo/freezone/agent_catalog/builtins/skills/text-to-image-video.json").read_text())
    for user in ("alice", "bob"):
        folder = output / user / "_account/freezone/agent_config/skills"
        folder.mkdir(parents=True)
        (folder / "private-test.json").write_text(json.dumps({**base, "id": "private-test", "name": user + " private"}))
    overrides = service._codex_mcp_config_overrides(service._dramaclaw_mcp_servers("freezone_canvas"))
    script = """
import json
from novelvideo.freezone.agent_workflows.catalog import get_workflow_skill
result = get_workflow_skill({'skill_id':'private-test', 'username':'bob'})
assert result['ok'], result
print(json.dumps(result, ensure_ascii=False))
"""
    for user in ("alice", "bob"):
        config = backend_sdk._codex_thread_config(overrides, {"DRAMACLAW_USERNAME": user, "NOVELVIDEO_OUTPUT_DIR": str(output)})
        for server in ("dramaclaw", "dramaclaw_workflows"):
            bound = config[f"mcp_servers.{server}.env"]
            env = {**os.environ, **bound, "PYTHONPATH": str(root / "src"), "ST_EDITION": "ce"}
            result = subprocess.run([sys.executable, "-c", script], cwd=workspace, env=env, capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, result.stderr
            package = json.loads(result.stdout)
            assert package['skill']['name'] == user + ' private'


@pytest.mark.asyncio
async def test_builtin_workflow_skill_get_preserves_planning_instructions():
    result = await workflow_mcp.call_tool(
        "workflow_skill_get",
        {"skill_id": "lego-minifigure-animation-video", "user_goal": "做个短片"},
    )
    payload = _result_payload(result)
    assert payload["ok"] is True
    assert result.isError is False
    assert payload["planning_contract"]["node_prompt_role"] == "task_brief"
    assert "Runtime Recipe compilation" in payload["agent_instruction"]
    assert result.structuredContent == payload


@pytest.mark.asyncio
async def test_workflow_intent_schema_explains_compose_field_location():
    tools = {tool.name: tool for tool in await workflow_mcp.list_tools()}
    schema = tools["workflow_intent_compile"].inputSchema["properties"]["intent"]
    assert "intent.include_compose" in schema["properties"]["planner"]["description"]
    intent = {
        "skill_id": "lego-minifigure-animation-video",
        "user_goal": "做个短片",
        "planner": {"mode": "standard"},
        "include_compose": True,
    }
    Draft202012Validator(schema).validate(intent)
    intent["planner"]["include_compose"] = intent.pop("include_compose")
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(intent)


@pytest.mark.asyncio
async def test_graph_compile_states_nothing_created_or_run_and_names_next_tool():
    result = await workflow_mcp.call_tool(
        "workflow_graph_compile", {"plan": canonical_plan(), "run_after_create": True},
    )
    payload = _result_payload(result)
    assert payload["ok"] is True
    assert payload["status"] == "workflow_graph_commands_created"
    assert payload["run_after_create"] is True
    assert {"schema_version", "workflow_instance_id", "commands", "skipped_edges", "warnings"} <= (
        payload.keys()
    )
    assert payload["canvas_changed"] is False
    assert payload["draft_created"] is False
    assert payload["run_started"] is False
    assert payload["next_tool"] == "freezone_prepare_workflow"
    assert isinstance(payload["next_action"], str)
    assert "freezone_prepare_workflow" in payload["next_action"]
    assert isinstance(payload["agent_instruction"], str)
    for phrase in (
        "freezone_prepare_workflow", "operation_id", "run_after_create",
        "freezone_confirm_workflow_draft", "未创建", "未运行",
    ):
        assert phrase in payload["agent_instruction"]
    assert result.structuredContent == payload
    tool = next(
        tool for tool in await workflow_mcp.list_tools() if tool.name == "workflow_graph_compile"
    )
    Draft202012Validator(tool.outputSchema).validate(result.structuredContent)
    success = next(
        branch for branch in tool.outputSchema["oneOf"]
        if branch["properties"]["ok"] == {"const": True}
    )
    assert {
        "canvas_changed", "draft_created", "run_started", "next_tool", "next_action",
        "agent_instruction",
    } <= set(success["required"])
    assert "freezone_prepare_workflow" in tool.description
    assert "creates no canvas nodes or drafts and runs nothing" in tool.description


@pytest.mark.asyncio
async def test_failed_graph_compile_omits_success_next_step_fields():
    plan = canonical_plan()
    plan["edges"][0]["target"] = "unknown-node"
    result = await workflow_mcp.call_tool(
        "workflow_graph_compile", {"plan": plan, "run_after_create": True},
    )
    payload = _result_payload(result)
    assert payload["ok"] is False
    assert {"next_tool", "canvas_changed", "draft_created", "run_started"}.isdisjoint(payload)


@pytest.fixture(scope="module")
def workflow_contract_check():
    import runpy

    return runpy.run_path(
        str(
            Path(__file__).resolve().parents[1]
            / "scripts/check_workflow_agent_contracts.py"
        )
    )


async def test_workflow_contract_check_accepts_advertised_guidance(
    workflow_contract_check,
):
    from types import SimpleNamespace

    report = await workflow_contract_check["_run"](SimpleNamespace(username="local"))
    assert report.errors == []


@pytest.mark.parametrize(
    "path,replacement",
    [
        (("properties", "value", "minimum"), -1),
        (("required",), []),
        (("additionalProperties",), True),
        (("properties", "description", "type"), "number"),
        (("properties", "literal", "const", "description"), "changed"),
        (("properties", "literal", "enum", 0, "description"), "changed"),
        (("properties", "literal", "default", "description"), "changed"),
        (("properties", "value"), None),
    ],
)
def test_workflow_schema_contract_preserves_constraints_and_literal_descriptions(
    workflow_contract_check, path, replacement
):
    from copy import deepcopy

    schema = {
        "type": "object",
        "description": "Tool documentation",
        "required": ["value"],
        "additionalProperties": False,
        "properties": {
            "value": {"type": "number", "minimum": 0},
            "description": {"type": "string", "description": "A real input field"},
            "literal": {
                "const": {"description": "must"},
                "enum": [{"description": "must"}],
                "default": {"description": "must"},
            },
        },
    }
    altered = deepcopy(schema)
    parent = altered
    for key in path[:-1]:
        parent = parent[key]
    if replacement is None:
        del parent[path[-1]]
    else:
        parent[path[-1]] = replacement
    contract = workflow_contract_check["_schema_without_descriptions"]
    assert contract(schema) != contract(altered)
    assert contract(schema)["properties"]["description"] == {"type": "string"}
    assert schema["properties"]["description"]["description"] == "A real input field"


def test_workflow_schema_contract_ignores_nested_annotations_only(
    workflow_contract_check,
):
    contract = workflow_contract_check["_schema_without_descriptions"]
    schema = {
        "allOf": [
            {
                "if": {"description": "condition", "required": ["value"]},
                "then": {
                    "description": "consequence",
                    "properties": {
                        "description": {"type": "string", "description": "field docs"}
                    },
                },
            }
        ]
    }
    expected = {
        "allOf": [
            {
                "if": {"required": ["value"]},
                "then": {"properties": {"description": {"type": "string"}}},
            }
        ]
    }
    assert contract(schema) == expected


@pytest.fixture
def workflow_catalog_api(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    from types import SimpleNamespace
    import time

    builtin = Path(__file__).resolve().parents[1] / "src/novelvideo/freezone/agent_catalog/builtins"
    catalogs = {user: {} for user in ("alice", "bob", "relay-user")}
    output = tmp_path / "output"
    for kind, source in (("skills", "text-to-image-video"), ("recipes", "general-image")):
        builtins = [json.loads(path.read_text()) for path in sorted((builtin / kind).glob("*.json"))]
        for user in catalogs:
            item = json.loads((builtin / kind / f"{source}.json").read_text())
            item.update(id=f"private-{user}", name=f"{user} private")
            catalogs[user][kind] = [*builtins, item]
            if user == "relay-user":
                folder = output / user / "_account/freezone/agent_config" / kind
                folder.mkdir(parents=True)
                (folder / f"private-{user}.json").write_text(json.dumps(item))
    api = SimpleNamespace(requests=[], fail=False, output=output)

    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, payload):
            encoded = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            user = next((user for user in ("alice", "bob")
                         if self.headers.get("Authorization") == f"Bearer test-key-{user}"), None)
            api.requests.append(("POST", self.path, user))
            if self.path != "/api/v1/agent/sessions":
                self.respond(404, {"ok": False})
            elif user is None:
                self.respond(401, {"ok": False})
            else:
                self.respond(200, {"ok": True, "data": {
                    "token": f"session-{user}", "expires_at": time.time() + 3600,
                }})

        def do_GET(self):
            user = next((user for user in ("alice", "bob")
                         if self.headers.get("Authorization") == f"Bearer session-{user}"), None)
            api.requests.append(("GET", self.path, user))
            kind = self.path.rsplit("/", 1)[-1]
            if user is None:
                self.respond(401, {"ok": False})
            elif self.path != f"/api/v1/freezone/agent-config/{kind}" or kind not in ("skills", "recipes"):
                self.respond(404, {"ok": False})
            elif api.fail:
                self.respond(500, {"ok": False})
            else:
                self.respond(200, {"ok": True, "data": catalogs[user][kind]})

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    api.url = f"http://127.0.0.1:{server.server_port}"
    try:
        yield api
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def _workflow_env():
    env = os.environ.copy()
    for name in (
        "DRAMACLAW_AGENT_KEY", "DRAMACLAW_AGENT_KEY_FILE", "DRAMACLAW_AGENT_TOKEN",
        "DRAMACLAW_AGENT_TOKEN_FILE", "DRAMACLAW_PROJECT_ID", "DRAMACLAW_USERNAME",
        "DRAMACLAW_USER",
    ):
        env.pop(name, None)
    return env


@pytest.fixture
def workflow_session(workflow_catalog_api, tmp_path):
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def connect(**overrides):
        env = _workflow_env() | {
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            "ST_EDITION": "ce", "PYTHONDONTWRITEBYTECODE": "1",
            "DRAMACLAW_USERNAME": "relay-user",
            "DRAMACLAW_API_URL": workflow_catalog_api.url,
            "NOVELVIDEO_OUTPUT_DIR": str(workflow_catalog_api.output),
        }
        for name, value in overrides.items():
            if value is None:
                env.pop(name, None)
            else:
                env[name] = value
        parameters = StdioServerParameters(
            command=sys.executable, args=["-m", "novelvideo.chat.workflow_mcp"],
            cwd=str(tmp_path), env=env,
        )
        async with stdio_client(parameters) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                yield session

    return connect


def _catalog_tool_payload(result):
    for content in result.content:
        if hasattr(content, "text"):
            assert not any(secret in content.text for secret in (
                "test-key-alice", "test-key-bob", "test-key-unknown",
                "session-alice", "session-bob", "test-turn-token",
            )), "Credential leaked in tool result"
    return _result_payload(result)


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", ["alice", "bob"])
async def test_workflow_agent_key_owns_catalog(workflow_session, workflow_catalog_api, owner):
    peer = "bob" if owner == "alice" else "alice"
    async with workflow_session(DRAMACLAW_AGENT_KEY=f"test-key-{owner}") as session:
        for kind in ("skills", "recipes"):
            result = _catalog_tool_payload(await session.call_tool(
                "workflow_catalog_search", {"kind": kind, "query": "private"},
            ))
            assert result["ok"] is True
            assert {item["id"] for item in result["items"]} == {f"private-{owner}"}
        for other in (peer, "relay-user"):
            result = _catalog_tool_payload(await session.call_tool(
                "workflow_recipe_get", {"recipe_id": f"private-{other}"},
            ))
            assert result["ok"] is False
        resource = await session.read_resource(f"dramaclaw-workflow://recipes/private-{owner}")
        assert json.loads(resource.contents[0].text)["recipe"]["id"] == f"private-{owner}"
        with pytest.raises(McpError):
            await session.read_resource(f"dramaclaw-workflow://recipes/private-{peer}")
        for user, expected in ((owner, True), (peer, False)):
            result = _catalog_tool_payload(await session.call_tool(
                "workflow_skill_get", {"skill_id": f"private-{user}"},
            ))
            assert result["ok"] is expected
    for kind in ("skills", "recipes"):
        assert ("GET", f"/api/v1/freezone/agent-config/{kind}", owner) in workflow_catalog_api.requests
    assert ("POST", "/api/v1/agent/sessions", owner) in workflow_catalog_api.requests


@pytest.mark.asyncio
@pytest.mark.parametrize("username", [None, "local", "relay-user", "bob"])
@pytest.mark.parametrize("key_source", ["env", "file"])
async def test_workflow_agent_key_ignores_username(workflow_session, tmp_path, username, key_source):
    credentials = {"DRAMACLAW_AGENT_KEY": "test-key-alice"}
    if key_source == "file":
        key_file = tmp_path / "agent-key"
        key_file.write_text("test-key-alice")
        credentials = {"DRAMACLAW_AGENT_KEY_FILE": str(key_file)}
    async with workflow_session(DRAMACLAW_USERNAME=username, **credentials) as session:
        for kind in ("skills", "recipes"):
            result = _catalog_tool_payload(await session.call_tool(
                "workflow_catalog_search", {"kind": kind, "query": "private"},
            ))
            assert result["ok"] is True
            assert {item["id"] for item in result["items"]} == {"private-alice"}


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["catalog-500", "exchange-401"])
async def test_workflow_agent_key_catalog_fails_closed(workflow_session, workflow_catalog_api, failure):
    workflow_catalog_api.fail = failure == "catalog-500"
    key = "test-key-alice" if failure == "catalog-500" else "test-key-unknown"
    async with workflow_session(DRAMACLAW_AGENT_KEY=key) as session:
        for kind in ("skills", "recipes"):
            response = await session.call_tool("workflow_catalog_search", {"kind": kind, "query": "private"})
            result = _catalog_tool_payload(response)
            assert result["ok"] is False
            assert "private-relay-user" not in "".join(c.text for c in response.content if hasattr(c, "text"))
        with pytest.raises(McpError):
            await session.read_resource("dramaclaw-workflow://recipes/private-relay-user")
    assert ("POST", "/api/v1/agent/sessions", "alice" if failure == "catalog-500" else None) in workflow_catalog_api.requests
    if failure == "catalog-500":
        assert any(method == "GET" for method, _, _ in workflow_catalog_api.requests)


@pytest.mark.asyncio
@pytest.mark.parametrize("key", [None, "test-key-alice"])
async def test_workflow_model_cannot_choose_catalog_user(workflow_session, key):
    async with workflow_session(DRAMACLAW_AGENT_KEY=key) as session:
        for tool, arguments in (
            ("workflow_catalog_search", {"kind": "recipes", "query": "private", "username": "bob"}),
            ("workflow_skill_get", {"skill_id": "private-bob", "username": "bob"}),
        ):
            result = _catalog_tool_payload(await session.call_tool(tool, arguments))
            assert result["ok"] is False
            assert result["status"] == "tool_arguments_invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["no-key", "token", "token-and-key", "token-file-and-key"])
async def test_workflow_local_catalog_without_agent_key_mode(workflow_session, workflow_catalog_api, tmp_path, mode):
    env = {}
    if mode != "no-key":
        env["DRAMACLAW_AGENT_TOKEN"] = "test-turn-token"
    if mode in ("token-and-key", "token-file-and-key"):
        env["DRAMACLAW_AGENT_KEY"] = "test-key-alice"
    if mode == "token-file-and-key":
        token_file = tmp_path / "turn-token"
        token_file.write_text("test-turn-token")
        env.pop("DRAMACLAW_AGENT_TOKEN")
        env["DRAMACLAW_AGENT_TOKEN_FILE"] = str(token_file)
    async with workflow_session(**env) as session:
        for kind in ("skills", "recipes"):
            result = _catalog_tool_payload(await session.call_tool(
                "workflow_catalog_search", {"kind": kind, "query": "private"},
            ))
            assert result["ok"] is True
            assert {item["id"] for item in result["items"]} == {"private-relay-user"}
    assert workflow_catalog_api.requests == []

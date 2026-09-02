from __future__ import annotations

import copy
import importlib.util
import json
import sys
import threading
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _restore_tools_registry_modules():
    """Keep dynamic Hermes plugin imports from leaking across test modules/workers."""

    sentinel = object()
    previous = {
        name: sys.modules.get(name, sentinel) for name in ("tools", "tools.registry")
    }
    yield
    for name, value in previous.items():
        if value is sentinel:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = value


_MINIMAL_ECOMMERCE_SKILL = {
    "id": "ecommerce-product",
    "name": "电商产品图",
    "version": 6,
    "description": "测试用电商产品图 Skill",
    "enabled": True,
    "triggers": {"node_scopes": ["imageGeneration"]},
    "allowed_recipe_ids": ["ecommerce-ad-image", "general-image"],
}

_MINIMAL_ECOMMERCE_RECIPES = [
    {
        "id": "ecommerce-ad-image",
        "name": "电商广告图",
        "version": 5,
        "enabled": True,
        "output_kind": "image",
        "requires_source_media": True,
    },
    {
        "id": "general-image",
        "name": "通用图片",
        "version": 1,
        "enabled": True,
        "output_kind": "image",
        "requires_source_media": False,
    },
]


def _load_plugin_module():
    tools_module = types.ModuleType("tools")
    registry_module = types.ModuleType("tools.registry")
    registry_module.tool_error = lambda value: value
    registry_module.tool_result = lambda value: value
    sys.modules["tools"] = tools_module
    sys.modules["tools.registry"] = registry_module

    path = (
        Path(__file__).resolve().parents[1]
        / ".hermes"
        / "plugins"
        / "freezone"
        / "__init__.py"
    )
    spec = importlib.util.spec_from_file_location("test_freezone_plugin", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _load_plugin_module_with_registry_result(registry_result):
    tools_module = types.ModuleType("tools")
    registry_module = types.ModuleType("tools.registry")
    registry_module.tool_error = lambda value: json.dumps(
        {"ok": False, "error": str(value)}, ensure_ascii=False
    )
    registry_module.tool_result = registry_result
    sys.modules["tools"] = tools_module
    sys.modules["tools.registry"] = registry_module

    path = (
        Path(__file__).resolve().parents[1]
        / ".hermes"
        / "plugins"
        / "freezone"
        / "__init__.py"
    )
    spec = importlib.util.spec_from_file_location(
        "test_freezone_plugin_structured", path
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _load_catalog_module():
    path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "novelvideo"
        / "freezone"
        / "agent_workflows"
        / "catalog.py"
    )
    spec = importlib.util.spec_from_file_location(
        "test_freezone_json_workflow_catalog", path
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _install_minimal_builtin_catalog(monkeypatch, catalog) -> None:
    def fake_load_json_dir(path):
        if path == catalog._SKILLS_DIR:
            return copy.deepcopy([_MINIMAL_ECOMMERCE_SKILL])
        if path == catalog._RECIPES_DIR:
            return copy.deepcopy(_MINIMAL_ECOMMERCE_RECIPES)
        return []

    monkeypatch.setattr(catalog, "_load_json_dir", fake_load_json_dir)
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)


def _install_workflow_draft_api(monkeypatch, plugin, project_dir: Path) -> None:
    from novelvideo.freezone.workflow_drafts import (
        claim_workflow_draft_confirmation,
        create_workflow_draft,
        finish_workflow_draft_confirmation,
        patch_workflow_draft,
        read_workflow_draft,
    )

    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")

    def fake_request(method, path, *, body=None, **_kwargs):
        if path.endswith("/freezone/agent-capability-quote"):
            return {
                "ok": True,
                "data": {
                    "feature_key": "freezone.agent.creative_planning",
                    "billing_required": False,
                    "metering_enabled": True,
                    "configured": True,
                    "exact": True,
                    "required_credits": 12,
                    "display": "12 积分",
                    "allowed": True,
                },
            }
        if "/workflow-drafts" not in path:
            raise AssertionError(path)
        parts = path.strip("/").split("/")
        project_id = parts[1]
        canvas_id = parts[4]
        draft_id = parts[6] if len(parts) > 6 else ""
        suffix = parts[7] if len(parts) > 7 else ""
        if method == "POST" and not draft_id:
            draft = create_workflow_draft(
                project_dir=project_dir,
                project_id=project_id,
                canvas_id=canvas_id,
                intent=body["intent"],
                compiled=body["compiled"],
                run_after_create=bool(body.get("run_after_create")),
            )
            return {"ok": True, "data": draft}
        if method == "GET" and draft_id:
            draft, error = read_workflow_draft(
                project_dir=project_dir,
                canvas_id=canvas_id,
                draft_id=draft_id,
            )
            return (
                {"ok": True, "data": draft}
                if draft is not None
                else {
                    "ok": False,
                    "status": "workflow_draft_unavailable",
                    "error": error,
                }
            )
        if method == "PATCH" and draft_id:
            draft, error = patch_workflow_draft(
                project_dir=project_dir,
                canvas_id=canvas_id,
                draft_id=draft_id,
                expected_revision=int(body["expected_revision"]),
                intent=body["intent"],
                compiled=body["compiled"],
                last_changes=body.get("last_changes"),
                run_after_create=body.get("run_after_create"),
            )
            return {"ok": True, "data": draft} if draft is not None else error
        if method == "POST" and suffix == "claim":
            draft, error = claim_workflow_draft_confirmation(
                project_dir=project_dir,
                canvas_id=canvas_id,
                draft_id=draft_id,
                revision=int(body["revision"]),
            )
            return {"ok": True, "data": draft} if draft is not None else error
        if method == "POST" and suffix == "finish":
            draft = finish_workflow_draft_confirmation(
                project_dir=project_dir,
                canvas_id=canvas_id,
                draft_id=draft_id,
                outcome=body["outcome"],
            )
            return {"ok": True, "data": draft}
        raise AssertionError((method, path, body))

    monkeypatch.setattr(plugin, "_request", fake_request)


def test_freezone_plugin_registers_canvas_command_tools():
    from novelvideo.freezone.workflow_plan import (
        ALLOWED_LINK_TYPES,
        ALLOWED_NODE_TYPES,
        MAX_WORKFLOW_EDGES,
        MAX_WORKFLOW_NODES,
    )

    plugin = _load_plugin_module()

    names = {name for name, _schema, _handler in plugin.TOOLS}
    schemas = {name: schema for name, schema, _handler in plugin.TOOLS}

    assert "freezone_request_user_clarification" in names
    assert "freezone_emit_canvas_command" in names
    assert "freezone_create_node" in names
    assert "freezone_update_node_data" in names
    assert "freezone_run_node_action" in names
    assert "freezone_run_workflow" in names
    assert "freezone_get_mainline_projection_assets" in names
    assert "freezone_list_workflows" not in names
    assert "freezone_build_workflow_plan" not in names
    assert "freezone_resolve_catalog_workflow" not in names
    assert "freezone_get_workflow_skill" in names
    assert not any(name.startswith("freezone_skill_") for name in names)
    assert "freezone_prepare_workflow_draft" in names
    assert "freezone_prepare_workflow_plan_draft" in names
    assert "freezone_patch_workflow_draft" in names
    assert "freezone_confirm_workflow_draft" in names
    assert "freezone_create_workflow_from_intent" not in names
    assert "freezone_create_workflow_graph" not in names
    assert "freezone_present_agent_catalog_draft" in names
    assert "freezone_put_agent_catalog_draft_outline" in names
    assert "freezone_begin_agent_catalog_draft" in names
    assert "freezone_put_agent_catalog_skill" in names
    for tool_name in (
        "freezone_prepare_workflow_draft",
        "freezone_prepare_workflow_plan_draft",
        "freezone_patch_workflow_draft",
        "freezone_confirm_workflow_draft",
    ):
        properties = schemas[tool_name]["parameters"]["properties"]
        assert "quote_id" in properties
        assert "confirmation_receipt" in properties
        assert "planning_confirmed" not in properties
    assert "freezone_put_agent_catalog_recipe" in names
    assert "freezone_patch_agent_catalog_draft" in names
    assert "freezone_finish_agent_catalog_draft" in names
    assert "freezone_list_agent_catalog" in names
    assert "freezone_get_saved_skill" in names
    assert "freezone_get_saved_recipe" in names
    create_schema = schemas["freezone_prepare_workflow_plan_draft"]["parameters"]
    assert create_schema["required"] == ["plan"]
    assert "workflow_type" not in create_schema["properties"]
    assert "items" not in create_schema["properties"]
    plan_schema = create_schema["properties"]["plan"]
    assert plan_schema["type"] == "object"
    assert plan_schema["required"] == ["schema_version", "skill", "nodes", "edges"]
    assert plan_schema["properties"]["schema_version"]["enum"] == [
        "freezone_workflow_plan.v1"
    ]
    assert plan_schema["properties"]["nodes"]["maxItems"] == MAX_WORKFLOW_NODES
    node_variants = plan_schema["properties"]["nodes"]["items"]["anyOf"]
    assert (
        set(
            node_type
            for variant in node_variants
            for node_type in variant["properties"]["node_type"]["enum"]
        )
        == ALLOWED_NODE_TYPES
    )
    recipe_variant = node_variants[0]
    workflow_catalog = recipe_variant["properties"]["data"]["properties"][
        "workflowCatalog"
    ]
    assert recipe_variant["required"] == ["id", "node_type", "data"]
    assert recipe_variant["additionalProperties"] is False
    assert workflow_catalog["required"] == ["recipeId"]
    assert set(workflow_catalog["properties"]) >= {
        "skillId",
        "skillVersion",
        "recipeId",
        "recipeVersion",
        "recipePipeline",
    }
    assert recipe_variant["properties"]["prompt"] == {"type": "string"}
    edge_schema = plan_schema["properties"]["edges"]["items"]
    assert edge_schema["required"] == ["source", "target", "link_type"]
    assert edge_schema["additionalProperties"] is False
    assert plan_schema["properties"]["edges"]["maxItems"] == MAX_WORKFLOW_EDGES
    assert (
        set(
            plan_schema["properties"]["edges"]["items"]["properties"]["link_type"][
                "enum"
            ]
        )
        == ALLOWED_LINK_TYPES
    )
    assert plan_schema["properties"] != {}
    draft_schema = schemas["freezone_confirm_workflow_draft"]["parameters"]
    assert draft_schema["required"] == ["draft_id", "revision"]
    prepare_draft_schema = schemas["freezone_prepare_workflow_draft"]["parameters"]
    assert prepare_draft_schema["required"] == []
    patch_draft_schema = schemas["freezone_patch_workflow_draft"]["parameters"]
    assert patch_draft_schema["required"] == [
        "draft_id",
        "expected_revision",
        "changes",
    ]


def test_workflow_graph_schema_rejects_missing_skill_and_executable_recipe():
    from jsonschema import Draft202012Validator

    plugin = _load_plugin_module()
    schema = next(
        schema
        for name, schema, _handler in plugin.TOOLS
        if name == "freezone_prepare_workflow_plan_draft"
    )["parameters"]["properties"]["plan"]
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    valid_plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": "ecommerce-product", "version": "1"},
        "nodes": [
            {
                "id": "image-1",
                "node_type": "imageGenNode",
                "data": {
                    "workflowCatalog": {
                        "skillId": "ecommerce-product",
                        "skillVersion": "1",
                        "recipeId": "ecommerce-ad-image",
                        "recipeVersion": "1",
                        "recipePipeline": [{"id": "image-review", "version": "1"}],
                    }
                },
            }
        ],
        "edges": [],
    }

    assert validator.is_valid(valid_plan)
    assert not validator.is_valid(
        {key: value for key, value in valid_plan.items() if key != "skill"}
    )
    missing_recipe = copy.deepcopy(valid_plan)
    missing_recipe["nodes"][0]["data"]["workflowCatalog"].pop("recipeId")
    assert not validator.is_valid(missing_recipe)

    disconnected_plan = copy.deepcopy(valid_plan)
    second_node = copy.deepcopy(disconnected_plan["nodes"][0])
    second_node["id"] = "image-2"
    disconnected_plan["nodes"].append(second_node)
    assert not validator.is_valid(disconnected_plan)
    disconnected_plan["edges"] = [
        {
            "source": "image-1",
            "target": "image-2",
            "link_type": "dependency_for",
        }
    ]
    assert validator.is_valid(disconnected_plan)

    resource_plan = copy.deepcopy(valid_plan)
    resource_plan["nodes"] = [
        {
            "id": "brief",
            "node_type": "textAnnotationNode",
            "stage": "input",
            "data": {"content": "The user-provided brief."},
        }
    ]
    assert validator.is_valid(resource_plan)


def test_validation_payload_uses_only_the_declared_commands_contract():
    plugin = _load_plugin_module()
    commands = [{"type": "create_node", "client_id": "node-a"}]

    payload = plugin._validation_payload(
        {"body": {"commands": [{"type": "ignored"}]}, "commands": commands}
    )

    assert payload == {
        "schema_version": "canvas_chat_commands.v1",
        "commands": commands,
    }


def test_validation_payload_rejects_removed_wrapper_only_contracts():
    plugin = _load_plugin_module()
    assert (
        plugin._validation_payload({"body": {"commands": [{"type": "create_node"}]}})
        == {}
    )
    assert (
        plugin._validation_payload(
            {"envelope": {"commands": [{"type": "create_node"}]}}
        )
        == {}
    )


def test_validate_canvas_commands_rejects_empty_required_data():
    plugin = _load_plugin_module()
    result = plugin._handle_validate_commands(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "commands": [
                {
                    "type": "create_node",
                    "node_type": "textAnnotationNode",
                    "client_id": "node-a",
                    "data": {},
                }
            ],
        }
    )

    assert result["ok"] is False
    assert result["status"] == "invalid_command_schema"
    assert "data" in result["error"]


def test_workflow_compiler_output_satisfies_plugin_write_shape_contract():
    plugin = _load_plugin_module()
    built = plugin.build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "input-root",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "data": {"displayName": "公共输入"},
                    },
                    {
                        "id": "beat-image",
                        "node_type": "imageGenNode",
                        "data": {"prompt": "生成首帧"},
                    },
                ],
                "edges": [
                    {
                        "source": "input-root",
                        "target": "beat-image",
                        "link_type": "prompt_for",
                    }
                ],
            }
        }
    )

    assert built["ok"] is True
    assert (
        plugin._validate_write_commands_shape(
            "project-a", "canvas-a", built["commands"]
        )
        is None
    )


def test_freezone_run_workflow_emits_one_deterministic_runner_command(monkeypatch):
    plugin = _load_plugin_module()
    captured = {}

    def fake_single_write(args, command):
        captured["args"] = args
        captured["command"] = command
        return "queued"

    monkeypatch.setattr(plugin, "_single_write_command", fake_single_write)

    result = plugin._handle_run_workflow(
        {
            "node_ids": ["shot-2"],
            "direction": "downstream",
            "regenerate": True,
        }
    )

    assert result == "queued"
    assert captured["command"] == {
        "type": "run_workflow",
        "node_ids": ["shot-2"],
        "direction": "downstream",
        "regenerate": True,
    }


def test_freezone_agent_rules_bound_content_policy_remediation() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    skill = (repo_root / ".hermes/skills/freezone/SKILL.md").read_text(encoding="utf-8")
    plugin = (repo_root / ".hermes/plugins/freezone/__init__.py").read_text(
        encoding="utf-8"
    )

    assert "内容安全失败不是提示词诊断" in skill
    assert "禁止靠猜词反复改写提示词" in skill
    assert "内容安全失败不可自动重试" in skill
    assert "修改后再次失败就暂停" in skill
    assert "If it reports content_policy, stop" in plugin


def test_freezone_run_workflow_command_passes_write_shape_validation():
    plugin = _load_plugin_module()

    error = plugin._validate_write_commands_shape(
        "project-a",
        "canvas-a",
        [{"type": "run_workflow", "scope": "canvas", "direction": "connected"}],
    )

    assert error is None


@pytest.mark.parametrize(
    "command",
    [
        {"type": "run_workflow"},
        {"type": "run_workflow", "scope": "selection"},
        {"type": "run_workflow", "node_ids": []},
    ],
)
def test_freezone_run_workflow_command_requires_explicit_targets(command):
    plugin = _load_plugin_module()

    error = plugin._validate_write_commands_shape(
        "project-a",
        "canvas-a",
        [command],
    )

    assert error["ok"] is False
    assert error["status"] == "invalid_command_schema"
    assert "node_ids" in error["error"]
    assert "scope=canvas" in error["error"]


def test_external_generation_preflight_blocks_missing_downstream_parameters(
    monkeypatch,
):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda *_args, **_kwargs: {
            "ok": True,
            "data": {
                "nodes": [
                    {"id": "brief", "type": "textAnnotationNode", "data": {}},
                    {
                        "id": "image",
                        "type": "imageGenNode",
                        "data": {"displayName": "首帧", "aspectRatio": "16:9"},
                    },
                ],
                "edges": [{"source": "brief", "target": "image"}],
            },
        },
    )

    result = plugin._external_generation_parameter_preflight(
        "project-a",
        "canvas-a",
        [
            {
                "type": "run_workflow",
                "node_ids": ["brief"],
                "direction": "downstream",
            }
        ],
    )

    assert result is not None
    assert result["status"] == "clarification_required"
    assert result["code"] == "generation_parameters_required"
    assert result["media_types"] == ["image"]
    assert result["missing_parameters"] == [
        {
            "node_id": "image",
            "node_type": "imageGenNode",
            "display_name": "首帧",
            "fields": ["model", "size", "quality", "count"],
        }
    ]
    assert result["clarification"]["allow_skip"] is False


def test_external_generation_preflight_accepts_confirmed_image_and_video_parameters(
    monkeypatch,
):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda *_args, **_kwargs: {"ok": True, "data": {"nodes": [], "edges": []}},
    )
    commands = [
        {
            "type": "create_node",
            "client_id": "image",
            "node_type": "imageGenNode",
            "data": {
                "model": "image-model",
                "aspectRatio": "16:9",
                "size": "2K",
                "quality": "medium",
                "count": 1,
            },
        },
        {
            "type": "create_node",
            "client_id": "video",
            "node_type": "videoNode",
            "data": {
                "model": "video-model",
                "aspectRatio": "16:9",
                "quality": "720P",
                "durationSec": 5,
                "generateAudio": False,
                "count": 1,
            },
        },
        {
            "type": "run_workflow",
            "node_ids": ["image", "video"],
            "scope": "selection",
        },
    ]

    assert (
        plugin._external_generation_parameter_preflight(
            "project-a", "canvas-a", commands
        )
        is None
    )


def test_hermes_generation_path_does_not_enable_external_parameter_preflight(
    monkeypatch,
):
    plugin = _load_plugin_module()
    monkeypatch.delenv("DRAMACLAW_EXTERNAL_MCP", raising=False)
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda *_args, **_kwargs: pytest.fail("Hermes preflight must not read canvas"),
    )

    assert (
        plugin._external_generation_parameter_preflight(
            "project-a",
            "canvas-a",
            [{"type": "run_workflow", "scope": "canvas"}],
        )
        is None
    )


def test_dynamic_workflow_plan_is_rejected_before_canvas_bridge():
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    result = handlers["freezone_prepare_workflow_plan_draft"](
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.ecommerce-product",
                "skill": {"id": "ecommerce-product"},
                "nodes": [{"id": "bad", "node_type": "inventedNode"}],
                "edges": [],
            }
        }
    )

    assert result["ok"] is False
    assert result["status"] == "invalid_dynamic_workflow_plan"
    assert result["errors"][0]["path"] == "nodes[0].node_type"


def test_fixed_workflow_creation_is_rejected_before_canvas_bridge():
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    result = handlers["freezone_prepare_workflow_plan_draft"](
        {
            "workflow_type": "catalog.ecommerce_product.ecommerce_scene_images",
            "count": 3,
        }
    )

    assert result["ok"] is False
    assert result["status"] == "dynamic_workflow_plan_required"


def test_handwritten_workflow_batch_cannot_bypass_dynamic_plan():
    plugin = _load_plugin_module()

    result = plugin._handle_emit_canvas_command(
        {
            "commands": [
                {
                    "type": "create_node",
                    "node_type": "textAnnotationNode",
                    "data": {"displayName": "广告视频工作流"},
                },
                {"type": "create_node", "node_type": "imageGenNode"},
                {"type": "create_node", "node_type": "videoNode"},
            ]
        }
    )

    assert result["ok"] is False
    assert result["status"] == "wrong_tool_dynamic_workflow"


def test_external_canvas_write_uses_frontend_default_for_recommended_model(
    monkeypatch,
):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    commands = [
        {
            "type": "create_node",
            "node_type": "imageGenNode",
            "data": {
                "model": "recommended",
                "aspectRatio": "9:16",
                "size": "high",
                "quality": "high",
                "count": 1,
            },
        }
    ]
    captured = {}

    monkeypatch.setattr(
        plugin,
        "_resolve_canvas_scope_for_write",
        lambda project, canvas: (project, canvas, None),
    )
    monkeypatch.setattr(plugin, "_validate_write_commands_shape", lambda *_args: None)
    monkeypatch.setattr(
        plugin,
        "_external_generation_parameter_preflight",
        lambda *_args: None,
    )
    monkeypatch.setattr(plugin, "_mcp_direct_canvas_apply_enabled", lambda: False)

    def fake_dispatch(**kwargs):
        captured.update(kwargs)
        return "dispatched"

    monkeypatch.setattr(
        plugin,
        "_dispatch_mcp_approved_frontend_commands",
        fake_dispatch,
    )

    result = plugin._emit_canvas_commands(
        "project-a",
        "canvas-a",
        commands,
        allow_dynamic_workflow_batch=True,
    )

    assert result == "dispatched"
    assert "model" not in captured["commands"][0]["data"]


def test_hermes_canvas_write_preserves_recommended_model(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.delenv("DRAMACLAW_EXTERNAL_MCP", raising=False)
    commands = [
        {
            "type": "create_node",
            "node_type": "imageGenNode",
            "data": {"model": "recommended"},
        }
    ]
    captured = {}

    monkeypatch.setattr(
        plugin,
        "_resolve_canvas_scope_for_write",
        lambda project, canvas: (project, canvas, None),
    )
    monkeypatch.setattr(plugin, "_validate_write_commands_shape", lambda *_args: None)
    monkeypatch.setattr(
        plugin,
        "_external_generation_parameter_preflight",
        lambda *_args: None,
    )
    monkeypatch.setattr(plugin, "_mcp_direct_canvas_apply_enabled", lambda: False)

    def fake_dispatch(**kwargs):
        captured.update(kwargs)
        return "dispatched"

    monkeypatch.setattr(plugin, "_dispatch_frontend_canvas_commands", fake_dispatch)

    result = plugin._emit_canvas_commands(
        "project-a",
        "canvas-a",
        commands,
        allow_dynamic_workflow_batch=True,
    )

    assert result == "dispatched"
    assert captured["commands"][0]["data"]["model"] == "recommended"


def test_dynamic_workflow_plan_uses_draft_before_canvas_bridge(monkeypatch, tmp_path):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.ecommerce-product",
        "skill": {"id": "ecommerce-product"},
        "nodes": [],
        "edges": [],
    }
    commands = [{"type": "create_node", "node_type": "textAnnotationNode"}]
    captured = {}

    monkeypatch.setattr(
        plugin,
        "validate_agent_workflow_plan",
        lambda value: {
            "ok": value is plan,
            "status": "workflow_plan_valid",
            "schema_version": "freezone_workflow_plan.v1",
            "skill_id": "ecommerce-product",
            "node_count": 0,
            "edge_count": 0,
            "plan": value,
        },
    )
    monkeypatch.setattr(
        plugin,
        "build_workflow_graph_commands",
        lambda args: {"ok": True, "commands": commands, "plan": args["plan"]},
    )

    def fake_preflight(compiled, *, project_id):
        captured["preflight_plan"] = compiled["plan"]
        captured["preflight_project"] = project_id
        return {"status": "ready", "blockers": [], "warnings": []}

    monkeypatch.setattr(plugin, "_workflow_runtime_preflight", fake_preflight)

    def fake_emit(project, canvas, emitted, **kwargs):
        captured.update(
            {
                "project": project,
                "canvas": canvas,
                "commands": emitted,
                "kwargs": kwargs,
            }
        )
        return {
            "ok": True,
            "canvas_apply_status": "applied",
            "applied": True,
        }

    monkeypatch.setattr(plugin, "_emit_canvas_commands", fake_emit)

    prepared = plugin._handle_prepare_workflow_plan_draft(
        {"project_id": "project-a", "canvas_id": "canvas-a", "plan": plan}
    )

    assert prepared["ok"] is True
    assert prepared["status"] == "workflow_draft_ready"
    assert prepared["preview"]["node_count"] == 0
    assert captured.get("commands") is None
    assert captured["preflight_plan"] is plan
    assert captured["preflight_project"] == "project-a"

    confirmed = plugin._handle_confirm_workflow_draft(
        {"draft_id": prepared["draft_id"], "revision": prepared["revision"]}
    )

    assert confirmed["ok"] is True
    assert captured["commands"] == commands
    assert captured["kwargs"]["allow_dynamic_workflow_batch"] is True


def test_dynamic_workflow_creation_stops_when_live_model_catalog_is_unavailable(
    monkeypatch,
):
    plugin = _load_plugin_module()
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.ecommerce-product",
        "skill": {"id": "ecommerce-product"},
        "nodes": [
            {
                "id": "image",
                "node_type": "imageGenNode",
                "data": {"model": "image-model", "size": "8K"},
            }
        ],
        "edges": [],
    }
    monkeypatch.setattr(
        plugin,
        "validate_agent_workflow_plan",
        lambda value: {"ok": value is plan, "plan": value},
    )
    monkeypatch.setattr(plugin, "_available", lambda: True)

    def fake_request(method, path, **_kwargs):
        assert method == "GET"
        if path.endswith("/freezone/image/models"):
            return {"ok": False, "error": "catalog unavailable"}
        if path.endswith("/tasks/limits"):
            return {"ok": True, "data": {}}
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)
    monkeypatch.setattr(
        plugin,
        "build_workflow_graph_commands",
        lambda _args: pytest.fail("must stop before building canvas commands"),
    )

    result = plugin._handle_prepare_workflow_plan_draft(
        {"project_id": "project-a", "canvas_id": "canvas-a", "plan": plan}
    )

    assert result["status"] == "workflow_preflight_failed"
    assert result["preflight"]["blockers"][0]["code"] == "model_catalog_unavailable"


def test_workflow_draft_can_be_prepared_patched_and_confirmed_once(
    monkeypatch, tmp_path
):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    emitted = []

    def fake_compile(intent):
        items = list(intent.get("items") or [])
        nodes = [
            {
                "id": "workflow_input",
                "name": "用户需求",
                "node_type": "textAnnotationNode",
                "stage": "input",
            },
            *[
                {
                    "id": f"shot_{index + 1}",
                    "name": str(item),
                    "node_type": "videoNode",
                    "stage": "video",
                }
                for index, item in enumerate(items)
            ],
        ]
        return {
            "ok": True,
            "skill_id": intent["skill_id"],
            "node_count": len(nodes),
            "edge_count": max(0, len(nodes) - 1),
            "plan": {
                "summary": intent["user_goal"],
                "inputs": dict(intent.get("inputs") or {}),
                "phases": ["脚本", "视频"],
                "nodes": nodes,
                "edges": [],
            },
        }

    monkeypatch.setattr(plugin, "compile_workflow_intent", fake_compile)
    monkeypatch.setattr(
        plugin,
        "build_workflow_graph_commands",
        lambda args: {
            "ok": True,
            "commands": [
                {
                    "type": "create_node",
                    "node_type": "textAnnotationNode",
                    "data": {"displayName": "用户需求"},
                }
            ],
        },
    )

    def fake_emit(project, canvas, commands, **kwargs):
        emitted.append((project, canvas, commands, kwargs))
        return {
            "ok": True,
            "canvas_apply_status": "applied",
            "applied": True,
        }

    monkeypatch.setattr(plugin, "_emit_canvas_commands", fake_emit)
    prepared = plugin._handle_prepare_workflow_draft(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "intent": {
                "skill_id": "video-ad",
                "user_goal": "制作广告",
                "items": ["开场", "卖点"],
            },
            "run_after_create": True,
        }
    )

    assert prepared["ok"] is True
    assert prepared["revision"] == 1
    assert prepared["preview"]["node_count"] == 3
    assert prepared["run_after_create"] is True
    assert "Do not mention credits" in prepared["agent_instruction"]

    patched = plugin._handle_patch_workflow_draft(
        {
            "draft_id": prepared["draft_id"],
            "expected_revision": 1,
            "changes": {"items": ["开场", "卖点", "收尾"]},
        }
    )

    assert patched["ok"] is True
    assert patched["revision"] == 2
    assert patched["preview"]["node_count"] == 4

    stale_patch = plugin._handle_patch_workflow_draft(
        {
            "draft_id": prepared["draft_id"],
            "expected_revision": 1,
            "changes": {"include_audio": False},
        }
    )
    confirmed = plugin._handle_confirm_workflow_draft(
        {"draft_id": prepared["draft_id"], "revision": 2}
    )
    repeated = plugin._handle_confirm_workflow_draft(
        {"draft_id": prepared["draft_id"], "revision": 2}
    )

    assert stale_patch["status"] == "workflow_draft_revision_conflict"
    assert confirmed["ok"] is True
    assert len(emitted) == 1
    assert emitted[0][0:2] == ("project-a", "canvas-a")
    assert repeated["status"] == "workflow_draft_already_confirmed"


def test_workflow_draft_prepare_stops_when_live_model_catalog_is_unavailable(
    monkeypatch,
    tmp_path,
):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    draft_request = plugin._request
    compiled = {
        "ok": True,
        "skill_id": "ecommerce-product",
        "plan": {
            "nodes": [
                {
                    "id": "image",
                    "node_type": "imageGenNode",
                    "data": {"model": "image-model", "size": "8K"},
                }
            ],
            "edges": [],
        },
    }
    monkeypatch.setattr(plugin, "compile_workflow_intent", lambda _intent: compiled)
    monkeypatch.setattr(plugin, "_available", lambda: True)

    def fake_request(method, path, **kwargs):
        if path.endswith("/freezone/image/models"):
            return {"ok": False, "error": "catalog unavailable"}
        if path.endswith("/tasks/limits"):
            return {"ok": True, "data": {}}
        return draft_request(method, path, **kwargs)

    monkeypatch.setattr(plugin, "_request", fake_request)
    result = plugin._handle_prepare_workflow_draft(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "intent": {
                "skill_id": "ecommerce-product",
                "user_goal": "生成商品图",
            },
        }
    )

    assert result["status"] == "workflow_preflight_failed"
    assert result["preflight"]["blockers"][0]["code"] == "model_catalog_unavailable"


def test_workflow_draft_confirm_stops_when_live_model_catalog_becomes_unavailable(
    monkeypatch,
    tmp_path,
):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    draft_request = plugin._request
    catalog_available = True
    compiled = {
        "ok": True,
        "skill_id": "ecommerce-product",
        "plan": {
            "nodes": [
                {
                    "id": "image",
                    "node_type": "imageGenNode",
                    "data": {"model": "image-model", "size": "2K"},
                }
            ],
            "edges": [],
        },
    }
    monkeypatch.setattr(plugin, "compile_workflow_intent", lambda _intent: compiled)
    monkeypatch.setattr(plugin, "_available", lambda: True)

    def fake_request(method, path, **kwargs):
        if path.endswith("/freezone/image/models"):
            return (
                {
                    "ok": True,
                    "data": [
                        {
                            "id": "image-model",
                            "resolutionOptions": ["2K"],
                            "ratioOptions": ["1:1"],
                        }
                    ],
                }
                if catalog_available
                else {"ok": False, "error": "catalog unavailable"}
            )
        if path.endswith("/tasks/limits"):
            return {"ok": True, "data": {}}
        return draft_request(method, path, **kwargs)

    monkeypatch.setattr(plugin, "_request", fake_request)
    monkeypatch.setattr(
        plugin,
        "_emit_canvas_commands",
        lambda *_args, **_kwargs: pytest.fail("must stop before the protected write"),
    )
    prepared = plugin._handle_prepare_workflow_draft(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "intent": {
                "skill_id": "ecommerce-product",
                "user_goal": "生成商品图",
            },
        }
    )
    assert prepared["ok"] is True

    catalog_available = False
    result = plugin._handle_confirm_workflow_draft(
        {"draft_id": prepared["draft_id"], "revision": prepared["revision"]}
    )

    assert result["status"] == "workflow_preflight_failed"
    assert result["preflight"]["blockers"][0]["code"] == "model_catalog_unavailable"


def test_workflow_draft_rejects_json_intent_string(monkeypatch, tmp_path):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {
            "summary": "广告",
            "inputs": {},
            "phases": [],
            "nodes": [],
            "edges": [],
        },
    }
    monkeypatch.setattr(plugin, "compile_workflow_intent", lambda intent: compiled)
    serialized = json.dumps(
        {
            "schema_version": "freezone_workflow_intent.v1",
            "skill_id": "video-ad",
            "user_goal": "制作广告",
        },
        ensure_ascii=False,
    )

    result = plugin._handle_prepare_workflow_draft({"intent": serialized})

    assert result["ok"] is False
    assert result["status"] == "workflow_intent_object_required"


def test_workflow_draft_returns_actionable_errors_for_wrong_phase_arguments():
    plugin = _load_plugin_module()

    wrong_tool = plugin._handle_prepare_workflow_draft(
        {"project_id": "project-a", "canvas_id": "canvas-a", "draft_id": "draft-1"}
    )
    assert wrong_tool["status"] == "wrong_workflow_draft_tool"
    assert "freezone_patch_workflow_draft" in wrong_tool["agent_instruction"]

    missing_intent = plugin._handle_prepare_workflow_draft(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
        }
    )
    assert missing_intent["status"] == "workflow_intent_required_for_quote"

    invalid_intent = plugin._handle_prepare_workflow_draft(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "intent": "not-json",
        }
    )
    assert invalid_intent["status"] == "workflow_intent_object_required"
    assert "execute_code" in invalid_intent["agent_instruction"]


def test_workflow_draft_requires_canonical_argument_shapes(monkeypatch, tmp_path):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {
            "summary": "广告",
            "inputs": {},
            "phases": [],
            "nodes": [],
            "edges": [],
        },
    }
    monkeypatch.setattr(
        plugin,
        "compile_workflow_intent",
        lambda intent: {**compiled, "skill_id": intent.get("skill_id") or "video-ad"},
    )

    flattened = plugin._handle_prepare_workflow_draft(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_id": "video-ad",
            "user_goal": "制作广告",
            "planner": {"deliverable": "video", "units": []},
        }
    )
    assert flattened["ok"] is False
    assert flattened["status"] == "workflow_intent_required_for_quote"

    prepared = plugin._handle_prepare_workflow_draft(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "intent": {
                "schema_version": "freezone_workflow_intent.v1",
                "skill_id": "video-ad",
                "user_goal": "制作广告",
                "planner": {"mode": "standard", "deliverable": "video", "units": []},
            },
        }
    )
    assert prepared["ok"] is True

    alias_patch = plugin._handle_patch_workflow_draft(
        {
            "draft_id": prepared["draft_id"],
            "expected_revision": 1,
            "patch": {"skill_id": "video-ad", "user_goal": "改成 30 秒"},
        }
    )
    assert alias_patch["ok"] is False
    assert alias_patch["status"] == "workflow_draft_patch_args_invalid"

    # 真正不可修改的字段仍然打回,并附可修改字段清单与纠正指令。
    rejected = plugin._handle_patch_workflow_draft(
        {
            "draft_id": prepared["draft_id"],
            "expected_revision": 1,
            "changes": {"skill_id": "other-skill"},
        }
    )
    assert rejected["ok"] is False
    assert rejected["status"] == "invalid_workflow_draft_patch"
    assert "planner" in rejected["patchable_fields"]
    assert "freezone_patch_workflow_draft" in rejected["agent_instruction"]


def test_workflow_planning_quote_skips_billing_in_ce(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda *_args, **_kwargs: {
            "ok": True,
            "data": {
                "feature_key": "freezone.agent.creative_planning",
                "metering_enabled": False,
                "billing_required": False,
                "allowed": True,
            },
        },
    )

    result = plugin._agent_billing_confirmation_gate(
        "project-a",
        "canvas-a",
        args={},
        operation_kind="workflow_planning_create",
        operation={"intent": {}, "run_after_create": False},
    )

    assert result is None


def test_workflow_planning_quote_stops_when_agent_credits_are_insufficient(
    monkeypatch,
):
    plugin = _load_plugin_module()
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda *_args, **_kwargs: {
            "ok": True,
            "data": {
                "billing_required": True,
                "configured": True,
                "exact": True,
                "allowed": False,
                "quote_id": "billing_quote_insufficient",
                "display": "12 积分",
            },
        },
    )

    result = plugin._agent_billing_confirmation_gate(
        "project-a",
        "canvas-a",
        args={},
        operation_kind="workflow_planning_create",
        operation={"intent": {}, "run_after_create": False},
    )

    assert result["status"] == "agent_credit_insufficient"
    assert result["confirmation_required"] is False
    assert result["next_action"] == "add_credits"
    assert "ask for confirmation" in result["agent_instruction"]


def test_workflow_prepare_requires_server_receipt_and_retries_exact_operation(
    monkeypatch,
):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    intent = {"skill_id": "video-ad", "user_goal": "制作广告"}
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {"summary": "广告", "nodes": [], "edges": [], "phases": []},
    }
    calls = []

    def fake_request(method, path, *, body=None, **_kwargs):
        calls.append((method, path, body))
        if path.endswith("/freezone/agent-capability-quote"):
            return {
                "ok": True,
                "data": {
                    "billing_required": True,
                    "configured": True,
                    "exact": True,
                    "quote_id": "billing_quote_a",
                    "display": "12 积分",
                },
            }
        if path.endswith("/workflow-drafts"):
            return {
                "ok": True,
                "data": {
                    "schema_version": "freezone_workflow_draft.v1",
                    "draft_id": "workflow_draft_a",
                    "revision": 1,
                    "status": "ready",
                    "skill_id": "video-ad",
                    "intent": intent,
                    "compiled": compiled,
                    "preview": {"node_count": 0},
                    "plan_digest": "digest-a",
                    "run_after_create": False,
                    "last_changes": {},
                    "expires_at": 9999999999,
                },
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)
    monkeypatch.setattr(plugin, "compile_workflow_intent", lambda _intent: compiled)
    monkeypatch.setattr(
        plugin,
        "_workflow_runtime_preflight",
        lambda *_args, **_kwargs: {"status": "ready", "blockers": [], "warnings": []},
    )

    quoted = plugin._handle_prepare_workflow_draft({"intent": intent})
    assert quoted["status"] == "agent_planning_confirmation_required"
    assert "确认规划费用 billing_quote_a" in quoted["agent_instruction"]
    assert len(calls) == 1
    assert calls[0][2]["operation"]["compiled"] == compiled

    prepared = plugin._handle_prepare_workflow_draft(
        {
            "intent": intent,
            "quote_id": "billing_quote_a",
            "confirmation_receipt": "billing_receipt_a",
        }
    )
    assert prepared["draft_id"] == "workflow_draft_a"
    assert calls[-1][2]["quote_id"] == "billing_quote_a"
    assert calls[-1][2]["confirmation_receipt"] == "billing_receipt_a"

    incomplete = plugin._agent_billing_confirmation_gate(
        "project-a",
        "canvas-a",
        args={"quote_id": "billing_quote_a"},
        operation_kind="workflow_planning_create",
        operation={"intent": intent, "compiled": compiled},
    )
    assert incomplete["status"] == "billing_confirmation_incomplete"


def test_workflow_plan_prepare_uses_the_same_receipt_bound_draft_flow(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": "video-ad"},
        "nodes": [],
        "edges": [],
    }
    compiled = {
        "ok": True,
        "status": "workflow_plan_valid",
        "schema_version": "freezone_workflow_plan.v1",
        "skill_id": "video-ad",
        "node_count": 0,
        "edge_count": 0,
        "plan": plan,
        "preflight": {"status": "ready", "blockers": [], "warnings": []},
    }
    calls = []

    def fake_request(method, path, *, body=None, **_kwargs):
        calls.append((method, path, body))
        if path.endswith("/freezone/agent-capability-quote"):
            return {
                "ok": True,
                "data": {
                    "billing_required": True,
                    "configured": True,
                    "exact": True,
                    "quote_id": "billing_quote_plan",
                    "display": "12 积分",
                },
            }
        if path.endswith("/workflow-drafts"):
            return {
                "ok": True,
                "data": {
                    "schema_version": "freezone_workflow_draft.v1",
                    "draft_id": "workflow_draft_plan",
                    "revision": 1,
                    "status": "ready",
                    "skill_id": "video-ad",
                    "compiled": compiled,
                    "preview": {"node_count": 0, "edge_count": 0},
                    "plan_digest": "digest-plan",
                    "run_after_create": False,
                    "last_changes": {},
                    "expires_at": 9999999999,
                },
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)
    monkeypatch.setattr(
        plugin, "validate_agent_workflow_plan", lambda value: dict(compiled)
    )
    monkeypatch.setattr(
        plugin,
        "_workflow_runtime_preflight",
        lambda *_args, **_kwargs: compiled["preflight"],
    )
    monkeypatch.setattr(
        plugin,
        "_emit_canvas_commands",
        lambda *_args, **_kwargs: pytest.fail("prepare must never write the canvas"),
    )

    quoted = plugin._handle_prepare_workflow_plan_draft({"plan": plan})
    assert quoted["status"] == "agent_planning_confirmation_required"
    assert len(calls) == 1
    operation = calls[0][2]["operation"]
    assert operation["intent"] == {
        "schema_version": "freezone_workflow_plan_draft.v1",
        "plan": plan,
    }
    assert operation["compiled"] == compiled

    prepared = plugin._handle_prepare_workflow_plan_draft(
        {
            "plan": plan,
            "quote_id": "billing_quote_plan",
            "confirmation_receipt": "billing_receipt_plan",
        }
    )
    assert prepared["status"] == "workflow_draft_ready"
    assert prepared["draft_id"] == "workflow_draft_plan"
    assert calls[-1][2]["quote_id"] == "billing_quote_plan"
    assert calls[-1][2]["confirmation_receipt"] == "billing_receipt_plan"
    assert calls[-1][2]["intent"] == operation["intent"]
    assert calls[-1][2]["compiled"] == operation["compiled"]


def test_workflow_draft_concurrent_confirmation_emits_once(monkeypatch, tmp_path):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {
            "summary": "广告",
            "inputs": {},
            "phases": [],
            "nodes": [
                {
                    "id": "input",
                    "name": "输入",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                }
            ],
            "edges": [],
        },
    }
    monkeypatch.setattr(plugin, "compile_workflow_intent", lambda _intent: compiled)
    monkeypatch.setattr(
        plugin,
        "build_workflow_graph_commands",
        lambda args: {
            "ok": True,
            "commands": [{"type": "create_node", "node_type": "textAnnotationNode"}],
            "workflow_instance_id": args["workflow_instance_id"],
        },
    )
    started = threading.Event()
    release = threading.Event()
    emitted = []

    def fake_emit(*args, **kwargs):
        emitted.append((args, kwargs))
        started.set()
        assert release.wait(timeout=5)
        return {"ok": True, "canvas_apply_status": "applied", "applied": True}

    monkeypatch.setattr(plugin, "_emit_canvas_commands", fake_emit)
    prepared = plugin._handle_prepare_workflow_draft(
        {
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
        }
    )
    confirm_args = {"draft_id": prepared["draft_id"], "revision": 1}

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(plugin._handle_confirm_workflow_draft, confirm_args)
        assert started.wait(timeout=5)
        second = executor.submit(plugin._handle_confirm_workflow_draft, confirm_args)
        second_result = second.result(timeout=5)
        release.set()
        first_result = first.result(timeout=5)

    assert first_result["ok"] is True
    assert second_result["status"] == "workflow_draft_confirmation_in_progress"
    assert len(emitted) == 1


def test_workflow_draft_timeout_is_persisted_without_duplicate_submission(
    monkeypatch, tmp_path
):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {
            "summary": "广告",
            "inputs": {},
            "phases": [],
            "nodes": [
                {
                    "id": "input",
                    "name": "输入",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                }
            ],
            "edges": [],
        },
    }
    monkeypatch.setattr(plugin, "compile_workflow_intent", lambda _intent: compiled)
    built_instance_ids = []

    def fake_build(args):
        built_instance_ids.append(args["workflow_instance_id"])
        return {
            "ok": True,
            "commands": [{"type": "create_node", "node_type": "textAnnotationNode"}],
        }

    monkeypatch.setattr(plugin, "build_workflow_graph_commands", fake_build)
    emitted = []

    def fake_emit(*args, **kwargs):
        emitted.append((args, kwargs))
        return {"ok": True, "canvas_apply_status": "timeout", "applied": False}

    monkeypatch.setattr(plugin, "_emit_canvas_commands", fake_emit)
    prepared = plugin._handle_prepare_workflow_draft(
        {
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
        }
    )
    confirm_args = {"draft_id": prepared["draft_id"], "revision": 1}

    first = plugin._handle_confirm_workflow_draft(confirm_args)
    repeated = plugin._handle_confirm_workflow_draft(confirm_args)

    assert first["canvas_apply_status"] == "timeout"
    assert repeated["status"] == "workflow_draft_confirmation_in_progress"
    assert len(emitted) == 1
    assert built_instance_ids == [prepared["draft_id"]]


def test_workflow_draft_patch_rejects_skill_replacement(monkeypatch, tmp_path):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, tmp_path)
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {
            "summary": "广告",
            "inputs": {},
            "phases": [],
            "nodes": [
                {
                    "id": "input",
                    "name": "输入",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                }
            ],
            "edges": [],
        },
    }
    monkeypatch.setattr(plugin, "compile_workflow_intent", lambda _intent: compiled)
    prepared = plugin._handle_prepare_workflow_draft(
        {
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
        }
    )

    result = plugin._handle_patch_workflow_draft(
        {
            "draft_id": prepared["draft_id"],
            "expected_revision": 1,
            "changes": {"skill_id": "short-drama"},
        }
    )

    assert result["ok"] is False
    assert result["status"] == "invalid_workflow_draft_patch"
    assert result["unsupported_fields"] == ["skill_id"]


def test_workflow_runtime_preflight_blocks_unavailable_model(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setattr(plugin, "_available", lambda: True)

    def fake_request(method, path, **_kwargs):
        assert method == "GET"
        if path.endswith("/freezone/image/models"):
            return {"ok": True, "data": [{"id": "available-image-model"}]}
        if path.endswith("/tasks/limits"):
            return {
                "ok": True,
                "data": {
                    "default": {"limit": 3, "remaining": 3},
                    "video": {"limit": 3, "remaining": 3},
                    "ffmpeg": {"limit": 1, "remaining": 1},
                },
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)
    result = plugin._workflow_runtime_preflight(
        {
            "preflight": {"status": "ready", "blockers": [], "warnings": []},
            "plan": {
                "nodes": [
                    {
                        "id": "image",
                        "node_type": "imageGenNode",
                        "data": {"model": "missing-image-model"},
                    }
                ]
            },
        },
        project_id="project-a",
    )

    assert result["status"] == "blocked"
    assert result["blockers"] == [
        {
            "path": "runtime.models",
            "message": "configured model is unavailable: missing-image-model",
            "code": "model_unavailable",
        }
    ]


def test_workflow_runtime_preflight_blocks_unavailable_live_model_catalog(
    monkeypatch,
):
    plugin = _load_plugin_module()
    monkeypatch.setattr(plugin, "_available", lambda: True)

    def fake_request(method, path, **_kwargs):
        assert method == "GET"
        if path.endswith("/freezone/image/models"):
            return {"ok": False, "error": "catalog unavailable"}
        if path.endswith("/tasks/limits"):
            return {
                "ok": True,
                "data": {
                    "default": {"limit": 3, "remaining": 3},
                    "video": {"limit": 3, "remaining": 3},
                    "ffmpeg": {"limit": 1, "remaining": 1},
                },
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)
    result = plugin._workflow_runtime_preflight(
        {
            "preflight": {"status": "ready", "blockers": [], "warnings": []},
            "plan": {
                "nodes": [
                    {
                        "id": "image",
                        "node_type": "imageGenNode",
                        "data": {
                            "model": "image-model",
                            "size": "8K",
                            "aspectRatio": "banana",
                            "quality": "ultra",
                        },
                    }
                ]
            },
        },
        project_id="project-a",
    )

    assert result["status"] == "blocked"
    assert result["blockers"] == [
        {
            "path": "runtime.models",
            "message": (
                "could not verify imageGenNode capabilities because the live model "
                "catalog is unavailable"
            ),
            "code": "model_catalog_unavailable",
        }
    ]


def test_workflow_runtime_preflight_uses_live_model_capabilities(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setattr(plugin, "_available", lambda: True)

    def fake_request(method, path, **_kwargs):
        assert method == "GET"
        if path.endswith("/freezone/image/models"):
            return {
                "ok": True,
                "data": [
                    {
                        "id": "seedream-5.0-lite",
                        "resolutionOptions": ["2K", "3K"],
                        "ratioOptions": ["1:1", "16:9"],
                    },
                    {
                        "id": "LingShan-NB-2",
                        "resolutionOptions": ["1K", "2K", "4K"],
                        "ratioOptions": ["1:1", "1:4", "4:1", "1:8", "8:1"],
                    },
                ],
            }
        if path.endswith("/freezone/video/models"):
            return {
                "ok": True,
                "data": [
                    {
                        "id": "MiniMax-H3",
                        "resolutionOptions": ["768P", "2K"],
                        "ratioOptions": ["21:9", "9:16"],
                        "minDuration": 4,
                        "maxDuration": 15,
                        "supportsGenerateAudio": False,
                    }
                ],
            }
        if path.endswith("/tasks/limits"):
            return {
                "ok": True,
                "data": {
                    "default": {"limit": 8, "remaining": 8},
                    "video": {"limit": 8, "remaining": 8},
                    "ffmpeg": {"limit": 1, "remaining": 1},
                },
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)
    result = plugin._workflow_runtime_preflight(
        {
            "preflight": {"status": "ready", "blockers": [], "warnings": []},
            "plan": {
                "nodes": [
                    {
                        "id": "image-3k",
                        "node_type": "imageGenNode",
                        "data": {
                            "model": "seedream-5.0-lite",
                            "size": "3K",
                            "aspectRatio": "16:9",
                        },
                    },
                    {
                        "id": "image-wide",
                        "node_type": "imageGenNode",
                        "data": {
                            "model": "LingShan-NB-2",
                            "size": "4K",
                            "aspectRatio": "1:8",
                        },
                    },
                    {
                        "id": "video",
                        "node_type": "videoNode",
                        "data": {
                            "model": "MiniMax-H3",
                            "quality": "2k",
                            "aspectRatio": "21:9",
                            "durationSec": 10,
                            "generateAudio": False,
                        },
                    },
                ]
            },
        },
        project_id="project-a",
    )

    assert result["status"] == "ready"
    assert result["blockers"] == []


def test_workflow_runtime_preflight_rejects_values_outside_selected_model_schema(
    monkeypatch,
):
    plugin = _load_plugin_module()
    monkeypatch.setattr(plugin, "_available", lambda: True)

    def fake_request(method, path, **_kwargs):
        assert method == "GET"
        if path.endswith("/freezone/image/models"):
            return {
                "ok": True,
                "data": [
                    {
                        "id": "image-model",
                        "resolutionOptions": ["2K", "3K"],
                        "ratioOptions": ["1:1", "16:9"],
                        "qualityOptions": ["low", "medium", "high"],
                    }
                ],
            }
        if path.endswith("/tasks/limits"):
            return {
                "ok": True,
                "data": {
                    "default": {"limit": 3, "remaining": 3},
                    "video": {"limit": 3, "remaining": 3},
                    "ffmpeg": {"limit": 1, "remaining": 1},
                },
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)
    result = plugin._workflow_runtime_preflight(
        {
            "preflight": {"status": "ready", "blockers": [], "warnings": []},
            "plan": {
                "nodes": [
                    {
                        "id": "image",
                        "node_type": "imageGenNode",
                        "data": {
                            "model": "image-model",
                            "size": "8K",
                            "aspectRatio": "banana",
                            "quality": "ultra",
                        },
                    }
                ]
            },
        },
        project_id="project-a",
    )

    assert result["status"] == "blocked"
    assert {(blocker["path"], blocker["code"]) for blocker in result["blockers"]} == {
        ("runtime.models.image.aspectRatio", "model_capability_unsupported"),
        ("runtime.models.image.size", "model_capability_unsupported"),
        ("runtime.models.image.quality", "model_capability_unsupported"),
    }


def test_workflow_runtime_preflight_warns_when_queue_is_full(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setattr(plugin, "_available", lambda: True)
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda _method, _path, **_kwargs: {
            "ok": True,
            "data": {
                "default": {"limit": 3, "remaining": 0},
                "video": {"limit": 3, "remaining": 3},
                "ffmpeg": {"limit": 1, "remaining": 1},
            },
        },
    )

    result = plugin._workflow_runtime_preflight(
        {
            "preflight": {"status": "ready", "blockers": [], "warnings": []},
            "plan": {
                "nodes": [
                    {"id": "brief", "node_type": "textAnnotationNode", "data": {}},
                    {"id": "image", "node_type": "imageGenNode", "data": {}},
                ]
            },
        },
        project_id="project-a",
    )

    assert result["status"] == "ready"
    assert result["blockers"] == []
    assert any(
        warning["path"] == "runtime.queue_capacity.default"
        for warning in result["warnings"]
    )


def test_workflow_graph_can_run_validated_nodes_after_create():
    plugin = _load_plugin_module()
    built = plugin.build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.example",
                "nodes": [
                    {"id": "brief", "node_type": "textAnnotationNode"},
                    {"id": "image", "node_type": "imageGenNode"},
                ],
                "edges": [
                    {"source": "brief", "target": "image", "link_type": "prompt_for"}
                ],
            },
            "run_after_create": True,
        }
    )

    assert built["ok"] is True
    assert built["workflow_instance_id"].startswith("workflow_plan_")
    create_commands = [
        command for command in built["commands"] if command["type"] == "create_node"
    ]
    assert [command["data"]["workflowPlanNodeId"] for command in create_commands] == [
        "brief",
        "image",
    ]
    assert {command["data"]["workflowInstanceId"] for command in create_commands} == {
        built["workflow_instance_id"]
    }
    layout_command = next(
        command for command in built["commands"] if command["type"] == "layout_nodes"
    )
    assert layout_command == {
        "type": "layout_nodes",
        "node_ids": ["brief", "image"],
        "mode": "grid",
    }
    assert built["commands"][-1] == {
        "type": "run_workflow",
        "node_ids": ["brief", "image"],
        "scope": "selection",
    }


def test_workflow_graph_leaves_mixed_text_edge_roles_for_per_edge_inference():
    plugin = _load_plugin_module()
    built = plugin.build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.example",
                "nodes": [
                    {"id": "input", "node_type": "textAnnotationNode"},
                    {"id": "outline", "node_type": "textAnnotationNode"},
                    {"id": "image", "node_type": "imageGenNode"},
                ],
                "edges": [
                    {
                        "source": "input",
                        "target": "outline",
                        "link_type": "context_for",
                    },
                    {"source": "input", "target": "image", "link_type": "prompt_for"},
                ],
            }
        }
    )

    assert built["ok"] is True
    input_command = next(
        command
        for command in built["commands"]
        if command.get("type") == "create_node" and command.get("client_id") == "input"
    )
    assert "semanticOutputRole" not in input_command["data"]


def test_workflow_graph_defaults_speech_audio_to_preset_voice():
    plugin = _load_plugin_module()
    built = plugin.build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.audio",
                "nodes": [
                    {
                        "id": "narration",
                        "node_type": "audioNode",
                        "data": {"text": "欢迎观看"},
                    }
                ],
                "edges": [],
            }
        }
    )

    create_command = next(
        command for command in built["commands"] if command["type"] == "create_node"
    )
    assert create_command["data"]["audioKind"] == "speech"
    assert create_command["data"]["speechMode"] == "clone"
    assert create_command["data"]["voiceAvailable"] is False
    assert "presetModel" not in create_command["data"]
    assert "presetVoice" not in create_command["data"]


def test_freezone_get_workflow_skill_returns_json_when_registry_summarizes(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    plugin = _load_plugin_module_with_registry_result(lambda value: "summarized")
    monkeypatch.setattr(plugin, "get_workflow_skill", catalog.get_workflow_skill)
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    loaded = handlers["freezone_get_workflow_skill"]({"skill_id": "ecommerce-product"})

    decoded = json.loads(loaded)
    assert decoded["ok"] is True
    assert decoded["skill_id"] == "ecommerce-product"
    assert isinstance(decoded["available_recipes"], list)
    assert decoded["recipes"] == []
    assert decoded["recipe_definitions_omitted"] is True


def test_freezone_get_workflow_skill_accepts_native_skill_id(monkeypatch):
    plugin = _load_plugin_module_with_registry_result(lambda value: "summarized")
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    loaded = handlers["freezone_get_workflow_skill"]({"skill_id": "ecommerce-ad"})

    decoded = json.loads(loaded)
    assert decoded["ok"] is True
    assert decoded["skill_id"] == "ecommerce-ad"


def test_freezone_get_workflow_skill_compact_omits_recipe_definitions(monkeypatch):
    plugin = _load_plugin_module_with_registry_result(lambda value: "summarized")
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    loaded = handlers["freezone_get_workflow_skill"](
        {"skill_id": "ecommerce-ad", "compact": True}
    )

    decoded = json.loads(loaded)
    assert decoded["ok"] is True
    assert decoded["recipes"] == []
    assert decoded["recipe_definitions_omitted"] is True
    assert decoded["available_recipes"]
    assert decoded["planning_contract"]["mode"] == "dynamic_only"


def test_freezone_get_workflow_skill_records_structured_result_side_channel(
    monkeypatch, tmp_path
):
    result_dir = tmp_path / "freezone-tool-results"
    monkeypatch.setenv("DRAMACLAW_FREEZONE_TOOL_RESULT_DIR", str(result_dir))
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    plugin = _load_plugin_module_with_registry_result(lambda value: "summarized")
    monkeypatch.setattr(plugin, "get_workflow_skill", catalog.get_workflow_skill)
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    handlers["freezone_get_workflow_skill"]({"skill_id": "ecommerce-product"})

    files = list(result_dir.glob("freezone_get_workflow_skill-*.json"))
    assert len(files) == 1
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    assert payload["tool_name"] == "freezone_get_workflow_skill"
    assert payload["result"]["ok"] is True
    assert payload["result"]["skill_id"] == "ecommerce-product"
    assert isinstance(payload["result"]["available_recipes"], list)


def test_freezone_plugin_reads_saved_skill_and_recipe(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    def fake_request(method, path, *, query=None, body=None):  # noqa: ARG001
        assert method == "GET"
        if path == "/api/v1/freezone/agent-config/skills":
            return {
                "ok": True,
                "data": [
                    {"id": "other-skill"},
                    {"id": "home-culture-poster", "description": "完整 Skill 配置"},
                ],
            }
        if path == "/api/v1/freezone/agent-config/recipes":
            return {
                "ok": True,
                "data": [
                    {
                        "id": "home-culture-poster-image",
                        "system_prompt": "完整 Recipe 配置",
                    },
                ],
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)

    skill = handlers["freezone_get_saved_skill"]({"skill_id": "home-culture-poster"})
    recipe = handlers["freezone_get_saved_recipe"](
        {"recipe_id": "home-culture-poster-image"}
    )

    assert skill["ok"] is True
    assert skill["kind"] == "skills"
    assert skill["item"]["description"] == "完整 Skill 配置"
    assert recipe["ok"] is True
    assert recipe["kind"] == "recipes"
    assert recipe["item"]["system_prompt"] == "完整 Recipe 配置"


def test_freezone_plugin_lists_agent_catalog_summaries(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    def fake_request(method, path, *, query=None, body=None):  # noqa: ARG001
        assert method == "GET"
        if path == "/api/v1/freezone/agent-config/recipes":
            return {
                "ok": True,
                "data": [
                    {
                        "id": "ad-character-anchor",
                        "name": "广告 IP 角色锚点",
                        "description": "角色立绘提示词",
                        "enabled": True,
                        "output_kind": "image",
                        "action_keys": ["character-anchor"],
                        "result_summary": "角色锚点图",
                        "system_prompt": "完整 Recipe prompt 不应出现在列表摘要里",
                    },
                    {
                        "id": "video-audio-layer",
                        "name": "广告音频层",
                        "description": "配音和音效",
                        "enabled": False,
                        "output_kind": "audio",
                        "action_keys": ["audio-layer"],
                        "system_prompt": "也不应出现",
                    },
                ],
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)

    listed = handlers["freezone_list_agent_catalog"](
        {"kind": "recipes", "query": "角色"}
    )

    assert listed["ok"] is True
    assert listed["kind"] == "recipes"
    assert listed["count"] == 1
    assert listed["items"] == [
        {
            "id": "ad-character-anchor",
            "name": "广告 IP 角色锚点",
            "description": "角色立绘提示词",
            "enabled": True,
            "schema_version": "",
            "version": "",
            "output_kind": "image",
            "action_keys": ["character-anchor"],
            "result_summary": "角色锚点图",
            "requires_source_media": False,
            "force_enhancement": False,
            "builtin": False,
            "owned": False,
        }
    ]
    assert "system_prompt" not in listed["items"][0]


def test_freezone_plugin_list_agent_catalog_token_search_ranks_partial_matches(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    def fake_request(method, path, *, query=None, body=None):  # noqa: ARG001
        assert method == "GET"
        if path == "/api/v1/freezone/agent-config/recipes":
            return {
                "ok": True,
                "data": [
                    {
                        "id": "general-image",
                        "name": "通用图片",
                        "description": "基础图片生成",
                        "enabled": True,
                        "output_kind": "image",
                        "action_keys": ["image"],
                    },
                    {
                        "id": "video-audio-layer",
                        "name": "视频音频层",
                        "description": "配音、音效和背景音乐",
                        "enabled": True,
                        "output_kind": "audio",
                        "action_keys": ["audio-layer"],
                        "result_summary": "音频层",
                    },
                    {
                        "id": "storyboard-shot-video",
                        "name": "分镜单段视频",
                        "description": "根据 storyboard 生成 video 片段",
                        "enabled": True,
                        "output_kind": "video",
                        "action_keys": ["shot-video"],
                        "result_summary": "逐镜视频",
                    },
                    {
                        "id": "video-storyboard-grid",
                        "name": "多宫格分镜图",
                        "description": "生成 storyboard grid",
                        "enabled": True,
                        "output_kind": "image",
                        "action_keys": ["storyboard"],
                        "result_summary": "分镜图",
                    },
                ],
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)

    listed = handlers["freezone_list_agent_catalog"](
        {"kind": "recipes", "query": "pixar character prop anchor storyboard video"}
    )

    assert listed["ok"] is True
    assert [item["id"] for item in listed["items"]] == [
        "storyboard-shot-video",
        "video-storyboard-grid",
        "video-audio-layer",
    ]


def test_freezone_plugin_list_agent_catalog_returns_fallback_summaries_when_query_misses(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    def fake_request(method, path, *, query=None, body=None):  # noqa: ARG001
        assert method == "GET"
        if path == "/api/v1/freezone/agent-config/recipes":
            return {
                "ok": True,
                "data": [
                    {
                        "id": "video-storyboard-grid",
                        "name": "多宫格分镜图",
                        "enabled": True,
                    },
                    {
                        "id": "storyboard-shot-video",
                        "name": "分镜单段视频",
                        "enabled": True,
                    },
                ],
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)

    listed = handlers["freezone_list_agent_catalog"](
        {"kind": "recipes", "query": "no matching phrase", "limit": 1}
    )

    assert listed["ok"] is True
    assert listed["count"] == 0
    assert [item["id"] for item in listed["fallback_items"]] == [
        "video-storyboard-grid"
    ]


def test_freezone_plugin_lists_agent_catalog_reports_available_ids(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    def fake_request(method, path, *, query=None, body=None):  # noqa: ARG001
        assert method == "GET"
        if path == "/api/v1/freezone/agent-config/skills":
            return {
                "ok": True,
                "data": [
                    {"id": "lego-video", "name": "乐高小人动画短片", "enabled": True},
                    {"id": "pixar-video", "name": "皮克斯广告短片", "enabled": True},
                ],
            }
        raise AssertionError(path)

    monkeypatch.setattr(plugin, "_request", fake_request)

    listed = handlers["freezone_list_agent_catalog"](
        {"kind": "skills", "query": "不存在"}
    )

    assert listed["ok"] is True
    assert listed["kind"] == "skills"
    assert listed["count"] == 0
    assert listed["available_ids"] == ["lego-video", "pixar-video"]


def test_freezone_plugin_clarification_tool_waits_for_frontend_result(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        assert project_id == "project-a"
        assert canvas_id == "canvas-a"
        assert event["type"] == "assistant.clarification.request"
        return "clarify-key-1"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):
        return {
            "ok": True,
            "status": "clarification_frontend_result",
            "tool_call_status": "completed",
            "clarification_status": "answered",
            "bridge_key": key,
            "answers": {
                "scope": {"option_ids": ["workflow"], "custom_text": "偏海报"},
            },
            "message": "User submitted clarification answers.",
        }

    monkeypatch.setattr(plugin, "clarification_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_clarification_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_clarification_result", fake_wait_result)

    result = handlers["freezone_request_user_clarification"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "clarification_id": "clarify_01",
            "title": "先确认方向",
            "questions": [
                {
                    "id": "scope",
                    "title": "主要做什么？",
                    "mode": "multiple",
                    "options": [{"id": "workflow", "label": "工作流自动化"}],
                    "allow_custom": True,
                }
            ],
            "allow_skip": True,
            "allow_recommended": True,
        }
    )

    assert result["ok"] is True
    assert result["status"] == "clarification_frontend_result"
    assert result["bridge_key"] == "clarify-key-1"
    assert result["answers"]["scope"]["option_ids"] == ["workflow"]
    assert pending_events[0]["event"]["type"] == "assistant.clarification.request"
    assert pending_events[0]["event"]["clarification_id"] == "clarify_01"
    assert pending_events[0]["event"]["questions"][0]["mode"] == "multiple"


def test_external_generation_clarification_rejects_bundled_settings(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    emitted = []
    monkeypatch.setattr(
        plugin,
        "_emit_clarification_event",
        lambda *_args, **_kwargs: emitted.append(True),
    )

    result = handlers["freezone_request_user_clarification"](
        {
            "title": "确认视频生成选项",
            "questions": [
                {
                    "id": "video_settings",
                    "title": "视频设置",
                    "options": [
                        {
                            "id": "recommended",
                            "label": "推荐设置",
                            "description": "9:16、高清、5 秒并生成环境音",
                        }
                    ],
                }
            ],
        }
    )

    assert result["ok"] is False
    assert result["code"] == "generation_parameter_questions_invalid"
    assert "video_resolution" in result["required_question_ids"]["video"]
    assert "image_variants_per_node" in result["required_question_ids"]["image"]
    assert "video_variants_per_node" in result["required_question_ids"]["video"]
    assert "image_count" not in result["required_question_ids"]["image"]
    assert "video_count" not in result["required_question_ids"]["video"]
    assert "480P" in result["agent_instruction"]
    assert emitted == []


def test_external_generation_clarification_accepts_separate_resolution_question(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    captured = {}

    def fake_emit(project, canvas, event):
        captured.update({"project": project, "canvas": canvas, "event": event})
        return "shown"

    monkeypatch.setattr(plugin, "_emit_clarification_event", fake_emit)
    result = handlers["freezone_request_user_clarification"](
        {
            "title": "确认视频清晰度",
            "questions": [
                {
                    "id": "video_resolution",
                    "title": "视频清晰度",
                    "options": [
                        {"id": "480P", "label": "480P"},
                        {"id": "720P", "label": "720P"},
                    ],
                }
            ],
        }
    )

    assert result == "shown"
    assert captured["event"]["questions"][0]["options"][0]["id"] == "480P"


def test_freezone_plugin_clarification_tool_generates_missing_id(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        assert project_id == "project-a"
        assert canvas_id == "canvas-a"
        assert event["clarification_id"].startswith("clarify_ss-distill-a_")
        return "clarify-key-2"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):
        return {
            "ok": True,
            "status": "clarification_frontend_result",
            "tool_call_status": "completed",
            "clarification_status": "answered",
            "bridge_key": key,
            "answers": {},
        }

    monkeypatch.setattr(plugin, "clarification_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_clarification_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_clarification_result", fake_wait_result)

    result = handlers["freezone_request_user_clarification"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "ss-distill-a",
            "questions": [
                {
                    "id": "scope",
                    "title": "主要做什么？",
                    "options": [{"id": "workflow", "label": "工作流自动化"}],
                }
            ],
        }
    )

    assert result["ok"] is True
    assert result["bridge_key"] == "clarify-key-2"
    generated_id = pending_events[0]["event"]["clarification_id"]
    assert generated_id.startswith("clarify_ss-distill-a_")
    assert len(generated_id.rsplit("_", 1)[-1]) == 8


def test_freezone_plugin_skill_studio_draft_tool_waits_for_frontend_result(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []
    wait_keys = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        assert project_id == "project-a"
        assert canvas_id == "canvas-a"
        assert event["type"].startswith("skill_studio.")
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):
        wait_keys.append((key, timeout_seconds))
        return {
            "ok": True,
            "status": "skill_studio_frontend_result",
            "tool_call_status": "completed",
            "skill_studio_status": "answered",
            "bridge_key": key,
            "selections": {"scope": "planning"},
            "message": "User submitted Skill Studio choices.",
        }

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    draft = handlers["freezone_present_agent_catalog_draft"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "skill": {"id": "demo_skill"},
            "recipes": [{"id": "demo_recipe"}],
            "summary": "草稿已生成",
            "warnings": ["检查 ID"],
        }
    )

    assert draft["ok"] is True
    assert draft["status"] == "skill_studio_frontend_result"
    assert draft["bridge_key"] == "skill-studio-1"
    assert pending_events[0]["event"]["type"] == "skill_studio.draft"
    assert pending_events[0]["event"]["skill"]["id"] == "demo_skill"
    assert pending_events[0]["event"]["recipes"][0]["id"] == "demo_recipe"
    assert wait_keys[0][0] == "skill-studio-1"


def test_freezone_plugin_skill_studio_chunked_draft_tools_emit_progress_and_finish(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []
    wait_keys = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        assert project_id == "project-a"
        assert canvas_id == "canvas-a"
        assert event["type"].startswith("skill_studio.")
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):
        wait_keys.append((key, timeout_seconds))
        return {
            "ok": True,
            "status": "skill_studio_frontend_result",
            "tool_call_status": "completed",
            "skill_studio_status": "answered",
            "bridge_key": key,
            "message": "User submitted Skill Studio draft.",
        }

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    outline = handlers["freezone_put_agent_catalog_draft_outline"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "reuse_goal": "公益短片工作流",
            "stages": [
                {
                    "id": "story-outline",
                    "recipe_id": "story-outline",
                    "reuse": "new",
                    "new_recipe_craft_gap": "现有 Recipe 缺少公益故事的输入结构和输出结构。",
                },
                {
                    "id": "video-render",
                    "recipe_id": "video-render",
                    "reuse": "new",
                    "new_recipe_craft_gap": "现有 Recipe 缺少公益视频生成的质量检查和失败边界。",
                },
            ],
            "expected_recipe_count": 2,
            "catalog_checked": True,
        }
    )
    begin = handlers["freezone_begin_agent_catalog_draft"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "summary": "正在生成公益短片 Skill",
            "expected_recipe_count": 2,
        }
    )
    skill = handlers["freezone_put_agent_catalog_skill"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "skill": {"id": "public-service-video", "description": "公益短片 Skill"},
        }
    )
    recipe_1 = handlers["freezone_put_agent_catalog_recipe"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "index": 0,
            "recipe": {"id": "story-outline", "name": "故事大纲"},
        }
    )
    recipe_2 = handlers["freezone_put_agent_catalog_recipe"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "index": 1,
            "recipe": {"id": "video-render", "name": "视频生成"},
        }
    )
    finished = handlers["freezone_finish_agent_catalog_draft"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
        }
    )

    assert outline["ok"] is True
    assert begin["ok"] is True
    assert skill["ok"] is True
    assert skill["agent_instruction"].startswith(
        "下一步必须调用 freezone_put_agent_catalog_recipe"
    )
    assert "剩余 2 个" in skill["agent_instruction"]
    assert (
        "下一步必须调用 freezone_put_agent_catalog_recipe" in skill["agent_instruction"]
    )
    assert "index=0" in skill["agent_instruction"]
    assert "中性工艺级 recipe_id" in skill["agent_instruction"]
    assert "不要把 Skill 的风格" in skill["agent_instruction"]
    assert (
        "现在不要调用 freezone_finish_agent_catalog_draft" in skill["agent_instruction"]
    )
    assert recipe_1["ok"] is True
    assert recipe_1["agent_instruction"].startswith(
        "下一步必须调用 freezone_put_agent_catalog_recipe"
    )
    assert "中性工艺级 recipe_id" in recipe_1["agent_instruction"]
    assert recipe_2["ok"] is True
    assert recipe_2["agent_instruction"].startswith(
        "下一步必须调用 freezone_finish_agent_catalog_draft"
    )
    assert finished["ok"] is True
    assert wait_keys == [("skill-studio-6", 600)]
    event_types = [item["event"]["type"] for item in pending_events]
    assert event_types == [
        "skill_studio.status",
        "skill_studio.status",
        "skill_studio.status",
        "skill_studio.status",
        "skill_studio.status",
        "skill_studio.draft",
    ]
    assert pending_events[0]["event"]["status"] == "draft_outline_ready"
    assert pending_events[1]["event"]["status"] == "draft_begin"
    assert pending_events[2]["event"]["message"] == "已生成 Skill 基础配置"
    assert "下一步必须调用 freezone_put_agent_catalog_recipe" in (
        pending_events[2]["event"]["debug"]["agent_instruction"]
    )
    assert pending_events[3]["event"]["message"] == "已生成 Recipe 1 / 2"
    assert (
        "不要把工具调用、参数块或代码块写进聊天内容"
        in pending_events[3]["event"]["debug"]["agent_instruction"]
    )
    assert pending_events[4]["event"]["message"] == "已生成 Recipe 2 / 2"
    draft_event = pending_events[-1]["event"]
    assert draft_event["skill"]["id"] == "public-service-video"
    assert [recipe["id"] for recipe in draft_event["recipes"]] == [
        "story-outline",
        "video-render",
    ]


def test_freezone_plugin_begin_agent_catalog_draft_requires_outline_for_create(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}

    result = handlers["freezone_begin_agent_catalog_draft"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_requires_outline",
            "mode": "create",
            "expected_recipe_count": 1,
        }
    )

    assert result["ok"] is False
    assert result["status"] == "skill_studio_outline_required"
    assert "freezone_put_agent_catalog_draft_outline" in result["agent_instruction"]


def test_freezone_plugin_begin_agent_catalog_draft_inherits_outline_expected_count(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):  # noqa: ARG001
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_inherits_expected",
    }
    handlers["freezone_put_agent_catalog_draft_outline"](
        {
            **base_args,
            "mode": "create",
            "reuse_goal": "广告短片工作流",
            "stages": [
                {
                    "id": "storyboard",
                    "recipe_id": "ad-storyboard",
                    "reuse": "new",
                    "new_recipe_craft_gap": "现有 Recipe 缺少全片分镜的输入结构和输出结构。",
                }
            ],
            "expected_recipe_count": 1,
            "catalog_checked": True,
        }
    )

    begin = handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create"}
    )
    recipe = handlers["freezone_put_agent_catalog_recipe"](
        {**base_args, "index": 0, "recipe": {"id": "ad-storyboard", "name": "广告分镜"}}
    )
    skill = handlers["freezone_put_agent_catalog_skill"](
        {**base_args, "skill": {"id": "ad-video", "description": "广告短片 Skill"}}
    )

    assert begin["ok"] is True
    assert recipe["ok"] is True
    assert pending_events[2]["event"]["message"] == "已生成 Recipe 1 / 1"
    assert skill["ok"] is True
    assert "Recipe 已提交 1 / 1" in skill["agent_instruction"]
    assert (
        "下一步必须调用 freezone_finish_agent_catalog_draft"
        in skill["agent_instruction"]
    )
    assert "本次不需要提交 Recipe" not in skill["agent_instruction"]


def test_freezone_plugin_draft_outline_allows_create_flow_and_reaches_final_draft(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):  # noqa: ARG001
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_outline",
    }
    outline = handlers["freezone_put_agent_catalog_draft_outline"](
        {
            **base_args,
            "mode": "create",
            "reuse_goal": "把当前广告短片流程沉淀成可复用 Skill",
            "skill_level_constraints": ["皮克斯 3D 风格放在 Skill"],
            "stages": [
                {
                    "id": "story-outline",
                    "recipe_id": "story-outline",
                    "reuse": "new",
                    "new_recipe_craft_gap": "现有 Recipe 缺少广告短片故事大纲的输入结构和输出结构。",
                },
            ],
            "expected_recipe_count": 1,
            "catalog_checked": True,
        }
    )
    begin = handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 1}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {**base_args, "skill": {"id": "ad-video"}}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {
            **base_args,
            "index": 0,
            "recipe": {
                "id": "story-outline",
                "name": "故事大纲",
                "output_kind": "text",
            },
        }
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    assert outline["ok"] is True
    assert begin["ok"] is True
    draft_event = pending_events[-1]["event"]
    assert (
        draft_event["outline"]["reuse_goal"] == "把当前广告短片流程沉淀成可复用 Skill"
    )
    assert draft_event["outline"]["expected_recipe_count"] == 1


def test_freezone_plugin_draft_outline_counts_only_new_recipe_chunks(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):  # noqa: ARG001
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_reuse_outline",
    }
    outline = handlers["freezone_put_agent_catalog_draft_outline"](
        {
            **base_args,
            "mode": "create",
            "reuse_goal": "复用广告短片制作流程",
            "stages": [
                {
                    "id": "character-anchor",
                    "recipe_id": "pixar-character-anchor",
                    "reuse": "new",
                    "new_recipe_craft_gap": "现有 Recipe 缺少广告 IP 角色锚点的输入结构和失败边界。",
                },
                {
                    "id": "prop-anchor",
                    "recipe_id": "brand-prop-anchor",
                    "reuse": "new",
                    "new_recipe_craft_gap": "现有 Recipe 缺少品牌道具植入的输出结构和质量检查。",
                },
                {
                    "id": "storyboard",
                    "recipe_id": "video-storyboard-grid",
                    "reuse": "existing",
                },
                {
                    "id": "shot-video",
                    "recipe_id": "storyboard-shot-video",
                    "reuse": "existing",
                },
                {
                    "id": "audio-layer",
                    "recipe_id": "video-audio-layer",
                    "reuse": "existing",
                },
            ],
            "expected_recipe_count": 5,
            "catalog_checked": True,
        }
    )
    begin = handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 5}
    )
    skill = handlers["freezone_put_agent_catalog_skill"](
        {**base_args, "skill": {"id": "pixar-ad-video"}}
    )

    assert outline["ok"] is True
    assert outline["agent_instruction"].count("expected_recipe_count=2") == 1
    assert begin["ok"] is True
    assert skill["agent_instruction"].count("Recipe 已提交 0 / 2") == 1
    outline_event = pending_events[0]["event"]
    assert outline_event["status"] == "draft_outline_ready"


def test_freezone_plugin_draft_outline_requires_craft_gap_for_new_recipes():
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    result = handlers["freezone_put_agent_catalog_draft_outline"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_missing_craft_gap_outline",
            "mode": "create",
            "reuse_goal": "把皮克斯 3D 广告短片沉淀成可复用 Skill",
            "skill_level_constraints": ["皮克斯 3D 风格放在 Skill"],
            "stages": [
                {
                    "id": "pixar-character-anchor",
                    "recipe_id": "pixar-character-anchor",
                    "reuse": "new",
                    "reason": "皮克斯卡通渲染风格的角色立绘是此 Skill 的核心特色，现有 Recipe 不含此风格",
                },
                {
                    "id": "storyboard",
                    "recipe_id": "video-storyboard-grid",
                    "reuse": "existing",
                    "reason": "已有通用多宫格分镜 Recipe，可直接复用",
                },
            ],
            "expected_recipe_count": 2,
            "catalog_checked": True,
        }
    )

    assert result["ok"] is False
    assert result["status"] == "skill_studio_outline_new_recipe_craft_gap_required"
    assert "new_recipe_craft_gap" in result["agent_instruction"]


def test_freezone_plugin_draft_outline_accepts_new_recipe_with_craft_gap(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):  # noqa: ARG001
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )

    result = handlers["freezone_put_agent_catalog_draft_outline"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_with_craft_gap_outline",
            "mode": "create",
            "reuse_goal": "把广告 IP 角色短片沉淀成可复用 Skill",
            "skill_level_constraints": ["视觉风格放在 Skill"],
            "stages": [
                {
                    "id": "ad-ip-character-anchor",
                    "recipe_id": "ad-ip-character-anchor",
                    "reuse": "new",
                    "reason": "需要广告 IP 角色锚点工艺",
                    "new_recipe_craft_gap": (
                        "现有角色锚点缺少广告 IP 角色的输入结构、输出结构和失败边界："
                        "必须拆出职业标识、品牌隔离、后续引用锁定，并禁止把产品卖点混入角色主体。"
                    ),
                },
                {
                    "id": "storyboard",
                    "recipe_id": "video-storyboard-grid",
                    "reuse": "existing",
                    "reason": "已有通用分镜图工艺可复用",
                },
            ],
            "expected_recipe_count": 2,
            "catalog_checked": True,
        }
    )

    assert result["ok"] is True
    assert result["agent_instruction"].count("expected_recipe_count=1") == 1
    outline_event = pending_events[0]["event"]
    assert outline_event["outline"]["recipe_chunk_count"] == 1


def test_freezone_plugin_finish_agent_catalog_draft_warns_structural_recipe_issues(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):  # noqa: ARG001
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_lint",
    }
    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 3}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {
            **base_args,
            "skill": {
                "id": "light-shadow-ad-video",
                "name": "光影广告短片",
                "input_parameters": [
                    {"id": "shot_count", "type": "number", "default": 6}
                ],
            },
        }
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {
            **base_args,
            "index": 0,
            "recipe": {
                "id": "anchor-assets",
                "name": "锚点资产",
                "output_kind": "image",
                "system_prompt": "输出两条提示词，分别生成角色锚点和道具锚点。",
            },
        }
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {
            **base_args,
            "index": 1,
            "recipe": {
                "id": "storyboard-plan",
                "name": "分镜图",
                "output_kind": "image",
                "system_prompt": "生成固定 9 宫格分镜草图。",
            },
        }
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {
            **base_args,
            "index": 2,
            "recipe": {
                "id": "audio-layer",
                "name": "音频层",
                "output_kind": "audio",
                "system_prompt": "生成配音和音效，并把所有视频和音频合成为最终成片。",
            },
        }
    )

    handlers["freezone_finish_agent_catalog_draft"](base_args)

    warnings = pending_events[-1]["event"]["warnings"]
    assert any("可能一次生成多个执行节点" in warning for warning in warnings)
    assert any("固定了九宫格" in warning for warning in warnings)
    assert any("音频输出" in warning and "最终合成" in warning for warning in warnings)


def test_freezone_plugin_chunked_draft_skill_result_directs_first_recipe_before_finish(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )

    handlers["freezone_put_agent_catalog_draft_outline"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "reuse_goal": "公益短片工作流",
            "stages": [
                {
                    "id": f"recipe-{index}",
                    "recipe_id": f"recipe-{index}",
                    "reuse": "new",
                    "new_recipe_craft_gap": "现有 Recipe 缺少该阶段的输入结构和输出结构。",
                }
                for index in range(5)
            ],
            "expected_recipe_count": 5,
            "catalog_checked": True,
        }
    )
    handlers["freezone_begin_agent_catalog_draft"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "expected_recipe_count": 5,
        }
    )
    result = handlers["freezone_put_agent_catalog_skill"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "skill": {"id": "public-service-video", "description": "公益短片 Skill"},
        }
    )

    instruction = result["agent_instruction"]
    assert "下一步必须调用 freezone_put_agent_catalog_recipe" in instruction
    assert "当前进度：Skill 已提交；Recipe 已提交 0 / 5；剩余 5 个。" in instruction
    assert "Recipe 已提交 0 / 5" in instruction
    assert "剩余 5 个" in instruction
    assert "index=0" in instruction
    assert "不要用普通文本回复" in instruction
    assert "不要把工具调用、参数块或代码块写进聊天内容" in instruction
    assert "请直接调用对应工具" in instruction
    assert "现在不要调用 freezone_finish_agent_catalog_draft" in instruction


def test_freezone_plugin_chunked_draft_skill_without_recipes_directs_finish(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )

    handlers["freezone_put_agent_catalog_draft_outline"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "reuse_goal": "多阶段工作流",
            "stages": [
                {
                    "id": f"recipe-{index}",
                    "recipe_id": f"recipe-{index}",
                    "reuse": "existing",
                }
                for index in range(6)
            ],
            "expected_recipe_count": 0,
            "catalog_checked": True,
        }
    )
    handlers["freezone_begin_agent_catalog_draft"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "expected_recipe_count": 0,
        }
    )
    result = handlers["freezone_put_agent_catalog_skill"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "skill": {"id": "public-service-video", "description": "公益短片 Skill"},
        }
    )

    instruction = result["agent_instruction"]
    assert "本次不需要提交 Recipe" in instruction
    assert "下一步必须调用 freezone_finish_agent_catalog_draft" in instruction
    assert "freezone_put_agent_catalog_recipe" not in instruction


def test_freezone_plugin_chunked_draft_recipe_progress_without_expected_count_avoids_fake_total(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    handlers["freezone_begin_agent_catalog_draft"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
        }
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "index": 0,
            "recipe": {"id": "story-outline", "name": "故事大纲"},
        }
    )

    assert pending_events[-1]["event"]["message"] == "已生成第 1 个 Recipe"
    assert "recipe_count" not in pending_events[-1]["event"]


def test_freezone_plugin_chunked_draft_recipe_result_directs_next_recipe_before_finish(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )

    handlers["freezone_put_agent_catalog_draft_outline"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "reuse_goal": "多阶段工作流",
            "stages": [
                {
                    "id": f"recipe-{index}",
                    "recipe_id": f"recipe-{index}",
                    "reuse": "new",
                    "new_recipe_craft_gap": "现有 Recipe 缺少该阶段的输入结构和输出结构。",
                }
                for index in range(6)
            ],
            "expected_recipe_count": 6,
            "catalog_checked": True,
        }
    )
    handlers["freezone_begin_agent_catalog_draft"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "mode": "create",
            "expected_recipe_count": 6,
        }
    )
    for index in range(4):
        handlers["freezone_put_agent_catalog_recipe"](
            {
                "project_id": "project-a",
                "canvas_id": "canvas-a",
                "skill_studio_session_id": "skill_studio_01",
                "index": index,
                "recipe": {"id": f"recipe-{index}", "name": f"Recipe {index}"},
            }
        )
    result = handlers["freezone_put_agent_catalog_recipe"](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "skill_studio_session_id": "skill_studio_01",
            "index": 4,
            "recipe": {"id": "audio-layer", "name": "音频层"},
        }
    )

    instruction = result["agent_instruction"]
    assert "剩余 1 个" in instruction
    assert "freezone_put_agent_catalog_recipe" in instruction
    assert "index=5" in instruction
    assert "不要用普通文本回复" in instruction
    assert "不要把工具调用、参数块或代码块写进聊天内容" in instruction
    assert "请直接调用对应工具" in instruction
    assert "不要调用 skill_view" in instruction
    assert "不要处理斜杠命令" in instruction
    assert "现在不要调用 freezone_finish_agent_catalog_draft" in instruction


def test_freezone_plugin_chunked_draft_revision_preserves_unchanged_recipes(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {
            "ok": True,
            "status": "skill_studio_frontend_result",
            "tool_call_status": "completed",
            "skill_studio_status": "answered",
            "bridge_key": key,
        }

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_01",
    }
    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 2}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {**base_args, "skill": {"id": "public-service-video"}}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {**base_args, "index": 0, "recipe": {"id": "story-outline"}}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {**base_args, "index": 1, "recipe": {"id": "video-render"}}
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "edit", "expected_recipe_count": 2}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {**base_args, "index": 1, "recipe": {"id": "video-render-v2"}}
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    draft_events = [
        item["event"]
        for item in pending_events
        if item["event"]["type"] == "skill_studio.draft"
    ]
    assert [recipe["id"] for recipe in draft_events[-1]["recipes"]] == [
        "story-outline",
        "video-render-v2",
    ]


def test_freezone_plugin_patch_draft_skill_keywords_preserves_recipes(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_patch",
    }
    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 2}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {
            **base_args,
            "skill": {
                "id": "public-service-video",
                "triggers": {"keywords": ["公益短片", "公益广告"]},
            },
        }
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {**base_args, "index": 0, "recipe": {"id": "story-outline"}}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {**base_args, "index": 1, "recipe": {"id": "video-render"}}
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "edit", "expected_recipe_count": 2}
    )
    patched = handlers["freezone_patch_agent_catalog_draft"](
        {
            **base_args,
            "target": "skill",
            "patch": [
                {
                    "op": "replace",
                    "path": "/triggers/keywords",
                    "value": ["公益短片", "公益视频"],
                }
            ],
        }
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    assert patched["ok"] is True
    assert patched["status"] == "draft_patch_applied"
    assert patched["agent_instruction"].startswith(
        "下一步必须调用 freezone_finish_agent_catalog_draft"
    )
    assert (
        "更新后的完整草稿必须通过 finish 工具重新展示给用户"
        in patched["agent_instruction"]
    )
    assert pending_events[-2]["event"]["message"] == "已更新 Skill 触发关键词"
    assert pending_events[-2]["event"]["debug"]["agent_instruction"].startswith(
        "下一步必须调用 freezone_finish_agent_catalog_draft"
    )
    draft_events = [
        item["event"]
        for item in pending_events
        if item["event"]["type"] == "skill_studio.draft"
    ]
    assert draft_events[-1]["skill"]["triggers"]["keywords"] == ["公益短片", "公益视频"]
    assert [recipe["id"] for recipe in draft_events[-1]["recipes"]] == [
        "story-outline",
        "video-render",
    ]


def test_freezone_plugin_patch_draft_recipe_system_prompt_by_recipe_id(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_patch_recipe",
    }
    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 2}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {**base_args, "skill": {"id": "public-service-video"}}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {
            **base_args,
            "index": 0,
            "recipe": {"id": "story-outline", "system_prompt": "旧大纲提示词"},
        }
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {
            **base_args,
            "index": 1,
            "recipe": {"id": "video-script", "system_prompt": "旧脚本提示词"},
        }
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "edit", "expected_recipe_count": 2}
    )
    patched = handlers["freezone_patch_agent_catalog_draft"](
        {
            **base_args,
            "target": "recipe",
            "recipe_id": "video-script",
            "patch": [
                {"op": "replace", "path": "/system_prompt", "value": "新脚本提示词"}
            ],
        }
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    assert patched["ok"] is True
    assert pending_events[-2]["event"]["message"] == "已更新 Recipe：video-script"
    draft_events = [
        item["event"]
        for item in pending_events
        if item["event"]["type"] == "skill_studio.draft"
    ]
    assert [recipe["system_prompt"] for recipe in draft_events[-1]["recipes"]] == [
        "旧大纲提示词",
        "新脚本提示词",
    ]


def test_freezone_plugin_patch_draft_removes_entire_recipe_by_recipe_id(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_patch_remove_recipe",
    }
    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 2}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {**base_args, "skill": {"id": "public-service-video"}}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {**base_args, "index": 0, "recipe": {"id": "story-outline"}}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {**base_args, "index": 1, "recipe": {"id": "video-script"}}
    )

    result = handlers["freezone_patch_agent_catalog_draft"](
        {
            **base_args,
            "target": "recipe",
            "recipe_id": "video-script",
            "patch": [{"op": "remove", "path": ""}],
        }
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    assert result["ok"] is True
    assert result["removed"] is True
    assert pending_events[-2]["event"]["message"] == "已移除 Recipe：video-script"
    draft_events = [
        item["event"]
        for item in pending_events
        if item["event"]["type"] == "skill_studio.draft"
    ]
    assert [recipe["id"] for recipe in draft_events[-1]["recipes"]] == ["story-outline"]


def test_freezone_plugin_patch_draft_invalid_path_does_not_mutate(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_patch_invalid",
    }
    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 0}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {
            **base_args,
            "skill": {
                "id": "public-service-video",
                "triggers": {"keywords": ["公益短片", "公益广告"]},
            },
        }
    )

    result = handlers["freezone_patch_agent_catalog_draft"](
        {
            **base_args,
            "target": "skill",
            "patch": [
                {"op": "replace", "path": "/triggers/missing/0", "value": "公益视频"}
            ],
        }
    )
    finished = handlers["freezone_finish_agent_catalog_draft"](base_args)

    assert result["ok"] is False
    assert result["status"] == "draft_patch_failed"
    assert finished["ok"] is True
    draft_events = [
        item["event"]
        for item in pending_events
        if item["event"]["type"] == "skill_studio.draft"
    ]
    assert draft_events[-1]["skill"]["triggers"]["keywords"] == ["公益短片", "公益广告"]


def test_freezone_plugin_patch_draft_rejects_recipe_root_path_with_guidance(
    monkeypatch,
):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_patch_recipe_path",
    }
    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 1}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {**base_args, "skill": {"id": "public-service-video"}}
    )
    handlers["freezone_put_agent_catalog_recipe"](
        {
            **base_args,
            "index": 0,
            "recipe": {
                "id": "public-welfare-storyboard-images",
                "must_have_items": ["旧字段"],
            },
        }
    )

    result = handlers["freezone_patch_agent_catalog_draft"](
        {
            **base_args,
            "target": "recipe",
            "recipe_id": "public-welfare-storyboard-images",
            "patch": [
                {
                    "op": "replace",
                    "path": "/recipes/public-welfare-storyboard-images/must_have_items",
                    "value": ["新字段"],
                }
            ],
        }
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    assert result["ok"] is False
    assert result["status"] == "draft_patch_failed"
    assert "target=recipe" in result["error"]
    assert "/must_have_items" in result["error"]
    assert (
        "/recipes/public-welfare-storyboard-images/must_have_items" in result["error"]
    )
    draft_events = [
        item["event"]
        for item in pending_events
        if item["event"]["type"] == "skill_studio.draft"
    ]
    assert draft_events[-1]["recipes"][0]["must_have_items"] == ["旧字段"]


def test_freezone_plugin_patch_draft_removes_keyword_list_item(monkeypatch):
    plugin = _load_plugin_module()
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    pending_events = []

    def fake_bridge_key(*, project_id, canvas_id, event):
        return f"skill-studio-{len(pending_events) + 1}"

    def fake_put_pending_event(**kwargs):
        pending_events.append(kwargs)

    def fake_wait_result(key, timeout_seconds):  # noqa: ARG001
        return {"ok": True, "bridge_key": key, "skill_studio_status": "answered"}

    monkeypatch.setattr(plugin, "skill_studio_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_skill_studio_event", fake_put_pending_event
    )
    monkeypatch.setattr(plugin, "wait_skill_studio_result", fake_wait_result)

    base_args = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "skill_studio_session_id": "skill_studio_patch_remove",
    }
    handlers["freezone_begin_agent_catalog_draft"](
        {**base_args, "mode": "create", "expected_recipe_count": 0}
    )
    handlers["freezone_put_agent_catalog_skill"](
        {
            **base_args,
            "skill": {
                "id": "public-service-video",
                "triggers": {"keywords": ["公益短片", "公益广告", "纪录片"]},
            },
        }
    )
    result = handlers["freezone_patch_agent_catalog_draft"](
        {
            **base_args,
            "target": "skill",
            "patch": [{"op": "remove", "path": "/triggers/keywords/1"}],
        }
    )
    handlers["freezone_finish_agent_catalog_draft"](base_args)

    assert result["ok"] is True
    draft_events = [
        item["event"]
        for item in pending_events
        if item["event"]["type"] == "skill_studio.draft"
    ]
    assert draft_events[-1]["skill"]["triggers"]["keywords"] == ["公益短片", "纪录片"]


def test_freezone_plugin_skill_studio_tool_schemas_expose_nested_contracts():
    plugin = _load_plugin_module()
    schemas = {name: schema for name, schema, _handler in plugin.TOOLS}

    clarification_schema = schemas["freezone_request_user_clarification"]["parameters"]
    clarification_description = schemas["freezone_request_user_clarification"][
        "description"
    ]
    clarification_question_item = clarification_schema["properties"]["questions"][
        "items"
    ]
    clarification_option_item = clarification_question_item["properties"]["options"][
        "items"
    ]
    draft_schema = schemas["freezone_present_agent_catalog_draft"]["parameters"]
    begin_schema = schemas["freezone_begin_agent_catalog_draft"]["parameters"]
    put_recipe_schema = schemas["freezone_put_agent_catalog_recipe"]["parameters"]
    outline_schema = schemas["freezone_put_agent_catalog_draft_outline"]["parameters"]
    patch_schema = schemas["freezone_patch_agent_catalog_draft"]["parameters"]
    patch_description = schemas["freezone_patch_agent_catalog_draft"]["description"]
    finish_schema = schemas["freezone_finish_agent_catalog_draft"]["parameters"]
    finish_description = schemas["freezone_finish_agent_catalog_draft"]["description"]
    skill_schema = draft_schema["properties"]["skill"]
    recipe_item = draft_schema["properties"]["recipes"]["items"]
    input_parameter_schema = skill_schema["properties"]["input_parameters"]["items"]

    assert "including Skill Studio setup questions" in clarification_description
    assert "decide the next step from the current context" in clarification_description
    assert (
        "Ask only the questions needed for the next decision"
        in clarification_schema["properties"]["questions"]["description"]
    )
    assert (
        "exactly one question"
        not in clarification_schema["properties"]["questions"]["description"]
    )
    assert "freezone_present_skill_studio_questions" not in schemas
    assert clarification_schema["required"] == ["questions"]
    assert (
        "Freezone will generate it automatically"
        in clarification_schema["properties"]["clarification_id"]["description"]
    )
    assert "skill_studio_session_id" in clarification_schema["properties"]
    assert clarification_question_item["required"] == ["id", "title", "options"]
    assert clarification_option_item["required"] == ["id", "label"]
    assert "Do not include Recipe drafts inside skill" in skill_schema["description"]
    patch_field_description = patch_schema["properties"]["patch"]["description"]
    assert "Top-level field name must be patch" in patch_field_description
    assert "do not use operation, operations, or patches" in patch_field_description
    assert 'patch=[{"op":"remove","path":""}]' in patch_field_description
    assert (
        "top-level recipes parameter"
        in draft_schema["properties"]["recipes"]["description"]
    )
    outline_stage_schema = outline_schema["properties"]["stages"]["items"]
    assert (
        "neutral craft/stage id"
        in outline_stage_schema["properties"]["id"]["description"]
    )
    assert (
        "operation or output shape only"
        in outline_stage_schema["properties"]["name"]["description"]
    )
    assert (
        "reusable craft-level Recipe id"
        in outline_stage_schema["properties"]["recipe_id"]["description"]
    )
    assert (
        "same input object, processing action, output shape"
        in outline_stage_schema["properties"]["reuse"]["description"]
    )
    assert (
        "workflow responsibility"
        in outline_stage_schema["properties"]["reuse"]["description"]
    )
    assert (
        "output_kind matches"
        in outline_stage_schema["properties"]["reuse"]["description"]
    )
    assert (
        "Do not cite style/theme/brand/aesthetic difference"
        in outline_stage_schema["properties"]["reason"]["description"]
    )
    assert (
        "Do not write only 'same craft'"
        in outline_stage_schema["properties"]["reason"]["description"]
    )
    assert (
        "Do not include the current Skill's visual style"
        in outline_stage_schema["properties"]["new_recipe_craft_gap"]["description"]
    )
    assert (
        "generic generation/enhancement Recipe is insufficient"
        in outline_stage_schema["properties"]["new_recipe_craft_gap"]["description"]
    )
    assert begin_schema["required"] == [
        "skill_studio_session_id",
        "mode",
        "expected_recipe_count",
    ]
    assert put_recipe_schema["required"] == ["skill_studio_session_id", "recipe"]
    assert patch_schema["required"] == ["skill_studio_session_id", "target", "patch"]
    assert patch_schema["properties"]["target"]["enum"] == ["skill", "recipe"]
    assert "local edits" in patch_description
    assert "recipe_id" in patch_schema["properties"]
    assert "target=recipe" in patch_schema["properties"]["patch"]["description"]
    assert (
        "/system_prompt"
        in patch_schema["properties"]["patch"]["items"]["properties"]["path"][
            "description"
        ]
    )
    assert (
        "/recipes/"
        in patch_schema["properties"]["patch"]["items"]["properties"]["path"][
            "description"
        ]
    )
    assert "Do not pass the full Skill/Recipe catalog" in finish_description
    assert "skill" not in finish_schema["properties"]
    assert "recipes" not in finish_schema["properties"]
    assert skill_schema["required"] == [
        "id",
        "name",
        "schema_version",
        "version",
        "description",
        "category",
        "triggers",
        "planning",
        "evaluation",
        "allowed_recipe_ids",
    ]
    assert input_parameter_schema["required"] == ["id", "label", "type", "required"]
    assert input_parameter_schema["properties"]["type"]["enum"] == [
        "single_select",
        "multi_select",
        "text",
        "number",
        "boolean",
    ]
    assert skill_schema["properties"]["triggers"]["required"] == [
        "keywords",
        "node_scopes",
    ]
    assert skill_schema["properties"]["triggers"]["properties"]["node_scopes"]["items"][
        "enum"
    ] == [
        "textGeneration",
        "imageGeneration",
        "videoGeneration",
        "audioGeneration",
    ]
    assert "workflow_templates" not in skill_schema["properties"]
    assert (
        "videoCompose"
        not in skill_schema["properties"]["triggers"]["properties"]["node_scopes"][
            "items"
        ]["enum"]
    )
    assert skill_schema["properties"]["planning"]["required"] == [
        "planning_notes",
        "prompt_guide",
        "conduct_rules",
    ]
    assert (
        "executable path summary"
        in skill_schema["properties"]["planning"]["properties"]["planning_notes"][
            "description"
        ]
    )
    assert (
        "hard execution rules"
        in skill_schema["properties"]["planning"]["properties"]["conduct_rules"][
            "description"
        ]
    )
    assert (
        "model_preferences" not in skill_schema["properties"]["planning"]["properties"]
    )
    assert (
        "default_aspect_ratios"
        not in skill_schema["properties"]["planning"]["properties"]
    )
    assert skill_schema["properties"]["evaluation"]["required"] == [
        "rating_bands",
        "quality_threshold",
        "domain_constraints",
        "visual_review_items",
        "text_review_items",
    ]
    assert recipe_item["required"] == [
        "id",
        "name",
        "output_kind",
        "action_keys",
        "system_prompt",
        "must_have_items",
        "planning_prompt",
        "result_summary",
        "requires_source_media",
    ]
    recipe_system_prompt_description = recipe_item["properties"]["system_prompt"][
        "description"
    ]
    assert (
        "must never be the final downstream prompt itself"
        in recipe_system_prompt_description
    )
    assert "重要：你的输出是一条提示词/指令" in recipe_system_prompt_description
    assert recipe_item["properties"]["output_kind"]["enum"] == [
        "text",
        "image",
        "video",
        "audio",
    ]
    legacy_system_prompt_key = "system" + "Prompt"
    assert legacy_system_prompt_key not in json.dumps(recipe_item, ensure_ascii=False)
    legacy_recipe_keys = [
        "required" + "_elements",
        "planner" + "_cue",
        "output" + "_summary",
        "needs" + "_multimodal_input",
    ]
    for legacy_key in legacy_recipe_keys:
        assert legacy_key not in recipe_item["properties"]
    system_prompt_description = recipe_item["properties"]["system_prompt"][
        "description"
    ]
    assert "节点" in system_prompt_description
    assert "提示词/指令" in system_prompt_description
    assert "不要直接生成最终内容" in system_prompt_description
    assert "送入对应节点" in system_prompt_description
    assert "终端生成型" not in system_prompt_description
    assert "不要把所有 Recipe 都写成 prompt compiler" not in system_prompt_description
    assert "角色设定" in system_prompt_description
    assert "输出结构" in system_prompt_description
    assert "禁止事项" in system_prompt_description
    planning_prompt_description = recipe_item["properties"]["planning_prompt"][
        "description"
    ]
    result_summary_description = recipe_item["properties"]["result_summary"][
        "description"
    ]
    assert "short business description" in planning_prompt_description
    assert "根据 X" in planning_prompt_description
    assert "Do not describe scheduling mechanics" in planning_prompt_description
    assert "short business description" in result_summary_description
    assert "Do not mention downstream execution" in result_summary_description


def test_freezone_get_workflow_skill_includes_current_user_agent_config(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setenv("DRAMACLAW_USER", "alice")

    def fake_list_user_agent_config_items(username, kind):
        assert username == "alice"
        if kind == "skills":
            return [
                {
                    "id": "custom-fruit-ad",
                    "name": "自定义水果广告",
                    "description": "用户导入的水果广告工作流",
                    "_catalog_source": "user",
                    "triggers": {"keywords": ["水果广告"]},
                    "allowed_recipe_ids": ["custom-fruit-outline"],
                }
            ]
        if kind == "recipes":
            return [
                {
                    "id": "custom-fruit-outline",
                    "name": "水果广告创意",
                    "_catalog_source": "user",
                    "generationType": "text",
                    "system_prompt": "输出一条提示词/指令。",
                }
            ]
        raise AssertionError(kind)

    monkeypatch.setattr(
        catalog, "list_user_agent_config_items", fake_list_user_agent_config_items
    )

    package = catalog.get_workflow_skill({"skill_id": "custom-fruit-ad"})

    assert package["ok"] is True
    assert package["skill_id"] == "custom-fruit-ad"
    assert package["source"] == "user"


def test_freezone_catalog_username_uses_local_for_ce(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("DRAMACLAW_USER", "dengyuxuan")
    monkeypatch.setenv("SUPERTALE_USER", "dengyuxuan")
    monkeypatch.setenv("USER", "tao")

    assert catalog._catalog_username() == "local"


def test_freezone_catalog_username_uses_login_user_for_supertale(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("DRAMACLAW_USER", "dengyuxuan")
    monkeypatch.setenv("USER", "tao")

    assert catalog._catalog_username() == "dengyuxuan"


def test_freezone_canvas_command_slim_result_omits_large_details():
    plugin = _load_plugin_module()

    summary = plugin._summarize_canvas_command_result(
        {
            "ok": True,
            "tool_call_status": "completed",
            "canvas_apply_status": "applied",
            "applied": True,
            "cancelled": False,
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "applied_count": 2,
            "opened_ui_actions": 0,
            "created_node_ids": ["node-a", "node-b"],
            "command_results": [{"very": "large"}],
            "message": "Frontend executor applied the canvas command.",
        },
        bridge_key="bridge-a",
        commands=[
            {
                "type": "create_node",
                "client_id": "outline",
                "node_type": "textAnnotationNode",
                "data": {"displayName": "生成广告创意大纲"},
            },
            {"type": "create_edge"},
            {
                "type": "create_node",
                "client_id": "storyboard",
                "node_type": "imageGenNode",
                "data": {"displayName": "多宫格分镜图"},
            },
        ],
    )

    assert summary["ok"] is True
    assert summary["created_node_count"] == 2
    assert summary["command_counts"] == {"create_node": 2, "create_edge": 1}
    assert summary["created_nodes"] == [
        {
            "client_id": "outline",
            "node_type": "textAnnotationNode",
            "displayName": "生成广告创意大纲",
        },
        {
            "client_id": "storyboard",
            "node_type": "imageGenNode",
            "displayName": "多宫格分镜图",
        },
    ]
    assert "copy every non-empty displayName" in summary["agent_instruction"]
    assert "created_node_ids" not in summary
    assert "command_results" not in summary


def test_freezone_canvas_command_slim_result_reports_background_acceptance():
    plugin = _load_plugin_module()

    summary = plugin._summarize_canvas_command_result(
        {
            "ok": True,
            "tool_call_status": "completed",
            "canvas_apply_status": "accepted",
            "applied": True,
            "cancelled": False,
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "message": "Frontend accepted the canvas workflow for background execution.",
        },
        bridge_key="bridge-workflow",
        commands=[{"type": "run_workflow", "scope": "canvas"}],
    )

    assert summary["ok"] is True
    assert summary["canvas_apply_status"] == "accepted"
    assert "workflow was accepted" in summary["agent_instruction"]
    assert "continuing on the canvas" in summary["agent_instruction"]
    assert "do not call freezone_run_workflow again" in summary["agent_instruction"]
    assert "Do not claim generation is complete" in summary["agent_instruction"]


def test_freezone_canvas_command_slim_result_reports_node_action_submission():
    plugin = _load_plugin_module()

    summary = plugin._summarize_canvas_command_result(
        {
            "ok": True,
            "tool_call_status": "completed",
            "canvas_apply_status": "accepted",
            "applied": True,
            "cancelled": False,
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "message": "Canvas command was submitted to the canvas.",
        },
        bridge_key="bridge-node-action",
        commands=[
            {
                "type": "run_node_action",
                "node_id": "image-node",
                "action": "run_matting_tool",
            }
        ],
    )

    assert summary["ok"] is True
    assert summary["canvas_apply_status"] == "accepted"
    assert "submitted to the canvas" in summary["agent_instruction"]
    assert "do not say a tool was opened" in summary["agent_instruction"]
    assert "run nodes manually" not in summary["agent_instruction"]


def test_freezone_canvas_command_slim_result_reports_open_node_action_as_opened_panel():
    plugin = _load_plugin_module()

    summary = plugin._summarize_canvas_command_result(
        {
            "ok": True,
            "tool_call_status": "completed",
            "canvas_apply_status": "applied",
            "applied": True,
            "cancelled": False,
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "message": "Frontend executor applied the canvas command.",
        },
        bridge_key="bridge-open-light",
        commands=[
            {
                "type": "run_node_action",
                "node_id": "image-node",
                "action": "open_light_tool",
            }
        ],
    )

    assert summary["ok"] is True
    assert "panel has been opened" in summary["agent_instruction"]
    assert "processing" in summary["agent_instruction"]
    assert "submitted for generation" in summary["agent_instruction"]


def test_freezone_single_write_commands_request_slim_result(monkeypatch):
    plugin = _load_plugin_module()
    captured: dict[str, object] = {}

    def fake_emit_canvas_commands(project, canvas, commands, **kwargs):
        captured.update(
            {
                "project": project,
                "canvas": canvas,
                "commands": commands,
                "kwargs": kwargs,
            }
        )
        return {"ok": True}

    monkeypatch.setattr(plugin, "_emit_canvas_commands", fake_emit_canvas_commands)

    result = plugin._handle_delete_nodes(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "node_ids": ["node-a", "node-b"],
        }
    )

    assert result == {"ok": True}
    assert captured["commands"] == [
        {"type": "delete_nodes", "node_ids": ["node-a", "node-b"]}
    ]
    assert captured["kwargs"]["slim_result"] is True


def test_freezone_delete_nodes_can_clear_canvas_without_agent_listing_ids(monkeypatch):
    plugin = _load_plugin_module()
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        plugin,
        "_resolve_canvas_scope_for_write",
        lambda project, canvas: ("project-a", "canvas-a", None),
    )
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda method, path, **kwargs: {
            "ok": True,
            "data": {"nodes": [{"id": "node-a"}, {"id": "node-b"}]},
        },
    )

    def fake_emit_canvas_commands(project, canvas, commands, **kwargs):
        captured.update(
            {
                "project": project,
                "canvas": canvas,
                "commands": commands,
                "kwargs": kwargs,
            }
        )
        return {"ok": True}

    monkeypatch.setattr(plugin, "_emit_canvas_commands", fake_emit_canvas_commands)

    result = plugin._handle_delete_nodes({"scope": "canvas"})

    assert result == {"ok": True}
    assert captured == {
        "project": "project-a",
        "canvas": "canvas-a",
        "commands": [{"type": "delete_nodes", "node_ids": ["node-a", "node-b"]}],
        "kwargs": {"slim_result": True},
    }


def test_freezone_delete_nodes_clear_canvas_is_idempotent(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setattr(
        plugin,
        "_resolve_canvas_scope_for_write",
        lambda project, canvas: ("project-a", "canvas-a", None),
    )
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda method, path, **kwargs: {"ok": True, "data": {"nodes": []}},
    )

    result = plugin._handle_delete_nodes({"scope": "canvas"})

    assert result["ok"] is True
    assert result["canvas_apply_status"] == "already_empty"
    assert result["deleted_node_count"] == 0


def test_freezone_plugin_create_node_schema_hides_internal_node_types():
    plugin = _load_plugin_module()
    create_node_tool = next(
        (
            schema
            for name, schema, _handler in plugin.TOOLS
            if name == "freezone_create_node"
        ),
        None,
    )
    add_next_tool = next(
        (
            schema
            for name, schema, _handler in plugin.TOOLS
            if name == "freezone_add_next_node"
        ),
        None,
    )
    emit_tool = next(
        (
            schema
            for name, schema, _handler in plugin.TOOLS
            if name == "freezone_emit_canvas_command"
        ),
        None,
    )
    group_tool = next(
        (
            schema
            for name, schema, _handler in plugin.TOOLS
            if name == "freezone_group_nodes"
        ),
        None,
    )

    assert create_node_tool is not None
    assert add_next_tool is not None
    assert emit_tool is not None
    assert group_tool is not None
    enum_values = create_node_tool["parameters"]["properties"]["node_type"]["enum"]
    add_next_enum_values = add_next_tool["parameters"]["properties"]["node_type"][
        "enum"
    ]
    command_variants = emit_tool["parameters"]["properties"]["commands"]["items"][
        "oneOf"
    ]
    create_command = next(
        variant
        for variant in command_variants
        if variant["properties"]["type"].get("enum") == ["create_node"]
        and "imageGenNode" in variant["properties"]["node_type"]["enum"]
    )
    emit_enum_values = [
        "textAnnotationNode",
        *create_command["properties"]["node_type"]["enum"],
    ]

    assert "imageGenNode" in enum_values
    assert "uploadNode" in enum_values
    assert "groupNode" not in enum_values
    assert "storyboardNode" not in enum_values
    assert "storyboardGenNode" not in enum_values
    assert "imageNode" not in enum_values
    assert "exportImageNode" not in enum_values
    assert "videoStoryNode" not in enum_values
    assert "skillNode" in enum_values
    assert (
        enum_values == create_node_tool["parameters"]["properties"]["nodeType"]["enum"]
    )
    assert add_next_enum_values == enum_values
    assert set(emit_enum_values) == set(enum_values)


def test_canvas_command_tools_expose_discriminated_minimal_schema():
    plugin = _load_plugin_module()
    schemas = {name: schema for name, schema, _handler in plugin.TOOLS}
    validate = schemas["freezone_validate_canvas_commands"]["parameters"]
    emit = schemas["freezone_emit_canvas_command"]["parameters"]

    assert validate["required"] == ["commands"]
    assert emit["required"] == ["commands"]
    assert validate["additionalProperties"] is False
    assert emit["additionalProperties"] is False
    assert set(validate["properties"]) == {"project_id", "canvas_id", "commands"}
    assert set(emit["properties"]) == {"project_id", "canvas_id", "commands"}

    variants = emit["properties"]["commands"]["items"]["oneOf"]
    assert len(variants) == 17
    by_type = {}
    for variant in variants:
        by_type.setdefault(variant["properties"]["type"]["enum"][0], []).append(variant)
    assert set(by_type) == plugin._COMMAND_TYPES
    assert all(variant["additionalProperties"] is False for variant in variants)
    create_annotation, create_other = by_type["create_node"]
    assert set(create_annotation["properties"]) == {
        "type",
        "client_id",
        "node_type",
        "position",
        "data",
    }
    assert create_annotation["required"] == ["type", "node_type", "data"]
    assert create_annotation["properties"]["node_type"]["enum"] == [
        "textAnnotationNode"
    ]
    assert create_annotation["properties"]["data"]["required"] == ["content"]
    assert create_annotation["properties"]["data"]["anyOf"] == [
        {"required": ["title"]},
        {"required": ["displayName"]},
    ]
    assert "textAnnotationNode" not in create_other["properties"]["node_type"]["enum"]
    assert [set(item["properties"]) for item in by_type["delete_edges"]] == [
        {"type", "edge_ids"},
        {"type", "pairs"},
    ]
    assert [set(item["properties"]) for item in by_type["move_nodes"]] == [
        {"type", "positions"},
        {"type", "deltas"},
    ]
    assert "direction" in by_type["run_workflow"][0]["properties"]


def test_canvas_command_tools_and_handlers_share_one_contract():
    plugin = _load_plugin_module()
    schemas = {name: schema for name, schema, _handler in plugin.TOOLS}

    validate_properties = schemas["freezone_validate_canvas_commands"]["parameters"][
        "properties"
    ]
    emit_properties = schemas["freezone_emit_canvas_command"]["parameters"][
        "properties"
    ]
    assert "canvasId" not in validate_properties
    assert "canvasId" not in emit_properties
    assert "body" not in validate_properties
    assert "body" not in emit_properties
    assert "envelope" not in validate_properties

    assert (
        plugin._validation_payload(
            {"canvasId": "old", "body": {"commands": [{"type": "x"}]}}
        )
        == {}
    )


def test_canvas_command_handlers_reject_legacy_scope_instead_of_using_defaults():
    plugin = _load_plugin_module()

    for handler in (
        plugin._handle_validate_commands,
        plugin._handle_emit_canvas_command,
    ):
        result = handler(
            {
                "project": "legacy-project",
                "canvasId": "second-canvas",
                "commands": [{"type": "run_workflow"}],
            }
        )

        assert result["ok"] is False
        assert result["status"] == "legacy_tool_argument_rejected"
        assert "canvasId" in result["error"]
        assert "project" in result["error"]


def test_agent_tool_scope_exposes_only_canonical_canvas_id():
    plugin = _load_plugin_module()

    for _name, schema, _handler in plugin.TOOLS:
        properties = schema["parameters"]["properties"]
        assert "canvasId" not in properties


def test_update_node_data_rejects_aliases_and_empty_payloads():
    plugin = _load_plugin_module()
    schema = next(
        schema
        for name, schema, _handler in plugin.TOOLS
        if name == "freezone_update_node_data"
    )["parameters"]

    assert schema["additionalProperties"] is False
    assert "nodeId" not in schema["properties"]
    assert schema["properties"]["data"]["minProperties"] == 1

    alias_result = plugin._handle_update_node_data(
        {"nodeId": "node-a", "data": {"content": "fixed"}}
    )
    assert alias_result["ok"] is False
    assert alias_result["status"] == "legacy_tool_argument_rejected"

    empty_result = plugin._handle_update_node_data({"node_id": "node-a", "data": {}})
    assert empty_result["ok"] is False
    assert empty_result["status"] == "data_required"


def test_canvas_command_schema_accepts_minimal_variants_and_rejects_union_shell():
    from jsonschema import Draft202012Validator
    from jsonschema.exceptions import ValidationError

    plugin = _load_plugin_module()
    schemas = {name: schema for name, schema, _handler in plugin.TOOLS}
    parameters = schemas["freezone_emit_canvas_command"]["parameters"]
    Draft202012Validator.check_schema(parameters)
    validator = Draft202012Validator(parameters)
    commands = [
        {
            "type": "create_node",
            "node_type": "textAnnotationNode",
            "data": {"title": "Fix", "content": "Apply the validated repair."},
        },
        {
            "type": "create_node",
            "node_type": "textAnnotationNode",
            "data": {
                "displayName": "Fix",
                "content": "Apply the validated repair.",
            },
        },
        {"type": "create_node", "node_type": "imageGenNode"},
        {"type": "add_next_node", "source_node_id": "node-1"},
        {"type": "update_node_data", "node_id": "node-1", "data": {"title": "Fixed"}},
        {"type": "delete_nodes", "node_ids": ["node-1"]},
        {"type": "delete_edges", "edge_ids": ["edge-1"]},
        {"type": "delete_edges", "pairs": [{"source": "node-1", "target": "node-2"}]},
        {
            "type": "create_edge",
            "source": "node-1",
            "target": "node-2",
            "link_type": "context_for",
        },
        {"type": "layout_nodes", "mode": "grid"},
        {"type": "group_nodes", "node_ids": ["node-1", "node-2"]},
        {"type": "move_nodes", "positions": {"node-1": {"x": 1, "y": 2}}},
        {"type": "move_nodes", "deltas": {"node-1": {"x": 1, "y": -1}}},
        {"type": "select_nodes", "node_ids": ["node-1"]},
        {"type": "run_node_action", "node_id": "node-1", "action": "generate"},
        {"type": "open_mainline_projection", "request": {"scope": "episode"}},
        {"type": "run_workflow", "scope": "canvas"},
    ]
    for command in commands:
        validator.validate({"commands": [command]})

    for command in (
        {"type": "run_workflow"},
        {"type": "run_workflow", "scope": "selection"},
        {"type": "run_workflow", "node_ids": []},
    ):
        with pytest.raises(ValidationError):
            validator.validate({"commands": [command]})

    union_shell = {
        "type": "create_node",
        "client_id": "retry_annotation",
        "node_type": "textAnnotationNode",
        "data": {},
        "node_id": "",
        "node_ids": [],
        "action": "",
        "parameters": {},
        "regenerate": False,
        "scope": "canvas",
        "source": "",
        "target": "",
        "link_type": "context_for",
        "request": {},
    }
    with pytest.raises(ValidationError):
        validator.validate({"commands": [union_shell]})


def test_freezone_mcp_default_create_node_uses_frontend_bridge(monkeypatch):
    plugin = _load_plugin_module()
    pending_commands = []

    monkeypatch.setenv(
        "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "/tmp/dramaclaw-test-bridge"
    )
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.delenv("DRAMACLAW_MCP_DIRECT_CANVAS_APPLY", raising=False)

    def fake_bridge_key(*, project_id, canvas_id, commands):
        assert project_id == "project-a"
        assert canvas_id == "canvas-a"
        assert commands[0]["type"] == "create_node"
        return "bridge-key-1"

    def fake_put_pending_canvas_command(**kwargs):
        pending_commands.append(kwargs)

    def fake_wait_canvas_command_result(key, **kwargs):
        assert key == "bridge-key-1"
        assert "bridge_dir" in kwargs
        return {
            "ok": True,
            "tool_call_status": "completed",
            "canvas_apply_status": "applied",
            "applied": True,
            "cancelled": False,
            "command_results": [{"type": "create_node", "status": "applied"}],
        }

    monkeypatch.setattr(plugin, "canvas_command_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_canvas_command", fake_put_pending_canvas_command
    )
    monkeypatch.setattr(
        plugin, "wait_canvas_command_result", fake_wait_canvas_command_result
    )

    result = plugin._handle_create_node(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "node_type": "videoNode",
            "data": {"displayName": "视频节点"},
        }
    )

    assert result["ok"] is True
    assert result["canvas_apply_status"] == "applied"
    assert pending_commands
    envelope = pending_commands[0]["envelope"]
    assert "auto_apply_after_mcp_approval" not in envelope
    assert envelope["agent_id"] == "main"
    assert envelope["external_mcp_command"] is True
    assert envelope["commands"][0]["type"] == "create_node"
    assert str(pending_commands[0]["bridge_dir"]) == "/tmp/dramaclaw-test-bridge"


def test_freezone_hermes_bridge_does_not_auto_apply_mcp_marker(monkeypatch):
    plugin = _load_plugin_module()
    pending_commands = []

    monkeypatch.delenv("DRAMACLAW_EXTERNAL_MCP", raising=False)
    monkeypatch.delenv("DRAMACLAW_MCP_DIRECT_CANVAS_APPLY", raising=False)

    def fake_bridge_key(*, project_id, canvas_id, commands):
        assert project_id == "project-a"
        assert canvas_id == "canvas-a"
        return "bridge-key-2"

    def fake_put_pending_canvas_command(**kwargs):
        pending_commands.append(kwargs)

    def fake_wait_canvas_command_result(key, **kwargs):
        assert key == "bridge-key-2"
        return {
            "ok": True,
            "tool_call_status": "completed",
            "canvas_apply_status": "applied",
            "applied": True,
            "cancelled": False,
            "command_results": [{"type": "create_node", "status": "applied"}],
        }

    monkeypatch.setattr(plugin, "canvas_command_bridge_key", fake_bridge_key)
    monkeypatch.setattr(
        plugin, "put_pending_canvas_command", fake_put_pending_canvas_command
    )
    monkeypatch.setattr(
        plugin, "wait_canvas_command_result", fake_wait_canvas_command_result
    )

    result = plugin._handle_create_node(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "node_type": "videoNode",
        }
    )

    assert result["ok"] is True
    envelope = pending_commands[0]["envelope"]
    assert "auto_apply_after_mcp_approval" not in envelope
    assert "agent_id" not in envelope
    assert "external_mcp_command" not in envelope


def test_freezone_codex_bridge_preserves_non_main_agent_scope(monkeypatch):
    plugin = _load_plugin_module()
    pending_commands = []

    monkeypatch.setenv(
        "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "/tmp/dramaclaw-test-bridge"
    )
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.setenv("DRAMACLAW_AGENT_PROFILE", "freezone:agent-2")
    monkeypatch.setattr(
        plugin, "canvas_command_bridge_key", lambda **_kwargs: "bridge-agent-2"
    )
    monkeypatch.setattr(
        plugin,
        "put_pending_canvas_command",
        lambda **kwargs: pending_commands.append(kwargs),
    )
    monkeypatch.setattr(
        plugin,
        "wait_canvas_command_result",
        lambda *_args, **_kwargs: {"ok": True, "canvas_apply_status": "applied"},
    )

    result = plugin._handle_create_node(
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "node_type": "videoNode",
        }
    )

    assert result["ok"] is True
    assert pending_commands[0]["envelope"]["agent_id"] == "agent-2"
    assert pending_commands[0]["envelope"]["external_mcp_command"] is True


def test_freezone_plugin_uses_frontend_link_type_catalog_values():
    plugin = _load_plugin_module()

    for tool_name in ("freezone_create_edge", "freezone_emit_canvas_command"):
        tool = next(
            (schema for name, schema, _handler in plugin.TOOLS if name == tool_name),
            None,
        )
        assert tool is not None
        schema_text = json.dumps(tool, ensure_ascii=False)
        assert "media_input_for" in schema_text
        assert "visual_reference_for" not in schema_text
        assert "source_media_for" not in schema_text


def test_freezone_plugin_mainline_projection_assets_schema_is_directional():
    plugin = _load_plugin_module()
    asset_tool = next(
        (
            schema
            for name, schema, _handler in plugin.TOOLS
            if name == "freezone_get_mainline_projection_assets"
        ),
        None,
    )

    assert asset_tool is not None
    schema_text = json.dumps(asset_tool, ensure_ascii=False)

    assert "Mainline -> canvas only" in schema_text
    assert "freezone_open_mainline_projection" in schema_text
    assert "asset_kinds" in schema_text
    assert "query" in schema_text
    assert "limit" in schema_text
    enum_values = asset_tool["parameters"]["properties"]["asset_kinds"]["items"]["enum"]
    assert "character" in enum_values
    assert "identity" not in enum_values
    assert "portrait" not in enum_values


def test_freezone_plugin_mainline_projection_assets_normalizes_people_to_character(
    monkeypatch,
):
    plugin = _load_plugin_module()
    captured: dict[str, object] = {}

    def fake_request_canvas_context_from_frontend(**kwargs):
        captured.update(kwargs)
        return json.dumps({"ok": True}, ensure_ascii=False)

    monkeypatch.setattr(
        plugin,
        "_request_canvas_context_from_frontend",
        fake_request_canvas_context_from_frontend,
    )
    asset_handler = next(
        handler
        for name, _schema, handler in plugin.TOOLS
        if name == "freezone_get_mainline_projection_assets"
    )
    result = asset_handler(
        {
            "asset_kinds": ["identity", "portrait", "character_identity", "prop"],
            "query": "陈默",
            "limit": 12,
        }
    )

    assert json.loads(result)["ok"] is True
    assert captured["requests"] == [
        {
            "type": "mainline_projection_assets",
            "asset_kinds": ["character", "prop"],
            "query": "陈默",
            "limit": 12,
        }
    ]


def test_freezone_plugin_registers_with_hermes_acp_toolset():
    plugin = _load_plugin_module()

    assert plugin.REGISTER_TOOLSETS == ("hermes-acp",)


def test_freezone_plugin_register_call_exposes_node_tools_on_hermes_acp():
    plugin = _load_plugin_module()
    calls = []

    class FakeContext:
        def register_tool(self, **kwargs):
            calls.append(kwargs)

    plugin.register(FakeContext())

    by_name = {call["name"]: call for call in calls}
    assert by_name["freezone_create_node"]["toolset"] == "hermes-acp"
    assert by_name["freezone_emit_canvas_command"]["toolset"] == "hermes-acp"
    assert len(calls) == len(plugin.TOOLS)

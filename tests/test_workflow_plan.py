from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import pytest

from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_plan import validate_workflow_plan

_MINIMAL_ECOMMERCE_SKILL = {
    "id": "ecommerce-product",
    "name": "电商产品图",
    "version": 6,
    "description": "测试用电商产品图 Skill",
    "enabled": True,
    "triggers": {"node_scopes": ["imageGeneration"]},
    "allowed_recipe_ids": [
        "ecommerce-ad-image",
        "general-image",
        "custom-shot-image",
    ],
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
    {
        "id": "general-video",
        "name": "通用视频",
        "version": 1,
        "enabled": True,
        "output_kind": "video",
        "requires_source_media": False,
    },
    {
        "id": "custom-shot-image",
        "name": "自定义分镜图",
        "version": 1,
        "enabled": True,
        "output_kind": "image",
        "requires_source_media": False,
    },
]


def _load_catalog_module():
    path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "novelvideo"
        / "freezone"
        / "agent_workflows"
        / "catalog.py"
    )
    spec = importlib.util.spec_from_file_location("test_dynamic_workflow_catalog", path)
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


def _install_real_builtin_catalog(monkeypatch, catalog) -> None:
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)


def test_standard_ecommerce_image_planner_omits_audio_video_and_compose(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "生成三张黑色运动相机电商图",
            "planner": {
                "mode": "standard",
                "deliverable": "images",
                "item_count": 3,
                "include_audio": True,
            },
        }
    )

    assert result["ok"] is True, result
    assert result["planner"]["include_audio"] is False
    node_types = {node["node_type"] for node in result["plan"]["nodes"]}
    assert "audioNode" not in node_types
    assert "videoNode" not in node_types
    assert "videoComposeNode" not in node_types


def test_social_content_campaign_builtin_skill_is_loadable(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {
            "skill_id": "social-content-campaign",
            "user_goal": "制作小红书配图",
            "compact": True,
        }
    )

    assert package["ok"] is True
    assert package["input_contract"]["resolved"]["aspect_ratio"] == "3:4"
    assert {recipe["id"] for recipe in package["available_recipes"]} == {
        "social-copywriting",
        "social-content-image",
        "social-xiaohongshu-image",
        "social-douyin-cover",
        "social-weibo-wechat-image",
        "social-ig-post",
    }


def test_social_content_image_count_controls_nodes_not_variants(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "social-content-campaign",
            "user_goal": "制作三张社交媒体配图",
            "items": [
                {
                    "id": f"social_image_{index}",
                    "title": f"社交配图 {index}",
                    "recipe_id": "social-content-image",
                }
                for index in range(1, 4)
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True, compiled
    image_nodes = [
        node
        for node in compiled["plan"]["nodes"]
        if node["node_type"] == "imageGenNode"
    ]
    assert len(image_nodes) == 3
    assert all("count" not in node["data"] for node in image_nodes)
    assert all(
        node["data"]["workflowCatalog"]["confirmedInputs"]["image_count"] == 3
        for node in image_nodes
    )


def test_standard_video_planner_distributes_target_duration_across_clips(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "制作一条 30 秒竖屏香水广告",
            "planner": {
                "mode": "standard",
                "deliverable": "video",
                "item_count": 5,
                "total_duration_seconds": 30,
                "include_audio": False,
                "units": [
                    {"title": f"镜头 {index}", "prompt": f"香水镜头 {index}"}
                    for index in range(1, 6)
                ],
            },
        }
    )

    assert result["ok"] is True
    video_nodes = [
        node for node in result["plan"]["nodes"] if node["node_type"] == "videoNode"
    ]
    assert len(video_nodes) == 5
    assert [node["data"]["durationSec"] for node in video_nodes] == [6, 6, 6, 6, 6]
    assert sum(node["data"]["durationSec"] for node in video_nodes) == 30


def test_custom_video_item_keeps_structured_or_prompt_duration(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "制作一条 30 秒竖屏香水广告",
            "items": [
                {
                    "id": "product_anchor",
                    "title": "商品参考图",
                    "prompt": "透明玻璃香水瓶",
                    "recipe_id": "general-image",
                },
                {
                    "id": "clip_explicit",
                    "title": "商品特写",
                    "prompt": "镜头缓慢推近香水瓶",
                    "duration_seconds": 7,
                    "recipe_id": "video-clip-generation",
                    "depends_on": ["product_anchor"],
                },
                {
                    "id": "clip_legacy",
                    "title": "品牌收尾",
                    "prompt": "香水瓶缓缓旋转，6秒，9:16竖屏",
                    "recipe_id": "video-clip-generation",
                    "depends_on": ["product_anchor"],
                },
            ],
            "include_audio": False,
            "include_compose": True,
        }
    )

    assert result["ok"] is True, result
    video_nodes = {
        node["id"]: node
        for node in result["plan"]["nodes"]
        if node["node_type"] == "videoNode"
    }
    assert video_nodes["clip_explicit"]["data"]["durationSec"] == 7
    assert video_nodes["clip_legacy"]["data"]["durationSec"] == 6
    assert (
        video_nodes["clip_legacy"]["data"]["workflowCatalog"]["promptBuilder"][
            "planItem"
        ]["duration_seconds"]
        == 6
    )


def test_dynamic_text_dependencies_gate_media_without_becoming_prompts(monkeypatch):
    catalog = _load_catalog_module()
    recipes = copy.deepcopy(_MINIMAL_ECOMMERCE_RECIPES)
    recipes.append(
        {
            "id": "general-text",
            "name": "通用文本",
            "version": 1,
            "enabled": True,
            "output_kind": "text",
            "requires_source_media": False,
        }
    )
    skill = copy.deepcopy(_MINIMAL_ECOMMERCE_SKILL)
    skill["allowed_recipe_ids"].extend(["general-text", "general-video"])
    skill["triggers"]["node_scopes"].append("videoGeneration")

    def fake_load_json_dir(path):
        if path == catalog._SKILLS_DIR:
            return [copy.deepcopy(skill)]
        if path == catalog._RECIPES_DIR:
            return copy.deepcopy(recipes)
        return []

    monkeypatch.setattr(catalog, "_load_json_dir", fake_load_json_dir)
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "先写商品 Brief，再生成商品主图",
            "items": [
                {
                    "id": "brief",
                    "title": "商品 Brief",
                    "recipe_id": "general-text",
                },
                {
                    "id": "outline",
                    "title": "商品大纲",
                    "recipe_id": "general-text",
                    "depends_on": ["brief"],
                },
                {
                    "id": "hero-image",
                    "title": "商品主图",
                    "recipe_id": "general-image",
                    "depends_on": ["outline"],
                },
                {
                    "id": "hero-video",
                    "title": "商品视频",
                    "recipe_id": "general-video",
                    "depends_on": ["hero-image"],
                },
            ],
            "include_compose": False,
        }
    )

    assert result["ok"] is True, result
    edges = {
        (edge["source"], edge["target"]): edge["link_type"]
        for edge in result["plan"]["edges"]
    }
    assert edges[("brief", "outline")] == "context_for"
    assert edges[("outline", "hero-image")] == "dependency_for"
    assert edges[("hero-image", "hero-video")] == "media_input_for"


def test_standard_skill_planners_expand_without_agent_authored_topology(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)
    skill_package = catalog.get_workflow_skill(
        {"skill_id": "ecommerce-ad", "user_goal": "生成电商广告"}
    )
    planning_contract = skill_package["planning_contract"]
    assert planning_contract["topology_modes"] == ["standard_planner", "custom_items"]
    assert planning_contract["requires_agent_authored_topology"] is False
    assert planning_contract["custom_items_require_agent_authored_topology"] is True
    assert planning_contract["requires_explicit_recipe_id"] is False
    assert planning_contract["custom_items_require_explicit_recipe_id"] is True

    expectations = {
        "ecommerce-ad": {"video-clip-generation", "general-audio"},
        "text-to-image-video": {"general-image", "general-video"},
        "video-tutorial": {"general-video", "general-audio"},
        "short-drama-quick": {"general-video", "drama-shot-voice"},
    }
    for skill_id, expected_recipe_ids in expectations.items():
        result = catalog.compile_workflow_intent(
            {
                "skill_id": skill_id,
                "user_goal": "生成一个两段式竖屏测试视频",
                "planner": {
                    "mode": "standard",
                    "item_count": 2,
                    "units": [
                        {
                            "title": "开场",
                            "prompt": "快速建立主题",
                            "narration": "先看核心内容。",
                        },
                        {
                            "title": "收尾",
                            "prompt": "完成信息收束",
                            "narration": "以上就是全部内容。",
                        },
                    ],
                },
            }
        )

        assert result["ok"] is True
        assert result["planner"] == {
            "mode": "deterministic_standard",
            "skill_id": skill_id,
            "deliverable": "video",
            "item_count": 2,
            "include_audio": skill_id != "text-to-image-video",
        }
        plan = result["plan"]
        assert plan["planner"] == result["planner"]
        recipe_ids = {
            node.get("data", {}).get("workflowCatalog", {}).get("recipeId")
            for node in plan["nodes"]
        }
        assert expected_recipe_ids <= recipe_ids
        assert catalog.validate_agent_workflow_plan(plan)["ok"] is True


def test_standard_skill_planner_uses_defaults_for_minimal_intent(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "生成一段赛博城市文生图生视频",
        }
    )

    assert result["ok"] is True
    assert result["planner"]["mode"] == "deterministic_standard"
    assert result["planner"]["item_count"] == 3
    assert result["planner"]["include_audio"] is False


def test_standard_audio_planner_rejects_missing_or_placeholder_narration(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    for narration in (None, "这是短剧的第一段旁白。"):
        unit = {"title": "开场", "prompt": "建立故事场景"}
        if narration is not None:
            unit["narration"] = narration
        result = catalog.compile_workflow_intent(
            {
                "skill_id": "short-drama-quick",
                "user_goal": "制作短剧",
                "include_audio": True,
                "planner": {
                    "mode": "standard",
                    "item_count": 1,
                    "include_audio": True,
                    "units": [unit],
                },
            }
        )
        assert result["ok"] is False
        assert result["errors"][0]["path"] == "planner.units.0.narration"
        # The rejection must be self-contained so the agent fixes the payload
        # instead of source-diving for the validation rules.
        assert "narration" in result["errors"][0]["hint"]
        assert "do NOT" in result["agent_instruction"]
        # Missing narration and placeholder narration are different mistakes and
        # must produce different messages: a real narration on another unit does
        # not satisfy the per-unit requirement, and the error has to say so.
        message = result["errors"][0]["message"]
        if narration is None:
            assert "missing narration" in message
            assert "EVERY unit" in message
        else:
            assert "placeholder" in message


def test_custom_items_take_precedence_over_standard_planner(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    result = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-ad",
            "user_goal": "只生成一张自定义商品图",
            "planner": {"mode": "standard", "item_count": 6},
            "include_compose": False,
            "items": [
                {
                    "id": "custom_image",
                    "title": "自定义商品图",
                    "prompt": "极简背景中的商品",
                    "recipe_id": "general-image",
                }
            ],
        }
    )

    assert result["ok"] is True
    assert "planner" not in result
    node_ids = {node["id"] for node in result["plan"]["nodes"]}
    assert node_ids == {"workflow_input", "custom_image"}


def _dynamic_plan(*, image_count: int = 1) -> dict:
    nodes = [
        {
            "id": "brief",
            "node_type": "textAnnotationNode",
            "stage": "input",
            "data": {"displayName": "用户需求", "content": "运动鞋电商图"},
        }
    ]
    edges = []
    for index in range(image_count):
        node_id = f"product_image_{index + 1}"
        nodes.append(
            {
                "id": node_id,
                "node_type": "imageGenNode",
                "stage": "image",
                "data": {
                    "displayName": f"商品图 {index + 1}",
                    "referenceImageUrl": "/static/product.png",
                    "workflowCatalog": {
                        "skillId": "ecommerce-product",
                        "recipeId": "ecommerce-ad-image",
                        "recipeVersion": "5",
                    },
                },
            }
        )
        edges.append({"source": "brief", "target": node_id, "link_type": "prompt_for"})
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.ecommerce-product",
        "skill": {"id": "ecommerce-product", "version": 6},
        "summary": f"{image_count} 张运动鞋电商图",
        "nodes": nodes,
        "edges": edges,
        "layout": {"direction": "left_to_right", "groups": []},
    }


def _use_parameterized_catalog(monkeypatch, catalog):
    def fake_list_user_agent_config_items(_username, kind):
        if kind == "skills":
            return [
                {
                    "id": "cinematic-short",
                    "triggers": {"node_scopes": ["textGeneration"]},
                    "allowed_recipe_ids": ["general-text"],
                    "input_parameters": [
                        {
                            "id": "duration",
                            "label": "成片时长",
                            "type": "single_select",
                            "required": True,
                            "default": "60",
                            "options": [
                                {"value": "60", "label": "60秒"},
                                {"value": "90", "label": "90秒"},
                            ],
                        },
                        {
                            "id": "execution_mode",
                            "label": "执行模式",
                            "type": "single_select",
                            "required": True,
                            "default": "auto",
                            "options": [
                                {"value": "auto", "label": "全自动"},
                                {"value": "manual", "label": "只创建画布"},
                            ],
                        },
                        {
                            "id": "aspect_ratio",
                            "label": "画幅比例",
                            "type": "single_select",
                            "required": False,
                            "default": "16:9",
                            "options": [
                                {"value": "16:9", "label": "16:9 横屏"},
                                {"value": "9:16", "label": "9:16 竖屏"},
                            ],
                        },
                    ],
                    "planning": {"planning_notes": "动态规划电影短片"},
                }
            ]
        if kind == "recipes":
            return [
                {
                    "id": "general-text",
                    "version": 1,
                    "output_kind": "text",
                    "system_prompt": "生成文本",
                }
            ]
        raise AssertionError(kind)

    monkeypatch.setattr(
        catalog, "list_user_agent_config_items", fake_list_user_agent_config_items
    )
    monkeypatch.setattr(catalog, "_catalog_username", lambda: "local")


def test_workflow_skill_package_supports_skill_without_template(monkeypatch):
    catalog = _load_catalog_module()

    def fake_list_user_agent_config_items(_username, kind):
        if kind == "skills":
            return [
                {
                    "id": "director-method",
                    "description": "没有固定模板的导演方法",
                    "triggers": {"node_scopes": ["imageGeneration"]},
                    "planning": {"planning_notes": "根据用户要求动态规划镜头"},
                    "allowed_recipe_ids": ["director-frame"],
                }
            ]
        if kind == "recipes":
            return [
                {
                    "id": "director-frame",
                    "name": "导演关键帧",
                    "version": 2,
                    "output_kind": "image",
                    "planning_prompt": "生成关键帧",
                    "result_summary": "关键帧图片",
                }
            ]
        raise AssertionError(kind)

    monkeypatch.setattr(
        catalog, "list_user_agent_config_items", fake_list_user_agent_config_items
    )
    monkeypatch.setattr(catalog, "_catalog_username", lambda: "local")

    package = catalog.get_workflow_skill(
        {"skill_id": "director-method", "user_goal": "规划 8 个镜头"}
    )

    assert package["ok"] is True
    assert "workflow_templates" not in package["skill"]
    assert package["allowed_node_types"] == ["imageGenNode"]
    assert "director-frame" in {recipe["id"] for recipe in package["available_recipes"]}
    assert package["planning_contract"]["strict_validation"] is True


def test_dynamic_item_supports_ordered_recipe_pipeline(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "先按通用构图，再按自定义分镜方法生成商品图",
            "items": [
                {
                    "id": "hero-shot",
                    "title": "商品英雄镜头",
                    "recipe_id": "general-image",
                    "recipe_pipeline": ["custom-shot-image", "general-image"],
                }
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True
    workflow_catalog = compiled["plan"]["nodes"][1]["data"]["workflowCatalog"]
    assert workflow_catalog["recipeId"] == "general-image"
    assert workflow_catalog["recipeName"] == "通用图片"
    assert workflow_catalog["recipePipeline"] == [
        {"id": "custom-shot-image", "name": "自定义分镜图", "version": 1}
    ]


def test_compiler_propagates_portable_image_generation_inputs(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "生成商品主图",
            "inputs": {
                "image_model": "image-model",
                "image_aspect_ratio": "16:9",
                "image_resolution": "2K",
                "image_quality": "medium",
                "image_count": 7,
                "image_variants_per_node": 2,
            },
            "items": [
                {
                    "id": "hero",
                    "title": "商品主图",
                    "recipe_id": "general-image",
                }
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True
    image = next(
        node
        for node in compiled["plan"]["nodes"]
        if node["node_type"] == "imageGenNode"
    )
    assert {
        key: image["data"].get(key)
        for key in ("model", "aspectRatio", "size", "quality", "count")
    } == {
        "model": "image-model",
        "aspectRatio": "16:9",
        "size": "2K",
        "quality": "medium",
        "count": 2,
    }


@pytest.mark.parametrize(
    ("parameter_id", "value"),
    [
        ("image_resolution", "3K"),
        ("image_aspect_ratio", "1:8"),
        ("video_resolution", "2K"),
        ("video_aspect_ratio", "9:21"),
    ],
)
def test_compiler_defers_model_dependent_generation_values_to_live_schema(
    monkeypatch,
    parameter_id,
    value,
):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "生成模型能力测试工作流",
            "inputs": {parameter_id: value},
        }
    )

    assert compiled["ok"] is True, compiled
    node_type = "imageGenNode" if parameter_id.startswith("image_") else "videoNode"
    data_key = (
        "aspectRatio"
        if parameter_id.endswith("aspect_ratio")
        else ("size" if node_type == "imageGenNode" else "quality")
    )
    media_nodes = [
        node for node in compiled["plan"]["nodes"] if node["node_type"] == node_type
    ]
    assert media_nodes
    assert all(node["data"][data_key] == value for node in media_nodes)


@pytest.mark.parametrize(
    ("parameter_id", "value", "message"),
    [
        (
            "image_variants_per_node",
            3,
            "unsupported option: 3; supported values: 1, 2, 4",
        ),
        (
            "video_variants_per_node",
            0,
            "unsupported option: 0; supported values: 1, 2, 4",
        ),
        ("image_variants_per_node", True, "must be an integer"),
        ("video_duration_seconds", 0, "must be greater than 0"),
        ("video_duration_seconds", 601, "must be less than or equal to 600"),
        ("video_generate_audio", "false", "must be a boolean"),
        ("image_model", 42, "must be a non-empty string"),
        ("video_generation_mode", "unknown", "unsupported option: unknown"),
    ],
)
def test_compiler_rejects_invalid_portable_generation_inputs(
    monkeypatch,
    parameter_id,
    value,
    message,
):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "生成商品主图",
            "inputs": {parameter_id: value},
            "items": [
                {
                    "id": "hero",
                    "title": "商品主图",
                    "recipe_id": "general-image",
                }
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is False
    assert compiled["status"] == "invalid_workflow_intent"
    assert compiled["errors"] == [
        {"path": f"inputs.{parameter_id}", "message": message}
    ]


def test_dynamic_item_auto_connects_unique_generated_source_anchor(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "先生成商品锚点，再生成广告图",
            "items": [
                {
                    "id": "product-anchor",
                    "title": "商品锚点",
                    "recipe_id": "general-image",
                },
                {
                    "id": "hero-shot",
                    "title": "商品广告图",
                    "recipe_id": "ecommerce-ad-image",
                },
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True
    assert {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in compiled["plan"]["edges"]
    } >= {
        ("product-anchor", "hero-shot", "media_input_for"),
    }


def test_dynamic_item_rejects_conflicting_recipe_pipeline(monkeypatch):
    catalog = _load_catalog_module()
    recipes = copy.deepcopy(_MINIMAL_ECOMMERCE_RECIPES)
    next(item for item in recipes if item["id"] == "custom-shot-image")[
        "conflicts_with"
    ] = ["general-image"]

    def fake_load_json_dir(path):
        if path == catalog._SKILLS_DIR:
            return copy.deepcopy([_MINIMAL_ECOMMERCE_SKILL])
        if path == catalog._RECIPES_DIR:
            return copy.deepcopy(recipes)
        return []

    monkeypatch.setattr(catalog, "_load_json_dir", fake_load_json_dir)
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "ecommerce-product",
            "user_goal": "生成商品图",
            "items": [
                {
                    "id": "hero",
                    "title": "商品图",
                    "recipe_id": "general-image",
                    "recipe_pipeline": ["custom-shot-image"],
                }
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is False
    assert "conflicts with" in compiled["error"]


def test_user_agent_config_merges_with_builtin_catalog(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    def fake_list_user_agent_config_items(_username, kind):
        if kind == "skills":
            return [
                {
                    "id": "director-method",
                    "description": "用户自定义导演方法",
                    "triggers": {"node_scopes": ["imageGeneration"]},
                    "allowed_recipe_ids": ["director-frame"],
                }
            ]
        if kind == "recipes":
            return [
                {
                    "id": "director-frame",
                    "name": "导演关键帧",
                    "version": 1,
                    "output_kind": "image",
                }
            ]
        raise AssertionError(kind)

    monkeypatch.setattr(
        catalog, "list_user_agent_config_items", fake_list_user_agent_config_items
    )
    monkeypatch.setattr(catalog, "_catalog_username", lambda: "local")

    custom_package = catalog.get_workflow_skill({"skill_id": "director-method"})
    builtin_package = catalog.get_workflow_skill({"skill_id": "ecommerce-product"})

    assert custom_package["ok"] is True
    assert builtin_package["ok"] is False


def test_workflow_skill_limits_recipes_and_identifies_source_anchor(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    package = catalog.get_workflow_skill({"skill_id": "ecommerce-product"})

    recipe_ids = {item["id"] for item in package["available_recipes"]}
    assert recipe_ids == {
        "ecommerce-ad-image",
        "general-image",
        "custom-shot-image",
    }
    assert package["planning_contract"]["recipe_ids_by_output_kind"] == {
        "image": [
            "custom-shot-image",
            "ecommerce-ad-image",
            "general-image",
        ]
    }
    assert package["planning_contract"]["missing_source_media"][
        "source_anchor_recipe_ids"
    ] == {"image": ["custom-shot-image", "general-image"]}


def test_compact_dynamic_intent_compiles_recipe_items_to_valid_plan(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "schema_version": "freezone_workflow_intent.v1",
            "skill_id": "pixar-ip-ad-video",
            "user_goal": "为黑色运动相机制作 15 秒 9:16 竖屏广告",
            "inputs": {"aspect_ratio": "9:16", "duration": "15"},
            "items": [
                {
                    "id": "character_anchor",
                    "title": "角色锚点",
                    "prompt": "设计品牌动画角色",
                    "recipe_id": "ad-ip-character-anchor",
                },
                {
                    "id": "storyboard",
                    "title": "广告分镜",
                    "prompt": "生成五镜头广告分镜",
                    "recipe_id": "storyboard-plan",
                    "depends_on": ["character_anchor"],
                },
                {
                    "id": "video_clip",
                    "title": "广告视频",
                    "prompt": "生成品牌广告视频",
                    "recipe_id": "storyboard-shot-video",
                    "depends_on": ["storyboard", "character_anchor"],
                },
            ],
        }
    )

    assert compiled["ok"] is True
    assert compiled["node_count"] == 5
    plan = compiled["plan"]
    assert plan["mode"] == "tool_compiled_dynamic"
    node_catalog = plan["nodes"][1]["data"]["workflowCatalog"]
    assert node_catalog["recipeId"] == "ad-ip-character-anchor"
    assert node_catalog["skillVersion"] == plan["skill"]["version"]
    assert node_catalog["confirmedInputs"]["aspect_ratio"] == "9:16"
    assert plan["nodes"][-1]["node_type"] == "videoComposeNode"
    assert plan["nodes"][-1]["data"]["compositionInputOrder"] == ["video_clip"]
    assert catalog.validate_agent_workflow_plan(plan)["ok"] is True


def test_validator_rejects_skill_version_mismatch_and_recipe_outside_whitelist():
    plan = _dynamic_plan()
    plan["nodes"][1]["data"]["workflowCatalog"]["skillVersion"] = "5"
    result = validate_workflow_plan(
        plan,
        skills_by_id={"ecommerce-product": _MINIMAL_ECOMMERCE_SKILL},
        recipes_by_id={item["id"]: item for item in _MINIMAL_ECOMMERCE_RECIPES},
    )
    assert result["ok"] is False
    assert any(issue["path"].endswith("skillVersion") for issue in result["errors"])

    plan = _dynamic_plan()
    plan["nodes"][1]["data"]["workflowCatalog"]["recipeId"] = "general-video"
    result = validate_workflow_plan(
        plan,
        skills_by_id={"ecommerce-product": _MINIMAL_ECOMMERCE_SKILL},
        recipes_by_id={item["id"]: item for item in _MINIMAL_ECOMMERCE_RECIPES},
    )
    assert result["ok"] is False
    assert any("not allowed by skill" in issue["message"] for issue in result["errors"])


def test_compiler_uses_explicit_anchor_and_skips_audio_only_compose(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    ecommerce = catalog.compile_workflow_intent(
        {
            "skill_id": "pixar-ip-ad-video",
            "user_goal": "为一款新产品制作动画广告",
            "items": [
                {
                    "id": "anchor",
                    "title": "角色锚点",
                    "prompt": "生成品牌角色",
                    "recipe_id": "ad-ip-character-anchor",
                },
                {
                    "id": "video",
                    "title": "广告视频",
                    "prompt": "生成品牌广告视频",
                    "recipe_id": "storyboard-shot-video",
                    "depends_on": ["anchor"],
                },
            ],
        }
    )
    audio = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "把欢迎使用转换成中文语音",
            "items": [
                {
                    "id": "audio",
                    "title": "广告音频",
                    "prompt": "欢迎使用",
                    "narration": "欢迎使用",
                    "recipe_id": "general-audio",
                }
            ],
        }
    )

    assert ecommerce["ok"] is True
    assert ecommerce["plan"]["nodes"][1]["id"] == "anchor"
    assert audio["ok"] is True
    assert all(
        node["node_type"] != "videoComposeNode" for node in audio["plan"]["nodes"]
    )
    audio_node = next(
        node for node in audio["plan"]["nodes"] if node["node_type"] == "audioNode"
    )
    assert audio_node["data"]["workflowCatalog"]["recipeId"] == "general-audio"


def test_compiler_routes_general_audio_bgm_to_music_generation(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "制作一条 15 秒广告",
            "items": [
                {
                    "id": "bgm",
                    "title": "背景音乐",
                    "prompt": "为 15 秒广告创作轻柔背景音乐",
                    "recipe_id": "general-audio",
                }
            ],
        }
    )

    assert compiled["ok"] is True
    audio_node = next(
        node for node in compiled["plan"]["nodes"] if node["node_type"] == "audioNode"
    )
    assert audio_node["data"]["audioKind"] == "music"
    assert audio_node["data"]["model"] == "suno_music"
    assert audio_node["data"]["musicLengthMs"] == 16_000
    assert "speechMode" not in audio_node["data"]


def test_compiler_keeps_timeline_audio_out_of_video_references(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "制作一条 30 秒中文教程视频",
            "items": [
                {
                    "id": "frame",
                    "title": "教程画面",
                    "prompt": "教程主画面",
                    "recipe_id": "general-image",
                },
                {
                    "id": "voice",
                    "title": "中文女声旁白",
                    "prompt": "欢迎观看本期教程",
                    "narration": "欢迎观看本期教程",
                    "recipe_id": "general-audio",
                    "timeline_role": "voiceover",
                },
                {
                    "id": "bgm",
                    "title": "30秒背景音乐",
                    "prompt": "轻快的纯音乐",
                    "recipe_id": "general-audio",
                    "audio_kind": "music",
                    "timeline_role": "music",
                },
                {
                    "id": "clip",
                    "title": "教程视频",
                    "prompt": "生成教程视频片段",
                    "recipe_id": "general-video",
                    "depends_on": ["frame", "voice", "bgm"],
                },
            ],
        }
    )

    assert compiled["ok"] is True
    edges = compiled["plan"]["edges"]
    assert not any(
        edge["target"] == "clip" and edge["source"] in {"voice", "bgm"}
        for edge in edges
    )
    assert {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in edges
        if edge["target"] == "final_compose"
    } >= {
        ("voice", "final_compose", "composition_input_for"),
        ("bgm", "final_compose", "composition_input_for"),
        ("clip", "final_compose", "composition_input_for"),
    }


def test_compiler_uses_execution_only_edge_between_generated_video_steps(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "制作两个连续教程镜头",
            "items": [
                {
                    "id": "clip_1",
                    "title": "镜头一",
                    "prompt": "展示操作入口",
                    "recipe_id": "general-video",
                    "timeline_role": "visual",
                },
                {
                    "id": "clip_2",
                    "title": "镜头二",
                    "prompt": "展示操作结果",
                    "recipe_id": "general-video",
                    "depends_on": ["clip_1"],
                    "timeline_role": "visual",
                },
            ],
        }
    )

    assert compiled["ok"] is True
    assert {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in compiled["plan"]["edges"]
    } >= {
        ("clip_1", "clip_2", "dependency_for"),
        ("clip_1", "final_compose", "composition_input_for"),
        ("clip_2", "final_compose", "composition_input_for"),
    }


def test_compiler_propagates_portable_video_generation_inputs(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "生成教程视频",
            "inputs": {
                "video_model": "video-model",
                "video_aspect_ratio": "9:16",
                "video_resolution": "1080P",
                "video_duration_seconds": 10,
                "video_generate_audio": True,
                "video_count": 3,
                "video_variants_per_node": 2,
            },
            "items": [
                {
                    "id": "clip",
                    "title": "教程镜头",
                    "recipe_id": "general-video",
                }
            ],
        }
    )

    assert compiled["ok"] is True
    video = next(
        node for node in compiled["plan"]["nodes"] if node["node_type"] == "videoNode"
    )
    assert {
        key: video["data"].get(key)
        for key in (
            "model",
            "aspectRatio",
            "quality",
            "durationSec",
            "generateAudio",
            "count",
        )
    } == {
        "model": "video-model",
        "aspectRatio": "9:16",
        "quality": "1080P",
        "durationSec": 10,
        "generateAudio": True,
        "count": 2,
    }


def test_validator_checks_singular_group_alias_references():
    result = validate_workflow_plan(
        {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "ecommerce-product"},
            "nodes": [
                {
                    "id": "prompt",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                }
            ],
            "edges": [],
            "group": {"label": "测试工作流", "nodes": ["prompt", "missing"]},
        },
        skills_by_id={"ecommerce-product": _MINIMAL_ECOMMERCE_SKILL},
        recipes_by_id={recipe["id"]: recipe for recipe in _MINIMAL_ECOMMERCE_RECIPES},
    )

    assert result["ok"] is False
    assert any(
        issue["path"] == "group[0].node_ids[1]" and "missing" in issue["message"]
        for issue in result["errors"]
    )


def test_validator_rejects_execution_policy_inside_plan():
    result = validate_workflow_plan(
        {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "ecommerce-product"},
            "nodes": [
                {
                    "id": "prompt",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                }
            ],
            "edges": [],
            "run_after_create": False,
        },
        skills_by_id={"ecommerce-product": _MINIMAL_ECOMMERCE_SKILL},
        recipes_by_id={recipe["id"]: recipe for recipe in _MINIMAL_ECOMMERCE_RECIPES},
    )

    assert result["ok"] is False
    assert any(
        issue["path"] == "run_after_create" and "beside plan" in issue["message"]
        for issue in result["errors"]
    )


def test_compiler_keeps_explicit_video_reference_as_media_input(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "参考动作视频生成新镜头",
            "items": [
                {
                    "id": "motion_reference",
                    "title": "动作参考",
                    "prompt": "参考动作",
                    "recipe_id": "general-video",
                },
                {
                    "id": "clip",
                    "title": "新镜头",
                    "prompt": "沿用动作节奏",
                    "recipe_id": "general-video",
                    "reference_inputs": ["motion_reference"],
                },
            ],
        }
    )

    assert compiled["ok"] is True
    assert (
        "motion_reference",
        "clip",
        "media_input_for",
    ) in {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in compiled["plan"]["edges"]
    }


def test_compiler_maps_explicit_text_reference_to_prompt_input(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "根据文字提示生成首帧",
            "items": [
                {
                    "id": "prompt",
                    "title": "画面提示词",
                    "prompt": "雨夜未来城市，霓虹灯倒映在路面",
                    "recipe_id": "general-text",
                },
                {
                    "id": "frame",
                    "title": "城市首帧",
                    "prompt": "生成城市首帧",
                    "recipe_id": "general-image",
                    "reference_inputs": ["prompt"],
                },
            ],
            "include_compose": False,
        }
    )

    assert compiled["ok"] is True, compiled
    assert (
        "prompt",
        "frame",
        "prompt_for",
    ) in {
        (edge["source"], edge["target"], edge["link_type"])
        for edge in compiled["plan"]["edges"]
    }


def test_compiler_replaces_recipe_backed_final_compose_with_compose_node(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "制作教程并合成成片",
            "items": [
                {
                    "id": "clip",
                    "title": "教程镜头",
                    "prompt": "展示操作",
                    "recipe_id": "general-video",
                },
                {
                    "id": "final-compose",
                    "title": "最终合成",
                    "prompt": "合成全部镜头和音频",
                    "recipe_id": "general-video",
                    "depends_on": ["clip"],
                },
            ],
        }
    )

    assert compiled["ok"] is True
    plan = compiled["plan"]
    assert not any(node["id"] == "final-compose" for node in plan["nodes"])
    assert sum(node["node_type"] == "videoComposeNode" for node in plan["nodes"]) == 1


def test_compiler_respects_explicit_audio_kind_for_ambiguous_general_audio(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "制作一条广告",
            "items": [
                {
                    "id": "soundtrack",
                    "title": "广告声音",
                    "prompt": "轻柔钢琴",
                    "audio_kind": "music",
                    "recipe_id": "general-audio",
                }
            ],
        }
    )

    audio_node = next(
        node for node in compiled["plan"]["nodes"] if node["node_type"] == "audioNode"
    )
    assert audio_node["data"]["audioKind"] == "music"


def test_compiler_rejects_speech_instruction_without_literal_narration(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "video-tutorial",
            "user_goal": "制作一条广告",
            "items": [
                {
                    "id": "narration",
                    "title": "旁白配音",
                    "prompt": "根据广告脚本中的旁白文案，生成女声旁白配音",
                    "audio_kind": "speech",
                    "recipe_id": "general-audio",
                }
            ],
        }
    )

    assert compiled["ok"] is False
    assert compiled["errors"][0]["path"] == "items.0.narration"


def test_parameterized_skill_uses_stateless_input_contract(monkeypatch):
    catalog = _load_catalog_module()
    _use_parameterized_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {
            "skill_id": "cinematic-short",
            "user_goal": "生成一支竖屏电影感短片",
            "inputs": {"duration": "90"},
        }
    )

    assert package["ok"] is True
    assert "type" not in package["skill"]
    assert "parameters" not in package["skill"]
    assert package["skill"]["input_parameters"]
    assert package["input_contract"]["ready_for_planning"] is True
    assert package["input_contract"]["resolved"]["duration"] == "90"
    assert package["input_contract"]["resolved"]["aspect_ratio"] == "9:16"
    assert package["input_contract"]["inferred"] == {"aspect_ratio": "9:16"}
    assert (
        next(
            field
            for field in package["input_contract"]["fields"]
            if field["id"] == "aspect_ratio"
        )["source"]
        == "inferred"
    )
    assert package["input_contract"]["recommended_run_after_create"] is True
    recipe_ids = {item["id"] for item in package["available_recipes"]}
    assert "general-text" in recipe_ids


def test_explicit_skill_inputs_override_deterministic_inference(monkeypatch):
    catalog = _load_catalog_module()
    _use_parameterized_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {
            "skill_id": "cinematic-short",
            "user_goal": "生成一支 90 秒竖屏短片并自动执行",
            "inputs": {
                "duration": "60",
                "aspect_ratio": "16:9",
                "execution_mode": "manual",
            },
        }
    )

    contract = package["input_contract"]
    assert contract["resolved"] == {
        "duration": "60",
        "execution_mode": "manual",
        "aspect_ratio": "16:9",
    }
    assert contract["inferred"] == {
        "duration": "90",
        "execution_mode": "auto",
        "aspect_ratio": "9:16",
    }
    assert contract["recommended_run_after_create"] is False


def test_workflow_skill_input_contract_rejects_unknown_option(monkeypatch):
    catalog = _load_catalog_module()
    _use_parameterized_catalog(monkeypatch, catalog)

    package = catalog.get_workflow_skill(
        {
            "skill_id": "cinematic-short",
            "inputs": {"duration": "120"},
        }
    )

    assert package["ok"] is True
    assert package["input_contract"]["ready_for_planning"] is False
    assert package["input_contract"]["errors"] == [
        {"path": "inputs.duration", "message": "unsupported option: 120"}
    ]


def test_dynamic_workflow_plan_accepts_different_node_counts(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)

    three = catalog.validate_agent_workflow_plan(_dynamic_plan(image_count=3))
    six = catalog.validate_agent_workflow_plan(_dynamic_plan(image_count=6))

    assert three["ok"] is True
    assert three["node_count"] == 4
    assert six["ok"] is True
    assert six["node_count"] == 7


def test_workflow_plan_accepts_canvas_type_alias_and_counts_it():
    plan = _dynamic_plan(image_count=1)
    for node in plan["nodes"]:
        node["type"] = node.pop("node_type")

    result = validate_workflow_plan(plan)

    assert result["ok"] is True, result
    assert result["preflight"]["counts"] == {
        "text": 1,
        "image": 1,
        "video": 0,
        "audio": 0,
        "compose": 0,
    }


def test_workflow_plan_rejects_conflicting_node_type_alias():
    plan = _dynamic_plan(image_count=1)
    plan["nodes"][1]["type"] = "audioNode"

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert {
        "path": "nodes[1].type",
        "message": "conflicts with node_type: imageGenNode",
    } in result["errors"]


def test_workflow_plan_accepts_data_stage_and_edge_type_aliases():
    plan = _dynamic_plan(image_count=1)
    input_node = plan["nodes"][0]
    input_node["data"]["stage"] = input_node.pop("stage")
    for edge in plan["edges"]:
        edge["type"] = edge.pop("link_type")

    result = validate_workflow_plan(plan)

    assert result["ok"] is True, result


def test_workflow_plan_rejects_conflicting_edge_type_alias():
    plan = _dynamic_plan(image_count=1)
    plan["edges"][0]["type"] = "dependency_for"

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert {
        "path": "edges[0].type",
        "message": "conflicts with link_type: prompt_for",
    } in result["errors"]


def test_workflow_plan_rejects_invalid_runtime_catalog_shapes_before_canvas_apply():
    plan = _dynamic_plan()
    catalog = plan["nodes"][1]["data"]["workflowCatalog"]
    catalog.update(
        {
            "confirmedInputs": ["brief"],
            "promptStrategy": "ambient_bgm",
            "inputStrategy": "script_to_bgm",
            "promptBuilder": "episode_bgm",
        }
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    errors = {error["path"]: error["message"] for error in result["errors"]}
    catalog_path = "nodes[1].data.workflowCatalog"
    assert errors[f"{catalog_path}.confirmedInputs"] == "must be an object"
    assert errors[f"{catalog_path}.inputStrategy"] == "must be an object"
    assert errors[f"{catalog_path}.promptBuilder"] == "must be an object"
    assert errors[f"{catalog_path}.promptStrategy"].startswith("must be one of:")


def test_workflow_plan_rejects_recipe_backed_user_input_node():
    plan = _dynamic_plan()
    plan["nodes"][0]["data"]["workflowCatalog"] = {
        "skillId": "ecommerce-product",
        "recipeId": "general-text",
        "stepId": "user_requirement",
    }

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        error["path"] == "nodes[0].data.workflowCatalog.recipeId"
        and "must not execute a Recipe" in error["message"]
        for error in result["errors"]
    )


def test_workflow_plan_reports_deterministic_preflight_summary():
    result = validate_workflow_plan(_dynamic_plan(image_count=3))

    assert result["ok"] is True
    assert result["preflight"]["status"] == "ready"
    assert result["preflight"]["generation_task_count"] == 3
    assert result["preflight"]["counts"] == {
        "text": 1,
        "image": 3,
        "video": 0,
        "audio": 0,
        "compose": 0,
    }


def test_exact_short_drama_plan_supports_24_beats_and_exact_count_guards(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    skill_id = "short-drama-quick"
    nodes = [
        {
            "id": "request",
            "node_type": "textAnnotationNode",
            "stage": "input",
            "data": {"displayName": "用户需求", "content": "固定生成24个视觉Beat"},
        },
        {
            "id": "script",
            "node_type": "textAnnotationNode",
            "stage": "story",
            "data": {
                "displayName": "第1集完整分集剧本",
                "content": "Beat 01—Beat 24",
                "workflowCatalog": {
                    "skillId": skill_id,
                    "recipeId": "general-text",
                },
            },
        },
    ]
    edges = [{"source": "request", "target": "script", "link_type": "context_for"}]
    for beat in range(1, 25):
        suffix = f"{beat:02d}"
        frame_id = f"beat_{suffix}_frame"
        video_id = f"beat_{suffix}_video"
        nodes.extend(
            [
                {
                    "id": frame_id,
                    "node_type": "imageGenNode",
                    "stage": "image",
                    "data": {
                        "displayName": f"Beat {suffix} 首帧",
                        "workflowCatalog": {
                            "skillId": skill_id,
                            "recipeId": "general-image",
                        },
                    },
                },
                {
                    "id": video_id,
                    "node_type": "videoNode",
                    "stage": "video",
                    "data": {
                        "displayName": f"Beat {suffix} 视频",
                        "workflowCatalog": {
                            "skillId": skill_id,
                            "recipeId": "general-video",
                        },
                    },
                },
            ]
        )
        edges.extend(
            [
                {"source": "script", "target": frame_id, "link_type": "prompt_for"},
                {
                    "source": frame_id,
                    "target": video_id,
                    "link_type": "media_input_for",
                },
            ]
        )

    nodes.extend(
        [
            {
                "id": "voiceover",
                "node_type": "audioNode",
                "stage": "audio",
                "data": {
                    "displayName": "第1集旁白",
                    "audioKind": "speech",
                    "workflowCatalog": {
                        "skillId": skill_id,
                        "recipeId": "drama-shot-voice",
                    },
                },
            },
            {
                "id": "background_music",
                "node_type": "audioNode",
                "stage": "audio",
                "data": {
                    "displayName": "第1集背景音乐",
                    "audioKind": "music",
                    "workflowCatalog": {
                        "skillId": skill_id,
                        "recipeId": "drama-background-music",
                    },
                },
            },
            {
                "id": "final_compose",
                "node_type": "videoComposeNode",
                "stage": "compose",
                "data": {"displayName": "第1集最终成片"},
            },
        ]
    )
    edges.extend(
        [
            {"source": "script", "target": "voiceover", "link_type": "prompt_for"},
            {
                "source": "script",
                "target": "background_music",
                "link_type": "prompt_for",
            },
            {
                "source": "voiceover",
                "target": "final_compose",
                "link_type": "composition_input_for",
            },
            {
                "source": "background_music",
                "target": "final_compose",
                "link_type": "composition_input_for",
            },
            *[
                {
                    "source": f"beat_{beat:02d}_video",
                    "target": "final_compose",
                    "link_type": "composition_input_for",
                }
                for beat in range(1, 25)
            ],
        ]
    )
    node_ids = [node["id"] for node in nodes]
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.short-drama-episode",
        "skill": {"id": skill_id, "version": 1},
        "expected_node_count": 53,
        "expected_node_counts": {
            "textAnnotationNode": 2,
            "imageGenNode": 24,
            "videoNode": 24,
            "audioNode": 2,
            "videoComposeNode": 1,
        },
        "nodes": nodes,
        "edges": edges,
        "group": {"label": "第1集制作工作流", "node_ids": node_ids},
        "layout": {"mode": "grid", "direction": "left_to_right"},
    }

    validated = catalog.validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert validated["node_count"] == 53
    graph = build_workflow_graph_commands({"plan": plan, "run_after_create": False})
    assert graph["ok"] is True, graph
    assert sum(command["type"] == "create_node" for command in graph["commands"]) == 53
    assert sum(command["type"] == "group_nodes" for command in graph["commands"]) == 1

    truncated = {**plan, "nodes": plan["nodes"][:-1]}
    rejected = validate_workflow_plan(truncated)
    assert rejected["ok"] is False
    assert any(issue["path"] == "expected_node_count" for issue in rejected["errors"])


def _video_compose_plan() -> dict:
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.video",
        "nodes": [
            {"id": "clip", "node_type": "videoNode", "stage": "video"},
            {"id": "compose", "node_type": "videoComposeNode", "stage": "compose"},
        ],
        "edges": [
            {
                "source": "clip",
                "target": "compose",
                "link_type": "composition_input_for",
            }
        ],
    }


@pytest.mark.parametrize(
    ("requested_model", "canvas_model"),
    [
        ("seedance-2.0-fast", "seedance-2.0-fast"),
        ("newapi_seedance-2.0-fast", "seedance-2.0-fast"),
        ("newapi_seedance-2.0", "seedance-2.0"),
        ("huimeng_seedance-1.5-pro", "seedance-1.5-pro"),
    ],
)
def test_workflow_graph_normalizes_video_provider_names_to_canvas_model_ids(
    requested_model,
    canvas_model,
):
    graph = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.video",
                "nodes": [
                    {
                        "id": "clip",
                        "node_type": "videoNode",
                        "stage": "video",
                        "data": {"model": requested_model},
                    }
                ],
                "edges": [],
            },
            "run_after_create": False,
        }
    )

    assert graph["ok"] is True
    create_command = next(
        command for command in graph["commands"] if command["type"] == "create_node"
    )
    assert create_command["data"]["model"] == canvas_model


def test_workflow_plan_rejects_duplicate_or_non_terminal_compose_nodes():
    plan = _video_compose_plan()
    plan["nodes"].append(
        {"id": "compose_two", "node_type": "videoComposeNode", "stage": "compose"}
    )
    plan["edges"].append(
        {
            "source": "clip",
            "target": "compose_two",
            "link_type": "composition_input_for",
        }
    )
    plan["edges"].append(
        {"source": "compose", "target": "clip", "link_type": "dependency_for"}
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        "at most one videoComposeNode" in issue["message"] for issue in result["errors"]
    )
    assert any(
        "must be a terminal node" in issue["message"] for issue in result["errors"]
    )


def test_workflow_plan_rejects_composition_edge_to_regular_video_node():
    plan = _video_compose_plan()
    plan["nodes"].append({"id": "clip_two", "node_type": "videoNode", "stage": "video"})
    plan["edges"].append(
        {
            "source": "clip",
            "target": "clip_two",
            "link_type": "composition_input_for",
        }
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        "composition_input_for must target videoComposeNode" in issue["message"]
        for issue in result["errors"]
    )


def test_workflow_plan_rejects_recipe_backed_video_as_final_compose():
    plan = _video_compose_plan()
    plan["nodes"] = [
        {
            "id": "clip",
            "node_type": "videoNode",
            "stage": "compose",
            "data": {
                "workflowCatalog": {
                    "recipeId": "general-video",
                    "stepId": "final_compose",
                }
            },
        }
    ]
    plan["edges"] = []

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert any(
        "final composition must use videoComposeNode" in issue["message"]
        for issue in result["errors"]
    )


def test_dynamic_workflow_plan_validates_skill_inputs(monkeypatch):
    catalog = _load_catalog_module()
    _use_parameterized_catalog(monkeypatch, catalog)
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.cinematic-short",
        "skill": {"id": "cinematic-short"},
        "inputs": {"duration": "120", "execution_mode": "manual"},
        "nodes": [
            {
                "id": "concept",
                "node_type": "textAnnotationNode",
                "stage": "story",
                "data": {
                    "prompt": "生成电影短片概念",
                    "workflowCatalog": {
                        "skillId": "cinematic-short",
                        "recipeId": "general-text",
                        "recipeVersion": "1",
                    },
                },
            }
        ],
        "edges": [],
    }

    invalid = catalog.validate_agent_workflow_plan(plan)
    assert invalid["ok"] is False
    assert invalid["errors"][0] == {
        "path": "inputs.duration",
        "message": "unsupported option: 120",
    }

    plan["inputs"]["duration"] = "90"
    valid = catalog.validate_agent_workflow_plan(plan)
    assert valid["ok"] is True
    assert valid["execution_mode"] == "manual"
    assert valid["recommended_run_after_create"] is False


def test_strict_workflow_plan_rejects_disconnected_multi_node_graph():
    plan = _dynamic_plan(image_count=2)
    plan["edges"] = []

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert result["errors"] == [
        {
            "path": "edges",
            "message": "multi-node workflow must declare dependency edges",
        }
    ]

    partially_connected = _dynamic_plan(image_count=2)
    partially_connected["edges"] = partially_connected["edges"][:1]

    partial_result = validate_workflow_plan(partially_connected)

    assert partial_result["ok"] is False
    assert partial_result["errors"] == [
        {
            "path": "edges",
            "message": "workflow graph contains disconnected nodes: product_image_2",
        }
    ]


def test_strict_workflow_plan_rejects_unknown_node_bad_edge_and_cycle():
    plan = _dynamic_plan()
    plan["nodes"].append({"id": "invalid", "node_type": "inventedImageNode"})
    plan["edges"].append(
        {"source": "missing", "target": "brief", "link_type": "context_for"}
    )
    plan["edges"].append(
        {"source": "product_image_1", "target": "brief", "link_type": "media_input_for"}
    )

    result = validate_workflow_plan(plan)

    assert result["ok"] is False
    assert result["status"] == "invalid_dynamic_workflow_plan"
    paths = {error["path"] for error in result["errors"]}
    assert "nodes[2].node_type" in paths
    assert "edges[1].source" in paths
    assert any("cycle" in error["message"] for error in result["errors"])


def test_catalog_validation_rejects_unknown_recipe_and_version_mismatch(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    unknown = _dynamic_plan()
    unknown["nodes"][1]["data"]["workflowCatalog"]["recipeId"] = "not-a-recipe"
    mismatch = _dynamic_plan()
    mismatch["nodes"][1]["data"]["workflowCatalog"]["recipeVersion"] = "999"

    unknown_result = catalog.validate_agent_workflow_plan(unknown)
    mismatch_result = catalog.validate_agent_workflow_plan(mismatch)

    assert unknown_result["ok"] is False
    assert "unknown recipe" in unknown_result["error"]
    assert mismatch_result["ok"] is False
    assert "version mismatch" in mismatch_result["error"]


def test_catalog_validation_requires_recipe_and_skill_capability(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    missing_recipe = _dynamic_plan()
    missing_recipe["nodes"][1]["data"].pop("workflowCatalog")
    unsupported_capability = _dynamic_plan()
    unsupported_capability["nodes"][1]["node_type"] = "videoNode"
    unsupported_catalog = unsupported_capability["nodes"][1]["data"]["workflowCatalog"]
    unsupported_catalog["recipeId"] = "general-video"
    unsupported_catalog["recipeVersion"] = "1"

    missing_result = catalog.validate_agent_workflow_plan(missing_recipe)
    unsupported_result = catalog.validate_agent_workflow_plan(unsupported_capability)

    assert missing_result["ok"] is False
    assert "requires an explicit recipeId" in missing_result["error"]
    assert unsupported_result["ok"] is False
    assert any(
        "not allowed by skill" in error["message"]
        for error in unsupported_result["errors"]
    )


def test_catalog_validation_requires_real_or_generated_source_media(monkeypatch):
    catalog = _load_catalog_module()
    _install_minimal_builtin_catalog(monkeypatch, catalog)
    missing_source = _dynamic_plan()
    missing_source["nodes"][1]["data"].pop("referenceImageUrl")

    missing_result = catalog.validate_agent_workflow_plan(missing_source)

    assert missing_result["ok"] is False
    assert "requires source media" in missing_result["error"]

    anchor = {
        "id": "product_anchor",
        "node_type": "imageGenNode",
        "stage": "asset",
        "data": {
            "prompt": "中性背景的运动鞋产品基准图",
            "workflowCatalog": {
                "skillId": "ecommerce-product",
                "recipeId": "general-image",
                "recipeVersion": "1",
            },
        },
    }
    missing_source["nodes"].insert(1, anchor)
    missing_source["edges"].append(
        {
            "source": "product_anchor",
            "target": "product_image_1",
            "link_type": "media_input_for",
        }
    )

    anchored_result = catalog.validate_agent_workflow_plan(missing_source)

    assert anchored_result["ok"] is True


def test_project_catalog_uses_canonical_pixar_skill_and_recipes(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }

    assert skills["ecommerce-ad"]["name"] == "电商广告"
    assert skills["video-tutorial"]["name"] == "视频解说教程"
    assert skills["text-to-image-video"]["name"] == "文生图生视频（动态）"
    assert skills["short-drama-quick"]["name"] == "短剧（快速测试）"
    assert skills["pixar-ip-ad-video"]["name"] == "皮克斯 IP 品牌广告短片"
    assert skills["lego-minifigure-animation-video"]["name"] == "乐高小人动画短片"
    assert skills["retro-hong-kong-kungfu-comedy-video"]["name"] == "港风功夫萌宠短片"
    assert skills["outdoor-stage-duel-video"]["name"] == "户外舞台双人能力秀"
    assert skills["ling-cage-cinematic-video"]["name"] == "灵笼风格科幻短片"
    assert skills["japanese-anime-drama-video"]["name"] == "日系漫剧梦工坊"
    assert all(
        parameter.get("id") != "execution_mode"
        for skill in skills.values()
        for parameter in skill.get("input_parameters") or []
        if isinstance(parameter, dict)
    )
    assert "pixar-ip-brand-ad-short-film" not in skills
    assert skills["pixar-ip-ad-video"]["allowed_recipe_ids"] == [
        "ad-ip-character-anchor",
        "ad-product-prop-anchor",
        "storyboard-plan",
        "storyboard-shot-video",
        "video-audio-layer",
    ]
    assert skills["lego-minifigure-animation-video"]["allowed_recipe_ids"] == [
        "short-film-script-outline",
        "storyboard-plan",
        "visual-key-elements",
        "storyboard-shot-video",
    ]
    assert skills["retro-hong-kong-kungfu-comedy-video"]["allowed_recipe_ids"] == [
        "four-act-comedy-story-outline",
        "storyboard-plan",
        "anthropomorphic-kungfu-key-elements",
        "anthropomorphic-kungfu-shot-video",
        "video-audio-layer",
    ]
    assert skills["outdoor-stage-duel-video"]["allowed_recipe_ids"] == [
        "outdoor-stage-duel-storyboard",
        "outdoor-stage-duel-key-elements",
        "outdoor-stage-duel-shot-video",
        "outdoor-stage-duel-audio-layers",
    ]
    assert skills["ling-cage-cinematic-video"]["allowed_recipe_ids"] == [
        "sci-fi-survival-story-script",
        "sci-fi-survival-storyboard",
        "sci-fi-survival-key-elements",
        "sci-fi-survival-shot-video",
        "sci-fi-survival-audio-layers",
    ]
    assert skills["japanese-anime-drama-video"]["allowed_recipe_ids"] == [
        "dialogue-drama-story-script",
        "dialogue-drama-storyboard-plan",
        "visual-key-elements",
        "dialogue-continuity-shot-video",
    ]
    assert "ad-ip-character-anchor" in recipes
    assert "ad-product-prop-anchor" in recipes
    assert "workflow-input-analysis" in recipes
    assert "short-film-script-outline" in recipes
    assert "four-act-comedy-story-outline" in recipes
    assert "storyboard-plan" in recipes
    assert "anthropomorphic-kungfu-key-elements" in recipes
    assert "anthropomorphic-kungfu-shot-video" in recipes
    assert "outdoor-stage-duel-storyboard" in recipes
    assert "outdoor-stage-duel-key-elements" in recipes
    assert "outdoor-stage-duel-shot-video" in recipes
    assert "outdoor-stage-duel-audio-layers" in recipes
    assert "sci-fi-survival-story-script" in recipes
    assert "sci-fi-survival-storyboard" in recipes
    assert "sci-fi-survival-key-elements" in recipes
    assert "sci-fi-survival-shot-video" in recipes
    assert "sci-fi-survival-audio-layers" in recipes
    assert "dialogue-drama-story-script" in recipes
    assert "dialogue-drama-storyboard-plan" in recipes
    assert "dialogue-drama-key-elements" not in recipes
    assert "dialogue-continuity-shot-video" in recipes
    assert "dialogue-voice-ambience-layer" not in recipes
    assert "visual-key-elements" in recipes
    assert "storyboard-shot-video" in recipes
    assert "video-audio-layer" in recipes
    assert "pixar-ip-character-design" not in recipes
    assert "pixar-ip-prop-anchor" not in recipes
    assert "pixar-ip-storyboard-sketch" not in recipes
    assert "pixar-ip-shot-video" not in recipes
    assert "pixar-ip-audio-layers" not in recipes
    assert "pixar-ip-compose-plan" not in recipes
    assert "pixar-shot-video-clip" not in recipes
    assert "storyboard-sketch" not in recipes
    assert "shot-video" not in recipes
    assert "ad-video-audio-layer" not in recipes
    assert "ad-audio-production" not in recipes
    assert "lego-minifig-input-analysis" not in recipes
    assert "lego-minifig-script-outline" not in recipes
    assert "lego-minifig-video-spec" not in recipes
    assert "lego-minifig-storyboard" not in recipes
    assert "lego-minifig-key-elements" not in recipes
    assert "lego-minifig-shot-video" not in recipes
    assert "lego-minifig-audio-layers" not in recipes
    assert "retro-kungfu-video-spec" not in recipes
    assert "retro-kungfu-story-outline" not in recipes
    assert "retro-kungfu-shot-list" not in recipes
    assert "retro-kungfu-key-elements" not in recipes
    assert "retro-kungfu-shot-video" not in recipes
    assert "retro-kungfu-bgm" not in recipes
    assert "outdoor-stage-duel-video-spec" not in recipes
    assert "ling-cage-video-spec" not in recipes
    assert "ling-cage-story-script" not in recipes
    assert "ling-cage-storyboard" not in recipes
    assert "ling-cage-key-elements" not in recipes
    assert "ling-cage-shot-video" not in recipes
    assert "ling-cage-audio-layers" not in recipes


def test_pixar_skill_keeps_methodology_while_recipes_stay_stage_focused(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    pixar_skill = skills["pixar-ip-ad-video"]
    planning_text = "\n".join(
        [
            pixar_skill["planning"]["planning_notes"],
            pixar_skill["planning"]["prompt_guide"],
            "\n".join(pixar_skill["planning"]["conduct_rules"]),
            "\n".join(pixar_skill["evaluation"]["domain_constraints"]),
        ]
    )
    planning_notes = pixar_skill["planning"]["planning_notes"]
    prompt_guide = pixar_skill["planning"]["prompt_guide"]

    assert "闸门 1" in planning_text
    assert "角色属性表" in planning_text
    assert "产品道具" in planning_text
    assert "角色关联道具" in planning_text
    assert "15 秒广告 = 9 个面板" in planning_text
    assert "15 秒广告通常拆分为 4 个视频片段" in planning_text
    assert "角色锚点" in planning_text and "分镜" in planning_text
    assert "Sequence → Shot Group → Shot" in planning_text
    assert "皮克斯 3D 卡通渲染" in prompt_guide
    assert "C4D + Octane" in prompt_guide
    assert "【执行路径】" not in prompt_guide
    assert "【皮克斯视觉方向】" not in planning_notes
    assert "input_parameters" not in planning_text
    assert "videoCompose" not in planning_text
    assert "storyboard-sketch" not in planning_text
    assert "shot-video" not in planning_text
    assert "ad-video-audio-layer" not in planning_text
    assert "workflow-input-analysis" not in planning_text
    assert "short-film-script-outline" not in planning_text
    assert "storyboard-plan" not in planning_text
    assert "storyboard-shot-video" not in planning_text
    assert "video-audio-layer" not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in [
            "ad-ip-character-anchor",
            "ad-product-prop-anchor",
            "storyboard-plan",
            "storyboard-shot-video",
            "video-audio-layer",
        ]
        for item in [
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "自创风格" not in recipe_text
    assert "覆盖 Skill" not in recipe_text
    assert "Recipe 内" not in recipe_text

    character_anchor = recipes["ad-ip-character-anchor"]
    character_text = "\n".join(
        [
            character_anchor["name"],
            character_anchor["system_prompt"],
            character_anchor["planning_prompt"],
            character_anchor["result_summary"],
            "\n".join(character_anchor["must_have_items"]),
        ]
    )
    assert "广告 IP 角色锚点" in character_text
    assert "身体附属结构" in character_text
    assert "品牌、Logo、产品卖点和产品外观留给道具锚点阶段" in character_text
    assert "尾巴状态必须明确" not in character_text
    assert "no tail / tailless" not in character_text


def test_lego_skill_keeps_style_while_recipes_are_shared_workflow_stages(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    lego_skill = skills["lego-minifigure-animation-video"]
    planning = lego_skill["planning"]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(lego_skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "LEGO Minifigure animation" in planning["prompt_guide"]
    assert "ABS 塑料材质" in planning["prompt_guide"]
    assert "LEGO building logic" in planning["prompt_guide"]
    assert "开始前" in planning["planning_notes"]
    assert "已确认信息" in planning["planning_notes"]
    assert "剧本大纲" in planning["planning_notes"]
    assert "三层分镜" in planning["planning_notes"]
    assert "视觉关键元素" in planning["planning_notes"]
    assert "视频片段" in planning["planning_notes"]
    assert "最终剪辑" in planning["planning_notes"]
    assert "Final_Video_Spec" not in planning_text
    assert "input_parameters" not in planning_text
    assert "planning.prompt_guide" not in planning_text
    assert "conduct_rules" not in planning_text
    assert "workflow-input-analysis" not in planning_text
    assert "short-film-script-outline" not in planning_text
    assert "storyboard-plan" not in planning_text
    assert "visual-key-elements" not in planning_text
    assert "storyboard-shot-video" not in planning_text
    assert "video-audio-layer" not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in [
            "short-film-script-outline",
            "storyboard-plan",
            "visual-key-elements",
            "storyboard-shot-video",
        ]
        for item in [
            recipes[recipe_id]["name"],
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            recipes[recipe_id]["result_summary"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "LEGO Minifigure" not in recipe_text
    assert "official LEGO style" not in recipe_text
    assert "ABS plastic material" not in recipe_text
    assert "Final_Video_Spec" not in recipe_text


def test_retro_kungfu_skill_keeps_style_while_recipes_stay_stage_focused(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    retro_skill = skills["retro-hong-kong-kungfu-comedy-video"]
    planning = retro_skill["planning"]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(retro_skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "1980s 复古香港功夫喜剧" in planning["prompt_guide"]
    assert "35mm 旧胶片颗粒" in planning["prompt_guide"]
    assert "港式普通话口音" in planning["prompt_guide"]
    assert "剧本大纲" in planning["planning_notes"]
    assert "分镜规划" in planning["planning_notes"]
    assert "拟人功夫关键元素图" in planning["planning_notes"]
    assert "拟人功夫单段视频" in planning["planning_notes"]
    assert "视频音频层" in planning["planning_notes"]
    assert "独立关键元素节点" in planning["planning_notes"]
    assert "不得把多个主体合并为一个关键元素节点" in planning["planning_notes"]
    assert "默认并行" in planning["planning_notes"]
    assert "真实连续性输入" in planning["planning_notes"]
    assert "Final_Video_Spec" not in planning_text
    assert "retro-kungfu" not in planning_text
    assert "four-act-comedy-story-outline" not in planning_text
    assert "storyboard-plan" not in planning_text
    assert "anthropomorphic-kungfu-shot-video" not in planning_text
    assert "video-audio-layer" not in planning_text

    recipe = recipes["anthropomorphic-kungfu-key-elements"]
    recipe_text = "\n".join(
        [
            recipe["name"],
            recipe["system_prompt"],
            recipe["planning_prompt"],
            recipe["result_summary"],
            "\n".join(recipe["must_have_items"]),
        ]
    )
    assert "拟人功夫" in recipe_text
    assert "参考来源" in recipe_text
    assert "后续引用方式" in recipe_text
    assert "35mm" not in recipe_text
    assert "港风" not in recipe_text
    assert "香港" not in recipe_text
    assert "80s" not in recipe_text
    assert "旧胶片" not in recipe_text
    assert "Final_Video_Spec" not in recipe_text
    assert "Skill 输入参数" not in recipe_text
    assert "覆盖 Skill" not in recipe_text
    assert "Recipe 内" not in recipe_text

    story_recipe = recipes["four-act-comedy-story-outline"]
    story_text = "\n".join(
        [
            story_recipe["name"],
            story_recipe["system_prompt"],
            story_recipe["planning_prompt"],
            story_recipe["result_summary"],
            "\n".join(story_recipe["must_have_items"]),
        ]
    )
    assert "四幕" in story_text
    assert "喜剧反差" in story_text
    assert "三幕结构" not in story_text
    assert "港风" not in story_text
    assert "香港" not in story_text

    shot_recipe = recipes["anthropomorphic-kungfu-shot-video"]
    shot_text = "\n".join(
        [
            shot_recipe["name"],
            shot_recipe["system_prompt"],
            shot_recipe["planning_prompt"],
            shot_recipe["result_summary"],
            "\n".join(shot_recipe["must_have_items"]),
        ]
    )
    assert "Anticipation" in shot_text
    assert "Movement" in shot_text
    assert "Completion" in shot_text
    assert "动物本能" in shot_text
    assert "no background music" in shot_text
    assert "35mm" not in shot_text
    assert "港风" not in shot_text
    assert "香港" not in shot_text
    assert "80s" not in shot_text
    assert "旧胶片" not in shot_text


def test_outdoor_stage_duel_skill_keeps_global_spec_in_skill(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    skill = skills["outdoor-stage-duel-video"]
    planning = skill["planning"]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "观众第一人称" in planning["prompt_guide"]
    assert "双角色 A/B" in planning["planning_notes"]
    assert "这个规格不创建独立节点" in planning["planning_notes"]
    assert "分镜" in planning["planning_notes"]
    assert "关键元素" in planning["planning_notes"]
    assert "单镜视频" in planning["planning_notes"]
    assert "音频层" in planning["planning_notes"]
    assert "Final_Video_Spec" not in planning_text
    assert "outdoor-stage-duel-video-spec" not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in [
            "outdoor-stage-duel-storyboard",
            "outdoor-stage-duel-key-elements",
            "outdoor-stage-duel-shot-video",
            "outdoor-stage-duel-audio-layers",
        ]
        for item in [
            recipes[recipe_id]["name"],
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            recipes[recipe_id]["result_summary"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "Final_Video_Spec" not in recipe_text
    assert "audience POV" in recipe_text
    assert "Element_Character_A" in recipe_text
    assert "Element_Character_B" in recipe_text
    assert "Beat 1" in recipe_text
    assert "Audio_BGM" in recipe_text
    assert "Audio_VO" in recipe_text


def test_ling_cage_skill_keeps_style_while_recipes_are_survival_sci_fi_stages(
    monkeypatch,
):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    skill = skills["ling-cage-cinematic-video"]
    planning = skill["planning"]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "灵笼气质" in planning["prompt_guide"]
    assert "半写实 3D CG" in planning_text
    assert "GPT Image 2" not in planning_text
    assert "Seedance 2.0" not in planning_text
    assert "同模型失败自动重试一次" not in planning_text
    assert "这个规格不创建独立节点" in planning["planning_notes"]
    assert "故事方向" in planning["planning_notes"]
    assert "分镜" in planning["planning_notes"]
    assert "关键元素图" in planning["planning_notes"]
    assert "不得只创建一个笼统的“关键元素”总节点" in planning_text
    assert "每个持续出现的角色或队伍各自独立成节点" in planning_text
    assert "每个主要复用场景各自独立成节点" in planning_text
    assert "每个 Shot List 条目必须是独立的视频 intent item" in planning_text
    assert "单镜视频" in planning["planning_notes"]
    assert "音频" in planning["planning_notes"]
    audio_mode = next(
        parameter
        for parameter in skill["input_parameters"]
        if parameter["id"] == "audio_mode"
    )
    assert audio_mode["label"] == "背景音乐"
    assert audio_mode["default"] == "生成BGM"
    assert audio_mode["options"] == ["生成BGM", "不生成BGM"]
    assert "对白旁白音效和BGM" not in planning_text
    assert "仅音效和BGM" not in planning_text
    assert "对白和音效写入对应视频提示词" in planning_text
    assert "只在需要配乐时创建 BGM 音频节点" in planning_text
    assert "Final_Video_Spec" not in planning_text
    assert "ling-cage-video-spec" not in planning_text
    assert "sci-fi-survival-story-script" not in planning_text
    assert "sci-fi-survival-storyboard" not in planning_text
    assert "sci-fi-survival-key-elements" not in planning_text
    assert "sci-fi-survival-shot-video" not in planning_text
    assert "sci-fi-survival-audio-layers" not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in [
            "sci-fi-survival-story-script",
            "sci-fi-survival-storyboard",
            "sci-fi-survival-key-elements",
            "sci-fi-survival-shot-video",
            "sci-fi-survival-audio-layers",
        ]
        for item in [
            recipes[recipe_id]["name"],
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            recipes[recipe_id]["result_summary"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "末世科幻" in recipe_text
    assert "Final_Video_Spec" not in recipe_text
    assert "灵笼" not in recipe_text
    assert "玛娜" not in recipe_text
    assert "灯塔" not in recipe_text
    assert "龙骨村" not in recipe_text
    assert "噬极兽" not in recipe_text
    assert "覆盖 Skill" not in recipe_text
    assert "Recipe 内" not in recipe_text

    audio_layer = recipes["sci-fi-survival-audio-layers"]
    audio_layer_text = "\n".join(
        [
            audio_layer["name"],
            audio_layer["system_prompt"],
            audio_layer["planning_prompt"],
            audio_layer["result_summary"],
            "\n".join(audio_layer["must_have_items"]),
        ]
    )
    assert "BGM" in audio_layer_text
    assert "Dialogue" not in audio_layer_text
    assert "Narration" not in audio_layer_text
    assert "Ambient" not in audio_layer_text
    assert "Action SFX" not in audio_layer_text
    assert "key_element_audio" not in audio_layer_text
    assert "narration_speaker_profile" not in audio_layer_text

    key_elements = recipes["sci-fi-survival-key-elements"]
    key_text = "\n".join(
        [
            key_elements["name"],
            key_elements["system_prompt"],
            key_elements["planning_prompt"],
            key_elements["result_summary"],
            "\n".join(key_elements["must_have_items"]),
        ]
    )
    assert "全身三视图" in key_text
    assert "2x2 无角色四宫格" in key_text
    assert "完整结构或多角度" in key_text
    assert "后续视频引用锚点" in key_text

    shot_text = "\n".join(
        [
            recipes["sci-fi-survival-shot-video"]["system_prompt"],
            "\n".join(recipes["sci-fi-survival-shot-video"]["must_have_items"]),
        ]
    )
    assert "image_infos 最多 9" in shot_text
    assert "audio_infos 最多 3" in shot_text
    assert "reference_video" in shot_text
    assert "back to camera" in shot_text
    assert "micro-shake" in shot_text
    assert "no subtitles" in shot_text


def test_japanese_anime_drama_skill_locks_language_and_continuity(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    skills = {item["id"]: item for item in catalog._load_skills()}
    recipes = {
        item["id"]: item
        for item in catalog._load_agent_config_items("recipes", catalog._RECIPES_DIR)
    }
    skill = skills["japanese-anime-drama-video"]
    planning = skill["planning"]
    recipe_ids = [
        "dialogue-drama-story-script",
        "dialogue-drama-storyboard-plan",
        "visual-key-elements",
        "dialogue-continuity-shot-video",
    ]
    planning_text = "\n".join(
        [
            planning["planning_notes"],
            planning["prompt_guide"],
            "\n".join(planning["conduct_rules"]),
            "\n".join(skill["evaluation"]["domain_constraints"]),
        ]
    )

    assert "日式写实动漫" in planning["prompt_guide"]
    assert "语言与口音风格" in planning_text
    assert "台湾华语" in planning_text
    assert "16:9" in planning_text
    assert "24fps" in planning_text
    assert "无 BGM" in planning_text
    assert "无字幕" in planning_text
    assert "无屏幕文字" in planning_text
    assert "1.5 秒" in planning_text
    assert "30° 规则" in planning_text
    assert "这个规格不创建独立节点" in planning["planning_notes"]
    assert "故事脚本" in planning["planning_notes"]
    assert "分镜" in planning["planning_notes"]
    assert "关键元素" in planning["planning_notes"]
    assert "不得只创建一个笼统的“关键元素”总节点" in planning_text
    assert "每个持续出现的角色各自独立成节点" in planning_text
    assert "每个主要复用场景各自独立成节点" in planning_text
    assert "每个需要跨镜保持外观一致的核心道具" in planning_text
    assert "样片" in planning["planning_notes"]
    assert "声音参考素材" in planning["planning_notes"]
    assert "口型" in planning["planning_notes"]
    assert "默认不创建独立音频节点" in planning_text
    assert "用户指定已上传或画布中的音频/视频作为声音参考" in planning_text
    assert "用 @音频N 或 @视频N 说明声音、口型、语气或节奏用途" in planning_text
    assert "voiceRef" not in planning_text
    assert "speechMode" not in planning_text
    assert "音频节点连接关系" not in planning_text
    assert (
        "最终组装、混音、4K 超分和导出交给画布合成节点处理"
        in planning["planning_notes"]
    )
    assert "<<<image_" not in planning_text
    assert "<<<video_" not in planning_text
    assert "<<<audio_" not in planning_text
    assert "image_infos" not in planning_text
    assert "audio_infos" not in planning_text
    assert "当前节点所选模型和生成模式" in planning_text
    for recipe_id in recipe_ids:
        assert recipe_id not in planning_text

    recipe_text = "\n".join(
        item
        for recipe_id in recipe_ids
        for item in [
            recipes[recipe_id]["name"],
            recipes[recipe_id]["system_prompt"],
            recipes[recipe_id]["planning_prompt"],
            recipes[recipe_id]["result_summary"],
            "\n".join(recipes[recipe_id]["must_have_items"]),
        ]
    )
    assert "日系漫剧" not in recipe_text
    for supplier in ("Seedance", "Kling", "Nano Banana", "Gemini", "GPT Image"):
        assert supplier not in planning_text
        assert supplier not in recipe_text

    key_text = "\n".join(
        [
            recipes["visual-key-elements"]["system_prompt"],
            "\n".join(recipes["visual-key-elements"]["must_have_items"]),
        ]
    )
    assert "角色、场景、道具" in key_text
    assert "多角度/表情表" in key_text
    assert "后续镜头的一致性锚点" in key_text
    assert "已确认角色、场景或道具设定" in key_text

    shot_text = "\n".join(
        [
            recipes["dialogue-continuity-shot-video"]["system_prompt"],
            "\n".join(recipes["dialogue-continuity-shot-video"]["must_have_items"]),
        ]
    )
    assert "@图片N" in shot_text
    assert "@视频N" in shot_text
    assert "@音频N" in shot_text
    assert "当前节点已连接" in shot_text
    assert "当前节点所选模型和生成模式" in shot_text
    assert "<<<image_" not in shot_text
    assert "<<<video_" not in shot_text
    assert "<<<audio_" not in shot_text
    assert "image_infos" not in shot_text
    assert "audio_infos" not in shot_text
    assert "手持呼吸感" in shot_text
    assert "偏转 15°" in shot_text
    assert "全局创作规格" in shot_text


def test_project_catalog_skills_compile_dynamic_multi_item_workflows(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)
    skill_recipes = {
        "ecommerce-ad": ("video-clip-generation", "general-image"),
        "video-tutorial": ("general-video", None),
        "text-to-image-video": ("general-video", None),
        "short-drama-quick": ("general-video", None),
        "pixar-ip-ad-video": ("storyboard-shot-video", "ad-ip-character-anchor"),
        "lego-minifigure-animation-video": (
            "storyboard-shot-video",
            "visual-key-elements",
        ),
        "outdoor-stage-duel-video": (
            "outdoor-stage-duel-shot-video",
            "outdoor-stage-duel-key-elements",
        ),
        "ling-cage-cinematic-video": (
            "sci-fi-survival-shot-video",
            "sci-fi-survival-key-elements",
        ),
        "japanese-anime-drama-video": (
            "dialogue-continuity-shot-video",
            "visual-key-elements",
        ),
    }

    for skill_id, (recipe_id, anchor_recipe_id) in skill_recipes.items():
        anchor_items = (
            [
                {
                    "id": "anchor",
                    "title": "素材锚点",
                    "prompt": "生成一致性素材锚点",
                    "recipe_id": anchor_recipe_id,
                }
            ]
            if anchor_recipe_id
            else []
        )
        compiled = catalog.compile_workflow_intent(
            {
                "schema_version": "freezone_workflow_intent.v1",
                "skill_id": skill_id,
                "user_goal": f"测试 {skill_id}",
                "items": anchor_items
                + [
                    {
                        "id": f"shot_{index}",
                        "title": f"镜头 {index}",
                        "prompt": f"测试镜头 {index}",
                        "recipe_id": recipe_id,
                        **({"depends_on": ["anchor"]} if anchor_recipe_id else {}),
                    }
                    for index in range(1, 4)
                ],
            }
        )

        assert compiled["ok"] is True, (skill_id, compiled)
        assert catalog.validate_agent_workflow_plan(compiled["plan"])["ok"] is True
        assert compiled["plan"]["nodes"][-1]["node_type"] == "videoComposeNode"


def test_short_drama_quick_expands_shot_voice_and_background_music(monkeypatch):
    catalog = _load_catalog_module()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)

    compiled = catalog.compile_workflow_intent(
        {
            "schema_version": "freezone_workflow_intent.v1",
            "skill_id": "short-drama-quick",
            "user_goal": "制作两镜头悬疑短剧",
            "items": [
                {
                    "id": "clip_1",
                    "title": "镜头一",
                    "prompt": "便利店外景",
                    "recipe_id": "general-video",
                },
                {
                    "id": "clip_2",
                    "title": "镜头二",
                    "prompt": "店员看向监控",
                    "recipe_id": "general-video",
                },
                {
                    "id": "voice_1",
                    "title": "镜头一旁白",
                    "prompt": "深夜的便利店，只有他一个人。",
                    "narration": "深夜的便利店，只有他一个人。",
                    "recipe_id": "drama-shot-voice",
                    "depends_on": ["clip_1"],
                    "timeline_role": "shot_voice",
                },
                {
                    "id": "voice_2",
                    "title": "镜头二旁白",
                    "prompt": "监控里的自己，为什么没有同步动作？",
                    "narration": "监控里的自己，为什么没有同步动作？",
                    "recipe_id": "drama-shot-voice",
                    "depends_on": ["clip_2"],
                    "timeline_role": "shot_voice",
                },
                {
                    "id": "background_music",
                    "title": "背景音乐",
                    "prompt": "悬疑氛围纯音乐",
                    "recipe_id": "drama-background-music",
                    "timeline_role": "background_music",
                },
            ],
        }
    )

    assert compiled["ok"] is True
    plan = compiled["plan"]
    voice_nodes = [
        node
        for node in plan["nodes"]
        if node["data"].get("workflowCatalog", {}).get("timelineRole") == "shot_voice"
    ]
    bgm_nodes = [
        node
        for node in plan["nodes"]
        if node["data"].get("workflowCatalog", {}).get("timelineRole")
        == "background_music"
    ]
    assert [node["data"]["text"] for node in voice_nodes] == [
        "深夜的便利店，只有他一个人。",
        "监控里的自己，为什么没有同步动作？",
    ]
    assert all(node["data"]["audioKind"] == "speech" for node in voice_nodes)
    assert all(
        node["data"]["workflowCatalog"]["timelineRole"] == "shot_voice"
        for node in voice_nodes
    )
    assert len(bgm_nodes) == 1
    assert bgm_nodes[0]["data"]["audioKind"] == "music"
    assert bgm_nodes[0]["data"]["workflowCatalog"]["timelineRole"] == "background_music"
    assert {
        (edge["source"], edge["target"])
        for edge in plan["edges"]
        if edge["target"].startswith("voice_")
    } == {
        ("clip_1", "voice_1"),
        ("clip_2", "voice_2"),
    }

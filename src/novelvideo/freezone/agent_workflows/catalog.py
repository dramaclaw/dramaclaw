"""Resolve Workflow Skills and validate agent-authored dynamic workflow plans."""

from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

try:
    from novelvideo.freezone.agent_config_store import list_user_agent_config_items
except Exception:  # pragma: no cover - Hermes can run before app imports are available.
    list_user_agent_config_items = None

try:
    from novelvideo.freezone.workflow_plan import (
        ALLOWED_LINK_TYPES,
        ALLOWED_NODE_TYPES,
        validate_workflow_plan,
    )
except Exception:  # pragma: no cover - Hermes can run before app imports are available.
    validate_workflow_plan = None
    ALLOWED_LINK_TYPES = set()
    ALLOWED_NODE_TYPES = set()

PLAN_SCHEMA_VERSION = "freezone_workflow_plan.v1"
WORKFLOW_INTENT_SCHEMA_VERSION = "freezone_workflow_intent.v1"

_ROOT = Path(__file__).resolve().parents[4]
_CATALOG_ROOT = _ROOT / "src" / "novelvideo" / "freezone" / "agent_catalog" / "builtins"
_SKILLS_DIR = _CATALOG_ROOT / "skills"
_RECIPES_DIR = _CATALOG_ROOT / "recipes"
# Compatibility overlay for legacy installations and project-local catalog
# extensions. Built-in shared catalog data lives under
# ``src/novelvideo/freezone/agent_catalog`` and no longer depends on Hermes.
_PLUGIN_CATALOG_ROOT = _ROOT / ".hermes" / "plugins" / "freezone" / "catalog"
_PLUGIN_SKILLS_DIR = _PLUGIN_CATALOG_ROOT / "skills"
_PLUGIN_RECIPES_DIR = _PLUGIN_CATALOG_ROOT / "recipes"

_NODE_TYPE_BY_OUTPUT_KIND = {
    "text": "textAnnotationNode",
    "image": "imageGenNode",
    "video": "videoNode",
    "audio": "audioNode",
}

_STAGE_BY_NODE_TYPE = {
    "textAnnotationNode": "story",
    "scriptNode": "story",
    "beatContextNode": "beat",
    "imageGenNode": "image",
    "videoNode": "video",
    "audioNode": "audio",
    "videoComposeNode": "compose",
}

_CAPABILITY_BY_NODE_TYPE = {
    "textAnnotationNode": "textGeneration",
    "scriptNode": "textGeneration",
    "beatContextNode": "textGeneration",
    "imageGenNode": "imageGeneration",
    "videoNode": "videoGeneration",
    "audioNode": "audioGeneration",
    "videoComposeNode": "videoCompose",
}

_OUTPUT_KIND_BY_CAPABILITY = {
    "textGeneration": "text",
    "imageGeneration": "image",
    "videoGeneration": "video",
    "audioGeneration": "audio",
}

# These built-in prompt Recipes consume the user goal or upstream structured text.
# Older catalog copies marked them as requiring binary media, which makes valid
# text-first blueprints impossible to compile.
_TEXT_FIRST_BUILTIN_RECIPE_IDS = {
    "digital-product-text-plan",
    "drama-character-extraction",
    "drama-character-turnaround",
    "drama-plot-outline",
    "drama-prop-extraction",
    "drama-prop-image",
    "drama-scene-extraction",
    "drama-scene-image",
    "drama-shot-group-detail",
    "drama-shot-planning",
    "ecommerce-text-plan",
    "keyframe-scene-script",
    "social-copywriting",
    "video-ad-brief",
    "video-ad-creative-outline",
    "video-creative-outline",
    "video-storyboard-grid",
    "video-storyboard-script",
}

_DETERMINISTIC_SKILL_PLANNERS = {
    "ecommerce-ad": {
        "default_item_count": 3,
        "deliverables": ["images", "video", "mixed"],
        "default_deliverable": "video",
        "default_include_audio": True,
    },
    "text-to-image-video": {
        "default_item_count": 3,
        "deliverables": ["video"],
        "default_deliverable": "video",
        "default_include_audio": False,
    },
    "video-tutorial": {
        "default_item_count": 3,
        "deliverables": ["video"],
        "default_deliverable": "video",
        "default_include_audio": True,
    },
    "short-drama-quick": {
        "default_item_count": 3,
        "deliverables": ["video"],
        "default_deliverable": "video",
        "default_include_audio": True,
    },
}


def _workflow_input_values(args: dict[str, Any]) -> dict[str, Any]:
    value = args.get("inputs")
    if isinstance(value, dict):
        return dict(value)
    return {}


def _parameter_option_values(parameter: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for option in parameter.get("options") or []:
        value = (
            _text(option.get("value")) if isinstance(option, dict) else _text(option)
        )
        if value:
            values.append(value)
    return values


def _is_missing_parameter_value(value: Any) -> bool:
    return value is None or value == "" or value == []


def _allowed_inferred_option(parameter: dict[str, Any], value: str) -> str | None:
    return value if value in _parameter_option_values(parameter) else None


def _infer_parameter_value(parameter: dict[str, Any], user_goal: str) -> Any:
    """Extract only unambiguous structured values from the user's own words."""
    parameter_id = _text(parameter.get("id"))
    goal = user_goal.strip()
    lowered = goal.lower()
    if not parameter_id or not goal:
        return None

    options = [
        item for item in parameter.get("options") or [] if isinstance(item, dict)
    ]
    for option in options:
        value = _text(option.get("value"))
        label = _text(option.get("label"))
        if label and label.lower() in lowered:
            return value

    if parameter_id in {"aspect_ratio", "aspectRatio"}:
        ratio_match = re.search(r"(?<!\d)(\d{1,2}\s*:\s*\d{1,2})(?!\d)", goal)
        if ratio_match:
            ratio = re.sub(r"\s+", "", ratio_match.group(1))
            return _allowed_inferred_option(parameter, ratio)
        aliases = (
            (("竖屏", "竖版", "vertical", "portrait"), "9:16"),
            (("横屏", "横版", "landscape"), "16:9"),
            (("方形", "正方形", "square"), "1:1"),
            (("宽画幅", "超宽屏", "ultrawide"), "21:9"),
        )
        for keywords, value in aliases:
            if any(keyword in lowered for keyword in keywords):
                return _allowed_inferred_option(parameter, value)

    if parameter_id == "execution_mode":
        if any(
            keyword in lowered
            for keyword in (
                "只创建",
                "仅创建",
                "不执行",
                "不自动执行",
                "不要执行",
                "手动执行",
            )
        ):
            return _allowed_inferred_option(parameter, "manual")
        if any(
            keyword in lowered
            for keyword in ("自动执行", "自动运行", "直接执行", "直接生成")
        ):
            return _allowed_inferred_option(parameter, "auto")

    if parameter_id == "voice_mode":
        voice_aliases = (
            (("无对白", "不要对白", "纯音乐"), "no_dialogue"),
            (("旁白", "解说"), "voiceover"),
            (("对白", "对话"), "dialogue"),
        )
        for keywords, value in voice_aliases:
            if any(keyword in lowered for keyword in keywords):
                return _allowed_inferred_option(parameter, value)

    if parameter_id in {"duration", "duration_seconds"}:
        duration_match = re.search(
            r"(?<!\d)(\d{1,4})\s*(?:秒|s\b|sec(?:ond)?s?\b)", lowered
        )
        if duration_match:
            seconds = int(duration_match.group(1))
            exact = _allowed_inferred_option(parameter, str(seconds))
            if exact is not None:
                return exact
            for option in options:
                value = _text(option.get("value"))
                range_match = re.fullmatch(r"(\d+)[_-](\d+)", value)
                if range_match and int(range_match.group(1)) <= seconds <= int(
                    range_match.group(2)
                ):
                    return value

    if parameter_id in {
        "count",
        "item_count",
        "image_count",
        "shot_count",
        "beat_count",
    }:
        count_match = re.search(
            r"(?<!\d)(\d{1,2})\s*(?:张|幅|屏|个|段|条|镜头|镜)(?!\d)", goal
        )
        if count_match:
            return int(count_match.group(1))

    return None


def _infer_workflow_inputs(
    skill: dict[str, Any], args: dict[str, Any]
) -> dict[str, Any]:
    user_goal = _workflow_goal_text(args)
    inferred: dict[str, Any] = {}
    for parameter in skill.get("input_parameters") or []:
        if not isinstance(parameter, dict):
            continue
        parameter_id = _text(parameter.get("id"))
        value = _infer_parameter_value(parameter, user_goal)
        if parameter_id and not _is_missing_parameter_value(value):
            inferred[parameter_id] = value
    return inferred


def _skill_input_contract(
    skill: dict[str, Any], args: dict[str, Any]
) -> dict[str, Any]:
    raw_parameters = skill.get("input_parameters") or []
    parameters = [item for item in raw_parameters if isinstance(item, dict)]
    provided = _workflow_input_values(args)
    inferred = _infer_workflow_inputs(skill, args)
    effective = {**inferred, **provided}
    resolved: dict[str, Any] = {}
    missing_required: list[str] = []
    errors: list[dict[str, str]] = []
    fields: list[dict[str, Any]] = []

    for parameter in parameters:
        parameter_id = _text(parameter.get("id"))
        if not parameter_id:
            continue
        has_provided_value = parameter_id in provided
        has_inferred_value = parameter_id in inferred and not has_provided_value
        value = (
            effective.get(parameter_id)
            if parameter_id in effective
            else deepcopy(parameter.get("default"))
        )
        required = bool(parameter.get("required"))
        parameter_type = _text(parameter.get("type")) or "text"
        option_values = _parameter_option_values(parameter)
        if required and _is_missing_parameter_value(value):
            missing_required.append(parameter_id)
        elif not _is_missing_parameter_value(value):
            if parameter_type == "multi_select":
                if not isinstance(value, list):
                    errors.append(
                        {
                            "path": f"inputs.{parameter_id}",
                            "message": "must be an array",
                        }
                    )
                else:
                    invalid = [
                        str(item)
                        for item in value
                        if option_values and str(item) not in option_values
                    ]
                    if invalid:
                        errors.append(
                            {
                                "path": f"inputs.{parameter_id}",
                                "message": f"unsupported option: {invalid[0]}",
                            }
                        )
            elif option_values and str(value) not in option_values:
                errors.append(
                    {
                        "path": f"inputs.{parameter_id}",
                        "message": f"unsupported option: {value}",
                    }
                )
            resolved[parameter_id] = value
        fields.append(
            {
                "id": parameter_id,
                "label": _text(parameter.get("label")) or parameter_id,
                "type": parameter_type,
                "required": required,
                "default": deepcopy(parameter.get("default")),
                "options": deepcopy(parameter.get("options") or []),
                "value": deepcopy(value),
                "source": (
                    "user"
                    if has_provided_value
                    else "inferred" if has_inferred_value else "default"
                ),
            }
        )

    execution_mode = _text(resolved.get("execution_mode")) or "manual"
    return {
        "schema_version": "freezone_skill_inputs.v1",
        "fields": fields,
        "provided": provided,
        "inferred": inferred,
        "resolved": resolved,
        "missing_required": missing_required,
        "errors": errors,
        "ready_for_planning": not missing_required and not errors,
        "requires_confirmation": bool(fields),
        "execution_mode": execution_mode,
        "recommended_run_after_create": execution_mode == "auto",
        "execution_policy": deepcopy(skill.get("execution_policy") or {}),
    }


def get_workflow_skill(args: dict[str, Any]) -> dict[str, Any]:
    """Return one complete planning package for an explicitly selected Skill."""
    skill_id = _text(args.get("skill_id") or args.get("skillId") or args.get("id"))
    if not skill_id:
        return {
            "ok": False,
            "status": "skill_id_required",
            "error": "skill_id is required",
        }
    skill = _load_skill(skill_id)
    if skill is None or skill.get("_disabled") is True:
        return {
            "ok": False,
            "status": "workflow_skill_not_found",
            "error": f"workflow skill not found: {skill_id}",
            "available_skill_ids": sorted(
                _text(item.get("id"))
                for item in _load_skills()
                if _text(item.get("id")) and item.get("_disabled") is not True
            ),
        }

    recipes = [
        recipe
        for recipe in _load_agent_config_items("recipes", _RECIPES_DIR)
        if recipe.get("enabled") is not False and _text(recipe.get("id"))
    ]
    allowed_capabilities = _skill_capabilities(skill)
    candidate_recipes = _workflow_skill_recipe_candidates(
        skill,
        recipes,
        allowed_capabilities=allowed_capabilities,
    )
    referenced_recipe_ids = _skill_referenced_recipe_ids(skill)
    selected_recipes = [
        recipe
        for recipe in candidate_recipes
        if _recipe_matches_references(recipe, referenced_recipe_ids)
    ]
    full_recipes = [_without_private_fields(recipe) for recipe in selected_recipes]
    recipe_summaries = [_recipe_planning_summary(recipe) for recipe in selected_recipes]
    recipes_by_output_kind: dict[str, list[str]] = {}
    source_anchor_recipe_ids: dict[str, list[str]] = {}
    for recipe in recipe_summaries:
        output_kind = _text(recipe.get("output_kind"))
        recipe_id = _text(recipe.get("id"))
        if not output_kind or not recipe_id:
            continue
        recipes_by_output_kind.setdefault(output_kind, []).append(recipe_id)
        if not recipe.get("requires_source_media"):
            source_anchor_recipe_ids.setdefault(output_kind, []).append(recipe_id)
    input_contract = _skill_input_contract(skill, args)
    compact = bool(args.get("compact"))
    planning_skill = _without_private_fields(skill)
    return {
        "ok": True,
        "schema_version": "freezone_workflow_skill_package.v1",
        "skill_id": _text(skill.get("id")),
        "user_goal": _workflow_goal_text(args),
        "source": _catalog_source(skill),
        "skill": planning_skill,
        "recipes": [] if compact else full_recipes,
        "recipe_definitions_omitted": compact,
        "available_recipes": recipe_summaries,
        "capabilities": [
            {
                "id": capability,
                "output_kind": _OUTPUT_KIND_BY_CAPABILITY.get(
                    capability, "composition"
                ),
                "node_type": next(
                    (
                        node_type
                        for node_type, mapped_capability in _CAPABILITY_BY_NODE_TYPE.items()
                        if mapped_capability == capability
                    ),
                    "",
                ),
            }
            for capability in allowed_capabilities
        ],
        "allowed_node_types": sorted(
            node_type
            for node_type, capability in _CAPABILITY_BY_NODE_TYPE.items()
            if capability in allowed_capabilities
        ),
        "allowed_link_types": sorted(ALLOWED_LINK_TYPES),
        "input_contract": input_contract,
        "planning_contract": {
            "schema_version": PLAN_SCHEMA_VERSION,
            "workflow_type_prefix": "dynamic.",
            "mode": "dynamic_only",
            "requires_agent_authored_topology": (
                _text(skill.get("id")) not in _DETERMINISTIC_SKILL_PLANNERS
            ),
            "custom_items_require_agent_authored_topology": True,
            "requires_explicit_skill_id": True,
            "requires_explicit_recipe_id": (
                _text(skill.get("id")) not in _DETERMINISTIC_SKILL_PLANNERS
            ),
            "custom_items_require_explicit_recipe_id": True,
            "topology_modes": (
                ["standard_planner", "custom_items"]
                if _text(skill.get("id")) in _DETERMINISTIC_SKILL_PLANNERS
                else ["custom_items"]
            ),
            "standard_planner": deepcopy(
                _DETERMINISTIC_SKILL_PLANNERS.get(_text(skill.get("id"))) or {}
            ),
            "supports_ordered_recipe_pipeline": True,
            "strict_validation": True,
            "plan_inputs_field": "inputs",
            "max_nodes": 200,
            "max_edges": 400,
            "missing_source_media": {
                "strategy": "generate_anchor_then_continue",
                "anchor_recipe_requires_source_media": False,
                "dependency_link_type": "media_input_for",
                "source_anchor_recipe_ids": source_anchor_recipe_ids,
            },
            "recipe_ids_by_output_kind": recipes_by_output_kind,
            "recipe_selection_rule": (
                "Recipe output_kind must match the node type. For a generated source-media "
                "anchor, choose a same-output Recipe listed in source_anchor_recipe_ids; "
                "never copy a downstream text Recipe onto an image anchor."
            ),
        },
        "message": (
            "已加载完整 Workflow Skill 包，可直接规划 freezone_workflow_plan.v1。"
            if input_contract["ready_for_planning"]
            else "已加载 Workflow Skill，但必须先补全或修正 input_contract。"
        ),
    }


def compile_workflow_intent(intent: Any) -> dict[str, Any]:
    """Compile a compact Agent decision into a complete, validated dynamic plan."""
    if not isinstance(intent, dict):
        return _intent_error("intent must be an object", path="intent")
    schema_version = _text(intent.get("schema_version"))
    if schema_version and schema_version != WORKFLOW_INTENT_SCHEMA_VERSION:
        return _intent_error(
            f"schema_version must equal {WORKFLOW_INTENT_SCHEMA_VERSION}",
            path="schema_version",
        )
    skill_id = _text(intent.get("skill_id") or intent.get("skillId"))
    if not skill_id:
        return _intent_error("skill_id is required", path="skill_id")
    skill = _load_skill(skill_id)
    if skill is None or skill.get("_disabled") is True:
        return _intent_error(f"workflow skill not found: {skill_id}", path="skill_id")

    user_goal = _workflow_goal_text(intent)
    if not user_goal:
        return _intent_error("user_goal is required", path="user_goal")
    input_contract = _skill_input_contract(skill, intent)
    if input_contract["errors"] or input_contract["missing_required"]:
        errors = list(input_contract["errors"])
        errors.extend(
            {
                "path": f"inputs.{parameter_id}",
                "message": "required Skill input is missing",
                "hint": (
                    f"Provide inputs.{parameter_id}; its definition (type, "
                    "description, allowed values) is in the input_contract "
                    "returned by freezone_get_workflow_skill."
                ),
            }
            for parameter_id in input_contract["missing_required"]
        )
        return {
            "ok": False,
            "status": "invalid_workflow_intent",
            "error": errors[0]["message"],
            "errors": errors,
            "agent_instruction": _INTENT_FIX_INSTRUCTION,
        }

    compiled_intent = deepcopy(intent)
    planner_metadata: dict[str, Any] | None = None
    if not _intent_items(compiled_intent):
        compiled_intent, planner_metadata, planner_error = (
            _expand_standard_skill_intent(
                intent=compiled_intent,
                skill_id=skill_id,
                user_goal=user_goal,
                resolved_inputs=input_contract["resolved"],
            )
        )
        if planner_error is not None:
            return planner_error

    compiled = _compile_dynamic_recipe_items_intent(
        intent=compiled_intent,
        skill=skill,
        user_goal=user_goal,
        resolved_inputs=input_contract["resolved"],
    )
    if compiled.get("ok") and planner_metadata is not None:
        compiled["planner"] = planner_metadata
        plan = compiled.get("plan")
        if isinstance(plan, dict):
            plan["planner"] = deepcopy(planner_metadata)
    return compiled

def _standard_skill_items(
    *,
    skill_id: str,
    deliverable: str,
    include_audio: bool,
    units: list[dict[str, Any]],
    user_goal: str,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if skill_id == "ecommerce-ad":
        items.append(
            _planned_item(
                item_id="creative_outline",
                title="广告创意大纲",
                prompt=user_goal,
                recipe_id="video-ad-creative-outline",
                depends_on=["workflow_input"],
                stage="planning",
            )
        )
        items.append(
            _planned_item(
                item_id="product_reference",
                title="商品视觉锚点",
                prompt=f"{user_goal}，生成稳定一致的商品主体参考图",
                recipe_id="general-image",
                depends_on=["creative_outline"],
                stage="assets",
            )
        )
        for index, unit in enumerate(units, 1):
            image_id = f"scene_{index}"
            items.append(
                _planned_item(
                    item_id=image_id,
                    title=unit["title"],
                    prompt=unit["prompt"],
                    recipe_id="ecommerce-scene-image",
                    depends_on=["product_reference"],
                    stage="images",
                )
            )
            if deliverable != "images":
                items.append(
                    _planned_item(
                        item_id=f"clip_{index}",
                        title=f"{unit['title']}视频",
                        prompt=unit["prompt"],
                        recipe_id="video-clip-generation",
                        depends_on=[image_id],
                        stage="video",
                        timeline_role="visual",
                        duration_seconds=unit.get("duration_seconds"),
                    )
                )
            if include_audio:
                items.append(
                    _planned_item(
                        item_id=f"voice_{index}",
                        title=f"{unit['title']}旁白",
                        prompt=unit["narration"],
                        narration=unit["narration"],
                        recipe_id="general-audio",
                        depends_on=["creative_outline"],
                        stage="audio",
                        timeline_role="voiceover",
                    )
                )
        return items

    outline_recipe = {
        "text-to-image-video": "video-creative-outline",
        "video-tutorial": "general-text",
        "short-drama-quick": "drama-plot-outline",
    }[skill_id]
    items.append(
        _planned_item(
            item_id="outline",
            title="内容规划",
            prompt=user_goal,
            recipe_id=outline_recipe,
            depends_on=["workflow_input"],
            stage="planning",
        )
    )
    for index, unit in enumerate(units, 1):
        if skill_id == "short-drama-quick":
            source_id = f"shot_plan_{index}"
            items.append(
                _planned_item(
                    item_id=source_id,
                    title=f"{unit['title']}镜头设计",
                    prompt=unit["prompt"],
                    recipe_id="drama-shot-group-detail",
                    depends_on=["outline"],
                    stage="shots",
                )
            )
        else:
            source_id = f"frame_{index}"
            items.append(
                _planned_item(
                    item_id=source_id,
                    title=f"{unit['title']}画面",
                    prompt=unit["prompt"],
                    recipe_id="general-image",
                    depends_on=["outline"],
                    stage="images",
                )
            )
        items.append(
            _planned_item(
                item_id=f"clip_{index}",
                title=f"{unit['title']}视频",
                prompt=unit["prompt"],
                recipe_id="general-video",
                depends_on=[source_id],
                stage="video",
                timeline_role="visual",
                duration_seconds=unit.get("duration_seconds"),
            )
        )
        if include_audio and skill_id in {"video-tutorial", "short-drama-quick"}:
            items.append(
                _planned_item(
                    item_id=f"voice_{index}",
                    title=f"{unit['title']}旁白",
                    prompt=unit["narration"],
                    narration=unit["narration"],
                    recipe_id=(
                        "drama-shot-voice"
                        if skill_id == "short-drama-quick"
                        else "general-audio"
                    ),
                    depends_on=[source_id],
                    stage="audio",
                    timeline_role="voiceover",
                )
            )
    if include_audio and skill_id == "short-drama-quick":
        items.append(
            _planned_item(
                item_id="background_music",
                title="背景音乐",
                prompt=f"{user_goal}，生成与情绪节奏匹配的纯音乐",
                recipe_id="drama-background-music",
                depends_on=["outline"],
                stage="audio",
                timeline_role="music",
            )
        )
    return items


def _standard_planner_units(
    *,
    planner: dict[str, Any],
    item_count: int,
    user_goal: str,
    resolved_inputs: dict[str, Any],
) -> list[dict[str, Any]]:
    raw_units = planner.get("units")
    source_units = raw_units if isinstance(raw_units, list) else []
    units: list[dict[str, Any]] = []
    for index in range(item_count):
        raw_unit = source_units[index] if index < len(source_units) else {}
        if isinstance(raw_unit, str):
            raw_unit = {"title": raw_unit, "prompt": raw_unit}
        if not isinstance(raw_unit, dict):
            raw_unit = {}
        number = index + 1
        title = (
            _text(raw_unit.get("title") or raw_unit.get("name")) or f"内容段 {number}"
        )
        prompt = (
            _text(
                raw_unit.get("prompt")
                or raw_unit.get("description")
                or raw_unit.get("goal")
            )
            or f"{user_goal}，第 {number} 段：{title}"
        )
        narration = _text(
            raw_unit.get("narration")
            or raw_unit.get("voiceover")
            or raw_unit.get("dialogue")
        )
        duration_seconds = _positive_duration_seconds(
            raw_unit.get("duration_seconds")
            or raw_unit.get("durationSeconds")
            or raw_unit.get("duration")
        )
        units.append(
            {
                "title": title,
                "prompt": prompt,
                "narration": narration,
                **(
                    {"duration_seconds": duration_seconds}
                    if duration_seconds is not None
                    else {}
                ),
            }
        )

    total_duration_seconds = _planner_total_duration_seconds(
        planner=planner,
        resolved_inputs=resolved_inputs,
        user_goal=user_goal,
    )
    if total_duration_seconds is not None:
        missing_indices = [
            index for index, unit in enumerate(units) if "duration_seconds" not in unit
        ]
        explicit_total = sum(
            int(unit["duration_seconds"])
            for unit in units
            if "duration_seconds" in unit
        )
        remaining = total_duration_seconds - explicit_total
        if missing_indices and remaining >= len(missing_indices):
            base, extra = divmod(remaining, len(missing_indices))
            for offset, index in enumerate(missing_indices):
                units[index]["duration_seconds"] = base + (1 if offset < extra else 0)
    return units


def _planned_item(
    *,
    item_id: str,
    title: str,
    prompt: str,
    recipe_id: str,
    depends_on: list[str],
    stage: str,
    narration: str = "",
    timeline_role: str = "",
    duration_seconds: int | None = None,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "title": title,
        "prompt": prompt,
        "recipe_id": recipe_id,
        "depends_on": depends_on,
        "stage": stage,
        **({"narration": narration} if narration else {}),
        **({"timeline_role": timeline_role} if timeline_role else {}),
        **(
            {"duration_seconds": duration_seconds}
            if duration_seconds is not None
            else {}
        ),
    }


def _expand_standard_skill_intent(
    *,
    intent: dict[str, Any],
    skill_id: str,
    user_goal: str,
    resolved_inputs: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
    profile = _DETERMINISTIC_SKILL_PLANNERS.get(skill_id)
    if profile is None:
        return (
            intent,
            None,
            _intent_error(
                "dynamic workflow intent must include at least one recipe-backed item",
                path="items",
            ),
        )
    raw_planner = intent.get("planner")
    if raw_planner is not None and not isinstance(raw_planner, dict):
        return intent, None, _intent_error("planner must be an object", path="planner")
    planner = raw_planner if isinstance(raw_planner, dict) else {}
    mode = _text(planner.get("mode")) or "standard"
    if mode != "standard":
        return (
            intent,
            None,
            _intent_error(
                "planner.mode must equal standard",
                path="planner.mode",
            ),
        )
    deliverable = _text(planner.get("deliverable")) or profile["default_deliverable"]
    if deliverable not in profile["deliverables"]:
        return (
            intent,
            None,
            _intent_error(
                f"planner.deliverable is not supported by Skill {skill_id}: {deliverable}",
                path="planner.deliverable",
            ),
        )
    raw_count = planner.get("item_count", planner.get("itemCount"))
    if raw_count is None:
        item_count = int(profile["default_item_count"])
    elif isinstance(raw_count, int) and not isinstance(raw_count, bool):
        item_count = raw_count
    else:
        return (
            intent,
            None,
            _intent_error(
                "planner.item_count must be an integer",
                path="planner.item_count",
            ),
        )
    if not 1 <= item_count <= 12:
        return (
            intent,
            None,
            _intent_error(
                "planner.item_count must be between 1 and 12",
                path="planner.item_count",
            ),
        )
    planner_include_audio = planner.get("include_audio")
    if planner_include_audio is not None and not isinstance(
        planner_include_audio, bool
    ):
        return (
            intent,
            None,
            _intent_error(
                "planner.include_audio must be a boolean",
                path="planner.include_audio",
            ),
        )
    if planner.get("units") is not None and not isinstance(planner.get("units"), list):
        return (
            intent,
            None,
            _intent_error(
                "planner.units must be an array",
                path="planner.units",
            ),
        )
    include_audio = _intent_bool(
        intent,
        "include_audio",
        (
            planner_include_audio
            if isinstance(planner_include_audio, bool)
            else profile["default_include_audio"]
        ),
    )
    if deliverable == "images":
        include_audio = False
    units = _standard_planner_units(
        planner=planner,
        item_count=item_count,
        user_goal=user_goal,
        resolved_inputs=resolved_inputs,
    )
    if include_audio:
        for index, unit in enumerate(units):
            narration = _text(unit.get("narration"))
            title = _text(unit.get("title"))
            if not narration:
                return (
                    intent,
                    None,
                    _intent_error(
                        f"planner.units.{index} is missing narration; when "
                        "include_audio=true EVERY unit must carry its own "
                        "literal narration text (narration on another unit "
                        "does not cover this one)",
                        path=f"planner.units.{index}.narration",
                        hint=(
                            "Add narration to each unit: the exact sentence(s) the "
                            "voice-over should speak aloud for that unit, in the "
                            "user's language. If you want one overall voice-over "
                            "line instead of per-unit narration, drop the planner "
                            "units and plan explicit items with a single speech "
                            "audio item carrying that line. If the user did not "
                            "ask for audio, set include_audio=false."
                        ),
                    ),
                )
            if narration == title or re.fullmatch(
                r"(?:这是)?(?:短剧|视频)?的?第?[一二三四五六七八九十\d]+段(?:旁白|解说)[。.!！]?",
                narration,
            ):
                return (
                    intent,
                    None,
                    _intent_error(
                        "speech audio requires the literal narration text; "
                        "do not use a placeholder or a request to generate narration",
                        path=f"planner.units.{index}.narration",
                        hint=(
                            "Write the exact sentence(s) the voice-over should speak "
                            "aloud for this unit, in the user's language. Placeholders "
                            'like "第一段旁白" / "这是短剧的第二段解说" and unit titles '
                            "are rejected. Example: \"深夜的便利店，只有他一个人。\" "
                            "If include_audio was not requested by the user, set "
                            "include_audio=false instead of inventing narration."
                        ),
                    ),
                )
    items = _standard_skill_items(
        skill_id=skill_id,
        deliverable=deliverable,
        include_audio=include_audio,
        units=units,
        user_goal=user_goal,
    )
    expanded = {
        **intent,
        "items": items,
        "include_audio": include_audio,
        "include_compose": deliverable != "images",
    }
    metadata = {
        "mode": "deterministic_standard",
        "skill_id": skill_id,
        "deliverable": deliverable,
        "item_count": len(units),
        "include_audio": include_audio,
    }
    return expanded, metadata, None


def _compile_dynamic_recipe_items_intent(
    *,
    intent: dict[str, Any],
    skill: dict[str, Any],
    user_goal: str,
    resolved_inputs: dict[str, Any],
) -> dict[str, Any]:
    items = _intent_items(intent)
    if not items:
        return _intent_error(
            "dynamic workflow intent must include at least one recipe-backed item",
            path="items",
        )

    recipes = _intent_recipe_index()
    allowed_recipe_ids = {
        _text(item) for item in skill.get("allowed_recipe_ids") or [] if _text(item)
    }
    nodes: list[dict[str, Any]] = [
        {
            "id": "workflow_input",
            "node_type": "textAnnotationNode",
            "name": "用户需求 / 输入素材",
            "description": user_goal,
            "stage": "input",
            "data": {
                "displayName": "用户需求 / 输入素材",
                "title": "用户需求 / 输入素材",
                "content": user_goal,
                "prompt": user_goal,
                "workflowCatalogRole": "user_input",
            },
        }
    ]
    node_types = {"workflow_input": "textAnnotationNode"}
    node_recipes: dict[str, dict[str, Any] | None] = {"workflow_input": None}
    node_requires_source: dict[str, bool] = {"workflow_input": False}
    item_by_id: dict[str, dict[str, Any]] = {}
    phases: list[str] = []
    include_audio = _intent_bool(intent, "include_audio", True)
    include_compose = _intent_bool(intent, "include_compose", True)

    for index, item in enumerate(items):
        item_id = _safe_id(_text(item.get("id")) or f"item_{index + 1}")
        if item_id == "workflow_input" or item_id in item_by_id:
            return _intent_error(
                f"duplicate or reserved dynamic item id: {item_id}",
                path=f"items.{index}.id",
            )
        recipe_id = _text(item.get("recipe_id") or item.get("recipeId"))
        recipe = recipes.get(recipe_id)
        canonical_recipe_id = _text(recipe.get("id")) if recipe else ""
        if not recipe_id or recipe is None:
            return _intent_error(
                f"unknown Recipe for dynamic item {item_id}: {recipe_id or '<missing>'}",
                path=f"items.{index}.recipe_id",
            )
        if canonical_recipe_id not in allowed_recipe_ids:
            return _intent_error(
                f"Recipe {canonical_recipe_id} is not allowed by Skill {_text(skill.get('id'))}",
                path=f"items.{index}.recipe_id",
            )
        if _text(recipe.get("output_kind")) == "audio" and not include_audio:
            continue
        if include_compose and _is_redundant_compose_item(item_id, item):
            # The compiler appends one real videoComposeNode below. A Recipe-backed
            # "final compose" video item would instead call Seedance R2V with every
            # completed clip and exceed its reference-video duration limit.
            continue
        recipe_pipeline: list[dict[str, Any]] = []
        raw_pipeline = item.get("recipe_pipeline") or item.get("recipePipeline") or []
        if not isinstance(raw_pipeline, list):
            return _intent_error(
                "recipe_pipeline must be an array",
                path=f"items.{index}.recipe_pipeline",
            )
        for pipeline_index, pipeline_value in enumerate(raw_pipeline[:6]):
            pipeline_id = _text(
                pipeline_value.get("id")
                if isinstance(pipeline_value, dict)
                else pipeline_value
            )
            pipeline_recipe = recipes.get(pipeline_id)
            canonical_pipeline_id = (
                _text(pipeline_recipe.get("id")) if pipeline_recipe else ""
            )
            if not canonical_pipeline_id:
                return _intent_error(
                    f"unknown Recipe in pipeline: {pipeline_id or '<missing>'}",
                    path=f"items.{index}.recipe_pipeline.{pipeline_index}",
                )
            if canonical_pipeline_id not in allowed_recipe_ids:
                return _intent_error(
                    f"Recipe {canonical_pipeline_id} is not allowed by Skill "
                    f"{_text(skill.get('id'))}",
                    path=f"items.{index}.recipe_pipeline.{pipeline_index}",
                )
            if _text(pipeline_recipe.get("output_kind")) != _text(
                recipe.get("output_kind")
            ):
                return _intent_error(
                    f"Recipe {canonical_pipeline_id} output kind does not match "
                    f"{canonical_recipe_id}",
                    path=f"items.{index}.recipe_pipeline.{pipeline_index}",
                )
            if canonical_pipeline_id == canonical_recipe_id or any(
                _text(existing.get("id")) == canonical_pipeline_id
                for existing in recipe_pipeline
            ):
                continue
            recipe_pipeline.append(pipeline_recipe)
        conflict = _recipe_pipeline_conflict([recipe, *recipe_pipeline])
        if conflict is not None:
            source_id, target_id = conflict
            return _intent_error(
                f"Recipe {source_id} conflicts with {target_id}",
                path=f"items.{index}.recipe_pipeline",
            )
        node_type = _NODE_TYPE_BY_OUTPUT_KIND.get(_text(recipe.get("output_kind")))
        if not node_type:
            return _intent_error(
                f"Recipe {canonical_recipe_id} has unsupported output_kind",
                path=f"items.{index}.recipe_id",
            )
        if (
            node_type == "audioNode"
            and _intent_audio_kind(item, recipe) == "speech"
            and not _text(item.get("narration"))
            and _looks_like_speech_generation_instruction(item.get("prompt"))
        ):
            return _intent_error(
                "speech audio item must provide narration as the literal text to speak; "
                "prompt must not be a request to generate narration",
                path=f"items.{index}.narration",
                hint=(
                    'Set items[].narration to the exact spoken sentence(s), e.g. '
                    '"深夜的便利店，只有他一个人。" — an instruction such as '
                    '"为这段视频生成旁白" is not narration and is rejected.'
                ),
            )
        node = _intent_item_node(
            skill=skill,
            recipe=recipe,
            node_type=node_type,
            item_id=item_id,
            item=item,
            user_goal=user_goal,
            resolved_inputs=resolved_inputs,
            recipe_pipeline=recipe_pipeline,
        )
        explicit_stage = _text(item.get("stage"))
        if explicit_stage:
            node["stage"] = explicit_stage
        stage = _text(node.get("stage"))
        if stage and stage not in phases:
            phases.append(stage)
        nodes.append(node)
        node_types[item_id] = node_type
        node_recipes[item_id] = recipe
        node_requires_source[item_id] = any(
            bool(candidate.get("requires_source_media") or candidate.get("requiresSourceMedia"))
            for candidate in [recipe, *recipe_pipeline]
        )
        item_by_id[item_id] = item

    edges: list[dict[str, str]] = []
    item_order = {item_id: index for index, item_id in enumerate(item_by_id)}
    for item_id, item in item_by_id.items():
        raw_dependencies = item.get("depends_on") or item.get("dependsOn") or []
        raw_references = item.get("reference_inputs") or item.get("referenceInputs") or []
        dependencies = (
            [_text(value) for value in raw_dependencies if _text(value)]
            if isinstance(raw_dependencies, list)
            else [_text(raw_dependencies)]
            if _text(raw_dependencies)
            else []
        )
        references = (
            [_text(value) for value in raw_references if _text(value)]
            if isinstance(raw_references, list)
            else [_text(raw_references)]
            if _text(raw_references)
            else []
        )
        for reference_id in references:
            if reference_id not in dependencies:
                dependencies.append(reference_id)
        if not dependencies:
            dependencies = ["workflow_input"]
        normalized_dependencies: list[str] = []
        normalized_references: set[str] = set()
        for source_id in dependencies:
            normalized_source = (
                "workflow_input"
                if source_id == "workflow_input"
                else _safe_id(source_id)
            )
            if normalized_source not in node_types:
                return _intent_error(
                    f"unknown dependency {source_id} for dynamic item {item_id}",
                    path=f"items.{item_id}.depends_on",
                )
            normalized_dependencies.append(normalized_source)
            if source_id in references:
                normalized_references.add(normalized_source)

        has_media_dependency = any(
            node_types.get(source_id) in {"imageGenNode", "videoNode", "audioNode"}
            for source_id in normalized_dependencies
        )
        if node_requires_source.get(item_id) and not has_media_dependency:
            current_order = item_order[item_id]
            candidates = [
                candidate_id
                for candidate_id, candidate_order in item_order.items()
                if candidate_order < current_order
                and node_types.get(candidate_id) in {"imageGenNode", "videoNode", "audioNode"}
                and not node_requires_source.get(candidate_id)
            ]
            same_kind_candidates = [
                candidate_id
                for candidate_id in candidates
                if node_types.get(candidate_id) == node_types.get(item_id)
            ]
            anchor_id = (
                same_kind_candidates[0]
                if len(same_kind_candidates) == 1
                else candidates[0]
                if not same_kind_candidates and len(candidates) == 1
                else ""
            )
            if anchor_id:
                normalized_dependencies.append(anchor_id)

        for normalized_source in normalized_dependencies:
            source_item = item_by_id.get(normalized_source) or {}
            source_timeline_role = _text(
                source_item.get("timeline_role") or source_item.get("timelineRole")
            ).lower()
            if (
                node_types.get(normalized_source) == "audioNode"
                and node_types.get(item_id) == "videoNode"
                and normalized_source not in normalized_references
                and source_timeline_role
                in {
                    "voiceover",
                    "narration",
                    "shot_voice",
                    "music",
                    "bgm",
                    "background_music",
                }
            ):
                # Final narration/music belongs on the compose timeline. Feeding a
                # full-length track to Seedance omni makes it an audio reference,
                # whose provider limit is 1.8-15.2 seconds per clip.
                continue
            edges.append(
                {
                    "source": normalized_source,
                    "target": item_id,
                    "link_type": (
                        "media_input_for"
                        if normalized_source in normalized_references
                        else _intent_link_type(
                            node_types.get(normalized_source, ""),
                            node_types.get(item_id, ""),
                        )
                    ),
                }
            )

    if include_compose:
        compose_sources = [
            node_id
            for node_id, node_type in node_types.items()
            if node_type in {"videoNode", "audioNode"}
        ]
        if any(node_types.get(node_id) == "videoNode" for node_id in compose_sources):
            compose_id = "final_compose"
            nodes.append(
                {
                    "id": compose_id,
                    "node_type": "videoComposeNode",
                    "name": "成片合成",
                    "description": "汇总视频片段、配乐和旁白，进入时间线完成最终编排。",
                    "stage": "compose",
                    "data": {
                        "displayName": "成片合成",
                        "title": "成片合成",
                        "content": "汇总视频片段、配乐和旁白，进入时间线完成最终编排。",
                        "prompt": "汇总视频片段、配乐和旁白，进入时间线完成最终编排。",
                        # Keep the intent's semantic source order. Canvas node ids
                        # are allocated later, so the frontend resolves these plan
                        # ids through each node's workflowPlanNodeId.
                        "compositionInputOrder": compose_sources,
                        "workflowCatalog": {
                            "skillId": _text(skill.get("id")),
                            "skillVersion": skill.get("version"),
                            "confirmedInputs": resolved_inputs,
                            "stepId": compose_id,
                            "promptBuilder": {"userGoal": user_goal},
                        },
                    },
                }
            )
            node_types[compose_id] = "videoComposeNode"
            node_recipes[compose_id] = None
            edges.extend(
                {
                    "source": source_id,
                    "target": compose_id,
                    "link_type": "composition_input_for",
                }
                for source_id in compose_sources
            )
            phases.append("compose")

    edges = _dedupe_intent_edges(edges)
    skill_id = _text(skill.get("id"))
    title = _text(intent.get("title")) or _catalog_label(skill)
    plan = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "workflow_type": f"dynamic.{skill_id}",
        "mode": "tool_compiled_dynamic",
        "skill": {"id": skill_id, "version": skill.get("version")},
        "summary": _text(intent.get("summary")) or user_goal,
        "source_context": {
            "user_goal": user_goal,
            "canvas_context": [],
            "input_assets": [],
        },
        "analysis": {"entities": [], "production_units": [], "risks": []},
        "phases": phases,
        "assumptions": list(intent.get("assumptions") or []),
        "missing_inputs": [],
        "expansion_rules": {"item_count": len(items)},
        "inputs": resolved_inputs,
        "nodes": nodes,
        "edges": edges,
        "layout": {
            "direction": "left_to_right",
            "groups": [
                {
                    "label": title,
                    "node_ids": [_text(node.get("id")) for node in nodes],
                }
            ],
        },
        "execution_policy": {
            "requires_user_confirmation": True,
            "auto_create_nodes": False,
            "auto_generate_content": False,
            "handoff_tool": "freezone_create_workflow_from_intent",
        },
    }
    validated = validate_agent_workflow_plan(plan)
    if not validated.get("ok"):
        return {
            **validated,
            "status": "compiled_workflow_plan_invalid",
            "compiled_plan": plan,
        }
    return {
        "ok": True,
        "status": "workflow_intent_compiled",
        "schema_version": WORKFLOW_INTENT_SCHEMA_VERSION,
        "skill_id": skill_id,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "preflight": validated.get("preflight") or {},
        "plan": plan,
    }


def _dynamic_default_model(recipe: dict[str, Any]) -> str:
    if _text(recipe.get("output_kind")) != "audio":
        return ""
    searchable = " ".join(
        [
            _text(recipe.get("id")),
            _text(recipe.get("name")),
            *[_text(item) for item in recipe.get("action_keys") or []],
        ]
    ).lower()
    return "suno_music" if any(token in searchable for token in ("music", "bgm", "音乐", "配乐")) else "edge-tts"


def _intent_audio_kind(item: dict[str, Any], recipe: dict[str, Any] | None) -> str:
    explicit = _text(item.get("audio_kind") or item.get("audioKind")).lower()
    if explicit in {"music", "speech"}:
        return explicit

    model = _text(item.get("model")).lower()
    if model:
        return "music" if model == "suno_music" else "speech"
    if _text(item.get("narration")):
        return "speech"

    searchable = " ".join(
        [
            _text(item.get("id")),
            _text(item.get("title")),
            _text(item.get("timeline_role") or item.get("timelineRole")),
            _text(item.get("prompt")),
            _text(recipe.get("id") if recipe else ""),
            _text(recipe.get("name") if recipe else ""),
        ]
    ).lower()
    return (
        "music"
        if any(token in searchable for token in ("background_music", "bgm", "背景音乐", "配乐", "纯音乐"))
        else "speech"
    )


def _looks_like_speech_generation_instruction(value: Any) -> bool:
    text = _text(value)
    if not text:
        return False
    return bool(
        re.search(
            r"(?:根据|基于|使用|提取|将).{0,40}(?:旁白|文案|脚本|广告词).{0,40}"
            r"(?:生成|制作|转换|合成).{0,12}(?:旁白|配音|语音|音频)"
            r"|(?:生成|制作).{0,20}(?:旁白配音|语音音频)",
            text,
            re.IGNORECASE,
        )
    )


def _duration_ms(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(float(value) * 1000)
    text = _text(value).lower()
    if not text:
        return None
    minute_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:分钟|分|min(?:ute)?s?)", text)
    if minute_match:
        return int(float(minute_match.group(1)) * 60_000)
    second_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)", text)
    if second_match:
        return int(float(second_match.group(1)) * 1000)
    return None


def _positive_duration_seconds(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return max(1, min(int(round(float(value))), 600))
    text = _text(value)
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return max(1, min(int(round(float(text))), 600))
    parsed_ms = _duration_ms(text)
    if parsed_ms is None:
        return None
    return max(1, min(int(round(parsed_ms / 1000)), 600))


def _planner_total_duration_seconds(
    *,
    planner: dict[str, Any],
    resolved_inputs: dict[str, Any],
    user_goal: str,
) -> int | None:
    for key in (
        "total_duration_seconds",
        "totalDurationSeconds",
        "target_duration_seconds",
        "targetDurationSeconds",
        "duration_seconds",
        "durationSeconds",
        "duration",
    ):
        parsed = _positive_duration_seconds(planner.get(key))
        if parsed is not None:
            return parsed
    for key in ("total_duration", "target_duration", "video_duration", "duration"):
        parsed = _positive_duration_seconds(resolved_inputs.get(key))
        if parsed is not None:
            return parsed
    parsed_ms = _duration_ms(user_goal)
    return int(round(parsed_ms / 1000)) if parsed_ms is not None else None


def _intent_music_length_ms(
    item: dict[str, Any],
    user_goal: str,
    resolved_inputs: dict[str, Any],
) -> int | None:
    explicit = item.get("music_length_ms") or item.get("musicLengthMs")
    if isinstance(explicit, (int, float)) and not isinstance(explicit, bool):
        return max(3_000, min(int(explicit), 600_000))
    for key in ("total_duration", "target_duration", "video_duration", "duration"):
        parsed = _duration_ms(resolved_inputs.get(key))
        if parsed:
            return max(3_000, min(parsed + 1_000, 600_000))
    for value in (user_goal, item.get("prompt")):
        parsed = _duration_ms(value)
        if parsed:
            return max(3_000, min(parsed + 1_000, 600_000))
    return None


_INTENT_FIX_INSTRUCTION = (
    "Fix the intent fields listed in `errors` and call this tool again with the "
    "corrected freezone_workflow_intent.v1. Each error message (and `hint`, when "
    "present) already contains everything needed to fix the payload — do NOT "
    "search or read plugin/source code to debug validation rules."
)


def _intent_error(message: str, *, path: str, hint: str | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"path": path, "message": message}
    if hint:
        error["hint"] = hint
    return {
        "ok": False,
        "status": "invalid_workflow_intent",
        "error": message,
        "errors": [error],
        "agent_instruction": _INTENT_FIX_INSTRUCTION,
    }


def _intent_bool(intent: dict[str, Any], key: str, default: bool) -> bool:
    value = intent.get(key)
    if value is None:
        return default
    return value if isinstance(value, bool) else default


def _intent_recipe_index() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for recipe in _load_agent_config_items("recipes", _RECIPES_DIR):
        if recipe.get("enabled") is False:
            continue
        recipe_id = _text(recipe.get("id"))
        if recipe_id:
            result[recipe_id] = recipe
        for field in ("actionKeys", "action_keys", "operationTypes", "operation_types"):
            for action_key in recipe.get(field) or []:
                if _text(action_key):
                    result.setdefault(_text(action_key), recipe)
    return result


def _recipe_pipeline_conflict(
    recipes: list[dict[str, Any]],
) -> tuple[str, str] | None:
    recipe_ids = {
        _text(recipe.get("id")) for recipe in recipes if _text(recipe.get("id"))
    }
    for recipe in recipes:
        recipe_id = _text(recipe.get("id"))
        conflicts = {
            _text(item) for item in recipe.get("conflicts_with") or [] if _text(item)
        }
        matched = sorted((conflicts & recipe_ids) - {recipe_id})
        if matched:
            return recipe_id, matched[0]
    return None


def _intent_items(intent: dict[str, Any]) -> list[dict[str, Any]]:
    raw_items = intent.get("items") or intent.get("shots") or []
    if not isinstance(raw_items, list):
        return []
    items: list[dict[str, Any]] = []
    for raw_item in raw_items[:24]:
        if isinstance(raw_item, str) and raw_item.strip():
            items.append({"title": raw_item.strip(), "prompt": raw_item.strip()})
        elif isinstance(raw_item, dict):
            title = _text(raw_item.get("title") or raw_item.get("name"))
            prompt = _text(
                raw_item.get("prompt")
                or raw_item.get("description")
                or raw_item.get("goal")
            )
            narration = _text(
                raw_item.get("narration")
                or raw_item.get("voiceover")
                or raw_item.get("dialogue")
                or raw_item.get("speech_text")
                or raw_item.get("speechText")
            )
            step_id = _text(raw_item.get("step_id") or raw_item.get("stepId"))
            duration_seconds = _positive_duration_seconds(
                raw_item.get("duration_seconds")
                or raw_item.get("durationSeconds")
                or raw_item.get("duration")
            )
            if duration_seconds is None:
                duration_seconds = _positive_duration_seconds(prompt)
            if title or prompt or narration:
                items.append(
                    {
                        **(
                            {"id": _safe_id(_text(raw_item.get("id")))}
                            if _text(raw_item.get("id"))
                            else {}
                        ),
                        "title": title or prompt or narration,
                        "prompt": prompt or title or narration,
                        **({"narration": narration} if narration else {}),
                        **({"step_id": _safe_id(step_id)} if step_id else {}),
                        **(
                            {"recipe_id": _text(raw_item.get("recipe_id") or raw_item.get("recipeId"))}
                            if _text(raw_item.get("recipe_id") or raw_item.get("recipeId"))
                            else {}
                        ),
                        **(
                            {
                                "recipe_pipeline": list(
                                    raw_item.get("recipe_pipeline")
                                    or raw_item.get("recipePipeline")
                                )
                            }
                            if isinstance(
                                raw_item.get("recipe_pipeline")
                                or raw_item.get("recipePipeline"),
                                list,
                            )
                            else {}
                        ),
                        **(
                            {"depends_on": list(raw_item.get("depends_on") or raw_item.get("dependsOn"))}
                            if isinstance(
                                raw_item.get("depends_on") or raw_item.get("dependsOn"),
                                list,
                            )
                            else {}
                        ),
                        **(
                            {
                                "reference_inputs": list(
                                    raw_item.get("reference_inputs")
                                    or raw_item.get("referenceInputs")
                                )
                            }
                            if isinstance(
                                raw_item.get("reference_inputs")
                                or raw_item.get("referenceInputs"),
                                list,
                            )
                            else {}
                        ),
                        **(
                            {"stage": _text(raw_item.get("stage"))}
                            if _text(raw_item.get("stage"))
                            else {}
                        ),
                        **(
                            {"timeline_role": _text(raw_item.get("timeline_role") or raw_item.get("timelineRole"))}
                            if _text(raw_item.get("timeline_role") or raw_item.get("timelineRole"))
                            else {}
                        ),
                        **(
                            {"model": _text(raw_item.get("model"))}
                            if _text(raw_item.get("model"))
                            else {}
                        ),
                        **(
                            {
                                "audio_kind": _text(
                                    raw_item.get("audio_kind") or raw_item.get("audioKind")
                                ).lower()
                            }
                            if _text(raw_item.get("audio_kind") or raw_item.get("audioKind")).lower()
                            in {"music", "speech"}
                            else {}
                        ),
                        **(
                            {
                                "music_length_ms": int(
                                    raw_item.get("music_length_ms")
                                    or raw_item.get("musicLengthMs")
                                )
                            }
                            if isinstance(
                                raw_item.get("music_length_ms")
                                or raw_item.get("musicLengthMs"),
                                (int, float),
                            )
                            and not isinstance(
                                raw_item.get("music_length_ms")
                                or raw_item.get("musicLengthMs"),
                                bool,
                            )
                            else {}
                        ),
                        **(
                            {"duration_seconds": duration_seconds}
                            if duration_seconds is not None
                            else {}
                        ),
                    }
                )
    return items


def _intent_dependency_edges(
    source_ids: list[str],
    target_ids: list[str],
    *,
    node_types: dict[str, str],
) -> list[dict[str, str]]:
    pairs = (
        list(zip(source_ids, target_ids, strict=True))
        if len(source_ids) == len(target_ids) and len(source_ids) > 1
        else [(source_id, target_id) for source_id in source_ids for target_id in target_ids]
    )
    return [
        {
            "source": source_id,
            "target": target_id,
            "link_type": _intent_link_type(
                node_types.get(source_id, ""),
                node_types.get(target_id, ""),
            ),
        }
        for source_id, target_id in pairs
    ]


def _intent_link_type(source_type: str, target_type: str) -> str:
    if target_type == "videoComposeNode":
        return "composition_input_for"
    if source_type == "videoNode" and target_type == "videoNode":
        # A previous generated shot may gate the next workflow step without
        # becoming an R2V reference. Otherwise Seedance receives every prior
        # shot and can exceed its 15.2-second total reference-video limit.
        return "dependency_for"
    if source_type in {"textAnnotationNode", "scriptNode", "beatContextNode"}:
        if target_type in {"textAnnotationNode", "scriptNode", "beatContextNode"}:
            return "context_for"
        # A planning document can gate a media stage, but it is not the stage's
        # final execution prompt. The Recipe compiles that prompt from the
        # item's own prompt and the Skill constraints.
        return "dependency_for"
    if source_type in {"imageGenNode", "videoNode", "audioNode"}:
        return "media_input_for"
    return "context_for"


def _is_redundant_compose_item(item_id: str, item: dict[str, Any]) -> bool:
    normalized_id = item_id.strip().lower().replace("-", "_")
    if normalized_id in {
        "compose",
        "final_compose",
        "final_composition",
        "video_compose",
    }:
        return True
    title = _text(item.get("title")).strip().lower()
    return title in {
        "最终合成",
        "成片合成",
        "最终成片合成",
        "final compose",
        "final composition",
    }


def _intent_item_node(
    *,
    skill: dict[str, Any],
    recipe: dict[str, Any] | None,
    node_type: str,
    item_id: str,
    item: dict[str, Any],
    user_goal: str,
    resolved_inputs: dict[str, Any],
    recipe_pipeline: list[dict[str, Any]],
) -> dict[str, Any]:
    label = (_text(item.get("title")) or _text(item.get("prompt")) or item_id)[:64]
    audio_kind = _intent_audio_kind(item, recipe) if node_type == "audioNode" else ""
    model = _text(item.get("model"))
    if not model:
        model = "suno_music" if audio_kind == "music" else _dynamic_default_model(recipe or {})
    item_prompt = _text(item.get("prompt"))
    if node_type == "audioNode" and model in {
        "edge-tts",
        "LingShan-TTS-2",
        "qwen3-tts-flash",
    }:
        item_prompt = _text(item.get("narration")) or item_prompt
    prompt = item_prompt or label
    timeline_role = _text(item.get("timeline_role") or item.get("timelineRole"))
    recipe_id = _text(recipe.get("id") if recipe else "")
    operation_type = next(
        (
            _text(action_key)
            for action_key in (recipe.get("action_keys") if recipe else []) or []
            if _text(action_key)
        ),
        recipe_id,
    )
    data: dict[str, Any] = {
        "displayName": label,
        "title": label,
        "content": prompt,
        "prompt": prompt,
        "description": prompt,
        "workflowCatalog": {
            "skillId": _text(skill.get("id")),
            "skillVersion": skill.get("version"),
            "confirmedInputs": resolved_inputs,
            "stepId": item_id,
            **({"timelineRole": timeline_role} if timeline_role else {}),
            "operationType": operation_type,
            "recipeId": recipe_id,
            "recipeName": _text(recipe.get("name") if recipe else ""),
            "recipeVersion": recipe.get("version") if recipe else None,
            "recipePipeline": [
                {
                    "id": _text(pipeline_recipe.get("id")),
                    "name": _text(pipeline_recipe.get("name")),
                    "version": pipeline_recipe.get("version"),
                }
                for pipeline_recipe in recipe_pipeline
            ],
            "promptStrategy": "llm_refine",
            "inputStrategy": {},
            "promptBuilder": {
                "userGoal": user_goal,
                "goalTemplate": label,
                "recipeId": recipe_id,
                **({"planItem": item} if item else {}),
            },
        },
    }
    if model:
        data["model"] = model
    aspect_ratio = _text(resolved_inputs.get("aspect_ratio"))
    if aspect_ratio and node_type in {"imageGenNode", "videoNode"}:
        data["aspectRatio"] = aspect_ratio
    if node_type == "videoNode":
        duration_seconds = _positive_duration_seconds(item.get("duration_seconds"))
        if duration_seconds is not None:
            data["durationSec"] = duration_seconds
    if node_type == "audioNode":
        data["text"] = prompt
        if audio_kind == "music":
            data["audioKind"] = "music"
            data["makeInstrumental"] = True
            data["sunoGptDescriptionPrompt"] = prompt
            music_length_ms = _intent_music_length_ms(item, user_goal, resolved_inputs)
            if music_length_ms is not None:
                data["musicLengthMs"] = music_length_ms
        else:
            data["audioKind"] = "speech"
            data["speechMode"] = "preset"
            data["presetModel"] = (
                "edge-tts" if model in {"LingShan-TTS-2", "qwen3-tts-flash"} else model
            )
            data["presetVoice"] = "Serena"
            data["voice"] = "Serena"
            data["languageType"] = "Chinese"
    return {
        "id": item_id,
        "node_type": node_type,
        "name": label,
        "description": prompt,
        "stage": _STAGE_BY_NODE_TYPE.get(node_type, "story"),
        "data": data,
    }


def _dedupe_intent_edges(edges: list[dict[str, str]]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for edge in edges:
        key = (edge["source"], edge["target"], edge["link_type"])
        if key not in seen:
            result.append(edge)
            seen.add(key)
    return result


def validate_agent_workflow_plan(plan: Any) -> dict[str, Any]:
    """Strictly validate an agent-authored plan against the live catalog."""
    if validate_workflow_plan is None:
        return {
            "ok": False,
            "status": "workflow_plan_validation_unavailable",
            "error": "workflow plan validation is unavailable",
        }
    skills = {
        _text(skill.get("id")): skill
        for skill in _load_skills()
        if _text(skill.get("id")) and skill.get("_disabled") is not True
    }
    recipes = {
        _text(recipe.get("id")): recipe
        for recipe in _load_agent_config_items("recipes", _RECIPES_DIR)
        if _text(recipe.get("id")) and recipe.get("enabled") is not False
    }
    validated = validate_workflow_plan(
        plan,
        skills_by_id=skills,
        recipes_by_id=recipes,
    )
    if not validated.get("ok"):
        return validated
    skill_id = _text(validated.get("skill_id"))
    allowed_capabilities = _skill_capabilities(skills[skill_id])
    allowed_node_types = {
        node_type
        for node_type, capability in _CAPABILITY_BY_NODE_TYPE.items()
        if capability in allowed_capabilities
    }
    allowed_node_types.add("textAnnotationNode")
    if "videoNode" in allowed_node_types:
        allowed_node_types.add("videoComposeNode")
    allowed_recipe_ids = {
        _text(recipe.get("id"))
        for recipe in _workflow_skill_recipe_candidates(
            skills[skill_id], list(recipes.values())
        )
    }
    errors: list[dict[str, str]] = []
    plan_inputs = plan.get("inputs", {})
    if not isinstance(plan_inputs, dict):
        errors.append({"path": "inputs", "message": "must be an object"})
        plan_inputs = {}
    input_contract = _skill_input_contract(skills[skill_id], {"inputs": plan_inputs})
    errors.extend(input_contract["errors"])
    errors.extend(
        {
            "path": f"inputs.{parameter_id}",
            "message": "required Skill input is missing",
        }
        for parameter_id in input_contract["missing_required"]
    )
    for index, node in enumerate(plan.get("nodes") or []):
        node_type = _text(node.get("node_type")) if isinstance(node, dict) else ""
        if node_type not in allowed_node_types:
            errors.append(
                {
                    "path": f"nodes[{index}].node_type",
                    "message": f"node type {node_type} is not allowed by skill {skill_id}",
                }
            )
        data = node.get("data") if isinstance(node, dict) else None
        catalog = data.get("workflowCatalog") if isinstance(data, dict) else None
        recipe_id = _text(catalog.get("recipeId")) if isinstance(catalog, dict) else ""
        recipe_pipeline = (
            (catalog.get("recipePipeline") or []) if isinstance(catalog, dict) else []
        )
        stage = _text(node.get("stage")) if isinstance(node, dict) else ""
        requires_recipe = node_type in {
            "imageGenNode",
            "videoNode",
            "audioNode",
            "scriptNode",
            "beatContextNode",
        } or (
            node_type == "textAnnotationNode"
            and stage not in {"input", "resource", "asset"}
        )
        if requires_recipe and not recipe_id:
            errors.append(
                {
                    "path": f"nodes[{index}].data.workflowCatalog.recipeId",
                    "message": f"executable node {node.get('id')} requires an explicit recipeId",
                }
            )
        if recipe_id and recipe_id not in allowed_recipe_ids:
            errors.append(
                {
                    "path": f"nodes[{index}].data.workflowCatalog.recipeId",
                    "message": f"recipe {recipe_id} is not allowed by skill {skill_id}",
                }
            )
        if not isinstance(recipe_pipeline, list):
            errors.append(
                {
                    "path": f"nodes[{index}].data.workflowCatalog.recipePipeline",
                    "message": "recipePipeline must be an array",
                }
            )
        else:
            for pipeline_index, pipeline_value in enumerate(recipe_pipeline):
                pipeline_id = _text(
                    pipeline_value.get("id")
                    if isinstance(pipeline_value, dict)
                    else pipeline_value
                )
                if pipeline_id and pipeline_id not in allowed_recipe_ids:
                    errors.append(
                        {
                            "path": (
                                f"nodes[{index}].data.workflowCatalog."
                                f"recipePipeline[{pipeline_index}]"
                            ),
                            "message": (
                                f"recipe {pipeline_id} is not allowed by skill {skill_id}"
                            ),
                        }
                    )
    if errors:
        return {
            "ok": False,
            "status": "invalid_dynamic_workflow_plan",
            "error": errors[0]["message"],
            "errors": errors,
        }
    validated["resolved_inputs"] = input_contract["resolved"]
    validated["execution_mode"] = input_contract["execution_mode"]
    validated["recommended_run_after_create"] = input_contract[
        "recommended_run_after_create"
    ]
    return validated


def _load_skill(skill_id: str) -> dict[str, Any] | None:
    wanted = _alias_key(skill_id)
    for skill in _load_skills():
        if _alias_key(_text(skill.get("id"))) == wanted:
            return skill
    return None


def _load_skills() -> list[dict[str, Any]]:
    return _load_agent_config_items("skills", _SKILLS_DIR, _PLUGIN_SKILLS_DIR)


def _skill_capabilities(skill: dict[str, Any]) -> list[str]:
    capabilities: list[str] = []
    triggers = skill.get("triggers") if isinstance(skill.get("triggers"), dict) else {}
    raw_scopes = triggers.get("node_scopes") or triggers.get("nodeScopes") or []
    for scope in raw_scopes if isinstance(raw_scopes, list) else []:
        normalized = _text(scope)
        aliases = {
            "text": "textGeneration",
            "image": "imageGeneration",
            "video": "videoGeneration",
            "audio": "audioGeneration",
            "compose": "videoCompose",
        }
        capability = aliases.get(normalized, normalized)
        if capability in _OUTPUT_KIND_BY_CAPABILITY or capability == "videoCompose":
            if capability not in capabilities:
                capabilities.append(capability)
    if not capabilities:
        capabilities = list(_OUTPUT_KIND_BY_CAPABILITY)
    return capabilities


def _skill_referenced_recipe_ids(skill: dict[str, Any]) -> set[str]:
    references = {
        _text(item)
        for field in (
            "recipe_ids",
            "recipeIds",
            "allowed_recipe_ids",
            "allowedRecipeIds",
        )
        for item in (skill.get(field) if isinstance(skill.get(field), list) else [])
        if _text(item)
    }
    return references


def _workflow_skill_recipe_candidates(
    skill: dict[str, Any],
    recipes: list[dict[str, Any]],
    *,
    allowed_capabilities: list[str] | None = None,
) -> list[dict[str, Any]]:
    capabilities = allowed_capabilities or _skill_capabilities(skill)
    output_kinds = {
        _OUTPUT_KIND_BY_CAPABILITY[capability]
        for capability in capabilities
        if capability in _OUTPUT_KIND_BY_CAPABILITY
    }
    references = _skill_referenced_recipe_ids(skill)
    general_recipe_ids = {
        f"general-{output_kind}"
        for output_kind in output_kinds
    }
    candidates: list[dict[str, Any]] = []
    for recipe in recipes:
        recipe_id = _text(recipe.get("id"))
        action_keys = {
            _text(item)
            for field in (
                "actionKeys",
                "action_keys",
                "operationTypes",
                "operation_types",
            )
            for item in (
                recipe.get(field) if isinstance(recipe.get(field), list) else []
            )
            if _text(item)
        }
        output_kind = _text(
            recipe.get("output_kind")
            or recipe.get("generationType")
            or recipe.get("generation_type")
        )
        explicitly_referenced = recipe_id in references or bool(
            action_keys & references
        )
        if (
            explicitly_referenced
            or recipe_id in general_recipe_ids
            or (not references and (not output_kinds or output_kind in output_kinds))
        ):
            candidates.append(recipe)
    candidates.sort(key=lambda item: _text(item.get("id")))
    return candidates


def _recipe_matches_references(recipe: dict[str, Any], references: set[str]) -> bool:
    if _text(recipe.get("id")) in references:
        return True
    return any(
        _text(item) in references
        for field in ("actionKeys", "action_keys", "operationTypes", "operation_types")
        for item in (recipe.get(field) if isinstance(recipe.get(field), list) else [])
    )


def _recipe_planning_summary(recipe: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _text(recipe.get("id")),
        "name": _text(recipe.get("name") or recipe.get("label")),
        "version": recipe.get("version"),
        "output_kind": _text(
            recipe.get("output_kind")
            or recipe.get("generationType")
            or recipe.get("generation_type")
        ),
        "action_keys": [
            _text(item)
            for field in (
                "actionKeys",
                "action_keys",
                "operationTypes",
                "operation_types",
            )
            for item in (
                recipe.get(field) if isinstance(recipe.get(field), list) else []
            )
            if _text(item)
        ],
        "planning_prompt": _text(
            recipe.get("planning_prompt") or recipe.get("planningPrompt")
        ),
        "result_summary": _text(
            recipe.get("result_summary") or recipe.get("resultSummary")
        ),
        "requires_source_media": bool(
            recipe.get("requires_source_media") or recipe.get("requiresSourceMedia")
        ),
        "conflicts_with": [
            _text(item) for item in recipe.get("conflicts_with") or [] if _text(item)
        ],
    }


def _without_private_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_private_fields(item)
            for key, item in value.items()
            if not str(key).startswith("_")
        }
    if isinstance(value, list):
        return [_without_private_fields(item) for item in value]
    return value


def _load_agent_config_items(
    kind: str, fallback_dir: Path, project_dir: Path | None = None
) -> list[dict[str, Any]]:
    if list_user_agent_config_items is not None:
        username = _catalog_username()
        if username:
            try:
                loaded_items = list_user_agent_config_items(username, kind)
                return _normalize_agent_config_items(kind, loaded_items)
            except Exception:
                pass

    if project_dir is None:
        project_dir = _PLUGIN_RECIPES_DIR if kind == "recipes" else _PLUGIN_SKILLS_DIR
    fallback_items = _load_json_dir(fallback_dir)
    if project_dir is not None:
        project_items = [
            {**item, "_catalog_source": "builtin"}
            for item in _load_json_dir(project_dir)
        ]
        if project_items:
            fallback_items = _merge_agent_config_items(fallback_items, project_items)
    if kind == "skills":
        fallback_items = [
            item
            for item in fallback_items
            if item.get("allowed_recipe_ids")
        ]
    return _normalize_agent_config_items(kind, fallback_items)


def _normalize_agent_config_items(
    kind: str, items: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if kind != "recipes":
        return items
    normalized: list[dict[str, Any]] = []
    for item in items:
        if _text(item.get("id")) in _TEXT_FIRST_BUILTIN_RECIPE_IDS:
            normalized.append({**item, "requires_source_media": False})
        else:
            normalized.append(item)
    return normalized


def _merge_agent_config_items(
    builtin_items: list[dict[str, Any]],
    loaded_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge code fallback builtins with user/config-store items."""

    by_id: dict[str, dict[str, Any]] = {
        _text(item.get("id")): {
            **item,
            "_catalog_source": item.get("_catalog_source") or "builtin",
        }
        for item in builtin_items
        if _text(item.get("id"))
    }
    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in loaded_items:
        if not isinstance(item, dict):
            continue
        item_id = _text(item.get("id"))
        if not item_id:
            continue
        if item.get("hidden") is True:
            by_id.pop(item_id, None)
            seen.add(item_id)
            continue
        base = by_id.pop(item_id, {})
        merged = {**base, **item}
        merged.setdefault("_catalog_source", item.get("_catalog_source") or "user")
        ordered.append(merged)
        seen.add(item_id)
    ordered.extend(
        item for item_id, item in sorted(by_id.items()) if item_id not in seen
    )
    return ordered


def _catalog_username() -> str:
    if os.environ.get("ST_EDITION", "").strip().lower() == "ce":
        return "local"
    return (
        os.environ.get("DRAMACLAW_USERNAME")
        or os.environ.get("DRAMACLAW_USER")
        or os.environ.get("SUPERTALE_USER")
        or os.environ.get("FREEZONE_USER")
        or "local"
    ).strip()


def _catalog_source(payload: dict[str, Any]) -> str:
    return _text(payload.get("_catalog_source")) or "builtin"


def _load_json_dir(path: Path) -> list[dict[str, Any]]:
    if not path.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for file_path in sorted(path.glob("*.json")):
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(payload, dict):
            items.append(payload)
        elif isinstance(payload, list):
            items.extend(item for item in payload if isinstance(item, dict))
    return items


def _catalog_label(skill: dict[str, Any]) -> str:
    return (
        _text(skill.get("name") or skill.get("label") or skill.get("id"))
        or "配置工作流"
    )


def _workflow_goal_text(args: dict[str, Any]) -> str:
    for field in (
        "user_goal",
        "userGoal",
        "goal",
        "brief",
        "description",
        "message",
        "prompt",
        "title",
        "name",
    ):
        value = args.get(field)
        if isinstance(value, str) and value.strip():
            return re.sub(r"\s+", " ", value.strip())
    return ""


def _alias_key(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _safe_id(value: str) -> str:
    text = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", value.strip())
    text = re.sub(r"_+", "_", text).strip("_-")
    return text[:64] or "catalog_step"


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _error(message: str) -> dict[str, Any]:
    return {"ok": False, "status": "catalog_workflow_error", "error": message}

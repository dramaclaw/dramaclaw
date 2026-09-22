"""Portable JSON Schemas for shared Freezone workflow MCP tools.

Keep the stable workflow envelope here so Hermes, Codex App Server, and
standalone MCP clients advertise the same contract. Provider/model-specific
node options remain progressively loaded and are therefore allowed as
additional ``data`` properties.
"""

from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Any

from novelvideo.freezone.workflow_contract_generated import (
    WORKFLOW_INTENT_SCHEMA_VERSION,
    WORKFLOW_LINK_TYPES,
    WORKFLOW_NODE_TYPES,
    WORKFLOW_PLAN_SCHEMA_VERSION,
)

NODE_TYPE_VALUES = WORKFLOW_NODE_TYPES
LINK_TYPE_VALUES = WORKFLOW_LINK_TYPES


def normalize_workflow_tool_arguments(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Repair only lossless intent serialization mistakes before strict validation.

    Never fill missing items, merge conflicting forms, or remove arbitrary nulls:
    those may change the user's requested workflow. Stable scalar generation inputs
    are canonicalized when their JSON representation is unambiguous, so Agent hosts
    do not have to infer transport-level types such as ``"1"`` versus ``1``.
    """
    if name not in {"workflow_intent_compile", "freezone_prepare_workflow_draft"}:
        return arguments
    if not isinstance(arguments.get("intent"), dict):
        return arguments
    result = deepcopy(arguments)
    intent = result["intent"]
    indexed = {
        int(match.group(1)): key
        for key in intent
        if (match := re.fullmatch(r"items\[(0|[1-9][0-9]*)\]", key))
    }
    if (
        indexed
        and "items" not in intent
        and len(indexed) <= 24
        and sorted(indexed) == list(range(len(indexed)))
    ):
        intent["items"] = [intent.pop(indexed[i]) for i in range(len(indexed))]
    inputs = intent.get("inputs")
    if isinstance(inputs, dict):
        for key in ("image_variants_per_node", "video_variants_per_node"):
            value = inputs.get(key)
            if isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]*)", value):
                try:
                    inputs[key] = int(value)
                except (ValueError, OverflowError):
                    pass
        duration = inputs.get("video_duration_seconds")
        if isinstance(duration, str) and re.fullmatch(
            r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", duration
        ):
            try:
                parsed_duration = float(duration)
            except (ValueError, OverflowError):
                parsed_duration = None
            if parsed_duration is not None and math.isfinite(parsed_duration):
                inputs["video_duration_seconds"] = (
                    int(parsed_duration)
                    if parsed_duration.is_integer()
                    else parsed_duration
                )
        generate_audio = inputs.get("video_generate_audio")
        if isinstance(generate_audio, str) and generate_audio in {"true", "false"}:
            inputs["video_generate_audio"] = generate_audio == "true"
    planner = intent.get("planner")
    units = planner.get("units") if isinstance(planner, dict) else None
    for entries in (intent.get("items"), units):
        if isinstance(entries, list):
            for item in entries:
                if isinstance(item, dict) and item.get("duration_seconds") is None:
                    item.pop("duration_seconds", None)
    return result

def workflow_plan_schema_diagnostics(arguments: dict[str, Any]) -> list[dict[str, str]]:
    """Explain actionable HTML branch failures hidden by JSON Schema anyOf.

    This only describes invalid arguments; it never fills values or changes a
    node's requested deliverable type. The strict validator remains authoritative.
    """
    plan = arguments.get("plan")
    if not isinstance(plan, dict) or not isinstance(plan.get("nodes"), list):
        return []
    issues: list[dict[str, str]] = []
    for index, node in enumerate(plan["nodes"]):
        if not isinstance(node, dict) or node.get("node_type") != "htmlArtifactNode":
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        if not any(isinstance(value, str) and value.strip() for value in (node.get("prompt"), data.get("prompt"))):
            issues.append({
                "path": f"plan.nodes[{index}].prompt",
                "message": (
                    "HTML workflow step requires a non-empty generation prompt. "
                    f"Set plan.nodes[{index}].prompt or plan.nodes[{index}].data.prompt "
                    "to the webpage's business requirements, not HTML source. "
                    "Keep node_type=htmlArtifactNode and the existing Recipe and edges; "
                    "correct this field and resubmit the same complete plan."
                ),
            })
    return issues

def _version_schema() -> dict[str, Any]:
    return {"oneOf": [{"type": "string"}, {"type": "integer"}]}


def _catalog_schema(*, recipe_required: bool = False) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "description": (
            "Catalog identity for this node. Executable nodes must select a Recipe "
            "allowed by the plan's single Skill."
        ),
        "properties": {
            "skillId": {"type": "string", "minLength": 1},
            "skillVersion": _version_schema(),
            "stepId": {"type": "string", "minLength": 1},
            "timelineRole": {"type": "string"},
            "operationType": {"type": "string", "minLength": 1},
            "recipeId": {"type": "string", "minLength": 1},
            "recipeName": {"type": "string"},
            "recipeVersion": _version_schema(),
            "recipePipeline": {
                "type": "array",
                "items": {
                    "oneOf": [
                        {"type": "string", "minLength": 1},
                        {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "minLength": 1},
                                "version": _version_schema(),
                            },
                            "required": ["id"],
                            "additionalProperties": False,
                        },
                    ]
                },
            },
            "confirmedInputs": {
                "type": "object",
                "description": (
                    "Confirmed Skill input values keyed by input id. Workflow node "
                    "dependencies belong in plan edges, never in this object."
                ),
                "additionalProperties": {},
            },
            "promptStrategy": {
                "type": "string",
                "enum": ["template", "user_message", "previous_output", "llm_refine"],
            },
            "inputStrategy": {
                "type": "object",
                "additionalProperties": {},
            },
            "promptBuilder": {
                "type": "object",
                "properties": {
                    "userGoal": {"type": "string"},
                    "goalTemplate": {"type": "string"},
                    "recipeId": {"type": "string", "minLength": 1},
                    "planItem": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "minLength": 1},
                            "title": {"type": "string"},
                            "prompt": {"type": "string"},
                            "narration": {"type": "string"},
                            "audio_kind": {
                                "type": "string",
                                "enum": ["speech", "music"],
                            },
                            "music_length_ms": {
                                "type": "integer",
                                "minimum": 3000,
                                "maximum": 600000,
                            },
                            "duration_seconds": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 600,
                            },
                            "recipe_id": {"type": "string", "minLength": 1},
                            "depends_on": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "reference_inputs": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "stage": {"type": "string"},
                            "timeline_role": {"type": "string"},
                        },
                        "required": ["id", "title", "recipe_id"],
                        "additionalProperties": False,
                    },
                    "inputStrategy": {
                        "type": "object",
                        "additionalProperties": {},
                    },
                },
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    }
    if recipe_required:
        schema["required"] = ["recipeId"]
    return schema


def _node_data_schema(
    *, recipe_required: bool = False, resource_stage_allowed: bool = False
) -> dict[str, Any]:
    return {
        "type": "object",
        "description": (
            "Stable portable node fields. Additional provider/model-specific fields are "
            "allowed and should be selected from the progressively loaded live node schema."
        ),
        "properties": {
            "workflowCatalog": _catalog_schema(recipe_required=recipe_required),
            "displayName": {"type": "string"},
            "title": {"type": "string"},
            "content": {"type": "string"},
            "text": {"type": "string"},
            "prompt": {"type": "string"},
            "description": {"type": "string"},
            # Compatibility input for agent-authored resource text nodes. The
            # compiler moves this to the portable top-level stage and removes
            # it from emitted canvas node data. Executable nodes stay strict.
            "stage": (
                {"type": "string", "enum": ["input", "resource", "asset"]}
                if resource_stage_allowed
                else False
            ),
            "model": {"type": "string"},
            "aspectRatio": {"type": "string"},
            "size": {"type": "string"},
            "quality": {"type": "string"},
            "count": {"type": "integer", "minimum": 1},
            "durationSec": {"type": "number", "exclusiveMinimum": 0},
            "generateAudio": {"type": "boolean"},
            "audioKind": {"type": "string", "enum": ["speech", "music"]},
            "speechMode": {"type": "string"},
            "presetModel": {"type": "string"},
            "presetVoice": {"type": "string"},
        },
        "required": ["workflowCatalog"] if recipe_required else [],
        # Dynamic node capabilities are discovered from the canvas frontend.
        "additionalProperties": True,
    }


def _node_common_properties() -> dict[str, Any]:
    return {
        "id": {"type": "string", "minLength": 1, "maxLength": 128},
        "title": {"type": "string"},
        "label": {"type": "string"},
        "name": {"type": "string"},
        "stage": {"type": "string"},
        "content": {"type": "string"},
        "text": {"type": "string"},
        "prompt": {"type": "string"},
        "description": {"type": "string"},
        "position": {
            "type": "object",
            "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
            "required": ["x", "y"],
            "additionalProperties": False,
        },
        "data": _node_data_schema(),
    }


def _recipe_node_schema() -> dict[str, Any]:
    properties = _node_common_properties()
    properties.update(
        {
            "node_type": {
                "type": "string",
                "enum": [value for value in NODE_TYPE_VALUES if value not in {"videoComposeNode", "htmlArtifactNode"}],
            },
            "data": _node_data_schema(recipe_required=True),
        }
    )
    return {
        "type": "object",
        "properties": properties,
        "required": ["id", "node_type", "data"],
        "additionalProperties": False,
    }


def _html_node_schema() -> dict[str, Any]:
    properties = _node_common_properties()
    for field in ("content", "text"):
        properties.pop(field, None)
    properties["node_type"] = {"type": "string", "enum": ["htmlArtifactNode"]}
    properties["prompt"] = {
        "type": "string", "minLength": 1,
        "description": "Required here or in data.prompt: business requirements for generating the webpage. Keep HTML source in Artifact storage.",
    }
    properties["data"] = {
        "type": "object",
        "properties": {
            "workflowCatalog": _catalog_schema(recipe_required=True),
            "prompt": {"type": "string"},
            "title": {"type": "string"},
            "displayName": {"type": "string"},
        },
        "required": ["workflowCatalog"],
        "additionalProperties": False,
    }
    return {"type": "object", "properties": properties,
            "required": ["id", "node_type", "data"], "additionalProperties": False,
            "anyOf": [
                {"required": ["prompt"], "properties": {"prompt": {"type": "string", "minLength": 1}}},
                {"properties": {"data": {"required": ["prompt"], "properties": {"prompt": {"type": "string", "minLength": 1}}}}},
            ]}


def _resource_text_node_schema() -> dict[str, Any]:
    properties = _node_common_properties()
    properties.update(
        {
            "node_type": {"type": "string", "enum": ["textAnnotationNode"]},
            "stage": {"type": "string", "enum": ["input", "resource", "asset"]},
            "data": _node_data_schema(resource_stage_allowed=True),
        }
    )
    return {
        "type": "object",
        "properties": properties,
        "required": ["id", "node_type", "data"],
        "anyOf": [
            {"required": ["stage"]},
            {
                "properties": {
                    "data": {
                        "type": "object",
                        "required": ["stage"],
                    }
                }
            },
        ],
        "additionalProperties": False,
    }


def _compose_node_schema() -> dict[str, Any]:
    properties = _node_common_properties()
    properties["node_type"] = {"type": "string", "enum": ["videoComposeNode"]}
    return {
        "type": "object",
        "properties": properties,
        "required": ["id", "node_type"],
        "additionalProperties": False,
    }


def _group_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            # Agent hosts often attach a logical group id. Canvas group
            # commands do not need it, so the compiler accepts and discards it.
            "id": {"type": "string"},
            "label": {"type": "string"},
            "node_ids": {
                "type": "array",
                "minItems": 2,
                "items": {"type": "string", "minLength": 1},
            },
        },
        "required": ["node_ids"],
        "additionalProperties": False,
    }


def workflow_plan_json_schema() -> dict[str, Any]:
    """Return a fresh portable WorkflowPlan schema."""
    group = _group_schema()
    schema: dict[str, Any] = {
        "type": "object",
        "description": (
            "Complete freezone_workflow_plan.v1 object. Execution policy is not part of the "
            "plan; pass run_after_create beside plan in the tool arguments."
        ),
        "properties": {
            "external_inputs": {
                "type": "array", "maxItems": 24,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "minLength": 1},
                        "node_id": {"type": "string", "minLength": 1},
                        "media_kind": {"const": "image"},
                    },
                    "required": ["id", "node_id", "media_kind"],
                    "additionalProperties": False,
                },
            },
            "schema_version": {
                "type": "string",
                "enum": [WORKFLOW_PLAN_SCHEMA_VERSION],
            },
            "workflow_type": {"type": "string"},
            "title": {"type": "string"},
            "summary": {"type": "string"},
            "mode": {"type": "string"},
            "source_context": {"type": "object"},
            "analysis": {"type": "object"},
            "phases": {"type": "array", "items": {"type": "string"}},
            "assumptions": {"type": "array", "items": {"type": "string"}},
            "missing_inputs": {"type": "array"},
            "expansion_rules": {"type": "object"},
            "execution_policy": {"type": "object"},
            "inputs": {"type": "object"},
            "expected_node_count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": (
                    "Optional exact business-node count stated by the user. Validation fails "
                    "before approval when nodes does not contain exactly this many entries."
                ),
            },
            "expected_node_counts": {
                "type": "object",
                "description": "Optional exact node counts keyed by portable node_type.",
                "properties": {
                    node_type: {"type": "integer", "minimum": 0, "maximum": 200}
                    for node_type in NODE_TYPE_VALUES
                },
                "additionalProperties": False,
            },
            "skill": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "minLength": 1},
                    "version": _version_schema(),
                },
                "required": ["id"],
                "additionalProperties": False,
            },
            "nodes": {
                "type": "array",
                "minItems": 1,
                "maxItems": 200,
                "items": {
                    "anyOf": [
                        _recipe_node_schema(),
                        _resource_text_node_schema(),
                        _compose_node_schema(),
                        _html_node_schema(),
                    ]
                },
            },
            "edges": {
                "type": "array",
                "maxItems": 400,
                "description": (
                    "Dependency edges for one connected workflow graph. Use prompt_for from "
                    "text to generated media, context_for when a text node consumes upstream "
                    "text as context, and media_input_for only from media nodes. dependency_for "
                    "only controls execution order and does not consume the source output; a "
                    "target that consumes upstream output must not use dependency_for. A plan "
                    "with two or more nodes must include at least one edge; never use an empty "
                    "edge array as a diagnostic probe."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {"type": "string", "minLength": 1},
                        "target": {"type": "string", "minLength": 1},
                        "link_type": {"type": "string", "enum": LINK_TYPE_VALUES},
                    },
                    "required": ["source", "target", "link_type"],
                    "additionalProperties": False,
                },
            },
            "groups": {"type": "array", "items": deepcopy(group)},
            "group": {
                "oneOf": [
                    deepcopy(group),
                    {"type": "array", "items": deepcopy(group)},
                ]
            },
            "layout": {
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["grid"]},
                    "direction": {
                        "type": "string",
                        "enum": ["left_to_right", "top_to_bottom"],
                    },
                    "groups": {"type": "array", "items": deepcopy(group)},
                },
                "additionalProperties": False,
            },
        },
        "required": ["schema_version", "skill", "nodes", "edges"],
        "anyOf": [
            {"properties": {"nodes": {"maxItems": 1}}},
            {
                "properties": {
                    "nodes": {"minItems": 2},
                    "edges": {"minItems": 1},
                }
            },
        ],
        "additionalProperties": False,
    }
    return schema


def workflow_intent_json_schema() -> dict[str, Any]:
    """Return the stable public WorkflowIntent contract used by MCP clients."""
    unit = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "prompt": {"type": "string"},
            "narration": {"type": "string"},
            "duration_seconds": {"type": "integer", "minimum": 1, "maximum": 600},
        },
        "required": ["title"],
        "additionalProperties": False,
    }
    item = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "minLength": 1},
            "title": {"type": "string"},
            "prompt": {"type": "string"},
            "narration": {"type": "string"},
            "audio_kind": {"type": "string", "enum": ["speech", "music"]},
            "music_length_ms": {"type": "integer", "minimum": 3000, "maximum": 600000},
            "duration_seconds": {"type": "integer", "minimum": 1, "maximum": 600},
            "recipe_id": {"type": "string", "minLength": 1},
            "depends_on": {"type": "array", "items": {"type": "string"}},
            "reference_inputs": {"type": "array", "items": {"type": "string"}},
            "stage": {"type": "string"},
            "timeline_role": {"type": "string"},
        },
        "required": ["id", "title", "recipe_id"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "description": (
            "Compact freezone_workflow_intent.v1 planning decision. "
            "Put composition policy at intent.include_compose, never inside intent.planner."
        ),
        "properties": {
            "external_inputs": {
                "type": "array", "maxItems": 24,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "minLength": 1},
                        "node_id": {"type": "string", "minLength": 1},
                        "media_kind": {"const": "image"},
                    },
                    "required": ["id", "node_id", "media_kind"],
                    "additionalProperties": False,
                },
            },
            "schema_version": {
                "type": "string",
                "enum": [WORKFLOW_INTENT_SCHEMA_VERSION],
            },
            "skill_id": {"type": "string", "minLength": 1},
            "user_goal": {"type": "string", "minLength": 1},
            "title": {"type": "string"},
            "summary": {"type": "string"},
            "inputs": {
                "type": "object",
                "description": (
                    "Skill-specific inputs plus stable media generation controls. "
                    "Use the declared JSON scalar types for the stable controls."
                ),
                "properties": {
                    "aspect_ratio": {"type": "string", "minLength": 1},
                    "image_aspect_ratio": {"type": "string", "minLength": 1},
                    "image_model": {"type": "string", "minLength": 1},
                    "image_quality": {"type": "string", "minLength": 1},
                    "image_resolution": {"type": "string", "minLength": 1},
                    "image_variants_per_node": {
                        "type": "integer",
                        "enum": [1, 2, 4],
                    },
                    "video_aspect_ratio": {"type": "string", "minLength": 1},
                    "video_duration_seconds": {
                        "type": "number",
                        "exclusiveMinimum": 0,
                        "maximum": 600,
                    },
                    "video_generate_audio": {"type": "boolean"},
                    "video_generation_mode": {
                        "type": "string",
                        "enum": [
                            "allReference",
                            "firstLastFrame",
                            "imageReference",
                            "imageToVideo",
                            "textToVideo",
                        ],
                    },
                    "video_model": {"type": "string", "minLength": 1},
                    "video_resolution": {"type": "string", "minLength": 1},
                    "video_variants_per_node": {
                        "type": "integer",
                        "enum": [1, 2, 4],
                    },
                },
                "additionalProperties": True,
            },
            "planner": {
                "type": "object",
                "description": (
                    "Planning mode, deliverable, duration, and units. "
                    "Composition is controlled by sibling intent.include_compose; "
                    "do not put include_compose here."
                ),
                "properties": {
                    "mode": {"type": "string", "enum": ["standard"]},
                    "deliverable": {
                        "type": "string",
                        "enum": ["images", "video", "mixed", "html"],
                    },
                    "item_count": {"type": "integer", "minimum": 1, "maximum": 12},
                    "total_duration_seconds": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 600,
                    },
                    "include_audio": {"type": "boolean"},
                    "units": {"type": "array", "maxItems": 12, "items": unit},
                },
                "required": ["mode"],
                "additionalProperties": False,
            },
            "items": {"type": "array", "maxItems": 24, "items": item},
            "include_audio": {"type": "boolean"},
            "include_compose": {
                "type": "boolean",
                "description": "Composition policy at intent.include_compose, outside intent.planner.",
            },
            "assumptions": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["skill_id", "user_goal"],
        "additionalProperties": False,
    }

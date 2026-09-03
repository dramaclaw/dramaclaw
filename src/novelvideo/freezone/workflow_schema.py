"""Portable JSON Schemas for shared Freezone workflow MCP tools.

Keep the stable workflow envelope here so Hermes, Codex App Server, and
standalone MCP clients advertise the same contract. Provider/model-specific
node options remain progressively loaded and are therefore allowed as
additional ``data`` properties.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

WORKFLOW_PLAN_SCHEMA_VERSION = "freezone_workflow_plan.v1"
WORKFLOW_INTENT_SCHEMA_VERSION = "freezone_workflow_intent.v1"

NODE_TYPE_VALUES = [
    "textAnnotationNode",
    "scriptNode",
    "beatContextNode",
    "imageGenNode",
    "videoNode",
    "audioNode",
    "videoComposeNode",
]

LINK_TYPE_VALUES = [
    "context_for",
    "prompt_for",
    "dependency_for",
    "media_input_for",
    "derived_from",
    "composition_input_for",
]


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


def _node_data_schema(*, recipe_required: bool = False) -> dict[str, Any]:
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
            "stage": False,
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
                "enum": NODE_TYPE_VALUES[:-1],
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


def _resource_text_node_schema() -> dict[str, Any]:
    properties = _node_common_properties()
    properties.update(
        {
            "node_type": {"type": "string", "enum": ["textAnnotationNode"]},
            "stage": {"type": "string", "enum": ["input", "resource", "asset"]},
        }
    )
    return {
        "type": "object",
        "properties": properties,
        "required": ["id", "node_type", "stage"],
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
                    ]
                },
            },
            "edges": {
                "type": "array",
                "maxItems": 400,
                "description": (
                    "Dependency edges for one connected workflow graph. Use prompt_for from "
                    "text to generated media and media_input_for only from media nodes. A plan "
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
        "description": "Compact freezone_workflow_intent.v1 planning decision.",
        "properties": {
            "schema_version": {
                "type": "string",
                "enum": [WORKFLOW_INTENT_SCHEMA_VERSION],
            },
            "skill_id": {"type": "string", "minLength": 1},
            "user_goal": {"type": "string", "minLength": 1},
            "title": {"type": "string"},
            "summary": {"type": "string"},
            "inputs": {"type": "object"},
            "planner": {
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["standard"]},
                    "deliverable": {
                        "type": "string",
                        "enum": ["images", "video", "mixed"],
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
            "include_compose": {"type": "boolean"},
            "assumptions": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["skill_id", "user_goal"],
        "additionalProperties": False,
    }

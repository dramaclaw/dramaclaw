"""Interactive-story tool definitions for the shared DramaClaw toolset.

This module is intentionally host-neutral and stdlib-only. Hermes loads the
tool entries through the native plugin, while Codex and other MCP clients see
the same entries through ``novelvideo.chat.dramaclaw_mcp``.
"""

from __future__ import annotations

import os
from typing import Any, Callable
from urllib.parse import quote


_ENTITY_ID_SCHEMA = {
    "type": "string",
    "minLength": 1,
    "maxLength": 128,
    "pattern": r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
}

_VARIABLE_NAME_SCHEMA = {
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": r"^[A-Za-z_][A-Za-z0-9_]*$",
}


def _strict_object(
    properties: dict[str, Any],
    required: list[str] | None = None,
    **constraints: Any,
) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        **constraints,
    }
    if required:
        schema["required"] = required
    return schema


def _nullable(schema: dict[str, Any]) -> dict[str, Any]:
    return {"oneOf": [schema, {"type": "null"}]}


def _story_character_schema() -> dict[str, Any]:
    return _strict_object(
        {
            "id": dict(_ENTITY_ID_SCHEMA),
            "name": {"type": "string", "minLength": 1, "maxLength": 120},
            "description": {"type": "string", "maxLength": 2_000},
            "visual_description": {"type": "string", "maxLength": 4_000},
        },
        ["id", "name"],
    )


def _story_variable_schema() -> dict[str, Any]:
    return _strict_object(
        {
            "name": dict(_VARIABLE_NAME_SCHEMA),
            "label": {"type": "string", "minLength": 1, "maxLength": 120},
            "initial": {"type": "integer"},
            "minimum": _nullable({"type": "integer"}),
            "maximum": _nullable({"type": "integer"}),
        },
        ["name", "label"],
    )


def _story_flag_schema() -> dict[str, Any]:
    return _strict_object(
        {
            "name": dict(_VARIABLE_NAME_SCHEMA),
            "label": {"type": "string", "minLength": 1, "maxLength": 120},
            "initial": {"type": "boolean"},
        },
        ["name", "label"],
    )


def _story_media_schema() -> dict[str, Any]:
    schema = _strict_object(
        {
            "source": {"enum": ["placeholder", "imported", "generated"]},
            "status": {"enum": ["missing", "pending", "ready", "failed"]},
            "asset_id": _nullable(
                {"type": "string", "minLength": 1, "maxLength": 256}
            ),
            "url": _nullable(
                {"type": "string", "minLength": 1, "maxLength": 4_096}
            ),
            "version": {"type": "integer", "minimum": 1},
        }
    )
    schema["allOf"] = [
        {
            "if": {
                "required": ["source", "status"],
                "properties": {
                    "source": {"enum": ["imported", "generated"]},
                    "status": {"const": "ready"},
                },
            },
            "then": {
                "anyOf": [
                    {
                        "required": ["asset_id"],
                        "properties": {"asset_id": {"type": "string"}},
                    },
                    {
                        "required": ["url"],
                        "properties": {"url": {"type": "string"}},
                    },
                ]
            },
        }
    ]
    return schema


def _story_choice_loop_schema() -> dict[str, Any]:
    return _strict_object(
        {
            "description": {"type": "string", "minLength": 1, "maxLength": 2_000},
            "production_notes": {"type": "string", "maxLength": 4_000},
            "media": _story_media_schema(),
        },
        ["description"],
    )


def _story_segment_schema() -> dict[str, Any]:
    schema = _strict_object(
        {
            "id": dict(_ENTITY_ID_SCHEMA),
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "script": {"type": "string", "minLength": 1, "maxLength": 20_000},
            "kind": {"enum": ["scene", "ending"]},
            "ending_label": _nullable(
                {"type": "string", "minLength": 1, "maxLength": 40}
            ),
            "character_ids": {
                "type": "array",
                "maxItems": 64,
                "uniqueItems": True,
                "items": dict(_ENTITY_ID_SCHEMA),
            },
            "choice_time_limit_sec": _nullable(
                {"type": "integer", "minimum": 1, "maximum": 300}
            ),
            "production_notes": {"type": "string", "maxLength": 8_000},
            "video_prompt": {"type": "string", "maxLength": 20_000},
            "media": _story_media_schema(),
            "choice_loop": _nullable(_story_choice_loop_schema()),
        },
        ["id", "title", "script"],
    )
    schema["allOf"] = [
        {
            "if": {
                "required": ["kind"],
                "properties": {"kind": {"const": "ending"}},
            },
            "then": {
                "required": ["ending_label"],
                "properties": {
                    "ending_label": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 40,
                    }
                },
            },
        },
        {
            "if": {
                "properties": {"kind": {"const": "scene"}},
            },
            "then": {"properties": {"ending_label": {"type": "null"}}},
        },
    ]
    return schema


def _story_condition_leaf_schemas() -> list[dict[str, Any]]:
    operator = {"enum": [">=", "<=", "==", ">", "<"]}
    return [
        _strict_object(
            {
                "kind": {"const": "variable"},
                "variable": dict(_VARIABLE_NAME_SCHEMA),
                "operator": operator,
                "value": {"type": "integer"},
            },
            ["kind", "variable", "operator", "value"],
        ),
        _strict_object(
            {
                "kind": {"const": "visited"},
                "segment_id": dict(_ENTITY_ID_SCHEMA),
                "operator": operator,
                "value": {"type": "integer", "minimum": 0},
            },
            ["kind", "segment_id", "operator", "value"],
        ),
        _strict_object(
            {
                "kind": {"const": "flag"},
                "flag": dict(_VARIABLE_NAME_SCHEMA),
                "value": {"type": "boolean"},
            },
            ["kind", "flag", "value"],
        ),
    ]


def _story_condition_schema() -> dict[str, Any]:
    leaves = _story_condition_leaf_schemas()
    group = _strict_object(
        {
            "kind": {"const": "group"},
            "join": {"enum": ["and", "or"]},
            "items": {
                "type": "array",
                "minItems": 1,
                "maxItems": 20,
                "items": {"oneOf": leaves},
            },
        },
        ["kind", "join", "items"],
    )
    return {"oneOf": [*leaves, group, {"type": "null"}]}


def _story_effects_schema() -> dict[str, Any]:
    return {
        "type": "array",
        "maxItems": 20,
        "items": {
            "oneOf": [
                _strict_object(
                    {
                        "kind": {"const": "increment"},
                        "variable": dict(_VARIABLE_NAME_SCHEMA),
                        "delta": {"type": "integer"},
                    },
                    ["kind", "variable", "delta"],
                ),
                _strict_object(
                    {
                        "kind": {"const": "set_flag"},
                        "flag": dict(_VARIABLE_NAME_SCHEMA),
                        "value": {"type": "boolean"},
                    },
                    ["kind", "flag", "value"],
                ),
            ]
        },
    }


def _story_anchor_schema() -> dict[str, Any]:
    schema = _strict_object(
        {
            "x": {"type": "number", "minimum": 0, "maximum": 1},
            "y": {"type": "number", "minimum": 0, "maximum": 1},
            "width": _nullable(
                {"type": "number", "exclusiveMinimum": 0, "maximum": 1}
            ),
            "height": _nullable(
                {"type": "number", "exclusiveMinimum": 0, "maximum": 1}
            ),
            "object_label": {"type": "string", "maxLength": 80},
        },
        ["x", "y"],
    )
    schema["allOf"] = [
        {
            "if": {"required": ["width"]},
            "then": {"required": ["height"]},
        },
        {
            "if": {"required": ["height"]},
            "then": {"required": ["width"]},
        },
    ]
    return schema


def _story_interaction_schema() -> dict[str, Any]:
    schema = _strict_object(
        {
            "presentation": {"enum": ["overlay", "object_anchor", "baked_video"]},
            "anchor": _nullable(_story_anchor_schema()),
            "ui_style": {"enum": ["glass", "tag", "warning"]},
            "motion": {"enum": ["fade", "pop", "pulse"]},
            "transition": {"enum": ["fade", "flash", "cut"]},
        }
    )
    schema["allOf"] = [
        {
            "if": {
                "required": ["presentation"],
                "properties": {
                    "presentation": {"enum": ["object_anchor", "baked_video"]}
                },
            },
            "then": {
                "required": ["anchor"],
                "properties": {"anchor": _story_anchor_schema()},
            },
        },
        {
            "if": {
                "required": ["presentation"],
                "properties": {"presentation": {"const": "baked_video"}},
            },
            "then": {
                "properties": {
                    "anchor": {
                        **_story_anchor_schema(),
                        "required": ["x", "y", "width", "height"],
                        "properties": {
                            **_story_anchor_schema()["properties"],
                            "width": {
                                "type": "number",
                                "exclusiveMinimum": 0,
                                "maximum": 1,
                            },
                            "height": {
                                "type": "number",
                                "exclusiveMinimum": 0,
                                "maximum": 1,
                            },
                        },
                    }
                }
            },
        },
    ]
    return schema


def _default_story_interaction_schema() -> dict[str, Any]:
    """Accept omitted default fields and the domain model's serialized defaults."""
    return _strict_object({
        "presentation": {"const": "overlay"},
        "anchor": {"type": "null"},
        "ui_style": {"const": "glass"},
        "motion": {"const": "fade"},
        "transition": {"const": "fade"},
    })


def _story_choice_schema() -> dict[str, Any]:
    """Describe the strict choice contract before a request reaches the API."""

    schema = _strict_object(
        {
            "id": dict(_ENTITY_ID_SCHEMA),
            "source_segment_id": dict(_ENTITY_ID_SCHEMA),
            "target_segment_id": dict(_ENTITY_ID_SCHEMA),
            "mode": {"enum": ["visible", "automatic"]},
            "text": {"type": "string", "maxLength": 500},
            "order": {"type": "integer", "minimum": 0},
            "condition": _story_condition_schema(),
            "effects": _story_effects_schema(),
            "feedback_text": {"type": "string", "maxLength": 500},
            "interaction": _story_interaction_schema(),
            "is_default": {"type": "boolean"},
        },
        [
            "id",
            "source_segment_id",
            "target_segment_id",
            "mode",
            "text",
            "order",
        ],
    )
    schema["allOf"] = [
            {
                "if": {
                    "required": ["mode"],
                    "properties": {"mode": {"const": "visible"}},
                },
                "then": {
                    "required": ["text"],
                    "properties": {"text": {"minLength": 1}},
                },
            },
            {
                "if": {
                    "required": ["mode"],
                    "properties": {"mode": {"const": "automatic"}},
                },
                "then": {
                    "properties": {
                        "text": {"const": ""},
                        "feedback_text": {"const": ""},
                        "interaction": _default_story_interaction_schema(),
                        "is_default": {"const": False},
                    }
                },
            },
        ]
    return schema


def _story_draft_schema() -> dict[str, Any]:
    return _strict_object(
        {
            "schema_version": {"const": "story_draft.v2"},
            "story_id": dict(_ENTITY_ID_SCHEMA),
            "revision": {"type": "integer", "minimum": 0},
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "synopsis": {"type": "string", "maxLength": 4_000},
            "start_segment_id": dict(_ENTITY_ID_SCHEMA),
            "characters": {
                "type": "array",
                "maxItems": 100,
                "items": _story_character_schema(),
            },
            "variables": {
                "type": "array",
                "maxItems": 100,
                "items": _story_variable_schema(),
            },
            "flags": {
                "type": "array",
                "maxItems": 100,
                "items": _story_flag_schema(),
            },
            "segments": {
                "type": "array",
                "minItems": 1,
                "maxItems": 2_000,
                "items": _story_segment_schema(),
            },
            "choices": {
                "type": "array",
                "maxItems": 8_000,
                "items": _story_choice_schema(),
            },
        },
        ["story_id", "title", "start_segment_id", "segments"],
    )


def _story_metadata_changes_schema() -> dict[str, Any]:
    return _strict_object(
        {
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "synopsis": {"type": "string", "maxLength": 4_000},
        },
        minProperties=1,
    )


def _story_segment_changes_schema() -> dict[str, Any]:
    schema = _strict_object(
        {
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "script": {"type": "string", "minLength": 1, "maxLength": 20_000},
            "kind": {"enum": ["scene", "ending"]},
            "ending_label": _nullable(
                {"type": "string", "minLength": 1, "maxLength": 40}
            ),
            "character_ids": {
                "type": "array",
                "maxItems": 64,
                "uniqueItems": True,
                "items": dict(_ENTITY_ID_SCHEMA),
            },
            "choice_time_limit_sec": _nullable(
                {"type": "integer", "minimum": 1, "maximum": 300}
            ),
            "production_notes": {"type": "string", "maxLength": 8_000},
            "video_prompt": {"type": "string", "maxLength": 20_000},
            "media": _nullable(_story_media_schema()),
            "choice_loop": _nullable(_story_choice_loop_schema()),
        },
        minProperties=1,
    )
    schema["allOf"] = [
        {
            "if": {
                "required": ["kind"],
                "properties": {"kind": {"const": "ending"}},
            },
            "then": {
                "required": ["ending_label"],
                "properties": {
                    "ending_label": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 40,
                    }
                },
            },
        },
        {
            "if": {
                "required": ["kind"],
                "properties": {"kind": {"const": "scene"}},
            },
            "then": {
                "required": ["ending_label"],
                "properties": {"ending_label": {"type": "null"}},
            },
        },
    ]
    return schema


def _story_choice_changes_schema() -> dict[str, Any]:
    schema = _strict_object(
        {
            "source_segment_id": dict(_ENTITY_ID_SCHEMA),
            "target_segment_id": dict(_ENTITY_ID_SCHEMA),
            "mode": {"enum": ["visible", "automatic"]},
            "text": {"type": "string", "maxLength": 500},
            "order": {"type": "integer", "minimum": 0},
            "condition": _story_condition_schema(),
            "effects": _story_effects_schema(),
            "feedback_text": {"type": "string", "maxLength": 500},
            "interaction": _story_interaction_schema(),
            "is_default": {"type": "boolean"},
        },
        minProperties=1,
    )
    schema["allOf"] = [
        {
            "if": {
                "required": ["mode"],
                "properties": {"mode": {"const": "visible"}},
            },
            "then": {
                "required": ["text"],
                "properties": {"text": {"minLength": 1}},
            },
        },
        {
            "if": {
                "required": ["mode"],
                "properties": {"mode": {"const": "automatic"}},
            },
            "then": {
                "required": ["text", "feedback_text", "interaction", "is_default"],
                "properties": {
                    "text": {"const": ""},
                    "feedback_text": {"const": ""},
                    "interaction": _default_story_interaction_schema(),
                    "is_default": {"const": False},
                },
            },
        },
    ]
    return schema


def _story_patch_operations_schema() -> dict[str, Any]:
    """Keep Patch operation names and envelopes unambiguous for MCP clients."""

    def operation(
        op: str,
        properties: dict[str, Any],
        required: list[str],
    ) -> dict[str, Any]:
        return {
            "type": "object",
            "additionalProperties": False,
            "properties": {"op": {"const": op}, **properties},
            "required": ["op", *required],
        }

    choice = _story_choice_schema()
    entity_ref = {"type": "string", "minLength": 1}
    return {
        "oneOf": [
            operation(
                "update_story_metadata",
                {"changes": _story_metadata_changes_schema()},
                ["changes"],
            ),
            operation(
                "set_story_start",
                {"segment_id": dict(_ENTITY_ID_SCHEMA)},
                ["segment_id"],
            ),
            operation(
                "add_segment",
                {"segment": _story_segment_schema()},
                ["segment"],
            ),
            operation(
                "update_segment",
                {
                    "segment_id": dict(_ENTITY_ID_SCHEMA),
                    "changes": _story_segment_changes_schema(),
                },
                ["segment_id", "changes"],
            ),
            operation(
                "remove_segment",
                {"segment_id": dict(_ENTITY_ID_SCHEMA)},
                ["segment_id"],
            ),
            operation("add_choice", {"choice": choice}, ["choice"]),
            operation(
                "update_choice",
                {
                    "choice_id": dict(_ENTITY_ID_SCHEMA),
                    "changes": _story_choice_changes_schema(),
                },
                ["choice_id", "changes"],
            ),
            operation(
                "remove_choice",
                {"choice_id": dict(_ENTITY_ID_SCHEMA)},
                ["choice_id"],
            ),
            operation(
                "upsert_variable",
                {"variable": _story_variable_schema()},
                ["variable"],
            ),
            operation("remove_variable", {"variable_name": entity_ref}, ["variable_name"]),
            operation(
                "upsert_flag",
                {"flag": _story_flag_schema()},
                ["flag"],
            ),
            operation("remove_flag", {"flag_name": entity_ref}, ["flag_name"]),
            operation(
                "upsert_character",
                {"character": _story_character_schema()},
                ["character"],
            ),
            operation(
                "remove_character",
                {"character_id": dict(_ENTITY_ID_SCHEMA)},
                ["character_id"],
            ),
        ]
    }


def build_tools(
    *,
    schema: Callable[..., dict[str, Any]],
    request: Callable[..., dict[str, Any]],
    project_from_args: Callable[[dict[str, Any]], str],
    tool_result: Callable[[Any], str],
    tool_error: Callable[[Any], str],
) -> tuple[tuple[str, dict[str, Any], Callable[..., str]], ...]:
    """Build the four interactive-story tools against one host adapter."""

    def story_path(args: dict[str, Any], story_id: str | None = None) -> str:
        project = quote(project_from_args(args), safe="")
        path = f"/api/v1/projects/{project}/interactive-stories"
        if story_id:
            path += f"/{quote(story_id, safe='')}"
        return path

    def story_body(args: dict[str, Any], *keys: str) -> dict[str, Any]:
        body = {key: args[key] for key in keys if key in args}
        canvas_id = str(
            args.get("canvas_id")
            or os.environ.get("DRAMACLAW_CANVAS_ID")
            or "default"
        ).strip()
        body["canvas_id"] = canvas_id or "default"
        return body

    def require_story_id(args: dict[str, Any]) -> str:
        story_id = str(args.get("story_id") or "").strip()
        if not story_id:
            raise ValueError("story_id is required")
        return story_id

    def handle_create(args: dict[str, Any], **_: Any) -> str:
        try:
            body = story_body(args, "base_revision", "idempotency_key", "story")
            return tool_result(request("POST", story_path(args), body=body))
        except Exception as exc:
            return tool_error(str(exc))

    def handle_get(args: dict[str, Any], **_: Any) -> str:
        try:
            story_id = require_story_id(args)
            canvas_id = str(
                args.get("canvas_id")
                or os.environ.get("DRAMACLAW_CANVAS_ID")
                or "default"
            ).strip()
            return tool_result(
                request(
                    "GET",
                    story_path(args, story_id),
                    query={"canvas_id": canvas_id or "default"},
                )
            )
        except Exception as exc:
            return tool_error(str(exc))

    def handle_patch(args: dict[str, Any], **_: Any) -> str:
        try:
            story_id = require_story_id(args)
            body = story_body(
                args,
                "story_id",
                "base_revision",
                "idempotency_key",
                "operations",
            )
            return tool_result(
                request("PATCH", story_path(args, story_id), body=body)
            )
        except Exception as exc:
            return tool_error(str(exc))

    def handle_validate(args: dict[str, Any], **_: Any) -> str:
        try:
            story_id = require_story_id(args)
            body = story_body(args, "story_id")
            return tool_result(
                request(
                    "POST",
                    f"{story_path(args, story_id)}/validate",
                    body=body,
                )
            )
        except Exception as exc:
            return tool_error(str(exc))

    return (
        (
            "dramaclaw_create_interactive_story",
            schema(
                "dramaclaw_create_interactive_story",
                "Create one confirmed branching interactive story and project it into the current Freezone canvas. Never replay a successful or ambiguous write; after an explicit request-validation rejection, correct only the reported fields and retry at most once.",
                {
                    "project_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_PROJECT_ID.",
                    },
                    "canvas_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_CANVAS_ID or default.",
                    },
                    "base_revision": {"type": "integer", "minimum": 0},
                    "idempotency_key": {
                        "type": "string",
                        "minLength": 8,
                        "maxLength": 200,
                    },
                    "story": {
                        **_story_draft_schema(),
                        "description": "Complete StoryDraftV2 payload.",
                    },
                },
                ["base_revision", "idempotency_key", "story"],
                additional_properties=False,
            ),
            handle_create,
        ),
        (
            "dramaclaw_get_interactive_story",
            schema(
                "dramaclaw_get_interactive_story",
                "Read one branching story from its canvas projection before explaining or editing it.",
                {
                    "project_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_PROJECT_ID.",
                    },
                    "canvas_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_CANVAS_ID or default.",
                    },
                    "story_id": {"type": "string", "minLength": 1},
                },
                ["story_id"],
                additional_properties=False,
            ),
            handle_get,
        ),
        (
            "dramaclaw_patch_interactive_story",
            schema(
                "dramaclaw_patch_interactive_story",
                "Apply one atomic StoryPatchV2 to an existing branching story. Merge all changes for the current user intent into this one call.",
                {
                    "project_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_PROJECT_ID.",
                    },
                    "canvas_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_CANVAS_ID or default.",
                    },
                    "story_id": {"type": "string", "minLength": 1},
                    "base_revision": {"type": "integer", "minimum": 0},
                    "idempotency_key": {
                        "type": "string",
                        "minLength": 8,
                        "maxLength": 200,
                    },
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 200,
                        "items": _story_patch_operations_schema(),
                    },
                },
                ["story_id", "base_revision", "idempotency_key", "operations"],
                additional_properties=False,
            ),
            handle_patch,
        ),
        (
            "dramaclaw_validate_interactive_story",
            schema(
                "dramaclaw_validate_interactive_story",
                "Validate the stored branching story and return structural and media-readiness issues without writing the canvas.",
                {
                    "project_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_PROJECT_ID.",
                    },
                    "canvas_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_CANVAS_ID or default.",
                    },
                    "story_id": {"type": "string", "minLength": 1},
                },
                ["story_id"],
                additional_properties=False,
            ),
            handle_validate,
        ),
    )

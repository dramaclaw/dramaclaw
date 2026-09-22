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
            "cta": _nullable(_strict_object({"label": {"type": "string", "minLength": 1, "maxLength": 120}, "url": {"type": "string", "maxLength": 4096}}, ["label"])),
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
            "trigger": {"enum": ["click", "hold"]},
            "hold_ms": {"type": "integer", "minimum": 300, "maximum": 5000},
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
        "trigger": {"const": "click"},
        "hold_ms": {"const": 1000},
    })


def _story_choice_schema() -> dict[str, Any]:
    """Describe the choice contract while preserving domain-model defaults."""

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
            "order",
        ],
    )
    schema["allOf"] = [
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
            # Omitting mode uses the domain default (visible), which still
            # requires player-facing choice text.
            "else": {
                "required": ["text"],
                "properties": {"text": {"minLength": 1}},
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
            "cta": _nullable(_strict_object({"label": {"type": "string", "minLength": 1, "maxLength": 120}, "url": {"type": "string", "maxLength": 4096}}, ["label"])),
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
        description = f"{op}: required payload fields: {', '.join(required)}."
        if op.startswith("upsert_"):
            description += (
                f" Put the complete entity in '{required[0]}', never in 'changes'."
                " When replacing an existing entity, preserve its other fields from Get."
            )
        return {
            "type": "object",
            "description": description,
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


def _story_outline_schema() -> dict[str, Any]:
    return _strict_object(
        {
            "schema_version": {"const": "pending_story_outline.v1"},
            "outline_id": dict(_ENTITY_ID_SCHEMA),
            "kind": {"enum": ["story", "ad"]},
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "premise": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4_000,
                "description": "Background or creative idea awaiting confirmation.",
            },
            "plot_summary": {"type": "string", "minLength": 1, "maxLength": 8_000},
            "interaction_summary": {"type": "string", "maxLength": 4_000},
            "endings_summary": {"type": "string", "maxLength": 2_000},
            "duration_budget_sec": _nullable(
                {"type": "integer", "minimum": 1, "maximum": 86_400}
            ),
            "open_questions": {
                "type": "array",
                "maxItems": 20,
                "items": {"type": "string", "minLength": 1, "maxLength": 500},
            },
            "status": {"enum": ["pending", "needs_revision"]},
        },
        ["outline_id", "kind", "title", "premise", "plot_summary"],
    )


# The SKILL's "only Create after the user confirmed" is no longer prompt-only:
# the Create entry hard-gates on the canvas outline when one exists.
_CONFIRMED_OUTLINE_STATUSES = frozenset({"confirmed", "linked"})


def build_tools(
    *,
    schema: Callable[..., dict[str, Any]],
    request: Callable[..., dict[str, Any]],
    project_from_args: Callable[[dict[str, Any]], str],
    tool_result: Callable[[Any], str],
    tool_error: Callable[[Any], str],
) -> tuple[tuple[str, dict[str, Any], Callable[..., str]], ...]:
    """Build the interactive-story tools against one host adapter."""

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

    def outline_confirmation_gate(args: dict[str, Any]) -> str | None:
        """Cheap pre-check: refuse Create while the canvas outline is unconfirmed.

        The authoritative gate lives in the backend create path itself (the
        REST route returns the same outline_not_confirmed code), so this
        pre-check may fail open on read errors without letting an unconfirmed
        create through; it exists to give the agent the clearer "do not retry,
        ask the user to confirm" instruction before a write is attempted.
        A missing outline passes: outline-free direct creation stays
        permissive.
        """
        canvas_id = str(
            args.get("canvas_id")
            or os.environ.get("DRAMACLAW_CANVAS_ID")
            or "default"
        ).strip() or "default"
        result = request("GET", outline_path(args), query={"canvas_id": canvas_id})
        outline = result.get("outline") if isinstance(result, dict) else None
        if isinstance(outline, dict) and outline.get("status") not in _CONFIRMED_OUTLINE_STATUSES:
            return (
                "outline_not_confirmed: the canvas still has a pending story outline "
                f"(status={outline.get('status')!r}) that the user has not confirmed "
                "on the plan card. Do not retry; ask the user to confirm it, and "
                "only call Create after dramaclaw_get_interactive_story_outline "
                "reports status confirmed or linked."
            )
        return None

    def handle_create(args: dict[str, Any], **_: Any) -> str:
        try:
            gate_error = outline_confirmation_gate(args)
            if gate_error is not None:
                return tool_error(gate_error)
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

    def outline_path(args: dict[str, Any]) -> str:
        project = quote(project_from_args(args), safe="")
        return f"/api/v1/projects/{project}/interactive-story-outline"

    def handle_save_outline(args: dict[str, Any], **_: Any) -> str:
        try:
            outline = args.get("outline")
            if not isinstance(outline, dict):
                raise ValueError("outline is required")
            body = story_body(args, "base_revision", "idempotency_key")
            body["outline"] = outline
            return tool_result(request("PUT", outline_path(args), body=body))
        except Exception as exc:
            return tool_error(str(exc))

    def handle_get_outline(args: dict[str, Any], **_: Any) -> str:
        try:
            canvas_id = str(
                args.get("canvas_id")
                or os.environ.get("DRAMACLAW_CANVAS_ID")
                or "default"
            ).strip()
            return tool_result(
                request(
                    "GET",
                    outline_path(args),
                    query={"canvas_id": canvas_id or "default"},
                )
            )
        except Exception as exc:
            return tool_error(str(exc))

    def handle_get_progress(args: dict[str, Any], **_: Any) -> str:
        try:
            project = quote(project_from_args(args), safe="")
            canvas_id = str(
                args.get("canvas_id")
                or os.environ.get("DRAMACLAW_CANVAS_ID")
                or "default"
            ).strip()
            return tool_result(
                request(
                    "GET",
                    f"/api/v1/projects/{project}/interactive-story-progress",
                    query={"canvas_id": canvas_id or "default"},
                )
            )
        except Exception as exc:
            return tool_error(str(exc))

    def handle_confirm_stages(args: dict[str, Any], **_: Any) -> str:
        try:
            story_id = require_story_id(args)
            body = story_body(
                args,
                "story_id",
                "stages",
                "action",
                "base_revision",
                "idempotency_key",
            )
            return tool_result(
                request(
                    "POST",
                    f"{story_path(args, story_id)}/stage-confirmations",
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
                "Create one confirmed branching interactive story and project it into the current Freezone canvas. The call is rejected with outline_not_confirmed while the canvas still holds a user-unconfirmed pending outline. Never replay a successful or ambiguous write; after an explicit request-validation rejection, correct only the reported fields and retry at most once.",
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
                "Apply one atomic StoryPatchV2 to an existing branching story. "
                "Always supply a non-empty operations array along with story_id, base_revision and idempotency_key. "
                "Merge all changes for the current user intent into this one call. "
                "Only update_* operations use changes. upsert_character uses character, "
                "upsert_variable uses variable, and upsert_flag uses flag (complete entities). "
                "add_segment uses segment; add_choice uses choice.",
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
                        "description": (
                            "Required non-empty list of {op, ...payload} operations. "
                            "Do not send a metadata-only Patch. Example: "
                            '{"op":"upsert_character","character":{"id":"meimei","name":"小美"}}. '
                            "Use each op's exact payload field; changes is only for update_* operations."
                        ),
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
        (
            "dramaclaw_save_interactive_story_outline",
            schema(
                "dramaclaw_save_interactive_story_outline",
                "Save or update the canvas-level pending story outline for user review. This is not the formal story: it never creates story nodes, and any content change resets the user's confirmation. Only call after the user agreed to move the plan onto the canvas.",
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
                    "outline": {
                        **_story_outline_schema(),
                        "description": "Complete PendingStoryOutline payload.",
                    },
                },
                ["base_revision", "idempotency_key", "outline"],
                additional_properties=False,
            ),
            handle_save_outline,
        ),
        (
            "dramaclaw_get_interactive_story_outline",
            schema(
                "dramaclaw_get_interactive_story_outline",
                "Read the canvas-level pending story outline and its confirmation status before creating the formal story.",
                {
                    "project_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_PROJECT_ID.",
                    },
                    "canvas_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_CANVAS_ID or default.",
                    },
                },
                None,
                additional_properties=False,
            ),
            handle_get_outline,
        ),
        (
            "dramaclaw_get_interactive_story_progress",
            schema(
                "dramaclaw_get_interactive_story_progress",
                "Read the canvas-derived creative pipeline progress (proposal/outline/script/characters/video/... plus the underlying evidence counts). This read writes nothing. Call it before drafting a production plan or writing per-segment video prompts so the plan matches the stage the user actually sees. A script-like stage that is not done means narration or structural errors are still missing. character_count only counts story definitions; it is not evidence that character cards, designs, or reference assets exist. confirmed_stages contains only explicit user confirmations recorded through dramaclaw_confirm_interactive_story_stages.",
                {
                    "project_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_PROJECT_ID.",
                    },
                    "canvas_id": {
                        "type": "string",
                        "description": "Defaults to DRAMACLAW_CANVAS_ID or default.",
                    },
                },
                None,
                additional_properties=False,
            ),
            handle_get_progress,
        ),
        (
            "dramaclaw_confirm_interactive_story_stages",
            schema(
                "dramaclaw_confirm_interactive_story_stages",
                "Confirm or reopen manual interactive-story stages on the persisted canvas. Call action=confirm only when the user explicitly says the listed stages are complete or asks to continue past them; never infer confirmation from image nodes, filenames, generated assets, or later-stage content. Call action=reopen when the user explicitly asks to redo a previously confirmed stage.",
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
                    "stages": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 4,
                        "uniqueItems": True,
                        "items": {
                            "enum": [
                                "characters",
                                "scenes",
                                "storyboard",
                                "complete",
                            ]
                        },
                    },
                    "action": {"enum": ["confirm", "reopen"]},
                    "base_revision": {"type": "integer", "minimum": 0},
                    "idempotency_key": {
                        "type": "string",
                        "minLength": 8,
                        "maxLength": 200,
                    },
                },
                ["story_id", "stages", "action", "base_revision", "idempotency_key"],
                additional_properties=False,
            ),
            handle_confirm_stages,
        ),
    )

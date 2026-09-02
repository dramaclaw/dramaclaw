"""Interactive-story tool definitions for the shared DramaClaw toolset.

This module is intentionally host-neutral and stdlib-only. Hermes loads the
tool entries through the native plugin, while Codex and other MCP clients see
the same entries through ``novelvideo.chat.dramaclaw_mcp``.
"""

from __future__ import annotations

import os
from typing import Any, Callable
from urllib.parse import quote


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
                "Create one confirmed branching interactive story and project it into the current Freezone canvas. Call at most once per user turn.",
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
                        "type": "object",
                        "description": "Complete StoryDraftV1 payload.",
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
                "Apply one atomic StoryPatchV1 to an existing branching story. Merge all changes for the current user intent into this one call.",
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
                        "items": {"type": "object"},
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

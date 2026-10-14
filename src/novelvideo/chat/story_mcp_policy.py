"""Interactive-story validation and result rules for MCP hosts."""

from __future__ import annotations

import json
from typing import Any

from jsonschema.exceptions import SchemaError, ValidationError

from novelvideo.chat import mcp_runtime

STORY_WRITE_TOOLS = frozenset(
    {
        "dramaclaw_create_interactive_story",
        "dramaclaw_patch_interactive_story",
        "dramaclaw_confirm_interactive_story_stages",
    }
)


def _validation_message(error: Any) -> str | None:
    path = ".".join(str(part) for part in getattr(error, "absolute_path", ()))
    if (
        path.endswith(".feedback_text")
        and error.validator == "const"
        and error.validator_value == ""
    ):
        return "Automatic transition feedback_text must be empty. Keep effects unchanged; automatic transitions may apply effects."
    return None


def validation_error_details(errors: list[Any]) -> list[dict[str, Any]]:
    return mcp_runtime.validation_error_details(errors, _validation_message)


def validation_error_payload(
    name: str,
    arguments: dict[str, Any],
    schema: dict[str, Any],
    exc: SchemaError | ValidationError,
    errors: list[Any],
) -> dict[str, Any]:
    payload = mcp_runtime.validation_error_payload(name, arguments, schema, exc, errors)
    if name in STORY_WRITE_TOOLS:
        details = validation_error_details(errors)
        payload.update(
            {
                "message": f"{len(details)} argument validation error(s); first at {details[0]['path'] or '<root>'}: {details[0]['message']}",
                "path": ".".join(
                    str(part) for part in getattr(exc, "absolute_path", ())
                ),
                "details": details,
                "retryable": True,
                "next_action": "仅修正 details.path 列出的字段，保留其他字段；读取最新 revision 后最多重试一次",
                "agent_instruction": (
                    "The story write was rejected before execution. Report the validation paths, correct only those exact fields, "
                    "and preserve all unreported fields including effects. Re-read the current canvas for Create or the story "
                    "for Patch, then retry once with the latest revision and a new idempotency key. If that corrected call "
                    "fails, report it and end the turn without another write."
                ),
            }
        )
    return payload


def render_text(name: str, text: str, decoded: Any, structured: dict[str, Any]) -> str:
    if name in {
        "dramaclaw_create_interactive_story",
        "dramaclaw_patch_interactive_story",
    }:
        if (
            isinstance(decoded, dict)
            and isinstance(decoded.get("data"), dict)
            and "detail" in decoded["data"]
        ):
            return json.dumps(structured, ensure_ascii=False)
    return text


STORY_HOOKS = mcp_runtime.ToolCallHooks(
    validation_error=validation_error_payload,
    collect_all_errors=lambda name: name in STORY_WRITE_TOOLS,
    render_text=render_text,
)

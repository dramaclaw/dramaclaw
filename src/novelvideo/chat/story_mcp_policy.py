"""Interactive-story validation and result rules for MCP hosts."""

from __future__ import annotations

import json
from typing import Any

from novelvideo.chat import mcp_runtime

from novelvideo.chat.story_validation import (
    STORY_WRITE_TOOLS,
    story_validation_error_details as validation_error_details,  # noqa: F401 - public re-export
    validation_error_payload,
)


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

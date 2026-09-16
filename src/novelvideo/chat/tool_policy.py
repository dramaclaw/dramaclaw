"""Surface and Agent-profile policy decisions for chat tools."""

from __future__ import annotations

from typing import Any


def surface_context_has_freezone_canvas(
    surface_context: dict[str, Any] | None,
) -> bool:
    return bool(str((surface_context or {}).get("freezone_canvas_id") or "").strip())


def tool_mode_for_surface(
    surface: str | None,
    *,
    prompt: str | None = None,
    surface_context: dict[str, Any] | None = None,
) -> str:
    """Resolve a legacy tool mode without treating prompt text as authority."""
    del prompt
    if str(surface or "").strip() == "freezone":
        return "freezone_canvas"
    if surface_context_has_freezone_canvas(surface_context):
        return "freezone_canvas"
    return "default"


def freezone_canvas_id_from_context(
    surface_context: dict[str, Any] | None,
) -> str:
    return (
        str((surface_context or {}).get("freezone_canvas_id") or "default").strip()
        or "default"
    )


def freezone_canvas_execution_mode_from_context(
    surface_context: dict[str, Any] | None,
) -> str:
    value = str(
        (surface_context or {}).get("canvas_command_execution_mode") or ""
    ).strip()
    return "auto_execute" if value == "auto_execute" else "manual_confirm"


def allows_mainline_media_ui_specs(tool_mode: str) -> bool:
    """Mainline galleries are unavailable in Freezone canvas replies."""
    return str(tool_mode or "").strip() != "freezone_canvas"

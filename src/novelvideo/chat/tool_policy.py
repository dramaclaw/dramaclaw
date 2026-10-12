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


# ---------------------------------------------------------------------------
# Tool-name policy.
#
# This is the single source for "which agent tool counts as what" decisions.
# Runtime adapters (Hermes/Codex), the runtime event evidence checks, the chat
# application and the presentation mappers all import these values; none of
# them may keep a private copy. The names must match the tools published by
# the Hermes plugins under ``.hermes/plugins`` (tests/test_tool_policy_contract.py
# checks that they do).
# ---------------------------------------------------------------------------

DRAMACLAW_WRITE_TOOLS: frozenset[str] = frozenset(
    {
        "dramaclaw_build_characters",
        "dramaclaw_compose_episode",
        "dramaclaw_create_freezone_canvas_from_preset",
        "dramaclaw_delete",
        "dramaclaw_delete_freezone_canvas",
        "dramaclaw_detect_sketch_identities",
        "dramaclaw_generate_audio",
        "dramaclaw_generate_identity_image",
        "dramaclaw_generate_portrait",
        "dramaclaw_generate_scene_master",
        "dramaclaw_generate_scene_reverse",
        "dramaclaw_generate_script",
        "dramaclaw_generate_sketches",
        "dramaclaw_optimize_video_global",
        "dramaclaw_patch",
        "dramaclaw_plan_episodes",
        "dramaclaw_plan_identities",
        "dramaclaw_plan_props",
        "dramaclaw_plan_scenes",
        "dramaclaw_post",
        "dramaclaw_prepare_system_voices",
        "dramaclaw_render_first_frames",
        "dramaclaw_run_freezone_skill",
        "dramaclaw_save_freezone_canvas",
        "dramaclaw_start_single_video",
        "dramaclaw_start_video_batch",
        "dramaclaw_update_character_face_prompt",
    }
)
"""Mainline write tools. A Hermes turn stops after one of these has run (one-step rule)."""

FREEZONE_CANVAS_WRITE_TOOLS: frozenset[str] = frozenset(
    {
        "freezone_add_next_node",
        "freezone_confirm_canvas_action",
        "freezone_confirm_workflow_draft",
        "freezone_create_edge",
        "freezone_create_node",
        "freezone_delete_edges",
        "freezone_delete_nodes",
        "freezone_emit_canvas_command",
        "freezone_group_nodes",
        "freezone_layout_nodes",
        "freezone_move_nodes",
        "freezone_open_mainline_projection",
        "freezone_run_node_action",
        "freezone_run_workflow",
        "freezone_select_nodes",
        "freezone_update_node_data",
    }
)
"""Freezone tools that mutate the canvas and complete through the browser bridge receipt."""

FREEZONE_TERMINAL_WRITE_TOOLS: frozenset[str] = frozenset(
    {
        "freezone_run_workflow",
    }
)
"""Freezone writes that end the turn once issued; a repeat of the same tool is stopped."""

FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS: frozenset[str] = frozenset(
    {
        "freezone_prepare_workflow_draft",
        "freezone_prepare_workflow_plan_draft",
    }
)
"""Tools whose successful result carries a persisted workflow draft."""

FREEZONE_WORKFLOW_DRAFT_TOOLS: frozenset[str] = (
    FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS
    | frozenset(
        {
            "freezone_patch_workflow_draft",
            "freezone_confirm_workflow_draft",
        }
    )
)
"""Workflow draft tools. Repeated reads of these are legitimate and exempt from the read guard."""

AGENT_PRODUCT_RESULT_TOOLS: frozenset[str] = frozenset(
    {
        "freezone_prepare_workflow",
        "freezone_prepare_workflow_draft",
        "freezone_prepare_workflow_plan_draft",
        "freezone_put_agent_catalog_recipe",
        "freezone_put_agent_catalog_skill",
    }
)
"""Tools whose result binds an admitted Agent product operation to the executing tool call."""

DISPLAY_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "dramaclaw_get_character_media",
        "dramaclaw_get_episode_media",
        "dramaclaw_get_final_video",
        "dramaclaw_get_first_frames",
        "dramaclaw_get_scene_images",
        "dramaclaw_get_sketch_candidates",
        "dramaclaw_get_sketches",
    }
)
"""Mainline media display tools whose UI cards may be rebuilt from the authoritative API."""

HIDDEN_TOOL_MARKERS: tuple[str, ...] = (
    "skill_view",
    "skills_list",
    "skill view",
    "skills list",
    "loading skill",
    "→ skill view",
    "→ skills list",
)
"""Substrings that mark internal Hermes bookkeeping tool events (skill loading) as not user-visible."""


def is_hidden_chat_tool_event(name: object, text: object) -> bool:
    """Internal Hermes bookkeeping tools should not become user-visible cards."""
    haystack = f"{name or ''}\n{text or ''}".lower()
    return any(marker in haystack for marker in HIDDEN_TOOL_MARKERS)

"""Normalize Freezone tool outcomes from Agent runtime events.

The chat application uses these pure checks to distinguish a durable canvas
write receipt from a successful transport call. Keep provider payload parsing
at this boundary while callers migrate to provider-neutral event names.
"""

from __future__ import annotations

import json
from typing import Any

from novelvideo.chat.tool_policy import (
    FREEZONE_CANVAS_WRITE_TOOLS as _FREEZONE_CANVAS_WRITE_TOOLS,
)


def _codex_freezone_tool_name(event: Any) -> str:
    return str(getattr(event, "name", "") or "").rsplit(".", 1)[-1].strip()


def _json_objects_from_codex_tool_value(value: Any) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    if isinstance(value, dict):
        objects.append(value)
        for nested in value.values():
            objects.extend(_json_objects_from_codex_tool_value(nested))
    elif isinstance(value, list):
        for nested in value:
            objects.extend(_json_objects_from_codex_tool_value(nested))
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            # ValueError also covers a digit string beyond int()'s digit limit,
            # which json.loads raises as a plain ValueError, not a decode error.
            return objects
        objects.extend(_json_objects_from_codex_tool_value(parsed))
    return objects


def _codex_freezone_is_write_event(event: Any) -> bool:
    name = _codex_freezone_tool_name(event)
    if name not in _FREEZONE_CANVAS_WRITE_TOOLS:
        return False
    if name == "freezone_run_node_action":
        for payload in _json_objects_from_codex_tool_value(
            getattr(event, "input", None)
        ):
            action = payload.get("action")
            if action in {"read_source", "history"}:
                return False
            if isinstance(action, str) and action.strip():
                return True
        return True
    return True


def _codex_freezone_write_receipt(
    event: Any,
    *,
    expected_project: str | None = None,
    expected_canvas: str | None = None,
) -> dict[str, Any] | None:
    if _codex_freezone_tool_name(event) not in _FREEZONE_CANVAS_WRITE_TOOLS:
        return None
    status = str(getattr(event, "status", "") or "").strip().lower()
    if status not in {"completed", "success", "succeeded"} or getattr(
        event, "error", None
    ):
        return None
    values = [getattr(event, "structured", None), getattr(event, "output", None)]
    for value in values:
        for payload in _json_objects_from_codex_tool_value(value):
            if payload.get("ok") is not True:
                continue
            apply_status = str(payload.get("canvas_apply_status") or "").strip().lower()
            project_id = str(payload.get("project_id") or "").strip()
            canvas_id = str(payload.get("canvas_id") or "").strip()
            if expected_project is not None and project_id != expected_project:
                continue
            if expected_canvas is not None and canvas_id != expected_canvas:
                continue
            bridge_key = str(payload.get("bridge_key") or "").strip()
            revision = payload.get("revision")
            story_tool = _codex_freezone_tool_name(event)
            if story_tool in {
                "dramaclaw_create_interactive_story",
                "dramaclaw_patch_interactive_story",
                "dramaclaw_save_interactive_story_outline",
                "dramaclaw_confirm_interactive_story_outline",
                "dramaclaw_confirm_interactive_story_stages",
            }:
                identity_field = (
                    "outline_id"
                    if story_tool in {"dramaclaw_save_interactive_story_outline", "dramaclaw_confirm_interactive_story_outline"}
                    else "story_id"
                )
                if (
                    payload.get("refresh_canvas") is True
                    and isinstance(payload.get(identity_field), str)
                    and payload[identity_field].strip()
                    and project_id
                    and canvas_id
                    and type(revision) is int
                    and revision >= 0
                ):
                    return payload
                continue
            # Browser receipts require bridge identity; server receipts require
            # the saved canvas revision as proof of persistence.
            browser_receipt = (
                apply_status in {"applied", "accepted"}
                and payload.get("applied") is True
                and bool(bridge_key and project_id and canvas_id)
            )
            server_receipt = (
                apply_status == "applied"
                and payload.get("applied") is True
                and bool(project_id and canvas_id)
                and isinstance(revision, int)
                and not isinstance(revision, bool)
                and revision >= 0
            )
            if browser_receipt or server_receipt:
                return payload
    return None


def _codex_freezone_tool_arguments(event: Any) -> dict[str, Any] | None:
    payload = getattr(event, "input", None)
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return None
    return payload if isinstance(payload, dict) else None


def story_argument_retry_matches(
    before: dict[str, Any], after: dict[str, Any], rejection: dict[str, Any],
    *, tool_name: str | None = None,
) -> bool:
    """Compare a story retry, allowing only server-reported invalid fields.

    The caller must separately verify tool name, bound scope, call identity and
    the durable receipt. Unknown or ambiguous diagnostics are not proof that a
    later write resolves the earlier rejection.
    """
    if (
        rejection.get("ok") is not False
        or rejection.get("error") != "tool_arguments_invalid"
        or rejection.get("phase") != "tool_validation"
    ):
        return False
    paths = rejection.get("invalid_argument_paths")
    if rejection.get("argument_corrections_complete") is not True:
        # Older servers returned only this precise diagnostic. Keep the
        # previously supported outline-ID retry without guessing other fields.
        if (
            "argument_corrections_complete" not in rejection
            and
            rejection.get("path") == "outline"
            and rejection.get("message") == "'outline_id' is a required property"
        ):
            paths = [["outline", "outline_id"]]
        else:
            return False
    if not isinstance(paths, list) or not paths:
        return False
    parsed: list[tuple[str | int, ...]] = []
    for path in paths:
        if (
            not isinstance(path, list) or not path
            or any(not isinstance(part, (str, int)) or isinstance(part, bool) for part in path)
            or not isinstance(path[0], str)
            or path[0] in {"project_id", "canvas_id", "project"}
        ):
            return False
        item = tuple(path)
        if item not in parsed:
            parsed.append(item)
    # A diagnostic for an entire operation payload does not identify what the
    # user intended; it cannot prove that a replacement is the same operation.
    if any(path in {("story",), ("outline",), ("operations",), ("stages",)} for path in parsed):
        return False
    if any(a != b and len(a) <= len(b) and b[:len(a)] == a for a in parsed for b in parsed):
        return False
    try:
        left = json.loads(json.dumps(before, ensure_ascii=False))
        right = json.loads(json.dumps(after, ensure_ascii=False))
    except (TypeError, ValueError):
        return False
    changed = False
    marker = {"__reported_invalid_argument__": True}
    for path in parsed:
        if path[0] in {"base_revision", "idempotency_key"} and len(path) == 1:
            if left.get(path[0]) != right.get(path[0]):
                changed = True
            continue
        parents = [left, right]
        for part in path[:-1]:
            for i, parent in enumerate(parents):
                if isinstance(parent, dict) and isinstance(part, str) and part in parent:
                    parents[i] = parent[part]
                elif isinstance(parent, list) and type(part) is int and 0 <= part < len(parent):
                    parents[i] = parent[part]
                else:
                    return False
        key = path[-1]
        if all(isinstance(parent, dict) for parent in parents) and isinstance(key, str):
            if key not in parents[0] and key not in parents[1]:
                return False
            # Mask scalar corrections only. Replacing a nested object or array
            # could silently change unreported content, order, or operation count.
            if any(isinstance(parent.get(key), (dict, list)) for parent in parents):
                return False
            changed |= (
                key not in parents[0] or key not in parents[1]
                or json.dumps(parents[0][key], sort_keys=True) != json.dumps(parents[1][key], sort_keys=True)
            )
            for parent in parents:
                parent[key] = marker
        elif (
            all(isinstance(parent, list) for parent in parents)
            and type(key) is int
            and len(parents[0]) == len(parents[1])
            and all(0 <= key < len(parent) for parent in parents)
            and all(not isinstance(parent[key], (dict, list)) for parent in parents)
        ):
            changed |= json.dumps(parents[0][key], sort_keys=True) != json.dumps(parents[1][key], sort_keys=True)
            for parent in parents:
                parent[key] = marker
        else:
            return False
    if not changed:
        return False
    for args in (left, right):
        args.pop("base_revision", None)
        args.pop("idempotency_key", None)
        if tool_name == "dramaclaw_save_interactive_story_outline":
            outline = args.get("outline")
            if isinstance(outline, dict):
                # PendingStoryOutline materializes these defaults before saving.
                # Omitting one and explicitly sending its default are therefore
                # the same write; no other field or value gets normalized.
                defaults = {
                    "schema_version": "pending_story_outline.v1",
                    "interaction_summary": "",
                    "endings_summary": "",
                    "duration_budget_sec": None,
                    "open_questions": [],
                    "status": "pending",
                }
                for field, default in defaults.items():
                    value = outline.get(field)
                    if field in outline and type(value) is type(default) and value == default:
                        del outline[field]
    return json.dumps(left, sort_keys=True, ensure_ascii=False) == json.dumps(
        right, sort_keys=True, ensure_ascii=False
    )


def _codex_freezone_tool_argument_rejection(event: Any) -> dict[str, Any] | None:
    """The payload of a write the MCP input schema refused before its handler ran."""
    if _codex_freezone_tool_name(event) not in _FREEZONE_CANVAS_WRITE_TOOLS:
        return None
    rejection = None
    for value in (
        getattr(event, "structured", None),
        getattr(event, "output", None),
        getattr(event, "error", None),
    ):
        for payload in _json_objects_from_codex_tool_value(value):
            if (
                payload.get("ok") is False
                and payload.get("error") == "tool_arguments_invalid"
                and payload.get("phase") == "tool_validation"
            ):
                # structuredContent keeps only output-schema keys; prefer the
                # raw copy that still carries the reported corrections.
                if "unexpected_fields" in payload or "integer_string_fields" in payload:
                    return payload
                rejection = rejection or payload
    return rejection

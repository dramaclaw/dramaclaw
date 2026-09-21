"""Normalize Freezone tool outcomes from Agent runtime events.

The chat application uses these pure checks to distinguish a durable canvas
write receipt from a successful transport call. Keep provider payload parsing
at this boundary while callers migrate to provider-neutral event names.
"""

from __future__ import annotations

import json
from typing import Any

_FREEZONE_CANVAS_WRITE_TOOLS = frozenset(
    {
        "freezone_create_node",
        "freezone_add_next_node",
        "freezone_emit_canvas_command",
        "freezone_update_node_data",
        "freezone_delete_nodes",
        "freezone_delete_edges",
        "freezone_create_edge",
        "freezone_layout_nodes",
        "freezone_group_nodes",
        "freezone_move_nodes",
        "freezone_select_nodes",
        "freezone_open_mainline_projection",
        "freezone_run_node_action",
        "freezone_run_workflow",
        "freezone_confirm_workflow_draft",
        "freezone_confirm_canvas_action",
    }
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
        except (TypeError, json.JSONDecodeError):
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


def _codex_freezone_write_result_succeeded(event: Any) -> bool:
    return _codex_freezone_write_receipt(event) is not None


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
            # A transport/tool status is not proof that the canvas mutation
            # was persisted. Browser-applied results are durable only when
            # they carry the bridge receipt identity; direct applies must
            # carry the saved canvas revision returned by the persistence API.
            browser_receipt = (
                apply_status in {"applied", "accepted"}
                and payload.get("applied") is True
                and bool(bridge_key and project_id and canvas_id)
            )
            direct_receipt = (
                apply_status == "direct_applied"
                and payload.get("applied") is True
                and bool(project_id and canvas_id)
                and isinstance(revision, int)
                and not isinstance(revision, bool)
                and revision >= 0
            )
            if browser_receipt or direct_receipt:
                return payload
    return None


def _codex_freezone_write_result_error(event: Any) -> str:
    """Extract the business error returned by a completed Freezone write tool."""

    if _codex_freezone_tool_name(event) not in _FREEZONE_CANVAS_WRITE_TOOLS:
        return ""
    values = [
        getattr(event, "structured", None),
        getattr(event, "output", None),
        getattr(event, "error", None),
    ]
    for value in values:
        for payload in _json_objects_from_codex_tool_value(value):
            if payload.get("ok") is not False:
                continue
            for key in ("user_message", "error"):
                message = payload.get(key)
                if isinstance(message, str) and message.strip():
                    return message.strip()[:1000]
            errors = payload.get("errors")
            if isinstance(errors, list):
                messages = [str(item).strip() for item in errors if str(item).strip()]
                if messages:
                    return "；".join(messages[:3])[:1000]
            message = payload.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()[:1000]
    raw_error = getattr(event, "error", None)
    if isinstance(raw_error, str) and raw_error.strip():
        return raw_error.strip()[:1000]
    return ""


def _codex_freezone_write_result_state(event: Any) -> str:
    """Keep cancellation, timeout, and pending approval separate from failure."""
    for value in (
        getattr(event, "structured", None),
        getattr(event, "output", None),
        {"tool_call_status": getattr(event, "status", None)},
    ):
        for payload in _json_objects_from_codex_tool_value(value):
            states = {
                str(payload.get(key) or "").lower()
                for key in ("canvas_apply_status", "tool_call_status", "status")
            }
            if states & {"cancelled", "canceled", "rejected"}:
                return "cancelled"
            if states & {"timeout", "timed_out", "expired"}:
                return "timeout"
            if states & {
                "pending",
                "awaiting_approval",
                "waiting_approval",
                "in_progress",
            }:
                return "waiting_approval"
    return "failed"


_GENERATION_RETRY_DATA_FIELDS = frozenset(
    {
        "model",
        "modelId",
        "aspectRatio",
        "size",
        "quality",
        "resolution",
        "duration",
        "durationSec",
        "durationSeconds",
        "generateAudio",
        "count",
        "variantsPerNode",
    }
)


def _codex_freezone_generation_retry_key(event: Any) -> str | None:
    """Match a rejected generation run to a receipt-backed retry of that run."""
    name = _codex_freezone_tool_name(event)
    if name not in {
        "freezone_emit_canvas_command",
        "freezone_run_node_action",
        "freezone_run_workflow",
        "freezone_confirm_workflow_draft",
    }:
        return None
    for payload in _json_objects_from_codex_tool_value(getattr(event, "input", None)):
        if name == "freezone_confirm_workflow_draft":
            draft_id = str(payload.get("draft_id") or "").strip()
            if not draft_id:
                continue
            # Patching generation choices raises the revision, but confirmation
            # still targets the same persisted draft and canvas.
            identity = [
                name,
                payload.get("project_id"),
                payload.get("canvas_id"),
                draft_id,
            ]
            return json.dumps(identity, sort_keys=True, ensure_ascii=False)
        if name == "freezone_run_node_action":
            node_id = str(payload.get("node_id") or "").strip()
            action = str(payload.get("action") or "").strip()
            if not node_id or action not in {"generate_image", "generate_video"}:
                continue
            parameters = payload.get("parameters") or payload.get("params") or {}
            if not isinstance(parameters, dict):
                continue
            parameters = {
                key: value
                for key, value in parameters.items()
                if key not in _GENERATION_RETRY_DATA_FIELDS
            }
            identity = [
                name,
                payload.get("project_id"),
                payload.get("canvas_id"),
                node_id,
                action,
                parameters,
                bool(payload.get("regenerate") or payload.get("force_regenerate")),
            ]
            return json.dumps(identity, sort_keys=True, ensure_ascii=False)
        if name == "freezone_run_workflow":
            node_ids = payload.get("node_ids") or []
            scope = str(payload.get("scope") or "").strip()
            if not isinstance(node_ids, list) or (not node_ids and scope != "canvas"):
                continue
            identity = [
                name,
                payload.get("project_id"),
                payload.get("canvas_id"),
                node_ids,
                scope,
                str(payload.get("direction") or "connected").strip(),
                bool(payload.get("regenerate") or payload.get("force_regenerate")),
            ]
            return json.dumps(identity, sort_keys=True, ensure_ascii=False)
        commands = payload.get("commands")
        if (
            not isinstance(commands, list)
            or not commands
            or not all(isinstance(command, dict) for command in commands)
        ):
            continue
        normalized = []
        for command in commands:
            item = dict(command)
            data = item.get("data")
            if isinstance(data, dict):
                item["data"] = {
                    key: value
                    for key, value in data.items()
                    if key not in _GENERATION_RETRY_DATA_FIELDS
                }
            elif data is None:
                item["data"] = {}
            normalized.append(item)
        return json.dumps(
            [payload.get("project_id"), payload.get("canvas_id"), normalized],
            sort_keys=True,
            ensure_ascii=False,
        )
    return None


def _codex_freezone_is_generation_preflight_rejection(event: Any) -> bool:
    """Only this explicit, side-effect-free rejection may be superseded."""
    if getattr(event, "error", None) or str(
        getattr(event, "status", "") or ""
    ).lower() not in {"completed", "success", "succeeded"}:
        return False
    for value in (getattr(event, "structured", None), getattr(event, "output", None)):
        for payload in _json_objects_from_codex_tool_value(value):
            if (
                payload.get("ok") is False
                and payload.get("status") == "clarification_required"
                and payload.get("code") == "generation_parameters_required"
            ):
                return True
    return False


def _codex_freezone_clarification_answered(event: Any) -> bool:
    """Recognize a successful answer, not merely a submitted or failed tool call."""
    if _codex_freezone_tool_name(event) != "freezone_request_user_clarification":
        return False
    if getattr(event, "error", None) or str(
        getattr(event, "status", "") or ""
    ).lower() not in {"completed", "success", "succeeded"}:
        return False
    for value in (getattr(event, "structured", None), getattr(event, "output", None)):
        for payload in _json_objects_from_codex_tool_value(value):
            if (
                payload.get("ok") is True
                and not payload.get("errors")
                and payload.get("clarification_status") == "answered"
            ):
                return True
    return False


_FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS = {
    "freezone_prepare_workflow_draft",
    "freezone_prepare_workflow_plan_draft",
}


def _codex_freezone_ready_workflow_draft(event: Any) -> dict[str, Any] | None:
    """Return a successfully prepared workflow draft carried by a Codex event."""

    if _codex_freezone_tool_name(event) not in _FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS:
        return None
    status = str(getattr(event, "status", "") or "").strip().lower()
    if status not in {"completed", "success", "succeeded"} or getattr(
        event, "error", None
    ):
        return None
    for value in (getattr(event, "structured", None), getattr(event, "output", None)):
        for payload in _json_objects_from_codex_tool_value(value):
            if (
                payload.get("ok") is True
                and str(payload.get("status") or "") == "workflow_draft_ready"
                and str(payload.get("draft_id") or "").strip()
            ):
                return payload
    return None

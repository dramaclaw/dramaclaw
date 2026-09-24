"""Normalize Freezone tool outcomes from Agent runtime events.

The chat application uses these pure checks to distinguish a durable canvas
write receipt from a successful transport call. Keep provider payload parsing
at this boundary while callers migrate to provider-neutral event names.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

from novelvideo.chat.tool_policy import (
    FREEZONE_CANVAS_WRITE_TOOLS as _FREEZONE_CANVAS_WRITE_TOOLS,
    FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS as _FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS,
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


# Fields that name what a write command acts on, as opposed to how. A call the
# MCP input schema rejected is matched to its corrected retry on these alone,
# because the correction itself (e.g. dropping an unsupported position) is
# exactly what differs between the two calls.
_ARGUMENT_RETRY_IDENTITY_FIELDS = (
    "type",
    "action",
    "client_id",
    "node_type",
    "node_id",
    "node_ids",
    "source_node_id",
    "source",
    "target",
    "edge_ids",
    "pairs",
    "mode",
    "scope",
    "direction",
    "project_id",
    "artifact_id",
    "draft_id",
    "approval_id",
    "asset_id",
    "asset_kind",
    "identity_id",
    "primary_slot",
    "character",
    # Flags that change what executes, not just how it looks.
    "connect",
    "regenerate",
    "force_regenerate",
)
# Integer targets: versions the user reviewed or asked to restore, and the
# mainline episode/beat. MCP validation rejects a numeric string, so "1" and
# its corrected retry 1 must compare equal.
_ARGUMENT_RETRY_INTEGER_FIELDS = (
    "revision",
    "version",
    "base_version",
    "episode",
    "beat",
)
# ASCII only: str.isdigit() also accepts characters such as "²" that int()
# rejects, and those must stay distinct rather than raise.
_ASCII_INTEGER = re.compile(r"-?[0-9]+", re.ASCII)
# Maps keyed by the node ids they act on; the keys are the target, the values
# (coordinates) are how.
_ARGUMENT_RETRY_KEYED_TARGET_FIELDS = ("positions", "deltas")


def _argument_retry_identity(command: dict[str, Any]) -> str:
    identity: dict[str, Any] = {
        key: command[key] for key in _ARGUMENT_RETRY_IDENTITY_FIELDS if key in command
    }
    for key in _ARGUMENT_RETRY_INTEGER_FIELDS:
        if key not in command:
            continue
        value = command[key]
        if isinstance(value, str) and _ASCII_INTEGER.fullmatch(value.strip()):
            try:
                value = int(value.strip())
            except ValueError:
                # Beyond the int conversion digit limit: keep it distinct.
                pass
        identity[key] = value
    for key in _ARGUMENT_RETRY_KEYED_TARGET_FIELDS:
        if key not in command:
            continue
        value = command[key]
        # A malformed map keeps its raw value, so only an identical call matches.
        identity[key] = sorted(value) if isinstance(value, dict) else value
    request = command.get("request")
    if isinstance(request, dict):
        # open_mainline_projection names its target inside the request.
        identity["request"] = json.loads(_argument_retry_identity(request))
    elif "request" in command:
        identity["request"] = request
    return json.dumps(identity, sort_keys=True, ensure_ascii=False)


def _codex_freezone_is_tool_argument_rejection(event: Any) -> bool:
    """A write the MCP input schema refused before its handler ever ran (#686)."""
    if _codex_freezone_tool_name(event) not in _FREEZONE_CANVAS_WRITE_TOOLS:
        return False
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
                return True
    return False


def _codex_freezone_argument_retry_scope(
    event: Any,
) -> tuple[str, Counter[str]] | None:
    """The target canvas and command identities of a write tool call.

    A schema-rejected call is superseded only by a successful call of the same
    tool on the same canvas that covers every command the rejected call named,
    counted with multiplicity, so a batch retried with a command silently
    dropped stays failed even when identical commands repeat.
    """
    name = _codex_freezone_tool_name(event)
    if name not in _FREEZONE_CANVAS_WRITE_TOOLS:
        return None
    payload = getattr(event, "input", None)
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return None
    if not isinstance(payload, dict):
        return None
    if name == "freezone_emit_canvas_command":
        commands = payload.get("commands")
        if (
            not isinstance(commands, list)
            or not commands
            or not all(isinstance(command, dict) for command in commands)
        ):
            return None
    else:
        commands = [payload]
    try:
        identities = Counter(_argument_retry_identity(command) for command in commands)
    except (TypeError, ValueError):
        # Unrepresentable arguments cannot be matched: a rejection stays failed
        # and a success supersedes nothing.
        return None
    scope = json.dumps(
        [name, payload.get("project_id"), payload.get("canvas_id")],
        sort_keys=True,
        ensure_ascii=False,
    )
    return scope, identities


# Workflow draft confirmation guard that rejects before any claim or dispatch.
# The plugin answers it from a single GET of the draft, and the only way forward
# is the agent's own patch of run_after_create in this turn, so a later
# confirmation of the same draft that reports the requested policy is the real
# outcome of that call (see _codex_freezone_execution_policy_requirement). A
# workflow_draft_revision_conflict is deliberately excluded: the new revision
# may hold changes the user never reviewed, so it needs a fresh confirmation
# rather than a silent retry.
_FREEZONE_DRAFT_CONFIRM_GUARD_STATUSES = frozenset(
    {"workflow_draft_execution_policy_changed"}
)


def _codex_freezone_is_generation_preflight_rejection(event: Any) -> bool:
    """Only explicit, side-effect-free rejections may be superseded by a retry."""
    if getattr(event, "error", None) or str(
        getattr(event, "status", "") or ""
    ).lower() not in {"completed", "success", "succeeded"}:
        return False
    for value in (getattr(event, "structured", None), getattr(event, "output", None)):
        for payload in _json_objects_from_codex_tool_value(value):
            if payload.get("ok") is not False:
                continue
            status = str(payload.get("status") or "")
            if (
                status == "clarification_required"
                and payload.get("code") == "generation_parameters_required"
            ):
                return True
            if (
                status in _FREEZONE_DRAFT_CONFIRM_GUARD_STATUSES
                and _codex_freezone_tool_name(event)
                == "freezone_confirm_workflow_draft"
            ):
                return True
    return False


def _codex_freezone_is_execution_policy_rejection(event: Any) -> bool:
    """A draft confirmation the plugin refused because run_after_create differed."""
    if _codex_freezone_tool_name(event) != "freezone_confirm_workflow_draft":
        return False
    for value in (getattr(event, "structured", None), getattr(event, "output", None)):
        for payload in _json_objects_from_codex_tool_value(value):
            if (
                payload.get("ok") is False
                and str(payload.get("status") or "")
                in _FREEZONE_DRAFT_CONFIRM_GUARD_STATUSES
            ):
                return True
    return False


def _codex_freezone_execution_policy_requirement(event: Any) -> bool | None:
    """The run_after_create the agent asked for in a policy-guard rejection.

    Only a boolean request can be honoured later. The rejection is superseded
    solely by a confirmation of the same draft whose receipt reports this same
    policy; a confirmation that silently kept the old policy (the agent skipped
    the patch and simply omitted run_after_create) leaves the rejection on
    record, because the user's request was not executed.
    """
    if not _codex_freezone_is_execution_policy_rejection(event):
        return None
    for payload in _json_objects_from_codex_tool_value(getattr(event, "input", None)):
        requested = payload.get("run_after_create")
        if isinstance(requested, bool):
            return requested
    return None


def _codex_freezone_confirmed_execution_policy(event: Any) -> bool | None:
    """The run_after_create a successful draft confirmation receipt reports."""
    if _codex_freezone_tool_name(event) != "freezone_confirm_workflow_draft":
        return None
    for value in (getattr(event, "structured", None), getattr(event, "output", None)):
        for payload in _json_objects_from_codex_tool_value(value):
            if payload.get("ok") is True and isinstance(
                payload.get("run_after_create"), bool
            ):
                return payload["run_after_create"]
    return None


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

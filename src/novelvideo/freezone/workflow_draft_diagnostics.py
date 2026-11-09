"""Bounded, content-free observations of workflow draft preparation.

Only allowlisted codes and field names leave this module. Prompts, raw errors,
user-defined node IDs, credentials and complete request payloads are excluded.
Observations never decide whether a workflow may run or retry.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import Any

from novelvideo.chat import evidence_metrics

logger = logging.getLogger(__name__)

PREPARATION_TOOLS = {
    "freezone_prepare_workflow": "prepare",
    "freezone_prepare_workflow_draft": "intent",
    "freezone_prepare_workflow_plan_draft": "plan",
}
_CODES = frozenset(
    {
        "workflow_intent_required",
        "workflow_intent_object_required",
        "wrong_workflow_draft_tool",
        "workflow_source_required",
        "invalid_workflow_intent",
        "invalid_dynamic_workflow_plan",
        "compiled_workflow_plan_invalid",
        "workflow_result_admission_required",
        "workflow_result_operation_unavailable",
        "workflow_result_operation_mismatch",
        "workflow_result_skill_identity_required",
        "workflow_result_skill_identity_mismatch",
        "workflow_preflight_failed",
        "generation_parameters_required",
        "generation_mode_clarification_required",
        "video_model_clarification_required",
        "model_capability_unsupported",
        "model_unavailable",
        "model_catalog_unavailable",
        "recommended_model_unavailable",
        "recommended_parameters_unavailable",
        "skill_stage_missing",
        "skill_stage_unused",
        "no_compatible_video_model",
        "workflow_draft_scope_required",
        "workflow_draft_unavailable",
        "BILLING_RULE_NOT_CONFIGURED",
        "INSUFFICIENT_CREDITS",
        "FEATURE_BILLING_IDENTITY_INVALID",
    }
)
_CLARIFICATIONS = frozenset(
    {
        "generation_parameters_required",
        "generation_mode_clarification_required",
        "video_model_clarification_required",
    }
)
_PATH_FIELDS = frozenset(
    {
        "intent",
        "plan",
        "inputs",
        "planner",
        "items",
        "nodes",
        "edges",
        "runtime",
        "models",
        "schema_version",
        "skill_id",
        "skill",
        "version",
        "id",
        "data",
        "node_type",
        "model",
        "image_model",
        "video_model",
        "image_quality",
        "image_resolution",
        "video_resolution",
        "aspect_ratio",
        "image_aspect_ratio",
        "video_aspect_ratio",
        "aspectRatio",
        "size",
        "quality",
        "resolution",
        "durationSec",
        "duration_seconds",
        "video_duration_seconds",
        "generateAudio",
        "video_generate_audio",
        "video_generation_mode",
        "genMode",
        "include_compose",
        "include_audio",
        "mode",
        "deliverable",
        "item_count",
        "units",
        "total_duration_seconds",
        "recipe_id",
        "recipeId",
        "workflowCatalog",
        "depends_on",
        "reference_inputs",
        "narration",
        "audio_kind",
        "source",
        "target",
        "link_type",
        "stage",
        "source_context",
        "external_inputs",
        "run_after_create",
        "operation_id",
        "bindings",
        "targets",
        "asset_targets",
    }
)


def _safe_path(value: Any) -> str:
    if not isinstance(value, str):
        return "other"
    # A path can embed arbitrary user-authored node IDs; never log them verbatim.
    parts = re.split(r"[.\[\]/]+", value[:512])
    return (
        ".".join(
            "[]" if part.isdecimal() else part if part in _PATH_FIELDS else "*"
            for part in parts[:8]
            if part
        )
        or "other"
    )


def observe_preparation(
    tool_name: str,
    arguments: dict[str, Any],
    result: dict[str, Any] | None,
    *,
    elapsed_ms: int,
    raised: bool = False,
) -> None:
    """Count one invocation and emit redacted diagnostics, failing open on I/O errors."""
    try:
        kind = PREPARATION_TOOLS.get(tool_name)
        if kind is None:
            return
        payload = result if isinstance(result, dict) else {}
        records = [payload]
        for key in ("detail", "data", "preflight"):
            nested = payload.get(key)
            if isinstance(nested, dict):
                records.append(nested)
        errors = [
            error
            for record in records
            for key in ("errors", "blockers")
            for error in (record.get(key) if isinstance(record.get(key), list) else [])[
                :16
            ]
            if isinstance(error, dict)
        ]
        codes = sorted(
            {
                value
                for record in [*records, *errors]
                for key in ("code", "status")
                if isinstance(value := record.get(key), str) and value in _CODES
            }
        )[:8]
        paths = sorted({_safe_path(error.get("path")) for error in errors})[:8]
        if raised:
            outcome = "exception"
        elif any(code in _CLARIFICATIONS for code in codes):
            outcome = "clarification"
        elif payload.get("ok") is False:
            outcome = "rejected"
        elif payload.get("ok") is True:
            outcome = "success"
        else:
            outcome = "unknown"
        elapsed_ms = max(0, min(int(elapsed_ms), 86_400_000))
        bucket = next(
            (limit for limit in (100, 1000, 10000) if elapsed_ms <= limit), "slow"
        )
        prefix = f"workflow_draft.{kind}"
        counters = [
            f"{prefix}.calls",
            f"{prefix}.outcome.{outcome}",
            f"{prefix}.latency.{bucket}",
            *(
                f"{prefix}.code.{code}"
                for code in codes or (["other"] if outcome == "rejected" else [])
            ),
            *(f"{prefix}.path.{path}" for path in paths),
        ]
        operation = arguments.get("operation_id")
        operation_hash = (
            hashlib.sha256(operation.encode()).hexdigest()[:16]
            if isinstance(operation, str)
            and re.fullmatch(r"agent_product_[0-9a-f]{32}", operation)
            else "unavailable"
        )
        logger.info(
            "workflow_draft.prepare tool=%s outcome=%s codes=%s paths=%s "
            "elapsed_ms=%d operation_hash=%s",
            kind,
            outcome,
            codes,
            paths,
            elapsed_ms,
            operation_hash,
        )
        evidence_metrics.observe_batch(counters)
    except Exception:
        # Storage/logging outages must not change a tool's result or exception.
        return

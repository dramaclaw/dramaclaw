"""Shared deterministic runtime checks; transports supply authenticated live catalogs."""

from copy import deepcopy
from typing import Any
import math

_RECOMMENDED_GENERATION_MODEL_VALUES = {
    "auto",
    "default",
    "recommend",
    "recommended",
    "推荐",
    "推荐模型",
    "默认",
    "自动",
}


def _catalog_string_options(entry: dict[str, Any], key: str) -> list[str]:
    values = entry.get(key)
    if not isinstance(values, list):
        return []
    return [str(value).strip() for value in values if str(value).strip()]


def _catalog_option_supported(
    value: Any,
    options: list[str],
    *,
    case_insensitive: bool = False,
) -> bool:
    requested = str(value or "").strip()
    if not requested:
        return True
    if case_insensitive:
        requested = requested.casefold()
        return any(requested == option.casefold() for option in options)
    return requested in options


def workflow_parameter_type_blockers(node: dict[str, Any]) -> list[dict[str, Any]]:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    node_id = str(node.get("id") or node.get("node_type") or "")
    invalid_fields = []
    for field in ("model", "aspectRatio", "size", "quality"):
        if (
            field in data
            and data[field] is not None
            and not isinstance(data[field], str)
        ):
            invalid_fields.append(field)
    if "count" in data and (
        type(data["count"]) is not int or data["count"] not in (1, 2, 4)
    ):
        invalid_fields.append("count")
    if "generateAudio" in data and not isinstance(data["generateAudio"], bool):
        invalid_fields.append("generateAudio")
    duration_value = data.get("durationSec")
    invalid_duration = "durationSec" in data and (
        isinstance(duration_value, bool)
        or not isinstance(duration_value, (int, float))
        or duration_value <= 0
        or duration_value > 86400
        or not math.isfinite(duration_value)
    )
    if invalid_duration:
        invalid_fields.append("durationSec")
    return list(
        {
            "path": f"runtime.models.{node_id}.{field}",
            "message": f"invalid generation parameter: {field}",
            "code": "generation_parameter_invalid",
        }
        for field in invalid_fields
    )


def _workflow_node_capability_blockers(
    node: dict[str, Any],
    catalog_entry: dict[str, Any],
) -> list[dict[str, Any]]:
    node_type = str(node.get("node_type") or "").strip()
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    node_id = str(node.get("id") or node_type).strip()
    model_id = str(data.get("model") or "").strip()
    field_options = (
        {
            "aspectRatio": ("ratioOptions", False),
            "size": ("resolutionOptions", True),
            "quality": ("qualityOptions", True),
        }
        if node_type == "imageGenNode"
        else (
            {
                "aspectRatio": ("ratioOptions", False),
                "quality": ("resolutionOptions", True),
            }
            if node_type == "videoNode"
            else {}
        )
    )
    blockers: list[dict[str, Any]] = []
    for field, (catalog_key, case_insensitive) in field_options.items():
        value = data.get(field)
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        options = _catalog_string_options(catalog_entry, catalog_key)
        if not options:
            # Missing ratio/resolution declarations use the canvas fallback. Quality
            # deliberately has no fallback: an absent qualityOptions means the model
            # does not accept the quality parameter.
            if catalog_key != "qualityOptions":
                continue
        if _catalog_option_supported(
            value,
            options,
            case_insensitive=case_insensitive,
        ):
            continue
        blockers.append(
            {
                "path": f"runtime.models.{node_id}.{field}",
                "message": (
                    f"{field} value {value!r} is not supported by model {model_id}. "
                    + (
                        f"Supported values: {options!r}."
                        if options
                        else "This model does not accept this parameter; omit it."
                    )
                ),
                "code": "model_capability_unsupported",
                "allowed_values": options,
                "recovery": "choose_supported_value" if options else "omit_parameter",
            }
        )
    type_blockers = workflow_parameter_type_blockers(node)
    blockers.extend(type_blockers)
    duration_value = data.get("durationSec")
    invalid_duration = any(
        item["path"].endswith(".durationSec") for item in type_blockers
    )
    if (
        node_type == "videoNode"
        and not invalid_duration
        and isinstance(duration_value, (int, float))
    ):
        duration = float(data["durationSec"])
        minimum = catalog_entry.get("minDuration")
        maximum = catalog_entry.get("maxDuration")
        if (
            isinstance(minimum, (int, float))
            and duration < float(minimum)
            or isinstance(maximum, (int, float))
            and duration > float(maximum)
        ):
            blockers.append(
                {
                    "path": f"runtime.models.{node_id}.durationSec",
                    "message": (
                        f"durationSec value {data['durationSec']!r} is not supported "
                        f"by model {model_id}"
                        f"; supported duration range: {minimum!r} to {maximum!r} seconds"
                    ),
                    "code": "model_capability_unsupported",
                    "minimum": minimum,
                    "maximum": maximum,
                }
            )
    if (
        node_type == "videoNode"
        and data.get("generateAudio") is True
        and catalog_entry.get("supportsGenerateAudio") is False
    ):
        blockers.append(
            {
                "path": f"runtime.models.{node_id}.generateAudio",
                "message": f"generateAudio is not supported by model {model_id}",
                "code": "model_capability_unsupported",
            }
        )
    return blockers


def evaluate_workflow_preflight(
    compiled: dict[str, Any],
    *,
    model_responses: dict[str, dict[str, Any]],
    limits: dict[str, Any],
    runtime_available: bool = True,
) -> dict[str, Any]:
    base = deepcopy(compiled.get("preflight") or {})
    blockers = list(base.get("blockers") or [])
    warnings = list(base.get("warnings") or [])
    checks: dict[str, Any] = {}
    plan = compiled.get("plan") if isinstance(compiled.get("plan"), dict) else {}
    nodes = plan.get("nodes") if isinstance(plan.get("nodes"), list) else []
    for node in nodes:
        if (
            isinstance(node, dict)
            and node.get("node_type") in {"imageGenNode", "videoNode"}
            and not (node.get("data") or {}).get("model")
        ):
            blockers.extend(workflow_parameter_type_blockers(node))
    if not runtime_available:
        checks["runtime"] = "unavailable"
        warnings.append(
            {
                "path": "runtime",
                "message": "runtime model and queue availability could not be checked",
            }
        )
    else:
        for node_type in ("imageGenNode", "videoNode"):
            typed_nodes = [
                node
                for node in nodes
                if isinstance(node, dict)
                and node.get("node_type") == node_type
                and isinstance(node.get("data"), dict)
                and str((node.get("data") or {}).get("model") or "").strip()
            ]
            requested = {
                str((node.get("data") or {}).get("model") or "").strip()
                for node in typed_nodes
            }
            if not requested:
                continue
            response = model_responses.get(node_type, {"ok": False})
            if response.get("ok") is False:
                checks[f"{node_type}.models"] = "unavailable"
                blockers.append(
                    {
                        "path": "runtime.models",
                        "message": (
                            f"could not verify {node_type} capabilities because the "
                            "live model catalog is unavailable"
                        ),
                        "code": "model_catalog_unavailable",
                    }
                )
                continue
            raw_models = response.get("data")
            catalog_by_id = (
                {
                    str(
                        item.get("id")
                        or item.get("apiModel")
                        or item.get("api_model")
                        or ""
                    ).strip(): item
                    for item in raw_models
                    if isinstance(item, dict)
                    and str(
                        item.get("id")
                        or item.get("apiModel")
                        or item.get("api_model")
                        or ""
                    ).strip()
                }
                if isinstance(raw_models, list)
                else {}
            )
            missing = sorted(requested - set(catalog_by_id))
            checks[f"{node_type}.models"] = {
                "requested": sorted(requested),
                "available": not missing,
            }
            blockers.extend(
                {
                    "path": "runtime.models",
                    "message": (
                        f"{model!r} is a model preference, not a catalog id. "
                        "Select a concrete model from available_models matching the user's "
                        "parameters; do not assume the first model is cheapest."
                        if model.casefold() in _RECOMMENDED_GENERATION_MODEL_VALUES
                        else f"configured model is unavailable: {model}"
                    ),
                    "code": (
                        "model_selection_required"
                        if model.casefold() in _RECOMMENDED_GENERATION_MODEL_VALUES
                        else "model_unavailable"
                    ),
                    "available_models": [
                        {
                            "id": model_id,
                            **{
                                key: entry[key]
                                for key in (
                                    "ratioOptions",
                                    "resolutionOptions",
                                    "qualityOptions",
                                    "minDuration",
                                    "maxDuration",
                                    "supportsGenerateAudio",
                                )
                                if key in entry
                            },
                        }
                        for model_id, entry in catalog_by_id.items()
                    ],
                }
                for model in missing
            )
            for node in typed_nodes:
                model = str((node.get("data") or {}).get("model") or "").strip()
                catalog_entry = catalog_by_id.get(model)
                if catalog_entry is not None:
                    blockers.extend(
                        _workflow_node_capability_blockers(node, catalog_entry)
                    )
        lane_demand = {
            "default": sum(
                1
                for node in nodes
                if isinstance(node, dict)
                and (
                    node.get("node_type") in {"imageGenNode", "audioNode"}
                    or (
                        node.get("node_type")
                        in {"textAnnotationNode", "scriptNode", "beatContextNode"}
                        and isinstance(
                            (node.get("data") or {}).get("workflowCatalog"), dict
                        )
                        and str(
                            ((node.get("data") or {}).get("workflowCatalog") or {}).get(
                                "recipeId"
                            )
                            or ""
                        ).strip()
                    )
                )
            ),
            "video": sum(
                1
                for node in nodes
                if isinstance(node, dict) and node.get("node_type") == "videoNode"
            ),
            "ffmpeg": sum(
                1
                for node in nodes
                if isinstance(node, dict)
                and node.get("node_type") == "videoComposeNode"
            ),
        }
        if limits.get("ok") is False or not isinstance(limits.get("data"), dict):
            checks["queue_capacity"] = "unavailable"
            warnings.append(
                {
                    "path": "runtime.queue_capacity",
                    "message": "task queue capacity could not be checked",
                }
            )
        else:
            capacity = limits["data"]
            checks["queue_capacity"] = capacity
            for lane, demand in lane_demand.items():
                if demand <= 0:
                    continue
                lane_state = capacity.get(lane)
                if not isinstance(lane_state, dict):
                    continue
                limit = lane_state.get("limit")
                remaining = lane_state.get("remaining")
                if isinstance(limit, int) and limit <= 0:
                    blockers.append(
                        {
                            "path": f"runtime.queue_capacity.{lane}",
                            "message": f"{lane} generation queue is disabled",
                            "code": "queue_disabled",
                        }
                    )
                elif isinstance(remaining, int) and remaining <= 0:
                    warnings.append(
                        {
                            "path": f"runtime.queue_capacity.{lane}",
                            "message": f"{lane} generation queue is currently full; tasks will wait",
                        }
                    )
    return {
        **base,
        "status": "blocked" if blockers else "ready",
        "blockers": blockers,
        "warnings": warnings,
        "runtime_checks": checks,
    }

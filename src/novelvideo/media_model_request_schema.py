"""Validated declarative parameter mapping for NewAPI media requests."""

from __future__ import annotations

import copy
import math
import re
from typing import Any

KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
PATH_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$")
CONTROL_TYPES = {"select", "number", "switch", "text", "multiselect"}
JS_MAX_SAFE_INTEGER = 2**53 - 1
MAX_MEDIA_IMAGE_PIXELS = 16_777_216
BLOCKED_ROOTS = {
    "model",
    "prompt",
    "authorization",
    "headers",
    "api_key",
    "base_url",
    "url",
}
MODE_ALIASES = {
    "textToVideo": "text_to_video",
    "firstFrame": "first_frame",
    # 画布「图生视频」是单张图片参考：图片影响整体画面，但不锁定第一帧。
    # 真正的首帧模式由首尾帧入口按槽位派生为 first_frame。
    "imageToVideo": "image_to_video",
    "firstLastFrame": "first_last_frame",
    "imageReference": "image_reference",
    "allReference": "all_reference",
    "videoEdit": "video_edit",
}
MEDIA_MODEL_MODES = {
    "text_to_video",
    "first_frame",
    "first_last_frame",
    "image_to_video",
    "image_reference",
    "all_reference",
    "video_edit",
}
PARAMETER_MODES = MEDIA_MODEL_MODES | {
    "text_to_image",
    "image_to_image",
}
STRING_LIST_CONFIG_FIELDS = {
    "resolutionOptions",
    "ratioOptions",
    "qualityOptions",
    "sceneOptimizeOptions",
    "referenceFileTypes",
}
RESERVED_CATALOG_CONFIG_FIELDS = {
    "id",
    "media_type",
    "provider",
    "providerId",
    "provider_id",
    "apiModel",
    "api_model",
    "gatewayModel",
    "gateway_model",
    "label",
}


class MediaModelSchemaError(ValueError):
    pass


def normalize_media_resolution_value(value: object) -> str:
    """Normalize named resolution tiers without rewriting explicit pixel sizes."""

    clean = str(value or "").strip()
    lowered = clean.lower()
    if re.fullmatch(r"(?:\d+(?:\.\d+)?k|\d{3,4}p)", lowered):
        return lowered
    return clean


def normalize_media_model_catalog_config(config: object) -> dict[str, Any]:
    """Return a storage-safe catalog config with canonical public option values."""

    if not isinstance(config, dict):
        raise MediaModelSchemaError("media model config must be an object")
    normalized = copy.deepcopy(config)
    # Briefly introduced during development, then removed when native-audio
    # defaults were fixed by product policy (supported => on by default).
    # Drop it on save/import so previewed local configs do not retain dead data.
    normalized.pop("defaultGenerateAudio", None)
    resolutions = normalized.get("resolutionOptions")
    if isinstance(resolutions, list):
        seen: set[str] = set()
        canonical: list[object] = []
        for item in resolutions:
            value = normalize_media_resolution_value(item) if isinstance(item, str) else item
            identity = f"{type(value).__name__}:{value!s}"
            if identity in seen:
                continue
            seen.add(identity)
            canonical.append(value)
        normalized["resolutionOptions"] = canonical
    ratios = normalized.get("ratioOptions")
    if isinstance(ratios, list):
        seen_ratios: set[str] = set()
        canonical_ratios: list[object] = []
        for item in ratios:
            value: object = item
            if isinstance(item, str):
                clean = item.strip()
                value = "auto" if clean.lower() in {"auto", "adaptive"} else clean
            identity = f"{type(value).__name__}:{value!s}"
            if identity in seen_ratios:
                continue
            seen_ratios.add(identity)
            canonical_ratios.append(value)
        normalized["ratioOptions"] = canonical_ratios
    file_types = normalized.get("referenceFileTypes")
    if isinstance(file_types, list):
        normalized["referenceFileTypes"] = list(
            dict.fromkeys(
                str(item or "").strip().lower().lstrip(".")
                for item in file_types
                if str(item or "").strip().lstrip(".")
            )
        )
    return normalized


def normalize_media_model_mode(mode: str | None) -> str:
    """Normalize canvas business mode names to media catalog mode names."""
    raw_mode = str(mode or "")
    return MODE_ALIASES.get(raw_mode, raw_mode)


def enforce_newapi_media_geometry_contract(
    payload: dict[str, Any], *, media_type: str
) -> dict[str, Any]:
    """Enforce the final mutually exclusive NewAPI geometry representation.

    Fixed geometry keeps its semantic ratio and derived width/height together.
    Follow-input geometry is expressed by a canonical ratio value without
    dimensions. Resolution remains independent in metadata for both forms.
    """

    result = copy.deepcopy(payload)
    raw_metadata = result.get("metadata")
    metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
    resolution = normalize_media_resolution_value(
        metadata.get("resolution") or result.pop("resolution", None)
    )
    if resolution:
        metadata["resolution"] = resolution

    ratio = str(
        metadata.get("ratio")
        or metadata.get("aspect_ratio")
        or result.get("ratio")
        or result.get("aspect_ratio")
        or ""
    ).strip().lower()
    result.pop("ratio", None)
    result.pop("aspect_ratio", None)
    # ``size`` is a retired merged geometry alias. Public NewAPI requests use
    # numeric width/height for fixed geometry and omit all dimensions for auto.
    result.pop("size", None)
    if ratio in {"auto", "adaptive"}:
        metadata["ratio"] = "auto"
        metadata.pop("aspect_ratio", None)
        result.pop("width", None)
        result.pop("height", None)
    else:
        if ratio:
            metadata["ratio"] = ratio
        metadata.pop("aspect_ratio", None)

    if metadata:
        result["metadata"] = metadata
    else:
        result.pop("metadata", None)
    return result


def enforce_newapi_video_duration_contract(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize the final generic NewAPI duration without provider aliases."""

    result = copy.deepcopy(payload)
    raw_duration = result.get("duration", result.get("seconds"))
    result.pop("seconds", None)
    if str(raw_duration or "").strip().lower() == "auto":
        result["duration"] = "auto"
        return result
    try:
        duration = float(str(raw_duration))
    except (TypeError, ValueError):
        result.pop("duration", None)
        return result
    if duration <= 0:
        result.pop("duration", None)
        return result
    result["duration"] = int(duration) if duration.is_integer() else duration
    return result


def enforce_newapi_video_mode_contract(
    payload: dict[str, Any],
    *,
    mode: str | None,
    fixed_duration: int | float | None = None,
) -> dict[str, Any]:
    """Apply product-level invariants that model parameters may not override."""

    result = copy.deepcopy(payload)
    if normalize_media_model_mode(mode) != "video_edit":
        if (
            str(result.get("duration") or result.get("seconds") or "")
            .strip()
            .lower()
            == "auto"
            and fixed_duration is not None
        ):
            result["duration"] = fixed_duration
            result.pop("seconds", None)
        return result

    raw_metadata = result.get("metadata")
    metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
    metadata["ratio"] = "auto"
    metadata.pop("aspect_ratio", None)
    result["metadata"] = metadata
    result["duration"] = "auto"
    for key in ("seconds", "ratio", "aspect_ratio", "size", "width", "height"):
        result.pop(key, None)
    return result


def _validate_js_number(value: int | float, field: str) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise MediaModelSchemaError(f"{field} must be finite")
    if abs(value) > JS_MAX_SAFE_INTEGER:
        raise MediaModelSchemaError(f"{field} exceeds JavaScript safe numeric range")


def _option_identity(value: str | int | float | bool) -> str:
    if isinstance(value, bool):
        return f"boolean:{str(value).lower()}"
    if isinstance(value, str):
        return f"string:{value}"
    _validate_js_number(value, "options")
    if isinstance(value, float) and value.is_integer():
        return f"number:{int(value)}"
    return f"number:{value!r}"


def _validate_parameter_value(
    definition: dict[str, Any],
    value: Any,
    key: str,
) -> None:
    control = definition["control"]
    if control == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise MediaModelSchemaError(f"parameter must be numeric: {key}")
        _validate_js_number(value, f"parameter {key}")
        minimum = definition.get("min")
        maximum = definition.get("max")
        if minimum is not None and value < minimum:
            raise MediaModelSchemaError(f"parameter is below minimum: {key}")
        if maximum is not None and value > maximum:
            raise MediaModelSchemaError(f"parameter exceeds maximum: {key}")
    elif control == "switch":
        if not isinstance(value, bool):
            raise MediaModelSchemaError(f"parameter must be boolean: {key}")
    elif control == "multiselect":
        if not isinstance(value, list):
            raise MediaModelSchemaError(f"parameter must be a list: {key}")
    elif control == "select" and not isinstance(value, (str, int, float, bool)):
        raise MediaModelSchemaError(f"parameter has invalid type: {key}")
    elif control == "text" and not isinstance(value, str):
        raise MediaModelSchemaError(f"parameter must be text: {key}")
    options = definition.get("options") or []
    if options:
        candidates = value if isinstance(value, list) else [value]
        option_identities = {_option_identity(option) for option in options}
        if any(
            not isinstance(candidate, (str, int, float, bool))
            or _option_identity(candidate) not in option_identities
            for candidate in candidates
        ):
            raise MediaModelSchemaError(f"parameter has unsupported value: {key}")


def validate_media_request_schema(schema: object) -> dict[str, Any]:
    if schema in (None, {}):
        return {}
    if not isinstance(schema, dict):
        raise MediaModelSchemaError("request schema must be an object")
    endpoint = str(schema.get("endpoint") or "").strip()
    if endpoint not in {"images/generations", "video/generations", "audio/speech"}:
        raise MediaModelSchemaError("unsupported NewAPI media endpoint")
    parameters = schema.get("parameters") or []
    if not isinstance(parameters, list) or len(parameters) > 32:
        raise MediaModelSchemaError("parameters must be a list with at most 32 items")
    seen: set[str] = set()
    for item in parameters:
        if not isinstance(item, dict):
            raise MediaModelSchemaError("parameter definition must be an object")
        key = str(item.get("key") or "")
        path = str(item.get("requestPath") or "")
        control = str(item.get("control") or "")
        if not KEY_RE.fullmatch(key) or key in seen:
            raise MediaModelSchemaError(f"invalid or duplicate parameter key: {key}")
        if (
            not PATH_RE.fullmatch(path)
            or path.split(".", 1)[0].lower() in BLOCKED_ROOTS
        ):
            raise MediaModelSchemaError(f"unsafe request path: {path}")
        if control not in CONTROL_TYPES:
            raise MediaModelSchemaError(f"unsupported control type: {control}")
        required = item.get("required")
        if required is not None and not isinstance(required, bool):
            raise MediaModelSchemaError(f"invalid required flag for {key}")
        label = item.get("label")
        if label is not None and (not isinstance(label, str) or len(label) > 64):
            raise MediaModelSchemaError(f"invalid label for {key}")
        options = item.get("options")
        if options is not None and (
            not isinstance(options, list)
            or len(options) > 64
            or any(not isinstance(value, (str, int, float, bool)) for value in options)
        ):
            raise MediaModelSchemaError(f"invalid options for {key}")
        if options is not None:
            option_identities = [_option_identity(value) for value in options]
            if len(set(option_identities)) != len(option_identities):
                raise MediaModelSchemaError(f"duplicate options for {key}")
        if control in {"select", "multiselect"} and not options:
            raise MediaModelSchemaError(f"options are required for {key}")
        modes = item.get("modes")
        if modes is not None and (
            not isinstance(modes, list)
            or len(modes) > 16
            or any(not isinstance(mode, str) or mode not in PARAMETER_MODES for mode in modes)
            or len(set(modes)) != len(modes)
        ):
            raise MediaModelSchemaError(f"invalid or duplicate modes for {key}")
        for bound in ("min", "max", "step"):
            if bound in item and (
                isinstance(item[bound], bool)
                or not isinstance(item[bound], (int, float))
            ):
                raise MediaModelSchemaError(f"invalid {bound} for {key}")
            if bound in item:
                _validate_js_number(item[bound], f"{bound} for {key}")
        minimum = item.get("min")
        maximum = item.get("max")
        step = item.get("step")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise MediaModelSchemaError(f"min exceeds max for {key}")
        if step is not None and step <= 0:
            raise MediaModelSchemaError(f"step must be positive for {key}")
        if "default" in item and item["default"] not in (None, ""):
            _validate_parameter_value(item, item["default"], key)
        seen.add(key)
    omit_paths = schema.get("omitPaths") or []
    if not isinstance(omit_paths, list) or len(omit_paths) > 32:
        raise MediaModelSchemaError("omitPaths must be a list with at most 32 items")
    for path in omit_paths:
        if (
            not isinstance(path, str)
            or not PATH_RE.fullmatch(path)
            or path.split(".", 1)[0].lower() in BLOCKED_ROOTS
        ):
            raise MediaModelSchemaError(f"invalid omit path: {path}")
    return schema


def validate_media_model_catalog_config(
    config: object,
    media_type: str,
) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise MediaModelSchemaError("media model config must be an object")
    if media_type not in {"image", "video"}:
        raise MediaModelSchemaError("media type must be image or video")
    reserved_fields = sorted(RESERVED_CATALOG_CONFIG_FIELDS.intersection(config))
    if reserved_fields:
        raise MediaModelSchemaError(
            "media model config contains reserved fields: " + ", ".join(reserved_fields)
        )
    request_schema = validate_media_request_schema(config.get("request"))
    expected_endpoint = (
        "images/generations" if media_type == "image" else "video/generations"
    )
    if request_schema and request_schema.get("endpoint") != expected_endpoint:
        raise MediaModelSchemaError(
            f"{media_type} model request endpoint must be {expected_endpoint}"
        )

    incompatible_fields = (
        {
            "minDuration",
            "maxDuration",
            "supportedModes",
            "referenceVideoMax",
            "referenceAudioMax",
            "referenceFileMax",
            "referenceLinkMax",
            "referenceFileTypes",
            "referenceAudioMinSeconds",
            "referenceAudioMaxSeconds",
            "referenceAudioTotalMinSeconds",
            "referenceAudioTotalMaxSeconds",
            "referenceVideoMinSeconds",
            "referenceVideoMaxSeconds",
            "referenceVideoTotalMinSeconds",
            "referenceVideoTotalMaxSeconds",
            "humanReview",
            "supportsGenerateAudio",
            "sceneOptimizeOptions",
            "defaultSceneOptimize",
        }
        if media_type == "image"
        else {"qualityOptions", "minPixels"}
    )
    configured_incompatible = sorted(
        field for field in incompatible_fields if config.get(field) is not None
    )
    if configured_incompatible:
        raise MediaModelSchemaError(
            f"{media_type} model config contains incompatible fields: "
            + ", ".join(configured_incompatible)
        )

    for field in STRING_LIST_CONFIG_FIELDS:
        value = config.get(field)
        if value is None:
            continue
        if (
            not isinstance(value, list)
            or len(value) > 64
            or any(not isinstance(item, str) or not item.strip() for item in value)
            or len(set(value)) != len(value)
        ):
            raise MediaModelSchemaError(f"{field} must contain unique non-empty strings")

    modes = config.get("supportedModes")
    if modes is not None and (
        not isinstance(modes, list)
        or any(not isinstance(mode, str) for mode in modes)
        or any(mode not in MEDIA_MODEL_MODES for mode in modes)
        or len(set(modes)) != len(modes)
    ):
        raise MediaModelSchemaError("supportedModes contains an invalid or duplicate mode")

    for field in ("minDuration", "maxDuration"):
        value = config.get(field)
        if value is not None and (type(value) is not int or value <= 0):
            raise MediaModelSchemaError(f"{field} must be a positive integer")
    minimum = config.get("minDuration")
    maximum = config.get("maxDuration")
    if minimum is not None and maximum is not None and minimum > maximum:
        raise MediaModelSchemaError("minDuration cannot exceed maxDuration")

    for field in (
        "referenceImageMax",
        "referenceVideoMax",
        "referenceAudioMax",
        "referenceFileMax",
        "referenceLinkMax",
    ):
        value = config.get(field)
        if value is not None and (type(value) is not int or value < 0):
            raise MediaModelSchemaError(f"{field} must be a non-negative integer")
    for field in ("referenceFileMax", "referenceLinkMax"):
        value = config.get(field)
        if type(value) is int and value > 1:
            raise MediaModelSchemaError(f"{field} cannot exceed 1")

    reference_file_types = config.get("referenceFileTypes")
    if reference_file_types is not None and any(
        not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,15}", item)
        for item in reference_file_types
    ):
        raise MediaModelSchemaError(
            "referenceFileTypes must use lowercase extensions without dots"
        )

    duration_fields = (
        "referenceAudioMinSeconds",
        "referenceAudioMaxSeconds",
        "referenceAudioTotalMinSeconds",
        "referenceAudioTotalMaxSeconds",
        "referenceVideoMinSeconds",
        "referenceVideoMaxSeconds",
        "referenceVideoTotalMinSeconds",
        "referenceVideoTotalMaxSeconds",
    )
    for field in duration_fields:
        value = config.get(field)
        if value is not None and (
            type(value) not in (int, float)
            or not math.isfinite(value)
            or value <= 0
        ):
            raise MediaModelSchemaError(f"{field} must be a positive finite number")

    for minimum_field, maximum_field in (
        ("referenceAudioMinSeconds", "referenceAudioMaxSeconds"),
        ("referenceAudioTotalMinSeconds", "referenceAudioTotalMaxSeconds"),
        ("referenceVideoMinSeconds", "referenceVideoMaxSeconds"),
        ("referenceVideoTotalMinSeconds", "referenceVideoTotalMaxSeconds"),
    ):
        minimum_value = config.get(minimum_field)
        maximum_value = config.get(maximum_field)
        if (
            minimum_value is not None
            and maximum_value is not None
            and minimum_value > maximum_value
        ):
            raise MediaModelSchemaError(f"{minimum_field} cannot exceed {maximum_field}")

    if media_type == "video":
        video_limit = config.get("referenceVideoMax")
        configured_modes = set(modes or [])
        if (
            type(video_limit) is int
            and video_limit > 0
            and not configured_modes.intersection({"all_reference", "video_edit"})
        ):
            raise MediaModelSchemaError(
                "referenceVideoMax requires all_reference or video_edit mode"
            )
        for field in ("referenceFileMax", "referenceLinkMax"):
            limit = config.get(field)
            if type(limit) is int and limit > 0 and "all_reference" not in configured_modes:
                raise MediaModelSchemaError(f"{field} requires all_reference mode")
        if reference_file_types and not (
            type(config.get("referenceFileMax")) is int
            and config["referenceFileMax"] > 0
        ):
            raise MediaModelSchemaError(
                "referenceFileTypes requires a positive referenceFileMax"
            )

    min_pixels = config.get("minPixels")
    if min_pixels is not None and (
        type(min_pixels) is not int
        or min_pixels <= 0
        or min_pixels > MAX_MEDIA_IMAGE_PIXELS
    ):
        raise MediaModelSchemaError(
            f"minPixels must be between 1 and {MAX_MEDIA_IMAGE_PIXELS}"
        )

    human_review = config.get("humanReview")
    if human_review is not None and not isinstance(human_review, bool):
        raise MediaModelSchemaError("humanReview must be boolean")

    supports_generate_audio = config.get("supportsGenerateAudio")
    if supports_generate_audio is not None and not isinstance(
        supports_generate_audio, bool
    ):
        raise MediaModelSchemaError("supportsGenerateAudio must be boolean")
    default_scene = config.get("defaultSceneOptimize")
    scene_options = config.get("sceneOptimizeOptions") or []
    if default_scene is not None and (
        not isinstance(default_scene, str) or default_scene not in scene_options
    ):
        raise MediaModelSchemaError(
            "defaultSceneOptimize must be included in sceneOptimizeOptions"
        )
    return config


def validate_media_model_params(schema: object, values: object) -> dict[str, Any]:
    normalized_schema = validate_media_request_schema(schema)
    raw_values = values or {}
    if not isinstance(raw_values, dict):
        raise MediaModelSchemaError("model_params must be an object")
    definitions = {
        str(item["key"]): item for item in normalized_schema.get("parameters") or []
    }
    unknown = set(raw_values) - set(definitions)
    if unknown:
        raise MediaModelSchemaError(
            f"unknown model parameters: {', '.join(sorted(unknown))}"
        )
    result: dict[str, Any] = {}
    for key, definition in definitions.items():
        value = raw_values.get(key, definition.get("default"))
        if value is None or value == "" or (
            definition.get("required")
            and definition.get("control") == "multiselect"
            and value == []
        ):
            if definition.get("required"):
                raise MediaModelSchemaError(f"parameter is required: {key}")
            continue
        _validate_parameter_value(definition, value, key)
        result[key] = value
    return result


def media_request_schema_for_mode(schema: object, mode: str | None) -> dict[str, Any]:
    normalized_schema = validate_media_request_schema(schema)
    if not normalized_schema:
        return {}
    normalized_mode = normalize_media_model_mode(mode)
    filtered = copy.deepcopy(normalized_schema)
    filtered["parameters"] = [
        item
        for item in normalized_schema.get("parameters") or []
        if not item.get("modes") or normalized_mode in item["modes"]
    ]
    return filtered


def apply_media_request_schema(
    payload: dict[str, Any], schema: object, values: object
) -> dict[str, Any]:
    normalized_schema = validate_media_request_schema(schema)
    normalized_values = validate_media_model_params(normalized_schema, values)
    result = copy.deepcopy(payload)
    definitions = {
        str(item["key"]): item for item in normalized_schema.get("parameters") or []
    }
    for key, value in normalized_values.items():
        _set_path(result, str(definitions[key]["requestPath"]), value)
    for path in normalized_schema.get("omitPaths") or []:
        _delete_path(result, str(path))
    return result


def _set_path(target: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    cursor = target
    for part in parts[:-1]:
        child = cursor.get(part)
        if child is None:
            child = {}
            cursor[part] = child
        if not isinstance(child, dict):
            raise MediaModelSchemaError(
                f"request path conflicts with scalar field: {path}"
            )
        cursor = child
    cursor[parts[-1]] = value


def _delete_path(target: dict[str, Any], path: str) -> None:
    parts = path.split(".")
    cursor: Any = target
    for part in parts[:-1]:
        if not isinstance(cursor, dict):
            return
        cursor = cursor.get(part)
    if isinstance(cursor, dict):
        cursor.pop(parts[-1], None)

"""Shared deterministic runtime checks; transports supply authenticated live catalogs."""

from copy import deepcopy
from typing import Any
import math

from novelvideo.api.schemas import FREEZONE_DEFAULT_IMAGE_MODEL
from novelvideo.freezone.video_node import FREEZONE_DEFAULT_VIDEO_BACKEND

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

# Product defaults are preferences, never catalog ids. Resolve them only against
# the caller's visible catalog. The order of entries in that catalog is irrelevant.
_RECOMMENDED_MODEL_ALIASES = {
    "imageGenNode": FREEZONE_DEFAULT_IMAGE_MODEL,
    "videoNode": FREEZONE_DEFAULT_VIDEO_BACKEND,
}
_RECOMMENDED_OPTIONS = {
    "aspectRatio": ("9:16", "16:9", "1:1"),
    "imageSize": ("1K", "2K", "4K"),
    "imageQuality": ("medium", "low", "high"),
    "videoResolution": ("720p", "480p", "1080p", "2K"),
}
_VIDEO_CATALOG_MODES = {
    "textToVideo": "text_to_video",
    "firstFrame": "first_frame",
    "imageToVideo": "image_to_video",
    "firstLastFrame": "first_last_frame",
    "imageReference": "image_reference",
    "allReference": "all_reference",
    "videoEdit": "video_edit",
}


def _preferred_option(entry: dict[str, Any], key: str, preferences: tuple[str, ...]) -> str | None:
    options = _catalog_string_options(entry, key)
    preferred = next(
        (option for preferred in preferences for option in options
         if option.casefold() == preferred.casefold()),
        None,
    )
    return preferred or (options[0] if len(options) == 1 else None)


def _catalog_entry_identifiers(entry: dict[str, Any]) -> set[str]:
    """Every identifier a node may legitimately use for one catalog entry."""
    values = (
        entry.get("id"), entry.get("apiModel"), entry.get("api_model"),
        entry.get("catalogId"), *(entry.get("aliases") or []),
    )
    return {
        str(value).strip().casefold()
        for value in values
        if isinstance(value, (str, int)) and str(value).strip()
    }


def _catalog_entry_for_model(
    catalog: list[dict[str, Any]], requested: str
) -> dict[str, Any] | None:
    wanted = requested.strip().casefold()
    return next(
        (item for item in catalog if wanted in _catalog_entry_identifiers(item)), None
    )


def resolve_generation_recommendations(
    nodes: list[Any],
    model_responses: dict[str, dict[str, Any]],
    *,
    fill_missing: bool = False,
) -> list[dict[str, Any]]:
    """Materialize concrete choices from one scoped catalog snapshot per media type.

    Mutates only valid choices. A missing default or capability leaves a blocker;
    callers must not persist or dispatch any node when blockers are returned.

    ``fill_missing`` also completes nodes whose model is already concrete but
    whose other fields are absent. It exists to build a recommendation the user
    will see and accept; plan and canvas preflight keep the default so an
    incomplete node is reported instead of silently defaulted.
    """
    blockers: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("node_type") not in _RECOMMENDED_MODEL_ALIASES:
            continue
        kind = node["node_type"]
        data = node.get("data")
        if not isinstance(data, dict):
            data = {}
            node["data"] = data
        response = model_responses.get(kind) or {}
        raw_catalog = response.get("data") if response.get("ok") is not False else None
        if not isinstance(raw_catalog, list):
            continue  # Existing runtime preflight reports unavailable catalogs.
        catalog = [entry for entry in raw_catalog if isinstance(entry, dict)]
        requested = str(data.get("model") or "").strip()
        symbolic_fields = any(
            isinstance(value, str)
            and value.strip().casefold() in _RECOMMENDED_GENERATION_MODEL_VALUES
            for key, value in data.items() if key in {"aspectRatio", "size", "quality"}
        )
        if not requested and not symbolic_fields:
            continue
        symbolic = not requested or requested.casefold() in _RECOMMENDED_GENERATION_MODEL_VALUES
        if not symbolic and not symbolic_fields and not fill_missing:
            continue
        # A concrete model may be any identifier the catalog publishes for the
        # entry (id, apiModel, catalogId or an alias such as ``newapi_gpt_image2``
        # for ``LingShan-G2``); the symbolic default resolves the same way.
        entry = _catalog_entry_for_model(
            catalog, _RECOMMENDED_MODEL_ALIASES[kind] if symbolic else requested
        )
        if entry is None:
            if symbolic or symbolic_fields:
                blockers.append({
                    "path": f"runtime.models.{node.get('id') or kind}.model",
                    "code": "recommended_model_unavailable",
                    "message": "The selected model is unavailable for recommended parameters",
                })
            continue
        model_id = str(entry.get("id") or "").strip()
        if not model_id:
            blockers.append({
                "path": f"runtime.models.{node.get('id') or kind}.model",
                "code": "recommended_model_unavailable",
                "message": "The recommended catalog entry has no model id",
            })
            continue
        option_fields = {
            "aspectRatio": ("ratioOptions", "aspectRatio"),
            ("size" if kind == "imageGenNode" else "quality"): (
                "resolutionOptions",
                "imageSize" if kind == "imageGenNode" else "videoResolution",
            ),
        }
        if kind == "imageGenNode" and _catalog_string_options(entry, "qualityOptions"):
            option_fields["quality"] = ("qualityOptions", "imageQuality")
        candidates = {
            field: _preferred_option(entry, catalog_key, _RECOMMENDED_OPTIONS[preference_key])
            for field, (catalog_key, preference_key) in option_fields.items()
            if not data.get(field) or (
                isinstance(data.get(field), str)
                and str(data[field]).strip().casefold() in _RECOMMENDED_GENERATION_MODEL_VALUES
            )
        }
        if "aspectRatio" in candidates and not _catalog_string_options(entry, "ratioOptions"):
            # The catalog leaves the ratio unconstrained: runtime preflight treats
            # aspectRatio as optional for exactly this case, so a missing
            # ``ratioOptions`` must not abandon every other recommendation.
            # Recommend the product default ratio instead; the frontend offers the
            # same built-in ratio list when a model declares none (issue #674).
            candidates["aspectRatio"] = _RECOMMENDED_OPTIONS["aspectRatio"][0]
        if any(value is None for value in candidates.values()):
            blockers.append({
                "path": f"runtime.models.{node.get('id') or kind}",
                "code": "recommended_parameters_unavailable",
                "message": "The selected catalog model has no compatible recommended parameters",
            })
            continue
        if symbolic:
            data["model"] = model_id
        for field, value in candidates.items():
            current = data.get(field)
            if not current or (
                isinstance(current, str)
                and current.strip().casefold() in _RECOMMENDED_GENERATION_MODEL_VALUES
            ):
                data[field] = value
        if kind == "imageGenNode" and not _catalog_string_options(entry, "qualityOptions"):
            quality = str(data.get("quality") or "").strip().casefold()
            if quality in _RECOMMENDED_GENERATION_MODEL_VALUES:
                data.pop("quality", None)
        data.setdefault("count", 1)
        if kind == "videoNode":
            minimum = entry.get("minDuration")
            maximum = entry.get("maxDuration")
            duration = data.get("durationSec")
            if duration is None:
                duration = 5
                if isinstance(minimum, (int, float)) and minimum > duration:
                    duration = int(math.ceil(minimum))
                if isinstance(maximum, (int, float)) and maximum < duration:
                    duration = int(math.floor(maximum))
                data["durationSec"] = duration
            if entry.get("supportsGenerateAudio") is not False:
                data.setdefault("generateAudio", False)
    return blockers


def _catalog_string_options(entry: dict[str, Any], key: str) -> list[str]:
    values = entry.get(key)
    if not isinstance(values, list):
        return []
    return [str(value).strip() for value in values if str(value).strip()]


# Recipe ids / timeline roles that mark a video shot as carrying dialogue or
# voice-over. There is no first-class "voiced" flag on plan nodes yet, so this
# is the narrow, explicit signal preflight can act on (issue #677).
_VOICED_RECIPE_MARKERS = ("dialog", "voice", "speech", "narrat", "lipsync", "lip-sync")
_VOICED_TIMELINE_ROLES = frozenset({"voiceover", "narration", "shot_voice", "dialogue"})


def _video_node_is_voiced(node: dict[str, Any]) -> bool:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    catalog = data.get("workflowCatalog") if isinstance(data.get("workflowCatalog"), dict) else {}
    if catalog.get("requiresGeneratedAudio") is True:
        return True
    role = str(catalog.get("timelineRole") or "").strip().casefold()
    if role in _VOICED_TIMELINE_ROLES:
        return True
    recipe_ids = [str(catalog.get("recipeId") or "")]
    pipeline = catalog.get("recipePipeline")
    if isinstance(pipeline, list):
        recipe_ids.extend(
            str(item.get("id") if isinstance(item, dict) else item or "") for item in pipeline
        )
    return any(
        marker in recipe_id.casefold() for recipe_id in recipe_ids for marker in _VOICED_RECIPE_MARKERS
    )


def _video_duration_blockers(node: dict[str, Any]) -> list[dict[str, Any]]:
    """A video node must state a positive durationSec before its draft is ready.

    The standard planner writes it from user preferences; an agent-authored
    plan may omit it and the runtime then renders a 0-second shot. Duration
    existence does not depend on model capabilities, so this runs for every
    video node even when the live catalog is unavailable. The blocker carries
    ``required_choices`` in the canvas-write preflight shape so the agent asks
    the user through one clarification card (issue #677).
    """
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    node_id = str(node.get("id") or "video").strip()
    duration = data.get("durationSec")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration > 0:
        return []
    return [
        {
            "path": f"runtime.models.{node_id}.durationSec",
            "code": "generation_parameters_required",
            "message": "video node has no planned duration; set data.durationSec (seconds)",
            "required_choices": {"video": ["duration_seconds"]},
        }
    ]


def _video_audio_intent_blockers(node: dict[str, Any]) -> list[dict[str, Any]]:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    catalog = data.get("workflowCatalog") if isinstance(data.get("workflowCatalog"), dict) else {}
    if catalog.get("requiresGeneratedAudio") is not True or data.get("generateAudio") is not False:
        return []
    node_id = str(node.get("id") or "video").strip()
    return [{
        "path": f"runtime.models.{node_id}.generateAudio",
        "code": "generation_parameter_conflict",
        "message": "this shot requires generated dialogue or sound; set generateAudio=true",
    }]


def _video_runtime_parameter_blockers(
    node: dict[str, Any], catalog_entry: dict[str, Any]
) -> list[dict[str, Any]]:
    """Catalog-dependent runtime fields: a voiced shot on an audio-capable model
    must state generateAudio, or the runtime default renders it silent."""
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    node_id = str(node.get("id") or "video").strip()
    blockers: list[dict[str, Any]] = []
    catalog = data.get("workflowCatalog") if isinstance(data.get("workflowCatalog"), dict) else {}
    if catalog.get("requiresGeneratedAudio") is True:
        if catalog_entry.get("supportsGenerateAudio") is False:
            blockers.append({
                "path": f"runtime.models.{node_id}.generateAudio",
                "code": "model_capability_unsupported",
                "message": "this video model cannot generate the audio required by the shot",
            })
    if (
        _video_node_is_voiced(node)
        and catalog_entry.get("supportsGenerateAudio") is not False
        and not isinstance(data.get("generateAudio"), bool)
    ):
        blockers.append(
            {
                "path": f"runtime.models.{node_id}.generateAudio",
                "code": "generation_parameters_required",
                "message": (
                    "dialogue or voice-over shot must state generateAudio explicitly; "
                    "the runtime default renders it silent"
                ),
                "required_choices": {"video": ["generate_audio"]},
            }
        )
    return blockers


# Portable choice names used in required_choices -> canvas data field.
_PORTABLE_CHOICE_DATA_FIELDS = {
    "model": "model",
    "aspect_ratio": "aspectRatio",
    "resolution": "size",  # videoNode stores its resolution in data.quality
    "quality": "quality",
    "duration_seconds": "durationSec",
    "generate_audio": "generateAudio",
    "count": "count",
}
_MEDIA_NODE_TYPES = {"image": "imageGenNode", "video": "videoNode"}


_MODEL_BLOCKER_PATH_PREFIX = "runtime.models."


def _blocker_node_id(path: str) -> str:
    """Node id from a ``runtime.models.<node_id>.<field>`` blocker path.

    Node ids may contain dots, so split on the known prefix and the trailing
    field name rather than on every dot.
    """
    if not path.startswith(_MODEL_BLOCKER_PATH_PREFIX):
        return path
    rest = path[len(_MODEL_BLOCKER_PATH_PREFIX) :]
    node_id, separator, _field = rest.rpartition(".")
    return node_id if separator else rest


def preflight_failure_blocker(preflight: dict[str, Any]) -> dict[str, Any]:
    """The blocker to report when a blocked preflight is not a clarification.

    A missing generation choice is answerable; a disabled queue or an
    unavailable model/catalog is not. When both kinds are present the
    non-answerable one is reported first so the agent does not ask the user a
    question whose answer cannot unblock the draft.
    """
    blockers = [b for b in preflight.get("blockers") or [] if isinstance(b, dict)]
    for blocker in blockers:
        if blocker.get("code") != "generation_parameters_required":
            return blocker
    return blockers[0] if blockers else {}


def generation_clarification_request(preflight: dict[str, Any]) -> dict[str, Any] | None:
    """Merge generation_parameters_required blockers into one clarification request.

    Returns ``None`` when the preflight has no such blocker, and also when any
    other blocker is present: a clarification is retryable, so returning one
    while a ``queue_disabled`` / ``model_unavailable`` blocker sits beside it
    would make the agent ask the user a question and only then fail. Mixed
    preflights stay a ``workflow_preflight_failed`` error that reports the
    non-answerable blocker first (``preflight_failure_blocker``). Otherwise
    the result carries the same ``media_types`` / ``missing_parameters`` /
    ``required_choices`` shape as the canvas-write preflight, so every entry
    point (HTTP drafts API, server-owned MCP operations, legacy plugin
    handlers) can hand the agent a single clarification card (issue #677).
    """
    blockers = [b for b in preflight.get("blockers") or [] if isinstance(b, dict)]
    if any(
        blocker.get("code") != "generation_parameters_required" for blocker in blockers
    ):
        return None
    by_node: dict[str, dict[str, Any]] = {}
    for blocker in blockers:
        choices = blocker.get("required_choices")
        if not isinstance(choices, dict):
            continue
        node_id = _blocker_node_id(str(blocker.get("path") or ""))
        for media, portable_fields in choices.items():
            node_type = _MEDIA_NODE_TYPES.get(str(media))
            if node_type is None or not isinstance(portable_fields, list):
                continue
            item = by_node.setdefault(
                f"{node_type}:{node_id}",
                {"node_id": node_id, "node_type": node_type, "fields": []},
            )
            for portable in portable_fields:
                field = _PORTABLE_CHOICE_DATA_FIELDS.get(str(portable), str(portable))
                if node_type == "videoNode" and portable == "resolution":
                    field = "quality"
                if field not in item["fields"]:
                    item["fields"].append(field)
    if not by_node:
        return None
    # Canonical field order (model, ratio, resolution, ..., duration, audio,
    # count) so the request is stable regardless of blocker emission order.
    field_rank = {field: index for index, field in enumerate(_PORTABLE_CHOICE_DATA_FIELDS.values())}
    missing = list(by_node.values())
    for item in missing:
        item["fields"].sort(key=lambda field: (field_rank.get(field, len(field_rank)), field))
    required_choices: dict[str, list[str]] = {}
    data_to_portable = {v: k for k, v in _PORTABLE_CHOICE_DATA_FIELDS.items()}
    for item in missing:
        media = "image" if item["node_type"] == "imageGenNode" else "video"
        bucket = required_choices.setdefault(media, [])
        for field in item["fields"]:
            portable = "resolution" if media == "video" and field == "quality" else (
                data_to_portable.get(field, field)
            )
            if portable not in bucket:
                bucket.append(portable)
    portable_rank = {name: index for index, name in enumerate(_PORTABLE_CHOICE_DATA_FIELDS)}
    for bucket in required_choices.values():
        bucket.sort(key=lambda name: (portable_rank.get(name, len(portable_rank)), name))
    return {
        "ok": False,
        "status": "clarification_required",
        "code": "generation_parameters_required",
        "error": "image/video generation parameters require user clarification",
        "media_types": sorted(required_choices),
        "missing_parameters": missing,
        "required_choices": required_choices,
        "clarification": {"title": "确认图片和视频生成参数", "allow_skip": False},
    }


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
    catalog: list[dict[str, Any]] | None = None,
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
    if node_type == "videoNode":
        supported_modes = catalog_entry.get("supportedModes")
        selected_mode = data.get("genMode") or "textToVideo"
        catalog_mode = (
            _VIDEO_CATALOG_MODES.get(selected_mode)
            if isinstance(selected_mode, str) else None
        )
        if isinstance(supported_modes, list) and supported_modes and (
            catalog_mode not in supported_modes
        ):
            allowed = [
                mode for mode, catalog_mode in _VIDEO_CATALOG_MODES.items()
                if catalog_mode in supported_modes
            ]
            # The mode is what the user asked for (issue #711): imageToVideo and
            # firstFrame consume the same single image differently, so recovery
            # keeps the mode and switches to a model that supports it.
            compatible = [
                str(entry.get("id") or "").strip()
                for entry in catalog or []
                if isinstance(entry, dict)
                and str(entry.get("id") or "").strip()
                and isinstance(entry.get("supportedModes"), list)
                and catalog_mode in entry["supportedModes"]
            ]
            blockers.append({
                "path": f"runtime.models.{node_id}.genMode",
                "message": (
                    f"genMode value {selected_mode!r} is not supported by model "
                    f"{model_id}; supported values: {allowed!r}. "
                    + (
                        f"Keep genMode {selected_mode!r} and select one of the "
                        f"compatible_models; do not substitute another mode."
                        if compatible
                        else "No available model supports this mode; ask the user "
                        "instead of substituting another mode."
                    )
                ),
                "code": "model_capability_unsupported",
                "allowed_values": allowed,
                "compatible_models": compatible,
                "recovery": "choose_compatible_model" if compatible else "ask_user",
            })
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
    if runtime_available:
        blockers.extend(resolve_generation_recommendations(nodes, model_responses))
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
            catalog = (
                [item for item in raw_models if isinstance(item, dict)]
                if isinstance(raw_models, list)
                else []
            )
            # Primary ids for the available_models listing only; a node may name
            # the same entry by any legal identifier (id, apiModel, alias...).
            catalog_by_id = {
                str(
                    item.get("id") or item.get("apiModel") or item.get("api_model") or ""
                ).strip(): item
                for item in catalog
                if str(
                    item.get("id") or item.get("apiModel") or item.get("api_model") or ""
                ).strip()
            }
            missing = sorted(
                model
                for model in requested
                if _catalog_entry_for_model(catalog, model) is None
            )
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
                                    "supportedModes",
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
                catalog_entry = _catalog_entry_for_model(catalog, model)
                if catalog_entry is not None:
                    blockers.extend(
                        _workflow_node_capability_blockers(node, catalog_entry, catalog)
                    )
                    if node_type == "videoNode":
                        blockers.extend(
                            _video_runtime_parameter_blockers(node, catalog_entry)
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
    # Duration existence is model-independent: check every video node whether
    # or not the live catalog was reachable (after catalog-level blockers so an
    # unavailable catalog is still reported first).
    for node in nodes:
        if isinstance(node, dict) and node.get("node_type") == "videoNode":
            blockers.extend(_video_duration_blockers(node))
            blockers.extend(_video_audio_intent_blockers(node))
    return {
        **base,
        "status": "blocked" if blockers else "ready",
        "blockers": blockers,
        "warnings": warnings,
        "runtime_checks": checks,
    }

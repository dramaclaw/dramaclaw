"""Generation credit cost lookup for the main application."""

import json
import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from novelvideo.api.auth import get_api_user
from novelvideo.ports import get_credit_quote

router = APIRouter()

GenerationCreditCostKind = Literal[
    "model",
    "image_selection",
    "fixed_image",
    "video_backend",
    "beat_tts",
    "freezone_audio_music",
    "freezone_image_reverse_prompt",
    "style_analyzer",
    "feature",
]
GenerationCreditSurface = Literal["supertale", "canvas"]


def _display_credit_cost(cost: int) -> str:
    return str(cost)


def _parse_billing_params(raw_params: str) -> dict:
    if not isinstance(raw_params, str):
        return {}
    clean_params = raw_params.strip()
    if not clean_params:
        return {}
    try:
        value = json.loads(clean_params)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid billing params") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="billing params must be an object")
    return value


def _clean_query_value(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()


def _clean_quantity(value: object) -> int:
    try:
        return max(int(value or 1), 0)
    except (TypeError, ValueError):
        return 1


def _image_model_supports_quality(model: str) -> bool:
    model_name = str(model or "").strip().lower()
    return (
        model_name in {"lingshan-g2", "gpt-image-2", "image-2", "image-2-official"}
        or "gpt-image" in model_name
    )


def _image_billing_params(
    *,
    model: str,
    image_size: str = "",
    quality: str = "",
) -> dict[str, str]:
    params: dict[str, str] = {}
    clean_size = str(image_size or "").strip()
    if clean_size:
        params["size"] = clean_size
    clean_quality = str(quality or "").strip()
    if clean_quality and _image_model_supports_quality(model):
        params["quality"] = clean_quality
    return params


def _merge_billing_params(defaults: dict, explicit: dict) -> dict:
    if not defaults:
        return explicit
    merged = dict(defaults)
    merged.update(explicit)
    return merged


def _resolve_labeled_value(
    value: str, options: dict[str, str], *, label_name: str
) -> str:
    clean_value = value.strip()
    if clean_value in options:
        return clean_value

    label_matches = [
        key for key, label in options.items() if label.strip() == clean_value
    ]
    if not label_matches:
        normalized_label = clean_value.casefold()
        label_matches = [
            key
            for key, label in options.items()
            if label.strip().casefold() == normalized_label
        ]
    if len(label_matches) != 1:
        detail = (
            f"ambiguous {label_name} label"
            if label_matches
            else f"invalid {label_name}"
        )
        raise HTTPException(status_code=400, detail=detail)
    return label_matches[0]


def _fixed_image_cost_model(kind: str) -> str:
    if kind == "prop_reference":
        from novelvideo.generators.nanobanana_prop import (
            resolve_prop_reference_image_model,
        )

        return resolve_prop_reference_image_model()
    if kind == "scene_master":
        from novelvideo.generators.scene_reference_images import (
            resolve_scene_reference_image_model,
        )

        return resolve_scene_reference_image_model("master")
    if kind == "scene_reverse_master":
        from novelvideo.generators.scene_reference_images import (
            resolve_scene_reference_image_model,
        )

        return resolve_scene_reference_image_model("reverse_master")
    if kind == "scene_pano":
        from novelvideo.stage_asset_tasks import resolve_scene_360_image_model

        return resolve_scene_360_image_model()
    raise HTTPException(status_code=400, detail="invalid fixed image credit cost kind")


def _image_selection_cost_model(selection: str) -> str:
    clean_selection = selection.strip()
    if not clean_selection:
        raise HTTPException(status_code=400, detail="selection is required")

    from novelvideo.config import (
        IMAGE_GENERATION_SELECTIONS,
        character_image_selection_options,
    )

    options = character_image_selection_options()
    clean_selection = _resolve_labeled_value(
        clean_selection,
        options,
        label_name="image selection",
    )

    if clean_selection not in IMAGE_GENERATION_SELECTIONS:
        raise HTTPException(status_code=400, detail="invalid image selection")
    return IMAGE_GENERATION_SELECTIONS[clean_selection]["model"]


def _video_backend_cost_model(backend: str) -> str:
    clean_backend = backend.strip()
    if not clean_backend:
        raise HTTPException(status_code=400, detail="video backend is required")

    from novelvideo.generators.huimengi import parse_huimeng_video_backend
    from novelvideo.generators.video_generator import (
        VideoBackend,
        newapi_video_backend_options,
        parse_newapi_video_backend,
    )

    newapi_model = parse_newapi_video_backend(clean_backend)
    huimeng_model = parse_huimeng_video_backend(clean_backend)
    backend_enum: VideoBackend | None = None
    if not newapi_model and not huimeng_model:
        try:
            backend_enum = VideoBackend(clean_backend)
        except ValueError:
            from novelvideo.generators.huimengi import huimeng_video_backend_options

            clean_backend = _resolve_labeled_value(
                clean_backend,
                {
                    **newapi_video_backend_options(),
                    **huimeng_video_backend_options(),
                },
                label_name="video backend",
            )
            newapi_model = parse_newapi_video_backend(clean_backend)
            huimeng_model = parse_huimeng_video_backend(clean_backend)

    if newapi_model:
        return newapi_model
    if huimeng_model:
        return huimeng_model

    if backend_enum is None:
        try:
            backend_enum = VideoBackend(clean_backend)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="invalid video backend"
            ) from exc

    if backend_enum == VideoBackend.SEEDANCE_FAST:
        from novelvideo.config import SEEDANCE_FAST_MODEL

        return SEEDANCE_FAST_MODEL
    if backend_enum in {VideoBackend.SEEDANCE_PRO, VideoBackend.SEEDANCE_PRO_SILENT}:
        from novelvideo.config import SEEDANCE_PRO_MODEL

        return SEEDANCE_PRO_MODEL
    if backend_enum == VideoBackend.SEEDANCE_2:
        from novelvideo.generators.video_generator import Seedance2VideoGenerator

        return Seedance2VideoGenerator.MODEL
    if backend_enum == VideoBackend.GROK_720:
        from novelvideo.generators.video_generator import GrokVideoGenerator

        return GrokVideoGenerator.MODEL

    raise HTTPException(status_code=400, detail="video backend has no credit model")


def _generation_credit_cost_model(kind: str, value: str) -> str:
    clean_value = value.strip()
    if kind == "model":
        if not clean_value:
            raise HTTPException(status_code=400, detail="model is required")
        return clean_value
    if kind == "image_selection":
        return _image_selection_cost_model(clean_value)
    if kind == "fixed_image":
        if not clean_value:
            raise HTTPException(status_code=400, detail="fixed image kind is required")
        return _fixed_image_cost_model(clean_value)
    if kind == "video_backend":
        return _video_backend_cost_model(clean_value)
    if kind == "beat_tts":
        from novelvideo.config import INDEXTTS2_RECORD_MODEL

        return INDEXTTS2_RECORD_MODEL.strip()
    if kind == "freezone_audio_music":
        return "LingShan-MU-11"
    if kind == "freezone_image_reverse_prompt":
        from novelvideo.freezone.vision_gateway import resolve_freezone_vision_model

        return resolve_freezone_vision_model()
    if kind == "style_analyzer":
        from novelvideo.config import get_newapi_text_model_name

        return get_newapi_text_model_name("STYLE_ANALYZER_MODEL", "gemini-3.5-flash")
    if kind == "feature":
        if not clean_value:
            raise HTTPException(status_code=400, detail="feature key is required")
        return clean_value
    raise HTTPException(status_code=400, detail="invalid generation credit cost kind")


def _generation_billing_kind(kind: str) -> str:
    if kind in {"image_selection", "fixed_image"}:
        return "image"
    if kind == "video_backend":
        return "video"
    if kind in {"beat_tts", "freezone_audio_music"}:
        return "audio"
    if kind in {
        "freezone_image_reverse_prompt",
        "style_analyzer",
    }:
        return "text"
    if kind == "feature":
        return "feature"
    return "model"


def _fixed_image_billing_params(value: str, *, model: str) -> dict:
    clean_value = value.strip()
    if clean_value == "scene_pano":
        image_size = (os.environ.get("SCENE_360_IMAGE_SIZE") or "2K").strip()
        quality = (
            os.environ.get("SCENE_360_IMAGE_QUALITY")
            or os.environ.get("HUIMENG_IMAGE_QUALITY")
            or "medium"
        ).strip()
        return _image_billing_params(
            model=model, image_size=image_size, quality=quality
        )
    if clean_value in {"scene_master", "scene_reverse_master"}:
        return _image_billing_params(model=model, image_size="1K", quality="low")
    if clean_value == "prop_reference":
        from novelvideo.generators.nanobanana_grid import normalize_image_size
        from novelvideo.generators.nanobanana_prop import PROP_REF_IMAGE_SIZE

        return _image_billing_params(
            model=model,
            image_size=normalize_image_size(PROP_REF_IMAGE_SIZE, provider="newapi"),
            quality="medium",
        )
    return {}


def _image_selection_billing_params(
    *,
    model: str,
    mode_key: str = "",
    image_role: str = "",
) -> dict:
    params: dict[str, str] = {}
    clean_mode_key = mode_key.strip()
    if clean_mode_key:
        from novelvideo.generators.nanobanana_grid import (
            REGEN_MODE_CONFIGS,
            normalize_image_size,
        )

        mode_cfg = REGEN_MODE_CONFIGS.get(clean_mode_key)
        if mode_cfg is None:
            raise HTTPException(status_code=400, detail="invalid image mode key")
        params["size"] = normalize_image_size(
            str(mode_cfg.get("image_size") or ""), "newapi"
        )

    clean_role = image_role.strip().lower()
    if clean_role == "sketch":
        from novelvideo.config import OPENAI_SKETCH_IMAGE_QUALITY

        params.update(
            _image_billing_params(
                model=model,
                image_size="",
                quality=OPENAI_SKETCH_IMAGE_QUALITY,
            )
        )
    elif clean_role in {"render", "character", "identity"}:
        from novelvideo.config import OPENAI_IMAGE_QUALITY

        params.update(
            _image_billing_params(
                model=model,
                image_size="1K" if clean_role in {"character", "identity"} else "",
                quality=OPENAI_IMAGE_QUALITY,
            )
        )
    return params


def _video_backend_billing_params(params: dict) -> dict:
    resolution = str(params.get("resolution") or "").strip()
    return {"resolution": resolution} if resolution else {}


def _video_backend_feature_billing_params(params: dict) -> dict:
    video_backend = str(params.get("video_backend") or "").strip()
    if not video_backend:
        return params
    from novelvideo.video_duration import normalize_video_duration_for_backend

    # Never trust a client-provided pricing model. The backend selection is
    # resolved server-side so callers cannot pair cheap pricing with another
    # provider model.
    pricing_model = _video_backend_cost_model(video_backend)
    pricing_quantity = normalize_video_duration_for_backend(
        video_backend,
        params.get("pricing_quantity"),
    )
    return {
        **params,
        "pricing_kind": "video",
        "pricing_model": pricing_model,
        "pricing_params": _video_backend_billing_params(params),
        "pricing_quantity": pricing_quantity,
        "pricing_metrics": {
            "call_count": 1,
            "item_count": 1,
            "duration_seconds": pricing_quantity,
        },
        "pricing_model_selection": video_backend,
    }


def freezone_video_generate_billing_params(params: dict) -> dict:
    """Resolve Freezone video generation metadata for quotes and task reservations."""
    return _video_backend_feature_billing_params(params)


def freezone_video_generate_task_billing(params: dict) -> dict:
    return {
        "feature_key": "freezone.video_generate",
        **freezone_video_generate_billing_params(params),
    }


def freezone_audio_speech_billing_params(params: dict) -> dict:
    """Resolve Freezone speech metadata for quotes and task reservations."""
    from novelvideo.audio.indextts2_beat_audio_task import (
        indextts2_audio_billing_params,
    )

    try:
        quantity = max(int(params.get("pricing_quantity") or 1), 1)
    except (TypeError, ValueError):
        quantity = 1
    resolved = (
        params
        if str(params.get("pricing_model") or "").strip()
        else {**params, **indextts2_audio_billing_params(quantity)}
    )
    return {
        **resolved,
        "pricing_metrics": {
            "call_count": 1,
            "item_count": 1,
            "billable_chars": quantity,
        },
    }


def freezone_audio_music_billing_params(params: dict) -> dict:
    """Resolve Freezone music metadata for quotes and task reservations."""
    from novelvideo.freezone.audio_node import freezone_audio_music_billing_seconds

    try:
        pricing_quantity = max(int(params.get("pricing_quantity") or 0), 0)
    except (TypeError, ValueError):
        pricing_quantity = 0
    if pricing_quantity <= 0:
        pricing_quantity = freezone_audio_music_billing_seconds(
            int(params.get("music_length_ms") or 0)
        )
    pricing_model = str(
        params.get("pricing_model")
        or params.get("model")
        or "LingShan-MU-11"
    ).strip() or "LingShan-MU-11"
    return {
        **params,
        "pricing_kind": "audio",
        "pricing_model": pricing_model,
        "pricing_params": {},
        "pricing_quantity": pricing_quantity,
        "pricing_metrics": {
            "call_count": 1,
            "item_count": 1,
            "duration_seconds": pricing_quantity,
        },
    }


def freezone_audio_task_billing(feature_key: str, params: dict) -> dict:
    if feature_key == "freezone.audio_speech":
        resolved = freezone_audio_speech_billing_params(params)
    elif feature_key == "freezone.audio_music":
        resolved = freezone_audio_music_billing_params(params)
    else:
        raise ValueError(f"unsupported Freezone audio feature: {feature_key}")
    return {"feature_key": feature_key, **resolved}


def freezone_image_reverse_prompt_billing_params(params: dict) -> dict:
    """Resolve vision-model metadata for reverse-prompt quotes and reservations."""
    from novelvideo.freezone.vision_gateway import resolve_freezone_vision_model

    try:
        pricing_quantity = max(
            int(
                params.get("pricing_quantity")
                or params.get("billable_chars")
                or 1
            ),
            1,
        )
    except (TypeError, ValueError):
        pricing_quantity = 1
    resolved = dict(params)
    if not str(resolved.get("pricing_model") or "").strip():
        resolved.update(
            {
                "pricing_kind": "text",
                "pricing_model": resolve_freezone_vision_model(),
                "pricing_params": {},
            }
        )
    return {
        **resolved,
        "pricing_quantity": pricing_quantity,
        "pricing_metrics": {
            "call_count": 1,
            "item_count": 1,
            "billable_chars": pricing_quantity,
        },
    }


def freezone_image_reverse_prompt_task_billing(params: dict) -> dict:
    return {
        "feature_key": "freezone.image_reverse_prompt",
        **freezone_image_reverse_prompt_billing_params(params),
    }


FREEZONE_IMAGE_FEATURE_KEYS = {
    "freezone.image_generate",
    "freezone.image_panorama",
    "freezone.image_multi_view",
    "freezone.image_relight",
    "freezone.image_edit",
    "freezone.image_grid",
}


def freezone_image_feature_billing_params(feature_key: str, params: dict) -> dict:
    """Resolve shared Freezone image metadata for quotes and task reservations."""
    clean_feature_key = str(feature_key or "").strip()
    if clean_feature_key not in FREEZONE_IMAGE_FEATURE_KEYS:
        raise ValueError(f"unsupported Freezone image feature: {clean_feature_key}")
    catalog_id = str(
        params.get("catalog_id")
        or params.get("catalog_model_id")
        or params.get("catalogId")
        or ""
    ).strip()
    explicit_pricing_model = str(params.get("pricing_model") or "").strip()
    if catalog_id:
        try:
            pricing_quantity = max(int(params.get("pricing_quantity") or 1), 1)
        except (TypeError, ValueError):
            pricing_quantity = 1
        pricing_params = params.get("pricing_params")
        if not isinstance(pricing_params, dict):
            pricing_params = {
                key: str(params.get(key) or "").strip()
                for key in ("size", "quality")
                if str(params.get(key) or "").strip()
            }
        return {
            **params,
            "catalog_id": catalog_id,
            "pricing_kind": "image",
            **(
                {"pricing_model": explicit_pricing_model}
                if explicit_pricing_model
                else {}
            ),
            "pricing_params": pricing_params,
            "pricing_quantity": pricing_quantity,
            "pricing_metrics": {
                "call_count": pricing_quantity,
                "item_count": pricing_quantity,
            },
        }
    if explicit_pricing_model:
        try:
            pricing_quantity = max(int(params.get("pricing_quantity") or 1), 1)
        except (TypeError, ValueError):
            pricing_quantity = 1
        pricing_params = params.get("pricing_params")
        if not isinstance(pricing_params, dict):
            pricing_params = _image_billing_params(
                model=explicit_pricing_model,
                image_size=str(params.get("size") or ""),
                quality=str(params.get("quality") or ""),
            )
        return {
            **params,
            "pricing_kind": "image",
            "pricing_model": explicit_pricing_model,
            "pricing_params": pricing_params,
            "pricing_quantity": pricing_quantity,
            "pricing_metrics": {
                "call_count": pricing_quantity,
                "item_count": pricing_quantity,
            },
        }
    image_selection = str(params.get("image_selection") or "").strip()
    if not image_selection:
        return params
    from novelvideo.config import (
        IMAGE_GENERATION_SELECTIONS,
        normalize_image_generation_selection,
    )

    selection = normalize_image_generation_selection(image_selection)
    model_cfg = IMAGE_GENERATION_SELECTIONS.get(selection) or {}
    pricing_model = str(model_cfg.get("model") or "").strip()
    if not pricing_model:
        return params
    try:
        pricing_quantity = max(int(params.get("pricing_quantity") or 1), 1)
    except (TypeError, ValueError):
        pricing_quantity = 1
    return {
        **params,
        "pricing_kind": "image",
        "pricing_model": pricing_model,
        "pricing_params": _image_billing_params(
            model=pricing_model,
            image_size=str(params.get("size") or ""),
            quality=str(params.get("quality") or ""),
        ),
        "pricing_quantity": pricing_quantity,
        "pricing_metrics": {
            "call_count": pricing_quantity,
            "item_count": pricing_quantity,
        },
        "pricing_model_selection": selection,
        "pricing_model_label": str(model_cfg.get("label") or selection),
    }


def freezone_image_task_billing(feature_key: str, params: dict) -> dict:
    return {
        "feature_key": str(feature_key or "").strip(),
        **freezone_image_feature_billing_params(feature_key, params),
    }


def freezone_image_generate_billing_params(params: dict) -> dict:
    """Backward-compatible helper for ordinary Freezone image generation."""
    return freezone_image_feature_billing_params("freezone.image_generate", params)


def _feature_billing_params(value: str, params: dict, *, mode_key: str = "") -> dict:
    feature_key = str(value or "").strip()
    if feature_key in FREEZONE_IMAGE_FEATURE_KEYS:
        return freezone_image_feature_billing_params(feature_key, params)
    if feature_key == "freezone.video_generate":
        return freezone_video_generate_billing_params(params)
    if feature_key == "freezone.audio_speech":
        return freezone_audio_speech_billing_params(params)
    if feature_key == "freezone.audio_music":
        return freezone_audio_music_billing_params(params)
    if feature_key == "freezone.image_reverse_prompt":
        return freezone_image_reverse_prompt_billing_params(params)
    if feature_key == "mainline.style_analysis":
        if str(params.get("pricing_model") or "").strip():
            return params
        from novelvideo.api.routes.styles import style_analysis_billing_params

        return {**params, **style_analysis_billing_params()}
    if feature_key == "mainline.beat_video_generation":
        return _video_backend_feature_billing_params(params)
    if feature_key == "mainline.beat_audio_generation":
        from novelvideo.audio.indextts2_beat_audio_task import (
            indextts2_audio_billing_params,
        )

        try:
            quantity = max(int(params.get("pricing_quantity") or 1), 1)
        except (TypeError, ValueError):
            quantity = 1
        if str(params.get("pricing_model") or "").strip():
            return {
                **params,
                "pricing_metrics": {
                    "call_count": quantity,
                    "item_count": quantity,
                },
            }
        return {**params, **indextts2_audio_billing_params(quantity)}
    if feature_key == "mainline.scene_pano_generation":
        if str(params.get("pricing_model") or "").strip():
            return params
        from novelvideo.stage_asset_tasks import (
            _scene_360_credit_billing_params,
            resolve_scene_360_image_model,
            resolve_scene_360_image_provider,
        )

        provider = resolve_scene_360_image_provider(str(params.get("provider") or ""))
        pricing_model = resolve_scene_360_image_model(
            provider=provider,
            model=str(params.get("model") or ""),
        )
        if not pricing_model:
            return params
        image_size = str(
            params.get("image_size") or os.environ.get("SCENE_360_IMAGE_SIZE") or "2K"
        )
        quality = str(
            params.get("quality")
            or os.environ.get("SCENE_360_IMAGE_QUALITY")
            or os.environ.get("HUIMENG_IMAGE_QUALITY")
            or "medium"
        )
        return {
            **params,
            "pricing_kind": "image",
            "pricing_model": pricing_model,
            "pricing_params": _scene_360_credit_billing_params(
                image_size=image_size,
                quality=quality,
            ),
            "pricing_model_selection": str(params.get("model") or pricing_model),
            "pricing_model_label": pricing_model,
            "provider": provider,
        }
    if feature_key == "mainline.scene_reference_image":
        if str(params.get("pricing_model") or "").strip():
            return params
        image_selection = str(params.get("image_selection") or "").strip()
        if not image_selection:
            return params
        from novelvideo.config import (
            IMAGE_GENERATION_SELECTIONS,
            normalize_image_generation_selection,
        )

        selection = normalize_image_generation_selection(image_selection)
        model_cfg = IMAGE_GENERATION_SELECTIONS.get(selection) or {}
        pricing_model = str(model_cfg.get("model") or "").strip()
        if not pricing_model:
            return params
        return {
            **params,
            "pricing_kind": "image",
            "pricing_model": pricing_model,
            "pricing_params": _fixed_image_billing_params(
                "scene_master",
                model=pricing_model,
            ),
            "pricing_model_selection": selection,
            "pricing_model_label": str(model_cfg.get("label") or selection),
        }
    feature_image_role = {
        "mainline.character_portrait": "character",
        "mainline.identity_image": "identity",
        "mainline.prop_reference_image": "prop",
        "mainline.sketch_regen": "sketch",
        "mainline.director_control_to_sketch": "sketch",
        "mainline.render_regen": "render",
    }.get(feature_key)
    if not feature_image_role:
        return params
    if str(params.get("pricing_model") or "").strip():
        return params
    image_selection = str(
        params.get("image_selection") or params.get("character_image_selection") or ""
    ).strip()
    if not image_selection:
        return params
    from novelvideo.config import (
        IMAGE_GENERATION_SELECTIONS,
        normalize_character_image_selection,
        normalize_image_generation_selection,
    )

    selection = (
        normalize_image_generation_selection(image_selection)
        if feature_image_role in {"sketch", "render", "prop"}
        else normalize_character_image_selection(image_selection)
    )
    model_cfg = IMAGE_GENERATION_SELECTIONS.get(selection) or {}
    pricing_model = str(model_cfg.get("model") or "").strip()
    if not pricing_model:
        return params
    pricing_params = (
        _fixed_image_billing_params("prop_reference", model=pricing_model)
        if feature_image_role == "prop"
        else _image_selection_billing_params(
            model=pricing_model,
            mode_key=mode_key,
            image_role=feature_image_role,
        )
    )
    return {
        **params,
        "pricing_kind": "image",
        "pricing_model": pricing_model,
        "pricing_params": pricing_params,
        "pricing_model_selection": selection,
        "pricing_model_label": str(model_cfg.get("label") or selection),
    }


def _default_billing_params(
    *,
    kind: str,
    surface: str,
    value: str,
    model: str,
    explicit_params: dict,
    quantity: int = 1,
    mode_key: str = "",
    image_role: str = "",
) -> dict:
    def feature_params(params: dict) -> dict:
        action_count = max(int(quantity or 0), 1)
        feature_input = dict(params)
        feature_key = str(value or "").strip()
        if feature_key in {
            "freezone.video_generate",
            "mainline.beat_video_generation",
        }:
            try:
                total_duration = max(int(feature_input.get("pricing_quantity") or 0), 0)
            except (TypeError, ValueError):
                total_duration = 0
            if total_duration > 0 and action_count > 1:
                # Canvas asks for N videos with a total duration of N * seconds.
                # Normalize the duration of one provider request first, then
                # aggregate it again below. Otherwise a batch total can be
                # mistaken for one long video and clamped by backend limits.
                feature_input["pricing_quantity"] = total_duration / action_count

        resolved = _feature_billing_params(value, feature_input, mode_key=mode_key)
        if not str(resolved.get("pricing_model") or resolved.get("catalog_id") or "").strip():
            return resolved
        raw_metrics = resolved.get("pricing_metrics")
        metrics = dict(raw_metrics) if isinstance(raw_metrics, dict) else {}
        if "billable_chars" in resolved:
            metrics.update(
                {
                    "call_count": 1,
                    "item_count": 1,
                    "billable_chars": max(int(resolved.get("billable_chars") or 0), 1),
                }
            )
        elif "items" in resolved:
            item_count = max(int(resolved.get("items") or 0), 1)
            metrics.update({"call_count": item_count, "item_count": item_count})
        else:
            metrics.update({"call_count": action_count, "item_count": action_count})
            if str(resolved.get("pricing_kind") or "").strip() == "video":
                per_call_duration = max(int(metrics.get("duration_seconds") or 0), 1)
                metrics["duration_seconds"] = per_call_duration * action_count
        return {**resolved, "pricing_metrics": metrics}

    if surface == "canvas":
        if kind == "video_backend":
            return _video_backend_billing_params(explicit_params)
        if kind == "feature":
            return feature_params(explicit_params)
        return explicit_params

    if kind == "fixed_image":
        return _merge_billing_params(
            _fixed_image_billing_params(value, model=model),
            explicit_params,
        )
    if kind == "image_selection":
        return _merge_billing_params(
            _image_selection_billing_params(
                model=model,
                mode_key=mode_key,
                image_role=image_role,
            ),
            explicit_params,
        )
    if kind == "video_backend":
        return _video_backend_billing_params(explicit_params)
    if kind == "feature":
        return feature_params(explicit_params)
    return explicit_params


@router.get("/generation-credit-cost")
async def get_generation_credit_cost(
    kind: GenerationCreditCostKind = Query(...),
    surface: GenerationCreditSurface = Query("supertale"),
    value: str = Query("", max_length=256),
    params: str = Query("", max_length=2048),
    quantity: int = Query(1, ge=0, le=50_000_000),
    mode_key: str = Query("", max_length=128),
    image_role: str = Query("", max_length=64),
    user: dict = Depends(get_api_user),
) -> dict:
    """Return display-ready credit cost for one generation action or model."""
    model = _generation_credit_cost_model(kind, value)
    if not model:
        raise HTTPException(
            status_code=400, detail="generation model is not configured"
        )
    parsed_params = _parse_billing_params(params)
    quote_args = {
        "kind": _generation_billing_kind(kind),
        "model": model,
        "params": _default_billing_params(
            kind=kind,
            surface=surface,
            value=value,
            model=model,
            explicit_params=parsed_params,
            quantity=_clean_quantity(quantity),
            mode_key=_clean_query_value(mode_key),
            image_role=_clean_query_value(image_role),
        ),
        "quantity": _clean_quantity(quantity),
    }
    try:
        quote = await get_credit_quote().generation_credit_quote(
            **quote_args,
            user_id=str(user.get("id") or user.get("user_id") or ""),
        )
    except TypeError as exc:
        if "user_id" not in str(exc):
            raise
        # One-release compatibility for third-party quote ports compiled
        # against the previous protocol.
        quote = await get_credit_quote().generation_credit_quote(**quote_args)
    original_cost = (
        quote.total_cost
        if quote.original_total_cost is None
        else quote.original_total_cost
    )
    data = {"cost": quote.total_cost, "display": _display_credit_cost(quote.total_cost)}
    if quote.discount_amount > 0:
        data.update(
            {
                "display": (
                    f"{_display_credit_cost(original_cost)}"
                    f"→{_display_credit_cost(quote.total_cost)}"
                ),
                "original_cost": original_cost,
                "original_display": _display_credit_cost(original_cost),
                "discount_amount": quote.discount_amount,
                "promotion": quote.promotion or {},
            }
        )
    if getattr(quote, "unit", "call") == "character":
        data.update(
            {
                "unit": "character",
                "unit_cost": getattr(quote, "unit_cost", 0),
                "quantity": getattr(quote, "quantity", quantity),
                "params": getattr(quote, "params", None) or {},
            }
        )
    return {"ok": True, "data": data}

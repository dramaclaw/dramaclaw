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
    "freezone_story_script",
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


def _resolve_labeled_value(value: str, options: dict[str, str], *, label_name: str) -> str:
    clean_value = value.strip()
    if clean_value in options:
        return clean_value

    label_matches = [key for key, label in options.items() if label.strip() == clean_value]
    if not label_matches:
        normalized_label = clean_value.casefold()
        label_matches = [
            key for key, label in options.items() if label.strip().casefold() == normalized_label
        ]
    if len(label_matches) != 1:
        detail = f"ambiguous {label_name} label" if label_matches else f"invalid {label_name}"
        raise HTTPException(status_code=400, detail=detail)
    return label_matches[0]


def _fixed_image_cost_model(kind: str) -> str:
    if kind == "prop_reference":
        from novelvideo.generators.nanobanana_prop import resolve_prop_reference_image_model

        return resolve_prop_reference_image_model()
    if kind == "scene_master":
        from novelvideo.generators.scene_reference_images import resolve_scene_reference_image_model

        return resolve_scene_reference_image_model("master")
    if kind == "scene_reverse_master":
        from novelvideo.generators.scene_reference_images import resolve_scene_reference_image_model

        return resolve_scene_reference_image_model("reverse_master")
    if kind == "scene_pano":
        from novelvideo.stage_asset_tasks import resolve_scene_360_image_model

        return resolve_scene_360_image_model()
    raise HTTPException(status_code=400, detail="invalid fixed image credit cost kind")


def _image_selection_cost_model(selection: str) -> str:
    clean_selection = selection.strip()
    if not clean_selection:
        raise HTTPException(status_code=400, detail="selection is required")

    from novelvideo.config import IMAGE_GENERATION_SELECTIONS, character_image_selection_options

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
            raise HTTPException(status_code=400, detail="invalid video backend") from exc

    if backend_enum == VideoBackend.SEEDANCE_FAST:
        from novelvideo.config import SEEDANCE_FAST_MODEL

        return SEEDANCE_FAST_MODEL
    if backend_enum in {VideoBackend.SEEDANCE_PRO, VideoBackend.SEEDANCE_PRO_SILENT}:
        from novelvideo.config import SEEDANCE_PRO_MODEL

        return SEEDANCE_PRO_MODEL
    if backend_enum == VideoBackend.SEEDANCE_2:
        from novelvideo.generators.video_generator import Seedance2VideoGenerator

        return Seedance2VideoGenerator.MODEL
    if backend_enum == VideoBackend.WAN26:
        from novelvideo.generators.video_generator import Wan26VideoGenerator

        return Wan26VideoGenerator.MODEL
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
    if kind == "freezone_story_script":
        from novelvideo.freezone.text_node import resolve_freezone_story_script_model

        return resolve_freezone_story_script_model(clean_value or None)["model"]
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
    if kind in {"freezone_image_reverse_prompt", "freezone_story_script", "style_analyzer"}:
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
        return _image_billing_params(model=model, image_size=image_size, quality=quality)
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
        params["size"] = normalize_image_size(str(mode_cfg.get("image_size") or ""), "newapi")

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


def _default_billing_params(
    *,
    kind: str,
    surface: str,
    value: str,
    model: str,
    explicit_params: dict,
    mode_key: str = "",
    image_role: str = "",
) -> dict:
    if surface == "canvas":
        if kind == "video_backend":
            return _video_backend_billing_params(explicit_params)
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
    del user
    model = _generation_credit_cost_model(kind, value)
    if not model:
        raise HTTPException(status_code=400, detail="generation model is not configured")
    parsed_params = _parse_billing_params(params)
    quote = await get_credit_quote().generation_credit_quote(
        kind=_generation_billing_kind(kind),
        model=model,
        params=_default_billing_params(
            kind=kind,
            surface=surface,
            value=value,
            model=model,
            explicit_params=parsed_params,
            mode_key=_clean_query_value(mode_key),
            image_role=_clean_query_value(image_role),
        ),
        quantity=_clean_quantity(quantity),
    )
    data = {
        "cost": quote.total_cost,
        "display": _display_credit_cost(quote.total_cost),
    }
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

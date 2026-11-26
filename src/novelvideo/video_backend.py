"""Shared identifiers for video generation backends."""

DEFAULT_MAINLINE_VIDEO_MODEL = "seedance-2.0-fast"
DEFAULT_MAINLINE_VIDEO_BACKEND = f"newapi_{DEFAULT_MAINLINE_VIDEO_MODEL}"

RETIRED_SEEDANCE_MODELS = frozenset({
    "seedance-1.0-pro",
    "seedance-1.0-pro-fast",
    "seedance-1.5-pro",
})
_RETIRED_VIDEO_BACKEND_IDS = {
    *RETIRED_SEEDANCE_MODELS,
    "doubao-seedance-1-0-pro-250528",
    "doubao-seedance-1-0-pro-fast-251015",
    "doubao-seedance-1-5-pro-251215",
    "seedance_fast",
    "seedance_pro",
    "seedance_pro_silent",
    "seedance_1.0_pro_fast",
    "seedance10_fast",
    "seedance15_pro",
}


def is_retired_video_backend(backend: str | None) -> bool:
    model = str(backend or "").strip().casefold()
    for prefix in ("newapi_", "huimeng_", "huimengi_"):
        if model.startswith(prefix):
            model = model.removeprefix(prefix).strip()
            break
    return model in _RETIRED_VIDEO_BACKEND_IDS

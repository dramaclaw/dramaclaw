"""Shared speed factors for video enhancement quotes and execution."""

SLOWDOWN_FACTORS = {"auto": 1, "2x": 2, "3x": 3, "4x": 4, "5x": 5}


def slowdown_factor(value: str) -> int:
    try:
        return SLOWDOWN_FACTORS[value]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"unsupported slowdown: {value}") from exc


def is_topaz_backend(backend: str) -> bool:
    """Identify the public Topaz processing models, including gateway prefixes."""
    return backend.removeprefix("newapi_") in {
        "topaz-video-upscale", "topaz/upscale/video/precision",
        "topaz-video-frame-rate", "topaz/interpolate/video",
    }

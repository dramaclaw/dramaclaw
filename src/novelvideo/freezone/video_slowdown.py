"""Shared speed factors for video enhancement quotes and execution."""

SLOWDOWN_FACTORS = {"auto": 1, "2x": 2, "3x": 3, "4x": 4, "5x": 5}


def slowdown_factor(value: str) -> int:
    try:
        return SLOWDOWN_FACTORS[value]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"unsupported slowdown: {value}") from exc


def topaz_requires_frame_rate(target_fps: float | None, slowdown: str) -> bool:
    """Precision handles explicit FPS up to 60; Apollo handles retiming above it."""
    return slowdown_factor(slowdown) > 1 or (target_fps is not None and target_fps > 60)


def is_topaz_backend(backend: str) -> bool:
    """Identify the public Topaz processing models, including gateway prefixes."""
    return backend.removeprefix("newapi_") in {
        "topaz-video-upscale", "topaz/upscale/video/precision",
        "topaz-video-frame-rate", "topaz/interpolate/video",
    }

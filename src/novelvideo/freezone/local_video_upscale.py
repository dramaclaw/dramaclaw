"""Deployment policy for the private GPU video enhancement model."""

import os

LOCAL_VIDEO_UPSCALE_MODEL = "video-upscale-fast"


def is_local_video_upscale_backend(backend: str | None) -> bool:
    return str(backend or "").strip().lower().removeprefix("newapi_").strip() == LOCAL_VIDEO_UPSCALE_MODEL


def local_video_upscale_enabled() -> bool:
    return os.getenv("LOCAL_VIDEO_UPSCALE_ENABLED", "").strip().lower() == "true"

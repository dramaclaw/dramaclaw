"""Deployment policy for the private GPU video enhancement model."""

import os
import re
from urllib.parse import urlsplit

LOCAL_VIDEO_UPSCALE_MODEL = "video-upscale-fast"
LOCAL_VIDEO_UPSCALE_CLIENT_HEADER = "X-Local-Video-Upscale-Key"


def is_local_video_upscale_backend(backend: str | None) -> bool:
    return str(backend or "").strip().lower().removeprefix("newapi_").strip() == LOCAL_VIDEO_UPSCALE_MODEL


def local_video_upscale_enabled() -> bool:
    return os.getenv("LOCAL_VIDEO_UPSCALE_ENABLED", "").strip().lower() == "true"


def local_video_upscale_client_key(submit_url: str) -> str:
    """Only attach the deployment credential to its configured HTTPS gateway."""
    base = os.getenv("NEWAPI_BASE_URL", "").strip().rstrip("/")
    origin = urlsplit(base)
    if (
        not local_video_upscale_enabled() or origin.scheme != "https" or not origin.hostname
        or origin.username is not None or origin.password is not None or origin.query or origin.fragment
        or submit_url != f"{base}/video/generations"
    ):
        raise ValueError("LOCAL_VIDEO_UPSCALE_GATEWAY_MISMATCH")
    key = os.getenv("LOCAL_VIDEO_UPSCALE_CLIENT_KEY", "")
    if not re.fullmatch(r"[a-f0-9]{64}", key):
        raise ValueError("LOCAL_VIDEO_UPSCALE_CREDENTIAL_UNAVAILABLE")
    return key

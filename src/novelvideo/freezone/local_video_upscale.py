"""Enhancement plan identifiers, asynchronous budgets and legacy beta policy."""

import os
import re
from urllib.parse import urlsplit

# Compute includes queue time; the outer task also covers relay, delivery and cancellation.
LOCAL_VIDEO_UPSCALE_COMPUTE_TIMEOUT_SECONDS = 3600
LOCAL_VIDEO_UPSCALE_POLL_GRACE_SECONDS = 60
LOCAL_VIDEO_UPSCALE_DOWNLOAD_TIMEOUT_SECONDS = 900
LOCAL_VIDEO_UPSCALE_TASK_TIMEOUT_SECONDS = 4800
LOCAL_VIDEO_UPSCALE_CANCEL_TIMEOUT_SECONDS = 60

LOCAL_VIDEO_UPSCALE_MODEL = "video-upscale-fast"
LOCAL_GPU_UPSCALE_MODEL = "local-video-upscale"
LOCAL_GPU_FRAME_RATE_MODEL = "local-video-frame-rate"
LOCAL_VIDEO_UPSCALE_CLIENT_HEADER = "X-Local-Video-Upscale-Key"


def is_local_video_upscale_backend(backend: str | None) -> bool:
    return str(backend or "").strip().lower().removeprefix("newapi_").strip() in {
        LOCAL_VIDEO_UPSCALE_MODEL,
        LOCAL_GPU_UPSCALE_MODEL,
        LOCAL_GPU_FRAME_RATE_MODEL,
    }


def video_enhancement_group(entry: dict) -> str:
    """Select a business enhancement plan by its configured model identifier."""
    from novelvideo.freezone.video_slowdown import is_topaz_backend

    backend = str(entry.get("apiModel") or entry.get("api_model") or "").removeprefix(
        "newapi_"
    )
    if backend in {LOCAL_GPU_UPSCALE_MODEL, LOCAL_GPU_FRAME_RATE_MODEL}:
        return "local_gpu"
    return "topaz" if is_topaz_backend(backend) else "standard"


def local_video_upscale_enabled() -> bool:
    return os.getenv("LOCAL_VIDEO_UPSCALE_ENABLED", "").strip().lower() == "true"


def local_video_upscale_client_key(submit_url: str) -> str:
    """Only attach the deployment credential to its configured HTTPS gateway."""
    base = os.getenv("NEWAPI_BASE_URL", "").strip().rstrip("/")
    origin = urlsplit(base)
    if (
        not local_video_upscale_enabled()
        or origin.scheme != "https"
        or not origin.hostname
        or origin.username is not None
        or origin.password is not None
        or origin.query
        or origin.fragment
        or submit_url != f"{base}/video/generations"
    ):
        raise ValueError("LOCAL_VIDEO_UPSCALE_GATEWAY_MISMATCH")
    key = os.getenv("LOCAL_VIDEO_UPSCALE_CLIENT_KEY", "")
    if not re.fullmatch(r"[a-f0-9]{64}", key):
        raise ValueError("LOCAL_VIDEO_UPSCALE_CREDENTIAL_UNAVAILABLE")
    return key


class LocalVideoSubmissionPending(RuntimeError):
    code = "LOCAL_VIDEO_SUBMISSION_PENDING"

    def __init__(self, request_id: str):
        super().__init__(self.code)
        self.request_id = request_id

"""Minimal HuiMeng task API helpers.

This module intentionally keeps only the generic task/client pieces needed by
image and video callers. Higher-level generators decide model names and params.
"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
import urllib.parse
from collections.abc import Callable
from pathlib import Path

import httpx

HUIMENGI_BASE_URL = "https://api.huimengi.com"
HUIMENG_VIDEO_BACKEND_PREFIX = "huimeng_"
HUIMENG_LEGACY_VIDEO_BACKEND_PREFIX = "huimengi_"
SUPPORTED_HUIMENG_VIDEO_MODEL_NAMES = (
    "seedance-2.0-fast",
    "seedance-1.0-pro-fast",
    "seedance-1.5-pro",
)
FALLBACK_HUIMENG_VIDEO_MODELS = [
    {"name": "seedance-2.0-fast", "display_name": "Seedance 2.0 Fast"},
    {"name": "seedance-1.0-pro-fast", "display_name": "Seedance 1.0 Pro Fast"},
    {"name": "seedance-1.5-pro", "display_name": "Seedance 1.5 Pro"},
]
HUIMENG_DONE_STATUSES = {"completed", "succeeded", "success", "done"}
HUIMENG_FAILED_STATUSES = {"failed", "error", "canceled", "cancelled"}


class HuimengTaskFailed(RuntimeError):
    """HuiMeng reported a terminal failed status."""


# mimetypes 在 Windows 上读注册表(.wav -> audio/wav),与 POSIX 内置表
# (audio/x-wav)不一致;上游契约按 POSIX 值固定。
_MIME_BY_EXT = {".wav": "audio/x-wav"}


def local_file_to_data_url(path: str | Path) -> str:
    file_path = Path(path)
    mime_type = (
        _MIME_BY_EXT.get(file_path.suffix.lower())
        or mimetypes.guess_type(file_path.name)[0]
        or "application/octet-stream"
    )
    encoded = base64.b64encode(file_path.read_bytes()).decode("utf-8")
    return f"data:{mime_type};base64,{encoded}"


def bytes_to_data_url(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        mime_type = "image/png"
    elif content.startswith(b"\xff\xd8\xff"):
        mime_type = "image/jpeg"
    elif content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        mime_type = "image/webp"
    elif content.startswith((b"GIF87a", b"GIF89a")):
        mime_type = "image/gif"
    else:
        mime_type = "application/octet-stream"
    encoded = base64.b64encode(content).decode("utf-8")
    return f"data:{mime_type};base64,{encoded}"


def huimeng_video_backend_value(model_name: str) -> str:
    return f"{HUIMENG_VIDEO_BACKEND_PREFIX}{model_name}"


def parse_huimeng_video_backend(value: str | None) -> str | None:
    backend = str(value or "").strip()
    for prefix in (HUIMENG_VIDEO_BACKEND_PREFIX, HUIMENG_LEGACY_VIDEO_BACKEND_PREFIX):
        if backend.startswith(prefix):
            model_name = backend[len(prefix):].strip()
            return model_name or None
    return None


def huimeng_video_backend_options() -> dict[str, str]:
    """Return stable UI options keyed by HuiMeng video backend value."""
    fallback_by_name = {
        str(model.get("name") or "").strip(): model
        for model in FALLBACK_HUIMENG_VIDEO_MODELS
    }
    options: dict[str, str] = {}
    for name in SUPPORTED_HUIMENG_VIDEO_MODEL_NAMES:
        model = fallback_by_name[name]
        display_name = str(model.get("display_name") or name).strip()
        if not display_name.lower().startswith("huimeng "):
            display_name = f"HuiMeng {display_name}"
        options[huimeng_video_backend_value(name)] = display_name
    return options


def _compact(value, *, limit: int = 240) -> str:
    text = str(value).strip()
    return f"{text[:limit]}..." if len(text) > limit else text


def _failure_details(task: dict) -> str:
    parts: list[str] = []
    for key in (
        "task_id",
        "id",
        "status",
        "error_message",
        "error",
        "error_code",
        "reason",
        "message",
        "fail_reason",
        "failed_reason",
        "status_message",
        "msg",
        "result",
    ):
        value = task.get(key)
        if value:
            parts.append(f"{key}={_compact(value)}")
    return " | ".join(parts) or "HuiMeng task failed"


def extract_huimeng_result_url(result: dict, *preferred_keys: str) -> str:
    """Return the first URL-like string from a HuiMeng result payload."""
    if not isinstance(result, dict):
        return ""

    def url_from_value(value) -> str:
        if isinstance(value, str) and value.startswith(("http://", "https://", "data:")):
            return value
        if isinstance(value, list):
            for item in value:
                found = url_from_value(item)
                if found:
                    return found
        return ""

    for key in preferred_keys:
        found = url_from_value(result.get(key))
        if found:
            return found

    search_keys = (*preferred_keys, "url")

    def walk(value) -> str:
        if isinstance(value, dict):
            for key in search_keys:
                found = url_from_value(value.get(key))
                if found:
                    return found
            for child in value.values():
                found = walk(child)
                if found:
                    return found
        elif isinstance(value, list):
            for item in value:
                found = walk(item)
                if found:
                    return found
        return ""

    return walk(result)


def extract_huimeng_result_last_frame_url(result: dict) -> str:
    """Return a URL-like returned-last-frame image from a HuiMeng result payload."""
    if not isinstance(result, dict):
        return ""

    preferred_keys = (
        "returned_last_frame",
        "return_last_frame",
        "last_frame_output",
        "last_frame_url",
        "last_frame_image",
        "last_frame",
        "tail_frame_url",
        "tail_frame_image",
        "end_frame_url",
        "end_frame_image",
    )
    image_collection_keys = (
        "image_url",
        "image_urls",
        "images",
        "output_images",
        "last_frames",
        "frames",
    )

    def is_url(value) -> bool:
        return isinstance(value, str) and value.startswith(
            ("http://", "https://", "data:")
        )

    def looks_like_video_url(value: str) -> bool:
        if value.startswith("data:video/"):
            return True
        parsed = urllib.parse.urlparse(value)
        path = parsed.path.lower()
        return path.endswith((".mp4", ".mov", ".webm", ".mkv", ".avi"))

    def first_url(value) -> str:
        if is_url(value):
            text = str(value)
            return "" if looks_like_video_url(text) else text
        if isinstance(value, dict):
            for key in (*preferred_keys, "url", *image_collection_keys):
                found = first_url(value.get(key))
                if found:
                    return found
            for child in value.values():
                found = first_url(child)
                if found:
                    return found
        elif isinstance(value, list):
            for item in value:
                found = first_url(item)
                if found:
                    return found
        return ""

    for key in preferred_keys:
        found = first_url(result.get(key))
        if found:
            return found

    for key in image_collection_keys:
        found = first_url(result.get(key))
        if found:
            return found

    return ""


def extract_huimeng_result_duration(result: dict) -> float | None:
    """Return a nested duration value from a HuiMeng result payload if present."""
    if not isinstance(result, dict):
        return None

    def walk(value) -> float | None:
        if isinstance(value, dict):
            duration = value.get("duration")
            if duration is not None:
                try:
                    return float(duration)
                except (TypeError, ValueError):
                    pass
            for child in value.values():
                found = walk(child)
                if found is not None:
                    return found
        elif isinstance(value, list):
            for item in value:
                found = walk(item)
                if found is not None:
                    return found
        return None

    return walk(result)


def validate_huimeng_media_download(
    content: bytes,
    content_type: str | None,
    *,
    expected_media_type: str,
    url: str = "",
) -> None:
    """Reject empty or obvious non-media CDN responses before writing artifacts."""
    label = "图片" if expected_media_type == "image" else "视频"
    content_type = str(content_type or "").split(";", 1)[0].strip().lower()
    context = f" ({url})" if url else ""
    if not content:
        raise RuntimeError(f"HuiMeng 下载结果为空{context}")
    if content_type.startswith("text/") or content_type in {
        "application/json",
        "application/problem+json",
        "application/xml",
    }:
        raise RuntimeError(
            f"HuiMeng 下载结果不是有效{label}: content-type={content_type or 'unknown'}{context}"
        )
    if expected_media_type == "image":
        if content_type.startswith("image/") or content.startswith(
            (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")
        ):
            return
        if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
            return
    if expected_media_type == "video":
        if content_type.startswith("video/") or (
            len(content) >= 12 and content[4:8] == b"ftyp"
        ):
            return
        if content.startswith(b"\x1a\x45\xdf\xa3"):
            return
        if content.startswith(b"RIFF") and content[8:12] == b"AVI ":
            return
    raise RuntimeError(
        f"HuiMeng 下载结果不是有效{label}: content-type={content_type or 'unknown'}{context}"
    )


class HuimengiTaskClient:
    """Thin wrapper over HuiMeng's async task API."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 60.0,
    ):
        self.api_key = api_key or os.environ.get("HUIMENGI_API_KEY")
        self.base_url = (
            base_url or os.environ.get("HUIMENGI_BASE_URL") or HUIMENGI_BASE_URL
        ).rstrip("/")
        self.timeout = timeout
        if not self.api_key:
            raise ValueError("HUIMENGI_API_KEY must be set for HuiMeng generation")

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def submit_task(
        self,
        *,
        model: str,
        params: dict,
        idempotency_key: str | None = None,
    ) -> dict:
        body = {"model": model, "params": params}
        if idempotency_key:
            body["idempotency_key"] = idempotency_key
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}/api/v1/tasks",
                headers=self.headers,
                json=body,
            )
        if response.status_code != 200:
            raise RuntimeError(
                f"HuiMeng submit failed: HTTP {response.status_code} - {response.text}"
            )
        data = response.json()
        if not data.get("task_id"):
            raise RuntimeError(f"HuiMeng submit response missing task_id: {data}")
        return data

    async def get_task(self, task_id: str) -> dict:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{self.base_url}/api/v1/tasks/{task_id}",
                headers=self.headers,
            )
        if response.status_code != 200:
            raise RuntimeError(
                f"HuiMeng task query failed: HTTP {response.status_code} - {response.text}"
            )
        return response.json()

    async def wait_for_completion(
        self,
        task_id: str,
        *,
        poll_interval: float = 2.0,
        max_polls: int = 290,
        on_log: Callable[[str], None] | None = None,
        on_progress: Callable[[float], None] | None = None,
    ) -> dict:
        for poll_count in range(max_polls):
            task = await self.get_task(task_id)
            status = str(task.get("status") or "").lower()
            if on_progress:
                on_progress(0.2 + (poll_count / max(max_polls, 1)) * 0.7)
            if status in HUIMENG_DONE_STATUSES:
                if on_progress:
                    on_progress(0.9)
                return task
            if status in HUIMENG_FAILED_STATUSES:
                raise HuimengTaskFailed(_failure_details(task))
            if on_log and poll_count % 6 == 0:
                on_log(
                    f"HuiMeng task {task_id} status: "
                    f"{status or 'pending'} ({poll_count}/{max_polls})"
                )
            if poll_interval > 0:
                await asyncio.sleep(poll_interval)
        raise TimeoutError("Timeout waiting for HuiMeng task completion")

    async def download_url(self, url: str, output_path: str) -> bytes:
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as client:
            response = await client.get(url)
        if response.status_code != 200:
            raise RuntimeError(f"HuiMeng result download failed: HTTP {response.status_code}")
        validate_huimeng_media_download(
            response.content,
            response.headers.get("content-type"),
            expected_media_type="video",
            url=url,
        )
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(response.content)
        return response.content

    async def download_image_url(self, url: str, output_path: str) -> bytes:
        async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as client:
            response = await client.get(url)
        if response.status_code != 200:
            raise RuntimeError(
                f"HuiMeng image download failed: HTTP {response.status_code}"
            )
        validate_huimeng_media_download(
            response.content,
            response.headers.get("content-type"),
            expected_media_type="image",
            url=url,
        )
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(response.content)
        return response.content

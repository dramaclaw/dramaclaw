"""Public model identities and supported options for enhancement workflows."""

import math
from typing import Any

CLAYMORE_PROCESSING_MODELS = {
    "video_upscale": "claymore-video-upscale",
    "video_frame_rate": "claymore-video-frame-rate",
}
CLAYMORE_PROCESSING_RESOLUTIONS = {
    "video_upscale": ("1080p", "2k", "4k"),
    "video_frame_rate": ("1080p",),
}


def processing_model_name(backend: str | None) -> str:
    return str(backend or "").removeprefix("newapi_")


def is_claymore_processing_model(backend: str | None) -> bool:
    return processing_model_name(backend) in CLAYMORE_PROCESSING_MODELS.values()


def claymore_source_error(
    source: dict[str, Any],
    resolution: str,
    *,
    frame_rate: bool = False,
) -> str | None:
    """Validate the public models' supported source profiles before quoting."""
    fps, seconds = float(source["fps"]), float(source["duration"])
    width, height = int(source["width"]), int(source["height"])
    if not math.isfinite(fps) or not 1 <= fps <= 30:
        return "虾驿视频增强仅支持 1–30 FPS 的源视频"
    if not math.isfinite(seconds) or not 0 < seconds <= 120:
        return "虾驿视频增强仅支持最长 120 秒的视频"
    if min(width, height) < 64 or max(width, height) > 1920 or width % 2 or height % 2:
        return "虾驿视频增强仅支持宽高为偶数、最小边至少 64 且长边不超过 1920 像素的视频"
    if source.get("hdr") is True or source.get("constant_frame_rate") is False:
        return "虾驿视频增强仅支持 SDR 恒定帧率视频"
    if source.get("pixel_format") and source["pixel_format"] not in {"yuv420p", "yuvj420p"}:
        return "虾驿视频增强仅支持 8 位 YUV420 视频"
    if source.get("field_order") not in {None, "unknown", "progressive"}:
        return "虾驿视频增强仅支持逐行扫描视频"
    if (
        source.get("sample_aspect_ratio") not in {None, "N/A", "1:1"}
        or source.get("rotated") is True
    ):
        return "虾驿视频增强仅支持方形像素、无旋转标记的视频"
    if resolution == "4k" and (fps != 24 or width * height > 1024 * 1024):
        return "虾驿 4K 超分仅支持 24 FPS、最多 1048576 像素的源视频"
    if frame_rate and (resolution != "1080p" or fps not in (24, 30)):
        return "虾驿补帧仅支持 1080P、24/30 FPS 到 60 FPS 的原速处理"
    return None

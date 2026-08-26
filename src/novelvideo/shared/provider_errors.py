"""Provider-facing business error normalization."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

CONTENT_MODERATION_FAILED_CODE = "CONTENT_MODERATION_FAILED"
CONTENT_MODERATION_FAILED_MESSAGE = "图片生成结果未通过内容审核，请调整提示词后重试"
INPUT_IMAGE_POLICY_FAILED_MESSAGE = "参考图片未通过版权或内容安全审核，请更换参考图后重试。"
OUTPUT_VIDEO_POLICY_FAILED_MESSAGE = (
    "视频生成结果未通过版权或内容安全审核，请调整提示词或参考素材后重试。"
)
COPYRIGHT_POLICY_FAILED_MESSAGE = (
    "生成内容可能涉及版权限制，未通过平台审核。请调整提示词或更换参考素材后重试。"
)
OUTPUT_AUDIO_POLICY_FAILED_MESSAGE = (
    "生成音频可能包含敏感内容，未通过平台审核。请更换音频或调整描述后重试。"
)

# DramaClawAPI（视频网关）在任务失败报文里给的枚举码。组织账号的出口路径会把厂商
# 原文整个抹掉（原文里可能带签名的 relay URL），但这些枚举码本身不含秘密，必须放行，
# 否则用户只能看到 `EGRESS_OPERATION_UNKNOWN`——2026-08-26 3060 上 338x191 的参考图
# 被火山 HeightTooSmall 连拒 8 次，用户就是这么被蒙住的。
VIDEO_MEDIA_DIMENSIONS_INVALID_CODE = "VIDEO_MEDIA_DIMENSIONS_INVALID"
VIDEO_MEDIA_DIMENSIONS_INVALID_MESSAGE = (
    "参考素材尺寸不符合要求：图片宽度和高度需在 300 至 6000 像素之间，"
    "请更换参考图后重试。"
)
VIDEO_CONTENT_COPYRIGHT_RESTRICTED_CODE = "VIDEO_CONTENT_COPYRIGHT_RESTRICTED"
VIDEO_OUTPUT_AUDIO_SENSITIVE_CODE = "VIDEO_OUTPUT_AUDIO_SENSITIVE"

# 只认「全大写枚举」形态的 VIDEO_* 码；任何带空格/小写/标点的东西都当自由文本拒掉。
_PROVIDER_VIDEO_ERROR_CODE_RE = re.compile(r"VIDEO_[A-Z0-9]+(?:_[A-Z0-9]+)*")
# 网关 HTTP 错误体（JSON）或 Python repr 里的 `"code": "VIDEO_*"`。
_PROVIDER_VIDEO_ERROR_BODY_CODE_RE = re.compile(
    r"[\"']code[\"']\s*:\s*[\"'](VIDEO_[A-Z0-9_]+)[\"']"
)
# 网关只给自由文本（`error_message`）时，按厂商原话里的关键字归类。
_PROVIDER_VIDEO_ERROR_TEXT_MARKERS: tuple[tuple[str, str], ...] = (
    ("heighttoosmall", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("widthtoosmall", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("heighttoolarge", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("widthtoolarge", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("must be between 300px and 6000px", VIDEO_MEDIA_DIMENSIONS_INVALID_CODE),
    ("copyright restrictions", VIDEO_CONTENT_COPYRIGHT_RESTRICTED_CODE),
    ("output audio may contain sensitive", VIDEO_OUTPUT_AUDIO_SENSITIVE_CODE),
)
# 已知码 → 给用户看的 (error_code, message)。版权/敏感沿用前端已经认识的
# CONTENT_MODERATION_FAILED，尺寸问题单独一个码，方便前端以后做针对性引导。
_PROVIDER_VIDEO_ERROR_PRESENTATION: dict[str, tuple[str, str]] = {
    VIDEO_MEDIA_DIMENSIONS_INVALID_CODE: (
        VIDEO_MEDIA_DIMENSIONS_INVALID_CODE,
        VIDEO_MEDIA_DIMENSIONS_INVALID_MESSAGE,
    ),
    VIDEO_CONTENT_COPYRIGHT_RESTRICTED_CODE: (
        CONTENT_MODERATION_FAILED_CODE,
        COPYRIGHT_POLICY_FAILED_MESSAGE,
    ),
    VIDEO_OUTPUT_AUDIO_SENSITIVE_CODE: (
        CONTENT_MODERATION_FAILED_CODE,
        OUTPUT_AUDIO_POLICY_FAILED_MESSAGE,
    ),
}
_KNOWN_PROVIDER_VIDEO_ERROR_RE = re.compile(
    r"\b(" + "|".join(re.escape(code) for code in _PROVIDER_VIDEO_ERROR_PRESENTATION) + r")\b"
)

_CONTENT_MODERATION_MARKERS = (
    "output_moderation",
    "inputimagesensitivecontentdetected.policyviolation",
    "outputvideosensitivecontentdetected.policyviolation",
    "copyright restrictions",
)


def is_content_moderation_error(
    exc: BaseException | None = None,
    message: str = "",
) -> bool:
    text = " ".join(part for part in (str(exc) if exc else "", message) if part).lower()
    return any(marker in text for marker in _CONTENT_MODERATION_MARKERS)


def content_moderation_message(exc: BaseException | None = None, message: str = "") -> str:
    text = " ".join(part for part in (str(exc) if exc else "", message) if part).lower()
    if "inputimagesensitivecontentdetected.policyviolation" in text:
        return INPUT_IMAGE_POLICY_FAILED_MESSAGE
    if "outputvideosensitivecontentdetected.policyviolation" in text:
        return OUTPUT_VIDEO_POLICY_FAILED_MESSAGE
    if "copyright restrictions" in text:
        return COPYRIGHT_POLICY_FAILED_MESSAGE
    return CONTENT_MODERATION_FAILED_MESSAGE


def content_moderation_payload(exc: BaseException | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "error_code": CONTENT_MODERATION_FAILED_CODE,
        "message": content_moderation_message(exc),
    }
    if exc is not None:
        payload["provider_error"] = str(exc)[:2000]
    return payload


def safe_provider_video_error_code(code: object) -> str:
    """网关给的 `code` 字段是纯枚举的 VIDEO_* 才原样返回，否则返回空串。"""
    text = str(code or "").strip()
    if len(text) > 64 or not _PROVIDER_VIDEO_ERROR_CODE_RE.fullmatch(text):
        return ""
    return text


def provider_video_error_code_from_text(text: str) -> str:
    """从厂商/网关自由文本里提取安全的 VIDEO_* 码；认不出返回空串，原文绝不回传。"""
    if not text:
        return ""
    match = _PROVIDER_VIDEO_ERROR_BODY_CODE_RE.search(text)
    if match:
        code = safe_provider_video_error_code(match.group(1))
        if code:
            return code
    lowered = text.lower()
    for marker, code in _PROVIDER_VIDEO_ERROR_TEXT_MARKERS:
        if marker in lowered:
            return code
    return ""


def classify_provider_video_task_error(task: Mapping[str, Any]) -> str:
    """把网关「任务失败」报文归成安全的 VIDEO_* 码，认不出返回空串。

    报文有两种形态：`error: {code, message}`，或只有 `error_message` 自由文本
    （里面可能带签名的 relay URL）。只有枚举码会被返回，文本只用来识别关键字。
    """
    error = task.get("error")
    if isinstance(error, Mapping):
        code = safe_provider_video_error_code(error.get("code"))
        if code:
            return code
        message = error.get("message")
    else:
        message = error
    text = " ".join(
        str(part)
        for part in (message, task.get("fail_reason"), task.get("error_message"))
        if part
    )
    return provider_video_error_code_from_text(text)


def provider_video_error_payload(exc: BaseException) -> dict[str, Any] | None:
    """异常文本里带已知 VIDEO_* 码时，给出结构化的用户可读失败；否则 None。"""
    match = _KNOWN_PROVIDER_VIDEO_ERROR_RE.search(str(exc))
    if not match:
        return None
    error_code, message = _PROVIDER_VIDEO_ERROR_PRESENTATION[match.group(1)]
    return {
        "error_code": error_code,
        "message": message,
        "provider_error": str(exc)[:2000],
    }


__all__ = [
    "CONTENT_MODERATION_FAILED_CODE",
    "CONTENT_MODERATION_FAILED_MESSAGE",
    "COPYRIGHT_POLICY_FAILED_MESSAGE",
    "INPUT_IMAGE_POLICY_FAILED_MESSAGE",
    "OUTPUT_AUDIO_POLICY_FAILED_MESSAGE",
    "OUTPUT_VIDEO_POLICY_FAILED_MESSAGE",
    "VIDEO_CONTENT_COPYRIGHT_RESTRICTED_CODE",
    "VIDEO_MEDIA_DIMENSIONS_INVALID_CODE",
    "VIDEO_MEDIA_DIMENSIONS_INVALID_MESSAGE",
    "VIDEO_OUTPUT_AUDIO_SENSITIVE_CODE",
    "classify_provider_video_task_error",
    "content_moderation_message",
    "content_moderation_payload",
    "is_content_moderation_error",
    "provider_video_error_code_from_text",
    "provider_video_error_payload",
    "safe_provider_video_error_code",
]

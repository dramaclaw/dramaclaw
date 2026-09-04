"""Business errors for video-prompt media prerequisites."""

from __future__ import annotations


VIDEO_PROMPT_PREREQUISITE_REQUIRED_CODE = "VIDEO_PROMPT_PREREQUISITE_REQUIRED"


class VideoPromptPrerequisiteError(ValueError):
    error_code = VIDEO_PROMPT_PREREQUISITE_REQUIRED_CODE


def video_prompt_prerequisite_response(
    exc: VideoPromptPrerequisiteError,
) -> dict[str, str | bool]:
    return {
        "ok": False,
        "code": exc.error_code,
        "error": str(exc),
    }

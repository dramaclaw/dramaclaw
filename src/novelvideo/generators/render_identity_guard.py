"""Render preflight checks for sketch AI identity detection."""

from collections.abc import Iterable
from typing import Any

from novelvideo.models import NO_CHARACTER_MARKER, real_detected_identities


def _beat_get(beat: Any, key: str, default: Any = None) -> Any:
    if isinstance(beat, dict):
        return beat.get(key, default)
    return getattr(beat, key, default)


def _has_identity_detection_state(beat: Any) -> bool:
    identities = _beat_get(beat, "detected_identities", None)
    if isinstance(identities, str):
        identities = [identities]
    try:
        values = [str(item or "").strip() for item in (identities or [])]
    except TypeError:
        return False
    return NO_CHARACTER_MARKER in values or bool(real_detected_identities(values))


class RenderIdentityDetectionRequired(RuntimeError):
    """A render beat has no identity detection state; the user must mark it first."""

    error_code = "RENDER_IDENTITY_DETECTION_REQUIRED"


def render_ai_detection_error(
    beats: Iterable[Any] | None = None,
    *,
    standalone_beat_context: bool = False,
) -> str | None:
    """Return an error when any render beat has no explicit identity detection state."""
    beat_list = list(beats or [])
    missing = [beat for beat in beat_list if not _has_identity_detection_state(beat)]
    if not missing:
        return None
    if standalone_beat_context:
        # 画布独立镜头没有剧集 beat 可去「草图」检测，beat 号恒为 0，只能在节点上改。
        return (
            "渲染分镜前请先在「镜头上下文」节点的「出场身份」里选择出场角色。"
            "如果确实没有出场角色，请选择「无角色出场」。"
        )
    beat_numbers = ", ".join(f"#{_beat_get(beat, 'beat_number', '?')}" for beat in missing)
    return (
        "Render 前请先到「草图」点击「AI 检测」识别出场身份，"
        "或在「更多 > 出场身份」手工标注。"
        f"以下 beat 尚未检测/标注：{beat_numbers}。"
        "如果确实没有出场角色，请选择「无角色出场」。"
    )

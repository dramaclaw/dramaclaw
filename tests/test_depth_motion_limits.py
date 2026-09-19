"""深度动作捕捉的帧数上限:按清晰度分档。

这些是纯函数,不碰 torch / DA3 / GPU,所以在任何机器上都能跑。
"""

from __future__ import annotations

from novelvideo.freezone.depth_motion_worker import (
    DEFAULT_RESOLUTION,
    RESOLUTION_FRAME_LIMITS,
    _too_long_message,
    frame_limit_for,
)


def test_each_resolution_has_its_own_limit() -> None:
    """原本是 750 帧一刀切,480P 被 720P 的成本曲线拖着一起限死。"""
    assert RESOLUTION_FRAME_LIMITS["480p"] > RESOLUTION_FRAME_LIMITS["720p"]


def test_higher_resolution_gets_the_tighter_cap() -> None:
    """成本是像素数 x 帧数:单帧越贵,能容忍的帧数必须越少。这条反了等于没有上限。"""
    ordered = sorted(RESOLUTION_FRAME_LIMITS.items(), key=lambda kv: int(kv[0].rstrip("p")))
    for (_low, low_limit), (_high, high_limit) in zip(ordered, ordered[1:]):
        assert high_limit < low_limit


def test_unknown_resolution_falls_back_to_the_strictest_default() -> None:
    """清晰度来自请求体。拿到不认识的值要回落到默认档,而不是 KeyError。"""
    assert frame_limit_for("4k") == RESOLUTION_FRAME_LIMITS[DEFAULT_RESOLUTION]
    assert frame_limit_for("") == RESOLUTION_FRAME_LIMITS[DEFAULT_RESOLUTION]
    assert frame_limit_for("720P") == RESOLUTION_FRAME_LIMITS["720p"]  # 大小写不敏感


def test_message_points_at_the_looser_tier() -> None:
    """超限报错要给可行动的下一步:720P 超了就告诉他 480P 能跑多长。"""
    message = _too_long_message(RESOLUTION_FRAME_LIMITS["720p"], "720p")
    assert "720P" in message
    assert "480P" in message
    assert str(RESOLUTION_FRAME_LIMITS["480p"]) in message


def test_message_for_the_loosest_tier_does_not_suggest_a_tighter_one() -> None:
    """已经在最宽的档位上了,再建议换档就是误导——只该让他裁剪。"""
    message = _too_long_message(RESOLUTION_FRAME_LIMITS["480p"], "480p")
    assert "720P" not in message
    assert "裁剪" in message

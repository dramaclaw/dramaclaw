from __future__ import annotations

import pytest

from dramaclaw_blender.core.limits import (
    MAX_VIDEO_SECONDS,
    LimitError,
    check_frame_range,
    resolution_for,
)


def test_landscape_short_side_is_the_cap():
    # 1920x1080 的场景挑 720P：短边 720，长边按 16:9 推回 1280。
    assert resolution_for(1920, 1080, 720) == (1280, 720)


def test_portrait_keeps_being_portrait():
    # 竖屏 9:16 挑 720P：短边（宽）720，高 1280。LibTV 固定横屏，我们不能跟。
    assert resolution_for(1080, 1920, 720) == (720, 1280)


def test_square_stays_square():
    assert resolution_for(1000, 1000, 1080) == (1080, 1080)


def test_odd_result_is_rounded_up_to_even():
    # 1001:1000 的长边算出来是 1081，H.264 要偶数边，进位到 1082。
    assert resolution_for(1001, 1000, 1080) == (1082, 1080)


def test_scene_smaller_than_the_target_is_still_scaled_up():
    # 档位是「渲染成多大」，不是「最多多大」——用户挑了 1080P 就给 1080P。
    assert resolution_for(640, 360, 1080) == (1920, 1080)


def test_degenerate_scene_size_is_rejected():
    with pytest.raises(LimitError):
        resolution_for(0, 1080, 720)


def test_frame_range_within_limit_passes():
    # 24fps 下 30 秒是 720 帧，闭区间 1..720 正好 720 帧。
    check_frame_range(1, 720, fps=24.0)


def test_frame_range_one_frame_over_is_rejected():
    with pytest.raises(LimitError) as excinfo:
        check_frame_range(1, 721, fps=24.0)
    assert "30" in str(excinfo.value)


def test_frame_range_respects_actual_fps():
    # 60fps 下 30 秒是 1800 帧；别把 24 写死。
    check_frame_range(1, 1800, fps=60.0)
    with pytest.raises(LimitError):
        check_frame_range(1, 1801, fps=60.0)


def test_reversed_frame_range_is_rejected():
    with pytest.raises(LimitError):
        check_frame_range(100, 50, fps=24.0)


def test_max_video_seconds_is_thirty():
    assert MAX_VIDEO_SECONDS == 30

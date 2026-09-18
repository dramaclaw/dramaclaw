"""投递前的限额换算与校验。

全部是纯函数：面板在用户点按钮之前调它们，渲染一帧都还没开始。渲完再说「超了」
是最糟的交互——几分钟白等，而所有需要的数字在点之前就都知道了。
"""

from __future__ import annotations

MAX_VIDEO_SECONDS = 30
MAX_VIDEO_BYTES = 200 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024


class LimitError(ValueError):
    """参数不满足投递限制。消息直接给用户看，写成人话。"""


def _even(value: int) -> int:
    # H.264 要求宽高都是偶数。向上取整而不是向下，免得 719 这种值把短边档位
    # 悄悄降一级。
    return value if value % 2 == 0 else value + 1


def resolution_for(
    scene_width: int,
    scene_height: int,
    short_side: int,
) -> tuple[int, int]:
    """按场景现有宽高比，把**短边**定到 `short_side`。

    档位「720P / 1080P」指的是短边，不是宽。竖屏 9:16 挑 720P 得到 720x1280，
    仍然是竖的；LibTV 固定 1280x720，对短剧不适用。
    """
    if scene_width <= 0 or scene_height <= 0:
        raise LimitError("场景分辨率必须是正数")

    if scene_width <= scene_height:
        width = short_side
        height = round(short_side * scene_height / scene_width)
    else:
        height = short_side
        width = round(short_side * scene_width / scene_height)
    return _even(int(width)), _even(int(height))


def check_frame_range(start: int, end: int, *, fps: float) -> None:
    """闭区间 `start..end` 的帧数不得超过 `MAX_VIDEO_SECONDS`。"""
    if end < start:
        raise LimitError("帧范围的结束帧不能小于起始帧")
    if fps <= 0:
        raise LimitError("帧率必须是正数")

    frames = end - start + 1
    max_frames = int(MAX_VIDEO_SECONDS * fps)
    if frames > max_frames:
        raise LimitError(
            f"最长 {MAX_VIDEO_SECONDS} 秒：{fps:g}fps 下最多 {max_frames} 帧，"
            f"当前选了 {frames} 帧"
        )

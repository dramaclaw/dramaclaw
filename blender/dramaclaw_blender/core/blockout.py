"""白模渲染要设成什么。

这些值本身没有 bpy 依赖，抽出来是为了能测。`render.py` 负责把它们灌到场景上。
"""

from __future__ import annotations

RENDER_ENGINE = "BLENDER_WORKBENCH"


def shading_settings() -> dict:
    """Workbench 的着色设置：均匀浅灰，靠 cavity 看出体积。

    `show_cavity` 不是可选项：关掉之后凸面和凹面是同一个灰，整个白模糊成一坨，
    看不出转折——而白模的用处恰恰就是看体块关系。
    """
    return {
        "light": "STUDIO",
        "color_type": "SINGLE",
        "single_color": (0.8, 0.8, 0.8),
        "show_cavity": True,
    }


def ffmpeg_settings() -> dict:
    """视频编码设置。

    `audio_codec` 显式设成 NONE：Blender 默认会往 MP4 里写一条静音音轨，
    白模视频不需要，留着只是每段多几百 KB。
    """
    return {
        "format": "MPEG4",
        "codec": "H264",
        "audio_codec": "NONE",
    }

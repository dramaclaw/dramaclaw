"""投递文件名。

这里的消毒是**给用户看的体面**，不是安全边界：服务端收到后仍会过一遍
`sanitize_upload_filename`。插件端做这一道，是为了让素材库里的名字可读、可排序，
而不是为了防谁。
"""

from __future__ import annotations

import re

FALLBACK_CAMERA_NAME = "camera"
MAX_CAMERA_NAME_LENGTH = 48

_ALLOWED = re.compile(r"[^A-Za-z0-9._-]")


def sanitize_camera_name(raw: str | None) -> str:
    """把相机名压成 ASCII 安全字符。

    非 ASCII（比如中文相机名）不硬转写，直接退回 `camera`——猜一个音译出来，
    用户在素材库里既认不出也搜不到，不如给个稳定的名字。
    """
    name = (raw or "").strip()
    if not name:
        return FALLBACK_CAMERA_NAME
    if ".." in name:
        # 带 .. 的名字不试图挽救。把 "../../etc/passwd" 洗成 ".._.._etc_passwd"
        # 技术上安全，但素材库里出现这种名字只会让人以为出了 bug。
        return FALLBACK_CAMERA_NAME

    name = _ALLOWED.sub("_", name)[:MAX_CAMERA_NAME_LENGTH]
    if not name.strip("._-"):
        # 全是分隔符，比如中文名被逐字替换成 "___"。
        return FALLBACK_CAMERA_NAME
    return name


def still_filename(camera: str | None, frame: int, timestamp: str) -> str:
    return f"blockout_{sanitize_camera_name(camera)}_frame_{frame}_{timestamp}.png"


def video_filename(camera: str | None, start: int, end: int, timestamp: str) -> str:
    return f"blockout_{sanitize_camera_name(camera)}_{start}-{end}_{timestamp}.mp4"

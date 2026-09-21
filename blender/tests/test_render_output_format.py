"""`render._set_output_format`：Blender 5.x 把视频格式挪到了 `media_type` 后面。

`render.py` 顶层 import bpy，这里临时塞个空壳进 `sys.modules` 让它能被 import；
被测函数只碰传进来的 image_settings，不碰 bpy。空壳和 render 模块用完都得撤掉——
`test_package_imports_without_bpy` 断言的就是 `sys.modules` 里没有 bpy。
"""

from __future__ import annotations

import importlib
import sys
import types

import pytest


@pytest.fixture
def set_output_format(monkeypatch):
    monkeypatch.setitem(sys.modules, "bpy", types.ModuleType("bpy"))
    monkeypatch.delitem(sys.modules, "dramaclaw_blender.render", raising=False)
    render = importlib.import_module("dramaclaw_blender.render")
    yield render._set_output_format
    sys.modules.pop("dramaclaw_blender.render", None)
    package = sys.modules["dramaclaw_blender"]
    if getattr(package, "render", None) is render:
        delattr(package, "render")


_IMAGE_FORMATS = {"PNG", "JPEG", "OPEN_EXR"}


class Blender5ImageSettings:
    """照 5.2 实测行为：`file_format` 的可选项跟着 `media_type` 走。"""

    def __init__(self, media_type: str = "IMAGE", file_format: str = "PNG") -> None:
        object.__setattr__(self, "media_type", media_type)
        object.__setattr__(self, "file_format", file_format)

    def __setattr__(self, key: str, value: str) -> None:
        if key == "file_format":
            allowed = {"FFMPEG"} if self.media_type == "VIDEO" else _IMAGE_FORMATS
            if value not in allowed:
                raise TypeError(f'enum "{value}" not found in {sorted(allowed)}')
        object.__setattr__(self, key, value)


class Blender4ImageSettings:
    """3.6–4.x：没有 `media_type`，视频格式就在 `file_format` 里。"""

    file_format = "PNG"


def test_blender5_video_needs_media_type_first(set_output_format):
    settings = Blender5ImageSettings()
    set_output_format(settings, media_type="VIDEO", file_format="FFMPEG")
    assert (settings.media_type, settings.file_format) == ("VIDEO", "FFMPEG")


def test_blender5_still_after_user_scene_outputs_video(set_output_format):
    # 场景副本继承用户设置：用户本来在出视频，也得能切回 PNG。
    settings = Blender5ImageSettings(media_type="VIDEO", file_format="FFMPEG")
    set_output_format(settings, media_type="IMAGE", file_format="PNG")
    assert (settings.media_type, settings.file_format) == ("IMAGE", "PNG")


def test_blender5_direct_assignment_is_the_bug():
    with pytest.raises(TypeError):
        Blender5ImageSettings().file_format = "FFMPEG"


@pytest.mark.parametrize("file_format", ["FFMPEG", "PNG"])
def test_older_blender_without_media_type(set_output_format, file_format):
    settings = Blender4ImageSettings()
    set_output_format(settings, media_type="VIDEO", file_format=file_format)
    assert settings.file_format == file_format
    assert not hasattr(settings, "media_type")

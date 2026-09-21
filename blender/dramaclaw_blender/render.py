"""白模渲染。

核心决定：**不改用户的场景，复制一份。** `scene.copy()` 是浅拷贝——物体、材质、
动画全部共享，复制的只是场景级设置（引擎、分辨率、输出路径、帧范围）。渲完把副本
删掉，用户的场景一个字节都没动过。

比起「先存下 12 个属性、改、渲完再写回去」，这个做法的好处是漏不掉：没有需要写回
的东西。而漏掉一个属性的后果是用户的渲染设置被悄悄改了，他既不知道发生过什么，也
不知道去哪儿改回来。
"""

from __future__ import annotations

import os
import shutil
import tempfile

import bpy

from .core import blockout
from .core.limits import resolution_for

_SCENE_PREFIX = "DramaClaw-Blockout"
_TEMP_PREFIX = "dramaclaw-blockout-"


def make_blockout_scene(
    source: bpy.types.Scene,
    *,
    camera: bpy.types.Object,
    short_side: int,
    frame_start: int | None = None,
    frame_end: int | None = None,
    animation: bool = False,
) -> tuple[bpy.types.Scene, str]:
    """造一个只为这次渲染存在的场景。返回 `(场景, 输出路径)`。"""
    scene = source.copy()
    scene.name = f"{_SCENE_PREFIX}-{os.getpid()}"

    scene.render.engine = blockout.RENDER_ENGINE
    for key, value in blockout.shading_settings().items():
        setattr(scene.display.shading, key, value)

    width, height = resolution_for(
        source.render.resolution_x, source.render.resolution_y, short_side
    )
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.camera = camera

    scene.render.film_transparent = False
    scene.render.use_overwrite = True
    scene.render.use_file_extension = True

    directory = tempfile.mkdtemp(prefix=_TEMP_PREFIX)
    if animation:
        scene.frame_start = frame_start
        scene.frame_end = frame_end
        _set_output_format(
            scene.render.image_settings, media_type="VIDEO", file_format="FFMPEG"
        )
        for key, value in blockout.ffmpeg_settings().items():
            setattr(scene.render.ffmpeg, key, value)
        output = os.path.join(directory, "blockout")
    else:
        _set_output_format(
            scene.render.image_settings, media_type="IMAGE", file_format="PNG"
        )
        scene.render.image_settings.color_mode = "RGB"
        output = os.path.join(directory, "blockout.png")

    scene.render.filepath = output
    return scene, output


def _set_output_format(image_settings, *, media_type: str, file_format: str) -> None:
    """设输出格式，兼容 Blender 5.x 把它拆成了两级。

    5.x 起先有 `media_type`（IMAGE / MULTI_LAYER_IMAGE / VIDEO），`file_format` 的可选项
    跟着它变：`media_type` 不是 VIDEO 时枚举里根本没有 `FFMPEG`，直接赋值就是
    `TypeError: enum "FFMPEG" not found`（5.2 真机上踩过）。反方向也一样——场景副本
    继承了用户的输出设置，用户场景要是本来就输出视频，不先切回 IMAGE 就设不上 PNG。

    插件声明支持到 3.6，那时候还没有 `media_type`，只能按属性在不在来分支。
    """
    if hasattr(image_settings, "media_type"):
        image_settings.media_type = media_type
    image_settings.file_format = file_format


def discard_blockout_scene(scene: bpy.types.Scene) -> None:
    """删掉副本场景。物体是共享的，删场景不会删掉用户的东西。"""
    if scene and scene.name in bpy.data.scenes:
        bpy.data.scenes.remove(scene, do_unlink=True)


def discard_output_dir(output_path: str) -> None:
    """删掉 `make_blockout_scene` 开的那个临时目录。

    只在渲染结果已经读进内存（或压根没渲出来）之后调。不删的后果不是「多占点盘」：
    macOS 的 /var/folders 三天才清，Windows 的 %TEMP% 永不自动清，用户投二十次就是
    二十份完整视频躺在那儿。

    只删名字对得上的目录——万一 `output_path` 被改成指向别处，这里不该跟着 rmtree。
    """
    if not output_path:
        return
    directory = os.path.dirname(output_path)
    if not os.path.basename(directory).startswith(_TEMP_PREFIX):
        return
    shutil.rmtree(directory, ignore_errors=True)


def find_rendered_file(output_path: str, *, animation: bool) -> str | None:
    """找出 Blender 实际写出的那个文件。

    动画输出时 Blender 会自己往文件名后面贴帧范围和扩展名（`blockout0001-0250.mp4`），
    所以不能直接用我们给的路径去读。
    """
    if not animation:
        return output_path if os.path.exists(output_path) else None

    directory = os.path.dirname(output_path)
    prefix = os.path.basename(output_path)
    candidates = [
        os.path.join(directory, name)
        for name in os.listdir(directory)
        if name.startswith(prefix)
    ]
    return max(candidates, key=os.path.getmtime) if candidates else None


def scene_fps(scene: bpy.types.Scene) -> float:
    """Blender 的帧率是 `fps / fps_base`，29.97 这种就藏在 base 里。"""
    return scene.render.fps / scene.render.fps_base

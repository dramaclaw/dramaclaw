"""View3D > Sidebar > DramaClaw。

面板上写清楚限制（分辨率、时长、大小），因为用户点下按钮之后就要等好几分钟。
渲完才说「超了」是最糟的交互，而所有需要的数字在点之前就都知道。
"""

from __future__ import annotations

import bpy

from .core.limits import (
    MAX_IMAGE_BYTES,
    MAX_VIDEO_BYTES,
    MAX_VIDEO_SECONDS,
    LimitError,
    resolution_for,
)
from .ops import PROJECT_CACHE
from .prefs import get_prefs

_SHORT_SIDE_ITEMS = [
    ("720", "720P", "短边 720"),
    ("1080", "1080P", "短边 1080"),
]


def register_scene_props() -> None:
    bpy.types.Scene.dramaclaw_short_side = bpy.props.EnumProperty(
        name="分辨率",
        items=_SHORT_SIDE_ITEMS,
        default="720",
    )


def unregister_scene_props() -> None:
    del bpy.types.Scene.dramaclaw_short_side


class DRAMACLAW_MT_projects(bpy.types.Menu):
    """项目下拉。

    用菜单而不是动态 `EnumProperty`：后者的 items 回调必须自己持有返回字符串的引用，
    否则 Blender 会读到已释放的内存、菜单显示成乱码。菜单里画 operator 没有这个坑。
    """

    bl_label = "项目"
    bl_idname = "DRAMACLAW_MT_projects"

    def draw(self, context):
        layout = self.layout
        if not PROJECT_CACHE:
            layout.label(text="先点右边的刷新")
            return
        for name in PROJECT_CACHE:
            layout.operator("dramaclaw.set_project", text=name).name = name


class DRAMACLAW_PT_panel(bpy.types.Panel):
    bl_label = "DramaClaw"
    bl_idname = "DRAMACLAW_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "DramaClaw"

    def draw(self, context):
        layout = self.layout
        prefs = get_prefs(context)
        scene = context.scene

        if not prefs.token:
            layout.operator("dramaclaw.connect", icon="LINKED")
            if prefs.last_error:
                # 配对是在定时器里收尾的，那边没有 operator 能 report。这是失败
                # 原因唯一能露头的地方。
                layout.label(text=prefs.last_error, icon="ERROR")
            else:
                layout.label(text="连接后才能导入", icon="INFO")
            return

        row = layout.row(align=True)
        row.menu("DRAMACLAW_MT_projects", text=prefs.project or "选择项目")
        row.operator("dramaclaw.refresh_projects", text="", icon="FILE_REFRESH")
        layout.prop(scene, "dramaclaw_short_side")

        camera = scene.camera
        if camera is None:
            layout.label(text="场景里没有激活的相机", icon="ERROR")
            return

        box = layout.box()
        box.label(text=f"相机：{camera.name}")
        try:
            width, height = resolution_for(
                scene.render.resolution_x,
                scene.render.resolution_y,
                int(scene.dramaclaw_short_side),
            )
        except LimitError as exc:
            # draw() 里抛异常整个面板就没了，连「断开」都点不到。宁可少画一行。
            box.label(text=f"输出：算不出（{exc}）", icon="ERROR")
        else:
            box.label(text=f"输出：{width}×{height}")
        box.label(text=f"图片 PNG · 最大 {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
        box.label(
            text=(
                f"视频 H.264 · 最长 {MAX_VIDEO_SECONDS} 秒 · "
                f"最大 {MAX_VIDEO_BYTES // (1024 * 1024)} MB"
            )
        )

        layout.operator("dramaclaw.deliver_still", icon="RENDER_STILL")
        layout.operator("dramaclaw.deliver_video", icon="RENDER_ANIMATION")
        layout.label(text=f"帧范围 {scene.frame_start}–{scene.frame_end}")

        local = layout.box()
        local.operator("dramaclaw.deliver_local_video", icon="FILE_MOVIE")
        # 直说读不出这些，而不是留白让人以为插件检查过。
        local.label(text="已渲好的文件：不读相机/帧率，只查扩展名与大小")

"""插件偏好设置：服务器地址、令牌、当前项目。

令牌存在 AddonPreferences 里，也就是用户的 Blender 配置文件里——跟 .blend 文件
无关。这是有意的：.blend 会被发给别人、被提交进仓库，令牌跟着走就等于泄露。
"""

from __future__ import annotations

import bpy

DEFAULT_SERVER = "http://127.0.0.1:19081"


class DramaClawPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__

    server_url: bpy.props.StringProperty(
        name="服务器地址",
        default=DEFAULT_SERVER,
    )
    token: bpy.props.StringProperty(
        name="令牌",
        default="",
        subtype="PASSWORD",
    )
    project: bpy.props.StringProperty(
        name="项目",
        default="",
    )
    last_error: bpy.props.StringProperty(
        # 配对是在 `bpy.app.timers` 的回调里收尾的，那里没有 operator 可以
        # `self.report()`。失败原因只能落到这里，由面板画出来——否则配对码过期时
        # 界面上一个字都不会变，用户只会一直点「连接」。
        name="上次错误",
        default="",
        options={"SKIP_SAVE"},
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "server_url")
        row = layout.row()
        row.enabled = False
        row.label(text="已连接" if self.token else "未连接")
        if self.token:
            layout.operator("dramaclaw.disconnect", icon="UNLINKED")


def get_prefs(context) -> DramaClawPreferences:
    return context.preferences.addons[__package__].preferences


def api_url(context, path: str) -> str:
    base = get_prefs(context).server_url.rstrip("/")
    return f"{base}/api/v1{path}"

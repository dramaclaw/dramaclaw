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
    web_url: bpy.props.StringProperty(
        # 页面和接口不一定同源。生产由 nginx 合到一个源上，这里留空即可；开发
        # 环境后端在 19081、页面在 vite 的 5174，不填就会把用户送去后端吃 404。
        name="网页地址",
        description="留空则与服务器地址相同。开发环境请填前端地址",
        default="",
    )
    token: bpy.props.StringProperty(
        name="令牌",
        default="",
        subtype="PASSWORD",
    )
    project: bpy.props.StringProperty(
        # 存的是项目 **id**，投递地址拼的就是它；名字只拿来显示，见下面 project_name。
        name="项目",
        default="",
    )
    project_name: bpy.props.StringProperty(
        # 只用于面板显示。下拉框的缓存重启 Blender 就没了，没有它面板上只能画出一串
        # id。老版本存下的 `project` 是名字而这里是空的——投递前据此当作「没选项目」。
        name="项目名",
        default="",
    )
    open_canvas_after_import: bpy.props.BoolProperty(
        name="导入后打开画布页",
        description="投递成功后在浏览器里打开该项目的画布，并定位到刚导入的节点",
        default=True,
    )
    pending_code: bpy.props.StringProperty(
        # 配对码过去只在状态栏报一次就没了，而库里只存哈希，错过就再也拿不回来，
        # 用户只能反复点「连接」。它必须留在面板上，直到配对有结果。
        name="配对码",
        default="",
        options={"SKIP_SAVE"},
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
        layout.prop(self, "web_url")
        layout.prop(self, "open_canvas_after_import")
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

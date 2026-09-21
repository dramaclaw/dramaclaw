"""集中注册/反注册。

`__init__.py` 顶层不能 import bpy（`core/` 要在没有 Blender 的 CI 里可导入），
所以真正的 bpy 依赖从这个模块开始。
"""

from __future__ import annotations

from pathlib import Path

import bpy

from . import ops, panel, prefs
from .core.bundled_config import load_bundled_config, seeded_values

_CLASSES = (
    prefs.DramaClawPreferences,
    ops.DRAMACLAW_OT_connect,
    ops.DRAMACLAW_OT_disconnect,
    ops.DRAMACLAW_OT_refresh_projects,
    ops.DRAMACLAW_OT_set_project,
    ops.DRAMACLAW_OT_deliver_still,
    ops.DRAMACLAW_OT_deliver_video,
    ops.DRAMACLAW_OT_deliver_local_video,
    panel.DRAMACLAW_MT_projects,
    panel.DRAMACLAW_PT_panel,
)


def _seed_from_bundled_config() -> None:
    """把随包配置里的地址填进偏好设置。

    整段吞掉异常：这只是个省事功能，不值得为它让插件装不上。真出问题，用户手填地址
    就能继续用，而一个 `register()` 里抛出的异常会让整个插件直接启用失败。
    """
    try:
        addon_prefs = bpy.context.preferences.addons[__package__].preferences
        config, reason = load_bundled_config(Path(__file__).resolve().parent)
        if reason:
            # register() 里没有 operator 可以 self.report()，处境跟 prefs.py:44-51
            # 说的配对定时器回调一模一样：错误只能写进 last_error，由 panel.py:83
            # 画出来。而且那行只在「未连接」分支画——刚装完没配对正是这个状态，
            # 也正是随包配置唯一起作用的时刻，位置刚好。
            addon_prefs.last_error = f"随包配置读取失败：{reason}"
            return
        values = seeded_values(
            config,
            current_server_url=addon_prefs.server_url,
            current_web_url=addon_prefs.web_url,
        )
        for key, value in values.items():
            setattr(addon_prefs, key, value)
    except Exception:  # noqa: BLE001
        pass


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    panel.register_scene_props()
    # 必须排在注册之后：偏好设置要等 DramaClawPreferences 注册完才拿得到。
    _seed_from_bundled_config()


def unregister() -> None:
    panel.unregister_scene_props()
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)

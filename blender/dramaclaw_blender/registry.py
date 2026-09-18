"""集中注册/反注册。

`__init__.py` 顶层不能 import bpy（`core/` 要在没有 Blender 的 CI 里可导入），
所以真正的 bpy 依赖从这个模块开始。
"""

from __future__ import annotations

import bpy

from . import ops, panel, prefs

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


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    panel.register_scene_props()


def unregister() -> None:
    panel.unregister_scene_props()
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)

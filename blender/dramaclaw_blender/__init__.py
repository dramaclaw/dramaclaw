"""DramaClaw 素材导入（Blender 插件）。

顶层刻意**不** `import bpy`：`core/` 里的纯逻辑要在没有 Blender 的 CI 里被测到，
而 import 子模块会先执行这个文件。Blender 只要求 `register()` / `unregister()`
可调用，不要求模块顶层就把 bpy 拉进来，所以真正的 import 推迟到 `register()`。
"""

from __future__ import annotations

bl_info = {
    "name": "DramaClaw 素材导入",
    "author": "DramaClaw",
    "version": (0, 1, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > DramaClaw",
    "description": "把 Blender 里的白模渲染直接投递到 DramaClaw 项目",
    "category": "Import-Export",
}


def register() -> None:
    from . import registry

    registry.register()


def unregister() -> None:
    from . import registry

    registry.unregister()

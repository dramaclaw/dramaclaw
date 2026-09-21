"""DramaClaw 素材导入（Blender 插件）。

顶层刻意**不** `import bpy`：`core/` 里的纯逻辑要在没有 Blender 的 CI 里被测到，
而 import 子模块会先执行这个文件。Blender 只要求 `register()` / `unregister()`
可调用，不要求模块顶层就把 bpy 拉进来，所以真正的 import 推迟到 `register()`。
"""

from __future__ import annotations

bl_info = {
    "name": "DramaClaw 素材导入",
    "author": "DramaClaw",
    "version": (0, 1, 2),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > DramaClaw",
    "description": "把 Blender 里的白模渲染直接投递到 DramaClaw 项目",
    "category": "Import-Export",
}


def _purge_stale_submodules() -> None:
    """把自己的子模块从 `sys.modules` 里清掉，逼下面的 import 重新读盘。

    覆盖安装（Install from Disk 装一个新版本盖住旧版本）时，Blender 只
    `importlib.reload()` 这个 `__init__.py`，不碰已经加载过的子模块。于是
    `register()` 里那句 `from . import registry` 命中的是旧版本留在 `sys.modules`
    里的模块对象——磁盘上的新代码一行都不会执行，而且全程不报任何错：面板照画、
    投递照走，只有新版本加的东西静悄悄地没生效。实测过一次，表现是点「连接」被送到
    后端端口吃 404，因为随包配置里的 `web_url` 从没被写进偏好设置。

    所以这里主动清一遍。只清 `dramaclaw_blender.` 开头的，**不清包自身**：那是正在
    执行的这个模块，抽走它等于让 Blender 手里的引用和 `sys.modules` 里的对象分家。
    前缀带上那个点，顺手也避免误伤 `dramaclaw_blender_extra` 这种同前缀的名字。

    **只删 `sys.modules` 是不够的**，而且会把事情弄得更糟：`from . import registry`
    会先看包对象上有没有 `registry` 属性，有就直接用、根本不去 import。那个属性还指着
    旧模块，于是拿到的仍是旧代码——但它的模块已经被从 `sys.modules` 里删掉了，
    `bpy.utils.register_class` 走 `typing.get_type_hints` 时按 `cls.__module__` 回查
    globals 会查空，注解里的 `bpy` 当场 `NameError`，插件直接启用失败。所以两边都得删。

    清完只是丢掉缓存，旧模块对象本身还活着——比如配对轮询挂在
    `bpy.app.timers` 上的回调仍持有它，不会因为这里清了缓存就失效。
    """
    import sys

    package = sys.modules[__name__]
    prefix = __name__ + "."
    for name in [name for name in sys.modules if name.startswith(prefix)]:
        del sys.modules[name]
        # `dramaclaw_blender.core.pairing` 只需要摘掉包上的 `core`：`core` 重新 import
        # 出来是个全新模块对象，它自己的属性表本来就是空的。
        attr = name[len(prefix) :].partition(".")[0]
        if hasattr(package, attr):
            delattr(package, attr)


def register() -> None:
    # 必须排在 import 之前：先 import 就已经用上旧模块了，再清等于没清。
    _purge_stale_submodules()

    from . import registry

    registry.register()


def unregister() -> None:
    from . import registry

    registry.unregister()

"""插件包必须能在没有 Blender 的环境里导入。

`core/` 里的纯逻辑全靠这一条保证可测：只要有人在 `__init__.py` 顶层写了
`import bpy`，CI 里这条就红，问题当场暴露，而不是等到有人想给 `core/` 补测试
时才发现根本 import 不进来。
"""

from __future__ import annotations

import importlib
import pkgutil
import sys


def test_package_imports_without_bpy():
    assert "bpy" not in sys.modules
    import dramaclaw_blender

    assert dramaclaw_blender.bl_info["name"] == "DramaClaw 素材导入"
    assert "bpy" not in sys.modules


def test_core_imports_without_bpy():
    """把 `core/` 下每个子模块都真 import 一遍。

    只 import `dramaclaw_blender.core` 是抓不住人的：`core/__init__.py` 里只有注释，
    一个子模块都不会被加载，这条断言等于没跑。所以用 `pkgutil` 走一遍包目录。

    为什么用动态遍历而不是手写一份模块名单：名单要靠人记得维护，而新加的模块正是
    最可能不小心 `import bpy` 的那个——恰恰是名单漏掉它的时候。遍历目录则是新模块
    一落盘就自动被盯上，零维护。

    用 `walk_packages` 而不是 `iter_modules`：后者只列出子包、不往里走，`core/` 哪天
    分出子目录，里面的 `import bpy` 就会从这条守护底下漏过去（实测过：种一个
    `core/_pkg/inner.py` 写 `import bpy`，`iter_modules` 版本照样全绿）。`core/` 现在
    是扁平的，所以这是补缺口，不是修现存 bug——但「零维护」这句话得是真的。
    """
    import dramaclaw_blender.core as core

    names = [name for _, name, _ in pkgutil.walk_packages(core.__path__, f"{core.__name__}.")]
    assert names, "core/ 下一个子模块都没找到，这条测试等于空跑"
    for name in names:
        importlib.import_module(name)

    assert "bpy" not in sys.modules

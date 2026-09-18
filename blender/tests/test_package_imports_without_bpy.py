"""插件包必须能在没有 Blender 的环境里导入。

`core/` 里的纯逻辑全靠这一条保证可测：只要有人在 `__init__.py` 顶层写了
`import bpy`，CI 里这条就红，问题当场暴露，而不是等到有人想给 `core/` 补测试
时才发现根本 import 不进来。
"""

from __future__ import annotations

import sys


def test_package_imports_without_bpy():
    assert "bpy" not in sys.modules
    import dramaclaw_blender

    assert dramaclaw_blender.bl_info["name"] == "DramaClaw 素材导入"
    assert "bpy" not in sys.modules


def test_core_imports_without_bpy():
    import dramaclaw_blender.core  # noqa: F401

    assert "bpy" not in sys.modules

"""覆盖安装之后，`register()` 必须跑新代码而不是内存里的旧模块。

这条守的是一个只在真 Blender 里才会发作、而且不报任何错的 bug：

用户装着 0.1.1，下载 0.1.2 的 zip「Install from Disk」覆盖上去。Blender 会
`importlib.reload()` 顶层的 `__init__.py`（控制台里能看到
`module changed on disk: .../__init__.py reloading...`），但**只 reload 这一个文件**。
`register()` 里那句 `from . import registry` 命中的是 `sys.modules` 里 0.1.1 留下的
模块对象——磁盘上的新 `registry.py` 一行都不会执行。

发作起来完全没有声音：面板照画、投递照走，只是新版本加的东西（比如随包配置里的
`web_url`）静悄悄地没生效，用户点「连接」被送到后端端口上吃一个 404。这也是它必须
由测试盯住的原因——人工验收时它看起来跟「功能没写」一模一样。

所以 `register()` 第一件事就是把自己的子模块从 `sys.modules` 里清掉，逼下面的
import 重新读盘。
"""

from __future__ import annotations

import sys

import dramaclaw_blender


def test_purge_drops_own_submodules():
    sentinel = object()
    sys.modules["dramaclaw_blender.registry"] = sentinel  # type: ignore[assignment]
    sys.modules["dramaclaw_blender.core.pairing"] = sentinel  # type: ignore[assignment]
    try:
        dramaclaw_blender._purge_stale_submodules()
        assert "dramaclaw_blender.registry" not in sys.modules
        assert "dramaclaw_blender.core.pairing" not in sys.modules
    finally:
        sys.modules.pop("dramaclaw_blender.registry", None)
        sys.modules.pop("dramaclaw_blender.core.pairing", None)


def test_purge_keeps_the_package_itself_and_strangers():
    """只清自己的子模块。

    连包自身一起清掉，`register()` 就是在把正在执行自己的那个模块对象从
    `sys.modules` 里抽走——Blender 拿着的还是旧对象，`unregister()` 之后再 enable
    会变成两个包对象并存。前缀必须带上那个点，`dramaclaw_blender_extra` 这种名字
    也不能误伤。
    """
    sentinel = object()
    sys.modules["dramaclaw_blender_extra"] = sentinel  # type: ignore[assignment]
    try:
        dramaclaw_blender._purge_stale_submodules()
        assert sys.modules["dramaclaw_blender"] is dramaclaw_blender
        assert sys.modules["dramaclaw_blender_extra"] is sentinel
    finally:
        sys.modules.pop("dramaclaw_blender_extra", None)


def test_purge_also_drops_the_attribute_on_the_package():
    """光清 `sys.modules` 不够，包对象上的属性也得摘掉。

    `from . import registry` 会先看包对象有没有 `registry` 属性，有就直接拿来用、
    根本不触发 import。只清 `sys.modules` 的话，拿到的仍是旧模块——而且比不清更糟：
    它的模块名已经不在 `sys.modules` 里了，`bpy.utils.register_class` 走
    `typing.get_type_hints` 按 `cls.__module__` 回查 globals 会查空，注解里的 `bpy`
    当场 `NameError`，插件直接启用失败。真 Blender 里踩过这一脚。
    """
    sentinel = object()
    sys.modules["dramaclaw_blender.registry"] = sentinel  # type: ignore[assignment]
    dramaclaw_blender.registry = sentinel  # type: ignore[attr-defined]
    try:
        dramaclaw_blender._purge_stale_submodules()
        assert not hasattr(dramaclaw_blender, "registry")
    finally:
        sys.modules.pop("dramaclaw_blender.registry", None)
        if hasattr(dramaclaw_blender, "registry"):
            del dramaclaw_blender.registry  # type: ignore[attr-defined]


def test_register_purges_before_importing_registry():
    """顺序不能反。

    清理必须排在 `from . import registry` 之前：反过来就是先把旧模块用了一遍，
    再去清一个已经用完的缓存，等于没清。单测 `_purge_stale_submodules` 本身是测不出
    这个顺序的，所以这里直接读源码。
    """
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(dramaclaw_blender.register))
    body = tree.body[0].body  # type: ignore[attr-defined]
    steps: list[str] = []
    for node in body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            func = node.value.func
            if isinstance(func, ast.Name):
                steps.append(func.id)
        elif isinstance(node, ast.ImportFrom):
            steps.append("import " + ", ".join(alias.name for alias in node.names))

    assert steps.index("_purge_stale_submodules") < steps.index("import registry")

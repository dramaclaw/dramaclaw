"""Store 生命周期：工厂初始化失败也要关，scope 出了 ``async with`` 一定关。

每个 ``SQLiteStore`` 背后是一条 aiosqlite 连接加一个后台线程。漏关不会立刻报错，
只会在压测或长跑里表现成连接数和线程数单调上涨——所以这里的断言全部落在
"``close()`` 被调用了几次"上，而不是落在返回值。

工厂那条尤其容易漏：``*_scope`` 的 ``try/finally`` 只对**工厂成功返回的**实例负责。
``initialize()`` 已经把连接打开、``load_graph_state()`` 随后抛错时，实例还没交给任
何人，scope 的 ``finally`` 根本看不见它。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest


class _FakeStore:
    """记账用的假 store：只关心 init 步骤抛不抛、close 被调用几次。"""

    instances: list["_FakeStore"] = []

    def __init__(self, *_args, fail_on: str | None = None, **_kwargs):
        self.fail_on = fail_on
        self.initialized = False
        self.graph_loaded = False
        self.close_calls = 0
        _FakeStore.instances.append(self)

    async def initialize(self):
        if self.fail_on == "initialize":
            raise RuntimeError("boom in initialize")
        self.initialized = True

    async def load_graph_state(self):
        if self.fail_on == "load_graph_state":
            raise RuntimeError("boom in load_graph_state")
        self.graph_loaded = True

    async def close(self):
        self.close_calls += 1


def _install_fake_store(monkeypatch, *, fail_on: str | None = None):
    """把工厂内部 ``from novelvideo.sqlite_store import SQLiteStore`` 换成假货。"""
    import novelvideo.sqlite_store as sqlite_store_module

    _FakeStore.instances.clear()
    monkeypatch.setattr(
        sqlite_store_module,
        "SQLiteStore",
        lambda *a, **kw: _FakeStore(*a, fail_on=fail_on, **kw),
    )


def _ctx(tmp_path: Path):
    return SimpleNamespace(
        project_id="proj_demo",
        owner_project_label="demo",
        output_dir=tmp_path,
        state_dir=tmp_path,
        is_home_node=True,
    )


@pytest.fixture
def deps_module(monkeypatch):
    # 函数内 import：``tests/contract/test_m01_auth.py`` 会把 ``novelvideo.api.*``
    # 整片从 ``sys.modules`` 里弹掉再以 CE 模式重建 app，模块级绑定到那时已经是个
    # 死对象，打在上面的 patch 会静默落空。
    from novelvideo.api import deps

    # 工厂里这一步只做归属校验，和本文件要验的生命周期无关。
    monkeypatch.setattr(deps, "require_project_home_node", lambda ctx, operation="": None)
    return deps


async def test_context_factory_closes_store_when_load_graph_state_raises(
    deps_module, monkeypatch, tmp_path
):
    """初始化窗口：连接已经开了，第二步抛错，实例还没交出去——必须自己关掉。"""
    _install_fake_store(monkeypatch, fail_on="load_graph_state")

    with pytest.raises(RuntimeError, match="boom in load_graph_state"):
        await deps_module.make_sqlite_store_for_context(_ctx(tmp_path))

    (store,) = _FakeStore.instances
    assert store.initialized is True, "前提：连接确实开了，否则这条用例没在测它想测的东西"
    assert store.close_calls == 1


async def test_context_factory_closes_store_when_initialize_raises(
    deps_module, monkeypatch, tmp_path
):
    _install_fake_store(monkeypatch, fail_on="initialize")

    with pytest.raises(RuntimeError, match="boom in initialize"):
        await deps_module.make_sqlite_store_for_context(_ctx(tmp_path))

    (store,) = _FakeStore.instances
    assert store.close_calls == 1


async def test_context_factory_skips_graph_state_but_still_closes_on_init_failure(
    deps_module, monkeypatch, tmp_path
):
    """``load_graph_state=False`` 是 ``/beats`` 走的分支，别在这条上漏掉收口。"""
    _install_fake_store(monkeypatch, fail_on="initialize")

    with pytest.raises(RuntimeError):
        await deps_module.make_sqlite_store_for_context(
            _ctx(tmp_path), load_graph_state=False
        )

    (store,) = _FakeStore.instances
    assert store.graph_loaded is False
    assert store.close_calls == 1


async def test_ce_factory_closes_store_when_load_graph_state_raises(
    deps_module, monkeypatch, tmp_path
):
    """CE 路径（按 username/project 开库）享有同样的保证。"""
    _install_fake_store(monkeypatch, fail_on="load_graph_state")
    monkeypatch.setattr(deps_module, "get_output_dir", lambda u, p: str(tmp_path))
    monkeypatch.setattr(deps_module, "get_state_dir", lambda u, p: str(tmp_path))

    with pytest.raises(RuntimeError, match="boom in load_graph_state"):
        await deps_module.make_sqlite_store("admin", "demo")

    (store,) = _FakeStore.instances
    assert store.close_calls == 1


async def test_successful_factory_does_not_close_the_store_it_returns(
    deps_module, monkeypatch, tmp_path
):
    """反向哨兵：别把"出错就关"写成"总是关"，那样调用方拿到的是条死连接。"""
    _install_fake_store(monkeypatch)

    store = await deps_module.make_sqlite_store_for_context(_ctx(tmp_path))

    assert store.initialized is True
    assert store.graph_loaded is True
    assert store.close_calls == 0


async def test_context_scope_closes_on_normal_exit(deps_module, monkeypatch, tmp_path):
    _install_fake_store(monkeypatch)

    async with deps_module.sqlite_store_for_context_scope(_ctx(tmp_path)) as store:
        assert store.close_calls == 0

    assert store.close_calls == 1


async def test_context_scope_closes_when_the_body_raises(deps_module, monkeypatch, tmp_path):
    _install_fake_store(monkeypatch)

    with pytest.raises(RuntimeError, match="body blew up"):
        async with deps_module.sqlite_store_for_context_scope(_ctx(tmp_path)) as store:
            raise RuntimeError("body blew up")

    assert store.close_calls == 1


async def test_context_scope_leaves_no_store_open_when_init_fails(
    deps_module, monkeypatch, tmp_path
):
    """scope 的 ``finally`` 看不见初始化失败的实例，这条守的就是工厂那层的兜底。"""
    _install_fake_store(monkeypatch, fail_on="load_graph_state")

    with pytest.raises(RuntimeError, match="boom in load_graph_state"):
        async with deps_module.sqlite_store_for_context_scope(_ctx(tmp_path)):
            pytest.fail("不该进到 body：工厂就已经抛了")

    (store,) = _FakeStore.instances
    assert store.close_calls == 1

"""Linux 沙箱“装了 binary 还得能真建起来”的运行时降级行为。

#346 P1①:CE 镜像现按 TARGETARCH 装 codex-linux-sandbox + bubblewrap。但"binary 在"
不等于"沙箱能建"——宿主内核缺 unprivileged user namespaces 时 bwrap 运行时才失败。
本测试钉住运行时执行边界：
- ``_wrap_linux`` 的一次性探针:binary 缺 / binary 在但探针失败,都走同一套
  ``_fallback_or_raise`` 决策(EE 拒绝、CE 单租户 opt-in 降级)。

平台无关:直接调 ``_wrap_linux`` 并 monkeypatch 探针,不依赖真跑 Linux 沙箱。
"""

from pathlib import Path

import pytest

from novelvideo.security import sandbox_wrap
from novelvideo.security.sandbox_wrap import SandboxSpec

@pytest.fixture(autouse=True)
def _clear_probe_cache():
    sandbox_wrap._SANDBOX_PROBE_CACHE.clear()
    yield
    sandbox_wrap._SANDBOX_PROBE_CACHE.clear()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    # 每个用例自定沙箱必需/opt-in/Linux 激活,先清干净,避免宿主 .env / CI runner 干扰。
    # 尤其 SUPERTALE_LINUX_SANDBOX:设过它的机器会让"默认未激活"用例失去默认语义,
    # 需要激活的用例自己显式 setenv。
    monkeypatch.delenv("SUPERTALE_ENV", raising=False)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("SUPERTALE_ALLOW_UNSANDBOXED", raising=False)
    monkeypatch.delenv("SUPERTALE_LINUX_SANDBOX", raising=False)


def _spec(tmp_path: Path) -> SandboxSpec:
    return SandboxSpec(user="probe", hermes_home=tmp_path / ".hermes")


def _present_binary(monkeypatch, tmp_path: Path) -> Path:
    """让 `_wrap_linux` 认为 binary 存在:which 返回一个真实存在的文件。"""
    fake = tmp_path / "codex-linux-sandbox"
    fake.write_text("#!/bin/true\n")
    monkeypatch.setattr(sandbox_wrap.shutil, "which", lambda _n: str(fake))
    return fake


# ---- _wrap_linux:Linux 沙箱是"显式激活"的(默认不激活,#346 P1②)----

def test_wrap_linux_not_activated_by_default_failcloses_on_ee(monkeypatch, tmp_path):
    # 默认不设 SUPERTALE_LINUX_SANDBOX:即便 binary 在、探针会成功,也不包裹——
    # 因为 codex restricted 的 root:read 让同宿主 peer 数据可读,读隔离只能在部署层
    # (只挂当前用户切片)关掉。EE 宁可 fail-close 也不带着"假读隔离"上线。
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: True)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")  # EE/多租户
    with pytest.raises(RuntimeError, match="sandbox required"):
        sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))


def test_wrap_linux_not_activated_by_default_degrades_on_ce_optin(monkeypatch, tmp_path):
    # 未激活 + CE 单租户 + opt-in:走同一 _fallback_or_raise → 降级裸跑(单租户无跨用户风险)。
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: True)
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")
    with pytest.warns(RuntimeWarning, match="UNSANDBOXED"):
        out = sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))
    assert out == ["hermes", "run"]


# ---- _wrap_linux:已激活 + binary 存在 + 探针成功 → 真包裹 ----

def test_wrap_linux_wraps_when_sandbox_usable(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERTALE_LINUX_SANDBOX", "1")  # 显式激活(部署已挂单用户切片)
    fake = _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: True)
    out = sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))
    assert out[0] == str(fake)
    assert "--" in out
    assert out[-2:] == ["hermes", "run"]


# ---- _wrap_linux:已激活但探针失败 → 与"binary 缺失"同样的降级/拒绝 ----

def test_present_but_unusable_degrades_on_ce_optin(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERTALE_LINUX_SANDBOX", "1")
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: False)
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")  # CE 单租户降级阀门
    with pytest.warns(RuntimeWarning, match="UNSANDBOXED"):
        out = sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))
    assert out == ["hermes", "run"]  # 未包裹:降级裸跑


def test_present_but_unusable_failcloses_on_ee(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERTALE_LINUX_SANDBOX", "1")
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: False)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")  # EE/多租户
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")  # 对 EE 无效
    with pytest.raises(RuntimeError, match="sandbox required"):
        sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))


def test_missing_binary_still_failcloses_on_ce_without_optin(monkeypatch, tmp_path):
    # binary 缺失在激活判定之前就短路,与激活开关无关。
    monkeypatch.setattr(sandbox_wrap.shutil, "which", lambda _n: None)
    # /usr/local/bin/codex-linux-sandbox 在 mac 上不存在 → 视为缺失;未 opt-in → 拒绝
    with pytest.raises(RuntimeError, match="SUPERTALE_ALLOW_UNSANDBOXED"):
        sandbox_wrap._wrap_linux(["hermes"], _spec(tmp_path))


# ---- _sandbox_can_run:一次性探针 + 缓存 ----

def test_sandbox_can_run_caches_by_binary(monkeypatch):
    calls = {"n": 0}

    class _Proc:
        returncode = 0

    def _fake_run(*_a, **_k):
        calls["n"] += 1
        return _Proc()

    monkeypatch.setattr(sandbox_wrap.subprocess, "run", _fake_run)
    assert sandbox_wrap._sandbox_can_run("/x/codex-linux-sandbox") is True
    assert sandbox_wrap._sandbox_can_run("/x/codex-linux-sandbox") is True
    assert calls["n"] == 1  # 第二次命中缓存,不再 spawn


def test_sandbox_can_run_false_when_probe_nonzero(monkeypatch):
    class _Proc:
        returncode = 1

    monkeypatch.setattr(sandbox_wrap.subprocess, "run", lambda *_a, **_k: _Proc())
    assert sandbox_wrap._sandbox_can_run("/y/codex-linux-sandbox") is False


def test_sandbox_can_run_false_on_oserror(monkeypatch):
    def _boom(*_a, **_k):
        raise OSError("no such kernel feature")

    monkeypatch.setattr(sandbox_wrap.subprocess, "run", _boom)
    assert sandbox_wrap._sandbox_can_run("/z/codex-linux-sandbox") is False

"""Linux 沙箱"装了 binary 还得能真建起来"的运行时/启动门行为。

#346 P1①:CE 镜像现按 TARGETARCH 装 codex-linux-sandbox + bubblewrap。但"binary 在"
不等于"沙箱能建"——宿主内核缺 unprivileged user namespaces 时 bwrap 运行时才失败。
本测试钉住两处执行:
- ``_wrap_linux`` 的一次性探针:binary 缺 / binary 在但探针失败,都走同一套
  ``_fallback_or_raise`` 决策(EE 拒绝、CE 单租户 opt-in 降级)。
- 启动门 ``deploy/hermes_sandbox_selfcheck.py`` 的退出码语义(0=放行 / 非0=拒绝启动)。

平台无关:直接调 ``_wrap_linux`` 并 monkeypatch 探针,不依赖真跑 Linux 沙箱。
"""

import importlib.util
from pathlib import Path

import pytest

from novelvideo.security import sandbox_wrap
from novelvideo.security.sandbox_wrap import SandboxSpec

REPO_ROOT = Path(__file__).resolve().parents[1]
SELFCHECK_PATH = REPO_ROOT / "deploy" / "hermes_sandbox_selfcheck.py"


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


# ---- 启动门脚本 deploy/hermes_sandbox_selfcheck.py 的退出码 ----

def _load_gate():
    spec = importlib.util.spec_from_file_location("_hermes_gate", SELFCHECK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_gate_refuses_when_wrap_raises(monkeypatch):
    # wrap_command 抛错 = fail-close(EE 或 CE 无 opt-in)→ 拒绝启动。
    monkeypatch.setattr(
        sandbox_wrap, "wrap_command",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("sandbox required")),
    )
    gate = _load_gate()
    assert gate.main() == gate._REFUSE_FAILCLOSE


def test_gate_boots_on_ce_degrade(monkeypatch):
    # wrap_command 返回原样(未包裹)= CE 降级已被允许 → 放行启动(0)。
    monkeypatch.setattr(sandbox_wrap, "wrap_command", lambda cmd, _spec: list(cmd))
    gate = _load_gate()
    assert gate.main() == gate._BOOT


def test_gate_boots_when_sandbox_usable(monkeypatch):
    # wrap_command 返回真包裹 + 沙箱内 /bin/true 成功 → 放行启动(0)。
    monkeypatch.setattr(
        sandbox_wrap, "wrap_command",
        lambda cmd, _spec: ["/fake/codex-linux-sandbox", "--", *cmd],
    )

    class _Proc:
        returncode = 0
        stdout = ""
        stderr = ""

    import subprocess as _sp

    monkeypatch.setattr(_sp, "run", lambda *_a, **_k: _Proc())
    gate = _load_gate()
    assert gate.main() == gate._BOOT


# ---- [P2] gate 与 wrapper 的降级判定必须同源:CE 无 opt-in 的三条异常路径都拒绝 ----
# 回归 lywaterman 复审:旧 gate 三处(import-fail / launch-fail / probe 非0)只看
# `_sandbox_required()`,CE 单租户但**没** opt-in 时会 `not required → 降级放行`,
# 比 `_fallback_or_raise`(该场景 raise)更宽松。现在统一走 `_may_degrade()`。


def _wrapped_but_launch_raises(monkeypatch):
    monkeypatch.setattr(
        sandbox_wrap, "wrap_command",
        lambda cmd, _spec: ["/fake/codex-linux-sandbox", "--", *cmd],
    )
    import subprocess as _sp

    def _boom(*_a, **_k):
        raise OSError("cannot launch")

    monkeypatch.setattr(_sp, "run", _boom)


def _wrapped_but_probe_nonzero(monkeypatch):
    monkeypatch.setattr(
        sandbox_wrap, "wrap_command",
        lambda cmd, _spec: ["/fake/codex-linux-sandbox", "--", *cmd],
    )

    class _Proc:
        returncode = 1
        stdout = ""
        stderr = "bwrap: no user namespaces"

    import subprocess as _sp

    monkeypatch.setattr(_sp, "run", lambda *_a, **_k: _Proc())


def test_gate_refuses_import_fail_on_ce_without_optin(monkeypatch):
    # 连 wrapper 都导不进来 + CE 无 opt-in → 拒绝(不再默默降级放行)。
    monkeypatch.delattr(sandbox_wrap, "wrap_command", raising=False)
    gate = _load_gate()
    assert gate.main() == gate._REFUSE_FAILCLOSE


def test_gate_degrades_import_fail_on_ce_optin(monkeypatch):
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")
    monkeypatch.delattr(sandbox_wrap, "wrap_command", raising=False)
    gate = _load_gate()
    assert gate.main() == gate._BOOT


def test_gate_refuses_import_fail_on_ee_even_with_optin(monkeypatch):
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")  # 对 EE 无效
    monkeypatch.delattr(sandbox_wrap, "wrap_command", raising=False)
    gate = _load_gate()
    assert gate.main() == gate._REFUSE_FAILCLOSE


def test_gate_refuses_launch_fail_on_ce_without_optin(monkeypatch):
    _wrapped_but_launch_raises(monkeypatch)
    gate = _load_gate()
    assert gate.main() == gate._REFUSE_LAUNCH


def test_gate_degrades_launch_fail_on_ce_optin(monkeypatch):
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")
    _wrapped_but_launch_raises(monkeypatch)
    gate = _load_gate()
    assert gate.main() == gate._BOOT


def test_gate_refuses_probe_nonzero_on_ce_without_optin(monkeypatch):
    _wrapped_but_probe_nonzero(monkeypatch)
    gate = _load_gate()
    assert gate.main() != gate._BOOT  # 拒绝(返回探针码或 fail-close 码)


def test_gate_degrades_probe_nonzero_on_ce_optin(monkeypatch):
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")
    _wrapped_but_probe_nonzero(monkeypatch)
    gate = _load_gate()
    assert gate.main() == gate._BOOT


def test_gate_refuses_probe_nonzero_on_ee_even_with_optin(monkeypatch):
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")  # 对 EE 无效
    _wrapped_but_probe_nonzero(monkeypatch)
    gate = _load_gate()
    assert gate.main() != gate._BOOT

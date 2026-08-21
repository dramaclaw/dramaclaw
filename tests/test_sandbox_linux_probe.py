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
    # 每个用例自定沙箱必需/opt-in,先清干净,避免宿主 .env 干扰。
    monkeypatch.delenv("SUPERTALE_ENV", raising=False)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("SUPERTALE_ALLOW_UNSANDBOXED", raising=False)


def _spec(tmp_path: Path) -> SandboxSpec:
    return SandboxSpec(user="probe", hermes_home=tmp_path / ".hermes")


def _present_binary(monkeypatch, tmp_path: Path) -> Path:
    """让 `_wrap_linux` 认为 binary 存在:which 返回一个真实存在的文件。"""
    fake = tmp_path / "codex-linux-sandbox"
    fake.write_text("#!/bin/true\n")
    monkeypatch.setattr(sandbox_wrap.shutil, "which", lambda _n: str(fake))
    return fake


# ---- _wrap_linux:binary 存在 + 探针成功 → 真包裹 ----

def test_wrap_linux_wraps_when_sandbox_usable(monkeypatch, tmp_path):
    fake = _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: True)
    out = sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))
    assert out[0] == str(fake)
    assert "--" in out
    assert out[-2:] == ["hermes", "run"]


# ---- _wrap_linux:binary 存在但探针失败 → 与"binary 缺失"同样的降级/拒绝 ----

def test_present_but_unusable_degrades_on_ce_optin(monkeypatch, tmp_path):
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: False)
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")  # CE 单租户降级阀门
    with pytest.warns(RuntimeWarning, match="UNSANDBOXED"):
        out = sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))
    assert out == ["hermes", "run"]  # 未包裹:降级裸跑


def test_present_but_unusable_failcloses_on_ee(monkeypatch, tmp_path):
    _present_binary(monkeypatch, tmp_path)
    monkeypatch.setattr(sandbox_wrap, "_sandbox_can_run", lambda _b: False)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")  # EE/多租户
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")  # 对 EE 无效
    with pytest.raises(RuntimeError, match="sandbox required"):
        sandbox_wrap._wrap_linux(["hermes", "run"], _spec(tmp_path))


def test_missing_binary_still_failcloses_on_ce_without_optin(monkeypatch, tmp_path):
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

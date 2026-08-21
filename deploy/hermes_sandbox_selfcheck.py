#!/usr/bin/env python3
"""Hermes 沙箱启动自检 / 放行门(CE 版)。

在最终 API 镜像里、以 worker 实际的运行用户跑,走 worker 完全相同的代码路径
(``wrap_command`` → ``codex-linux-sandbox`` → bubblewrap),在临时 HERMES_HOME 里
把 ``/bin/true`` 放进沙箱执行,以此判断"这台宿主上沙箱是否真的建得起来"。仅装上
二进制还不够:宿主内核若不支持 unprivileged user namespaces,binary 在但 bwrap 会
在运行时失败——所以必须真跑一次。

退出码即"容器是否应该启动"(供 ENTRYPOINT / K8s startupProbe 使用):

- ``0`` 沙箱可用      → 启动,Hermes 隔离运行;
- ``0`` CE 降级       → 启动,但大声告警 Hermes 将**无沙箱**运行(单租户 CE,DSN 空,
  且显式 opt-in);单租户无跨用户数据风险,不因老内核把自托管用户拒之门外;
- 非 ``0`` 拒绝       → EE/production(或 CE 未 opt-in)下沙箱不可用,fail-close 拒绝启动。

CE 与 EE 版的差别:EE 版是纯探针(建不起来一律非 0);CE 版额外把"单租户可降级"的
决策编进退出码,与 ``sandbox_wrap._fallback_or_raise`` 的语义保持一致(不重复实现)。
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

# 退出码语义(见模块 docstring)。
_BOOT = 0  # 启动(沙箱可用,或 CE 允许降级)
_REFUSE_FAILCLOSE = 3  # 拒绝启动:沙箱必需但不可用(EE/production 或 CE 未 opt-in)
_REFUSE_LAUNCH = 4  # 拒绝启动:沙箱包裹好了却无法拉起(异常环境)


def _sandbox_required() -> bool:
    """与 sandbox_wrap 同源的判定:多租户/生产必须强制沙箱。导入失败时保守视为必需。"""
    try:
        from novelvideo.security.sandbox_wrap import _sandbox_required as impl

        return impl()
    except Exception:  # noqa: BLE001 - 判不了就按"必需"保守处理
        return True


def main() -> int:
    try:
        from novelvideo.security.sandbox_wrap import SandboxSpec, wrap_command
    except Exception as exc:  # noqa: BLE001 - 导入失败也算沙箱不可用
        # 连 wrapper 都导不进来:EE 拒绝启动,CE 降级放行(告警)。
        if _sandbox_required():
            print(
                f"sandbox startup gate FAILED: cannot import sandbox wrapper: {exc}",
                file=sys.stderr,
            )
            return _REFUSE_FAILCLOSE
        print(
            f"sandbox startup gate DEGRADED: cannot import sandbox wrapper ({exc}); "
            "booting UNSANDBOXED (CE single-tenant)",
            file=sys.stderr,
        )
        return _BOOT

    probe = ["/bin/true"]
    with tempfile.TemporaryDirectory(prefix="hermes-sbx-selfcheck-") as tmp:
        home = Path(tmp) / ".hermes"
        home.mkdir(parents=True)
        try:
            wrapped = wrap_command(probe, SandboxSpec(user="_sandbox_selfcheck", hermes_home=home))
        except Exception as exc:  # noqa: BLE001
            # wrap_command 抛错 = fail-close 分支:沙箱必需但不可用(EE/production),
            # 或 CE 未设 SUPERTALE_ALLOW_UNSANDBOXED。两种都拒绝启动。
            print(f"sandbox startup gate FAILED (refuse to boot): {exc}", file=sys.stderr)
            return _REFUSE_FAILCLOSE

        if wrapped[: len(probe)] == probe:
            # 命令没有被沙箱前缀包裹 → wrap_command 走了降级返回原样。能走到这里
            # 说明 _fallback_or_raise 没抛错,即 CE 单租户 + 已 opt-in,允许无沙箱启动。
            print(
                "sandbox startup gate DEGRADED: sandbox unavailable; booting UNSANDBOXED "
                "(CE single-tenant, SUPERTALE_ALLOW_UNSANDBOXED set)",
                file=sys.stderr,
            )
            return _BOOT

        try:
            proc = subprocess.run(wrapped, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as exc:
            # 包裹好了却拉不起来(极少见:二进制/内核异常)。EE 拒绝,CE 降级放行。
            if _sandbox_required():
                print(
                    f"sandbox startup gate FAILED (refuse to boot): could not launch sandbox: {exc}",
                    file=sys.stderr,
                )
                return _REFUSE_LAUNCH
            print(
                f"sandbox startup gate DEGRADED: could not launch sandbox ({exc}); "
                "booting UNSANDBOXED (CE single-tenant)",
                file=sys.stderr,
            )
            return _BOOT

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        # 沙箱二进制在、也拉起了,但沙箱内 /bin/true 非 0:通常是内核缺 userns 让
        # bwrap 失败。EE 拒绝启动;CE 单租户降级为无沙箱(告警),不把老内核用户拒之门外。
        if _sandbox_required():
            print(
                f"sandbox startup gate FAILED (refuse to boot, exit {proc.returncode}): {detail}",
                file=sys.stderr,
            )
            return proc.returncode or _REFUSE_FAILCLOSE
        print(
            f"sandbox startup gate DEGRADED (sandbox probe exit {proc.returncode}: {detail}); "
            "booting UNSANDBOXED (CE single-tenant — host kernel likely lacks user namespaces)",
            file=sys.stderr,
        )
        return _BOOT

    print("sandbox startup gate OK: Hermes sandbox can be created")
    return _BOOT


if __name__ == "__main__":
    sys.exit(main())

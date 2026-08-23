"""deploy/docker-entrypoint.sh 只在选定 Hermes 后端时才跑沙箱启动门。

回归 #349 复审(lywaterman):启动门原来无条件运行,会把一个 Hermes 专属的约束
扩大成整个镜像的全局启动条件——codex/claude 后端、迁移/诊断/覆盖 CMD 的运维命令都会
被无关的 Hermes gate 挡住(Linux 沙箱默认不激活时更会在 EE 上误 fail-close)。入口脚本
现按 novelvideo.chat.service._chat_backend 的偏好判定(DRAMACLAW_CHAT_BACKEND →
SUPERTALE_CHAT_BACKEND → 默认 hermes)决定跑不跑门。

用 PATH 上的桩 python(任何调用都写 marker 并 exit 0)观测门有没有被触发;
`exec "$@"` 用 `true` 收尾。平台无关的 POSIX sh 行为测试,不依赖真沙箱。
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = REPO_ROOT / "deploy" / "docker-entrypoint.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("sh") is None, reason="POSIX sh required to exercise the entrypoint"
)


def _run(tmp_path: Path, env: dict) -> tuple[subprocess.CompletedProcess, bool]:
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    marker = tmp_path / "gate_ran"
    pystub = bindir / "python"
    # 任何 `python ...` 调用都算"门被触发":写 marker 后成功退出,让脚本继续到 exec。
    pystub.write_text(f'#!/bin/sh\necho ran > "{marker}"\nexit 0\n', encoding="utf-8")
    pystub.chmod(0o755)
    full_env = {**os.environ, "PATH": f"{bindir}:{os.environ.get('PATH', '')}"}
    for key in ("DRAMACLAW_CHAT_BACKEND", "SUPERTALE_CHAT_BACKEND"):
        full_env.pop(key, None)  # 先清宿主值,再叠加用例
    full_env.update(env)
    proc = subprocess.run(
        ["sh", str(ENTRYPOINT), "true"],
        env=full_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return proc, marker.exists()


@pytest.mark.parametrize(
    "env",
    [
        {},  # 后端未设 → 默认 hermes
        {"DRAMACLAW_CHAT_BACKEND": "hermes"},
        {"DRAMACLAW_CHAT_BACKEND": "HERMES"},  # 大小写不敏感
        {"DRAMACLAW_CHAT_BACKEND": " hermes "},  # 去空白
        {"SUPERTALE_CHAT_BACKEND": "hermes"},  # 次选环境变量
    ],
)
def test_gate_runs_for_hermes_backend(tmp_path, env):
    proc, gate_ran = _run(tmp_path, env)
    assert proc.returncode == 0, proc.stderr
    assert gate_ran, f"门应在 Hermes 后端下运行:env={env}"


@pytest.mark.parametrize(
    "env",
    [
        {"DRAMACLAW_CHAT_BACKEND": "codex"},
        {"DRAMACLAW_CHAT_BACKEND": "claude"},
        {"SUPERTALE_CHAT_BACKEND": "codex"},  # DRAMACLAW 未设,次选生效
        # DRAMACLAW 优先于 SUPERTALE:显式 codex 压过 hermes 次选 → 跳过门。
        {"DRAMACLAW_CHAT_BACKEND": "codex", "SUPERTALE_CHAT_BACKEND": "hermes"},
    ],
)
def test_gate_skipped_for_non_hermes_backend(tmp_path, env):
    proc, gate_ran = _run(tmp_path, env)
    assert proc.returncode == 0, proc.stderr
    assert not gate_ran, f"门不应在非 Hermes 后端下运行:env={env}"

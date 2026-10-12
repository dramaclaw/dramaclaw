#!/usr/bin/env python3
"""DCO check（REPO-19）：PR 范围内每个 commit 都必须带 Signed-off-by trailer。

用法：
    python scripts/check_dco.py <base>..<head> [--not <trusted-ref>]
    python scripts/check_dco.py                   # 默认 origin/main..HEAD

合并提交（merge）跳过。任一 commit 缺 `Signed-off-by:` → 退出码 1。
贡献者签署说明见 CONTRIBUTING.md 与 DCO。
"""
from __future__ import annotations

import re
import subprocess
import sys

# 形如：Signed-off-by: Jane Doe <jane@example.com>
SIGNOFF = re.compile(r"^\s*Signed-off-by: .+ <.+@.+>\s*$", re.MULTILINE)


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=True
    ).stdout


def commit_shas(revisions: list[str]) -> list[str]:
    # --no-merges 跳过合并提交（其作者非贡献者本人）
    return _git("log", "--no-merges", "--format=%H", *revisions).split()


def main(argv: list[str]) -> int:
    revisions = argv if argv else ["origin/main..HEAD"]
    offenders: list[str] = []
    for sha in commit_shas(revisions):
        body = _git("log", "-1", "--format=%B", sha)
        if not SIGNOFF.search(body):
            subject = _git("log", "-1", "--format=%s", sha).strip()
            offenders.append(f"{sha[:12]} {subject}")
    if offenders:
        print(
            "✖ 以下 commit 缺少 Signed-off-by(DCO 签署):",
            file=sys.stderr,
        )
        for line in offenders:
            print(f"  {line}", file=sys.stderr)
        print(
            "\n每个 commit 须含 `Signed-off-by: Your Name <email>`——提交时加 `-s`"
            "(`git commit -s`),补签历史用 `git rebase --signoff <base>`。详见 CONTRIBUTING.md。",
            file=sys.stderr,
        )
        return 1
    print("✓ 所有 commit 均已 DCO 签署。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

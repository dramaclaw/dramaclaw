#!/usr/bin/env python3
"""DCO check（REPO-19）：PR 范围内每个 commit 都必须带 Signed-off-by trailer。

用法：
    python scripts/check_dco.py <base>..<head> [--not <trusted-ref>]
    python scripts/check_dco.py                   # 默认 origin/main..HEAD

合并提交（merge）跳过。已发布历史可由带本人签署的后继 commit 逐 SHA 补签，
使用 `DCO-Remediation: <完整 SHA>` trailer。未签署且未被补签 → 退出码 1。
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


def trailer_values(sha: str, key: str) -> list[str]:
    raw = _git(
        "show", "-s", f"--format=%(trailers:key={key},separator=%x00)", sha
    ).strip()
    return (
        [trailer.partition(":")[2].strip() for trailer in raw.split("\0")]
        if raw
        else []
    )


def remediations(commits: list[tuple[str, str]]) -> tuple[dict[str, str], list[str]]:
    """Resolve explicit follow-up certifications without changing commit history."""
    recovered: dict[str, str] = {}
    errors: list[str] = []
    for sha, body in commits:
        if "DCO-Remediation:" not in body:
            continue
        targets = trailer_values(sha, "DCO-Remediation")
        if not targets:
            continue
        author = _git("show", "-s", "--format=%an <%ae>", sha).strip()
        signers = trailer_values(sha, "Signed-off-by")
        if author not in signers:
            errors.append(
                f"{sha[:12]}: DCO remediation requires its author's Signed-off-by"
            )
            continue
        for target in targets:
            if not re.fullmatch(r"[0-9a-f]{40}", target) or target == sha:
                errors.append(
                    f"{sha[:12]}: DCO remediation requires a full ancestor commit SHA"
                )
                continue
            try:
                _git("merge-base", "--is-ancestor", target, sha)
            except subprocess.CalledProcessError:
                errors.append(
                    f"{sha[:12]}: DCO remediation target {target} is not an ancestor"
                )
                continue
            recovered[target] = sha
    return recovered, errors


def main(argv: list[str]) -> int:
    revisions = argv if argv else ["origin/main..HEAD"]
    commits = [
        (sha, _git("log", "-1", "--format=%B", sha)) for sha in commit_shas(revisions)
    ]
    recovered, errors = remediations(commits)
    offenders: list[str] = []
    for sha, body in commits:
        if not SIGNOFF.search(body):
            if sha in recovered:
                print(
                    f"✓ DCO remediation: {sha[:12]} certified by {recovered[sha][:12]}"
                )
                continue
            subject = _git("log", "-1", "--format=%s", sha).strip()
            offenders.append(f"{sha[:12]} {subject}")
    if errors:
        for error in errors:
            print(f"✖ {error}", file=sys.stderr)
    if offenders:
        print(
            "✖ 以下 commit 缺少 Signed-off-by(DCO 签署):",
            file=sys.stderr,
        )
        for line in offenders:
            print(f"  {line}", file=sys.stderr)
        print(
            "\n每个 commit 须含 `Signed-off-by: Your Name <email>`——提交时加 `-s`"
            "(`git commit -s`)。已发布历史可用 DCO-Remediation 补签。详见 CONTRIBUTING.md。",
            file=sys.stderr,
        )
    if offenders or errors:
        return 1
    print("✓ 所有 commit 均已 DCO 签署。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""发布前禁用词 lint（REPO-07）。

dramaclaw-ce 采用 Elastic License v2（源码可得 / source-available），**不是开源**。
对外文本不得把本项目称为“开源 / open source”，以免与 OSI 开源定位混淆。

用法：
    python scripts/lint_banned_words.py            # 扫全部被跟踪的文档/文本
    python scripts/lint_banned_words.py a.md b.md  # 只扫指定文件（供 pre-commit）

放行：在该行加注释标记 `banned-word-allow`，即可豁免——用于 LICENSE-FAQ 等
需要明确写“这不是开源 / not open source”的说明性文本。

命中任一禁用词 → 退出码 1。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from ce_allowlist import inline_marker, skip_paths

# 禁用词（中英、大小写不敏感、允许 open-source / open source / opensource）
BANNED = [
    ("开源", re.compile("开源")),
    ("open source", re.compile(r"open[\s\-_]?source", re.IGNORECASE)),
]

# 行内豁免标记（说明性文本可写“不是开源”）——从 ce-allowlist.toml 统一取
ALLOW_MARKER = inline_marker()

# 扫描的文本/文档扩展名
TEXT_SUFFIXES = {".md", ".markdown", ".mdx", ".txt", ".rst", ".html", ".htm"}
# 无扩展名但需扫描的文件名前缀
TEXT_STEMS = ("README", "LICENSE", "NOTICE", "CONTRIBUTING", "GOVERNANCE", "CHANGELOG")

# 永远跳过的路径（lint 自身与其规则文档会“提到”这些词）——从 ce-allowlist.toml 统一取
SKIP_PATHS = skip_paths("banned-words")


def is_text_target(path: Path) -> bool:
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    return path.suffix == "" and path.name.upper().startswith(TEXT_STEMS)


def tracked_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    return [Path(p) for p in out]


def collect_targets(argv: list[str]) -> list[Path]:
    paths = [Path(p) for p in argv] if argv else tracked_files()
    return [
        p
        for p in paths
        if p.is_file() and is_text_target(p) and p.as_posix() not in SKIP_PATHS
    ]


def scan(path: Path) -> list[tuple[int, str, str]]:
    hits: list[tuple[int, str, str]] = []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return hits
    for lineno, line in enumerate(text.splitlines(), 1):
        if ALLOW_MARKER in line:
            continue
        for label, pattern in BANNED:
            if pattern.search(line):
                hits.append((lineno, label, line.strip()[:100]))
    return hits


def main(argv: list[str]) -> int:
    total = 0
    for path in collect_targets(argv):
        for lineno, label, snippet in scan(path):
            total += 1
            print(f"{path}:{lineno}: 禁用词「{label}」  ┆ {snippet}")
    if total:
        print(
            f"\n✖ 命中 {total} 处禁用词。dramaclaw-ce 不是开源（ELv2 source-available）；"
            f"对外文本请改用“源码可得 / source-available”。\n"
            f"  说明性文本（如“这不是开源”）可在该行加注释标记 `{ALLOW_MARKER}` 豁免。",
            file=sys.stderr,
        )
        return 1
    print("✓ 无禁用词。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

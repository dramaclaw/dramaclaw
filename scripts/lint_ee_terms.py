#!/usr/bin/env python3
"""禁用包名 lint（REPO-10，硬零）。

下列包不属于本仓库，不得以任何形式（代码、注释、docstring、文档、配置）出现。
本守栏扫描源码+配置+文档，与 import-lint（lint_ce_imports.py，只抓 import 语句）
互补——它抓「字符串/注释/文档/路径」层面的引用。

注：词表只收口在「实测 0 命中」的包名，不含本仓正常依赖（asyncpg / psycopg /
oss2 / celery / litestream）、运行期开关（control_plane / ST_CONTROL_PLANE_DSN）、
品牌名（supertale-ce）等——这些是合法用法，误入词表会引发假阳。

用法：
    python scripts/lint_ee_terms.py            # 扫全部被跟踪文件（CI 默认）
    python scripts/lint_ee_terms.py a.py b.md  # 只扫指定文件（供 pre-commit）

放行：在该行加注释标记 `banned-word-allow`（与 lint_banned_words.py 同一约定）。

命中任一禁用包名 → 退出码 1。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from ce_allowlist import inline_marker, skip_paths

# 禁用包名（substring 匹配；均已实测在本仓 0 命中）。
# 形如 (label, compiled_pattern)。包名大小写敏感，故不加 IGNORECASE。
# 仅收口「包命名空间」级别；更细的内部标识符由私有侧反向扫描，不放在本仓。
EE_TERMS = [
    (term, re.compile(re.escape(term)))
    for term in (
        "novelvideo_ee",    # 外部包命名空间（import-lint 同步禁止其导入）
        "supertale_admin",  # 外部 admin 包
        "supertale-admin",  # 同上，连字符变体
        "supertale_ee",     # 外部包变体
    )
]

# 行内豁免标记 + 跳过路径：统一从 ce-allowlist.toml 取（不再硬编码）
ALLOW_MARKER = inline_marker()
SKIP_PATHS = skip_paths("ee-terms")

# 扫描的源码/配置/文档扩展名
SCAN_SUFFIXES = {
    ".py", ".md", ".markdown", ".mdx", ".txt", ".rst",
    ".yaml", ".yml", ".toml", ".cfg", ".ini", ".sh", ".env",
}
# 无扩展名但需扫描的文件名前缀 / 精确名
SCAN_STEMS = ("README", "LICENSE", "NOTICE", "CONTRIBUTING", "GOVERNANCE", "CHANGELOG")
SCAN_NAMES = {"Dockerfile", "Dockerfile.ce"}


def is_scan_target(path: Path) -> bool:
    if path.suffix.lower() in SCAN_SUFFIXES:
        return True
    if path.name in SCAN_NAMES:
        return True
    return path.suffix == "" and path.name.upper().startswith(SCAN_STEMS)


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
        if p.is_file() and is_scan_target(p) and p.as_posix() not in SKIP_PATHS
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
        for label, pattern in EE_TERMS:
            if pattern.search(line):
                hits.append((lineno, label, line.strip()[:100]))
    return hits


def main(argv: list[str]) -> int:
    total = 0
    for path in collect_targets(argv):
        for lineno, label, snippet in scan(path):
            total += 1
            print(f"{path}:{lineno}: 禁用包名「{label}」  ┆ {snippet}")
    if total:
        print(
            f"\n✖ 命中 {total} 处禁用包名。这些包不属于本仓库。\n"
            f"  相关能力应经 novelvideo.ports.* 抽象消费，而非引用外部包。\n"
            f"  确属合法引用（如跨仓说明）可在该行加注释标记 `{ALLOW_MARKER}` 豁免。",
            file=sys.stderr,
        )
        return 1
    print("✓ 无禁用包名。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""依赖许可证准入门（DEP-11，硬零）。

本仓以 Elastic-2.0 闭源分发，依赖树中不得引入强 copyleft 许可证
（GPL / AGPL / SSPL——传染范围会波及整仓分发）。弱 copyleft（LGPL / MPL）
以「动态导入、不静态链接、不改源」方式使用，允许并列出提示。

扫描对象是**当前环境已安装的全部发行版**（importlib.metadata）：CI 先
`uv sync --frozen` 把环境装成与 uv.lock 完全一致，故等价于审计锁文件全树，
不依赖 GitHub Dependency Graph 的清单索引能力。与之互补的 PR 增量审查见
.github/workflows/dependency-review.yml（GitHub dependency-review-action）。

许可证判定顺序：License-Expression（PEP 639）→ License 分类器 → License 字段。
三者皆缺 → UNKNOWN，同样阻断（防「无元数据」成为绕过口），除非列入 EXEMPT。

豁免：EXEMPT 按「发行版名 → 理由」收口在本文件（与 pyproject 冻结 ruff 规则
同一哲学：改豁免必须走 PR）。豁免包若已不在依赖树中 → 视为腐烂豁免，同样失败。

用法：
    uv run python scripts/check_dependency_licenses.py

命中强 copyleft / 无豁免的 UNKNOWN / 腐烂豁免 → 退出码 1。
"""
from __future__ import annotations

import importlib.metadata as importlib_metadata
import re
import sys

# 豁免（发行版名小写 → 理由）。仅限：a) 元数据缺失但真实许可已人工核明；
# b) 多许可（OR）可选出非传染分支。理由必须写明真实许可与依据。
EXEMPT: dict[str, str] = {
    "tiktoken": "MIT——wheel 未写 License 元数据；见 github.com/openai/tiktoken 根 LICENSE",
}

# 强 copyleft：命中即阻断。注意 LGPL/Lesser/Library 属弱 copyleft，须先排除，
# 否则 "GPL" 子串会把 LGPL 一并误杀。
_DENY = re.compile(r"\bAGPL|\bSSPL|Affero", re.IGNORECASE)
_GPL = re.compile(r"GPL", re.IGNORECASE)
_WEAK = re.compile(r"LGPL|Lesser|Library", re.IGNORECASE)
_NOTICE = re.compile(r"LGPL|Lesser|Library|MPL|Mozilla", re.IGNORECASE)

UNKNOWN = "UNKNOWN"


def license_of(dist: importlib_metadata.Distribution) -> str:
    """从发行版元数据解析许可证描述（找不到返回 UNKNOWN）。"""
    md = dist.metadata
    expr = md.get("License-Expression")
    if expr:
        return expr
    classifiers = [
        c.split("::")[-1].strip()
        for c in (md.get_all("Classifier") or [])
        if c.startswith("License")
    ]
    if classifiers:
        return " / ".join(classifiers)
    lic = (md.get("License") or "").strip()
    # 有些包把整份许可证全文塞进 License 字段——只认短标识
    if lic and "\n" not in lic and len(lic) <= 80:
        return lic
    return UNKNOWN


def classify(license_text: str) -> str:
    """归类：denied（强 copyleft）/ unknown / notice（弱 copyleft）/ ok。"""
    if license_text == UNKNOWN:
        return "unknown"
    if _DENY.search(license_text):
        return "denied"
    # GPL 命中且整串不含任何弱 copyleft 词 → 强 copyleft。
    # （"LGPL-3.0-only" 含 GPL 子串但属弱；"GPL-3.0 / LGPL" 这类混排按弱放行，
    #   真实双许可取舍走 EXEMPT 显式豁免。）
    if _GPL.search(license_text) and not _WEAK.search(license_text):
        return "denied"
    if _NOTICE.search(license_text):
        return "notice"
    return "ok"


def audit() -> tuple[list[str], list[str], list[str]]:
    """扫描当前环境。返回 (violations, notices, rotten_exempts)。"""
    violations: list[str] = []
    notices: list[str] = []
    seen: set[str] = set()
    for dist in importlib_metadata.distributions():
        name = (dist.metadata.get("Name") or "").strip()
        if not name:
            continue
        seen.add(name.lower())
        lic = license_of(dist)
        kind = classify(lic)
        if name.lower() in EXEMPT:
            if kind in ("denied", "unknown"):
                continue  # 已人工核明，放行
            # 包元数据已修好 → 豁免失去存在理由，按腐烂处理（见下）
        if kind == "denied":
            violations.append(f"{name}: 强 copyleft「{lic}」")
        elif kind == "unknown":
            violations.append(f"{name}: 无许可证元数据（UNKNOWN）")
        elif kind == "notice":
            notices.append(f"{name}: {lic}")
    rotten = [
        f"{pkg}: 豁免已无必要（包不在依赖树，或元数据已可正常判定）——请从 EXEMPT 移除"
        for pkg in EXEMPT
        if pkg not in seen or classify(license_of_by_name(pkg)) not in ("denied", "unknown")
    ]
    return violations, notices, rotten


def license_of_by_name(pkg: str) -> str:
    try:
        return license_of(importlib_metadata.distribution(pkg))
    except importlib_metadata.PackageNotFoundError:
        return UNKNOWN


def main() -> int:
    violations, notices, rotten = audit()
    for line in notices:
        print(f"ℹ 弱 copyleft（动态导入使用，放行）：{line}")
    for line in rotten:
        print(f"✖ 腐烂豁免 {line}", file=sys.stderr)
    for line in violations:
        print(f"✖ {line}", file=sys.stderr)
    if violations or rotten:
        print(
            f"\n✖ 依赖许可证门未过（{len(violations)} 违规 / {len(rotten)} 腐烂豁免）。\n"
            "  强 copyleft 依赖与 Elastic-2.0 分发冲突：换替代库，或确属误判/"
            "双许可时在 scripts/check_dependency_licenses.py 的 EXEMPT 写明理由豁免。",
            file=sys.stderr,
        )
        return 1
    print(f"✓ 依赖许可证门通过（弱 copyleft 提示 {len(notices)} 项，豁免 {len(EXEMPT)} 项）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

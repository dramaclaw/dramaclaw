#!/usr/bin/env python3
"""前端硬编码中文文案检查（i18n 棘轮）。

用法：
    python scripts/check_frontend_i18n.py            # 对照 allowlist 检查
    python scripts/check_frontend_i18n.py --write    # 重新生成 allowlist（只在有意放行时用）
    python scripts/check_frontend_i18n.py --list     # 打印全部命中，不比对 allowlist

扫描口径：剥掉注释后，`frontend/src` 下 .ts/.tsx 里**任何**残留的中日韩字符都算一处。

早先版本只认三种模式（JSX 文本 / UI 属性 / toast 首参），实测在画布里漏报一多半——
`setStatus('已加载')`、`title={open ? '收起' : '展开'}`、模块级 `label: '前方'` 常量、
以及一堆模板字面量全都逃掉了。宁可宽到误报，也不要让英文界面继续漏中文；确实要保留
中文的行（解析用的字段别名、正则里的中文标点、语言切换里的「中文」）加 `// i18n-exempt`。

allowlist 是棘轮：文件里已有的条数只许减不许增，新文件一旦命中直接失败。
个别确实要保留中文的行（如语言切换里的「中文」）可在行尾加 `// i18n-exempt`。

存量已清零，所以仓库里没有 allowlist 文件——缺文件等于空 allowlist，任何命中都失败。
真要临时放行才用 `--write` 生成它，别顺手跑。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

FRONTEND_SRC = os.path.join("frontend", "src")
ALLOWLIST = os.path.join("scripts", "frontend_i18n_allowlist.json")

CJK = re.compile(r"[一-鿿]")
# `/*` 只有在前面不是标识符/引号/斜杠时才是块注释开头——否则 `'image/*'`
# 这种 MIME 通配符会被当成注释起点，把后面几百行真命中一起吃掉。
BLOCK_COMMENT = re.compile(r"(?<![\w'\"/])/\*.*?\*/", re.S)
COMMENT_LINE = re.compile(r"^\s*(//|\*)")
# 标记既认 `// i18n-exempt`，也认 JSX 里只能写成块注释的 `{/* i18n-exempt */}`——
# 后者会被 BLOCK_COMMENT 抹掉，所以标记一律在原文上找（见 scan()）。
EXEMPT = re.compile(r"(?://|/\*)\s*i18n-exempt(?!-)")
# 协议值表（后端逐字对应的枚举、会写进存档 JSON 的规范默认值）整块保留中文，
# 逐行贴 `// i18n-exempt` 只会把表读糊，所以给一对区间标记。
EXEMPT_START = re.compile(r"(?://|/\*)\s*i18n-exempt-start")
EXEMPT_END = re.compile(r"(?://|/\*)\s*i18n-exempt-end")
# t(key, { defaultValue: "中文" })：key 已存在，中文只是兜底。
DEFAULT_VALUE = re.compile(r"defaultValue:\s*([\"'])(?:(?!\1).)*\1")



def scan() -> tuple[dict[str, list[tuple[int, str]]], list[str]]:
    """返回 (命中, 豁免标记错误)。

    标记错误单独返回而不是并入命中：区间标记写错会让扫描器**少报**，
    是关卡静默失效而不是文案回潮，必须无条件失败，不能被 allowlist 抵掉。
    """
    hits: dict[str, list[tuple[int, str]]] = {}
    marker_errors: list[str] = []
    for root, dirs, files in os.walk(FRONTEND_SRC):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        if "__tests__" in root.split(os.sep):
            continue
        for name in sorted(files):
            if not name.endswith((".ts", ".tsx")):
                continue
            if name.endswith((".test.ts", ".test.tsx", ".d.ts")):
                continue
            path = os.path.join(root, name).replace(os.sep, "/")
            with open(path, encoding="utf-8") as handle:
                raw = handle.read()
            # 块注释整体抹掉，但保留换行，行号才对得上。
            source = BLOCK_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), raw)
            found: list[tuple[int, str]] = []
            in_exempt_block = False
            exempt_start_line = 0
            # 标记在原文里找、命中在剥注释后的文本里找：两边行号一一对应。
            for lineno, (raw_line, line) in enumerate(
                zip(raw.split("\n"), source.split("\n")), 1
            ):
                if EXEMPT_START.search(raw_line):
                    if in_exempt_block:
                        marker_errors.append(
                            f"{path}:{lineno}: i18n-exempt-start 嵌套在第 "
                            f"{exempt_start_line} 行开启的豁免块里（区间不支持嵌套）"
                        )
                    in_exempt_block = True
                    exempt_start_line = lineno
                    continue
                if EXEMPT_END.search(raw_line):
                    if not in_exempt_block:
                        marker_errors.append(
                            f"{path}:{lineno}: i18n-exempt-end 没有对应的 i18n-exempt-start"
                        )
                    in_exempt_block = False
                    exempt_start_line = 0
                    continue
                if in_exempt_block:
                    continue
                if COMMENT_LINE.match(line) or EXEMPT.search(raw_line):
                    continue
                # 去掉行尾行注释，避免注释里的中文误报（`://` 这类 URL 不切）。
                stripped = re.sub(r"(?<![:\"'])//[^\"']*$", "", line)
                # `t(key, { defaultValue: "中文" })` 是已接入 i18n 的兜底，不算硬编码。
                stripped = DEFAULT_VALUE.sub("", stripped)
                if CJK.search(stripped):
                    found.append((lineno, line.strip()[:120]))
            if in_exempt_block:
                # 漏写结束标记时，该行之后整个文件的中文都被跳过，扫描依然 0 命中通过——
                # 这是棘轮静默失效，比漏一处文案严重得多，直接报错。
                marker_errors.append(
                    f"{path}:{exempt_start_line}: i18n-exempt-start 到文件结束都没有 "
                    "i18n-exempt-end，其后所有中文都被静默跳过了"
                )
            if found:
                hits[path] = found
    return hits, marker_errors


def load_allowlist() -> dict[str, int]:
    if not os.path.exists(ALLOWLIST):
        return {}
    with open(ALLOWLIST, encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args(argv)

    hits, marker_errors = scan()
    counts = {path: len(v) for path, v in sorted(hits.items())}

    # 标记写错会让扫描器少报，所以在任何模式下都先失败：`--write` 尤其不能在
    # 区间破损的情况下把「少报后的计数」固化进 allowlist。
    if marker_errors:
        print("✖ i18n 豁免区间标记有误（会让检查静默跳过中文）:", file=sys.stderr)
        for line in marker_errors:
            print(f"  {line}", file=sys.stderr)
        print(
            "\n`// i18n-exempt-start` 必须有配对的 `// i18n-exempt-end`，且不支持嵌套。",
            file=sys.stderr,
        )
        return 1

    if args.list:
        for path, entries in sorted(hits.items()):
            for lineno, text in entries:
                print(f"{path}:{lineno}  {text}")
        print(f"\n合计 {sum(counts.values())} 处 / {len(counts)} 文件")
        return 0

    if args.write:
        with open(ALLOWLIST, "w", encoding="utf-8") as handle:
            json.dump(counts, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        print(f"已写入 {ALLOWLIST}：{sum(counts.values())} 处 / {len(counts)} 文件")
        return 0

    allowed = load_allowlist()
    regressions: list[str] = []
    for path, count in counts.items():
        budget = allowed.get(path)
        if budget is None:
            regressions.append(f"{path}: 新增 {count} 处硬编码中文（该文件不在 allowlist 中）")
        elif count > budget:
            regressions.append(f"{path}: {budget} → {count} 处，硬编码中文增加了")

    if regressions:
        print("✖ 前端硬编码中文文案增加了（这些文案在英文界面下会直接漏出中文）:", file=sys.stderr)
        for line in regressions:
            print(f"  {line}", file=sys.stderr)
        print(
            "\n请改用 `t(\"…\")` 并在 frontend/public/locales/{zh,en}/translation.json 补齐两边的 key。"
            "\n确需保留中文的单行可加 `// i18n-exempt`；整块协议值表用"
            " `// i18n-exempt-start` / `// i18n-exempt-end` 括起来。",
            file=sys.stderr,
        )
        return 1

    shrunk = {p: (allowed[p], counts.get(p, 0)) for p in allowed if counts.get(p, 0) < allowed[p]}
    stale = [p for p in allowed if p not in counts]
    print(f"✓ 前端硬编码中文未增加（当前 {sum(counts.values())} 处 / {len(counts)} 文件）。")
    if shrunk or stale:
        print(
            "提示：以下条目已减少或清零，可执行 "
            "`python scripts/check_frontend_i18n.py --write` 收紧棘轮："
        )
        for path, (before, after) in sorted(shrunk.items()):
            print(f"  {path}: {before} → {after}")
        for path in sorted(stale):
            print(f"  {path}: 已清零")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

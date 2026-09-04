#!/usr/bin/env python3
"""后端面向用户文案的 i18n 棘轮。

用法：
    python scripts/check_backend_i18n.py            # 对照 allowlist 检查
    python scripts/check_backend_i18n.py --write    # 重新生成 allowlist（只在有意放行时用）
    python scripts/check_backend_i18n.py --list     # 打印全部命中，不比对 allowlist

`scripts/check_frontend_i18n.py` 只看 frontend/，所以后端直接写死的中文全逃掉了：
任务进度条、任务日志面板、排队 toast 都是后端把成品中文交给前端原样回显的，英文界面
下这些位置一直在漏中文。

扫描口径**不是**「后端里的任何中文」——后端有大量正当的中文（LLM prompt、服务端日志、
解析用的字面量、异常信息），一刀切只会淹没信号。这里只认会流到前端的四个位置：

  * `current_task=` 关键字实参
  * `logs=[...]` 关键字实参
  * `report(...)` / `update_progress(...)` / `log(...)` 的实参
  * 返回体 dict 里的 `"message"` 值

修法是把中文包进 `lmsg("<code>", "<中文>", **params)`（见 novelvideo/i18n_message.py），
再去 frontend/public/locales/{zh,en}/translation.json 两边补词条。`lmsg(...)` 内部的
中文是**兜底文案**，不算命中，扫描遇到 lmsg 调用就不再下钻。

allowlist 是棘轮：文件里已有的条数只许减不许增，新文件一旦命中直接失败。
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys

BACKEND_SRC = os.path.join("src", "novelvideo")
ALLOWLIST = os.path.join("scripts", "backend_i18n_allowlist.json")

CJK = re.compile(r"[一-鿿]")
# 这些回调把实参直接写进任务状态，用户在进度条/日志面板上逐字看到。
PROGRESS_CALLS = {"report", "update_progress", "log"}
# 中文兜底文案的合法容器：命中它就整棵子树跳过。
LOCALIZABLE = {"lmsg", "LocalizableMessage"}


def _call_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _has_cjk(node: ast.AST) -> bool:
    """节点里是否有中文字面量（含 f-string 的字面量片段）。

    不能用 `ast.walk`：它会一路钻进 `lmsg("code", "中文")` 里，把已经迁移好的
    兜底文案又数成命中，`report(0.1, lmsg(...))` 这种正确写法反而报错。所以
    自己递归，遇到 lmsg / LocalizableMessage 调用就整棵子树跳过。
    """
    if isinstance(node, ast.Call) and _call_name(node) in LOCALIZABLE:
        return False
    if isinstance(node, ast.Constant):
        return isinstance(node.value, str) and bool(CJK.search(node.value))
    return any(_has_cjk(child) for child in ast.iter_child_nodes(node))


class Scanner(ast.NodeVisitor):
    def __init__(self) -> None:
        self.hits: list[tuple[int, str]] = []

    def _record(self, node: ast.AST, what: str) -> None:
        self.hits.append((node.lineno, what))

    def visit_Call(self, node: ast.Call) -> None:
        if _call_name(node) in LOCALIZABLE:
            # 已经是本地化消息，里面的中文就是兜底文案本身。
            return
        name = _call_name(node)
        for kw in node.keywords:
            if kw.arg in ("current_task", "logs") and _has_cjk(kw.value):
                self._record(node, f"{kw.arg}= 传了中文字面量")
        if name in PROGRESS_CALLS:
            for arg in node.args:
                if _has_cjk(arg):
                    self._record(node, f"{name}() 的实参是中文字面量")
                    break
        self.generic_visit(node)

    def visit_Dict(self, node: ast.Dict) -> None:
        for key, value in zip(node.keys, node.values):
            if (
                isinstance(key, ast.Constant)
                and key.value == "message"
                and _has_cjk(value)
            ):
                self._record(value, '返回体 "message" 是中文字面量')
        self.generic_visit(node)


def scan() -> dict[str, list[tuple[int, str]]]:
    hits: dict[str, list[tuple[int, str]]] = {}
    for root, dirs, files in os.walk(BACKEND_SRC):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in sorted(files):
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name).replace(os.sep, "/")
            with open(path, encoding="utf-8") as handle:
                source = handle.read()
            try:
                tree = ast.parse(source, filename=path)
            except SyntaxError:
                continue
            scanner = Scanner()
            scanner.visit(tree)
            # 行尾 `# i18n-exempt` 放行确实不面向用户的那几处。
            lines = source.split("\n")
            kept = [
                (lineno, what)
                for lineno, what in scanner.hits
                if "i18n-exempt" not in lines[lineno - 1]
            ]
            if kept:
                hits[path] = sorted(set(kept))
    return hits


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

    hits = scan()
    counts = {path: len(v) for path, v in sorted(hits.items())}

    if args.list:
        for path, entries in sorted(hits.items()):
            for lineno, what in entries:
                print(f"{path}:{lineno}  {what}")
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
        print(
            "✖ 后端面向用户的硬编码中文增加了（英文界面下会原样漏出中文）:",
            file=sys.stderr,
        )
        for line in regressions:
            print(f"  {line}", file=sys.stderr)
        print(
            '\n请把中文包进 `lmsg("<code>", "<中文>", **params)`（novelvideo/i18n_message.py），'
            "\n并在 frontend/public/locales/{zh,en}/translation.json 两边补齐词条。"
            "\n确实不面向用户的那几处可在行尾加 `# i18n-exempt`。",
            file=sys.stderr,
        )
        return 1

    shrunk = {p: (allowed[p], counts.get(p, 0)) for p in allowed if counts.get(p, 0) < allowed[p]}
    stale = [p for p in allowed if p not in counts]
    print(f"✓ 后端面向用户的硬编码中文未增加（当前 {sum(counts.values())} 处 / {len(counts)} 文件）。")
    if shrunk or stale:
        print(
            "提示：以下条目已减少或清零，可执行 "
            "`python scripts/check_backend_i18n.py --write` 收紧棘轮："
        )
        for path, (before, after) in sorted(shrunk.items()):
            print(f"  {path}: {before} → {after}")
        for path in sorted(stale):
            print(f"  {path}: 已清零")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

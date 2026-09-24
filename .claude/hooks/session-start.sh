#!/usr/bin/env bash
# SessionStart hook：把交接台账的索引注入新会话的上下文。
#
# 为什么是 hook 而不是让 AGENTS.md @-import STATE.md：STATE.md 每天都在改，
# 而 AGENTS.md 的内容进的是会话的缓存前缀，改一次就把缓存打掉一次。
# hook 的输出不进缓存前缀，改得再勤也不花钱。
#
# 纯文本 stdout 会被 Claude Code 当作上下文注入（SessionStart 是支持这个的事件之一）。
# 所以这里只能打印给模型看的内容，不要打印调试信息。
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
state="$root/docs/agent/STATE.md"

if [ ! -f "$state" ]; then
  echo "提醒：docs/agent/STATE.md 不存在。交接台账体系可能被误删，见 AGENTS.md 的「多模型协作协议」。"
  exit 0
fi

echo "===== 交接台账索引（docs/agent/STATE.md，自动注入）====="
cat "$state"
echo
echo "===== 工作区实际状态（git status 摘要）====="
if git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  echo "分支：$(git -C "$root" branch --show-current 2>/dev/null)"
  echo "最新提交：$(git -C "$root" log --oneline -1 2>/dev/null)"
  modified=$(git -C "$root" status --short 2>/dev/null | grep -c '^ M' || true)
  untracked=$(git -C "$root" status --short 2>/dev/null | grep -c '^??' || true)
  echo "未提交：${modified} 个已修改 / ${untracked} 个未跟踪"
  echo "（上面的索引若与这里对不上，以 git 为准，并顺手更新 STATE.md 第一节。）"
fi
echo
echo "===== 多模型 guard（机器校验）====="
guard="$root/scripts/agent_guard.py"
if [ -f "$guard" ]; then
  python3 "$guard" --repo "$root" check 2>&1 || true
  python3 "$guard" --repo "$root" status 2>&1 || true
else
  echo "提醒：scripts/agent_guard.py 不存在，机器护栏可能被误删。"
fi
echo
echo "开工前请按 AGENTS.md 完成方案门、acquire 与 preflight；收工前 handoff、release 并更新对应台账。"

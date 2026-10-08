#!/usr/bin/env bash
# Stop hook：动了代码却没动台账时，拦一次并要求补记录。
#
# 只拦一次：用一个按 session_id 命名的标记文件做闸，避免和 Claude 互相顶成死循环。
# 拦截靠 exit 2 + stderr（Stop 事件的语义：exit 2 阻止结束，stderr 文本作为原因交给模型）。
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -z "$session_id" ] && session_id="unknown"

# Claude Code 自己的循环保护位；它为真说明这一轮就是被本 hook 拦出来的，直接放行。
if printf '%s' "$payload" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# 先做跨客户端通用检查。新增脏文件若没有 scope、台账结构损坏或认领冲突，
# 不能因为某个 ledger 的 mtime 恰好变了就放过。
guard_script="$root/scripts/agent_guard.py"
if [ -f "$guard_script" ]; then
  guard_output="$(python3 "$guard_script" --repo "$root" check 2>&1)"
  guard_status=$?
  if [ "$guard_status" -ne 0 ]; then
    printf '%s\n' "$guard_output" >&2
    echo "请先修复 agent guard 报告的问题，再结束会话。" >&2
    exit 2
  fi
fi

guard_dir="${TMPDIR:-/tmp}/dramaclaw-ledger-guard"
mkdir -p "$guard_dir"
guard="$guard_dir/$session_id"
[ -f "$guard" ] && exit 0

# 本会话是否动过代码：取最近 4 小时内改动过的受控源码文件。
# 用 mtime 而不是 git diff，是因为 git diff 分不出「这一轮改的」和「三周前就改了的」。
changed_code=$(find "$root/src" "$root/frontend/src" "$root/scripts" "$root/tests" \
  -type f \( -name '*.py' -o -name '*.ts' -o -name '*.tsx' -o -name '*.sh' \) \
  -mmin -240 2>/dev/null | head -1)
[ -z "$changed_code" ] && exit 0

changed_ledger=$(find "$root/docs/agent" -type f -name '*.md' -mmin -240 2>/dev/null | head -1)
if [ -n "$changed_ledger" ]; then
  exit 0
fi

touch "$guard"
cat >&2 <<'MSG'
这一轮改了代码，但 docs/agent/ 下的台账没有任何改动。

按 AGENTS.md 的「多模型协作协议」，收工前需要在对应的 docs/agent/tasks/<slug>.md
「进展记录」顶部加一条，写清楚：改了什么、为什么这么改（尤其是与原计划分叉的地方）、
怎么验证的。状态有变化的话同时更新 docs/agent/STATE.md 的表。

补完再结束。如果这一轮确实只是探索、没有产生需要交接的结论，说明一句即可结束。
MSG
exit 2

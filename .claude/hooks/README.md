# Claude Code hooks：通用协作协议的客户端提醒

根 `AGENTS.md` 与 `docs/agent/README.md` 是所有模型共用的协议；这里的两个脚本只为 Claude Code
自动注入和提醒，**不是协议的唯一载体**。换成 Codex、IDE agent 或其他模型时，即使 hook 不运行，
也仍要手工执行同一套开工 / 方案 / 冲突 / 收工流程。

| 脚本 | 时机 | 做什么 |
|---|---|---|
| `session-start.sh` | 会话开始 / 恢复 / compact 后 | 注入 STATE / Git 摘要，并运行 guard `check` / `status` |
| `stop-ledger-check.sh` | 会话收尾 | 先拒绝 guard 失败，再检查近 4 小时源码有改但台账未更新 |

hook 本身仍不能替 Claude 自动选择工作线。真正的路径归属和并发判断由 `scripts/agent_guard.py`
读取 `docs/agent/claims/*.toml` 完成；模型仍须按 `AGENTS.md` 主动执行 acquire / preflight / handoff / release。

## 启用

脚本本身进仓库，**开关不进**——`.gitignore` 里已经约定
「`.claude/settings.json` 是本机的 worktree 开关，不是团队约定」，这里沿用该约定。
所以每台机器要自己把下面这段合进 `.claude/settings.json`（没有就新建）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/session-start.sh",
            "timeout": 15
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/stop-ledger-check.sh",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

已经有 `.claude/settings.json` 的话，把 `hooks` 这个键合进去，别整个覆盖。
改完开一个新会话验证：开场应能看到台账索引被注入。

## 两个实现细节，改之前先看

- **`session-start.sh` 的 stdout 是给模型看的上下文**，不是日志。
  SessionStart 是少数几个「纯文本 stdout 直接进上下文」的事件，所以里面不能打印调试信息；
  另外一旦输出变成合法 JSON，Claude Code 会按 JSON 解析而不再当正文注入。
- **`stop-ledger-check.sh` 靠 `exit 2` + stderr 拦截**，这是 Stop 事件阻止结束的方式。
  它每个会话只拦一次（`$TMPDIR/dramaclaw-ledger-guard/<session_id>` 标记文件），
  并且检查 `stop_hook_active`——两道闸都是为了不和模型顶成死循环。去掉任何一道都会出事。
- 判断「这一轮动没动代码」用的是文件 mtime（近 240 分钟）而不是 `git diff`。
  因为这个仓库长期有上百个未提交改动，`git diff` 永远非空，分不出新旧。
  副作用：会话跨度超过 4 小时时可能漏判，这是有意的取舍——宁可漏提醒，不要天天误报。

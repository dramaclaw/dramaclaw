# Codex

1. 安装 `dramaclaw-workflows` 与 `interactive-story` Skill 到 `~/.agents/skills/` 或项目 `.agents/skills/`。
2. 用 `scripts/render_config.py --host codex ...` 生成配置片段。
3. 合并到 `~/.codex/config.toml` 或可信项目的 `.codex/config.toml`。
4. 重启 Codex，运行 `codex mcp list`，并在会话中用 `/mcp` 检查两个 server。

`dramaclaw-workflows` server 只负责 Workflow/Recipe 查询与编译；互动故事四个工具位于授权 `dramaclaw` server。安装或更新 Skill 后应新开任务，直接用“互动影游、分支剧情、多结局”等自然语言即可触发；若宿主没有自动选择，可显式指定 `interactive-story` Skill。

互动故事 Create/Patch 会直接写入 CE 后端画布。外部 Codex 收到 `refresh_canvas=true` 回执，但当前不会向已打开的 DramaClaw 浏览器自动广播刷新；需要宿主刷新适配或手动刷新画布。产品内置 Agent 不受此限制。

不要把已有 `config.toml` 整体替换为模板。

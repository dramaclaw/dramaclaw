# Codex

1. 安装 `dramaclaw-workflows` 与 `interactive-story` Skill 到 `~/.agents/skills/` 或项目 `.agents/skills/`。
2. 用 `scripts/render_config.py --host codex ...` 生成配置片段。
3. 合并到 `~/.codex/config.toml` 或可信项目的 `.codex/config.toml`。
4. 重启 Codex，运行 `codex mcp list`，并在会话中用 `/mcp` 检查两个 server。

`dramaclaw-workflows` server 只负责 Workflow/Recipe 查询与编译；互动故事四个工具位于授权 `dramaclaw` server。安装或更新 Skill 后应新开任务，直接用“互动影游、分支剧情、多结局”等自然语言即可触发；若宿主没有自动选择，可显式指定 `interactive-story` Skill。

互动故事 Create/Patch 会直接写入 CE 后端画布。外部 Codex 收到 `refresh_canvas=true` 回执，但当前不会向已打开的 DramaClaw 浏览器自动广播刷新；需要宿主刷新适配或手动刷新画布。产品内置 Agent 不受此限制。

模板不设置 `tool_input_schema_max_bytes`，沿用 Codex 默认：超过 5000 字节的工具输入 schema 会被压缩，嵌套字段可能缺失。画布命令的两个工具发布的是 5000 字节以内的精简 schema，`commands[]` 的字段完整可见。其余被压缩的工具里，工作流草稿的拒绝信息附带改正示例，互动故事的拒绝信息列出操作名和必填字段但不带示例；画布命令的拒绝信息只在文本节点缺标题或正文时附带示例。不建议把这个上限整体调大：实测会让工具负载明显增大，并导致运行不稳定。

模板启用 `DRAMACLAW_CODEX_COMPACT_SCHEMAS=1`。它给工作流和互动故事的五个大工具发布精简参数形状，保留常用节点、连线、媒体引用和故事补丁操作。已有配置可在对应 MCP 服务的环境变量中加入此设置。服务端仍按完整契约校验。

不要把已有 `config.toml` 整体替换为模板。

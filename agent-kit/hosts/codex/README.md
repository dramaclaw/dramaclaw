# Codex

1. 安装 Skill 到 `~/.agents/skills/dramaclaw-workflows` 或项目 `.agents/skills/`。
2. 用 `scripts/render_config.py --host codex ...` 生成配置片段。
3. 合并到 `~/.codex/config.toml` 或可信项目的 `.codex/config.toml`。
4. 重启 Codex，运行 `codex mcp list`，并在会话中用 `/mcp` 检查两个 server。

不要把已有 `config.toml` 整体替换为模板。

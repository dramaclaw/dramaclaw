# Claude Code

1. 安装 Skill 到 `~/.claude/skills/dramaclaw-workflows` 或项目 `.claude/skills/`。
2. 用 `scripts/render_config.py --host claude-code ...` 生成 `.mcp.json`。
3. 将其中两个 `mcpServers` 合并到项目 `.mcp.json`，不要覆盖已有 server。
4. 重启 Claude Code，使用 `/mcp` 检查连接。

正式发布到 Claude Marketplace 时，可将本目录的 Skill 和 MCP 定义包装为 Claude Plugin；
业务 MCP 启动器仍应指向用户本机的 `dramaclaw-ce`。

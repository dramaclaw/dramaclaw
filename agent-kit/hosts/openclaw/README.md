# OpenClaw

OpenClaw 发行版的配置入口可能不同，因此本包提供标准 stdio `mcpServers` 对象，不假定某个
私有配置路径。用 `scripts/render_config.py --host openclaw ...` 生成后，在当前 OpenClaw 的
MCP 设置中导入两个 server。

将 Skill 安装到该发行版声明的 Agent Skills 目录。如果它不支持自动 Skill 发现，把
`skills/dramaclaw-workflows/SKILL.md` 作为项目指令导入，但仍保留两个 MCP server。

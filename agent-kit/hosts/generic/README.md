# Generic stdio MCP Host

把 `mcp.json` 中的两个 server 合并到宿主的 MCP 配置。宿主必须支持：

- stdio transport
- `command` + `args`
- server 级环境变量
- MCP tools；最好同时支持 MCP resources

如果宿主不支持 MCP resources，仍可通过 `workflow_skill_get` 和 `workflow_recipe_get` 工具
完成渐进式读取。Skill 安装位置遵循宿主自己的 Agent Skill 规范。

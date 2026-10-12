# WorkBuddy

WorkBuddy 不同版本的 MCP 配置位置可能不同。本目录仅提供标准 stdio `mcpServers` 对象。
使用 `scripts/render_config.py --host workbuddy ...` 渲染，然后合并到该版本提供的 MCP
设置。不要直接覆盖其现有工具配置。

如果当前版本支持 Agent Skills，安装 `dramaclaw-workflows`；否则把 `SKILL.md` 作为按需
工作流指令加载。MCP 仍是实际操作本机 DramaClaw 的必要边界。

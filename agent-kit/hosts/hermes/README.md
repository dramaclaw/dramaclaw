# Hermes

`dramaclaw-ce` 内置 Hermes 已原生加载 `.hermes/plugins/dramaclaw`、
`.hermes/plugins/freezone` 与相应 Skills，不需要再挂载本包 MCP，否则可能产生重复工具或
重复审批。

对于独立的第三方 Hermes：

1. 优先安装 CE 自带 Hermes 插件，保持原生审批链路。
2. 如果该 Hermes 发行版只支持标准 MCP，则按 `hosts/generic/mcp.json` 注册两个 stdio
   server。
3. 将公共 Skill 安装到其 Skill 目录。

不要在内置 Hermes 会话中同时启用原生 Freezone 插件和外部 `dramaclaw` MCP。

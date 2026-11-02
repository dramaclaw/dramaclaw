# 影游 MCP

影游工具由独立 stdio 服务 `dramaclaw_interactive_story` 提供：

```sh
uv run python -m novelvideo.chat.interactive_story_mcp
```

运行时需要绑定 `DRAMACLAW_PROJECT_ID` 和 `DRAMACLAW_CANVAS_ID`，设置
`DRAMACLAW_API_URL`，并通过 `DRAMACLAW_AGENT_TOKEN_FILE` 提供当前回合的 API
凭证。每次调用重新读取凭证文件；文件失效后调用会拒绝执行。服务不读取模型
供应商密钥，不要求加载 Hermes 插件，也不要求从仓库目录启动。

## 工具边界

独立服务提供以下 9 个工具，名称及输入、输出契约保持兼容：

- `dramaclaw_get_freezone_canvas`：读取当前画布及 revision。
- `dramaclaw_save_interactive_story_outline` / `dramaclaw_get_interactive_story_outline`：保存、读取大纲。
- `dramaclaw_create_interactive_story` / `dramaclaw_get_interactive_story` / `dramaclaw_patch_interactive_story`：创建、读取、修改故事。
- `dramaclaw_validate_interactive_story`：校验分支故事。
- `dramaclaw_get_interactive_story_progress`：读取阶段与进度证据。
- `dramaclaw_confirm_interactive_story_stages`：确认或重新打开创作阶段。

调用只能使用绑定的项目与画布。写入继续走现有 REST API，保留大纲确认门禁、
revision 冲突检查、幂等键和 `refresh_canvas` 回执。素材生成仍由现有画布工作流
承接，不在这个服务内重建执行器。

## 接入与兼容

Codex 的 Freezone 对话自动挂载三个 MCP：`dramaclaw` 管理画布操作，
`dramaclaw_workflows` 负责工作流发现与编译，`dramaclaw_interactive_story`
负责影游。自动配置为原画布服务添加 `--exclude-interactive-story`，在插件
构建前跳过影游定义及 handler 加载，避免重复暴露影游工具。

Claude 的应用内对话尚未自动接入独立影游 MCP；可以在外部 MCP 客户端手动
配置上述 stdio 入口，并提供绑定的项目、画布和 API 凭证。若同时配置原
`dramaclaw` 服务，应为原服务添加 `--exclude-interactive-story`。

主线插件不再加载或注册影游工具，通用 API 工具也拒绝影游创作与发布专属接口；
原有画布管理、画布读取和 Skill 能力保留。原入口不带排除参数时，仅在画布
模式下提供原生影游工具。主线工作区也不安装托管的 `interactive-story` Agent
Skill，并在下次初始化时移除旧副本；MCP 不向主线暴露它的 Skill 文档。
主线能力说明按当前会话限定，影游请求引导进入虾画。
Hermes 原生 Freezone 插件继续在其既有审批边界内
使用影游工具，不新增影游会话、工作目录或权限体系。两种接入共用
`novelvideo.chat.story_tools` 中的定义、作用域绑定和画布读取逻辑，API 与业务
模型仍位于现有影游模块；MCP 仅负责传输和凭证注入。

两个 MCP 入口共同使用 `novelvideo.chat.mcp_runtime` 处理协议、schema 校验、
handler 调度和结构化输出。影游错误修正及文本结果规则由
`novelvideo.chat.story_mcp_policy` 注入；画布与工作流规则由原入口注入。
独立影游服务不导入原 MCP、Freezone 模块或工作流 schema。

## 启动失败策略

Codex 自动挂载的三个服务均保持 `required=true`。其中任一服务启动失败，
当前对话回合应报错，不能以缺失影游工具的状态继续写入或自动改用普通画布
工具创建影游。独立进程提供工具边界，但当前配置不提供对话级故障降级。
服务启动成功后的单次 API/工具失败仍通过结构化错误返回，由回合既有规则
处理；不会因此开放其他项目或画布的访问。

## 开发与验证

原生 Hermes 需要在应用 venv 之外独立加载插件。修改共享工具定义或错误处理后，
运行 `python scripts/sync_interactive_story_tools.py` 更新标准库插件文件；
`--check` 和回归测试会检查这两份发布文件是否与共享源文件一致。

Freezone 的 Codex 线程协议版本为 `canvas-workflows-v30`；主线协议更新为
`tool-discovery-v4`，旧主线线程会重新建立，避免使用缓存的影游工具入口及
Skill 能力描述。
现有故事与大纲数据无需迁移。

回归覆盖真实 stdio 工具集合、在禁止旧 MCP/Freezone 导入时的影游调用、
主线不加载影游、通用 API 无法绕路调用、画布模式与 Hermes 的兼容、空画布
创建，以及凭证、作用域、revision 和幂等契约：

```sh
uv run python scripts/sync_interactive_story_tools.py --check
uv run pytest tests/test_mcp_runtime.py tests/test_interactive_story_mcp.py \
  tests/test_dramaclaw_mcp.py tests/test_dramaclaw_mcp_progressive.py \
  tests/test_hermes_dramaclaw_plugin.py tests/test_workflow_mcp.py \
  tests/test_mainline_story_boundary.py tests/test_api_interactive_stories.py \
  tests/test_chat_service_user_agent_scope.py tests/test_tool_policy_contract.py
```

# DramaClaw Agent Kit

面向本机源码可得 `dramaclaw-ce` 的跨 Agent Skill + MCP 发布包。它让 Codex、Claude Code、
OpenClaw、Hermes、WorkBuddy 及其他支持标准 stdio MCP 的 Agent 复用同一套 Workflow
Skill、Recipe 编译器、业务审批和 Freezone 画布写入链路。

## 边界

本目录是宿主适配包，不复制 DramaClaw 的业务实现：

```text
第三方 Agent
├── dramaclaw-workflows Skill
├── interactive-story Skill
├── dramaclaw-workflows MCP（只读、查询、校验、编译）
└── dramaclaw MCP（本地授权、业务 API、审批、画布提交、运行）
                              │
                              ▼
                    本机 dc/dramaclaw-ce
```

- `scripts/launch_mcp.py workflows` 启动公共 Workflow MCP。
- `scripts/launch_mcp.py tools` 启动授权 DramaClaw MCP，并复用 CE 内现有 Hermes 工具实现。
- Workflow MCP 与互动故事模块彼此独立：Workflow MCP 保持只读/编译；互动故事四个工具属于授权 DramaClaw MCP。
- 默认 `browser` 执行器下，普通 Freezone 节点/连线/工作流命令由浏览器执行，需打开对应项目/画布页面。服务端执行器支持无需浏览器的结构修改、上下文读取和受支持的运行，详见下方说明。互动故事 Create/Patch 通过 API 和 `InteractiveStoryService` 在后端原子写入画布，再由宿主根据写入回执刷新界面。
- 不包含 API Key、Agent Token、用户项目、SQLite、画布状态或生成媒体。
- 内置 Hermes 无需改链路；它继续使用原生插件。这个包只为外部 Agent 提供等价入口。

CE 内部运行时的 Skill owner 是 `src/novelvideo/agent_skills/`；`agent-kit/skills/` 是同步后的外部分发副本，不是 Docker 运行时依赖，因此无需把整个 `agent-kit/` 复制进应用镜像。

## 前置条件

1. 本机已有满足 `manifest.json` 中 capability contract 的 `dramaclaw-ce` 源码 checkout，
   并执行过 `uv sync`。校验只读取当前树中的契约标记和必需文件，支持 shallow checkout
   与源码归档，不依赖 Git 历史。正式版本发布后可再增加 release 下界。
2. API 只监听回环地址：

   ```bash
   cd /path/to/dramaclaw-ce
   DRAMACLAW_LOCAL_AGENT_TRUST=1 uv run novelvideo api --host 127.0.0.1 --port 8780
   ```

3. 默认 `browser` 执行器下，操作普通 Freezone 节点/连线/工作流时需保持对应项目/画布页面打开。服务端执行器下，结构修改、上下文读取和受支持的运行不需要浏览器；`html_artifact`、`open_mainline_projection`、`open_*` 节点动作及下方链接拒绝表中的情况仍需打开画布。互动故事 Create/Patch 不依赖浏览器完成服务端写入，但外部 MCP 当前不会主动广播刷新到浏览器。

付费生成、删除、清空的确认在 Agent 自己的对话中完成：用户明确同意后，Agent 调用
`freezone_confirm_canvas_action`。外部 Agent（无 `DRAMACLAW_TURN_ID`）不会显示澄清卡，
`freezone_request_user_clarification` 会立即返回 `clarification_ui_unavailable`，不创建卡片。
不得重试或换画布；明示合理假设后继续，或在自己的对话中询问用户。不得替用户选择生成参数
或升级到更贵的设置；缺失的图片、视频参数必须在对话中询问，付费确认规则仍然适用。
例外：用 agent key 换取会话时，新建图片或视频节点而用户没有指定分辨率或图片画质，Agent 可以
不填这两项，由服务端补成平台标准档，并在确认结果里标明哪些是平台标准默认、哪些是 Agent 显式
指定（详见 `docs/zh/guides/local-agent-mcp.md`）。

本地免 Token 模式只允许 `127.0.0.1`、`::1` 或 `localhost`。如果 API 可被局域网或公网访问，
不要开启 `DRAMACLAW_LOCAL_AGENT_TRUST`，应改用 CE 签发的短期 Agent Token。

## 安装 Skill

先把通用工作流 Skill 与互动影游 Skill 安装到 Agent 的 Skill 目录：

```bash
python3 scripts/install_skill.py --host codex
python3 scripts/install_skill.py --host codex --skill interactive-story
python3 scripts/install_skill.py --host claude-code
python3 scripts/install_skill.py --host claude-code --skill interactive-story
```

默认位置：

| Host | Skill 目录 |
|---|---|
| Codex | `~/.agents/skills/<skill-name>` |
| Claude Code | `~/.claude/skills/<skill-name>` |
| Hermes | `~/.hermes/skills/<skill-name>` |
| OpenClaw / WorkBuddy / 其他 | 使用 `--target /path/to/skills/<skill-name>` |

安装器不会覆盖已有目录。升级时先核对现有自定义内容，再显式传 `--replace`。

## 生成 MCP 配置

配置模板不含密钥。根据本机路径渲染：

```bash
python3 scripts/render_config.py \
  --host codex \
  --ce-dir /path/to/dramaclaw-ce \
  --project-id PROJECT_ID \
  --canvas-id CANVAS_ID \
  --output /tmp/dramaclaw-codex.toml
```

支持的 `--host`：

- `codex`
- `claude-code`
- `openclaw`
- `workbuddy`
- `generic`

渲染结果是待合并片段，不会自动覆盖 Agent 的现有全局配置。宿主说明见 `hosts/`。

Codex 模板不设置 `tool_input_schema_max_bytes`，沿用 Codex 默认：超过 5000 字节的工具输入 schema 会被压缩，嵌套字段可能缺失。画布命令的两个工具（`freezone_emit_canvas_command`、`freezone_validate_canvas_commands`）发布的是 5000 字节以内的精简 schema，`commands[]` 的字段完整可见，每种命令的必填字段写在说明里。其余被压缩的工具里，工作流草稿的拒绝信息附带改正示例，互动故事的拒绝信息列出操作名和必填字段但不带示例；画布命令的拒绝信息只在文本节点缺标题或正文时附带示例。不建议把这个上限整体调大：实测会让工具负载明显增大，并导致运行不稳定。

## 自检

```bash
python3 scripts/doctor.py --ce-dir /path/to/dramaclaw-ce
```

自检会确认：CE checkout、虚拟环境、两个 MCP 模块、Hermes 工具插件、两份公共 Skill 和本机
`/healthz`。它不会执行画布写入。

## MCP 启动命令

配置模板最终都调用同一个启动器：

```bash
python3 /path/to/dramaclaw-agent-kit/scripts/launch_mcp.py workflows
python3 /path/to/dramaclaw-agent-kit/scripts/launch_mcp.py tools
```

启动器通过 `DRAMACLAW_CE_DIR` 定位本机 CE，并优先使用 CE 的 `.venv`。重要环境变量：

| 变量 | 用途 |
|---|---|
| `DRAMACLAW_CE_DIR` | `dramaclaw-ce` checkout 绝对路径 |
| `DRAMACLAW_API_URL` | 默认 `http://127.0.0.1:8780` |
| `DRAMACLAW_USERNAME` | 本机 CE 用户名，默认 `local` |
| `DRAMACLAW_PROJECT_ID` | 当前项目；画布模式必须正确设置 |
| `DRAMACLAW_CANVAS_ID` | 当前 Freezone 画布 |
| `DRAMACLAW_AGENT_PROFILE` | 默认 `freezone:main` |
| `DRAMACLAW_AGENT_TOKEN_FILE` | 可选短期 Token 文件，优先于环境变量 Token、Key 和免 Token 模式 |
| `DRAMACLAW_AGENT_TOKEN` | 可选短期 Token，优先于 Key 和免 Token 模式 |
| `DRAMACLAW_AGENT_KEY_FILE` | 可选 Key 文件，优先于环境变量 Key；排在 Token 之后、免 Token 模式之前 |
| `DRAMACLAW_AGENT_KEY` | 可选 Key；MCP 通过 `POST /api/v1/agent/sessions` 换取短期会话，仅存内存。远程 API 必须使用 `https`，非 loopback 的 `http` 会被拒绝；不支持此端点的服务器（如本地社区 API）请使用默认免 Token 模式 |

在 API 服务端同时设置 `DRAMACLAW_AGENT_CANVAS_EXECUTOR=server` 和 `DRAMACLAW_CANVAS_PATCH_PUSH=1`（默认执行器为 `browser`），服务端可处理结构修改、上下文读取，并在无需打开画布的情况下运行受支持的节点动作和工作流，包括图片、文本、音频、视频生成及部分图片工具，3D 世界生成通过 `run_node_action` 启动。部分动作或参数组合仍会被拒绝，需要用户打开对应画布运行。支持列表、拒绝原因及恢复限制见[本机 Agent MCP 指南的“服务端执行器”](../docs/zh/guides/local-agent-mcp.md#服务端执行器)。

服务端执行器还支持 `freezone_list_canvases` 和 `freezone_create_canvas`；默认 `browser`
执行器拒绝这两个工具。列表返回 `bound_canvas_id`、各画布的 `created_from_this_chat` 和
`quota`。创建接收非空、最多 100 字符的 `name`，返回 `canvas_id`、`display_name`、
`revision`、`canvas_path`；同一请求重放可返回 `exists`，同名创建返回 `duplicate_name`
及 `existing_canvas_id`。每个用户在每个项目最多创建 25 个画布。绑定画布的聊天只能写入
绑定画布和本聊天创建的画布；操作新画布必须显式传 `canvas_id`，省略仍指向绑定画布。
新画布上的澄清返回 `clarification_ui_unavailable`，付费生成仍需正常确认。

## 发布前

在 `dramaclaw-ce` 根目录运行：

```bash
python3 agent-kit/scripts/sync_skill.py --check
python3 agent-kit/scripts/doctor.py --ce-dir . --skip-api
python3 agent-kit/scripts/render_config.py --host codex --ce-dir . --project-id demo --canvas-id demo
```

发布整个 `agent-kit/` 目录即可。许可证见 `LICENSES/Elastic-2.0.txt`，第三方声明见 `NOTICE`。

## 远程 MCP 中继（仅限本地验证）

在仓库根目录使用已安装的 Python 环境启动：

```bash
.venv/bin/python agent-kit/scripts/remote_mcp_relay.py --ce-dir "$PWD"
```

可通过 `--api-url`、`--username`、`--port` 分别指定 API 地址、用户名和监听端口。
`--api-url` 默认是 `http://127.0.0.1:8780`，必须使用 https 或回环地址 http。
`--api-url` 指向的 API 必须提供 `POST /api/v1/agent/sessions`；缺少此接口会使每个新会话返回 503。
中继在启动会话前通过 API（`POST /api/v1/agent/sessions`）校验 Key；拒绝返回 401，校验不可用返回 503。
新会话在确认携带 Bearer 后，先校验请求头及 JSON-RPC `initialize` 请求，再校验 Key、启动子进程。
初始化请求体最多 4 MiB，超过返回 413；无效请求返回可读的 JSON 错误，不调用 Key 校验接口或启动子进程。

使用 Streamable HTTP MCP 客户端连接 `http://127.0.0.1:8790/mcp/tools` 或
`http://127.0.0.1:8790/mcp/workflows`，并携带请求头
`Authorization: Bearer <agent key>`。这是唯一的凭据传入渠道；中继通过
`DRAMACLAW_AGENT_KEY` 将 Key 传给子进程，忽略中继自身环境中的 Agent Key/Token 变量。

路径支持以下形式，均可带末尾斜杠：

- `/mcp/{tools|workflows}`：自动绑定 Key 唯一可见的项目，否则保留 home scope。
- `/mcp/{tools|workflows}/projects/<project_id>`：项目 scope。
- `/mcp/{tools|workflows}/projects/<project_id>/canvases/<canvas_id>`：指定项目和画布。

ID 仅允许 `[A-Za-z0-9._-]`，长度为 1–128 个字符。路径包含项目时，Key 校验使用项目 scope。
要获得与 Codex 宿主配置等价的工具集（Freezone 画布工具），需使用带画布的项目路径；
子进程的项目和画布不继承中继环境中的值。

home 路径先以 home scope 校验 Key，再用交换得到的 Token 请求 `GET /api/v1/projects`。
恰好有一个可见项目且 ID 有效时，子进程绑定该项目 scope，画布保持未设置。
没有可见项目、存在多个项目或列表不可用（包括无效 ID）时，保留 home scope，并记录一行
`Home path kept home scope: <reason>`；原因分别为 `no visible project`、
`several visible projects` 或 `project listing unavailable`。
Token 仅在内存中用于此次查询，查询结束即丢弃，不写入 Session 或日志。
会话后续请求仍使用原 home URL；携带该会话 ID 访问项目路径会返回 404。
显式项目或画布路径不查询项目列表，始终使用路径指定的 scope。

可见多个项目的 Key 在静态 home URL 上只能获得 home-scope 工具；需要项目工具时，
请使用项目路径，或改用仅能访问一个项目的 Key。

每个会话启动一个子进程。以下参数默认读取对应环境变量，显式 CLI 参数优先：

| CLI 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--max-children` | `REMOTE_MCP_MAX_CHILDREN` | 32 |
| `--max-children-per-key` | `REMOTE_MCP_MAX_CHILDREN_PER_KEY` | 8 |
| `--idle-timeout` | `REMOTE_MCP_IDLE_TIMEOUT` | 600 秒 |
| `--disconnect-grace` | `REMOTE_MCP_DISCONNECT_GRACE` | 10 秒 |

两个上限必须是 ≥ 1 的整数，两个时间必须是有限正数。总会话数或单 Key 会话数达到上限时，
新初始化请求返回 HTTP 429，JSON-RPC 错误保留请求 id，并说明限额；现有会话不受影响。
限额包含正在创建的会话，单 Key 按 SHA-256 摘要计数，不保存原始 Key 用于计数。
限额仅作用于单个中继进程，不排队、不跨实例计数。因限额拒绝或无效的请求均不调用
Key 交换接口（`POST /api/v1/agent/sessions`），也不启动子进程。

空闲时间从最后一次 POST 结束时开始计算；没有 POST 请求进行时，即使 GET 流保持打开，
达到 idle timeout 也会结束会话。曾打开 GET 流的会话，在所有 GET 流关闭且没有 POST
请求进行时，从最后一次 POST 或 GET 结束起经过 disconnect grace 后结束。未打开过
GET 流的会话按 idle timeout 回收。DELETE 请求、子进程退出和中继关闭也会结束会话；
回收后释放名额。

中继默认只监听回环地址，仅用于本地验证，不用于生产环境。

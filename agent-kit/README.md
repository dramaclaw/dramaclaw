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

模板启用 `DRAMACLAW_CODEX_COMPACT_SCHEMAS=1`。它给工作流和互动故事的五个大工具发布精简参数形状，保留常用节点、连线、媒体引用和故事补丁操作。已有配置可在对应 MCP 服务的环境变量中加入此设置。服务端仍按完整契约校验。

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

API 服务端可设置 `DRAMACLAW_PUBLIC_ORIGIN`（例如 `https://app.example.com`），让外部 MCP 画布工具返回可打开的页面链接。留空时使用 `SUPERTALE_OPENFILM_STUDIO_PUBLIC_ORIGIN`。

服务端配置了对象存储时，`freezone_get_node_detail` 会为图片节点及其图片参考项返回 `image_url`：有时效的对象存储签名地址，宿主界面无需登录即可加载。仅后缀为 `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`、`.bmp`、`.avif` 的文件会返回 `image_url`（不区分大小写），其他文件（如 TIFF）仅返回 `canvas_url`。有效期由服务端的 `OSS_STATIC_PRESIGN_EXPIRES` 控制，默认 3600 秒。任何持有该地址的人都可在过期前查看图片。未配置对象存储或对象尚不可读时，结果省略该字段。此时，在不经产品聊天的外部宿主连接中，`freezone_get_node_detail` 不返回该图片的 `source_url` 与 `preview_url`（需登录的内部引用），改为返回 `image_unavailable_reason`（含 `code` 与 `message`），说明没有可分享的图片地址、图片可在画布页面查看；`freezone_get_selection` 与 `freezone_get_neighbor_graph` 对图片项同样处理。
视频和音频节点及其参考项在相同条件下会返回 `media_url`，
也是有时效的签名地址，使用同一个有效期设置。
视频支持 `.mp4`、`.mov`、`.webm`，音频支持
`.mp3`、`.wav`、`.m4a`、`.aac`、`.ogg`、`.webm`、`.flac`、`.opus`，
后缀不区分大小写。视频的 `preview_url` 封面不会单独签名。
非图片项有 `source_url` 或 `preview_url`、但没有可分享的地址时，
外部宿主收到的结果会省略这两个字段，
并返回 `media_unavailable_reason`（含 `code` 与 `message`）。
`freezone_get_selection` 和 `freezone_get_neighbor_graph` 同样处理，
并在原因中提示使用 `freezone_get_node_detail` 获取可分享的地址。

使用服务端画布执行器的外部 MCP 宿主可以调用 `freezone_get_upload_address`。该工具需要配置上文的公开访问源。成功时返回 `status: ready`、项目 ID `project_id`、上传地址 `upload_url`、有效秒数 `expires_in_seconds`、HTTP 方法 `method`（`POST`）、表单文件字段 `file_field`（`file`）、请求体大小上限 `max_bytes`、本地上传命令示例 `usage_example` 和操作说明 `agent_instruction`。没有可用的公开访问源时，工具会提示改用浏览器上传。通过该地址上传时，仅按文件名后缀检查文件类型，只接受支持的图片、视频和音频后缀，其他文件会被拒绝。地址有效期为 10 分钟，绑定到一个项目、该项目的上传端点和发起请求的用户，到期前可重复使用。任何持有该地址的人都能在过期前以该用户的身份向该项目上传文件。凭证位于查询字符串中，因此地址会出现在服务器访问日志中。上传成功后，用响应中的 `data.url` 调用 `freezone_create_node` 创建一个节点。图片用 `uploadNode`，填写 `imageUrl` 和 `previewImageUrl`。视频用 `videoNode`，填写 `videoUrl` 并设置 `referenceOnly: true`。音频用 `audioNode`，填写 `audioUrl`。三种节点都要用 `sourceFileName` 记录原始文件名。上传节点不能包含 `videoUrl` 或 `audioUrl`，外部 MCP 宿主发出的此类创建命令会被拒绝。宽度、高度和时长在创建时为空，之后在浏览器中打开画布并加载该媒体时补齐。视频按原样保存，不会转码。

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

## 远程 MCP 入口（API 进程内）

API 进程可以在自身端口的 `/mcp/` 下提供远程 MCP 入口，供外部 Agent 用 Agent Key 接入。默认关闭，
不挂载这些路径。

### 在本机开启

为 API 进程设置开关后启动（取值 `1`、`true`、`yes`、`on` 均视为开启，不区分大小写）：

```bash
DRAMACLAW_REMOTE_MCP_ENABLED=true uv run novelvideo api --host 127.0.0.1 --port 8780
```

开启后启动日志会输出一行 `Remote MCP entry enabled at /mcp/{tools|workflows}` 以及生效的并发上限。
入口在 API 进程内通过认证会话端口（auth session port）的 Agent Key 方法校验 Key、换取会话，
不经 HTTP 调用 `POST /api/v1/agent/sessions`。未提供 Agent Key 服务的安装（如本地社区版）对每个请求
返回 503，`code` 为 `agent_key_unsupported`，`detail` 说明这是服务端属性，与 Key 和请求无关。

### 接入

使用 Streamable HTTP MCP 客户端连接以下地址，并在每个请求上携带
`Authorization: Bearer <agent key>`，这是唯一的凭据传入渠道：

- `http://127.0.0.1:8780/mcp/tools`：画布工具。Key 恰好能看到一个项目且其 ID 有效时，自动绑定该项目；
  没有可见项目、有多个项目或项目列表不可用时保留 home scope。
- `http://127.0.0.1:8780/mcp/tools/projects/<project_id>`：指定项目。
- `http://127.0.0.1:8780/mcp/tools/projects/<project_id>/canvases/<canvas_id>`：指定项目和画布。
- `http://127.0.0.1:8780/mcp/workflows`：Skills/Recipes 工作流服务，读取的目录由 Key 的所有者决定。
  同样支持上面的 `/projects/<project_id>[/canvases/<canvas_id>]` 后缀。

路径均可带末尾斜杠。ID 仅允许 `[A-Za-z0-9._-]`，长度为 1–128 个字符；其他路径返回 404。
路径包含项目时，Key 以该项目的 scope 校验；显式项目或画布路径不查询项目列表。

入口无状态：每个 POST 独立完成，返回 JSON，不签发 `mcp-session-id`，不启动子进程；
GET、DELETE 返回 405，WebSocket 连接被关闭。每个请求都先通过端口校验 Key，因此撤销、过期或停用的 Key
在撤销后的第一个请求即被拒绝。校验通过后，API 进程在内存中按 Key 和 scope 缓存换得的短期会话，
会话距过期超过 60 秒时直接复用，否则重新换取；工具回调 API 时携带该会话。

- 缺少 Bearer 或 Key 为空时返回 401，`code` 为 `agent_key_required`（`Bearer key required`）。
- Key 无效、被撤销、已过期或所属用户被停用时返回 401，`code` 为 `agent_key_rejected`。
- Key 有效但不允许用于请求的项目时返回 403，`code` 为 `agent_key_project_forbidden`。
- Key 服务暂时不可用、校验无法完成时返回 503，`code` 为 `agent_key_check_unavailable`；
  这不是对 Key 的拒绝，稍后重试即可。
- 每个请求都在执行任何工具代码前校验 Key；`DRAMACLAW_LOCAL_AGENT_TRUST` 以及 API 进程环境中的
  Key、Token、项目、画布、用户变量对该入口无效，项目和画布只取自请求路径或自动绑定。
- 工具回调 API 时使用的地址，与对话后端的解析顺序相同：`DRAMACLAW_API_URL` →
  `NOVELVIDEO_API_URL` → `NOVELVIDEO_API_HOST`/`NOVELVIDEO_API_PORT` → `SUPERTALE_API_URL` →
  `http://127.0.0.1:8780`，通常无需额外设置。API 不在默认地址时，为 API 进程设置 `DRAMACLAW_API_URL`，
  指向 API 进程自身可达的地址。该地址必须是 https 或回环地址 http，否则返回 503，
  `code` 为 `agent_key_insecure_transport`。
- 带项目的 `tools` 请求（路径中指定项目，或 Key 只能访问一个项目）把画布命令和卡片事件写入该项目自己的
  事件目录，即浏览器中该项目的会话所监听的目录；API 进程环境中的 `DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR`
  对该入口无效。该目录位于项目数据所在的节点上：多节点部署时，请求必须落在项目的归属节点，
  否则入口无法确定目录（日志有一条 warning），需要浏览器执行的画布命令会等待到超时。

当 `/mcp/tools` 保留 home scope 时，tools 服务提供完整 Freezone 工具集和只读的
`freezone_list_projects`。模型应先列出项目，选择用户所指的项目（有歧义时询问，不猜测），再在每次其他
Freezone 工具调用中传入 `project_id`；同一连接可操作多个项目。initialize 返回的 instructions 会说明此流程。

### 对外入口的必要限制

入口本身不限制请求体大小，也不限速。如需对外暴露，前置的公共入口必须同时设置：
- 所有请求的请求体大小上限。
- 每个客户端及全局的并发连接上限，并建议设置请求速率限制。
- 请求头和请求体的读取超时，避免慢速上传长期占用连接。

未缓存会话的 Key（包括无效 Key）每个请求都会向 API 发起一次 Key 交换。

### 并发上限（按进程计数）

入口限制同时执行的请求数，超限的请求立即返回 HTTP 429，不排队：

| 环境变量 | 含义 | 默认值 |
| --- | --- | --- |
| `DRAMACLAW_REMOTE_MCP_MAX_CONCURRENT` | 单个 API 进程同时执行的远程 MCP 请求总数 | 进程默认线程池大小 `min(32, CPU 数 + 4)` 的一半，至少为 1 |
| `DRAMACLAW_REMOTE_MCP_MAX_CONCURRENT_PER_KEY` | 单个 API 进程内同一 Agent Key 同时执行的请求数 | 总数上限的一半，至少为 1 |

- **按进程计数，不是全局限制**：进程之间不共享计数。以多个 worker 运行 API 时，
  实际总上限 = 配置值 × worker 数，单 Key 的实际上限同理。一个请求落在哪个进程由前置的负载分配决定，
  因此同一 Key 在未达到“配置值 × worker 数”时也可能在某个进程上被拒绝。
- 两个值必须是 ≥ 1 的整数；空值、0、负数、小数或非数字按未设置处理，使用默认值。
  启动日志会输出实际生效的两个上限。
- 工具在进程的默认线程池中执行，并在其中等待对 API 的回调，而 API 自身的路由也使用同一线程池。
  调高总数上限时应低于该线程池的大小，为回调留出线程；否则工具与其回调会互相等待直到超时。
- 只有通过 Key 校验的请求才计数，计数覆盖校验通过之后的执行阶段，直到响应结束；
  缺少 Key、Key 无效或校验不可用的请求不占名额。请求结束、执行出错或被取消时都会释放名额。
- 进程总数已满时，请求在 Key 校验之前即被拒绝，不调用 Key 交换接口；此时无效 Key 得到的也是 429 而不是 401。
- 单 Key 按 SHA-256 摘要计数，Key 及其摘要不写入日志或响应。
- 拒绝响应带 `Retry-After: 1`，JSON 为 `{"error": "...", "code": "..."}`，`code` 为
  `remote_mcp_concurrency_limit`（进程总数已满）或 `remote_mcp_key_concurrency_limit`（该 Key 已满）。
  两种情况下请求本身都没有问题，稍后原样重试即可，无需修改参数。
- 该上限不排队、不限速、不跨进程计数，不能替代上一节的入口限制。

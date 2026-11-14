# 本机 Codex / Claude 使用 DramaClaw MCP

本文档说明如何让用户本机安装的 Codex、Claude、OpenClaw 等外部 Agent 操作本机运行的 `dramaclaw-ce`。

## 设计目标

本机模式不需要复杂的外部网关。推荐链路是：

```text
Codex / Claude / OpenClaw
  -> 本机 MCP server
  -> http://127.0.0.1:8780
  -> dramaclaw-ce API
  -> 现有任务系统 / Freezone 画布 bridge
```

MCP 只作为本机工具适配层；真正的项目、任务、画布操作仍由 `dramaclaw-ce` API 和前端画布执行。

## 启动 dramaclaw-ce

先启动本机 API：

```bash
cd /path/to/dramaclaw-ce
DRAMACLAW_LOCAL_AGENT_TRUST=1 novelvideo api --host 127.0.0.1 --port 8780
```

`DRAMACLAW_LOCAL_AGENT_TRUST=1` 表示允许本机 `127.0.0.1` / `::1` / `localhost` 来源的本地 Agent 请求跳过 token。

注意：

- 只建议绑定 `127.0.0.1`。
- 不建议在监听 `0.0.0.0` 或局域网可访问时开启。
- 默认 `browser` 执行器将画布写操作交给 Freezone 前端执行，需打开对应画布；无需浏览器的能力见下方“服务端执行器”。
- 覆盖、删除、重摄入等高风险业务操作仍应保留业务确认。

## MCP Server

业务工具与只读 Workflow 目录使用两个明确边界：

```bash
python agent-kit/scripts/launch_mcp.py tools
python agent-kit/scripts/launch_mcp.py workflows
```

两个入口分别暴露：

- `tools`：经过授权的 `dramaclaw_*` 业务操作和 `freezone_*` 画布写入。
- `workflows`：Workflow Skill/Recipe 查询、验证与只读编译。
- `tools` 中的 `dramaclaw_{create,get,patch,validate}_interactive_story`：互动故事结构化创建、读取、增量修改与校验。

`tools` 底层复用 `.hermes/plugins/dramaclaw` 和 `.hermes/plugins/freezone` 的现有工具实现。

默认环境会自动补齐：

- `DRAMACLAW_API_URL=http://127.0.0.1:8780`
- `DRAMACLAW_LOCAL_AGENT_TRUST=1`
- `DRAMACLAW_EXTERNAL_MCP=1`
- `DRAMACLAW_USER=local`
- `DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR=state/<user>/.hermes-freezone/tmp/supertale_canvas_command_bridge`

其中 bridge 目录使用共享根目录，方便当前浏览器中的 Freezone 会话监听并执行画布命令。外部 Agent 的确认在自己的对话中完成。只有在调试特定 Agent profile 时，才需要手动覆盖 `DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR`。

### 列出与创建画布

`freezone_list_canvases` 和 `freezone_create_canvas` 需要服务端执行器；默认 `browser`
执行器返回 `canvas_server_executor_required`。两者都使用当前项目或显式 `project_id`，
不能跨越会话绑定的项目。

- `freezone_list_canvases` 返回 `bound_canvas_id`、`canvases`、`count` 和 `quota`。
  每个画布包含 `canvas_id`、`display_name`、`kind`、`creator_username`、
  `created_by_viewer`、`created_from_this_chat` 和 `modified_at`。
- `freezone_create_canvas` 接收 `name`（去除首尾空白后不能为空，最多 100 个字符）。
  成功返回 `canvas_id`、`display_name`、`revision` 和 `canvas_path`；同一请求重放可返回
  `status="exists"`。同名画布不会再创建，拒绝结果为 `duplicate_name`，并给出
  `existing_canvas_id`。每个用户在每个项目最多创建 25 个画布；配额状态由 `quota` 返回。

绑定画布的聊天在服务端执行器下只能写入绑定画布及 `created_from_this_chat=true`
的画布；同名画布或当前用户创建的其他画布不因此自动获得写权限。写入新画布时每次显式
传入 `canvas_id`，省略它仍指向绑定画布。新画布上的付费生成仍遵循正常确认规则。
澄清卡只能由绑定画布的产品聊天轮次读取；向本聊天创建的其他画布请求澄清会返回
`clarification_ui_unavailable`，不会把卡转移到绑定画布。

## Codex 配置示例

推荐使用仓库虚拟环境里的 Python：

```json
{
  "mcpServers": {
    "dramaclaw": {
      "command": "/path/to/dramaclaw-ce/.venv/bin/python",
      "args": ["/path/to/dramaclaw-ce/agent-kit/scripts/launch_mcp.py", "tools"],
      "cwd": "/path/to/dramaclaw-ce",
      "env": {
        "DRAMACLAW_API_URL": "http://127.0.0.1:8780",
        "DRAMACLAW_LOCAL_AGENT_TRUST": "1",
        "DRAMACLAW_EXTERNAL_MCP": "1",
        "DRAMACLAW_USER": "local"
      }
    },
    "dramaclaw-workflows": {
      "command": "/path/to/dramaclaw-ce/.venv/bin/python",
      "args": ["/path/to/dramaclaw-ce/agent-kit/scripts/launch_mcp.py", "workflows"],
      "cwd": "/path/to/dramaclaw-ce",
      "env": {
        "DRAMACLAW_USERNAME": "local"
      }
    }
  }
}
```

如果要操作虾画画布，建议补充当前画布上下文：

```json
{
  "DRAMACLAW_CHAT_SURFACE": "freezone",
  "DRAMACLAW_CANVAS_ID": "当前画布 ID"
}
```

没有 `DRAMACLAW_CANVAS_ID` 时，部分 Freezone 工具会要求调用时显式传 `canvas_id`。

## Token 模式

如果不想开启本机 trust，可以使用 token：

```json
{
  "env": {
    "DRAMACLAW_API_URL": "http://127.0.0.1:8780",
    "DRAMACLAW_AGENT_TOKEN": "xxx"
  }
}
```

有 token 时，插件会发送：

```http
Authorization: Bearer xxx
```

没有 token 且未开启 `DRAMACLAW_LOCAL_AGENT_TRUST=1` 时，工具会拒绝调用。

## 画布操作说明

删除节点、清空画布、会消耗积分的生成需要确认（30 分钟有效，过期需重新确认）；其它结构改动直接执行。外部 Agent 在自己的对话里得到用户明确同意后调用 `freezone_confirm_canvas_action`，取消用 `freezone_cancel_canvas_action`。默认 `browser` 执行器运行节点和工作流需要浏览器打开画布；服务端执行见下方“服务端执行器”。

互动故事四个工具是例外：Create/Patch 调用 CE API，由 `InteractiveStoryService` 在后端写入完整故事投影，不写 pending canvas command。产品内 Agent 会根据成功工具帧自动刷新当前画布并保护未保存本地编辑；外部 MCP 客户端当前没有通用的浏览器刷新广播，写入后需要宿主适配刷新或手动刷新/重新打开画布。

外部 Agent 的付费生成、删除和清空确认在 Agent 自己的对话中完成；得到用户明确同意后，
调用 `freezone_confirm_canvas_action`。

当外部 Agent 真正运行图片或视频节点时，授权 MCP 会在审批和画布写入前执行参数预检。
如果模型、比例、分辨率/质量、时长、声音开关或数量仍有缺项，会返回
`generation_parameters_required`，`missing_parameters[].fields` 列出每个节点缺少的字段。
有产品聊天监听时，Agent 应使用 `freezone_request_user_clarification` 一次询问全部缺项，
再以同一个工作流草稿或计划重试。
外部 Agent（`DRAMACLAW_EXTERNAL_MCP=1` 且无 `DRAMACLAW_TURN_ID`）没有可回答澄清卡的界面：
澄清工具立即返回 `clarification_ui_unavailable`，不创建卡片。Agent 不得重试或换画布；
可明示合理假设后继续，或在自己的对话中询问用户。此时缺参数结果不带澄清卡，
`required_choices` 直接使用节点数据字段名（与 `missing_parameters[].fields` 一致，视频分辨率在
`quality`）；Agent 在自己的对话中一次问齐这些字段，不得替用户选择或升级到更贵的设置，
拿到回答后用补全的参数重试一次。付费操作仍需用户明确同意后调用
`freezone_confirm_canvas_action`，不得静默采用默认值。普通空节点创建、连线、
归组、布局、文案及独立音频设置不受该预检影响。

运行命令无效时，错误信息会点名第几条命令（`commands[N]`）、哪个字段，以及可用的取值或形状；
Agent 应改正该命令后重试一次，不要原样重发。对同一对节点、同一组连接点、同一种连线语义再次
`create_edge`（例如 `add_next_node` 已自带连线）时，画布只保留一条边，`create_edge` 按成功处理并在
结果里返回已有边的 id；连接点或连线语义不同的边照常新建。

用户在询问卡中选择“推荐模型”时，Agent 应传递标准符号值 `"recommended"`，不得自行猜测
具体模型 ID。授权 MCP 会在提交画布前移除该符号值，由本地画布使用当前实际可用的默认模型；
因此也不需要为了替换推荐项而重新生成整份工作流图。

### 服务端执行器

在 API 服务端同时设置 `DRAMACLAW_AGENT_CANVAS_EXECUTOR=server` 和 `DRAMACLAW_CANVAS_PATCH_PUSH=1` 即可启用，默认执行器为 `browser`。服务端处理结构修改、上下文读取，以及下列受支持的节点动作和工作流，无需浏览器打开画布。确认规则与浏览器相同，付费生成仍需用户确认；费用归发起运行的用户，每次媒体提交计费一次。

`run_workflow` / `run_node_action` 支持以下动作，仍受下表拒绝条件限制：

- `generate_image`、`generate_text`、`generate_audio`。
- `translate_text` 仅限 `audioNode`，`generate_video` 仅限 `videoNode`。
- `generate_3gs_world` 仅限 `threeDWorldNode`，通过 `run_node_action` 启动。3D 世界节点不属于工作流节点类型，`run_workflow` 不包含它们，浏览器也一样。
- 图片工具仅限 `imageGenNode`、`uploadNode`、`imageNode`、`exportImageNode`：`run_outpaint_tool`、`run_upscale_tool`、`run_grid_multi_camera`、`run_grid_plot_four`、`run_grid_face_three_view`、`run_grid_product_three_view`、`run_grid_serial_storyboard_25`、`run_grid_cinematic_light_correction`、`run_grid_character_three_view`、`run_grid_scene_setting_sheet`、`run_grid_frame_projection_3s_later`、`run_grid_frame_projection_5s_earlier`。

以下情况需要打开对应画布：

| 原因码 | 拒绝条件 |
|---|---|
| `action_not_on_server` | 动作不在支持列表中，或节点类型不受支持。例如 `auto_compose_video`、`run_audio_separate`、`run_video_analyze_story`、`start_video_breakdown`、`generate_html`、`run_skill`、`generate_text_video`、`run_scene360_tool`、`run_matting_tool`。 |
| `mixed_commands` | 一次调用同时包含运行命令和需要打开画布的命令（`html_artifact`、`open_mainline_projection`、`open_*` 节点动作），整次调用不能在服务端运行。 |
| `world_recipe` | 3D 世界节点设置了 `workflowCatalog.recipeId`。 |
| `video_count` | 视频节点的 `count` 大于 1。 |
| `video_story_continuity` | 视频节点带 `storySegmentId`、`storyRole=start` 或连接 `storyChoiceEdge`，且 `continuityMode` 为 `auto` 或 `independent`。 |
| `recipe_required` | 仅在启用用量计量时，模型动作没有所需的 Recipe。 |
| `mainline_auto_commit` | 系统管理的图片节点开启了生成后自动提交主线（`autoCommitOnGenerate`），服务端没有提交主线的路径。 |

全部动作被拒绝时，工具返回 `canvas_open_required` 和拒绝列表，用户需打开画布运行。仅部分动作被拒绝时，其余可运行动作继续执行，拒绝项及原因列在运行记录中；依赖失败动作的下游会被阻断。

一次调用同时包含画布修改（建节点、连线、分组、布局、选择等）和运行命令时，确认后服务端先应用修改，再按修改后的画布规划并启动运行；运行命令可以引用同一次调用新建节点的 `client_id`。修改失败时不启动运行。修改已应用但运行因上表原因或其它原因未启动时，修改保留，确认结果的 `run.status` 为 `not_started`，`run.code` 给出原因码。

最后一层执行完后，`finalize_run` 会像浏览器一样将已完成的分镜图片挂回原故事段落，挂接警告记录在 `story_attach_warnings`。

同一次运行由一个进程持有 180 秒租约并持续续租。进程退出后，租约到期，恢复扫描每 30 秒检查一次，由另一个 API 进程接管并继续剩余动作；已完成、失败、跳过或阻断的动作不会重新执行。在已确认原进程退出时，其在途 inline 生成任务会标记为失败，节点显示 `执行该任务的服务进程已退出,任务已中断,请重新发起`。该任务不会自动重新提交，不会因此产生第二次费用，用户需重新运行。

结果丢失窗口是：向上游提供方提交任务后、保存输出前。当前代码未在等待结果前将提供方任务句柄持久化到可恢复的任务状态；如果进程在此期间退出，提供方仍可能完成任务并计费，但结果无法重新挂接，会丢失，节点显示上述失败消息。中断任务的预留费用目前既不结算也不退还，这是已知限制。

同机多进程必须共享运行目录 `NOVELVIDEO_RUNTIME_DIR`，通过 `task_owners` 中的进程文件锁判断在途任务的原进程是否仍存活。跨主机的 owner 检查返回未知，即使共享目录也不会据此把任务标记为失败，因此不能依赖上述进程退出检测完成跨主机恢复。

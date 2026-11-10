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
- 画布写操作默认仍交给 Freezone 前端执行，以保持即时同步；外部 Agent 在自己的聊天中完成审批后，前端会自动执行，不再打开虾画内置聊天审批。
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

其中 bridge 目录使用共享根目录，方便当前浏览器中的 Freezone 会话监听并弹出审批。只有在调试特定 Agent profile 时，才需要手动覆盖 `DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR`。

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

删除节点、清空画布、会消耗积分的生成需要确认（30 分钟有效，过期需重新确认）；其它结构改动直接执行。外部 Agent 在自己的对话里得到用户明确同意后调用 `freezone_confirm_canvas_action`，取消用 `freezone_cancel_canvas_action`。运行节点和工作流仍需要浏览器打开画布。

互动故事四个工具是例外：Create/Patch 调用 CE API，由 `InteractiveStoryService` 在后端写入完整故事投影，不写 pending canvas command。产品内 Agent 会根据成功工具帧自动刷新当前画布并保护未保存本地编辑；外部 MCP 客户端当前没有通用的浏览器刷新广播，写入后需要宿主适配刷新或手动刷新/重新打开画布。

`DRAMACLAW_EXTERNAL_MCP=1` 只用于外部 Agent 入口。需要确认的操作在有当前对话轮次且画布打开时显示虾画聊天确认卡，否则在对话中请求确认。

当外部 Agent 真正运行图片或视频节点时，授权 MCP 会在审批和画布写入前执行参数预检。
如果模型、比例、分辨率/质量、时长、声音开关或数量仍有缺项，会返回
`generation_parameters_required`。Agent 应使用 `freezone_request_user_clarification` 一次询问
全部缺项，再以同一个工作流草稿或计划重试；不得静默采用默认值。普通空节点创建、连线、
归组、布局、文案及独立音频设置不受该预检影响。

用户在询问卡中选择“推荐模型”时，Agent 应传递标准符号值 `"recommended"`，不得自行猜测
具体模型 ID。授权 MCP 会在提交画布前移除该符号值，由本地画布使用当前实际可用的默认模型；
因此也不需要为了替换推荐项而重新生成整份工作流图。

在 API 服务端设置 `DRAMACLAW_AGENT_CANVAS_EXECUTOR=server`（默认 `browser`），Agent 的结构修改和上下文读取会由服务端画布执行器处理；运行节点、工作流等 host 命令仍需打开对应画布。`server` 要求同时启用 `DRAMACLAW_CANVAS_PATCH_PUSH=1`。

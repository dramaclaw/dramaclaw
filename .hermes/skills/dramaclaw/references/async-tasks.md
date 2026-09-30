# Async Tasks

异步任务的目标是：**按用户要求启动、观察或继续任务，并用最小必要状态对外汇报。**

## 适用场景

- 启动某个异步任务
- 看下当前进度
- 持续跟踪直到完成
- 从断点继续等待

## 默认策略

- 用户只说“启动并看下当前进度”时，做 one-shot 状态检查，不自动升级成持续跟踪。
- 用户明确要求“持续看 / 实时跟 / 一直盯到完成”时，也只允许观察当前任务状态，不允许在任务完成后继续启动下一步。
- 当前状态不是 `completed` 时，明确告诉用户当前状态，不要压缩成“已完成”。
- 长任务最终回复默认只保留“已完成什么 / 当前状态 / 下一步”，不把阶段性排查过程串成对外日志。
- 任何异步任务处于 `queued` / `running` / `pending` 时，本轮只反馈“后台正在生成中”和当前任务状态；不得启动依赖它的下一步。

## one-shot 状态查询

默认输出只保留：

1. 是否已启动
2. 当前状态/进度
3. 必要时的一句下一步建议

不要把准备动作、接口确认、重试判断过程串成面向用户的日志。

### one-shot 默认路径

- 启动前先看是否已有同类或依赖任务处于 queued/running/pending；如果有，直接反馈任务进行中并停止
- 没有运行中任务时，才启动当前请求对应的一个任务
- 如果启动接口返回 `ok:false`、HTTP 非 2xx、或响应里有明确 `error`，立即把该错误原文摘要反馈给用户，不要说“已启动”
- 再查一次对应 task 状态
- 如果这一次查询返回的仍是 `queued` / `running` / `pending`，就按当前状态收口，不继续循环轮询到完成，也不启动下一步
- 如果这一次查询返回 `failed` / `cancelled`，必须把 `task.error`、`error_code` 或 `logs` 中最直接的一句失败原因反馈给用户，不要压缩成“已启动”或“已重做”
- 如果 task 状态已经足够，就直接据此回复
- 只有 task 状态不足以解释当前阶段时，才补一次全局状态说明
- 对任务取消/清理这类 task-management 请求：状态确认只使用 `GET /api/v1/projects/{project}/tasks`、`GET /api/v1/projects/{project}/tasks/{type}/{episode}`，必要时最多补一次 `GET /api/v1/projects/{project}/pipeline/status`
- 不要探测 `GET /api/v1/projects/{project}/status`，这不是当前可用的任务状态路由
- **任务状态路由统一在 `/api/v1/projects/{project}/tasks/` 下**；不要探测顶层 `/api/v1/tasks/...`，当前后端没有该路由。

### one-shot 输出模板

- `已启动 <任务名>。`
- `当前状态：<queued/running/completed/failed/cancelled>`，必要时补一句进度或限制
- 失败时：`失败原因：<task.error 或接口 error>`
- `如果你要，稍后我可以继续查看进度；等当前任务完成后再执行下一步。`

## 持续观察

- 仅在用户明确要求持续跟踪时使用
- 持续观察时，单轮最多 4 次状态查询；一旦拿到 `completed` / `failed` / `cancelled` 就立即停止
- 面向用户只展示自然语言进度，不展示原始 JSON
- 任务完成后收口到结果状态，不继续复述整个观察过程，不启动下一步
- 状态查询只使用 DramaClaw 插件工具，不调用 shell、curl 或本地脚本解析响应。

## 恢复与冲突

- 已有项目恢复：优先看 `playbooks/resume.md`
- 任务冲突：先查当前状态，再决定等待、恢复或重试
- 没有新事实前，不要盲目重试
- 对 one-shot 请求，不要为了“更稳”反复混用多条状态线，也不要先去看 API 文档页做二次确认

## 单 beat 任务完成后的边界

- **单 beat 视频重做** (`single_video`)：同一用户请求里同一 beat 的重做 POST 只发一次。POST 返回 2xx 且 `ok`/`generated: true` 后，直接按已启动或当前查询到的任务状态收口；不要因为任务查询返回 `Task not found`、任务状态缺失或没有 `result.video_path` 再 POST 一次。**如果随后查到同一 `single_video` 任务为 `failed` / `cancelled`，必须反馈失败原因（例如积分不足、上游拒绝、下载失败），不能说成已完成/已重做。**不要为了获取视频文件而触发整集 compose/generate/optimize，也不要猜测文件下载路径。
- 如果 `single_video` 状态没有返回 `result.video_path`，不要探测 `/files`，不要探测 `/api/v1/projects/{project}/files`，只能按已启动或当前状态收口。
- **单 beat 音频重做**：同步返回，直接告知完成即可。
- 原则：单 beat 操作的范围就是那个 beat，不要升级为整集操作。
- **场景锚图生成**：**不是异步任务**。当前后端没有 `/scenes/{name}/anchor-image/*` 路由，也没有 `scene_anchor` task type；不要调用锚图生成或查询路径。

## 检查点异常处理

- 如果异步任务状态显示 `completed`，但检查点应交付的核心产物仍为空：
  - 先把它当成**异常断点**
  - 直接向用户汇报“任务完成但产物为空/不可审阅”
  - 默认停在当前检查点
- 在同一轮 continuation / checkpoint 请求里：
  - 不自动重触发同一步生成
  - 不手工补写本应由生成步骤产出的核心内容
  - 不把异常断点伪装成“已正常到达检查点”
- 只有用户明确要求继续补救、重跑或改为手工方案时，才进入下一轮补救动作

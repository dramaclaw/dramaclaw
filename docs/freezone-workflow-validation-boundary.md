# Freezone 工作流校验与确认边界

工作流计划、Agent 返回的 `compiled.ok` 和工具成功消息均不是执行授权或完成凭证。

- 草稿创建、修改及领取确认任务时，API 使用已认证用户的 Skill/Recipe 目录重新校验计划。
  不使用进程环境中的用户名，不信任调用方提交的预检结果、节点计数等派生字段。
- 计划与画布命令共用文本连线角色检查。没有角色的普通文本可按边推断用途；明确声明的
  `semanticOutputRole` 和兼容字段 `ioRole` 不得为通过校验而被改写。
- 确认只能执行保存版本中的 `run_after_create`。改变执行策略必须先修改草稿、增加版本，
  再确认新版本；不能在确认工具调用中覆盖。
- 确认工具的节点命令携带草稿版本和持久任务 ID。API 从待处理命令读取这些绑定，不能
  从回执请求体接受替代值。迟到回执不得结束不同版本或不同任务。
- 普通完成接口只接受绑定任务、版本的提交/失败状态更新，不接受 `confirmed`。
  成功交付由浏览器会话回执处理；Agent 会话不得提交画布执行回执。
- HTTP、运行中的 WebSocket 和空闲 WebSocket 使用同一回执处理入口。工作流确认
  必须走该入口，即使配置了 MCP 直接写画布，也不走缺少回执的直接应用路径。
- 画布确认只证明画布操作交付，不代表媒体生成完成。后续生成继续经过现有项目权限、
  模型能力检查、任务信封验证及计费流程。

部署时后端与 Freezone 插件需配套更新。旧插件没有携带任务/版本绑定的在途回执会被
拒绝确认；应先排空正在确认的工作流再更新，更新后启动新 Agent 会话。不要通过手工
标记 `confirmed` 或关闭校验恢复旧任务。

回归覆盖见 `test_workflow_semantics.py`、`test_api_freezone_workflow_runs.py`、
`test_freezone_workflow_drafts.py`、`test_freezone_plugin.py` 和 `test_chat_route_prewarm.py`。

## 第三方固定流程工具（workflow-operations.v1）

业务实现位于后端 `workflow_transactions.py`，MCP 只负责带身份转发。
新增 `freezone_prepare_workflow`、`freezone_revise_workflow`、`freezone_get_workflow`、
`freezone_get_workflow_capabilities`。准备和修改均只需一次 HTTP 请求，返回摘要，
无需 Agent 下载、重写、回传整个编译结果。旧工具继续兼容。

- POST workflow-drafts 接收 intent 或完整 plan，可附带业务用途 bindings；后端编译校验。
- PATCH workflow-drafts 接收 expected_revision + changes；后端读取、修改、校验并 CAS 保存。
- GET workflow-drafts/{id}?view=summary 返回草稿和确认状态，避免回传全图。
- GET workflow-capabilities 返回协议版本和执行适配能力。

目录快照绑定 API 认证用户，以 ContextVar 隔离并发请求，不修改进程环境。
连线绑定不改变已有文本角色；规划内容用于生成时，必须提供独立的实际提示词。
非法修改不会持久化；版本冲突和超时不得盲目重试或自动采用新版本。

Agent Kit 0.2.0 要求 workflow-operations.v1，并同步发布 Skill。
当前仍使用 canvas_approval_bridge，headless_execution=false：支持第三方准备、修改与查询，
不代表已提供独立的后台媒体执行器。权限、计费准入、确认任务和浏览器回执约束保持有效。


## 运行预检与跟踪补充（Agent Kit 0.3.0）

模型能力校验集中在 workflow_preflight.py；旧插件和 API 复用同一实现。API 在创建、修改、
claim 前读取认证用户的实时目录，不采信调用方的预检通过标记。校验比例、分辨率、质量、
时长范围、伴音支持与参数类型。模型目录不可用时阻止显式模型请求；队列信息不可用时警告，
最终入队仍使用既有权限和限额检查。

运行详情查询现与列表共用任务及产物对账。freezone_observe_workflow_run 提供最多 20 秒
的有界等待、状态令牌、进度摘要与恢复建议；请求结束后不会保留后台轮询任务。
读取超时可重试查询；生成超时、连接中断等结果不确定情况要求先对账。观察工具不重放付费
生成、不接管运行租约、不改变确认权限。持续后台调度仍不属于当前画布适配器的能力。

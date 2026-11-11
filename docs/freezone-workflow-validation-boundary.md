# Freezone 工作流校验与确认边界

## 草稿准备契约与诊断

`freezone_prepare_workflow_draft` 的工具 Schema 同时要求 `operation_id` 和结构化
`intent`，嵌套字段继续引用公开 WorkflowIntent Schema。已有合法调用保持兼容；旧客户端
漏参仍由处理函数拒绝，不自动补写模型决策或放宽后端校验。
通用 `freezone_prepare_workflow` 的 Schema 声明 `intent` / `plan` 必须且只能提供一个，
与已有处理函数保持一致；完整 Plan 入口继续要求 `operation_id` 和 `plan`。

推荐模型在 Intent 中填写 `inputs.image_model` / `inputs.video_model`，完整 Plan 使用
`nodes[].data.model`；不要把模型字段写进 Intent items。共享规划说明同时用于规划包和
草稿工具描述。推荐值仍必须通过当前用户目录、模型能力、权限、计费准入及用户确认。

三个草稿准备入口在工具返回后记录 `workflow_draft.<prepare|intent|plan>` 计数：
`calls`、`outcome.<success|rejected|clarification|exception|unknown>`、耗时区间，以及固定
白名单内的错误码和归一化字段路径。可从既有 `/diagnostics/evidence` 的 `counters` 读取。
日志 `workflow_draft.prepare` 另外包含毫秒耗时与服务端操作 ID 的不可逆摘要，可按摘要
关联多次调用，计算每次准入的调用次数；缺少合法操作 ID 时不生成关联摘要。

诊断不记录提示词、原始错误正文、素材、用户自定义节点 ID、密钥或完整请求。字段路径
中的节点标识替换为 `*`，数组位置统一为 `[]`。诊断计数单次批量写入，进程锁和 SQLite
锁各等待最多 50ms；忙时跳过计数、保留日志。诊断失败不会改变原工具返回值或异常，
也不决定是否重试、修补方案、保存草稿或创建画布。此阶段不改变默认规划或重试策略。

## 执行边界

准备或修改草稿的成功结果表示等待用户确认，不要求画布写入回执；只有确认创建等
实际画布写入仍受回执检查约束。同一轮后续写入失败或草稿修订失败，不能被先前
草稿准备成功的状态掩盖。

模型兼容性预检返回的 `affected_node_ids` 属于尚未落图的 Plan。参数确认使用
服务端返回的问题；兼容旧调用传入这些编号时，必须与该作用域的预检目标完整匹配，
不能用它们跳过普通画布视频节点的模式校验。预检证明只在确认卡成功保存后消耗，
参数校验或保存失败可修正后重试；已保存的卡通过同一个 `clarification_id` 恢复。
证明继续受项目、画布、有效期和并发防重复约束，不构成运行媒体生成的授权。

工作流计划、Agent 返回的 `compiled.ok` 和工具成功消息均不是执行授权或完成凭证。

- 草稿创建、修改及领取确认任务时，API 使用已认证用户的 Skill/Recipe 目录重新校验计划。
  不使用进程环境中的用户名，不信任调用方提交的预检结果、节点计数等派生字段。
- 计划与画布命令共用文本连线角色检查。没有角色的普通文本可按边推断用途；明确声明的
  `semanticOutputRole` 和兼容字段 `ioRole` 不得为通过校验而被改写。
- 确认只能执行保存版本中的 `run_after_create`。改变执行策略必须先修改草稿、增加版本，
  再确认新版本；不能在确认工具调用中覆盖。
- 常规工作流准备可省略 `run_after_create`，保持原来的默认 `false`（仅创建，不运行）。
  只有通过 `source_context.targets` 或 `source_context.asset_targets` 绑定影游目标的计划，
  才要求显式传入布尔值。API 先核验绑定的故事、素材和节点，再检查执行策略；不按 Skill 名
  或画布上是否存在故事统一判定。无效绑定仍拒绝，不能用伪造或损坏的目标绕过校验。
  影游绑定计划漏参返回 `story_execution_policy_required`，可补传后重试；拒绝时不保存草稿。
  MCP 原样保留参数缺失，不能提前把缺失转成 `false`。显式 `true`/`false` 和已有草稿的
  保存策略保持不变，修改已有草稿时省略该字段仍沿用保存值。
- 用户以“可以”“确认”等简短回复确认上一轮方案时，继承已说明的执行策略；含生成/运行
  的方案传 `true`，仅创建画布的方案传 `false`。准备草稿本身不启动生成。
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

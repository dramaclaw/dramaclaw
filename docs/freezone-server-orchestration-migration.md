# Freezone 服务端编排迁移决策

状态：Proposed  
目标分支：staging  
关联：#557、#558、#559

## 决策摘要

Freezone Workflow 的最终目标是由服务端 Orchestrator 独占状态推进权。浏览器负责编辑
Draft、提交批准、执行必须依赖浏览器能力的 UI 命令，以及把服务端事件投影到 Canvas；
浏览器不得自行确认持久化 Action 已完成。

迁移采用“先建立契约和持久化通道，再转移调度权，最后删除旧状态机”的顺序。迁移期间
每个 Run 只允许一个执行 owner，禁止同一个 Run 同时由 browser runner 和 server
orchestrator 推进。

## 不变量

1. Agent 只能提出版本化 Workflow Draft，不能直接创建已批准 Run。
2. 用户批准产生不可变的批准记录；Commit 和主线同步始终停在人工闸口。
3. Run、Action、Task、Artifact、Product Operation 使用同一组关联 ID。
4. Action 进入 completed 前必须满足其 `action_type` 对应的服务端证据策略；不得把
   Task/Artifact 作为所有动作的统一前提。
5. 终态单向推进；迟到回执不能覆盖 applied、failed、cancelled、expired 或 completed。
6. 同一 Command 的投递重试复用命令级幂等键并增加 attempt；dead-letter 重放使用新的
   命令级幂等键，但复用业务操作级幂等键，确保不重复应用 Canvas mutation 或重复扣费。
7. Canvas 是 Run 的可重建投影，不是执行事实源。

## 目标边界与依赖方向

```text
Web / Agent
    │  draft、approve、cancel、subscribe
    ▼
Workflow Application
    ├── Tool Policy / Approval Policy
    ├── Workflow Schema
    └── Orchestrator
          │
          ├── Workflow Repository
          ├── Command Inbox / Outbox
          ├── Task Port
          ├── Artifact Verifier
          └── Product Operation Port
                    │
                    ▼
Runtime Adapters (Codex / Hermes) 与 Task Runners
```

依赖只能向下。业务层依赖 `AgentRuntimePort` 和上述 ports，不读取 Codex、Hermes
原始事件。Runtime Adapter 负责把原始事件映射为统一事件：
`turn.started`、`tool.requested`、`tool.result`、`turn.completed`、
`turn.failed`、`turn.interrupted`。

## 权威数据模型

### Workflow Run

- `run_id`、`workflow_schema_version`、`draft_hash`
- `principal_id`、`project_id`、`canvas_id`、`agent_id`、`turn_id`
- `approval_id`、`status`、`owner_kind`、`owner_id`
- `lease_expires_at`、`created_at`、`updated_at`

### Workflow Action

- `action_id`、`run_id`、`depends_on`、`action_type`
- `operation_idempotency_key`、`payload_hash`、`attempt`、`status`
- `task_id`、`artifact_ids`、`product_operation_id`
- `requires_user_approval`、`approval_id`
- `evidence_policy`、`result_receipt_id`、`projection_revision`

Action 的完成证据按类型定义：

| Action 类型 | completed 前的必要证据 |
|---|---|
| 生成动作 | Task 成功终态 + 服务端核验通过的 Artifact；付费动作还需关联 Product Operation |
| Canvas mutation / UI command | 服务端核验的 Command `applied` 回执 + 对应 Canvas projection revision；纯 UI 动作记录执行时观察到的 revision |
| 人工主线动作 | 有权 principal 的审批记录 + 主线业务结果回执及其 revision |

`evidence_policy` 由版本化 Workflow Schema 根据 `action_type` 决定，Draft 和客户端
不能覆盖。缺少对应证据时 Action 保持 running/awaiting_evidence，不能伪造空 Task 或
Artifact 来进入 completed。

### Command Inbox / Outbox

- `command_id`、`command_idempotency_key`、`operation_idempotency_key`
- `replay_of`、`payload_hash`
- principal/project/canvas/agent/turn/run/action 关联字段
- 正常路径：`pending → delivered → accepted → applied`
- `applied` 是不可逆成功终态；失败终态为 `failed | cancelled | expired`
- `consumer_id`、`lease_expires_at`、`attempt`、`available_at`
- `result_payload`、`result_expires_at`

命令级和业务操作级幂等键承担不同职责：

- `command_idempotency_key` 标识一次命令创建意图。同一 key 配合不同
  `payload_hash` 必须返回冲突；相同 hash 返回已有 command。
- `operation_idempotency_key` 标识不可重复的业务副作用，在原命令及其所有重放之间
  保持不变。Canvas mutation、Product Operation 和计费结算必须以该键去重。

所有 compare-and-set 状态更新与幂等键占用必须在持久化事务内完成。

投递与超时规则：

1. consumer 取得 command 时，以 CAS 将 pending 改为 delivered，同时写入 consumer 和
   lease；确认接管后改为 accepted，执行期间续租。
2. delivered 或 accepted 的 lease 到期且未到最大尝试次数时，服务端清除旧 consumer，
   增加 attempt，并以同一 command_id/command_idempotency_key 重新进入 pending；重投
   不得创建新的业务动作或计费 Operation。
3. 达到最大尝试次数、超过 command TTL 或 payload 不可恢复时转为 expired，并写入
   dead-letter 记录和最后失败原因，供人工重放或审计。
4. applied、failed、cancelled、expired 都是不可逆终态。结果处理只允许从当前有效
   delivered/accepted lease 做 CAS；旧 consumer 的迟到 ack/result 必须返回终态快照，
   不得覆盖终态或较新的 attempt。
5. 重放 dead letter 必须在一个事务内创建新的 command_id 和新的
   command_idempotency_key，并通过 replay_of 指向原命令；禁止复用原命令级幂等键。
   新命令必须继承原 operation_idempotency_key。执行前若该业务键已有 applied/settled
   结果，重放直接复用该结果并进入 applied，不得再次修改 Canvas 或创建计费 Operation。

## 部署支持矩阵

| 模式 | Command transport | Run owner | 支持等级 |
|---|---|---|---|
| CE 单进程 | 数据库 Inbox/Outbox；文件桥兼容适配器 | Server | 正式 |
| CE 多 API worker、共享项目数据库 | 数据库 Inbox/Outbox | Server | 正式 |
| 多节点、无共享本地文件系统 | Redis Stream 或集中数据库 | Server | 正式 |
| 旧文件桥 | pending/result 文件 | Browser | 仅迁移期，不支持多节点 |

文件桥适配器只实现新的 CommandPort，不再向业务层暴露文件名、轮询和锁语义。适配器
必须具备 result TTL、启动清理、冲突检测和指标；分布式配置检测到文件桥时应拒绝启动。

## 分阶段迁移

### Phase 0：安全闸口

- 主线 Commit 与 BeatContext 同步仅允许人工 UI。
- 引入服务端可信 AgentExecutionContext，客户端 metadata 不参与工具授权。
- Owner：现有 browser runner；服务端只做验证和记录。
- 退出条件：#555、#556 的防护与回归测试合入。

### Phase 1：统一契约和关联 ID

- 发布 `workflow-schema/v1`，定义 Draft、Run、Action、Command、Result envelope。
- `workflow_runs.py` 补齐 task/artifact/product-operation 关联和 CAS 状态规则。
- 为 Node、Link、Action、Recipe stable envelope 建立唯一 schema 源。
- 从 schema 生成 Python model、TypeScript type 和 MCP input schema。
- Owner：仍是 browser runner；只有浏览器能推进 legacy Run。
- 退出条件：CI contract test 能发现枚举、字段、alias 和 schema version 漂移。

### Phase 2：持久化 Inbox/Outbox

- 实现 CommandPort 和数据库 transport；WebSocket 改为订阅/ack。
- 文件桥降级为 CE 单机 adapter，并加入 TTL、清理和指标。
- 新 Command 使用持久化 transport；旧 Run 保持原 transport 至终态。
- Owner：legacy Run 为 browser；新 command 的 delivery owner 为 server。
- 退出条件：跨 API worker、断线重连、幂等冲突、迟到回执测试通过。

当前实现基线：Canvas Command、Canvas Context、Skill Studio 和 Clarification 已写入桥接
目录中的 SQLite Inbox/Outbox，API worker 通过事务 CAS 竞争投递 lease，浏览器断线后可从
同一 Inbox 重新投递。旧 pending/result JSON 仍保留为迁移期双写适配器，但不再作为新请求
的唯一事实源。终态结果保留 24 小时，未完成消息按类型 TTL 转为 expired；队列状态可通过
`bridge_status_counts` 读取。

该 SQLite transport 要求所有 API worker 挂载同一个桥接目录。它正式覆盖 CE 单进程和
共享该目录的 CE 多 worker；跨主机且无共享存储的部署必须改用实现同一 CommandPort 的
集中数据库或 Redis Stream，在该 transport 落地前不得把节点本地 SQLite 声明为多节点
支持。文件双写只承担旧版本兼容和回滚，不改变这一部署边界。

### Phase 3：服务端 Orchestrator shadow mode

- Orchestrator 读取 Run、计算下一动作，但不调度，仅与 browser 决策做差异记录。
- 对 DAG 展开、重试分类、Artifact 验证建立 golden tests。
- Owner：browser；shadow 不得写 Action 状态。
- 退出条件：连续观测窗口内无无法解释的决策差异。

### Phase 4：按 Run 切换执行 owner

- 批准 Run 时持久化 `owner_kind=server` 或 `browser_legacy`，创建后不可变。
- server-owned Run 由 Orchestrator 获取 lease、调度 Task、核验 Artifact、推进 DAG。
- 浏览器只应用带 revision 的 Canvas projection event。
- Owner：由 Run 字段唯一决定。
- 退出条件：关闭浏览器后继续运行；取消、恢复、worker 切换和多标签测试通过。

### Phase 5：移除浏览器 runner

- 禁止创建 browser-owned Run，等待旧 Run 到达终态后删除调度和对账逻辑。
- 保留 UI command consumer，仅处理上传选择器等确实需要浏览器能力的动作。
- 拆分巨型模块并删除双写兼容分支。

## 模块拆分顺序

避免按文件机械拆分，按稳定职责抽取：

1. `chat/execution_context.py` 与 `chat/tool_policy.py`
2. `chat/application.py`：一次 turn 的用例编排
3. `chat/runtime_port.py` 与 `chat/adapters/{codex,hermes}.py`
4. `chat/session_registry.py`、`chat/delivery_evidence.py`
5. `freezone/orchestrator.py`、`freezone/command_port.py`
6. routes 拆为 canvas、catalog、workflow、operation、asset 薄适配层

每次抽取必须先有 characterization test，且旧入口委托给新模块；不允许同时重写行为。

## Schema 单一真源

稳定 envelope 放入独立、版本化目录 `schemas/workflow/v1`。生成物必须带源 schema
hash，CI 执行“重新生成后 git diff 为空”的检查。模型 catalog、价格和实时能力不进入
稳定 schema，继续由 live catalog 提供；schema 只定义 catalog item 的 envelope。

兼容规则：

- 新增可选字段允许同版本演进；删除、改名、语义变化必须升 major。
- alias 只存在于入站迁移层，持久化前归一化。
- 未知 major fail closed；未知可选字段透传但不能参与授权。

## 可观测性与清理

最低指标包括 pending commands、oldest age、delivery latency、lease steals、retry count、
dead letters、artifact verification failures、projection lag。清理任务只能删除超过 TTL
且处于终态的 result payload；command 审计记录按保留策略保存。pending、delivered、
accepted 超过各自 TTL 或重试上限时必须先通过 CAS 转 expired、写入 dead letter 和审计
原因，不能直接删除。delivered/accepted 的短暂 lease 超时优先按上述规则重投。

日志统一携带 project_id、canvas_id、turn_id、run_id、action_id、command_id、
task_id 和 product_operation_id，禁止记录密钥和完整敏感 payload。

## 必需测试

- 浏览器关闭后 server-owned Run 继续或明确暂停。
- 两个 API worker 竞争同一 lease 只有一个成功。
- 多标签页重复 ack 不重复应用 mutation。
- 同一命令级幂等键配合不同 payload 拒绝；相同 payload 返回同一 command。
- dead-letter 重放获得新 command/key 和 replay_of，但继承业务操作级幂等键；已有
  applied/settled 结果时不重复写 Canvas 或扣费。
- delivered/accepted lease 超时会以同一 command 重投，耗尽重试后进入 expired/dead letter。
- applied/cancelled/failed/expired 后迟到 result 不改变终态。
- 生成 Action 在 Task completed 但 Artifact 缺失时不得 completed。
- Canvas/UI Action 无 Task/Artifact 时，可凭 applied 回执和 projection revision 完成。
- 人工主线 Action 缺少审批或业务结果回执时不得 completed。
- 旧 Recipe/Skill/Canvas JSON 通过迁移层恢复。
- Codex 与 Hermes adapter 对同一 fixture 产生相同统一事件序列。

## 明确不在本次设计 PR 中执行

- 不切换现有 Run 的 owner。
- 不删除文件桥或浏览器 runner。
- 不引入 Redis 生产依赖。
- 不在缺少 contract tests 时移动巨型模块。

这些限制保证设计合入本身不改变 staging 运行行为，后续每个 Phase 使用独立 PR 和回滚
开关实施。

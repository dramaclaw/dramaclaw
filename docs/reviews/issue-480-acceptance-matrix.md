# Issue #480 / PR #434 跨仓验收对照

基准是 PR #434 于 2026-09-04 00:35 发布的“最终实施计划”。该计划的 §10
实际列出 18 项；本表不以测试总数代替逐项验收，也不把通用计费测试误算成
四类 Agent 产品的真实 paired-head 验证。

状态含义：

- **自动覆盖**：当前代码库有直接回归测试。
- **部分覆盖**：单仓或通用生命周期已测，仍缺真实 paired/live 证据。
- **未覆盖**：需要后续代码或验收环境。

| # | 验收项 | 状态 | 当前证据 | 后续动作 |
|---|---|---|---|---|
| 1 | 四个 feature 的未配置、停用、free/0、正数价格 | 部分覆盖 | SuperTale 通用严格价格测试；PR #186 注册测试 | 用最新 CE/EE heads 对四个 feature 分别跑四种价格矩阵 |
| 2 | 未配置/余额不足在模型调用前失败且不交付结果 | 部分覆盖 | SuperTale 严格价格和余额不足测试；CE operation 先 admission 后结果 | paired test 断言模型调用计数为 0、无 result receipt |
| 3 | started/queued/running 不最终消费 | 部分覆盖 | `tests/test_agent_product_operations.py` pending 状态；SuperTale 通用 task settlement | paired test 检查 reservation 未 confirm |
| 4 | 模型调用未发生时退款 | 部分覆盖 | CE 无 evidence 禁止 delivered；SuperTale 通用失败退款 | paired test 检查四类 task 的退款账本 |
| 5 | 模型成功且结果交付后只确认一次 | 自动覆盖 | `tests/test_agent_product_operations.py` 终态幂等；`tests/test_api_freezone_workflow_runs.py` Workflow result 重复提交 | paired ledger 可作为额外发布证据 |
| 6 | provider 拒绝、无结果、取消、进程中断的退款/审查 | 部分覆盖 | `tests/test_task_timeout.py`、`tests/test_agent_product_operations.py` | 补四类 operation 的进程中断 paired test |
| 7 | accepted/submitted 保留 reservation，重启和晚到结果收敛 | 部分覆盖 | late delivery 确认及 `awaiting_reconciliation` 测试；诊断计数 | 在真实 EE 中执行一次 timeout → restart → confirm/refund |
| 8 | duplicate MCP、transport retry、重复 finish/save 不重复扣费 | 自动覆盖 | operation 幂等、终态 result_ref 一致性、Workflow draft 重复提交测试 | paired ledger 可作为额外发布证据 |
| 9 | Skill-only、Recipe-only、Skill + N Recipes、仅复用 Recipe | 自动覆盖 | `tests/test_freezone_plugin.py` Skill Studio 各模式；服务端 manifest/reuse 校验 | 无 |
| 10 | N 个新 Recipe 对应 N 个 `recipe_generate` operation | 自动覆盖 | `tests/test_freezone_plugin.py::test_freezone_plugin_recipe_only_manifest_admits_and_delivers_each_recipe`；服务端数量校验 | 无 |
| 11 | N 个模型型 Recipe 节点对应 N 个 `recipe_result`，确定性路径免费 | 自动覆盖 | `tests/test_api_freezone_workflow_runs.py` workflow-run admission 和 deterministic compile 测试 | 无 |
| 12 | Workflow result 收费一次，Canvas confirm/apply 不重复收费 | 自动覆盖 | `test_metered_workflow_result_is_delivered_once_before_canvas_confirmation` | paired ledger 可作为额外发布证据 |
| 13 | CRUD、导入、复制、保存、schema validation、deterministic compile 不收费 | 部分覆盖 | CE 路由无 product operation；deterministic compile 回归 | 增加跨仓“零 ledger event”汇总测试 |
| 14 | 大量文字按可信 `billable_chars` 额外计费 | 部分覆盖 | text runner 持久化实际输出字符；任务核心从可信结果重算 settlement metrics；Workflow MCP/规划回复拒绝超过 4000 字符的正文旁路 | SuperTale 结算端按 actual metrics 对预留金额补差/退差，并跑 paired ledger 测试 |
| 15 | 图片/音频/视频费用不被父 operation 的 `feature_included` 抑制 | 部分覆盖 | SuperTale `feature_included` 与媒体独立 feature 通用测试 | paired workflow 同时断言父产品和媒体两条账 |
| 16 | 部分成功按各自产物独立 confirm/refund | 部分覆盖 | 每个 Recipe 独立 operation；失败只终结对应 operation | 补混合成功/失败的 paired ledger 测试 |
| 17 | 个人、组织、成员额度、组织覆盖价 | 部分覆盖 | SuperTale 组织计费通用测试 | 对四个新 feature 跑组织覆盖价 paired test |
| 18 | CE 全链路可用且无本地积分账本 | 自动覆盖 | CE 使用 `NoOpUsageMeter`；不存在 `agent_billing_state.py`；CE Workflow/Skill Studio 测试 | 无 |

## 本分支新增证据

- `53e3a30e`：服务端交叉校验 manifest、outline、put 结果、operation session/kind/artifact
  和真实可复用 Recipe；同时校验 Workflow result operation 与 `compiled.skill_id`。
- `d2e7e3be`：诊断计数覆盖证据绑定失败、缺证据 409、进入 reconciliation、晚到结果完成。
- 当前 A1 变更：文本任务以实际交付内容生成可信 `billable_chars` settlement metadata；
  Workflow Plan/MCP 与规划回复均拒绝超过 4000 个可计费字符的正文旁路。
- 全量 CE 回归：5183 passed、16 skipped、3 deselected；其中 3 项因受限沙箱的端口/联网限制
  首次失败，在允许对应能力后单独重跑通过。

## 发布前仍需人工保存的证据

1. 使用当前 DramaClaw 与 SuperTale PR #186 的精确 heads 跑 paired gate。
2. 在真实价格配置下各执行一次 Workflow result、Recipe result、Workflow generate、
   Recipe generate，保存 reservation、model evidence、result receipt 和 terminal settlement 的关联记录。
3. 故意制造一次 accepted/submitted 超时并重启，确认 reservation 最终收敛且诊断计数变化正确。
4. A1 完成后，用大段文字成功与失败各跑一次，核对实际输出字符计费和失败不确认。

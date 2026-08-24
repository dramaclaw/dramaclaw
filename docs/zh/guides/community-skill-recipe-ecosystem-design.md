# DramaClaw 2.0：社区 Skill + Recipe 动态工作流设计

> 状态：基于 `freezone-canvas` 当前代码的 2.0 实施基线
>
> 设计基线：`bd74b4d`（2026-07-26）
>
> 进度复核基线：`671cb07`（2026-08-02）。六项中第 1、2、3、6 项已完成，第 4 项部分完成，第 5 项完成约三分之一；§8.3 收尾项第 1、3 项已完成。逐项状态见 §0.1 的表格，实测数据见 §2.8。
>
> 本次修订依据：`src/novelvideo/freezone/agent_catalog/builtins` 下 5 个内置 Skill 与 30 份内置 Recipe 的实测统计（见 §2.8）；一份用户提供的真实 Flova Skill 样本；Flova、Miora、LibTV 的公开文档与公开仓库（见 §5，其中 §5.3 的 LibTV 是形态最接近的对照）
>
> 社区仓库：[dramaclaw-skills](https://github.com/dramaclaw/dramaclaw-skills)

## 0. 实施导读

**这份文档的用途是交接实施。如果你是来写代码的，从这一节开始，按下面的路径读，不要从头顺读。**

### 0.1 要做的六项，一屏看完

| 序 | 做什么 | 主要文件 | 性质 | 依赖 | 状态（`671cb07`） |
| --- | --- | --- | --- | --- | --- |
| 1 | 把锚点要求写进规划包与 Agent 规则（**零 Schema 改动**） | `json_workflow_catalog.py`、`.hermes/skills/workflows/SKILL.md`、`skill-studio-authoring-guide.md`、`src/novelvideo/chat/service.py` | 提示词 + 测试 | — | ✅ 四处均已落地；**标杆通过率尚未测量**（见 §8.3 第 5 项） |
| 2 | 修 Skill Studio 保存契约（删非法字段 + 复用已有 validator） | `frontend/src/features/superchat/superchat-panel.tsx:3920` | 减 | — | ✅ 已完成 |
| 3 | 把 Skill 已有约束送进 Recipe Compiler，并修优先级 | `recipe_runtime.py`（含第 33 行系统提示）、`workflowRecipeRuntime.ts`、Recipe 编译 API 模型、四类节点编译入口 | 减 + 接线 | — | ✅ 已完成 |
| 4 | `allowed_recipe_ids` 改真白名单 | `json_workflow_catalog.py:1982` | 减（一个布尔分支） | — | ⚠️ 主体已改，但新增了未经设计的 `general-*` 例外，导致三处语义不一致 |
| 5 | 内置 Recipe 收敛为共享工艺集 | `src/novelvideo/freezone/agent_catalog/builtins/` | 内容重组，预计约 10–15 份 | 3 | ⚠️ 约三分之一：6 个 Skill 中仅 lego、pixar 迁移到位 |
| 6 | 默认策略改动态 WorkflowPlan | `.hermes/skills/workflows/SKILL.md:15` | 减（一段文字） | — | ✅ 已完成，且主路径已演进为 intent → draft（见 §3.3） |

第 1、2、4、6 项可以独立实施。第 5 项需要在第 3 项把 Skill 约束接入 Recipe Runtime 后进行，并由懂创作工艺的人负责内容重组。

**接手前先读这两条，它们是复核后新增的坑：**

- 第 5 项**不是「还剩几个 Skill 没迁移」**，而是共享集本身还没吸收够工艺就先被当成了迁移目标。直接把剩余 Skill 指过去会造成工艺倒退，**必须先加厚共享集再迁移**——理由与证据见 §8.2 第 5 项的「执行顺序」小节；
- 第 4 项已经改过一轮但改出了新的不一致，不要当成未开工的项重做，见 §8.2 第 4 项的状态说明。

一句话概括这次改造：**用厚 Skill 指导 Agent 做专业判断，用薄 Schema 保持动态规划空间，用 Recipe 复用跨 Skill 的创作工艺。** 六项做的是三件事——把本来就写在 Skill 里却到不了执行层的约束接通（第 3 项，核心）、把散在 30 份 Recipe 里的重复工艺收敛成共享工艺集（第 5 项）、清掉规则漂移（第 4、6 项）与一个既有 bug（第 2 项）。**不是增加创作状态机，而是让 Agent 真正消费厚 Skill。**

### 0.2 按角色的阅读路径

**实施工程师**——读这些就够开工：

```text
§0    本节
§8.2  六项明细（确切文件与行号、回归测试要求）
§6.1  厚 Skill、薄 Schema 与锚点规则的边界
§6.2  约束传递的节点类型筛选表 + 哪些字段不进 Compiler
§6.4  规则优先级链（第 3 项的裁决依据）
§9    明确不做（防止顺手扩张）
§10   验收标准（自检清单）
```

**工艺 / 内容负责人**——第 5 项的执行者：

```text
§0.1  依赖顺序（等 1、3 落地后开始）
§8.2 第 5 项  收敛映射与清理清单
§2.8  为什么这 30 份不是写坏了——迁移心态，先读这节再动手
§3.2  Skill 与 Recipe 的切分线 + 示范拆分
§6.5  从散文式 Skill 迁移过来的映射表
```

**需要向他人解释决策依据时**再读：§1.1（五条架构主张）、§2（当前代码盘点）、§4（为什么不造 Project Spec）、§5（参考与竞品）、§11（最终判断）。**这些是论证材料，不是实施说明**，不读也能把六项做完。

### 0.3 四条最容易踩的坑

1. **锚点要求要作为规划指令下发，不能混在散文里。** Skill 的 `planning_notes` 里写了要求不等于 Agent 会照做——规划包必须把它作为明确指令呈现（“必须创建 X 锚点节点并向每个 Y 连出引用边”）。见 §6.1、§8.2 第 1 项。
2. **第 5 项删 Recipe 里的阶段推进指令时要给去处**，不是简单删掉。阶段顺序和暂停条件上移到厚 Skill 的 `planning.conduct_rules`，由 Hermes 结合用户本轮授权判断。删了不给去处，下一个作者会写回 Recipe。
3. **不要顺手加字段。** §6.1 有一张“曾考虑过但没加”的表，门槛是三条同时成立：能否机器确定性校验、错了是否静默、代价是否昂贵。**总原则是尽量用提示词驱动——结构化字段只用在提示词已被证明不够的地方，不用在可能不够的地方。** 本轮连锚点绑定字段都推迟到标杆跑出数据后再决定。
4. **第 5 项收敛的是重复，不是厚度，也不是追求固定文件数。** 厚 Skill 是正确的 Agent 设计：它应完整表达风格、判断方法、素材策略、阶段原则和质量标准。共享 Recipe 也可以很厚，但只承载跨 Skill 可复用的工艺。验收标准不是恰好剩 10 份，而是新增一种风格 Skill 原则上不再复制一套 Recipe。

### 0.4 测试落点

现有测试目录，新增回归测试就放在对应位置：

```text
后端   tests/test_freezone_agent_config_store.py      Skill/Recipe 存取与 Schema
       tests/test_freezone_agent_bundle.py            Bundle 校验
       tests/test_api_freezone_agent_bundles.py       Bundle API
       tests/contract/                                 跨层契约测试
前端   frontend/src/__tests__/features/superchat/     Skill Studio 保存（第 2 项）
       frontend/src/__tests__/components/settings/settings-dialog.test.tsx   设置页 Schema 校验
       frontend/src/__tests__/features/canvas/         画布与 Recipe Runtime
```

§8.2 每一项末尾都列了该项必须增加的回归测试，验收标准见 §10。

## 1. 架构主张与结论

### 1.1 五条架构主张

这一节先陈述 DramaClaw 主张什么，后面所有工作项都是为了兑现它，不是为了追平任何竞品。每条主张后面直接给代码证据，或标注“待兑现”并指向对应工作项——没有证据也没有工作项的主张不写进来。

**主张一：Graph 是创作的真相源，不是 Agent 输出的投影。**

因此拓扑对用户可见、可改、可复制、可局部重跑。证据：`Canvas.tsx:3202` 的 `duplicateNodes()` 同时复制节点与两端都在选区内的连线，接在多选工具栏的创建副本与剪贴板粘贴上——用户能把 Agent 生成的整条工作流复制一份、改一个参数、并排跑对比；`freezone_run_workflow` 支持 `node` / `downstream` / `connected` 三种范围；节点级 Action Catalog 提供 `can_run_now` 与 `blocked_reasons`。

**主张二：WorkflowPlan 是可校验、可审批的 Agent 产物，不是不可见的内部行为。**

因此一张图能在写入画布前被机器检查、被用户拒绝。证据：`freezone_workflow_plan.v1` + `validate_agent_workflow_plan()` 校验 schema 版本、节点类型、重复节点、边端点兼容性、环路、Recipe 存在性与版本、参考媒体要求，上限 200 节点 / 400 边；应用画布命令前有确认门。Plan 转换后的 Graph 会持久化，但当前不承诺原始 Plan 本身可重放或作为独立历史记录保存。

**主张三：Skill 声明观感与边界，Recipe 提供可复用工艺，两者都是结构化可校验数据。**

因此社区审阅的是一份 JSON diff，而不是一篇散文。证据（部分）：`_CatalogBaseModel` 的 `extra="forbid"` 在保存、加载、Bundle 安装三条路径统一校验；`dramaclaw.skill-bundle.v1` 校验引用完整性与危险内容。

**待兑现**：Skill 已有 `planning_notes`、`prompt_guide` 和 `conduct_rules` 可以承载厚方法，但这些内容尚未完整进入规划和节点执行上下文，Recipe 跨 Skill 复用率实测为 0（§2.8）。这条主张现在是设计目标而非现状，由 §8.2 第 1、3、5 项兑现。问题不是缺更多字段，而是现有内容没有被完整消费。

**主张四：模型能力由系统声明，Skill 不感知供应商。**

因此同一个 Skill 在不同部署、不同模型后端上都能跑，社区 Skill 不会因为某个供应商下线而失效。证据：Skill Schema 不含模型名，实际模型由内部模型名与 NewAPI 映射决定（§6.4）。

**主张五：Agent Runtime 外部依赖 Hermes，我们只做创作层。**

因此 ReAct 循环、Memory、Tool Permission 协议和 Plan/Thought 事件随 Hermes 升级，我们只维护适配层与契约测试。证据：§2.1。

这五条同时是后续需求的判据。一个新需求如果不能让 Graph 更接近真相源、不能让 Plan 更可校验、不能让 Skill/Recipe 更可复用可审阅，就不做——无论竞品有没有。

### 1.2 结论

DramaClaw 不需要重新开发一套 Agent 平台，也不需要重新开发动态工作流引擎。

当前代码已经具备：

- Hermes Agent 会话、Memory、ACP 事件和工具权限；
- Skill Studio 创建、修改和保存 Skill/Recipe；
- `freezone_workflow_plan.v1` 动态计划；
- 节点、边、环路、Recipe 和媒体输入校验；
- 一次确认后批量创建 Graph；
- 按依赖层并行执行节点；
- Workflow Run、生成历史、故事板视图和视频合成节点。

当前代码已经补齐 Skill/Recipe Schema、Skill Studio 字段保存、Bundle 导入导出和社区安装入口。

但对 30 份内置 Recipe 的实测（§2.8）推翻了一个原有假设：Skill Schema 并没有承载观感、资产策略和全局负面约束的字段，作者已经用一份 `*-video-spec` 文本 Recipe 加一个运行时中转文本节点手工模拟了它，17/30 份 Recipe 依赖这条链。结果是 Recipe 复用率精确为 0，换一种观感就必须复制整套 Recipe。

因此 2.0 主链需要完成的是六项，按依赖顺序：

1. 把锚点要求写进规划包与 Agent 规则，零 Schema 改动（§6.1）；
2. 修复 Skill Studio 与后端 Schema 的保存契约不一致；
3. 把已确认输入和 Skill 强约束传入 Recipe Runtime；
4. 让 `allowed_recipe_ids` 成为真正的严格白名单；
5. 把 30 份内置 Recipe 收敛为共享工艺集，初步预计约 10–15 份；
6. 把 Hermes 的默认策略从“模板优先”切换为“Skill 驱动的动态 Graph”。

第 3 项是第 5 项的前置：Skill 约束能进入 Recipe Runtime 后，重复的风格与阶段规则才可以从 Recipe 移走。其余项目可独立推进。

`skillVersion` 追溯和 Hermes/DramaClaw 版本收口属于发布质量项，不阻塞动态主链，但应在 2.0 正式发布前完成。

```text
用户选择 Skill
  → Hermes 读取 Skill + Recipe 摘要 + 当前画布
  → Hermes 生成 freezone_workflow_plan.v1
  → 现有 Validator 校验
  → 用户确认
  → 现有 Graph Builder 创建节点和连线
  → Hermes 按成本、风险和用户授权决定执行范围
  → 现有 Runner 按依赖执行允许推进的节点
  → Recipe Runtime 为每个节点生成实际提示词
  → Hermes 根据生成结果继续、局部返工或请求确认
```

DramaClaw 2.0 的核心可以概括为：

```text
Hermes Agent + Skill + Recipe + Dynamic Graph
```

不再增加 CreativePlan、Skill Session 或第二种工作流计划。

## 2. 当前代码到底已经有什么

### 2.1 Hermes 已经是 Agent Runtime

当前实现已经把 Hermes 作为虾导和虾画助手的底层 Agent：

- `.hermes-version` 固定 Hermes 版本；
- `src/novelvideo/chat/hermes_pool.py` 管理用户 Worker 和会话恢复；
- Director 与 Freezone 使用不同的 Hermes Profile；
- Freezone 会话按用户、项目和画布区分并复用 Session；
- `src/novelvideo/chat/hermes_sdk.py` 转发 Plan、Thought、Tool、Permission 和消息事件；
- `src/novelvideo/chat/hermes_workspace.py` 配置 Hermes Skill、Plugin、Memory 和 NewAPI 模型路由；
- Freezone Profile 禁用 Shell 和任意文件读写，只开放画布相关工具。

因此 DramaClaw 不自建：

- ReAct 循环；
- Agent 记忆引擎；
- 多 Agent 框架；
- 通用任务计划系统；
- Tool Permission 协议；
- Thought/Plan 事件协议。

Hermes 更新这些能力时，DramaClaw 只升级适配层和契约测试。

Freezone Memory 覆盖问题已经修复：`_ensure_freezone_identity_context()` 现在只在文件不存在时写入默认内容，或在检测到旧默认内容时做兼容迁移，不再覆盖 Hermes 已学习的普通记忆。

当前只剩一个版本收口问题：`.hermes-version` 已经是 `0.19.0`，但 `hermes_pool.py` 的缺文件 fallback 仍是 `0.18.0`。正式发布前应让 `.hermes-version` 成为唯一版本来源，避免非 Docker 安装出现漂移。

旧的用户级 `preferences.md` 兼容层已经移除。创作偏好和项目事实都应留在项目作用域，由项目内的 Agent Memory 与会话承载，避免电影、广告、电商等不同项目之间互相污染。

### 2.2 Skill Studio 已经能让用户创建 Skill

当前 Skill Studio 与设置页合起来已支持：

- 自然语言创建 Skill；
- 从当前画布或选中流程总结 Skill；
- Agent 逐步提问；
- 分块生成 Skill 和 Recipe 草稿；
- 用户修改草稿；
- 保存和再次编辑；
- JSON 导入导出。

主要代码：

- Agent 编写规则：`src/novelvideo/chat/service.py`
- Skill Studio 工具：`.hermes/plugins/freezone/__init__.py`
- 编写指南：`.hermes/skills/freezone/references/skill-studio-authoring-guide.md`
- 前端草稿 UI：`frontend/src/features/superchat/superchat-panel.tsx`
- 设置页：`frontend/src/components/settings/freezone-skill-recipe-settings.tsx`
- 存储：`src/novelvideo/freezone/agent_config_store.py`

当前存储仍是用户目录下的简单 JSON：

```text
output/{user}/_account/freezone/agent_config/
  skills/{skill_id}.json
  recipes/{recipe_id}.json
```

这个结构足以支持 2.0，不需要立即引入数据库或新的 Catalog 服务。

当前契约基础已经完成：

- 后端已有统一 Pydantic Schema，保存、加载和 Bundle 安装都会校验完整 Skill/Recipe；
- Skill Studio 已保留 `name`、`version`、`allowed_recipe_ids`、`input_parameters` 和 `schema_version`；
- 设置页已有对应的前端 Schema 校验；
- Skill 与依赖 Recipe 已能作为 Bundle 一起导入导出；
- 普通入口只展示 Skill，Recipe 已收进高级管理。

还剩一个真实的跨层 Bug：Skill Studio 标准化保存时仍会在 `planning` 中写入 `default_aspect_ratios`，但后端 `AgentCatalogPlanning` 不接受该字段且启用了 `extra="forbid"`。该字段也不应继续存在于 Skill Schema：画幅属于每次任务的可变输入，应使用 `input_parameters` 的 `default` 表达。Skill Studio 保存前还应直接复用现有 `validateFreezoneAgentConfigPayload()`，避免前端弱校验与后端必填字段再次漂移。

### 2.3 动态 WorkflowPlan 和 Graph Builder 已经存在

当前动态链路并不是概念代码，而是已经可以运行：

```text
freezone_get_workflow_skill(compact=true)
  → 返回 Skill、Recipe 规划摘要、input_contract、节点能力约束
  → Hermes 生成 freezone_workflow_plan.v1
  → validate_agent_workflow_plan()
  → freezone_create_workflow_graph(plan=...)
  → canvas_chat_commands.v1
  → 前端确认并写入 Graph
```

主要代码：

- Catalog 加载与规划包：`.hermes/plugins/freezone/json_workflow_catalog.py`
- Plan 严格校验：`src/novelvideo/freezone/workflow_plan.py`
- Graph 命令生成：`.hermes/plugins/freezone/workflow_graph.py`
- Canvas 命令执行：`frontend/src/features/freezone/canvasChatCommands.ts`

Validator 已经检查：

- Schema 版本；
- 最大节点数和边数；
- 节点 ID、节点类型和重复节点；
- 边类型、端点兼容性和环路；
- Skill 和 Recipe 是否存在；
- Recipe 版本和输出类型；
- 需要参考媒体的 Recipe 是否有输入。

Graph Builder 已经能把逻辑节点 ID 转成前端 `client_id`，批量创建节点、边、分组、布局和选择状态。`run_after_create=true` 时，还会在同一批准批次中追加 `run_workflow`。

因此不需要新建 Graph Builder，也不需要让 Agent 逐个创建节点。

### 2.4 Recipe Runtime 已经是真实执行层

Recipe 当前不是一个展示标签。节点执行前会读取：

- `recipe_id`；
- `recipe_version`；
- 节点类型；
- 用户目标；
- 当前节点意图；
- 上游文本；
- 参考媒体摘要。

`src/novelvideo/freezone/recipe_runtime.py` 会通过 NewAPI 调用 Recipe Compiler，把这些信息编译为对应图片、视频、音频或文本节点的实际提示词。编译结果已有内存缓存、持久化缓存和并发去重。

分层的三段划分本身是对的：

```text
Skill：决定本次应该有哪些阶段和规则
Recipe：决定某个阶段的提示词怎样写好
节点能力：真正调用图片、视频、音频或文本功能
```

分层带来两个 Flova 式单体 Skill 拿不到的真实收益，且都已经兑现：

- **上下文经济**：`freezone_get_workflow_skill(compact=true)` 规划期只返回 Recipe 摘要，节点执行时才加载该 Recipe 完整 `system_prompt`；
- **单阶段可独立版本化和回归测试**：分镜工艺能单独迭代，不必改动整个 Skill。

同时要记录它的代价：`_run_recipe_compiler()` 是一次独立 Agent 调用，30 镜头漫剧首次执行等于 30 次冷编译，返回空字符串会直接抛 `RuntimeError`。这是每个节点多付的一跳，Flova 把提示词写法放在 Skill 区块内、规划时顺带产出，没有这一跳。

这笔成本**不需要在 DramaClaw 侧优化**——它属于 LLM 调用，由 BrainClaw 的 cheap-first 级联承接，详见 §6.4 的第 1 条协同点。这里只记录代价的存在，不要据此在本仓做特殊优化。

但当前的切分线画错了位置。§2.8 的实测显示，观感与流程控制被切进了 Recipe，导致复用率精确为 0。原先“Recipe 不应被合并回 Skill，否则相同的分镜、产品分析、视频提示词或配音工艺会在大量 Skill 中重复”这个论证的前提已被实测否决：重复已经发生了，只是从“写在 5 个 Skill 里”变成“散在 30 个文件里”，抽象一份收益都没兑现。

正确的结论是：保留三段分层，但按 §3.2 的切分线把观感、流程顺序和资产决策上移回 Skill，Recipe 才能收敛成可跨 Skill 复用的纯工艺。

### 2.5 Graph 执行和创作视图也已有基础

当前前端 Runner 会根据画布边计算 DAG 层级：

- 同一层使用 `Promise.all()` 并行；
- 下游等待上游；
- 上游失败后阻断相关下游；
- 不相关分支可以继续；
- 执行状态写入 Workflow Run；
- 节点生成结果写入按 `(canvas_id, node_id)` 保存的追加式历史。

当前故事板视图由 `assetBoard.ts` 直接从 Graph 节点和边计算，图片、视频、音频和文本仍使用原节点的数据和操作。`videoComposeNode` 已经承担时间线和成片合成。

所以 2.0 不新增独立 Storyboard 数据库、Asset 数据库或 Timeline 真相源。Graph 继续是创作结构，生成历史保存节点的历史尝试，故事板只是第二种视图。

还有两个已实现但容易被忽略的能力，它们是主张一（Graph 是创作真相源）的直接证据，规划新功能前应先确认现有能力是否已覆盖需求：

- **工作流子图可整体复制。** `Canvas.tsx:3202` 的 `duplicateNodes()` 取选区内的节点，并同时复制两端都落在选区内的连线（`internalEdges`），接在多选工具栏的创建副本与剪贴板粘贴上，并带避让碰撞的落位。因此用户可以把 Agent 生成的整条工作流复制一份、只改一个参数、在同一画布并排跑对比。**这使得“项目级分支/时光恢复”类需求在本架构下不必要**——分支就是拓扑的一部分。
- **节点级历史版本可回选。** 生成历史按 `(canvas_id, node_id)` 追加式存储，每条记录带该版本自己的提示词；`NodeGenerationHistory.tsx` 已支持点击已完成的历史条目恢复该版本，restore 语义由宿主节点持有。因此“比较同一步骤的不同产出”这个最高频的对比需求已经覆盖。

### 2.6 当前代码已经补齐节点级动作目录

最近的 `freezone-canvas` 代码已经不只允许 Agent 创建 Graph，也能让 Agent 在 Graph 建成后可靠地操作现有节点：

- `canvas_action_catalog.v1` 描述画布级生成、编辑、分析和 UI 能力；
- `freezone_get_node_action_catalog` 返回某个真实节点当前可用的动作、参数和执行方式；
- Skill 节点动作会返回 `can_run_now`、`preconditions` 和 `blocked_reasons`；
- `freezone_run_node_action` 可以运行一个明确节点动作；
- `freezone_update_node_data` 可以修改一个节点的可编辑字段；
- `freezone_run_workflow` 支持 `connected`、`downstream` 和 `node` 三种范围，并默认跳过已有结果；
- 前端 Validator 会拒绝当前节点不存在、动作不可用或前置条件不满足的调用。

这意味着“执行后观察结果，再局部修改或返工”已经有真实工具基础，不需要再发明一个新的执行器。

但这套动作目录和 Workflow Skill 的规划能力不是同一个层次：

- Workflow Skill Catalog 当前只暴露 `textGeneration`、`imageGeneration`、`videoGeneration`、`audioGeneration` 和 `videoCompose` 等粗粒度拓扑能力；
- `canvas_action_catalog.v1` 描述具体节点实例当前能做什么；
- `freezone_workflow_plan.v1` 仍只允许现有七类工作流节点，不能把裁剪、扩图、下载或打开面板等动作伪装成新的 Workflow 节点类型。

2.0 应保留这层区分：规划时使用粗粒度节点能力，执行和局部修订时按需读取节点动作目录。

### 2.7 最小社区分发闭环已经存在

当前代码已经实现：

- `dramaclaw.skill-bundle.v1` Pydantic Schema；
- Skill、Recipe、引用完整性、最低 DramaClaw 版本和危险内容校验；
- Bundle 导入、导出和本地安装；
- 受信任 GitHub Catalog 拉取；
- 设置页中的社区 Skill 浏览、安装和“我的 Skill”入口；
- Bundle 与普通 JSON 配置的后端 API 和回归测试。

因此社区 Bundle 不再属于“需要从零增加”的 2.0 P0。

~~剩余工作主要是发布收口：当前包版本仍是 `1.1.2`，而 Bundle 导出默认声明 `min_dramaclaw_version=2.0.0`，导出后又立即按当前包版本校验。在版本正式提升到 `2.0.0` 前，这条默认导出路径可能被最低版本检查拒绝。~~

**已解决（`671cb07`）**：导出默认值已改为 `current_dramaclaw_version()`（`agent_bundle_store.py:86`），因此 `_ensure_minimum_dramaclaw_version()` 的 `current < minimum` 自校验在默认导出路径上不再可能失败。包版本（当前 `1.1.5`）提升到 `2.0.0` 现在只是发布节奏决策，不再是会拒收导出的 bug。

### 2.8 Skill 约束传递缺口的实测证据

前面几节盘点的都是“已经具备的能力”。这一节记录一个相反方向的事实：内置 Catalog 的实际内容证明厚 Skill 的约束没有真正传到节点执行层，作者已经用运行时的笨办法补上了。

对 `src/novelvideo/freezone/agent_catalog/builtins` 下 5 个 Skill、30 份 Recipe 的统计：

| 观测项 | 实测结果 |
| --- | --- |
| Recipe 跨 Skill 复用 | **30 份 Recipe、30 次引用、0 份被两个 Skill 共用**；每份 Recipe 的 id 前缀就是它唯一归属的那个 Skill |
| 依赖 `Final_Video_Spec` | **17 / 30** |
| `system_prompt` 里指挥阶段推进（“确认后进入【某】阶段”） | **12 / 30** |
| 各自声明禁字幕 | **8 / 30** |
| 硬编码分辨率数值（2K/4K/1080P/720P） | **7 / 30** |
| 明确声明角色/造型一致性 | **4 / 30** |
| 硬编码字面画幅值（16:9、4:3…） | **3 / 30**：`ling-cage-key-elements`、`ling-cage-video-spec`、`retro-kungfu-video-spec` |
| 正确消费 `input aspect_ratio`（对照组） | 4 / 30 |
| 按工艺去重后的种类 | 15 种（其中 3 种只是同一工艺换了名字，见 §8.2 第 5 项） |

#### 复核：`671cb07`（2026-08-02）

上表是**设计基线**，保留原值不改。同口径复测结果：

| 观测项 | 基线 `bd74b4d` | 复核 `671cb07` | |
| --- | --- | --- | --- |
| Recipe 跨 Skill 复用 | **0 份共用** | **4 份共用** | 主张三开始兑现 |
| 依赖 `Final_Video_Spec` | 17 / 30 | **0** | `*-video-spec` 已全部删除 |
| `system_prompt` 里指挥阶段推进 | 12 / 30 | **3** | 残留的 3 份全在未迁移的 Skill 里 |
| 每个 Skill 引用的 Recipe 数 | 5 ~ 7 | 4 ~ 5 | |

共用的 4 份是 `storyboard-plan`（3 个 Skill）、`video-audio-layer`（3）、`visual-key-elements`（2）、`storyboard-shot-video`（2）。

**口径说明**：`builtins/recipes/` 目录现有 61 份，但其中 38 份带 `actionKeys`，属于主线节点动作路径，不在本节的 workflow-skill 口径内。可比口径是 **30 份 → 23 份被引用**。

本节记录的核心问题——「把运行时规格伪装成 Recipe，下游靠 prose 约定读取，零校验」——**已经消除**：`confirmed_inputs` 与 `skill_constraints` 现在由 §8.2 第 3 项直接传入 Recipe Runtime。剩余缺口是工艺收敛本身，见 §8.2 第 5 项。

统计口径需要说明，否则容易高估违规规模：“提及画幅”有 13 份，但其中多数是在合法消费 `input aspect_ratio`，或者说的是人物体型比例而非画幅；真正写死字面画幅值的只有 3 份。角色一致性同理——按宽口径（含 `Style Lock` 字段名与泛化的“统一比例和灯光”）会得到 14 份，按“确指角色或造型一致性”收紧后只有 4 份。下面的结论只使用收紧后的口径。

`Final_Video_Spec` 并不是一个不存在的契约。它由 `*-video-spec` 这 4 份 `output_kind=text` 的 Recipe 生成一个【全局视频规格】文本节点，下游 17 份 Recipe 通过 `upstream_text` 读取它。把已确认输入投影成可读文本本身没有问题，问题是把它变成新的运行时真相源并让下游依赖自然语言解析。

问题在这个文本节点实际驮的内容。以 `ling-cage-video-spec` 的 `must_have_items` 为例：

```text
【全局视频规格】· Aspect Ratio · Duration · Frame Rate · Output Language
· Visual Style Lock · Asset Policy · Audio Policy · Global Negatives · Confirmation Needed
```

逐条归属：

| 字段 | 本该属于 |
| --- | --- |
| Aspect Ratio / Duration / Output Language | `input_parameters`（该 Recipe 甚至写着“Duration 使用 input total_duration”，在手工搬运已有的权威值） |
| Visual Style Lock（半写实 3D CG、末世科幻、脏旧真实材质、体积光…） | Skill 的观感声明——已有 `planning.prompt_guide` |
| Asset Policy（优先绑定用户素材，缺失或风格不匹配才重制） | Skill 的资产决策——已有 `planning.conduct_rules` / `planning_notes` |
| Audio Policy / Global Negatives | Skill 强约束——已有 `planning.prompt_guide` / `conduct_rules` |
| 末尾“确认后进入【分镜设计】阶段” | 流程控制，属 Skill 与 Agent，不属 Recipe |

因此结论是：**不是需要新增一种 Plan。** 真正缺的也不是字段——`planning.prompt_guide` 与 `conduct_rules` 本来就能承载这些内容，缺的是把它们送到执行层的传递路径（§8.2 第 3 项）。 缺失的后果，作者用「一份 text Recipe + 一次 Recipe 编译 + 一次 LLM 生成 + 一个中转文本节点 + 17 份 Recipe 的 prose 读取约定」补上了，代价是四条实打实的：

1. 每条工作流多一个节点和两次 LLM 调用，才拿到本该零成本直接可用的 `input_parameters`；
2. 规格是自然语言，下游靠 prose 约定读取，**零校验**——模型漏写一个字段，17 份下游 Recipe 静默降级，没有任何报错；
3. `input_parameters` 的权威值被手工搬运一遍，两处随时可能不一致；
4. `Visual Style Lock` 换一种风格就得复制整份 `video-spec` Recipe——这就是复用率 0 的直接机制，也是社区作者写新风格必须先抄 5~7 份 Recipe 的原因。

`pixar-ip-character-design` 是同一问题在单份 Recipe 内的缩影，一份里混了三层：

| 内容 | 归属 |
| --- | --- |
| 【输出结构要求】7 点、【质量标准】、【禁止事项】 | 纯工艺，本来就该留在 Recipe |
| `风格前缀：皮克斯3D卡通渲染，C4D+Octane质感` | 观感，应上移 `planning.prompt_guide` |
| `品牌元素由道具锚点阶段处理` | 流程分工，应上移 `planning.conduct_rules`；现在是两份 Recipe 之间的口头约定，无任何机制保障 |

#### 这 30 份 Recipe 不是写坏了

迁移前要先建立正确的认知，否则容易改出对抗情绪。这批 Recipe 是**为人驱动的流程写的助手**：Agent 接管建图之前，这条产线是人手工搭图做出真实剧集的——人选哪个节点用哪个 Recipe、人保证跨镜头观感一致、人判断素材够不够、人决定要不要加关键帧。

在那个模式下，现在这些“问题”都不是问题：

- 每个 Skill 一套私有 Recipe 很合理，因为使用者就是作者本人，不需要跨 Skill 复用；
- 观感写死在 Recipe 里很合理，因为不存在“换一种风格复用同一工艺”的场景；
- 画幅和分辨率写在 Recipe 里很合理，因为人知道这次要什么；
- `conduct_rules` 传不到 Compiler 也无所谓，因为人已经在挑 Recipe 时把意图落实了；
- `allowed_recipe_ids` 不是真白名单也无所谓，因为不会有人手滑挑一个不相干的 Recipe。

**六项不是在修一直坏着的 bug，是在补人退出建图环节后空出来的那个位置。** 所以迁移的动作是“把人原先做的可复现判断编码进 Skill 字段”，而不是“修前人写错的 Recipe”。主观判断（镜头数量、节奏）不搬进 Skill，按 §3.1 交给单修路线。

对应的改造是 §8.2 第 3 项（把已有字段真正送到执行层）和第 5 项（工艺收敛）。都不需要新增 Schema 字段。

## 3. 2.0 中四个概念的准确边界

### 3.1 Skill：用户选择的完整创作方法

Skill 回答：

> 这类作品应该怎样规划和制作？

例如：

- 小说转漫剧；
- 60 秒产品广告；
- 电商主图组；
- 角色设定与三视图；
- MV 制作。

Skill 包含适用场景、输入参数、允许使用的 Recipes、规划规则、强约束、质量标准和决策边界。它可以描述典型制作阶段及其依赖，但不把阶段固化为每次都必须展开的模板，也不保存某一次任务产生的节点数量或最终 Graph。

Skill 的重点不是告诉 Agent“永远按这六步执行”，而是告诉 Agent：

- 什么结果必须交付；
- 已有素材、模型能力和用户目标不同时，应怎样选择生产路径；
- 哪些步骤可以跳过、合并、并行或从中间开始；
- 哪些操作可以自动推进，哪些操作必须等待用户确认；
- 什么结果算合格，失败后允许怎样局部返工。

#### 什么该进 Skill，什么不该

正面判据只有一条：

```text
可复现的、换一个作者也应该得到同样答案的   → 进 Skill
主观的、每个人想法本来就不同的             → 不进 Skill，走下面两条路径之一
```

主观决策有**两条**承接路径，不要只想到第一条：

```text
路径 A  人在环：把节点放进 Agent 上下文，AI 辅助人修改，再 direction="downstream" 重做后续
路径 B  批量对比：一次生成多个候选，按 evaluation 的标准自动择优或让人快速挑选
```

路径 B 容易被忽略，但能力和字段都已存在：图片与视频节点支持 `count = 1 | 2 | 4`，结果存入 `generationBatch` 并以叠卡形式呈现；`evaluation` 的 `quality_threshold`、`rating_bands`、`visual_review_items` 就是择优标准的载体。当前缺的只是把两者接起来——§8.4 把“让 `evaluation` 真正触发自动审核和局部返工”列为 P1。

两条路径的选择依据是**候选能否被并列比较**：镜头数量这类结构性选择只能走 A（不同数量的 Graph 无法并排看）；某个镜头的构图、某个角色的造型这类可并列的产出走 B 更快，也是 Agent 无人值守推进的前提。

这一点关系到产品形态：如果只有路径 A，Agent 每遇到一个主观选择都得停下等人；有了路径 B，Agent 才能在授权范围内连续推进，把人的介入集中在真正需要拍板的地方。**因此 P1 的 `evaluation` 落地不是可选优化，而是全自动能力的前提**——但它不阻塞 §8.2 的六项主线，顺序上仍在其后。

按这条判据划分：

| 决策 | 换个作者会不一样吗 | 归属 |
| --- | --- | --- |
| 这个 Skill 是什么风格（半写实 3D CG / 皮克斯卡通） | 不会——这是 Skill 的身份 | `planning.prompt_guide` |
| 角色造型是否跨镜头一致 | 不会——不一致就是错 | 提示词声明锚点要求，Agent 落成拓扑（§6.1） |
| 能不能出字幕 | 不会——硬禁项 | `planning.conduct_rules` |
| 产品图该绑到哪个语义角色 | 不会——客观对应 | `planning.planning_notes` 里的锚点要求 |
| 生成前必须先确认哪些素材 | 不会——有客观依赖顺序 | `planning.conduct_rules`（顺序交给 Agent 理解，不加字段） |
| **这个故事该拍几个镜头** | **会** | **不进 Skill** |
| **节奏快慢、某个镜头怎么构图** | **会** | **不进 Skill** |

把主观决策写进 Skill 有两个害处：一是把个人偏好固化成规则，等于 §3.1 已经反对的模板化；二是约束越密，Agent 的规划空间越小，创作力被挤掉。**Skill 应该声明不可妥协的部分，然后把创作空间留出来。**

主观决策的承接机制是现有的单修路线，不需要新建任何东西：把目标节点放进 Agent 上下文，由 AI 辅助人修改，然后 `freezone_run_workflow(direction="downstream")` 从改动点往下重做（§7.3）。这条路线在手工建图阶段已被生产使用验证。

相应地，主观决策的“验证”方式也不同：可复现的部分靠自动化校验和标杆用例回归；主观的部分靠人看一眼再调，不写进任何断言。§8.3 的标杆用例集据此设计——它断言风格是否锁定、锚点是否绑上、禁项是否遵守，**不断言镜头数量应该是多少**。

### 3.2 Recipe：单阶段工艺

Recipe 回答：

> 某一个生成阶段的输入应怎样转成高质量提示词？

标题刻意不写“内部复用的”——**跨 Skill 复用是这一层的设计目标，不是当前状态**。实测复用率为 0（§2.8），兑现条件见 §11。定义与现状必须分开，否则读者会把目标当成既有能力。

Recipe 继续使用当前 Runtime，不新增脚本执行能力。普通用户不需要选择 Recipe；设置页中的 Recipe 管理保留为高级功能和社区作者工具。

Skill 与 Recipe 的切分线必须写死，否则会重演 §2.8 的漂移：

```text
Skill  持有：流程顺序 + 资产决策 + 跨镜头一致性锚点 + 观感基调 + 强约束
Recipe 持有：给定已确定的输入、目标和强约束后，这一个节点的提示词怎么写
```

判据是一句话：**换一种观感或换一个题材时需要改的东西，属于 Skill；不论什么观感都同样适用的写法规范，属于 Recipe。**

以 `pixar-ip-character-design` 为例做示范拆分：

| 原 Recipe 中的内容 | 迁移后归属 |
| --- | --- |
| 【输出结构要求】的 7 点结构、【质量标准】、【禁止事项】 | 留在 Recipe——任何风格的角色立绘都需要这套结构 |
| `风格前缀：皮克斯3D卡通渲染，C4D+Octane质感，圆润人物建模` | 上移 Skill 的 `planning.prompt_guide` |
| `所有标志性配饰必须在提示词中明确提及` | **留在 Recipe**——见下方说明，这是最容易判错的一条 |
| `品牌元素由道具锚点阶段处理` | 上移 Skill 的 `planning.conduct_rules` |
| `负面提示词：写实风格、恐怖、变形、多余肢体…` | 通用画质类留 Recipe；风格排斥类（如 `写实风格`）上移 `planning.conduct_rules` |

第三行值得单独说明，因为它看起来像一致性要求，实际不是。这条 Recipe 生成的是**角色立绘本身**，也就是锚点图。生成锚点的时刻还不存在任何参考图，所以“把标志性配饰写清楚”是一条**提示词完备性要求**——不写全，产出的锚点自己就不可复现。而且这条要求与风格无关：任何风格的角色立绘都该枚举辨识特征。因此它是通用工艺，留在 Recipe。

真正的一致性要求是另一件事：**后续每个相关镜头都应复用这张锚点图**。厚 Skill 要求 Agent 把它落成锚点节点和引用边；真实参考拓扑比一句“保持一致”更有效，但当前 Validator 不检查角色身份语义（§6.1）。

同一段文字里混着这两件事，是散文式 Skill 最常见的陷阱：生成锚点时的提示词完备性 vs 使用锚点时的拓扑绑定。迁移时必须分开处理。

按这条线迁移后，同一份「角色立绘 Recipe」能被皮克斯风、乐高风和港片风三个 Skill 共用，观感差异由各自 Skill 的 `planning.prompt_guide` 注入，跨镜头参考关系由各自厚 Skill 指导 Agent 落成。

### 3.3 WorkflowPlan：本次任务唯一的结构化计划

本次任务只有一份结构化计划。节点数量、拓扑、并行关系、阶段分组和素材依赖都在它里面表达。

**主路径已演进（`671cb07`）。** 原设计是让 Agent 直接产出完整 `freezone_workflow_plan.v1`；当前代码改为让 Agent 只产出精简意图，由工具确定性编译成计划：

```text
Agent 产出 freezone_workflow_intent.v1        （json_workflow_catalog.py:29）
  → freezone_prepare_workflow_draft(intent=...)   工具确定性编译，返回精确预览
  → freezone_patch_workflow_draft(...)            用户调整方案时
  → freezone_confirm_workflow_draft(...)          确认后写入画布
```

Agent 只决定：用户目标、结构化输入、作品/镜头 PlanItems、每项使用的允许 Recipe、真实输入依赖、是否生成素材锚点、是否自动执行。**节点数据、稳定 ID、连线类型、分组、布局和成片合成由工具完成，不由模型生成。**

这个改动方向与主张二一致且更强：模型产出的面变小，可校验的结构由确定性代码生成，能被模型写错的东西更少。

两个入口的现状必须写清楚，否则容易改错地方：

| 入口 | 现状 |
| --- | --- |
| `freezone_prepare/patch/confirm_workflow_draft` | **主路径**，正常规划一律走这里 |
| `freezone_create_workflow_graph(plan=...)` | **兼容入口**，只在用户明确要求 Skill 蓝图无法表达的自定义拓扑时使用 |
| `freezone_build_workflow_plan` | **禁止调用**（见 `.hermes/skills/workflows/SKILL.md`） |

`freezone_workflow_plan.v1` 与 `validate_agent_workflow_plan()` 继续存在，服务于兼容入口和最终结构校验；但**不要再把「让 Agent 直接生成完整 Plan」当作要实现的目标**，那条路已经降级。

当前代码的原生审批粒度是“应用画布命令前确认”，并没有独立的阶段检查点协议。阶段性确认由 Skill 的执行规则、计划的节点分组和 Hermes 对现有 `freezone_run_workflow` 的分范围调用共同实现，不能在文档中假设 Validator 或 Runner 已经原生理解 `pause_after`。

不增加 CreativePlan，也不增加独立的 Skill Session。intent 是 Plan 的输入而非第二种计划——它不落盘、不参与执行、确认后即被编译结果取代。

### 3.4 节点能力：当前代码中的原子 Skill

当前原子执行能力有两个互补来源：

- `src/novelvideo/freezone/skill_registry.py` 中的 `skill.v1` 和 `SkillDefinition`，主要描述可运行 Skill 节点的输入、输出、权限和项目主线能力；
- 前端 `canvas_action_catalog.v1` 与节点级 Action Catalog，描述图片、视频、音频、文本、上传、合成和 UI 节点在当前状态下真正可执行的动作。

为了避免和用户可见的 Workflow Skill 混淆，产品文档统一称它们为“节点能力”或 Capability。前者回答“这个 Skill 节点接受什么、产出什么”，后者回答“这个真实节点现在能做什么、是否满足执行条件”。

2.0 不强行合并这两个现有协议，也不改现有 `SkillNode`；只在产品语言和 Agent 编写规则中明确各自边界。

## 4. 本次规格不需要再造 Project Spec

Flova 将 Prompt、Final Video Spec 和 Skill 分开，这个产品原则是对的：一次任务的比例、时长、语言不应写进长期 Skill。[Flova Skill 文档](https://www.flova.ai/docs/en/features/skills)

但 DramaClaw 当前已经有足够的承载方式：

```text
Skill.input_parameters
  → freezone_get_workflow_skill().input_contract
  → input_contract.resolved
  → WorkflowPlan.inputs
```

因此 2.0 不新增 `freezone_project_spec.v1`。用户本次的比例、时长、语言、数量和执行模式都通过现有 Input Contract 解析、补默认值和确认，再写入 `WorkflowPlan.inputs`。

对于广告、漫剧等复杂 Skill，已确认输入可以在现有确认界面或 Plan 摘要中展示。2.0 不要求额外创建“创作规格”文本节点；如果以后确有画布可视化需求，再把 `WorkflowPlan.inputs` 做成只读投影，不能成为第二种真相源。

如果以后确实需要跨多轮持久保存项目规格，可以把已确认值写入现有 Canvas metadata；这仍然不是另一种 Plan。

### 4.1 上述论证漏掉的一半

以上判断只覆盖了“每次任务可变的输入”，这部分成立且不需要改。但它漏了另一半：**Skill 作者声明的长期观感、资产策略和全局负面约束，当时在 Schema 中没有任何承载位置。**

§2.8 的实测显示，作者因此自己造了一个：用 `*-video-spec` Recipe 生成一个【全局视频规格】文本节点，把 `Visual Style Lock`、`Asset Policy`、`Audio Policy` 和 `Global Negatives` 写进去，17/30 份下游 Recipe 靠 prose 约定读取它。也就是说，这一节“不需要再造 Project Spec”的结论没有错，但因为论证不完整，实际结果是**在运行时用文本节点造了一个没有 Schema、没有校验的 Project Spec**。

正确的归属是 Skill 已有的 `planning.prompt_guide` 与 `conduct_rules`（§6.1），而不是第二种 Plan Schema。因此：

- 本节结论不变：**不新增 `freezone_project_spec.v1`**，§9 的对应条目也保留；
- 但 §8.2 第 3 项必须把这些已有字段真正送到执行层，否则作者会继续用运行时文本节点模拟它；
- `*-video-spec` 那 4 份 Recipe 随之删除（§8.2 第 5 项）；已确认规格直接保留在 `WorkflowPlan.inputs` 并传入 Recipe Runtime，不在本轮新增前端或 Graph Builder 投影机制。

判据可以概括为一句话：**每次任务都可能变的值走 `input_parameters`；Skill 作者一次写定、跨任务复用的规则走现有 `planning`；两者都不需要新的 Plan Schema。**

## 5. 参考与竞品

这一节的作用不是需求来源。判断依据始终是 §1.1 的五条主张与自有代码事实；别人有没有某个功能，不构成我们做或不做的理由。

**三家的角色不同，不能平铺着读。** 区别的根源是它们的方法层是否可获取：

| 对象 | 角色 | 方法层可获取？ | 对我们的实际用途 |
| --- | --- | --- | --- |
| **Flova**（§5.1） | **参考** | ✅ 文档详尽，Skill 提示词可获取 | **工艺层内容可以真正学习**——电影化提示词规则、镜头写作顺序、关键帧写法可用于完善共享 Recipe；音色身份机制只作为未来产品目标记录 |
| **LibTV**（§5.3） | **竞品** | ❌ 闭源，云端 Skill Hub 拿不到 | **只能对标定位与架构取向**，方法层无从学习。它 100 多个 Skill 的数量对我们没有可借鉴的工艺价值 |
| **Miora**（§5.2） | 产品流程参考 | 仅产品说明 | 只提供“选垂直 Skill → 描述 Brief → 从结果反向沉淀 Skill”这一流程层参考 |

这个区分有实际后果，不是分类癖：

- 撰写共享 Recipe 时（§8.2 第 5 项），Flova 公开的工艺原则是可用的参考输入；
- LibTV 的 Skill 内容既拿不到也不该去逆推，它唯一对我们有信息量的是那个公开的遥控包所暴露的架构选择（§5.3）；
- **参考工艺原则与复制 Skill 内容再分发是两件事。** 前者是正常的专业实践，后者涉及来源授权，见 §6.3 的许可提示。

信息边界：以下内容来自各家公开文档、公开报道与公开仓库，加一份用户提供的真实 Flova Skill 样本（截断）。Flova 公开 Skill 画廊的完整规则文本未能取得，因此不对其画廊内容做断言；LibTV 的云端 Skill Hub 内容因闭源而结构性不可得，§5.3 只依据其公开仓库、官方说明与第三方实测，且不打算通过逆向推测补足。

### 5.1 Flova：参考对象

Flova 在本文档中的角色是**参考**而非竞品对标：它文档详尽、Skill 提示词可获取，因此其工艺层内容能被真正学习和吸收。本节记录的区块划分与工艺原则，是 §6.1 字段设计和 §8.2 第 5 项撰写通用 Recipe 的参考输入。

Flova 的公开设计表明：Skill 是 Agent 的生产手册，用户可以显式选择、查看、编辑、复制和分享。[Flova Skill 文档](https://www.flova.ai/docs/en/features/skills)

其官方文档把 Skill 描述为七个区块：基本信息、工作流规划、媒体分析与处理、分镜设计、媒体生成（模型选择、分辨率、参考图用法、连贯性规则）、提示词写法、视频剪辑（时间线组装、节奏、转场、音量、淡入淡出）。**其公开 Skill 画廊的实际规则文本未能取得，因此本节不对其具体内容做任何断言。**

一份用户提供的真实 Flova Skill 样本显示，它的形态是编号散文而非结构化字段，并且明确写着 `complete the task in the following order`，随后是 `Step 1 确认输入素材 → Step 2 提取角色锚点（脸型/五官/发型/服装/配饰/体态）并设为全片唯一视觉锚点 → Step 3 非全身像时先补全全身参考`。

另外一处需要更正保守表述：其项目编辑文档明确写出用户 **cannot re-run individual workflow items or modify the underlying task topology**，可编辑的只有既有结构内的内容（双击改元素/镜头/音频描述、拖拽重排故事板卡片、把素材拖进故事板分类）。因此“局部返工”这件事在 Flova 不是粒度更粗，而是**该维度不存在**——这比原先“恢复靠时光与分支”的描述更根本，也让主张一与主张二的对照更硬。手工编辑与 Agent 的关系是冲突面板二选一，且手工结果成为 Agent 后续工作的起点。

其 Skill 的固定顺序与本文档主张的动态规划**不矛盾**，但必须区分两个层次：

- Flova 固定的是**前置资产准备的决策顺序**——先确认素材、再提锚点、再判断要不要补图，这个顺序确实不该每次变；
- 动态的应该是**镜头拓扑**——分镜数量、并行分支、是否加关键帧、从哪一阶段开始。

这两层我们都不需要新字段承载：前置决策的顺序写在 `planning.planning_notes` 与 `conduct_rules` 的散文里，Agent 读散文排顺序本来就可靠；镜头拓扑由 `freezone_workflow_plan.v1` 按本次任务动态决定。曾考虑为“有序前置决策”加一个 `preparation_steps` 字段，后来砍掉了——理由见 §6.1 的新增字段判据。

对照下来，Flova 七区块中我们已有对应的只有基本信息和（很薄的）提示词写法两块；分镜设计、媒体分析、连贯性规则在我们这里被挤进了 Recipe 的 `system_prompt`（§2.8）；视频剪辑区块我们刻意不做（见下文）。

#### Flova Agent 的实际机制

其 Agent 文档记录的机制如下，用来对照 §1.1 的主张一和主张二。[Flova Agent 文档](https://www.flova.ai/docs/en/features/agent)、[项目编辑文档](https://www.flova.ai/docs/en/features/project-content-editing)

| 机制 | Flova | DramaClaw |
| --- | --- | --- |
| 工作流的存在形式 | Agent 内部协调 5 个模块（Planning / Media Understanding / Storyboard Design / Media Generation / Editing Assembly），模块对用户不可见，文档称用户“usually do not need to name these modules” | `freezone_workflow_plan.v1`，可校验、可审批、可存档的一等公民（主张二） |
| 计划审批 | 无结构化计划审批，只在对话里展示执行步骤（“Analyzing media”“Creating the storyboard”“Generating shot videos”）；想先看计划要靠提示词请求 | 应用画布命令前确认，Plan 先过 `validate_agent_workflow_plan()` |
| 生成前确认门 | 文档明确写“no pre-generation permission gate exists” | 按命令类型与批量规模确认（§7.5 承认还不是成本感知的风险引擎） |
| 单点失败恢复 | 文档未记录 retry 或失败处理协议；提供 Stop、back to this moment、Branch in new project | `freezone_run_workflow(direction="node")` 只重跑该节点，下游按 DAG 续上 |
| 探索另一条方向 | Branch in new project，在消息边界整体 fork 项目 | 框选工作流子图 + 创建副本（`duplicateNodes()` 连内部边一起复制），同画布并排跑对比 |
| 并发冲突 | 冲突面板让用户选保留哪个版本 | 无对应机制；当前是单用户场景，暂不需要 |
| 结果承载 | Storyboard / Media Files / Timeline / Docs 四个面板，是 Agent 写入的投影 | Graph 是真相源，故事板与时间线是同一批数据的视图（主张一） |
| **用户可编辑什么** | **只能改既有结构内的内容**——双击改元素/镜头/音频描述、拖拽重排故事板卡片、拖素材关联分类。其文档明写用户 **cannot re-run individual workflow items or modify the underlying task topology** | 拓扑本身可改：增删节点、改连线、框选复制子图、单节点重跑 |
| 手工编辑与 Agent 的关系 | 冲突面板二选一；手工编辑成为 Agent 后续工作的起点（“the Agent will continue from the current project state afterward”） | 同一块画布上人机共存，Graph 始终是双方共同的真相源 |

两处需要说明，避免误读：

- **“文档未记录”不等于“实现里没有”。** 上表只反映其公开文档，不对其内部实现下结论。
- **Branch in new project 不作为我们的对标项。** 它是工作流不可见所导致的代偿设计：既然用户伸手改不到“工作流”本身，探索另一条方向就只能整体 fork。我们的工作流是可框选复制的对象，分支天然是拓扑的一部分，不需要在消息边界 fork 项目。因此 §8.4 不保留“Agent 消息级恢复”。

#### 对照后的判断

Flova 七区块中我们已有对应的只有基本信息和（很薄的）提示词写法两块；分镜设计、媒体分析、连贯性规则在我们这里被挤进了 Recipe 的 `system_prompt`（§2.8），这是要补的；视频剪辑区块按 §9 的理由不做。

反向对照能确认三条主张成立：工作流是一等公民而非内部行为（主张二）；**相对 Flova 这种投影式架构**，失败恢复到单节点而非整体回滚（主张一，注意这一条不构成相对 LibTV 的优势，见 §5.3）；Recipe 这一层其文档明确否认存在——原文 no shared modules, inheritance, or cross-Skill composition，复用只发生在 Skill 级别的拷贝——所以工艺复用是我们的结构性差异（主张三，待兑现）。

#### 一份真实样本对主张三的印证

用户提供的一份完整 Flova 视频制作 Skill 是主张三最具体的证据。它在同一份散文里同时包含：阶段依赖声明、确认检查点策略、素材分析规则、分镜设计规范、图片提示词六条电影化规则、关键帧写法、视频提示词的四层顺序、音频提示词规则、剪辑装配说明，以及具体的模型名与分辨率。

其中这几块是**与题材和风格无关的通用工艺**，任何影视类 Skill 都需要：

- 电影化提示词的六条规则（专业术语、构图与镜别、灯光与负补光、调色克制、渲染质感、潜台词与微表情）；
- 视频提示词的四层顺序（镜头 → 主体 → 空间 → 音频）；
- 首帧 / 尾帧 / 高光帧各自的写法；
- `no music` / `no subtitles` 这类清洁产出的负面约束。

**在单体结构下，每一个 Skill 都必须把这些重新包含一遍。** 这比 §2.8 那份 30 份内置 Recipe 的统计更有说服力，因为它说明重复不是我们独有的实现问题，而是单体 Skill 的必然结果。我们把这些放进共享 Recipe 一次、全部 Skill 共用，正是 §8.2 第 5 项要达成的状态。

必须同时说清一件容易被读反的事：**这些 Skill 写得厚是对的，厚是它们能出好片的原因。** 一份只写“做个王家卫风格短片”的薄 Skill，不会得到那样的成片；正是那些具体到景别、负补光、调色克制度、锚点钉法、并行分批的条目，把 Agent 的输出抬到可用水平。

所以我们要的不是更薄的 Skill，而是**同样的厚度换一种组织方式**：风格身份、资产判断、阶段原则和一致性方法留在厚 Skill，可跨题材复用的工艺沉进 Recipe 写一次，由 Agent 根据当次任务生成 Graph。反对的是重复的厚，不是厚。

同一份样本里还有一处值得记录的机制：它为每个有对白的角色建立独立音色身份，并在生成镜头时持续复用。这个产品目标值得保留，但当前 DramaClaw 的 VideoNode 音频引用主要是配乐参考，不能据此宣称音色身份链路已经完成；等 voice identity / voice clone 与画布引用真正接通后再实施。

它的阶段依赖是用散文写的（`2→1; 3→1,2; 4→3; …`）。我们不需要这种写法——WorkflowPlan 的边本身就是 DAG，可校验、可执行、可视化，这正是主张二的对照。

同时记录我们不采纳的其余设计，以及原因：独立 Asset/Media 数据模型、对象级协同冲突系统、新的 Timeline 数据中心、模型名写入社区 Skill。前三条当前 Graph、生成历史、Canvas revision 和 `videoComposeNode` 已能覆盖首发需要，只有真实使用证明不够时再增强；最后一条与主张四直接冲突。

### 5.2 Miora

用户提供的 Miora 资料中，最重要的不是界面名称，而是三件事：

1. 用户先选一个垂直 Skill，再描述 Brief；
2. Agent 根据任务决定真实节点和执行过程；
3. 用户可以从满意的结果和过程反向创建自己的 Skill。

Miora 将记忆分为项目与个人层，并强调 Skill、Memory 和画布共同工作。其团队公开说明也强调 Memory 与 Skill 分享相互隔离。[Miora 产品与团队说明](https://www.producthunt.com/products/miora-2?launch=miora-2)

DramaClaw 对应方式：

- 垂直 Skill：现有 Skill Studio + `/Skill` 选择；
- 动态节点：现有 WorkflowPlan + Graph Builder；
- 从结果沉淀：现有“从画布总结 Skill”；
- 记忆：Hermes Memory；
- 画板：Freezone Graph + 故事板视图。

不需要为对齐 Miora 再开发一套 Memory 或多 Agent 系统。

### 5.3 LibTV：竞品，形态最接近、架构取向相反

LibTV 在本文档中的角色是**竞品**，不是参考对象。它是 LiblibAI 于 2026 年 3 月 18 日发布的 AI 视频创作平台，2026 年 7 月 14 日发布了自己的视频 Agent，产品形态上与 DramaClaw 最接近——无限画布、节点工作流、工作流视图与故事板视图双视图、画布内置视频合成节点。本仓库前端约四十处 `libtv` 注释对标的即是它的画布交互。

**它的方法层闭源，因此本节只做定位与架构对标，不做工艺学习。** 云端 Skill Hub 的内容结构性不可得，我们也不通过逆向推测去补足——那既不可靠也没有必要。本节可用的信息只有三类：公开仓库、官方说明、第三方实测。

形态几乎一致的部分：

| 能力 | LibTV Agent | DramaClaw |
| --- | --- | --- |
| Agent 自动建节点、连线、填提示词、生成、合成 | ✅ | ✅ |
| 工作流视图 + 故事板视图双视图 | ✅ | ✅ |
| 勾选需重做的分镜，只重跑受影响的下游节点 | ✅ | ✅ |
| 阶段性确认 + 随时打断调整方向 | ✅ | ✅ |
| Skill 驱动创作 | ✅ | ✅ |

**因此“局部返工优于整体回滚”不是我们相对 LibTV 的优势**，它是这一代画布类产品的共同做法；该优势只在对比 Flova 那种把结果投影到面板、只能在消息边界整体 fork 的架构时成立。§5.1 已据此限定。

架构取向相反的部分，这才是真实差异：

| 维度 | LibTV | DramaClaw |
| --- | --- | --- |
| **Skill 形态** | MD 散文文件，引导式创建，无机器校验 | 结构化 JSON + `extra="forbid"` 三路径校验 |
| **工艺复用层** | 无。每个 Skill 自包含 | Recipe（主张三，待兑现） |
| **对外开放什么** | 只开放遥控。公开的 `libtv-labs/libtv-skills` 是 API 客户端，其 `SKILL.md` 明确要求外部 Agent “**你的职责是搬运工，不是创作者**……不要自行拆解任务步骤……不要自行编排镜头描述”，创作方法留在云端 Skill Hub | 开放方法本身。Skill Bundle 就是创作方法，可读、可改、可 review、可自部署 |
| 执行位置 | 云服务，需 ACCESS_KEY | 本地 Graph + 本地 Runner |
| 模型 | 绑定自家 | NewAPI 中立（主张四） |

#### 可用作对标参照的公开数字

第三方实测给出的端到端耗时与规格，可作为 §8.3 标杆用例的参照量级（我们尚未测过自己的对应数字）：

| 项目 | 公开数字 |
| --- | --- |
| 世界杯主题短片，创意到成片 | 32 分钟 |
| 皮克斯风动画广告 | 21 分钟 |
| 女性向短剧（含优化） | 2 小时 10 分 |
| 单项目最大成片长度 | 5 分钟，含多语言字幕与音画同步 |
| Agent 一次生成的故事板镜头数 | 7 个以上 |
| 官方 Skill 数量 / 参与设计师 | 100+ / 200+ |

另有两个已被验证过的能力方向值得记录：**参考视频克隆**（上传成片，提取叙事逻辑与镜头节奏后重制）对应我们的 `videoAnalyzeStory.ts` 与 `videoStoryNormalizer.ts`，可在 `conduct_rules` 里写一句“若用户上传参考视频，先提取叙事结构与镜头节奏”；**角色一致性锚定**可由厚 Skill 描述三视图、服装与表情变体的生成和复用方法，再由 Agent 落成参考拓扑。两者当前都不需要新增 Schema 字段。

#### 创作者激励机制，以及我们为什么走另一条路

其 Skill 生态是用现金驱动的：千万级激励金，首期截止 2026 年 8 月 30 日，合格创作者每月最高 3000 元、解锁独家邀约后 5000 元，叠加社媒热度激励与月度社区评奖；Skill 需经官方审核并按质量分级发放；Skill 广场商业化后按真实使用量持续分成，首批创作者享更高比例。

我们不复制这套机制，走的是**源码可得协作**——`dramaclaw-skills` 是公开仓库，Skill 以可校验 JSON Bundle 形式提交、可被任何人 review 和 fork。两条路的适用条件不同：现金激励能快速堆数量，但方法留在闭源平台、作者拿的是分成；源码可得协作起量慢，但方法本身归社区所有、可自部署、可二次分发（受 §6.3 的许可约束）。

这也是为什么 §8.2 第 5 项那个指标是生态命门：**在没有同等资金投入的情况下，最有效的降门槛方式是让新增风格或题材 Skill 不需要复制任何 Recipe。**

#### Recipe 层价值的直接证据：一个真实作者的困境

一篇第三方深度实测里有一处细节，比任何推断都有说服力。作者提到 `lengyi-shotlist` 是他此前**在 GitHub 公开发布的“一套分镜 Skill”**。

注意这个措辞。在缺少工艺复用层的架构里，“分镜方法”只能作为一个**完整 Skill** 存在。于是作者面对的是二选一：用自己的分镜方法，就得放弃平台的导演美学 Skill；用美学 Skill，就得放弃自己的分镜方法。两者都要，只能复制整份 Skill 再手工缝合。

在 Skill + Recipe 分层下这不是问题：分镜工艺作为通用 Recipe，观感由各 Skill 的 `planning.prompt_guide` 注入，锚点要求由各 Skill 的 `planning_notes` 声明——同一份分镜 Recipe 可以同时服务多种导演风格。

从三个实测案例里能直接列出的通用工艺，全部与题材风格无关，却必须在每个 Skill 里重写一遍：

| 通用工艺 | 与风格有关吗 |
| --- | --- |
| 锚点清单的组织方式（编号 + 描述 + 指向实际节点的 key） | 无关 |
| 分镜表的列结构（镜号 / 时间区间 / 内容 / 引用锚点 / 镜头语言） | 无关 |
| 角色三视图的生成方法 | 无关 |
| moodboard 与影调图各出多张供用户择一 | 无关 |
| 并行分批策略（先跑前一批，全部完成后自动接后一批） | 无关 |
| 叙事节拍提取（先拆节拍，再按节拍定分镜数） | 无关 |

**这六项恰好就是共享 Recipe 该装的东西。** §8.2 第 5 项要收敛出的共享工艺集，覆盖的正是这一类内容。

#### 结构化 Skill 的价值有具体失败模式

同一篇实测展示了锚点绑定在无结构层时的实现方式：Agent 生成两份 markdown 文件——一份锚点清单（每条锚点带编号、外观描述，以及一个指向实际画布节点的 `node_key`），一份分镜表（其中一列直接写该镜引用哪几条锚点，如 `A1,A2,A4`）。然后 Agent 照着这张表去连线。

**这套机制没有任何校验。** 表里写了引用 A2、实际连线漏了 A2，不会有任何东西报错——一致性完全依赖模型自觉照表执行。而漏连的后果要等镜头生成出来、人眼看出角色漂了才发现。

我们本轮同样靠厚 Skill 要求 Agent 连线（§6.1），因此**这个失败模式我们也可能有**——区别在于我们把它当成一个待测量的假设：§8.2 第 1 项与 §8.3 的标杆评测会统计实际失败率，真会漏再升级成 Schema 字段加 Validator 不变量。写在这里是为了记住这个风险存在，而不是宣称我们已经解决了它。

顺带注意那份锚点清单的形态：**又是用运行时 markdown 文件承载本该结构化的映射关系**，与 §2.8 里 `Final_Video_Spec` 完全同一个模式。缺字段的地方，作者一定会用运行时文本补上。

#### 外部实践印证了现有字段足够承载首版

实测中出现了交付物与执行模式两类信息，但它们都可以由现有字段表达，不需要新增区块：

- **交付物**：其 Skill 详情页会写明“这个 Skill 适合拍什么、需要哪些素材，以及**最后会交付什么**”。交付物确实是 Skill 的一等信息——但用 `description` 一句话说清就够，Agent 据此判断该不该建合成节点，漏了用户一句话能补，不值一个字段（§6.1）。
- **执行模式**：Agent 的入口问询里有一项就是“**执行模式？**”，选项形如“全自动（我不参与中间确认，直接出成片）”。这正好说明它是一个**每次任务的输入项**，因此我们用 `input_parameters` 里一条 `execution_mode` 承载，不新增区块（§7.5）。

两者的位置略有不同，值得记录：它把执行模式作为**每次任务问用户**的输入项；我们让 **Skill 作者声明默认档位、用户本轮指令可覆盖**（§7.5）。我们的做法少一次提问，且同一 Skill 的行为更可预期——但必须保证用户覆盖始终有效，否则就变成了作者替用户做决定。

#### 100+ 份自包含 MD 是规模层面的佐证

LibTV 已上线 100 多个 Skill（韦斯安德森电影美学、皮克斯动画广告、FOST-3D 国漫短片等），每个是自包含的 MD 文件，其公开信息中没有任何跨 Skill 复用单元。

这意味着“电影化提示词规则”“镜头→主体→空间→音频的写作顺序”“首尾帧写法”“no music / no subtitles”这类**与题材风格无关的通用工艺，在 100 多份 MD 里各写一遍**，改一条要改一百个文件。它还投入了千万级创作者激励继续扩充 Skill 数量，重复只会随规模放大。

§2.8 用我们自己 30 份内置 Recipe 的零复用做论证，这里得到一个量级更大的外部印证：**重复是单体 Skill 结构的必然结果，不是某个团队写得不好。** 因此“新增一个 Skill 需要新增几份 Recipe”（§8.2 第 5 项）不只是工程指标，更是生态指标——它决定作者门槛是“抄五到七份 Recipe 再逐份改措辞”还是“填一份 Skill”，直接影响在没有同等资金激励的情况下生态能否自行跑起来。

#### 从其实测报告免费拿到的一条风险

公开实测指出 LibTV 的一个弱点：**制作步骤紧耦合，前段产出直接透传后段，早期错误会沿链条向下游传播**——分镜阶段判断错了，后续所有镜头都跟着错。

我们的 Recipe 链有完全相同的结构：`upstream_text` 一路向下透传，上游文本节点的错误会污染全部下游节点。这不是抄它，是从它的教训里拿一条已知风险。现有缓解手段有两个，都已在文档内：

- 在厚 Skill 的 `conduct_rules` 里把易错的早期判断（分镜、锚点）标为必须确认的门，并结合当前 `manual/auto` 授权生效；
- §7.5 的风险驱动确认——批量付费生成前等确认，正好卡在错误开始放大成本的位置。

需要注意的是这两者都是“让人早点看见”，不是自动纠错。文档不宣称我们解决了这个问题，只记录它存在以及当前缓解方式。

#### 明确不做：不发 OpenClaw 遥控包

LibTV 通过 OpenClaw 规范发布客户端包，使任意兼容 Agent 都能遥控其云服务。OpenClaw 生态规模不小，但**我们不做同类包**，理由是架构冲突而非工作量：

发一个遥控包意味着把外部 Agent 降为搬运工、把创作决策收回服务端，这与主张一（Graph 是本地创作真相源）和主张三（创作方法可检查）直接矛盾。两种源码开放策略的分野可以概括为一句话：**LibTV 公开客户端源码以保护云端方法，DramaClaw 公开方法本身，因此不需要客户端。**

我们的分发单位是 Skill Bundle——方法本体，而不是访问凭证加 API 封装。

## 6. 2.0 使用的最小数据契约

### 6.1 Skill

当前后端 `AgentCatalogSkillConfig` 使用以下最小契约：

```json
{
  "schema_version": "dramaclaw.workflow-skill.v1",
  "id": "ecommerce-video",
  "name": "电商产品视频",
  "version": "1.0.0",
  "enabled": true,
  "description": "根据产品素材和营销目标动态生成电商视频工作流",
  "category": "ecommerce",
  "triggers": {
    "keywords": ["电商视频", "产品广告"],
    "node_scopes": ["textGeneration", "imageGeneration", "videoGeneration"]
  },
  "input_parameters": [
    {
      "id": "duration",
      "label": "目标时长",
      "type": "single_select",
      "required": true,
      "default": "30",
      "options": ["15", "30", "60"]
    },
    {
      "id": "execution_mode",
      "label": "执行模式",
      "type": "single_select",
      "required": false,
      "default": "manual",
      "options": ["manual", "auto"]
    }
  ],
  "allowed_recipe_ids": [
    "product-brief",
    "product-storyboard",
    "product-element-image",
    "product-video-shot"
  ],
  "planning": {
    "planning_notes": "根据素材、目标时长、模型能力和已有节点动态决定阶段、数量、依赖和执行范围。先确认并绑定素材，再提取外观参考，缺少场景参考时创建参考图而非凭空生成。优先为产品主体建立统一参考图节点，并把它连到每个需要保持产品外观的元素图与镜头视频节点。",
    "prompt_guide": "商业广告质感，干净影棚光，高饱和产品色；突出真实卖点、使用场景和品牌调性。避免手绘插画风、低分辨率、变形产品外观，不要字幕。",
    "conduct_rules": [
      "已有合格素材时复用，不重复生成",
      "低成本且可逆的文本规划可以自动推进；批量付费生成、替换已有素材和最终合成必须按当前授权确认",
      "视频工具不需要锁定首帧时跳过关键帧节点",
      "局部失败只重做相关节点"
    ]
  },
  "evaluation": {
    "quality_threshold": 8,
    "domain_constraints": ["不得虚构产品功能"],
    "rating_bands": [
      {"score": 8, "description": "卖点真实，素材绑定正确，结构和执行路径完整"},
      {"score": 5, "description": "基本可用，但卖点、素材引用或镜头结构仍需局部修正"}
    ],
    "visual_review_items": [],
    "text_review_items": []
  }
}
```

上面所有字段都已是当前后端与设置页在用的契约，**本轮不新增任何字段**。`options` 当前是字符串数组；如果需要单独的用户显示标签，应以后统一扩展前后端 Schema，不能只在文档中使用 `{value,label}`。

画幅、时长和语言等每次任务可变值继续放在 `input_parameters`。不要恢复已经从 Agent Tool Schema 中移除的 `planning.default_aspect_ratios` 或真实供应商模型偏好。

`workflow_templates` 继续兼容旧 Skill，但不属于新社区 Skill 的必填字段，也不决定 Skill 能否显示。

#### 厚 Skill 决策，通用 Validator 守底线

本轮把创作判断留给 Agent，不把角色、场景、道具、镜头数量和阶段顺序硬编码进 Schema。厚 Skill 应完整告诉 Hermes：

- 什么内容必须先判断，什么素材应优先复用；
- 哪些主体需要参考锚点，哪些下游节点应引用它；
- 如何保持风格、角色和产品外观一致；
- 什么情况下可以跳过阶段、增加关键帧或局部返工；
- 哪些方向性决策和高成本操作应先询问用户。

现有 Validator 继续只守通用结构底线：Schema、节点与边是否合法、是否成环、Recipe 是否存在、媒体输入是否满足。它**不会**理解“这是同一个角色”“这个锚点必须覆盖所有镜头”之类的创作语义，也不应该在没有真实失败数据前承担这些领域规则。

角色一致性仍应尽量落成真实拓扑，而不是只写一句“保持一致”：Hermes 根据厚 Skill 创建角色或产品参考节点，再把它连接到相关图片和视频节点。当前代码已经提供实现这种拓扑所需的基础能力：

- `REFERENCE_CAPS_BY_MODE.allReference` 支持多参考，`firstLastFrame` 支持首尾帧；
- 图片生成提交层支持 `character` / `style` / `pose` / `generic` 参考角色和参考顺序；
- `VideoNodeData.referenceOrder` 支持调整视频引用的实际提交顺序。

这些能力让 Agent **可以**落成更好的 Graph，但不等于运行时已经具备锚点语义校验。2.0 的重点是让厚 Skill 稳定指导 Agent；如果标杆和真实项目证明某类漏连频繁、静默且代价高，再把那一类规则升级成结构化约束。

观感需要两条腿走：首次生成时还没有参考图，依靠 `planning.prompt_guide` 锁定风格；产生合格参考图后，Agent 再把它作为后续节点的实际参考。不要为了表达这条方法预先增加 `anchors` 字段。

#### 锚点用提示词声明，本轮不加字段

**Schema 本轮零改动。** 跨镜头的视觉一致性通过**厚 Skill 声明方法 + Agent 落成拓扑**实现，不新增结构化字段，也不宣称 Validator 可以确定性证明角色一致。

写法是在 `planning.planning_notes` 或 `conduct_rules` 里明确要求锚点节点与引用关系，例如：

```text
优先为产品主体建立统一参考图节点，并把它连到每个需要保持产品外观的元素图与镜头视频节点；
如果用户已经提供合格产品素材，直接把该素材作为统一参考，不重复生成。
```

当前物理机制足以支持图片参考拓扑：

- `REFERENCE_CAPS_BY_MODE.allReference` 支持多参考，`firstLastFrame` 支持首尾帧锁定；
- `referenceRoles.ts` 定义 `ReferenceRole = "character" | "style" | "pose" | "generic"`，用 `[ref:n=role]` 标记；
- `reorderReferencesByRole()` 把 character anchor 排到最前，因为多数供应商对靠前的参考权重更高；
- `VideoNodeData.referenceOrder` 让视频引用顺序可拖拽并决定实际提交顺序。

音频引用目前主要表达配乐参考，不能等同于角色音色身份。角色跨镜头音色一致需要独立的 voice identity / voice clone 链路；在该链路与画布引用语义真正接通前，文档不把“音色锚点”列为 2.0 已具备能力。

同一角色的多套外观（换装、不同年龄）就在提示词里分别描述并说明各自用于哪些镜头，不需要任何嵌套结构。

#### 为什么暂不加 `asset_policy.anchors` 字段

曾考虑把锚点绑定做成结构化字段 `asset_policy.anchors`，配 Validator 的绑定不变量——声明了 `required` 的锚点，Plan 里缺节点或缺引用边就拒绝。理由是竞品的同类机制没有校验：Agent 生成一份锚点清单和一份分镜表，表里某列标明该镜引用哪几条锚点，然后 Agent 照表连线，漏一条不报错（§5.3）。

**这个理由不够。** 它是从“对方没有校验”推出“会漏”，不是观察到实际漏了——我们没有任何数据说 Agent 连引用边的失败率是多少。为一个可能但未测量的失败提前加字段和校验，违反本文档自己在别处坚持的“跑过标杆再决定”。

因此顺序改为：

```text
本轮   用提示词声明锚点要求（零 Schema 改动）
        ↓
       跑 §8.3 的三个标杆，测量 Agent 实际漏不漏引用边
        ↓
真漏   再加 asset_policy.anchors 字段 + Validator 不变量，那时有数据支撑
不漏   省下一个字段、一套校验和四处 Schema 同步
```

标杆评测检查“需要一致性的镜头是否引用同一参考节点”，所以漏连可以在离线评测中被统计。它不是确定性单元测试，也不是运行时兜底；跑出真实失败率后，才决定要不要增加校验机制。

代价要写明：视觉参考漏连可能导致角色或产品外观漂移，通常在生成后才被发现。本轮接受这一风险，由厚 Skill、生成前确认和标杆评测降低概率，不用提前增加一套创作状态机。

#### 新增字段的门槛

这张表记录本轮考虑过但没有加的字段，以及它们各自的归宿。**它的作用是防止以后顺手扩 Schema**——判据是三条同时成立：能否被机器确定性校验、错了是否静默、代价是否昂贵。不同时成立，就用提示词交给 Agent。

| 曾考虑过的字段 | 为什么不加 | 改用什么 |
| --- | --- | --- |
| `asset_policy.anchors` | 失败率未测量，属提前优化 | 提示词声明 + 标杆测试验证（见上一节）；实测证明会漏再加 |
| `aesthetic.visual_style_lock` | 风格没进提示词，看一眼成片就知道，错误不静默 | 已有的 `planning.prompt_guide`——它的定义本来就是“提示词该怎么写”。真正的病根不是缺字段，是缺传递路径（§8.2 第 3 项） |
| `aesthetic.global_negatives` | 同上 | `prompt_guide` 与 `conduct_rules` |
| `preparation_steps` | 排顺序是 LLM 最擅长的事，写在散文里它就能照做 | `planning.planning_notes` 或 `conduct_rules` 里一句话 |
| `deliverables` | 漏了合成节点，用户说一句“合成一下”就补上，恢复成本极低 | Skill 的 `description` 已经表达了交付什么，Agent 据此判断 |
| `confirmation_policy` | 不需要新区块 | `input_parameters` 里一条 `execution_mode`（见上方示例），零新增 Schema，走现有 `input_contract` 路径，且天然由用户本轮选择覆盖 |
| `asset_policy.reuse_rule` / `missing_action` | 复用与缺失策略是判断题，散文足够 | `conduct_rules` |

**总原则：尽量用提示词驱动。** 结构化字段只用在“提示词已被证明不够”的地方，而不是用在“提示词可能不够”的地方。

### 6.2 Recipe

当前后端 `AgentCatalogRecipeConfig` 使用以下最小契约：

```json
{
  "schema_version": "dramaclaw.recipe.v1",
  "id": "product-storyboard",
  "name": "产品广告分镜",
  "version": "1.0.0",
  "enabled": true,
  "output_kind": "text",
  "action_keys": ["product-storyboard-plan"],
  "requires_source_media": true,
  "planning_prompt": "根据产品简报和参考素材生成广告分镜。",
  "result_summary": "产品广告分镜与镜头制作计划",
  "must_have_items": ["产品主体", "使用场景", "镜头内容", "镜头语言", "音频层", "品牌约束"],
  "system_prompt": "指导当前模型把用户目标、上游内容和产品参考素材转换为结构清晰的广告分镜计划。元素图、关键帧、视频和音频提示词由对应 Recipe 在各节点执行时生成。"
}
```

Recipe 仍然只是声明式 JSON 和提示词，不允许包含 Python、JavaScript、Shell 或网络请求。

复杂 Skill 不应像单体生产手册一样，把产品分析、分镜设计、图片提示词、视频提示词和音频规则全部重复写进一个超长 `system_prompt`。应按输出阶段拆成可复用 Recipe，并在节点执行时只加载当前 Recipe 的完整内容。例如：

```text
产品广告 Skill
  ├─ 产品卖点分析 Recipe（text）
  ├─ 广告分镜 Recipe（text）
  ├─ 产品与场景元素 Recipe（image）
  ├─ 可选关键帧 Recipe（image）
  ├─ 商业镜头 Recipe（video）
  └─ 旁白与音乐设计 Recipe（audio）
```

Recipe 不是独立决策者，也不是比 Skill 更高一层的指令。它只能在当前节点已经确定的输入、目标和强约束范围内，把上下文转换成更专业的下游提示词。Recipe 不得：

- 改变用户已确认的比例、语言、时长、品牌或产品事实；
- 跳过 Skill 要求的安全、合规、素材引用和质量约束；
- 决定增加、删除或重新连接 WorkflowPlan 节点；
- 自行选择 Skill 白名单之外的 Recipe；
- 直接执行节点动作、最终合成或模型路由。

这份清单本身正确，但必须记录一件事：**内置 Recipe 已经在违反它，而且当前代码没有任何机制阻止。** 实测（§2.8）：

- **12/30** 在 `system_prompt` 里指挥阶段推进，例如 `lego-minifig-input-analysis` 要求下游输出“请确认输入分析是否准确，确认后进入【剧本大纲】阶段”——违反第 3 条；
- **3/30** 写死字面画幅值、**7/30** 写死分辨率数值，例如 `ling-cage-key-elements` 的 `角色三视图：16:9，2K`、`ling-cage-shot-video` 的 `固定 720p`——违反第 1 条。

其中分辨率这 7 份要分两类处理：`ling-cage-key-elements`、`ling-cage-shot-video`、`retro-kungfu-shot-video` 是在工艺里写死数值，属真违规；`*-video-spec` 那几份写的是 `Resolution 默认 720p` 这类缺省声明，行为本身合理，但归属错了——缺省值应由 `input_parameters` 的 `default` 表达，随 §8.2 第 5 项一并上移。作为对照，`lego-minifig-video-spec` 和 `retro-kungfu-shot-video` 已经在正确消费 `input aspect_ratio`，说明正确写法是可行的，只是没有机制强制。

禁令之所以完全无效，是因为它没有执行机制：`build_recipe_compiler_task()` 收不到 `confirmed_inputs`，无从判断是否与已确认值冲突；Compiler 系统提示又把 Recipe 标为最高优先级。因此这份清单必须与 §8.2 第 3 项的机制改造捆绑，并在第 5 项的迁移中清除已有违规内容，否则它只是一段没有约束力的文字。

当前 `recipe_runtime.py:209` 的 `build_recipe_compiler_task()` 只显式接收 Recipe、节点类型、节点意图、用户目标、上游文本和参考媒体摘要，没有接收 Skill 的 `conduct_rules`、质量约束和已确认输入；其 Compiler 系统提示第 33 行还写着 `Follow the Recipe instructions as the highest-priority creative method`。

这个缺口的后果需要明确写出来，它不是契约整洁度问题：**“观感由 Skill 控制”这条产品路径当前是断开的。** Skill 作者写的 `conduct_rules`、`prompt_guide` 和 `domain_constraints`，到编译节点提示词那一刻一条都不在上下文里，而模型被明确告知 Recipe 优先级最高。因此 Skill 里的观感规则写得再好也不生效，作者唯一能真正影响输出的位置就是 Recipe 的 `system_prompt`——这正是观感被写死进私有 Recipe、复用率归零的成因。这一项是六项里的核心：字段存在但传不下去，等于没加。

2.0 的 Recipe Runtime 调用至少应携带：

```text
skill_id + resolved_skill_version
confirmed_inputs
skill_constraints
recipe_id + recipe_version
node_intent
upstream_text
reference_media
```

其中 `skill_constraints` 只传与当前节点相关的强约束和质量要求，不把完整 Skill、全部 Recipe 或整个 Graph 重复塞入上下文。它的来源按节点类型筛选：

| 节点类型 | 应传入的 Skill 内容 |
| --- | --- |
| 图片节点 | `planning.prompt_guide`、相关 `conduct_rules`、`evaluation.domain_constraints` |
| 视频节点 | 同图片节点 |
| 音频节点 | 相关 `conduct_rules`、`evaluation.domain_constraints` |
| 文本节点 | `planning.prompt_guide` 中与文本相关的部分、`evaluation.domain_constraints` |

所有节点都同时传入 `confirmed_inputs` 中的画幅、时长和语言，用于让 Compiler 拒绝与已确认值冲突的 Recipe 指令。

**锚点要求不传给 Compiler**——注意这不等于“不进任何 LLM 上下文”。它进的是**规划期**的上下文（§7.2），由 Hermes 消费成拓扑。写进节点提示词只会让模型在画面里念一句“角色要一致”，起不到锚定作用。

两者必须分清，否则实现时容易一刀切掉：

```text
锚点要求（写在 planning_notes 里）        → 规划 LLM 的上下文  ✅ 必须作为规划指令下发
                                         → Recipe Compiler     ✗ 不传，写"角色要一致"只会得到一句话
planning.prompt_guide / conduct_rules    → Recipe Compiler     ✅ 必须传，否则风格与约束进不了提示词
                                         → 规划 LLM 的上下文  ✅ 规划期也要，用于决定阶段与路径
```

真正保证一致性的是参考边确实连上了、`[ref:n=character]` 标对了、排在了首位（§6.1）。参考图的 role 标记与排序由前端在提交时处理，不经 Compiler。

### 6.3 社区 Bundle

当前代码不使用 ZIP、签名包管理器或私有 Marketplace。社区分发使用已经实现的可校验 JSON Bundle：

```json
{
  "schema_version": "dramaclaw.skill-bundle.v1",
  "id": "ecommerce-video",
  "name": "电商产品视频",
  "version": "1.0.0",
  "description": "根据产品素材动态规划并生成电商产品视频。",
  "author": "lywaterman",
  "license": "Apache-2.0",
  "min_dramaclaw_version": "2.0.0",
  "tags": ["ecommerce", "video"],
  "skill": {
    "schema_version": "dramaclaw.workflow-skill.v1",
    "id": "ecommerce-video",
    "name": "电商产品视频",
    "version": "1.0.0",
    "enabled": true,
    "description": "根据产品素材动态规划并生成电商产品视频。",
    "category": "ecommerce",
    "triggers": {
      "keywords": ["电商视频"],
      "node_scopes": ["textGeneration"]
    },
    "input_parameters": [],
    "allowed_recipe_ids": ["product-brief"],
    "planning": {
      "planning_notes": "根据产品素材和用户目标动态规划制作阶段；先绑定产品主体图再进入生成。",
      "prompt_guide": "商业广告质感；准确表达产品事实和卖点；不要字幕。",
      "conduct_rules": ["不得虚构产品能力。", "批量付费生成与最终合成前必须确认。"]
    },
    "evaluation": {
      "rating_bands": [{"score": 5, "description": "产品事实准确且结构完整"}],
      "quality_threshold": 4,
      "domain_constraints": ["不得虚构产品能力"],
      "visual_review_items": [],
      "text_review_items": []
    },
    "workflow_templates": []
  },
  "recipes": [
    {
      "schema_version": "dramaclaw.recipe.v1",
      "id": "product-brief",
      "name": "产品简报",
      "version": "1.0.0",
      "enabled": true,
      "output_kind": "text",
      "action_keys": ["product-brief"],
      "system_prompt": "把用户输入和产品事实整理为结构化产品简报。",
      "must_have_items": ["产品事实", "目标受众", "核心卖点"],
      "planning_prompt": "根据产品素材和用户目标生成产品简报。",
      "result_summary": "结构化产品简报。",
      "requires_source_media": false
    }
  ]
}
```

`dramaclaw-skills` 可以为每个 Skill 保存：

```text
skills/ecommerce-video/
  bundle.json
  README.md
  cover.webp
```

客户端已经能从受信任 GitHub Catalog 下载 `bundle.json`，后端会校验 Skill、Recipe、引用完整性、最低版本和危险内容后再保存。当前实现不执行包内代码，也不安装额外依赖。

`license` 只描述 Bundle 内提示词、说明和示例素材的许可证，不改变 DramaClaw 核心代码的 Elastic-2.0 许可证。

它成立的前提是提交者确实有权按该许可证再授权。如果 Skill 内容改造自其他平台的 Skill，需要先确认来源方允许再分发，否则 `license` 字段只是一句空话，社区仓库会带上来源不明的内容。从自有手工建图经验沉淀的 Skill 没有这个问题，这也是优先用自有素材沉淀标杆 Skill 的一个实际理由。

当前 Runtime 通过单一 `recipe_id` 查找 Recipe，因此社区 Skill ID 和 Recipe ID 先保持全局唯一。CI 和安装接口拒绝不同来源的重复 ID，不能静默覆盖。

### 6.4 规则优先级与模型能力

Skill 与 Recipe 都是 Agent 的约束来源，必须定义稳定的冲突优先级，避免大型 Skill 内部出现“优先长镜头”和“优先短镜头”、或“使用中文提示词”和“始终使用英文提示词”这类互相覆盖的问题：

```text
用户本次明确要求
  > 已确认的 WorkflowPlan.inputs
  > Skill 的安全、品牌和生产强约束（evaluation.domain_constraints + conduct_rules）
  > Skill 的 planning.prompt_guide（风格与提示词写法）
  > Recipe 的单阶段工艺规则
  > 系统默认值
```

这条链**只管提示词层的冲突**。Skill 的 `prompt_guide` 与 `conduct_rules` 必须高于 Recipe 工艺规则，这是“观感由 Skill 控制”成立的必要条件。典型冲突与裁决：

| 冲突 | 裁决 |
| --- | --- |
| Recipe `system_prompt` 写“写实风格”，Skill `prompt_guide` 写“皮克斯3D卡通” | Skill 胜 |
| Recipe 负面词写“禁止卡通”，Skill `prompt_guide` 要求卡通 | Skill 胜，该 Recipe 的负面词被视为工艺默认值 |
| Recipe 硬编码 `16:9`，`confirmed_inputs.aspect_ratio` 是 `9:16` | `confirmed_inputs` 胜（§6.2 已列为回归测试项） |
| Skill `conduct_rules` 含“不要字幕”，Recipe 要求烧字幕 | Skill 胜 |

硬禁项（“绝不出现”）写在 `conduct_rules` 里，它比 `prompt_guide` 的风格倾向更硬，因此排位更高。

**锚点要求不参与这条链**，因为它不是节点提示词的内容。锚点属于拓扑层：它的“执行”是引用边确实连上、role 标记正确、排序正确，发生在规划期而不是编译期（§6.1 的两种实现层）。

社区 Skill 不写真实供应商模型名。当前 2.0 首发只使用现有节点能力、生成模式和系统模型配置，例如视觉理解、多参考图、首尾帧、目标比例和音频生成；实际模型仍由 DramaClaw 的内部模型名和 NewAPI 映射决定。

根据价格、并发和供应商实时状态自动选择上游模型是独立的模型路由能力，DramaClaw 2.0 不实现它，也不能把它伪装成社区 Skill Schema 的既有能力。

#### 模型选择的归属边界

主张四（Skill 不感知供应商）由**两个不同机制**承接，取决于是哪一类模型调用。这两条路必须分清，否则会把媒体模型的选择错误地推给 BrainClaw：

```text
Skill 只声明能力需求，从不写供应商模型名
  │
  ├─ LLM / VLM 调用（规划、Recipe 编译、文本生成、视觉理解）
  │    ↓ NewAPI public model: brainclaw
  │  BrainClaw 按 (task_class, step_role) 选候选 LLM
  │    ↓ NewAPI internal candidate model
  │
  └─ 图片 / 视频 / 音频生成、Embedding、Reranker、TTS、ASR
       ↓ 原 NewAPI channel —— BrainClaw 文档明写这类请求「永不进入 BrainClaw」
     DramaClaw 自己的媒体模型配置层决定后端：
       FREEZONE_DEFAULT_VIDEO_BACKEND / FREEZONE_NEWAPI_VIDEO_BACKENDS
       + GET /projects/{project}/freezone/{video,image}/models 下发候选
       + 节点 model 字段（canvasNodeActionCatalog 的 videoModelSchema / imageModelSchema）
```

**BrainClaw 只管 LLM，不管媒体生成模型。** 因此像 `Seedance 2.0`、`Nano Banana 2`、`720p`、`2K` 这类媒体模型与分辨率的选择，承接者是上面第二条路的媒体模型配置层，不是 BrainClaw。Skill 仍然不写它们——它只声明“需要多参考图”“需要首尾帧”“需要音频生成”这类能力需求，由媒体模型层映射到当前可用后端。

这条边界也决定了两侧的建设分工：LLM 路由不要在 DramaClaw 侧重复建设；媒体模型的能力表、候选下发和默认值则始终是 DramaClaw 自己的职责，不要期待 BrainClaw 接管。

#### 模型特定提示词语法暂不扩张契约

某些视频模型有专用的提示词编码约定，例如用括号标注音乐、尖括号标注音效、花括号标注对白、方括号标注字幕文本。这类东西是**模型的输入格式**，不是创作方法，因此：

- **不进 Skill**——违反主张四，且换模型时所有 Skill 都要改；
- **原则上不进共享 Recipe**——Recipe 是跨 Skill 复用的通用工艺，绑定单一模型语法会降低复用性；
- **当前也不宣称节点提交层能自动转换**——现有 Recipe Compiler 返回普通字符串，没有对白、音效和画面描述的结构化输出契约，提交层无法可靠推断每段语义。

2.0 先让 Recipe 产出模型无关、可直接执行的自然语言提示词。某个后端确实需要专用语法时，由该媒体后端的适配层做有限、明确的转换；只有真实需求证明普通字符串不足时，才引入结构化提示词契约。

#### 模型能力上限由系统声明，不由 Skill 重复声明

单镜头最大时长、单次最多几张参考图、支持不支持首尾帧，都是**模型能力**而非创作选择。Skill 不应写“每个镜头不超过 15 秒”这类数值——换模型时要改所有 Skill。这类上限由媒体模型配置层声明，规划时作为节点能力约束下发给 Hermes（现有 `REFERENCE_CAPS_BY_MODE` 已是这类约束的一个例子）。

注意区分同一句话里常混着的两件事：`单镜头 ≤15s` 是模型上限，属系统；`偏好长镜头内部剪辑而不是切成许多短镜头` 是这个 Skill 的风格倾向，属 `planning.conduct_rules`。这与 §3.2 里“标志性配饰”那个陷阱是同一类错误——一句话里混了两层，迁移时必须拆开。

三条与 BrainClaw 的协同点记录在此，避免以后重复劳动。注意三条都只涉及 LLM 调用：

1. **Recipe Compiler 的多一跳成本由 BrainClaw 级联承接。** 每个节点执行前一次独立编译调用（30 镜头首跑约 30 次冷编译）是分层的固有代价，在 BrainClaw 的分类中属 `prompt_composition`——结构化程度高、输出就是一段提示词、质量下限清楚，是 cheap-first 级联最划算的场景。不要在 DramaClaw 侧为此做特殊优化。
2. **`validate_agent_workflow_plan()` 可作为 BrainClaw 的免费 scorer。** BrainClaw 的级联依赖确定性验证器，而 Plan 校验本来就要跑：便宜模型出一份 Plan → Validator 判结构合法 → 不合法才升级到强模型，零训练数据、契约维度零质量损失。这使我们的 Validator 从单纯的防御机制变成了路由资产。
3. **级联只保证 Plan 跑得起来，不保证 Plan 是个好 Plan。** Validator 只查结构合法性，6 个镜头和 30 个镜头都会通过。创作决策合理性没有确定性验证器，仍然按 §3.1 的判据交给人和单修路线。这条边界要写清楚，否则容易误以为接上 BrainClaw 就解决了拓扑质量问题。

BrainClaw 的具体实现依据见同级仓库 `brainclaw/docs/brainclaw-end-to-end-plan.md`；这里不使用跨仓库相对链接，避免 GitHub 文档链接失效。

### 6.5 从散文式 Skill 迁移过来的映射表

专业作者可能拿其他平台成熟的散文式 Skill 作为起点改造。这是一次**格式迁移加分层重排**，不是复制粘贴——对方是一整段编号散文，我们是按实现层拆开的结构化字段。没有映射表，最常见的失败是把整段 prose 塞进 `planning_notes`，字段等于没填。

以 Flova 的七区块（其官方文档公开的区块划分）为例：

| 来源区块 | 落到哪 | 注意 |
| --- | --- | --- |
| 1 基本信息 | `name` / `description` / `category` / `triggers` | 直接对应 |
| 2 工作流规划（执行顺序、工具调用、步骤依赖） | 全部落到 `planning.planning_notes` 与 `conduct_rules` 的散文里——顺序交给 Agent 理解，不要为它造字段 | **不要**转成 `workflow_templates`，那会退回模板化（§7.3） |
| 3 媒体分析与处理 | 必须锚定的角色与场景、复用与缺失策略 → `planning_notes` / `conduct_rules`；提取工艺 → 通用 `input-analysis` Recipe | 「哪些主体必须跨镜头保持一致」要写成明确的锚点与引用要求，不要只写“保持一致” |
| 4 分镜设计 | 分镜结构与必备项 → 通用 `storyboard` Recipe 的 `must_have_items`；景别/机位/运镜是否必写 → `conduct_rules` | 具体拍几个镜头属主观决策，**不迁移**（§3.1） |
| 5 媒体生成 | 风格锁定 → `planning.prompt_guide`；视觉一致性方法与参考复用要求 → `planning_notes`；画幅/时长 → `input_parameters` | **模型名与分辨率丢弃**——媒体模型由 DramaClaw 媒体模型配置层决定，不是 BrainClaw（§6.4）；厚 Skill 要明确告诉 Agent 如何建立和复用参考拓扑 |
| 6 提示词写法 | 通用 Recipe 的 `system_prompt`；跨阶段的表达倾向 → `planning.prompt_guide` | 不要每个 Skill 复制一份 Recipe，否则重演复用率 0（§2.8） |
| 7 视频剪辑 | **丢弃** | 理由见 §9 |
| 「产出什么 / 最终交付什么」 | `description` 一句话说清即可 | 不为它加字段——漏了合成节点用户一句话就能补（§6.1） |
| 「什么时候问你 / 何时停下来确认」 | `planning.conduct_rules`，并结合现有 `execution_mode=manual/auto` | 用户本轮授权可覆盖默认值。**不要写进 Recipe**——那正是 12/30 份 Recipe 现在的病 |

后两行来自散文式 Skill 常见的收尾小节（例如“产出什么：成片，附脚本和分镜”“什么时候问你：拿不准题材或风格时问一次，其余自己定”）。它们都不需要新字段：交付物写进 `description`，基础 Manual/Auto 走 `input_parameters`，更细的确认原则写进厚 Skill 的 `conduct_rules`。

迁移时按顺序做三次判断，顺序不能颠倒：

1. **可复现还是主观？** 主观的直接丢弃，不进 Skill（§3.1）。
2. **拓扑动作还是节点提示词？** 需要建立参考节点和连线的，写进厚 Skill 的 `planning_notes` / `conduct_rules`，让 Hermes 落成 Graph；画面风格和负面约束进入 Recipe Compiler（§6.1）。
3. **Skill 还是 Recipe？** 换一种风格就要改的进 Skill，任何风格都适用的写法规范留 Recipe（§3.2）。

许可提示见 §6.3：改造他人 Skill 内容再分发前，需确认来源方允许再授权。

## 7. 2.0 的运行规则

### 7.1 用户显式选择 Skill

大多数情况下由用户从 UI 或 `/skill-id` 选择 Skill。已经有 `skill_id` 时，Hermes 直接读取该 Skill，不能再次自动换成另一个 Skill。

用户没有选择时，可以使用现有 `freezone_resolve_catalog_workflow` 推荐；多个候选接近时让用户选择，不自动取第一个。

#### 统一入口问询：一次问完，不要边做边问

Skill 选定后，把所有不确定项**合并成一次问询**再开始执行，不要在生产过程中反复打断。第三方实测显示这个模式在实践中效果很好——Agent 在开工前一次性列出六项待确认（时长偏好、执行模式、画幅、语言与字幕、核心元素、故事大纲来源），用户依次回复后即进入连续执行。

我们的机制已经齐了，只是缺这条约定：`input_parameters` → `freezone_get_workflow_skill().input_contract` → `input_contract.resolved` 本来就是把缺失项一次算出来的（§6.1、§7.2）。因此实现要求是：

- Hermes 应基于 `input_contract.missing_required` 一次性提出全部缺项，而不是发现一项问一项；
- `execution_mode` 也在这一轮确认（对应实测里那项“执行模式”），用户此时的选择覆盖 Skill 声明的默认值（§7.5）；
- 已有默认值且不影响成本与不可逆操作的参数不必问，直接用 `resolved` 里的值并在计划中显示，让用户有机会否决而不是被强制回答。

这条约定的价值是把打断集中在开工前。生产过程中的暂停按 §7.5 的风险驱动确认决定，与入口问询是两件事，不要混。

### 7.2 只加载必要上下文

继续使用当前渐进加载方式：

```text
Skill 列表：只加载 ID、名称、描述和触发词
选定 Skill：freezone_get_workflow_skill(compact=true)
规划阶段：完整 Skill（含 planning_notes 里的锚点要求）+ 白名单 Recipe 摘要
执行节点：该 Recipe 完整 system_prompt + 按节点类型筛选后的 skill_constraints + confirmed_inputs
创建节点：按需读取 node create schema
```

不要把所有 Recipe、所有节点 Schema、全部生成历史或完整画布一次塞给 Hermes。执行节点时也不要传完整 Skill：`prompt_guide` 与 `conduct_rules` 按 §6.2 的节点类型表筛选，其中的锚点与流程类要求完全不进 Compiler 上下文。

### 7.3 动态 Plan 是默认路径

对于新 Workflow Skill：

- Hermes 根据用户目标、`input_contract.resolved`、当前选区、邻居 Graph 和已有素材生成完整 WorkflowPlan；
- 分镜数量、并行分支、起始阶段和依赖关系由本次任务决定；
- Skill 规定生产边界和决策规则，不能把典型阶段误当成必须完整展开的固定模板；
- 已有合格中间素材时允许从中间阶段开始；
- 先完成前置资产决策——按 `planning_notes` 与 `conduct_rules` 描述的原则确认素材、建立参考、判断缺口；
- 用户上传素材按厚 Skill 描述的语义角色绑定为 Graph 输入，复用还是重制、缺失怎么处理由 Hermes 结合 `conduct_rules` 判断；
- Skill 要明确说明哪些主体需要统一参考，以及哪些下游节点应复用它；Hermes 据此生成参考节点与引用边，当前 Validator 只校验通用 Graph 合法性，不理解角色身份语义（§6.1）；
- 模型支持多参考图直接生成视频时可以省略关键帧；需要锁定首帧时再动态加入关键帧节点；
- 缺少必需素材时先创建素材锚点或询问用户；
- 用户确认后只调用一次 `freezone_create_workflow_graph(plan=...)`；
- **布局承载语义**：锚点节点排在上游左侧、分镜与生成节点居中、合成节点在右，让人一眼看出项目进展到哪一步。Graph Builder 已支持批量布局与分组，这是一条零成本的规划约定，不是新机制。同类产品把它作为明确设计原则（角色定义在左、故事板居中、成片在右），因为画布的空间位置本身就是最直观的状态显示。

固定模板仅保留给已有的文生图、图生视频等简单注册工作流和旧 Skill 兼容。模板不是新社区 Skill 的默认执行方式。

**Agent 产出的拓扑是提案，不是决定。** 镜头数量、节奏这类主观决策不由 Skill 规定（§3.1），Agent 只能从目标时长、故事内容和成本约束推出一个起点。这个起点必然需要人调整，收敛机制就是下面的单修路线。因此“Skill 不管镜头数量”不等于“拓扑无人负责”——负责的是人，Agent 负责给出一个合理的起点并在人改完后正确重做下游。

Graph 创建后也不是不可修改的终局计划。Hermes 可以根据实际结果对局部子图增删节点、调整依赖或只重跑失败分支；除非用户明确要求重新规划整体方向，不应因为一个节点失败而推翻完整 Graph。

对现有节点执行局部操作时，Hermes 应先读取节点的 Action Catalog：

- `can_run_now=false` 时，根据 `blocked_reasons` 补齐上游输入或停止；
- 单节点生成、编辑、分析或 UI 操作使用 `freezone_run_node_action`；
- 修改节点参数使用 `freezone_update_node_data`；
- 一个节点失败只重试该节点时使用 `freezone_run_workflow(direction="node")`；
- 从修改点重做后续时使用 `freezone_run_workflow(direction="downstream")`；
- 继续完整工作流时使用 `freezone_run_workflow(direction="connected")` 或 `scope="canvas"`。

### 7.4 Recipe 是严格白名单

目标规则是：只要 Skill 声明 `allowed_recipe_ids`：

- `freezone_get_workflow_skill` 只返回这些 Recipe 的摘要；
- Validator 只允许这些 Recipe；
- 相同 `output_kind` 的其他 Recipe 不能自动加入候选。

这既提高规划稳定性，也构成社区 Skill 的权限边界。

当前代码尚未完全满足这条规则。`_workflow_skill_recipe_candidates()` 会把显式引用的 Recipe 加入候选，也会继续加入相同 `output_kind` 的其他 Recipe。因此规划包和 Validator 使用的“允许集合”仍然偏宽。2.0 必须改为：

```text
allowed_recipe_ids 非空
  → 只允许列表中的 Recipe

旧 Skill 没有 allowed_recipe_ids
  → 才使用模板引用和 output_kind 推断兼容
```

### 7.5 使用风险驱动确认和现有执行器

不新增执行器：

1. Hermes 展示可读计划；
2. 用户确认整体方向和本次执行授权；
3. Graph Builder 一次性创建 Graph；
4. Hermes 根据成本、风险和用户授权决定只落图、执行部分节点或立即执行；
5. Runner 按现有 DAG 规则执行当前允许推进的范围；
6. Recipe Runtime 为各节点编译提示词；
7. Hermes 检查结果并决定继续、局部返工或请求下一次确认；
8. Workflow Run 和生成历史记录结果。

确认不按“每一个阶段都暂停”写死，而按操作风险决定：

- 低成本、可逆的文本分析和规划可以自动执行；
- 用户明确开启 Auto 后，可以自动推进其授权范围内的低风险节点；
- 批量图片或视频生成、替换已有素材、改变品牌或产品外观、最终合成和导出应等待确认；
- 局部失败可以按厚 Skill 的返工原则处理；涉及新的付费生成时仍遵循当前授权与确认规则。

Manual/Auto 不需要设计成新的 Agent 状态机，直接复用当前代码真正支持的 `execution_mode` 和 `recommended_run_after_create`：`manual` 默认只创建并等待确认，`auto` 才建议创建后运行。Auto 只代表用户预先授权的执行范围，不代表 Agent 可以无条件执行所有高成本或不可逆操作。

默认值由 Skill 的 `input_parameters` 里一条 `execution_mode` 声明（§6.1），不新增区块。当前只使用代码已经识别的两个值：

| `execution_mode` | 默认执行行为 |
| --- | --- |
| `manual` | 创建 Graph 后等待用户确认，再按节点或范围推进 |
| `auto` | 建议创建后运行，但仍不得绕过现有高风险操作确认 |

“只在方向选择时问”“按预算自动推进”等更细行为先写在厚 Skill 的 `conduct_rules` 中交给 Hermes 判断，不把尚不存在的预算引擎和检查点协议伪装成枚举能力。用户本轮的显式选择始终高于 Skill 默认值。

当前 `run_after_create=true` 会运行完整选区，不能表达阶段检查点。复杂 Skill 默认使用 `run_after_create=false` 创建完整 Graph；Hermes 在用户确认后调用现有 `freezone_run_workflow`，通过 `node_ids` 和 `direction=node` 分范围推进。未来只有在真实使用证明该方式不足时，才考虑给 WorkflowPlan 增加原生 checkpoint 字段。

当前审批规则本质上仍按命令类型和批量规模判断：`run_workflow`、删除、批量命令和部分外部 MCP 节点动作会触发确认。它还不是一个理解实际积分成本、素材覆盖风险和品牌影响的通用风险引擎。因此“风险驱动确认”是 2.0 要落实到 Skill 执行规则和 Agent 行为中的目标，不应在“当前已经具备”列表里描述成完成状态。

## 8. 基于当前代码的最小改造清单

### 8.1 当前已经完成的基础

- Skill/Recipe 后端 Pydantic Schema；
- 设置页和 Skill 入口的前端 Schema 校验；
- Skill Studio 保留 `schema_version`、`name`、`version`、`allowed_recipe_ids` 和 `input_parameters`；
- 新 Skill 的编写指南和 Agent 创建规则默认使用 `input_parameters + allowed_recipe_ids + planning`；
- `freezone_workflow_plan.v1`、Validator、Graph Builder 和 DAG Runner；
- Recipe Compiler、节点级 Action Catalog 和局部重跑工具；
- Freezone Memory 不覆盖已有 Hermes 学习内容；
- Bundle Schema、危险内容检查、导入、导出、本地安装和社区 Catalog 安装入口；
- 普通用户入口只展示 Skill，Recipe 放在高级管理。

不要把这些内容继续列为待开发 P0。

上面第一条“Skill/Recipe 后端 Pydantic Schema”指的是结构校验机制已经建成。§2.8 暴露的问题不是必须新增字段，而是厚 Skill 中已有的 `planning_notes`、`prompt_guide`、`conduct_rules` 没有完整进入规划和节点执行上下文；本轮优先接通传递路径。

### 8.2 动态主链必须完成的六项

按依赖顺序编号。第 5 项依赖第 3 项先接通 Skill 约束；其余项目可以独立推进。

| 序号 | 内容 | 依赖 | 状态（`671cb07`） |
| --- | --- | --- | --- |
| 1 | 把锚点要求写进规划包与 Agent 规则（零 Schema 改动） | — | ✅ 代码已落地，标杆未测 |
| 2 | 修复 Skill Studio 保存契约 | — | ✅ |
| 3 | 修正 Skill → Recipe Runtime 约束传递 | — | ✅ |
| 4 | Recipe 候选改严格白名单 | — | ⚠️ 改出新的不一致 |
| 5 | 内置 Recipe 收敛为共享工艺集 | 3 | ⚠️ 约三分之一，且执行顺序需纠正 |
| 6 | 默认策略改为动态 WorkflowPlan | — | ✅ 并已演进为 intent → draft |

#### 1. 把锚点要求写进规划包与 Agent 规则（零 Schema 改动）

本项**不改 Schema、不加 Validator 校验**，理由与后续升级条件见 §6.1「为什么暂不加 `asset_policy.anchors` 字段」。要做的是让 Agent 稳定地把锚点落成拓扑：

- `.hermes/plugins/freezone/json_workflow_catalog.py`：规划包里明确下发锚点要求。Skill 的 `planning_notes` / `conduct_rules` 已经写了要求，规划包要把它作为**规划指令**呈现给 Hermes，而不是混在一大段散文里让模型自己挑；
- `.hermes/skills/workflows/SKILL.md`：写明 Agent 生成 Plan 时应主动建立锚点节点并向下游连出引用边，且同一主体在所有相关镜头引用同一个锚点节点；
- `.hermes/skills/freezone/references/skill-studio-authoring-guide.md`：让 Skill Studio 创建 Skill 时把视觉参考的建立、复用和连接方法写进 `planning_notes`；
- `src/novelvideo/chat/service.py`：Agent 编写规则同步，避免三处规则漂移。

必须增加的标杆评测（涉及 Hermes 规划行为，不作为确定性单元测试）：

- 给定一个声明了角色锚点要求的 Skill，生成的 Plan 中存在锚点节点，且每个镜头视频节点都有来自它的引用边；
- 同一主体在多个镜头中引用的是**同一个**锚点节点，而不是各镜头各生成一个。

这些评测的作用是**测量**：它们在三个标杆 Skill 上的通过率就是 §6.1 里那个待测数据——Agent 到底会不会漏引用边。跑完再决定是否需要把它升级成 Schema 字段加 Validator 不变量。

##### 状态：✅ 代码已落地，⚠️ 标杆通过率尚未测量（`671cb07`）

四处规则均已写入：`json_workflow_catalog.py` 的规划包已下发 `asset_anchor_policy`（含 `strategy: generate_anchor_then_continue` 与 `source_anchor_recipe_ids`）；`.hermes/skills/workflows/SKILL.md` 已写明锚点作为首个 PlanItem、后续项通过 `depends_on` 引用同一语义 item id、锚点节点通过 `media_input_for` 连到所有依赖它的节点；`skill-studio-authoring-guide.md` 与 `chat/service.py` 同步。

**但上面那两条标杆评测还没跑。** 规划包里写了指令 ≠ Agent 会照做，而这正是本项要测的东西。在拿到通过率之前：

- §10 的「Skill Schema 零改动」这条验收标准**处于未验证状态**——是否需要补 `asset_policy.anchors` 字段与 Validator 不变量，完全取决于这个数据；
- 不要因为「代码已落地」就把本项当作完全结项。

这是当前唯一一处「机制在、效力未知」的地方，静态检查给不出结论，必须真跑 Hermes。

#### 2. 修复 Skill Studio 保存契约

修改 `frontend/src/features/superchat/superchat-panel.tsx`：

- 不再向 `planning` 写入后端不支持的 `default_aspect_ratios`（当前在 `superchat-panel.tsx:3920`，而 `AgentCatalogPlanning` 只接受 `planning_notes` / `prompt_guide` / `conduct_rules` 且启用 `extra="forbid"`，因此 Skill Studio 存出的 Skill 会被后端直接拒收）；
- 画幅默认值由 `input_parameters` 表达；
- `buildSkillStudioCatalogSaveItems()` 保存前复用 `validateFreezoneAgentConfigPayload()`，不再只检查少量字段；
- 增加“Skill Studio 产物可以被后端 `AgentCatalogSkillConfig` 直接接受”的跨层回归测试。

`default_aspect_ratios` 是当前代码 Bug，应作为独立的小修复优先完成。

##### 状态：✅ 已完成（`671cb07`）

`default_aspect_ratios` 在 Skill Studio 与后端 Schema 中均已不存在；`superchat-panel.tsx:4748` 已复用 `validateFreezoneAgentConfigPayload()`，与设置页（`freezone-skill-recipe-settings.tsx`）走同一套前端校验。

#### 3. 修正 Skill → Recipe Runtime 约束传递

这一项是“观感由 Skill 控制”能否成立的开关，缺口成因与后果见 §6.2。它消费的是现有 `planning` 字段，不依赖新增字段或第 1 项。

修改：

- `frontend/src/features/canvas/application/workflowRecipeRuntime.ts`；
- Recipe 编译 API 请求/响应模型；
- `src/novelvideo/freezone/recipe_runtime.py`；
- 图片、视频、音频和文本节点的 Recipe 编译入口。

最小运行上下文为：

```text
skill_id + resolved_skill_version
confirmed_inputs
skill_constraints
recipe_id + recipe_version
node_intent
upstream_text
reference_media
```

实现规则：

- Graph 节点先保存 `skillId` 和本次 `confirmedInputs`；完成 8.3 的追溯项后再同时保存 `skillVersion`；
- 后端根据 `skillId` 读取有效 Skill 及其当前版本，按 §6.2 的节点类型表提取相关的 `prompt_guide`、`conduct_rules` 和 `domain_constraints`，不信任客户端自行提交完整 Skill；
- 锚点与流程类要求不进 Compiler 上下文，它们由 Hermes 在规划期消费；
- 删除 `recipe_runtime.py` 系统提示第 33 行的 `Follow the Recipe instructions as the highest-priority creative method`，改为“用户要求 > 已确认输入 > Skill 强约束 > Recipe 工艺 > 默认值”（与 §6.4 一致）；
- 不把完整 Graph、无关 Skill 内容或其他 Recipe 的完整提示词塞入上下文；
- 缓存键覆盖 Skill 版本、确认输入和实际传入约束，避免规则变化后复用旧提示词；
- 为语言、画幅、品牌事实和 Recipe 指令冲突增加回归测试，其中必须包含一条：**Recipe 的 `system_prompt` 与 `confirmed_inputs` 的画幅冲突时，以 `confirmed_inputs` 为准。**

##### 状态：✅ 已完成（`671cb07`）

`recipe_runtime.py` 已把 `confirmed_inputs` 与 `skill_constraints` 贯穿到编译入口（`_skill_constraints()` 由后端按 `skillId` 自行提取，不信任客户端提交的完整 Skill），并各自设了字符上限。

第 33 行那句 `Follow the Recipe instructions as the highest-priority creative method` 已删除，改为与 §6.4 一致的优先级链：

```text
1. Resolve conflicts in this order: explicit user goal, confirmed inputs, Skill hard constraints,
   Skill prompt guide, Recipe method, then defaults.
2. Recipe instructions are a reusable production method, not permission to override higher-priority
   user choices or Skill constraints.
```

**这一项是 §2.8 那个「运行时伪 Project Spec」问题的根治**：`Final_Video_Spec` 依赖已从 17/30 降到 0，作者不再需要用文本节点手工模拟约束传递。

#### 4. 把 Recipe 候选改为严格白名单

修改 `.hermes/plugins/freezone/json_workflow_catalog.py`。当前 `_workflow_skill_recipe_candidates()`（约 1639 行）的准入条件是 `explicitly_referenced or not output_kinds or output_kind in output_kinds`，因此只要 `output_kind` 对得上就会进入候选，`allowed_recipe_ids` 实际上不是白名单。改为：

- `allowed_recipe_ids` 非空时，规划包和 Validator 只允许明确列出的 Recipe；
- 列表中的 Recipe 缺失或禁用时返回清晰错误，不能退化成同 `output_kind` 的其他 Recipe；
- 只有旧 Skill 没有 `allowed_recipe_ids` 时，才保留模板引用和 `output_kind` 推断；
- `freezone_get_workflow_skill()` 和 `validate_agent_workflow_plan()` 必须复用同一个候选计算结果；
- 增加“同输出类型但未在白名单中的 Recipe 被拒绝”的回归测试。

##### 状态：⚠️ 改了一轮，但引入了新的不一致（`671cb07`）

`output_kind` 兜底部分**已修对**——`_workflow_skill_recipe_candidates()`（现 `json_workflow_catalog.py:1982`）加了 `not references` 前置，只有旧 Skill 才退化推断，符合上面第 3 条。

但同时新增了一个**上面没有设计过**的分支，且它是无条件的：

```python
explicitly_referenced
or recipe_id in general_recipe_ids      # ← 新增，references 非空时也放行
or (not references and (not output_kinds or output_kind in output_kinds))
```

结果是同一个「allowed」概念现在有三处计算、两种语义：

| 位置 | 语义 | 是否放行 `general-*` |
| --- | --- | --- |
| `json_workflow_catalog.py:1982` `_workflow_skill_recipe_candidates()` | 候选集 | **是** |
| `json_workflow_catalog.py:951` `_compile_dynamic_recipe_items_intent()` | 原始 `allowed_recipe_ids` | 否 |
| `workflow_plan.py:462` `_validate_node_catalog_refs()` | 原始 `allowed_recipe_ids` | 否 |

6 个内置 Skill 的 `allowed_recipe_ids` **无一包含 `general-*`**。因此规划包会把 `general-image` 等 4 份作为候选交给 Agent，Agent 一旦选用，下游两条路径都会拒收：

```text
Recipe general-image is not allowed by Skill <skill_id>
```

这正是上面第 4 条要防的情况。

**建议做法**：删掉候选函数里 `or recipe_id in general_recipe_ids` 这一个分支。旧 Skill（无 `allowed_recipe_ids`）仍可通过第三个分支按 `output_kind` 拿到 `general-*`，不受影响；新 Skill 则恢复严格。如果确实希望 `general-*` 永远可用，就必须把它写进各 Skill 的 `allowed_recipe_ids` 并在本节补上这条设计，**不能只在候选侧开口子**。

回归测试同时覆盖：同输出类型但未在白名单中的 Recipe 被拒绝；候选集与两处校验对同一个 Skill 给出一致的准入结论。

#### 5. 内置 Recipe 收敛为共享工艺集

第 3 项完成后再做：Skill 约束必须先能传到节点执行层，才谈得上把重复规则从 Recipe 移走。

**先立一条前提，否则这一项极易做反：收敛的对象是重复，不是厚度。**

厚 Skill 是被验证过的优秀 Agent 设计范式——竞品那些真实 Skill 之所以能让 Agent 拍出像样的片子，正因为它们写得足够厚：电影化提示词的多条规则、镜头写作顺序、首尾帧各自的写法、锚点如何钉住、并行分批策略，一条不缺。**厚本身是对的，问题只在于同样的厚度被每个 Skill 各写一遍。**

收敛后的共享 Recipe **可以而且应该足够厚**：它们要吸收五种内置风格里共通的工艺精华，再加上公开可参考的工艺原则。目标不是变薄，而是让同一条工艺只有一个维护位置。

正确的形态是：

```text
收敛前  30 份 × 各自偏薄且互相重复
收敛后  约 10–15 份共享工艺 Recipe      数量由真实工艺边界决定
```

判断标准不是字节数变小，而是**同一条工艺在整个 Catalog 里只出现一次**。

按 §2.8 的统计，30 份 Recipe 去重后是 15 种工艺，其中 3 种只是同一工艺换了名字。收敛动作：

```text
删除  *-video-spec ×4        → 不再把运行时规格伪装成一种创作 Recipe；
                               confirmed_inputs 直接进入 Plan 与 Recipe Runtime
合并  script-outline / story-script / story-outline   → 剧本大纲 ×1
合并  storyboard / shot-list / storyboard-sketch      → 分镜 ×1（image 变体保留为独立 Recipe）
合并  audio-layers / bgm                             → 音频层 ×1
泛化  shot-video ×5、key-elements ×4、character-design、prop-anchor、compose-plan、input-analysis
                               → 各 ×1。风格差异上移到各 Skill 的 prompt_guide；
                               五份里的工艺精华要合并进那一份，不是留一份丢四份
```

同时清理已有违规内容（§6.2）：

- **12 份 Recipe 里的阶段推进指令（“确认后进入【某】阶段”）要有去处，不是简单删掉。** 阶段顺序和暂停原则上移到厚 Skill 的 `planning.conduct_rules`，基础自动运行只使用现有 `manual/auto`。删掉而不给去处，作者下次会写回 Recipe；
- 移除 7 份里的硬编码分辨率、3 份里的硬编码画幅——改为消费 `confirmed_inputs`；
- 移除对 `Final_Video_Spec` 的 prose 读取约定，改为消费第 3 项传入的 `skill_constraints`；
- **4 份里那种“角色造型必须一致”的空话删掉，改写成 Skill 的锚点要求。** 光在 Recipe 里说“保持一致”没有效力；有效的写法是在 Skill 的 `planning_notes` 里要求建立锚点节点并连到每个相关镜头，由 Agent 落成拓扑（§6.1）。

5 个内置 Skill 的 `allowed_recipe_ids` 随之改为指向通用 Recipe。

撰写共享 Recipe 时，**Flova 公开的工艺原则是可用的参考输入**（§5.1 是参考对象而非竞品）：电影化提示词的若干条规则、视频提示词的镜头→主体→空间→音频顺序、首帧/尾帧/高光帧各自的写法、清洁产出约束。这些恰好都是与题材风格无关的通用工艺。

两条边界要同时守住：

- **参考工艺原则不等于复制 Skill 文本再分发。** 前者是正常专业实践，后者涉及来源授权（§6.3）。通用 Recipe 应当是我们自己组织的工艺规范，而不是他人 Skill 的搬运；
- **不要把模型特定语法写进来**（§6.4）。参考其“先写镜头再写主体”的顺序原则可以，不要让共享 Recipe 与某个供应商永久绑定。

LibTV 的 Skill 内容不在参考范围内：它闭源，其 100 多个 Skill 对本项工作没有可借鉴的工艺价值（§5.3）。

**验收指标不是文件数量，而是：新增一个 Skill 需要新增几份 Recipe。当前是 5~7 份；新增的只是风格或题材时，目标是 0 份，只有出现真正的新工艺才新增 Recipe。** 作者的主要工作应是写好厚 Skill，而不是复制一套 Recipe。

##### 状态与执行顺序纠正（`671cb07`）——**动手前必读**

已完成的部分是实打实的：`*-video-spec` 在所有 Skill 上删干净了（`Final_Video_Spec` 依赖 17 → 0），阶段推进指令 12 → 3，跨 Skill 复用 0 → 4。

但**收敛只做了约三分之一，而且执行方式走反了一步**：

| Skill | 共用 | 独占 | 实际发生的动作 |
| --- | --- | --- | --- |
| `lego-minifigure-animation-video` | 4 | 1 | ✅ 迁移到共享集（`97207105`） |
| `pixar-ip-ad-video` | 3 | 2 | ✅ 迁移到共享集（`bc612bce`） |
| `retro-hong-kong-kungfu-comedy-video` | 2 | 3 | 🔸 部分迁移 + 去 IP 品牌化改名（`18207244`） |
| `japanese-anime-drama-video` | 1 | 4 | 🔸 **仅改名** `jp-anime-drama-*` → `dialogue-drama-*`（`0dbd2769`） |
| `outdoor-stage-duel-video` | 0 | 4 | ❌ 仅删 `video-spec`（`6fb6e2c4`） |
| `ling-cage-cinematic-video` | 0 | 5 | ❌ **仅改名** `ling-cage-*` → `sci-fi-survival-*`（`ce9f456d`） |

去 IP 品牌化本身有价值（社区分发的 Catalog 不该带他人 IP 名，见 §6.3），但**改名不是收敛**。

**关键问题：共享集是「乐高形状」的。** `97207105` 做的是「7 份 `lego-minifig-*` 删除 → 6 份泛化重命名」，即单个 Skill 脱掉风格换通用名，**从未吸收过其他四家的工艺**。后果是共享版比未迁移的私有版还薄：

| Recipe | `system_prompt` 长度 |
| --- | --- |
| `storyboard-shot-video`（共享） | 811 |
| `sci-fi-survival-shot-video`（未迁移） | 831 |
| `outdoor-stage-duel-shot-video`（未迁移） | 1665 |

`sci-fi-survival-shot-video` 里这些是**与风格无关、任何影视 Skill 都该有、而共享版目前没有**的通用工艺：

- 背对镜头写法：`character seen from behind, back to camera, rear view, facing away from lens` + 必须描述背部装备/发型 + `no turning around` 锁定；
- 战斗写法：wind-up、follow-through、命中反馈、微震 0.1–0.3s、伤害连续、环境互动；
- 情绪写法：Cause → 面部肌肉 → 身体动作 → 语气；
- `generate a single continuous scene, forbid grid/split-screen layouts`；
- 结构顺序 `Camera → Subject → Space → Audio → Style → Negatives`——**正是本节上文点名要从 Flova 吸收的「镜头→主体→空间→音频」顺序**，而共享版目前是主体在前、运镜排第 5。

**所以直接让剩余 Skill 指向当前共享集，是工艺倒退**，正是本节反复强调的「留一份丢四份」。

**执行顺序必须是：**

```text
第一步  先加厚共享集——把未迁移 Skill 里的通用工艺提炼进去
第二步  再让 Skill 指过去——各自身份进 planning.prompt_guide
```

第二步的归属判断按 §3.2 的切分线，注意两类内容处理方式相反：

- `sci-fi-survival-shot-video` 的上述条目是**通用工艺，要合并进共享 Recipe**；
- `outdoor-stage-duel-shot-video` 的 1665 字里绝大部分（`First-person audience POV from inside the crowd`、五段 Beat 结构、整个 Avoid block）是**该 Skill 的身份，要上移 `planning.prompt_guide`，绝不能合进共享 Recipe**，否则污染共享集。它还硬编码了「每条 15 秒视频对应 1 个 shot」，属本节要清理的违规项。

**另需回头核对**：`lego` 与 `pixar` 迁移时是否也丢过工艺——对一遍 `97207105` 与 `bc612bce` 的删除内容。尚未逐份比对。

#### 6. 把默认策略改为动态 WorkflowPlan

主要修改 `.hermes/skills/workflows/SKILL.md`。该文件当前第 15 行仍写着“读取 Skill 规划包后，优先让 Catalog 工具展开模板。拓扑不变时，Agent 只决定数量及简短 `items`”，与动态优先的方向相反。改为：

- 删除“优先展开模板，拓扑变化时才动态规划”；
- 用户选择的新 Skill 有 `allowed_recipe_ids` 时，默认生成完整 `freezone_workflow_plan.v1`；
- 节点数量、阶段、依赖、并行关系和是否加入关键帧由本次目标、素材和输入决定；
- `conduct_rules` 里描述的前置资产决策按顺序消费，**不得**展开成固定节点序列；
- 只有用户明确选择固定模板，或旧 Skill 只有 `workflow_templates` 时，才使用 Catalog 模板展开；
- ~~继续一次调用 `freezone_create_workflow_graph(plan=...)`，不逐节点创建，也不增加 Plan Schema。~~ 见下方状态说明，这条已被更好的方案取代。

##### 状态：✅ 已完成，且主路径已演进（`671cb07`）

`SKILL.md` 第 15 行那段“优先展开模板”已删除，默认策略确为 Skill 驱动的动态规划。

但实现方式比本项原先设想的更进一步：**不再让 Agent 直接产出完整 Plan**，而是产出精简 `freezone_workflow_intent.v1`，由工具确定性编译：

```text
freezone_prepare_workflow_draft(intent=...)  →  patch  →  confirm
```

Agent 只决定用户目标、结构化输入、PlanItems、每项的 Recipe、输入依赖、是否生成锚点、是否自动执行；节点数据、稳定 ID、连线类型、分组、布局与成片合成由工具完成。`freezone_create_workflow_graph(plan=...)` 降级为兼容入口，`freezone_build_workflow_plan` 被明令禁止调用。

**这个方向与主张二一致且更强**（模型可写错的面更小），完整说明见 §3.3。**接手时不要再按 `plan=` 那条路径动手，它已不是主路径。**

`.hermes/skills/freezone/references/skill-studio-authoring-guide.md` 和 `src/novelvideo/chat/service.py` 已经写明新 Skill 默认动态，不需要再次重做，只需增加契约测试防止三处规则漂移。

##### 从画布沉淀 Skill 时提取方法，不快照拓扑

`_handle_summarize_canvas()`（`.hermes/plugins/freezone/__init__.py:1512`）支持从当前画布或选中流程总结 Skill。这条路径需要明确提取规则，否则容易把一次任务的结果当成方法存下来。

判据与 §7.3 一致：**同一个 Skill 面对不同输入必须能生成不同 Graph**——用户选 15 秒和选 60 秒，镜头数量、并行分支、是否加关键帧都应随之变化。因此从一个 6 镜头画布沉淀出的 Skill 不能带走“6 个镜头”这件事，否则下次不论目标时长多少都展开成同样拓扑。

沉淀时按下表提取：

| 画布上的东西 | 沉淀时怎么处理 |
| --- | --- |
| 节点数量、连线、分组、坐标 | **丢弃**。它们是这一次任务的结果，不是方法 |
| 反复出现的风格描述 | 提炼进 `planning.prompt_guide` |
| 全局排斥项（如禁字幕） | 提炼进 `planning.conduct_rules` |
| 被多个下游引用的锚点节点及其引用关系 | 提炼成 `planning_notes` 里的锚点要求，写明该锚点要连到哪些节点类型 |
| 生成前必须先就位的判断顺序 | 写进 `planning.planning_notes` 的散文 |
| 实际用到的 Recipe | 汇总进 `allowed_recipe_ids` |
| 具体镜头数量、单镜时长、每个镜头的提示词 | **丢弃**。属主观决策（§3.1），不进 Skill |
| 模型名与分辨率 | **丢弃**（主张四、§6.4） |

一句话判据：**沉淀的是“这类作品该怎么做”，不是“这一次做成了什么样”。** 因此 Agent 在总结画布时应当主动询问哪些特征属于长期方法、哪些只是本次选择，而不是把画布状态整体序列化。相应的规则要同步写进 `skill-studio-authoring-guide.md`，并增加一条回归测试：从同一画布沉淀出的 Skill，不得包含节点数量或拓扑信息。

### 8.3 正式发布 2.0 前的收尾项

这些不阻塞动态主链开发，但应在发布前完成：

1. ✅ **已完成**（`671cb07`）。在新动态 Plan 的 `workflowCatalog` 中保存 `skillVersion`，Validator 校验其与当前 Skill 一致；旧 Graph 缺失时继续兼容。实现见 `workflow_plan.py:442-448`，`if requested_skill_version` 前置即旧 Graph 兼容分支。
2. ❌ **未开始**。让 `.hermes-version` 成为唯一 Hermes 版本来源，移除 `hermes_pool.py` 中独立的 `0.18.0` fallback。复核时 `.hermes-version` 已是 `0.19.0`，而 `hermes_pool.py:50` 的 `DEFAULT_HERMES_VERSION = "0.18.0"` 原样未动，漂移风险仍在。
3. 🔸 **bug 部分已解，升版待定**。~~解决 Bundle 默认最低版本为 `2.0.0`、当前包仍为 `1.1.2` 时导出自校验失败的问题~~——导出默认值已改为 `current_dramaclaw_version()`（`agent_bundle_store.py:86`），自校验不再可能自相矛盾（详见 §2.7）。将包版本（现 `1.1.5`）提升到 `2.0.0` 现在只是发布节奏决策。
4. ❌ **未开始**。对 ACP、Memory、Session 恢复、动态 Plan、Recipe Runtime 和 Bundle 做一次发布契约测试。
5. 建立标杆用例集，验证范围严格限定在下面第二段。

   **已由手工建图的生产使用验证，本次不重复测**：节点执行、DAG 并行与上游失败阻断、局部重跑、生成历史、合成导出、Recipe Compiler 产出可用提示词、大图规模。这条产线在 Agent 接管建图之前已经用于制作真实剧集，重测这些属于浪费。

   **本次唯一需要验证的是把人从建图环节移出后，Agent 能否接住那些可复现的判断。** 手工建图时人就是 Skill——人选 Recipe、人保证观感一致、人判断素材够不够。六项要补的正是人退出后空出来的位置，所以标杆用例只测这个位置。

   每个标杆 Skill（漫剧、产品广告、电商图）配一组固定输入（素材 + 目标 + 期望特征），改 Skill 后重跑比对。断言范围：

   - `planning.prompt_guide` 的风格锁定是否真的进入了节点提示词并生效；
   - 厚 Skill 要求统一视觉参考时，Agent 是否创建或复用同一个参考节点，并把它连接到相关下游；
   - `conduct_rules` 里的硬禁项（如不要字幕）是否被遵守；
   - 已有合格素材是否被复用，而不是被重新生成；
   - Plan 是否结构合法且能完整跑通、单节点失败后能局部返工；
   - 同一 Skill 喂三组不同素材与目标时，拓扑是否随之变化（而不是每次展开成同一张图）。

   **不断言镜头数量应该是多少、节奏应该多快。** 那些是主观决策，不属于 Skill 也不属于回归测试（§3.1），验证方式是人看一眼再走单修路线。把主观判断写进断言会让这套用例变成审美投票，失去回归价值。

   这套用例集里**涉及 LLM 调用的那部分**（Plan 生成、Recipe 编译）同时可作为 BrainClaw 需要的 DramaClaw 垂直离线评测资产（§6.4），一份投入服务两个项目。媒体生成部分不属于 BrainClaw 范围。手工建图阶段产出的真实剧集素材和成片就是现成基准。

   音色身份不纳入本轮标杆断言；当前画布音频引用主要用于配乐参考，等 voice identity / voice clone 链路完成后单独设计验收。
6. ❌ **未开始**。处理视频合成的两个假功能。`buildComposePayload()` 会发送 `speed` 和 `coverUrl`（`timelineModel.ts` 已在注释里标注 ⚠️），但后端合成链路中搜不到这两个字段：`_render_video_clip()` 不接受倍速参数，`run_freezone_video_compose()` 也不处理封面。因此时间线上的变速在导出时被静默丢弃，封面不会烧进 MP4。发布前二选一：补齐后端，或在 UI 上移除这两个入口。不允许保留“设置了但无效”的状态。

   复核（`671cb07`）：文件已从 `domain/timelineModel.ts` 移到 `frontend/src/features/canvas/compose/timelineModel.ts:241`，内容未变，两处 ⚠️ 注释仍在，后端仍搜不到 `cover_url`。

   **这是当前唯一一条用户已经能碰到、且明确表现为「设置了却无效」的问题，且与 Skill/Recipe 主线完全无关。** 它容易被主线进度掩盖——建议不要排在收尾项里等发布，而是与其他小修一起尽早清掉。

### 8.4 P1：2.0 后按真实需求迭代

- 从结构化 JSON 渲染可读的 Skill 文档页；
- 从 Skill Studio 直接生成 GitHub PR；
- 根据用户选中的优秀版本，生成 Skill/Recipe 改进建议；
- 让 `evaluation` 真正触发自动审核和局部返工；
- 为 Bundle 增加升级、回滚和来源展示；
- 如果生成历史的历史版本回选（`NodeGenerationHistory.tsx`）在多版本并列比较场景下不够用，再补 `selected_version_id`。

这些都不能反向阻塞动态 Skill 主链。

#### 合成层：下一个版本补齐

2.0 主线不做合成层（§9 给了理由：转场在执行层不存在，且剪辑是成熟工具已解决的领域）。但 §5.3 的对照显示这是当前最明确的功能短板，因此把靶子写清楚，避免“后期再补”变成没有目标：

1. **让合成层支持视频片段时间重叠**——这是转场与画中画的前置条件。当前 `run_freezone_video_compose()` 直接拒绝重叠（`overlapping video clips are not supported in MVP compose`），前端也据此拦截导出；
2. **转场**——重叠能力就位后才有意义；
3. **字幕轨与文字层**；
4. **自动字幕 + 音画同步**，目标覆盖 5 分钟量级成片；
5. **补齐或移除 `speed` 与 `coverUrl`**（§8.3 第 6 项已列为发布收尾，不要拖到这一版）。

只有第 1 项完成后，才需要重新评估 §9 中“不在 Skill 里声明转场与剪辑节奏”这条决定——在那之前该决定继续有效，因为字段仍然无处生效。

原先列在这里的“Agent 消息级恢复”已移除，不再作为待办。理由是需求本身已被现有能力覆盖（§2.5）：探索另一条创作方向用框选子图 + 创建副本，同画布并排对比且逐节点一致；比较同一步骤的不同产出用节点级历史版本回选。项目级时光恢复是工作流不可见的产品才需要的代偿手段（§5.1），在 Graph 即真相源的架构下反而比子图复制更弱——它无法并排对比，也无法只改一个参数而保持其余完全一致。

## 9. 明确不做

- 不自建 Agent Runtime，继续依赖 Hermes；
- 不自建 Memory 系统，继续依赖 Hermes Memory；
- 不为了“专家团”默认拉起多个 Agent；
- 不增加 CreativePlan、Skill Session 或第二个 WorkflowPlan；
- 不增加独立 Project Spec Schema——本轮 Skill Schema 零改动，相关内容由 `planning` 已有字段与 `input_parameters` 承载，判据见 §4.1 与 §6.1；
- 不在 Skill 里声明转场、剪辑节奏或淡入淡出——两条自有理由：合成层 `run_freezone_video_compose()` 拒绝时间上重叠的视频片段，转场在执行层不存在，字段写了也无处生效；且剪辑合成是成熟工具已解决的领域，不是本项目的差异化方向（主张一：Graph 是创作真相源，合成层是它的下游消费者）。合成层具备重叠能力后再评估；
- 不在引擎里做“导演水平评估”——观感属于 Skill 内容，由 `planning.prompt_guide` 声明并经 §8.2 第 3 项传达到每个节点；引擎负责让约束可靠抵达，不负责给作品打分；
- 不在 Skill 里硬编码阶段暂停点。竞品样本把“每个关键阶段都停下确认”写进 Skill，我们按 §7.5 的风险驱动确认决定何时暂停——低成本可逆的文本规划自动推进，批量付费生成与不可逆操作才等确认。机械地每阶段暂停在成本可控时是体验负担；
- 不把模型特定的提示词语法写进 Skill 或 Recipe（§6.4），也不把模型能力上限写进 Skill；
- 不复制竞品的卡片式交互协议（多轮卡片收集需求、固定的确认选项）——那是它的 UI 层设计，我们有自己的确认机制和 Skill Studio 提问流程；
- 不发布 OpenClaw 式的遥控客户端包让外部 Agent 驱动我们的服务（§5.3）——那会把外部 Agent 降为搬运工、把创作决策收回服务端，与主张一和主张三直接冲突。我们的分发单位是 Skill Bundle，即创作方法本体；
- 不重写 Graph Builder 或 Canvas Runner；
- 不复制一套 Storyboard、Asset 或 Timeline 数据；
- 不要求普通用户理解和选择 Recipe；
- 不把固定工作流模板数量当作生态壁垒；
- 不让社区 Skill 携带可执行代码；
- 不把真实供应商 API model name 固化进社区 Skill。

## 10. 2.0 验收标准

> **复核提示（`671cb07`）**：下列条目当前**只经过静态走查，未跑标杆评测**。走查能确认的是「机制是否存在、代码是否接通」；**不能**确认「Agent 是否真的照做」。
>
> 因此以下几条处于**未验证**状态，必须跑完 §8.3 第 5 项的标杆用例集才能勾选——它们全都断言 Agent 的实际行为，而非代码结构：
>
> - Agent 能按厚 Skill 声明的视觉参考方法稳定落成拓扑（参考节点存在、相关镜头复用同一参考）；
> - `execution_mode` 真的影响执行行为，且用户本轮选择高于 Skill 默认值；
> - 同一 Skill 面对不同分镜数量 / 不同素材与目标能生成不同 Graph（选 15 秒与选 60 秒的拓扑差异）；
> - 已有素材时能跳过不必要阶段、已有资产不会被默认重新生成；
> - `planning.prompt_guide` 与 `conduct_rules` 的约束在冲突时确实按 §6.4 优先级胜出。
>
> 其中第一条直接决定「Skill Schema 零改动」这条标准能否成立（见 §8.2 第 1 项状态说明）。**在拿到标杆数据前，不要宣布 2.0 验收通过。**

完成时必须满足：

- 用户可以自然语言创建不含固定模板的 Skill；
- 用户可以从当前画布总结 Skill；
- Skill 保存后立即出现在选择入口；
- 同一 Skill 面对不同分镜数量能生成不同 Graph；
- 已有素材时能跳过不必要阶段；
- 用户上传素材能按语义角色绑定到对应节点，已有资产不会被默认重新生成；
- 模型能力不同时，同一 Skill 能动态加入或省略关键帧等可选阶段；
- Agent 只能使用 Skill 白名单内的 Recipe；
- Skill 输入通过现有 Input Contract 解析和确认；
- 已确认输入可以在 Graph 中以创作规格节点或确认卡查看；
- 用户确认后一次性创建 Graph，不逐节点写入；
- 复杂 Graph 可以按风险和用户授权分范围执行，不强制一次跑完，也不机械地每阶段暂停；
- 现有 DAG Runner 能执行动态创建的 Graph；
- 节点能够通过当前 Recipe Runtime 生成实际提示词；
- Recipe Runtime 能接收当前节点相关的 Skill 强约束和已确认输入，Recipe 不会覆盖更高优先级规则；
- 单个节点失败后可以局部返工，不重建无关分支；
- Agent 执行现有节点动作前会读取该节点的 Action Catalog，并拒绝绕过未满足的前置条件；
- 社区 Skill 只声明能力需求，不固化真实供应商模型名；
- Graph 中能追溯 Skill/Recipe 版本；
- Hermes Memory 不会被 DramaClaw 初始化逻辑覆盖；
- Skill 和依赖 Recipes 能作为一个 Bundle 导入导出；
- 无效、缺依赖或越权 Bundle 会在保存前整体拒绝；
- 普通用户只需要理解 Skill，不需要管理 Recipe；
- **Skill Schema 零改动**：本轮没有新增任何字段，创作方法、交付物、基础执行选择分别由 `planning` / `description` / `input_parameters.execution_mode` 承载（§6.1）；
- Agent 能按厚 Skill 声明的视觉参考方法稳定落成拓扑——参考节点存在、相关镜头复用同一参考。三个标杆上的通过率用于决定以后是否需要增加 Validator 领域校验（§8.2 第 1 项）；
- `input_parameters` 里的 `execution_mode` 真的影响执行行为，且用户本轮选择高于 Skill 声明的默认值；
- 迁移后 Recipe 的 `system_prompt` 里不再出现任何阶段推进指令，该职责回到 `conduct_rules` 与 `execution_mode`；
- **新增的只是风格或题材时，不需要新增 Recipe；只有出现新工艺时才新增**（§8.2 第 5 项的核心指标）；
- **提示词层**：`planning.prompt_guide` 与 `conduct_rules` 在节点执行时确实进入 Recipe Compiler 上下文，且与 Recipe 的 `system_prompt` 冲突时按 §6.4 的优先级胜出；
- **拓扑层**：厚 Skill 的视觉参考方法被规划包清晰呈现，Agent 能主动创建或复用参考节点并连到相关下游；Validator 继续只检查通用 Graph 合法性；
- `preparation_steps` / `deliverables` / `confirmation_policy` 这类字段**没有**被加进 Schema——相应意图由 `planning` 已有字段和 `input_parameters` 承载（§6.1）；
- 已确认规格保存在 `WorkflowPlan.inputs` 并进入 Recipe Runtime，不再依赖 `*-video-spec` Recipe 或运行时规格文本节点；
- 同一 Skill 在素材与目标不同时生成不同拓扑——选 15 秒和选 60 秒的镜头数量、并行分支、是否加关键帧都随之变化。

## 11. 最终判断

§1.1 的五条主张里，四条已有代码实证，一条待兑现。2.0 要做的就是把那一条补上。

**已成立的四条**：Graph 是可复制、可局部重跑的创作真相源；WorkflowPlan 是可校验可审批的一等公民；模型能力由系统声明；Agent Runtime 依赖 Hermes。这四条不需要新工程，只需要在后续开发中不被破坏。

**待兑现的一条是主张三**——Skill 声明观感与边界、Recipe 提供可复用工艺。§2.8 的实测说明它今天不成立，而且原因很具体：**分层的方向对，切分线画错了。** 观感、流程顺序和资产决策被切进了 Recipe，于是 30 份 Recipe、0 份共用，同一批约束被 7~14 份各自重写，改一条要改十几个文件。Recipe 层现在是维护负债而不是复用资产。

兑现条件是两件事同时完成，缺一不可：§8.2 第 3 项的约束传递（让 Skill 里已写好的提示词真正到达执行层）、§8.2 第 5 项的工艺收敛（把重复的厚度换成共享的厚度）。两者缺一，Recipe 层就只是把重复从 5 个 Skill 挪到 30 个文件。

**为什么值得为这一条投入**：§5.3 记录了一个真实作者的困境——他把自己的分镜方法公开成了“一套分镜 Skill”，于是在使用平台导演美学 Skill 时只能二选一。在没有工艺复用层的架构里，通用工艺与观感被迫塞进同一个单元，任何组合都要复制整份再改。分镜表的列结构、锚点清单的组织方式、三视图生成方法、并行分批策略、叙事节拍提取——这些与题材风格完全无关的工艺，每个 Skill 都得重写一遍。

这就是 Recipe 层要解决的问题，也是它兑现后最直接的收益：**作者写好自己的厚 Skill，通用工艺来自共享库。** 对社区生态而言，这决定了新 Skill 的门槛是“抄五到七份 Recipe 再逐份改措辞”，还是“写清风格、素材策略、判断方法和质量标准”。

由此得出的因果链是 2.0 的核心判断：

```text
Skill Schema 缺观感 / 资产 / 负面约束字段
  → 作者用 video-spec 文本节点在运行时手工模拟（17/30 依赖它）
  → 观感被写死进每个 Skill 私有的 Recipe
  → Recipe 复用率 0，写一种新风格要抄 5~7 份 Recipe
  → 社区生态起不来
```

因此 2.0 的胜负点不是实现更多名词，也不是补齐某个竞品的功能表，而是两件事：把切错的那一层字段归位，然后把这条链路真正打通——用户选 Skill，Hermes 根据当前任务动态规划出一份可校验的 Graph，Skill 的观感与强约束真正抵达每个节点的提示词，现有执行器可靠完成生成，失败只重跑那一个节点，用户再从优秀结果中沉淀和分享新的 Skill。

判断是否达成，只看两个可验证的数字，不看架构图：

1. 新增一个 Skill 需要新增几份 Recipe——当前 5~7 份，目标 0 份；
2. 漫剧、产品广告、电商图三个标杆 Skill，在素材、数量和目标不同时能否生成不同 Graph 并完整跑通、局部返工（§8.3 第 5 项）。

这两条过了，五条主张就全部成立。没过，六项就只是一次结构整理。

### 复核（`671cb07`，2026-08-02）

上面那条因果链的**前三环已经断开**：Skill 已有字段（`planning.prompt_guide` / `conduct_rules`）真正抵达了节点执行层（第 3 项），`*-video-spec` 全部删除，`Final_Video_Spec` 依赖 17/30 → 0。作者不再需要在运行时用文本节点手工模拟约束传递。

两个判定数字的当前值：

| 判定 | 目标 | 当前 |
| --- | --- | --- |
| 1. 新增 Skill 需新增几份 Recipe | 0 份 | **1 ~ 5 份**（`lego` 已达 1，`ling-cage` 仍需 5） |
| 2. 三个标杆 Skill 的行为验证 | 通过 | **未跑** |

第 1 条已从「全员 5~7」变成「最好 1、最差 5」，说明路径走得通——`lego-minifigure-animation-video` 是现成的达标样本（4 份共用 + 1 份真正的新工艺）。剩下的是把这个形态推广到其余 Skill，**但必须先加厚共享集**（见 §8.2 第 5 项的执行顺序纠正，直接迁移会造成工艺倒退）。

第 2 条完全未动，且它是唯一能证明「厚 Skill 真的在指挥 Agent」的证据。**在它跑出来之前，六项的完成度只能说到「机制齐备」，说不到「主张三已兑现」。**

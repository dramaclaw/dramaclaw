# 虾画 Token 优化分析

## 结论

虾画侧仍有较大的 Token 优化空间，而且潜在收益可能高于外围虾导。

外围虾导对 `dramaclaw` Skill 的分层优化不会自动减少虾画的 Skill 内容、画布上下文和工具 Schema。虾画当前已经具备独立 Hermes workspace、确定性工作流工具和重复读取保护，但仍存在以下主要消耗来源：

1. 每条非空消息都携带画布摘要；
2. 同一批画布规则在前端、后端和 Skill 中重复注入；
3. Freezone 插件一次注册约 48 个工具；
4. Skill Studio 触发时上下文体积过大；
5. 旧画布快照和大型工具结果可能随会话历史累积。

推荐先处理画布摘要和规则去重，再考虑动态工具集。前两项风险较低、收益直接；动态工具集收益可能最大，但改动和测试范围也最大。

## 当前已有优化

- 虾画使用独立 Hermes workspace，不会把外围 DramaClaw 工具一起暴露给模型。
- 虾画基础 workspace 默认只挂载 `freezone` 和 `workflows` 两个 Skill。
- 原生 Workflow Skill 使用 `freezone_get_workflow_skill(compact=true)` 加载精简内容。
- 标准动态工作流已把 Recipe 选择、节点展开、稳定 ID、连线、布局和合成等确定性操作交给工具。
- 普通多节点编辑优先使用批量命令，不要求模型逐节点调用工具。
- 同一读取工具使用相同参数重复调用超过限制时，会被 Hermes SDK 拦截。
- Freezone 单轮工具调用已有总量保护，避免无限循环。

这些机制能够减少执行过程中的重复推理，但尚未解决每轮输入上下文和工具 Schema 本身的固定成本。

## 问题一：每条消息都携带画布摘要

当前前端 `shouldIncludeCanvasSummary()` 对所有非空消息直接返回 `true`：

```text
frontend/src/features/freezone/chatNodeReferences.ts
```

因此以下请求也会携带整张画布摘要：

- 普通聊天和创意咨询；
- 用户确认或取消；
- 删除已选节点；
- 清空画布；
- 运行已有工作流；
- 已经带有明确节点引用的单节点操作；
- 从文字创建一个全新工作流。

画布摘要默认最多包含 30 个节点和 40 条连线。节点越多，单轮输入越大。如果 Hermes 会话保留完整用户 prompt，历史中还可能同时存在多份已经过期的画布快照。

### 建议

默认只注入轻量路由信息和 `canvas_id/revision`，按请求类型决定是否携带摘要：

| 请求类型 | 是否需要全画布摘要 |
|---|---|
| 普通聊天、创意咨询 | 不需要 |
| 清空画布 | 不需要 |
| 删除已选节点 | 不需要，使用节点引用 |
| 运行已有工作流 | 不需要，Runner 自行读取 |
| 从文字创建新工作流 | 通常不需要 |
| 操作明确选中的单个节点 | 不需要，使用节点引用 |
| 全画布总结、整理、布局 | 需要 |
| 从当前画布沉淀 Skill | 需要 ontology，必要时补关键节点详情 |
| 修改依赖现有拓扑的多节点结构 | 需要摘要或按需读取 |

当没有注入摘要但模型确实需要画布事实时，再调用 `freezone_get_canvas_ontology` 或更具体的读取工具。

### 历史处理

画布上下文属于临时运输信息，不应作为普通用户消息长期保留。建议历史只保存：

- 用户真实输入；
- 助手最终业务回复；
- 当前工作流 `draft_id/revision`；
- 用户确认的关键决策；
- 当前画布 revision/hash。

不要长期保存每轮完整画布摘要、节点 Schema、命令目录和大型工具结果。

### 收益与风险

收益高，风险低到中等。主要风险是模型在需要全局拓扑时没有足够上下文。可通过意图判断、按需读取工具和画布 revision 校验解决。

## 问题二：同一规则重复注入

当前相似规则同时存在于：

1. `.hermes/skills/freezone/SKILL.md`，约 22 KB；
2. `src/novelvideo/chat/service.py` 中的 Freezone 固定说明，约 4.9 KB；
3. 前端注入的 `[SUPERTALE_CANVAS_CHAT_COMMANDS]`；
4. 部分工具自身的长 description。

重复内容主要包括：

- 画布写入前必须调用工具；
- 多节点操作使用批量命令；
- 动态字段先读取 Schema；
- 连线必须具有真实输入语义；
- 合成节点只能消费视频和音频；
- 工具成功前不能声称已经完成；
- 不向用户展示内部 ID、Schema 和工具名。

### 建议分层

```text
freezone/
├── SKILL.md
├── playbooks/
│   ├── canvas-edit.md
│   ├── workflow.md
│   ├── skill-studio.md
│   └── mainline-projection.md
├── references/
│   ├── canvas-modeling-guide.md
│   ├── canvas-command-guide.md
│   ├── error-handling.md
│   └── response-boundaries.md
└── evals/
    └── evals.json
```

职责建议：

- `SKILL.md`：只负责触发、请求分类、全局安全边界和按需加载路由；
- `playbooks/`：分别负责普通画布编辑、动态工作流、Skill Studio 和主线映射流程；
- `references/`：负责节点语义、命令字段、错误分类和用户回复边界；
- 前端注入：只提供当前 surface、canvas、selection、revision 等事实，不重复业务规则；
- 后端固定 prompt：只保留无法由 Skill 覆盖的安全隔离规则。

目标是将 `freezone/SKILL.md` 控制在约 6-10 KB，并保证同一规则只有一个事实源。

### 收益与风险

收益高，风险较低。主要风险是拆分后遗漏硬规则，需要增加结构契约测试和真实请求 evals。

## 问题三：一次注册约 48 个 Freezone 工具

当前 Freezone 插件同时注册多组能力：

- 画布摘要和上下文读取；
- 节点创建、修改、删除、布局和连线；
- 动态工作流准备、修改、确认和运行；
- Skill Studio 草稿和 Catalog 管理；
- 主线资源映射；
- 节点动作和选项查询。

即使某轮只需要运行一个工作流，模型仍可能看到 Skill Studio、主线映射和所有普通节点工具的 Schema。工具 Schema 会占用模型输入，也会增加选错工具的概率。

### 建议工具分组

| 工具模式 | 建议暴露能力 |
|---|---|
| `freezone-chat` | 普通回复，必要时仅保留澄清工具 |
| `freezone-workflow` | Workflow Skill、draft prepare/patch/confirm、run workflow |
| `freezone-canvas-edit` | 画布读取、批量编辑、必要的单步编辑和校验 |
| `freezone-skill-studio` | Catalog 查询、草稿分片、保存和局部修改 |
| `freezone-mainline` | 主线资源查询和映射 |

用户请求进入模型前，由后端做轻量确定性路由，只给本轮需要的工具组。路由不明确时可先使用小型分类步骤，或提供一个“升级到更宽工具集”的受控入口。

### 实现选择

可选方案包括：

1. 将 Freezone 插件拆成多个插件或 toolset；
2. 为不同意图创建隔离 Hermes profile/session；
3. 在 session 创建前按路由过滤工具注册；
4. 若 Hermes 原生 Tool Search 能稳定支持插件工具，再评估启用按需工具搜索。

当前 Freezone profile 明确关闭了 Tool Search，因此仅修改 Skill 文案不能减少工具 Schema。需要调整工具注册或 session 构建方式。

### 收益与风险

收益可能最高，风险中到高。需要处理同一聊天会话中从工作流切换到节点编辑、再切换到 Skill Studio 的场景，并验证工具集能够安全切换或重新创建 session。

## 问题四：Skill Studio 上下文过大

Skill Studio 被触发时，后端会额外注入约 24 KB 固定说明；完整 authoring guide 约 48 KB。若再叠加画布 ontology、Catalog 摘要和全部 Skill Studio 工具 Schema，单轮输入会明显增大。

### 建议拆分

根据来源模式只加载一条流程：

```text
playbooks/skill-studio/
├── new-from-brief.md
├── distill-from-canvas.md
└── edit-existing.md
```

- `new-from-brief`：不加载画布 ontology；
- `distill-from-canvas`：加载 ontology，只补少量关键节点详情；
- `edit-existing`：只读取目标 Skill/Recipe 和当前 draft；
- Recipe 编写字段、复用判断和质量规则继续放在 references，按需加载；
- 能由工具校验的 Schema 规则不重复写进 prompt。

### 收益与风险

对普通虾画操作没有影响；对 Skill Studio 请求收益高。主要风险是草稿质量下降，需要通过 evals 验证三种来源模式。

## 问题五：工具输出和会话历史

部分读取工具可能返回完整 ontology、节点详情、命令目录或 Catalog。即使 UI 只显示精简结果，模型上下文仍可能收到完整工具结果。

### 建议

- 所有大型读取工具默认返回 compact 结果；
- 详细字段通过 `detail=true`、分页或指定 node/section 再读取；
- ontology 默认只返回摘要、selection、关键节点和 revision；
- 命令目录按 command type 查询，不一次返回全部命令；
- Node Schema 按目标节点类型查询；
- Catalog 使用分页、关键词和 ID 精确查询；
- 工具结果进入聊天历史前只保留业务摘要和稳定引用。

### 收益与风险

收益中到高，风险中等。过度压缩可能导致模型再次读取，因此需要保证 compact 返回中包含下一步读取所需的稳定 ID 和缺失字段提示。

## 不建议优先处理的事项

### 直接降低工具调用上限

当前 Freezone 单轮工具调用上限主要用于阻止循环，不能减少每轮固定 prompt 和工具 Schema Token。直接从 12 降到更低可能导致 Skill Studio 分片提交被提前中断。

更合理的是按模式设置预算：

- 普通单节点操作：2-4 次；
- 动态工作流创建：3-5 次；
- 普通批量画布编辑：3-6 次；
- Skill Studio：根据新 Recipe 数量动态计算；
- 重复读取相同对象：继续保持严格限制。

### 仅缩短工具描述

缩短工具 description 有收益，但如果仍同时注册 48 个工具，整体改善有限。应先减少每轮暴露的工具数量，再压缩每个 Schema。

## 推荐实施顺序

### 第一阶段：低风险、高收益

1. 改造 `shouldIncludeCanvasSummary()`，只在确实需要全画布上下文时注入摘要；
2. 节点引用存在时优先使用引用，不再附带整张画布；
3. 清空、删除、运行工作流等确定性操作不附带摘要；
4. 避免临时上下文块进入长期历史；
5. 为上述路由增加前端和后端测试。

### 第二阶段：Skill 分层和规则去重

1. 精简 `freezone/SKILL.md`；
2. 新增 canvas-edit、workflow、skill-studio、mainline playbooks；
3. 删除前端、后端、Skill 中重复的说明；
4. 将 Skill Studio 按三种来源模式拆分；
5. 新增触发、路由、工具选择和回复边界 evals。

### 第三阶段：动态工具集

1. 统计生产环境每种请求实际使用的工具集合；
2. 拆分 Freezone toolset；
3. 增加确定性意图路由和受控工具集升级；
4. 验证同一会话跨模式切换；
5. 再根据模式调整 max turns 和工具调用预算。

### 第四阶段：工具输出和历史压缩

1. 为大型工具增加 compact、分页和 section 查询；
2. 历史只保存业务结果和稳定引用；
3. 基于 canvas revision 使用增量上下文；
4. 增加长会话、大画布和多项目压力测试。

## 验收指标

建议在优化前后记录以下指标：

- 普通虾画聊天的 input tokens；
- 空画布和 30/60/100 节点画布的 input tokens；
- 动态工作流创建的总 input/output tokens；
- Skill Studio 新建、沉淀和编辑三种流程的 token；
- 单轮暴露工具数和工具 Schema 字节数；
- 每轮画布摘要字节数；
- 同一会话第 1、10、30 次消息的上下文增长；
- 平均工具调用次数、重复读取次数和守卫中断率；
- 工作流创建成功率、节点编辑成功率和 Skill Studio 草稿通过率。

第一阶段完成后，应首先看到普通聊天、简单删除、运行工作流和明确节点操作的输入 Token 显著下降；第二、三阶段完成后，动态工作流和 Skill Studio 的工具选择稳定性也应提高。

## 影响判断

- 第一阶段主要改变上下文注入策略，不改变画布 API、节点执行、动态工作流和 UI 操作流程；整体风险较低。
- 第二阶段改变规则归属，不改变产品能力；通过契约测试后对现有功能影响较小。
- 第三阶段会改变模型每轮可见工具，需要重点验证跨模式切换，属于中等规模改造。
- 第四阶段会改变工具返回结构和历史保存方式，需要保留兼容字段或同步修改消费者。

综合判断：虾画 Token 优化值得继续做，但应先从“画布摘要按需注入”和“规则单一事实源”开始，不建议直接降低工具调用上限，也不建议一开始就重构全部工具注册。

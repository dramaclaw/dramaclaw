# Agent 驱动互动影游：需求理解与实施计划

> 状态：实施中
>
> 当前阶段：Codex-first 的 M0–M4 代码闭环已完成，下一步进行真实 Agent 对话与浏览器试玩联调
>
> 首次整理：2026-08-31
>
> 最近对账：2026-09-02
>
> 适用基线：`feat/canvas-interactive-story-agent`

本文是 Agent 驱动互动影游功能的正式需求与实施计划。后续讨论形成的稳定决策、阶段状态和验收结果统一更新到本文，避免只保留在聊天记录中。

## 1. 需求理解

### 1.1 用户目标

创作者通过自然语言与 Agent 对话，描述题材、角色、冲突、分支和结局。Agent 将讨论结果生成可验证的结构化互动剧本，自动写入画布形成剧情树。创作者可以继续通过对话或画布修改故事，在正式制作视频前使用占位素材试玩，最终为各剧情节点导入或生成视频并发布为可玩的互动影游。

目标闭环：

```text
用户创意
  → Agent 对话与必要澄清
  → 确认故事大纲和分支规模
  → 生成结构化互动剧本
  → 自动写入画布剧情树
  → 校验并编译为 Ink
  → 占位素材试玩
  → 导入或生成节点视频
  → 完整试玩与发布
```

### 1.2 目标用户

- 不熟悉 Ink 语法，但希望通过对话创作互动故事的普通创作者。
- 需要在高成本视频制作前验证分支结构的编剧、导演和内容团队。
- 希望在画布中精修 Agent 结果，并保留人工修改的专业创作者。

### 1.3 核心体验要求

1. 用户不需要理解 Ink 或画布内部数据结构。
2. Agent 先控制故事范围，再写入画布，避免分支数量失控。
3. 没有任何视频时也能完整试玩故事。
4. Agent 后续修改必须是增量修改，不能覆盖用户已有布局、视频和人工调整。
5. 故事存在断路、不可达节点、变量错误等严重问题时，不能进入发布。
6. 视频既支持用户导入，也支持系统生成；两种来源在播放器中没有差别。
7. 剧情状态同时支持数值变量与布尔开关（Flag）；分支既支持玩家主动选择，也支持按条件自动跳转、无需玩家操作。

### 1.4 第一版不解决的问题

- 不追求一次对话生成长篇、多章节、大规模剧情网络。
- 不在故事结构验证前批量生成正式视频。
- 不在首个闭环中实现多人实时协作、商业计费或复杂数据平台。
- 不让 Agent 直接生成任意 Ink 文本并依赖逆向解析作为主要创作路径。
- 不把互动故事业务逻辑绑定到 Hermes 或 Codex 任一 Agent 运行时。

## 2. 当前实现判断

既有画布互动影游实现已具备主要播放骨架：

- 画布故事节点、选择边、变量、条件和变量效果。
- 画布故事组编译为 Ink，并由 `inkjs` 执行。
- 剧情校验、存档、限时选择、默认选项、后继视频预取和路径统计。
- 画布内播放器、占位素材试玩、Ink 导入和 HTML 播放器导出。
- 按剧情节点批量发起视频生成。

本轮开始前最大的缺口不是播放器，而是：

> Agent 对话结果还不能通过稳定、可校验、可增量修改的领域协议写入画布。

M0–M4 已在代码层打通这条链路。当前剩余工作是用真实模型和浏览器验收完整对话，随后统一后端静态校验与前端 Ink 编译门禁，再完善正式视频生产和发布体验。

## 3. 已采纳的架构决策

### 3.1 画布故事模型是创作事实源

Agent 不直接把任意 Ink 文本作为主要输出。Agent 输出版本化的 `StoryDraftV2`，系统将其确定性转换为画布节点和连线，再由现有编译器生成 Ink。

这样可以保留稳定节点 ID、媒体绑定、画布布局、校验能力和后续增量修改能力。

### 3.2 Agent 运行时与业务能力解耦

```text
                     ┌─ Codex harness ─ MCP Tool（主路径）
用户 → Agent UI → Agent Runtime
                     └─ Hermes Adapter ─ Plugin Tool（兼容路径）
                                  ↓
                    InteractiveStoryService
                                  ↓
                       StoryDraftV2 / Patch
                                  ↓
                    画布 → Ink → 播放器 → 视频
```

- `InteractiveStoryService` 保存真正的创建、读取、修改和校验逻辑。
- Codex harness + MCP 是当前优先运行路径。
- Hermes Plugin Tool 保留为兼容适配器，两者复用同一个 API 与服务层。
- 切换 Agent runtime 不重写剧情、画布、Ink 和视频管线。

### 3.3 Skill 与 Tool/MCP 分工

- Skill 负责对话策略：如何澄清、控制分支、确认大纲、决定创建或修改。
- Tool/MCP 负责可靠操作：创建、读取、增量修改、校验和后续视频任务。
- Schema 的权威来源是后端领域模型和工具契约；Skill reference 只提供调用时所需的构造指南，不成为第二份契约 owner。
- Workflow Skill/MCP 与 Interactive Story Skill/工具是独立模块：前者负责 Recipe 查询和确定性编译，后者直接调用 `InteractiveStoryService`，不经过 Workflow Draft、审批或执行状态机。

### 3.4 第一版使用对话式大纲确认

- 第一版先使用自然语言大纲确认，不等待结构化大纲卡片 UI。
- Agent 最多集中追问四个高影响信息；用户没有偏好时采用约 7 个节点、2 个选择点、2 个结局和占位媒体。
- 未得到针对当前大纲的明确确认，不执行 Create。
- 结构化大纲卡片可以在 M4 作为体验增强，不改变 Create/Patch 工具契约。

### 3.5 视频采用“先占位，后混合生产”

节点媒体统一抽象为素材引用，来源允许为：

- `placeholder`：文字卡或静帧，用于低成本试玩。
- `imported`：用户上传或已有素材。
- `generated`：模型生成的视频。

第一版先保证三种素材来源能绑定到同一个稳定节点；自动生成质量与成本优化后置。

## 4. `StoryDraftV2` 初步范围

> 范围变更记录（2026-09-04）：在 V1 基础上新增布尔开关（Flag）状态与 Choice 自动跳转模式（`mode: automatic`），协议由 `StoryDraftV1` 升级为 `StoryDraftV2`。V1 从未发布、属全新功能，因此协议直接替换：不留双版本兼容层，旧 `storyVariables` 镜像字段不做读取回退与数据迁移。两项能力已随后端模型/服务、前端画布/编译器/运行时和 Skill 契约同步实现。

M0 阶段需要冻结以下语义，具体字段名以实现时的 Pydantic/TypeScript Schema 为准：

| 领域对象 | 最小信息 |
|---|---|
| Story | `schema_version`、`story_id`、标题、简介、开始节点、修订号 |
| Character | 稳定 ID、名称、简介、可选视觉描述 |
| Segment | 稳定 ID、标题、剧情/对白、节点类型、是否结局、素材引用 |
| Choice | 稳定 ID、来源节点、目标节点、玩家选择/自动跳转模式、排序、可选倒计时与默认项 |
| Variable / Flag | 数值变量或布尔开关的名称、标签、初始值与可选范围 |
| Condition | 数值变量、布尔开关、访问次数条件及 `and`、`or` 组合 |
| Effect | 跳转后执行数值变化或设置布尔开关 |
| MediaRef | 来源、资产 ID/URL、生成状态、版本 |

协议必须满足：

- 所有可编辑实体拥有稳定 ID。
- 节点 ID 不依赖标题或数组位置。
- Schema 带显式版本号。
- 未绑定媒体不影响编译和占位试玩。
- 可以确定性转换为现有画布模型。
- 可以执行完整静态校验，并返回节点级错误位置。

### 4.1 已冻结的持久化边界

- 故事由 Freezone 画布持久化，不新增平行的故事文件或数据库副本。
- 画布 JSON 是持久化 owner，现有 `revision`、`base_revision`、`client_save_id`、写锁和历史快照继续作为并发与恢复机制。
- `StoryDraftV2.revision` 表示该故事快照对应的画布 revision；Patch 使用相同 revision 做乐观并发控制。
- `StoryDraftV2` 是 Agent 和业务服务之间的领域契约，不直接替代完整画布 JSON。

### 4.2 与现有画布模型的确定性映射

| StoryDraftV2 | 画布表示 |
|---|---|
| `story_id` | 故事组 `data.interactiveStoryId`；画布节点 ID 使用带 story 命名空间的确定性 ID |
| `title`、`synopsis` | `groupNode.data.label`、`data.storySynopsis` |
| `characters` | `groupNode.data.storyCharacters`，供后续视频制作规格复用 |
| `variables` / `flags` | 分别存于 `groupNode.data.storyVariableDefinitions` 与 `data.storyFlags` |
| `start_segment_id` | 对应 `videoNode.data.storyRole = "start"` |
| `segment.id` | `videoNode.data.storySegmentId`；React Flow ID 使用 story 命名空间 |
| `segment.title` | `videoNode.data.displayName` |
| `segment.script` | `videoNode.data.narration` |
| `segment.choice_time_limit_sec` | `videoNode.data.choiceTimeLimitSec` |
| `segment.ending_label` | `videoNode.data.endingLabel` |
| `segment.media.url` | `videoNode.data.videoUrl`；完整来源与版本另存 `data.storyMedia` |
| `choice.id` | `storyChoiceEdge.data.storyChoiceId`；边 ID 使用 story 命名空间 |
| `choice.mode/text/order/is_default` | `transitionMode/choiceText/order/isDefault`；自动跳转在画布上显示为虚线 |
| variable condition | `{ var, op, value }` |
| visited condition | `{ visitedNodeId, op, value }`，其中 ID 转成实际画布节点 ID |
| flag condition | `{ flag, value }` |
| condition group | `{ join, items }`，采用单层组合 |
| increment effect | `{ var, delta }` |
| set flag effect | `{ flag, value }` |

确定性 ID 建议格式：

```text
group node:  story-{story_id}
segment:     story-{story_id}-segment-{segment_id}
choice edge: story-{story_id}-choice-{choice_id}
```

映射器仍需检测目标画布已有 ID 冲突；不能因冲突覆盖非本故事节点。

## 5. Agent 工具契约

第一阶段只建设四个故事工具：

| 工具 | 类型 | 责任 |
|---|---|---|
| `dramaclaw_create_interactive_story` | 写 | 创建故事和画布故事组，返回故事 ID、修订号和校验结果 |
| `dramaclaw_get_interactive_story` | 读 | 获取当前故事摘要、结构、修订号、素材状态和校验问题 |
| `dramaclaw_patch_interactive_story` | 写 | 基于 `base_revision` 执行一组类型化增量操作 |
| `dramaclaw_validate_interactive_story` | 读 | 当前执行 Schema 和图结构校验，不修改故事；Ink 编译校验在 M5 落地 |

共同约束：

- 写操作支持幂等请求 ID，防止 Agent 重试产生重复节点。
- Patch 必须带 `base_revision`；版本不一致时返回冲突，不静默覆盖。
- Patch 使用类型化操作，例如增加节点、修改台词、连接选择、更新条件，而不是提交整棵树覆盖。
- 工具返回结构化错误码、可定位实体 ID 和面向用户的简短说明。
- Hermes 和 MCP 只包装同一套 `InteractiveStoryService`，不复制业务逻辑。

## 6. 分阶段实施计划

### M0：协议与边界冻结

工作项：

- [x] 对齐现有画布节点、选择边、变量与 `StoryDraftV2` 的映射。
- [x] 定义 `StoryDraftV2`、Patch 操作和工具输入输出 Schema。
- [x] 确认故事、修订号、幂等键和冲突处理的持久化位置。
- [x] 为 Hermes、MCP、未来 Codex harness 划定相同的服务边界。
- [x] 增加双选择点、双结局的标准示例和协议测试。

验收标准：

- 一份固定的 `StoryDraftV2` 示例可表达至少两个选择点和两个结局。
- 示例能无歧义映射到当前画布模型。
- Create/Get/Patch/Validate 的成功和失败返回均有明确契约。
- 设计不引用 Hermes 专属会话字段。

实现与验证：

- 领域模型：`src/novelvideo/interactive_story/models.py`
- 标准示例：`examples/interactive_story/story_draft_v2.json`
- 契约测试：`tests/test_interactive_story_models.py`
- 定向验证：`uv run pytest tests/test_interactive_story_models.py -q`

### M1：独立故事服务

工作项：

- [x] 实现 `InteractiveStoryService` 的 create/get/patch/validate。
- [x] 实现 StoryDraft 与画布故事组之间的双向转换。
- [x] 加入修订冲突、幂等与原子保存边界。
- [x] Patch 保留人工布局、用户视频和未知扩展字段。
- [x] 增加领域服务和映射契约测试。

验收标准：

- 固定示例可以创建为画布剧情树并持久化。
- Get 能完整还原 Agent 后续修改所需的故事信息。
- 重复 Create 不生成重复故事。
- 过期 Patch 被拒绝，当前版本数据不受影响。

实现与验证：

- 双向映射：`src/novelvideo/interactive_story/canvas_mapper.py`
- 原子服务：`src/novelvideo/interactive_story/service.py`
- 服务测试：`tests/test_interactive_story_service.py`
- 前端可选领域元数据：`frontend/src/features/canvas/domain/canvasNodes.ts`、`frontend/src/features/canvas/story/storyTypes.ts`
- 后端定向验证：`uv run pytest tests/test_interactive_story_service.py -q`（覆盖 Create/Patch 幂等重试、冲突、失败原子性和异常画布错误契约）。
- 前端相关领域测试与 TypeScript 构建用于验证画布映射兼容性；测试数量不在本文固化，避免随主干增长后失真。

实现边界：

- 复用 Freezone 画布文件、revision、幂等记录、写锁和历史快照，没有新增平行故事存储。
- 服务在画布写锁内读取最新状态、应用 Patch 并一次原子写回。
- 当前 `validate` 完成领域 Schema 和画布图完整性校验；Ink 编译仍由现有前端编译链负责，统一校验错误语义放在 M5。

### M2：Hermes Plugin 与 MCP 接入

工作项：

- [x] 将四个工具接入现有 DramaClaw Plugin。
- [x] 通过现有 MCP 桥暴露相同工具。
- [x] 把 Create/Patch 纳入每轮写工具限制和审批策略。
- [x] 保证两个入口的输入输出一致。

验收标准：

- Hermes 和 MCP 客户端创建同一输入时得到等价结果。
- 单轮只执行一次故事写操作。
- 工具失败不会留下半成品画布数据。

实现与验证：

- 互动故事 HTTP API：`src/novelvideo/api/routes/interactive_stories.py`
- DramaClaw Plugin 装配：`.hermes/plugins/dramaclaw/__init__.py`
- 运行时无关的互动故事工具与输入 Schema：`.hermes/plugins/dramaclaw/interactive_story.py`
- MCP 复用现有 Plugin 工具桥：`src/novelvideo/chat/dramaclaw_mcp.py`
- Agent 每轮写工具限制：`src/novelvideo/chat/hermes_sdk.py`
- API、Plugin、MCP 与工作区配置测试：`tests/test_api_interactive_stories.py`、`tests/test_hermes_dramaclaw_plugin.py`、`tests/test_dramaclaw_mcp.py`、`tests/test_hermes_workspace.py`
- 定向回归：`uv run pytest tests/test_api_interactive_stories.py tests/test_hermes_dramaclaw_plugin.py tests/test_dramaclaw_mcp.py tests/test_hermes_workspace.py -q`；前端相关测试与 TypeScript 构建同步验证。

实现边界：

- `dramaclaw_create_interactive_story` 和 `dramaclaw_patch_interactive_story` 是写工具，受每轮最多一次写操作约束；Get 和 Validate 保持只读。
- MCP 桥直接发现并暴露 Plugin 的同一组 `TOOLS`，没有维护第二套业务实现或转换逻辑。
- API 继续复用项目权限、画布锁和 `InteractiveStoryService` 的原子写入；冲突、校验失败和服务不可用均返回结构化错误。
- Agent 创建和增量修改分别记录为 `agent_create`、`agent_patch`，与前端自动保存和普通导入区分。
- `remove_segment` 会级联删除直接以该节点为起点或终点的 Choice；条件中的访问节点引用仍需显式调整，避免静默改变条件语义。
- `storyVariableDefinitions` 与 `storyFlags` 分别是数值状态和布尔状态的权威来源；新功能不再读写旧的 `storyVariables` 字段（V1 未发布、属全新功能，无需兼容回退或迁移）。
- 媒体引用同时识别 URL 和 asset ID；只有 asset ID 尚未解析为播放 URL 时返回 `media_url_unresolved`，限时节点没有显式默认项时返回首选项回退 warning。

### M3：互动故事 Skill 与对话闭环

工作项：

- [x] 新增独立 `interactive-story` Skill。
- [x] 定义意图触发、必要澄清、大纲确认、分支预算和修改策略。
- [x] 用户确认后只调用一次 Create；后续编辑只调用 Patch。
- [x] 创建完成后自动调用 Validate，并向用户解释严重问题。

验收标准：

- 用户用一句创意开始，经过有限澄清后可生成剧情树。
- Agent 不要求用户理解 JSON、Ink 或节点 ID。
- 未经确认不执行创建写操作。
- Agent 可以完成“把第二个结局改成开放结局”一类增量修改。

实现与验证：

- runtime-neutral 对话策略 owner：`src/novelvideo/agent_skills/interactive-story/SKILL.md`
- 按需领域构造指南 owner：`src/novelvideo/agent_skills/interactive-story/references/story-contract.md`
- 外部 Agent 发布副本：`agent-kit/skills/interactive-story/`，由 `agent-kit/scripts/sync_skill.py` 与 owner 对账。
- 线性剧本与互动故事意图分流：`.hermes/skills/dramaclaw/SKILL.md`
- Hermes Freezone 工作区从 canonical owner 建立 Skill 链接：`src/novelvideo/chat/hermes_workspace.py`
- 内置 Codex/Claude Freezone 工作区自动物化同一份 runtime-neutral Skill：`src/novelvideo/chat/service.py`
- 外部 Codex/Claude/OpenClaw 使用 `agent-kit` 手工安装 Skill，并配置 Workflow MCP 与授权 DramaClaw MCP；这与产品内工作区自动装载不是同一条部署路径。
- `agent-kit/manifest.json` 使用既有 `skills` 列表声明发布内容，不新增 `skill_packages` 字段；CE 运行时直接使用 `src/novelvideo/agent_skills`，Docker 镜像不依赖复制整个 `agent-kit/`。

联调边界：

- 自动化测试已覆盖 Skill 发现、Hermes 用户工作区链接、Codex/Claude 工作区同步、工具写入上限和互动故事服务契约。
- 尚未使用真实模型和真实项目执行“一句话创意 → 大纲确认 → Create → Validate”完整对话，因此 M3 进入联调状态；联调通过后再标记产品验收完成。

### M4：画布落地与占位试玩

工作项：

- [x] 自动创建故事组、节点和选择边。
- [x] 为新故事执行稳定、可重复的初始布局。
- [x] 没有媒体时自动显示文字卡/静帧占位。
- [x] 产品内 Agent 工具写入成功后，通过 `agent.tool.updated` 中的 `canvas_id + revision + refresh_canvas` 回执刷新当前画布。
- [x] 画布内使用现有编译器与播放器直接试玩。

验收标准：

- 新故事无需手工补线即可编译为 Ink。
- 从开始节点可以走完所有预期结局。
- 刷新后故事、布局和修订号仍然存在。
- 占位素材与正式视频使用相同的剧情运行逻辑。

实现与验证：

- 映射与初始布局：`src/novelvideo/interactive_story/canvas_mapper.py`
- 画布写入回执：`src/novelvideo/interactive_story/models.py`
- 前端远端刷新：`frontend/src/features/freezone/interactiveStoryCanvasRefresh.ts`
- 占位与试玩复用现有 `compileStoryGroup`、Ink runtime 和画布播放器。
- Create/Patch 由 `InteractiveStoryService` 在后端原子写入画布；它们不走普通 Freezone 节点命令的浏览器 bridge。产品内聊天收到成功工具帧后才拉取远端画布。
- 刷新只在工具帧作用域与当前项目/画布一致时执行。若本地存在未保存编辑，前端保留本地副本并进入冲突状态；干净画布采用归一化后的 store 状态作为持久化签名基线，连续 Agent 刷新不会被误判为冲突。
- 外部 stdio MCP 客户端会收到相同写入回执，但当前没有通用的 MCP→浏览器广播；外部宿主若未实现刷新适配，需要用户刷新/重新打开画布后看到服务端结果。
- 自动化验证已覆盖服务映射、API、MCP、插件、刷新目标解析、未保存编辑保护和连续刷新；真实浏览器中的完整创作对话仍待人工联调。

### M5：增量编辑与质量门禁

工作项：

- Patch 保留未修改节点的布局、媒体和稳定 ID。
- 统一后端校验与前端 `lintStory`/Ink 编译错误语义。
- 明确 warning 与阻止发布的 error。
- 增加断路、死路、循环、不可达节点、变量和版本冲突测试。
- 增加条件感知可达性与变量边界模拟，识别结构可达但运行时不可达的路径。
- 明确故事组尺寸只增不减的当前保护策略，并提供不破坏人工布局的显式紧凑操作。

验收标准：

- 修改台词不会解绑视频或移动节点。
- 增加分支只影响目标局部结构。
- 严重校验错误不能进入发布。
- 错误可以定位并高亮到具体画布节点或连线。

### M6：视频生产与素材版本

工作项：

- 为节点生成标准化制作规格：角色、场景、镜头、对白、时长和连续性约束。
- 支持单节点导入、单节点生成和批量生成。
- 保存素材来源、生成任务、版本、成本和失败状态。
- 支持替换、重试和恢复上一版本。

验收标准：

- 一个故事可以混用占位、导入和生成视频。
- 视频生成失败不破坏故事结构和已有素材。
- 修改故事后能够识别需要重新生成的节点，而不是全量重做。

### M7：发布与运营

工作项：

- 补齐发布播放器与画布内播放器的能力差异。
- 明确视频打包、外链和真正离线导出的产品边界。
- 完善预加载、存档、路径回顾、选择统计和结局达成率。
- 增加发布前检查、版本快照和回滚方案。

验收标准：

- 发布版本与创作预览的剧情行为一致。
- 发布后能记录选择路径与结局数据。
- 每次发布保留版本快照，并能够回滚到上一发布版本。

## 7. 当前优先级

| 优先级 | 内容 | 状态 |
|---|---|---|
| P0 | M0 协议与边界冻结 | 已完成 |
| P0 | M1 独立故事服务 | 已完成 |
| P0 | M2 Hermes/MCP 工具接入 | 已完成 |
| P0 | M3 Agent 对话闭环 | Codex-first 已实现，待真实模型联调 |
| P0 | M4 占位试玩闭环 | 代码已完成，待浏览器验收 |
| P1 | M5 增量编辑与质量门禁 | Patch/基础校验已完成，统一 Ink 门禁待做 |
| P1 | M6 视频生产与版本 | 已有批量生成骨架，素材来源/版本闭环待设计 |
| P2 | M7 发布与运营 | 待开始 |

## 8. 首个可交付版本

首个版本只承诺以下场景：

> 用户输入一句故事创意，Agent 通过少量问题确认题材、主角、分支规模和结局方向；用户确认后生成画布剧情树；系统执行领域与静态图校验，并在进入试玩/导出时由前端将画布故事组确定性编译为 Ink；即使没有正式视频，用户也能通过占位素材完成一次包含至少两个结局的互动试玩。

首个版本的默认规模建议：

- 5～12 个剧情节点。
- 每个选择点 2～3 个选项。
- 2～3 个结局。
- 0～5 个数值变量与 0～3 个布尔开关。
- 允许分支汇合，避免指数级增长。
- 允许按条件自动跳转的分支，用于无对白的过场衔接。

## 9. 风险与控制

| 风险 | 控制方式 |
|---|---|
| Agent 输出不稳定 | 严格 Schema、服务端校验、类型化 Patch |
| 分支爆炸导致视频成本失控 | Skill 分支预算、优先汇合、生成前成本预估 |
| Agent 覆盖人工修改 | 稳定 ID、`base_revision`、局部 Patch、版本冲突；产品内刷新前比较归一化持久化签名，有未保存编辑时保留冲突副本而不覆盖 |
| Agent runtime 迁移返工 | Codex-first MCP、运行时无关服务层、Hermes 薄兼容适配器 |
| 前后端校验结果不一致 | 共享错误码和契约测试，逐步统一规则来源 |
| 静态图可达但变量条件永远无法满足 | M5 引入条件感知可达性、变量边界模拟和运行路径测试 |
| 视频生成失败阻断创作 | 占位试玩、节点级重试、素材版本独立于剧情版本 |
| 导出播放器与编辑器行为漂移 | 共用编译产物和运行时契约，增加端到端用例 |

## 10. 待确认事项

这些问题不会阻塞 M0 Schema 设计，但应在进入对应阶段前确定 owner 和结论：

1. 发布产品第一版面向在线链接、可下载包，还是两者都支持。
2. 视频生成的默认供应商、单节点时长和成本上限。
3. 是否允许玩家看到全局分支图，以及何时解锁未探索路径。

## 11. 文档维护规则

- 每个里程碑开始时更新“当前阶段”和优先级状态。
- 完成里程碑时补充实际实现文件、验证命令和已知限制。
- 架构方向变化时先更新“已采纳的架构决策”，再调整阶段计划。
- 尚未实现的目标必须保持为“计划”或“待开始”，不能描述成当前能力。
- 竞品和体验依据参见 [互动影游竞品调研报告](fmv-competitive-research.md)。

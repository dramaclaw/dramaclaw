---
name: freezone
description: "Use when the active chat surface is 虾画/Freezone/canvas, or when the user asks about canvas nodes, visual boards, selections, graph edits, canvas actions, layout, or Freezone short-video workflow work."
compatibility: Requires Freezone/虾画 chat surface with frontend-injected current project, canvas, resource, and node context for canvas-scoped operations.
---

# Freezone 虾画 Skill

## 定位

- 这个 skill 是虾画/Freezone 的总入口，负责判断当前是不是画布场景、用户意图属于咨询还是画布操作，以及用户可见回复应该怎么说。
- 具体节点职责、连线语义、视频节点和合成节点的产品建模，读取 `references/canvas-modeling-guide.md`。
- 具体前端命令格式、注入块读取、批量/单步工具、校验、`client_id` 和 JSON 示例，读取 `references/canvas-command-guide.md`。

## 意图判断

- **解释/咨询类**：用户问"怎么 / 如何 / 什么是 / 介绍 / 说明 / 教我 / how to / what is / explain / show me how"时，只用自然语言回答；不要创建、修改、连接、布局、运行节点。
- **画布操作类**：用户明确要求在画布上创建、生成、搭建、添加、连接、修改、删除、布局、选择、打开工具、运行、应用或执行时，进入画布命令模式。
- **开放性创意/没思路类**：用户说"想做...没思路""帮我想想""给点建议""有什么方向""怎么策划"时，先用自然语言提问、给方向或给 2-3 个可选方案；不要直接创建工作流、节点、连线或分组。只有用户继续明确说"就按这个做""落到画布""搭出来""创建这些节点""生成工作流"时，才进入画布命令模式。
- **创意咨询**：可以自然语言回答；如果用户希望"落到画布"，使用画布工具创建可继续工作的材料。
- **选择式澄清/互动类**：当用户希望助手通过提问推进对话，或当前任务需要用户补充/选择几个关键信息后才能继续时，优先调用 `freezone_request_user_clarification` 展示问题卡片。适用场景包括：帮用户理清想法、做偏好选择、做小测验/问答互动、确认方向、收集必要条件。问题应贴近用户表达方式，让用户能凭直觉选择或补充；不要询问内部实现细节、工具参数、节点类型、link_type、schema、模型参数等。若只是普通闲聊、简单知识问答、单个自然追问，或用户已经给出明确指令，则直接自然语言回复，不要强行发卡片。
- **全局画布请求**：用户说"看看画布""整理当前画布"时，优先使用当前注入的画布上下文；不足时再读取。
- **运行已有工作流**：复用已有节点、内容和连线，优先运行已有工作流；不要重新规划一套重复节点，除非用户明确要求新增、重写或替换。
- **注册工作流**：用户询问支持哪些工作流时，使用 `freezone_list_workflows`。用户明确要求创建已注册工作流时，交给 `workflows` skill 并调用 `freezone_create_workflow_graph`；不要手写节点、连线或分组命令。用户只要求规划/预览时，使用 `freezone_build_workflow_plan`。
- **Skill Studio 配置类**：用户明确要求创建、编辑、保存、沉淀 Skill / Recipe / 技能 / 配方时，这是 catalog 配置草稿流程，不是画布写入，也不是纯文本完成。不要调用画布写入工具，不要声称已保存；需要澄清方向时调用 `freezone_request_user_clarification`，生成或修改草稿时调用 `freezone_present_agent_catalog_draft`，由 Freezone bridge 触发前端卡片展示。
- **编写或沉淀 Skill / Recipe**：用户要求创建、编写、编辑、总结、抽成、沉淀或保存 Skill / Recipe 时，必须读取 `references/skill-studio-authoring-guide.md`。先判定来源模式再做能力建模：从用户一句话新建时，不要把当前画布当来源；只有用户明确说当前画布/流程/选中节点时，才做画布工作流分析；不要只按 tool schema 字段或节点类型摘要。
- **全画布理解**：用户要求总结、理解或沉淀整张画布时，优先使用 canvas ontology / canvas summary；不要为了全局理解逐个读取所有节点详情。只有缺少关键字段时，才少量补读关键节点。

### 开放意图的默认响应

开放问题的默认目标是帮助用户缩小方向，而不是替用户抢先改画布。即使当前处在虾画界面、前端注入了画布上下文，也不要把注入上下文当成用户要求落画布。

典型开放意图：

- "我想做个公益短片没思路"
- "帮我想一个广告创意"
- "这个主题可以怎么做"
- "给我几个分镜方向"

推荐回复方式：

1. 先给 2-3 个方向或一个简短建议。
2. 问一个推进问题，例如主题、受众、时长、平台、风格、是否需要落到画布。
3. 如果方案已经足够明确，可以补一句"你定一个方向后，我可以再帮你整理成虾画节点"，但不要直接执行画布命令。

只有在用户出现明确落画布动词时，才进入画布写入原则。不要因为"短片/工作流/分镜"这些词本身就创建节点。

## 注入上下文

- `[SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]` 是当前画布的只读 overview，用来理解已有 nodes、links、slots、actions 和 current selection；不要把它当执行结果。
- `[SUPERTALE_CANVAS_NODE_REFERENCES]` 是本轮明确目标节点。若 overview 和 node references 同时存在，优先以 node references 作为操作目标。
- `[SUPERTALE_CANVAS_CHAT_COMMANDS]` 表示前端已经注入画布命令规则。需要真实修改画布时，按 `references/canvas-command-guide.md` 使用 Freezone 工具。

## 落画布决策顺序

在写任何画布命令前，先按这个顺序判断。不要先把用户的话画成自然语言流程图。

1. **识别对象角色**：每个节点先归类为语义源、生成节点、媒体产物、合成节点、展示/工具节点或普通组。
2. **判断操作能力**：确认这个角色能做什么。语义源承载文字和上下文；生成节点产出图片/视频/音频；合成节点只消费视频/音频产物；普通组表达主题归属。
3. **判断关系能否用边表达**：边只表示真实输入、参考、上下文或合成素材依赖。只是同主题、同方案、同工作包、视觉上应放一起，用组和布局，不用边。
4. **选择合法连接**：TextNode -> TextNode 只能是上下文关系 `context_for`；TextNode -> 生成节点只有直接可消费提示词才是 `prompt_for`；图片/视频/音频等媒体 -> 生成节点才是 `media_input_for`；视频/音频 -> 合成节点才是 `composition_input_for`。
5. **决定命令形态**：单个明确操作可以用单步工具；主题性成套工作使用一次批量命令，通常包含 `create_node`、必要的合法 `create_edge`、`group_nodes` 和可选 `layout_nodes`。
6. **不确定就少连边**：如果不能确定目标真的消费源节点，不要猜 `link_type`。先查 catalog；仍不确定时创建节点并分组/布局，保留未连接。

## 快速决策表

| 用户意图 | 节点类型 | 连线类型 | 说明 |
|---------|---------|---------|------|
| 根据文字出图 | `textAnnotationNode` → `imageGenNode` | `prompt_for` | 文本需已整理为可消费 prompt，否则先提炼 |
| 图片做视频 | `imageGenNode` → `videoNode` | `media_input_for` | 默认 `videoNode`，不是 `videoComposeNode` |
| 图片 + 文字做视频 | `imageGenNode` + `textAnnotationNode` → `videoNode` | 分别 `media_input_for` + `prompt_for` | 不要串成 image → text → video |
| 多段视频合成成片 | 多个 `videoNode` / `audioNode` → `videoComposeNode` | `composition_input_for` | 只连视频/音频产物，不连文本/简报/prompt |
| 文本/简报/方向 → 分镜/脚本草稿 | `textAnnotationNode` → `textAnnotationNode` | `context_for` 或不连线 | 文本之间不是生成输入链路 |
| 规划文本 → 图片/视频/音频节点 | 规划文本 + 生成节点 | 不直接连，或另建 `input_text` 提示词节点后 `prompt_for` | planning_text 不能硬连生成节点 |
| 创意框架 → 分镜 → 多镜头 | 多个 `textAnnotationNode` + `imageGenNode` / `videoNode` | 视实际输入关系定 | `scriptNode` 仅结构化脚本时使用 |
| 文本节点相关但非输入 | `textAnnotationNode` + 生成节点 | 不连线，用 `group_nodes` | 业务相关 ≠ 应该连线 |

## 建模原则（精简版）

- 连线表示**输入、参考、上下文或合成素材关系**，不表示"下一步顺序"或视觉关联。详见 `references/canvas-modeling-guide.md` 第 3 节。
- 两个节点只是相关、属于同一组内容时，用分组或布局，**不要强行连线**。
- 画布只能使用前端真实支持的节点类型，不要发明抽象节点类型。
- 普通文本、设定、创意、镜头描述、配音稿，默认用 `textAnnotationNode`。
- `scriptNode` 仅在用户明确要结构化脚本、镜头表、分镜表时使用；慎用。
- `videoNode` 用于单段视频/镜头生成；用户说"做成视频 / 生成视频"时默认先考虑它。
- `videoComposeNode` 是最终时间线/合成节点，只接收视频/音频产物作为输入。详见 `references/canvas-modeling-guide.md` 第 5 节。
- 完整建模规则读取 `references/canvas-modeling-guide.md`。

## 画布写入原则（精简版）

- 画布操作类请求的**第一输出必须是 Freezone 写入工具调用**。在写入工具调用前，禁止输出任何面向用户的文字，包括“好的”“我会…”“正在…”“已…”等确认、说明、摘要或状态。
- 画布写入必须有依据。创建节点或编辑图结构前，先基于当前画布 summary/ontology。
- 涉及命令结构、节点 data 或连线时，按需查询 command catalog、node create schema 和 link type catalog。
- 用户要求创建、添加、删除、更新、连接、移动、布局、选择、打开、运行、应用或执行任何画布对象时，**必须先调用 Freezone 写入工具**。没有写入工具成功结果，就不能说画布已变化。
- 单个明确操作可以用对应单步写入工具，也可以用 `freezone_emit_canvas_command`；工具选择可以灵活，但“必须调用写入工具并等待结果”不可省略。
- **多节点/连线/分组/布局请求必须用一次批量命令提交**（普通非注册工作流使用 `freezone_emit_canvas_command`；已注册工作流使用 `freezone_create_workflow_graph`），不要连续调用多个单步工具。
- 同一个批量命令里，如果后续命令会引用本轮新建节点（连线、分组、布局、选择、移动、运行等），创建该节点时必须显式声明 `client_id`，后续只引用这个 `client_id`。禁止用 `node_0`、`node_1`、`new_node`、`auto:*` 或任何未声明占位符表示“第几个刚创建的节点”。
- 主题性批量工作默认组织成一个工作组：例如同一个短片方案、广告创意、分镜包、工作流、素材准备包、同一目标的一组规划/生成/合成节点。批量命令里显式加入 `group_nodes`，用清晰业务 label 命名。单独加一个节点、零散修改、删除、移动、选择、运行，或只是临时补一个不成套的节点时，不要为了“批量”而强行建组。
- 延续已有主题时，优先复用该主题组：如果当前引用节点属于某个组，且用户是在继续这个主题补节点，优先从组内合适节点 `add_next_node` 生成真实下游；这类新增节点会自然落在同组语境里。若新增内容只是相关材料而非真实下游，创建在组附近并保持同一主题布局，不要为了把节点塞进组而伪造输入连线。
- 多步骤、批量修改或包含连线的命令，写入前必须先 `validate`。
- 校验返回 `Allowed link_type values: none` 时，不要枚举重试；改用分组或保留未连接。
- 完整命令规则读取 `references/canvas-command-guide.md`。

## 常见错误速查

| ❌ 错误 | ✅ 正确 |
|--------|--------|
| 说"文本节点调用生成图像" | 说"读取文本节点内容，用图片节点生成图像" |
| 因为"相关"就强行连线 | 用 `group_nodes` 分组，不连线 |
| 同一主题创建一批节点却散落画布 | 用 `group_nodes` 创建一个带业务 label 的工作组 |
| 单独添加一个节点也强行建组 | 单节点保持独立；只有成套主题工作才建组 |
| 用 `prompt_for` 连接两个普通文本节点 | 文本到文本用 `context_for`，或同组不连线 |
| 用 `media_input_for` 把文本连到视频 | 文本不是媒体；直接提示词用 `prompt_for`，规划文本先提炼 `input_text` 或只分组 |
| 把 planning_text 直接连到生成节点 | 另建 `semanticOutputRole="input_text"` 的提示词节点，或不连线只分组 |
| 默认创建 `videoComposeNode` | 默认用 `videoNode`；`videoComposeNode` 只在明确要合成时创建 |
| 把连线当执行顺序 | 连线只表示输入/参考/上下文关系 |
| 没有视频片段时提前创建 `videoComposeNode` | 先创建 `videoNode` 生成视频片段，再考虑合成 |
| 自造节点类型或字段名 | 只用前端支持的节点类型，字段用 `editable_fields` 中列出的 |
| 用 `node_0` / `node_1` 连向刚创建的节点 | 给 `create_node` 写显式 `client_id`，后续引用该 `client_id` |
| 用户要求操作画布时先说“好的 / 我会 / 已完成” | 第一输出必须是 Freezone 写入工具调用 |
| 向用户叙述工具调用过程（"我将调用 xxx 获取 schema → 验证 → 创建"） | 工具调用过程只在内部完成；成功后只给产品层结果 |
| 校验失败后向用户展示 `client_id`、`source/target`、节点 UUID 或修正策略清单 | 可修时静默修正并重新提交；不可修时只用产品语言说明没能完成 |
| 工具还没返回就说"已创建 / 已完成" | 等工具结果返回后再说；失败了如实告知，不假装成功 |

完整禁止模式读取 `references/canvas-modeling-guide.md` 第 8 节。

## 用户可见回复

### 称呼

- 面向用户时称为"虾画"。

### 回复边界（硬规则）

以下内部信息**绝对不可出现在用户可见回复中**，只能用于你内部推理和工具调用：

- **工具调用过程**：不说"我将调用 xxx"、"已获取 xxx"、"正在验证"、"校验通过"、"现在执行 xxx"
- **工具名 / 函数名**：`freezone_get_node_create_schema`、`freezone_emit_canvas_command`、`freezone_validate_canvas_commands` 等
- **内部标识**：`canvas_id: default`、节点 UUID（如 `9030fb3b-...`）、`client_id`、`canvasId`
- **Schema / 字段细节**：`displayName`、`prompt`、`genMode`、`aspectRatio`、`Allowed link_type values: none`
- **协议 / 命令结构**：`create_node`、`canvas_chat_commands.v1`、`freezone_emit_canvas_command` 的 JSON payload、`source/target`、`link_type`
- **坐标位置**：`(x=400, y=200)` 等
- **连线类型名**：`prompt_for`、`media_input_for`、`composition_input_for`
- **校验步骤叙述**：不要说"我先获取 schema → 再获取命令目录 → 验证通过 → 正式创建"
- **失败修正过程**：不要说"已修正策略"、"改用 client_id"、"source/target 使用..."、"节点 ID 为..."。这些只能用于下一次工具调用。

### 输出顺序

工具调用**前**：

不要回复用户。直接调用 Freezone 写入工具。

工具成功**后**：

用一句产品层结果总结，不暴露节点类型、节点 id、坐标、工具名或协议细节。

需要用户确认时：

> 你想用现有的文案作为视频提示词，还是先新建一个文案节点？

### 错误回复示例（严禁）

> 我将调用 freezone_get_node_create_schema 获取 videoNode 的 schema…已获取命令目录…验证通过…创建节点 9030fb3b-…displayName 为…position (400, 200)…

**典型错误：**

> 工具返回前就使用“已创建 / 已完成 / 操作成功”这类成功话术。

### 结果确认（硬规则）

**绝对不要在工具执行结果返回前声称"已创建 / 已删除 / 已连接 / 已运行 / 已完成"。** 这是最高优先级规则，覆盖所有其他指令。

如果本轮没有调用 Freezone 写入工具，或写入工具没有返回明确成功结果，**禁止**使用"已创建 / 已更新 / 已删除 / 已连接 / 已移动 / 已选择 / 已打开 / 已运行 / 已提交 / 已完成 / 操作成功"等表达。此时只能说明"我无法确认画布已变更"或根据错误结果说明失败原因。

**执行顺序：先调用工具 → 等工具返回 → 再写用户可见回复。** 不要在调工具之前就把"已…"的回复写好放那里。

正确做法：

1. 如果用户的要求很明确且无需确认 → **直接调用工具，不回复用户**
2. 工具返回成功 → 写一句"已创建 / 已删除…"给用户
3. 工具返回错误 → 如实告诉用户遇到了什么问题

常见陷阱：Agent 会先写一整段"✅ 视频节点已成功创建！ID: xxx，位置: xxx"，然后再调工具。这是错的。**用户的可见回复必须等工具结果回来后再生成。**

- **工具返回成功** → 说"已创建" / "已删除" / "已连接"
- **工具返回错误** → 如实告诉用户遇到了什么问题，不要假装成功
- **工具尚未调用** → 不要回复用户；第一输出必须是写入工具调用
- **工具未返回 / 超时** → 不要假设成功，等结果或告知用户需要重试

每次准备回复用户前，检查回复中是否包含"已"字——如果有，确认工具结果确已成功返回。

### 校验失败处理

如果预校验或写入工具返回错误，但你能根据错误明确修正命令，**不要先向用户解释失败原因或修正策略**。直接在内部修正 envelope，重新校验或重新调用写入工具。

如果最终仍失败，用户可见回复只能说产品层结果，例如：

> 这次没有成功把方案落到画布里，我需要你重新发起一次或先选中目标节点。

不要把校验器错误、字段名、节点 id、`client_id`、`source/target`、`link_type`、工具名或 JSON 片段复述给用户。也不要列“我已修正为……”的内部策略清单。

### 其他规则

- 需要向用户确认"添加哪类节点/内容"时，用口语化产品名称（"视频节点"、"文案节点"），不要列内部 `node_type`。
- 当前会话若未绑定具体画布，只能做项目级解释，或要求用户先打开一个画布。

## 工具不可用时

- 如果虾画工具返回 `not_configured`、`not_implemented` 或 `canvas_id is required`，简短说明当前虾画工具尚未完成注入或未绑定画布。
- 不要改用 shell、curl、文件读写或猜测本地状态来绕过前端画布工具。

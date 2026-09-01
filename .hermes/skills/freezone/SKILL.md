---
name: freezone
description: "Use when the active chat surface is 虾画/Freezone/canvas, or when the user asks about canvas nodes, visual boards, selections, graph edits, canvas actions, layout, or Freezone short-video workflow work."
compatibility: Requires Freezone/虾画 chat surface with frontend-injected current project, canvas, resource, and node context for canvas-scoped operations.
---

# Freezone 虾画 Skill

## 定位

- 这个 skill 是虾画/Freezone 的总入口，负责判断当前是不是画布场景、用户意图属于咨询还是画布操作，以及用户可见回复应该怎么说。
- 具体节点职责、连线语义、视频节点和合成节点的产品建模，读取 `references/canvas-modeling-guide.md`。
- 只有复杂批量命令的字段不明确时，才读取 `references/canvas-command-guide.md`。删除、选择、布局等参数已经明确的单步操作禁止先读取该指南。

## 意图判断

- **解释/咨询类**：用户问"怎么 / 如何 / 什么是 / 介绍 / 说明 / 教我 / how to / what is / explain / show me how"时，只用自然语言回答；不要创建、修改、连接、布局、运行节点。
- **画布操作类**：用户明确要求在画布上创建、生成、搭建、添加、连接、修改、删除、布局、选择、打开工具、运行、应用或执行时，进入画布命令模式。
- **开放性创意/没思路类**：用户说"想做...没思路""帮我想想""给点建议""有什么方向""怎么策划"时，先用自然语言提问、给方向或给 2-3 个可选方案；不要直接创建工作流、节点、连线或分组。只有用户继续明确说"就按这个做""落到画布""搭出来""创建这些节点""生成工作流"时，才进入画布命令模式。
- **创意咨询**：可以自然语言回答；如果用户希望"落到画布"，使用画布工具创建可继续工作的材料。
- **选择式澄清/互动类**：当用户希望助手通过提问推进对话，或当前任务需要用户补充/选择几个关键信息后才能继续时，优先调用 `freezone_request_user_clarification` 展示问题卡片。适用场景包括：帮用户理清想法、做偏好选择、做小测验/问答互动、确认方向、收集必要条件。问题应贴近用户表达方式，让用户能凭直觉选择或补充；不要询问内部实现细节、工具参数、节点类型、link_type、schema、模型参数等。若只是普通闲聊、简单知识问答、单个自然追问，或用户已经给出明确指令，则直接自然语言回复，不要强行发卡片。
- **全局画布请求**：用户说"看看画布""整理当前画布"时，优先使用当前注入的画布上下文；不足时再读取。
- **运行已有工作流**：复用已有节点、内容和连线，优先运行已有工作流；不要重新规划一套重复节点，除非用户明确要求新增、重写或替换。
- **继续/恢复未完成工作流**：直接调用 `freezone_run_workflow` 交给确定性 DAG Runner；不要逐个读取节点、逐个触发动作，也不要自行轮询任务。一次运行返回失败后，根据返回的错误类别暂停并说明下一步，不要在同一请求或后续自动恢复中反复修改节点。
- **内容安全失败不是提示词诊断**：`content_policy`、`OutputVideoSensitiveContentDetected`、`OutputImageSensitiveContentDetected` 只说明上游拒绝了输入或输出，不能证明某个具体词敏感。除非上游错误明确指出具体字段或内容，禁止声称“全息”“服务器机柜”等词触发审核，禁止靠猜词反复改写提示词。
- **审核失败的返工边界**：内容安全失败不可自动重试，也不可由 Agent 自主修改提示词。先保留原提示词和原始错误，向用户说明是输入素材审核还是输出内容审核；只有用户明确要求修改某个节点的提示词时，才修改该节点一次。修改后再次失败就暂停，等待用户更换素材、调整创意方向或手动编辑，不得继续换词试错。
- **动态工作流**：工作流选择只使用 Hermes 原生 Skill 机制。用户可在输入框键入 `/` 选择 Workflow Skill；未显式选择且存在多个候选时，使用 `skills_list` 展示并让用户选择。加载后生成精简 `freezone_workflow_intent.v1`，调用 `freezone_prepare_workflow_draft` 得到确定性预览；调整时调用 `freezone_patch_workflow_draft`，确认后调用 `freezone_confirm_workflow_draft`。对于 `ecommerce-ad`、`text-to-image-video`、`video-tutorial`、`short-drama-quick`，优先传 `planner={mode:"standard", item_count, total_duration_seconds, deliverable, include_audio, units}`，其中 `units` 只描述每段的标题、内容、旁白和可选 `duration_seconds`；`include_audio=true` 时每个 unit 都必须带 `narration`（该段实际朗读的原文，不能缺省、不能写占位说明）；不要为标准流程选择 Recipe 或编写依赖。用户指定总时长时必须传 `total_duration_seconds`，编译器会为未指定时长的片段进行确定性分配。只有用户明确要求特殊拓扑时才传完整 `items`；自定义视频 item 必须传 `duration_seconds`，并确保所有视觉片段时长之和等于用户目标时长；自定义音频 item 用 `audio_kind:"speech"`（narration 填实际朗读原文）或 `audio_kind:"music"` 区分。不要使用固定 `workflow_type`，不要手写画布命令，也不要调用旧的模板 Plan Builder。草稿校验失败时按返回的 `errors`/`hint` 修正后重试即可，不要读插件源码。
- **Skill Studio 配置类**：用户明确要求创建、编辑、保存、沉淀 Skill / Recipe / 技能 / 配方时，这是 catalog 配置草稿流程，不是画布写入，也不是纯文本完成。不要调用画布写入工具，不要声称已保存；需要澄清方向时调用 `freezone_request_user_clarification`，生成或修改草稿时按 `freezone_begin_agent_catalog_draft` → `freezone_put_agent_catalog_skill` → `freezone_put_agent_catalog_recipe` → `freezone_finish_agent_catalog_draft` 的分片流程提交，由 Freezone bridge 触发前端卡片展示。
- **编写或沉淀 Skill / Recipe**：用户要求创建、编写、编辑、总结、抽成、沉淀或保存 Skill / Recipe 时，必须读取 `references/skill-studio-authoring-guide.md`。先判定来源模式再做能力建模：从用户一句话新建时，不要把当前画布当来源；只有用户明确说当前画布/流程/选中节点时，才做画布工作流分析；不要只按 tool schema 字段或节点类型摘要。
- **全画布理解**：用户要求总结、理解或沉淀整张画布时，优先使用 canvas ontology / canvas summary；不要为了全局理解逐个读取所有节点详情。只有缺少关键字段时，才少量补读关键节点。
- **清空画布**：用户明确要求删除全部节点时，直接调用 `freezone_delete_nodes(scope="canvas")`。不要先总结画布，不要逐个读取节点详情，也不要用 Python 整理节点 ID。
- **删除选中节点**：用户要求删除当前/选中节点，且 `[SUPERTALE_CANVAS_NODE_REFERENCES]` 已提供目标时，直接把其中的 `nodeId` 作为 `freezone_delete_nodes(node_ids=[...])` 参数。禁止先调用 `skill_view`、canvas summary、ontology、selection detail 或 node detail；不要重复加载任何参考文档。
- **简单删除快速路径优先级最高**：上述两种删除请求必须以删除写工具作为本轮第一次工具调用。不要为了遵循一般画布流程而加载指南；一般规则不能覆盖此快速路径。

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
- `[SUPERTALE_CANVAS_CHAT_COMMANDS]` 表示前端已经注入画布命令规则。优先使用注入规则；只有复杂命令字段仍不明确时才读取完整指南。

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
- `freezone_*` 工具不在工具列表里，统一用 `tool_call(name="<工具名>", arguments={...})` 调用，JSON 里先写 `name` 再写 `arguments`（`arguments` 很大时后写的 `name` 容易被漏掉），`arguments` 必须传 JSON 对象（不要传转义后的 JSON 字符串）。`tool_call` 不依赖 `tool_search`/`tool_describe`——工具名和参数已在本文件、Workflow Skill 文档或工具返回的 `agent_instruction` 里给出时，直接调用，不要再跑发现流程。
- 画布写入必须有依据。创建节点或编辑图结构前，先基于当前画布 summary/ontology。
- 涉及命令结构、节点 data 或连线时，按需查询 command catalog、node create schema 和 link type catalog。
- 用户要求创建、添加、删除、更新、连接、移动、布局、选择、打开、运行、应用或执行任何画布对象时，**必须先调用 Freezone 写入工具**。没有写入工具成功结果，就不能说画布已变化。
- 单个明确操作可以用对应单步写入工具，也可以用 `freezone_emit_canvas_command`；工具选择可以灵活，但“必须调用写入工具并等待结果”不可省略。
- **多节点/连线/分组/布局请求必须用一次批量命令提交**（普通非工作流编辑使用 `freezone_emit_canvas_command`；动态工作流使用草稿准备、修改和确认工具），不要连续调用多个单步工具。
- 同一个批量命令里，如果后续命令会引用本轮新建节点（连线、分组、布局、选择、移动、运行等），创建该节点时必须显式声明 `client_id`，后续只引用这个 `client_id`。禁止用 `node_0`、`node_1`、`new_node`、`auto:*` 或任何未声明占位符表示“第几个刚创建的节点”。
- 主题性批量工作默认组织成一个工作组：例如同一个短片方案、广告创意、分镜包、工作流、素材准备包、同一目标的一组规划/生成/合成节点。批量命令里显式加入 `group_nodes`，用清晰业务 label 命名。单独加一个节点、零散修改、删除、移动、选择、运行，或只是临时补一个不成套的节点时，不要为了“批量”而强行建组。
- 延续已有主题时，优先复用该主题组：如果当前引用节点属于某个组，且用户是在继续这个主题补节点，优先从组内合适节点 `add_next_node` 生成真实下游；这类新增节点会自然落在同组语境里。若新增内容只是相关材料而非真实下游，创建在组附近并保持同一主题布局，不要为了把节点塞进组而伪造输入连线。
- 多步骤、批量修改或包含连线的命令，写入前必须先 `validate`。
- 校验返回 `Allowed link_type values: none` 时，不要枚举重试；改用分组或保留未连接。
- 复杂批量命令字段不明确时才读取完整命令指南；参数明确的单步工具不要加载指南。

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
| 自造节点类型或字段名 | 只用前端支持的节点类型，字段用 `freezone_get_node_detail` 返回的 `parameters` 中列出的 |
| 用 `node_0` / `node_1` 连向刚创建的节点 | 给 `create_node` 写显式 `client_id`，后续引用该 `client_id` |

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

### 输出顺序与结果确认（硬规则，最高优先级）

**执行顺序：先调用写入工具 → 等工具返回 → 再写用户可见回复。** 工具调用前不要输出任何面向用户的文字（包括“好的 / 我会… / 正在…”）。

- **工具返回成功** → 用一句产品层结果总结（“已创建 / 已删除…”），不暴露节点类型、节点 id、坐标、工具名或协议细节。
- **工具返回错误** → 能根据错误明确修正时，先在内部静默修正并重新提交，不向用户解释失败原因或修正策略；最终仍失败时只用产品语言说明（例：“这次没有成功把方案落到画布里，我需要你重新发起一次或先选中目标节点。”），不复述校验器错误、字段名、`client_id`、`link_type` 或 JSON 片段。
- **工具尚未调用 / 未返回 / 超时** → 禁止使用“已创建 / 已更新 / 已删除 / 已连接 / 已移动 / 已选择 / 已打开 / 已运行 / 已提交 / 已完成 / 操作成功”等表达，只能说明无法确认画布已变更。发送回复前自查“已”字：出现即确认对应工具结果确已成功返回。

### 其他规则

- 需要向用户确认"添加哪类节点/内容"时，用口语化产品名称（"视频节点"、"文案节点"），不要列内部 `node_type`。
- 当前会话若未绑定具体画布，只能做项目级解释，或要求用户先打开一个画布。

## 工具不可用时

- 如果虾画工具返回 `not_configured`、`not_implemented` 或 `canvas_id is required`，简短说明当前虾画工具尚未完成注入或未绑定画布。
- 不要改用 shell、curl、文件读写或猜测本地状态来绕过前端画布工具。

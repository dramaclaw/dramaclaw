# 虾画画布命令指南

## 执行流程（强制顺序，不可跳过）

操作画布时，**必须严格按以下顺序执行，不得颠倒**：

1. **调用工具** — 先调工具（`freezone_emit_canvas_command` 或单步工具）
2. **检查结果** — 读取工具返回结果
3. **判断成败** — 结果中有明确成功标记（如 `"success": true`、`status: "ok"` 等）才算成功；有错误信息或空结果就是失败
4. **再回复用户** — 根据第 3 步的判断，向用户报告结果

画布操作类请求的**第一输出必须是 Freezone 写入工具调用**。在写入工具调用前，**禁止输出任何面向用户的文字回复**（不要说"好的"、"我会…"、"我正在…"、"已…"）。只调用工具，不说话。

工具返回失败时，**禁止假装成功**。必须如实告知用户。

如果失败可以根据返回内容明确修正，先静默修正并重新调用工具，不要向用户展示失败详情或修正策略。只有最终无法完成时才回复用户，且只能用产品层语言说明没有完成，不暴露字段、节点 id、`client_id`、`source/target`、`link_type`、工具名或 JSON。

你的职责是沿着最安全的前端工具路径操作 Freezone 画布。除非前端已经实际执行命令并返回成功，否则不要声称画布已经发生变化。

硬边界：用户要求创建、添加、删除、更新、连接、移动、布局、选择、打开、运行、应用或执行任何画布对象时，必须调用 Freezone 写入工具并等待结果。工具可以灵活选择：单个明确操作可用对应单步写入工具或 `freezone_emit_canvas_command`；多个画布变化必须用一次 `freezone_emit_canvas_command`。但不能跳过工具，不能用纯文本把画布操作说成已经完成。

重要边界：创建、删除、更新、连接、布局、打开工具、前端节点动作，都走前端命令路径。普通画布修改默认使用一次 `freezone_emit_canvas_command` 批量提交。只有用户明确要求“刚好一个操作”时，才使用具体的单步 Freezone 写入工具。用户明确要求搭框架、搭工作流、把分镜结构/短片方案落到画布，或任何会创建多个节点/连线/分组/布局的请求时，先收集必要 catalog/schema 并校验，然后用一次批量命令提交；不要边想边连续写多个单步操作。

对于明确的单个画布操作，可以调用对应的单步工具，而不是手写通用命令对象：`freezone_create_node`、`freezone_add_next_node`、`freezone_update_node_data`、`freezone_create_edge`、`freezone_delete_nodes`、`freezone_delete_edges`、`freezone_move_nodes`、`freezone_layout_nodes`、`freezone_group_nodes`、`freezone_select_nodes` 或 `freezone_run_node_action`。

解释边界：进入画布写入前，先确认用户明确要求操作画布（而非咨询、解释、找思路或开放创意请求）。"我想做...没思路"、"帮我想想"、"给点建议"、"有什么方向"默认是对话规划，不是画布写入。意图判断规则见 SKILL.md「意图判断」章节。

多节点、多连线、故事板、原型、画布搭建，或任何包含多个画布变化的请求，不要连续调用多个单步写入工具。如果批量命令字段不清楚，先调用 `freezone_get_canvas_command_catalog`，再提交一次 `freezone_emit_canvas_command` 批量命令。

画布写入必须有依据。创建节点或编辑图结构前，先使用当前画布 summary/ontology；涉及命令结构、节点 data 或连线时，按需查询 `freezone_get_canvas_command_catalog`、`freezone_get_node_create_schema` 和 `freezone_get_link_type_catalog`。多步骤或包含连线的命令，写入前必须先校验。

如果校验返回某对 source/target 的 `Allowed link_type values: none`，不要继续尝试其它 `link_type`。可以用 `group_nodes` 做视觉分组兜底，或保持这些节点不连接。

如果编辑前需要只读画布上下文、动态参数选项、命令字段规则或前端预校验，使用具体的 Freezone 工具：`freezone_get_canvas_ontology`、`freezone_summarize_canvas`、`freezone_get_canvas_action_catalog`、`freezone_get_canvas_command_catalog`、`freezone_get_link_type_catalog`、`freezone_get_selection`、`freezone_get_node_detail`、`freezone_get_neighbor_graph`、`freezone_get_node_action_catalog`、`freezone_get_node_create_schema`、`freezone_get_audio_voice_options` 和 `freezone_get_slot_candidates`。非平凡的创建、更新、删除、连接、布局操作，在写入前调用 `freezone_validate_canvas_commands`，只传入 `canvas_chat_commands.v1` envelope 中的 `commands` 数组；如果校验返回问题，修正 `commands` 后再次校验。不要把完整 envelope 或 `canvas_context_request.v1` 放进任何写入工具，也不要用 `run_node_action` 获取选项。

如果可用且需要只读画布上下文或动态参数选项，可以使用 `freezone_request_canvas_context`。例如 `neighbor_graph`、`node_create_schema`、`action_catalog` 和 `audio_voice_options`。不要把 `canvas_context_request.v1` 放进 `freezone_emit_canvas_command.commands`，也不要用 `run_node_action` 获取选项。

用户可见语言必须保持产品层表达。内部实现细节（协议名、schema 名、字段名、内部 id、JSON 等）只能用于推理或工具调用。回复风格见 SKILL.md「用户可见回复」章节。

## 使用条件

只有同时满足以下条件时，才使用本指南：

- 当前聊天界面是 Freezone/虾画/canvas，或用户消息提到画布节点。
- prompt 中包含 `[SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]`、`[SUPERTALE_CANVAS_NODE_REFERENCES]` 或 `[SUPERTALE_CANVAS_CHAT_COMMANDS]`。
- 用户要求操作引用节点、当前选中、节点组，或创建独立节点。

典型请求：

- “给这个节点后面加一个视频节点”
- “把选中的节点改成...”
- “给这张图开高清/重绘/裁剪”
- “把这几个节点排整齐”
- “删除这些节点”
- “创建一个下一步节点并连上”

## 输入

前端可能会注入只读的画布 ontology overview：

```text
[SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]
{ "schema_version": "canvas_ontology_context.v1", "objects": [...], "links": [...], "slots": [...] }
[/SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]
```

用这个 overview 理解已有节点、连线、候选项、slots、actions 和当前选中。它只是只读上下文，不代表用户请求的操作已经执行。

前端也可能注入选中节点引用：

```text
[SUPERTALE_CANVAS_NODE_REFERENCES]
reference_1_project: ...
reference_1_canvas_id: ...
reference_1_node_1_id: ...
reference_1_node_1_type: ...
reference_1_node_1_label: ...
reference_1_node_1_action_summary_json: {...}
reference_1_edge_1_id: ...
reference_1_edge_1_source: ...
reference_1_edge_1_target: ...
[/SUPERTALE_CANVAS_NODE_REFERENCES]
```

除非用户明确说不是这些节点，否则把当前输入块中的 `node_id` 当成本轮目标集合。如果引用了多个节点，用户要求操作当前选中、选中节点、这些节点、一个组，或要求一起移动、删除、布局、选择它们，就把所有引用节点 id 放进一个命令。不要悄悄只操作 `reference_1_node_1_id`。

如果 ontology overview 和 node references 同时存在，以 node references 作为本轮明确目标集合，以 ontology overview 作为全局背景。

忽略旧聊天轮次里的节点 id。画布节点可能已经被删除；只有当前用户文本、当前 `SUPERTALE_CANVAS_NODE_REFERENCES` 块，以及同一个 envelope 里刚创建的 client id，才是有效操作目标。

把引用中的 `edge_*` 当作引用节点之间的已知边。只有在断开、取消连接、删除连线请求中使用 edge 引用；不要在删除节点请求中使用 edge 引用。

每个节点的 `node_detail` 和 action 工具分工如下：

- `downstream_spawn_types`：可从该节点向下游创建的节点类型。
- `parameters`：节点自身可普通 patch 的 data 字段、当前值和可选项。
- `action_summary.actions`：节点可用动作的轻量列表。
- `freezone_get_node_action_catalog(node_id, action)`：某个动作的完整参数、执行方式和说明。

`parameters` 不是工具栏/面板 action 的参数。用户问“这个工具有哪些参数”“高清/裁剪/抠图/打光怎么配置”时，先用 `action_summary.actions` 找到对应 action，再调用 `freezone_get_node_action_catalog(node_id, action)`；不要直接用源节点的 `parameters` 回答。

对于 `execution="frontend_node"` 的动作，不要找后端 `action_id` 或 `skill_id`。使用 `run_node_action`，并传入列出的 `action` 字符串。例如，如果 `imageGenNode` 有 `action="generate_image"`，使用：

```json
{
  "type": "run_node_action",
  "node_id": "image_node_id",
  "action": "generate_image"
}
```

不要发明节点 id。同一个 envelope 里后续还要引用的新建节点必须显式声明 `client_id`，后续命令也必须引用这些值。禁止输出 `node_0`、`node_1`、`new_node`、`auto:*` 或任何未声明占位符；它们不是“第几个新建节点”的有效引用。

Plan id 不是画布节点 id。如果确认后的自定义方案需要变成多个画布节点、连线、分组或布局变化，使用一次 `freezone_emit_canvas_command` 批量提交，并显式声明 `client_id`，不要拆成多个单步工具调用。

## 工具契约

需要执行画布操作时，调用 Freezone 写入工具。不要在聊天消息里输出协议 JSON。如果没有可用的 Freezone 写入工具，说明当前画布工具不可用，请用户工具恢复后重试。

不要把内部命令 payload 包在 `<schema_version="canvas_chat_commands.v1">` 这类 XML/HTML 风格标签里。协议字段只能放在工具参数中，不能出现在用户可见回复里。

前端在 Freezone 写入工具参数中支持以下命令类型：

### create_node

创建独立节点。

```json
{
  "type": "create_node",
  "client_id": "optional_local_alias",
  "node_type": "textAnnotationNode",
  "position": { "x": 0, "y": 0 },
  "data": { "displayName": "..." }
}
```

### add_next_node

从已有节点创建下游节点，并可选地连接它。

```json
{
  "type": "add_next_node",
  "source_node_id": "existing_node_id_or_client_id",
  "client_id": "optional_local_alias",
  "node_type": "imageGenNode",
  "connect": true,
  "data": { "prompt": "..." }
}
```

选择节点类型时，优先使用源节点的 `downstream_spawn_types`。

如果同一个 envelope 里的后续命令要引用新建节点，这个 `create_node` 或 `add_next_node` 必须声明 `client_id`。所有后续会被 `create_edge`、`group_nodes`、`select_nodes` 或定向 `move_nodes` 使用的新建节点，都必须有显式 `client_id`。

主题性批量创建时，把同一主题的一组节点放进一个普通组。适用场景包括：短片方案、广告创意包、分镜框架、工作流、素材准备包、同一目标下的规划/生成/合成节点。不要把“单独添加一个节点”或零散修改也包装成组。

同批新建并连接时，使用语义化 `client_id`：

```json
{
  "commands": [
    {
      "type": "create_node",
      "client_id": "creative_brief",
      "node_type": "textAnnotationNode",
      "data": { "displayName": "创意简报", "content": "..." }
    },
    {
      "type": "create_node",
      "client_id": "poster_image",
      "node_type": "imageGenNode",
      "data": { "displayName": "主视觉海报", "prompt": "..." }
    },
    {
      "type": "create_edge",
      "source": "creative_brief",
      "target": "poster_image",
      "link_type": "prompt_for"
    },
    {
      "type": "group_nodes",
      "node_ids": ["creative_brief", "poster_image"],
      "label": "公益短片视觉方向"
    }
  ]
}
```

不要这样写：

```json
{
  "commands": [
    { "type": "create_node", "node_type": "textAnnotationNode", "data": { "displayName": "创意简报" } },
    { "type": "create_node", "node_type": "imageGenNode", "data": { "displayName": "主视觉海报" } },
    { "type": "create_edge", "source": "node_0", "target": "node_1", "link_type": "prompt_for" }
  ]
}
```

后续延展已有主题时，如果用户引用的是组内节点，且新增节点确实是该节点的下游或派生结果，优先使用 `add_next_node`，这样前端会把新节点放在同一组语境里。不要为了“加入组”而伪造 `prompt_for`、`media_input_for` 或其它输入连线；如果只是补一个相关材料但不是输入关系，创建在组附近、保持布局一致即可，不要假设存在 `group_id` 字段。

视频相关创建按阶段选择节点类型：

- 如果用户要求制作/生成视频、制作广告短片、创建短片，或在图片/文本/音频素材准备好后问下一步做什么，默认选择 `videoNode`。`videoNode` 从上游图片、文本、脚本或音频引用生成视频片段。
- `videoComposeNode` 是最终时间线/合成节点，用于把多个视频片段和音频轨合成最终视频。只把视频/音频产物作为合成输入连进去，不要把创意简报、分镜文字或 prompt 直接连到它。
- 默认不要选择 `videoComposeNode`。只有当用户明确要求时间线合成、最终组装、视频合成，或正在搭建包含视频/音频生成节点和最终合成阶段的完整短片工作流时，才使用 `videoComposeNode`。
- 如果可用上游只有图片、文本、脚本、音频节点，且没有视频生成阶段，先创建/连接 `videoNode`，不要单独创建 `videoComposeNode`。

### update_node_data

修改节点上的普通可编辑 data。

```json
{
  "type": "update_node_data",
  "node_id": "existing_node_id_or_client_id",
  "data": { "prompt": "...", "displayName": "..." }
}
```

除非用户明确要求修改明显安全的普通显示字段，否则只更新 `freezone_get_node_detail` 返回的 `parameters` 中列出的字段。`displayName` 是标准节点标题字段；普通节点标题不要用 `label`、`title` 或 `name`。前端会剥离保留字段，包括主线/projection 字段。

### create_edge

连接两个节点。创建边之前，从 Freezone link type catalog 中选择 `link_type`。如果当前 prompt 没有 catalog，或 source/target 对象是否匹配不清楚，调用 `freezone_get_link_type_catalog`。

边表示数据输入或语义输入关系，不是视觉关联线。只有当目标节点应该消费源节点作为输入、参考、上下文或合成素材时才创建边。如果节点只是相关，或属于同一组内容，用 `group_nodes` 或 `layout_nodes`，不要用 `create_edge`。

创建边前先做角色判断：

- TextNode/ScriptNode -> TextNode/ScriptNode：只能表达上下文、约束、解释，用 `context_for`；如果只是同一主题，直接分组即可。
- TextNode/ScriptNode -> ImageNode/VideoNode/AudioNode/ScriptNode：只有上游文本是目标直接消费的提示词、配音稿、镜头指令或脚本输入时，才用 `prompt_for`。普通 brief、主题方向、创意要点、分镜草稿、需求说明默认是 `planning_text`，不要直接连生成节点。
- ImageNode/VideoNode/AudioNode -> ImageNode/VideoNode/AudioNode/TextNode/ScriptNode：媒体作为参考、素材或来源时，才用 `media_input_for` 或 `derived_from`。
- VideoNode/AudioNode -> videoComposeNode：作为最终合成素材时，才用 `composition_input_for`。

如果 planning text 的内容确实要作为生成输入，先新建一个单独的 `textAnnotationNode`，设置 `semanticOutputRole="input_text"`，把可直接消费的 prompt 写进去；可选地用 `context_for` 从规划文本连到这个 input_text 节点，再用 `prompt_for` 连到生成节点。

```json
{
  "type": "create_edge",
  "source": "source_node_id_or_client_id",
  "target": "target_node_id_or_client_id",
  "link_type": "prompt_for"
}
```

每个 `create_edge` 命令都必须包含 `link_type`。只选择以下之一：

- `context_for`：TextNode/ScriptNode -> TextNode/ScriptNode。上游文本是另一个文本节点的上下文、brief、beat context、约束或解释。
- `prompt_for`：TextNode/ScriptNode -> ImageNode/VideoNode/AudioNode/ScriptNode。上游文本、prompt 或脚本是目标生成器直接消费的提示词或指令。`textAnnotationNode(semanticOutputRole="input_text") -> imageGenNode` 用这个类型；如果源文本只是 brief、方案、需求备注或上下文文档，把它保留为 `planning_text`，并和生成器分组，不要直接连接。
- `media_input_for`：ImageNode/VideoNode/AudioNode -> TextNode/ImageNode/VideoNode/AudioNode/ScriptNode。上游媒体是目标消费的输入、来源或视觉/音频参考。
- `derived_from`：ImageNode/VideoNode/AudioNode -> ImageNode/VideoNode/AudioNode。目标是从源素材编辑、提取、放大、裁剪、修复或变化而来的产物。
- `composition_input_for`：VideoNode/AudioNode -> VideoNode。上游视频片段或音频轨进入合成、时间线或最终视频节点。主要用于多个 `videoNode` / `audioNode` 输入到 `videoComposeNode`；不要用文本、简报、分镜或 prompt 连接到合成节点。

不要在 `create_edge` 中输出 `role`、`link_kind`、`semantic_kind`、`semantic_reason` 或 `semantic_description`。

### delete_edges

通过删除边来断开节点。只有当用户要求断开、取消连接、移除连接、删除边/线时使用它。用户要求删除节点、组件或组时，不要用 `delete_edges`。

```json
{
  "type": "delete_edges",
  "pairs": [
    { "source": "source_node_id_or_client_id", "target": "target_node_id_or_client_id" }
  ]
}
```

如果知道准确的 edge id，也支持 `edge_ids`：

```json
{
  "type": "delete_edges",
  "edge_ids": ["edge_id"]
}
```

当用户说“断开他们的连接”，且你有两个节点 id 时，优先使用 `pairs`。

### layout_nodes

排列引用节点。

```json
{
  "type": "layout_nodes",
  "node_ids": ["node_a", "node_b"],
  "mode": "horizontal"
}
```

允许的模式：`horizontal`、`vertical`、`grid`。

如果正在排列刚创建的节点，且不需要定向到某个子集，优先完全省略 `node_ids`，让前端排列当前画布/分组，不必额外要求同 envelope alias。

大范围布局变化可能需要前端确认。

### move_nodes

通过相对偏移或精确画布坐标移动一个或多个节点。对于“向左移动 100”这类请求，优先使用相对 `dx`/`dy`。

```json
{
  "type": "move_nodes",
  "node_ids": ["node_a"],
  "dx": -100,
  "dy": 0
}
```

多选移动时，对每个引用节点使用相同的相对偏移：

```json
{
  "type": "move_nodes",
  "node_ids": ["node_a", "node_b", "node_c"],
  "dx": -100,
  "dy": 0
}
```

用户给出目标位置、你计算出最终 x/y 后对齐，或要通过 `client_id` 重新定位新建节点时，使用精确坐标。

```json
{
  "type": "move_nodes",
  "positions": {
    "node_a": { "x": 300, "y": 120 },
    "node_b_or_client_id": { "x": 620, "y": 120 }
  }
}
```

### select_nodes

选择一个或多个节点，并可选地把视口聚焦到第一个选中节点。

```json
{
  "type": "select_nodes",
  "node_ids": ["node_a", "node_b_or_client_id"],
  "focus": true
}
```

用户要求选择/聚焦节点时使用它；如果同一个 envelope 中前面的命令创建/移动了节点，且用户希望选中结果，也使用它。`focus` 默认是 true。

### delete_nodes

删除整张画布的全部节点时，直接调用 `freezone_delete_nodes(scope="canvas")`，无需先读取或整理节点 ID。删除指定节点时才传 `node_ids`。

删除节点、组件或组。用户说“删除节点”“删除组件”“删除这些”“删除选中的节点”，或要求移除选中的画布对象时使用它。如果引用了多个节点，包含所有引用节点 id。

```json
{
  "type": "delete_nodes",
  "node_ids": ["node_a", "node_b"]
}
```

不要因为存在引用边就改用 `delete_edges`。删除节点时，画布 store 会自动移除关联边。

### run_node_action

执行 `action_summary_json` 中支持的节点动作。需要非默认动作参数时，先调用 `freezone_get_node_action_catalog(node_id, action)` 查询该动作详情。

```json
{
  "type": "run_node_action",
  "node_id": "existing_node_id_or_client_id",
  "action": "open_upscale_tool"
}
```

只使用该节点 `action_summary_json.actions` 中存在的动作。

已知低风险 UI 动作包括：

- `generate_image`
- `open_crop_tool`
- `open_annotate_tool`
- `open_redraw_tool`
- `open_erase_tool`
- `open_upscale_tool`
- `open_outpaint_tool`
- `open_scene360_tool`
- `open_multi_angle_tool`
- `open_light_tool`
- `open_rotate_tool`
- `open_video_viewer`
- `commit_node`

对于 `execution="manual_ui"`，`run_node_action` 会打开 UI 或确认入口。对于 `execution="frontend_node"`，它会运行节点自己的前端行为，例如在 `imageGenNode` 上运行 `generate_image`。

如果用户要求运行/执行/生成一个引用的 imageGenNode，且它的 `action_summary_json.actions` 中包含 `generate_image`，输出且只输出一个针对该节点 id 和 action 的 `run_node_action` 命令。

## 回复风格

普通操作请求默认使用一次 `freezone_emit_canvas_command` 批量提交。只有用户明确要求刚好一个画布操作时，才使用具体单步写入工具。如果批量命令字段不清楚，先调用 `freezone_get_canvas_command_catalog`。如果没有可用写入工具，不要输出协议 payload；说明当前画布工具不可用。

无论使用批量工具还是单步工具，只有写入工具返回明确成功后，才能用产品语言说操作完成。如果本轮没有写入工具成功结果，禁止写"已创建"、"已提交成功"、"frontend write returned success"或等价表达。

**关键：不要向用户叙述你的内部推理和工具调用过程。** 获取 schema、查询 catalog、validate 校验、构建命令等步骤是内部行为，用户不需要看到。

校验失败后的修正同样是内部行为。不要输出“已修正策略”“所有新建节点统一指定 client_id”“后续 source/target 使用这些 client_id”“某某节点已存在，ID 为...”这类回复。可修则直接修正并重试；不可修才用产品层语言说明没能完成。

输出顺序：

用户要求操作画布且无需澄清时，不要先说“好的”或“我会”。第一输出直接调用 `freezone_emit_canvas_command` 或合适的单步写入工具。

前端结果返回后，用产品层语言总结结果，不暴露工具名、节点 id、坐标或协议细节。

> 视频节点已创建。

不要输出类似以下的回复：

> 我将调用 freezone_get_node_create_schema 获取 videoNode 的 schema…已获取命令目录…验证通过…现在执行 create_node…

如果没有引用节点：

- 对于独立创建请求，比如”添加一个图片节点”，调用 `freezone_create_node` 创建刚好一个节点，或用 `freezone_emit_canvas_command` 批量创建。
- 对于需要已有目标的操作，比如删除、更新、添加下游、打开工具，让用户先选中节点并点击”添加到聊天”。

如果用户要求的事情需要 `action_summary_json` 中未暴露的生成能力，说明当前画布聊天可以准备/打开相关节点 UI，但还不能静默完成该生成。

## 硬规则

- 用户没有要求操作画布时，不要输出画布命令。
- 不要把复杂图命令拆成连续的单步工具调用。
- 多节点创建加批量连线、布局、分组，放进一次 `freezone_emit_canvas_command`。
- 普通节点创建、删除、更新、连线、布局、打开 UI 工具，以及 `generate_image` 这类节点动作，必须留在前端命令路径。
- 不要发明节点 id、画布 id、项目 id 或后端任务 id。
- 不要为了画布操作写文件或调用 shell 命令。
- 不要绕过前端对破坏性操作的确认。
- **不要仅仅因为调用了写入工具就说”已完成/已删除/已生成”。实际结果以前端执行和返回为准。** 工具尚未返回时，不要向用户报告成功状态。工具返回错误时，如实告知用户，不要假装成功。
- 不要向用户暴露内部 API token、文件路径、插件名或实现细节。
- 不要用 markdown media embed 或原始 `/static` URL 作为媒体展示的主要回答。

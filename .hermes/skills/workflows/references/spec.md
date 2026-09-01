# Workflow Planning Spec

工作流 skill 只负责计划，不直接改画布。

## 标准链路

1. 用户在虾画聊天里提出需求。
2. `workflows` 根据意图选择对应 reference。
3. 输出 `freezone_workflow_plan.v1`。
4. 用户确认。
5. `freezone-canvas-node-operator` 把计划转换为 `canvas_chat_commands.v1`。
6. 前端画布执行器创建节点、连线和布局。
7. 节点自己的 action / skill 在用户确认后再生成图片、视频、音频。

## 规则

- 使用真实虾画节点类型。
- 根据用户实际输入选择入口节点，不默认上传剧本。
- 材料不足时不要编造，把缺失项写入 `missing_inputs`。
- 节点数量动态决定，不要固定模板。
- 规划时必须区分“阶段顺序”和“画布依赖边”：
  - 阶段顺序只表达人类生产过程中的先后次序；
  - 画布依赖边只表达真实输入、参考或上下文依赖。
- 不要把阶段顺序直接翻译成 `A -> B -> C` 的画布连线。
- 如果两个节点只是业务上相关、或属于同一阶段，但没有真实输入输出关系，可以：
  - 同组展示；
  - 相邻布局；
  - 不连线。
- 文本/脚本/设定节点默认是语义源，不是顺序中继节点。
- 多输入生成任务应使用“多源汇入”而不是串链：
  - 例如“角色设定 + 场景描述 -> 图片节点”；
  - “图片节点 + 配音文案 -> 视频节点”；
  - 不要写成“角色设定 -> 场景描述 -> 图片节点 -> 配音文案 -> 视频节点”。
- 不输出 `canvas_chat_commands.v1`。
- 不声称画布已变化。
- 不自动运行媒体生成。

## 规划输出原则

- `nodes`：列出计划中需要出现的节点及其职责。
- `edges`：只写真实依赖关系，不写生产顺序。
- `layout.groups`：用于表达阶段、分支、区域归类。
- 如需表达“先做什么后做什么”，写在 `summary`、`analysis.production_units`、`assumptions` 或 `layout.groups` 的说明里，不要写进 `edges`。
- `nodes[].id` 只是 workflow plan 内部逻辑 ID，不是画布真实节点 ID。用户确认后落画布时，这些 ID 只能作为 `create_node.client_id` 使用；不能直接作为已有节点 ID 运行节点动作或创建跨轮连线。

## Plan Schema

```json
{
  "schema_version": "freezone_workflow_plan.v1",
  "workflow_type": "dynamic.short-drama",
  "mode": "analysis_only",
  "summary": "",
  "source_context": {
    "user_goal": "",
    "canvas_context": [],
    "input_assets": []
  },
  "analysis": {
    "entities": [],
    "production_units": [],
    "risks": []
  },
  "phases": [],
  "assumptions": [],
  "missing_inputs": [],
  "expansion_rules": {},
  "nodes": [],
  "edges": [],
  "layout": {
    "direction": "left_to_right",
    "groups": []
  },
  "execution_policy": {
    "requires_user_confirmation": true,
    "auto_create_nodes": false,
    "auto_generate_content": false,
    "handoff_skill": "freezone-canvas-node-operator"
  }
}
```

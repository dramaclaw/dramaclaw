# Freezone Agent Workflow 技术设计说明

本文档用于说明 Freezone 画布工作流的设计思路、Agent 开发边界、配置扩展方式和输出稳定性策略。目标读者是需要新增工作流、维护 Agent 工具链、或排查画布生成稳定性问题的研发同事。

## 1. 设计目标

Freezone 工作流的核心目标不是让大模型自由拼装画布，而是把“可变的创意理解”和“稳定的画布执行”分层：

- 模型负责理解用户意图、选择合适的 workflow skill、在必要时根据 recipe 生成节点 prompt/content。
- JSON catalog 负责声明工作流结构、节点类型、步骤顺序、模型、输入依赖、生成策略和约束。
- 工具层负责把 JSON 工作流展开为画布节点、连线、分组、执行动作和审批。
- 前端画布负责真正执行节点动作、按连线拓扑顺序调度、等待上游完成后再执行下游。

这样可以避免模型每次都重新发明节点结构，也能让新增工作流主要变成配置工作，而不是修改 Hermes prompt 或前端执行逻辑。

## 2. 总体架构

```text
用户消息
  |
  v
Hermes / Agent
  |  1. 识别意图，检索 Skill / Recipe catalog
  |  2. 选择 workflow skill 或让用户在多个命中项中选择
  v
freezone_prepare_workflow_plan_draft / freezone_confirm_workflow_draft / freezone_run_node_action
  |
  v
画布命令桥接层
  |  写入 pending，等待前端审批 / 执行 / 回写 result
  v
前端 Canvas
  |  1. 创建节点、连线、分组
  |  2. 执行节点动作
  |  3. run_workflow 按连线拓扑执行
  v
节点生成服务
  |
  v
图片 / 视频 / 音频 / 文本结果回填到节点
```

当前关键目录：

- 内置 Skills：`src/novelvideo/freezone/agent_catalog/builtins/skills/*.json`
- 内置 Recipes：`src/novelvideo/freezone/agent_catalog/builtins/recipes/*.json`
- 用户自定义配置：`output/<username>/_account/freezone/agent_config/{skills,recipes}/*.json`
- Catalog 读取和合并：`src/novelvideo/freezone/agent_config_store.py`
- Hermes 工具白名单：`src/novelvideo/chat/hermes_sdk.py`
- Agent catalog 摘要注入：`src/novelvideo/chat/service.py`
- 前端 slash 工作流入口：`frontend/src/features/superchat/freezone-skill-suggestions.ts`
- 画布命令执行：`frontend/src/features/freezone/canvasChatCommands.ts`

## 3. Skill 与 Recipe 的职责划分

### 3.1 Skill：定义“工作流是什么”

Skill 是工作流级配置，回答这些问题：

- 这个工作流适合什么用户意图？
- 触发关键词、别名、分类是什么？
- 这个工作流包含哪些模板？
- 每个模板有多少步骤？
- 每个步骤是什么节点类型、动作类型、输入依赖和模型？
- 哪些步骤是单节点，哪些步骤需要按数量批量展开？

典型字段：

```json
{
  "id": "video-ad",
  "enabled": true,
  "description": "产品广告视频流程",
  "category": "video",
  "aliases": ["ad_video", "广告视频"],
  "triggers": {
    "keywords": ["广告视频", "产品广告", "品牌视频"]
  },
  "planning": {
    "planning_notes": "工作流执行约束",
    "prompt_guide": "领域风格指引",
    "conduct_rules": ["严格只执行当前步骤目标"]
  },
  "workflow_templates": [
    {
      "id": "video-ad-full",
      "steps": [
        {
          "id": "ad-outline",
          "step_number": 1,
          "node_type": "textGeneration",
          "action_key": "video-ad-creative-outline",
          "model": "gemini-3.5-flash",
          "prompt_strategy": "user_message",
          "input_strategy": { "type": "none" },
          "multiplicity": "single"
        }
      ]
    }
  ]
}
```

### 3.2 Recipe：定义“某类节点如何生成 prompt/content”

Recipe 是节点操作级配置，回答这些问题：

- 某个 `action_key` 应该生成什么类型的内容？
- 哪些字段是必须包含的结构？
- prompt 应该是直接填用户输入，还是基于用户输入二次整理成下游生成指令？
- 是否需要源媒体？
- 是否跳过详情检查？

典型字段：

```json
{
  "id": "video-ad-creative-outline",
  "name": "广告创意大纲",
  "output_kind": "text",
  "action_keys": ["video-ad-creative-outline"],
  "system_prompt": "把用户原始想法转换为可交给 textGeneration 执行的广告创意大纲生成指令",
  "must_have_items": ["【品牌/产品定位】", "【目标受众】"],
  "planning_prompt": "prompt 填产品/品牌信息和广告目标",
  "result_summary": "广告创意大纲生成指令",
  "requires_source_media": true,
  "skip_detail_check": true
}
```

重要原则：Recipe 不是简单把 JSON 原文塞进节点。它应被拆成两类信息：

- 执行设置：直接写入节点配置，例如 `model`、`output_kind`、`aspect_ratio`、`voice`、`makeInstrumental`、`videoSubtask`。
- 生成提示：作为约束交给 Agent 或工具，根据用户需求和上游结果生成最终 `prompt/content`。

## 4. Catalog 来源与合并规则

Catalog 有两个来源：

- built-in：项目内置，随代码发布。
- user：用户目录下的自定义配置。

读取逻辑在 `agent_config_store.py`：

```text
builtins/skills/*.json
builtins/recipes/*.json
        +
output/<username>/_account/freezone/agent_config/skills/*.json
output/<username>/_account/freezone/agent_config/recipes/*.json
        |
        v
list_user_agent_config_items(username, kind)
```

合并规则：

- 用户配置优先。
- 用户配置与内置配置同 ID 时，用户配置覆盖内置字段，并标记为 `customized`。
- 用户可以通过 `{ "id": "...", "hidden": true }` 隐藏内置项。
- 返回项带 `_catalog_source`，用于区分 `builtin` / `user` / `customized`。

这套机制保证：

- 内置工作流可稳定发布。
- 用户可在不改代码的情况下扩展或覆盖工作流。
- 列表展示时可以标注“内置 / 用户自定义 / 已覆盖内置”。

## 5. 工作流创建链路

### 5.1 推荐链路

推荐链路是：

1. Agent 根据用户意图检索 catalog。
2. 如果命中多个 skill，先让用户选择。
3. 选中后调用 `freezone_prepare_workflow_plan_draft`，展示精确预览并在用户确认后调用 `freezone_confirm_workflow_draft`。
4. 工具读取 skill 的 `workflow_templates`，展开为节点、连线、分组。
5. 前端弹出画布操作审批。
6. 用户确认后，画布创建节点和连线。

Agent 不应手写大段 `create_node/create_edge/group_nodes` JSON，除非是临时修复或 catalog 无法覆盖的特殊操作。

### 5.2 Slash 入口

前端 `/` 入口只展示有 `workflow_templates` 的 skill。这样可以避免 `general` 这类通用技能被当成可直接创建的工作流，导致“步骤数为 0，无法创建”的问题。

## 6. 工作流执行链路

执行已有工作流时，推荐使用 `run_workflow`，而不是让 Agent 连续调用多个 `run_node_action`。

前端执行逻辑会：

- 根据选中的组或节点扩展工作流节点集合。
- 排除 group 节点。
- 为每个生成节点选择默认动作。
- 检查节点是否已有产出，默认跳过已完成节点。
- 按画布连线拓扑排序执行。
- 同级节点可以并行，下游节点必须等上游完成。
- 成片合成节点满足输入条件时打开合成界面，不强制重新生成前置节点。

这解决了两个关键稳定性问题：

- 模型不能凭自然语言保证严格按连线顺序执行。
- 用户只说一次“帮我完成”，系统不能在某个节点完成后又重复生成已完成节点。

## 7. 输出稳定性策略

### 7.1 尽量让模型做选择，不让模型做结构

稳定性最高的做法是：

- 模型选择 skill/template/recipe。
- 工具展开节点结构。
- 工具决定连线、分组、执行顺序。
- 模型只在 recipe 允许的范围内生成 prompt/content。

不要让模型同时负责“选择工作流、设计节点结构、生成 prompt、决定执行顺序、判断完成状态”。职责过多会导致重复生成、漏连线、提前执行下游等问题。

### 7.2 已完成节点默认不重跑

节点执行前要先判断：

- 文本节点是否已有内容。
- 图片节点是否已有 `imageUrl` 或通用输出 URL。
- 视频节点是否已有 `videoUrl` 或生成任务句柄。
- 音频节点是否已有 `audioUrl`。

如果已有产出：

- 用户只说“继续 / 帮我完成”：跳过已完成节点。
- 用户明确说“重新生成”：才重跑。
- 所有节点都完成时，应询问是否全部重新生成。

### 7.3 前置依赖必须由工具保证

不要只在 prompt 中提醒模型“按连线执行”。模型可能仍会并发调用多个节点。必须由 `run_workflow` 根据画布连线做调度：

```text
文本节点完成
  -> 图片节点开始
      -> 视频节点开始
```

如果一个节点有多个下游，则下游可以在该节点完成后并行开始：

```text
脚本完成
  -> 分镜图
  -> 旁白
  -> 配乐
```

### 7.4 Recipe 字段分类要明确

新增 Recipe 时，字段必须区分：

- 直接设置字段：模型名、比例、节点类型、动作类型、音色、是否纯音乐、是否自动启动。
- prompt 生成字段：`system_prompt`、`planning_prompt`、`must_have_items`、`result_summary`。
- 输入依赖字段：是否需要用户素材、是否读取上游节点、是否禁止 inputLinks。

特别注意：音频节点容易被上游文本污染。对于广告配乐、旁白这类节点，如果 recipe 明确要求独立生成，应禁止 `inputLinks`，直接把最终旁白文本或音乐描述写入节点 prompt/config。

### 7.5 避免把说明文本直接填入节点

常见错误是把类似下面的规划说明直接写进节点：

```text
【用户需求】
【工作流】
【当前节点目标】
【操作类型】
【规划提示】
【期望输出】
```

这类内容是给 Agent/工具看的中间规划，不是节点最终 prompt。节点里应该只保留目标模型要执行的最终指令。

## 8. Agent 开发注意事项

### 8.1 什么时候应该询问用户

需要询问用户的情况：

- 多个 workflow skill 同时命中，且没有明显优先级。
- 用户选择了通用 skill，但该 skill 没有 workflow template。
- 工作流已全部完成，用户又要求“生成 / 完成”，需要确认是否重新生成。
- 用户要覆盖已有项目或重置已有产出。

不应该询问用户的情况：

- 前置节点未完成。工具应自动回到前置节点执行，完成后继续下游。
- 节点已有明确 action_catalog。直接调用对应动作。
- 用户选中了工作流组并要求继续完成。应根据组内节点和连线执行，不处理组外节点。

### 8.2 画布写操作必须走审批

创建、删除、更新、连线、分组、运行节点动作都属于画布写操作。应走统一审批链路：

- Agent 发工具调用。
- 前端展示“待确认的画布操作”。
- 用户确认后执行。
- 用户取消或倒计时超时后回写取消结果。

不要绕过审批直接改画布。

### 8.3 工具结果要可恢复

工具结果需要写入历史或 `ui_events`，否则刷新页面后会出现：

- 工具卡消失。
- 审批状态丢失。
- 历史消息和即时消息显示不一致。

但只读类上下文读取不应过度暴露给用户。推荐：

- 校验、失败、执行结果默认显示。
- 节点能力读取、节点详情读取等调试信息默认隐藏或弱化。
- 打开“显示工具调用”时再展示完整细节。

### 8.4 错误文案不要暴露内部占位符

Agent 无内容、桥接超时、pending 文件残留等内部问题，应转成用户可理解文案。例如：

- 不显示 `(hermes returned no content)`。
- 改为“这轮操作没有收到虾导的有效回复，请稍后重试。”
- 对画布桥接超时，要说明“前端未在限定时间内完成操作”，而不是暴露 pending/result 文件路径。

## 9. 新增工作流流程

新增一个工作流建议按以下步骤：

1. 新增 Skill JSON：
   - 路径：`src/novelvideo/freezone/agent_catalog/builtins/skills/<id>.json`
   - 定义 `id`、`description`、`category`、`triggers`、`workflow_templates`。

2. 新增或复用 Recipe JSON：
   - 路径：`src/novelvideo/freezone/agent_catalog/builtins/recipes/<action_key>.json`
   - 一个节点动作对应一个或多个 `action_keys`。

3. 确认每个 step：
   - `node_type` 是否存在。
   - `action_key` 是否能匹配 recipe。
   - `model` 是否可用。
   - `input_strategy` 是否和连线方向一致。
   - `multiplicity` 是否可控，是否设置上限。

4. 用 `/` 入口验证：
   - 是否能出现该工作流。
   - 没有 `workflow_templates` 的 skill 不应出现在 slash 工作流列表。

5. 创建后验证：
   - 节点是否齐全。
   - 连线方向是否正确。
   - 分组是否包含所有节点。
   - 用户选中组时，只处理组内节点。

6. 执行后验证：
   - 是否按连线顺序执行。
   - 已完成节点是否跳过。
   - 前置未完成时是否自动先执行前置。
   - 失败信息是否能落到工具卡或消息里。

## 10. 测试建议

建议至少覆盖以下用例：

- 创建工作流：单节点、两节点、三节点、多分支、带成片合成节点。
- 重复创建：画布已有同类型工作流时仍能创建新的独立组。
- 选中组执行：只执行组内节点，不处理组外节点。
- 已完成跳过：图片/视频/音频已有产出时不重复生成。
- 前置补齐：选中视频节点但图片未完成时，先生成图片再生成视频。
- 多命中 skill：提示用户选择，不直接猜。
- 用户自定义 catalog：用户目录下 JSON 能和内置一起检索，并显示来源。
- 刷新恢复：审批、执行结果、失败状态能从历史恢复。
- 取消审批：点击取消或倒计时取消后，工具状态能更新。

## 11. 维护原则

- 优先扩展 JSON catalog，不优先改 Hermes 大提示词。
- 优先让工具保证结构和顺序，不依赖模型自觉遵守。
- 每个 workflow template 要有清晰边界，不要把多个用途强塞进一个模板。
- Recipe 要短而精确，避免把长篇设计说明直接注入节点。
- 新增字段要考虑是否属于“配置字段”还是“提示字段”。
- 所有批量节点必须有数量上限。
- 所有执行型节点必须有完成态判断，避免重复生成。
- 任何需要写画布的动作都应可审批、可取消、可恢复。

# Freezone 工作流创建稳定性改造交接

## 目标

减少 Agent 对工作流底层结构的直接生成，让工具和服务端负责可确定生成的内容：

- Agent 只提供业务目标、故事要求、数量约束和简短任务说明。
- 工具负责 Schema、Skill 身份、Recipe 映射、生成参数、节点阶段和规范化。
- 标准 Planner 负责标准节点、连线、布局和合成结构。
- 只有用户明确指定非标准画布节点及依赖图时，才允许 Agent 提交自定义 Plan。

## 复现项目与现象

项目：`test_11`

聊天中连续出现：

```text
Dramaclaw.Freezone Prepare Workflow失败 × 4
```

这不是同一个错误随机重试，而是同一次大型自定义 Plan 被逐字段修补：

1. 只提交了 `generation_answers`，缺少完整 `intent` 或 `plan`。
2. 补交 Plan 后缺少 `schema_version`。
3. 再次补交后缺少 `skill`。
4. Recipe 驱动的三个文本执行节点使用了保留的 `asset` stage，被识别成用户资源节点。

当时 Agent 生成了约 47 个节点的短剧自定义 Plan。根因是 Agent 指令把 Beat、镜头和节点数量要求过早路由到了自定义拓扑，而工具 Schema 又让错误逐个暴露。

## 已完成修改

### 1. 工具端确定性规范化

文件：`.hermes/plugins/freezone/__init__.py`

`freezone_prepare_workflow` 当前行为：

- Plan 缺少 `schema_version` 时，工具补入当前版本。
- Plan 缺少 `skill.id` 时，从已准入的 `workflow_result` operation 恢复 Skill 身份。
- 恢复身份前检查 operation 的产品类型和画布范围。
- Recipe 驱动的 `textAnnotationNode` 如果误带 `input/resource/asset` 保留 stage，工具移除该系统冲突字段，再交给后端根据 Recipe 处理。
- `generation_answers` 只补充完整 Intent/Plan。
- 完全缺少 Intent/Plan 或同时提供两者时，一次性返回明确的结构化错误。
- 持久化 Plan 的内部 Schema 仍保持严格；只在工具输入边界放宽可由 operation 唯一恢复的字段。
- 已显式提供但冲突的 Schema 或 Skill 不会被静默覆盖，仍由后端拒绝。

### 2. 减少 Agent 生成原始拓扑

已修改：

- `src/novelvideo/chat/service.py`
- `src/novelvideo/agent_skills/dramaclaw-workflows/SKILL.md`
- `src/novelvideo/agent_skills/dramaclaw-workflows/references/custom-topology.md`
- `agent-kit/skills/dramaclaw-workflows/SKILL.md`
- `agent-kit/skills/dramaclaw-workflows/references/custom-topology.md`
- `.hermes/skills/workflows/SKILL.md`
- `.hermes/skills/workflows/references/spec.md`

新路由原则：

- 集数、Beat 数、镜头数、时长、交付数量属于标准 Planner 的业务输入。
- 单独出现这些数量要求，不再触发 Agent 编写完整节点图。
- 只有用户明确要求具体画布节点，并指定偏离标准模板的依赖关系时，才进入自定义 Plan。
- 自定义 Plan 必须携带完整业务节点和边；工具负责系统身份与规范化。

Agent 协议版本已从 `canvas-workflows-v24` 逐步升级到 `canvas-workflows-v26`，用于避免重启后复用旧线程指令。

## 安全边界

当前设计不应放宽权限或执行边界：

- operation 仍受项目、用户和画布范围限制。
- 只从 `workflow_result` operation 恢复 Skill 身份。
- Recipe、节点类型和连线类型仍走白名单与后端校验。
- 节点与边数量仍有上限。
- 工具补全不会绕过 Draft 确认或画布批准。
- `run_after_create` 的既有确认语义不变。
- Agent 显式提交冲突身份时，不自动改写为另一 Skill。

需要继续审查的一点：工具移除 Recipe 文本节点上的保留 stage 属于规范化。应确认所有标准 Planner/Recipe 都能从 Recipe 目录正确推导执行阶段；如果不能，应改成由目录显式返回 canonical stage，而不是依赖删除后的推导。

## 已增加或更新的测试

主要测试位于：

- `tests/test_freezone_plugin.py`
- `tests/test_workflow_mcp.py`
- `tests/test_chat_service_user_agent_scope.py`

已覆盖：

- 从 operation 恢复 Plan Skill 身份和版本。
- 自动补充 Plan Schema 版本。
- 清理 Recipe 文本节点的冲突 stage。
- 完全缺少 Intent/Plan 时只返回一次明确错误。
- Agent Skill/reference 明确描述完整 Plan 字段和标准 Planner 路由。
- 新的 Freezone Agent 协议指令已注入。

最近执行结果：

```text
相关定向 pytest：通过
ruff：通过
git diff --check：通过
```

测试环境中的 `pytest` 可执行脚本仍带旧目录 shebang，因此使用：

```bash
./.venv/bin/python -m pytest ...
```

## 当前工作区注意事项

工作区存在多组未提交修改，其中一部分来自此前 Draft 状态、任务超时和前端重复失败展示修复。不要 reset、checkout 或覆盖不相关修改。

`.cache/` 为未跟踪目录，不要纳入本问题提交。

开始工作前请先执行：

```bash
git status --short
git diff --check
```

## 新会话建议任务

新会话先阅读本文件，然后完成以下检查：

1. 审查 `freezone_prepare_workflow` 的 operation 身份恢复是否存在跨项目、跨画布或错误产品类型风险。
2. 确认标准短剧请求在新指令下走 compact Intent/standard Planner，而不是生成几十节点的 raw Plan。
3. 为“Beat/镜头数量不触发自定义拓扑”补充更直接的行为测试，而不仅是指令文本断言。
4. 检查标准 Planner 是否能表达 `test_11` 的三集大纲、第一集 20–25 Beats、角色/场景/道具、镜头组、视频、配音和合成需求。
5. 如标准 Planner 能表达，增加端到端测试，断言 Agent 侧不需要提交 nodes/edges/stage/skill identity。
6. 运行相关完整测试集，并在重启服务后使用新项目复测；不要直接依赖旧 `test_11` 的活动线程。

## 后续整改结果

已完成以下闭环整改：

- `workflow_result` operation 现在必须携带非空 `canvas_id`，幂等复用时也校验画布。
- 草稿 API 强制校验 operation 与目标画布、Skill ID、Skill 版本及 artifact 身份一致。
- Plan 工具对提供了 `operation_id` 的请求始终校验 operation；可分别补齐缺失的
  `skill.id` 和 `skill.version`，显式冲突会一次性拒绝。
- Recipe 文本节点误用保留 stage 时，优先按标准 Planner 的 Recipe 目录恢复
  canonical stage；无法唯一恢复时才移除冲突 stage。
- `short-drama-quick` 标准 Planner 支持最多 25 个 Beat，并确定性生成故事规划、
  角色设定与身份图、场景设定与参考图、道具设定与参考图、逐 Beat 镜头设计、
  首帧、视频、配音、背景音乐和最终合成。
- 新增 25 Beat compact Intent 行为测试：Agent 输入不含 `nodes`/`edges`/`stage` 或
  Plan 身份结构，服务端展开为 110 个节点，并通过图命令编译和完整 preflight。
- 相关回归测试：`941 passed`；`ruff` 与 `git diff --check` 通过。

## 新会话可直接使用的提示

```text
请先阅读 dc/dramaclaw-ce/docs/freezone-workflow-agent-determinism-handoff.md，
检查现有未提交改动，不要覆盖用户修改。目标是让 Agent 尽量只生成业务 Intent，
由工具和标准 Planner 确定性生成工作流结构。请审查安全边界、补足行为测试，
然后验证短剧工作流不再因为 Beat/镜头数量进入大型 raw Plan。
```

## test_12 配音草稿重复失败整改

`test_12` 暴露了 screenplay-first 与草稿音频校验之间的冲突：短剧标准 Planner
开启音频时，旧逻辑要求每个尚未执行的 Beat 在草稿阶段已经携带字面 `narration`，
导致 Agent 对同一 `planner.units.0.narration` 错误反复重试，最后甚至通过删除逐镜头
配音节点绕过校验。

现已调整为：

- `short-drama-quick` 可在草稿阶段省略尚未生成的字面旁白；标准 Planner 保留
  `drama-shot-voice` 节点，并用 `prompt_for` 从上游镜头/剧本文本运行时绑定正文。
- 用户已提供字面旁白时仍原样保留；占位旁白继续拒绝。非 screenplay-first 的标准
  Planner 仍要求字面旁白，不扩大放宽范围。
- 自定义短剧显式 `include_audio=true` 时必须保留 speech 节点，不能只留 BGM 或删除
  配音来绕过校验。
- 顶层 `intent.include_audio` 与 `planner.include_audio` 冲突时一次性返回明确错误，不再
  静默使用顶层值后重复报“缺少 narration”。
- Intent Schema 是序列化白名单；Recipe 查询结果中的 `requires_source_media` 只用于选择
  Recipe 和规划依赖，不复制到 `intent.items[]`。权威值由服务端依据 `recipe_id` 推导。
- Agent 指令增加同错误路径熔断：禁止原样重提；修正一次后同一路径仍失败则本轮停止。

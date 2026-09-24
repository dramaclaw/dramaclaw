# 创作阶段（虾本）：写手 agent 与通用文档存储

**状态**：待验收
**最后更新**：2026-09-18
**基线**：`10275ec8bea13620e5b6f266ececc1f9fb26c52c`；治理与 LOD 核心已提交；`routeTree.gen.ts` 同时被 `origin/main` 修改
**相关文档**：无独立设计文档；设计意图写在 `src/novelvideo/api/routes/story.py` 与
`src/novelvideo/agents/story_writer.py` 的模块 docstring 里（写得很完整，接手先读那两段）
**样例产物**：`曹操.md`（创作方案样例，仓库根目录，未跟踪）

## 目标

创作阶段的产物（故事圣经、创作方案、角色体系、分集目录、分集草稿）有地方存、有 agent 写，
前端有独立路由可编辑。

## 非目标

- 不为尚未定型的每种创作产物新增数据库表、专用路由或固定 schema。
- 不在补测试阶段重做创作 UI、导航系统或 Superchat 通用交互。

## 写入边界（既有改动归属）

| 文件 | 新增/修改 | 作用 |
|---|---|---|
| `src/novelvideo/agents/story_writer.py` | 新增 | 写手 agent，长提示词 |
| `src/novelvideo/api/routes/story.py` | 新增 | 通用文档存储路由 |
| `tests/test_story_writer.py` | 新增 | 文档安全、并发修订与剧本格式回归 |
| `src/novelvideo/api/__init__.py` | 修改 | 挂载路由 |
| `frontend/src/features/story/` | 新增（整个目录） | 创作阶段界面 |
| `frontend/src/api/story.ts`、`lib/queries/story.ts` | 新增 | 接口与查询 |
| `frontend/src/routes/_app/projects.$project/story.lazy.tsx` | 新增 | 路由 |
| `frontend/src/routeTree.gen.ts`、`components/layout/project-navigation-routes.ts`、`project-header-navigation.tsx` | 修改 | 导航接入 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | story UI 与后端错误码三语词条，只按 key 合并 |
| `frontend/src/stores/assistant-draft-store.ts` | 新增 | 草稿状态 |
| `frontend/src/features/superchat/superchat-panel.tsx` | 修改 | |

后端 story 两个新增文件、前端 `features/story/**`、story API / query 与测试可视为本线独占；
`api/__init__.py`、导航文件、`superchat-panel.tsx`、`routeTree.gen.ts` 是共享集成层。

## 协调与冲突

- `sync-main-remotes` 可在最终合流时把 `story_writer.py` 的网关能力从通用文本标签改为上游规定的
  `text.generate.agent`；只改能力归类，不改提示词、模型别名或文档格式。

- `frontend/src/routeTree.gen.ts` 已被 `origin/main` 修改，它是生成物，不应手工选择本地或远端整份。
  最终在最新基线上保留 story 路由源文件后重新运行 TanStack Router 生成流程。
- `superchat-panel.tsx` 当前还有其他本地改动来源未在本台账中解释；补测试前先用 diff 确认 story 实际改动块，
  不能把整个文件认领为本线。
- 后端最小契约已有聚焦测试；在真实全流程验收和存储生命周期决定完成前，不扩展新的文档类型。

## 实施方案（后续）

1. 在可用模型配置下走完真实四阶段创作，确认编译结果能被现有导入链路直接解析。
2. 对 `superchat-panel.tsx` 做逐块归属，只保留 story 所需的最小接入。
3. 明确 story JSON 的单文档 / 单项目配额、删除与损坏恢复策略，再补对应测试。
4. 将 `曹操.md` 脱敏、精简后固化为测试 fixture；原始样例继续保持未跟踪。

## 风险与回退

- 风险是自由 JSON 存储缺少大小 / 生命周期限制，以及生成路由被整文件覆盖。
- 新增 story 模块可单独撤销；共享导航与 Superchat 只按本线 diff 块回退。

## 进展记录

### 2026-09-18 · 锁定 Story 后端契约并通过前端构建

做了什么：新增 14 项后端测试，覆盖非法 / 合法 `doc_id`、原子写入与临时文件清理、乐观修订冲突、
单集固定格式渲染和模型失败映射；路由错误改为 `message_code` + `message_params` 的三语协议，中文、英文、
越南文同步补齐。运行前端构建，让 TanStack Router 根据 story 路由源文件更新生成树。原始 `曹操.md`
没有纳入提交，避免把真实创作内容直接公开。

为什么这么做：先把路径边界、并发写入和下游剧本格式固化，后续模型或 UI 改动就不能悄悄破坏存储契约；
后端错误码同时三语化，避免为了通过棘轮把用户可见错误退化成不可翻译字符串。

怎么验证的：`uv run pytest tests/test_story_writer.py -q` 通过（14 passed）；
`uv run ruff check src/novelvideo/agents/story_writer.py src/novelvideo/api/routes/story.py tests/test_story_writer.py`
通过；三份 locale JSON 可解析；`cd frontend && pnpm build` 通过（5417 modules transformed）。
全局后端 i18n 棘轮仍被 `freezone.py` 的 3 个其他工作线新增命中阻断，前端 i18n 棘轮仍只命中 LibTV / depth
相关文件，均非 Story 改动。尚未在真实模型配置下走完四阶段 UI，所以状态改为“待验收”而非“已完成”。

### 2026-09-18 · 开始补最小后端契约测试

做了什么：逐段读取通用文档路由与写手 agent，确认测试边界为 `doc_id` 白名单、原子 JSON 写入、
1MB 限制、乐观修订冲突和 `render_episode()` 的固定场次头；新增测试路径已先登记到 scope。

为什么这么做：本线此前没有任何自动测试，直接提交会让路径穿越和自由 JSON 存储成为无门禁接口；
先锁住后端契约，再接入共享路由和前端生成路由，能把风险限制在最小模块内。

怎么验证的：当时尚未完成；完成结果见上方最新记录。

### 2026-09-18 · 补齐路由与共享 UI 的机器 scope

做了什么：只更新台账和 scope，声明 story 新模块独占，路由生成物、导航和 Superchat 为共享；
没有修改 story 业务代码。

为什么这么做：本线仍是零测试且共享 UI 来源未完全解释，先阻止整文件覆盖，再补聚焦测试。

怎么验证的：待全局 `agent_guard check` 通过；story 功能本轮未验证。

## 已定下来的决策（不要回头改）

- **「一个 doc_id 对应一份 JSON」的通用存储，不给每种产物开表和路由。**
  创作阶段的产物形态还在变，给每种开一套路由和 schema 等于把没定型的东西焊死在后端。
  **新增一种产物不需要改任何后端代码**，前端换个 doc_id 就行。
- **落在 `state_dir/story/<doc_id>.json`，不进 SQLite。** 这些是自由形态的草稿而不是结构化实体，
  进表反而要跟着形态反复迁移。
- **单集剧本走结构化输出，格式由代码渲染，不让模型吐格式文本。**
  下游对场次头格式要求很硬（`X-Y地点 日/夜 内/外` + `人物：`），让模型自由输出再回头校验，
  等于把格式正确率押在模型最容易漂的能力上（尤其长文本后半段）。
  改成模型只输出「在哪、什么时辰、内外景、有谁、说了什么」，格式正确率是 100% 而不是「大概率」。
- **方案 / 角色 / 目录这三步反而用纯文本。** 它们的消费者是人和模型，不是解析器，
  结构化只会把创作束缚成填表。
- **模型名必须填 newAPI 里已注册的逻辑别名（`DC-*-LLM`），不能填上游原名。**
  填 `deepseek-ai/DeepSeek-V4-Flash` 这类上游名会直接 502。默认复用内容改写那条别名。

## 待办

- [x] 补齐最小后端契约测试：`doc_id` 校验、原子写入、修订冲突、结构化剧本渲染、模型失败路径
- [ ] `state_dir/story/*.json` 的清理与配额没定：谁删、什么时候删、单项目上限多少
- [ ] `曹操.md` 是目前唯一的真实样例，应该固化成一份回归样例放进 `tests/fixtures/`
- [ ] 在真实模型配置下走完四阶段 UI，并验证编译结果可直接进入现有导入链路

## 阻塞

无。

## 验收标准

- 新建一个项目，走完「创作方案 → 角色体系 → 分集目录 → 单集剧本」，
  产出的单集剧本能被现有导入链路直接解析，场次头零格式错误。
- 刷新页面后草稿还在；换个 doc_id 新增一种产物，后端不需要改代码。

## 交接摘要

- **最后完成到**：后端最小契约的 14 项测试与前端生产构建通过；清理 / 配额和真实模型全流程仍未验收。
- **下一步唯一动作**：在可用模型配置下走完四阶段创作，并把编译结果送入现有导入链路验证。
- **先读这些文件**：`story.py`、`story_writer.py` 的模块 docstring 与当前 diff。
- **不要动这些文件 / 决策**：不要把自由草稿改成多表 schema；不要手工覆盖 `routeTree.gen.ts`。

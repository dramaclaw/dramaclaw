# 状态检测与恢复

## 恢复流程

已有项目 → 使用 Step 0（SKILL.md §0）已拉取的 `pipeline/status` 返回值，不要重复调用。

若需要指定集的状态，补调 `GET /api/v1/projects/{P}/pipeline/status?episode=N`（Step 0 默认只取项目级）。

读取响应：
- `global` 段：全局准备是否完成（ingested, configured, characters, episodes, portraits_done）
- `episode_status` 段：当前集各步骤（identity_plan, identity_images, script, sketches, coloring, global_optimize, first_frames, tts, video）
  - 辅助任务 type：`content_rewriter`（解说改写）、`script_writer`（剧本生成）。这些辅助步骤通过 `GET /projects/{P}/tasks/{task_type}/{N}` 主动查
  - 当前后端没有场景锚图 `anchor-image/*` 和 `scene_anchor` task
- `next_step` + `next_step_name`：从断点继续

### Step 10 路径判定

一进入 Step 10 区段，先 `GET /projects/{project}/episodes/{ep}/script` 读取脚本。这里只允许 project-scoped script 端点，禁止省略项目名的 `/episodes/{ep}/script` 简写：

- `data` 为空 → 剧本尚未生成，应继续 `rewrite` 或 `script/generate`
- `data` 非空 → 剧本已就绪，可进入 Step 11（场景/道具上下文）或 Step 12 草图
- 当前后端没有 `literal-script/generate`，不要用 `script_mode == "literal_source"` 作为硬判定

## 进度展示

**进度表必须包含全部步骤**，按两段列出：

**项目准备**：摄入、配置、角色、分集、分级、肖像
**逐集阶段**：身份规划、身份图、解说改写、剧本生成、场景/道具、草图、配色+检测、全局优化、首帧、音频、视频、合成、成片展示

每步标记 ✅（完成）或 ❌（未完成）。直接从 `episode_status` 映射：
- identity_plan → 身份规划, identity_images → 身份图
- coloring → 配色+检测, global_optimize → 全局优化
- 分级：API 不单独暴露。`portraits_done=true` 意味着分级已完成（肖像依赖分级）
- 剧本：新主线下由“解说改写 + 逐行生成”两步取代旧展示口径，不再单列成公开主线步骤

### 新流程的辅助步骤展示（仅在用户走过时才显示）

- 解说改写：`GET /projects/{P}/tasks/content_rewriter/{N}` 返回 completed → ✅；或 `GET /adapted-content` 非空 → ✅
- 剧本生成：`GET /projects/{P}/tasks/script_writer/{N}` 返回 completed，或 `GET /projects/{P}/episodes/{N}/script` 有数据 → ✅

用户查看逐集阶段时，`解说改写` 与 `剧本生成` 作为显式步骤展示：
- 若尚未触发：显示 ❌
- 若 `content_rewriter` 已完成或 `adapted-content` 非空：`解说改写` 显示 ✅
- 若 `script_writer` 已完成或 script 有数据：`剧本生成` 显示 ✅

- 场景/道具：当前后端没有锚图判定；只展示场景库、道具规划/列表的当前状态

## 恢复执行

**运行模式优先（但所有模式都受一步执行协议限制）**：
- 若用户本会话已选 / 现在表示要**逐步确认模式** → `Read references/run-modes.md` 模式一，
  从断点起**每个写操作步骤前都停下问用户，一次只推进一步**。
- 若用户选**自动推进模式**，或当前消息包含 UI 注入的 `[DRAMACLAW_RUN_MODE] mode=episode_auto` → 按 `pipeline/status.next_step` 自动选择当前一步，不再询问每步确认，但每轮仍最多启动一个写任务，启动后立即收口；如果已有 queued/running 任务，立即告知后台正在生成中并停止。
- 若用户只说「继续」且**未指定过模式** → 先问一句「每步确认还是自动推进（每轮一步）？」再决定（除非用户明显赶时间/已说过别问）。

先根据用户请求判断恢复模式：

- **用户只是在问进度 / 想看当前做到哪一步**
  - 展示进度表
  - 必要时再询问交互模式（每步确认/自动推进）
  - 暂不直接推进
- **用户已经明确要求继续 / 恢复 / 从这里开始**
  - 先依据 `next_step` 和任务状态判断当前一步
  - 如果已有 queued/running 任务，只反馈“后台正在生成中”和当前任务状态，不推进下一步
  - 如果没有运行中任务，只启动 `next_step` 对应的一个写任务，启动后立即收口
  - 不把 continuation 当成自动续跑，不等待当前任务完成后继续启动下一步

恢复路由：

- 全局阶段断点 → Read playbooks/init.md
- 逐集阶段断点 → Read playbooks/episode.md

## 项目级 continuation 默认

当用户只说“继续 / 帮我继续 / 恢复”，且当前断点仍在全局阶段时：

- 先找当前首个缺失的全局步骤
- 默认只启动这个首个缺失全局步骤对应的一个写任务，或在同步步骤完成后立刻停止
- 启动异步任务后立刻停止，不轮询到完成点，不继续下一步
- 不在同一轮里继续自动推进下一个全局步骤
- 不自动继续到 `POST /projects/{project}/episodes/plan`、批量肖像或逐集执行；即使用户明确要求整段自动跑完，也必须分多轮，每轮一个写任务


## 单集 continuation 默认

当用户已经给出明确的单集范围，并且请求语义是：

- “帮我从这里开始”
- “从断点继续”
- “继续做到下一步”
- “继续”

则默认按**当前集 continuation**处理，而不是先退回项目总览或模式协商。

对这类单集 continuation：

- 以 `GET /api/v1/projects/{P}/pipeline/status?episode=N` 作为主事实源
- 允许补充读取项目、角色、分集等必要状态
- 若 `next_step` 已明确，直接进入该步对应执行
- 若用户说的是“从这里开始 / 从断点继续 / 继续做到下一步”，
  默认只启动**当前首个缺失步骤**对应的一个写任务；如果该步已有任务运行，只汇报运行中
- 启动或发现运行中任务后立即停止继续探测、停止额外轮询，直接汇报当前状态
- 只有用户明确要求“先看进度/先别执行/我来决定模式”时，才停在展示或询问

## 草图图池查询规则

用户问"草图"/"能用的图"/"图池"时触发。

**数据获取**：**必须**用 `GET /grids` API，**禁止**扫描文件系统。

**默认展示**：只报告当前批次（`stale=false`）的摘要统计：
> "25 个 beat，当前批次共 68 张可用草图（每 beat 2-4 张）。"

用户明确要求时才补充旧批次信息。

**选用旧批次草图**：若目标图 `stale=true`，先警告再操作：
> "这张草图来自旧批次，角色配色和当前批次不一致。选用后人物可能会错乱。确定要选用吗？"
用户确认后才调 `pool-select` 并传 `force=true`。禁止 try→fail→force 模式。

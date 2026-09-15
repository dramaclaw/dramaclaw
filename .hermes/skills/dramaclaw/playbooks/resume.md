# 状态检测与恢复

## 恢复流程

已有项目 → 使用 Step 0（SKILL.md §0）已拉取的 `pipeline/status` 返回值，不要重复调用。

若需要指定集的状态，补调 `GET /api/v1/projects/{P}/pipeline/status?episode=N`（Step 0 默认只取项目级）。

读取响应：
- `global` 段：全局准备是否完成（ingested, configured, characters, episodes, portraits_done）
- `episode_status` 段：当前集各步骤（identity_plan, identity_images, script, scene_anchors, sketches, coloring, global_optimize, first_frames, tts, video）
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

**复用用户已选运行模式**：
- 若用户本会话已选 / 现在表示要**逐步确认模式** → `Read references/run-modes.md` 模式一，
  从断点起**每个写操作步骤前都停下问用户，一次只推进一步**。
执行范围、是否逐步确认及连续推进统一遵循 `../references/run-modes.md`；不要额外设置每轮写操作数限制。

先根据请求范围恢复：只查进度则返回状态；明确继续则承接已有目标及运行模式，无需再次协商模式。未明确目标时先读必要状态，仅对影响执行范围的歧义询问。

全局阶段按 `init.md`，逐集阶段按 `episode.md`。当前集以 `pipeline/status?episode=N` 为主事实源，必要时补项目/角色状态。执行顺序及付费授权见 `../references/run-modes.md`；依赖任务运行时按 `../references/async-tasks.md` 等待，不重复提交。

用户明确“只做下一步”时只执行该步；“继续”承接原授权范围。只读请求不扩大为写操作，整集目标不扩大为其他集或重新摄入。

## 草图图池查询规则

用户问"草图"/"能用的图"/"图池"时触发。

**数据获取**：**必须**用 `GET /grids` API，**禁止**扫描文件系统。

**默认展示**：只报告当前批次（`stale=false`）的摘要统计：
> "25 个 beat，当前批次共 68 张可用草图（每 beat 2-4 张）。"

用户明确要求时才补充旧批次信息。

**选用旧批次草图**：若目标图 `stale=true`，先警告再操作：
> "这张草图来自旧批次，角色配色和当前批次不一致。选用后人物可能会错乱。确定要选用吗？"
用户确认后才调 `pool-select` 并传 `force=true`。禁止 try→fail→force 模式。

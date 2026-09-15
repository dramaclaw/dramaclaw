# 逐集生成阶段（Steps 8-21）

> API 请求细节不确定时，`Read references/pipeline-details.md`。
> 变量：`$EP` = 当前集数。
> **首步**：`GET /projects/{project}` 读取项目配置（rhythm, tts_provider, video_resolution），用于 `{项目...}` 占位符；视频后端默认统一使用 `huimeng_seedance-1.0-pro-fast`。

## 流水线
Steps 8-21 详见 `references/pipeline-details.md`。检查点：CP2(场景/道具后) | CP3(草图后) | CP4(音频后) | CP5(最终成片后)

CP2 判定：脚本、场景/道具上下文足够推进草图；当前后端没有 `anchor_image_url` 契约。

## 步骤要点

**整集制作入口**：直接读取当前集必要状态，按 `../references/run-modes.md` 的范围与成本授权顺序推进；不要求先批准只读查询。

**Step 9（服装一致性关键）**：
1. 先读取核心+重要角色的 identity 状态，选择第一个缺失身份图的 identity；在授权角色/数量及预算内串行生成缺失身份图
   - `CHAR_NAME` 只能来自已读到的角色名列表或当前返回结果中的明确角色字段，且必须非空
   - 如果当前拿不到角色名，就跳过该角色的 identity 补读，不要探测 `/characters//identities` 或任何空名路径
   - 不要并发提交冲突任务，不生成授权范围外的角色/identity；无需为已授权的每张身份图重复确认
2. 身份图是后续草图/首帧中服装外观的**视觉锚点**——没有身份图，服装每帧随机
3. `appearance_details` 必须具体到颜色+款式+材质，避免"正装"、"便装"等模糊词

**单步 continuation 收口**：
- 若 resume 已明确这是“从断点开始 / 继续做到下一步”的单步 continuation，
  则当前 `next_step` 完成后立刻停止，不继续探测后续步骤
- 例如断点在 Step 8（身份规划）时：
  - 完成 `POST /episodes/{ep}/identities/plan`
  - 直接汇报“本集身份规划已开始/已完成当前步”
  - 不继续轮询无关任务，不继续推进到 Step 9+
  - 默认直接使用 `identities/plan` 的返回结果汇报本步产物
  - 不为“核对每个角色身份”再补读 `GET /characters/{name}/identities`
  - 若规划返回已给出角色与身份位信息，就以该返回为最终事实源收口

**Step 10 固定主线**：
- 用户先准备 `raw-content`
- 若需要解说改写，先 `POST /rewrite/generate`，等待改写成功后才可继续依赖的 `script/generate`，授权及等待规则见 run-modes.md
- 只有改写稿已完成/已存在时，才调用当前后端实际存在的 `POST /script/generate`；依赖完成后按已授权范围继续
- 剧本生成完成后可进入 Step 11（场景/道具上下文），再进入 Step 12 草图
- 当前后端没有 `literal-script/generate`，也不保证 `script_mode == "literal_source"`

**Step 11-13（场景 / 道具上下文 — 草图前置）**：
- 当前后端没有 `anchor-image/*`、`scene_anchor`、`scenes/snapshot-sync` 路由，禁止调用这些旧接口
- 可用流程：
  1. `GET /projects/{project}/scenes` 列项目场景库
  2. `GET /projects/{project}/episodes/{ep}/beats` 读取本集 beats
  3. 如需补场景 → `POST /projects/{project}/scenes`，body 使用当前后端字段：`{"name":"...","description":"...","environment_prompt":"..."}`
  4. 本集道具规划 → `dramaclaw_plan_props`（`POST /projects/{project}/episodes/{ep}/props/plan`）
  5. 道具列表 → `GET /projects/{project}/props`
执行范围、是否逐步确认及连续推进统一遵循 `../references/run-modes.md`；不要额外设置每轮写操作数限制。
- 完成判定：脚本、场景/道具上下文足够推进草图；不要要求 `anchor_image_url`

**Step 12（草图生成前置）**：先调 `assign-colors`（幂等），再生成草图
- 若草图需要多个 grid_index，当前轮最多启动一个 grid 的生成；不要循环所有 grid_index。下轮“继续”再处理下一个 grid。

**Step 12.3**：先配色再检测。无身份图时检测无效

**Step 12.5**：`{"language":"en"}` 默认英文 SuperPower 模式，决定 video_mode + motion prompt

**Step 18 音频生成**：使用 `dramaclaw_generate_audio`，即当前 `audio/generate` [ASYNC: `audio_generation_indextts2`]。旧 `/tts/generate` 已移除，不要调用。

**局部音频更新**：
- 当用户修改 beat 的 `audio_type`、`speaker`、`fish_speech_prompt` 或对白文本时，
  必须按固定顺序执行：
  1. 先 `PATCH /episodes/{ep}/beats/{beat}`
  2. 再重做该 beat 音频（`POST /episodes/{ep}/beats/{beat}/audio` 或对应音频生成路径）
  3. 最后才允许 `POST /episodes/{ep}/videos/compose`
- 即使 beat 当前对白文本已经等于目标文本，只要 `audio_type`、`speaker`
  或其他音频相关字段还需要调整，也必须先完成这次 `PATCH`，
  不要先重做音频再补 `PATCH`
- `compose` 不能预启动、不能抢跑、不能为了省时间先发起再回头补音频。
  必须等该 beat 的音频重做请求已经发出并返回成功后，才允许进入 `compose`。
- 不要在该 beat 的音频重做之前先发起 `compose`

**Step 19 视频模型**：当前后端没有整集 `/videos/generate` 路由。默认用 `POST /episodes/{ep}/beats/{beat}/video` 单 beat 生成；如需整集片段，读取 beats 后只选择第一个未完成且前置满足的 beat，按授权范围串行处理未完成 beat；每个 beat 避免重复提交，依赖及队列限制不变。默认 `huimeng_seedance-1.0-pro-fast`。

**Step 19-21**：分别为 `single_video`（逐 beat）、`compose_episode`、`dramaclaw_get_final_video`，**必须顺序执行**

## 检查点规则（仅手动模式）

到达检查点时停止工具调用，展示成果，等用户回复。

| CP | 展示 | 用户可改 |
|----|------|----------|
| CP2 | Beat 摘要（序号+场景+画面，≤3行/beat） | 画面描述、对白、增删 |
| CP3 | 3-5 张代表首帧 | 重渲染、改 visual_description |
| CP4 | 音频播放器 + 对白声线列表 | 换声线、调语速 |
| CP5 | 成片视频 + 时长 + beat 数 | 重做 beat、重新合成 |


逐步确认模式下的用户回复：
- "继续" / "ok" → 只推进当前 `next_step` 的一个任务；若已有任务运行中，只反馈当前状态
- "看第X张" / "看全部" → 补充展示，仍在同一检查点
- 具体修改指令 → 执行修改，再展示，仍等确认

## 渐进式生成策略

```
阶段一：当前项目准备（Step 1-6，项目已创建并绑定） → 手动模式在 CP1 暂停
阶段二：逐集生成（Step 8-21，per EP） → 手动模式在 CP2-CP5 暂停
```

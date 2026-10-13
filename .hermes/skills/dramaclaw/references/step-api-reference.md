# DramaClaw 步骤 API 参考

本文件只记录各步骤的端点、参数和任务类型，不拥有流程顺序决策权。Steps 1-7 的顺序以
`playbooks/init.md` 为准，Steps 8-16 的顺序以 `playbooks/episode.md` 为准；恢复定位以
`playbooks/resume.md` 为准。每个 API 调用必须以后端当前 FastAPI routes 为准。

变量约定：
- `$PID` = 当前 `DRAMACLAW_PROJECT_ID`
- `$EP` = 集数编号
- `$CHAR_NAME` = 角色名
- `$IDENTITY_ID` = 身份 ID
- `$BEAT` = beat 编号

认证：所有请求使用 `Authorization: Bearer $DRAMACLAW_AGENT_TOKEN`。

---

## 当前项目准备阶段

项目创建由前端/系统完成，虾导不会调用 `POST /projects`。以下步骤均要求
`DRAMACLAW_PROJECT_ID` 已绑定到一个存在的项目。

### Step 1: 上传小说 [SYNC]

```
POST /projects/$PID/ingest/upload
Body: multipart/form-data, file=novel.txt
```

### Step 2: 摄入 [ASYNC -> ingest_fast, ep=0]

```
POST /projects/$PID/ingest/start
Body: {"filename": "novel.txt", "rebuild": false}

已摄入项目覆盖重建只能在二次确认后调用:
Body: {"filename": "novel.txt", "rebuild": true}

GET /projects/$PID/tasks/ingest_fast/0
SSE /projects/$PID/tasks/ingest_fast/0/stream
```

### Step 3: 配置项目 [SYNC]

```
PATCH /projects/$PID
Body: {"visual_style": "...", "narration_style": "...", "ethnicity": "...", "rhythm": "..."}
```

### Step 4: 角色提取 [ASYNC -> build_characters, ep=0]

**触发用专用工具 `dramaclaw_build_characters`（不要自己拼路径）**，它内部就是
`POST /projects/$PID/characters/build`。

```
dramaclaw_build_characters            # 触发提取（项目默认取 DRAMACLAW_PROJECT_ID）

dramaclaw_get_task(task_type="build_characters", episode=0)   # 轮询状态
SSE /projects/$PID/tasks/build_characters/0/stream            # 或流式
```

完成后用：

```
GET /projects/$PID/characters
```

手动添加角色 fallback：

```
POST /projects/$PID/characters
Body: {"name":"角色名","role":"主角","is_main":true,"gender":"female","age_group":"youth","description":"描述","face_prompt":"面部特征"}
```

### Step 5: 角色 face_prompt 检查/补齐 [SYNC]

肖像生成依赖角色 `face_prompt`。进入肖像生成前必须读取角色列表并补齐缺失值：

```
GET /projects/$PID/characters
PATCH /projects/$PID/characters/$CHAR_NAME
Body: {"face_prompt": "具体面部特征描述"}
```

缺失时优先用专用工具：

```
dramaclaw_update_character_face_prompt(name="$CHAR_NAME", face_prompt="...")
```

`face_prompt` 只描述脸部，不写服装、场景、身份图。

### Step 6: 分集规划 [ASYNC -> build_episodes, ep=0]

```
POST /projects/$PID/episodes/plan
Body: {"target_episodes": 10, "planning_mode": "chapters"}

GET /projects/$PID/tasks/build_episodes/0
SSE /projects/$PID/tasks/build_episodes/0/stream
```

完成后用：

```
GET /projects/$PID/episodes
```

### Step 7: 肖像生成 [SYNC]

```
POST /projects/$PID/characters/$CHAR_NAME/portrait
Body: {"style": "...", "ethnicity": "...", "model": "nanobanana"}
```

---

## 逐集生成阶段

### Step 8: 身份规划 [SYNC]

```
POST /projects/$PID/episodes/$EP/identities/plan
```

### Step 9: 身份图生成 [SYNC]

```
GET /projects/$PID/characters/$CHAR_NAME/identities

POST /projects/$PID/characters/$CHAR_NAME/identities/$IDENTITY_ID/generate
Body: {"style": "...", "model": "nanobanana"}
```

`$CHAR_NAME` 必须来自已读取的角色列表或身份规划结果，且非空。禁止探测 `/characters//identities`。

### Step 10a: 解说改写 [ASYNC -> content_rewriter]

```
GET /projects/$PID/episodes/$EP/raw-content

POST /projects/$PID/episodes/$EP/rewrite/generate
Body: {"target_beats": 18, "beat_chars_min": 14, "beat_chars_max": 20}

GET /projects/$PID/tasks/content_rewriter/$EP
SSE /projects/$PID/tasks/content_rewriter/$EP/stream
```

完成后可用：

```
GET /projects/$PID/episodes/$EP/adapted-content
```

### Step 10b: 剧本生成 [ASYNC -> script_writer]

当前后端没有 `/literal-script/generate`。使用实际存在的：

```
POST /projects/$PID/episodes/$EP/script/generate
Body: {"narration_style": "first_person"}

GET /projects/$PID/tasks/script_writer/$EP
SSE /projects/$PID/tasks/script_writer/$EP/stream
```

完成后验证：

```
GET /projects/$PID/episodes/$EP/script
GET /projects/$PID/episodes/$EP/beats
```

不要要求 `script_mode == "literal_source"`；当前后端不保证该字段。

### Step 11: 场景 / 道具上下文 [SYNC/ASYNC]

当前后端没有 `anchor-image/*`、`scene_anchor` task，也没有 `/episodes/$EP/scenes/snapshot-sync`。不要调用这些路径。

可用场景 API：

```
GET /projects/$PID/scenes

POST /projects/$PID/scenes
Body: {"name":"场景名","description":"...","environment_prompt":"..."}

PATCH /projects/$PID/scenes/$SCENE_NAME
Body: {"description":"...","environment_prompt":"..."}

POST /projects/$PID/scenes/$SCENE_NAME/delete
```

可用道具 API：

```
POST /projects/$PID/episodes/$EP/props/plan
GET /projects/$PID/props
POST /projects/$PID/props
PATCH /projects/$PID/props/$PROP_NAME
POST /projects/$PID/props/$PROP_NAME/delete
```

### Step 12: 草图生成 [ASYNC -> sketch_generation]

```
POST /projects/$PID/episodes/$EP/sketches/assign-colors

POST /projects/$PID/episodes/$EP/sketches/generate
Body: {"style": "...", "model": "nanobanana", "grid_index": 0, "sketch_location_grouping": true}

GET /projects/$PID/tasks/sketch_generation/$EP?scope=grid_0
SSE /projects/$PID/tasks/sketch_generation/$EP/stream?scope=grid_0
```

按 `grid_index` 串行生成每张 grid。每个 grid 对应 task scope `grid_N`。

状态/结果查看：

```
GET /projects/$PID/episodes/$EP/grids
```

### Step 12.3: AI 身份检测 [SYNC]

```
POST /projects/$PID/episodes/$EP/sketches/detect-identities
```

### Step 12.5: 全局视频优化 [ASYNC -> global_optimize_video]

```
POST /projects/$PID/episodes/$EP/optimize/video-global
Body: {"language":"en"}

GET /projects/$PID/tasks/global_optimize_video/$EP
SSE /projects/$PID/tasks/global_optimize_video/$EP/stream
```

### Step 13: 首帧生成 [ASYNC -> selected_regen]

```
POST /projects/$PID/episodes/$EP/beats/regenerate
Body: {"beat_indices": [1], "style": "...", "model": "nanobanana",
       "batch_id": "first-frame-...", "batch_size": 9}

一次 `dramaclaw_render_first_frames` 最多为 9 个 beat 分别提交一个独立任务，共用 batch_id；
省略 beat_indices 时自动选择接下来 9 个缺少首帧的 beat。图片队列最多并发执行 3 个，
其余任务排队；每个任务独立计时并独立保存。

GET /projects/$PID/tasks?task_type=selected_regen&episode=$EP
```

### Step 14: 音频生成 [ASYNC -> audio_generation_indextts2]

当前主线只使用 `audio/generate`。旧 `/tts/generate` 已移除，不要调用。

```
POST /projects/$PID/episodes/$EP/audio/generate
Body: {"mode": "sync_changed"}  # 可省略，后端默认 sync_changed

GET /projects/$PID/tasks/audio_generation_indextts2/$EP
SSE /projects/$PID/tasks/audio_generation_indextts2/$EP/stream
```

单 beat 音频重做：

```
POST /projects/$PID/episodes/$EP/beats/$BEAT/audio
```

### Step 15: 视频生成 [ASYNC -> single_video]

当前后端没有 `/projects/$PID/episodes/$EP/videos/generate` 整集批量视频路由。

**单轮限制**：本步骤一次用户消息只调用一次视频启动工具。存在多个 eligible beat 时，优先调用 `dramaclaw_start_video_batch`；工具默认从缺少视频且已有首帧的 beat 中自动补足并按顺序提交最多 9 个独立任务。共享视频队列最多并发执行 3 个，其余排队。只有用户明确指定单个 beat 时调用 `dramaclaw_start_single_video`；明确指定少量 beat 时才传 `auto_fill=false`。用户首次说“完成第 N 集视频生成 / 生成第 N 集视频 / 整集视频”这类笼统目标时，先按根 Skill 的“大任务先澄清拆解”处理。启动后不要继续 compose。

生成单个 beat 视频：

```
POST /projects/$PID/episodes/$EP/beats/$BEAT/video
Body: {"resolution": "720x1280", "video_backend": "huimeng_seedance-1.0-pro-fast"}

GET /projects/$PID/tasks/single_video/$EP?beat_num=$BEAT
SSE /projects/$PID/tasks/single_video/$EP/stream?beat_num=$BEAT
```

启动接口返回 `ok:false` 或 HTTP 错误时，直接向用户反馈接口错误。启动成功后如果任务状态为 `failed` / `cancelled`，直接向用户反馈 `task.error`、`error_code` 或最近日志中的失败原因；不要把失败收口成“已重做完成”。

如果用户要求“整集生成视频片段”，先读取 beats，选择最前面最多 9 个未完成且前置满足的 beat，通过批量业务工具提交；没有满足前置的 beat 时只汇报缺项。不要调用不存在的 `/videos/generate`，也不要通过通用 POST 循环模拟批量。

### Step 16: 合成 [ASYNC -> compose_episode]

合成只能在本集所有 beat 视频都已完成后启动。启动 `compose_episode` 后立即收口；不要在同一轮先启动视频再启动合成，也不要等待合成完成后继续展示成片。

优先调用 `dramaclaw_compose_episode(episode=$EP)`。专用工具内部使用下面的规范请求体；它没有
暴露 body 参数是预期行为，不得因此改用 `dramaclaw_post`，也不得在启动前重复查询同一状态。

```
POST /projects/$PID/episodes/$EP/videos/compose
Body: {"add_subtitles": true, "add_bgm": false}

GET /projects/$PID/tasks/compose_episode/$EP
SSE /projects/$PID/tasks/compose_episode/$EP/stream
```

compose 完成后，读取正式成片状态：

```
GET /projects/$PID/episodes/$EP/final
```

若返回 `data.exists=true` 且有 `data.video_url`，用 `dramaclaw_get_final_video` 展示成片。不要自己拼 host、下载地址或 `/files` 路径。

用户明确要导出文件时，可结合：

```
GET /projects/$PID/episodes/$EP/export/srt
POST /projects/$PID/episodes/$EP/export/zip
```

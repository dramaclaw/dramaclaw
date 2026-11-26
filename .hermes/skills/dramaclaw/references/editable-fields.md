# DramaClaw 虾导 可编辑字段参考

Agent 处理用户编辑请求时，查此文档获取具体字段名、类型和可选值。更新请求的返回边界与用户表达方式见 [update-behavior.md](update-behavior.md)。

---

## 项目配置

**API**: `PATCH /projects/{project}`

| 字段 | 类型 | 可选值 | 默认 |
|------|------|--------|------|
| `visual_style` | string | `chinese_period_drama`, `anime`, `realistic`, `post_apocalyptic` | `chinese_period_drama` |
| `narration_style` | string | `first_person`, `third_person` | `first_person` |
| `ethnicity` | string | `Chinese`, `Japanese`, `Korean`, `Western` | `Chinese` |
| `rhythm` | string | `fast`, `medium`, `slow` | `medium` |
| `tts_provider` | string | `cosyvoice`, `edge` | `cosyvoice` |
| `tts_model` | string | `cosyvoice-v3-flash` 等 | `cosyvoice-v3-flash` |
| `tts_voice` | string | `longanling_v3`, `zh-CN-XiaoxiaoNeural` 等 | `longanling_v3` |
| `grid_mode` | string | `3x3` 等 | `3x3` |
| `grid_model` | string | `nanobanana` | `nanobanana` |
| `video_backend` | string | 见 `GET /projects/{project}/video-backends` | `newapi_seedance-2.0-fast` |
| `video_resolution` | string | `720x1280`, `1080x1920` | `720x1280` |

`video_backend` 选择规则：
- `newapi_seedance-2.0-fast`：默认值；用户没有明确指定其它后端时，逐 beat 视频生成和单 beat 重做都用它。
- 已知限制：当前主线没有整集批量视频生成路由；不要把整集拆成多个单 beat 请求来模拟批量内分流。同一轮最多只启动一个 eligible beat 的 `single_video`。

## 角色

**API**: `PATCH /projects/{project}/characters/{name}`

| 字段 | 类型 | 说明 | 下游影响 |
|------|------|------|----------|
| `face_prompt` | string | 面部描述（发型、眼型、肤色） | → 重做肖像 |
| `description` | string | 角色简介 | 无直接重跑 |
| `gender` | string | 性别 | 无直接重跑 |
| `is_main` | bool | 是否主角 | 影响角色分级 |
| `role` | string | 角色类型（主角/配角/反派） | 影响角色分级 |
| `body_type` | string | 体型描述（纤细高挑/健壮魁梧） | 影响画面生成 |
| `fish_voice_id` | string | Fish Audio S2 声线 ID（对白 beat 专用） | → 该角色所有对白 beat 重做配音 |
| `aliases` | string[] | 别名列表 | 影响角色识别 |

## 角色身份

**新增**: `POST /projects/{project}/characters/{name}/identities`
**修改**: `PATCH /projects/{project}/characters/{name}/identities/{identity_id}`（identity_id = `角色名_身份名`）
**删除**: `DELETE /projects/{project}/characters/{name}/identities/{identity_id}`
**生成身份图**: `POST /projects/{project}/characters/{name}/identities/{identity_id}/generate`
**上传身份图**: `POST /projects/{project}/characters/{name}/identities/{identity_name}/upload`（multipart）

| 字段 | 类型 | 说明 |
|------|------|------|
| `identity_name` | string | 身份名称（如"便装"、"朝服"、"战甲"） |
| `appearance_details` | string | 外观描述（**必须**具体到服装颜色+款式+材质，避免"正装"、"便装"、"休闲装"等模糊词）。不含面部。→ 重做身份图 → 影响草图/首帧服装一致性 |

## 剧集

**API**: `PATCH /projects/{project}/episodes/{ep}`

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 集标题 |
| `content_summary` | string | 内容摘要 |
| `character_names` | string[] | 出场角色名 |
| `key_events` | string[] | 关键事件 |
| `cliffhanger` | string | 悬念/钩子 |
| `identity_ids` | string[] | 本集使用的身份 ID |

## 剧集内容（原文 & 改写稿）

原文和改写稿不在 `PATCH /episodes/{ep}` 里，各走独立端点。

| 字段 | API | 说明 | 下游影响 |
|------|-----|------|----------|
| `raw_content` | `GET/PUT /projects/{project}/episodes/{ep}/raw-content` | 原文（剧集工作台原始文案） | 改变后：改写稿（若已存在）变旧 → 需重新改写；直接生成剧本时 → 需重新生成 beats |
| `adapted_content` | `GET/PUT/DELETE /projects/{project}/episodes/{ep}/adapted-content` | 解说改写后的工作副本 | → 重新生成剧本 → 草图/首帧/视频/合成 |

**DELETE 语义**：清空改写稿后，剧本生成会回退到原文。

**注意**：改 `raw_content` 不会自动清掉 `adapted_content`；如果希望 skill 重新改写，调用 `DELETE /adapted-content` 或显式 `PUT /adapted-content` 覆盖。

## Beat

**API**: `PATCH /projects/{project}/episodes/{ep}/beats/{beat}`

| 字段 | 类型 | 说明 | 下游影响 |
|------|------|------|----------|
| `narration_segment` | string | 旁白/台词文本 | → 重做配音 |
| `visual_description` | string | 画面描述 | → 重做草图 → 首帧 → 视频 |
| `location` | string | 场景地点 | → 可能影响草图 |
| `location_description` | string | 场景详细描述 | → 可能影响草图 |
| `time_of_day` | string | 时间（day/night/…） | → 影响光影氛围 |
| `video_prompt` | string | i2v 视频提示词 | → 重做视频 |
| `keyframe_prompt` | string | k2v 关键帧提示词 | → 重做视频 |
| `video_mode` | string | `"first_frame"` / `"keyframe"` | → 影响视频生成模式 |
| `audio_type` | string | `"narration"`（旁白）/ `"dialogue"`（角色台词） | → 重做配音 |
| `speaker` | string | 说话人身份ID（dialogue 时必填，如 `"姜裳宁_皇后"`） | → 重做配音 |
| `fish_speech_prompt` | string? | Fish Audio S2 情感标记台词（如 `[angry]台词内容`） | → 重做配音 |

## 风格

**查看**: `GET /styles`（列表）、`GET /styles/{id}`（详情）
**创建**: `POST /styles`
**删除**: `DELETE /styles/{id}`（仅自定义风格）
**预览**: 直接输出 `/static/style-examples/{style_id}.jpg`（OSS 上，前端自动签名加载）

```json
// 创建
{"id": "my_style", "name": "My Style", "label": "自定义", "config": {...}}
```

## 场景

**列出**: `GET /projects/{project}/scenes`
**新增**: `POST /projects/{project}/scenes`  body `{"name":"...","description":"...","environment_prompt":"..."}`
**修改**: `PATCH /projects/{project}/scenes/{name}`
**删除**: `POST /projects/{project}/scenes/{name}/delete`

| 字段 | 类型 | 说明 | 下游影响 |
|------|------|------|----------|
| `name` | string | 场景名 | 影响场景库匹配 |
| `description` | string | 场景描述 | 影响后续生成提示 |
| `environment_prompt` | string | 环境提示词 | 影响后续生成提示 |

当前后端没有 `anchor-image/*`、`snapshot-sync`、`scene_anchor` task；不要调用这些旧路由。

## 道具

| 操作 | API |
|------|-----|
| 列表 | `GET /projects/{project}/props` |
| 规划本集道具 | `POST /projects/{project}/episodes/{ep}/props/plan` |
| 新增 | `POST /projects/{project}/props` |
| 修改 | `PATCH /projects/{project}/props/{name}` |
| 删除 | `POST /projects/{project}/props/{name}/delete` |

## 文件上传

| 操作 | API | 格式 |
|------|-----|------|
| 上传小说 | `POST /projects/{project}/ingest/upload` | multipart `file=novel.txt` |
| 上传肖像 | `POST /projects/{project}/characters/{name}/portrait/upload` | multipart `file=portrait.png` |
| 上传身份图 | `POST /projects/{project}/characters/{name}/identities/{identity_name}/upload` | multipart `file=identity.png` |

## 图池选择

**工作流**：浏览图池 → 选图 → 更新 beat 首帧

```
1. GET /projects/{project}/episodes/{ep}/grids → 获取图池数据（含 cell_url、stale 字段）
2. 向用户展示图池时，交付边界见 delivery-boundaries.md；默认读取摘要策略见 read-behavior.md
3. 用户选定图片后，先检查该图的 stale 字段：
   - stale=false → 正常选图：POST pool-select {"pool_id": "..."}
   - stale=true → 警告旧批次颜色不兼容，用户确认后传 {"pool_id": "...", "force": true}
   - 禁止 try→fail→force 模式（先不带 force → 被拒 → 再加 force 重试）
```

## 音频操作

| 操作 | API | 说明 |
|------|-----|------|
| 整集音频 | `POST /projects/{project}/episodes/{ep}/audio/generate` | [ASYNC: audio_generation_indextts2]，当前主线使用 |
| 重做单 beat | `POST /projects/{project}/episodes/{ep}/beats/{beat}/audio` | 同步，直接返回 |

旧 `/tts/generate`、`/tts/preview`、`/tts/voices` 已移除，不要调用。

## 导出

| 操作 | API | 说明 |
|------|-----|------|
| 导出 ZIP | `POST /projects/{project}/episodes/{ep}/export/zip` | 全集素材打包 |
| 导出 SRT 字幕 | `GET /projects/{project}/episodes/{ep}/export/srt` | SubRip 格式 |
| 下载文件 | `GET /projects/{project}/files/{path}` | 路径相对于 `output/{username}/{project}/` |

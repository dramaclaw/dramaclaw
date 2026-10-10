# DramaClaw 虾导 API 快速参考

**Base URL**: `$DRAMACLAW_API_URL/api/v1`
**认证**: `Authorization: Bearer $DRAMACLAW_AGENT_TOKEN`

---

## 项目管理

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects` | 列出所有项目 |
| `POST` | `/projects` | 创建项目 `{"name":"..."}`；仅前端/系统使用，虾导流程不调用 |
| `GET` | `/projects/{project}` | 获取项目配置 |
| `PATCH` | `/projects/{project}` | 更新配置 |

## 摄入

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/projects/{project}/ingest/upload` | 上传小说 (multipart) |
| `POST` | `/projects/{project}/ingest/start` | 启动摄入 `{"filename":"...", "rebuild":false}` [ASYNC]；已摄入项目覆盖重建必须二次确认后传 `{"rebuild":true}` |

摄入 API 只允许以上两个路径。`ingest_fast` 是后端任务类型，不是 HTTP 路由；不要调用或推断 `/ingest/init`、`/ingest/setup`、`/ingest_script`、`/ingest_fast`、`/projects/{project}/ingest` 或其它 ingest 变体。遇到这些路径的 404 时，不要解释为摄入模块未启用，应改用上表真实路由。

## 角色

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects/{project}/characters` | 列出角色 |
| `POST` | `/projects/{project}/characters` | 手动添加角色 `{"name":"...","role":"...","is_main":true,"gender":"female","age_group":"youth","description":"...","face_prompt":"..."}` |
| `POST` | `/projects/{project}/characters/build` | 提取角色 [ASYNC] |
| `PATCH` | `/projects/{project}/characters/{name}` | 修改角色 |
| `POST` | `/projects/{project}/characters/{name}/portrait` | 单个肖像 |
| `POST` | `/projects/{project}/characters/{name}/portrait/upload` | 上传肖像 (multipart) |
| `GET` | `/projects/{project}/characters/{name}/identities` | 查看身份 |
| `POST` | `/projects/{project}/characters/{name}/identities` | 新增身份 |
| `PATCH` | `/projects/{project}/characters/{name}/identities/{identity_id}` | 修改身份（identity_id = `角色名_身份名`） |
| `DELETE` | `/projects/{project}/characters/{name}/identities/{identity_id}` | 删除身份 |
| `POST` | `/projects/{project}/characters/{name}/identities/{identity_name}/upload` | 上传身份图 |
| `POST` | `/projects/{project}/characters/{name}/identities/{identity_id}/generate` | 生成身份图（Identity Locking）`{"style":"...","model":"..."}` [SYNC] |

## 分集

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects/{project}/episodes` | 列出分集 |
| `POST` | `/projects/{project}/episodes/plan` | 分集规划 `{"target_episodes":10,"planning_mode":"chapters"}` [ASYNC] |
| `GET` | `/projects/{project}/chapters` | 检测小说章节 |
| `PATCH` | `/projects/{project}/episodes/{ep}` | 修改集信息 |
| `POST` | `/projects/{project}/episodes/{ep}/identities/plan` | 规划本集身份 |

## 剧本

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects/{project}/episodes/{ep}/script` | 获取剧本（当前后端可能返回 script_mode，但不要依赖 literal_source 作为硬判定） |
| `PUT` | `/projects/{project}/episodes/{ep}/script` | 保存完整剧本 `{"beats":[...]}` |
| `GET` | `/projects/{project}/episodes/{ep}/beats` | 获取 beat 列表 |
| `PATCH` | `/projects/{project}/episodes/{ep}/beats/{beat}` | 编辑 beat |

## 原文 & 改写稿（新流程输入）

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects/{project}/episodes/{ep}/raw-content` | 读原文 |
| `PUT` | `/projects/{project}/episodes/{ep}/raw-content` | 保存原文 `{"content":"..."}`（UPSERT） |
| `GET` | `/projects/{project}/episodes/{ep}/adapted-content` | 读改写稿（未保存返回空串） |
| `PUT` | `/projects/{project}/episodes/{ep}/adapted-content` | 保存改写稿 `{"content":"..."}` |
| `DELETE` | `/projects/{project}/episodes/{ep}/adapted-content` | 清空改写稿，回退到原文 |

## 解说改写 & 剧本生成（Step 10）

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/rewrite/generate` | 解说改写：原文 → 改写稿 `{"target_beats":18,"beat_chars_min":14,"beat_chars_max":20,"narration_style":"first_person"}` [ASYNC → content_rewriter] |
| `POST` | `/projects/{project}/episodes/{ep}/script/generate` | 生成剧本 [ASYNC → script_writer]；当前后端没有 `literal-script/generate` 路由 |

## 画面生成

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/sketches/generate` | 草图 `{"style":"...","model":"nanobanana","grid_index":0,"sketch_location_grouping":true}` [ASYNC]。后端按 beat 数自动拆成 N 张 grid（2x4 起步，按容量 8/6/4/2/1 降级；18 beat→`2x4+2x4+1x2` 共 3 张）。每次只启动一个 `grid_index`；首次调用的 SSE result 里返回 `total_grids`。如果还有后续 grid，等用户下一轮“继续”再启动下一个；不要同一轮循环所有 grid。详见 `step-api-reference.md` Step 12。 |
| `POST` | `/projects/{project}/episodes/{ep}/grids/generate` | 九宫格 [ASYNC] |
| `POST` | `/projects/{project}/episodes/{ep}/grids/{idx}/regenerate` | 重新生成单个网格 [ASYNC] |
| `POST` | `/projects/{project}/episodes/{ep}/grids/{idx}/cut` | 切割入池 |
| `GET` | `/projects/{project}/episodes/{ep}/grids` | 查看九宫格与图池（返回 `images[].stale` 布尔字段，true=旧版脚本生成） |
| `POST` | `/projects/{project}/episodes/{ep}/beats/{beat}/pool-select` | 从图池选图 `{"pool_id":"...","force":false}` 旧批次需 `force:true` |
| `POST` | `/projects/{project}/episodes/{ep}/sketches/assign-colors` | 草图配色（为身份分配唯一颜色）[SYNC] |
| `POST` | `/projects/{project}/episodes/{ep}/sketches/detect-identities` | AI 身份检测（识别草图中出场角色）[SYNC] |

## TTS & 音频

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/audio/generate` | 批量语音生成 [ASYNC: audio_generation_indextts2]；当前主线用这个 |
| `POST` | `/projects/{project}/episodes/{ep}/audio/system-voices/prepare` | 经用户确认后准备系统声线 [ASYNC: system_voice_setup]；仅虾导使用，不启动 TTS |
| `POST` | `/projects/{project}/episodes/{ep}/beats/{beat}/audio` | 重做单beat音频 (SYNC) |

旧 `/tts/generate`、`/tts/preview`、`/tts/voices` 已移除，不要调用。

## 视频

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/optimize/video-global` | 全局视频优化(SuperPower⚡️) `{"language":"en"}` en=英文(默认), zh=中文 [ASYNC] |
| `POST` | `/projects/{project}/episodes/{ep}/beats/{beat}/video` | 单beat视频重做 [ASYNC: single_video]。默认 `{"video_backend": "huimeng_seedance-1.0-pro-fast"}`；只有用户明确指定 1.5 Pro / 有声 1.5 / Huimeng 1.5 时才传 `{"video_backend": "huimeng_seedance-1.5-pro"}`。同一用户请求里同一 beat 只 POST 一次；启动接口返回 `ok:false` 或 HTTP 错误时，必须直接反馈接口 `error`。POST 返回 2xx 且 `ok`/`generated: true` 后，查 `GET /projects/{project}/tasks/single_video/{ep}?beat_num={beat}`；若状态是 `failed` / `cancelled`，必须反馈 `task.error`/`error_code`，不要说已完成。不要因 `Task not found`、任务状态缺失或无 `result.video_path` 重复 POST。没有 `result.video_path` 时不要探测 `/files`，不要探测 `/api/v1/projects/{project}/files`，只能按已启动或当前状态收口；`generated: true` 不等于返回新视频路径，不要交付 beat 记录里的旧 `video_url`，不要拼接 host。**不要触发整集 compose/generate/optimize** |
| `POST` | `/projects/{project}/episodes/{ep}/videos/compose` | 合成 `{"add_subtitles":true,"add_bgm":false}` [ASYNC] |

## 导出 & 文件

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/export/zip` | 导出 ZIP |
| `GET` | `/projects/{project}/episodes/{ep}/export/srt` | 导出 SRT 字幕 |
| `GET` | `/projects/{project}/episodes/{ep}/final` | 读取最终成片状态和可展示 `video_url` |
| `GET` | `/projects/{project}/files/{path}` | 下载文件 |

## 再生成

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/sketches/regenerate` | 重做指定草图 `{"beat_indices":[...],"style":"..."}` [ASYNC: sketch_regen] |
| `POST` | `/projects/{project}/episodes/{ep}/beats/regenerate` | 重做指定首帧 `{"beat_indices":[...],"style":"..."}` [ASYNC: selected_regen] |
| `POST` | `/projects/{project}/episodes/{ep}/grids/{idx}/regenerate` | 重做单个网格 `{"style":"...","model":"nanobanana"}` [ASYNC: grid_regenerate] |

## 场景与锚图

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects/{project}/scenes` | 列项目场景库；展示场景图时取 `master_url` / `reverse_master_url` / `pano_url` / `custom_scene_url`，不要用本地 `*_path` |
| `POST` | `/projects/{project}/scenes` | 新增场景 `{"name":"...","description":"...","environment_prompt":"..."}`；已存在会返回错误 |
| `PATCH` | `/projects/{project}/scenes/{name}` | 修改场景；当前后端支持改名与更新描述/提示词字段 |
| `POST` | `/projects/{project}/scenes/{name}/delete` | 删除场景 |
| `POST` | `/projects/{project}/scenes/{name}/master/generate-async` | 生成场景 master 图 [ASYNC: scene_reference_asset] |
| `POST` | `/projects/{project}/scenes/{name}/reverse/generate-async` | 生成场景 reverse master 图 [ASYNC: scene_reference_asset] |

## 道具（只读）

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects/{project}/props` | 列项目道具 |
| `POST` | `/projects/{project}/episodes/{ep}/props/plan` | 规划本集道具 |

当前后端还提供项目级道具写接口：`POST /projects/{project}/props`、`PATCH /projects/{project}/props/{name}`、`POST /projects/{project}/props/{name}/delete`。

## 风格

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/styles` | 列出风格 |
| `GET` | `/styles/{id}` | 风格详情 |
| `POST` | `/styles` | 创建自定义风格 |
| `DELETE` | `/styles/{id}` | 删除自定义风格 |
| `GET` | `/styles/{id}/preview` | 风格预览图（返回图片文件）。**拿到 200 响应即完成，直接告知用户"预览图已获取"，不要暴露 URL，不要再探测其他路径** |
| `POST` | `/projects/{project}/styles/analyze` | 风格分析（上传参考图提取风格参数）multipart/form-data [SYNC] |

## 流水线状态

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects/{project}/pipeline/status` | 聚合流水线进度（支持 `?episode=N`）|

## 任务管理

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/projects/{project}/tasks` | 列出项目任务 |
| `GET` | `/projects/{project}/tasks/{task_type}/{episode}` | 查询项目任务状态，单 beat 任务带 `?beat_num=N` |
| `GET` | `/projects/{project}/tasks/{task_type}/{episode}/stream` | 项目任务 SSE，单 beat 任务带 `?beat_num=N` |
| `GET` | `/projects/{project}/tasks/stream` | 项目任务聚合 SSE |
| `DELETE` | `/projects/{project}/tasks/{task_type}/{episode}` | 取消项目任务 |
| `DELETE` | `/projects/{project}/tasks/completed` | 清理项目已完成任务 |

# 当前项目初始化阶段（Steps 1-7）

> API 请求细节不确定时，`Read references/pipeline-details.md`。

## 前置：项目存在性检查

Step 0（SKILL.md §0）的 `/pipeline/status` 返回决定从哪一步开始：
- **404**：当前会话绑定的项目不存在或不可访问 → 停止，提示用户先在前端创建/打开项目；虾导不调用 `POST /projects`
- **200 + 各阶段全 false**：项目已存在但未摄入 → 从 Step 1（获取小说文件）开始
- **200 + 部分完成**：实际上应走 resume.md；如误路由到此，退回按 `next_step` 定位

## 入口决策树

> 进入本 playbook 的前提是当前消息已经带有剧本文档附件，或前端已注入 `[DRAMACLAW_INGEST_AUTOMATION]` / 明确摄入上下文。若用户只是用聊天文字要求“创建/生成/写剧本”，不得进入下面流程；直接告知只能通过“虾料”上传剧本文档。

```
1. 获取小说文件
   当前消息必须已有剧本文档附件或虾料摄入上下文
   ├─ 有 → 使用前端提供的上传/摄入上下文
   └─ 没有 → 停止，提示通过“虾料”上传剧本文档

2. 自动执行（不需要问用户）
   上传小说(1) → 启动摄入(2)。摄入是异步任务，依赖完成后才可配置；按已授权范围及 async-tasks.md 决定持续等待或返回状态。

3. 智能推荐配置（§5 决策点规则）
   摄入完成后分析小说内容再推荐：
   - 时代背景/关键词 → 视觉风格
   - 角色名/背景 → 种族
   - 人称视角 → 叙事方式
   - 情节节奏 → rhythm

4. 一次性展示推荐方案，让用户确认/修改

5. 确认后 → 配置项目(3)；配置完成后按既有授权及运行模式推进
```

**运行模式**：复用用户已选模式；未指定时按请求范围推进，只在必要选择或授权不明确时询问。规则见 `../references/run-modes.md`。

## 步骤详情

**步骤详情**：见 `references/pipeline-details.md` Steps 1-7。项目创建由前端/系统完成，不属于虾导步骤。

**Step 4 失败处理**：若 `build_characters` 返回空结果，从小说内容分析角色后通过 `POST /projects/{project}/characters` 逐个添加。

**Step 5 face_prompt 前置**：生成肖像前必须读取 `GET /projects/{project}/characters`，检查核心角色/重要角色的 `face_prompt`。
- 如果为空，先根据角色名、性别、年龄段、description 生成一句具体面部特征描述，调用 `dramaclaw_update_character_face_prompt` 写入。
- `face_prompt` 只写脸部特征：发型、脸型、五官、肤色、年龄感、气质；不要写服装、身份、场景。
- 只有缺失角色全部补齐后，才允许进入肖像生成。
- 如果肖像任务报“请先设置面部特征 (face_prompt)”，停在当前角色，补齐该角色 `face_prompt` 后再重试，不要跳过或继续生成其它依赖项。

**Step 6.5 角色分级标准**：

| 级别 | 条件 | 处理 |
|------|------|------|
| 核心角色 | `is_main=true`，或多集反复出场 | Portrait + 身份图 |
| 重要配角 | 有人名，2集以上出场 | Portrait + 身份图 |
| 一次性配角 | 仅1集出场，无关键剧情 | 跳过 |

### 决策点参考

**智能推荐**（分析小说内容后一次性推荐）：
- `visual_style`: 古代/武侠→`chinese_period_drama` | 现代都市→`realistic` | 末日→`post_apocalyptic` | 二次元→`anime`
- `narration_style`: 原文人称 → `first_person`/`third_person`（默认 first_person）
- `ethnicity`: 姓名/地理 → `Chinese`/`Japanese`/`Korean`/`Western`（默认 Chinese）
- `rhythm`: 情节密度 → `fast`(3s)/`medium`(4s)/`slow`(5s)（默认 medium）

**用户必选**（首次或用户主动问时展示）：
- 配音: `tts_provider`+`tts_voice`（默认 cosyvoice + longanling_v3）
- 视频后端: `video_backend`（默认 `huimeng_seedance-1.0-pro-fast`；`huimeng_seedance-1.5-pro` 仅在用户明确指定时使用；旧值仅兼容历史任务）
- 分辨率: `video_resolution`（720x1280/1080x1920，默认 720x1280）

## Step 7 完成 → 阶段过渡

简短汇报全局准备结果并展示必要检查点。按 `../references/run-modes.md` 继续：用户选择逐步确认时在下一未批准步骤前暂停；按目标推进时，通过必要质量门即可继续，不额外要求“继续”。

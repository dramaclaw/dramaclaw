# 当前项目初始化阶段（Steps 1-7）

> 本文件是 Steps 1-7 流程顺序的唯一事实源。API 请求细节不确定时，读取
> `references/step-api-reference.md`；技术参考不得改变本文件的顺序。

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

2. 按当前状态执行一个动作（不重复确认同一步）
   - 前端已注入 `[DRAMACLAW_INGEST_AUTOMATION]`：上传和摄入启动已由前端处理，不重复调用写工具，只汇报当前状态。
   - 当前附件尚未上传：只执行上传（Step 1）并收口；用户下次继续时再启动摄入。
   - 文件已上传但摄入未启动：只启动摄入（Step 2）并立即收口。
   - 摄入处于 queued/running：只告知后台正在摄入，不等待完成后继续配置。

3. 智能推荐配置（§5 决策点规则）
   摄入完成后分析小说内容再推荐：
   - 时代背景/关键词 → 视觉风格
   - 角色名/背景 → 种族
   - 人称视角 → 叙事方式
   - 情节节奏 → rhythm

4. 一次性展示推荐方案，让用户确认/修改

5. 确认后 → 配置项目(3)；配置完成后询问运行模式，不继续启动角色提取
```

**运行模式**：配置完成后**必须**先问一句「要我**每步确认**，还是**自动推进（每轮一步）**？」，
然后 `Read references/run-modes.md` 按所选模式执行：
- **逐步确认模式** → 每个写操作步骤前停下问用户，一次只推进一步
- **自动推进模式** → 用户下次说“继续”时按断点推进；每轮仍最多启动一个写任务，启动后收口

**关键**：不要逐项问用户选择配置，分析后一次性推荐；但**运行模式必须显式问**。

## 步骤详情

**API 详情**：见 `references/step-api-reference.md` Steps 1-7。项目创建由前端/系统完成，不属于虾导步骤。

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

**无论手动/自动模式**，输出阶段摘要（如："全局准备完成：项目 X，5角色(2核心3重要)，10集，肖像已生成"）。

**逐步确认模式**：见 `references/run-modes.md` 模式一——从 Step 3 起每个写操作步骤前都停下问用户，
一次只推进一步。CP1 处展示核心角色 Portrait + 级别 + 分集标题，用户可改角色分级/外貌/分集数量，
确认后再问「执行下一步吗」。

**自动推进模式**：见 `references/run-modes.md` 模式二——自动选择下一步，但每轮最多启动一个写任务；
启动后立即收口。到 CP1（展示核心角色+分集标题）时也必须停下，等待用户继续。

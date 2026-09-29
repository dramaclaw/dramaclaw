# 全新 TV Director 等价系统：细化到功能逻辑的技术开发方案

版本：研究方案 v0.1（历史设计），2026-09-25 按融合 v2.1 收口，历史设计不再单独维护执行规则。事实依据见[按钮级分析报告](liblib-tv-director-analysis.md)。

> 本文不是 LibTV 服务端源码。当前已有独立 Director 首切片，但尚未实现完整产品；不得沿用旧稿“尚未开发”判断现状。后续实现以[融合 v2.1 主方案](tv-director-skill-fusion.md)及其五份专项合同为准：按钮、Skill、状态/费用、文档语义、验收各有唯一权威。本文件保留观察经过与界面研究，冲突的流程与伪代码已校正；原始观察不因新设计改变。

## 1. 产品范围与不可省略的交付条件

全新项目实现完整工作闭环：画布感知 → 全能/原创/改编/导演模式 → 结构化参数与引用 → 可恢复 Agent → 文档、分镜、媒体任务 → 审核与版本 → Skill 创建/使用/修改/测试/导入/私有保存/可选发布。

不把现有 dramaclaw 的四阶段页面作为界面基线；不通过依赖 LibTV 私有线上接口来实现正式产品。研究阶段调用与自建产品供应商接入分离。视频提供方首期遵守既有要求：仅 MiniMax H3；文本模型单独配置，不能把“视频只要 H3”误解成用视频模型写剧本。

必须独立验收三个层次：

- 视觉/交互一致性：控件、布局、状态、键盘路径与截图可对照。
- 协议/行为一致性：用户选择、实际参数、引用、顺序、确认与返回一一对应。
- 内容质量：同源输入、事实保留、动作可拍、时长可执行、跨集连续性；不靠“看起来像”验收。

不得承诺生成文本逐字相同。第三方品牌、头像、示例作品、媒体图标素材另行替换为自有资产。

## 2. 独立项目边界与模块树

早期提出 TypeScript 前端 + Python 服务端、PostgreSQL/Redis 的独立部署原型。融合 v2 已选择在本仓库独立 director 域落地，CE首版使用项目 state_dir 下SQLite与repository接口，持久事件/outbox/费用账本从P1实现；不按下列概念目录另建重复产品。前端编辑器/画布依赖开工时核实官方能力并锁定版本。本节目录仅表示模块职责，实际代码落点见v2实施表。

```text
director-studio/
  apps/web/src/
    shell/                    # 项目入口、浮窗、停靠、快捷键
    canvas/                   # 节点、边、选区、视口、事务
    director/
      composer/               # 富文本、引用、附件、发送校验
      presets/                # 原创/改编/角色选择
      conversation/           # 消息、工具卡、问卷、审批卡
      sessions/               # 历史、新建、关联、恢复
      settings/               # 全局和会话设置
    screenplay/
      tree/ editor/ diff/     # VFS、富文本、选区修改、审核
    skills/
      catalog/ editor/ intake/ tests/ publishing/
    media/                    # 报价、任务、预览、重试
  services/api/
    routes/ schemas/ auth/    # 薄接口层
  services/core/
    sessions/ events/ runs/ checkpoints/
    skills/ tools/ scripts/ source/ documents/ canvas/
    approvals/ billing/ generation/ audit/
  services/workers/           # Agent、媒体、导入解析、导出
  packages/contracts/        # 由Schema生成TS/Python类型和客户端
  skills/                    # 本产品独立编写、版本化的方法包
  tests/
    contract/ workflow/ golden/ browser/ security/ recovery/
```

路由只鉴权、解析、调用用例；不得在 route 中散布提示词、文档解析和媒体参数拼装。

## 3. 数据模型：状态不依赖聊天记忆

| 实体 | 关键字段 | 约束 |
|---|---|---|
| Workspace/Canvas | id、owner、revision | 明确空间与画布，不复用含糊 projectId |
| CanvasNode | id、canvasId、kind、payload、revision | 节点引用稳定；位置不是唯一身份 |
| CanvasEdge | id、source、target、inputOrder | 同一目标的素材顺序可持久化 |
| Session | id、workspaceId、canvasId、nodeId?、agentMode、modelKey | 一个关联剧本入口可查找原会话 |
| Message | id、sessionId、role、parts、createdAt | parts 为结构化JSON，文本只负责展示 |
| Run | id、sessionId、status、attempt、parentRunId、lastSeq | run完成不等于作品完成 |
| Event | sessionId、seq、runId、type、payload | (sessionId,seq) 唯一；先持久化再广播 |
| ToolCall | id、runId、name、argsHash、status、result | requestId幂等，副作用可追踪 |
| ScriptWork | id、workKey、mode、checkpoint、confirmedSpec、revision | 工作状态可独立恢复 |
| SourceDocument | id、sha256、mime、normalizedText、lineIndex | 原稿不可覆盖；所有改编可追溯 |
| SourceSpan | sourceId、chapter、startLine、endLine、hash | 每个改编段落有来源或明确新增标记 |
| EpisodeIdentity | sourceEpisodeLabel、workflowEpisodeOrdinal、deliveryEpisodeLabel、artifactPath、mappingReason | 原稿“第2集”与单源任务 `episodeNo=1` 不能互相覆盖；UI、报价、文件、交付卡须各有明确映射 |
| StoryStateEvent | sceneId、storyTime、entityId、location、holder、form、transferCause、sourceSpan? | 道具归属、人物位置、日夜形态按场景顺序可追溯；未知转移不得自动补成事实 |
| DocumentVersion | docId、version、content、hash、origin | 正式稿不可原地覆盖 |
| DraftChangeSet | id、baseVersions、proposedVersions、hunks、decisions | 审查与正式稿分离 |
| SkillVersion | key、version、manifest、filesHash、visibility | 历史run绑定不可变版本 |
| SkillTest | skillVersion、fixture、assertions、result、cost | 自测可复跑、可比较 |
| Approval | id、scope、quoteId、maxCost、status、expiresAt | 审批不是普通问卷答案 |
| Quote | id、requestHash、amount、currency、free、expiresAt | 参数改变报价失效 |
| GenerationTask | id、provider、requestHash、quoteId、state、artifactIds | 同一确认不能重复创建扣费任务 |
| ReferenceBinding | id、nodeId、assetVersion、kind、displayOrder、modelSlot | 提示词引用与素材顺序统一来源 |
| AuditRecord | actor、operation、before/after hash、evidenceId | 记录副作用，不记录密钥 |

关系数据库保存元数据/事务，对象存储保存附件、版本正文与媒体；小文本可以数据库存储。数据库备份与对象存储快照必须配套，否则只恢复会话会丢产物。

## 4. UI 实现落点与按钮映射

研究报告的 A/O/D/Q/S/E/R/K 编号就是验收索引，不能实施时另起一套不对应的功能列表。

| 模块 | 对应按钮 | 主组件/逻辑 | 最低自动化验收 |
|---|---|---|---|
| DirectorShell | A01–A11 | FloatingWindow、DockedPanel、SessionHeader | 浮窗/停靠切换不重发请求，尺寸持久化 |
| Composer | A14–A24 | PartEditor、ReferencePicker、UploadQueue、SendController | 参数往返、上传未完成禁发、引用删除一致 |
| OriginalPreset | O01–O16 | GenreWheel、PresetFields、EpisodeInput、StructureMenu | 默认/上限/自动/自定义/参考图映射 |
| AdaptPreset | D01–D09 | ManuscriptChip、DirectionRadio、EpisodeInput | 四方向；输入1与UI策略一致；不丢原稿 |
| HumanQuestion | Q01–Q07 | QuestionPager、OptionInput、FeedbackSubmit | 逐题保留、单次提交、过期问卷阻止 |
| ApprovalCard | Q08–Q09 | CostQuote、ApprovalCheckbox | 报价变化重确认，取消无生成副作用 |
| Settings | S01–S07 | DefaultsForm、SessionPolicy | 新会话默认与当前会话分离 |
| ScriptEditor | E01–E23 | FileTree、MarkdownEditor、SelectionComposer | 保存后发选区、绑定正确文档与会话 |
| DraftReview | E24–E32 | HunkNavigator、ReviewActions、ConflictDialog | 部分接受、全部撤回、刷新续审 |
| DirectorRole | R01–R18 | RoleCarousel、RoleEditor、RoleIntake、PromptResultCard | 私有创建/编辑/复用，禁止意外公开 |
| SkillWorkbench | K01–K20 | Catalog、SkillEditor、TestRunner、PublishDialog | 创建/更新/导入/测试/审核版本闭环 |

视觉基线不是一个聊天框，而是**画布节点＋节点动作条＋TV Director 浮窗/停靠＋双栏设定器＋全屏编辑器＋审批/审阅层**。研究报告 §3.3–3.4 已把用户补充的三张截图落成逐屏合同。先从真实截图测量尺寸/间距/字体/颜色形成新项目 DESIGN.md 和 token，不凭印象重新设计。至少比对1200×863与1920×1080两档；选择态、禁用态、加载态、错误态各有截图。

### 4.1 页面层级与可恢复的 UI 状态

```text
CanvasPage
├─ CanvasToolbar / DotGrid / ScriptNode[] / MediaNode[]
│  └─ ScriptNode: NodeTitle + ContextActionBar + SectionRail + SectionPreview
├─ DirectorShell
│  ├─ SessionHeader + HistoryDrawer + SettingsDialog + SkillDrawer
│  ├─ MessageTimeline
│  │  ├─ Text/Thought/ToolProgress/DocumentCard
│  │  ├─ HumanQuestionCard / CostApprovalCard / DiffReviewCard
│  │  └─ ResultCard / ErrorRecoveryCard
│  └─ Composer + AttachmentQueue + ContextChips + ModePicker + ModelPicker
├─ ScriptPresetDialog: Top8Rail + GenreFusionStage + FieldSummaryRow + Footer
└─ ScriptEditor: FormattingToolbar + FileOutline + DocumentSurface + ReviewLayer
```

不能让 `ScriptEditor`、`ScriptPresetDialog`、`DirectorShell` 各自用局部布尔值抢层级：统一 `OverlayCoordinator` 保存 `modalType / activeNodeId / activeDocumentId / returnFocusId`，关闭/ESC按层级逐层返回；消息滚动、画布缩放、编辑器文档游标互不污染。`DirectorShell` 的当前 `sessionId`、浮窗尺寸、停靠模式、草稿和未审变更从可恢复状态加载；关闭浮窗只隐藏，绝不触发取消 run 或删除会话。

| UI 状态 | 进入条件 | 退出条件 | 必测回放 |
|---|---|---|---|
| 欢迎/新对话 | 新建或无会话 | 选择模式、发送或恢复历史 | Top8、通知提示、上下文引用、Send禁用态 |
| 浮窗有会话 | 打开Director | 停靠、最小化/关闭、打开编辑器 | 400×640基线、拖拽边界、刷新后同一session |
| 剧本节点预览 | 产物节点存在 | 目录切换/打开编辑器/下载 | 激活项与右侧文件一致，不重新生成 |
| 设定器单题材 | 打开原创预设 | 融合、取消、确认 | Top8映射、六字段摘要、结构/集数弹层 |
| 设定器双题材 | 选择融合题材 | 移除融合、取消、确认 | 主/融合两列互斥，两个 `aria-pressed`，禁用对侧重复项 |
| 费用等待 | 报价 `free=false` | 取消、单次确认 | 未勾自动确认；30积分审批有独立事件和审计记录 |
| 文件交付待确认 | 文档写入且run到检查点 | 确认/修改/忽略 | 交付卡打开正式文件；问卷不被误当费用批准 |
| 全屏编辑/差异审阅 | 打开文件或 patch 草稿 | 保存/接受/关闭 | 左章节目录、格式栏、同文档版本、刷新续审 |

### 4.2 视觉 token 与响应式合同

以下是**实测桌面参考**，不是复制第三方商标或图像素材的指令。1920宽时浮窗400×640、右/下间距16、圆角28、半透明底；原创设定器整体1232×640，左栏264、间隔8、右栏960，左右卡片底色约`#212121`、圆角24。1200宽时整体收至1080×640、左右两栏仍保留；六个字段卡在宽屏约132×74、圆角14，取消/确认80×36。选中目录文本为浅青 `#5ddcff`，确认是浅色填充主按钮；中文字体以系统字体/PingFang SC/Noto Sans SC优先。尺寸和颜色要由主题 token 管，不可在每个组件散写 magic number。

```css
/* 新项目的参考 token；测量值与设计建议必须在设计记录里分别标注。 */
:root {
  --director-panel-width: 400px;
  --director-panel-height: 640px;
  --director-panel-radius: 28px;
  --director-modal-max-width: 1232px;
  --director-modal-height: 640px;
  --director-presets-width: 264px;
  --director-modal-gap: 8px;
  --director-surface: #212121;
  --director-section-active: #5ddcff;
}
.script-preset-dialog {
  width: min(var(--director-modal-max-width), calc(100vw - 120px));
  max-height: calc(100vh - 32px);
}
```

`calc(100vw - 120px)` 是为匹配1200/1920两次观察而提出的实现公式，**不是**已取得的原站 CSS 源规则。低于1200、低于640高以及手机宽度还没在原站实测；本系统建议左栏改抽屉/标签、摘要卡横向滚动或分行、主操作粘底，必须另做可用性和截图验收，不声称原站也是这样。

### 4.3 题材融合和参数摘要：同一状态只序列化一次

```ts
type GenreId = string;
type PresetDraft = {
  templateId?: string;
  primaryGenre: GenreId | null;
  fusionGenre: GenreId | null;
  fields: Record<string, { optionIds: string[]; customText?: string; refImageId?: string }>;
  episodeCount: number | "auto";
  structureId: string | null;
};

function selectGenre(d: PresetDraft, side: "primary" | "fusion", id: GenreId): PresetDraft {
  const other = side === "primary" ? d.fusionGenre : d.primaryGenre;
  if (id === other) return d; // 与可见 disabled 态一致；不能提交重复题材
  return { ...d, [side === "primary" ? "primaryGenre" : "fusionGenre"]: id };
}

function removeFusion(d: PresetDraft): PresetDraft {
  return { ...d, fusionGenre: null }; // 不清空主题材和其它字段
}
```

`Top8Rail` 选中卡片时用一个配置对象原子更新题材/受众/角色/时代/看点/画风/结构等草稿，六张摘要卡是**同一 draft 的投影**，不能维护另一套文本状态。主体/融合候选从同一题材列表生成，`disabled={id===otherGenre}`、`aria-pressed={id===selectedGenre}`；图片缺失必须仍能靠文字、排序和状态操作。两集实测已确认：先手设2集·三幕式、都市写实，再选「现实职场成长」，集数/结构回到模板的15集，画风仍为都市写实。新系统若选择对齐该交互，就给被覆盖字段即时提示并在发送前展示**最终**参数；不能默默把先前的2集发送成15集。其他Top8卡对手改字段的覆盖范围仍需逐卡验证。

点击「确认」只生成结构化 `scriptPreset` chip 和 `display[]`，不创建会话也不扣费。点击 Send 才从 `PresetDraft` 的冻结快照编译 `preset.mode="create"`、`genre="<主体 + 融合>"`、各真实 fieldKey、`episodeCount`、`structure` 等消息参数；发送前预览 UI 值→ID→序列化值清单，发送后保存 payload hash 与展示值。实测两集 WebSocket 消息同时带正文中的 `{{scriptPreset:<id>}}` 标记和独立 `scriptPreset` part，其 `preset` 含 `genre/audience/characters/era/highlights/visualStyle/episodeCount/structure/mode`；本次 `episodeCount` 边界值为字符串 `"2"`，不是 number。新系统内部仍用强类型整数，协议适配层负责该转换并做往返断言。删除 chip 必须删除 payload 中的引用，而不是只删图标。字段与服务端 schema 不匹配时阻止发送并指出哪张摘要卡有问题。

### 4.4 剧本节点、编辑器和浮窗的共同文件源

`ScriptNode` 只保留 `workId/fileId/activeSectionId/previewRevision`，正文按选中章节从 `DocumentVersion` 读取；顶部「生成角色图」「全能创作」是新动作，必须先形成显式 intent，不可因滚动/切目录触发。浮动动作条的打开编辑器与交付卡打开编辑器走同一 `openDocument(fileId,revision)`；编辑器左侧目录来自 Markdown/结构化章节索引，而非把卡片预览 HTML 再解析一遍。章节选择同步高亮和正文定位，下载基于当前已确认版本。文档重写后节点预览、全屏编辑器、引用 chip 的版本必须一起失效刷新；未审草稿仅在审阅层可见，不得提前污染正式节点。

键盘和无障碍验收：设定器打开后焦点落标题或首个可操作项，Tab覆盖Top8、双侧题材、六张字段卡与底部操作；ESC关最顶层且焦点回开窗按钮。融合视觉的两个大圆只是辅助，读屏必须读出主体/融合题材名称与选中状态。费用确认不能由 Enter 穿过普通问卷默认触发；报价变化、会话切换、页面刷新后必须重新核对批准对象。

## 5. 类型化输入与单一参数来源

所有UI值先存为领域枚举/ID，再由提交编译器转换；显示文案不能兼任业务主键。为了兼容研究协议，可在 boundary serializer 转换到中文 direction，但内部存 `condense` 等稳定key。

```ts
type DirectorMode = "omni" | "script_original" | "script_adaptation" | "directing";
type AdaptDirection = "condense" | "expand" | "conflict" | "hook";
type MessagePart =
  | { type: "text"; text: string }
  | { type: "asset"; bindingId: string; kind: "image"|"video"|"audio"|"document" }
  | { type: "node"; nodeId: string; revision: number }
  | { type: "scriptPreset"; preset: ScriptPreset }
  | { type: "skill"; skillKey: string; version: string }
  | { type: "selection"; selection: SelectionRef };

interface SubmitCommand {
  clientMessageId: string;
  sessionId: string;
  expectedSessionRevision: number;
  parts: MessagePart[];
  context: {
    workspaceId: string; canvasId: string; nodeId?: string;
    mode: DirectorMode; modelKey: string;
    approvalPolicy: "ask" | "auto_with_limit";
  };
}
```

`compileSubmit(viewState)` 的必要步骤：

1. 验证当前工作区/画布/会话一致，禁止用全局 mutable currentNode 覆盖已排队请求。
2. 拒绝 pending/failed 上传，检查 asset MIME 与节点类型。
3. 冻结 preset、SkillVersion、reference order、node/document revisions。
4. 确认模型支持的字段；UI不支持的字段不显示，服务端不支持的字段明确报错。
5. 生成 clientMessageId；同一消息重试使用同一 ID。
6. 服务端保存有效输入快照，再创建 run。不得只有前端校验。

原创参数需要覆盖主体/融合题材、每个动态字段的选项、自定义文本、参考图、集数自动/指定、结构；改编参数覆盖原稿版本、四方向、集数、明确的每集时长。预设中的缺省与用户显式指定必须可区分。

## 6. 会话、流式事件与恢复

建议自有协议直接传JSON对象，避免兼容源协议中的二次字符串编码；研究抓包的读取器负责兼容双重编码，业务内部不要延续这种负担。

```ts
interface EventEnvelope<T> {
  sessionId: string;
  runId: string;
  seq: number;
  eventId: string;
  type: string;
  schemaVersion: 1;
  payload: T;
}

function reduceEvent(state: SessionState, event: EventEnvelope<unknown>) {
  if (event.seq <= state.lastSeq) return state;       // 重放去重
  if (event.seq !== state.lastSeq + 1) return requestReplay(state.lastSeq);
  return applyTypedEvent(state, event);              // 工具、文档、问卷分别处理
}
```

本节早期事件名仅用于理解研究回放；新实现使用[v2事件合同](tv-director/workflow-contracts.md)的统一枚举与payloadVersion，不再各模块发不同同义事件。必须同时维护run状态与work checkpoint。

服务端写数据库事件日志后广播；断线客户端带 afterSeq 重放。网络断开不取消服务端长任务，用户显式停止才发 cancel。取消必须注明：未开始任务可取消，已提交供应商任务是否可取消/退款不能保证，不能伪装全撤回。

```python
async def submit_message(cmd: SubmitCommand) -> Accepted:
    async with db.transaction():
        existing = await messages.get_by_client_id(cmd.client_message_id)
        if existing:
            return Accepted.from_existing(existing)
        await authorize_context(cmd.context)
        await sessions.assert_revision(cmd.session_id, cmd.expected_session_revision)
        snapshot = await compile_and_validate(cmd)
        message = await messages.insert(snapshot)
        run = await runs.create_or_queue(message)
        await outbox.add("run.enqueue", {"run_id": run.id})
    return Accepted(message_id=message.id, run_id=run.id)
```

同一 session 默认串行执行；多条输入可排队并允许取消队列项，不对同一文档并发写。跨session工作需要文档乐观锁。客户端画布工具必须有能力协商，无法在线执行时转为服务端画布事务或持久等待，不能静默丢指令。

## 7. 工具执行：可校验、可重放、可中止

工具注册表必须包含：name、args schema、result schema、sideEffectLevel、allowedModes、permissions、timeout、retryPolicy、idempotency、UI renderer。

```python
@tool(
    name="write_artifact",
    args=WriteArtifactArgs,
    result=WriteArtifactResult,
    effects="document_draft",
    modes={"script_original", "script_adaptation"},
)
async def write_artifact(ctx, args):
    path = safe_work_path(ctx.work_id, args.path)     # 不能 ../ 越界
    await ctx.checkpoint.assert_writable(path)
    partial = await drafts.append_idempotent(
        path, args.content, append=args.append,
        chunk_id=ctx.tool_call_id,
    )
    if args.more:
        return {"ok": True, "partial": True, "bytes_so_far": partial.size}
    violations = await validators.validate(path, partial.content, ctx.confirmed_spec)
    if any(v.severity == "error" for v in violations):
        return {"ok": False, "violations": violations, "repair_required": True}
    change_set = await drafts.stage_change_set(path, expected_base=args.base_version)
    await events.emit("document.draft_created", change_set.to_event())
    return {"ok": True, "path": path, "change_set_id": change_set.id,
            "user_review_required": True, "violations": violations}
```

上面是流程伪代码，不能未经实现直接运行。关键要求：每个分片幂等、整稿完成才校验并交付待审，失败仍保留草稿；模型工具不直接发布正式稿。正式提交由人工CS用例处理版本、依赖闭包、语义失效与事务。

结构化工具参数不合规时返回可修复错误，由Agent最多有限次重试。真实角色测试遇到 ask_human.options 缺 type 的校验错误，说明工具 schema 验证比“提示模型注意格式”可靠。不得无限循环重试消耗额度。

## 8. 原创链：不是一个大 Prompt

### 8.1 状态机

```text
CREATED → DIRECTION_DRAFT → WAIT_DIRECTION
→ OUTLINE_AND_ASSETS → WAIT_OUTLINE
→ EPISODE_PLAN（各远程阶段按需插入WAIT_COST）
→ EPISODE_DRAFT → EPISODE_REVIEW
→ WAIT_EPISODE（所有集都需人工确认）
→ WAIT_NEXT（非末集）→ 下一集计划/独立费用授权
→ COMPLETE（末集且所有有效人工定稿齐全）

任意可编辑检查点 → REVISION_PROPOSAL → WAIT_DIFF → 原检查点
任意执行点 → FAILED_RECOVERABLE / CANCELLED / UNKNOWN
```

上图仅概述；唯一可执行转移、忽略/取消/人工接管/完成后改写规则见[状态合同](tv-director/workflow-contracts.md)。分集计划默认后台校验，不另加正常路径确认；费用门覆盖所有模型阶段，已有范围授权时不重复弹窗。在数据库中保存transition reason、触发消息、确认问题版本，旧按钮不能重复推进。

两集实测支持如下具体分支：总纲自定义修改只产生待审 `skeleton.md` 草稿，审阅接受并在下一轮明确「采纳，继续」后才报价第一集；第一集交付以 `ask_human` 等待「写第2集」；第二集是新的 `episodeNo=2` 报价与审批；最后 `finish_script_task` 返回 `stage=completed, episodes_done=2, total_episodes=2, follow_up_needed=false`。`RUN_FINISHED` 仍只表示当前 run 停止，不代表作品完稿。

### 8.2 工作项初始化

`init_work(brief, mode, sourceId?, totalEpisodes?, durationSeconds?)` 创建工作文件夹和 confirmedSpec 初稿。用户指定值保留 provenance=user；Agent推断值标 provenance=inferred 并在问卷里显示。不要让模型在每次回复自行改集数和时长。

同名 workKey 冲突不得静默接管。返回 `WORK_OWNED_BY_OTHER_SESSION` 和可选的新 workKey 预留凭证，阻止任何写入；询问继续旧作或另建。继续旧作需鉴权并 handoff 到原会话，另建需提交服务端预留的新 key。不要将模型生成的路径当成跨会话访问授权，也不能仅因同一账户就自动覆盖旧项目。

### 8.3 方向

输入：brief、预设、硬约束。输出四个可比较方向，每个有 logline、视角、核心阻力、风格、差异、制作代价。方向生成后先验证硬约束，再产生 ask_human；同一消息中必须有可读内容和问卷，不能只发一个隐藏工具结果。

### 8.4 筹备

生成 skeleton、characters、relations、locations、props；以DocumentVersion的正文AST为权威，Markdown与编辑器是投影，语义plan/事件图绑定正文hash派生，详见[文档合同](tv-director/document-semantics.md)。角色与场景使用稳定ID；台词提及的对象必须存在或作为待确认新对象。

建议短篇路径与长篇路径分开配置，阈值通过进一步实测决定，不把样例输出里的阈值直接当事实。长篇需阶段arc、伏笔与反转台账、信息获取时点；单集不强行写无意义的跨集表格。

### 8.5 分集

每集输入冻结：大纲版本、人物/场景版本、该集 must_keep/ending、前集最终状态、允许的新事实、目标时长。输出 episode_plan 与 screenplay；声画、动作、对话、场次、估计秒数结构化保存，Markdown用于阅读。

校验至少包括人物/地点一致、事件因果、禁止提前泄露、台词主体明确、画外音不误作嘴部发声、场次顺序、时长预算。20秒塞入大量解释性台词应报容量风险，而不是只把“20秒”写进标题。

### 8.6 实测分集写作的代码级闭环与质量闸

一次真实1集/30秒试验依序返回：`episodes_skeleton/EP001_skeleton.md` → `scripts/EP001.md` → `review_episode({episode:1})` → 覆写 `scripts/EP001.md` → 交付/询问 → 最终 `finish_script_task`。新增独立两集试验暴露另一分支：第一集评审模型返回非法JSON，工具明确给 `skipped=true`，正文仍交付；第二集评审正常返回具体问题，自动改写一次，再以全剧完稿收口。这意味着评审不能只有布尔 pass/fail，更不能按工具提示隐瞒失败。新系统要把每步变成可审计状态，而不是让聊天内容暗示已完成。

```python
async def write_episode(work_id: str, episode_no: int, approval_id: str) -> EpisodeDelivery:
    spec = await freeze_episode_inputs(work_id, episode_no)
    # 授权覆盖计划、正文、评审与限次修订；每次远程调用均有子账本。
    run = await runs.start_approved_stage_plan(spec, approval_id)
    plan = await generate_episode_plan(spec)
    await plans.stage_and_validate(spec, plan)
    draft = await generate_screenplay(spec, plan)
    draft_version = await drafts.stage(spec.episode_id, draft)
    review = await review_episode_with_schema_validation(spec, draft_version)
    await reviews.store(work_id, episode_no, draft_version.id, review)
    candidate = draft_version
    if review.status == "UNAVAILABLE":
        await works.flag(work_id, episode_no, "NEEDS_HUMAN_QUALITY_REVIEW")
    elif review.has_blocking_issue and await run.may_attempt_revision():
        revised = await revise_screenplay(spec, draft_version, review)
        candidate = await drafts.stage(spec.episode_id, revised)
        await record_hard_constraints(spec, candidate)
        review = await review_episode_with_schema_validation(spec, candidate)
        await reviews.store(work_id, episode_no, candidate.id, review)
    # 失败/未验证报告不隐藏；所有集都交付待审，人工finalize用例才可完成作品。
    await checkpoints.await_episode_decision(spec, candidate.id, review.id)
    return EpisodeDelivery(run_id=run.id, draft_version_id=candidate.id, review_id=review.id)
```

`review_episode` 应产出每条问题的 `category/verdict/evidence/location/fixSuggestion`；机检做人物/场景/时长/字面硬约束，人工或评估模型做因果、首次观看可理解性和可拍性。评审不能只返回“通过”总分，且需对修订稿再跑关键硬断言。真实样例虽生成了三场五句对白，最终仍有信封打开动作不清和“辞职/退休”语义衔接不足；将这两项作为回归 fixture，禁止把一次成功写盘当成“质量完成”。确认定稿只更改作品检查点，不得在用户未再次批准时触发媒体生产。

### 8.7 两集衔接、全局改纲与后续重算

`ScriptWork.confirmedSpec` 必须保存 `totalEpisodes=2`、`durationSeconds=30`、`structureId=three_act`、`visualStyleId` 和各字段 provenance；总纲AST是全剧规划正文权威，`skeleton.md`只是导出，语义快照绑定版本，不能让两集各自重写成互相矛盾的版本。全剧修改先计算影响闭包，形成 `DraftChangeSet`：本次「取消深夜跳时、同一秒接续、日志 AQ-0917 与 U 盘回收」至少影响总纲中的两集分段、伏笔账本和创作禁区。对未写集更新后续输入；对已写集只提出关联差异，不能无审批覆盖。原站的本次改纲发生在写单集前，因此**已完稿后重排集数/画风、重写第1集后如何同步第2集仍未实测**，以下是新系统必须实现并测试的方案，不是 LibTV 既有事实。

```python
async def propose_global_revision(work_id, instruction, expected_versions):
    canonical = await works.load_confirmed_spec_and_documents(work_id)
    draft = await revisions.generate(canonical, instruction)
    affected = dependency_graph.closure(draft.changed_facts)  # 两集、资产与伏笔引用
    changes = await revisions.diff_versions(canonical, draft, affected)
    await constraints.validate(changes, total_episodes=canonical.total_episodes)
    return await change_sets.stage(work_id, expected_versions, changes)

async def commit_global_revision(change_set_id, decisions):
    # 先验证显式选择的依赖组闭包与合并候选；事务内再次CAS，见v2文档合同。
    prepared = await change_sets.prepare_dependency_closed(change_set_id, decisions)
    async with db.transaction():
        await change_sets.assert_all_base_versions(prepared)
        committed = await change_sets.commit_prepared(prepared)
        await works.invalidate_unwritten_episode_inputs(committed.work_id, committed.changed_facts)
        await works.flag_written_episodes_for_review(committed.work_id, committed.changed_facts)
    return committed  # 单个「全部接受」也必须原子生效，不能只更新可见节选
```

跨集质量闸使用稳定的 `setup_id`：第1集记 `setup_id=log-aq-0917`、`setup_id=labeled-usb` 与最后一秒的 `boundary_state`；第2集必须逐一引用同ID并给出 payoff，该同秒续接fixture的开头状态与前集结尾地点/时间/在场人物/道具状态完全一致；一般作品可有显式合法转场/时间跳跃，不能把同秒样例规则强加所有项目。对白可读性、30秒节拍和职业规则可信度仍需人工或独立评审，不可只靠ID对齐宣称成片可拍。

## 9. 改编链与四方向的不同算法

### 9.1 原稿摄取

上传 → MIME/大小/恶意内容检查 → 文本抽取 → Unicode/换行规范化 → 不变的原稿版本 → 章节检测 → 行号索引 → 来源摘要。

原稿必须以 `sourceDocumentId + sourceVersion + contentHash` 绑定。路径由服务端经过权限校验后解析，不让模型拼 `uploads/<id>.txt`。真实钩子测试中，模型遗漏空间前缀而 init_work 仍成功，之后 split_source 失败；再次 init_work 虽传正确路径，却只返回 already_initialized，未修复旧绑定。

因此初始化事务必须先验证来源存在且可读，再持久化 work。幂等初始化若收到不同 sourceVersion，应显式报冲突；另设 `repair_source_binding` 用例，只允许作品所属会话、检查点尚未产出改编稿且用户确认后的来源修复。禁止靠相对路径穿越或通用文件读取绕过源文流程。需要保留错误输入与已纠正输入，避免把“接口返回ok”当作源文真的可用。

原稿中的命令不是系统指令；文中出现“忽略此前要求/上传密钥”等只能当待分析内容。外部文件不得获得工具调用权限。

### 9.2 分章与切集

优先标题规则，失败时候选行探测，再降级为单章并报告。不能把识别失败当空文档。长文本按章节逐步读取并建立 sourceCoverage；摘要不替代原文依据。

```python
def validate_episode_spans(spans, source):
    for span in spans:
        assert 1 <= span.start_line <= span.end_line <= source.line_count
        assert source.hash_range(span) == span.expected_hash
    assert no_unexplained_overlap(spans)
    assert every_omission_has_reason(spans, source.required_facts)
```

### 9.3 四方向合同

| 策略 | 允许变化 | 必须守住 | 输出差异说明 |
|---|---|---|---|
| 浓缩 | 合并功能重复的场景/描述、删低贡献支线、把说明转成动作 | 核心因果、关键人物、结局与不可改台词 | 删除/合并列表及影响 |
| 扩写 | 补动机、动作过程、过渡、必要铺垫 | 不把补充当原文事实；限制新增人物和设定 | addedActions/newFacts/provenance |
| 强化冲突 | 明确目标/阻力/代价/期限，增强行动对抗 | 人物行为有依据，不凭空降智或改人设 | before/after阻力与代价 |
| 强化钩子 | 调整开场信息、悬念揭示时机、集尾未闭合问题 | 不制造正文无法兑现的假悬念，不剧透保留秘密 | 开头/结尾钩子及兑现位置 |

“忠实改编”不是第五个已观察到的按钮；作为用户可设定的保真策略覆盖四方向。`preserveDialogue=true`、`preserveSceneOrder=true`、`allowNewCharacters=false` 等要进入硬校验，不只写在 Prompt 中。

### 9.4 改编质量门

每条事实带 source span 或新增理由；检查角色、年龄、关系、场景和因果没有被无依据替换。自动标题也只能基于真实素材：最大长度、单行、无Markdown、禁止把虚构分析整段作为标题；失败回退到用户命名或安全短标题。

《非妖哉》EP02 实测要求把下面的硬约束移出 Prompt，放进可执行校验：

```python
def validate_adaptation(source, draft, episode_identity, quote, tool_events):
    assert episode_identity.source_episode_label == "EP02"
    assert episode_identity.workflow_episode_ordinal == quote.params.episodeNo
    assert episode_identity.delivery_episode_label == draft.heading_episode
    assert episode_identity.artifact_path == tool_events.final_write_path
    assert all_source_facts_have_spans_or_explicit_additions(draft)
    assert no_unexplained_property_teleport(draft.story_state_events)
    assert no_unmarked_time_reversal(draft.scenes)
    assert no_day_form_after_sunset(draft.story_state_events)
    assert review_result_matches_call_id(tool_events)
```

这里的 `sourceEpisodeLabel=EP02` 是用户原稿标识；`workflowEpisodeOrdinal=1` 是改编任务内第1个交付件，不能因此对外改称原剧第1集。单集原稿必须允许独立改编；若 UI 所选最小2集而问卷/正文选择1集，提交前显示冲突并要求重设，绝不能静默让预设、问卷与最终任务各说各话。首版可用显式 `sourceEpisodeLabel/deliveryEpisodeLabel` 与 `workflowEpisodeOrdinal` 映射，不依赖文案里的“不要补第一集”。

道具和身份校验按时间线解析 `acquire/transfer/leave/destroy` 事件：同一画在 1-11 被大郎取到、1-13 仍在大郎怀里，就不能在没有转交事件时于 1-16 从戏楼墙上再次被他取下。场景由夜回到傍晚必须标明闪回或重新排序；“最后日光消失才换形”不能被模型扩写成“点灯/灭灯任意触发”，夜景也不能短暂显示昼童。校验不等于文本匹配：未知时间、道具隐蔽携带和象征性镜头可进入人工复核，但默认不自动宣布通过。

评审工具的 `toolCallId`、run 与 `episodeIdentity` 必须同时匹配；解析失败、结果错配、评审跳过都设为 `review_unverified` 并阻断“自动定稿”，但不抹掉已生成的正文。一次真实样例导出将修订 `write_artifact` 结果误配在 `review_episode` 下，故不能用其推导评审通过。定稿与制作验证必须分开：已知硬错不能定稿；自动评审不可用可按v2逐项人工复核接管；未实测时长只能标“文学稿人工确认、制作未验证”，不得标productionReady。

## 10. 文档编辑、局部改写与联动修订

### 10.1 保存与选区

正文AST是唯一权威，ProseMirror与Markdown是无损适配/投影，语义图按当前DV/hash派生。选区offset固定为canonical plain-text projection的UTF-16左闭右开范围；中文、emoji、表格、标题均需映射回归。手改稿的解析失败保留UserDraft，提交后相关图谱/评审/定稿失效，详见[v2文档合同](tv-director/document-semantics.md)。

```ts
interface SelectionRef {
  documentId: string;
  version: number;
  startOffset: number;
  endOffset: number;
  lineStart: number;
  lineEnd: number;
  selectedTextHash: string;
}

async function sendSelection(instruction: string) {
  await autosave.flush();
  const selection = editor.getSelectionForSavedVersion();
  if (!selection || selection.startOffset === selection.endOffset) return;
  await sessionRouter.resolveLinkedSession(selection.documentId);
  await composer.send({instruction, selection});
}
```

不能先取旧offset、再保存会改变正文的转换，最后把旧offset送出。服务端再次校验文档version和selectedTextHash；不匹配返回409并要求重新选择。

### 10.2 局部与关联修改

局部改写输入包含 changeScope=selection；只生成允许区间的patch。若发现人设/时间线需全局修改，返回 impactPlan，让用户确认后才能创建关联patch，不能“顺便”重写全剧。

依赖图示例：人物姓名 → 人物卡、关系表、分集台词标识、分镜角色绑定；场景变更 → 场景文档、场次、资产提示词。以稳定ID查引用，不做全目录字符串替换。

### 10.3 差异审批

用base/current/proposed三方合并；逐hunk展示，但强依赖hunk组成不可拆组。部分采纳先校验显式决定的依赖闭包及合并候选，全部baseVersions CAS后原子生成新版本并失效下游。不能只接受人物改名却拒绝对应身份/台词变更；无依赖润色允许独立采纳。刷新、切会话、暂时关闭编辑器都恢复未审结果，详见v2文档合同。

接受某段不等于批准媒体生成；文档审批和费用审批是不同资源。撤回未接受draft不删除旧正式版本。退出时如果有未处理项，应说明保留草稿还是放弃草稿，不能沉默丢失。

实测源产品通过“写正式全文 → draft/push 通知”两次请求完成接受。独立系统应由单个提交用例封装事务或具备可恢复提交记录；若第一步成功、第二步断网，重试不能再覆盖更新后的文档。首个离线fixture是大纲首行插入两个字，其余1629字符不变；必须同时验证patch范围、Diff渲染、正式版本和刷新读取。

修改收尾与正常检查点分离：`finish_revision` 返回 draft_files/user_review_required，不再同时弹出 ask_human 让用户重复确认。用户审核文档后可以明确发消息继续，不以接受编辑替代正文收费授权。

## 11. 导演模式与画布联动

导演角色是特定bizType的SkillVersion。使用时冻结其版本、输入节点和模型约束；不把角色名当实际方法内容。

`directing.plan()`：读取用户选定剧本/视频节点 → 镜头目标与时长 → 构图/机位/运动/动作/声音 → 提示词候选 → 逐镜可编辑比较 → 用户确认 → 一次画布事务创建或更新节点。

批量优化应返回 `{nodeId,baseRevision,before,after,reason,warnings}`，允许逐节点采用；单个节点失败不抹掉其他候选。创建分镜和立即生成媒体必须是两个动作。

对无目标节点的新文本候选，允许 `nodeId:null`；通过结构化 `show_optimized_prompts(items)` 事件渲染结果卡，而非从普通聊天里猜分镜数量。`accepted/count` 只代表候选接收，不能置媒体状态为成功。角色复用实测提供了3条候选且节点为空，这应成为首个回归fixture。

画布事务必须具备幂等id、节点/边合法性、输入顺序和变更预览；成功后记录一条可撤销操作。工具声称成功但节点没持久化属于失败，需通过节点查询和刷新验收。

### 11.1 多模态引用顺序

继承先前用户强调的约束：界面顺序、占位符、实际提交文件顺序必须来自同一个 binding manifest。

```ts
interface ReferenceBinding {
  bindingId: string;                 // 永久身份
  sourceNodeId: string;
  assetVersionId: string;
  kind: "text" | "image" | "video" | "audio";
  displayOrder: number;
  namespace: "text" | "mixed";
  ordinal: number;                   // namespace 内编号
}
```

文本编号1与图片编号1可以共存，因为namespace不同；不能用数组下标或标签文字作为唯一引用ID。是否把图/视频/音频合为mixed以及占位符语法必须按 H3 实际适配器合同测试，而非凭 LibTV 界面猜测。

拖拽重排只改变 displayOrder，绑定ID不变；编译时同时生成用户可见标签、模型占位符与文件manifest。按类型上传需要分组时保留映射表，不能分组后重新编号导致提示词指向另一素材。

## 12. Skill 系统：可执行的方法包而非名称列表

方法包不再采用本节早期的名称表/示例YAML作为可执行规范。完整manifest、24个包的输入输出/引用/工具顺序/失败门、4个改编策略、18条条件规则和正反例统一见[v2逐Skill合同](tv-director/skill-contracts.md)。这些是独立设计，不是声称获取LibTV内部文件；编排包不得自己finish作品，必须走宿主检查点和人工定稿用例。

### 12.1 独立编写Skill的规范

每个Skill必须写清：适用与不适用范围、输入缺失时问什么、必须调用哪些工具、何时停下请求确认、产物schema、事实/时长/身份/顺序校验、失败修复次数、禁止副作用。正例和反例成对；禁止只写“你是优秀导演，生成高质量剧本”。

检查点由代码掌握，Skill不能自行批准自己的下一步。工具白名单由运行器校验，Markdown里的“允许上传”不能突破账户权限。外部导入Skill默认无网络/文件系统/发布权限。

### 12.2 创建、更新与自测

五种intake：从零、从对话、从画布、更新、测试。对话与画布输入冻结快照ID；UI显示实际纳入哪些素材。创建流程：需求问卷 → 方法草稿 → 用户确认 → 静态校验 → 私有SkillVersion → 试用。

更新现有Skill必须绑定baseVersion；新版本先draft，不改变历史会话锁定版本。允许另存为新Skill。导入.md或文件夹需路径规范化、限制文件数/大小、禁止符号链接和可执行脚本默默运行。

自测不能只是让同一模型说“通过”：固定fixtures，先用schema/计数/实体/时长断言，再由独立评估提示做内容评分，再人工抽查。保存真实调用和产物，以便比较版本回退。

发布是单独授权操作，有可见性、示例素材权属、费用提示与审核状态；默认私有，不把测试Skill自动放公共广场。

### 12.3 逆向边界与《非妖哉》回归夹具

前端代码、UI、工具名和结果能反推**可观察的工作链**：读原稿并提取事件/人物/规则 → 问缺口并冻结事实 → 写大纲/骨架/资产 → 单集报价与人工批准 → 正文与评审 → 修改差异 → 人工采纳/定稿。四种改编按钮能观察到不同策略要求，但不能由此唯一反推出服务端原始 Skill 文件、系统提示词、检索资料、模型权重或私有路由阈值。上述 Skill 是重新设计的行为等价实现，不是泄露/复制来的原版；仅凭此文档不能保证输出字句或成片质量与原站相同。

把 EP02 原稿及两轮平台产物的哈希留在受控本机夹具库，公开测试只存脱敏事实表。至少设置以下硬断言，失败不得展示“已定稿/已达415秒”：来源集号与交付集号映射独立；一幅年画昼童/夜绫互斥且由夕光退尽触发；小画自湖里捞回后不能无交接地挂到戏楼墙上；夜戏不能无标记返回傍晚或露出昼童；桂娘仅在回忆且存殁未明、关键台词字面保留；火场同时带走两画且火把/小画/细针有可执行的持握顺序；前厅得知火情后群众反应连贯；基于当前稿的beat依赖与并行声画时间线计算关键路径区间，再与415秒比较；合法同时发生取覆盖长度，先后动作串行，不能把对白与同步动作重复相加。人工复核必须记录每项的原稿证据行、生成稿位置、修法和重新检查结果。

```python
def validate_episode(source_facts, draft, scene_budget):
    errors = check_source_fidelity(source_facts, draft)
    errors += check_artifact_custody(draft, ["抱福童子年画", "抱鱼小儿图", "火把", "细针"])
    errors += check_time_and_identity(draft, day_night_rule="sunset", roles=["昼童", "绫娘"])
    errors += check_required_dialogue(draft, source_facts.locked_lines)
    errors += check_blocking_feasibility(draft)
    for scene in draft.scenes:
        timeline = schedule_beats_with_resource_constraints(scene)
        bounds = critical_path_bounds(timeline)  # 详见v2，未知不能填0秒
        errors += compare_duration_bounds(bounds, scene_budget.limit_for(scene.id))
    episode_timeline = compose_scenes_with_explicit_overlaps(draft.scenes)
    errors += compare_duration_bounds(critical_path_bounds(episode_timeline), 415)
    return errors
```

时长校验先做保守估算，之后真人试读和分镜排演回填实际值；不能将 Agent 自述“约860字/未超时”当作通过。文档/代码实现顺序应是先完成这些夹具与校验器，再把它们作为 `adaptation-chain`、`episode-writing`、`linked-revision` 的完成门。

本次真实反例又给出两个必须代码化的断言：估时表须由**提交的当前文档版本**解析生成，逐场字数与正文逐句可追溯，不能复用上轮表；道具位置是 `(scene, beat, holder)` 状态，1-16 宅院桌面的小画不能在1-17 街巷才执行「从桌上拿起」。即使总数恰好414秒，1-16 十秒内同时完成安放道具、解线、取画、纸狮成形、起火、塌顶也要触发 `BLOCKING_TOO_DENSE` 人工分镜门。仅在动作前面加“快剪”不自动减少动作时长，必须列出可见镜头、镜头长、被删/合并信息与音画承接；真实试读与分镜计时前状态为 `DURATION_UNVERIFIED`，而非 `PASS`。

## 13. 费用、配置与供应商适配

费用执行以[v2工作流/费用合同](tv-director/workflow-contracts.md)为权威，从方向、来源审计、计划、正文、评审、重试到Skill自测/媒体全部入账，P1先实现。媒体报价绑定精确requestHash；多阶段文本授权绑定范围/StagePlan/hash/额度，子调用单独记录实际hash和成本。`free`由真实报价决定；未知费用不是0，已发送结果不明不得盲重试。

实测独立两集分别按 `episodeNo=1/2` 报价30积分/free=false，手动批准后同一研究标签页刷新余额1,110→1,080→1,050。另一单集样例是1,140→1,110；两组不可混成一次结算。《非妖哉》EP02 改编明确报价30积分/free=false且仅手动批准一次，后续同一账户标签页刷新余额1,050→1,020，与报价相符；无服务端结算流水。模型随后声称“未报价/未扣费”与真实报价和余额证据冲突，不能当结算事实；后续无付费修改轮的“未触发付费”也不能倒推首次生成免费。新系统必须在 UI 同时呈现“报价值、批准对象、实际结算/余额变化、失败退款状态”，后台保留 `quoteId/approvalId/taskId/ledgerEntryId` 链；只凭旧标签或模型说法不能判断是否收费。两集的确认必须是两个不同 `Approval`，第二集不能继承第一集30积分的授权。

```python
async def execute_generation(command, actor):
    frozen = await generation.compile(command)
    quote = await quotes.get_valid(command.quote_id, frozen.sha256)
    approval = await approvals.require(
        actor=actor, quote=quote, request_hash=frozen.sha256,
    )
    async with db.transaction():
        task = await tasks.get_or_create(approval.id, frozen.sha256)
        if task.dispatch_state != "new":
            return task
        await billing.reserve(task.id, quote.amount)
        await tasks.mark_dispatch_pending(task.id)
        await outbox.add_unique(task.id, "provider.dispatch", {"task_id": task.id})
    return task
```

任务完成后按供应商实际账单结算；只有确定未发送/未收费部分才释放预留，结果未知保留待核，禁止盲重发。上述get_or_create需唯一约束与事务锁；派发状态在入outbox时就改变，不能只等收到供应商结果才防重复。手动模式逐次确认；自动模式受服务端限额、任务类型与有效期约束。预算提醒和硬上限不同，详见v2费用合同。

系统设置应配置文本模型、H3服务地址/鉴权引用、超时/重试、模型支持分辨率/比例/时长/参考上限、音频支持、并发、存储与通知。密钥只在服务端SecretStore，前端只看到掩码与是否已配置。

H3 UI schema由能力注册表生成；提交编译器输出参数清单供用户展开核对，包括最终模式、时长、分辨率、比例、声音设置、参考binding与序号。模型不支持的选项不伪装生效。

## 14. 自有接口合同建议

下表是历史接口概念索引，不是LibTV路由，也不与v2并行成为第二份API规范。实施以[v2 API合同](tv-director/workflow-contracts.md)为准；旧PUT正文必须接入AST/CS/语义失效用例，不得成为绕过审批的直写后门；旧hunk决定映射到显式依赖组，错误恢复遵循同一DomainError。

| 方法/接口 | 请求要点 | 返回/失败 |
|---|---|---|
| POST /sessions | workspaceId/canvasId/mode/modelKey/nodeId? | session+revision |
| POST /sessions/:id/messages | SubmitCommand | messageId/runId；409 stale context |
| GET /sessions/:id/events?afterSeq= | seq | 持久事件回放 |
| POST /runs/:id/cancel | expectedState | cancelled/cancel_requested |
| POST /questions/:id/answers | questionVersion/answers/idempotencyKey | 新run或409已处理 |
| POST /works | initWork | work+checkpoint |
| GET /works/:id/documents | version? | 树和文档元数据 |
| PUT /documents/:id | expectedVersion/content | 新version；409冲突 |
| POST /documents/:id/revisions | SelectionRef/instruction | changeSetId |
| POST /change-sets/:id/decisions | hunkId/decision/baseRevision | 可续审状态 |
| POST /change-sets/:id/commit | expectedRevision | 文档新版本集合 |
| POST /skills/intake | intent/contextSnapshots | 问卷或draft |
| POST /skills/:key/versions | manifest/files/baseVersion | 私有版本 |
| POST /skills/:key/tests | version/fixtures/budget | 可追踪testRun |
| POST /skills/:key/publish | version/visibility/consent | 审核状态 |
| POST /generation/quotes | frozenRequest | quote/free/expiry |
| POST /approvals | quoteId/requestHash/limit | approvalId |
| POST /generation/tasks | approvalId/frozenRequest/idempotencyKey | taskId |
| POST /canvas/:id/transactions | baseRevision/ops/idempotencyKey | 新revision或冲突 |

统一错误码：VALIDATION_ERROR、STALE_CONTEXT、STALE_DOCUMENT、MISSING_ASSET、MODEL_UNSUPPORTED、APPROVAL_REQUIRED、QUOTE_EXPIRED、BUDGET_EXCEEDED、PROVIDER_REJECTED、TOOL_UNSUPPORTED、SESSION_PREEMPTED。错误必须可操作，不只显示“生成失败”。

## 15. 每次请求与返回的证据沉淀

每次测试建一个TestCaseRun，而不是累计一个无法检索的HAR。

```text
case-id/
  manifest.json         # 模式/模型/Skill版本/输入hash/期望/时间/状态
  input.json            # 用户文字、预设、引用manifest
  requests.jsonl        # 方法/路径/脱敏参数/请求ID/时间
  responses.jsonl       # 对应返回/状态/耗时/错误
  events.jsonl          # WS流式事件，保留seq和toolCallId
  tools.jsonl           # 完整args/result，解码但保留原始hash
  artifacts/            # 生成文件的版本与hash
  screenshots/          # 关键按钮、参数、结果、费用
  assertions.json       # 实际对照结论
```

测试清单保留UI显示值、内部枚举、序列化值、工具最终接收值和供应商请求值，逐层比较。源产品无法观察供应商最后一层时明确 unknown，不声称已打通全部链路。

日志采用字段白名单，递归处理嵌套JSON字符串；Cookie/Token/Authorization/访问密钥/签名查询值不写入公开证据。账户ID/项目ID替换为稳定匿名别名，但保留跨请求关联关系。原始私有证据加访问控制与保留期限；公开报告只保留合同、必要样例和结论。

生成内容、工具异常、自我修复、取消和未完成都要保存，不能只挑成功截图。重复测试前查索引，已验证的请求通过离线fixture回归，真实调用只补新分支。

## 16. 验收用例：不得只看按钮是否存在

| 类别 | 必测用例与断言 |
|---|---|
| 界面 | 1200×863/1920×1080逐屏截图：剧本节点+浮窗、Top8单/双题材、模式二级菜单、历史、报价、交付、编辑器；测试pressed/disabled/focus/ESC、停靠/缩放/刷新恢复；手机断点单独设计验证，不冒充已观察原站行为 |
| 参数 | 原创所有字段、自动集数、自定义文本/参考图；改编四方向；UI显示与最终请求一致 |
| 文本 | 原创1集、实测2集黄金样例、短篇6集边界、长篇、多语言、空brief、互相矛盾约束；断言前集尾帧与后集开头、日志编号/U盘 setup-payoff、完稿 `episodes_done=total_episodes` |
| 改编 | 同一原文分别忠实/浓缩/扩写/冲突/钩子；不可改台词字面校验、人物不新增 |
| 原稿 | 无章节、多种标题、长段落、扫描PDF、抽取失败、恶意指令文本 |
| 问卷 | 单选/多选/自定义、上一题、重复提交、过期回答、忽略不批准付费 |
| 编辑 | 中文emoji选区、1500ms内发送、表格往返、范围外不变、关联修改需批准 |
| 差异 | 全剧改纲产生待审草稿；一次「全部接受」原子更新所有节；部分接受、全部撤回、两设备冲突、刷新继续审核、断线恢复；改第一集后第二集不得悄悄保持过期事实 |
| 导演 | 自动和六类角色、私有角色、同输入不同角色、批量部分失败、落节点后刷新 |
| Skill | 创建/更新/另存/导入/自测/回退/删除；平台不可编辑；私有不公开 |
| 引用 | 文本1与图片1并存；每类至少3项；混合重排/删除/替换；提示词绑定不漂移 |
| 费用 | free true/false、逐集独立报价与审批（两集30+30）、过期报价、参数变化、重复确认、取消、失败结算、自动限额 |
| 评审 | 评审返回结构化问题并自动修订一次；评审模型非法JSON时标 `UNAVAILABLE` 并显示需人工复核，不得隐藏或误报通过；修订后重跑硬断言 |
| 传输 | 断网、重放重复seq、乱序、迟到结果、切session、双标签抢占、浏览器关闭 |
| 安全 | 越权文档/画布/附件、路径穿越、SSRF、恶意Skill、日志密钥扫描 |
| 导出 | 中文文件名、目录结构、文档版本一致、断链素材提示、跨Windows恢复 |

内容评估分离硬断言与软评分。硬约束如人物数、保留台词、禁止新增、集数、总时长先通过，再看悬念与情绪等主观质量。输出得高分但违反用户事实仍失败。

## 17. 实施顺序与每阶段退出门

本节旧顺序由[融合v2的P0–P8实施表](tv-director-skill-fusion.md)替代，避免两套计划并行：
P0合同/匿名夹具 → P1权威数据、状态、费用账本/幂等/恢复 → P2阶段方法与原创 →
P3来源/四策略 → P4语义/容量/修订深化 → P5完整剧本UI → P6导演/Skill/全能 →
P7媒体/生态/Windows交付 → P8完整对标验收。

费用基础设施必须先于任何真实收费模型调用；P2已有的基础时长/评审门不得等P4才补。
每片退出门、代码范围与未证分支以v2专项合同为准。本文件保留的观察样例不是全部gold正例，
源站失败稿用作反例；未知供应商、分享/插件协议、发布行为仍待补证，不能因文档有名称就标完成。

## 18. 完成定义

全部按钮ID能追溯到组件、用例、后端合同和测试；所有生成能追溯到冻结参数/Skill版本/引用manifest；用户操作可以恢复、回滚、解释；费用有审批账本；跨设备能打开已有项目与素材；无凭据进入日志和Git；最后通过真实业务样例而不只是mock。量化门槛、24类反例/输入、12类质量对标、149个UI动作及八项能力以[v2验收合同](tv-director/acceptance-contracts.md)为准；未验收项不得宣称完整等价。

## 19. 2026-09-25实测驱动的开发补充

事实权威为[十项补证报告](tv-director-liblib-gap-validation.md)，产品规则权威仍是[融合v2](tv-director-skill-fusion.md)及五份专项合同。本节只明确实现落点/反例，不静默把源站缺陷覆盖成产品要求；以下为**待开发逻辑，不是已实现测试**。

### 19.1 P0/P1：参数、身份、审批的确定性边界

源站出现用户5秒→工具6秒、工具720p→节点2K。模型不能掌握最终参数解释权，须在`src/novelvideo/director/`的应用服务/媒体端口实现三层对账：

```text
freeze(userSpec, orderedReferences, capabilityVersion) -> specHash
proposal = model.suggest(promptOnly, frozenSpec)
validate(proposal):
  提案修改任一冻结字段 -> SPEC_CHANGE_REQUIRES_CONFIRMATION，不创建任务
normalized = providerAdapter.encode(frozenSpec)
assert providerAdapter.decode(normalized) 与 frozenSpec 语义相等
transaction(createNode, sourceBindings, frozenSpecHash)
readBack(node): 对照显示值/存储值/已批准值，任何差异 -> PARAMETER_DRIFT
quote(normalized.hash) -> humanApprove -> submit(sameHash, idempotencyKey)
```

字段至少覆盖模型、模式、时长、分辨率、比例、数量、声音、所有引用ID/顺序/角色和prompt。显示别名允许不同，但720p与2K不可当等价；禁止unknown枚举落默认最高档。H3能力表须来自本方真实适配器/已验证工作台API，不能照搬通用工具口头枚举。未验证供应商映射时停止，不拿源站未运行节点当生成能力证明。回读不一致要阻止报价/提交，并显示具体字段差异。

来源关系独立于媒体引用：`sourceBindings[{nodeId,documentVersion,ordinal,span}]`记录A/C文本；`generationReferences`才装真实图片/视频/音频。不能因文生模式无媒体引用而把文本来源只写标题。按用户显式manifest顺序，不按画布坐标、数据库nodeList或异步完成先后重排。每个batch item保存自己的inputHash/status/error/outputNodeIds；B失败不吞掉A/C，也不重发已成功项。

拟加入`tests/test_tv_director.py`或后续窄contract模块的反例：固定5秒时6秒提案拒绝；720p编码后回读2K拒绝；调整规格需新hash与新报价；A/B/C乱序返回仍按原ordinal显示；空媒体引用保留文本来源；没有create_text能力时在执行前显示不可用，绝不把聊天摘要标成已落节点。

### 19.2 P1/P4：强依赖审阅与恢复

沿v2的DocumentVersion/ChangeSet合同，改名用稳定entityId，不用名字充当主键；9文件修改属于同一dependencyGroup。用户点击一节接受时，服务端重算受影响引用闭包；若缺其他必需hunk则返回`DEPENDENCY_GROUP_INCOMPLETE`和需一起接受清单，不仅给模型文字警告。CAS检验所有baseVersions后同事务提交文档、语义索引、版本和事件；单文件失败整体回滚，草稿完整保留。界面“本节/本文/全部”分别展示影响范围，不能名称都叫全部却隐含不同事务范围。

故障夹具：第二文件write失败、人物标题先改正文未改、跨集旧名、同文件多个hunk依赖；断言无正式混名、无部分版本递增、失败草稿可恢复。完成状态与待审状态分离；改已定稿大纲后按依赖标相关集需复核。LibTV仍completed不是我们可以跳过此门的理由。

会话抢占可按v2的租约/版本控制实现：旧页只读、明确接管按钮、续租失效停止写入；不能通过移除遮罩继续写。离线草稿在本地outbox绑定baseVersion，网络恢复重试前CAS，冲突交人工；文档重试与供应商任务恢复使用不同幂等域。续轮N10另证明收到taskId后断网重连不重复创建；仍不授予盲重发付费请求权限。

### 19.3 P2/P3/P6：Skill入口与读取策略

| 输入/操作 | 需要实现的逻辑 | 验收失败夹具 |
|---|---|---|
| 长稿 | 基于source spans分块摄取，持久化read/revised coverage；检查切集无缺口/重叠及最后事实 | 24章尾锚点、单读超过20000、已读但最终忽略尾事实、顺叙要求被改闪前 |
| 从画布提炼 | 区分工作流拓扑提炼与单剧本文档提炼；节点artifactRef解析当前授权版本，先读产物索引，再分块正文 | 无连线脚本不应被一概当空画布；不要误读uploads代替展示中的大纲 |
| 从对话提炼 | session范围与输入版本显式绑定；新建不携带旧副本更新身份；真实权限失败保留错误并停止 | 删除副本后新建隔离、owner不匹配、工具RESULT缺失；关联只作排查线索不直接定根因 |
| 草稿保存/更新/另存 | 分开draftId/skillId/ownerId/version；apply幂等，update CAS，fork新ID | 重复apply不重建；fork不改原Skill；删除仅确认的目标 |
| 自测 | frozen skillVersion/inputHash/modelVersion→独立testRunId→输出/硬断言/费用凭据；报告只能引用真实回执 | 模型自述test-skill但无执行回执应UNAVAILABLE；字数由代码计算 |

short-drama提供创作/改编方法与质量规则，反推的LibTV工作流提供阶段/问卷/工具交接合同；上述读取、身份、幂等、依赖和参数约束属于程序运行层，不能继续靠给模型增加“务必正确”的Skill文字修补。模型负责提案，确定性代码负责约束与验证，人工决定实质变更。

### 19.4 P5/P7：UI取消、发布与外部接入差异

- 首次设置取消：源站X继续发送已证实；本方按v2保留取消不发送，清除pending intent，不设置已确认标志。关闭普通运行浮窗不取消后台任务；停止任务必须独立按钮和回执。测试两者不能混用。
- 忽略问卷：旧卡只读只是UI事实，服务端仍须验证checkpoint版本/已答状态，旧ID返回stale，不允许绕过逐集/费用确认；服务端源站行为未知不影响本方安全门。
- 分享/发布：先私有预览、列出可见内容、明确发布确认，再创建链接/发布；撤销须验证外部访问失效。未取得授权前不在验收报告虚填发布成功。
- 外部Plugin：源站是LibTV向外提供MCP，不是站内配置供应商。独立MCP网关、OAuth scope与撤销属于P7生态能力；匿名discovery不能替代账户全生命周期。不得依赖源站私有接口作为本方正式后端，不自动把浏览器Cookie交给外部工具。

### 19.5 实施接手与退出门

下一实施会话先把本报告的5→6、720p→2K、强依赖混名、读取错路径、无工具却报告成功、缺测试回执转成匿名fixture；按P0→P1先建立会失败的测试，再实现约束，不先重跑模型。具体目录新增须另过方案门与guard，不把本轮研究当编码授权。N08/N09已获授权并实测，最新范围见§19.6；物理两设备、单独撤回等未完成子项不能整项标绿。源站已观察失败不阻止明确差异的改进，但必须在兼容矩阵公开注明。

### 19.6 v2.1权威迁移索引（替代重复实现条款）

本轮将授权续轮的九类设计增量并入融合合同，不再维护第二套字段/状态名。19.1–19.5是实测触发设计的历史摘要；实际字段、接口、状态、执行顺序和反例以如下落点为准。源站事实及原始证据仍见[补证报告§13](tv-director-liblib-gap-validation.md)，没有被本轮改成“全项通过”。

| 研究驱动增量 | 唯一实现合同 | 固定验收 |
|---|---|---|
| 长稿顺序/尾事实 | [正文语义§9](tv-director/document-semantics.md#9-顺叙与尾部事件的可执行守卫)，区分源顺序与已批准故事时间线 | F25、M05/M12 |
| 真缺失节点/乱序批量 | [按钮能力§7](tv-director/feature-contracts.md#7-补证后的交互边界唯一权威)第1项 | F26、C01/C03 |
| Skill实际执行版本 | [Skill§9](tv-director/skill-contracts.md#9-融合来源冻结与执行凭证)、[工作流§9](tv-director/workflow-contracts.md#9-对象字段及状态命名的唯一边界) | F27、M18/M19 |
| 预设取消/旧问卷恢复 | [按钮能力§7](tv-director/feature-contracts.md#7-补证后的交互边界唯一权威)第2项及WT23/WT31 | F28、O14/Q06 |
| 请求/回显/成片实际参数 | [按钮能力§7](tv-director/feature-contracts.md#7-补证后的交互边界唯一权威)第3项、MediaAttempt | F23/F29 |
| 已受理与未知提交 | [工作流§10.3](tv-director/workflow-contracts.md#103-已受理与未知提交)及费用§5 | F19/F30 |
| 会话分享白名单/撤销 | [工作流§10.1](tv-director/workflow-contracts.md#101-分享与skill发布) | F31 |
| 私有/发布/撤回/归档/删除 | 同上；不再把K20映射成archive | F22/F32、K19/K20/X10/X11 |
| Plugin最小scope/失效/断开 | [工作流§10.2](tv-director/workflow-contracts.md#102-pluginoauth) | F33 |

[代码级收口清单](tv-director/implementation-closure.md)规定22个工作包及13类已决定差异；[机器追踪表](tv-director/implementation-map.json)记录149动作/8能力/24方法/18规则/33转移到文件、命令、接口、schema与482个计划测试ID。[规格检查器](tv-director/verify-spec.mjs)验证闭合，不把计划用例当实测结果。源站内部未知、真实第二设备、配对质量与供应商异常仍按明确发布门验收，不从产品分母删除。

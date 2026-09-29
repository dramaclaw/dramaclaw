# 全新 TV Director 剧本工作台实现

**状态**：执行中
**最后更新**：2026-09-28
**基线**：`0d7b609f`（main；两笔Director提交已推送至私有`zhonggwv/main`，待本轮交接状态提交）；历史实现起点e7b1fbce。保留受保护未跟踪资料。
**认领者**：`codex/director-s1-20260928`
**相关文档**：`docs/guides/liblib-tv-director-analysis.md`、`docs/guides/liblib-tv-director-development.md`、`docs/guides/tv-director-skill-fusion.md`、`docs/guides/tv-director/character-parity.md`、`docs/guides/tv-director/scene-parity.md`、`docs/guides/tv-director/prop-parity.md`
**相关分支 / PR**：无
**本轮详细证据**：`docs/guides/tv-director/batch-facts-pixels.md`；前轮编辑/媒体见`interaction-closure.md`，分集见`episode-parity.md`

## 目标

在 DramaClaw 中新增独立 TV Director 工作台，不以现有“虾本” UI 为基线。用户可在画布式页面创建原创/改编作品、设定题材/集数/结构、关联来源、通过配置的文本模型生成可审草稿、保存版本、修改与人工定稿、恢复历史；浮窗/设定器/剧本文档/编辑器操作按现有 LibTV 按钮级报告逐项对照。后续补齐完整 Skill/导演/媒体/多设备等能力前，页面不得谎称已经等价。

首个可验收切片已建立作品/来源/版本/待审变更/事件存储和部分UI。当前完整边界/实施顺序以`docs/guides/tv-director/full-replication-plan.md`审核r1与其权威导航为准，验收数值与依赖统一到acceptance-policy.json；融合v2与P/WP记录保留历史来源，不能覆盖新S切片。业务是否完成仍以实际代码和有效测试为准。

## 非目标

- 不改用户已有 LibTV 项目、原剧本或现有 story/freezone 业务行为；本轮用户授权在隔离比较项目执行有价值的文本生成，禁止自动购买媒体或重放未知请求。
- 不声称取得 LibTV 服务端私有 Skill 或能生成逐字相同的文本。
- 本切片不自动触发 H3 视频或扣费媒体任务；后续独立接入有报价/审批的生成路径。

## 现状与证据

- `story_writer.py`/`story.py` 是单文档覆盖与前端拼提示词；`ScriptNode.tsx` 是镜头表节点，不是剧本文档节点；现有画布基础设施和模型网关可复用，但旧 UI 与存储不作新产品合同。
- 研究报告实测了浮窗、Top8 双栏设定器、文档节点/编辑器、两集递进及人工审阅；《非妖哉》EP02 暴露 source EP02 与 workflow ordinal 1 混淆及道具/时间/时长质量问题。网页登录态只用于只读 UI 对照，凭据不入文档。
- `git status` 仅有研究线文档/STATE 和受保护未跟踪本地资料；拟改业务路径 `git diff -- <path>` 无内容。`git branch -a --list '*director*' '*story*'` 无同名远端实现。`origin/main` 与本地 API 注册、路由生成和三语文件重叠；本线仅追加，禁止按整文件覆盖；新模块及路由源无路径重叠。
- 架构选择：按用户上轮确认，在现有仓库中建独立 director 域及 UI，而非沿用旧四阶段页面。首版以项目 `state_dir` 内 SQLite 事务存元数据和小文本；独立 repository 接口隔离持久层，后续可更换 PostgreSQL。这样当前 CE 和 Windows 项目数据路径可落地，仍保留文档版本与乐观锁。若将来迁移数据库，必须单开迁移线。

## 写入边界

| 路径 | 模式 | 作用 |
|---|---|---|
| `docs/agent/STATE.md` | 共享 | 登记本线；保留研究线原有未提交内容 |
| `docs/agent/tasks/tv-director-implementation.md`、`docs/agent/claims/tv-director-implementation.toml` | 独占 | 本线方案和机器范围 |
| `docs/guides/tv-director-skill-fusion.md` | 独占 | short-drama 与可观察 TV Director 工作流的融合设计、阶段合同及验收矩阵 |
| `docs/guides/tv-director/feature-contracts.md`、`workflow-contracts.md`、`document-semantics.md`、`acceptance-contracts.md`、`seed-outline-parity-implementation.md`、`implementation-map.json`、`verify-spec.mjs` | 共享 | 用户批准discovery串行执行审核修订，释放后本线集成；scope逐文件对称认领 |
| `docs/guides/tv-director/skill-contracts.md`、`implementation-closure.md` | 共享 | discovery唯一持锁串行清除旧上限/自动扩大交付冲突；完成后本线集成 |
| `docs/guides/tv-director/source-inventory.json` | 独占 | 冻结来源指纹；研究线只读核实 |
| `docs/guides/liblib-tv-director-development.md` | 共享 | 与 discovery 双向认领；本线持锁修正旧设计，研究事实不变 |
| discovery 的台账与 scope | 协调 | 仅记录上述共享顺序与交接 |
| `src/novelvideo/director/**` | 独占 | 新工作流、存储、质量门、方法包 |
| `src/novelvideo/api/routes/director.py` | 独占 | 新薄路由 |
| `src/novelvideo/api/__init__.py` | 共享 | 仅新增导演路由注册 |
| 本轮新增测试与9个fixture | 独占 | 精确文件见2026-09-26实施方案及逐文件scope |
| `tests/test_tv_director.py` | 独占 | API/存储回归 |
| `frontend/src/features/director/**` | 独占 | 新工作台 UI、状态与局部样式 |
| `frontend/src/api/director.ts` | 独占 | 前端导演 API 合同 |
| `frontend/src/routes/_app/projects.$project/director.lazy.tsx` | 独占 | 独立项目入口 |
| `frontend/src/routeTree.gen.ts` | 共享 | 根据路由源重新生成，不手写丢旧路由 |
| `frontend/src/components/layout/project-navigation-routes.ts`、`frontend/src/components/layout/project-header-navigation.tsx` | 共享 | 把新工作台加入项目导航，不替换旧虾本入口 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | 新键按语言同步追加 |
| `DESIGN.md` | 独占 | 新 director 组件视觉 token 与截图基线记录 |
| `frontend/src/features/story/**`、现有 `freezone/`、`canvas/`、原稿与 cookie | 只读 | 复用取证，不改旧实现或凭据 |

## 协调与冲突

- 2026-09-27审核修订：用户批准六项建议；discovery唯一持锁串行修订feature/workflow/document/acceptance、Seed大纲细案、implementation-map及verify-spec七文件，scope双方共享。实现线在其释放后集成；其余业务、测试、旧失败记录不变。当前完整范围/切片以full-replication-plan为导航，验收数值以acceptance-policy.json为唯一配置，历史P/WP不作为新执行顺序。

- 2026-09-26 分支集成：本线已有提交在前，`sync-main-remotes` 持唯一锁串行合入 main 的 TV Director。
  三语只保留并合入各线键值；DESIGN按画布和Director各自章节并存。相关claim已互认共享，
  最终冲突集成归同步线，原功能所有权、验收欠项和待办不变；不改技能或收费生成逻辑。

- 2026-09-26提交准备：git-sync-preparation持唯一锁，仅串行修ui-parity与本台账各一处被banned-words钩子拒绝的第三方依赖描述；ui-parity改双向shared，不改UI事实、业务代码、许可结论。准备而非提交/推送。

- 2026-09-25 N01–N10补证：acceptance-contracts.md与discovery双方共享，研究线持唯一锁更新十项证据状态/链接；既定验收策略仍由实现线负责，不将源站观测静默改成产品策略。其余四份专项合同和主指南本轮研究只读。

- **相关工作线**：`liblib-tv-director-discovery` 只负责研究证据；`story-writer` 保持旧功能待验收；`liblib-canvas-parity` 等画布线不被本切片改写。
- **本地已有改动**：STATE 的研究线新行及研究文档属于 discovery，原样保留；`_to_delete/` 与原始样例冻结。
- **远端重复实现**：无 Director 同名分支；`origin/main` 改过 API 注册、生成路由和三语 JSON，改动语义与新功能不同，逐键/逐路由追加，合并时再对账。未在脏工作树 pull/rebase。
- **共享文件顺序**：当前无别的持锁者；本线持锁串行修改。复查发现 story-writer 对 `routeTree.gen.ts` 和项目导航均已有 wildcard 共享，无需改对方台账；新增路由源后由工具生成。API 注册/三语也已有 wildcard 共享，合并时由本线对本轮键负责。

## 实施方案

### 2026-09-28 · 已有首功能代码与测试分线提交

目标是把本线已有的TV Director来源→五节大纲→局改/审阅/流式及首次原创三页问卷的代码、方法包、测试、视觉/三语和进展方案本地提交；不扩大业务实现，不调用模型，不推送。复核发现前一研究提交`0a1d4fac`仅改方案与台账，当前业务diff仍完全归本线；已按精确文件与claim对账，其他受保护未跟踪资料冻结。执行顺序：更新基线→preflight全部当前精确路径→运行后端/前端聚焦测试、构建、ruff、i18n、差异/密钥检查→显式暂存本线文件→带DCO提交→记录实际结果与未过门项→handoff/release。风险是把隔离运行误称常驻部署、把格式测试误称文学通过、把过期plan-closure源码映射误称有效；均在交接中如实标明。回退只通过后续修正提交，不清理原工作树或用户数据。

### 2026-09-28 · 首次原创三页问卷与冻结参数同源（方案就绪→执行中）

目标：把已取证的原站首次原创 `ask_human` 三页（方向、确认集数、确认单集秒数；最后提交才继续）接到当前真实Seed方向关口。页面选中的两个数必须与作品持久设定、集身份、后续M07/M08/M09冻结请求完全一致；刷新与重复提交不新增模型调用。源站原始请求在本机忽略的`two-episode-serial-evidence.json`，分析§6.2记录`q_0/q_1/q_2`同一`toolCallId`。本轮重新按仓库规定加载忽略的登录态后原站显示登录弹窗，故不冒充新的在线复验；使用既有原始请求和独立本地运行来核对。现有本地真实原创返回4方向+6模型追问形成7页，是可确认偏差；设定值目前在建作时冻结，直接改前端数字会造成实际下游仍用旧值。

取舍：原创方向后的篇幅问卷由宿主从已保存preset构造，不让M03模型决定集数/时长，也不把随机创意追问强制变成六页；原始M03回包和其建议问题照旧留在不可变artifact用于审计。应用内M03方法对原创要求`specQuestions=[]`、改编仍允许真正缺失的来源事实问题；宿主面对旧/不守约回包也只把原问题保留为建议，不提升为原创必答。用户可选“按已有值”或输入有效自定义值；在同一`planning.decide`事务里更新作品preset、稳定集身份和workflow root，随后下一阶段重新按新值报价/冻结，不在客户端做两个可断开的提交。旧检查点/旧客户端明确拒绝缺少两项确认，新已答命令仅幂等回放。模式为改编的现有追问合同不改。来源事实与原故事不因选择讲法自动批准新增剧情。

精确路径：`src/novelvideo/director/{workflow.py,schemas/planning.py}`、应用内`skills/builtin/direction-options/{method.md,manifest.json,provenance.json}`及`skills/{pinned.py,runtime.py}`；`frontend/src/features/director/components/PlanningWorkflow.tsx`、`frontend/src/api/director-execution.ts`、同域`director.css`；`tests/director/{test_workflow.py,test_skill_runtime.py}`、`frontend/src/__tests__/director-execution.test.tsx`、三语`frontend/public/locales/{zh,en,vi}/translation.json`、`DESIGN.md`本节与本台账/claim/STATE。若发现必须扩大到其他路径，先补方案和scope再preflight。非目标：改编问卷重构、第二功能、模型文学质量声称通过、旧作品自动迁移、媒体与新的收费调用。风险：更改作品revision后下一组自动授权仍用旧revision、已生成M03 artifact与新root混读、扩大集数时稳定ID错乱；分别用投影返回当前workRevision、事务中只改未来根且保留M03原证据、复用`allocate_documents`并覆盖增减与刷新回归。回退关闭新UI/命令分支但保留已答决策和账本，不删除用户作品或旧回包。

实施中发现并记录分叉：当前`compile_planning`的M07原创输入只含brief/episodes/已选方向，没有向模型显式提供preset集数与单集时长。宿主最终会拒绝不符，但无法弥补模型在生成时不知道规格。新增本线已独占的精确`src/novelvideo/director/planning.py`：把确认后的preset安全投影到M03与下游prompt（不以页面字段替代服务端root），只读现有模型输入，不变更供应商参数/收费范围；新增实请求冻结快照断言。写入前重新preflight该路径。

定向测试发现的第二处接线分叉：本线既有实模型验证脚本`tests/director/live_execution.py`在方向选择时仍只提交旧的`specQuestions`答案，新增两项确认后被服务端正确拒绝；将该脚本精确加入本轮写入边界，按checkpoint中的`confirmedPreset`显式提交两项默认确认，不让测试脚本绕过真实合同。先核对该路径旧diff与claims，再重新preflight。前端自动推进另有作品revision在quote→grant之间丢失的风险，沿已认领PlanningWorkflow传递服务端最新workRevision并测试。

真实Seed首轮分叉：本机工具沙箱无法连接127.0.0.1网关，隔离尝试0.5秒返回UNKNOWN，未重派；只读提权连通检查网关可达，另建隔离作品。新作品M03/M07/M08三笔成功，M09返回合法JSON但给已确认closed单集的最后一集填写了非空`hook`，宿主正确拒绝并保留原回包，不能称全流程通过。根因是M09仅提示词约束、未启用该已验证Seed路由的结构化解码，而通用schema允许hook为字符串或null。沿已认领`planning.py`为M09开启同schema严格格式；仅在单集且closed时将发给解码器的hook收窄为JSON null（宿主原输出合同与检查不放宽），版本指纹更新；在`test_workflow.py`覆盖冻结schema和一集闭合/多集不误收窄。已付成功M03/M07/M08不可重买，沿已认领实测脚本新增显式`--resume-planning <保存目录>`只对M09失败且前序产物已保存的本轮隔离作品重新报价一笔；保留历史失败回包、未知结果不自动重派。新路径仍为本线既有范围，修改前重新preflight。

Git/冲突：main `213854b5`，本线既有业务/UI/方法/测试脏文件均在本台账已归属；逐路径`git diff -- <path>`已核对，新增hunk只叠加，不整文件覆盖。`origin/main`缓存中无同域新实现（Director路径仅本线新增）；不在脏工作树pull/rebase。guard 31线1130claims、无活动锁；本轮同一持锁会话串行修改三语和DESIGN。验证先原始取证三题/本地4方向对照，后端正负/幂等/并发/重开/下游实际请求，前端逐页按钮和状态、构建/i18n/ruff/设计lint/guard；最后在隔离作品以真实Seed从一次发送到三页提交+下一阶段执行一次，记录真实提交参数和返回，不覆盖旧失败、不调用DeepSeek或媒体。费用金额未知不记0；未知供应商状态不重派发。若原站仍未登录，像素同屏在线复验标未验证，不能称100%一致。

### 2026-09-28 · 首次发送无回复的接线修复（执行中）

用户纠偏：个人自用的导演流程不需要逐阶段费用弹窗。前述“创建后仅弹报价、仍需勾选”是与明确体验目标冲突的中间实现，不能算验收。现在首轮发送必须在同一用户动作内完成服务器有界报价→批准该阶段→启动Seed流；方向/修改问卷的提交在进入下一阶段时同样衔接，但一次动作最多推进一个新阶段。服务端报价冻结范围和幂等命令仍保留，`unknownCostConsent`由本次明确发送/提交意图授权；没有新的用户动作、刷新/重开、未知结果或连接中断均不得重派发/自动重试。UI不显示费用确认卡，故障时显示原请求的恢复动作。沿已认领的Studio/PlanningWorkflow/ConversationScroll、现有execution测试及三语窄改；不改后端收费记录或放宽模型调用上限。验证在专用smoke作品最多真实1笔Seed方向阶段，保留请求/回包与执行状态，不自动购买下一阶段。风险是方向选择被误当作多阶段授权；由一次动作只触发一个预算组和负向测试约束。

真实Smoke第一笔分叉：M03实际`model.started.stream=false`，故页面只有“执行中”而没有流式方向；回包JSON完整且`finishReason=stop`、1次模型请求、4个候选，但第4项缺必填`obstacle`，宿主正确拒绝，不可伪造或直接采纳。发送快照含`json_schema.strict=true`与required字段，但这一实际路由未达到严格约束保证。先改`planning.py`启用M03结构化流，`outline_stream.py`仅投影方向/问题白名单可读字段，前端`useExecutionStream.ts`/`DirectorConversation.tsx`显示增量候选，不泄露原JSON或把临时字段当已通过。补`tests/director/test_outline_stream.py`、`frontend/src/__tests__/director-streaming.test.tsx`和三语。旧失败回包留存，通过既有`validationRecovery`把准确缺失路径送入下一次用户主动发起的M03，不自动重试；一笔受限复验后停，验收流式可见、4候选最终校验通过或如实失败。新文件均归本线已认领路径，旧diff归属核对完；不改网关密钥、全局模型适配或其他阶段流协议。

验收目标：在空作品输入创意并按一次发送后，创建作品随即启动有界方向阶段，并在同一聊天浮层展示真实执行进度、流式内容及可回答的方向问卷；不需要第二次发送或费用确认。状态不再把仅创建的作品误写为“创作中”。已有作品刷新、重开不自动重报或重派发。非目标：改写模型/Skill质量、扩大到人物等第二功能、取消后端用量边界或未知状态保护。

现状证据：用户曹操样例的作品为`created`，仅`work.created`事件；对应workflow、quote、operation、execution记录均为0。`DirectorStudio.createWork`只建档并清空输入，`PlanningWorkflow`只在第二次发送时接收到`planning.quote`；原站已存证据表明首次发送即在同一会话流式进入方向分析、四方向和人工问卷。当前本地流式实现存在，但须在显式审批后的模型执行中验证，不把报价冒称为流式回复。

写入边界：仅已认领`frontend/src/features/director/{DirectorStudio.tsx,components/PlanningWorkflow.tsx,components/DirectorConversation.tsx}`、`frontend/src/__tests__/director-execution.test.tsx`、三语`frontend/public/locales/{zh,en,vi}/translation.json`及本台账；不改后端API、用户实际作品或第三方作品。追加ConversationScroll的原因是现有滚动只听执行流revision，新阶段卡插入后可能仍在可视区下方，造成“无回复”假象。步骤：新建作品后由同一PlanningWorkflow一次性报价并批准；阶段进度/失败有可见状态并跟随显示，防重入且仅本次创建生效；方向提交仅推进下一预算组；修正`created`文案；加首次发送、刷新不重发、断线保留原意图和真实执行回归；前端定向测试/build/i18n，隔离smoke与原站已保存样例核对。回退仅撤本段接线及文案，保留现有作品、报价历史与原有改动。已核对这几条路径的现有diff均归本线，claims覆盖Director域、测试和三语；guard无活动锁，缓存`origin/main`无本接线实现；不在脏树pull或覆盖其他线。

### 2026-09-28 · 接通第一功能并逐步与原站核对（执行中）

局改实测追加：M14把来源“愿望之后入画”改成愿望触发白雾的确定机制，M12未发现；同一批还有原文不变的伪修改。人工拒绝该批，不以模型复审通过替代人工验收。沿现有outline-patch/outline-audit方法包补匿名先后→因果反例、最小改动约束；宿主拒绝无变化hunk，不丢弃原回包。保留替换块中未改变的原有格式范围，避免采纳使字段粗体丢失。同步补revalidate方向/依赖指纹与末阶段checkpoint收束；测试、方法哈希、三语和进展记录仍在已认领边界。修复后以相同概要/修改指令重测Seed；不切第二功能。

流式接线追加：新outline_stream.py与test_outline_stream.py，使用已锁定pydantic-core的增量JSON解析能力而非自造正则提取器；只投影M07/M14白名单正文字符串，未闭合内容标临时预览，最终重复键/合同仍严格拒绝。dispatch保持response_format与流同通道；存原始prefix供断流恢复，preview不写正文。已有execution_repository、writing、outline_compiler、outline_changes、frontend useExecutionStream/DirectorConversation/ExecutionHistory/API与测试精确修改；新增只读purpose投影区分父规划与独立局改，修复后者被stage字段误隐藏停止按钮。前台不显示JSON、内部审查推理和假打字，不把传输恢复等同重新派发。

M12第二个实测漏报已定位：把新增跨空间听觉当interpretation。增加宿主叙事/说明角色：由原始段落位置与稳定lineage派生，不信模型自标nature；局改保留角色和原引用索引。动作叙事单元不允许interpretation绕过事实核对，schema前置限制、宿主最终阻断；报告绑定validatorVersion，旧已通过报告不可授权新规则下采纳。修改现有schemas/outline_delivery、outline_patch、outline_candidate_review、compiler、workflow与已认领测试；不替模型写supported，不修改原回包。

手编后真实UI报价发现上下文超预算（收费前422、未派发）：原因是patchContext的完整AST/段落索引与targets重复入prompt，新增保真引用使重复更大。修复compile_patch的模型视图：完整原快照仍入库并绑定hash，模型一次读取所有当前块（含保护标识、原type/attrs/marks、目标hash），不再重复读AST内部索引。保留全部源文/主张/当前稿，不提高上限掩盖冗余，不裁文。增加最新手编版本/参数指纹和预算回归。

最后一轮浏览器暴露审批弹窗直接铺满内部AST/schema，且M14标题缺翻译：沿已认领DirectorStudio/ExecutionHistory及三语、execution测试，把复杂对象收进技术明细（原参数不删不变），常用设定保留可见，补M14标签。测试脚本seed_outline_parity增加只读export动作，导出浏览器生产路径的请求/回包/流事件，不额外买调用、不覆盖已有原始记录。

末轮M12又新增findings_note并对narrative使用interpretation，严格门拒绝；不剥字段伪装成功。沿outline-audit方法包窄升3.0.3，明确逐层允许字段及宿主evidenceRole约束，保留既有适用short-drama参考。同步manifest/hash/runtime白名单与test_outline_pipeline反例；新批准单次Seed复验，已失败回包不改写。

3.0.3实测仍有JSON缺分隔符，原3.0.2还只核对28/48段。改模型线协议为可逆短编号1.2，宿主canonical仍1.0并兼容历史1.1；枚举完整路径、绑定准确条目数，最终仍验唯一/完整覆盖。M12只发送全部源文/当前候选/确认要求，不再重复发送作者M04图和DeliveryContext，避免独立核对被作者主张主导。沿outline_candidate_review/outline_compiler及pipeline测试，方法包3.0.4与hash同步；不是截断、补标点或删错误字段。若下一次仍不合格，保留真实失败并继续定位，不能放宽采纳门。

短协议实测48/48覆盖但一个证据对象代替数组，4处仍违规interpretation。将独立组合审稿接入明确失败反馈：只读同work/同candidateHash/同changeRevision已知完整failed回包，下一次用户批准时冻结原输出hash和全部schema错误到请求；UNKNOWN/截断/别候选不复用。不自动派发，不把invalid解释改写成supported；仍可返回uncertain并阻断。改现有outline_changes/outline_compiler与changes回归，修复“重跑拿不到具体失败原因”的编排缺口。

浏览器验收临时入口仅frontend/director-preview.local.html和.tsx两文件，串行独占，真实组件+隔离API/库，收工前删除入口，不作为产品路由发布。私有证据和API启动器放忽略output目录；不改用户常驻项目。新增文件曾误认为旧忽略规则覆盖，已发现并精确认领，不扩大目录。

本轮实测补充：M04把来源的未决边界与剧情事件分别分类，但宿主错误地要求未决边界也进入因果链。只修requiredEventIds筛选，保留全部来源主张、未决覆盖和稳定ID词典；新增反例。追加显式planning.revalidate命令，仅重校同根已知失败且完整的保留回包，不改原失败记录、不发模型请求、不绕过M12。新审计事件绑定原回包hash和当前校验版本；成功后下一份报价只列剩余阶段。原有域内schema/workflow、前端PlanningWorkflow/API/三语及已认领pipeline/harness测试承载，无新公共路由或迁移。

M12实测容量分叉：首次16384 tokens在钩子核对中明确length终止，完整收费回包保留，不认作审查完成。完整逐段证据需要比文学正文更大传输预算；只提升M12自动档至32768并在报价展示，传输超时600秒，用户仍可取消。其他阶段自动档不变；输入/输出估计超预算仍前置分段，不截文、不更改创作时长。对应output_budget/schema/capability与现有test_output_budget精确回归，下一次仅重跑M12。

审查实测分叉：完整M12发现真实时序倒置/新增心理，并有4处省略号伪逐字引用。新M12线协议1.1只选择宿主已编号来源单元；宿主以整段原文生成精确引用和位置，语义判断仍由独立审查承担，不再让模型重复抄写证据。旧1.0回包按旧合同保留/校验，不修改它来过门。另补WAIT_OUTLINE→revise→WAIT_COST：明确修改指令与旧候选/报告冻结在direction修订上下文，旧checkpoint/操作历史留存，仅新M07/M12付费、无需重抽来源；无未经确认的自动重写。涉及已有schema/compiler/workflow/方法包/前端问卷和测试边界。

用户要求处理完并边测试边与LibTV核对；本轮目标为S1改编大纲完整路径，不进入人物等第二功能。沿已批准Seed大纲细案继续B02–B08和B11：来源冻结/抽取/独立核对→方向问答→五节生成/候选核对→局部修改/持久审阅→手编和刷新恢复。新能力先由宿主开关在隔离项目启用；默认不迁移历史11节稿，不改常驻栈或原站用户作品。模型仅Seed；原站复用已存同源649字概要和215字指令、既有实测证据，在独立研究作品核对当前可见交互。每次付费调用完整留存到忽略output，无隐藏修复调用；已知失败先定位修复再新意图复测，UNKNOWN只查询。

恢复证据：main/213854b5，guard31线1121claims，无活动锁；B01及之前Director dirty均为本线，研究线与受保护资料不动。已核对拟接线文件diff；缓存origin/main无同域替代实现，同步分支保留不pull。代码仍实际走v2，B01纯函数通过不代表运行路径通过。

首批精确路径：新增域内`schemas/outline_source.py`、`outline_source.py`、`outline_compiler.py`、`outline_candidate_review.py`，新方法包`skills/builtin/source-events/`、`source-audit/`、`adaptation-outline/`、`outline-audit/`各文件；改`planning.py`、`workflow.py`、`schemas/planning.py`、`skills/runtime.py`、`skills/pinned.py`、`writing.py`、`dispatch.py`、`execution_repository.py`、`execution.py`、`output_budget.py`。新增测试`tests/director/test_outline_source.py`、`test_outline_pipeline.py`、真实opt-in`seed_outline_parity.py`，匿名fixture`tests/fixtures/director/outline-v3/source.json`；既有workflow/skill/runtime/streaming测试按需窄改。前端本批仅`components/PlanningWorkflow.tsx`、`api/director-execution.ts`及三语新增真实阶段/核对状态；后续patch/API/样式精确路径在动笔前追加并preflight。原skill参考只读，应用包版本/哈希/白名单同时更新；新的独立核对调用在父费用计划列出，不能藏在M07中。

接线增量：按细案§8.5追加`repository.py::write_verified_ast`与`store.py::_put_document`可选宿主AST，初稿采纳保留被核对的块ID和hash，不在落库时重新解析随机ID。仍沿原事务写兼容Markdown/版本/失效/事件；无新表、不迁移旧稿。追加pipeline测试断言重开数据库后的AST与候选相同。原站编辑器已复核五节目录、顶部和每节接受/撤回；全文与差异文字不可混读。

局改增量精确路径：新增`schemas/outline_changes.py`、`outline_patch.py`（稳定块连续范围、hash、保护字段、依赖组、确定性候选），随后`outline_changes.py`和`migrations/outline_v3.py`按已批准§8实现事务；新`tests/director/test_outline_patch.py`、`test_outline_changes.py`。本次先零费用正反例，模型运行中的方法包不修改以免使后续子任务能力指纹失效。第一轮Seed已完成M04/M05，继续M03；旧失败在报价前、未产生供应商操作。隔离测试模型网关复用现有配置，未重启或修改用户项目。

实测恢复增量：Seed M03在strict json_schema已传入的请求仍新增未知字段；原始回包和schema失败收据完整保留。新增正式的显式重修上下文：下一次planning.quote仅列未成功阶段，并冻结同作品/同根快照最后一次已知格式失败的operationId、输出hash、原输出与校验路径；grant后按同一冻结上下文执行。不得从UNKNOWN构造重试，不删字段、不隐藏额外调用、不重抽已通过M04/M05。写入仍为workflow.py/planning.py及上述pipeline/harness测试；上下文过大收费前拒绝。新的恢复机制本身需匿名失败→人工新批准→单阶段重修回归，再调用Seed验证，不能把碰巧重试成功称为供应商strict得到保证。

来源采用宿主完整分段与Unicode范围/摘要hash；模型给出段内准确引文，宿主定位为不可变证据，事件和主张ID由宿主内容身份派生，不使用响应数组下标。M05另一次上下文从来源列观察再对照M04；读完与语义支持分开，未决可保留说法归属，不能自动批准新增事实。先短稿单块闭环，长篇按已批准B09另门，超范围收费前明示。阶段产物沿现有workflow artifact和operation账本保存，暂不新增第二正文存储。M07五节候选通过完整审查后仍等待人采纳，不能自动定稿。

验证按零费用匿名反例→完整生产quote/grant/dispatch/checkpoint事务回归→隔离Seed实际运行→LibTV同状态截图/请求核对；真实失败独立保存。风险为阶段多一次调用但未冻结费用、审核与候选hash不一致、旧稿静默升级、取消重发，均补负例。回退关闭新请求开关，保留新产物/原回包和旧读路径；不删数据。未完成的步骤如实记录，不改验收门宣称通过。

末轮浏览器增量：`DirectorConversation.tsx`、streaming测试与三语按真实流类型区分大纲/分集标签。`OutlinePatchReview.tsx`、`api/director.ts`与patch测试读取服务端已返回的审稿units，展开显示阻断原句、原因和证据；不新增后台调用、不修改审核结论。只对匹配当前版本且标记阻断的段落提示问题，旧格式报告兼容；模型文本纯文本呈现。`DirectorStudio.tsx`给审阅态接入与编辑态相同的五类文档导航，切换仅查看、待审建议不隐式接受/撤回；新增交互负例并浏览器核对。发现精确替换导致上下文重复时，人工退回继续定向修稿，不能只看0事实错误。

### 2026-09-28 · 按功能块串行：先 B00/B01 五节交付

补充前一节本轮S1写入边界：局改接线沿B04–B08，`outline_changes.py`加两张加法表（本模块initialize统一安装）；`schemas/documents.py`加outline.decideGroups，`schemas/execution.py`加受限reviewTarget。报价/派发/落回包只对同一待审变更开放独立候选审查，不绕过其他pending或UNKNOWN。M14应用包`skills/builtin/outline-patch/`及runtime/pinned同步，沿short-drama保真和事件覆盖，不改全局技能。前端新增`components/OutlinePatchReview.tsx`，改`DirectorStudio.tsx`、两api文件、director.css、DESIGN、三语；新`frontend/src/__tests__/director-outline-patch.test.tsx`。逐节/逐组/全部操作，依赖组不可拆；组合审查的独立费用提示是明确的本地安全策略，不冒称源站同款。旧bool拒绝v3，CAS/幂等沿DocumentRepository。

本轮M07反馈：证据长ID重复导致截断，改可逆短别名后5619tokens完整；跨字段规则缺于decoder schema，补anyOf/枚举与负例，不裁剪模型输出伪造合格。旧失败和费用未知全部保留，M04/M05复用。

用户已批准按方案开发，并追加“第一个功能通过后再做第二个”。本轮严格限定 B00/B01：建立改编五节的严格模型输出合同、宿主来源/授权展示上下文、确定性校验、三语安全 AST 投影和旧 v2 分派兼容。先冻结匿名反例并实际跑出失败，再实现并重跑；不同时开发 B02 来源抽取、B04 patch、后续文档或媒体。此块是五节交付基础，不把它描述为已打通 S1 模型/UI闭环。B03 未接之前不将缺来源核对的新合同静默用于收费生成。

基线 main/213854b5；guard 31线1116claims、无锁。现存 outline.py 的单字退化门和本线其余 dirty 保留；新增路径不存在。缓存 origin/main 无新增同类模块，outline.py 有本线历史差异；同步分支同路径与HEAD一致；未在脏工作区 pull/rebase。已有台账/claims/STATE diff 已对账，本轮只改本线段落。研究线冻结的 plan-closure 当前源码指纹不改写为新验收证据。

精确写入：新增 `src/novelvideo/director/schemas/outline_delivery.py`、`src/novelvideo/director/outline_delivery.py`、`tests/director/test_outline_delivery.py`、`tests/fixtures/director/outline-v3/delivery.json`、`docs/guides/tv-director/outline-delivery-progress.md`；窄改 `src/novelvideo/director/outline.py` 仅按宿主冻结合同显式分派。测试、fixture与报告逐文件claim；源码使用本线既有Director独占认领，本轮preflight仍逐文件列出。其余业务、全局技能、原始证据、用户资料只读。source/event/decision 展示输入由宿主提供，不接模型自报 approved/audited；语义支持关系仍待B02/B06，结构成功不得标为事实或文学通过。

步骤：匿名正反 fixture/旧11节保留 → 必填/未知字段/引用/集数/结局/适用性校验 → 五节安全投影与稳定段落索引绑定AST内容hash → 宿主合同分派与旧v2回归 → 全Director回归、ruff/i18n/泄露/guard检查 → 记录本块结果和下一块入口。模型、来源解析器与UI像素门不在本块假验收；源码未接生产前不购买无价值模型测试。

本块验证补充精确路径：`tests/fixtures/director/outline-v3/projections.json`（匿名三语编译结果，由Python测试校验不漂移），`frontend/src/__tests__/director-outline-delivery.test.tsx`（用现有真实富文本组件读取相同结果，验证五节、目录、安全文本及打开不触发保存）。只加验证、不改前端业务/样式，不把jsdom当像素验收；`已接受/定稿`状态不固化进可编辑正文，留给后续receipt与界面，避免接受后正文仍永久显示待审。

收口审计追加：规格校验正确检测到 `outline.py` 当前字节不同于r2；本线在共享 `implementation-map.json` 中仅重新审计该分派增量、更新对应baseline hash并记录前一hash/本块报告，追加本块新文件hash。研究线已释放且本线唯一持锁；不改其 `plan-closure.json`、旧来源证据、157项产品not_run或验收门，不通过削弱校验器隐藏陈旧快照。先preflight该精确文件再改。

回退：移除新增合同分派即可保持旧v2行为；不迁移数据库、不修改已保存文档或回包。主要风险为混淆解释/授权、markdown标题注入、索引和AST漂移；分别用额外字段拒绝、宿主授权区分、转义/多行/emoji及hash失效用例验证。命令：`.venv/bin/python -m pytest tests/director/test_outline_delivery.py tests/director/test_outline.py -q`，再全 `tests/director tests/test_tv_director.py`；定向ruff、前后i18n、diff-check、gitleaks、agent guard。无提交/push/部署。

### 2026-09-27 · Seed 大纲对齐代码级方案（本轮仅文档）

用户要求将下一步方案细化到代码块并输出独立MD。本轮可验收交付为`docs/guides/tv-director/seed-outline-parity-implementation.md`：以agent-plan-outline §9真实双站证据和当前代码为基线，细化五节交付、short-drama条件融合、来源事实/独立核验、初稿/局部patch共用编译器、单一AST权威、持久分组审阅、流式/聊天/自动保存、迁移和真实Seed/像素验收。所有新增符号明确planned，不能把骨架当已实现。

本轮写入仅该指南、本台账/同名claim及STATE本线索引；所有业务、测试、旧证据指南和全局技能只读。main仍213854b5，无活动锁；旧业务/协调diff归本线保留，未跟踪用户资料不动。已检查三个协调文件diff；新指南不存在且diff为空；本地origin/main无同名文档或替代Director台账（D表示对方不存在，不是删除指令），同步分支引用保留，不fetch/pull/rebase。使用short-drama与skill-creator的已读方法作分层设计，进化查询无匹配，不改原始参考。

步骤：恢复协议/读源码和既有语义合同→列新旧接口与增量选择→写类型/算法/SQL/API/TS骨架及逐文件批次→审查重复权威/费用/版本/下游失效与失败恢复→检查文档链接、代码块语法、编号/范围、敏感数据和guard→交接。风险为文档建议被误当已部署、模型语义保证或完整产品完成，须明确现状/计划/验收三列；回退仅本次文档增量。涉及新增持久结构/接口的推荐选择完整写入方案，业务实施前确认本方案并更新精确scope，不在本轮偷偷实现。无收费模型调用、无浏览器外部写入、无提交推送/部署。

### 2026-09-27 · Agent Plan 与《入画》大纲对照（执行中）

同源打磨新增证据：本地Seed结构成功但把修改说明塞进synopsis，钩子新增独坐、阻力字段仍暗示环境有意诱捕；原站问卷fill未进入富文本状态，随后普通Enter提前提交，均只触发追问未改文；Shift+Enter正确换行后实测自填截至300字。操作失败完整留证，不充当有效配对。下一次把全部要求压为相同的300字内指令，两边从初稿各改一次；本地保留/忽略上一份待审失败候选、不冒充定稿。沿story-plan/method.md、manifest.json、pinned.py、test_skill_runtime.py、test_outline.py窄升M07到2.3.2：故事字段不混入对用户的修改报告；非人格化阻力不强填意图；钩子也须逐项核实动作与在场状态。short-drama三个原参考不改。先回归与包哈希检查，再重载本任务隔离API，仅Seed真实复测；不更改原常驻服务或追购媒体。完整五节投影合同与语义门另列，不以此窄修声称已完成。

**最新范围覆盖此前双模型实验：** 用户要求只用本地Seed对比LibTV的Seed，并允许先提炼概要。停止新增DeepSeek调用；此前source-authority-v1两笔已结束（Seed196.64秒、Flash64.12秒，均仅结构通过），全部保留，不再扩展横向模型矩阵。下一轮固定同一份从用户原稿人工提炼的概要、同一实验规格/回答，两个独立作品从首轮提问同步推进到大纲，再做同一条窄范围修改与保存恢复；按步骤记录请求/响应/时长/结构/人工内容检查，不将“调用成功”等同质量通过。每阶段先看两边差异再决定下一步，先完成首问和大纲这一个闭环，不自动跳到人物或分集，不买媒体。记录沿本线指南，原始概要与回包仅存忽略output；必要根因修复继续先列精确路径并preflight。当前用户只变更实验路线，不要求删除系统DeepSeek可选能力、不要求Git提交或重启其常驻栈。

同步概要首轮发现M03真实返回stakes_alt/stakes_note额外字段导致问卷不可用；旧严格输出只覆盖M07，M03仍文本通道。修复范围仅planning.py及test_workflow.py：M03也从同一宿主schema冻结json_schema协议，未知模型兼容json_object；保持原校验、不丢多余字段冒充成功、不改故事。planning版本升2.3.3使旧报价失效。先聚焦/Director回归，再重载本任务18780隔离API并用新意图重测Seed M03；LibTV停在方向确认不额外购买。收费失败和旧进程技能指纹错误均保留，不修改历史记录。

M03第二笔Seed严格请求仍多stakes_note，证明该路由不能只依赖provider strict；宿主拒绝正确但用户仍不可用。按skill-creator与short-drama作窄方法修正：direction-options/method.md升2.3.1，给出确切输出字段集合、补充放现有字段不新造键；区分真正未决问题与用户已经规定的处理政策，允许零补充问题，禁止以补问重新开放锁定顺序。更新manifest method哈希与pinned.py，追加test_skill_runtime.py包加载检查；原始short-drama引用不改、不删、进化库只读。第三笔仅Seed M03真实验证，成功后再与原站同一自定义讲法进入M07，不将失败文本删字段后强行采纳。

同源Seed轮M03第3笔和M07已结构通过，进入真实UI复核发现WAIT_OUTLINE仍显示原创“采纳全部筹备资料”，而checkpoint仅含outline。窄修PlanningWorkflow.tsx及三语键，按实际checkpoint文档集合显示大纲单独采纳/等待提示，避免只根据当前模式推测授权范围；改编阶段标题同步更正，原创完整筹备合同不变。补director-execution.test.tsx的outline-only文案/载荷回归，前端测试/build通过后在隔离浏览器采纳为可编辑草稿（非定稿），用同一窄修改指令同时测试本地Seed和原站Seed，保留修改前后回包，不发后续设计。另发现模型prompt重复序列化responseSchema/response_format，先记录尺寸与实际费用证据；本次不混入大范围编译器重构影响对照。

实际打磨预览在付费前422，原因为完整JSON schema同时放responseSchema和response_format，后者又被当创作参数全文注入，649字源概要的初稿prompt已60692字符，加入现稿后越过旧单文档60000门。不能让用户删故事或仅抬门槛。将此阻断转为窄根因修复：context.py只在发给模型的可读参数中将重复的response_format.json_schema.schema替换为其hash，保留宿主responseSchema完整一份和真实参数/传输strict原样；hash参与prompt确保不同解码合同仍有不同inputHash。context版本升级，tests/director/test_context.py验证不改调用者参数、正文末尾不丢、schema只注入一次及hash绑定，追加真实单文档outline编译回归。原Paid请求不变，新报价必须按新编译结果重新授权；先667后端全量再重启隔离API，仍只买Seed打磨一笔。不是通用长稿分块实现。

离线重编译进一步确认：去重schema后仍61904字符，其中已禁用规则完整审计元数据占4008字符。同一窄修将prompt里的disabled仅保留id/reason，完整receipt仍存manifest；selected规则、short-drama参考、源稿、现稿均不删。配套disabled审计完整与prompt紧凑回归，不扩大60k门，也不改变模型wire参数。execution capability加入context编译版本使旧预览失效，后续按原意图只读查询不受影响。

用户随后明确采用合理的后台预算方案：不再把token选择作为创作参数。替代上面的临时12288 UI默认方案：普通/高级设置均移除token输入及旧浏览器偏好读取；quote API的maxOutputTokens改为可省略，后台按阶段/集数/时长/来源与现稿规模计算并冻结预算，兼容旧客户端显式预算但不静默放大。新output_budget.py以本轮已实测预算为保守运行档位，不伪称已知供应商最大能力；未知模型不制造能力值。原稿与时长绝不被预算反向修改。确认卡展示自动处理和真实授权范围，技术数字仅审计详情可见。截断保留原响应，不提议/自动采纳半稿；跨段生成需要独立已授权的执行计划，不能把length误当网络重试或在一次许可下无限续写。先落地自动预算与无token UI，再按证据验证长篇分段边界，不宣称通用长篇链已完成。

新精确路径：src/novelvideo/director/output_budget.py、tests/director/test_output_budget.py；既有execution.py、workflow.py、schemas/{execution,planning}.py、api/director-execution.ts、DirectorStudio.tsx、components/{PlanningWorkflow,DirectorSettingsDialog}.tsx、director-ui-state.ts和相关tests/三语/指南沿已有边界串行更新。仅读取目录，不写供应商配置或密钥。已完成实测不废弃；可另加最多2笔自动预算实际调用（每模型最多1笔、UNKNOWN不重试），先mock合同和浏览器无收费确认再执行。

自动预算两笔实测后分叉：Flash并非正常故事过长，而是非法占位字段重复退化至length；Seed正常stop但缺2字段/多1字段。禁止以提高额度、放宽schema或补造内容掩盖失败。沿execution_repository.py与ExecutionHistory.tsx/API类型补安全校验摘要（只记录字段路径/错误类型，不含input/异常全文），区分截断与过滤并保留原回包，配套test_execution.py/test_streaming.py/test_workflow.py和director-execution.test.tsx；新增域内output_validation.py归原director独占。回放原回包离线诊断，不修改旧收费操作、不自动修复/重新购买；这轮2笔额度已用尽。长稿分段/续写仍需完整持久计划，当前仅预检拒绝明显超出单次范围，明确标记未交付，不能声称完成任意长度。

用户随后明确要求修复后继续真实调用直到验证正确，否定只留失败不修复的收尾方式。新增授权按证据迭代，不把上一批2次测试预算当用户阻止继续的理由：先每模型1笔小型结构化协议探针，再修实际输出合同传输，各1笔完整M07；若失败先修根因再开下一批，未知请求不重放。官方Chat API与模型表已查询，两目标支持结构化输出但Agent Plan实际路由仍须实测。当前只用json_object，schema仅放提示词，没有解码期字段约束，这是漏字段/假字段的根因之一。拟加域内structured_output.py，从同一output_schema派生实际json_schema(strict)请求，限定已验证模型，宿主校验仍保留；不削弱StoryPlan字段、不以修补字符串冒充有效返回。writing.py/planning.py/dispatch.py及tests/director/{test_outline.py,test_streaming.py,test_workflow.py,test_execution.py}沿原边界，output_budget/执行能力版本同步令旧报价失效，改方法则版本/指纹同改。严格格式通过后继续同源事实人工核对和真实审稿，不能将结构合格写成文学合格。

严格格式第1轮仍失败：Flash结构通过但大量正文退化为单字（非文学PASS），疑为宿主pattern=\\S的search语义被解码器按full-match处理；Seed仍多result_note字段，说明HTTP接受strict不是完全遵循保证。增加等价provider pattern转换[\\s\\S]*\\S[\\s\\S]*，保留宿主schema不变，补多行/纯空白等价与必填/禁多字段回归；新增outline.py的成片字段系统性单字退化门，不对创作时长或正常文段施加新长度目标。M07候选升2.3.1，强化字段清单/源动作与人物说法归属，保留short-drama方法与原始引用指纹；hash全部同步。继续下一组每模型1笔同源调用，逐笔检查，不将无正文结构通过当完成；此前小探针3笔（Flash另测nonthinking）、完整2笔全部留证。

strict-v2两模型格式通过后，用户要求查看实际提交与耗时。已输出本机忽略目录actual-submission-readable.md，未暴露鉴权。核对输入发现真实权威链错误：M03未审核的stakes/obstacle等推断随整份option被封装进confirmedDirection，和后来人工回答直接冲突。改编M07只接收选择ID/讲法difference/tone及实际freeText/answers，候选的剧情断言不得冒充确认事实；完整option仍留workflow审计不删。原创选项作为创意种子保持旧合同。planning.py升2.3.2并补test_workflow.py强断言错误候选断言不入prompt、原稿和用户回答完整；tests/director/test_outline_benchmark.py仅更新SDK mock的response_format关键字签名（全回归当前唯一失败），新增源与修改理由不变。下一组每模型1笔验证此输入根因修复；先人工全字段检查，再按需要独立模型核验，不停在格式通过。

用户提供完整《聊斋·入画》作为唯一比较底稿；两边冻结同一来源、集数/时长和约束，未确认设置明确标为实验设定，不当用户事实。先对齐大纲，不宣称整套Director已完成。short-drama、skill-creator、Playwright及plan/改编参考已读；保留现有方法根基，只根据失败证据窄改应用内技能。

现状：main=213854b5、同步分支=3fbd16e6，业务树一致；拟改路径diff为空、仅受保护未跟踪资料、无活动锁，guard31线1100claims通过。通用本地网关已按目录透传模型，但Director仍锁定router.text_model；前端仅展示一个模型且高级框可自由输入。目录实际默认ark::doubao-seed-evolving，另一个ark::deepseek-v4.1-flash启用可用。origin/main无Director替代实现；不pull/rebase、不改通用网关、不写凭据。常驻栈从同步工作树运行；主目录改动先隔离测试，不能冒称已部署。

1. 修Director模型合同：沿LocalModelCatalog解析、过滤可用文本模型，显示名称/渠道与canonical ID一一对应；默认Seed-Evolving、显式DeepSeek选择必须进入冻结参数和网关。禁用/不存在失败而非隐式回退。非本地兼容网关保留既有合同。模型只是下一次执行配置，单独切换不重开已定稿剧情；CAS、旧批准失效、在途请求不可换模型仍保留。
2. 前端真实模型菜单和设定器共用合同、重新打开/刷新恢复选择；不能用虚构选项或裸ID冒充友好标签。补后端合同/修订与前端选择、禁用、请求一致回归。
3. 隔离LibTV测试项目与本地数据，用同一用户来源对照：首次大纲、缺口提问、确认/改写、保存恢复与流式显示。最多12笔明确记录的真实文本请求（两模型基线+按证据修订复测），逐笔保存无鉴权的参数/响应/usage/失败；未知不重试、无媒体购买，费用未知如实标注。原稿含挽髻前置缺口和巡使触发口径差异，必须区分来源矛盾/提问/授权补写，不擅改来源。
4. 对照M07保留因果、动机、代价、情绪与主题的文学质量，不把JSON通过当质量通过；改技能时同步包版本、指纹与fixture，失败实验不自动晋级。界面按相同视口逐状态实测、记录整页原始差异与内容不可比因素，不使用局部截图声称像素级完成。

精确本轮路径：writing.py、revisions.py（director域）；frontend/src/api/{director.ts,director-execution.ts}；features/director/{DirectorStudio.tsx,DirectorPresetDialog.tsx,director.css}；tests/test_tv_director.py、tests/director/{test_revisions.py,live_outline.py}；frontend/src/__tests__/director-ui.test.tsx；三语translation.json；既有story-plan方法包、skills/{runtime.py,pinned.py}按证据再preflight；DESIGN.md；新增tests/director/test_model_catalog.py、frontend/src/__tests__/director-models.test.tsx、docs/guides/tv-director/agent-plan-outline.md。新测试/指南逐文件认领，其余沿既有独占/共享串行边界。忽略output/playwright保存私有原稿和实测，不提交用户故事全文、账号信息或原站素材。

实测分叉：两模型首次经生产执行均HTTP400/UNKNOWN（回包保留、不重放）；64token小探针取得明确InvalidParameter：max_tokens和max_completion_tokens不可同时设置。追加tests/director/test_outline.py精确回归；仅对ark命名空间通过SDK extra_body发送max_tokens，其他既有供应商合同不改，编译器版本升级使旧报价失效。成功后创建新基线意图，不修改未知旧回执。实际计费仍未知，不以HTTP400断言免费。

模型切换与审稿依赖分离：追加quality.py、outline_review.py和tests/director/test_quality.py。费用/生成快照继续完整绑定模型；审稿新增只排除model_name的内容指纹，切换下一次模型不废弃未变的原稿、报告、定稿。旧报告优先原inputHash匹配，仅能从原执行快照验证时兼容内容匹配，否则保持需重审，不能宽松跳过来源/方法/正文变化。无DB迁移。单独选模型明确表达用户操作，可直接提交零模型调用的CAS修订，不要求再填改剧情理由；混合故事参数修改仍走影响预览。

M07证据驱动候选2.3.0：首次Seed结构通过但把巡使口径统一成客观规则、挽髻未设前置缺口；DeepSeek原始输出因中文技术ID结构失败并增补脱险必要条件。新增story-plan/references/source-grounding.md，归纳已读short-drama adaptation-core/event-coverage且注明改编；只在adaptation加载，不给原创增加源码保真约束。明确ASCII ID示例和人物原名一致、回述不等于已安排前置事件。同步SKILL/method/manifest/provenance、runtime条件与pinned；新增合成输入的引用选择回归于test_skill_runtime.py。候选须两模型复测后再决定晋级，不把LibTV服务端方法冒称已获取。浏览器临时入口frontend/director-preview.local.html与忽略output下隔离API用于同内容比较，不作为正式业务路由。

原站实测后的流程补齐：新改编上传后先读来源、四方向及分页提问，再写大纲；本地旧入口直接M07，存在真实操作差距。本轮添加有界“改编方向→人工回答→只写大纲→人工采纳”，沿既有工作流表/幂等/报价，不新增隐式调用或改旧四阶段原创链。planning.quote增加可选targetScope=outline（旧客户端默认preparation不变），冻结完整sourceText及hash；改编仅允许outline范围，禁止冒称M04/M05全文审计已实施。M03适用改编并只调整讲法、不替换原事件；问题支持可选建议答案，用户可自由输入，已设集数/时长仍以设定器为权威，不把问答文本偷改参数。M07独立停止，不连带购买M08/M09；采纳不定稿。新增精确路径schemas/planning.py、planning.py、workflow.py、skills/builtin/direction-options/{method.md,manifest.json,schemas/input.json,schemas/output.json,provenance.json}、frontend/components/PlanningWorkflow.tsx（director域）、tests/director/test_workflow.py及既有director-execution.test.tsx；其他runtime/pinned/Studio/API/三语沿本轮边界。新增M03参考source-grounding.md使用本轮M07同源规则并登记指纹。新的问题合同与输入模式需要包版本/指纹更新。验证改编空来源拒绝、source冻结、M03/M07且仅两笔、问题未答/忽略不前进、刷新恢复、无人物场景道具覆盖、旧原创四阶段全部保留。M07两笔复测结构均过但事实仍有扩写，不以此晋级为文学合格；后续先验证提问能把关键缺口交给用户，再购买新大纲。

补充回归边界：tests/director/outline_benchmark.py按实际mode选择方法引用，避免原创消融实验误带新改编规则；test_streaming.py同时验证两Ark模型流式线协议没有重复token上限。问卷继续/提交分离、建议答案后自动翻页且最后一题不自动提交；同内容编辑器首块与段距按实站修正，DESIGN同步。纯展示差异与模型内容质量分别验收，不伪造五节改编正文或已审计来源字段。

真实输出上限修正：六笔完整大纲输出超过4096 tokens，旧默认值会造成正常入口截断。execution.py能力默认与director-ui-state.ts无历史偏好的初始值统一为本轮实测使用的12288；设置菜单补同值，不覆盖用户已选的1024/2048/4096/8192/16384。费用确认仍显式显示、冻结上限，不能静默补购。回归精确增加test_execution.py和director-richtext.test.tsx；没有改变实际已授权操作或后端请求必填上限，不增加自动重试。

验证从模型/修订单测→Director全回归→前端测试/build→真实两模型→LibTV/本地浏览器与像素→ruff/i18n/设计/密钥/guard。回退仅本轮代码/方法版本，不删正文、费用或回包。无数据库迁移、无自动提交/push；部署需精确检查服务所有权并验证原项目数据。全部证据和未达项写入新指南。

### 2026-09-27 · 推送已提交代码

用户在提交后明确要求push。本轮只将本地main的b5883b8f正常快进推送到既有tracking远端zhonggwv/main，不force、不pull/rebase、不推origin或其他分支、不部署。远端只读核验为私有仓库、main=f057a867；本地领先50个提交，包含此前已审计合并历史。远端同步分支已有新头4c9dee4f，本轮不合入也不更新。业务代码不改、不重跑收费模型；沿上一轮620后端/225前端/build与pre-commit结果。写入仅本台账/同名claim/STATE的推送交接，保留同步线旧diff及全部本地资料；提交目标固定为核验过的b5883b8f。普通push若因非快进拒绝即停止，成功后ls-remote比对目标SHA并handoff/release；回退必须另行授权，不自动回退远端。

### 2026-09-27 · 按用户授权提交当前实现

本轮只提交本线已完成的连续增量，不新增业务行为、不继续收费测试、不push/部署。Git为main/0298aefa、ahead49，索引为空，guard29线966claims且无活动锁；人物/场景/道具/分集/自动保存/媒体/事实检查及其测试、方法包、六份验收指南均由前轮本线留存。DESIGN与三语diff仅本线内容；同步线两份文档、STATE中同步线段落及受保护本地资料保持未暂存。现有origin/main没有Director域同类实现，私有同步分支仍在同基线，不pull/rebase。

提交边界沿本claim的实际已修改/新增精确路径（由status生成候选并逐路径preflight），不使用整树git add；STATE仅暂存本线日期、索引行与恢复优先级。先复核候选/密钥与diff门，重跑Director后端/前端与构建，执行实际暂存文件的pre-commit检查，创建带DCO的单一同工作线提交；验证提交路径、DCO和剩余状态，再handoff/release。回退仅将来显式revert该提交，不清理工作树。已有像素FAIL/文学漏判/长篇分块及实际图片质量欠项不因提交改成通过，本线维持执行中。

### 2026-09-27 · 批量画布、全文事实与整页像素（执行中）

用户明确补齐三项，不以单素材、六项总评、局部几何代替。恢复基线0298aefa/main，guard29线959claims无锁；旧Director差异归本线保留，同步线及受保护资料不动。检查拟改路径diff及本地origin/main：无同域替代实现、无director/story同名分支，不pull。short-drama/skill-creator/Playwright及单集/可拍性/改编/事件覆盖参考已读，知识查询无匹配。

1. 批量采用已存设计稿顺序的确定性规划（不付费让模型重新发明素材），自动为每项形成可编辑提示词、源文档版本和稳定节点ID。新增独立batch/node表，沿既有媒体意图及队列，不改旧canvas/freezone。计划原子落库、批准集一次冻结、未选中不发、取消只停未提交项，重连/恢复沿相同意图；部分失败/未知不得自动重买。节点与任务一一对应，结果只从项目任务读取，拖动位置CAS持久化。图像结果不写回剧本。
2. 扩展独立M12而非在M11自评：全稿逐段、完整来源及全部已写前集进入冻结上下文；逐段列原子主张和状态转移（主体/物件/位置/动作完成/内外与画中层次），逐一引文锚定，不允许未覆盖段落冒充完整。来源/跨集/本集均可回看，矛盾阻断、未知需逐项人工判断；新审查版本使旧报告失效，正文与付费旧回包保留。读取覆盖不是语义完美，明确人工复核边界。复用short-drama两份M12参考，窄修方法与指纹；新请求使用完整合同，旧回执按旧版本保留。
3. 同视口原站/本地整页截图、可复跑像素指标及差异图；记录页面状态/尺寸/数据差异、不得把遮掉正文或整块区域后结果当全页通过。按可比状态逐屏实点并修差距，源码方法/图像质量/像素状态分别验收。原站仅读现有稿与上次占位节点，不再重复购买。不能取得相同业务内容时报告原始全页差异与原因，不编造零差。

精确写入：新增director/media_batch.py、episode_facts.py；既有media.py、quality.py、schemas/quality.py、skills/builtin/episode-review/{SKILL.md,method.md,manifest.json,provenance.json}、skills/{runtime.py,pinned.py}、API routes/director.py。前端api/director.ts、DirectorStudio.tsx、components/{DirectorMediaPanel.tsx,DirectorCanvas.tsx,QualityReviewDialog.tsx}、director.css，新增useDirectorMedia.ts、components/DirectorMediaNodes.tsx。测试新增tests/director/{test_media_batch.py,test_episode_facts.py,live_episode_facts.py,pixel_compare.py}、frontend/src/__tests__/{director-media-batch.test.tsx,director-facts.test.tsx}，既有test_media.py/test_quality.py/test_skill_runtime.py/preview_execution.py及director-media.test.tsx；三语/DESIGN/临时preview HTML，本台账/claim/STATE，新增guides/tv-director/batch-facts-pixels.md。上述新域独占，三语共享串行追加，旧业务/凭据/用户稿只读。新增路径先scope/preflight。

顺序：合同与失败回归→服务端批次/画布与完整审查→UI→离线全Director→最多4笔独立真实文本审查（各请求8192输出上限、无自动重试，UNKNOWN停，复用已有稿不重买）→浏览器/像素→门禁与交接。实际金额未知不报免费，上限非账单保证；当前无新增真实图片购买，图片链以隔离队列和持久结果验证，真实图片如需另记明确单笔范围。验证pytest、Vitest/build、ruff/i18n/设计/CE/gitleaks/guard；回退只关新入口保留表/报告/费用，不删数据、不自动迁移事实、不提交部署。

实测分叉：首笔CE settings.db优先于env，未进入隔离网关，回执UNKNOWN保留且不重试；新正例实际V4-Flash返回完整内容，但OTHER_EPISODE携带有效事实被宿主互斥条件误拒。修正枚举语义并收紧场景头（内外/时间不能当纯标题跳过），补负例后安排新版正反两笔，总计最多4次授权请求。供应商reported outputTokens可含推理而超过8192，保留实际usage，不声称账单硬封顶。

### 2026-09-27 · 编辑、媒体与来源事实收口（执行中）

最新请求同时覆盖自动保存、编辑时聊天浮窗、角色/场景/道具媒体操作，以及年龄/称呼/动作/场景类型补写。基线0298aefa/main，guard29线954claims、无锁；已完整读台账、协议、DESIGN、Playwright、short-drama和skill-creator及人物/单集/可拍性/改编/事件覆盖参考，知识查询无匹配。既有人物场景道具分集diff归本线原样延续，同步线与用户资料冻结；拟改精确路径已检查diff，本地origin/main没有Director域替代实现，无同类远端分支，不在脏树pull。

分批实施而不以子批冒充全量：A编辑闭环复用既有document.commitManual幂等命令，不增第二正文权威：1秒空闲自动保存用户编辑（非模型采纳/定稿），串行合并后续输入；失败保留会话恢复稿及原命令，409不重基覆盖；关闭/切栏目/选区引用先flush，刷新未知响应重放同命令；保存状态置顶，私稿收进更多菜单，移除56px聊天偏移。聊天开关/停靠/拖放/窄屏按原站实测，待审采纳栏另行保留可达。B核对原站角色/场景/道具下拉和全能创作真实动作，接现有媒体目录、参数校验、项目任务与素材，不复制旧画布UI、不造可点击假入口；新持久化/API选择如需扩展，先补本段和精确scope再写。C来源事实先建立带来源和未知态的字段/动作约束及负例，冻结到请求并保留候选与人工确认，不把模型抽取当用户已确认。依据失败回包窄修应用内M08/M11，保留short-drama参考，真实样本在隔离项目有界执行，不改原站/用户稿，不重放旧UNKNOWN。

A精确路径：frontend/src/api/director.ts、features/director/{DirectorStudio.tsx,director.css,components/DirectorDocumentEditor.tsx,components/DirectorWindow.tsx}，新增useDocumentAutosave.ts；src/novelvideo/director/repository.py（既有幂等响应补事务workRevision，不改DB）；新增frontend/src/__tests__/director-autosave.test.tsx，既有director-execution.test.tsx/director-richtext.test.tsx/director-ui.test.tsx、tests/director/test_documents.py/preview_execution.py；三语、DESIGN、本台账/claim/STATE，新增guides/tv-director/interaction-closure.md；临时preview HTML。其他B/C文件读审后逐一追加。原站只读现有稿，实测媒体菜单已确认角色/场景/道具三类。

验证A：零改动不写；连续输入/输入法/保存中继续输入；断网/丢响应同命令重试；外部版本冲突不覆盖；关闭/切栏/引用/刷新恢复；保存不生成/不采纳模型/不定稿。三视口同几何与叠层可达，后端事务/前端用例/build/i18n/ruff/设计/密钥/guard。B/C有各自请求证据和行为断言，实际费用未知如实标记；不把schema通过当文学质量。回退只移除新入口/接点，保留正文、版本、费用与回包，不删库；本轮不提交/push/部署。

B取证纠正：源站场景图菜单实际自动切换全能创作、发送附文档的任务，读取3份创作文本并创建6个待生成图片节点，然后询问90积分确认。本轮未确认，已取消；原剧本文字未改，但测试已创建该对话和待生成节点，不再写成纯只读。此自动规划不等于图像已生成，费用余额观察仍930，不据此保证文本规划免费。全能创作与图片执行分离是必须保留的语义。

B技术选择已以非阻塞问题告知用户：新Director界面复用现有媒体模型目录及任务服务，保留显式费用审批。默认沿此兼容选择实施，不重建供应商网关。新增独立媒体意图表，不改正文表或已有媒体任务；prepare按已保存设计文档的H2顺序提取素材，用户勾选及编辑提示词，冻结文档版本、模型目录指纹、实际参数和一次执行ID；confirm原子claim，丢响应只GET/同ID查询、不自动重发。既有freezone/gen负责权限、模型参数映射、队列和供应商；Director薄路由适配，领域不导入API。没有目录选项的兼容模型只显示接口默认值并提示，不编造可用档位。金额未知明确显示且需独立确认，禁止报免费/0积分。新图像只在本次源素材下关联展示，文稿不被改写。

B精确新增：src/novelvideo/director/media.py，frontend/src/features/director/components/DirectorMediaPanel.tsx，tests/director/test_media.py，frontend/src/__tests__/director-media.test.tsx；既有src/novelvideo/api/routes/director.py、frontend/src/api/director.ts、DirectorStudio.tsx、director.css、三语、DESIGN、preview_execution.py及本台账/scope/指南。其余freezone/catalog/任务只读调用。先实现单素材独立确认；批量必须逐个冻结且逐个明确确认，不宣称与源站批量agent完整等价。验证空文档/跨作品/版本变化/同ID不同参数/双击/丢响应/供应商异常/仅选中素材/参数一致，前后端及浏览器隔离适配测试通过后再考虑单笔真实图像。

C具体化：对独立人物/场景生成，在冻结请求中附来源事实边界，模型给关键字段提供原文引证；宿主核对引用真实存在、主体和值匹配。人物具体数字年龄、称呼规则、记忆动作与受压动作，场景内外类型、空间限制及可复用位置，无证据则保持未知。未经证实的结果留在原回包，不产生可采纳变更、不自动重试购买。此门只是高风险字段引证检查，不宣称证明所有散文语义或M11动作；改编叙述解释不能变成新动作，分集仍需独立审稿。旧回包和旧已保存稿不迁移、不自动删改。

C精确新增src/novelvideo/director/fact_guard.py、tests/director/test_fact_guard.py；既有writing.py、execution_repository.py、skills/builtin/character-bible/{method.md,manifest.json,provenance.json}、skills/pinned.py、tests/director/{test_characters.py,test_scenes.py,test_skill_runtime.py,test_workflow.py,live_characters.py,live_scenes.py}。响应schema只在新单文档请求附sourceProofs；解析前验证并去除审计字段交既有业务schema，筹备M08及M11保持当前合同并记为未覆盖，禁止用局部规则声称全量已解决。真实模型上限本轮人物workplace和场景workplace各一次8192输出token，费用未知、无自动重试；失败原回包保留再人工审查，不盲目购买。技能按skill-creator增量改应用内包，更新版本/hash；不修改全局short-drama。

C版本门补充：运行时Manifest显式枚举允许版本，新增精确skills/runtime.py仅允许本轮已审计2.4.1，不放宽任意包/工具权限。回归在该门发现未登记版本会拒绝整个方法包，先登记再进行模型测试。

C两笔实测后的分叉：两笔均返回完整JSON但来源门未过；人物仍编示例对白且漏pressureResponse引证，另有句末标点误拦；场景把长段概括当原句，并漏内外证明。零费用修标点比较，voice列入高风险来源字段；新增schema关键文本字段的来源片段候选枚举与结尾检查说明，保持其他文学字段可写解释但不得新增事实。追加同两样本各一次对照（本轮文本最多4笔，各8192输出token，绝不覆盖首轮回包、不自动重试），用于验证不是仅靠拦截让功能无法使用。若仍失败如实留待审，不降低门槛以凑成功。方法2.4.2及全部指纹同步，筹备M08和M11未覆盖仍显式记录。

C结果可检查性：追加精确frontend/src/api/director-execution.ts，仅为既有只读result响应声明factAudit可选字段；repository.retained_result返回同一已存审计，DirectorStudio原回包弹窗展示失败字段和值，三语补文案。不新增收费接口或自动修订。

最终回归补充：tests/director/test_props.py仅同步共享M08方法版本断言2.4.2（不改道具合同）。A补聊天栏目切换/打磨动作同一flush屏障；B修目录空选项、必选参数显示和完成结果只读恢复，预览仅合成队列；C同一空间去重不把室内/室外不同地点强并。四笔模型已执行，不再自动追加调用，场景对照失败留证，修复后先用原回包零费用重验。

A冲突可用性补充：409只拦截会导致用户反复打开恢复稿仍无法前进。沿原A路径添加显式“下载本地副本并读取最新稿”，读取服务器后先导出本地文本，用户确认已备份才替换编辑区；不向正文POST、不合并/覆盖远端、不在请求仍执行或未知结果时重置。配套三语与hook回归，未知响应仍仅同命令重放。

### 2026-09-27 · 分集剧本与真实增量交互（方案就绪→执行中）

用户优先分集要素/操作/布局，特别要求对话、模型与技能流式打磨。基线仍0298aefa/main，29线949claims且无锁；逐项diff确认人物场景道具旧变更属于本线保留，同步台账和用户资料不动。现有origin/main无Director同域实现、无同类director/story分支，不在脏树pull。已完整读台账/协议/DESIGN/Playwright/short-drama/skill-creator及单集所需六参考、改编两参考，知识查询无匹配。

源站只读现存分集：H1集号/标题；目标时长、题材/口味、节拍、核心氛围、本集承接、本集钩子、关联资产七项；剧情梗概H2/正文H2/场号地点日夜内外H3；出场人物、△动作、粗体说话人/斜体表演提示/分行对白。1920正文x620/y178/680px、15/28，与前三页一致。参考稿含用户后续镜头修改，不能把每一处运镜都强制成文学剧本字段。既有研究已实测write_file活动、分段append、独立review及人工修改/定稿；复用合法留证不再付费购买旧样例，不操作原站正文。

现状：Agent.run等完整回包，UI每2.5秒刷新状态；已有持久execution_events/after_seq只读接口但前端未消费。M11已加载short-drama与保存人物/场景/道具/前集，但未规定原站分集交付要素。先接真实供应商run_stream，将文字增量和实际方法加载/模型开始/结束写同一运行事件；客户端按seq去重恢复，仅只读读取，不因重连重发生成。保留原独立报价/显式采纳/审稿/定稿，不新增自动收费审稿修订。本轮向用户说明该推荐方式；无相反选择时复用既有事件API，不引入第二种会话协议或数据库迁移。SSE长连接与事件短轮询两种可行，先复用现有鉴权事件游标（活跃时短轮询），不以传输方式冒充模型文字流式。

验收：七项/梗概/场次对白方法和可见缺项提示；模型实际增量在最终结果前到达并保留，思维链不展示；流中停止/中断/刷新/切作品不重复调用、不串稿、不将半稿变正式；用户指令及真实方法版本可回看；聊天按时间、跟随仅在底部、回到底部；分集目录可展开到每集/场次、交付卡可定位目标集、继续修改只预填不自动扣费。编辑器与聊天共存须保持版本CAS及未保存保护。生成、修订、审阅、定稿分开，末集不自动写续集。保留旧稿，不称自动审稿、完整M10或全套Director完成。

精确写入：writing.py/dispatch.py/execution_repository.py/execution.py，新增director/streaming.py和episode_format.py；skills/builtin/episode-writing/{SKILL.md,method.md,manifest.json,provenance.json}、runtime.py/pinned.py（方法指纹）；前端api/director-execution.ts、DirectorStudio.tsx、components/{ExecutionHistory.tsx,DirectorDocumentEditor.tsx,DirectorRichText.tsx}、director.css，新增useExecutionStream.ts与components/DirectorConversation.tsx；三语translation.json仅新增director键；DESIGN。测试新增tests/director/{test_streaming.py,test_episode_format.py,live_episodes.py}与frontend/src/__tests__/director-streaming.test.tsx，既有test_execution.py/test_skill_runtime.py/preview_execution.py及director-execution.test.tsx/director-richtext.test.tsx；临时preview HTML；新增docs/guides/tv-director/episode-parity.md、本台账/claim/STATE。网关已支持透传SSE只读不改，API既有events路由只读复用。其余业务/原稿/凭据不动。

步骤：源站及现有SDK/接口审计→方法/格式→供应商流+持久事件→对话与目录/打磨动作→零费用断线/取消/重放/分块Unicode/隐藏思考/多作品与UI测试→最多三次隔离真实模型（首集、承接、定向修订，各一次8192输出token、无自动重试，UNKNOWN停）→三视口浏览器与完整参数回包归档→文档/门禁/交接。费用未知不冒称免费或硬账单封顶。回退只撤新增接点、保留账单/事件/正式稿，不删库。验证Director pytest、定向Vitest/build、ruff/i18n/设计lint/密钥扫描/guard；文学事实另判，不用静态要素通过替代质量。

### 2026-09-26 · 道具设计要素、操作与布局（方案就绪→执行中）

用户优先对齐道具设计。登录态只读核对既有LibTV道具稿：道具清单H1→物名H2→类型/戏剧作用/使用边界/首次出场/关键集次五项；同类物按持有人区分，画中物与现实物、拍摄/持有/发送完成状态不混淆。实测1920视口正文x620/y178/680px、15/28、H1 23.25/H2 19.5，与场景共享布局。类型只观测到科技/证据，不据此虚构封闭枚举；采用输出语言自由分类。short-drama的episode-writing/ai-producibility/adaptation-core/event-coverage已读，知识查询无匹配，skill-creator用于维护应用内M08，不改全局技能。

基线0298aefa/main；guard29线946claims无锁。已核对拟改路径diff，人物/场景既有改动归本线完整保留；同步台账及用户资料不动。origin/main对应Director路径不存在（diff为D），无director/story同名分支；不pull/rebase。现状props仅Asset(id/name/description)，单文档未路由M08、M11未读取保存道具，需同时接通而非仅换排版。

验收：新增版本化PropDocument、五项三语人类投影，两入口共用；稳定ID/首次和关键集次由宿主校验，空清单必须说明但不得为凑数发明道具；历史旧描述只读兼容。M08独立道具只加载prop-craft，筹备加载三份，保留现有方法；持有人/位置/流转/状态/屏幕呈现范围融入戏剧作用及使用边界，不额外堆UI字段。正式道具与人物场景装入下游M11并绑定版本/hash，编辑使旧授权失效。UI核验切换/目录/编辑保存/刷新/引用/生成待审采纳，不覆盖别的稿。非目标：原站改稿、媒体调用、新API/数据库迁移、自动定稿及整套TVDirector等价；原站自动保存/聊天浮层与本地安全保存差异继续如实披露。

精确路径：新增src/novelvideo/director/props.py、skills/builtin/character-bible/references/prop-craft.md；既有schemas/planning.py、planning.py、writing.py、execution_repository.py、skills/runtime.py、skills/pinned.py、character-bible/{SKILL.md,method.md,manifest.json,provenance.json,schemas/input.json,schemas/output.json,fixtures/contracts.json}；新增tests/director/{test_props.py,live_props.py}，既有test_workflow.py/test_scenes.py/test_characters.py/preview_execution.py、frontend/src/__tests__/director-richtext.test.tsx；如需修复交互仅既有DirectorStudio.tsx/components/DirectorDocumentEditor.tsx/components/DirectorRichText.tsx/director.css；DESIGN、三语仅必要新增文案；临时frontend/director-preview.local.html沿既有claim；新增docs/guides/tv-director/prop-parity.md、本台账/scope/STATE。

步骤：字段和几何证据→合同/方法/筹备及单文档/M11→正负回归→最多三笔隔离合成真实模型（单集流转、双集同类不同物、改编画中物/未完成动作），各一次8192输出token，无自动重试，UNKNOWN停止；费用未知不报零、请求上限不承诺结算封顶。原请求/回包/usage/SQLite在忽略output完整保留→浏览器1920/1200/390与完整保存生成闭环→pytest/Vitest/build/ruff/i18n/设计/安全/guard交接。文学事实单独人工核对，字段通过不等于质量通过；不会盲目追加购买。M08升2.4.0与hash使旧报价失效；旧历史不迁移覆盖。回退仅撤本轮接点，不删文档/账单/旧回执。所有测试数为本方验证，不冒充源站内部Skill还原。

浏览器接点补充：执行卡把docKey=props直接显示为英文，不符合道具页的人类栏目名。追加精确frontend/src/features/director/components/ExecutionHistory.tsx（旧diff为空）及既有director-execution.test.tsx，仅复用已有三语section键映射四类设计稿的标题/无障碍名称，参数原始docKey不改、未知key保留、分集编号不改。不触及审批费用或新翻译键。

### 2026-09-26 · 场景设计要素、操作与布局（方案就绪→执行中）

用户将优先级转为场景设计。只读登录既有LibTV作品：场景清单H1→场景名H2→类型、戏剧作用、空间对行动的限制、可复用动作位置、关键集次五项；六个场景含室内/室外/电视画面中的空间。节点仍为通用“生成角色图”菜单，不按当前页伪造新按钮；编辑器正文x620/y178/680px（1920视口），延续人物轮排版。已读short-drama及episode-writing/ai-producibility/adaptation-core/event-coverage，经验查询无匹配；仅更新应用内M08派生技能，不修改全局技能。

基线0298aefa/main，guard通过且无活动锁；人物轮全部未提交改动属本线保留，同步线台账及受保护资料只读。拟改路径diff已逐项对账；本地origin/main无Director域替代实现，无director/story远端分支；不pull/rebase。现状locations仅id/name/description，场景单文档未挂M08，M11未读保存后的场景。解决这些接点，不以英文JSON投影冒充设计稿。

验收：两入口共用SceneDocument合同和五项可读投影，稳定ID、宿主集次/顺序、旧稿兼容不伪造；场景单独生成不覆盖人物道具；M11读取正式场景版本/hash，改场景使旧报价失效；UI切换/目录/编辑/保存/刷新/引用可用，沿已测共享布局；真实请求与原回包完整保留，结构与文学事实分别审查。不扩张到媒体生成、新API、数据库迁移、自动定稿或完整TVDirector等价。

精确路径：新src/novelvideo/director/scenes.py；既有schemas/planning.py、planning.py、writing.py、execution_repository.py、skills/runtime.py、skills/pinned.py及skills/builtin/character-bible包（增references/scene-craft.md）；既有frontend/src/features/director/{DirectorStudio.tsx,director.css,components/DirectorRichText.tsx,components/DirectorDocumentEditor.tsx}仅场景相关验证后必要改动；新tests/director/{test_scenes.py,live_scenes.py}及既有test_workflow.py/test_skill_runtime.py/preview_execution.py、frontend/src/__tests__/{director-richtext.test.tsx,director-ui.test.tsx}；DESIGN、三语仅必要新文案；新docs/guides/tv-director/scene-parity.md、本台账/scope/STATE。临时preview HTML沿已有精确认领。

步骤：冻结源站字段/几何→合同/技能/两入口/M11→正负例回归→三组隔离合成原创单集/原创多集/改编场景模型实测（每组最多一笔、8192输出token、无自动重试，UNKNOWN停止）→浏览器三视口与持久化→指南/交接。请求上限非金额封顶，实际费用未知；输出到忽略的output，公开只记安全摘要。新合同有sceneVersion，旧版读投影独立；更新包hash使旧授权失效。失败保留付费原回包，不自动重购。回退只撤本轮接点，不删文档/账单。验证Director pytest、定向Vitest/build、ruff、i18n、设计lint、gitleaks及guard；文学不合格如实记录，不由schema代替。

精确测试追加tests/director/test_characters.py：只更新M08版本断言至2.3.0（人物文档合同仍2.2.0），保留全部原人物回归；包版本与内容hash同时变，不能改了技能还报旧版本。

三例后分叉：2.3.0回包暴露两类具体缺陷：空间未知被强化成排他限制（唯一门/陈伯不碰盒），电视内车厢仅嵌入实景而未独立列项。不是schema错误，不伪称质量过关。沿已认领包/runtime/schema/writing/test_scenes修改M08内部documentKind路由，人物方法不再全量塞场景请求，共同原则仍保留；加入正反例：不替开盒≠不能触盒，有门≠仅一门、电视可见场所单列且不得当实际到访。包升2.3.1，人物合同不改。先增加零费用方法选择/禁区测试，再追加同silent/adaptation各一笔对照（本轮总上限5笔，各一次8192，无重试，UNKNOWN即停止），原三笔保持不覆盖。即使改善也只报告样本结果，仍不宣称可靠自动事实门。

UI报价点测追加：当前确认框把sceneRoot/responseSchema对象显示为[object Object]，不利于核对真实提交。沿DirectorStudio.tsx把对象转可读JSON（与现有ExecutionHistory一致），不改实际参数或授权动作；追加已认领frontend/src/__tests__/director-execution.test.tsx回归。没有新文案，不扩展设置或模型API。

类型检查补充精确路径frontend/src/api/director-execution.ts：现有quote.parameters还声明为标量，但服务端已经返回schema/root等嵌套对象；修正TS为JSON值类型，不改变API请求或响应。构建发现的类型错应修合同，不在测试强制类型转换掩盖。

### 2026-09-26 · 人物小传要素与编辑体验对齐（方案就绪→执行中）

用户最新优先级是人物小传，生成要素、操作、布局一致。已登录只读核对原站既有人物稿：人物清单H1、人名H2、加粗字段列表；主角/主要/次要分级，人物设定、剧中作用、标签、语言风格、说话破绽、记忆点、弧光、受压反应、称呼规则、首次/关键集次；次要人物简化，未知信息不编造。编辑器680px正文、15px/28px正文、23.25/19.5px标题、168px目录。观察不是私有Skill源码。short-drama /characters及villain-design已读，知识查询无匹配；skill-creator用于更新应用内派生包，不改全局技能。

现状：M08只有appearance/motive/knowledge/voice/arc等简项；筹备投影泄露英文key/ID；单文档characters入口未调用M08；节点仅裁切且编辑按钮在左下，人物目录只支持通用标题。业务拟改路径diff为空；本地origin/main不存在同域替代实现；三语/DESIGN合并实现已在HEAD，串行保留。无活动锁，29线940claims。同步线三份协调diff和三份未跟踪资料不覆盖，不pull/rebase。

验收范围：①版本化人物合同覆盖观测字段及short-drama动机/知情边界/关系，主次分层、未知不强造；②筹备M08和单独生成人物共用人物合同/方法，严格JSON/集次/ID校验，原回包保留、失败不自动重购；③三语人类可读投影、兼容旧稿只读不改历史；④人物编辑器标题/目录/字段排版、节点右上编辑、切换/保存/重载/选区引用不串稿，保留CAS/显式审批；⑤离线回归+真实浏览器三视口+有界真实模型样本，费用未知如实记录。非目标：角色图/H3媒体链、全能模式、全TVDirector等价、可靠文学事实审计与自动定稿；原站用户稿不修改，不在原站付费重生已存在人物。

精确路径：`src/novelvideo/director/characters.py`、`schemas/planning.py`、`planning.py`、`writing.py`、`execution_repository.py`、`skills/runtime.py`、`skills/pinned.py`、`skills/builtin/character-bible/`既有包及新增SKILL.md/人物方法来源摘录；`frontend/src/features/director/DirectorStudio.tsx`、`director.css`、`components/DirectorRichText.tsx`、`components/DirectorDocumentEditor.tsx`；必要窄UI辅助文件在同域内先追加说明。测试`tests/director/test_characters.py`、`live_characters.py`、`test_workflow.py`、`test_skill_runtime.py`、`preview_execution.py`、`frontend/src/__tests__/director-richtext.test.tsx`、`director-ui.test.tsx`；三语、DESIGN、`docs/guides/tv-director/character-parity.md`及本台账/scope/STATE。临时预览HTML沿既有认领。

步骤：先冻结取证字段/几何；扩充严格合同与派生技能，完整签名刷新使旧授权失效；接单文档/筹备投影，不新增API/迁移；补人物渲染/跳转与不丢稿交互；离线正负例后以隔离合成故事真实调用最多3笔、每笔一次、最多8192输出token/300秒，UNKNOWN立即停且不重放。保留完整请求/响应/usage/SQLite到忽略output，公开指南仅安全摘要。默认测试不联网不扣费。

风险/回退：新字段缺失拒绝但付费原回包仍留存；旧2.1产物读取用独立兼容投影不伪造字段；关系/集次只做结构验证，不冒充文学判断。回退代码/方法注册，不回滚用户文档和费用历史；正文编辑必须显式CAS保存。验证：Director pytest、定向Vitest、pnpm build、ruff、i18n/设计lint、gitleaks、diff/guard；真实模型语义另作人工逐项审核，不用schema通过替代质量。

接点审计补充：单文档M11当前未装入已保存人物稿，生成后的人物设定会在后续写集时丢失。沿已认领writing.py补必需人物上下文与版本/hash，人物更新使未消费报价过期；新增同文件测试，不扩大到场景/道具阶段。编辑器仍保留本地显式保存安全栏与私稿；不冒充原站自动保存或全能媒体链已通。

### 2026-09-26 · 续轮：独立大纲事实与因果证据审查

恢复：main/e7b1fbce，guard 18线457claims、无锁；本线域/测试diff为空（已归属未跟踪），本地origin/main无同域实现、无director/story分支，不fetch/pull。继承用户继续文学质量工作的授权。short-drama /review、episode-writing、adaptation-core、event-coverage已读，知识查询无匹配；保留M07 2.2.0，不上线已否证的长prompt。技能来源/宿主审查职责分开。

验收目标：已保存大纲可显式报价→独立模型审查→逐项证据报告，不再只支持正文。完整brief/source/locked facts按保留原文与offset的语句单元全覆盖；每单元需要逐义务结论，模型遗漏不能变PASS。剥离渲染稿中用户要求、创作禁区与自夸栏目，作为元数据不准当剧情兑现证据；实际情节引文必须属于正文叙事区且可精确定位。文学五维另列，不用平均分抵销违反。有效FAIL不被另一个坏条目抹掉；全正面也只为待人工复核，不等同定稿/实测时长。输入、版本、方法hash、原回包与usage沿现有审批和报告表持久化，失效后不复用。

方案取舍：复用已有purpose=review及quality_reports，不另起隐式多模型链/数据库迁移；保留用户草稿保存与采纳权，不把保存等同文学验收。本切片先支持已保存outline（规划待采纳四文档仍由人工决定，不能冒称其自动门已打通）。审查不自动修订/付费/定稿。已报告的事实FAIL应可见、不可标成可用；完整源事件独立审计、人类证据审批及后续编排强制门仍须另外闭合。

精确路径：新增`src/novelvideo/director/outline_review.py`、`schemas/outline_review.py`、`tests/director/test_outline_review.py`、`tests/director/live_outline_review.py`；修改`quality.py`、`schemas/execution.py`、`execution.py`、`writing.py`、`dispatch.py`、API routes/director.py（只增报告读取）、`frontend/src/api/director.ts`、`frontend/src/features/director/DirectorStudio.tsx`及新增`components/OutlineReviewDialog.tsx`；三语仅director新键、`frontend/src/__tests__/director-execution.test.tsx`；报告literary-benchmark、台账/scope/STATE。既有execution_repository报告保存hook复用，不改费用语义。审查适配器读取已验证M12来源参考，独立大纲方法/系统版本纳入capability，不声称新增完整第七包或获得私有LibTV Skill。不改全局技能、旧业务、源稿、Cookie、模型/代理配置。

步骤：纯类型/输入分层/逐项证据校验及负例→既有审批/派发/报告→页面只读报告与显式收费确认→离线回归→复用上一轮五份真实大纲，各最多一次8192输出token独立审稿（最多5请求；无重买初稿、无自动重试，UNKNOWN停止）。请求上限非结算硬封顶，实际金额unknown保留。若新审稿漏判，留原报告并明确源头未解决，不伪填评审。可追加零费用合成正例检验不是永远FAIL。

类型接点追加已认领`frontend/src/api/director-execution.ts`，只把审稿回执状态扩为UNKNOWN/REVIEWED，保留原M12状态和一次审批语义。

浏览器验收追加既有`tests/director/preview_execution.py`及临时`frontend/director-preview.local.html`：隔离合成已保存大纲与故意失败的审稿回包，用真实API/SQLite点测报告→报价→取消/授权→持久失败报告，不接真实供应商、不读用户作品。真实五例已显示职场与温情漏判，绝不据此开放自动放行；实测结论单独记录。

五例后源头审计分叉：M12整包text含“six check IDs”及正文格式，虽大纲system声明覆盖，仍是可避免的双指令；正确融合应仅载入已钉住short-drama参考，不把分集评审schema和大纲schema混用。沿outline_review.py改为reference-only binding，适配器升1.1.0、旧quote失效；不改M12包或M07。零费用HTTP模拟核验system/JSON模式/一次调用，额外最多一笔同职场旧稿独立审查（总6次，上限仍8192），只隔离这一变量，失败也保留，不能声称已证明因果或根治。真实检验后不再加购。临时费用提示同时修正三语boundedUnknownCost：显示请求token上限而非账单保证。

风险/回退：语句覆盖只是读取覆盖，不证明全部语义被识别；引文匹配不证明推理正确，正面结论仍须人工。模型生成的义务不是用户确认事实表。长source不截断，超上下文预算拒绝。新入口可关闭但不删付费证据/旧版本。验证：定向pytest→全Director pytest、ruff、三语/i18n、前端组件/build、浏览器实际报告/报价/取消（合成provider）及guard；不把UI验证算文学通过，不提交推送/部署。

### 2026-09-26 · 多题材真实文学质量验收（质量优先）

执行分叉（已见五份初稿，不用格式通过替代文学验收）：温情稿改掉明确交接顺序；职场稿只有可能损失、实习生表态支持而无改变结果的动作；悬疑稿在“无备用件”的自设规则后拿出备用衣，且主要靠迟到坦白；奇幻稿多添人物、把最后使用者拒收偷换成别人接收；改编稿核心事件较稳但概要归错修车人/车位。共同缺口是多个字段各自编故事、用创作评价代替事件。按skill-creator的证据驱动修订原则，不叠加样本专用禁令：将M07工作法改为“先确定单一因果主线及状态，再投影交付字段”，明确具体选择/实际后果/规则不便利变更。保留三份short-drama来源参考和原输出schema。升方法版本2.2.1、同步指纹，并将已认领`skills/runtime.py`的允许版本列表作为本轮新增精确路径；不改其他方法、供应商或UI。选职场与规则奇幻两例同输入复测（不预设一定通过）；温情/悬疑/改编不购买修订稿、不宣称已修好。初稿与评审原件原样留存，审稿伪引文不人工回填原响应。

复测否证与最后两次诊断：2.2.1职场漏action/result、setup链接且依然仅有条件性损失；奇幻structureId错误并继续修改能力/人物边界。两例均未进入候选，不把增加提示词视为修复。撤回本轮实验方法/runtime/指纹/test版本变化，精确恢复本轮之前2.2.0的内容（不动既有改动），失败版本已完整冻在request。原计划两次复测审稿改为职场一例“无大JSON约束的故事主线创作→独立请求投影原schema”诊断，总本方仍最多14次；新命令仅加于已认领outline_benchmark.py及离线测试，不接正式产品/审批，不买额外评审，不把单个成功宣称因果证明。输入保留short-drama三份参考、同用户brief/规格；第一步不读旧生成稿或review_checks。第二步完整记录冻结第一步文本与同规格，宿主照常严格校验，失败不补字段。以此辨别上下文/输出负担与纯模型能力，作为后续方案证据而非偷偷新增产品调用费用。

用户要求多套样本尽量对齐，并强调结构只是基础。本轮只验收故事大纲文学质量，沿用已交付M07，不把schema通过计入文学分。Git仍main/e7b1fbce，18线454claims无锁；现有Director增量归本线，拟改路径diff为空（未跟踪），本地origin/main无同域实现、无director/story远端分支，未fetch/pull。继承既有用户真实模型/有价值付费授权，采用隔离合成作品，不改正式稿与旧UNKNOWN。

步骤：①冻结五套各异brief/规格与仅评审可见判据：温情默剧1×120s、现实职场1×180s、公平线索悬疑3×120s、规则约束奇幻喜剧4×90s、完整来源改编1×240s；②逐例走生产quote/grant/dispatch，不调整用户规格换通过；③独立新上下文模型审稿（不提供作者模型/版本/期望结论）并由本会话逐段复核证据，硬错、结构性重写、局部建议分列；④依据已证实问题做窄技能修订，保留旧hash/原稿，最多选两例新意图复测；⑤留全部请求/正文/回包/usage/评分证据、对照局限和复跑方法。审核不等于两名真人盲评，不宣称完整24份基准通过。原M12当前只支持分集正文，因此大纲盲评用显式实验验收器，不伪装已接产品质量门。

费用范围：本轮五次初稿，每次请求上限12288输出token；每份独立评审4096；仅在证据支持修订时最多两份重生成及对应评审，总最多14个本方付费请求，无自动修复/重试。请求上限不当结算承诺，实际费用未知如实记录，推理用量单列可见分项；UNKNOWN保留并停止相关分支。LibTV基线先复用既有合法取证，仅当需要同输入比较时通过用户登录态创建最多两个明确命名的合成纯文本测试项目，不改已有作品、不生成图/视频/正文、不发布分享，记录实际可见费用；不能将不同brief比较包装为配对胜率。该项是本轮质量对标对历史“原站只读”的窄例外。

精确写入：新增`tests/director/outline_benchmark.py`（固定样本/单次显式运行/独立审稿与证据检查）、`tests/director/test_outline_benchmark.py`、`docs/guides/tv-director/literary-benchmark.md`；已认领`tests/director/live_outline.py`仅提取通用一次请求保存以复用审批链；必要语义修订限`src/novelvideo/director/skills/builtin/story-plan/{method.md,manifest.json,provenance.json}`及`skills/pinned.py`、`tests/director/test_outline.py`，先记录证据再preflight；`writing.py`仅允许在需要时保留安全usage分项，不改供应商/密钥/模型选择。文档outline-parity/本台账/scope/STATE同步。全局short-drama参考、用户原稿、既有源站证据只读；完整合成产物仅忽略output/playwright，公开报告只放短证据及聚合结果。

风险/回退：同模型评审偏好、自选样本与一次随机生成不足以证明泛化，采用匿名输入/具体引文/本会话逐段反驳、分离对标和自测结论；所有失败保留、不挑成功样本。无库迁移/UI/正式稿修改；技能回退可恢复旧包hash，已批准任务继续受hash失效门。验证：新验收器零网络离线测试→真实逐例→全Director pytest/ruff/i18n/包hash与quick_validate/gitleaks/guard。文学结论必须有原文锚点和未测边界，不能靠评分表堆满宣布质量一致。

### 2026-09-26 · 优先对齐故事大纲要素，保留 short-drama 方法根基

用户明确本轮先对齐大纲生成要素，并允许完善现有技能；不继续扩展UI或替换short-drama。已恢复现场，18线451claims、无锁；main/e7b1fbce，对拟改域及测试的diff为空（未跟踪增量均属本线），本地远端引用无Director同域实现；无pull/rebase。本轮原站仅只读已交付故事大纲，与已有trial-outline-delivery中write_artifact(skeleton.md)交叉核对：概要设计、故事简述、背景设定、主要关系与压力、全剧分段、为什么能追、钩子/伏笔/适用时反转预设、创作禁区。原站两份产物详略不同，不能把某次“≤6集”策略当成全部故事的硬规则。来源文章和完整用户剧本不入公共文档。

步骤：①建立观察要素→short-drama /plan、开篇/节奏/爽点→类型字段映射，明确 /outline 是分集目录不是故事总纲；②升级现有M07包到2.2.0，保留三份已钉住来源参考，增加完整概要/压力/分段/追看/钩伏反/禁区字段及空表不适用理由；③同一严格schema验证新筹备链及单文档大纲入口，集数/时长/结构/引用ID由冻结参数核对，缺字段失败且保留回包，不自动补空或重买；④确定性渲染中文/英文/越南文栏目，候选预览与采纳使用同一正文，不把内部JSON字段当标题；旧存量仅保守读取，不迁移、不覆盖或假称达到新合同；⑤真实合成模型一笔最多8192输出tokens，用现有报价/审批/派发链，保存完整冻结请求、原始返回、用量与逐要素检查，失败停止，不自动重试；⑥测试单/多集、开放/闭合、缺字段、越界/逆序ID、旧产物、能力版本失效、预览/采纳一致性及全Director回归。

精确边界：`src/novelvideo/director/{planning.py,outline.py,writing.py,dispatch.py,execution_repository.py,workflow.py}`、`schemas/planning.py`、`skills/{runtime.py,pinned.py}`；`skills/builtin/story-plan/{method.md,manifest.json,provenance.json,templates/request.md,schemas/input.json,schemas/output.json,fixtures/contracts.json}`及新增`SKILL.md`；其他三个筹备包仅生成一致的input schema快照/manifest哈希（若通用输入类型改变）。测试`tests/director/{test_outline.py,test_workflow.py,test_execution.py,test_skill_runtime.py,live_outline.py}`和现有`tests/test_tv_director.py`；文档新增`docs/guides/tv-director/outline-parity.md`，更新`skill-contracts.md`/本台账/scope/STATE。系统全局short-drama目录只读，本次改应用真正加载的派生技能，不另造平行创作体系。无路由/数据库迁移/外部API新增，旧报价以能力hash自然失效，旧文档和已完成回包保留。输出显示语言服从preset.output_language，非界面语言。

风险/回退：完整字段会增加输出长度和费用；用一次有上限真实测试测量，禁止拿schema通过宣称文学质量通过。新技能只影响新请求，旧稿不会后台改写。发现已批准旧任务必须先失效，不能用新schema解释未完成旧调用。验证命令：聚焦与全`uv run pytest tests/director tests/test_tv_director.py`、定向ruff、backend i18n、skill quick_validate、guard/diff-check；本轮无CSS改动，不跑像素验收冒充生成验收。

实施分叉：同一严格合同也改变了浏览器合成provider的返回格式，故把`tests/director/preview_execution.py`列入本轮精确边界，同步测试夹具（仅合成回包、零真实模型），避免之后UI回归使用已经无效的旧Markdown假响应。M07使用独立OutlineMethodContext扩展改编单文档模式，其他三个筹备包输入schema无需改动。uv默认缓存被沙盒拒绝，使用已有`.venv/bin/python -m pytest`和ruff；未重装或改环境。

真实验证分叉：第一笔71.84秒、输入19413/输出2388tokens，模型主体有全部栏目，但末尾重复assumptions/setupsNote/reversalsNote并追加未知字段，校验正确拒绝，原始回包留存且无候选/重试。现有传输只在提示词要求JSON，未启用供应商JSON模式；已核本机SDK源码和硅基官方JSON文档。本轮在既定writing/dispatch/planning/outline路径补M07专用`response_format=json_object`，冻结进报价、真实HTTP模拟断言它未丢；增加重复key硬拒绝，不做有损清洗。技能补“已确认事实不得重列假设、具体归属与动作不得写备选”。修正后另建新意图作第二笔最多8192输出token的人工发起验收；第一笔失败不覆盖，总最多两笔，不作自动重试或不明状态重发。JSON模式只保格式，不能冒充语义或schema保证；第二笔仍失败则保留证据，不继续购买。

用户进一步明确“时长应该由用户自己决定”：30秒只是本轮测试值。排查发现历史设定器另有5–3600秒静默钳制，不能继续替用户裁剪输入。本轮追加精确路径`src/novelvideo/director/models.py`、`frontend/src/features/director/DirectorPresetDialog.tsx`、`frontend/src/__tests__/director-ui.test.tsx`（同线独占无diff冲突），将业务范围改为正整数秒，去掉5秒下限与3600秒上限、保留用户输入，不自动套回默认值；非法/空值禁确认，不改布局/样式和文案。增加1/120/5400秒前后端一致、取消回滚、清空不偷改测试。默认120只作新建初值，模板选择继续不覆盖用户时长。时长冲突只能提示并等用户选修改内容或时长，不以模型建议自动更新preset；现有设置CAS流程不改。此次不追加第三笔付费请求。

### 2026-09-26 · 全界面续轮：设置、历史、编辑器及创作入口

画风已逐项从实际弹层读取21张公开无鉴权URL，新增精确 `frontend/public/director-reference/style-00.webp`至`style-20.webp`（仅02是png）；来源映射与hash入reference-assets清单，先claim/preflight后下载。不采集用户作品。发现原站男频显示“男频 -1”文字瑕疵，按既有male语义保留男频，不把显示bug复制入生成参数。

用户要求「全部对齐」，本轮沿UI优先继续，不重复首屏换皮。已恢复438行台账、DESIGN、UI差距与149按钮合同；基线e7b1fbce/main、18线426claims无锁，拟改Director未跟踪文件归本线，三语/DESIGN旧diff归本线保留，包清单/lock干净、无路径认领冲突。本地origin/main无同域实现，不在脏树pull/rebase。

按已登录真实DOM补测全局设置600宽/圆角12/中性38灰、历史320宽/圆角16锚定标题按钮、全屏编辑器52高顶栏/680正文/168目录、附件和模型菜单，再逐屏实施。顺序：①通用锚定弹层/焦点/ESC；②全局设置、通知及输出Token真实设置（自动付费与积分预算无后端能力时明确不可开启，不伪造生效）；历史搜索/空态及真实标题更新，归档若接入须保留费用/正文且不取消任务；③Tiptap富文本、格式/撤销重做/缩放/目录/选区回到创作器，保留原Markdown/版本CAS/私稿恢复和不支持格式保守源码模式；④实际文件入口、模型浮层、当前会话手动菜单、未发稿恢复；⑤题材滚轮/自定义、完整Top8字段、画风图片、画布平移缩放/工具栏；⑥问卷逐题、报价与候选运行态视觉；⑦三视口点击、单位回归、生产构建、安全/i18n/设计检查。新增依赖采用Tiptap 3公开发行包，不复制原站客户端业务源码；原站SVG只采图形，来源/hash补清单，未获再分发许可仍禁止发布。

精确业务路径：DirectorStudio.tsx、DirectorPresetDialog.tsx、director.css、components/DirectorDocumentEditor.tsx、PlanningWorkflow.tsx、ExecutionHistory.tsx、DirectorReferenceIcon.tsx、assets/libtv-icons.json、reference-assets.json；新增components/DirectorPopover.tsx、DirectorSettingsDialog.tsx、DirectorHistoryPopover.tsx、DirectorRichText.tsx、DirectorCanvas.tsx、director-ui-state.ts和assets/preset-templates.json；完整路径均在独占frontend/src/features/director域。依赖仅frontend/package.json及frontend/pnpm-lock.yaml，新增精确claim；测试director-ui.test.tsx/director-execution.test.tsx及新增director-richtext.test.tsx。必要历史写动作限src/novelvideo/director/store.py/models.py、API routes/director.py、frontend/src/api/director.ts与新增tests/director/test_history.py；新接口仅标题/软归档，不改正文或费用权限。三语仅director；DESIGN/UI验收指南/台账/STATE；预览tests/director/preview_execution.py和临时frontend/director-preview.local.html。新增画风资源逐文件取证后追加scope再落盘，不泛认领公共目录。旧画布、用户原稿、密钥和供应商链只读。

风险与回退：富文本往返可能损失未知Markdown→初始不改原文、支持格式往返回归、未知结构保留源码视图；标题与作品规格不能混改→独立CAS命令及审计；浏览器通知拒绝不能假开启；本地设置明确设备范围，不冒充跨设备策略。改动逐组件可回退，保留所有版本/任务/私稿，禁止删库/自动发模型。验证定向Vitest、后端历史/API回归、pnpm build、三语/i18n、DESIGN lint、guard、无外链/凭据扫描与1920/1200/390真实浏览器。未接通分享/插件/媒体不造成功，视觉完成与全功能交付分开记录；不付费生成、不提交推送。

### 2026-09-26 · 用户改为 UI 优先：参考站逐屏对齐

素材收尾追加精确路径 `frontend/src/features/director/components/DirectorDocumentEditor.tsx`：仅将已有关闭X导入切为参考SVG，编辑保存/私稿/选区逻辑不动。该文件为本线未跟踪实现、diff为空，无其他工作线写入；preflight后修改，原组件回归与build覆盖。

追加用户明确要求「图标也用它的素材」：覆盖此前临时装饰占位决定。只采集当前 TV Director/预设公开 UI 所用 SVG 图形和14张公共题材装饰图；不复制头像、用户作品、cookie、签名URL或服务端提示词。新增 `frontend/src/features/director/components/DirectorReferenceIcon.tsx`、`assets/libtv-icons.json`、`assets/reference-assets.json`，14张图仅写 `frontend/public/director-reference/genre-00.webp` 至 `genre-13.webp`，每个文件精确scope；来源/校验hash/未提供再分发许可证的状态留在素材清单，不把用户授权使用等同第三方授权公开再分发。SVG只保留图形白名单、数值/颜色属性，无脚本、事件、HTML或远程链接；以静态React图形渲染，禁止dangerouslySetInnerHTML。复验同视口截图、材质错配及所有图加载成功。文档与DESIGN同步移除“已用占位”的当前状态，但保留历史差异记录；尚未落实的功能仍不伪装成功。

本轮优先级覆盖上一轮 M10 待办，先对齐 TV Director 外观与操作，不调用付费模型。依据研究报告 §3.3、用户截图与本轮登录态只读复验；不能把相似布局宣布为全站像素验收。基线仍为 e7b1fbce；当前 Director 未跟踪实现、DESIGN 与三语已有差异均属本线。已查本地 origin/main(f51c2e44) 及 all-ref Director 路径，无相同新模块实现；共享翻译只追加本线键，不更新远端、不动旧画布/全局 index.css。

验收目标：① scoped 中性灰点阵画布、400×640/28px 浮窗、完整标题栏与欢迎 Top8；②1232×640 双栏设定器、264px Top8、单/双题材圆形布局、六张132×74参数摘要卡，点击进入字段编辑，取消不污染草稿；③节点悬浮工具栏、左目录/富文本正文；④标题栏收起/停靠、模式选择、历史检索、参数弹层键盘与窄屏可用。未落地的分享/插件/媒体按钮提供明确禁用原因，不能做假成功；后端调用和审批合同保持不变。图片资源若无可随产品发布的资产，仅保留可替换装饰位并明确视觉差异，不把第三方示例版权素材直接作为本产品资产。

步骤：读取实际 DOM/截图与历史证据→记录尺寸色值→重构设定器摘要与弹层（原有完整参数保留到高级区）→工作台/浮窗/文档预览及操作反馈→同视口1920×1080、1200×863及390窄屏验证→记录已验证和仍未达到像素一致的条目。

精确写入：现有 `frontend/src/features/director/DirectorStudio.tsx`、`DirectorPresetDialog.tsx`、`director.css`；新增同域 `components/DirectorGenrePicker.tsx`、`components/DirectorWindow.tsx`（如需尺寸交互拆分）；现有 `frontend/src/__tests__/director-execution.test.tsx`、新增 `frontend/src/__tests__/director-ui.test.tsx`；三语 translation.json 仅 director；DESIGN.md 的 Director 专节；预览 `tests/director/preview_execution.py`、临时 `frontend/director-preview.local.html`；新增 `docs/guides/tv-director/ui-parity.md`，以及本台账/scope/STATE。截图/几何测量仅忽略 output/playwright 下保存，无凭据。其他 backend、Skill、原稿与旧画布只读。

验证：聚焦 Vitest（包含取消回滚/字段保留/互斥题材/只读/高级参数）→tsc+Vite build→三语/i18n、DESIGN lint→隔离合成 API 的浏览器截图和交互（不读生产数据、不调用模型）。风险：仅换视觉可能丢字段/审批；以原合约测试及弹层草稿隔离回归。新灰色 token 仅局部覆盖，不改全站主题；回退只撤本轮 UI 差异不碰既有未提交功能和数据。像素差异需如实列出，首屏对齐不代表149动作或全工作流完工。

### 2026-09-26 · 本轮阶段编排、方向问卷及筹备审批

按22工作包完整退出条件核对，目前22包均尚有缺项，不用340个局部测试折算完成率。本轮接WP03–WP07的实际原创入口：方向四选/自由补充→一次方向确认→M07总纲、M08人物场景道具、M09目录的顺序子调用→一次筹备审批。保存父StagePlan、输入版本/方法hash、有限次数及输出上限；子请求从获批依赖生成独立requestHash/Approval/Operation，复用已有outbox与UNKNOWN不重发规则。问卷持久化，版本/恢复标识/操作者/幂等检查；忽略不默认批准，恢复不重买已完成产物。模型JSON按严格schema与集数/时长/结构/ID验证；筹备产物只在显式采纳时全CAS原子提交四类文档，目录作为有hash阶段产物绑定供后续M10使用。旧单文档写作兼容入口保留并明确标记，不谎称已执行M10或完整M11结构化正文。

精确业务边界：新增`src/novelvideo/director/schemas/planning.py`、`planning.py`、`workflow.py`；修改`execution.py`、`execution_repository.py`、`dispatch.py`、`writing.py`、`skills/runtime.py`、`skills/pinned.py`，在`skills/builtin/`新增direction-options/story-plan/character-bible/episode-directory四个校验包及各自manifest、method、schema、template、fixtures、provenance、LICENSE、已读参考；API `src/novelvideo/api/routes/director.py`。新增`tests/director/test_workflow.py`，已有`test_execution.py`、`test_skill_runtime.py`作回归。UI新增`frontend/src/features/director/components/PlanningWorkflow.tsx`，修改`DirectorStudio.tsx`、`director.css`、`frontend/src/api/director-execution.ts`、既有组件测试及三语translation.json；文档更新本台账/scope/STATE、runtime-validation.md及implementation-closure.md的进度链接。其余业务/原稿/研究证据只读。新增独立测试逐文件claim。

步骤：严格stage输出/父预算/决策schema→复用派发事务+结果hook→方向和筹备包校验加载→持久检查点/取消恢复/全CAS采纳→API与实际浮窗入口→单元/API/组件/浏览器验收→条件允许时一个合成方向真实模型请求，保存完整参数回包，不重试历史UNKNOWN。不默认自动修订，不自动展开后续集费用，不改编来源摄取假扮原创。下一集容量规划与全24包等缺项逐包继续保留。

本批验证接点：沿既有claim增加精确`tests/director/preview_execution.py`、`tests/director/live_execution.py`、临时`frontend/director-preview.local.html`与`frontend/src/features/director/components/ExecutionHistory.tsx`。预览新增合成四阶段响应，不读用户数据；真实验收器增加显式原创筹备case（最多方向1次+筹备3次，每次4096输出/300秒、任何失败/UNKNOWN立即停止），固定选择合成方向并记录决定，不生成正文/媒体，不对原失败请求重放。运行前先无费用验证回环连接；完整输出只在忽略output，金额未知继续null。子任务历史显示真实阶段且不将JSON筹备成功误标“草稿已保存”；控制入口统一父编排以传播取消。

现场：main e7b1fbce，guard 18线409claims，无活动锁；拟改Director路径diff为空（均已归本线未跟踪），本地origin/main相同路径无同类变更，skill远端分支只作只读审计，不fetch/pull。三语已有本线增量逐键追加；保留其他工作线diff。风险是父批准扩大范围、阶段结果过期、问卷重放与半采纳，靠冻结DAG/方法/规格、子请求预算事务、CP CAS和故障注入验证。回退关闭新编排入口，保留历史和账本，不恢复隐式重试、不清库。

验证：`.venv/bin/python -m pytest tests/director/test_workflow.py -q`后全Director+网关回归；定向vitest与build；ruff/i18n/CE/guard/diff/密钥扫描；UI先遵循已读DESIGN，不新增色板；真实模型不是mock通过替代，失败如实留存。尚无全量目标完成声明，不提交推送或部署。

### 2026-09-26 · M12 与逐项人工定稿先闭合，然后接阶段编排

在已有AST/费用/参数入口上接独立审稿，不向旧单次批准偷偷附加模型调用。`cost.quote`增加明确purpose=review（默认draft兼容），审稿单独冻结源稿/当前正文/上集/规格与输出schema，沿同一安全批准/派发账本执行。后续阶段父预算将复用该独立子调用，不能自评分冒充独立审稿。M12输出六类检查与原文证据；宿主核验引用、hash、必需类别和确定性错误。非法/截断回包为UNAVAILABLE且保留原始结果与费用；FAIL不得总分覆盖。当前尚未实现的完整source-audit和排演不标PASS。

精确路径：新增`src/novelvideo/director/schemas/quality.py`、`quality.py`、`tests/director/test_quality.py`；修改已有store.py、schemas/execution.py、execution.py、execution_repository.py、dispatch.py、writing.py、API routes/director.py、frontend api/director.ts与director-execution.ts、DirectorStudio.tsx、components/QualityReviewDialog.tsx、三语与两份已有Director测试。上述新模块位于已独占域，测试新增精确claim。本轮检查相关diff/本地origin无同路径实现，旧改动均归本线，继续现有唯一owner。

定稿v2使用版本/hash绑定的逐项人工证据和幂等命令，同事务保存Finalization/上一集边界并推进；canonical作品旧bool接口拒绝，旧legacy保持只读历史和显式迁移边界。版本变化使报告无效，迟到审稿只保留结果不更新当前稿。UI展示检查详情、重新审稿的显式费用预览、必要人工项和制作未验证提示。格式/来源关键失败仍阻断。不能把模型审稿得分当已测试拍摄时长。回退关闭v2新写，不启用bool绕过，不删历史。

验证：合成正确/漏类/伪造证据/过期/越权/并发/重放/UNAVAILABLE/硬失败；后端全Director与网关回归、UI参数/审稿/定稿、build/i18n/ruff。独立审稿接通后在已授权有界真实模型样本验证，保存参数/输出/usage，实际金额未知不计0。

本批验证接点扩展到既有`tests/director/live_execution.py`、`tests/director/preview_execution.py`与临时`frontend/director-preview.local.html`：真实审稿读取上一轮三个已留存合成样本和其原始指令/来源（只读），导入新的隔离测试作品，每例只发一次4096输出token以内的独立审稿，不重买正文、不改原证据、不自动修订。通过新费用批准链；UNKNOWN立即停止后续调用。浏览器fixture增加可解析合成审稿响应，真实页面核验费用/报告/逐项定稿，截图和请求完整证据只写忽略output目录。本机服务仅绑定loopback，关闭自己启动的进程。使用Playwright技能做UI验证，不操作LibTV账户。

浏览器实测追加精确`frontend/src/features/director/components/ExecutionHistory.tsx`：审稿成功不是“草稿已保存”，运行卡按purpose区分审稿与写作，报告FAIL/UNAVAILABLE明确显示。沿原预览及费用权限，不增调用。

迁移/定稿衔接分叉（原合同要求，不更改授权目标）：代码审计发现v2若仍读取旧episode_confirmations，已迁移定稿无法重审，且新版Finalization会被旧表的ordinal主键挡住。改以director_finalizations_v2及按finalizationId的失效记录为canonical权威，legacy表只保留历史不更新。显式迁移回到首集复审，旧正文版本保留；fresh独立审稿与逐项人工确认可解除legacy_unverified门，不伪造生产验证。补`repository.py`失效闭包、`migrations/v2.py`首集复审和`test_migrations.py`/`test_quality.py`正反例：升级两集旧定稿→重新审阅→逐集新定稿，旧确认行逐字保留；修改上游仅使依赖定稿失效，不使较早集被写下集无理由失效。

### 2026-09-26 · 持续完整交付：正文权威与阶段依赖先接入现有操作

本轮继续完整目标，不以执行层切片作为结束。首批实现WP01/WP02/WP11的正文基础：在同一Director SQLite内增加稳定文档/集ID、不可变AST版本、用户草稿、派生产物与依赖失效；新作品直接使用AST权威，旧作品必须先预览、校验一致性备份hash再显式导入。v1读取和编辑作为适配器读取/提交同一AST，Markdown只作确定性投影，不引入两个正文权威。旧确认保留为历史，不迁成v2通过。已有安全执行和未知费用规则保持。

精确路径：`src/novelvideo/director/schemas/documents.py`、`documents.py`、`repository.py`、`migrations/v2.py`、`store.py`、`writing.py`、`src/novelvideo/api/routes/director.py`、`tests/director/test_documents.py`、`tests/director/test_migrations.py`、`frontend/src/api/director.ts`、`frontend/src/features/director/DirectorStudio.tsx`、`components/DocumentVersionPanel.tsx`、三语translation.json及本台账/scope/STATE。业务新文件在已认领新域内，测试逐文件新增。后续方法和界面仍按closure依赖补方案/preflight，不将这一批当全量完成。

步骤：①AST严格类型、保守无损Markdown适配/稳定块ID/UTF16选区及hash；②同事务版本保存和派生依赖闭包失效，阶段结果绑定准确输入版本；③旧数据一致性快照、预览hash/CAS/幂等导入，不自动转换来源编号或旧确认；④接现有创建/读取/编辑/生成快照路径，API权限+严格命令；⑤页面版本/导入/失效提示；⑥迁移、双写竞争、Unicode往返、过期产物和接口回归，再继续阶段运行器。旧数据保留，回退关闭新写不删表、不倒灌旧正文。

本批界面回归同时更新已认领的`frontend/src/__tests__/director-execution.test.tsx`，覆盖旧稿预览取消不升级、确认断线复用意图、当前稿版本标记；新增文档API的鉴权/越权/拒绝未知字段测试放`tests/director/test_documents.py`。不调用真实模型测试纯存储行为。

后续WP06精确路径：`src/novelvideo/director/context.py`、`rules/resolver.py`、`tests/director/test_context.py`、`tests/director/test_rule_resolver.py`、现有`writing.py`/`execution.py`。执行18规则条件白名单、选中/禁用理由、来源hash与上下文必需版本核验；先冻结静态规则和当前空知识库事实，不冒充24个包已加载。M22只做确定性编译，不自动付费摘要，超预算拒绝并保留尾部；上下文数据无系统权限，使用JSON资料区隔。把实际规则清单/manifest hash加入当前生成快照和能力指纹，使旧预览不能执行升级后的编译器。当前旧Preset缺少的商业/反派等确认值保守禁用，不猜用户同意；后续完整Spec再给明确参数。验证条件正/负/冲突、跨作品/hash/缺依赖/超限/Unicode与现有执行回归。新增两测试逐文件scope，其他共享文件不扩展。

WP14参数接点（不替代完整Spec/影响分析）：增加精确`src/novelvideo/director/models.py`、`frontend/src/features/director/DirectorPresetDialog.tsx`，沿已认领writing/API-client/Studio/三语/现有测试落实八种结构、故事基调与画风分离、结局、语言、市场、保真/新增范围/锁定说明及来源/交付标签独立字段。旧preset没有字段时默认值须页面可见并与服务端一致；旧four_act/custom只作为兼容选项显示，不能静默映射成八枚举之一。每个新字段保存→重载→冻结参数→context规则一致性测试；模型版本对话从capability取，不再硬写1.0.0或声称不存在的完整方法包已执行。未实现的影响分析仍不能借编辑规格绕过锁定。

现场：main仍e7b1fbce，402claims无锁；本批路径git diff为空（现有未跟踪模块归本线），本地origin/main无同路径差异、无director/story远端分支；不fetch/pull。冻结两条Director既有diff及其他资料。风险是混合旧接口造成双权威、静默迁移、误复用旧报告，分别由单一事务入口/显式迁移/依赖与hash验证回归阻断。验证先`.venv/bin/python -m pytest tests/director/test_documents.py tests/director/test_migrations.py -q`再Director全套/ruff/i18n/build/真实浏览器；质量真实模型只在阶段已接入后用已授权的有界新意图验证，保留全部失败回执。

### 2026-09-26 · 完整实现续轮：先接真实执行路径，再扩展阶段与界面

用户明确要求认真完成完整TV Director。本轮按v2.1工作包推进；不再把独立函数通过当产品完成。先将WP02–WP05费用/幂等/事件/恢复接入当前可操作的生成入口，使用additive v2表保留旧作品/文档/运行记录；随后按前置推进阶段方法及v2参数/界面。WP00其余fixture与对应行为同时补，而非为了凑齐编号创建不可执行占位。只有实际打通的行为才更新完成状态。

首批精确路径：`src/novelvideo/director/schemas/execution.py`、`src/novelvideo/director/execution_repository.py`、`src/novelvideo/director/execution.py`、`src/novelvideo/director/dispatch.py`、`src/novelvideo/director/writing.py`、`src/novelvideo/api/routes/director.py`、`tests/director/test_execution.py`、`frontend/src/api/director-execution.ts`、`frontend/src/features/director/DirectorStudio.tsx`、`frontend/src/features/director/components/ExecutionHistory.tsx`、`frontend/src/features/director/director.css`、`frontend/src/__tests__/director-execution.test.tsx`、三语`frontend/public/locales/{zh,en,vi}/translation.json`、本台账/scope/STATE。新增API客户端/测试逐文件认领；后续新路径先追加方案与preflight。当前方案不改旧文档存储语义，不隐式迁移/清库，不改其他工作线配置、媒体供应商及共享画布，不调用LibTV或真实付费模型进行试错，不提交推送。

实施：①严格命令、hash绑定quote/approval、一次用户意图的幂等键；②同事务reserve+operation+outbox+event，冻结服务端实际参数与输入；③worker原子领取一次，超时/断线归unknown并保留预留；取消未发任务可释放，已发取消不冒充退款，成功结果只落待审稿；④API仅鉴权/路由，v1写作入口也走同一安全服务避免绕过；⑤页面持久任务投影/刷新恢复/停止/参数与费用确认，并阻止旧任务覆盖新作品；⑥并发/重放/断线/取消/过期/旧版本/无权限API测试、组件测试、构建与真实浏览器本地模拟验收。旧v1读取继续；错误码与三语文案同步。

基线仍e7b1fbce/main，两个Director线脏文件已归属。当前18线392claims、无锁；拟改新域/route/frontend/API/tests的git diff为空（本线未跟踪），本地origin/main相关路径无同类差异；没有pull/fetch。三语仅追加键。风险是远端exactly-once无保证、未知费用不能记0、停止/重启丢回包、用户切作品期间迟到响应；用唯一派发键、持久状态/事件和故障注入验证。回退保留新表/审计，停新写入口，不删除运行数据；无账本的旧自动重试入口不能作为回退手段重新开放。

验证命令：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q`；定向ruff；frontend定向vitest及pnpm build；i18n/CE边界/规格回归/gitleaks/guard。交接必须标明已接入路径、尚缺工作包与未跑的真实质量/设备验证。后续阶段涉及short-drama时已重读Skill及路由参考，参数/版权/来源冻结遵从融合合同，不宣称私有Skill还原。

执行分叉：旧`POST generate`没有用户意图ID、用量上限和持久授权；自动包装会把网络重试误判新生成，不能安全兼容。按closure要求保留v1读取，将此单一旧付费入口改为409 `EXECUTION_V2_REQUIRED`，页面同步改v2；不删除旧文档/运行记录，其余旧接口不变。新增精确写入`tests/test_tv_director.py`，只将旧生成测试改为升级拒绝/0调用，其原成功路径迁到真实v2事务/API回归。此前17条结果是历史，不再冒充旧付费写接口仍可调用。

安全接点与浏览器验证：新增本批精确写入`src/novelvideo/director/store.py`，只在同一事务质量门拒绝仍有v2活跃/UNKNOWN任务的定稿，避免旧接口绕过；新增`tests/director/preview_execution.py`仅本地127.0.0.1合成模型验证器、临时`frontend/director-preview.local.html`（完成后移除）加载真实组件/i18n，独立临时数据目录不读用户作品与凭据。截图放忽略的output/playwright；浏览器证据不代表真实模型质量或完整工作台。额外网络只访问本机测试端口。

用户追加真实模型验收授权：模拟不能证明写作质量。本轮增加`tests/director/live_execution.py`显式命令行验收器与`docs/guides/tv-director/runtime-validation.md`结果报告，新增精确scope。在隔离合成故事项目执行原创、保留来源的改编、定向修改三个真实请求，每次最多4096输出token/300秒/一次调用，遇UNKNOWN不重发；默认不运行，须显式传同意计费参数。通过生产quote→approval→dispatch→待审路径，不直连绕过审批。请求快照/完整合成文本输出存忽略目录，公开报告只放合成事实与断言、usage摘要，不存鉴权头/URL/账户信息。增强writing返回安全usage/finish_reason回执、dispatcher保留，实际金额仍未知而非0。不会因写手自评通过就标全套Skill/LibTV等价；失败样本要记录源头和后续修复。

真实链路诊断分叉：首次生成UNKNOWN/1.12秒后停止；不重放该operation。只读GET models对照证明本机回环地址在trust_env=True返回502空体，False返回200。新增精确`src/novelvideo/config.py`（local-stack已wildcard共享）、`tests/test_newapi_text_gateway.py`、协调`docs/agent/tasks/local-stack.md`：仅让未显式设置NEWAPI_TEXT_TRUST_ENV的loopback文本客户端绕过系统代理；远端与显式开关行为不变，不改网关/密钥/启动器。Git此两文件干净，本地origin/main差异仅已有图像选项，与该函数无重叠；前置gitleaks后preflight。回退仅该窄hunk。验证默认远端True、loopbackFalse、显式True/False和真实新意图；首次UNKNOWN仍保留不写0费用。

界面验收补缺：`frontend/src/features/director/DirectorPresetDialog.tsx`现有变更直接写父级草稿，取消实际上未撤销。新增本批精确路径，改为弹窗内独立草稿，确认才传父级/保存，取消/ESC/遮罩丢弃；异步导入用当前草稿合并避免覆盖刚改字段。更新既有DirectorStudio及组件测试。修复375px顶部按钮挤成竖字（不增设计token）、确认费用断线错误展示在当前弹窗内。此不代表八种结构/全部参数字段已补齐。

付费回包保留接点：在本批已列出的execution repository/route/client/history/studio/test/三语路径中增加只读`GET v2/works/{workId}/runs/{runId}/result`，返回项目权限内已保留输出与hash（无prompt/凭据），迟到/取消/截断结果可查看但不可由此直接采用；不发模型。展示安全usage和provider-reported model（不能宣称底层权重验证）。actual_output_tokens记录供应商回执，金额仍unknown。覆盖跨作品访问、缺失结果、只读与不产生新候选的测试。

### 2026-09-26 · 恢复实际实施：WP00/WP01首批硬约束

用户追问为何停止；本轮继续已批准实现，不再仅改方案。验收目标：F01/F03/F05/F11/F17/F19/F23/F27/F28九类匿名fixture变成真实代码调用的正负断言；严格v2模型拒绝未知字段/错误类型/非法版本；来源读取与独立审计分离、依赖闭包、声画DAG、引用稳定顺序、Skill回执和问卷CAS、UNKNOWN恢复有可运行纯函数。此为WP00/WP01首批，不冒充全49schema/184命令/33fixtures或已接前端与数据库。

精确写入：`src/novelvideo/director/schemas/__init__.py`、`src/novelvideo/director/schemas/common.py`、`src/novelvideo/director/schemas/foundation.py`、`src/novelvideo/director/semantic_validator.py`、`src/novelvideo/director/duration.py`、`src/novelvideo/director/references.py`、`src/novelvideo/director/recovery.py`、`src/novelvideo/director/checkpoints.py`、`tests/director/test_foundation.py`、`tests/fixtures/director/cases/f01.json`、`tests/fixtures/director/cases/f03.json`、`tests/fixtures/director/cases/f05.json`、`tests/fixtures/director/cases/f11.json`、`tests/fixtures/director/cases/f17.json`、`tests/fixtures/director/cases/f19.json`、`tests/fixtures/director/cases/f23.json`、`tests/fixtures/director/cases/f27.json`、`tests/fixtures/director/cases/f28.json`，以及本台账、scope和STATE。现有models/store/writing/API/UI只读，兼容v1；新增schema与纯函数由后续repository/route接入。没有模型/第三方付费调用，不改用户数据/运行栈/凭据，不提交推送。

步骤：①读权威语义/状态合同、现有Pydantic/测试并查diff；②定义严格类型和结构化错误，建立九类合成输入/预期；③实现纯确定性守卫与schema验证，不由模型自报完成；④正负fixture与类型/边界/不变性回归、已有director测试、ruff/guard/规格回归；⑤记录实现范围和未接入边界，交接下一WP。参数为camelCase wire aliases，版本不随显示标签改变，时长未知不计0，关闭/刷新不发新供应商任务。

现场：main e7b1fbce，与zhonggwv/main同步；现有两个Director工作线diff归属明确，18线382claims且无锁。拟改新路径git diff为空；本地origin/main与origin/fix/skill-save-and-workflow-retry在对应域/测试无同路径差异；未fetch/pull。新文件已查不存在，不覆盖首切片。领取唯一锁后按上列路径preflight；新增测试fixture逐文件认领，不扩展宽泛目录。

风险/回退：最主要风险是把输入schema合法等同语义或产品通过；分别返回验证错误/UNKNOWN，并保持未接入项not_implemented。新模块无import副作用、不修改运行数据，回退只撤本批独立文件。验证命令采用现有虚拟环境离线pytest与ruff、node verify-spec --self-test、git diff --check、agent_guard。uv默认缓存受沙箱限制时用现有.venv解释器，不改机器配置。

### 2026-09-25 · 全量方案收口 v2.1（仅文档与规格校验）

用户要求把上一轮明确指出的方案缺口做完。本轮完成定义：149动作/8能力/24方法/18规则/工作流每条转移/夹具全部建立唯一ID和需求→组件→领域用例→接口/本地命令→schema→测试→证据/差异的机器追踪；新增九类实测约束迁入五份权威合同；主指南和历史开发指南仅引用权威规则，不再各自定义；所有剩余源站N有明确产品决策、验收办法与阻断范围。未知不伪造为T，设计就绪不伪称软件已实现。

步骤：①完整复核五合同、最新补证、short-drama主技能/相关方法与当前代码落点；②固定方法来源相对路径/哈希与命令映射；③迁入sourceOrdinal、缺失补位、执行版本receipt、取消恢复、实际媒体偏差、accepted/UNKNOWN、分享allowlist、删除/撤回及OAuth约束；④补实施拆分/旧API迁移/精确命令表、机器矩阵和只读校验器；⑤校验所有ID完整、跨引用闭合、路径存在或明确planned、非法/缺行/假PASS变异样例能报错；⑥文档/安全/guard交接。

基线e7b1fbce/main与zhonggwv/main同步；当前首切片及研究文档未提交均保留。拟改文档git diff为空（已归属未跟踪），对本地origin/main及origin/fix/skill-save-and-workflow-retry无同路径变更；未fetch/pull。guard为18线378claims、无活动锁。新增四路径逐一认领后acquire/preflight；研究报告只读，开发和验收共享由本会话串行修改，研究台账仅追加交接，不改其历史事实。

非目标：不改业务代码/配置/三语/现有测试，不创建运行时Skill，不新发第三方请求/付费生成，不删除项目，不提交推送。风险是把规划路径当已实现、复制旧待测状态、为“收口”降低未知验收门；用不同状态字段及负向校验防止。回退只撤本轮规格增量，不覆盖既有diff。验证命令为node docs/guides/tv-director/verify-spec.mjs及--self-test、git diff --check、定向gitleaks、agent_guard check/handoff/release；业务pytest/build不适用于本轮。

### 2026-09-25 · 审核意见落实（本轮仅文档）

用户要求按审核建议修改。可验收目标：九项审核缺口在五份专项合同中各有唯一权威规则，137 个已编目按钮均映射到命令、持久状态、恢复与测试；消除旧文档的自动末集完成、读块即语义完整、音画简单求和及费用后置等冲突。明确非目标：本轮不写业务代码、不调整模型配置、不运行付费生成，不把文档完整冒充产品已等价。

步骤：① 对照 short-drama 原创/改编方法和现有研究编号；② 完成全功能矩阵、逐 Skill 合同、状态/费用合同、文档语义合同、量化验收合同；③ 主指南改为 v2 权威索引与实施依赖，旧开发指南只对冲突设计作替换/指向；④ 检查按钮 ID 唯一且齐全、链接存在、围栏/空白、敏感数据和 guard；⑤ 台账记结果并 handoff/release。缺 LibTV 实测的分支保留 N 和明确取证动作，不编造成功。

Git/冲突审计：当前 main 基线 e7b1fbce；两条 Director 线既有未提交内容保留。拟改文档为对应工作线已归属新增文件，STATE 原有增量逐行保留。已查本地 origin/main 和相关 skill 分支的路径差异；拟改路径无远端同类实现；未 fetch/pull。开发指南改成双方共享，实现线为本轮最终集成者，研究线不并行写。五份新合同为精确独占路径。

风险与回退：规格分拆可能产生重复权威或断链，主指南建立职责表并检验交叉引用；回退仅恢复本轮文档增量，不动已有业务实现、用户资料或研究观测。验证命令：文档 ID/链接/围栏断言、`git diff --check`、gitleaks 文档扫描、`python3 scripts/agent_guard.py check` 与 handoff/release；没有业务代码修改，不以未运行的 pytest/build 冒充验证。

历史v1文档方案（2026-09-25，已由上方v2续轮替代）：对照本地 `short-drama` Skill、LibTV 取证与当前代码建立初版融合指南，只写设计、不调用付费生成；当时两份研究文档只读。v2已将旧开发指南调整为双方共享以消除冲突，事实分析仍只读。原方案的按阶段/规则/模型/参数/测试追踪原则保留，完整细节以v2为准。

1. 定义 `Work/Preset/Source/EpisodeIdentity/DocumentVersion/ChangeSet/Event` 合同，SQLite 事务、预期版本与安全来源绑定；先用 EP02 编号/选区范围/刷新恢复测试证明行为。
2. 建立服务端原创/改编阶段编译器：从冻结输入和版本化方法包构建提示词，模型输出只落待审稿；硬约束与无法验证项明确展示；需人工定稿后才推进集数，不凭模型自述通过。
3. 新建导演工作台：画布式节点与 400×640 右浮窗、模式菜单、Top8 双栏设定器、输入附件/引用、会话历史、文档全屏编辑/差异接受。三语键及 `DESIGN.md` 与 CSS 同步，旧 story 页面不变。
4. 路由/API 集成后运行聚焦后端测试、前端测试/构建、i18n/ruff/guard；用 Playwright 在 1200×863 和 1920×1080 对照实测页面，真实文本模型一例需明确用户操作且留请求/结果摘要，不浪费供应商积分。
5. 按融合v2 P0–P8补全多集、Skill、导演/全能/媒体与界面；费用基础设施P1先于真实模型，不能沿用旧顺序到最后才加。每片以专项合同验收，不把首切片标作全量完成。

浏览器验收分叉：已有作品重新打开“剧本设定器”时，初版只修改前端临时草稿，不能保证界面参数等于模型入参。补充 `PATCH work` 的修订号 CAS：仅在没有正式文档、待审修改和成功/进行中的模型运行前允许改题材、时长、来源、集数等；失败调用保留审计但允许修复模型配置。一旦开始写作，原参数冻结，设定器只读。前端从服务端作品详情恢复所有设定与来源，不显示虚假的可保存状态。此修改仍在上述独占路径内。

真实模型试跑分叉：预览中的 `DC-content-rewriter-LLM` 请求收到上游 502，未产生待审稿。为使此配置可恢复而不偷偷换模型，给设定器增加显式文本模型名称；服务端以持久值作为唯一生成模型，与预览哈希绑定。旧作品缺此字段时使用原别名，界面明示实际值；上游 502 的本地环境原因待配置核实，不能宣称完整联机验收。

质量门补充：真实中文剧本标题可能用“第九集”而非“第9集”；若只认阿拉伯数字，来源 EP09 与正文第九集的错配会漏检。将中文数字标题识别加入同一服务端检查，并补聚焦测试；不扩展到正文全文猜集号，避免误读剧情文字。

V4-Flash 联机验收分叉（2026-09-25）：定位到此前的 502 是本机 HTTP 客户端继承代理环境对 loopback 请求的影响；显式 `NEWAPI_TEXT_TRUST_ENV=false` 后，经现有 3001 网关实际收到 `deepseek-ai/DeepSeek-V4-Flash` 的 200 响应，Director 生成一份待审大纲并经人工接受，刷新后版本 1 仍在。此结果不代表内容质量或完整 TV Director 验收：30 秒大纲过密且“单集完结”与续集伏笔矛盾。另发现本机网关强制使用其配置模型，作品手填模型可能只改预览、未改上游。此轮只在本线已认领的 `director/**`、`routes/director.py`、`frontend/features/director/**`、`frontend/api/director.ts`、三语键和 `tests/test_tv_director.py` 内：服务端识别本机网关并将固定模型写入预览合同，拒绝显式不一致；提供只公开模型 ID 的能力查询，前端显示真实模型且本机固定时禁改；为生成记录沉淀安全的请求参数与返回摘要（不落密钥/完整带个人信息正文），补一致性和刷新回归。被 local-stack 工作线独占的 `config.py`、`local_gateway.py`、启动脚本不改；本机忽略的启动环境可单独校正。随后以合成样例跑分集/审阅/定稿，失败如实记录。

## 风险与回退

- 本轮方法2.3.2离线回归揭示runtime Manifest仍是固定版本白名单；追加原有runtime.py精确边界，只纳入2.3.2，保持未知版本拒绝，不泛化为任意版本；全部测试通过再发真实模型。

- **风险**：新 API/SQLite 状态、长模型任务、自动生成路由和三语文件与既有工作线共享；模型可能输出质量不足。服务端事务/版本与质量状态禁止误定稿；浏览器对照只读，不改第三方作品。
- **回退**：新模块/路由可逐提交回退，先停止新入口；旧 story/freezone 不受影响。SQLite 新数据单独位于项目 state_dir/director，不删除用户数据。

## 验收标准

- [x] `uv run pytest tests/test_tv_director.py`：建作、来源绑定、EP02 编号、版本冲突、局部差异、审阅/恢复；中文集号补测后 16 passed。
- [x] `uv run ruff check src/novelvideo/director src/novelvideo/api/routes/director.py tests/test_tv_director.py`。
- [ ] `cd frontend && pnpm build && pnpm test`；构建通过，三语定向测试/检查通过；全量测试仍有未归属的既有失败项。
- [x] 浏览器 1200×863 / 1920×1080：浮窗、Top8、模式/设定、节点、编辑器与确认动作；网关 502 时不假装生成成功。
- [x] 本轮道具`agent_guard.py check`为29线949claims，handoff通过（41归属脏路径）；收尾release再次强制检查。最终ruff、双端i18n、diff、gitleaks增量/相关目录复验通过。两个浏览器会话及三个自建临时服务已关闭，3001/18780/15173无监听；临时preview已删、证据保留。

## 进展记录

### 2026-09-28 · 私有main拉取核对与推送交接

用户要求pull并push。开工核对本地主检出仅有受保护未跟踪`_to_delete/`和`曹操.md`，无已跟踪diff，guard31线1130claims、无活动锁。`git fetch zhonggwv main`所得远端`213854b5`是本地`0d7b609f`祖先，分叉2/0，因此没有待并入变更，也不在有受保护资料的工作区运行多余的pull/merge/stash/rebase。随后普通`git push zhonggwv HEAD:refs/heads/main`成功；只读`ls-remote`核验私有远端main=`0d7b609fce930c1fba19f54d50b13e9f695f1b7f`，与本地相同。公开origin/PR不动，无强推、无模型/媒体费用或部署。本条仅修正Git交接事实，不改变业务及前述质量欠项；受保护资料仍不提交。最终交接状态提交后再次核验远端SHA，以Git为准。


### 2026-09-28 · 首功能代码、技能包、测试与方案本地提交

做了什么：用户要求提交所有代码及方案。本轮先将研究线方案/规格独立保存为`0a1d4fac`，确认其没有改业务文件，再将本线现有 TV Director 大纲链、首次原创问卷、方法包、三语/UI、测试和实现进度显式暂存为第二笔本地提交；不包含`_to_delete/`、`曹操.md`、Cookie、运行数据或原始付费回包。不推送、不重启或更改用户项目。新的Git基线仅研究文档变动，已在claim和方案同步，148条精确业务/测试/文档路径preflight通过。

本轮验证：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q --tb=short` **808 passed**（18条既有依赖弃用警告）；6份前端定向测试 **77 passed**；`pnpm build`通过（既有>500kB chunk告警）；定向ruff、前后端i18n、guard、`git diff --check`及Director源码/界面gitleaks通过。`npx --offline @google/design.md lint DESIGN.md`因包不在本机缓存、联网受限未执行成功，不能写成通过。研究线规格检查因后续代码变化报告plan-closure源码hash/行号及测试定义过期，保留FAIL，不能只刷新hash或冒称产品通过。未重复调用Seed/LibTV模型，也未复测实际浏览器。

下一步可直接执行：先用当前提交的代码逐项重审`plan-closure.json`与`implementation-map.json`中过期映射，核实符号/行为/测试定义后复跑`verify-spec.mjs --self-test --local-evidence`；再按本台账S1清单在隔离项目做原创三页问卷浏览器自定义值/刷新与同视口原站对比（登录态若失效先恢复），补五节改编旧快照、常规入口、全页像素及文学反例。不进入第二功能、不把808/77格式回归当文学质量或完整TV Director验收。


### 2026-09-28 · 首次原创三页问卷及 Seed 冻结输入收口

做了什么：原站已存原始`ask_human`证据是方向、集数、单集时长三题，同一工具调用内逐页作答后才提交。当前原创M03建议问题不再冒充必答页，原回包仍不可变留存；宿主在checkpoint显示三页，用户确认或自填的两项在同一`planning.decide`事务写入作品preset、集身份与workflow root。后续M07编译显式收到确认preset。自动衔接quote→grant沿用服务端返回的最新workRevision，避免改数值后卡在版本冲突。旧实测脚本同步提交真实必填字段。没有移除服务端有界报价、幂等和未知结果保护，只去掉个人自用模式的二次费用点击。

真实Seed与修因：第一笔隔离实验在工具沙箱内无法连本机网关，0.5秒UNKNOWN，未重放。授权连通检查确认网关可达后另建隔离作品；M03/M07/M08分别成功一笔，M09因closed单集生成非空续集钩子而被宿主正确拒绝。方法包原已要求`hook=null`，但M09缺解码约束；仅将closed单集的M09冻结输出schema收窄为JSON null并启用Seed已验证的结构化格式，通用host validator不放宽。显式恢复只重报/执行M09一笔，回包`hook=null`且成功，最终phase=`WAIT_OUTLINE`、四阶段artifact齐全；M03/M07/M08未重买。完整请求、原始失败及成功回包保留在本机忽略的`output/playwright/director-questionnaire-20260928-connected/`，台账不复制正文或凭据，费用金额未知。未对原站用户项目做新收费提交：仓库保存的网页登录态本轮显示登录弹窗，在线像素比较未复验。

验证：`pytest tests/director tests/test_tv_director.py` 808 passed；前端相关两文件51 passed；`pnpm build`通过、定向ruff/前后i18n/`git diff --check`/agent guard通过。本地栈受控重启，API 8781、前端5173、网关3001健康。`npx @google/design.md lint DESIGN.md`因npm镜像DNS不可达未验证，不写作通过。新三页有组件交互测试和真实服务端问答/冻结回包，尚缺当前原站同视口截图与本地真实浏览器逐页像素复验；自定义3集45秒有服务端事务/提示词和前端测试，未为其另买四阶段模型调用。下一步先在本地浏览器建立隔离作品走方向→改集数→改时长→提交并截图/刷新，核对原站登录恢复后的同状态视觉与按钮；再清S1旧快照/closure，不开启第二功能。

### 2026-09-28 · 首次发送自动启动与方向流式显示闭环

做了什么：按用户明确的个人自用授权，首轮“发送”和后续问卷提交由同一次动作自动完成服务端有界报价与当前阶段授权，不再让用户勾选费用确认；刷新、重开和不确定结果均不会自动重派发。M03开启结构化流，只投影四方向与追问中的可读字段；原始JSON、ID和未校验内容不冒充正式结果。修正旧“重新预览授权”错误文案，界面区分方向流和大纲流。首次Seed回包缺第4方向的`obstacle`，虽然请求含strict schema仍被宿主拒绝并保留；没有补造字段。用户明确点击一次“继续”后，带原失败上下文的单次修正调用成功，先前失败记录未覆盖。

怎么验证：后端`tests/director` 780 passed，前端两份定向测试50 passed，`pnpm build`、定向ruff、前端i18n、`git diff --check`和agent guard均通过。重启原本地栈后，在隔离测试项目用真实Seed观察到修正调用`model.started.stream=true`、154条临时预览覆盖方向/问题、最终4方向和6追问；随后新建作品，从“新对话→填曹操创意→发送”一个操作直接产生1笔成功调用和300条预览，生成中浏览器确见“方向1·梗概/目标/阻力…”逐项出现，结束后出现4个方向，无费用确认卡或第二阶段自动调用；刷新仍是同一方向关口，操作数保持1。模型回包和请求仍在本机忽略的SQLite，台账仅记状态与计数，不写正文/凭据。浏览器控制台3条错误为账户头像404及更新视频CDN连接关闭，与这条流程无关。

边界与下一步：这次只证明首次原创方向的发送、Seed结构化流、失败保留/一次显式修正和方向问卷可用；不是完整TV Director或文学/像素同等验收。原站已取证的原创问卷约3页（方向、集数、时长），本地这次为方向加6个模型追问共7页；差异仍需在下一轮逐题对照，不因本轮成功擅自删题或把固定参数问卷改成模型猜测。旧失败继续保留，用户原项目不自动重派发，刷新后可主动点击“继续当前阶段”。

### 2026-09-28 · 末轮真实 Seed 审稿通过并采纳、双站刷新核对

做了什么：显式失败反馈最终用同一候选完成48/48段核对，0 violated/uncertain；人工发现的重复段落已经定向改正，不以格式成功代替文学检查。浏览器接受最终6处/5组，正式v4、待审0，刷新后先前手編及新修改均保留。原站独立研究作品采纳剩余三节，刷新重开五节、0差异，顺叙和禁闪前结果保留。大纲/分集流标签分开；审阅阻断显示原句/原因/证据；五类导航切换不误呈现旧稿，也不隐式采纳或撤回。

怎么验证：最终803后端、116前端/11文件、build通过；末轮build曾发现3处测试参数类型错误，修复后重跑通过。ruff、前端i18n0、后端i18n474未增、CE11端口、diff、业务/测试/agent目录gitleaks通过。真实实验共29次Seed（16阶段成功/13失败），请求、完整回包、用量、流、截图与final-acceptance.json均保存在忽略的实验目录；费用金额未知。两站最终1920截图人工查看，不能按不同内容声明像素一致。

边界与下一步：第一功能核心短概要链通过，S1整体仍未验收；源码未部署，旧v2不静默迁移。下一会话先读`outline-delivery-progress.md`，再用最终原站截图核对五节编译的概要字段顺序/列表/多余H1与审阅格式工具栏，补同内容状态快照；之后逐条重审24份基线及closure定位，再验常规入口及旧稿显式转换，最后才考虑第二功能。不能重复购买已通过的同一候选审稿，不覆盖v4或旧失败证据。

收工清理：本轮新增的两份临时前端bootstrap已删除（非产品路由）；隔离API、验收Vite和本轮模型网关均正常停止，没有运行中模型请求。实验SQLite/完整回包/截图保留在忽略目录，可据harness恢复；未停止或变更原用户栈。正式源码/测试/文档仍未提交，未清理任何既有dirty或研究线内容。随后执行guard handoff/release，不将未全项验收任务归档。

### 2026-09-28 · 首功能接通真实来源、模型、分组审阅与保存恢复

做了什么：按本节方案接M04/M05/M03/M07/M12、宿主来源区间/主张/版本、五节候选、显式重校/重修、M14最小patch与依赖组、组合审查报告及原子采纳/撤回、真实正文流和保留断流前缀。手编后的局改只读当前AST，去掉重复快照的模型视图，完整宿主参数仍存储；两张加法表不改旧稿。沿short-drama方法包完善来源保真、最小改动、叙事/评论区分和严格wire字段，原始参考不变。M12模型线1.2短编号可逆，绑定全部48段，独立审查不重复读取作者图作为事实权威。

为什么：真实Seed曾截断、新增字段、漏审评论、把时间先后写成因果、把新听觉行为当润色；代码/方法分别修其原因，原错误回包保留，格式或引文ID存在不充当语义通过。M12的interpretation不能用于叙事；旧validator报告不再授权新采纳。没有用删字段/裁正文/补标点/静默重试制造PASS。代码默认保留旧入口行为，隔离DIRECTOR_OUTLINE_V3=1验证新链，不部署用户常驻项目。

怎么验证：当前802后端/18依赖警告、113前端/11文件、build通过；ruff/i18n/CE11端口/导入/禁词/包名/diff与目录gitleaks通过。DESIGN lint0错误20警告。真实Seed初稿经修订和独立核对后人工采纳v1，局改第二批部分接受v2/撤回余组，手编自动保存v3且刷新保持；后续单处M14只加指定两字，1hunk、4个真实正文preview事件，输入仍含手编最新值。LibTV1920同状态复核五节、部分决定持久化、44px高14px圆角悬停按钮；本地正文680px/x620、全局栏y64/h44、悬停h44实测一致。详情与末轮审稿结论见`outline-delivery-progress.md`最新增量。

未通过项：正文标题/项目符号/顺序、完整目录/工具栏与全状态像素未齐；长稿分块、多样本文学、物理Windows未跑；新链未成为常规默认。verify-spec正确报告24旧源码快照及closure行号过期，本轮不修改研究线旧closure、不批量刷新hash伪造规格通过。没有进入第二功能；没有提交、push或媒体生成。旧diff、源稿、Cookie、研究线内容保留。最终模型回包导出、临时入口/服务清理、guard交接在下方补记。

### 2026-09-28 · 首功能内部 B00/B01：五节合同与展示基础通过

做了什么：新增严格 adaptation-outline/3.0.0、宿主DeliveryContext、动态ID schema、确定性校验、安全三语投影和绑定AST/source/context/spec的五节段落索引；原outline入口仅增加显式宿主合同分派。旧v2及已有单字退化门保留，原始模型回包/用户稿没有改动。新增匿名fixture、与实际Python编译逐字绑定的三语golden、74项后端回归和4项现有富文本组件验证。没有修改short-drama方法包或其来源；本块只落实内部技法与五节交付分层，不冒充技能或文学验收。

为什么：11节内部规划不能仅换五个标题；集数/时长/授权不能交给模型自报。模型提案与真实授权分离，非人格化阻力允许N/A；索引保护宿主块，逐段覆盖与hash防止后续局改错位。状态不固化进正文，避免将候选提示保存为永久“未接受”。来源ID存在不证明语义支持，专门保留倒序反例结构可过、无质量PASS字段的测试。

怎么验证：首次5失败/9通过→14通过；扩展67项抓到删空段落索引仍放行，补完整覆盖后修复。最终 `.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q --tb=short` **745 passed/18既有警告**；`pnpm exec vitest run src/__tests__/director` **10文件108 passed**；`pnpm build`通过（首次新测试API的exact属性TS错误已修，现有大chunk警告保留）。全仓ruff、双端i18n、CE11端口/import、禁词/包名、diff-check通过。12个本轮源码/测试/fixture/文档/台账精确文件gitleaks红化扫描均无泄露。guard最终31线1121claims；最初重复声明已有目录内源码claim被拒绝，已在acquire前修正，未绕过锁。

规格检查先正确报告outline旧指纹过期；本线只重审分派和新增文件，在共享implementation-map保留前一hash与独立增量报告，旧157项产品状态不变。`verify-spec.mjs --self-test --local-evidence`再次通过，52负例及24来源归档hash有效；不是S1产品通过。详情见 `docs/guides/tv-director/outline-delivery-progress.md`。所有新旧diff已归属；未动未知资料或研究线独占文件。

边界：B00仅本块反例已建，完整patch/组合核对反例随后续批次补；B01确定性基础通过。生成器仍选择v2，未接B02真实来源/独立核对或B03新合同，不宣称页面生成已变五节；jsdom并非像素、没有真实模型/LibTV/媒体调用、没有迁移/部署/重启/提交推送。按用户逐块要求不进入人物场景道具分集；下一步仍在第一个大纲功能内做B02来源核对，取得新路径preflight后实施，再接Seed链验收。不把实现欠项当外部阻塞；收尾执行本owner handoff/release。

### 2026-09-27 · 方案r2当前源码审计与源站续创补证交接

discovery唯一持锁完成157项当前代码/来源/支持测试定义绑定（plan-closure.json，22审计组/24来源归档），原not_implemented不冒充零实现；全部测试仍not_run。S1/S2的16流程、五类35格、24视觉状态明确路径与断言；52个规格反向测试通过，不是产品通过。源站新增203HTTP/312WS/21UI，32证据断言通过，历史29/32/62再次校验。

重要纠错：顶部E08全能创作不是attach-only，而是新omni会话自动发送续创，读取五类文档并规划/创建preview，再请媒体批准。15图片预览合计225积分已取消，未批准生成；源站错误音视频工具调用保留负例。工作流§1.2与machine command同时更新；原openMedia接线需改。刷新CL16切回关联会话但输入为空，不应声称chip恢复。旧100集永久上限及M01/M02全链误触发已经从共享方案清除；业务代码/现有失败未动。

接手唯一动作：按Seed细案B00及S1十条先做可执行失败用例，再B01–B08；当前源码/测试hash由verify-spec检查，变化时只审影响组。后续S6才实现新续创链；不得在S1擅自扩为媒体。九份共享合同由研究线释放锁后本线串行集成。全产品文学、像素、跨设备/安全发布门仍需真实业务验证，不重做本轮研究、不重新发明整体方案；本轮无代码提交/推送/部署。

### 2026-09-27 · 审核r1文档协调交接（discovery串行修订）

用户批准六项审核建议，研究线持唯一锁修订总案与七份共享设计/索引/校验文件，新增acceptance-policy.json作为唯一验收配置。S1必须通过十条改编大纲闭环用例，S2六条原创独立用例；四模式目标判定、独立文档版本/35格生命周期、Seed阶段与完整质量分层已落地到合同。WT06/WT08限制实际交付范围，不将方向确认当成全筹备调用批准；机器表同步。新157项执行追踪采用当前HEAD+dirty指纹，原P阶段/历史结果不删，待审计状态不冒充未实现或已通过。

本轮不改本线业务、测试或技能包、不部署/付费/提交推送。规格检查40负例通过、14文件gitleaks/文档检查通过；不是产品测试。下一步按总案§12及验收§10绑定S0/S1真实case与B00反例，再做短稿完整闭环，S5仅扩展跨文档，不后置部分采纳和保存恢复。原文学/像素/第二设备失败仍保留。共享文件在研究线释放后才写，不并行覆盖。

### 2026-09-27 · Seed 大纲对齐代码级实施方案交付（仅文档）

做了什么：新增 `docs/guides/tv-director/seed-outline-parity-implementation.md`，18 节、B00–B11 共 12 个实施工作包、T01–T33 共 33 条验收用例、V01–V10 共 10 个页面状态。按当前代码列出旧接点和拟改路径，包含来源主张/歧义决策、五节 Pydantic 合同、short-drama 条件融合、同一编译器、局部 AST patch、SQL 增量表、CAS/幂等/部分接受、候选付费审查、真实流式聊天、自动保存、长文任务、旧稿迁移和下游最新 AST 消费的关键代码块。新增方法是应用内适配设计，不冒称取得 LibTV 私有 Skill。

为什么这样改：最新同 Seed 对照的主要缺口是内部规划外露、全文重写及组合后漏审，不是继续增加模型横测。源码复核进一步补齐两个边界：pending 中只允许绑定当前候选的只读审查，不能被现有全局 pending 门锁死；纯拒绝建议无需新语义报告、不得新增模型费用或正文版本。来源缺段是摄取失败，不让用户通过问卷回答掩盖未读完。

怎么验证：对新指南执行只读结构检查，1252 行、25 个代码块围栏闭合，13 个 Python 块 ast.parse、2 个 JSON 块 json.loads、1 个 SQL 块内存 SQLite 建表及 4 个 TS/TSX 块 TypeScript transpileModule 语法检查通过；4 个相对文档链接有效，R/B/T/V 编号完整唯一，尾随空白与本机路径/凭据特征检查无错误。`gitleaks stdin --redact --no-banner` 扫描新指南 no leaks found；`git diff --check`、`python3 scripts/agent_guard.py check` 为 OK（31 workstreams/1105 claims）。代码块仅语法核验，辅助函数尚未实现，不是业务测试通过。

范围与交接：本轮只写新指南、台账、claim、STATE；既有业务/测试/设计脏改动及两份未跟踪用户资料保留。不调用模型、不使用浏览器、不修改全局技能、不部署、不提交或推送；历史 671 后端/104 前端/build 与文学/全页像素失败仍为原轮证据。当前方案交付完成，整条 TV Director 工作线未完成、不归档。下一步确认新增 API/持久结构与保存语义后，按指南 §18.2 从 B00 匿名反例冻结进入 B01/B02，不重新采购已有失败实验；收尾按本轮 owner handoff/release。

### 2026-09-27 · Agent Plan 接入与仅Seed的《入画》同源对照

- 遵循用户最新路线，停止新增DeepSeek，保留历史21笔证据。新同源轮人工649字符概要；相同brief/自填讲法/单集600秒三幕闭合，两边从方向到大纲；最后215字符修改实际出站逐字一致，同秒提交。本地实际6笔均Seed，138838输入/27964输出tokens；原站5个用户提交含2次无效富文本操作，不藏失败或宣称免费。详情见`docs/guides/tv-director/agent-plan-outline.md`§9，原参数/回包/截图仅忽略output。
- 本轮累积实现真实目录模型选择、Ark预算参数冲突修复、后台自动预算与无token创作UI、严格decoder/宿主双校验、安全失败回执、M03→改编大纲单独采纳、来源权威去污染、正文排版窄修。最新M03 2.3.1、M07 2.3.2均保留short-drama原始参考，新增来源约束和正文/修改说明分离，不改全局技能和进化库。
- 打磨前预检暴露prompt中schema与审计元数据重复。context/2.1.0仅精简提示词重复项，完整source/现稿/selected方法及wire严格schema不删；本地真实编辑成功，旧60k门未放宽。未实现通用长篇分块，不将此修复称为无限长度支持。
- 最新M03成功后M07初稿/两轮修改均结构通过，文学与事实仍FAIL：本地最后残留第二钩子、引诱/生路和人名缩写；原站patch11处后仍有另一段归来/叩画倒序。原站实际五节/逐节diff，本地仍11节/全文重写，明确未对齐。浏览器1440×900截图已看；正文不同不计算虚假像素通过。既有同文首屏0.0933%/整页1.3748%仍整页FAIL。
- 刷新复核：本地仅outline v1、同一个待审提案恢复，operation仍6笔；原站重新开编辑器恢复5节diff、用户提交数仍5。未采纳问题改稿、未定稿/续集/媒体购买。第5笔本地提案已显式忽略但原响应保留，第6笔保持待审。原站“已保存/无违规”不代替人工内容验收。
- 验证：最新全Director671 passed/18依赖warning；前端9文件104 passed、pnpm build通过；全仓ruff、双端i18n、diff、guard31线1104claims、skill quick_validate通过。升2.3.2时曾被runtime版本白名单拒绝，未收费即修复并重跑全671通过，不隐藏中间失败。后续六项根因改造按指南§9.6另过方案门，不在当前记录冒充已实现。
- 当前main仍213854b5；本轮尚未提交/push/部署。用户常驻栈未动，主目录验证全部隔离。收尾已确认无在途模型调用、关闭两隔离浏览器及本任务API/Vite，18780/15173无监听；删除仅本轮临时preview HTML，未删付费证据/数据库/用户资料。最新已跟踪及新增候选分别gitleaks通过，diff/guard通过。下一动作是指南§9.6的五节改编交付合同与段落patch方案，不再重复双模型横测；随后执行handoff/release。

### 2026-09-27 · 主目录同步前保存既有推送交接

用户已确认将最新同步分支也合回当前main。这里只提交本线前次保留的推送记录/claim与STATE中本线段落，避免在脏工作树merge时覆盖；同步线既有两文件和STATE历史同步段由其单独落提交。业务代码和方法包不改，已有失败保留。本线暂存文件的密钥/guard/禁词检查后生成DCO检查点，再交给同步线合并；不stash、reset或丢弃文档，不携带本机运行态。

### 2026-09-27 · 私有main推送完成

按用户后续push授权，先用 `git ls-remote --heads zhonggwv main codex/sync-main-remotes` 与仓库可见性检查确认私有目标；main为f057a867，同步分支已有4c9dee4f但本轮不更新。执行正常 `git push zhonggwv b5883b8fb0d3037bfdbe81b66de021b1a126a528:refs/heads/main` 成功，远端从f057a867快进到b5883b8f。再次ls-remote与本地HEAD、tracking ref三者SHA完全一致；50个待推送提交均已发布到私有main。未强推、未推公开origin、未修改其他分支、未部署或收费测试；上轮代码验证结果不变。STATE/本台账/claim只在本地记录本次推送，不创建额外提交，同步线旧改动与受保护资料保持不动。功能/文学/全页像素欠项不因推送变成已验收；收尾执行guard及handoff/release。

### 2026-09-27 · 提交检查点

用户要求提交代码。本轮将人物/场景/道具/分集、流式打磨、自动保存、批量图片节点、来源证据与M12全文审计作为同工作线连续实现一并提交，并包含三语、设计规范、测试与验收指南；不带用户素材、运行态、Cookie、供应商配置或付费原回包。同步线文档和STATE中同步事实保留未暂存。代码沿上轮已通过620后端/225前端/build的同一内容，本轮仍复跑离线测试及暂存检查，不新增模型费用。实际提交号以Git记录为准；没有推送或部署授权。完整产品与全页像素尚未全过的状态保持不变。

本轮复验结果：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q` 620通过（11条依赖弃用警告）；前端 `pnpm exec vitest run director` 17文件225通过，`pnpm build` 成功（既有大chunk警告）。`.venv/bin/ruff check .`、双端i18n棘轮、CE端口闭合11项、CE导入/禁词/禁用包名与diff检查全部通过。对91个精确候选路径执行 `pre-commit run --files …`，密钥扫描、agent guard与禁用词检查通过；STATE仅暂存本线3处，未暂存同步线内容。只复验离线代码，无新模型费用；提交后核验DCO、路径和剩余改动并交接释放锁。

### 2026-09-27 · 批量节点、全文事实与全页像素实测

- 批量图片从正式人物/场景/道具H2顺序自动形成可编辑计划，原子保存批次/意图/节点；批准集冻结、按源顺序逐项精确提交既有队列，取消只停未提交、UNKNOWN不重买。画布350px宽且比例跟随实际参数，结果持久恢复，坐标CAS与缩放换算、连续拖回原位回归，适配全部节点。没有复制旧freezone业务或自动发真实图片任务。
- M12保留short-drama两参考，方法包2.2.0与固定指纹，新增SKILL.md；宿主全文factUnits覆盖当前稿/完整来源/锁定要求/确认设计/全部前集。原子事实、before/after、现实/画中/台词、逐字引证与偏移、独立比较及人工逐段核对；矛盾阻断，漏段/假引文不可定稿，修改旧前集也使审查失效。事实合同最终1.1.1，收紧含事件集标题不能当纯编号跳过；同段两句非重叠矛盾允许取证，不接受重复自引。覆盖不等于语义无遗漏，60,000字符上限内不截断，长篇分块仍未实现。
- 真实派发四次：首笔UNKNOWN不重试；首次网关正例暴露OTHER_EPISODE互斥误拒并修复；新版V4-Flash正例REVIEWED9/9，负例FAIL6/9且含手机位置/文件夹/纸状态问题，三段引证未过也未放行。供应商三笔有usage合计16942输入/46076输出，金额unknown，8192输出请求非账单封顶。无自动采纳/定稿。1.1.1复用原回包零费用重验仍正9/9、负FAIL6/9，原回执不改。临时CE网关设置隔离，不改用户settings.db。
- 浏览器真API/SQLite合成队列：三项只选第一/第三，恰两笔任务，保留三节点/两图；75.46%缩放拖动保存到版本2，刷新位置和任务数不变。实际逐项请求/结果已存忽略output的director-batch-browser-receipt.json；不能称真实图片画质已验收。
- 全页像素工具已运行而非只量局部：不遮罩、不缩放、不自动对齐，差异超1%或尺寸不同即失败。1920设定器5.4324%；1200/390原站fullPage越界宽度不同，判尺寸失败。按实测修64px输入区、欢迎/按钮/通知间距、网点、小地图/缩放被浮窗遮挡；聊天区域16.9012%→2.3273%，最终全页14.6060%仍FAIL。账户壳/内容/动态球体/未接功能差异不造假；不能按局部百分比宣称完成率。三宽最终缩放可点、无本地横向溢出。
- 验证：620后端、17文件225前端、build通过；最后标题规则另跑41后端通过。全仓ruff、双端i18n、CE11端口/import、禁词/包名/diff通过；M12 skill quick_validate通过；DESIGN缓存同包CLI 0error/20既有对比度与未引用token warning；gitleaks前后端/测试/台账/指南/本轮模型证据未发现密钥。未跑全仓测试/物理Windows/真实图片供应商，整页像素门明确未过。
- 詳细合同、模型每笔原始状态、像素失败图与下一步见batch-facts-pixels.md；旧四轮diff、同步线台账和受保护资料保留，未提交/push/部署。工作线仍执行中，不把本轮功能链完成等同完整产品/文学/像素完成。
- 收尾：1.1.1最终全Director后端再次620通过，批量浏览器请求回执密钥扫描通过。已关闭本轮两浏览器及隔离API/Vite/网关，18780/15173/29419均无监听；删除本轮临时preview HTML，保留可复建的preview_execution工具、隔离数据库、截图与全部模型回包。未停止用户其他服务，未删除用户资料。guard29线966claims，执行handoff/release。

### 2026-09-27 · 自动保存、编辑聊天、媒体入口与有限来源事实门

- 原站实点纠正：场景图入口会进入全能创作、读3份文本、建6个图片待生成节点，再询问90积分。本轮取消图片确认；产生测试对话和占位节点，未改原文字，不能称全程只读或保证文本规划免费。单素材面板不能冒充源站批量Agent等价。
- 自动保存复用既有document.commitManual，返回事务workRevision；空闲1秒、串行后续编辑、IME/只读保护、断网保留/丢响应原命令恢复、409不重基。编辑器关闭/栏目/选区与聊天栏目/打磨/历史/新对话共用flush屏障；顶部状态/更多菜单、移除聊天56px偏移。冲突可下载本地副本，明确确认后GET服务器稿，不覆盖远端，不丢未知请求。
- 三媒体菜单接真实目录与既有图片任务服务，新增隔离媒体意图表。正文H2顺序选材、旧关系/世界规则不当角色，参数/版本/目录指纹冻结、未知金额明确确认、同ID原子领取，丢响应不自动重购；历史图片可按持久job恢复。当前仅单素材图，不是全能批量规划/画布节点/多参考图。
- 保留short-drama，应用M08升2.4.2及pin，编译器2.6.0；独立人物/场景请求附sourceProofs和未知态，高风险字段原句/主体/类型核验，拒绝结果保留原回包且不造可采纳变更。UI回包窗展示失败字段；不覆盖筹备M08或M11全文。场景别名误拦与同一场所重复分开处理，不默默合并室内外。
- 真实V4-Flash共4笔，无自动重试/采纳：人物对照关键事实门通过；首轮两例及场景对照失败均保留。总回报38277输入/12145输出tokens，费用unknown。场景对照原回包经零费用重验仍同一会议室重复和第二项类型引证缺失；不降门槛凑成功。详见interaction-closure §7。
- 浏览器真实API/SQLite合成队列：编辑立刻新对话/切聊天栏目，再重开仍保留；1920/1200/390聊天400×640（窄屏374）与全屏编辑并存。第三素材16:9/1K/high/seed42实收，未确认不能生成；结果显示、刷新恢复、队列仅1笔。测试未调用实际图片供应商。最终截图区别于早期测试服务重启造成的旧404/包指纹错误截图。
- 验证：Director后端598通过，全部Director前端15文件219通过，本轮相关6文件91通过，build通过。全仓ruff、双端i18n、CE11端口/import、禁词/包名、diff通过；包quick_validate通过；DESIGN0error/20既有warning，npx网络失败后用同包缓存CLI复验。gitleaks红化扫描前后端Director无泄露。未跑全仓测试/Windows/全页像素差异、实际图片供应商。本轮未提交/push/部署，保留已有四轮diff和同步线资料。
- 交付范围与明确未完成项集中到interaction-closure，不把局部通过等同整套目标。收工停止本轮自建临时服务/浏览器，删临时preview入口但保留测试输出，执行guard handoff/release。
- 收尾实况：219项前端与build最终重跑通过；新增合成图片请求/回执及场景零费用重验JSON留在忽略output。临时preview已删除，测试服务均正常停止，3001/18780/15173无监听；本地验收浏览器已关闭，原站研究会话已不在运行。guard为29线959claims，handoff通过72归属脏路径；随后release再次校验。不删除隔离数据库或付费回包。

### 2026-09-27 · 分集要素、编辑器共存与真实模型增量

- 原站只读确认集头七项、梗概/正文、场次/人物/△动作/说话人/表演/对白结构和右侧聊天共存；M11升2.2.0，六份short-drama参考保留，新增包内SKILL和交付结构/局部改稿边界，manifest/provenance/pinned同步，编译器2.5.0。不是恢复私有Skill或完整M10。
- `run_stream`供应商正文增量→持久事件→既有events游标GET；真实方法加载/所选参考/模型开始可见，跨chunk think标签不展示；重连退避、分页去重、切作品取消旧读取、读者上滑不强拉到底。增量不写正式稿/候选；停止、断线、截断和晚到结果沿明确状态处理，不自动重发收费请求。
- UI增加用户请求/方法/模型/正文/状态时间序列、继续打磨预填、运行中停止按钮、分集到场次目录、编辑器与浮窗共存；审批层仍在上方。修正内部分隔线误判YAML导致源码模式、对白软换行、浮窗遮挡安全栏、运行变只读后本地未保存保护。1920正文x620/y178/680px、15/28.0005与原站一致；三宽1920/1200/390无横向溢出。为本地安全栏让出56px，不报整个浮窗像素等价。
- 三次真实DeepSeek-V4-Flash，每例一次8192输出请求上限，无自动采纳/重试。首集和续集七项结构齐全但新增道具、手持变桌面等事实漂移；局部改稿只替换指定一句，全文其他文字/空行/标点逐字一致，旧稿结构缺项提示保留。原始请求/返回/事件/SQLite在忽略output。首例SDK把累计usage逐chunk相加，旧回执标无效保留；改用continuous_usage_stats，重复累计usage的HTTP模拟回归通过；后两例分别14611/679与20585/127 tokens，费用unknown，不用坏回执合计或猜账单。最终线上参数同时显式给两个兼容输出上限。
- 浏览器真实API/SQLite＋模拟供应商：输入/审批/部分正文时正式v1→待审→查看→接受v2→继续打磨不发请求；再流中停止无候选；模拟断流刷新恢复，运行数仍3、正式v2、待审0。不把模拟UI调用当文学验收。
- 验证：`pytest tests/director tests/test_tv_director.py -q`569通过；四个定向Director Vitest77通过；`pnpm build`通过（原有chunk警告）。全仓ruff、双端i18n、CE11端口/import、禁词/包名、diff和gitleaks通过；DESIGN lint0error/20既有warning。初次端口检查误用系统Python无novelvideo，已用.venv重跑通过。未跑全仓pytest/全仓前端/Windows；没追加第四笔付费。
- 保留人物/场景/道具旧diff及同步线资料，未提交/push/部署。详细边界、原始模型反例、复跑和截图在episode-parity.md；整套目标和事实质量门继续执行中，不归档。本轮临时服务和浏览器收尾关闭，凭据未打印或入仓。

### 2026-09-26 · 道具五项/M08方法/M11消费与三笔真实样本

- 原站只读核对道具清单、物名及类型/戏剧作用/使用边界/首次出场/关键集次五项和编辑器几何。未改源站、未调用源站生成。新增PropDocument及三语安全投影，筹备M08和单文档共用；历史描述保守兼容、空清单须说明，集次/重复键/ID校验拒绝坏格式，原回包先留存、不自动重购。
- short-drama四份方法保留并融入应用内prop-craft，M08 2.4.0按documentKind路由；人物场景方法未丢弃，筹备加载三类。最终包eeb6cd535f2dc40644190d7510fd855cb536cf28965018f1284ec12b1c43d5a8与三笔真实请求一致。单道具读取正式人物/场景，M11读取正式道具并绑定版本/hash；改道具使旧授权发送前失效，不发生模型调用。
- DeepSeek-V4-Flash真实三笔：单集90秒交接、双集180秒双手机、改编120秒/source EP02；各一次8192输出上限，无自动重试、未采纳。合计24,546输入/3,549输出token，金额unknown。结构全过；交接把放桌上写成归还、改编擅自补锁盒归属并混淆画/信递送目标，双手机另列数字视频导致粒度不同，不能称文学质量等价。输入、完整参数/系统方法、原始回包/usage/SQLite及人工判据在忽略output/playwright/director-prop-live-20260926/，未继续盲买。
- 原站/本地1920正文x620/y178/宽680、15/28及标题/列表间距实测相同，粗体字宽约0.3px差异；1200/390本地无横溢。实点目录定位、未保存切换取消、保存v2/刷新、带版本引用、报价取消/再确认、一次模拟生成待审、富文本草稿、显式全部接受、刷新v3及待审数0。执行卡显示三语道具设计而非props，原始参数不变。本方仍显式保存/模态编辑、媒体未接，不能称全页逐像素或全部操作相同。
- 最终验证：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q` 555通过（31项新增道具）；三个Director Vitest文件71通过；`pnpm build`含类型检查通过、既有chunk警告。全仓ruff、双端i18n、CE11端口/import、禁词/包名、skill quick_validate、gitleaks、diff/guard通过，DESIGN lint0错误/20既有警告。初次道具回归抓到props误入分集门，4项失败已修后全量通过，未带错发真实请求。未跑全仓前端、全仓pytest或Windows，不以局部数替代。
- 本轮不提交/push/部署、不重启用户常驻栈，人物场景既有diff及同步线/用户资料保留。收尾只关闭本轮临时模型中转/隔离API/Vite/两浏览器会话，删除临时preview HTML；保留合成SQLite、截图与全部模型证据。全Director继续执行中，质量门与完整UI未完成项不归档。最新范围、复跑及差异以prop-parity.md为准。

### 2026-09-26 · 场景五项/M08路由/M11消费与五笔实测

- 只读核对LibTV六场景、编辑器和目录：清单/场景名/类型/戏剧作用/空间限制/动作位置/关键集次。未改源站、未发生源站生成；short-drama四份静态方法和skill-creator用于应用内M08，原人物工作完整保留。详见scene-parity.md。
- 新SceneDocument/安全三语投影/集次校验同时接筹备M08与单文档场景；旧描述兼容、不强制重写，不串人物道具；M11读取保存场景并绑定版本/hash，旧授权遇场景变更在发送前失效。场景参数JSON实际进入请求，不再显示[object Object]；客户端嵌套参数类型已修正。
- 三例暴露过度补写/电视场景未单列后，M08升2.3.1、documentKind按需加载character-craft或scene-craft，筹备加载两者，人物合同保持2.2.0。技能反例与来源/指纹同时维护，原五筆回包完整保留不覆盖；最终包99da154d，后两笔即在此包下运行。不是获得原站私有Skill，也不是可靠事实门。
- 五笔均DeepSeek-V4-Flash，40,890输入/4,147输出token，金额unknown，一次/8192输出上限、无自动重试、均未采纳定稿。前3笔2.3.0，后2笔同默剧/改编2.3.1：车厢单列改善，但仍类型unknown/新增入场动作；职场唯一门等反例未冲销。字段成功不等于严格事实通过，停止继续购买。完整参数/回包/SQLite在忽略output/playwright/director-scene-live-20260926/。
- 原站/本地1920正文同x620/y178/宽680，15/28字号行距、23.25/19.5标题一致；截图人工检查。1200/390无横溢，场景目录、未保存切换取消、保存v2/刷新、带版本引用、场景报价取消/确认、模拟生成待审/显式采纳后刷新全部实点。开发HMR曾重置章节生成模拟大纲，已忽略且不算场景验收。本地模态/显式保存栏与源站浮窗/自动保存、未接媒体仍明确不同。
- 验证最终：523后端（32场景）/69定向前端，生产build/类型检查通过；全仓ruff、i18n、CE11端口/import、禁词/包名、skill校验、gitleaks增量与director源码/测试目录、diff/guard通过；设计lint0错误20既有警告。首次系统Python端口检查缺包，使用仓库venv重跑通过；新增真实JSON测试暴露TS参数过窄，已修合同再build，不靠cast规避。
- 未提交、push或部署；不重启用户常驻栈。临时模型中转/隔离API/Vite/浏览器关闭，临时预览HTML删除，合成SQLite与全部证据保留。同步线diff与用户资料未碰；全Director线仍执行中，事实门/完整UI欠项不归档。

### 2026-09-26 · 人物小传要素/M08/局部布局与三笔真实模型验收

- 按用户新优先级只读登录LibTV既有人物文档，实测主次人物分层、12类适用字段、节点/目录/编辑器几何和角色图菜单；未改源站稿、未调用源站生成。short-drama人物方法与villain-design完整读取，阶段经验查询无匹配；skill-creator用于应用内M08包，未修改全局技能。详见character-parity.md。
- 修复源头接点：筹备M08与单文档人物共用严格人物合同/方法；single入口只返回人物，不顺带覆盖场景道具；集次由宿主ID及顺序校验，重复JSON key/关系缺失拒绝；旧稿兼容读不伪造。原回包/usage先保留，格式失败不重试扣费。保留short-drama动机/知情/关系，M11实际读取保存后人物稿并绑定版本/hash。
- UI按原站640×350节点、右上编辑、680正文、15/28正文和标题/字段间距调整；1920视口正文x620/y178与源站相同。目录按位置区分重名，实测发现末项滚动被夹住会错误高亮上一人，已修复并加回归。1200与390视口无整页横向溢出；正式保存v1→v2后刷新保留、未保存切换取消不丢稿、选区带版本引用到对话均实点通过；隔离服务没有调用真实模型。原站聊天浮窗/自动保存、本地安全保存栏及未接角色图等差异明确保留，不称全部UI相同。
- 真实三笔：默剧1×60、职场2×180、改编1×120/source EP02；回执均为DeepSeek-V4-Flash，一次请求、8192输出上限、零自动重试。24,463输入/5,043输出token，实际金额unknown，全部未采纳未定稿。结构均过，但职场补称呼、改编推断年龄/受压行为，文学事实未过；不继续盲目购买。完整参数、system、冻结快照、原响应、稿、usage和隔离SQLite保存在忽略的output/playwright/director-character-live-20260926/。
- M08 2.2.0实测包c26d1f19；收尾仅修正不装入prompt的正例fixture外形/默剧矛盾，最终包2674d1f0。method/template/reference/schema不变；真实测试未冒充在最终包指纹下运行。合成浏览器例从单测EP02标签改回实际EP01，并重启仅本轮隔离服务更新截图。
- 验证：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q` **491 passed**；三个定向前端文件**67 passed**；`pnpm build`通过（已有chunk警告）；Director/test ruff、双端i18n、CE11端口、禁词/EE/import lint、skill quick_validate、gitleaks diff及新代码/测试目录扫描、diff/guard均通过。design.md在线npx因DNS失败，改用已安装0.4.0 CLI，0错误/20既有警告。初次测试两处夹具版本/回包键断言及一个TS测试参数错误已修复；不隐藏真实内容失败。
- 同步线三份既有协调diff及受保护资料未改；不提交、不push、不部署/重启用户常驻栈。本轮模型/浏览器临时服务与会话收尾关闭，临时HTML删除，截图/付费回包保留。整条Director线仍执行中，不归档；具体剩余质量与操作差异见指南§5/7。

### 2026-09-26 · 已按授权完成本地提交（未推送）

实现219文件已提交为`cb3833ee`，取证2报告为`180aac9f`，两线协调依赖为`ba101496`。提交前候选指纹无变化，逐组实际索引diff-check、gitleaks/guard/banned-words全通过，三条DCO有效。沿用同字节471后端/78前端/build结果；本轮未修改业务或重跑模型。提交不是完整功能/文学质量验收，也未授权push/部署；第三方素材许可仍需核验或替换。只剩三份受保护原稿/旧文件未跟踪。

提交工作线收口见`docs/agent/archive/git-sync-preparation.md`，本线仅以三条精确coordination claim承接其归档与活动台账/claim移除，旧内容可从已创建commit恢复。临时ui-parity共享随该线归档撤回，本线继续持有视觉文档。后续开发开工须将本线基线更新到实际HEAD后重新acquire/preflight，不能凭已提交推定可绕过基线复核。

### 2026-09-26 · 提交准备复验（无业务源码变动）

git-sync-preparation按用户要求在独立干净检出pull，zhonggwv/main已最新e7b1fbce；备份及按工作线候选见该线台账。含共享回环代理的后端471项、前端78项及build通过；实际独立候选pre-commit首次抓到本台账和ui-parity各一处第三方依赖描述用词，已双向共享/preflight后改为公开发行包/第三方富文本依赖，重跑三钩子全通过。业务源码与备份逐字一致，未commit/push；素材再分发许可与文学质量遗留不变，不能把提交准备当完整产品验收。

### 2026-09-26 · 大纲独立证据审查与6笔同稿复验（链路通过，文学未过门）

改了什么：新增outline_review合同、完整来源逐句覆盖、剧情/自评元数据分层与引文/位置/hash校验；有效VIOLATED不被坏兄弟项抹掉，全正面最多REVIEWED而非PASS。接入既有review报价/批准/派发/持久回包、viewer读取API、故事大纲报告入口和三语实验提示；单独审稿不清空输入、不改稿或自动定稿。M07 2.2.0和全局技能不变，M12已校验short-drama参考继续复用。发现整包正文六项指令与大纲合同混用，适配器1.1.0只取verified references、独立schema，旧报价绑定版本失效；M12原包不改。费用说明不再把请求token上限写成结算承诺。

为什么：上一轮生成器与审稿器都混淆实际代价和条件风险，只校验JSON会误放行。本轮独立证据入口使原文/要求/原回包可追溯，但逐句覆盖不等于原子事实完整、精确引文不等于推理正确，因此不能声称可靠质量门已完成。已保存大纲可用，规划WAIT_OUTLINE待审包、人工事实确认及下游强制门仍未接。

真实复验：旧五稿各1次独立审查，另职场1次reference-only对照；共6次，无新稿生成、自动重试或采纳定稿。供应商报告V4-Flash，输入57049+输出21197=78246tokens，实际费用unknown；5份UNAVAILABLE、1份REVIEWED，**6份都未抓出已知关键硬错**。温情虽引文有效仍把桌角拾取当直接交接；职场去除模板冲突后仍把可能绩效损失当实际后果，故无法证明内容改善，停止加购。各次system/冻结参数/报价批准/原回包/report/usage/隔离SQLite完整留在忽略`output/playwright/director-outline-review-20260926/`，逐项结论见literary-benchmark §9。

怎么验证：新增16项后端合同/权限/hash/CAS/重放/一次dispatch及HTTP system/JSON模式/双token参数测试；全Director+API **454 passed/10弃用告警**。4前端文件 **78 passed**；pnpm build通过、既有大chunk告警保留；全仓ruff、三语/前后i18n(0/475)、CE11端口、定向gitleaks、diff/guard通过。Playwright合成provider连真实UI/API/SQLite点测只读报告→报价取消→再次报价和费用勾选→单次授权→持久失败报告→重载，2quote/1grant；1200/390截图已实际查看，窄屏无横向溢出，只有关闭/审稿无定稿按钮。初始Vite代理变量错致500，改实际VITE_API_URL后复验200；CLI旧network命令改requests，原问题不掩盖。UI合成FAIL不当真实模型成绩。

交接：功能入口可用、真实审稿不可靠；没有宣称与LibTV文学对齐，没有提交推送部署或更换供应商。下一步按§9.5建立可编辑确认的原子事实表和有编辑依据的最小正反反例，再评审对照，不能继续靠补长提示或重复购买初稿。收尾停止本轮3001/18780/15173与独立浏览器，移除临时HTML但保留所有证据；未触碰用户运行栈/原稿/Cookie。最终guard/handoff/release由本轮owner执行；完整工作线保留执行中，不归档。

### 2026-09-26 · 五套文学基准、14真实请求与LibTV完整大纲对照（内容未过门）

改了什么：新增`outline_benchmark.py`冻结五套原创/改编/单多集案例、独立证据审稿、显式一次调用与目录拒绝覆盖、自由主线/结构投影诊断；`live_outline.py`复用生产quote/grant/dispatch并记录case输入。新增11项离线测试与`literary-benchmark.md`逐段编辑结论/成本/失败试验/复跑说明，outline-parity链接新证据。M07实验2.2.1做过两次实测，因仍有语义错误且新增结构失败，已精确撤回本轮method/manifest/provenance/runtime/pinned/test版本变化；原2.2.0包hash恢复80fdc1d2…d76ea，无新生产提示词上线、无UI/配置改动，保留所有原有dirty工作。

为什么：用户强调结构只是基础。五份初稿结构均有效，但温情交接顺序、职场实际代价/配角行动、悬疑备用衣/调查机制、奇幻固定规则/人数均失败，改编主链较稳但跨栏目道具主体/位置/雨况需局部修订。五次审稿四次证据或维度不合格，一次自报pass漏判硬条件，宿主至少降为revise；不能拿平均文学分报喜。两阶段诊断让职场具体到色卡/页面，但没解决实际代价，投影还添语义漂移，因此不直接改变产品费用/调用链。

真实开销/留档：5初稿+5新上下文评审+2修订复测+1自由主线+1投影，共14个本方供应商回报请求，输入180478/输出84256=264734tokens，金额无结算unknown；无自动重试、正式采纳或定稿。全请求/系统方法/冻结规格/原始回包/usage/隔离SQLite存忽略`output/playwright/director-literary-20260926/`。输出上报可能含推理且超过请求上限，不承诺硬账单封顶。LibTV新建唯一合成职场项目：同brief、方向2、1集180秒，最终《页脚》大纲及源站自动附带的四种筹备文本已到询问卡，未点击定稿/正文。前后界面余额未变（数值只留本机），无额外付费弹窗，不把余额未变当后台费用为零。记录init_work、两次skeleton写入（more/append/plan）及finish_script_task，HTTP/WS脱敏回执在completed-evidence.json；旧项目不动，未发布媒体或分享。

怎么验证：最终`.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q` **438 passed/9既有弃用警告**，基准11项独立通过；全仓ruff、前后端i18n（0/475无新增）、CE11端口、M07指纹及skill quick_validate、gitleaks测试/指南/源站证据目录、diff/guard通过。初期离线mock补丁打错已修正并复验；浏览器取证先修复监听的URL沙箱错误，发送前已核验http/ws统计，原异常不隐藏。本轮未跑前端构建、像素/Windows/完整24份与真人盲评，不声明全目标完成。

交接：最新文学结论与下步为literary-benchmark §8；先实现独立事实义务及逐证据门，再比较固定方向下的单/双阶段和不同模型，不从M07字段重写开始。全局short-drama没改，项目技能根基保留；本轮无提交/推送/部署。收工只停本轮3001回环网关与独立浏览器，保留付费回执和源站合成项目。锁按本轮owner完成handoff/release。

### 2026-09-26 · 大纲要素实接与用户时长权威

收尾追加：`pnpm test --run src/__tests__/i18n/locales-json.test.ts` **12 passed**，与三份Director前端64项合计本轮76项；最后`agent_guard.py check`为18线454claims通过，前端Director目录与本台账定向gitleaks也无发现。关闭自己启动的网关后3001无监听，不是停止用户原有服务。

本轮按用户新优先级对齐故事大纲，不丢弃short-drama。使用short-drama的/plan及开篇/节奏/爽点参考，按skill-creator更新应用内M07派生包2.2.0；三个来源参考文件/hash不变，未改全局个人技能。用Playwright只读原站现存大纲与既有write_artifact证据交叉核对，建立概要/简述/背景/压力/分段/追看/钩子/伏笔/反转/禁区十类要素合同。`OutlineMethodContext`适配原创及单文档改编，但不冒充来源审计。

实际完成：两条大纲生成入口共用同一技能和严格StoryPlan；新`outline.py`拒绝重复JSON键、漏项、错集号/顺序/伏笔链接、结构或总时长不符，三语言确定性渲染不泄露内部UUID。WAIT_OUTLINE预览/采纳与单文档待审投影同源，旧稿及旧2.1产物保守读取不迁移。M07实际HTTP请求带JSON模式和批准的token参数，失败原文、用量留存且无自动重试；测试provider同步新合同。详见[大纲对齐报告](../../guides/tv-director/outline-parity.md)。

真实V4-Flash两次独立合成验收：第一笔71.84秒、19413/2388输入/输出tokens，重复/未知字段导致正确拒绝且无候选；修正JSON传输及事实规则后第二笔58.94秒、19583/8356tokens，十类要素/schema/ID/结构/时长通过并留下待审稿，未采纳定稿。人工仍发现制作限制被写成戏内压力/代价，补强最后语义提示后仅离线回归、未买第三笔；不得称最终hash文学质量已复验。两笔合计49740tokens、金额未知；第二笔供应商上报输出超过请求8192且缺推理分项，不能承诺实扣硬封顶。每笔请求/原始回包/usage/quote/approval/hash/独立SQLite留在忽略的`output/playwright/director-outline-live-20260926{,-json-mode}/`，不含鉴权头。

用户明确时长自己决定：30秒从来只是测试样例。本轮实查并去掉旧设定器5–3600秒静默钳制及后端上下限，保留正整数秒规则；默认120不是强制值。输入清空/0/负数/小数不偷改，禁止确认；选模板不改时长、取消不保存。测试1/120/5400秒通过UI确认与保存后真实编译参数，其他1–5400秒样例验证大纲合同遵循用户值；模型回报总时长不符直接拒绝，不反向改preset。UI布局/CSS未动，无新像素或物理设备验收。

验证：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q` **427 passed / 9依赖弃用warnings**；`pnpm test --run src/__tests__/director-ui.test.tsx src/__tests__/director-execution.test.tsx src/__tests__/director-richtext.test.tsx` **64 passed**；`pnpm build`通过（既有>500kB chunk警告）；`.venv/bin/ruff check src/novelvideo/director tests/director`、前后端i18n棘轮通过；M07 `quick_validate.py`通过，包hash与合同fixture含在上述后端测试；`node docs/guides/tv-director/verify-spec.mjs --self-test`22突变正确拒绝（仅规格非产品）；gitleaks对新域/测试/指南扫描无发现；`git diff --check`通过。uv缓存权限受限故使用已有venv，没重装环境。原站浏览器会话及本轮临时启动3001网关均关闭，常驻用户栈未动。未提交/推送/部署，整体Director仍执行中。

### 2026-09-26 · UI续轮：设置/历史/富文本/完整模板与逐题交互

做了什么：继续同视口取证，补全600宽设置、320宽历史弹层、680正文全屏Tiptap编辑器、原站54 SVG/14题材图/21画风图、8个完整模板、345宽四类参数弹层/413×407画风及373×249结构。新增标题CAS/幂等软归档恢复，保留正文/历史/费用；运行或UNKNOWN阻断变更。接实际通知权限/本机偏好与Token上限、附件.md/.txt/拖入/来源chip、当前文档引用/真实模型/手动菜单、单文档画布平移缩放/底部工具条、方向问卷序号/逐题翻页/答案保留。新增Tiptap7直接依赖，锁文件仅504新增行，旧importer未升级。三语、DESIGN和ui-parity验收同步。

为什么：只换首屏/图标无法满足用户“全部对齐”；本批从真实DOM测量重建子界面并接实际操作。模板纠正职场成长融合职场行业、仙门团宠融合古装言情、重生复仇主体家庭伦理，避免同名预设提交错方向。源码保底保留未知Markdown；格式/保存不绕过CAS/私稿；打开/缩放/只读变化不会自动改正文。浏览器发现同作历史重开清空正文、重复重开浮钮遮住画布缩放，已修复并实点复验；历史不确定响应只准同意图重试。自动扣费/预算无服务端权限仍禁用，不造成功按钮。

怎么验证：68项定向前端（4文件）/357项Director后端通过（8既有依赖警告）；TypeScript+Vite构建通过，Director懒加载约652kB有大chunk警告。pnpm离线frozen lock安装、定向ruff、前后i18n、diff-check、guard18线451claims、DESIGN lint0错误/15既有警告，前后Director与指南gitleaks无泄漏。浏览器真实组件+隔离API/SQLite验证历史重命名→归档→恢复→同作重开；六弹层/21图加载；设置/编辑器/目录/菜单；画布150%→复位；1920/1200/390，窄屏scrollWidth390。六参数宽高与参考一致、位置≤1px；设置600×478.25对参考600×478.672；编辑器正文680居中x620。调试旧选择器/遮挡超时已重验，不隐去失败。原站只读UI，无付费调用；未跑全仓全部测试、生产认证、OS通知声音或Windows。

未完成与接续：ui-parity §6明确六组差距：全运行/审批态逐屏、块级diff/稳定选区、媒体资产/多节点画布、Skill/导演/分享插件、自动策略/跨设备、全应用壳与Windows。方法说明不是Skill库；相同图标不等于149动作交付。下一批先比对E22–E31待审差异视图与现有canonical changeset接口，写精确计划后接diff导航/依赖组接受撤回；不重复本批已完成布局。未提交、推送、部署；任务仍执行中，第三方素材发布许可未解决，旧真实内容FAIL/UNKNOWN保留。

收尾：最终68项定向前端与build再次通过；附件菜单153×77已实点测量。已移除本轮临时预览HTML、关闭本轮两独立浏览器会话，核对命令后停止18780隔离API与15173测试Vite；截图/合成记录保留，用户数据与常驻服务未动。最终guard/handoff/release按当前owner执行，不将未完业务归档。

### 2026-09-26 · UI优先：实测几何、原站SVG/题材图与操作回归

做了什么：按用户新优先级重构独立中性灰创作表面、400×640浮窗/标题拖动/八向缩放/停靠、欢迎Top8、1232×640双栏设定器、15题材与融合双圆、六摘要卡/94选项及八种结构/1–100集数；旧完整字段保留到高级区，取消保持模态草稿隔离。节点增加参考工具栏/Markdown富文本预览/实际下载。按追加“图标也用它的素材”，固定36种原站SVG与14张720×720公共题材图，原站Top3裁切/玻璃边缘/图后光晕；静态SVG白名单与实例渐变ID，来源/字节数/hash留清单，无运行时热链。编辑器只换关闭X，API/方法/审批和已有正文逻辑不变。

为什么：先前通用图标/表单堆叠并不符合用户要的LibTV交互；不能仅换色后称像素一致。按同视口DOM测量修正主窗、卡片、结构弹层尺寸，完善取消/焦点回归、停靠返回语义与窄屏。相同素材不代表获得再分发许可，发布前使用权待核验；本轮没有提交推送这些资源。用户源稿/旧画布/研究凭据未改。

怎么验证：定向Vitest三文件49 passed（新增SVG安全/渐变ID/14图hash/取消/参数保留/只读/选项上限/焦点/几何状态），tsc+Vite生产构建通过（既有bundle警告）；i18n 0新中文/三语检查通过，DESIGN lint 0错误/15既有警告，预览脚本ruff、diff通过，新增域和指南gitleaks无泄漏。浏览器1920/1200/390真实组件+隔离合成API：14图加载均720×720，主窗与设定器尺寸一致；结构弹层373×249，位置最大1px偏差；拖动从1504/424到1404/374、Home复位，融合移除/滑块/取消20→3/7后仍20/停靠返回/关闭重开/编辑器及下载已点测。手机scrollWidth390无整页横溢出。调试HMR导入错误/旧选择器超时已修正重验，不能将其隐去当一次全绿。全量前后端/Windows未跑；本轮零真实模型调用，不替历史内容FAIL结案。

证据与边界：新增`docs/guides/tv-director/ui-parity.md`列精确尺寸、素材清单、命令与本机截图名。已对齐首屏/核心设定器并非整套像素验收；设置/历史原有布局、富文本编辑/选区操作、完整题材/画风/Top8模板、无限画布/附件/模型浮层、问卷和执行全状态、媒体/分享/插件、Windows仍有缺项。保留“高级设置”、真实模型名和禁用原因，不能伪装原站行为。业务未提交推送部署，任务仍执行中。

收尾：已移除本轮临时`frontend/director-preview.local.html`（只含合成页面挂载，可按预览模块重建），关闭本轮两浏览器会话；核对进程命令后仅终止18780隔离API/15173测试Vite，两个端口已无监听。没有删除合成回执/截图或用户数据，没有重启用户服务。最终diff/guard通过（18线426认领），按本轮owner执行handoff/release；保留已声明的其他工作线脏文件。

### 2026-09-26 · 原创方向/筹备主流程实接，真实四阶段内容FAIL留证

做了什么：本轮按WP03–WP07新增M03/M07/M08/M09四方法适配包、严格结构化产物、原创workflow父计划/预算/顺序子调用、持久问卷/忽略返回/旧卡拒绝、自定义方向与必答问题、全部四文档CAS原子采纳。页面接真实费用/问卷/候选/阶段执行卡；刷新只读、丢响应原意图重放，UNKNOWN不重发。新增测试验收器可最多1+3次真实请求。修复采纳后画布停留旧版本、预览受JSON键排序影响、末次响应与停止竞争卡住付费结果、历史卡错误断言未采纳等问题。

为什么：用户问还剩多少并要求继续实现；先按完整22包退出条件逐项审计而不是从测试数推完成率，结果是22包仍有缺项，6/24实际包、9/33类gold，完整UI/方法/导演媒体生态未完。short-drama按阶段实际载入并保持用户短片/集数优先；生成候选与采纳、采纳与定稿、确认方向与付费分别处理。未把M10或完整逐集链包装成已完成。

验证：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py tests/test_newapi_text_gateway.py -q --tb=short`365 passed/8既有依赖警告；定向vitest两文件39 passed；生产build通过/已有bundle警告。25项workflow/验收器回归覆盖全链、并发重复批准、失败只重购未完成、UNKNOWN隔离、停止竞争、全事务回滚、错集/时长/ID/结构/输出字段。全仓ruff、前后i18n、CE11端口/导入、禁用词/包名、diff、gitleaks和规格22负向突变通过。离线wheel66方法源/资源逐字节相等。浏览器真实组件/API/SQLite的合成链验证忽略刷新/恢复/无默认选择/1+3预算/四文档顺序/采纳v1/刷新，无自动正文与定稿；不是生产认证或物理Windows验收。

真实模型：四阶段分别35.27/234.92/22.53/11.70秒，均一次请求与stop、provider-reported V4-Flash；合计43752输入+6062输出=49814 Token，实际金额未结算保持null。全部命令/快照/系统方法/JSON输出/usage/SQLite保留在忽略`output/playwright/director-live-planning-20260926/`。**内容验收FAIL**：M03编祖孙/退休/告别，测试器机械选择首项与泛答澄清，M07/M08继承为确定事实；M07/M09眼镜佩戴与手持缺过渡，30秒只是目标非实测。没有自动采纳或定稿，没有追加付费或重放旧UNKNOWN。`content-review.json`明确模型、宿主和测试决策各自问题；下一步优先修事实确认与M10，不用补一句prompt或换模型冒称解决。

剩余清单权威为implementation-closure §0，完整证据为runtime-validation §0.2。筹备期间规格变化后的重规划、实质改写、M10/结构化M11/逐集父计划、全改编/全UI/Skill生命周期/导演全能媒体分享/Windows均未完成。当前新增代码未提交、未推送、未部署，不归档。

收尾：本轮设计lint为0错误/15既有警告；最终中文/英文/越南语JSON回归39通过。实际点击四类正文均v1、EP01仍v0，1920/375截图已检查；不是全移动/全UI验收。已删除本轮临时HTML入口（可按既有预览方式重建，所有运行证据保留），关闭独立Playwright会话，仅核对并停止本轮启动的三项回环测试服务；未删除任何用户项目或付费回执。guard18线410claims；handoff核对159条已认领脏路径通过，按同owner执行release，任务仍执行中。

### 2026-09-26 · 持续实施实收：修订/私稿/方法包与真实审稿故障闭环

做了什么：本轮从canonical AST、18条件规则/上下文、参数冻结、独立M12与人工Finalization继续推进；现已接已完成集显式重开、设定影响预览/CAS、减集归档及稳定ID恢复、任意集只读浏览、固定编辑基线/显式私有稿恢复。现有M11/M12入口实际加载两个自带方法适配包，含许可/来源指纹/模板/schema/正反例，校验后才报价；升级/损坏使未消费授权不能派发。其他22个方法与全阶段仍未实现，不用两个适配包冒称24包完整。

为什么：用户指出“落实完”而不是继续只做文档；本轮实改用户可操作路径，并用真实模型发现引用ID漂移、坏引用吞掉已证实FAIL两个问题。输出schema枚举实际引用ID，逐check核验保留有效FAIL；旧UNAVAILABLE原报告不重写，本地复核保留回包只能增加失败阻断，不能放宽旧门或触发付费。字数/时长仍不信模型自报，不把流畅输出当质量通过。

验证：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py tests/test_newapi_text_gateway.py -q --tb=short`最终340 passed/8既有依赖警告；`pnpm exec vitest run src/__tests__/director-execution.test.tsx src/__tests__/i18n/locales-json.test.ts`34 passed；`pnpm build`通过，已有大bundle警告。全仓ruff、前后i18n（0/475基线无增加）、CE端口11/导入、diff、gitleaks源/UI/测试/文档、guard通过。`uv build --wheel --offline`通过；26个方法源/资源逐字节在wheel，缺失/差异0。规格22负向突变通过仍只证明规格，不当482产品测试。全量pytest/前端与Windows未跑。

真实模型与证据：新版M11 7.44秒/15383输入/105输出；M12初回27秒/3066输入/1130输出，引用`inputs.document`无效；修正enum后二次60.25秒/3147输入/1681输出，成功指出开锁后取眼镜环节遗漏，但另一检查误绑brief。三次都是一次请求、无自动重试，已知24512 Token，金额无结算仍null；沙箱失败0.41秒UNKNOWN与旧300秒UNKNOWN均保留不重放。宿主本地重核后原报告仍UNAVAILABLE、有效失败结论FAIL/REVIEW_FAILED、readyForHumanReview=false，原费用与历史未改，新增模型调用0。真实正文仍未达到质量通过，其他两例早先质量失败未关闭。完整请求/方法/schema/回包/SQLite及host-validation在忽略output，详见runtime-validation §0.1。

真实浏览器已验设定影响/重开EP2/2→1归档只读/私稿保存→重开→恢复且正式v1不变；截图保留。最后新增本地复核提示由组件测试/构建覆盖，未重开真实浏览器，明确不算其视觉验收。临时HTML入口删除；仅本轮启动且核对PID的3001网关/18780合成API/15173 Vite及浏览器关闭，没有部署/重启用户栈、修改原稿或第三方账户，没有提交推送。

完整目标未完成，不归档、不标验收通过：缺阶段父预算/持久会话问卷与33转移、全ConfirmedSpec/来源追踪、M03–M10筹备/事件独立审计/容量计划、其余方法、逐hunk/富文本、完整LibTV UI、Skill生命周期/导演/全能/媒体、分享/OAuth/导出导入/物理多设备。下一动作见末尾，不再从AST或旧prompt重复开始。

最终收尾检查：`npx --yes @google/design.md lint DESIGN.md`成功返回0 errors/15 warnings（现有对比度及孤立token警告未改邻域）；禁用词/包名检查通过；三个本次测试监听均已消失。guard为18线409claims，handoff核对114条已认领脏路径通过，收工release按同一owner执行，不影响另一研究线/原稿/用户资料。

### 2026-09-26 · WP06 方法文件实际加载续轮方案门

审计确认目前规则有来源指纹，但写作/审稿仍未读取自带方法文件。本批先将现有可调用的M11与M12落成校验包，不伪造其余22包已实现。新增`src/novelvideo/director/skills/runtime.py`及`skills/builtin/`下两个明确版本包、共享short-drama参考快照与MIT许可；每包有manifest/method/输入输出schema/template/正反fixture/provenance。由宿主固定注册key、允许validator、只读工具白名单；拒绝目录逃逸/符号链接/篡改/外部schema引用，校验文件hash再加载。M11当前输出仍为Markdown→canonical AST适配，不冒称完整EpisodePlan/ScreenplayDraft合同已经实现；M12沿既有严格六检查与证据验证。仅接已存在入口，不能悄悄增加模型次数。

源参考按实际阶段与集数加载（首集开场、非末集或开放结局钩子），确认参数和条件规则高于长篇范例。请求记录实际包revision/method/template/reference/schema摘要，能力指纹包含全包摘要；报价后升级/改动必须重新报价，派发前拦截，已返回的旧结果继续按原快照保留。运行不读开发者本机技能目录。新`tests/director/test_skill_runtime.py`覆盖破坏包、错schema/工具、条件选择、包升级/0调用、实际prompt及回执绑定；现有writing/quality/execution测试回归。源目录与目标域git diff和本地origin对照无同路径他线实现，唯一锁保持。风险/回退：数据不迁移；可回退编译入口但不得恢复旧quote执行，保留所有费用历史。静态包完整不代表源事件审计/容量规划/全TVDirector完成。

前一批实际结果：299后端网关、33前端定向测试及构建通过；浏览器已验证EP2重开、2→1归档再读取、私有草稿保存→关闭→重开→预览→恢复（正式v1保持不变）。私有稿是显式保存，不宣称自动保存/富文本已完成。

方法包接点增加既有context.py的独立HOST_VERIFIED_METHOD_JSON区，预算包括实际方法文本；M12方法和schema同时冻结。既有live_execution.py增加单case选择，允许只验证新版方法而非默认买三份正文。授权测试使用全新隔离目录/新意图，先最多一次M11原创、4096输出Token；失败或UNKNOWN即停，不重发旧审稿UNKNOWN。若有完整回包再人工检查是否满足原硬约束，不把包schema/38静态回归当生成质量；所有新参数与完整响应仍存忽略目录。此验证未增加自动修订或自动定稿。

真实验证分叉：沙箱内首次0.41秒UNKNOWN保留；只读loopback对照默认curl连接失败、提权可获HTTP响应，确认环境访问边界，不改业务重试规则。获准网络环境下新的M11测试意图7.44秒成功（15383输入/105输出、1请求），不是重放旧任务。生成两场/默剧且96汉字，但自报约180字不实、盒中取眼镜动作略过，仍未做30秒排演。下一步仅用这份新方法输出买一次独立M12（同4096上限），新增review单case筛选避免买其他正文/审稿；旧300秒审稿UNKNOWN不触碰，若再次UNKNOWN立即停止。完整回执与费用未知均保留。

M12真实回包27秒/3066输入/1130输出；模型输出引用ID `inputs.document` 而合同要求 `document`，正确拦为UNAVAILABLE。源头修复不是接受任意别名：compile_review将当前可用ID写入动态enum/schema，明确禁止路径写法，冻结实际responseSchemaHash，并将review编译版本升2.1.1使旧审批失效。新增实际失败最小重放、合法ID/伪造ID/参数hash回归；历史失败不改判，不覆盖原回执。用户已授权必要真实测试，新编译版本可再验证一次同样保留正文的独立新意图，非自动重试，仍4096/1次且UNKNOWN停。

第二次真实M12回包60.25秒/3147输入/1681输出：ID已正确，source_fidelity有brief/正文逐字证据指出开锁→取眼镜环节遗漏；continuity另一条quote却错挂brief。原整报告UNAVAILABLE会吞掉其余已证实FAIL，可能被全项人工接管绕过。修复为逐check核验：坏证据该项UNKNOWN/不可用并清除不可信引用，其他合法FAIL优先保留；整JSON/hash错仍全不可用。旧UNAVAILABLE报告不覆盖历史，读取时对已保存原回包本地复核，只能追加阻断、不能借复核放宽旧门；UI单列“保留回包本地复核”，不伪造新模型运行。新增旧报告/费用/定稿拒绝/原记录不变测试。精确沿quality.py、API-client、QualityReviewDialog与三语/现有测试，本轮不再付费调用。

### 2026-09-26 · WP11 已定稿修订续轮方案门（执行中）

验收发现的相邻安全接点：编辑器目前背景刷新会把保存使用的version换成新值，有覆盖他人正文的风险；按WP12补打开编辑器时固定work/doc/version，后台变化不更换编辑基线。接已有private draft API，以独立组件 `frontend/src/features/director/components/DirectorDocumentEditor.tsx` 保存私有稿/恢复列表，显式恢复而非自动覆盖；私有稿与正式保存分开，原有稿跨版本仍可读。新增保存不准隐式rebase，失败保留输入；正式保存需要初始版本CAS，完成后私有稿仅作为历史保留。三语及当前组件测试覆盖刷新/保存失败/切换作品不串写；无模型调用。该组件仍非完整富文本/hunk编辑器，不虚报WP12完成。

接通实际用户路径：设定器不再永远冻结；已有写作的作品通过服务端影响预览→逐项确认归档集→CAS原子提交。新 `revisions.py` 与 `schemas/revisions.py` 保存不可变 before/after 设定快照、预览和幂等回执；旧 preset 仅作为兼容适配数据，不冒称已实现完整 ConfirmedSpec provenance。源文本、模式与来源标签不在本轮可改范围，页面锁定并由服务端拒绝越界。创作参数变化使全部审稿/定稿/派生产物失效，保留正文及全部历史，从第一集重审；仅改标题不重开已完成作品。增集按稳定ID分配；减集仅归档，要求逐项确认与原因，不物理删除，也不自动重写/调用模型。

同时接“重开指定集”：独立影响预览保留该集及后续集的所有正文，失效该集起的审稿与定稿，后续工作流回到选中集。页面可查看任意已有/归档集，只有当前检查点可编辑；历史/未来集不误用当前集号调用模型。预览绑定actor/work/revision/doc版本/已定稿回执/待审和运行状态；运行或UNKNOWN期间不得改设定/重开；新增待审或新报告使旧预览失效。提交重放幂等，预览取消无正式状态变化。

精确新增边界：`src/novelvideo/director/revisions.py`、`schemas/revisions.py`、`tests/director/test_revisions.py`、`frontend/src/features/director/components/RevisionImpactDialog.tsx`；已有 store/repository/quality/API、DirectorStudio/PresetDialog、API client、三语及定向UI测试仅增加接点。源/API路径均本线独占无远端同类实现，共享翻译只加键。步骤：严格schema/事务→故障测试→UI接点/逐项映射→浏览器→回归→记录。回退只撤新接点，SQLite additive表与历史不删除。验证含并发重复提交、跨用户/跨作品、过期/CAS、故障回滚、增减恢复稳定ID、旧报告不可重新生效、标题不误失效、API权限与真实组件点击；不把合成模型与真实质量混淆。

### 2026-09-26 · 持续实施：独立审稿与新版定稿权威，未收工

已实现：canonical AST及完整版本投影/稳定ID/显式备份迁移；18规则选中/禁用/来源hash、必需上下文完整性和预算校验；八结构与基调/画风/结局/语言/保真/新增/锁定/来源交付参数保存→重载→模型请求逐字段验证。独立M12审稿通过purpose=review走同一quote/approval/dispatch账本；冻结原稿/上游/修改前稿/原始修改指令，六检查/证据引用宿主核验，模型不能直接定稿、写稿或自报实测。canonical bool定稿入口拒绝，新v2逐项HumanReview绑定DV/hash/report/actor并幂等提交；旧确认表仅历史，升级从首集复审，两集重审不覆盖历史。按finalizationId保留失效记录，写第二集不误伤第一集，上游变更则使依赖定稿失效。

为什么：上一轮仅安全传输仍未实现方法/正文权威，本轮补真实接点而非只造纯函数。审稿回包与正文回包分流；UNAVAILABLE不是PASS，已证实FAIL不能勾选绕过，尚未排演可仅确认文学稿但不标productionReady。UI审稿任务不能显示“草稿已保存”；原始改写指令必须输入独立评审，否则发现不了先后时机错误。

验证：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py tests/test_newapi_text_gateway.py -q --tb=short`为282 passed/8既有警告；定向vitest26 passed；pnpm build通过（已有大bundle警告）。全仓ruff、前后i18n、diff-check通过，guard407claims。真实浏览器实际组件/API/SQLite：设定基调/非线性保存并出现在审稿报价→手工合成正文→未审稿阻断→显式费用→合成独立审稿→逐项证据→单集定稿/只读；截图output/playwright/director-{parameters,review-quote,human-review,finalized,review-mobile}-20260926.png。浏览器为隔离测试后端，不是生产栈/物理Windows验收；最后canonical历史衔接增量由后端回归覆盖，测试服务需后续收尾时关闭。

真实模型：复用原已保存合成正文，首个独立审稿在300.08秒后UNKNOWN，无输出/usage；其余两例未发，未重买正文、未重试。请求/系统方法/完整源及正式稿/quote/approval/SQLite保存在忽略目录output/playwright/director-independent-review-20260926。只读授权GET models为200/2.29秒，配置V4-Flash在模型列表，不能据此判定生成没收费。该次费用仍unknown；M12真实内容质量尚未验证通过，不能将合成审稿PASS当真实结果。

仍在继续：完整ConfirmedSpec/33转移/会话与问题持久化、全阶段父预算及24包加载、M04/M05/M10实际编排、hunk与联动修改、Skill/全能/导演/H3/分享/导入导出/多设备及全量验收。已有文档/运行/质量模块可复用；不要重新写一遍或把函数级测试计入482完整用例已通过。当前锁仍由本会话持有，未handoff/release、未提交推送。

### 2026-09-26 · 持续实施中：AST正文/稳定ID/显式迁移接入

已增加严格AST、语义hash、稳定块lineage与UTF16选区，同SQLite新表保存正文权威、派生依赖、私有草稿与导入备份；新作品默认启用，旧接口读写适配同一权威，缓存Markdown不能覆盖正式AST。旧作品预览和确认hash、备份全部历史、事务中断回滚、重放幂等已接API与页面；旧确认不会作为新质量PASS。联动失效保留历史，不自动调用模型。首次28新增测试通过，扩展回归找到保存/读取字段差异及后集误失效前集问题并修复；当前40项正文/旧接口回归通过，完整Director回归正在补充后重跑。前端23项含新增迁移确认回归通过、build通过。此为连续实施过程记录，未收工、未归档；下面继续WP06，完整TV Director仍未达验收，不以局部通过结束。

### 2026-09-26 · v2安全执行层已接真实API/页面，真实模型三例完成并保留质量失败

做了什么：新增严格execution命令、additive SQLite quote/approval/operation/cost/outbox/event事务，哈希/版本/用户绑定、幂等重放、原子单次派发、未派发取消、UNKNOWN隔离与旧回包保留；页面改走新路径，费用预览/Token上限/任务恢复/只读结果接通。旧v1生成接口409拒绝升级绕过，其读取/手工编辑保持兼容。修复设定取消未回滚、异步预览跨作品及375px顶部挤字；三语齐全。实际usage/finish reason进入回执，金额未知不记0，截断不生完整候选，活跃/未知任务在同事务阻止定稿。`config.py`共享窄改修复loopback默认继承代理的502，明确开关/远端不变。

为什么：仅纯函数通过未进入用户路径；刷新/重复批准/断线都可能产生重复调用或误用草稿。实际模型测试又证实，流程成功不等于内容正确，所以安全执行、源头方法和质量必须分别验收，不能用模型自评分或换模型掩盖缺少阶段。

怎么验证：`.venv/bin/python -m pytest tests/director tests/test_tv_director.py tests/test_newapi_text_gateway.py -q`175通过（104基础+17旧Director+37执行+17网关）；`pnpm exec vitest run src/__tests__/director-execution.test.tsx src/__tests__/i18n/locales-json.test.ts`21通过；`pnpm build`、全仓ruff、前后端i18n、CE闭合11项、CE导入边界、禁用词/包名、gitleaks、diff检查通过；规格检查22反向变异通过仅说明规格。真实浏览器以实际组件/API/SQLite+合成模型验证预览→批准→候选→刷新、UNKNOWN不重发、保留结果只读，并检查1200/1920/375和浅色；临时HTML移除，自己启动的三个本机验收服务及浏览器已关闭，用户服务/数据不动。

用户追加必要真实模型授权后：首请求1.12秒UNKNOWN无回包立即停；只读模型列表对照True代理502空体/False直连200。代码修复后新批次3个独立意图经生产审批/派发路径用配置的V4-Flash返回：7.79/22.79/7.41秒，输入564/770/914 Token，输出414/728/181 Token，各一次、无重试、全为待审稿。合计3571 Token，不含未知首请求；金额未取得结算。原创两场161汉字但30秒未测；改编正文561汉字超450上限且新增年龄等未完整标记；改写场2逐字不变但犹豫动作发生时机不符。没有宣称质量全部通过或完整融合完成。

详细参数/回包位置、失败事实和下一阶段修复顺序见`docs/guides/tv-director/runtime-validation.md`。公开报告仅合成故事和安全指标，本地完整JSON/SQLite/截图在忽略的output/playwright；凭据与原稿未写入公开文档。没有提交、推送、部署或真实媒体调用。

范围与遗留：本轮是WP02–WP05的一部分执行基础，不是其全部（还缺正式v2正文/稳定ID/全部状态机/全局预算与人工对账）；写作仍单文档编译器，24方法包及全量UI/Skill/导演/全能/媒体链未接。下一步按交接摘要推进正文权威与阶段产物，不能再只改提示词声称融合到位。

### 2026-09-26 · WP00/WP01首批可执行基础校验（已写代码，尚未接入产品链路）

做了什么：新增8个Python源文件，定义strict/extra-forbid/camelCase wire合同及确定性守卫；F01/F03/F05/F11/F17/F19/F23/F27/F28九类合成fixture含58个正负变体，真实调用代码而非匹配文档编号。覆盖设定参数及来源逐项往返、稳定来源集号、读取覆盖与独立漏事件审计分开、强依赖修改全选/全拒、声画依赖图与资源冲突、UNKNOWN接单恢复决策、引用顺序/双编号命名空间、固定Skill版本回执、问卷版本与答案校验。补充时长实测证据必须绑定当前文档版本/语义hash；仅有模型的measured标记不放行。

为什么这么改：把反复返工中已确认的硬约束先变成能失败的函数与测试，避免换模型或增加提示词后同类错误重现。外部请求只收canonical camelCase，拒绝未知/错型/越界字段；素材展示顺序不受异步返回顺序影响，文本独立计数，图/音/视频共用mixed计数；供应商接单不明只返回人工核对，有taskId只查询原任务，不建议重建。

怎么验证：`.venv/bin/python -m pytest tests/test_tv_director.py tests/director/test_foundation.py -q`为**121 passed / 8 warnings**（104项新增基础测试＋17项既有Director；警告来自现有Starlette/Cognee/Pydantic依赖弃用）。`.venv/bin/ruff check src/novelvideo/director src/novelvideo/api/routes/director.py tests/test_tv_director.py tests/director/test_foundation.py`通过；仅格式化本轮9个Python文件。`python3 scripts/check_backend_i18n.py`通过、预算未增加；`.venv/bin/python scripts/lint_ce_imports.py`通过；`node docs/guides/tv-director/verify-spec.mjs --self-test`通过22组反向突变（这是单独规格检查，不把482个计划测试算通过）；定向gitleaks扫描director源和fixture目录均无泄漏。uv离线入口因沙箱缓存权限未启动，改用已安装.venv运行，未修改环境配置。最终diff/guard/handoff/release按仓库协议执行。

边界：纯函数返回的是校验结果/拟执行动作，**未接API/UI、未执行数据库原子CAS、未实现费用授权/outbox/实际重试，也没有实现完整阶段Skill执行器或语义抽取器**。时长artifact真实归属/内容与来源独立审计回执仍需宿主repository验证；时长结果不会宣称productionReady。未改旧models/store/writing/API/UI或用户数据；未发模型/LibTV请求，费用0；未提交推送。机器矩阵全场景状态继续not_implemented，不把九类fixture的局部守卫通过改成对应端到端通过。

下一步：按WP00/WP01补其余24类fixture及完整schema/命令注册，随后按WP02–WP05接入版本化持久化、原子状态转移、事件恢复和费用/outbox；先更新逐文件scope并preflight。旧常驻API/全量前端/真实质量与第二设备验收仍保留，不因基础测试通过关闭。

### 2026-09-25 · v2.1全量方案收口及可执行规格检查

做了什么：主方案/五份合同/历史开发§19.6已统一，修正K20删除与归档混用、Spec集数/AST/评审状态命名、源站旧N整类结论。九项研究增量迁入各自权威合同，新增F25–F33。新增implementation-closure.md的22个代码工作包、类型/严格命令守卫、迁移/回退与13项已决定差异；implementation-map.json逐项覆盖149动作+8能力、24方法、18规则、33转移、184语义命令/25运输入口/49字段词典，登记482个计划测试ID。source-inventory.json冻结24个short-drama文件hash和15条路由；用户源目录与安装副本24/24相同，空知识库未包装成已有案例。

为什么这么改：把“方案写过”变成可检查的逐项合同，避免遗漏入口、版本/状态漂移、源站失败被仿制、未执行测试被涂绿。源码位置是计划路径，不是实现声明；设计ready和产品not_implemented/resultRef=null分开；U01–U13各有独立决定/责任域/阶段/发布门，不再留“后续完善”行为空洞，也不假称原站未知已测。

怎么验证：node docs/guides/tv-director/verify-spec.mjs通过；--self-test拒绝22组缺项/断引用/假PASS/假来源等突变；node --check通过；git diff --check通过；gitleaks dir（专项合同目录/主方案/历史开发方案，--redact）无命中；agent_guard check为OK:18 workstreams/382 claims。check只读、不调用供应商，482用例是计划、不是本轮业务测试通过。业务pytest/build/UI/真实模型/物理设备未执行，现有业务diff保持不动；未提交/推送/付费生成。

下一步：按implementation-closure WP00+WP01写F01/F03/F05/F11/F17/F19/F23/F27/F28匿名case与strict schema负例，随后补齐33类，进入WP02–WP05持久化/状态/事件/费用安全门；精确认领后再写业务代码。完整产品仍待实施验收，研究事实与第二设备/真实质量等发布门未被这次设计收口伪造关闭。


### 2026-09-25 · 测试 Skill 删除与公开失效取证交接（未改业务）

研究线按用户精确许可删除自建合成“连续性清单”：delete HTTP200/code0，刷新私有列表保留另外两条；匿名公开详情两次HTTP200/code10051/data=null，页面失效。完整本机备份保留，源站没有可恢复承诺。开发§19.6及验收N08新增这条失败码夹具：按业务code解析，不能以HTTP200误判；整体删除与保留私有的独立撤回必须分开，不能推断样例直链或下载副本已销毁。聊天分享仍未撤销，物理第二设备未实测。62条离线证据断言不是本方产品验收；仅研究文档串行交接，不修改业务首切片或其他v2合同。

### 2026-09-25 · 授权后续轮实证移交（仅文档，未改业务）

研究线持同一唯一锁补充补证报告§13、分析§12.2、开发§19.6、验收§6：两集长稿正文完整流转且尾事实保留，但E10/E11仍逆序；对话提炼apply v1.0.0恢复，执行版本自述却称草稿；真已删节点返回C/A需按A/缺失/C重排；唯一H3请求5s768P16:9，实际5.167s1344×768；受理后断线恢复未重复create。预算/可见余额共130（正文60＋H3 70），不再自动收费补测。

分享实际上传整幅7节点快照且匿名可读，Skill发布/匿名源码可读；源站未见单独撤回/归档恢复，不可逆整体删除不冒充撤回。官方隔离MCP完成最小scope OAuth/48工具/read_project/refresh/revoke/旧token401，原生CLI和自然到期仍未通过。物理双设备等用户在第二设备改合成项目名；待办及副作用见研究台账，不以研究样例代替本方验收。

实现接手先加入sourceOrdinal顺序、manifest缺失补位、Skill引用revision/contentHash、目标/实际媒体参数、accepted断线与UNKNOWN分域、分享allowlist/revoke、private/public快照分离等确定性fixture，再按融合v2推进。其余四份专项合同及业务首切片均未改；本轮离线证据校验不是新增业务测试。最终guard/隐私检查在研究台账记录。

### 2026-09-25 · 研究线N01–N10实测交接（仅文档）

discovery持唯一锁串行更新共享验收合同§6、开发指南§19，新增证据链接`docs/guides/tv-director-liblib-gap-validation.md`。源站实测不是本方通过：5秒→6秒、720p工具请求→2K节点、强依赖改名可部分采纳形成混名、全能不能创建文本、Skill对话提炼失败/画布路径恢复均需加入反例。P0先冻结这些匿名fixture，P1实现参数回读一致性/依赖组原子提交/状态费用约束；别靠增加Skill警告或换模型重复生成。N08/N09公开发布及外部授权待许可，实际媒体/物理双设备未验。其他四份v2专项合同与首切片业务代码未改，研究证据32断言不能计入本方产品通过率。研究线收工后按正常acquire/preflight再开始实现。

### 2026-09-25 · 审核九项意见落实为融合v2

做了什么：主指南改为v2权威索引；新增feature-contracts、skill-contracts、workflow-contracts、document-semantics、acceptance-contracts五份细化规格。定义137个既有按钮、12个补充动作、8项完整能力；24方法包/4改编策略/18条件规则；唯一转移表与全阶段费用/UNKNOWN恢复；正文AST权威与语义失效、独立漏事件审计、依赖组部分采纳、稳定集ID和并行声画估时；24类正负例、12类×2次质量样本及10项待补实证。旧开发文档修正自动完稿、工具直写正式稿、时长简单求和、状态/API/Skill双规范、费用后置等冲突，未改原研究分析报告与其事实。

为什么这么改：审核指出的返工根因不是多加提示词就能解决，而是方法输入输出、正文/派生状态、审批/费用、部分采纳和验收不闭合。现在每类规则有一个权威落点，关键来源未知/未排演/评审不可用不再包装为PASS；末集收束和短篇规则有条件化，未实测LibTV行为仍列N及最小测试动作。

怎么验证：Node只读断言遍历7份方案文档，137既有按钮+12补充+8能力、24方法、18规则、24夹具、12质量组、10待证项各自编号唯一且齐全，failures=[]；相对链接、代码围栏、JSON示例及尾随空白检查通过，旧自动完稿/正文直提交/简单累加估时的代码片段断言不存在。`git diff --check`通过；`pre-commit run gitleaks --files`本轮12个文档/协调路径通过，另用`gitleaks dir --redact --no-banner`分别扫描五份合同目录、主指南和旧开发指南，均no leaks found（避免仅依赖Git钩子对未跟踪文件的覆盖）。`python3 scripts/agent_guard.py check`为OK:18 workstreams/374 claims。handoff/release在最后协调记录后执行。

本轮只有文档/台账/scope更新，没有修改业务代码、模型配置、源稿或Cookie，没有付费生成；因此未跑pytest/build/浏览器，不声称功能已通过。锁归属为codex/tv-director-plan-v2-20260925。下一步先把P0匿名F01–F24和schema做成可执行断言，再进入P1数据/费用/幂等；既有17项聚焦测试结果未收口和旧API问题仍未解决，不因文档修订抹掉。

### 2026-09-25 · short-drama × TV Director 融合方案补全

做了什么：新增 `docs/guides/tv-director-skill-fusion.md`，逐项对照本地 short-drama 原创/改编阶段与已取证的 LibTV 行为，明确证据等级、现有实现缺口、领域对象及不变量、两条状态机和人工门、来源事件覆盖、四方向改编、逐集时长/连续性/评审质量闸、Skill 运行合同、按钮→命令/API→测试矩阵、失败恢复、P0–P7 实施和退出门。特别注明本地 evolution 快照当前规则/案例均为零，隐藏私有 Skill 无法从输出唯一还原。

为什么这么做：当前写作服务只有一次模型调用和少量静态提示，尚未执行 Skill 的阶段方法；把运行链路成功误当质量合格，会重复出现30秒过密及EP02道具/时序返工。方案先固化可执行合同与反例夹具，后续按切片实施，不再仅靠改 prompt 或换模型。

怎么验证：对照两份 LibTV 报告、`short-drama/SKILL.md` 与对应 references、现有 Director API/UI；`python3 scripts/agent_guard.py preflight tv-director-implementation --owner codex/tv-director-v4-20260925 --path docs/guides/tv-director-skill-fusion.md` 通过；`git diff --check`、新文档尾随空白检查、`python3 scripts/agent_guard.py check`（18 workstreams/366 claims）通过。本轮只改方案/台账/scope，没有业务代码或付费生成；故不把方案标为功能已实现。

下一步：先冻结三个黄金夹具与匿名硬断言（1×30秒、2×30秒、EP02），再按指南 P1 schema/迁移和 P2 状态机进入业务实现；每片另行 preflight、测试与浏览器验证。

### 2026-09-25 · V4-Flash 模型合同与真实原创链路

做了什么：定位旧 502 为本机 loopback 请求继承代理环境，忽略的本机 `local.env` 已显式设置 `NEWAPI_TEXT_TRUST_ENV=false` 与 `SILICONFLOW_TEXT_MODEL=deepseek-ai/DeepSeek-V4-Flash`，未写入凭据。Director 服务端增加本机固定网关模型合同：预览和执行均解析为真实模型，明确选错时在调用前拒绝；页面展示真实模型，本机固定时不可在设定器改写。运行记录新增冻结参数、提示词字数及输出 SHA-256/字数（完整正文仍在对应待审变更，不复制凭据到台账），既有 SQLite runs 表按缺失列增量迁移。清理 V4 偶发输出开头的思考标签。

为什么这么做：固定模型路由会覆盖请求里的 `model`，若只让用户在界面填模型名，会产生预览与真实扣费模型错配；首轮真实大纲还暴露“30 秒内容过密、单集完结却留续集伏笔”，不能把技术链路成功等同内容质量通过。记录参数和响应摘要用于追查，不把可识别原稿或密钥写入公开台账。

怎么验证：通过本机网关的最小 V4-Flash 请求返回 200/模型 ID `deepseek-ai/DeepSeek-V4-Flash`；合成原创样例经浏览器生成故事大纲、接受版本 1、刷新持久；再以服务端预览的 `episode-001`、大纲版本 1、30 秒和精确 V4 模型调用，运行 completed、输出 1497 字，待审接受后分集文档版本 1，SQLite 记录的 request/response 字段可读。定稿前警告指出时长未经试读/分镜和连续性需人工复核；因实际内容仍显著超出 30 秒可拍容量，未勾选人工复核，也未定稿。`ruff`、`pnpm build`、前端 i18n 与 `git diff --check` 通过。聚焦测试第一次新合同断言发现测试构造缺 `mode`，已修；随后 17 项中的前 15 项通过，但本机 pytest 对异步用例前的导入/收集耗时异常，完整结果仍在隔离复核，不能写已通过。所有浏览器付费操作仅用于合成测试作品，未操作第三方项目。

与目标的差距：本次验证的是原创大纲→单集草稿，不是《非妖哉》改编，也不是 LibTV 全量等价。多轮对话、四类改编硬约束、差异块接受、真实 Skill 生命周期、导演画布/媒体事务及内容时长实测仍缺；页面虽有部分外形，不应称为“跟 Liblib.tv 一样”。

### 2026-09-25 · 首切片实现与本机验收

做了什么：新增项目内独立 Director 域、SQLite 版本化作品/文档/待审变更/事件/运行记录、冻结参数的写作编译器与 API；新增独立画布式剧本节点、右侧浮窗、Top8 双栏设定器、五类文档编辑、草稿审批、发送前参数/未知费用确认和定稿前质量报告。设定由服务端修订号 CAS 保存；产生正式文档、待审稿或成功/运行中模型记录后冻结，失败调用允许修复模型名。来源集号、交付集号与工作流序号分开存储。旧 story/freezone 页面未改。

为什么这么做：UI 参数须对应实际提交，不能仅留在前端；模型输出须先进入待审稿，不能覆盖正式文本；定稿须由人工确认，且模型不能自称已测时长/连续性。两次上游 502 后停止付费试错，保留失败运行供诊断，不宣称联机出稿成功。

怎么验证：`uv run pytest tests/test_tv_director.py -q` 为 16 passed；`uv run ruff check src/novelvideo/director src/novelvideo/api/routes/director.py tests/test_tv_director.py`、`python3 scripts/check_frontend_i18n.py`、`git diff --check` 均通过；`cd frontend && pnpm build` 通过。全量前端测试首次揭示本线越南语两个翻译键误入 ingest，已移回 director；`pnpm exec vitest run src/__tests__/i18n/locales-json.test.ts` 12 passed。最终 `pnpm exec vitest run` 为 430 files/3153 tests passed，3 files/7 tests failed，分别是未改动路径的 local-storage-quota 5 项、canvas prompt-mention 1 项和 ingest 1 项；不能据此宣称全量门通过，也未在本线修改这些路径。浏览器在 1200×863 和 1920×1080 核验了新建作品、设定修改/刷新保留、手工正文 v1→待审→接受 v2、已定稿作品只读、质量确认弹窗；一次合成作品手工定稿，另一次质量弹窗只验证后取消。实际调用分别以 `DC-content-rewriter-LLM` 和 `DC-freezone-story-script-writer-LLM` 送达网关，均收到空体 502，未生成待审稿、费用是否产生不可确认。

与目标的差距：这只是可用的第一个端到端切片，尚非完整 LibTV TV Director。未做实时多轮对话、来源事件映射/改编四方向硬校验、逐 hunk 差异、可执行 Skill 管理/自测、导演角色与画布事务、媒体生成及费用账本；第三方私有 Skill 无法仅凭界面反推。页面目前只展示独立方法包版本，不应称作原站同款 Skill。

### 2026-09-25 · 方案门与只读取证

做了什么：核对 STATE/Git/guard，浏览器只读确认现存项目中的剧本节点与右浮窗；读取 `short-drama` 方法中的事件覆盖、改编、单集、可拍性和反转规则，确定只取阶段方法与质量门，不把 50–100 集经验写成产品强制值。

为什么这么做：原有四阶段故事工作台与镜头表节点的语义均不等价于 TV Director；独立域可保护旧功能，并让新参数/版本/审阅合同可验收。

怎么验证：`agent_guard.py check` 为 `OK: 17 workstreams, 348 claims`，`status` 无活动锁；Playwright 登录态成功加载且只读页面显示剧本节点/浮窗，无付费操作。业务实现尚未开始，测试待跑。

## 已定下来的决策

- 新 UI/业务域独立；仅复用项目权限、模型网关、画布技术和导入边界，不改旧“虾本”体验。
- Skill 方法包必须版本化，关键事件与原稿行号相连；场次时长未实测只能标估算。
- 作品、文档审阅、费用审批分开；草稿接受不等于定稿，也不等于同意生成媒体。

## 2026-09-25 根因审计：不再用换模型掩盖方法缺口

- **已证实的传输问题**：旧 502 来自本机 loopback HTTP 继承代理；本地网关强制覆盖 `model`。前者已用本机环境修复，后者已由服务端模型合同在调用前校验。V4-Flash 真实请求返回与作品预览一致，所以这轮低质量不能归因于“模型没被调用”。
- **主要方法问题**：当前 `writing.py` 只摘取了 `short-drama` 的场次目标/阻力/动作/结果与不冒充实测时长等几条静态原则，未实现其 `/events → /skeleton → /adaptation → /episode → /review` 阶段路由、事件覆盖、逐场时长复核。该 Skill 默认面向 50–100 集，不能原封套到一集 30 秒；项目参数优先。`METHOD_VERSION` 是我们自建提示词版本，并非 LibTV 私有 Skill，也不是把本地 Skill 全部执行了。
- **观测与推断边界**：LibTV 研究证实方向问卷、总纲审批、每集单独费用确认、`review_episode` 及其可能 `skipped`、差异采纳和状态恢复；其隐藏系统提示词/Skill 全文不可从输出唯一反推。我们能复刻的是可观察合同和可测行为，不能把一次生成结果当内部源码。
- **本轮质量失败证据**：一集 30 秒的 V4 大纲引入过多动作且同时写“单集完结/续集接口”；第 1 集将至少 5/6/4 条动作分别塞入 6/9/15 秒，1497 字正文未按台词、行动、停顿、转场逐项估时。模型遵守了四个核心事件和“不要叮声”，说明基础指令跟随正常；缺的是生成前的容量预算、生成后的独立评审/限次修订，而不是简单换 V3.2。
- **纠偏顺序**：先冻结原创 1×30 秒、原创 2×30 秒和有来源 EP02 的 golden fixtures 与人工判据；再建版本化阶段产物（来源事件图、方向确认、每集 beat/场次预算）及服务端硬/软校验；输出未过门时明确标记评审失败，最多在已批准预算内限次修订，人工可看 diff 后采纳。最后在同一 fixture 下 A/B 比较 V4-Flash 与 V3.2。未建立这些门之前，不继续靠增加泛化提示词或重做 UI 宣称质量改善。

## 待办

- [x] 首次原创发送不再停在“创作中”或费用确认：隔离项目真实Seed新会话单动作启动、可读方向逐段显示、成功停在人工方向关口；已知格式失败保留并只在明确继续后单次修正。
- [ ] 对照原站三页问卷，核定哪些信息由已确认设定直接读取、哪些必须问用户；本地六个动态追问是否必要逐题审核，再做同内容视觉/交互验收。本项不因流式接通而自动完成。
- [x] 首功能内来源冻结/独立核对、新合同编译、局部patch/组合审阅事务、真实正文流和最新手编版本读取已接；短概要浏览器实际采纳/撤回/自动保存/刷新通过，不等同完整S1。
- [ ] 先收束新链S1：末轮Seed独立核对的全部格式/覆盖通过，补正文排版/目录/工具栏同内容逐状态对照，重审陈旧规格引用，再验常规入口开关与历史v2显式转换；禁止先切第二功能或把隔离测试当已上线。

- [x] 首功能内B00/B01匿名反例、五节严格合同/三语AST/显式分派/旧v2兼容与实际富文本展示：74新增后端、4新增组件通过，完整大纲S1未验收。
- [x] 按最新仅 Seed 双站实测写代码级方案：五节交付、来源事实、局部 patch/部分审阅、组合核对、UI/流/预算/迁移；见 `seed-outline-parity-implementation.md`。仅文档交付，不代表新功能上线。
- [ ] 确认新方案的 API/数据库/保存语义后，按 B00–B11 逐批实施并完成 T01–T33/V01–V10；先匿名失败夹具及五节合同，再真实 Seed ↔ Seed 闭环；不新增 DeepSeek 横测，不绕过未知费用/来源门。
- [x] 自动保存/编辑聊天共存/离开前flush/冲突备份；三媒体菜单到真实目录/幂等意图/确认/任务结果；独立人物场景高风险来源门与4笔回包。598后端/219前端/build，见interaction-closure.md。
- [x] 批量图片规划→明确审批→持久画布节点/结果/拖动恢复；独立M12全段事实清单、全部已写前集、逐字证据和人工核对，正反真实模型留证；整页像素计算与失败定位已接通。620后端/225前端/build，见batch-facts-pixels.md。
- [ ] 本轮未通过的验收：完整页同内容/全状态像素（当前1920全页14.6060%差异）；长篇跨块事实审查、模型逐原子语义召回与物件状态图；场景同址跨集正常生成/M08筹备事实门、多会话媒体关联、实际图片质量。已有失败不得勾成完整目标，下一动作见batch-facts-pixels §7。

- [x] 分集七项/梗概/场次对白方法、M11 2.2.0/六参考、真模型流/持久游标恢复、浮窗与编辑器/场次目录/继续打磨/停止；569后端/77前端/build，真实三例完整留证，局部修改逐字正确。
- [ ] 分集文学对齐仍未完成：M12已用跨集手机/确认单/新增文件夹最小正反例接通完整段落审查和人工核对，语义漏判及负例无效引证仍在；不被七项齐全或9/9覆盖抵销。完整M10/结构化所有历史集物件状态图/超长分块/逐处修改差异仍未实现，不重买旧稿。

- [x] 道具五项合同、两入口/三语投影/旧稿兼容、M08 2.4.0方法分路、M11读取正式道具及旧授权失效、局部布局/保存引用/候选采纳刷新闭环；555后端/71前端/build，三份真实参数与回包保留。
- [ ] 道具事实门：以物件ID绑定有来源的持有/所有权/位置/流转/使用完成状态及屏幕呈现范围，人工确认未知项；补放桌上≠归还、持钥匙≠拥有锁盒、递送画≠递送信正反例，再验证跨字段投影。三份schema通过不冲销两份语义漂移；源站自动保存/聊天覆盖与本地方显式保存/模态、媒体操作尚不同，见prop-parity.md。
- [x] 场景五项合同、两入口/三语投影/旧稿兼容、M08按文档方法分路、M11场景消费、局部UI与完整场景生成交互；523后端/69前端/build，5笔真实请求留证。
- [ ] 场景事实门：场所清单/实景或画中或提及/内外类型与原子动作绑定来源及人工确认；2.3.1仍有类型unknown和新增动作。模态、保存语义与媒体操作差异见scene-parity.md，不能称完全等价。
- [x] 人物M08两入口统一、主次/12类适用要素/旧稿兼容、M11读取保存人物、局部节点/编辑器布局与三视口操作；491后端/67定向前端/build通过，3笔真实输出完整留证。
- [ ] 人物事实门：将称谓推年龄、职务推称呼、未呈现受压行为与关系丢投影做正反例并接用户确认的原子事实；本轮职场/改编未过，不能以schema或提示词规则宣称文学质量等价。模态编辑/保存栏/角色图链与源站的操作差异亦未消除，见character-parity.md。
- [x] M07故事大纲十类要素、short-drama方法根基、两入口统一合同/三语言投影、时长由用户决定；427后端/64前端/build通过，真实两笔失败和成功格式均留证。
- [x] 冻结五套多题材、非30秒单多集判据并实测；14次本方请求及一个LibTV完整大纲对照留证，失败均未删除，实验提示未晋级。
- [x] 已保存大纲独立证据审查接入、单独费用批准及失效合同；6次真实同稿审查留证，实验模板冲突消除，漏判明确展示；454后端/78前端及浏览器链路通过。
- [ ] 文学门仍未通过：本轮6次均漏判，按literary-benchmark §9.5补原子事实人工确认/正反例集与方向到大纲一致性，再做受控评审模型对照；引用证据入口不等于可靠事实门。两阶段创作仍只为诊断；M10完整容量、来源审计和完整24份/真人盲评未完成。
- [x] UI首批：原站36 SVG/14公共题材图本地固定、核心浮窗/设定器/参数/节点/三视口操作回归；49定向测试和build通过，具体边界见ui-parity.md。
- [x] UI第二批：设置/历史布局与真实命令、富文本工具栏/源码保底、完整Top8/自定义题材/21画风、单文档画布/文本附件/实际模型菜单/方向问卷分页；68前端/357后端与build通过，局部几何和三视口实点见ui-parity.md。
- [ ] UI剩余：E22–E31稳定选区/逐处差异、改编专用面板、全运行/审批态、Skill库/导演角色/媒体素材/分享插件、自动策略/跨设备、应用壳/Windows与全页像素验收；发布前核验素材使用权。
- [x] 完成首切片 API、存储、前端与聚焦测试。
- [x] 查明文本模型网关 502 并以 V4-Flash 对原创大纲/分集各跑一例，确认返回待审稿、接受后持久化。
- [ ] 用用户提供的《非妖哉》EP02 原稿跑改编端到端；生成前需检查来源和用户授权的费用/资料范围，保留源集号与交付集号证据。
- [x] 按九项审核意见修订融合v2：五份专项合同、完整按钮/方法/状态/语义/验收与旧设计冲突收口；仅文档完成，不代表功能通过。
- [x] v2.1设计收口：149动作/24方法/18规则/33转移/33类fixture逐项追踪、24源文件hash、22工作包与13差异决定；规格检查及22组反向突变通过。
- [x] WP00/WP01首批九类匿名fixture与strict合同/确定性守卫：104项新测试及17项旧Director测试通过；仅基础切片，未接API/UI/事务/费用，九类完整端到端仍未验收。
- [x] WP02–WP05首批安全执行接入：持久批准/派发/费用未知/任务恢复/保留结果、API与页面；37项故障/事务回归、9组件与12翻译测试通过。不是完整P1。
- [x] 真实V4-Flash原创/改编/定向修改3例，参数/完整输出与质量失败保留；loopback代理默认修复、17网关测试通过。
- [ ] 按融合v2.1 WP00–WP21完成匿名可执行fixture、严格schema及P1费用/幂等/正文权威，再实施阶段方法、完整UI、Skill/全能/导演/媒体并逐项验收。
- [ ] 清理或归档本机合成测试作品前先核对其无用户资料；不要以删除项目数据作为自动收尾。

## 阻塞

当前无外部阻塞；用户已批准方案并要求逐功能块实施。来源、新模型编译、分组审阅/独立核对/流已在隔离新链接通，802后端/113前端/build通过，但整页像素、常规入口发布/旧稿转换、多题材文学与长篇跨块仍未闭合。代码默认开关未发布，不得将隔离通过称为常驻项目已更新。旧文学FAIL、物理第二设备和素材发布许可欠项不变；UNKNOWN未结算不重发。规格源码指纹/行号陈旧需逐项重审，不能更新hash就宣称产品PASS。

## 交接摘要

- **最后完成到**：main213854b5加本线新旧dirty；第一功能已接真实新链，隔离稿v1采纳/v2部分接受/v3手编刷新，末次单处patch正确。另已修复当前常驻栈的首次原创发送/方向流：真实Seed新会话一次发送直达4方向/6追问，失败留存后一次明确修正也通过。Director后端780、定向前端50及build通过。仍未签S1完整验收、未提交推送。
- **下一步唯一动作**：先按本轮最新进展核对原站三页方向问卷与本地七页的逐题语义，再读outline-delivery-progress最新模型收尾结果及私有run-02 manifest，不从零重抽来源。继承现有候选/版本完成S1；零费用改`outline_delivery.py`投影与审阅目录/工具栏，冻结同内容像素样本再实测，保留历史AST不静默替换。源码新鲜度/常规默认/历史转换门通过前保持隔离开关，不进入第二功能；本地只用Seed对原站Seed。
- **先读这些文件**：本台账最新进展、`full-replication-plan.md`§16和`plan-closure.json`对应审计组、Seed代码级指南B00与§2源码。S0–S10/policy为当前权威，旧WP为历史分解；人物场景道具分集、自动保存、批量媒体和M12历史失败仍保留，不能因大纲新方案而删除。
- **不要动这些文件 / 决策**：现有 story/freezone/canvas 业务代码、用户源稿、研究 Cookie。

### 2026-09-28 · 连线配色串行协调

既有 DESIGN 内容先保留，canvas-lod-perf 后续仅补用户指定的 LibTV 连线三色与流星说明，由 codex/edge-meteor-20260928 串行集成；不改变本线视觉或接口。

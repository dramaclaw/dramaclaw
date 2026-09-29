# TV Director 全功能复刻实施总案

2026-09-27 · 方案收口 r2（来源补证、157项当前代码审计及实施绑定） · 代码基线 `213854b5` + 当前未提交 Director 增量。

本文是**产品闭环、实施顺序和新增差异的总入口**，不是“已完成复刻”的验收报告。目标是独立实现 LibTV 可观察的界面、交互、交付文档和创作流程；以 short-drama 为创作方法基础，以实测差异改良方法，而不是取得或冒称取得 LibTV 私有系统提示词。生成文学质量以同题真实模型对照衡量，不能保证每次逐字相同。

本轮范围：新链接的实际 UI/普通业务请求、现有证据复核、当前代码只读审计、完整方案。没有改业务代码，没有新增生成、发布、插件授权或付费批准。入口自动复制了一个模板项目；没有改原模板和用户成品。取证账号、项目 ID、完整第三方正文、原始返回只留本机忽略目录，不进入本文件。

上述为原取证轮范围。r1仅修文档；r2按用户要求重新进入研究副本补测，记录203条HTTP、312条WS、21个UI检查点。E08顶部全能创作触发了真实文本续创、规划保存和15个图片预览，报价225积分后已取消；没有批准媒体生成。两轮范围不可混写为“从未生成”。本轮新增事实、请求字段、源码审计和限制见§16；未改业务代码或全局技能，没有本地模型调用，不抹掉历史产品失败。

## 1. 先明确目标与返工根因

### 1.1 六条独立验收线

1. 功能：全能创作、原创、故事改编、导演执导，以及 Skill/角色、设置/历史/分享/插件、媒体/导出，均有可用闭环；不是只实现大纲。
2. 操作：入口、按钮位置、分层菜单、询问与确认、局部修改、定稿后续集、编辑与聊天并存、关闭与停止区别，都逐状态对照。
3. 文档：故事大纲、人物小传、场景设计、道具设计、分集剧本的结构与要素符合该交付格式；不能仅把 JSON 键翻成中文标题。
4. 技能：short-drama 的方法实际加载进运行时，有版本、输入、规则选择和输出凭证；不是在 README 写“已融合”。
5. 质量：来源保真、因果、人物、可拍性、对白、节奏、情绪兑现分别过关；结构通过不能抵销内容失败。
6. 工程：保存、版本、恢复、素材顺序、预算与费用、并发和权限正确；模型说“已保存/已定稿”不算系统事实。

### 1.2 已有证据支持的根因，而非一概归咎模型

| 现象 | 应定位的层 | 根治，不再补一句提示词 |
|---|---|---|
| 同样输入反复改变大纲标题/漏栏目 | 交付合同、解析器、渲染器 | 冻结格式版本，严格校验，再确定性渲染 |
| 未确认年龄、称呼、因果被写成事实 | 来源证据、授权边界、方法 | 区分原文/用户确认/创作建议/未知；关键冲突阻断，而非结尾免责 |
| 只给一种题材越调越偏 | 规则适用条件、样本集 | 一次变更绑定失败样本，同时跑保持集；不得把《入画》人名写进通用技能 |
| UI 有按钮但一点击退回预设或无响应 | 状态模型、接线 | 会话/作品/输入草稿/视图分离，按钮对应确定命令 |
| 提示词改好了，继续却用旧稿 | 文档版本与上下文 | 每轮冻结版本/hash；正文编辑使旧语义图、评审和下游失效 |
| 收到流式文字就显示成功 | 事件投影、质量门 | 流式候选不等于已交付，只有宿主 receipt 能提交状态 |
| 一天都在重新生成大纲 | 缺最小闭环与回归纪律 | 先打通同一份作品的“创建→修改→接受→定稿→下一步”，逐层改错，不重开一切 |

换模型可以是对照变量，但不能修复上述状态、格式、事务问题。按用户最新要求，主验证模型固定 **Seed**；不再默认并行调用本地 DeepSeek 来解释失败。

## 2. 文档权威与冲突处理

避免再出现十份方案各自定义一套行为。后续代理按下面顺序读，不无目的加载所有报告。

| 文档 | 唯一职责 |
|---|---|
| 本文 | 全产品边界、这次新增证据、冲突决策、实施切片和总验收 |
| [功能合同](feature-contracts.md) | 149 个动作、8 项能力的原子前提/命令/结果/失败合同 |
| [追踪表](implementation-map.json) | ID→组件/用例/schema/测试/证据映射；`not_implemented` 不因本文存在而改成完成 |
| [当前收口审计](plan-closure.json) | 全157项→来源包/覆盖限制→22组真实代码符号及hash→已有测试定义→实施动作→阶段验收；不是测试结果 |
| [工作流合同](workflow-contracts.md) | 状态、命令、问卷、费用、幂等与恢复 |
| [语义合同](document-semantics.md) | AST 正文权威、来源证据、跨集连续性、关联修改、时长 |
| [技能合同](skill-contracts.md) | M01–M24 方法、G01–G18 条件规则与运行凭证 |
| [验收合同](acceptance-contracts.md) | 既有 fixture、负例和功能/质量/恢复门 |
| [验收配置](acceptance-policy.json) | 唯一视觉数值、质量模型/尺度/样本层级、文档生命周期和S阶段依赖；不得在别处重定义 |
| [Seed 大纲代码级方案](seed-outline-parity-implementation.md) | 来源声明、五节改编大纲、编译器、局部 patch、模型预算的具体代码设计 |
| [原实测分析](../liblib-tv-director-analysis.md)、[补证](../tv-director-liblib-gap-validation.md) | 源站观察事实及失败，不被我方设计覆盖 |
| [既有收口审计](implementation-closure.md) | 历史 WP 缺口；不能代替当前工作区审计 |

### 2.1 实施前必须解决的四个规格冲突

**D01 方法编号不再漂移。** 技能合同 M13 是 `revision-impact`，M14 是 `local-revision`，M15 是 `linked-revision`。大纲专项旧“M13 大纲修改”称谓已修正为影响分析后进入M14/M15，不能另建同号方法包；历史引用保留，实际包绑定仍在代码阶段验证。

**D02 不设无依据的创作硬上限。** 老合同的 1–100 集、默认 20 等是来源观察或旧设计，不再作为本产品永久约束。集数/时长由用户决定；使用正数、有限值、合理精度等输入合法性检查。大项目按分页规划、分集运行、资源预算拆分；技术容量不足给明确方案，不悄悄缩短故事。媒体供应商单段时长限制另行显示，不能限制文学剧本。

**D03 不把一个样本当所有模式的格式。** 新模板大纲九栏目，既有《入画》改编样本五节；这证明存在不同交付形态，**不能证明全部原创固定九栏、全部改编固定五栏**。已有文档保留原 `documentContractVersion`；新建采用经证据确认的产品 profile，并在首个对照样本核验。缺信息不能退化成模型自由换格式。

**D04 已实现的可靠部件保留。** 产品体验以 LibTV 为基准，不受旧 UI 限制；工程上保留已经测试的 CAS、执行账本、AST、引用编译器等，不另起第二套数据库/正文。产品“重新做一样的”不意味着删除这些能力再造一次。

上述是产品设计决策，不代表代码实现。r2已将157项当前代码/来源/测试定义审计落到plan-closure.json，并修正历史WP固定集数和M01/M02不分范围全链调用的歧义。S0开发入口仍须把B00失败样本变成可执行产品断言；不能把文档校验或源码存在当产品验收。新增冲突以对应权威文件修正并保留历史记录，不再平行定义。

## 3. 本次新入口取证

### 3.1 证据口径

来源为用户本轮提供的 [LibTV 画布入口](https://www.liblib.tv/canvas)。原参数链接由用户消息保留，不在公开仓库复制私人项目定位信息。Playwright 已加载本机登录态后访问；固定 1440×900 CSS px；原始截图、DOM 可访问树、computed style、脱敏 HTTP 参数与回包位于本机忽略目录 `output/playwright/liblib-tv-director/full-plan-20260927/`。

证据类型：`F`=本轮直接观察；`H`=既有报告中的历史实测；`P`=我方设计；`U`=尚不能确认。不能拿 H 冒充今天重新跑过，不能拿 P 冒充源站行为。

| ID | 本轮动作 / 事实 F | 证据文件或录制标签 | 实施影响 |
|---|---|---|---|
| FP01 | 模板入口自动创建副本，副本带完整剧本节点 | `01-entry.md/png`、HTTP 1 | “打开模板”可能写项目；只执行一次，不反复访问创建副本 |
| FP02 | 主菜单：全能创作、剧本创编、导演执导；创编子菜单原创/改编 | `02-modes.md/png` | 四种实际模式，不是两个文本开关 |
| FP03 | 原创欢迎 Top8；单题材圆、融合双圆、六卡 | `03-preset.md/png`、`06-fusion` | 模式欢迎区、配置弹层和发送输入分别实现 |
| FP04 | 添加融合默认出现第二题材；取消再打开回到单题材 | `06-fusion`、`08-preset-cancel-reopen` | 弹层必须编辑副本；取消不是保存 |
| FP05 | 六卡有各自选项、数量提示、搜索/自定义 | `04-structure`、`preset-*` | 配置化字段，不共用一个无约束字符串数组 |
| FP06 | 全能欢迎四入口及 Skill 按钮；模式切换保留节点 chip | `09-omni` | 选择模式不能清空用户上下文 |
| FP07 | Skill 筛选有全部、通用、收藏、我的；创建菜单有对话创建/导入 | `11-skills-loaded`、`12-skill-create` | 旧“三 tab”描述需增补“全部”筛选，不重复发明生命周期 |
| FP08 | 导演欢迎自动角色、优化镜头语言、一句话生成分镜；无手动生成按钮 | `15-directors-loaded` | 角色≠模型；费用门不能因按钮隐藏而消失 |
| FP09 | 文本模型菜单 Seed Evolving / DeepSeek V4 Pro，当前 Seed | `14-models` | 我方对照仅固定 Seed；同显示名不证明相同后端版本/采样配置 |
| FP10 | 改编设定是小浮层：浓缩、扩写、强化冲突、强化钩子，集数输入/滑杆 | `30-adapt-preset-ready` | 不套用原创大弹窗；源站当次 min2/max100，当前值100，不推断新用户默认值 |
| FP11 | 全局默认自动生成、预算提醒、通知/声音；新会话默认与当前会话区分 | `19-settings.md`、`19-settings-loaded` | 提醒阈值不是费用硬授权；本轮未改设置 |
| FP12 | 人物、场景、道具、分集四页字段已逐页读取 | `25-characters-ready`、`26-scenes-ready`、`27-props-ready`、`28-episode-ready` | §5 定义要素与条件字段，不能补造未知事实凑齐 |
| FP13 | 媒体下拉三项：角色图/场景图/道具图 | `29-media-menu-ready` | 图按钮各有目标实体与输入版本，不只是改按钮字样 |
| FP14 | 全屏编辑器与聊天同时存在；撤销重做、缩放、格式、目录、关闭 | `22-editor.md`、`22-editor-loaded` | 两者不是互斥页面，聊天状态跨开关保持 |
| FP15 | 关闭编辑器后可停靠聊天；悬浮卡一度遮挡点击，关闭后复验 | `23-docked` 及 CLI 失败记录 | 自动化不可 force 穿透假装操作通过；浮层栈/焦点要测 |

本轮保留自动化定位/遮挡失败：早期 Escape 关闭了聊天导致后续定位失败；旋转题材列表中非当前可点击项被容器遮挡；编辑器关闭后 HoverCard 遮挡停靠按钮。题材轮转未计通过，其余恢复界面后复验。`10-skills`、`17-adapt-preset`、`18-settings`、`20-media-menu`、`21-editor` 及初次 `doc-*` 抓取存在加载/切换中间态，静态验收使用 loaded/ready 补采版本，不把过渡帧当像素基线。验证脚本首先暴露了该采集时序问题，随后按明确标题/菜单可见条件重采，而非放宽断言。

### 3.2 真正捕获的请求与返回形状

公共摘要只列字段，不列用户 ID、正文、Cookie、签名地址。记录由正常 UI 触发，不用猜测内部端点发写请求。

| 请求 | 输入字段 | 当次返回 | 证明 / 不证明 |
|---|---|---|---|
| POST `/api/canvas/project/copy-project` | sourceProjectUuid, sourceSpaceId | HTTP200/code0；targetProjectUuid,targetSpaceId,config,folder,projectList,projectDetail 等 | 复制入口确实写副本；不是只读跳转 |
| POST `/api/canvas/folder/vfs/read` | projectSpaceId,path | code0；name,path,content,size,projectSpaceId | 文档正文来自 VFS；不证明我方必须使用同文件后端 |
| POST `/api/skill/biz/list` | bizType,page,pageSize | code0；list,total,hasMore | 目录分页；不证明获得内置 Skill 完整方法正文 |
| POST `/api/canvas/user-config/get` | 空对象 | code0；config | 读取配置；本轮未测写入 |
| POST `/api/canvas/folder/vfs/script/diff` | projectSpaceId,workKey | code0；pairs,total | 编辑器读取差异入口；本轮未创建新差异 |
| POST `/api/canvas/project/draft/update` | projectUuid,viewportX/Y/Zoom,draftJson,sessionId,timestamp | code0 | 画布草稿保存；**不是剧本文字自动保存证据** |

原始归档 `evidence.json` 配 `evidence-index.json` 的 SHA-256、`verify-evidence.mjs` 断言结果。此次没有聊天发送，WS 捕获为0；这是实际范围，不伪造本次流式工具链。历史聊天、定稿、两集正文、局部改稿、Skill 创建复用、H3 请求/响应与付费见补证报告。

最终归档188条HTTP、35组UI记录（含保留的中间态与ready补采）；29项证据/文档一致性断言通过。三个Python骨架通过语法解析，JSON示例可解析；相对链接/围栏/空白检查及定向gitleaks通过。以上不等于产品功能、真实生成质量或像素差异已通过。本轮无业务改动，未跑业务pytest/build。

### 3.3 明确保留的历史失败与未知

- H：源站曾出现审稿 JSON 无效却仍交付、改名只采纳部分文件导致混名、全部接受的多请求部分成功。这些是负例，不应忠实复制成我方 bug。
- H：实际媒体请求与最终节点参数曾不一致。requested/providerEcho/observed 必须分开记录，不能只相信 UI 或代理文字。
- H：已有两集顺序写作/确认以及一次授权 H3 受理后断线恢复证据；不能重复扣费重新“发现”相同行为。
- U：私有内置 Skill 全文、后台模型实际权重/路由、无限题材同质量、物理第二设备恢复、分享独立撤回等仍不能因 UI 调研宣布已证实。未知不妨碍定义独立实现及其验收，但必须标明我方合同。

## 4. 完整功能边界：不能再漏掉截图里的入口

以下是总验收分组，原子按钮规则以功能合同对应 ID 为准，全部纳入追踪，不以本表替代细表。

| 功能面 | 必须包含的入口与行为 | 动作 ID / 能力 |
|---|---|---|
| 画布/剧本节点 | 点阵背景、缩放/移动、节点选择/连接、左目录右正文、浮动动作条、编辑、角色/场景/道具图、全能引用、下载 | E01–E09、C01/C04/C08 |
| 聊天壳 | 标题、新建、历史、分享、全局设置、插件、浮窗/停靠、八向调整、关闭与通知引导 | A01–A13、X01/X02/X11、C05/C07 |
| 输入与模式 | 富文本/粘贴、附件、@ 节点资源、chip、四模式二级菜单、模型、Skill、手动/自动、发送/停止、上下文与工具进度 | A14–A26、C01/C05 |
| 原创 | Top8、显示开关、15题材/其他、融合与去重、六卡、自动值、自定义、画风图、取消/确认/重开 | O01–O16、X03/X04 |
| 改编 | 上传来源、四策略、集数、保留项、原作集号与交付集号、删除来源/设定分别处理 | D01–D09、C05 |
| 问卷与费用 | 单选/多选/自由输入、上下一题、继续/提交/忽略、已答卡、报价批准/拒绝、当前会话自动批准 | Q01–Q09、S01–S07、X12 |
| 文档编辑/修订 | 五类目录、场次锚点、富文本格式、缩放、撤销重做、自动保存、选区改写、聊天并存、差异逐处/逐节、全部接受/撤回、冲突 | E10–E32、X05–X07 |
| 导演 | 自动与六类导演、我的导演、定位问卷、创建/导入/编辑/复用、镜头优化、分镜、候选采用 | R01–R18、C03/C06 |
| Skill | 全部/通用/收藏/我的、搜索、详情/案例、添加、五种创建意图、导入、编辑/应用/另存、真实自测、分享/发布/撤回/删除、版本 | K01–K20、X10/X11、C06 |
| 全能与媒体 | 感知画布、任务拆解、工具与节点生成、批量规划/审批/执行/失败单项恢复、稳定引用顺序 | X09、C01–C04 |
| 导出与跨设备 | 部分集/全稿、版本 manifest、缺失媒体、相对路径、Windows 文件名、无密钥默认导出、导入冲突映射 | X08、C08 |

画布中的素材库、角色造型室、生成历史等是集成依赖，不再在 Director 内重造重复资产系统；接入真实端口并提供正确返回焦点、选中资源和版本。完整产品验收必须验证接入，不能以“归其他模块”删掉用户可见流程。

### 4.1 六卡参数与三层状态

| 界面参数 | 本轮观察 | 我方唯一提交来源 |
|---|---|---|
| 主/融合题材 | 15类别，其他自填；主辅不能重复 | genres.mainId/fusionId/customText |
| 目标受众 | 男频/女频/泛人群/出海/银发/其他；至多2 | audience.ids/customText |
| 角色设定 | 26可见项（含其他）；至多5 | characterSetup.ids/customText |
| 时代背景 | 10可见项（含其他）；至多2 | era.ids/customText |
| 核心看点 | 31可见项；至多3 | highlights.ids/customText |
| 画风 | 单选、搜索、自定义、参考图分支见历史证据 | visualStyle.id/text/referenceAssetVersion |
| 剧本结构 | 三幕/五幕/英雄旅程/平行/交叉/非线性/环形/单元 | structureId |
| 集数、每集时长 | 集数设置与方向问卷；用户可明确自定篇幅 | totalEpisodes、episodeDurations；见 D02 |

选项内容作为带版本的数据资产维护，不写死 JSX 分支。源站某个可访问名称带异常后缀（如男频 `-1`）不当成业务值复制；稳定 ID、显示文案、选中状态分别保存。选项最大多选数是控件语义；它与禁止用户写长故事的硬上限不同，用户自定义意图仍可完整表达。

三层状态：`PresetModalDraft → ComposerDraft → ConfirmedSpecRevision`。取消只丢弹层副本；确认只更新未发送输入；发送冻结快照；已有作品改设定先生成影响预览，确认后产生新规格版本。

## 5. 五类文档：结构要素与文学内容都对齐

### 5.1 大纲不能一刀切

本轮模板 profile（工作名 `outline.template-nine.v1`，不是平台内部枚举）具有九个 H2：

1. 概要设计：故事简介、核心看点、主角/主要阻力、题材/口味、总集数/单集/总时长、创作模式、来源。
2. 故事简述：起承转合的连贯故事，而不是分镜清单。
3. 背景设定：故事背景、关键规则或现实条件。
4. 主要关系与压力：主角为什么不能退、主要阻力如何拦、额外压力。
5. 全剧分段：位置、承接、阶段目标、主次冲突、阻力打法、人物弧光、伏笔、设定揭示、代价、观众所得、与其他段区别、段末留下什么。
6. 为什么能追：按已确认集次描述具体观看动力。
7. 钩子预设：ID、画面/台词、疑问、落点。
8. 伏笔预设：ID、埋什么/埋在哪/具体形态、收在哪/怎样收。
9. 创作禁区：可执行边界，不是泛泛“不要跑题”。

既有《入画》改编 profile 保留五节：概要设计、这次改写怎么处理原文、篇章划分、钩子预设、改写禁区；精确 schema/编译器见 Seed 专项 §4。已有文档不因切换模式自动改版；改版是可预览的显式迁移，旧用户文字不能丢。

共同要求：世界规则能支持冲突、主角选择造成结果、伏笔有可追的兑现、结局和时长符合规格。技法分析可放内部结构，用户正文应读得像故事；不得把“按要求我将…”等回复混入剧本。

### 5.2 人物小传

本轮为“人物清单”→姓名 H2。主角字段可有：类型、人物设定、在本剧的作用、标签、语言风格、说话的破绽、设定记忆点、弧光、被逼急时怎么做、称呼规则、首次出场、关键集次。配角可只保留类型/设定/作用/标签/出场/关键集次；**本轮同页人物字段数量已不相同**。

代码应定义 `requiredCore + conditionalFields`，而非要求每个角色填满12项。年龄/身高/具体口头禅没有来源且未允许设计时不能生成成事实；允许原创设计时标创作设定，不冒称原文已有。称呼规则绑定说话者、对象、场合和证据；一个“称呼”字符串不够。

### 5.3 场景设计

本轮“场景清单”→场景名称 H2→类型、戏剧作用、空间对行动的限制、可复用动作位置、关键集次。类型不能靠名称关键词猜“内/外”；地点与昼夜/现实或画境分开建模。空间限制必须能影响行动，复用位置必须有具体舞台调度意义。

视觉风格仍可作为资产提示输入，但**不是替换本轮这两个戏剧空间字段的理由**。历史 schema 如有其他字段，用版本映射保留；不得凭空认为所有旧场景格式错误。

### 5.4 道具设计

本轮“道具清单”→道具 H2→类型、戏剧作用、使用边界、首次出场、关键集次。物件由 entityId 区分，两个手机或两幅画即使名称相似也不能合并。使用边界进入事实/连续性校验，而非只写在说明里。没有关键道具可以明确为空及原因，不为凑模板增加“神秘信物”。

### 5.5 分集剧本

本轮标题“第 N 集：集名”；七项元信息：目标时长、题材/口味、节拍、核心氛围、本集承接、本集钩子、关联资产。正文层次为剧情梗概、正文、逐场 `集-场｜地点 昼夜 / 内外`。包含动作、对白、OS/声音、转场；允许显式时间段，但不强制所有作品每场写秒码。

场次数由容量/故事决定，模板本集七场不等于通用要求七场。对白、动作、声画同时发生时不机械累加时长；目标时长、估时区间、实际媒体探测时长三列分开。末集完整收束不强加“敬请下集”。

### 5.6 格式注册与校验骨架（拟实现）

扩展既有 schema/渲染，不另存第二套可编辑 JSON 权威。以下是接口骨架，不是已编译运行的新增代码：

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class DeliveryProfile:
    key: str
    version: int
    document_kind: str
    required_sections: tuple[str, ...]
    conditional_fields: tuple[str, ...]
    evidence_ids: tuple[str, ...]

def compile_delivery(candidate, frozen, registry, validators, ast_builder):
    profile = registry.resolve(frozen.document_contract)
    parsed = validators.schema(profile, candidate)  # 缺字段不能用空串掩盖
    report = validators.domain(profile, parsed, frozen)
    if report.hard_failures or report.critical_unknowns:
        return {"status": "needs_revision", "candidate": parsed, "report": report}
    ast = ast_builder.build(profile, parsed, frozen.confirmed_values)
    return {"status": "candidate_ready", "ast": ast, "report": report}
```

`candidate_ready` 只表示可展示审阅；不表示定稿。自动保存可以存未完整文本，不能因格式错误丢用户输入；后续模型生成只读取通过相应前置门的版本。

## 6. 全流程状态：从第一句话到整部作品

### 6.1 原创

入口→空会话→预设副本/用户故事想法→冻结输入→方向候选与关键缺口问卷→用户确认方向/篇幅→筹备产物（大纲、人物、场景、道具、集目录）→同一审阅检查点→局部/全局修改或接受→按需报价第一集→分集规划→正文→硬检查及质量审阅→用户确认定稿/要改→下一集→最终收束/导出。

这是一条依赖链，不意味着必须向用户暴露每个后台方法。不要将来源抽取、骨架、人物等内部步骤变成十几次机械确认；只在事实/方向/规格/费用/稿件接受与定稿的真正决策处停。

冻结requestedDeliverables决定本次范围；S1/S2只交大纲，不因上述完整链描述就顺带调用人物/场景/道具。其他文档在后续获准阶段生成。具体守卫按工作流§2/WT06/WT08，不能让“首阶段完成”依赖整套筹备已生成。

### 6.2 改编

原文上传/粘贴→完整摄取（失败块重试）→关键事实和事件图→独立原文审计→策略决策（浓缩/扩写/冲突/钩子）→有源约束的方向确认→筹备→与原创相同的审阅/分集/定稿链。若用户已明确方向和篇幅，不重复询问已知项；存在冲突才问具体问题。

只提供 EP02 时，`sourceLabel=EP02` 与 `deliveryOrdinal=1` 可同时成立。不能根据交付件第一个就改写成原作第一集；也不能凭空补前集情节。

### 6.3 “要改”与“确认定稿”

用户说“要改第二场对白”→解析目标文档/版本/场次→M13 影响分析→M14 最小 patch→格式、事实、语义复检→逐处/依赖组 diff→用户接受→原子提交新版本→旧质量报告/定稿失效→必要复核→再确认定稿。没有明确范围时先问，不默认全稿重写。

用户点击确认定稿→检查文档 hash、有效审阅、无未决强冲突→写 Finalization receipt→若仍有下一集，显示可继续入口/相应费用授权；若末集，进入完稿。`接受差异≠确认定稿≠批准费用≠自动生成策略`。

### 6.4 多集、续写和变更规格

- 每集稳定 episodeId，序号是投影。插集/删集/重排不能换掉所有引用 ID。
- 第二集读取第一集有效边界、人物知识、物件归属、未兑现伏笔和新规格，不只读故事摘要。
- 已写第一集后改变集数/风格/主角设定：先列影响清单，选择只改未来或重审已写内容。过去事实与新设定矛盾时，不能假称“只改未来”可保持一致。
- 续集不是复制开场再讲一遍；本集已发生事件必须进入事实账本。结局封闭后用户要求续作是新的意图和约束变更，不偷偷把已定稿结局改开放。

### 6.5 运行状态与对话状态分离

```ts
type ComposerMode = 'omni' | 'original' | 'adaptation' | 'directing';
type CheckpointKind = 'facts' | 'direction' | 'outline' | 'cost' | 'review' | 'finalize';
type InputDraft = {
  clientDraftId: string; sessionId: string; revision: number;
  mode: ComposerMode; parts: ComposerPart[];
  presetDraft: PresetDraft; modelBinding: ModelBinding;
};
type FrozenInput = {
  draftRevision: number; inputHash: string; workRevision: number;
  documentContract: string; methodVersions: MethodBinding[];
  refs: VersionRef[]; orderedReferences: ReferenceManifest;
  targets: TargetRef[]; targetResolutionReason: string;
};
```

上面引用的业务类型沿既有 schemas 扩展。模式选择修改 InputDraft，不改变正在运行的 FrozenInput；关闭面板修改 view，不取消 run；新建会话不等于新建作品，作品已有归属时给“继续编辑/另建作品”明确选择。

具体四模式可读范围/可写目标、TargetResolution、歧义/失效/不支持、运行中切换及同句修改用例只以[工作流§1.1](workflow-contracts.md#11-四模式上下文与目标解析合同)为准；模式不是写权限，InputDraft也不能替代目标解析。五文档分别版本化，FrozenInput.refs保存工作文档版本集合，详见[语义合同](document-semantics.md)。

## 7. short-drama 完整融合，而非替换根基

### 7.1 三层职责

- short-drama 层：来源事件、骨架、人物目标/阻力、因果、节奏、对白、可拍性、审稿、海外适配与导出方法。
- LibTV 行为适配层：模式/问卷/交付格式/局部修改/逐集确认/角色与 Skill 生命周期的可观察合同。
- 宿主程序层：权限、数据和顺序、schema、固定 ID、版本/hash、时长算式、事务、费用、幂等和状态。模型不得决定这些最终事实。

### 7.2 路由覆盖表（每一项都不能只停留在文档）

| short-drama 能力 / 新行为 | 方法 | 实现交付 |
|---|---|---|
| `/start` 原创 / 改编入口 | M01/M02/M03 | 选择流程、方向候选、缺口问题、确认 Spec |
| `/events` 原文事件 | M04/M05 | 全文覆盖、别名、来源证据、独立漏检报告 |
| `/skeleton` 因果骨架 | M24 | 事件顺序、前置条件、伏笔回收，不是复述摘要 |
| `/adaptation` 四策略 | M06 | 对每项关键事件的保留/压缩/扩写/移动/删除决策与授权 |
| `/plan` 故事大纲 | M07 | 格式 profile + 叙事质量，不与 `/outline` 混淆 |
| `/characters` 世界资产筹备 | M08 | 人物/场景/道具/关系同一实体注册表 |
| `/outline` 分集目录 | M09 | 集间主线/承接/收束/事件分配 |
| `/episode N/next/range` | M10/M11 | 后台容量规划、逐集写作，range 按依赖顺序子运行 |
| `/review` | M12 | 事实硬门与文学软评分，未审≠已通过 |
| 随时调整/海外改写 | M13/M14/M15 | 影响范围、局部/联动 patch、版本失效 |
| 导演执导/全能创作 | M16/M17 | 有工具白名单的镜头候选/任务 DAG |
| Skill/角色创建、更新、自测 | M18/M19 | 完整方法包、版本、独立测试记录 |
| `/compliance` / `/export` | M20/M21 | 目标市场审核、清晰未核项、可迁移产物 |
| 长文本上下文/知识演进 | M22/M23 | 来源优先检索、按条件加载已验证经验、禁用理由 |

### 7.3 规则应用必须有条件

原题材指南包含三角关系、金手指、爽点、付费卡点、每分钟笑点等特定经验，不能不分题材强加。对于《入画》这种完整志怪故事：保留目标/阻力/选择/后果、欲望—安乐—恐惧—归返—醒悟；不强行添加爱情、复仇、四层反派或续集钩子。`paywall-design` 仅在用户确选商业卡点时启用。`ai-producibility` 用于可拍性，不因此删除必须保留的文学事件。

`genre-guide` 的市场/人群说法作为技能来源的经验假设，不能冒充本轮已经核实的市场统计。当前知识查询无匹配时明示“未加载动态经验”，不能虚构积累。规则冲突优先级：用户确认的硬约束/来源授权边界→产品安全与能力→阶段合同→题材条件方法→可选经验。

### 7.4 每次差异怎样沉淀，避免越改越乱

每个方法包需 `manifest.json / method.md / schemas/input.json / schemas/output.json / templates / fixtures / provenance.json`；依赖的参考文档固定 hash，宿主白名单 validator 不执行外部导入脚本。

差异修正一条一条登记：

```json
{
  "differenceId": "DIF-UNSUPPORTED-AGE",
  "symptom": "无原文支持的年龄被写成确定事实",
  "layer": "source-grounding",
  "methodIds": ["M08"],
  "change": "未知字段省略或成为待确认设计，不补数字凑字段",
  "positiveFixture": "character-unknown-age",
  "negativeFixture": "character-invented-age",
  "retentionFixtures": ["original-authorized-design", "source-explicit-age"],
  "status": "planned"
}
```

先定位缺口属于技能、上下文、schema、UI、工作流、供应商哪个层；一轮只改变能解释失败的最小集合。修改方法后：冻结新版本→负例变通过→保持集不退化→真实 Seed 重跑失败切片→记录对照结果→才能合入。反推的是可检验的方法合同，不是声称唯一恢复私有 prompt。

### 7.5 模型输入顺序与运行凭证

编译顺序：系统任务边界→当前阶段 method→适用规则→冻结规格→锁定事实与冲突→完整必要来源片段→当前文档/选区→目标 schema/格式 profile→用户本轮意图。不会把整套24包每次全塞入 prompt，也不会只发很短概要丢掉关键事实。

run receipt 保存模型请求 ID、requested/actual route（供应商未回传则标未知）、method/schema/profile版本、source/document hash、加载/排除规则、token/finishReason、校验报告、费用、候选/接受/定稿版本关联。原始 prompt/返回留受控本机目录；公共报告只给必要脱敏字段和证据 hash。

## 8. 当前代码审计与落点

下面的路径相对仓库根。`已有`表示查到实现入口，不等于全部合同已验收；旧未提交增量属于实现线，本轮未覆盖。

| 领域 | 当前真实接点 | 缺口 / 改法 |
|---|---|---|
| 主 UI | `frontend/src/features/director/DirectorStudio.tsx` | 全能/导演/分享/插件禁用；已有作品模式按钮打开预设。拆出 mode/router/composer，不继续往此文件堆所有分支 |
| 窗口/画布 | `components/DirectorWindow.tsx`、`DirectorCanvas.tsx`、`director.css` | 沿用窗口/画布能力，补统一浮层栈、焦点、编辑时布局、视觉基线 |
| 设定 | `DirectorPresetDialog.tsx`、assets 预设 | 用同一 preset compiler 产提交/展示；补版本 profile 与无任意篇幅硬上限 |
| 输入 | Studio textarea、仅 md/txt file input | 富文本引用 AST、多模态附件、四模式正确 footer；IME/粘贴/回车行为按实测配置 |
| 流式 | `useExecutionStream.ts`、`components/ExecutionHistory.tsx`、`src/novelvideo/director/streaming.py` | 保留 durable seq，补 text/tool/question/artifact 独立投影，不重复消息或生成 |
| 自动保存 | `useDocumentAutosave.ts` | 已有1秒 debounce、journal、未知写入重试同 intent、409冲突。保留这些可靠性；对齐交互时序，不简化为失焦覆盖 |
| 正文/语义 | `documents.py`、`schemas/documents.py`、`semantic_validator.py` | AST与版本沿用；补多 profile、源授权、明确结构/语义失败，不建双正文 |
| 执行/规划 | `execution.py`、`execution_repository.py`、`planning.py`、`dispatch.py`、`workflow.py` | 接通四模式与方法调度；问卷/批准/定稿必须可恢复 |
| 修订 | `revisions.py`、`checkpoints.py`、`recovery.py` | 补稳定块 patch、跨文档依赖组和单处 UI，不能只有整稿布尔接受 |
| 技能 | `skills/runtime.py`、`pinned.py`、`rules/resolver.py` | 当前内置目录仅6运行包；不是M01–M24均完成。按切片增加缺包，不放空壳 manifest 算完成 |
| 大纲/输出 | `outline.py`、`outline_review.py`、`output_validation.py`、`structured_output.py`、`output_budget.py` | 继续大纲专项编译器/严格校验，与九栏 profile 扩展兼容 |
| 五类文档 | `characters.py`、`scenes.py`、`props.py`、`episode_format.py`、`episode_facts.py` | 字段条件化、实体ID、内外/昼夜、跨集事实与用户授权统一 |
| 媒体/引用 | `media.py`、`media_batch.py`、`references.py`、`useDirectorMedia.ts`、媒体面板/节点 | 已有批量准备/审批/取消/移动与引用纯函数；接齐画布选择→模型实参→返回节点验真 |
| 模型/API | `src/novelvideo/api/routes/director.py`、`frontend/src/api/director*.ts` | 沿用v2 command/event端点，路由薄层；禁止前端另拼prompt绕过冻结输入 |

### 8.1 组件拆分建议

`DirectorStudio` 保留 composition root；新增 `DirectorModeMenu`、`DirectorComposer`、`DirectorWelcome`、`DirectorReferenceChip`、`SkillCatalog/Editor/TestReport`、`DirectorRolePicker`、`DirectorTaskPlan`。已有 `DirectorConversation/DocumentEditor/PlanningWorkflow/SettingsDialog/HistoryPopover/MediaPanel/OutlineReviewDialog/RevisionImpactDialog` 优先扩展，不同时建另一套同名能力。

聊天标题不直接等于作品标题：同一作品可有多个会话；新会话有自身历史/草稿。历史组件由作品列表改为真实 session 投影，明确关联作品，不通过重命名作品假装重命名聊天。

### 8.2 状态命令接入骨架

```python
async def send_director_message(command, repositories, compiler, scheduler):
    # 依赖对象由宿主注入；模型请求在事务提交后的 worker 执行。
    with repositories.transaction() as tx:
        existing = tx.commands.find(command.idempotency_key)
        if existing:
            return existing.receipt
        draft = tx.drafts.load_and_check(command.draft_id, command.expected_revision)
        frozen = compiler.freeze(draft, tx.current_versions(), tx.capabilities())
        run = tx.runs.create(frozen, status="queued")
        tx.events.append(run.id, "run.queued", {"inputHash": frozen.input_hash})
        receipt = tx.commands.record(command, run.id)
        tx.outbox.enqueue("dispatch_run", {"runId": run.id})
    scheduler.wake()  # outbox 可恢复，wake 丢失不丢任务
    return receipt
```

不能在数据库事务内等待模型；命令重放返回同 run，不再次扣费。同幂等键不同 payload 返回冲突。所有 work/document/skill/canvas/asset ID 先权限校验；原稿文字不是执行命令。

### 8.3 API 与数据增量

沿用既有 `/v2/planning/commands`、`/v2/documents/commands`、`/v2/approvals/commands`、`/v2/runs/{run_id}/commands` 及事件读取。先审计实际路由 prefix 和 payload，再扩展 discriminated union，不能照下面意图名直接杜撰可调用 URL。

| 意图族（我方设计） | 必需输入 | 必需返回/副作用 |
|---|---|---|
| session.create/restore/rename/archive | projectId、expectedRevision、commandId | sessionId/revision、workLink、inputDraft；不自动新建作品 |
| draft.save / message.send | draftRevision、parts/preset/model、幂等键 | draft receipt / frozen run receipt |
| question.answer/skip | checkpointId/revision、answer、runId | 下一状态；旧卡409，不默认同意 |
| document.patch/review/commit | baseVersion、blockId/selection/hash、依赖组决定 | candidate/changeset、新DV或冲突；不直接定稿 |
| episode.finalize/continue | DV/hash、有效评审、目标episodeId | finalization receipt / 下一集计划或报价 |
| skill.import/apply/test/publish | manifest/schema/version、owner、scope | 私有版本、testRun、显式发布状态；权限不由方法声明自增 |
| taskplan.approve/apply | DAG hash、能力/费用快照、目标节点revision | 子任务列表、画布事务、失败槽位 |

数据新增候选：Session、ComposerDraft、FrozenInput、DeliveryProfileBinding、SourceClaim/FactDecision、MethodBinding、TaskPlan/TaskItem、SkillVersion/SkillTestRun、ShareGrant/PluginConnection。先映射到已有表/JSON/schema 能力，确实缺失再加迁移；迁移先备份/检查旧值/标 legacy_unverified，不能伪造历史验证结果。

## 9. UI、流式对话与像素对齐

### 9.1 本轮可用的实际尺寸

1440×900、浏览器 CSS 100%：聊天浮窗 x1024/y244，400×640，右/下各16，圆角28，背景 rgba(31,31,31,.75)。原创设定器整体1232×640，居中 x104/y130；该外层透明，不能将外层4px圆角误作内部面板样式。结构浮层373×249、圆角16、padding16；改编浮层280×205、圆角16、padding12。设置弹窗宽600、高约478.67、圆角12。

字体栈当次为系统字体/PingFang/Inter/Noto Sans SC/Microsoft YaHei；截图需要锁定系统/字体/DPR，Mac与Windows字形差异单独标记，不能把不同字体产生的差异归因业务CSS。节点本轮画布缩放118%，不把节点屏幕宽度写成固定 CSS 宽度。

### 9.2 视觉状态矩阵

逐屏至少覆盖：原始空态、选中态、hover/focus、弹层打开、loading、流式、问卷待答/已答、报价、待审差异、错误、断网重连、自动保存中/失败/冲突、停靠/浮窗、编辑器/聊天共存、长文滚动、窄视口。图片/动态图只遮罩真正不确定区域，不能遮整个正文/面板来降低差异率。

唯一验收参数从[acceptance-policy.json](acceptance-policy.json)的visual读取，采样/算法/不可比规则按[验收§4](acceptance-contracts.md)。保留既有全页原始门，局部只诊断；关键几何与按钮可用性独立一票否决。前版此处的区域比例与边界容差已被统一配置取代，不再保留第二套活动数值；历史报告按原policy保留FAIL，不回填成功。

所有颜色/间距变量遵循仓库 `DESIGN.md` 与 `index.css` 同步规则。源站图标素材已有 `libtv-icons.json/reference-assets.json` 接点，逐项核对viewBox/描边/颜色/尺寸与权属；仅公开可下载不等于可随公开仓库再分发。授权不明素材在本机对照，不把完整第三方素材包提交；可替换自有等形语义资源并在差异清单标记，不冒称完全同源。

### 9.3 流式：顺滑来自事件模型，不是打字机动画

```ts
function applyDirectorEvent(state: ViewState, event: RunEvent): ViewState {
  if (event.seq <= state.lastSeq) return state;
  if (event.seq !== state.lastSeq + 1) return markNeedsReplay(state);
  switch (event.type) {
    case 'text.delta': return appendMessageSegment(state, event);
    case 'tool.started': return upsertToolCard(state, event);
    case 'tool.result': return settleToolCard(state, event);
    case 'checkpoint.opened': return showDecisionCard(state, event);
    case 'artifact.staged': return upsertDraftArtifactCard(state, event);
    case 'document.committed': return acknowledgeDocumentVersion(state, event);
    default: return applyLifecycleEvent(state, event);
  }
}
```

事件名是我方归一化设计，适配当前 server event schema 后使用。每个 reducer 必须推进 lastSeq；seq 分区以 run 为单位，切换会话不能混流。重连从已确认 seq 回放，缺口先补事件，不重新发送模型意图。工具卡保存 toolCallId 与状态/可公开摘要，不输出私有推理全文。

用户向上看历史时不强制拉到底；在底部时才跟随。流式 JSON 可展示阶段进度，不能把未闭合 JSON 当剧本文档保存。最终校验失败保留候选和明确修复入口，不先渲染“成功”后突然改成失败。

### 9.4 自动保存与选区改稿

保留现有 journal/CAS/未知请求复用 intent；将自动保存的状态图接到编辑器与聊天。历史源站客户端为1500ms debounce，本地当前1000ms；若要时序一致可配置为1500ms，但保存正确性比精确计时更重要，不能因此削弱冲突处理。

发送选区前：flush→获取服务器确认DV→AST投影映射 UTF16 offsets→验证 selectedTextHash→构建 document part→显示选区chip→用户发送。切换文档或编辑后旧选区过期时明确要求重新选择；禁止把旧offset应用新稿。关闭编辑器不销毁会话；Esc只关闭最顶层可关闭视图，不连续关闭全部窗口。

## 10. 全能、导演、Skill 与媒体闭环

### 10.1 全能创作

欢迎四入口分别路由到：画布快照规划、原创设定器、原稿上传改编、选中节点批量镜头优化。感知范围由用户选择/可见区域/明确全项目授权决定；不默认上传所有私人资产。

M17 输出 DAG：每个任务声明依赖、输入版本、工具、成本类别、副作用、输出类型。宿主校验可执行工具/权限/预算；预览后执行。无能力的项显示具体缺失，不让模型文字“已经生成”冒充节点。有限并发不改变输入顺序；取消只停未受理工作，已受理供应商任务保留实际状态。

### 10.2 导演执导

内置自动/TVC/悬疑/带货口播/动画/纪录/MV用版本化角色方法包。选择角色、选择模型、选择素材是三个独立维度。两种主要结果：已有视频节点逐项优化候选；一句话生成ShotPlan。采用候选后才写节点，不收到流式文字就覆盖原提示词。

自定义角色：需求问卷→方法草稿→头像/名称/方法/预览→校验→私有保存→新输入引用执行→有独立回执的自测。历史实测“新建角色/使用角色”会发送意图，UI必须显式显示该消息，不伪装成纯下拉静默副作用。

### 10.3 Skill 全生命周期

目录/收藏/我的/全部→详情与案例→添加到输入；创建支持从零、对话提炼、画布提炼、更新已有、自测五种工作意图；顶部创建菜单只是对话创建与导入两种入口，不要混成七个平级按钮。

导入仅解析被允许文档/schema，不执行未知脚本；防路径穿越/符号链接。应用草稿生成新私有版本；使用冻结该版本。自测必须真有 `testRunId + inputHash + outputHash + assertionResults + usage`，不能相信模型“我已测试通过”。分享/发布/撤回/删除各自命令和授权，不能用删除代替撤回。历史运行所需审计凭证按策略保留，删除操作说明真实可恢复性。

### 10.4 媒体规划和引用顺序

角色/场景/道具图：选实体→冻结已确认描述/画风/参考版本→生成计划预览→报价/批准→任务→素材入库→画布节点绑定实体与版本。重新生成产生新版本，不把旧媒体静默覆盖为新稿证据。

视频只接 MiniMax H3，具体模式/参数沿[既有 H3 合同](../minimax-h3-liblib-request-contract.md)。叙事时长与H3片段时长分离；批量切镜头不擅改故事总长。文本索引与混合媒体索引独立：文本1与图片1可以同时存在，文本是内容上下文，媒体以稳定refId/type/providerIndex映射，不拿显示数字作全局主键。

```python
def freeze_reference_order(display_items, compiler):
    ordered = tuple(display_items)  # 用户可见顺序，不按上传完成顺序
    manifest = compiler.compile(ordered)
    compiler.assert_no_dangling_mentions(manifest)
    compiler.assert_unique_stable_ids(manifest)
    return manifest  # chip、提示词占位、上传/提交、预览共用
```

必须覆盖每类型至少2个素材的混合测试：文本2、图2、视频2、音频2；删除/重排/替换/乱序上传完成/单项失败/刷新。采用现有 `references.py` 纯函数后继续端到端捕获提交值，单元测试不能替代供应商实参证明。记录 requested、providerEcho、actualProbe；尺寸/时长不符显示差异，不能只改结果标签让它“看起来对”。

## 11. 文学质量与真实 Seed 对照

### 11.1 固定输入，不再两边测不同故事

《聊斋·入画》以用户本会话提供的完整故事为唯一来源，不用同名原典替换。源文固定hash、事件清单与未决问题；可以提炼概要，但概要是派生上下文，关键事实保留可回查来源，不以概要替换原文证据。

两边使用同一故事、明确相同方向/集数/时长/基调/保留与新增范围、同一阶段任务；用户未决定时长时先获得同一决定，不能各自默认30秒。LibTV选Seed；本地Agent Plan的 `doubao-seed-evolving`。各自记录实际回显/能力和未知参数；同名模型并不等于确定相同服务端设置，不伪称严格实验室同模型。

《入画》gold至少覆盖：现实厌倦→少女吸引→入画→安乐诱惑→囚笼真相→逃离欲望→巡使威胁/躲藏→现实友人与老僧援助→归返→发髻变化证据→主题醒悟。具体事件边界由原文标注，gold不是任意新写剧情。原文“察觉活人/察觉逃离念头”的规则口径，以及“为阿沅挽髻”的回忆性叙述，可能需要保留原有含混或提出具体确认；不得默补爱情/婚姻/年龄因果来消除含混。

### 11.2 最少样本与受控改动

A–D是policy.literary.stageProbes定义的分阶段探针，S1先A、S2原创B、S3保持集C、S4续写D。它们不是完整验收分母；S10按验收§5的fullGroups进行全量配对。严格同条件的历史样本可凭runId去重复用，不重复购买，保留首稿/失败稿，不只挑最好一次。

流程：同源输入→方向问卷对齐→大纲首稿→同一句局部修改→部分采纳/拒绝剩余→编辑保存/刷新/新版读取→人工确认继续→人物/场景/道具→第一集→修改/定稿→第二集或单集完成。每一步记录 UI 状态、模型实际输入/输出、schema检查、版本、耗时、费用；只在同一检查点比较。接受不是定稿，不能将两按钮合并后称体验一致。

### 11.3 分开评结构与文学

| 门 | 判断 | 不能怎样作弊 |
|---|---|---|
| G-format | 必填字段/标题层级/类型/引用/集数满足所选profile | 给缺字段补空串、把说明当正文、只统计数量 |
| G-facts | 锁定事实/台词/否定词/身份/顺序/结局；未知明确处理 | 模型自称100%保真、为了通过倒改来源 |
| G-literary | 因果推动、人物选择、具体场景、对白辨识、张弛、情绪兑现、主题含蓄 | 以字数长或术语多代替质量 |
| G-flow | 修改只动范围、确认后正确前进、流式/保存/恢复真实 | 只跑直接服务函数绕开UI |

文学统一使用policy.literary的评分尺度/维度/阈值，阶段门与完整门按[验收§5](acceptance-contracts.md)。双方证据给原句位置，先冻结rubric；Seed仅辅助审稿。单评审阶段结果只能标provisional_not_full_parity，不能将无人独立评审伪装成完整质量通过；事实硬失败直接失败。

### 11.4 修复后必须继续验证，但不是无限付费循环

失败先归因：输入丢失→补上下文；schema错→修编译/约束；文学空泛→改对应方法；版本错→修程序；供应商失败→恢复查询。开发阶段修复后须再次调用真实 Seed 验证原失败用例，并跑保持集；不能以“已经花钱”为由交付已知失败。

产品运行时保留有限自动格式修复，超出自动尝试进入可恢复待修，不标成功也不无限扣费。开发的“继续工作直到通过”与线上“一次请求无限重试”不是一回事。未知受理先查同任务；预算用尽/供应商不可用就诚实记录阻塞和可恢复输入，不把失败刷成通过。

## 12. 按切片落实，避免大改一天连主线都走不通

每个切片含：台账窄路径→先失败fixture→最小代码→单测/组件/真实必要模型→UI证据→文档映射→可审计提交。后续切片不得改已通过行为而不跑回归。以下文件为候选落点，开工需实际scope/preflight，不授权覆盖其他工作线。

| 切片 | 具体代码/内容 | 退出门 |
|---|---|---|
| S0 规格与当前证据审计 | §2、权威合同、executionTracking；冻结实际代码/dirty指纹和样本 | 149动作+8能力均有来源/实现双轴、子case和阶段；未知不猜填；当前S1入口所需负例/参数/版本可执行；规格检查不等于S0完成 |
| S1 改编大纲完整最小闭环 | B00–B08＋B10最新上下文最小读取＋B11的A阶段验证；接Studio/PlanningWorkflow | 验收S1-01至S1-10全部达标：部分采纳/拒绝、依赖组、保存失败/409、流恢复、新版读取与V01–V10；三类质量独立报告 |
| S2 原创闭环及四模式路由 | ModeMenu/Composer/Welcome、目标解析、预设/问卷、原创profile及session投影 | S2-01至S2-06：真实Seed原创预设→设定器→问答→大纲→局改保存恢复；四模式上下文合同通过，但未接全能/导演执行不得算完整 |
| S3 筹备文档生命周期 | M08/M09、characters/scenes/props/profile、独立DV/稳定实体/依赖 | 大纲、人物、场景、道具逐类七步；未知值不补、下游实际读取新版；同题Seed与保持集不退化 |
| S4 分集生命周期 | M10/M11/M12、episode_facts/duration/checkpoints | 分集七步＋首集修改/定稿/第二集承接/末集闭合；完成五类35格；sourceLabel独立 |
| S5 跨文档/全局规格修订 | M13/M14/M15扩展关联组、revision impact与stale重审 | 全局改名/结构/集数/只改未来、依赖集合CAS、旧媒体来源；不把S1已有保存和部分采纳拖到本阶段 |
| S6 全能后导演 | 先M17/画布感知/批量优化，再M16/角色/TaskPlan与媒体交接 | 两子门依次验；候选→采用节点→计划预览，取消/恢复/稳定排序；无工具不伪成功，预览不是出片 |
| S7 Skill完整生命周期 | M18/M19、skill版本与测试表、Catalog/Editor/TestReport | 创建/导入/应用/使用/真自测/另存/发布撤回/删除完整，不只列目录 |
| S8 媒体接通 | media_batch/references/供应商ports、媒体面板节点 | 三种图计划；H3参数一一对应；素材混排数量按F23；真实单任务回显/探测 |
| S9 设置分享插件导出 | Settings/History、share/plugin ports、M20/M21 | 权限/撤销/预算范围/通知；脱敏导出导入；Windows与实际跨设备 |
| S10 全页像素与文学回归 | CSS/tokens/assets、逐屏状态矩阵、policy全量质量组 | 所有按钮/适用状态/35格/设备结果齐全；完整配对文学门通过，不用A–D过程探针代替 |

S1不是全产品完成，只是第一条可演示垂直路径；S2–S10仍必须完成。像素截图从S1开始持续积累，S10是收口，不是最后才发现布局错。每轮报告明确当前切片与失败阻断项，不用含糊百分比代替。

阶段依赖只以policy.stages为准；历史P0–P8/WP章节是来源导航，不再作为新的排期。B09长文和B10全迁移是实际开放对应能力的前置门，不能静默限用户创作时长，也不能伪称无限容量；短稿S1不等待这些无关能力全部实施。现有方法包可先按明确版本调用，完整用户Skill生命周期在S7，不要求重建方法注册表才修大纲。

### 12.1 必跑测试名称建议

- `test_delivery_profiles.py`：九栏模板与五节改编分开、旧版本保留、缺关键字段失败、不可在读操作迁移正文。
- `test_mode_dispatch.py`：四模式实际路由、活动run冻结、切模式不清输入、不创建多余作品。
- `test_source_grounding.py`：未确认年龄/称呼、否定词、原作集号、两物件/同名人、关键尾段漏检。
- `test_revision_dependency_groups.py`：全局改名不能半套采纳、CAS失配全回滚、未知写回查同intent。
- `test_episode_continuity.py`：前集知识/物件/伏笔延续、末集不强钩子、重排ID稳定。
- `test_skill_lifecycle.py`：导入安全/权限、版本不漂移、真实自测receipt、撤回与删除区别。
- `test_director_task_plan.py`：依赖失败、乱序完成、取消、已受理未知状态不得重复发单。
- UI：`director-mode-menu`、`director-composer-references`、`director-document-profiles`、`director-stream-recovery`、`director-editor-chat`、`director-visual-states`；既有同类测试存在时扩展而不重复另起名字。

执行命令由改动范围选取：`uv run pytest tests/director`、`uv run pytest tests/test_tv_director.py`、前端 `pnpm test` / `pnpm build`；业务合入前还需 agent guard、ruff、端口闭合、i18n三语言/棘轮、CE边界与敏感扫描。本文纯研究文档不冒称本轮跑过上述业务测试。

## 13. 防遗漏的验收和证据账本

追踪表的`executionTracking`为当前执行视图，旧requirements.stage=P与status/resultRef保留历史，不拿来覆盖新S切片。每个动作/能力记录deliveryStages及来源证据状态、实现审计状态、已观察代码接点、具体caseBindings。case必须包含入口/前置状态/操作/UI变化/request/response/event关联/持久化复读/失败恢复/实际实现位置/截图与断言，纯本地动作明确no_request。研究报告链接只是导航，不能代替这些证据。

sourceEvidence与implementation分开：unknown/not_audited不是not_implemented，历史局部实现也不是完整pass。尚未逐行审计的项目标记缺什么、在哪个阶段补，不批量升级或删除旧结果。完整PASS须同一代码/输入/方法/模型/policy版本的有效证据；指纹改变则待复验。当前代码候选位置与旧planned路径分别列，目录存在不证明按钮已接通。

本轮新增 UI 差异另挂FP证据：Skill全部筛选、模板九栏、人物条件字段、场景空间字段、当前模型菜单、编辑聊天共存。沿149动作ID扩展子验收，不随便添加重复动作让总数虚胖。

收费调用前记录试验要回答的问题、冻结输入、预计价值、报价/预算；调用后记录接受情况、task/run关联、返回、token/耗时、费用证据、候选/错误。保留失败与无效输出。复测必须说明改了哪层、预计哪项断言转绿；没有新变量不反复生成。

完整验收还需实际第二设备/Windows、历史版本迁移、分享撤销/权限和插件scope验证。这些不属于私有Skill不可知问题，不能以“无法反推”免除我方实现测试。暂缺环境就保留明确状态与重现步骤，不能说“全部一样了”。

## 14. 可直接交给实施代理的执行提示词

> 目标：独立实现 LibTV TV Director 的完整可观察功能、操作和视觉体验。主方案是 `docs/guides/tv-director/full-replication-plan.md`，原子合同/方法/状态/语义/验收按该文档的权威导航读取。先遵守 AGENTS 恢复 Git 与任务台账、认领窄路径并通过 guard，不覆盖陌生改动。
>
> 不再从零改造所有代码，不再只凭截图画UI，不再把整个任务压成一段超长prompt。先做S0去冲突，再做S1《入画》单条垂直闭环。未完成该闭环前，不扩大为多个模型、多套故事和邻近模块重构。
>
> S1必须通过验收合同S1-01至S1-10，包含部分采纳、依赖组、保存失败/409、刷新、新版读取与完整适用视觉状态；S2原创另过S2-01至S2-06。唯一数值/模型/样本层级读取acceptance-policy.json；工作流§1.1决定目标，语义§1.0决定五文档独立版本和35格。未知证据如实登记，不使用旧P阶段、旧阈值或旧多模型要求替代新S切片。
>
> 创作根基继续使用short-drama；逐阶段加载所需参考和条件规则。LibTV实测用于补交付格式、交互、检查点及效果方法。宿主负责schema、版本、权限、素材顺序、费用、状态。不得自称拿到了私有内置Skill全文。
>
> 本地只用Agent Plan的doubao-seed-evolving，LibTV选Seed；固定同一份用户《聊斋·入画》原文、方向/篇幅/限制和同一操作指令。未确认的设定不能默补。不要再默认调用DeepSeek作第二套实验，也不要将同名模型当成已证明完全相同配置。
>
> 每项实现先列源站证据、当前代码、失败fixture、拟改层和验收标准。先修根因，再真实模型复测失败切片和保持集。格式错不补空字段蒙混，内容错不靠改评分标准通过，已花费用不构成交付已知失败的理由。未知受理不得盲重发；技术阻塞如实报告。
>
> UI按四模式、设定器、聊天、五文档、编辑/差异、导演、Skill、媒体、设置/历史/分享/插件逐屏逐状态做同视口截图和点击链。按钮禁用占位、静态截图、工具自称成功不算完成。像素验收保留差异图与未覆盖状态。
>
> 每轮只提交可解释的最小改动，保存模型请求/响应/费用/错误的脱敏证据，更新方法版本与差异账本。格式/事实/文学/流程分别报结果；失败就继续处理，不写“基本完成”。全部切片验收前不得宣布完整复刻。结束时明确已完成、仍失败、未验证以及下一条可直接执行动作，并按guard交接释放锁。

## 15. 本轮交付边界与下一步

本轮完成的是：新链接真实界面与接口形状取证、既有证据复用、代码接点/缺口审计、全功能集成方案和执行提示词。不是业务实现完成，不是新一轮《入画》生成质量通过，不是全页像素差异已归零。

审核r1的六项合同与policy保留；r2补齐当前代码/来源范围登记及关键入口实测，具体见§16和plan-closure.json。实现线下一步不再重新写一遍总方案，而是精确认领B00测试文件，冻结失败反例后进入B01–B08与S1十条门。源站证据和测试定义均不是本方通过；S1通过后依S2–S10推进，不能将大纲通过称为完整产品完成。

## 16. r2 完整方案收口记录

### 16.1 收口意味着什么

本次收口的是**可执行方案与差异处置**：149动作+8能力全部有ID、合同、当前代码证据或缺失结论、确定实施动作、正负测试定义、归属阶段；24方法/18规则/15条来源路由有输入输出与调用边界；五文档35格和S1/S2共16个必测流程均登记。没有用“未来再想”代替开发决策，也没有用源码行号伪装逐按钮测试通过。

以下不在本次完成声明内：完整产品已实现、所有LibTV子状态均实测成功、私有Skill已拿到、文学与全页像素已验收、Windows真机已通过。客户端不可观察的行为已有U01–U13的实现决定、责任域和发布门；这关闭开发决策，不改变sourceParity=not_claimed。源站失败继续成为我方负例。新增或改动的未知条件不能被代理默默“合理推断”为已验证。

### 16.2 本轮补证：从按钮一直记录到拒绝执行

本机忽略归档：`output/playwright/liblib-tv-director/plan-closure-20260927/`。evidence.json保留脱敏请求/返回和WS帧，index.json冻结SHA-256；公开索引只存字段/序号/哈希与结论，禁止凭据、账号及完整第三方正文入库。来源包链接表示可检索的相关观察，不表示链接到它的每项按钮全状态通过。

| 子案例 | 正常UI操作与结果 | 请求/持久化证据 | 能确认的边界 |
|---|---|---|---|
| CL01–CL04 | 未发送短句依次在原创/全能/导演/改编切换后仍在输入框 | UI可访问树逐步保存；未点击Send | 证明此文本草稿保留；不外推上传中的多媒体或服务端目标解析 |
| CL06–CL09 | 关闭重开保留草稿；@选择剧本文档产生chip，导演/原创切换后chip仍在 | 文档引用UI；没有发送引用消息 | 文档引用与模式是独立状态；不是把全文粘到textarea |
| CL10–CL13 | 编辑器打开时出现“继续在这里对话／切换到关联对话”；点击前者后继续当前编辑 | session/create及VFS读取/diff；UI不自动产生改稿发送 | 关联会话需独立分支；打开编辑器不等于授权修改 |
| CL14–CL16 | 刷新时先出现全能空壳，加载完成后切回剧本关联的原创会话；原输入引用未在新输入框恢复 | CL14输入含同名引用；CL16标题变为关联会话，输入为空且Send禁用；加载态CL15保留 | 只证明关联会话恢复，不证明原未发送草稿/chip恢复。不得把标题中的文档名误当输入引用；我方按会话分别持久化草稿并验收 |
| CL17–CL18 | 顶部全能创作新建会话，自动发续创，读五份文本、写规划 | HTTP126 session/create；WS唯一首次user消息，text/node/context及forwardedProps；context.dryRun=true | **推翻旧E08不自动发送假设**；与普通引用入口分离；真实规划写入仅研究副本 |
| CL19 | 先创建15个图片节点，再显示225积分的确认卡 | 15次create_image_node回执为NOT generating；HTTP174–188 power/calculator；询问工具与RUN_FINISHED | preview≠实际媒体受理；RUN_FINISHED也可能停在用户检查点 |
| CL20–CL21 | 点击取消，回答“不批准，先不运行”，回到可输入状态 | 第二条WS user回复；末帧RUN_FINISHED；本次未见run_node或媒体generation/create | 取消保留预览，未确认媒体扣费；界面余额930未变，但不是供应商完整计费审计 |

失败也记录：源站连续错误使用edit_video_v4、update_video_node、edit_audio，随后dry-run的audio工具把剧本文档引用成音频源；不能把模型自称“规划核对通过”当工具类型正确。我方须在调用前验证节点/素材类型，规划校验结果由宿主决定。此次源站默认规划使用Seedance，不是我方已确认H3：文学写作仍仅Seed对照，媒体规划适配用户H3能力，不能照搬15秒等供应商限制到文学时长。

本轮截图只覆盖若干局部：01/02为浮窗，03含导演加载态，04为引用状态，05仅关闭控件，不是完整编辑器像素基准。CL03/CL05/CL15存在过渡态；全页视觉仍用上一轮ready基线和policy重新成对验收，绝不拿局部截图换全页通过。

### 16.3 精确请求—返回—落地关系

| 来源调用 | 实际输入结构 | 实际返回/后续 | 本地落点与守卫 |
|---|---|---|---|
| POST `/api/v1/project/session/create` | projectId,name,agentName,canvasId,libtvMeta | code0会话创建；E08随后WS送消息 | sessions.py组合用例；actionId幂等、保留旧草稿、来源会话绑定 |
| WS user / forwardedProps | threadId,messages；content含text/node/context；context含currentNodeKey、source_agent_name/session、agent_name、dryRun | get_node_details/list_dir_v2/read_file_v2等TOOL_CALL_*及文本事件 | TargetResolution+frozen DV集合+M17；agent_name是路由，不声称私有Skill全文 |
| task_create_v2 / task_update_v2 | id,subject,task_content/status | created/status/updated回执 | TaskPlan与run生命周期；模型任务文本不覆盖宿主状态 |
| write_file_v2 | file_path,append,content | ok,size；写分镜总表/锚点/分镜页 | 候选ArtifactVersion+白名单路径；正式文学DV不被覆盖 |
| create_image_node | title,tag,aspect_ratio,prompt | node_key，task_id=N/A且NOT generating；canvas_patch→nodes/batch持久化 | MediaPlan→preview节点；保存source版本/实体/引用顺序，类型校验 |
| POST `/api/task/generation/power/calculator` | params含modeType/prompt/scene/model/quality/resolution/background/ratio及各类型素材数组；metadata含node_id/project_id；顶层provider/model/taskType/requestId | HTTP200/code0；data含power/originalPrice/taskWeight/type/discountRatio；本次每节点15、合计225 | 精确媒体manifest哈希与报价；批准前不能run_node；原值只留本机 |
| 询问用户→取消 | 卡片回答“不批准，先不运行”，同thread关联工具回复 | 15节点保留、后续文字结束、无实际运行 | CP CAS拒绝；释放未用预留、不退款谎报、不删除用户候选 |

这些是源站观察结构。本方API/strict schema以implementation-map及工作流合同为准，不直接对第三方私有端点建立生产依赖。

### 16.4 当前代码审计与交接

plan-closure.json以22个有限审计组覆盖157项，记录真实文件、行号、符号、内容SHA-256和支持测试定义；implementation-map.executionTracking关联这些记录。源码变化后旧审计必须失效，不能继续沿用“通过”。关键根因已经定位：

- 全能/导演/分享/插件及部分设置入口仍disabled；不能算只差样式。
- 聊天仍textarea，@会拼正文且有长度门；要独立Composer AST与ReferenceManifest，不用prompt修复引用漂移。
- 顶部全能创作接openMedia，必须按CL17改为新会话一次续创；媒体按钮保留各自批量入口。
- 五类文档、富文本、自动保存、CAS和执行账本已有部件；复用其可靠实现，补Session分离、独立DV依赖、三方冲突恢复与下游读新版。
- 6个已装方法包不等于24包完成；24个short-drama源文件两副本hash相同。保留根基，按失败样本加条件适配层，不整体重写、不把状态bug推给Skill。

每个组还列出完整实施动作与源站观察限制；具体组件/服务/schema/命令/fixture/正负测试从同ID追踪表直接定位。16个S1/S2流程、35格生命周期和24种视觉状态分别列出计划测试路径，状态全部not_run，不拿测试定义代替运行证据。

### 16.5 实现者下一步（无需重做本轮研究）

1. 按AGENTS恢复基线/业务dirty指纹并认领实现线；源码hash变更则仅重审受影响组。
2. 将Seed细案B00及S1-01…S1-10绑定的F样本做成可执行失败断言，保留当前错误真实输入/输出；先证明能抓住错位、漏事实、局改越界、部分采纳关联冲突和刷新丢状态。
3. B01–B08依序完成schema/来源/目标/上下文/patch/原子保存/流式投影；固定《入画》相同来源、本地Seed对原站Seed。不能因格式失败只反复重发；修根因后重跑失败样本及保持集。失败输出和usage保留，不提交正式稿。
4. 按policy验收S1后再S2原创、S3筹备、S4分集；S6接CL17的续创链与导演工具，不在S1偷偷扩大媒体范围。完成各阶段才更新真实product_execution结果。
5. S10汇总全按钮、24状态全页视觉、完整文学样本集、异常恢复与跨设备；来源不可证的增强项单独标注，不能计入“与源站像素/行为相同”的通过分母。

到此方案有明确完整边界与实施/验收入口；开发、真实模型回归和像素验收仍是接下来的工作，不是这份报告已替它们完成。

### 16.6 本次验证结果与复核命令

- `node docs/guides/tv-director/verify-spec.mjs --self-test --local-evidence`：通过；52类缺项/假通过/过期hash等突变被拒，24来源归档哈希及当前代码、支持测试定义指纹相符。无本机原始归档的新电脑可不加`--local-evidence`验证公开规格，但不得声称复核了原始回包。
- `node output/playwright/liblib-tv-director/plan-closure-20260927/verify.mjs`：32项来源一致性检查通过，包括不把会话标题当引用恢复、15预览、225报价、明确取消和末帧结束。
- 历史`full-plan-20260927/verify-evidence.mjs`、`gap-validation/verify-evidence.mjs`、`gap-validation/round2/verify.mjs`重新通过29/32/62项；没有重新购买历史媒体任务。
- `git diff --check`、方案及agent目录定向gitleaks、`agent_guard check`通过。既有未提交业务增量保留，未提交/推送/部署。

以上为证据与规格的校验，不是482个计划产品用例、真实Seed文学或完整视觉验收通过；每项后续执行必须写实际运行结果及对应版本，不得直接批量改绿。

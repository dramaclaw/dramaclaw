# STATE · 当前进度索引

> **新会话的第一件事是读这份文件。** 它只回答三个问题：现在有哪几条线在做、各自卡在哪、
> 下一步做什么。取证与方案不在这里——在 `docs/guides/`；每条线的逐步记录在 `docs/agent/tasks/`。
>
> 最后更新：2026-09-29 · 更新方式见 `AGENTS.md` 的「多模型协作协议」与
> [`docs/agent/README.md`](README.md)

## 一、仓库当前形态（接手前必须核对）

- 当前主检出`main`与私有同步分支均为`bc051ed3`，两条私有远端此前复核同SHA；包含Director与画布/HEVC双方提交。公开PR #717已包含合入`origin/main=30ab52c7`的双父提交`66da025f`，原35张参考图与图标目录未替换；公开`origin/main`仍未移动，PR显示可合并但需审核。完整S1、文学/全页像素仍未通过，新链默认开关未发布。
- 应用已按用户选择从945baa9f业务版本启动，复用原配置/数据；四端与前端代理HTTP200、原6项目可读取，重启记录3fbd16e6已推同步分支。工作区/远端最终提交以Git为准。
- 两条 TV Director 线和同步分支画布/H3提交均已在私有main与同名分支，但功能和文学质量仍未全验收。
  研究与实现边界、失败模型实验照原台账保留。主检出的 `_to_delete/` 与 `曹操.md` 仍受保护，
  `.playwright-cli/`、本地配置与付费回包继续忽略。备份与逐组验证见 `docs/agent/archive/git-sync-preparation.md`。
  会话开始时 hook 注入的摘要是实时值，不能用条目总数反推某条业务线又新增了多少文件。
- 这是当前最大的风险：一次整树 restore / 自动 stash / 强制切分支，就能抹掉三周的工作。
  **接手后第一条命令是 `git status --short --branch`，先和下表对账。**
- 最新`origin/main=30ab52c7`已在隔离分支双父合入私有`bc051ed3`，通过现有公开fork更新PR #717，待上游审核；本账号对上游仅pull，不能直接推`origin/main`。
  私有 main 未因公开PR集成而移动；今后双远端同步仍须重新审计，不可把旧 origin/main 直接推回私有 main。
- GitHub CLI 已认证为 `ZhongGWV`；Git 的全局 HTTP/HTTPS 代理为 `http://127.0.0.1:7890`。

## 二、在途工作线

| 台账 | 主题 | 状态 | 卡在哪 / 下一步 |
|---|---|---|---|
| [liblib-import-recovery](tasks/liblib-import-recovery.md) | 节点先保存、素材后台下载 | 待验收 | 89 项回归/类型检查通过；208 节点/139 连线/188 素材恢复，首次保存 4.3 秒；待页面确认 |
| [canvas-pan-stability-analysis](tasks/canvas-pan-stability-analysis.md) | 拖动画布卡顿与闪烁的 LibTV 对照分析 | 待验收 | 已捕获 LibTV 旧缩略图覆盖/淡出交接与抓手禁用命中规则；报告新增节点拖动订阅/指纹链，优先抓手归属与预览交接；只改文档，持续低缩放闪烁仍待可信轨迹 |
| [project-chinese-names](tasks/project-chinese-names.md) | 中文项目名与拼音目录 | 待验收 | 中文重命名及 LibTV 原名功能完成；132 项回归与真实 API 通过，48 文件提交审计/密钥检查通过，推送结果见 Git |
| [multi-provider-models](tasks/multi-provider-models.md) | 多供应商模型目录与路由 | 待验收 | H3 引用 422 和数量提示修复已重启；26 项提交审计/密钥检查通过，本地提交结果见 Git，火山图片仍待单独验收 |
| [pending-code-checkpoint](tasks/pending-code-checkpoint.md) | 已有代码分批提交 | 待验收 | 标题修复已补 DCO，剩余画布代码、测试、设计与交接文档已提交并随 `9d2e486` 推至私有同名分支；本机截图、凭据和工作流未入库 |
| [h3-prompt-optimizer](tasks/h3-prompt-optimizer.md) | H3 参考图完整保留与提示词格式转换 | 待验收 | 本地/云端共用字段布局，去共用段重复、统一空行/音效标题；服务已重启，待用户试转 |
| [h3-completion-recovery](tasks/h3-completion-recovery.md) | H3 完成结果认领及超时恢复 | 待验收 | 按任务 ID 认领修复并重启生效；545秒成品已接回、任务恢复完成，待下次正常生成通知验收 |
| [video-prompt-split](tasks/video-prompt-split.md) | 时间分镜一键拆分 | 待验收 | 完整镜头≤15秒、横排避让、清旧封面；18项回归及类型检查通过，当前五段坐标已修复，待空占位刷新复核 |
| [video-node-duplicate](tasks/video-node-duplicate.md) | 视频节点创建副本 | 待验收 | 顶部创建副本保留引用/参数并清运行态，类型检查通过；待页面点击验收 |
| [liblib-first-import](tasks/liblib-first-import.md) | LibTV 新建首次导入容错 | 待验收 | 27 节点/40 边/51 素材已首次导入；缓存异常中断修复，26 测试与类型检查通过，待历史报错核对 |
| [storyboard-dual-view](tasks/storyboard-dual-view.md) | 工作流 / 故事板双模式 | 待验收 | 三栏/详情/原生成面板/排序引用已实现，345 项相关测试及 CE 构建通过；Chrome 被其他扩展 UI 阻止操作，待关闭后实站对照 |
| [sync-main-remotes](tasks/sync-main-remotes.md) | 将私有最新代码交付现有公开PR #717 | 待验收 | 原35张LibTV图片及图标目录未替换；公开fork的PR已包含双父`66da025f`，GitHub显示MERGEABLE/REVIEW_REQUIRED，origin/main仍`30ab52c7`。合并相关测试/构建通过，全量存量失败与未知再分发许可已如实记台账；下一步由上游审核/合并，不直接推origin/main。 |
| [tv-director-implementation](tasks/tv-director-implementation.md) | 全新 TV Director 剧本工作台与写作链 | 执行中 | 首功能代码/技能/测试与方案已分线提交并推私有main；808后端、77定向前端/build通过。原创三页问卷和五节改编链已接，旧快照、原站同屏像素、文学质量、常规入口和过期方案映射仍待核；不进第二功能、不视为产品验收。历史Seed失败/成功证据保留。 |
| [liblib-tv-director-discovery](tasks/liblib-tv-director-discovery.md) | tvDirector 剧本 Agent 按钮级取证与代码级方案 | 待验收 | 研究方案与规格`0a1d4fac`已推私有main；157项审计的源码哈希/行号因后续代码变更过期，须逐项重审并复跑verify-spec，不能视为产品通过。 |
| [agent-collaboration-protocol](tasks/agent-collaboration-protocol.md) | 多模型协作、方案门与冲突治理 | 已完成 | 独立提交、测试与真实交接闭环已完成；后续变更另开工作线 |
| [legacy-unassigned-diff](tasks/legacy-unassigned-diff.md) | 历史未归属改动隔离区 | 已阻塞 | 只读审计来源；未归属前禁止覆盖或删除 |
| [asset-replacement-picker](tasks/asset-replacement-picker.md) | 画布素材替换：拖拽与点选双入口 | 待验收 | 独立实现与 5 项聚焦测试已通过；待真实画布手工走一遍点选替换 |
| [freezone-entry-recovery](tasks/freezone-entry-recovery.md) | 项目画布入口恢复 | 待验收 | 30 项聚焦测试和生产构建通过；待跨项目、无效深链、首次个人画布浏览器验收 |
| [liblib-canvas-parity](tasks/liblib-canvas-parity.md) | 画布架构与 LibTV 能力对齐 | 待验收 | 指定画布 61 个 HEVC 播放副本已预热，实测节点可显示 1920×1080 动态画面；原片不变，重拍/续写仍待 OSS relay 出片验收 |
| [canvas-grouped-auto-layout](tasks/canvas-grouped-auto-layout.md) | 分组画布整理与本地布局恢复 | 待验收 | 代码与本机 rev47 已修复，项目 API 已确认；待浏览器视觉确认 |
| [text-node-liblib-visual-parity](tasks/text-node-liblib-visual-parity.md) | 文本节点 LibLib 视觉、模型与引用素材 | 待验收 | 模型按钮/浮层按 Liblib 线上尺寸和色值实现，构建通过；待窗口视觉确认 |
| [minimax-h3-liblib-parity](tasks/minimax-h3-liblib-parity.md) | MiniMax H3 视频节点与 LibLib 参数/模式对齐 | 已完成 | 已验收分支集成到 main；后续底部模式入口与 Mixed 顺序由 `minimax-h3-reference-order` 接手 |
| [minimax-h3-canvas-defaults](tasks/minimax-h3-canvas-defaults.md) | DramaClaw MiniMax-H3 视频节点默认参数 | 执行中 | 新建及两个导入入口默认 H3；当前新画布 13 个视频节点已切 H3，旧引用附件验收待续 |
| [canvas-audio-actions](tasks/canvas-audio-actions.md) | 动作注册表 + 音频截取/变速 | 已完成 | 本地 ffmpeg 端到端、23+7 项聚焦测试、生产构建与真实画布截取/2×/刷新验收均通过 |
| [canvas-audio-split](tasks/canvas-audio-split.md) | 音频智能切分 / 自定义切分 | 已完成 | `4b578509` 已推送；17+10 项聚焦测试、构建、三语及真实画布智能/自定义/播放/刷新验收通过 |
| [creative-intro-discovery](tasks/creative-intro-discovery.md) | LibTV 创意片头专项取证 | 已完成 | `bb0bf189` 已推送；可另开实现线，最终供应商画质与扣费仍需真实任务验收 |
| [creative-intro-implementation](tasks/creative-intro-implementation.md) | 创意片头显式节点工作流 | 已完成 | `385139cc` 已推送；基础链完成，原片 5 秒融合与真实供应商生成另开增强线 |
| [creative-intro-blend](tasks/creative-intro-blend.md) | 创意片头融入原片 5 秒 | 已完成 | `dd8ac320` 已推送；本地 compose、双引用五节点/五边、失败回滚与刷新恢复均已实测 |
| [shot-breakdown](tasks/shot-breakdown.md) | 逐帧拉片三维度：分镜 / 动态 / 音乐 | 待验收 | 三层提交与干净快照通过；待真实视觉模型及有/无 demucs 两种音乐路径 |
| [depth-motion-da3](tasks/depth-motion-da3.md) | 拉片动态维度：Depth Anything 3 深度视频 | 待验收 | 任务中心名称与 20 项聚焦回归已补齐；待 CUDA 真机 720p 硬切样片验收 |
| [story-writer](tasks/story-writer.md) | 创作阶段（虾本）：写手 agent + 通用文档存储 + 前端路由 | 待验收 | 14 项后端契约测试与前端 build 已通过；待真实模型四阶段流程和导入链路验收 |
| [local-stack](tasks/local-stack.md) | 命令行 CE 本地栈：local_gateway + ComfyUI Qwen/Krea | 待验收 | 已按用户选择启动945baa9f同步分支，复用原配置/数据；3001/8781/5173/8188和前端代理均200，原6项目可读。Comfy部分triton/FP8插件不可用，具体出图未测，未触发生成；历史双图/Mac验收保留 |
| [canvas-lod-perf](tasks/canvas-lod-perf.md) | 画布 LOD 剔除、低缩放交互、视频抽帧封面 | 待验收 | 20% 缩放的图片/视频标题与页面视觉已核对，ImageGenNode 懒加载和发布容错已回归；慢图交接与大画布帧率仍待量化 |

已完成或放弃的线移到 `docs/agent/archive/`，不要在上表里留尸体。状态只用
`提案中 / 方案就绪 / 执行中 / 待验收 / 已阻塞 / 已完成 / 已归档`。

## 三、冲突雷达（动热点文件前必须看）

| 路径 / 区域 | 本地工作线 | 外部重叠 | 当前处理规则 |
|---|---|---|---|
| 三语翻译、配置文档、协调台账；历史上游集成热点 | sync-main-remotes 最终集成 | 私有main`bc051ed3`与上游`30ab52c7` | 双父`66da025f`已普通推公开fork现有PR #717，尚待审核；私有两分支未被这次公开合并改动，未来双main同步须重新审计/授权 |
| `Canvas.tsx`、`index.css`、`imageData.ts`、`useCanvasSync.ts` | LOD + LibTV 画布 | 历史 `origin/perf/canvas-pan-lod-culling` | 2026-09-18 来源审计已记录；本轮在 4c9dee4 保留当前外壳与故事板，仅串行改 Canvas/index.css 的平移性能，详见 canvas-lod-perf |
| `VideoNode.tsx`、`canvasNodes.ts`、`nodeRegistry.ts`、`NodeActionToolbar.tsx` 等 | LibTV + depth / 拉片接入 | `origin/feat/canvas-video-reshoot-breakdown` | 先做行为与测试的三方差异，不按文件新旧直接取舍 |
| `VideoOperationsPanel.tsx`、`PromptMentionEditor.tsx`、H3 工作台适配器 | MiniMax H3 引用顺序 | `codex/minimax-h3-liblib-parity`、旧 CTA 分支 | H3 已集成；sync-main-remotes 只修候选签名刷新与既有素材替换等待态的 effect 顺序，不改 Mixed 协议 |
| `official_media_models.json` 的 MiniMax-H3 条目、H3 工作台适配器 | minimax-h3-canvas-defaults | `sync-main-remotes` 已合并目录；H3 原实现已验收 | 仅改 H3 默认参数与 LoRA 传参；保留其他上游目录和现有画布透传协议 |
| `ProviderModelPicker.tsx` 的视频模型默认值 | minimax-h3-canvas-defaults | 新节点静态默认值 | 无历史模型选择时默认 MiniMax-H3；保留用户上次明确选择 |
| `freezone.py` 视频参考时长探测 | minimax-h3-canvas-defaults + 多条 Freezone 工作线 | 已合并路由与音频 / 拉片 / LibTV 路由改动共享 | 仅 H3 all_reference 无时长边界时跳过 ffprobe；其他模型、video_edit 与显式时长边界保持探测 |
| `.dramaclaw-local/local.env` 的 ComfyUI 路径 | minimax-h3-canvas-defaults + local-stack | 本机配置是机器私有值 | 仅共享修正 ComfyUI portable 目录 / Python 路径，不记录或改动其他私有值 |
| `freezone.py`、`tasks.py`、`schemas.py`、`jobs.py`、`runners/freezone.py` | shot + depth + LibTV | 远端重拍分支；部分还在 `origin/main` | 按 API schema → job → runner 串行集成，禁止并行写 |
| 音频工具条、动作注册表、Freezone 音频适配层 | canvas-audio-actions + canvas-audio-split + 上述画布线 | 无同类远端分支；共享文件已有已提交功能 | audio actions 提供单段任务合同，audio split 串行追加预览与扇出，禁止整文件覆盖 |
| 三语 `translation.json` | LibTV 与其他前端改动 | `origin/main` + 远端重拍分支 | 合并键，不整文件覆盖；三语同时验证 |
| `routeTree.gen.ts` | story-writer | `origin/main` | 先合并路由源文件，最后重新生成，不手工择一覆盖 |
| TV Director 新路由、`routeTree.gen.ts`、API 注册、三语键 | tv-director-implementation + story-writer | `origin/main` 亦改动生成路由与翻译 | 仅追加路由和键；生成文件由路由工具重建，串行对账，不覆盖已有节点/文案 |
| `docs/guides/liblib-tv-director-development.md` | tv-director-implementation + liblib-tv-director-discovery | 本地新增历史设计；无同路径远端差异 | 双向共享、串行修改；融合v2为实现合同权威，原分析报告观察不变 |
| `nanobanana_grid.py` | local-stack | `origin/main` | 已确认语义互补；同步时同时保留上游归档直拷与本地 multipart / 绕代理 |

已确认的重叠数字（基于当前本地远端引用）：LOD 分支 4 个文件全部与本地脏文件重叠；
视频重拍 / 拉片分支至少 24 个文件与本地脏文件重叠；`origin/main` 有 7 个文件与本地脏文件重叠。
远端引用更新后数字可能变化，决定合并前需 fetch 后复核。

## 四、恢复顺序（不是功能优先级）

用户最新优先级（2026-09-28）：Director两笔实现/方案提交已推私有main；用户仍要求只用本地Seed对原站Seed，不继续DeepSeek横测。常驻栈未因Git推送自动部署。下一步按实现线台账先重审过期方案映射和S1旧快照，再核原创三页问卷/同屏状态、文学与全页像素；不重复堆prompt或盲目买模型。既有失败保留。

1. 交接协议与 handoff 回归修复已独立提交并推送。
2. 只读分类 `legacy-unassigned-diff`，任何未确认归属的文件继续保持隔离。
3. `canvas-lod-perf` 的核心状态层已独立提交；混合 UI 增量继续留给对应工作线。
4. `shot-breakdown`、`depth-motion-da3` 与 `liblib-canvas-parity` 已按契约拆提交；LibTV 剩余
   工作仅是带 relay 的真实出片验收，不要把工作树里的 LOD / 素材替换差异倒灌回已收口提交。
5. `story-writer` 已独立提交；`local-stack` 可移植性和测试已收口，待第二台机器验收后归档。
6. 所有线有独立提交 / 分支、工作区可恢复后，再同步 `origin/main` 并转为一线一 worktree。

这是保护现场的技术顺序，不是产品优先级。若用户改变优先级，先更新方案，但仍不能跳过冲突审计。

## 五、全局阻塞（不是代码问题，改代码解决不了）

1. **`OSS_RELAY_AK` / `OSS_RELAY_SK` 未配置** → 任务能建、能派发，调到视频生成器报
   `OSS media relay config missing`。凡是「视频生成跑不通」，先查这个，别去 debug 业务代码。
2. **ComfyUI 模型 / 节点需单独安装**；`start-local-stack.sh` 默认负责启动和等待，也可配置为复用现有进程。
3. **demucs 未装** → 拉片的音乐维度降级成整轨提取（`mode` 字段会如实上报，不是静默降级）。
4. **公开PR #717 需上游审核** → 已在fork更新并显示可合并，但本账号不能直接推`origin/main`；等维护者审核/合并，不能把PR head当上游main。

## 六、环境速查

```bash
# 后端（云端/标准 CE）
uv sync --group dev && uv run novelvideo api --port 8780
# 本地命令行栈（本机 ComfyUI + 硅基流动），会一并起 local_gateway
cp config/local/local.env.example .dramaclaw-local/local.env  # 首次配置
bash scripts/start-local-stack.sh
# 前端
cd frontend && pnpm install --frozen-lockfile && pnpm dev
```

项目数据在 `state/local/<project>/`（gitignore）；产物在 `output/`（gitignore）。
当前有内容的项目：`chuan_yue_song_chao`、`liblib_canvas_import_review`、`Wawa_qiao`、`test`。

## 七、易丢的本地资产（不在 git 里）

| 路径 | 是什么 | 丢了会怎样 |
|---|---|---|
| `output/local/liblib_canvas_import_review/liblib-shot-breakdown-teardown.md` | 拉片实测原始笔记；证据已整理进 tracked guide | 原始笔记丢失不再导致需求证据归零 |
| `.dramaclaw-local/` | 本地路由配置与密钥 | 本地栈起不来 |
| `.dramaclaw-local/workflows/*.json` | 用户修改过的 ComfyUI 工作流副本 | 会回退到仓库内受审查模板，个性化调整丢失 |
| `曹操.md` | 创作阶段的真实样例产物 | story 线没有可回归的样例 |

这几样值得单独备份一次，再谈别的。

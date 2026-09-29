# LibTV 画布对齐：片段重拍 / 智能续写 / 导入器 / 工具条

**状态**：待验收
**最后更新**：2026-09-29
**基线**：`af8fdc1`；`codex/sync-main-remotes`；原封面工作基于 `4c9dee4`
**认领者**：`codex/hevc-playback-20260929`
**相关文档**：`docs/guides/canvas-architecture.md`（我方画布功能架构与扩展边界）、
`docs/guides/liblib-canvas-parity.md`（真实界面、线上 chunk 与能力差距）
**相关分支 / PR**：`main`；`28936905`、`8bc8d598`、`4959b1d9`、`09e2703a`

## 目标

把画布的视频再创作能力对齐 LibTV 线上版本：片段重拍、智能续写两个入口可用，
LibTV 画布导入不再丢节点语义，视频节点工具条按实测规格对齐。

本轮追加目标：以用户指定的线上画布为样本，必须进入登录态真实界面、选中不同媒体节点并
打开上下文入口，再结合线上 JS/HTML 与本仓库代码，形成可由后续 AI 直接接手的画布架构图、
差距矩阵、优先级和“先方案后代码”的扩展规则。不得把只在词条或按钮上看到的能力写成已验证实现。

## 非目标

- 不把 LibTV 私有的 mention / SegmentRange 状态机原样搬入本仓库。
- 不在来源审计前重写远端分支已有的视频裁切、重拍、续写或 breakdown 生命周期。
- 不借工具条对齐重做整个画布视觉系统。

## 写入边界（既有改动归属）

前端（新增）：

| 文件 | 作用 |
|---|---|
| `features/canvas/application/videoRangePrompt.ts` | 重拍/续写的纯逻辑层，厘秒整数运算、区间校验、提示词组装（36 条单测） |
| `features/canvas/nodes/VideoRemakePanel.tsx` | 区间选择条 + 胶片条，排在生成面板下方 |
| `features/canvas/nodes/VideoContinuationPanel.tsx` | 续写选区面板 |
| `features/canvas/nodes/LiblibMediaNode.tsx` / `liblibMediaNode.css` | 导入兜底的惰性素材卡 |
| `features/canvas/domain/liblibMediaUrl.ts` / `canvasRemoteMedia.ts` | LibTV 远程地址识别与本地化判定 |
| `features/canvas/ui/RemoteMediaBadge.tsx` | 「网络素材」角标 |
| `features/freezone/liblibCanvasImport.ts` / `createProjectLiblibImport.ts` | 导入器与建项目导入入口 |
| `features/freezone/CanvasLocalizeAssetsButton.tsx` | 一键本地化 |
| `features/canvas/nodes/lazyNodeComponents.tsx` | 节点组件懒加载 |

前端（修改）：`nodes/VideoNode.tsx`、`ui/NodeActionToolbar.tsx`、`ui/nodeToolbarConfig.ts`、
`domain/canvasNodes.ts`、`domain/nodeRegistry.ts`、`nodes/index.ts`、`lib/media-url.ts`、
`public/locales/{zh,en,vi}/translation.json`。

后端（新增）：`freezone/liblib_import.py`（分享链接解析）、`freezone/liblib_assets.py`（素材落本地静态存储）。
后端（修改）：`freezone/history.py`。
测试：`tests/test_liblib_assets.py`、`tests/test_liblib_canvas_import.py`、
`frontend/src/__tests__/liblib-canvas-import.test.ts`、`__tests__/canvas-remote-media-localize.test.ts`、
`__tests__/features/canvas/video-range-prompt.test.ts`。

新增的导入器、本地化模块、区间纯逻辑和面板可视为本线独占；`VideoNode.tsx`、`Canvas.tsx`、
节点注册、工具条、三语翻译、后端 `history.py` 及画布任务适配层均是共享热点。

## 协调与冲突
- 2026-09-27：中文项目命名线串行补充 LibTV 原名称保存 / 来源入口 / 预读名称与回归；既有导入合并和首次重试语义保留，由 project-chinese-names 集成。

- 2026-09-27：`project-chinese-names` 在已提交基线上串行调整新建名称校验 / `project.name*` 三语文案；不更改本线交互与数据，由该线会话集成，双方不同时写入。

- 2026-09-26 分支集成：本线已有提交在前，`sync-main-remotes` 持唯一锁串行合入 main 的 TV Director。
  三语只保留并合入各线键值；DESIGN按画布和Director各自章节并存。相关claim已互认共享，
  最终冲突集成归同步线，原功能所有权、验收欠项和待办不变；不改技能或收费生成逻辑。

- 2026-09-26 与 `text-node-liblib-visual-parity` 串行共享 Freezone route：该线只修改 DeepSeek 文本模型选择与透传，由其集成；本线原有功能及写入边界保持不变。

- `origin/feat/canvas-video-reshoot-breakdown` 已有重拍、续写、breakdown、depth capture、工具条与大量生命周期测试，
  至少 24 个文件和当前本地脏文件重叠。该分支的 UI 选择（例如合并下拉）还与本线实测后决定的“重拍平铺”不同，
  属于需要明确取舍的产品冲突，不是机械合并。
- 当前分支从更旧基线展开；三语翻译、`freezone.py`、`tasks.py`、`routeTree.gen.ts` 等同时受
  `origin/main` 影响。不能以当前整文件作为最终提交内容。
- 与 LOD 共享 `Canvas.tsx`、`index.css`、`LodShellNode.tsx`、`AssetCommitHandle.tsx` 等。
  顺序应为：先完成 LOD 4 文件来源审计，再由本线集成者处理工具条 / 节点行为。
- `sync-main-remotes` 是双方 main 合流的最终集成者；只允许在隔离 worktree解决视频/home-node 冲突，
  并让 `history.py` 的说明和测试匹配已提交的全档位预热；必须保留本线重拍/续写/导入行为与 LOD 合同。

## 实施方案（已执行）

1. `28936905`：后端分享链接解析、结构化错误与素材本地化。
2. `8bc8d598`：建项目 / 项目内导入、画布转换、刷新合并与远程素材本地化 UI。
3. `4959b1d9`：重拍 / 续写区间与提示词纯契约，独立 36 项单测。
4. `09e2703a`：面板、工具条、视频节点提交生命周期与三语文案。
5. 配 relay 后分别端到端跑重拍与续写，验证真实产物；这是环境验收，不再继续改契约猜结果。

## 风险与回退

- 最大风险是把两套同名功能同时保留，产生两组状态字段与不一致入口；次要风险是整文件覆盖 LOD / 主线修复。
- 回退按四个功能切片执行；未拆提交前不对共享文件做 restore。

## 进展记录

### 2026-09-29 · 公开 origin 集成共享路径协调

本线已提交节点类型先于 `sync-main-remotes`；后者在独立 `codex/public-origin-sync` 检出中仅对同名 claim 互认的精确路径解决公开上游三方冲突。本线旧媒体导入合同与验收结论不变；最终代码与公开 PR 结果由同步线记录。

### 2026-09-29 · HEVC 播放修复提交及同名分支同步

按用户要求将本线 9 个精确文件独立提交为 `17b3422`（DCO）；先获取同名远端最新 `dd2d57c`，在工作树干净后无冲突合并，保留远端 TV Director 历史及本线播放副本实现。合并树相对远端仅差这 9 个本线文件，未改项目数据或其他工作线代码。本轮只提交到本地，不推送。

提交前后复跑后端播放缓存/路由 4 项、前端播放地址及后台本地化 8 项、TypeScript、Ruff、三语检查、agent guard、差异格式和暂存密钥扫描，全部通过；真实画布播放验收沿用上条证据，未再次执行页面操作。重拍/续写的 OSS relay 出片验收仍待进行。

### 2026-09-29 · 导入 HEVC 视频的浏览器播放兼容方案

目标：用户指定导入画布的 HEVC 视频点击播放后能显示连续画面，进度与画面同步；原始文件及节点 `videoUrl` 保持原样，模型仍读取原片。非目标：批量改写画布、处理未本地化的远端视频、改变其他生成任务的编码。

现状证据：目标画布中 74 个本地 MP4 有 61 个 HEVC；样本为 HEVC Main 10 + AAC、12.064 秒，OpenCV 可读 1920×1080 帧；浏览器播放器走完时长却报 `videoWidth=videoHeight=0`。上传入口已有前端转码，本地化导入只复制原媒体。当前 HEAD `af8fdc1`，本轮目标业务文件与本台账无脏差异；本地 `origin/main` 引用在 `files.py` 仅有 `media_read` 参数差异，在 `VideoNode.tsx` 有旧的多功能差异但无浏览器播放副本。当前分支 ahead 3/behind 6，不在脏工作区拉取或覆盖远端。guard 初始 `check` 通过、无活动锁。

方案：在项目鉴权和路径校验之后，仅对本地 LibTV 导入 MP4 的显式播放请求提供服务端 H.264/AAC 缓存副本；首个请求用已配置 FFmpeg 探测编码并按需转码，缓存键含原片路径、大小和修改时间，临时文件原子替换、并发串行。普通静态地址仍返回原片。视频节点仅给播放器 URL 加兼容查询参数，封面、下载、模型输入和持久化地址均不改。针对既有画布预热 61 个 HEVC 副本，避免首次点击等待。失败时保留原片和封面，服务返回明确错误。本机 `FFMPEG_PATH` 未设置，已配置的便携 ComfyUI Python 含 FFmpeg；解析顺序补为显式配置、系统 PATH、该便携环境的附带可执行文件，不改受其他工作线保护的私有配置。

精确写入：新增独占 `src/novelvideo/freezone/browser_video.py`、`tests/test_browser_video_playback.py`、`frontend/src/features/canvas/application/videoPlaybackUrl.ts`、`frontend/src/__tests__/features/canvas/video-playback-url.test.ts`；修改独占 `src/novelvideo/api/routes/files.py`（`sync-main-remotes` 对该文件只读）；串行共享 `frontend/src/features/canvas/nodes/VideoNode.tsx`。本台账、claim 和 STATE 仅协调更新。共享 VideoNode 当前干净，既有相关工作线已互认 `liblib-canvas-parity`；本轮只加播放器 URL 的纯函数调用，不触及其他线的 LOD、拉片、拆分逻辑。

风险与回退：首次转码消耗 CPU/磁盘；限制输入大小、并发和墙钟时间，副本放项目缓存目录，原片不变。缺 FFmpeg 时请求失败但普通媒体服务不受影响。回退只移除本轮接口和播放器参数，缓存可保留且不参与画布数据。验证：纯函数与后端缓存/路由聚焦测试、类型检查、目标页面播放时 `videoWidth>0` 且画面随进度变化；不提交生成任务。

实施前：更新本线 claim，取得 `liblib-canvas-parity` owner 锁，对上述精确路径 preflight；结束后记录测试和页面结果并 handoff/release。

实施与验收：新增导入视频的浏览器播放副本服务和播放器 URL 选择，保持节点持久化地址与原始 MP4 不变。目标画布 74 个 MP4 中，61 个 HEVC 已预热为 H.264/AAC 副本，13 个 H.264 继续使用原片，全部成功。聚焦后端测试 4 项、前端测试 2 项、TypeScript 构建、Ruff、`git diff --check` 和 agent guard check 均通过。重启本地服务后，在指定画布实际点击节点 `v-n3N25b9Q3w`：修复前播放走到 12.064 秒时 `videoWidth=videoHeight=0`，修复后播放器使用 `st_video=h264` 地址、`videoWidth=1920`、`videoHeight=1080`，不同播放时刻截到不同画面。未启动视频生成任务。既有本线重拍/续写的 OSS relay 验收欠项仍在；本轮视频播放问题已验收。

### 2026-09-27 · 平移性能线串行协调

本线封面实现先完成，canvas-lod-perf 后串行修改共享 Canvas/index.css，由 codex/pan-fix-20260927 集成。保留本线未提交的 VideoNode/videoFrameCapture/LodShellNode 封面 hunk；本轮性能线不改变画布数据与故事板接口。

### 2026-09-27 · 全档位视频封面预览已实现

- 改动：普通 VideoNode 默认绘制静态封面，点击播放才同步创建播放器；首帧 loadeddata 前保留封面，暂停后保留已加载播放器供继续播放和截图；播放失败保留重试入口。播放前使用已保存的时长、分辨率；替换素材或进入生成/上传状态时重置播放会话。
- 封面归属：videoFrameCapture 的候选封面选择增加可选导入源比较；VideoNode 和 LodShellNode 同时透传。当前视频不是原导入视频时，忽略旧导入封面，复用现有服务端封面 / 限并发离屏抽帧兜底。没有封面的素材仍可能由原队列加载视频取一帧，不能据此宣称全站零视频请求。
- 范围：仅三个前端文件的预览 / 控件 / 封面来源判断，以及两线协调台账和本线索引；未修改节点坐标、尺寸、引用、生成参数或 LOD 策略。前一轮性能分析文档保留，未提交代码。
- 检查：TypeScript 编译 `tsc -b frontend/tsconfig.json --pretty false` 最终退出 0；迭代中发现的 isUploading 声明顺序和 ShellData 元数据类型错误均已修复。`git diff --check`、前端 i18n 棘轮（0 命中）、agent guard check（32 工作线 / 1031 claims）通过。
- 验收欠项：本轮用户要求实现，未要求测试，因此没有新增/执行测试、浏览器交互验收或媒体生成。下一步在目标大画布刷新后对比未播放时的拖拽表现，再确认点击播放、暂停继续、加载失败重试和新结果封面；本记录不宣称帧率改善已经实测。
- 回退：仅撤销本轮 VideoNode 预览与控件、LodShellNode 导入源透传、videoFrameCapture 导入封面归属判断的 hunk；保留历史功能和分析文档。

### 2026-09-27 · 全档位视频封面预览方案

- 授权：用户在画布性能分析后要求「先实现这个」，即复用本地已有封面，点击播放才创建播放器。
- 目标：普通视频节点无播放请求时显示静态封面；播放入口、已知时长和分辨率无需等待播放器；加载首帧时保留封面；更换素材重置播放状态。
- 非目标：不实施报告其余 LOD、裁剪、手势和 store 重构；不改变坐标、句柄、引用、生成提交、画册与历史播放交互；不提交代码。
- 证据：目标画布 61 个视频节点均有本地 previewImageUrl，55 张去重封面实际存在；VideoNode 仅低档位使用封面，高档位创建 video#t=0.1；底部控件和分辨率受 hasMetadata 门控。
- 基线与重叠：VideoNode.tsx 本地无 diff；origin/main..HEAD 的差异属于已集成的拆分、引用错误、续写等功能，没有此封面预览改法，均保留。旧远端重拍分支审计记录沿用本台账，不整文件覆盖；分析报告的四个文档为前一轮未提交产物，保持其归属。
- 精确写入：共享 `frontend/src/features/canvas/nodes/VideoNode.tsx`，以及本台账、对应 claim 和 STATE。现有 depth-motion-da3 / shot-breakdown / video-prompt-split / sync-main-remotes 均已先完成相应提交，本会话后串行集成预览段，既有共享约定继续适用。
- 封面正确性补充：代码审查发现生成完成仅替换 videoUrl，导入封面和来源元数据仍在。增加现有共享 `application/videoFrameCapture.ts` 的导入源匹配判断、`nodes/LodShellNode.tsx` 的同参数透传，防止新视频继续显示旧导入封面；不改 LOD 挂载策略。两文件当前无本地 diff，origin/main...HEAD 也无差异；沿用已集成封面管道。本线后串行集成，协调记录补入 canvas-lod-perf 台账；claim 已互认这两条路径。
- 步骤：播放状态按视频源绑定；控件支持未挂播放器时请求播放，并在用户点击中同步挂载；用现有封面覆盖首帧加载；元数据事件仅按差异更新素材信息；保留错误反馈与重试、暂停/继续及截图动作。
- 风险：浏览器播放授权需保持在用户点击内；请求播放但尚未开始时也需保护 LOD 媒体活跃状态；素材替换要防止旧播放状态复用。暂停后的已请求播放器保留以便继续和截当前帧，未点击播放的节点不创建播放器。
- 回退：只撤销本轮三个前端文件中的预览/控件/封面来源 hunk，不改任何画布数据或整文件回滚。
- 验证计划：类型编译和 diff/guard 静态检查；本轮未要求测试，不新增或运行测试，不提交生成任务。浏览器播放与冷/热缓存表现留作用户试用验收。
- 执行门：owner `codex/video-poster-20260927`，acquire/preflight 成功后写业务代码。

### 2026-09-27 · 分组备注样式落地并完成目标画布呈现对照

改动：新增 GroupNodeHeader，仅普通工作流组采用；保持故事板拖动头、组尺寸计算和子节点布局逻辑。groupColors 对齐 10% 底色、20% 边框，导入 groupColor 并保存 importedGroupColor，刷新保留用户改色（兼容旧导入）。index.css / DESIGN.md 同步标签配色和尺寸。用户指定画布通过已有 base_revision 保存接口从 revision 3 保存至 4，仅补 15 组颜色元数据，10 组恢复颜色；原数据备份留在忽略目录。

原因：通用 NodeHeader 在低缩放下文字太小，导入遗漏 groupColor；分组需要独立且固定屏幕尺寸的标签。复用 CSS 缩放变量，无新增每组缩放订阅。原站 DOM 取证结果与本地当前 DOM 一致：普通 13px / #919191；彩色 12px 白字、24px 高、6px 圆角；红 #4e1714、青 #014a5a、绿 #0c4327。

验证：两次 TypeScript `tsc -b frontend/tsconfig.json --pretty false` 退出 0；本轮路径 `git diff --check` 通过。Chrome 查看实际目标页面和截图，彩色标签已生效；一次开发 CSS 缓存未更新，重新保存样式文件后 HMR 已载入新 tokens。API 只读核对 revision 4、128 节点、512 边，全部坐标/尺寸/父组/样式几何与全部边保持原样。未新增或执行测试（本轮用户只要求样式调整）；未提交生成任务或代码。

Guard：owner codex/group-label-20260927 acquire 成功，首次 preflight 提醒旧基线，已按读取到的 762591d 审计并更新 ledger/claim；后续所有业务路径和目标数据路径 preflight 通过。canvas-lod-perf 的 index.css 共享声明和串行顺序同步在双方台账。

本轮完成；原工作线早期视频重拍/续写待办保持原状态。后续如需扩展其他色板，先实测原站对应 badge token，勿改工作流几何。


### 2026-09-27 · 工作流分组备注样式方案（已执行）

- 目标：普通组标题 13px 灰字；彩色组 12px 白字、24px 高 / 6px 圆角 / 横向 6px 内距标签；缩放保持可读。恢复来源 groupColor，背景/边框分别 10%/20%。
- 非目标：不移动、缩放、重排节点，不改边、文本、媒体、故事板布局、提示词和任务调用。
- 基线：762591d，codex/sync-main-remotes。拟改业务文件目前无本地 diff；origin/main 与同步分支没有同类样式差异，旧 H3 分支只有旧导入器差异，复用当前导入器，不移植旧代码。
- 证据：用户指定原站实际 DOM，普通文字 13px / #919191，彩色 12px / 18px，badge 24px / 6px；分组 header 使用 inverse zoom。源数据 15 组，其中 8 个红色、1 青色、1 绿色；本地漏 groupColor。
- 精确写入：共享 GroupNode.tsx、canvasNodes.ts、index.css；独占 groupColors.ts、ui/GroupNodeHeader.tsx、liblibCanvasImport.ts、DESIGN.md。原有 GroupNode/Canvas LOD 先完成，本线后串行集成，只消费现有 --st-canvas-zoom，不新增逐节点缩放订阅。index.css 与 canvas-lod-perf 共享声明双方同步；由本会话集成。
- 步骤：独立组标题组件；颜色导入和刷新时保留用户修改；补齐设计 token；通过现有带 base_revision 的保存接口修复目标画布的颜色字段并备份本地原数据；浏览器查看结果。
- 本地修复只按源 nodeKey 对齐 15 组的 backgroundColor / importedGroupColor，不改任何几何和引用，走现有 API 和历史备份，不做通用迁移。诊断与备份在忽略目录 .dramaclaw-local。
- 风险：旧画布颜色曾被用户编辑；已有颜色保留，刷新只在与上次导入值相同才更新。回退仅本轮 hunk 和颜色备份，不整树还原。
- 验证：类型检查、diff 检查与页面 DOM/截图观察。本轮用户未要求测试，不新增或运行测试。
- owner：codex/group-label-20260927；acquire/preflight 通过后写代码。


### 2026-09-19 · 目标画布真实交互复核与架构方案固化

改了什么：登录用户指定的 LibTV 画布，分别选中视频、图片、音频节点，打开添加节点、素材库、
人像造型室、生成历史、故事板和 Agent/Skill 面板；补查当日线上 chunk 的节点枚举、动作常量、
图层文案和 payload/workflow/voice/实体库接口。新增 `docs/guides/canvas-architecture.md`，把我方
节点/边、任务、保存冲突、恢复、主线提交和扩展方案门串成一份接手文档；重写竞品文档顶部的
证据分级、真实工具条矩阵、逐帧拉片交互、差距优先级和“不照搬”边界。

为什么这么改：视频节点上的逐帧拉片、主体消除、创意片头，以及图片图层分离、音频切分等能力
只有选中对应节点才出现，单看首页、静态 HTML 或 i18n 都会漏项或误判。新能力继续直接写入
2,823 行工具条和 4,481 行视频节点，也会复制能力门控、任务提交和结果解析，所以先把统一动作
注册表、派生故事板、类型化结果投影和独立工作线规则定下来。

怎么验证的：登录态目标画布起始显示 93 个节点；逐类选中节点核对上下文工具，切换故事板并
打开上述面板。点击一次逐帧拉片后确认它会先创建含“分镜/动态/音乐”的派生草稿节点，节点数
变为 94；未点击“开始拉片”，没有创建任务或消耗积分，且为避免误删没有远端删除。仓库侧用
`rg` 对回节点类型、工具条、同步、存储和 API 实现，并执行 `agent_guard check/preflight`。
本轮只改文档和台账，没有修改业务代码，因此未重复跑业务测试。

### 2026-09-19 · 本轮提交已推送并完成远端核对

改了什么：四层功能提交与交接记录已推送到 `zhonggwv/main`；没有改写只作上游对照的
`origin`。GitHub CLI 已重新授权为 `ZhongGWV`，并把 Git 的全局 HTTP/HTTPS 代理设为
`http://127.0.0.1:7890`，后续 Git 推送不再依赖临时环境变量。

为什么这么改：此前发布失败是主机未使用本地代理和旧 CLI 凭据失效，不是代码或远端分支冲突。
代理和官方设备授权恢复后，按常规 fast-forward 推送；没有使用 force push。

怎么验证的：代理下 `github.com` 返回 HTTP 200；`gh auth status` 显示活动账号 `ZhongGWV`
且具备 `repo` / `workflow` 权限；`git push zhonggwv main` 将远端从 `2ca34419` 快进到
`92f07de3`，`git ls-remote --heads zhonggwv main` 返回相同哈希。

### 2026-09-18 · 四层提交与干净快照收口

改了什么：将混在长期脏工作树里的 LibTV 功能拆成后端安全边界、前端可编辑导入器、视频
区间纯契约、重拍/续写 UI 生命周期四个提交。每次只暂存本线 hunk；翻译中的素材替换键、
`VideoNode` 的 LOD 封面订阅以及其余性能文件都继续留在各自工作线。

为什么这么改：后续 AI 可以按提交、台账和稳定错误码逐层定位；不需要重新从 49 个脏状态条目
猜哪些文件属于 LibTV，也不能再用整文件覆盖的方式“合并”共享热点。

怎么验证的：后端 23 项测试、ruff、后端 i18n 通过；前端导入/本地化 26 项和视频规则 36 项
通过；两次从 Git index 导出的干净快照均通过三语 JSON、前端 i18n、`tsc -b` 与 Vite build。
真实生成仍因缺少 OSS relay 凭据停在供应商转发层，明确保留为环境验收项。

### 2026-09-18 · 重拍与续写接入视频节点生命周期

改了什么：工具条新增平铺的片段重拍和智能续写入口；重拍派生下游视频编辑节点并保留每段
意图，续写先调用既有合成任务裁出可见前置片段，再建立带边绑定的续写节点。提交前会锁定
可容纳源片时长的视频编辑模型、校验源视频与区间、检查续写绑定；LibTV 远程视频未本地化时
所有服务端操作在入口即阻止。三语文案和实测工具条尺寸同步进入同一切片。

为什么这么改：重拍/续写会产生收费任务，不能让模式兜底静默丢掉区间，也不能在前置片段或
连线已变化时照常生成。工具条、面板和提交守卫必须作为同一个可构建切片交付，但 `VideoNode`
中的 LOD 封面/订阅优化继续留在工作树，避免跨工作线覆盖。

怎么验证的：从暂存区导出干净快照；区间单测 36 项通过，三语 JSON 可解析，前端 i18n 棘轮
为 0，`tsc -b` 通过，Vite production build 通过（5414 modules）。

### 2026-09-18 · 视频区间规则先固化为无界面契约

改了什么：把片段重拍与智能续写的区间类型、厘秒精度校验、插入/缩放、提交前全量拒绝、
提示词生成和续写绑定有效性独立成纯逻辑模块；画布视频节点只新增持久化这些状态所需的字段，
并用单元测试覆盖边界、浮点误差、失效连线和源素材变化。

为什么这么改：这些规则同时被面板和提交生命周期消费，若先塞进 `VideoNode.tsx`，后续模型换人时
很容易在 UI 重构中悄悄改掉 4–30 秒、最多 5 段或“整批拒绝”等产品约束。独立提交也避免把
当前工作树里的 LOD 解码优化混进重拍功能。

怎么验证的：`vitest run src/__tests__/features/canvas/video-range-prompt.test.ts` 通过 36 项；
并从暂存区导出干净快照执行 TypeScript 构建，避免未提交 UI 文件替这次提交“垫过”编译。

### 2026-09-18 · 导入器前端拆成可构建的垂直切片

改了什么：接通项目新建、项目卡片和项目内画布菜单三类 LibTV 导入入口；把分享链接、画布
转换、节点/连线语义恢复、刷新合并、远端素材标记与一键本地化收进同一提交。导入失败不再
直接显示后端中文，而是按稳定错误码走 zh/en/vi；项目已经创建但导入失败时保留原项目并提供
重试/进入入口。共享的 `Canvas.tsx`、`FreezoneShell.tsx`、素材面板和大纲均只暂存本线 hunk。

为什么这么改：原工作树把导入器和 LOD、素材替换、视频重拍混在相同文件里；整文件提交会把
尚未审计的状态一起带走。兜底 `liblibMediaNode` 在本提交先直接渲染，不依赖尚未提交的 LOD
外壳；后续性能切片再安全接入外壳。

怎么验证的：从 git index 导出干净快照；前端导入/本地化 26 项测试通过，三语 JSON 可解析，
前端 i18n 棘轮为 0，`tsc -b` 通过，Vite production build 通过（5411 modules）。

### 2026-09-18 · 完成远端重拍分支的行为审计

改了什么：逐提交核对远端 `985cb759`（重拍）、`11f094c5`（续写）与 `be19c5d3`
（收口修复），把可复用契约、明确冲突和本地补强写进长篇方案的差异表；同时把声明基线更新到
shot / depth 已收口后的 `2ca34419`，补齐本线真实会触碰的集成文件。

为什么这么改：远端是「源节点内操作 + SegmentRange mention + 合并下拉」，本地已经实机验证的是
「下游派生节点 + 每段 intent + 重拍平铺」。两者同名但状态模型不同，整文件合并会同时保留两套状态机。

怎么验证的：`git show --stat` 核对上述三个提交，并逐项查看远端 `video-reshoot-*`、
`video-extend-*` 测试清单；本地独立模块基线为后端 16 项、前端 62 项通过。前端 i18n 棘轮仍报告
本线若干中文协议 / 兜底文案以及别线设置页文案，已列入拆提交前修复项。

### 2026-09-18 · 端到端实跑，逮到模型时长上限问题

做了什么：本地 dev server 上把片段重拍从工具条点到提交，修了两处——挑模型时把
「这条源片放不放得下」算进去并优先选**明确声明了上限且装得下**的模型；提交前对源视频
也跑一遍时长校验。

为什么：自动换上的 Wan 3.0 声明 `referenceVideoMaxSeconds: 15`，源片 15.093 秒，
后端回 `400 video reference duration must be <= 15s`。用户看到的是英文 400，不是可读提示。

怎么验证的：工具条 → 片段重拍 → 镜头跟到新节点 → 胶片条出现 → 截出 5.0s 区间并显示时长角标
→ 写意图 → 刷新后区间与意图还在 → 模式锁在「视频编辑」、参考列表挂着源视频 → 提交建出任务。
**到这里停住**：缺 `OSS_RELAY_AK/SK`，报 `OSS media relay config missing`，出不了片。

### 2026-09-18 · 工具条按 LibTV 实测计算样式对齐

做了什么：在 LibTV 画布上选中视频节点直接量计算样式（不是照截图描），对齐条背景
`rgb(38,38,38)`、描边 `0.5px solid rgb(54,54,54)`、圆角 12px / 内距 4px / 间距 4px / 条高 41px、
按钮高 32px / 圆角 8px / 字号 13px、相对节点居中上方 32px。

为什么这么改：片段重拍在他们那儿是**平铺的第二个按钮**，不是下拉，所以我们也平铺
（此前一度收进「再创作」下拉，已改回）。他们的工具条同样会超出窄视口（实测 908px），
我们额外加了最大宽度 + 横向滚动——这是**有意比他们多做的一步**，不是抄漏了。

### 2026-09-18 · 实机联调，修四个「写完了但不能用」的问题

1. **未本地化的 LibTV 素材让所有服务端视频操作 400**（`url must be a same-origin path`）。
   现在这些按钮在网络素材节点上直接置灰并提示先一键本地化，而不是等 400 回来。
2. **工具条被挤出视口**（实测条宽 746px / 可视 444px，左右各约 150px 在视口外）。
3. **重拍节点的模式被兜底逻辑顶走**：抓到 `genMode: "allReference"`，用户圈的区间一个都没进
   提示词，还照付一次钱。现在重拍/续写节点会把模型换成支持视频编辑的那个并钉死模式。
4. **新建节点落在视口外**（落到源节点左边 658px），看着像「点了没反应」。现在 `requestFocusNode` 把镜头带过去。

顺手改掉：重拍选区条从节点上方挪到生成面板下方（上方是 React Flow 节点工具条的地盘，
是独立浮层，永远压在上面）；选区条的 ✕ 从「踢出重拍模式且回不去」改成只清空所选片段。

### 2026-09-18 · 三步功能落地

第一步片段重拍、第二步智能续写、第三步导入器补齐节点类型，三步都已实现。
具体分叉理由见下节与 `docs/guides/liblib-canvas-parity.md` 第六节。

## 已定下来的决策（不要回头改）

- **竞品证据分成 UI-实操、JS-逻辑、文案可见、我方代码四级。** 看到按钮只能证明入口，不能
  宣称请求协议、收费行为和产物已验证；尤其“创意片头”先做受控 discovery spike。
- **先建立统一画布动作注册表，再继续往工具条加能力。** 动作必须声明适用节点、能力门控、
  副作用类型、任务协议、结果 projector 和恢复策略；工具条、右键菜单和 Agent 消费同一份定义。
- **故事板是现有图的派生视图，不保存第二份图。** 第一阶段只读投影，排序只保存 override；
  故事板中的操作仍回到统一动作层。
- **图层分离要落成版本化 layer document，不能继续给图片节点堆松散可选字段。**
- **主体消除、创意片头、智能剪辑分别立项。** 不因 LibTV 把它们排在同一工具条就塞进一个
  共享组件改动；“导演台”同名也不能在语义未核对前视为相同能力。
- **重拍不在源节点上就地改，而在下游派生一个「片段重拍」节点**，源视频靠连线带过去。
  ——和「视频高清」同一个模式。重拍产出的是一条新视频，覆盖掉用户手里那条没道理，派生出来还能并排比。
- **`editSegments` 暂不发**，只发提示词那份。——`model_params` 按媒体目录声明做严格校验，
  目录里没声明的 key 直接被拒。结构化那份留在 `buildEditSegments` 里备着，等哪个模型目录声明了再接。
- **指代源视频用「这段视频」，不用 `@视频1`**。——后端按编号解析引用，而视频编辑模式下
  源视频是独立字段、不进编号引用列表，写编号只会解析失败。LibTV 的 `{{Mixed 1}}` 是他们自己那套 mention 归一。
- **不跟进 `{{SegmentRange}}` 内联标记方案**，沿用我们每段一个 `intent` 字段。
  ——标记同步是一套额外状态机，收益只在「跨段连贯描述」一种写法上。**这是有意分叉，不是遗漏。**
- **续写的前置片段落成画布上可见的节点**，不藏进续写节点字段。——效果不对时第一件要查的
  就是「这段裁对了没有」，藏起来就查不了；它本身也是可复用素材。
- **模型门控沿用 `video_edit` 能力**，不新造 `supportVideoContinuation` 位。
  ——造一个我们无法验证真假的能力位，只会让入口全灰着或者灰错。
- **导入器认不出的节点类型改看它挂的素材**（读 `_resourceMeta.items[].kind`，再看地址后缀），
  不按类型号硬映射。——脚本(20/21)和剧本(50)的 payload 结构没对照过，映射成 `scriptNode`
  只会得到一个空表格，比一张带标题的素材卡更糟。10（COMMENT）直接落文本节点。

## 待办

- [ ] 配上 `OSS_RELAY_AK` / `OSS_RELAY_SK`，把片段重拍真正出片一次，把结果记到本台账
- [ ] 智能续写还没做过同样强度的端到端实跑（重拍那轮暴露的四类问题，续写侧未逐一排查）
- [x] 用户指定画布已按视频/图片/音频选中态及故事板/Agent/资产面板完成真实 UI 复核
- [x] 我方画布架构、方案门、差距矩阵和分阶段路线已写入 tracked guide
- [x] 混合改动已拆为四个可评审、可单独构建的提交
- [x] `docs/guides/liblib-canvas-parity.md` 已纳入版本控制，取证不再只存在本机

## 阻塞

**环境，非代码**：`OSS_RELAY_AK` / `OSS_RELAY_SK` 未配置。任务能建、能派发，
调到视频生成器报 `OSS media relay config missing`。


## 验收标准

- 源片 3.9 秒时重拍入口禁用并给出原因；超过 5 段无法再加。
- 把某段拖到与相邻段只剩 4.0 秒空隙时提交被拒，且指出是哪一段。
- 提交后请求体里的提示词与面板上的区间一致。
- 续写：选区短于 4 秒或长于 30 秒时确认按钮禁用；源节点删掉后提示重选而不是提交失败。
- 导入一张含脚本/拉片/参考节点的 LibTV 画布，这些节点落成带素材的图/视频节点而非空卡。
- `cd frontend && pnpm test` 全绿；`uv run pytest tests/test_liblib_assets.py tests/test_liblib_canvas_import.py` 全绿。

## 交接摘要

- **最后完成到**：四层实现已提交并通过干净快照验证；本地重拍已走到任务创建，续写未同强度实跑。
- **下一步唯一动作**：配置 `OSS_RELAY_AK/SK` 后真实出片一次，再按同一清单跑续写，不要先重写状态模型。
- **先读这些文件**：本台账决策、`docs/guides/liblib-canvas-parity.md`、远端相关测试。
- **不要动这些文件 / 决策**：不要先覆盖共享画布文件；保留“派生节点”和“重拍平铺”的已验证理由。

### 2026-09-26 · 故事板共享协调

本线既有实现先完成，storyboard-dual-view 后续串行集成共享视图接点；保留本线生成和保存行为。由当前 Codex 会话集成，禁止改工作流坐标。

### 2026-09-26 · 首次导入容错协调

index.tsx 既有改动已提交且当前无 diff；liblib-first-import 在本线之后串行修新建排序缓存容错，由当前 Codex 会话集成，保持导入与卡片功能。

### 2026-09-26 · 新建/导入 H3 默认模型共享协调

本线提交的节点/导入入口先完成，minimax-h3-canvas-defaults 后串行修改默认模型选择；当前相关业务路径无历史 diff，由 Codex 集成，保持其他导入和卡片行为。

### 2026-09-26 · 视频副本工具条共享协调

本线原工具条功能先完成；video-node-duplicate 后串行追加副本按钮，复用 store 入边复制，当前 Codex 会话集成，不变更本线操作。

### 2026-09-26 · 时间分镜拆分协调

本线先完成，video-prompt-split 后串行集成，保留原功能；当前会话集成共享路径：frontend/src/features/canvas/nodes/VideoNode.tsx, frontend/src/features/canvas/ui/NodeActionToolbar.tsx, frontend/public/locales/zh/translation.json, frontend/public/locales/en/translation.json, frontend/public/locales/vi/translation.json。


### 2026-09-26 · H3 提示词优化协调
原工作先完成，h3-prompt-optimizer 在共享路径串行增加可选优化参数/入口/翻译，由当前会话集成，保留原行为。


### 2026-09-27 · 多供应商模型接入协调
用户已授权多供应商选择，替代原本固定硅基流动的限制。已有实现先完成，本线由 multi-provider-models 串行扩展模型目录、调用路由与选择器；最终集成为当前会话，保留既有数据和工作流。共享路径：frontend/public/locales/zh/translation.json, frontend/public/locales/en/translation.json, frontend/public/locales/vi/translation.json, src/novelvideo/api/routes/freezone.py。

### 2026-09-27 · 预览与拖动串行协调

canvas-lod-perf 在现有实现之后串行修改共享 VideoNode 的封面显示档位、预览就绪标记与内容引用订阅；保留本线生成/布局语义，由 codex/pan-stable-20260927b 集成。


### 2026-09-27 · LibTV 分阶段导入协调
现有实现先完成，liblib-import-recovery 后串行增加节点先保存、素材进入画布后分批后台下载及结构化 404 兼容。仅合并精确差异，保留其他功能，由本线会话最终集成。

### 2026-09-28 · 连线配色串行协调

既有 DESIGN 内容先保留，canvas-lod-perf 后续仅补用户指定的 LibTV 连线三色与流星说明，由 codex/edge-meteor-20260928 串行集成；不改变本线视觉或接口。

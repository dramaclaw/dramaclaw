# 画布 LOD 剔除与低缩放交互

**状态**：待验收
**最后更新**：2026-09-28
**基线**：`8428b3a`；2026-09-28 方案按当前工作树核对，保留此前 `4c9dee4` 起的封面、平移与诊断增量
**认领者**：`codex/commit-media-title-20260928`
**相关文档**：[实施方案](../../guides/canvas-pan-stability-implementation.md)、[LibTV 对照分析](../../guides/canvas-pan-stability-analysis.md)（前端视觉改动须先读 `DESIGN.md`）
**相关分支 / PR**：`08f8f410` 是旧树上的替代方案；当前实现继承已合入主线的 `1fa4b558`，不能整分支覆盖

## 目标

画布节点多时不卡：低缩放下用简化外壳替代完整节点，配套的交互（音频播放、外部文件拖入、
图片变体、视频抽帧封面）在简化态下仍可用。

## 非目标

- 不借性能优化重做节点视觉、数据模型或视频再创作工具条。
- 在来源审计完成前不继续扩展 LOD 功能，也不把远端分支整段覆盖到当前工作区。

## 写入边界（既有改动归属）

| 文件 | 新增/修改 | 作用 |
|---|---|---|
| `features/canvas/application/canvasLod.ts` | 修改 | LOD 判定 |
| `features/canvas/nodes/LodShellNode.tsx` | 修改 | 简化外壳节点 |
| `features/canvas/Canvas.tsx` | 修改 | |
| `features/canvas/application/videoFrameCapture.ts` | 修改 | 视频抽帧封面 |
| `features/canvas/application/imageData.ts`、`graphImageResolver.ts`、`graphContentResolver.ts`、`videoTranscode.ts`、`videoFrameCapture.ts` | 修改 | 变体阶梯、远端封面与按需转码 |
| `features/canvas/ui/CanvasNodeImage.tsx`、`nodeFrameStyles.ts`、`NodeHeader.tsx`、`NodeGenerationOverlay.tsx`、`NodeToolDialog.tsx`、`AssetCommitHandle.tsx`、`CanvasHistoryAssetsModal.tsx` | 修改 | |
| `features/canvas/nodes/{GroupNode,ImageGenNode,SkillNode,ThreeDWorldNode,UploadNode}.tsx` | 修改 | |
| `features/viewer-kit/three-d/ThreeDDirectorDialogLazy.tsx` | 新增 | 三维对话框懒加载 |
| `features/canvas/nodes/lazyNodeComponents.tsx` | 新增 | 3D / 全景节点按需加载与预热 |
| `lib/media-url.ts`、`freezone/history.py`、`vite.config.ts` | 修改 | 全档位预热、远端缩放与 bundle 分包 |
| `__tests__/features/canvas/{canvas-lod,lod-audio-playback,external-file-handoff-low-zoom,node-body-image-variant,video-frame-capture-poster,asset-replace-pick}.test.*` | 修改/新增 | |

上述路径以 `frontend/src/` 为根。新增的 LOD 模块与测试可视为本线独占；`Canvas.tsx`、`index.css`、
`imageData.ts`、`useCanvasSync.ts`、`LodShellNode.tsx`、`AssetCommitHandle.tsx` 等是共享热点，不能并行写。

## 协调与冲突

- 2026-09-27：liblib-canvas-parity 在已提交基线后串行补充静态视频预览；仅在共享 videoFrameCapture.ts 校验导入封面与当前视频源是否一致，LodShellNode.tsx 透传导入本地源。不更改本线 LOD 阈值、挂载、尺寸、变体或抓帧队列，由 codex/video-poster-20260927 集成。

- `origin/perf/canvas-pan-lod-culling` 相对本地基线只改 4 个文件：`Canvas.tsx`、`imageData.ts`、
  `useCanvasSync.ts`、`index.css`；这 4 个文件当前也全部为本地脏文件。
- `LodShellNode.tsx`、`Canvas.tsx`、`index.css`、`AssetCommitHandle.tsx` 同时被远端
  `origin/feat/canvas-video-reshoot-breakdown` 触及，且本地 LibTV 线也改画布热点。
- 下一步必须先按函数 / 测试比较本地与远端 LOD，不以提交时间或整文件 diff 直接选一份。
  审计完成前，这条线只允许只读分析和性能测量，不再写共享热点。
- `sync-main-remotes` 可在最终合流时只修正 `freezone/history.py` 的旧 docstring，并同步上游测试断言为
  本线已经交付的全档位预热；不得改变 LOD 档位或队列策略。

## 实施方案（后续）

### 2026-09-28 · 低缩放图片/视频标题与 LibTV 对齐

目标：用户给出的导入画布在约 20% 缩放时，每个图片、视频缩略图上方显示节点标题；保持已有标题文本、低缩放封面、连线、分组位置和节点宽高。非目标：不修改导入数据、名称、完整节点 Header、分组布局或 LOD 阈值。

证据：完整 `ImageNode`/`VideoNode` 已用 `localizeNodeDisplayName` 和浮动 `NodeHeader`（12px、top:-28px）；`withLodShell` 在低缩放换成 `LodShell`，后者只画缩略图/正文/状态，没有标题。截图中本地媒体缩略图有图无标题，LibTV 同缩放有标题。HEAD `8428b3a`、behind 6，`LodShellNode.tsx` 和 `index.css` 已有本线预览交接与抓手增量，逐段保留；本地 `origin/main` 对 LodShell 无同路径差异，对 index.css 有历史重叠，不合并整文件。

做法：仅在图片/视频类 shell 渲染一条绝对定位标题，与 shell 主体作为同一 React Flow 节点的并列子元素；节点主体仍 overflow:hidden，标题从外侧显示，不改变尺寸测量或封面裁切。标题用现有 `localizeNodeDisplayName` 保持自定义名和默认名的语言规则；LibTV 媒体节点只在图片/视频种类显示。CSS 沿用正式 Header 的 -28px、12px、普通字重与近白色，在窄节点裁切，不接指针、动画或 ResizeObserver。精确写入：既有共享 `frontend/src/features/canvas/nodes/LodShellNode.tsx`、`frontend/src/index.css` 的新局部段落，以及本台账/STATE；不触碰 ImageNode、VideoNode 或其他工作线。共享文件由本 owner 串行集成。

风险与回退：标题增加每个媒体 shell 一个轻量元素；缩放极低时文字会很小，但不允许反向放大引发布局跳动。若视觉不符，仅撤本轮并列标题和 CSS。验证计划：类型编译、diff/guard 与目标画布页面外观核对；用户未要求运行测试套件，本轮不新增或运行测试。

### 2026-09-28 · 单 SVG 连线绘制进入正式画布

用户要求把已有 DEV 单 SVG 对照推广到正常画布。当前基线 `8428b3a`，工作树已有本线的 Canvas/边样式脏改，保留不覆盖；`origin/main` 本地引用涉及 Canvas.tsx 的旧改但无正式共享层，远端 behind 6，不在脏树 pull。真实画布只读 DOM 证据：512 个 direct SVG、同一坐标系及 `z-index:1`，均为 default 边。此前探针隐藏整个边容器，无法保留悬停和断开，不能直接用于正式路径；三轮基准未证明性能收益，因此本轮只满足用户明确的架构选择，不宣称 FPS 改善。

目标：普通画布将兼容边的**可见绘制**放在一个共享 SVG，React Flow 原边仍负责 20/24px 命中、选择、重连及标签；已有 1.5px 常态、2px 悬停、0.8 秒蓝色流星不变。非目标：不修改边数据、坐标、分组、节点裁剪、相机及诊断对照；`canvasPerf` 页面继续保持 Normal/Single SVG 两种独立实验模式。

步骤：新增 `application/singleSvgEdgeLayer.ts`，挂在正式 Canvas 根，取 RF 已生成的 SVG 图形并按边增量镜像到同一 SVG；原边只用 CSS 透明而非 `display:none`，保留事件目标。MutationObserver 只监听原边树，不监听相机 transform；边增删/路径/悬停变化在下一帧绘制前同步。复制失败、坐标或层级不同、含不支持图形时仅该边回退原绘制；卸载恢复全部原边。共享层不响应指针，克隆内部 ID 改名，标记引用不改。新 CSS 只加源边透明和共享层禁止命中规则；Canvas.tsx 仅加挂载 effect，并在 DEV `canvasPerf` 下跳过。

精确写入：新增独占 `frontend/src/features/canvas/application/singleSvgEdgeLayer.ts`；修改既有独占 `edges/CanvasEdgeFlow.module.css`；共享 `Canvas.tsx` 只串行添加导入/effect；本台账、claim 和 STATE 更新。与 asset-replacement-picker、liblib-canvas-parity、storyboard-dual-view 的 Canvas 共享段不重叠；不触及其他工作线。风险：浏览器对 opacity 0 SVG 的命中行为、共享 SVG 与节点的层级、动态路径同步。回退移除挂载后原 React Flow 绘制自动恢复，无数据迁移。验证计划：静态类型编译、diff/guard；用户本轮未要求运行测试，先不加跑测试套件，交付时明确视觉/性能是否经过现场验证。

### 2026-09-28 · 用户再次指定连线线宽与动效周期

目标：两类边常态不透明1.5px，悬停/选中2px，蓝色流星0.8秒一圈。以共享常量统一两类边线宽，拖尾核心同步2px，柔光按前轮比例收窄；颜色、交互、几何、生成中状态不变。仅数值和已有测试断言修改，不新增业务功能或数据迁移。

范围：既有独占 DefaultCanvasEdge.tsx、DisconnectableEdge.tsx、CanvasEdgeFlow.tsx、CanvasEdgeFlow.module.css 和两份边组件测试；共享 DESIGN.md 窄段更新并由本 owner 串行集成，本台账/STATE/参考报告同步。HEAD8428b3a、behind6，既有同线脏改可归属，origin/main本地引用无同名流星模块或对Disconnectable的新差异；不合并远端。当前无锁，先 acquire/preflight。

验证：两份边组件现有回归、类型检查、diff/guard；本次是小幅参数调整，现有Chrome浏览器实测旧周期不当作0.8秒实测。风险是常态线变细可能改变高缩放手感；用户已指定并可自行拖动验收。回退只恢复本轮数值。DESIGN lint先前联网执行遭自动审批拒绝，本轮不绕过重试。

### 2026-09-28 · 用户调整流星线宽和速度

在前轮已验证实现上，仅按新要求将两类边 active 主线4→2.5px，公共动画3→0.6秒；流星实线核心同步为2.5px，柔光宽度按同比例收窄。常态2px、颜色、几何、引用、交互和按需动画机制保持。精确边界沿用既有独占的 DefaultCanvasEdge.tsx、DisconnectableEdge.tsx、CanvasEdgeFlow.tsx、CanvasEdgeFlow.module.css、两份边组件测试；共享DESIGN仅更新前轮独立段落，由本 owner 串行集成；同步台账/STATE/参考报告。HEAD8428b3a，本线已有dirty均已读，origin/main本地引用无新同名边实现或Disconnectable差异，不合并远端。验收为两类hover2.5、core2.5、CSS0.6s，沿用当前用户测试授权跑两份聚焦回归及diff/guard；不重启/重构。回退只恢复本轮宽度和周期常量。已有DESIGN lint联网审批拒绝记录保留，不重试绕过。

### 2026-09-28 · 用户指定连线画笔及流星动效

目标：普通导入 default 和新建 disconnectableEdge 常态统一不透明 2px #86909c，悬停 4px #c0c8d0，叠加 #64b4ff 流星拖尾。颜色来自本轮 LibTV computed CSS（--canvas-edge/--canvas-edge-hover），拖尾沿用前次实测的 8 层 dash、pathLength=300、3 秒循环。此为用户明确的视觉调整，不作为 66% 性能修复结论。

步骤：抽取 CanvasEdgeFlow.tsx / CanvasEdgeFlow.module.css，两个边组件共享按需挂载的无滤镜分段流光；Default 原导入淡色只在渲染时覆盖，marker/label/几何/命中不变。Disconnectable 删除旧白色 blur/animateMotion 流光，普通边不再用 alpha 压暗，保留节点关联选择、生成中专属状态、接点与延迟断开操作；抓手与平移禁用流光，reduced-motion 保持静态高亮。原 DefaultCanvasEdge.module.css 合入新公共模块后删除。探针同时拒绝新公共流光，防止拍进静态副本。

边界：新增独占 edges/CanvasEdgeFlow.tsx、CanvasEdgeFlow.module.css、DisconnectableEdge.tsx、测试 disconnectable-edge.test.tsx；修改既有 DefaultCanvasEdge、旧 CSS、default 测试、探针及测试。DESIGN.md 仅补三种边色和动效说明，与 liblib-canvas-parity / tv-director-implementation 串行共享，由本 owner 集成，既有内容不覆盖。其余正式 Canvas、index.css、节点、导入数据不改。台账/claim/STATE/参考报告同步。

审计：HEAD8428b3a、behind6；拟改旧 DisconnectableEdge 与 DESIGN 工作树干净，旧 default 实现属本线。origin/main 本地引用对 DisconnectableEdge 无差异；新模块/测试无同名远端实现。既有 default 注册保留，不拉取/合并脏工作树。性能共享层方案不混入本轮。

验证：沿用用户持续测试授权，覆盖两类边 idle 2px/不透明、hover 4px/8层流光、离开复原、hand/gesture 抑制、marker/几何/label、延迟断开及处理中状态，探针拒绝活动动画；tsc、i18n、DESIGN lint、diff/guard。浏览器核对实际 dashoffset 变化和样式，若旧副本草稿冲突仍存在则建隔离测试副本或临时组件页，不清除原草稿。风险：不透明边比旧样式更亮；限定局部渲染，不改保存数据；回退只撤本次画笔及公共动画接点。

### 2026-09-28 · 66% 差异收敛，当前仅记录方案

本轮只读取代码/参考DOM并更新本台账、STATE、参考报告，不改业务代码。相同参考相机下，本地已安装RF的节点大矩形算法预测108边，LibTV实际108边；参考DOM曲线按1024段采样只有55条进入带14px余量的视口，本地离线近似同为55，故不能将“参考站精确曲线剔除”当成性能差异。离线采样只是诊断估算，不可作为生产剔除算法。

已确认而未证明因果的差异：LibTV共享SVG直接有data-shared-edge-id的交互组、实色2px画笔；本地原生RF独立SVG与透明度0.55/1.5px画笔；DEV手动合层仍保留原RF组件，边集合变化重读computedStyle/复制全层。下一阶段先同相机固定边集合，单独对比画笔透明度（保持线宽与其他条件），再同画笔测直接共享SVG（没有MutationObserver全层复制）；记录原生边更新、复制耗时和绘制帧耗时分别是多少。只有重复收益后设计SharedCanvasEdgeLayer直接订阅边/节点几何，保留身份稳定的按id分组、marker、层级和hover，不订阅每帧相机。需要新增业务文件时另补精确claim及preflight；本轮不以此方案授权立即写共享热点。详见参考报告§16。

### 2026-09-28 · 导入连线悬停缺失修复

用户反馈23%两种模式均顺、66%均卡，手动单SVG不晋级。本轮LibTV重新设66%核实：108边共1SVG、10节点、video0；移动工具未选中悬停边stroke从2到4、CSS流光3秒；抓手工具边与节点pointer-events均none。故不能删除抓手命中保护。更直接根因：副本512条导入边均type=default，liblibCanvasImport.ts保留该类型，edges/index.ts只注册disconnectableEdge，实际DOM只有RF原生两条path，未进入旧悬停组件。这不是数据/连线丢失，也不能将默认边无动画完全归因于最近抓手CSS。

实现仅显示层：新DefaultCanvasEdge包装原生Bezier几何/BaseEdge，保留导入style、marker、交互宽度和RF自身选择/双击行为；常态仍两条路径，hover/selected才增加4px蓝色主线与无模糊filter的3秒dash流光，复用参考站观测到的pathLength分段方式。只注册default显示别名，不修改导入数据/原图/引用/坐标；旧disconnectableEdge不变。动画用同目录CSS module，抓手/真实panning/reduced-motion隐藏并停动效，禁止给所有边添加常驻滤镜或动画。DEV单SVG仍只测静态抓手，对新flow状态明确拒绝快照。

范围：新独占edges/DefaultCanvasEdge.tsx、DefaultCanvasEdge.module.css和default-canvas-edge.test.tsx；注册文件edges/index.ts未被其他claim认领，新增本线独占。既有canvasEdgePaintProbe.ts加新flow拒绝条件/测试。本台账/claim/STATE/报告同步。HEAD8428b3a、以上新文件不存在、注册文件/旧DisconnectableEdge无脏diff、远端本地引用无新同名模块；不刷新或合并远端，不动Canvas/index.css和旧预览实现。

验证：组件未悬停无流光、进入加粗/离开复原、选中、保留路径/style/marker、手势中不激活、注册default且disconnectable不变；探针拒绝活动flow；tsc/i18n/diff/guard；普通副本移动工具实机验证DOM与效果，抓手保持平移。风险是高亮新增绘制，因此按需挂载，性能问题单独记录而不宣称修复66%。回退只撤销default注册和本模块，无数据回退。

### 2026-09-28 · 用户自主拖动的持续对照

用户要求切换后由自己拖拽，固定4秒自动轨迹无法观察手感。本轮仅修改已有DEV诊断及其边探针/两份测试、报告和本台账/STATE；HEAD8428b3a、旧diff、既有scope均保留。上述探针/测试为本地未跟踪实现，无上游同路径；不修改正式Canvas/index.css/节点或数据文件。

具体方案：CanvasPanDiagnostics新增Normal/manual与Single SVG/manual两个持续按钮，自动轨迹折叠到独立details，手动单SVG启用期间禁用自动轨迹/组与缓存对照。不设置相机、不触发定时复位、不接管pointer手势。canvasEdgePaintProbe增加手动控制器，复用现有安全复制：监听RF原边DOM变化，在同一MutationObserver回调内恢复原边→准备新快照→激活，避免下一次绘制使用旧边集合；只在边内容变化时重建，纯viewport transform不重建。边集合为空时显示空集合并继续监听；节点选中、离开抓手、非支持边样式或复制失败时恢复原边并反馈原因。正常退出/卸载断开监听并幂等恢复，程序不更改节点或边模型。

风险与边界：动态复制有额外成本，此模式用于真实手感对照，不是产品架构；无缓存强制分层。高缩放剔除导致的复制成本计入用户体验，不冻结可见集合。出现异常可切Normal立即恢复。验证沿用用户对本对照的测试授权：增删边/路径更新/相机不触发重建/空区域恢复/退出/失败/工具切换回归，诊断常驻不自动移动及卸载恢复，tsc/i18n/diff/guard；浏览器可用则确认入口，否则明确由用户手测，不宣称性能通过。

### 2026-09-28 · 66% 连线绘制定向优化

续测第二处分叉：逐SVG常驻合成缓存三轮P95为16.8ms，但实际拖动后播放出现大块红底/已加载图片缺失；撤销后恢复，视觉验收失败，不晋级。改做仅DEV的 `single-svg-dom-transform`：与既有 `dom-transform` 完全相同的4秒相机轨迹、静止节点集合，只把已挂载连线的绘制容器合成一个SVG。高缩放不通过RF setViewport逐帧更新，防止剔除使快照失效；节点/连线任何变化立即取消并还原。原 `single-svg` 的低缩放门保持。精确只改已认领的CanvasPanDiagnostics及测试，不改探针算法或产品路径；补66%可运行、原模式拒绝、0逐帧setViewport和清理测试。该实验只回答连线容器是否影响绘制，不当作正式交互方案或性能修复。

续测分叉：用户要求继续后，Chrome恢复。用户新相机29%放到66%后为22节点/174边，整viewport缓存P95仍166–183ms，隐藏边为16.8ms；前次15节点/95边样本不能推广。先只在已有DEV对照中增加edges容器/独立edge SVG的合成提示两个选项，串行单变量比较；不改正式CSS。若全viewport不能跨密集区域稳定改善，撤回原单条正式规则计划，记录否定证据。需要结构实现时另补具体方案，禁止直接把DOM快照探针当正式渲染。

目标：复现用户报告的 66% 顿挫，在既有测试副本取得重复改善后启用最小修复。原画布数据只读；不调整坐标、分组、生成参数、节点裁剪和边结构。

证据：同副本 65.9754%、15 个挂载节点、95 个 SVG，三次 Normal P95 均 50ms；纯 DOM transform（0 React commit）仍为 50ms；隐藏图片无改善，隐藏边为 16.8ms。三次临时 viewport will-change:transform 均为 16.8ms，仍有 1–2 个 >33.4ms 尾帧。LibTV 66% 只有一个边 SVG；420px 往返时节点 10→14→10，已有节点图源/几何稳定、video=0。LibTV viewport 的 will-change 为 auto，不能说参考站用了本次候选 CSS。详见报告新增 §13。

代码块级步骤：
1. 仅在已有 DEV CanvasPanDiagnostics 增加可持续的 Viewport cache 对照（default/auto/transform），transform 规则限定非低细节档；结果记录所选模式。先只用于副本，不写保存数据。
2. 副本持续 transform 下做真实抓手往返、66→22→66 跨档、停止后节点选择与播放。确认低档 computed will-change=auto，高清档=transform，节点几何/图源稳定，无红屏/白屏。补三次 normal 固定轨迹，与第一批对照同条件。
3. 如重复改善和回归通过，在共享 index.css 增加单条 `.dc-canvas:not(.dc-canvas--low-detail) .react-flow__viewport { will-change: transform; }`。常驻于高清档，避免拖动首尾反复创建/销毁缓存；低档保持现状。保留 DEV auto 作为同页撤销对照。Canvas.tsx、边/分组组件不改。
4. 聚焦 LOD/诊断/预览/平移测试、tsc、构建、i18n、diff/guard；正式 CSS 下再测普通 URL 和 22% 回归；恢复参考站 14% 和移动工具，副本保留用户 66% 相机。

范围：独占既有 CanvasPanDiagnostics.tsx 及其测试、canvas-lod.test.ts；共享 index.css 仅增加上述规则，liblib-canvas-parity 既有标题 hunks 保留，由本 owner 串行集成；协调本台账/STATE，既有参考报告。已读 DESIGN/拟改 diff，当前 HEAD 8428b3a（同名远端 behind 6），本地引用 origin/main 不含候选规则；旧 LOD/分组 diff 和其他工作线全部保留，不 pull。未刷新远端引用，不宣称远端最新。

风险：浏览器合成缓存占用额外内存，不能由 RAF 推定 GPU 根因；因此不对每个节点/SVG逐个提升层级，也不启用低缩放全量节点缓存。若出现红屏、缩放模糊、叠层异常或性能回退，撤销本轮单条 CSS；诊断对照与报告保留，不回滚之前优化。

### 2026-09-28 · 获准执行 §10 副本对照

用户确认按方案执行。复用已存在副本，先做普通页/诊断页对照，再按三轮 Normal→single-svg→Normal 决定候选修改；分组与固定手势样式分开验证。当前 HEAD/脏文件及 guard 已核对，既有实现不重写。首批写入仅本台账、STATE 和参考报告的实验结果；副本视口与选择可通过界面调整，原画布只读。若发现需要修正探针，先补局部方案/路径审计与 preflight，再改已认领的 DEV 文件及回归。正式渲染路径仍以重复证据为进入条件。

### 2026-09-28 · 先用伪代码对齐实站行为

- 用户要求先厘清逻辑再改代码，并询问右上角诊断面板是否就是 Chrome 所说的拦截界面。本轮只读业务代码、在既有副本重试操作、在 LibTV 做可恢复的往返平移，写清实测与推断的界线。
- 写入仅本台账、STATE 与已认领的 `docs/guides/libtv-preview-group-rendering.md`。保留 HEAD 8428b3a 及全部旧 diff；本地 origin/main 在两份协调文档有历史差异，沿用当前本线记录；新报告无远端同名实现，不覆盖或合并远端。
- 报告补参考行为伪代码、本地代码块映射、可证伪的单变量副本实验及代码晋级条件。副本隔离数据、显式 DEV 开关隔离实验；业务渲染实现不在本轮写入范围。
- 验证为浏览器实际操作与 DOM 前后读取、源画布文件摘要复核、文档 diff/guard；没有业务变化不重跑构建或用旧单测数量充当实机证据。界面被拦时记录未完成，禁止换控制通道绕过。

### 2026-09-28 · 用户要求改在独立测试画布验证

- 本轮目标：创建独立画布 ID 的拖动测试副本，完整保留节点、边、分组、媒体引用和视口；原画布只读，复制前后校验。复用当前 DEV 诊断面板，在副本清选择并做 Normal→single-svg→Normal，所有结果只来自副本。
- 基线仍为 8428b3a，已有未提交实现保持；本轮不改业务代码。写入限本台账、STATE 及忽略目录内本机测试副本/基线快照/核对摘要。通过已存在的画布 GET/PUT 接口新建，使用唯一 ID、base_revision=null 和 client_save_id，拒绝覆盖任何已存在副本。
- 代码隔离：复制画布只能隔离数据，不能隔离共享 JS/CSS。当前 A/B 复用仅 DEV/显式 canvasPerf 页面内的临时开关；后续新代码必须限定测试副本或独立前端服务，取得重复改善证据后才启用正式路径。
- 验证：新画布重新读取的 nodes/edges/viewport 与源快照逐项一致、素材引用保持同项目；原文件摘要/修订号前后不变。浏览器在副本确认节点数量、已加载图片、无选择、无生成后开始测试，记录异常及节流，不把单次正常画面当作通过。
- 风险与回退：副本沿用同项目素材文件，只测试呈现/拖动，不改素材、不生成、不本地化、不更新原画布。已完成任务输出可随节点保留，但运行态任务不复制执行。副本是新的本地测试数据，保留明确名称供用户识别；所有布局和提示词差异不会回写原图。代码晋级仍按 §8 的独立方案门。

### 2026-09-28 · 用户批准按 §8 分批实施

按参考报告 §8 的 A→B→C 执行；D 仍受重复收益门槛约束。HEAD 8428b3a、旧性能 diff 已核对并保留；本地 origin/main 的 Canvas/ImageGen/Video 等差异属于已记录本地功能，沿用当前工作树，不移植远端整文件。没有同类探针/解码队列/稳定档位模块。新增精确独占路径为 canvasEdgePaintProbe、canvasPreviewPolicy、canvasPreviewDecodeQueue、useDecodedNodeImage、useNodeBodyVariantBudget 与 ImageNode，以及对应四项新测试（见 claim）。旧 CanvasPanDiagnostics、NodePreviewHandoff、imageData、media-url 与已有节点/测试按原 claim 串行；正式 GroupNode/Canvas/数据保持只读，只有证据达标后另做投影接入。

验证和回退沿用 §8：先探针聚焦测试/真实对照，再交接与选档/解码测试、类型和构建；每阶段记录，预览改动不作为红屏已解决的证据。共享节点保留既有封面归属、尺寸记录和生成流程。所有新增路径 preflight 后写入。

C 接点审计补充：imageGen 的 shell 原先优先 imageUrl，但完整组件优先 previewImageUrl，可能在升级交接时短暂盖上旧编辑前的图；在同一已认领 LodShellNode 中对齐取源顺序。交接身份增加已有 committed_at 版本值，让同地址素材的新版本立即使旧覆盖失效；不引入版本写入或缓存刷新策略。补 shell 取源/版本失效回归。

### 2026-09-27 · LibTV 预览及分组参考优先

用户要求详细研究参考后再实施；完整实测及方案见 [预览与分组参考](../../guides/libtv-preview-group-rendering.md)。撤下独立检出中未接入的整幅快照草稿，不将其当作 LibTV 做法。主目录导入工作线已释放锁，按现有 LOD 线串行。

- 本轮先实现 DEV 独立对照：底色移至分组外层、仅分组层级改为 -1001、两者组合。保持内部透明边框占位，外层描边用 inset outline，避免改变测量尺寸；正常路径不受影响。恢复或卸载精确撤销临时样式。新挂载组同样应用。
- 精确业务路径：既有独占 `frontend/src/features/canvas/ui/CanvasPanDiagnostics.tsx`；新增独占 `frontend/src/features/canvas/application/canvasGroupPaintProbe.ts`、`frontend/src/__tests__/features/canvas/canvas-group-paint-probe.test.ts`。文档为本台账/claim/STATE 与新增参考报告。GroupNode、Canvas、画布 JSON 本轮只读取证。
- 现状审计：诊断组件为本线未跟踪文件，已完整读过；新增路径不存在，本地/远端 origin/main 没有同类实现。既有共享 SVG 未改，不能一次同时推广多个未证实变量。
- 验证：Vitest 检查分组尺寸/transform 不变、仅层级模式、组合、离开恢复、新挂载、保留后续样式修改；tsc、diff/guard；Chrome 同画布 Normal/各对照拖动，恢复 Normal。实机没有可信改善则只保留诊断，不改默认产品路径、不宣称红屏已解决。
- 风险/回退：纯样式对照不能证明浏览器合成根因；分组层级可能改变命中/标题遮挡，因此只在开发面板显式选择。移除本轮选项/模块即可撤回，无数据迁移。

### 2026-09-27 · 整页红屏定向排查

- 用户提供手机录像；Chrome 同页真实手势截图已复现整页红色，包括顶栏。普通 URL 无 canvasPerf；不能再用红色分组底板解释整页红屏。
- 同页 45 次拖动采样的 128 节点和 102 张图片始终连接、可见且加载完成；背景计算值稳定。此证据排除本次采样中的 DOM 卸载，不等于证明 GPU 或驱动故障。
- 发现任务中心关闭时，全页 backdrop-blur-sm 遮罩仍 visibility:visible/opacity:0。拟复用 CanvasFileDropOverlay 已有隐藏策略，让关闭态停止绘制，保留开关动画、点击关闭和 Esc。
- 本轮新增独占边界：`frontend/src/components/task-center/panel.tsx`、`frontend/src/__tests__/components/task-center/panel.test.tsx`；文档限本台账、claim、STATE。Canvas/LOD/坐标/素材不改。两文件 Git diff 为空；现存 claim 无重叠，origin/main..HEAD 无对应差异，其他远端同类分支无新增实现。基线仍 4c9dee4。
- 串行步骤：补关闭/重开遮罩回归 → 遮罩增加 visibility 切换并与 opacity 同步过渡 → 同页相同缩放真实拖动 A/B → 检查任务中心打开/关闭、缩放、节点操作。
- 验证：聚焦 panel 和画布手势测试、tsc、前端 i18n、diff/guard；浏览器记录修前红屏与修后结果，不依据一次正常截图宣称根治。无稳定改善则保留未解决结论并继续查绘制层。
- 风险与回退：visibility 若与渐隐不同步会截断动画；用同一 duration/easing 的 CSS transition，并覆盖快速重开。只撤销本轮 panel 与测试 hunk，保留所有已有画布改动。没有数据/API/配置迁移。
- 对照追加：遮罩 hidden 后仍抓到红屏，排除其为充分原因；用户补充今日分组配色变更后才出现。只在既有 DEV/显式 canvasPerf 的 `CanvasPanDiagnostics.tsx` 增加分组底板/标题独立 CSS 开关，切换不写画布数据，离开诊断页自动撤销。先分别关闭/恢复同组元素测实际手势，再决定产品修复。既有 GroupNode/颜色导入代码只读，不能因时间相关直接回滚它们。

### 2026-09-27 · 用户确认先方案后实施

测试边界补充：`image-gen-stale-error-banner.test.ts` 的显式 hook mock 随接口新增同步，不改其断言语义。

完整方案与精确写入边界见 [画布拖动稳定性实施方案](../../guides/canvas-pan-stability-implementation.md)。按抓手命中/hover → 媒体交接与封面档位 → 内容订阅三步串行实施；共享 SVG 和保存指纹不在本轮产品改动内。已核对本地 dirty 归属和远端差异，保留前轮封面/平移修复。验证、风险与按 hunk 回退均见方案。


### 2026-09-27 · 已获授权的平移稳定性实施

- 用户确认按对照诊断 → 对应修改 → 大画布验收的方案处理。约 22% 节点/图片/路径稳定，不把闪动预先归因于挂载。目标为持续平移只改变视口，保留坐标、尺寸、引用、选择和播放语义。
- 精确本轮写入：共享 `frontend/src/features/canvas/Canvas.tsx`、`frontend/src/index.css`；独占 `frontend/src/features/canvas/ui/CanvasPanDiagnostics.tsx`、`frontend/src/features/canvas/application/canvasLod.ts`、`frontend/src/__tests__/features/canvas/canvas-lod.test.ts`、`frontend/src/__tests__/features/canvas/canvas-minimap-pan-mount.test.tsx`；新共享 SVG 或其他业务文件如有必要先补 scope。文档仅本台账/claim、STATE 与 liblib-canvas-parity 的串行协调。
- 来源核对：当前 Canvas/index.css/canvasLod 无未提交差异；旧提交 08f8f410 不在本机对象库，沿用本台账 2026-09-18 已完成审计与保留当前实现的决策，不取旧分支整树。当前远端仅 main 和两条 codex 分支；origin/main..HEAD 中 Canvas 差异为故事板隔离，index.css 为组标题 token，canvasLod 无差异。保留全部现状。
- 第一步：仅开发环境、显式查询参数开启的诊断面板，固定视口轨迹分别测 normal / 无连线 / 稳定样式 / 合成提示，记录 RAF 间隔、长动画帧与 React Profiler；每次自动恢复起点。诊断不记录素材地址、提示词或凭据。
- 第二步：依据前后对照选择渲染样式或连线层修改；同时处理有源码证据的平移 store 高频通知与重复相机写入。性能假设无收益不晋级。保留高缩放行为并按需要逐项修正。
- 第三步：用户已授权对照验收，执行聚焦 Vitest、TypeScript 与 i18n、实际页面拖动/往返/松手、缩放与播放检查；记录指标边界，不把 RAF 间隔当作完整 GPU trace。
- 对照补充：可见前台仍出现近秒级间隔，增加只改 DOM transform、移除连线布局和图片绘制的临时诊断模式，以区分浏览器绘制等待与 React Flow 相机更新；这些模式仅存在于显式开启的开发面板，运行结束恢复。
- 风险/回退：程序化轨迹可能触发视口保存，运行完成/取消恢复原视口；共享层改造可能影响连线命中，未验证不启用。只按本轮 hunk 撤销，保留上一轮封面变更。

1. 对比远端 LOD 提交 `08f8f410` 与本地 4 个重叠文件，列出相同、仅远端、仅本地行为。
2. 用现有单测确认哪份实现覆盖低缩放交互；决定复用远端提交还是保留本地增量，并记录理由。
3. 在同一浏览器、同一节点数据下采集 LOD 开 / 关的帧率和首屏时间，再决定是否收线。

## 风险与回退

- 最大风险是为了“用远端已有实现”而整文件覆盖，丢掉 LibTV 与其他画布改动。
- 回退只能按本线的独立提交撤销；在拆提交前禁止对共享文件执行 restore。

## 进展记录

### 2026-09-28 · 低缩放媒体标题已显示

改了什么：`LodShellNode.tsx` 的图片、视频类轻量外壳现在用现有节点名称生成一行浮动标题；标题与裁剪缩略图并列，不改 React Flow 节点尺寸、分组坐标和连线锚点。样式采用完整节点的 12px、上移 28px、普通字重，且不参与指针命中。未修改导入画布数据或完整节点标题。

为什么这么改：完整节点已有标题，但低于 LOD 阈值时只渲染无标题外壳，造成用户截图中 20% 缩放与 LibTV 参照的差异。此改动限定在外壳和对应 CSS，不碰同文件里既有封面/预览交接逻辑。

怎么验证：`pnpm exec tsc -b --pretty false`、目标文件 `git diff --check`、`agent_guard check` 均通过；Chrome 打开指定本地画布调到 20%，DOM 见 188 个外壳中 172 个媒体标题，截图确认标题位于图片/视频缩略图上方，首个标题左边与缩略图对齐、下缘与缩略图间约 1.6 屏幕像素。检查后缩放恢复到原来的 100%。用户未要求测试套件，本轮未新增或运行测试；浏览器拖动性能未量化。标题修复单独提交，提交号以 Git 为准；共享文件其他未提交改动保留在工作区。

下一步：用户确认该画布低缩放外观；若后续有长标题截断问题，仅调整标题 CSS，不改变节点几何。其余 LOD 慢图交接和性能量化继续留在本线既有待办。

### 2026-09-28 · Single SVG 已进入正式画布

改了什么：新增正式 `singleSvgEdgeLayer.ts`，将相同坐标系的普通边绘制增量镜像到一个共享 SVG；React Flow 原边以透明方式保留作为命中层。`Canvas.tsx` 正常路径挂载共享层，DEV `canvasPerf` 对照路径跳过。源边增删、路径和悬停状态同步；选中、特殊层级及不支持的 SVG 图形回退原绘制，卸载时恢复。共享边层禁止命中，内部 ID 改名，现有线宽/色彩/流星参数没有改变。

为什么这么改：旧 DEV 探针直接隐藏边容器，无法保证正式画布的悬停、选择和断开操作。此次只合并可见绘制，保留原交互 DOM 与 RF 相机/裁剪，避免重写连线几何或图数据。用户明确要求推广；历史三轮对照没有证明性能收益，仍不以该实现宣称 66% FPS 提升。

验证：`pnpm exec tsc -b --pretty false` 通过，`git diff --check` 通过；刷新本机原始画布后观察到 512 条源边仍挂载、512 条进入单个共享绘制 SVG，源边计算 opacity 为 0，页面截图线条和节点均正常。未对用户画布数据写入；未运行测试套件（本轮用户没有要求测试）。悬停/断开与 66% 拖动仍待用户或后续专门验收。进展未提交。


### 2026-09-28 · 常态 1.5px、悬停 2px、流星 0.8 秒

按用户给定值同步导入 default 与本地 disconnectableEdge：常态不透明1.5px，悬停/选中2px，公共蓝色拖尾0.8秒循环。主线线宽改为共享常量，拖尾核心宽2px，柔光继续按比例随主线缩放；保存的数据、颜色、命中和断开操作均未变化。

两份既有边组件测试12项、类型检查、diff/guard通过；未在浏览器重新计时本轮0.8秒周期。此前用户在不透明2px版本下反馈66%拖动顺畅，是上轮验收记录；本轮1.5px配置的高缩放手感待用户实际使用确认。DESIGN lint沿用已记录的自动审批拒绝，本轮没有联网重试。

### 2026-09-28 · 用户复测确认 66% 拖动已顺畅

用户反馈「卡顿的解决了，就是改了不透明后就没发现了」。当前主观验收结果是：此前有顿挫的 66% 画布在连线改为不透明后，用户拖动未再感到卡顿。本轮只更新验收记录，没有再改代码或另跑基准；这个反馈支持不透明画笔可能改善混合绘制开销，但没有隔离测出单项耗时。暂停以持续卡顿为前提的共享 SVG 改造；以后若同场景复现，再按 §16 做固定相机对照。整个 LOD 工作线仍有其他待验收项，保持「待验收」。

### 2026-09-28 · 流星参数按用户反馈收窄提速

将两类边active主线改为2.5px，公共CSS周期改0.6秒，流星核心同步2.5px，柔光按原比例收窄为7.5/4.375px，避免主线虽细而拖尾仍4px。普通2px/配色/交互保持。DESIGN同步当前值；历史LibTV实测4px/3s记录仍作为取证保留。

验证：两份边组件Vitest共12项通过；diff与guard通过。仅数值调整，本轮未重复浏览器动效实测或类型构建；上一轮实测结果属旧周期。DESIGN lint沿用已记录的自动审批拒绝，不重试联网。没有新文件/scope或数据变更。性能线仍待验收。

### 2026-09-28 · 不透明 2px 画笔与公共流星效果完成

改了什么：按用户指定把两类普通连线统一为 LibTV #86909c/2px/不透明；悬停/选中为 #c0c8d0/4px，共用 #64b4ff 的8层dash流星。Default旧CSS迁入 CanvasEdgeFlow.module.css；native旧白色模糊animateMotion移除，延迟断开/接点/生成状态保留；手势防误命中、抓手清理、reduced-motion/平移禁用动效。探针拒绝公共flow。DESIGN仅新增边色说明，共享工作线已串行协调。

为什么：上轮default显示接点虽已补齐，但配色仍用accent、常态沿用导入半透明1.5px，native仍是旧白色光点；因此两类边反馈不一致。以本轮参考站 computed颜色和前次实测dash机制统一。

怎么验证：Chrome独立4节点/2边副本66%实测两种流光offset随时间变化、悬停加粗、移开恢复、抓手0flow及往返拖动；源副本响应摘要未变。四文件Vitest 37通过，tsc -b、前端i18n=0、diff检查通过。DESIGN lint缺本地包，联网执行遭自动审批拒绝（外部包下载执行风险），明确未运行。初次5项失败仅因DOM将hex归一化为rgb的断言表示，调整断言后通过。完整证据见参考报告§17。

范围与限制：未改Canvas/全局CSS/节点布局/引用数据，也未提交。此小副本验证不等于大型画布66%性能改善；整体线继续待验收。日志既有React Query AbortError另记，未把浏览器无相关渲染异常写成整页零错误。

### 2026-09-28 · 同视口排除数量差异，下一轮绘制对照方案

本轮仅更新文档。核对RF实现与参考DOM，相同66%视口两者108边、近似55条进入视口，不能把屏外曲线剔除当作LibTV领先原因。已确认参考2px实色/共享SVG与本地1.5px半透明/独立SVG差异；手动探针还有源树与复制开销。报告§16写清先固定集合单测alpha，再隔离复制成本，证据成立才设计直接共享层，若无收益停止该假设而非继续换CSS。参考相机恢复14%。本轮无业务修改/新性能样本，功能测试未重跑，文档diff/guard核对。

### 2026-09-28 · 66% 实站复核与 default 边悬停修复

用户反馈两种手动模式 23% 均顺、66% 均卡，记录为单 SVG 不晋级证据。本轮参考站 66% 实拖 420px 往返：节点 10→14→10、边108→153→108，始终一个SVG、video0，10个存续节点style/currentSrc未变；实测未选中悬停4px/3秒flow，抓手禁命中。参考页最终恢复原14%相机及移动工具。

发现512条导入边显式default绕过旧交互组件。按本台账先方案/acquire/preflight后新增DefaultCanvasEdge及CSS module、注册default；保留原生Bezier/BaseEdge常态几何/画笔，只hover/selected按需挂载无滤镜流光。手势中不激活、抓手清除hover、平移与reduced-motion隐藏动画；单SVG探针增加活动flow拒绝条件。未改Canvas/index.css、旧DisconnectableEdge或保存数据。

验证：frontend目录运行vitest（default-canvas-edge、canvas-edge-paint-probe、canvas-pan-diagnostics）3文件32项通过；tsc -b、前端i18n、diff --check、guard check通过。首轮标签测试缺jsdom getBBox，补测量桩后通过。浏览器热更新已确认432条挂载边使用新组件；本地窗口随后被revision冲突遮罩阻止，未刷新丢弃草稿，仍92%。本地66%鼠标高亮视觉验收未完成，不能宣称性能修复。详见参考报告§15。

### 2026-09-28 · 持续手动对照交付用户

做了什么：按用户要求增加Normal/manual和Single SVG/manual持续切换，不自动移动、不限时、不复位。自动4秒工具折叠；手动对照与缓存/分组/自动轨迹互斥。复用安全边探针，在可见边变化时更新显示快照，纯相机不重建；切工具/选中/不支持内容/退出/卸载均恢复原边。只改DEV诊断、探针与对应测试，正式Canvas/index.css/节点/保存结构未改。

为什么：用户需要自主手感比较；高缩放不能持有不更新的静态快照，否则拖到新区域会显示失效边。该动态复制只用于实验，复制成本算入实际体验，不假装已经实现参考站的正式共享SVG。

验证：2文件24项定向测试、tsc -b、i18n0、diff/guard通过。Chrome恢复操作；23%模式切换不动相机，66%原边/快照同步为190条，实际400px往返模式始终生效，结束截图正常；退出原边恢复、快照0、相机未被复位。页面留在66%/Normal/grab供用户自主比较。详细边界见参考报告§14，不宣称性能改善或全帧无闪烁；无提交/推送/服务重启。

### 2026-09-28 · 66%密集区续测，否定缓存晋级并准备单SVG绘制对照

做了什么：恢复Chrome后复用用户当前测试副本。174边区域的整viewport缓存P95为166–183ms，edges容器为149.9ms；逐SVG缓存三轮P95为16.8ms，但真实拖动/视频播放截图出现红块与图片缺失，已暂停播放、撤销缓存并确认下一张画面恢复。没有修改正式CSS/边组件/分组数据。增加DEV edges/edge-svg选项，以及可在66%冻结RF相机的single-svg-dom-transform绘制对照；它和dom-transform比较，原single-svg低缩放限制保持。

为什么：95边区域的改善不能外推174边；RAF恢复60fps也不能抵消视觉回归。下一步先验证LibTV单SVG结构在密集区是否有绘制收益，不将静态DOM快照当作产品实现。详细数据、被排除的假手动样本及实验边界见参考报告13.5–13.6。

验证：frontend定向Vitest诊断/边探针/分组探针3文件21项通过；tsc初次发现测试误用了Playwright的exact选项，改为Testing Library名称正则后tsc -b通过；i18n初次控制台GBK编码异常，用Python -X utf8重跑0项；diff检查与guard通过。原画布及测试副本文件摘要、nodes/edges/viewport均与本轮前完全一致。新单SVG模式热更新后Chrome再次提示其他扩展UI阻止操作，已请求用户关闭；该模式浏览器结果尚未取得，不能记为通过。本轮未提交、推送或重启服务。

### 2026-09-28 · 定位 66% 连线绘制卡顿，持续缓存待实机收口

在用户现有副本 65.9754% 复现：三次 Normal P95=50ms，0 React commit 的 DOM transform 仍慢；隐藏边为16.8ms，隐藏媒体仍50ms。三次 viewport 合成提示为16.8ms，尚有少量尾帧。LibTV 66% 实站是一个 SVG、静态封面、节点按视口增减，已有图片源/几何稳定；其 will-change=auto，不能误称为采用同一 CSS。完整测量/代码方案见报告 §13。

本轮只新增 DEV 诊断的持续 Viewport cache 开关及回归，正式 CSS 未启用。Chrome 在热更新后再次对副本提示其他扩展 UI 阻止自动操作，已请用户关闭，持续开启后的真实拖动/缩放/播放未完成。参考页已恢复原 14% 相机与移动工具。原画布及副本当前文件均与本轮基线完全一致，未修改节点/边或生成数据。

验证：诊断/LOD/预览/节点平移等10文件117项通过，小地图另1文件8项通过，合计11文件125项；tsc、CE build、i18n、diff/guard通过。小地图首跑工作目录错误导致locale夹具ENOENT，改frontend目录重跑通过；构建保留原大chunk警告。没有提交/推送/重启。下一动作是恢复副本控制、选择持续transform并按方案实机验收，满足条件才增加单条高清档CSS。

### 2026-09-28 · 单SVG三轮完成，用户确认当前拖动稳定

复用同一副本，普通页50%播放成功（1播放器、readyState=4、时间推进且无错误），缩回22.3891%恢复128节点/102图片/video=0。关闭旧诊断标签后当前诊断页恢复可操作；完成三轮Normal→single-svg→Normal，九次P95均16.8ms，无节流标记、无几何/图片源/DOM增删变化。补实际鼠标拖动Normal/单SVG/Normal，截图均正常；单SVG确实临时合并512个绘制容器为1个，但未取得明确性能收益。详细数值与限制在[参考报告§12](../../guides/libtv-preview-group-rendering.md#12-2026-09-28-副本恢复操作后的连线实测)。

分组外层背景仅做一轮，也无明显收益；降低分组层级的同条件记录未完成。用户同时自行拖动并明确反馈不卡、不闪烁；后段相机受到双方操作，不作为固定轨迹证据。已恢复Normal分组、移除单SVG探针和canvasPerf，普通页图片全部加载、拖动采样正常。保留用户当前副本视口，不覆盖回旧相机。未改业务代码、原图数据、配置；本轮仅写报告/台账/STATE，不重跑代码测试或构建。正式连线及分组不晋级，慢图交接仍待独立验收。

用户随后再次确认还原后仍正常，并指明同一测试副本。最终文件核对：原画布SHA-256与基线一致；副本128节点的position/width/height/parentId/style及512条边保持一致，但不能记为nodes全字段一致：两处selected变化，一张图片的自然尺寸从1470×630变为320×137，两处视频quality由720P归一到544p、durationSec分别从5.056→5、28.064→15。后段存在用户交互，尚未分离这些写回的来源，不擅自撤销；没有改原图。后续慢图验收前先检查自然尺寸及生成参数的自动写回，避免把UI回归通过混同于数据完全无变化。diff/guard及handoff通过，锁释放。

### 2026-09-28 · 副本普通页已实拖，诊断模式导航后再次被阻止

用户批准§10执行；Chrome最初离线，用户打开后恢复。副本成功去掉canvasPerf，清除一个残留选择、切换抓手，在普通页完成320屏幕像素往返。相机恢复、128节点inline style及102图片图源变化均0，动作后截图正常。文件核对原图SHA-256未变、副本nodes/edges/viewport与源快照一致。完整结果见 [报告§11](../../guides/libtv-preview-group-rendering.md#11-2026-09-28-按-10-执行的首轮结果)。

导航加回canvasPerf后，地址已改变，但读取再次被Chrome扩展UI提示阻止。尚无因果证据；已请用户仅删副本诊断参数并刷新做反向对照，回复待到。没有执行单SVG的A/B或修改业务渲染代码。七个相关Vitest文件53项全部通过，构建未重跑。文档diff/guard检查后释放锁，等待界面恢复继续同一副本。

### 2026-09-28 · 参考实际平移与伪代码对照，确认诊断面板边界

只更新文档，未改业务代码。LibTV 在14%缩放真实水平往返320屏幕像素：节点112→128→112、始终1个连线SVG/0个video，保留节点inline style及图片currentSrc未变，相机恢复；动作后截图正常，未声称全程零闪烁或测得FPS。这纠正了“参考站平移时全部DOM冻结”的假设。完整行为模型、本地函数映射、单变量副本实验和晋级条件见 [参考报告 §10](../../guides/libtv-preview-group-rendering.md#10-2026-09-28-实际往返拖动与行为伪代码)。

用户询问右上角界面：核实为本地 CanvasPanDiagnostics 页面 aside。尝试导航副本到无 canvasPerf 地址仍被 Chrome 拦，标签清单确认参数仍在，因此未成功关面板，不能声称关闭后依旧拦截。LibTV 同轮可操作，具体拦截归属未知。此前普通页也曾红屏，说明诊断面板不是红屏必要条件，但不替代关闭对照。没有要求用户重复关闭或绕过拦截。

验证：原画布文件与建副本时 source-file 快照的 SHA-256 仍相同；参考相机/节点数量恢复，测试副本标签保留。只写报告/本台账/STATE，业务测试与构建未重跑。文档 diff/guard 通过后释放本轮锁，状态保持待验收；原图不用于试验，不重复建副本。

### 2026-09-28 · 原画布拖动复测再次捕获红屏，转独立副本

上一轮 Chrome 实际拖动在 Normal 多次捕获整页红色、节点画面消失，外移分组背景也曾变红；降低分组层级一次正常、恢复 Normal 一次也正常，不能证明层级改造有效。采样中 128 节点/102 图片无卸载、无换源，节点 inline geometry 不变；一次记录有 6 次 React commit/3.1ms，并有多次约 1 秒节流，不能当作真实 FPS 或 GPU 根因证据。该轮结束已恢复原相机、Normal、移动工具和原节点选择。业务代码未改；当时另一个写会话持锁，本条在本轮取得锁后补录。

本轮用户提出复制画布后测试，采用上面的隔离方案。源已保存画布为 128 节点/512 边，当前无运行中节点；GET 可读且无跨项目媒体引用。已通过既有 GET/PUT 创建独立测试画布，副本重新读取的 nodes/edges/viewport 与源逐项一致；原文件 SHA-256 和源 API 内容不变，结束再次确认源修订仍为 25、文件摘要未变。画布列表已显示明确的“拖动测试副本”名称。副本 ID、地址、源文件/API 快照与核对 manifest 仅存本机 `.dramaclaw-local/checks/test_pan_20260928_9f8a7e5d/`，不提交素材或原始提示词。

Chrome 已创建并导航到副本标签，已保留为后续测试入口；但导航后的 DOM 操作及重新认领仍明确被其他扩展 UI 阻止，未完成副本上的拖动或单 SVG 对照。本轮没有改业务代码，没有将试验效果推广到原图；不能把数据复制通过写成视觉验收通过。代码隔离边界仍是 DEV 显式查询参数和当前页面临时探针；若后续需修改共享业务路径，须先加副本限定开关或独立前端环境。

### 2026-09-28 · 执行参考方案 A/B/C，等待动态视觉验收

本轮独占 owner 为 codex/pan-impl-20260928，基线 8428b3a。先完成 claim/acquire/preflight，保留全部原有 dirty 增量。A 新增 DEV 单 SVG 静态边绘制探针：几何/画笔/局部 marker 复制，拒绝不支持的图形与选择/运行态，采样失败或卸载可靠恢复；尚未改正式边结构。B 修正慢图五秒退出、过期解码、目标替换、淡出取消及失败/重复完成。C 新增画布档位滞回、四任务解码队列和已解码图描述提交，接入 ImageNode/ImageGenNode/UploadNode/VideoNode/LodShell；保护原图测量、换素材、签名参数、抽帧 query，旧导入视频 shell 使用静态封面。完整实现和局限见 [参考报告 §9](../../guides/libtv-preview-group-rendering.md#9-2026-09-28-获准实施后的实际状态)。

验证：13 个聚焦 Vitest 文件 141 项通过（精确文件见报告 §9.3），tsc -b、CE 构建、i18n、diff/guard 通过。100 次纯平移的选档 hook 不新增 render；这是局部单测，不是实机整页性能数据。浏览器单 SVG 先因统一 z=1 被旧 guard 拒绝（已修为保留统一层级），之后因已有选择拒绝；创建独立页面再次遇到 Chrome 扩展 UI 阻止自动操作。已询问用户关闭，未取得最终实机对照与慢图视觉证据。A 探针和 B/C 逻辑独立完成，整批不标视觉验收通过；D 无重复收益，正式分组继续不变，红屏未解决。

本轮没有变更节点位置/宽高/parentId 或持久化图数据，没有提交/推送/重启。回退只撤本轮探针、hook、队列和节点接点 hunks，保留之前代码；下一动作是恢复 Chrome 后做无选择低缩放 Normal/单 SVG 对照、慢图交接以及真实拖动/播放回归。最终构建含既有大 chunk 警告。

### 2026-09-28 · 四项代码块级方案，业务实现暂未开始

用户要求先回答完成情况，再出具体代码方案。本轮 HEAD 为 `8428b3a`，导入修复已独立提交；既有性能工作树完整保留。只读审计安装的 RF EdgeWrapper、正式边组件、诊断面板、交接层、选档 hook、图片/视频/上传/shell 接点和组背景/标题，确认四项分别为：单 SVG 未做；交接主体已做待边界与实机收口；屏幕预算三档已做待稳定切档；分组仅诊断且无明确收益。

代码级方案权威落点：[参考报告 §8](../../guides/libtv-preview-group-rendering.md#8-2026-09-28四项进度与代码块级实施提案)。包含新旧文件/函数/代码块、SVG 快照容器与交互隔离、解码拒绝及 5 秒退出修正、档位滞回、提交显示描述与尺寸测量的一致性、签名封面例外、分组进入条件、验证与按 hunk 回退。

本轮只写已有报告、台账、STATE，并将 claim 基线同步为 `8428b3a`；没有扩大业务路径认领。未创建计划中的业务文件、未运行测试/构建/浏览器验收、未重启、未提交。guard 启动检查通过，本地 origin/main 引用在所列核心路径没有新差异；未 fetch，实施前需要重新核对。旧 136 项/15 项通过数属于历史证据，不作为本轮新测试结果。

下一步：向用户交付本方案；获得继续实施指示后，从 A 阶段单 SVG DEV 对照开始，先添加精确 scope、变更为执行中并 preflight。后续分批推进，正式组层仍不满足晋级条件。

### 2026-09-27 · 完成 LibTV 预览与分组实站研究及独立对照

详见 [实站报告](../../guides/libtv-preview-group-rendering.md)。Chrome 已恢复可操作，实测节点 srcset/sizes、低缩放 skeleton、120ms 节点交接、分组外层底色和 -1001 层级、固定屏幕标题、抓手命中规则以及单 SVG 连线。撤下独立检出中未接入的整幅快照草稿；没有把推测当参考站源码事实。

仅新增 DEV 分组外层底色 / 降低层级 / 组合三种可恢复对照与 6 项回归，原默认绘制保持。固定轨迹四模式帧间隔中位数均 16.7ms、P95 约 33.4ms，无节点增删或几何变化，尚无收益证据。本轮真实拖动 Normal 也没截到红屏，不能宣称修复；用户此前 Normal 红、隐藏底色黑说明内容缺失并未因去底色解决。正式 GroupNode/Canvas/画布 JSON 均未改。

验证：分组探针 + 平移挂载测试 2 文件 / 15 passed，tsc、UTF-8 i18n、diff/guard 通过。已恢复 Normal、移动工具和原相机，128 节点位置及尺寸与测试前逐项一致。详细数值和限制已归档报告。当前阻塞不再是 Chrome 连接，而是未得到红屏可重复的单变量因果证据。

下一步：先扩展窄 scope 和对照方案，再实现单 SVG 连线诊断，比较相同轨迹、真实手势与交接；获得重复收益才修改正式绘制。不要直接推广本轮分组试验，不要复制独立检出的整幅快照方案。串行导入提交窗口交给 liblib-import-recovery，本线保留未提交文件，不参与该次提交。

### 2026-09-27 · 实际捕获整页红屏，分组定向对照待续

证据：用户手机录像约 3.1 秒整页发红；本轮 Chrome 普通画布真实手势截图也抓到同样现象，
顶栏一起染色，浮动按钮仍可见。另有一帧大量图片/连线暂时没画出。因此先前“红色分组底板
露出”的解释不足，已向用户更正。普通页面无 canvasPerf，诊断 CSS 并未启用。
一轮 45 次 DOM 采样保持 128 节点、102 已加载图片，无卸载/隐藏，背景 RGB(21,22,29) 稳定；
另一轮全页 3458 元素计算样式对比只出现 viewport/选框/工具条平移变化，没有红色背景变化。
这些采样支持继续查绘制/合成，不能据此判定 GPU 驱动或显存故障。

改动：发现任务中心关闭后全页模糊遮罩仍 opacity:0/visibility:visible，将其改成与文件拖入
提示层相同的 opacity+visibility 过渡。真实页面确认 hidden 生效，但随后仍抓到红屏，
因此该项是独立隐藏态修正，**不是红屏已修复的证据**。补关闭、打开、点击关闭与快速重开测试。

后续对照：临时隐藏 512 条连线后两次拖动截图正常，恢复连线后一次截图也正常，样本不能证明
连线为原因；已恢复连线。用户指出今天分组配色变更后才出现，核对 68374b2：恢复导入颜色、
透明背景从约12%到10%、边框40%到20%、独立固定屏幕字号标签。分组正文既有几何未改。
在 DEV 且显式 canvasPerf 的诊断面板增加 Group paint 选择，可独立关闭底板或标签，正常页
不生效，开关不写节点数据。分组产品代码/数据未回滚。

验证：`vitest run src/__tests__/components/task-center/panel.test.tsx src/__tests__/features/canvas/canvas-minimap-pan-mount.test.tsx`
2 文件 / 16 passed；`tsc -b`、`git diff --check`、guard 通过。
i18n 首次因 Windows GBK 输出勾号失败，改 `python -X utf8 scripts/check_frontend_i18n.py` 后
0 新增通过。未跑本轮生产构建。红屏未解决，任务中心打开/关闭真实动画尚未补测。

浏览器限制：导航诊断页后 Chrome 再报其他扩展界面阻止自动操作，用户确认关闭后再次重试
仍被拦；没有绕过。已请用户手动比较 Group paint 的 Normal / Hide group backgrounds。
这项结果尚待返回。诊断导航是否完成未确认；未改浏览器设置。最后已确认 zoom 0.223891、
连线显示；工具处于抓手。一次 HMR 重置工具后测试拖动选中了原有文本节点，后续节点位置
采样未见修改；后续应清除测试选择并恢复适合用户的视口，避免覆盖用户自己随后移动的相机。

下一步：先取得背景开/关同条件结果；仅底板关闭能消除红屏时，再对比透明填充、标题及裁剪
边界，写明确修复方案后改 GroupNode。两种都红则继续绘制层定位。不得把本轮遮罩修正或测试
数量描述为红屏已解决。

### 2026-09-27 · 先方案后完成抓手、预览交接与引用订阅

改了什么：先写并展示上述详细实施方案，再完成三步增量。抓手下节点/边及子元素不抢鼠标事件，
引用拾取临时优先；开始移动清除 hover，手势中隐藏节点加号，结束再恢复。只有手势首尾更新
React 布尔状态，逐帧视口仍由 React Flow 维护。简化态升级保存已加载预览，完整主体图片解码后
短暂淡出；重新降档、换素材和卸载取消，错误/超时有限退出，减弱动效偏好直接撤除。交接前后
均校验目标图片，生成/上传中的节点不覆盖进度；绝对定位层不增加连线桩或节点测量尺寸。
视频静态封面复用现有图片档位。新增只订阅 id/type/data 的引用 hook，图快照共用索引；视频、
图片生成及纯内容投影接入，仍需要位置排序的消费者保留原几何订阅，引用顺序协议未改。

为什么这么改：这三项有 LibTV 页面观察与本地源码依据，且能独立验证交互和引用兼容性。
不把每边独立 SVG 推断为闪烁根因，本轮未晋级共享 SVG、保存层、全局合成提示或 LOD 阈值改造。
现有封面、平移修复完整保留。本轮只修改前端，不涉及画布数据迁移、生成参数或本地工作流。

最终自动验证：在 frontend 精确执行
`vitest run src/__tests__/features/canvas/{canvas-lod,canvas-minimap-pan-mount,canvas-manual-connect,use-smooth-minimap-pan,lod-audio-playback,external-file-handoff-low-zoom,node-body-image-variant,video-frame-capture-poster,canvas-preview-handoff,upstream-reference-subscription,image-gen-stale-error-banner,reference-ordering,asset-replace-pick}.test.*`
（实际调用逐一列出文件，非 PowerShell 花括号展开），13 文件 / 136 passed。
新增覆盖上游仅位置更新 20 次不重渲染引用栏、内容/边顺序变更生效、旧几何订阅仍刷新、预览解码/
换源/降档/卸载/生成态/错误/减弱动效，以及抓手与引用拾取优先级。初次新增用例失败分别为
测试夹具缺目标节点、测试环境无 matchMedia；修正夹具与显式 mock 后最终全部通过。
`tsc -b`、`vite build --mode ce` 通过；i18n 0 新增，`git diff --check` 通过。
构建保留已有大 chunk 警告；未跑整仓测试，未发起生成或提交代码。

Chrome 实际验证：约 22.389% 的 128 节点画布从视频封面开始往返拖动，节点 ID/inline 尺寸与
位置/媒体 src 的前后快照一致，zoom 不变，最终相机回到起点；未选中节点、未出现节点加号、
video 元素为 0。实际计算样式确认手工具下节点、图片与连线 pointer-events 均为 none。
切到 50% 后完整节点及主体图片已显示，video 仍为 0。但采样未捕获到短暂预览交接层，不能据此
声称实际慢图交接已经视觉验收。输入恢复原比例后 Chrome 再次被其他扩展界面阻止，稍后重试
仍被拦，最终比例和返回选择工具未能确认。此轮播放未重测，前次播放结果仅作历史证据。

下一步：浏览器可操作后先确认/恢复普通画布的原比例与选择工具，再补 10%/22%/50% 节点、
文字和连线起拖、跨档慢图、播放与返回选择的视觉检查；取得不受秒级节流影响的真实录制后
再决定剩余绘制层优化。不能用本轮测试通过推定持续闪烁已全部消失。

### 2026-09-27 · 持续平移状态修复与浏览器对照

改了什么：Canvas 的实时相机继续由 React Flow 维护，普通 onMove 不再按 120ms 写图 store；
结束相同视口去重。连线平移把同帧 pointermove 合并成一次相机写入，pointerup/cancel/窗口失焦
补齐最后位置。小地图/连线逐帧 setViewport 产生的 end 不再提前释放 panning 类和 LOD 保护；
真实手势结束后统一释放。LOD 升级队列在手势中休眠，由结束信号唤醒。
新增仅 DEV 且带 canvasPerf 查询参数的诊断面板，运行后恢复相机，不改节点内容或布局。

为什么这么改：逐帧程序化 end 曾在输入间隔超过 80ms 时把拖动状态提前释放，导致效果和内容
升级在同一次手势中恢复；高频图 store 通知与同帧多次相机写入是独立、可测试的冗余。
没有把 512 个 SVG 直接认定为闪烁根因，本轮没有修改业务 CSS 或引入共享 SVG。

自动验证：精确运行 canvas-lod、canvas-minimap-pan-mount、canvas-manual-connect、
use-smooth-minimap-pan、lod-audio-playback、external-file-handoff-low-zoom、
node-body-image-variant、video-frame-capture-poster 共 8 个 Vitest 文件，96 passed。
其中新增覆盖普通移动 20 次产生 0 次图状态写入、结束写入 1 次/重复结束 0 次、
同帧两次连线移动合并 1 次、松手补帧、小地图慢速输入保持手势直到真正结束。
最终复核 96 项仍全部通过；TypeScript、CE Vite 构建、i18n（0 新增）、diff whitespace
与 agent_guard（32 workstreams / 1033 claims）通过。构建保留既有大 chunk 警告。

页面验证：Chrome 重开后恢复操作。约 22.389% 的 128 节点/512 SVG 画布，在固定往返轨迹中
DOM 新增/移除均为 0，节点 inline geometry 变化为 0，未播放 video 元素为 0。
50% 下静态预览 video 元素仍为 0；点击一个视频后仅创建 1 个 video，readyState=4，
无媒体错误，正常播放到约 27 秒结束。随后恢复原缩放。50% 仍沿用既有视口裁剪，边界节点
会进出视口；不以低缩放的稳定结论覆盖高缩放行为。

量化限制：静止记录 240 帧/4秒、p95=16.8ms；移动测量却反复出现约 1 秒的间隔。
用户确认前台可见后，normal 为 10 帧、p95=1033.3ms，React 合计 1.6ms；直接 DOM transform
绕开 React 为 14 帧、p95=1016.6ms、React 0 次；隐藏连线布局为 8 帧，隐藏媒体为 10 帧，
隐藏整幅画布绘制仍为 7 帧。部分秒级长帧没有足以解释间隔的脚本/渲染耗时。
因此尚无法区分浏览器调度/窗口节流/绘制管线等待，不能用这些数据宣称真实 FPS 提升或
闪烁全部解决。合成提示和去特效模式也没有可靠收益证据，未推广到正常页面。
继续读取 Chrome 内部图形诊断页被浏览器工具 URL 策略禁止，未绕过限制。已导航回普通画布 URL，
但最终状态与截图检查再次被 Chrome 的其他扩展界面阻止，未确认最后这次导航后的画面；保留页面待续。
诊断面板按代码只在显式查询参数下显示。代码尚未提交。

下一步：在前台真实手势下采集不受上述异常影响的浏览器性能录制，确认剩余视觉闪烁，
然后再决定是否需要改变连线绘制与高缩放裁剪。已经通过单测的手势/通知修复保留。

### 2026-09-19 · 补齐 ImageGenNode 的按需对话框接点与结果发布容错

做了什么：ImageGenNode 改为引用已提交的 `ThreeDDirectorDialogLazy`，并在任务完成但结果 URL 尚未可读时
按短暂退避重试结果端点。

为什么这么做：前者是上一笔 LOD 懒加载的唯一遗留接点；后者与该异步任务完成路径同处，避免成功任务因
静态产物发布稍晚而停在最后一个进度帧。仅限结果读取，不改变任务协议。

怎么验证的：ImageGenNode 导演入口聚焦 Vitest 为 7 passed，`pnpm build` 通过；大画布量化验收仍未完成。

### 2026-09-19 · LOD、远端封面与重组件按需加载收口

改了什么：低缩放状态改为带滞回的模块级单一真值，避免平移时所有节点随 React Flow transform
重渲染；视频封面优先使用已落库封面或 OSS 服务端抽帧，才回退离屏解码；图片从单一 320px
缩略图扩展为 320/640/1280 三档，历史写入预热全部档位。3D、全景、标注和转码依赖改为
按需加载，节点类型存在时才预热对应 chunk；低缩放文本与远端素材卡继续保留可辨识内容。

为什么这么改：原实现会让 Retina 节点频繁回落原图、导入远端视频为每个节点各起一个离屏解码、
且罕用的数 MB 引擎跟画布首屏一起解析。这些不是单次视觉优化，而是会随节点数量线性放大的
交互阻塞；混在同一工作树的素材替换和业务入口 hunk 本次未纳入。

怎么验证的：从 Git index 导出干净快照，9 个 LOD / 节点注册 / 媒体变体聚焦文件通过 144 项；
前端 i18n 棘轮为 0，`tsc -b` 与 Vite production build 通过。量化帧率仍需有代表性的大画布
和浏览器性能录制，因此保持“待验收”。

### 2026-09-18 · 完成远端来源审计并开始拆分可恢复提交

做了什么：刷新 `origin` 后改用 `git show 08f8f410` 审计单提交补丁，而不是比较该旧分支整棵树；
确认它只改 `Canvas.tsx`、`imageData.ts`、`useCanvasSync.ts`、`index.css`，实现的是 CSS 隐藏式 LOD。
本地则是在已合入 `origin/main` 的 `1fa4b558` 外壳式 LOD 上增加滞回单一真值、文本外壳和低缩放回归。

为什么这么做：`origin/perf/canvas-pan-lod-culling` 基于旧提交 `52c76913`，直接做分支树 diff 会出现数百个
无关文件并诱导整树覆盖。两份方案不是同一补丁副本；当前外壳方案已有主线历史和更多交互保护，应保留本地增量。
同时发现现有 LOD scope 过粗：部分文件实际是 Liblib 远端媒体、视觉对齐、素材替换或 bundle 懒加载，
本轮只提交可独立识别的 LOD 核心，混合文件按 hunk 拆分并继续留在对应工作线。

怎么验证的：`pnpm exec vitest run` 精确执行 6 个相关文件 → `6 passed / 79 passed`；误用
`pnpm test -- ...` 时脚本忽略文件参数并跑了全量，结果 `424 passed / 2 failed`、`3112 passed / 6 failed`，
失败集中在 `local-storage-quota.test.ts` 与 `queries/ingest.test.tsx`，与本线目标文件无关，已如实保留为全局基线问题。

### 2026-09-18 · 补齐来源审计门与机器 scope

做了什么：只更新本台账和 `docs/agent/claims/canvas-lod-perf.toml`，声明 LOD 文件范围与
`Canvas.tsx` 的共享关系；没有修改 LOD 业务代码。

为什么这么做：远端已有同类提交，先锁定来源审计顺序，避免下一任 AI 直接覆盖四个重叠文件。

怎么验证的：待全局 `agent_guard check` 通过后补最终结果；业务功能本轮未验证。

## 已定下来的决策

- **远端 / 本地行为审计完成前，共享热点只读**——文件时间和提交时间都不足以证明哪份实现应保留。
- **性能线必须有量化前后对比才能完成**——单测只能证明兼容性，不能证明性能收益。
- **不移植 `08f8f410` 的 CSS 隐藏式方案**——当前代码已经继承主线 `1fa4b558` 的外壳式 LOD；
  前者基于旧树且会重新引入整节点 DOM，只保留其历史量化数据作为设计证据。
- **混合文件按 hunk 提交**——`Canvas.tsx`、`LodShellNode.tsx`、`index.css` 同时含 Liblib/素材替换增量，
  不得以“LOD 文件”名义整文件暂存。

## 待办

- [x] **已核对和 `origin/perf/canvas-pan-lod-culling` 的关系**：是同一批改动的两个副本，
      还是工作区这份更新？搞错会白干或覆盖。
- [ ] 补一组量化数据：N 个节点时的帧率 / 首屏时间，LOD 开与关各一次。
      现在只有「应该更快」，没有「快多少」，无法判断这条线能不能收。
- [ ] 前端视觉改动须对齐 `DESIGN.md`；`frontend/src/index.css` 也改了，
      如变量有变动需同 commit 更新 `DESIGN.md` 并保持 `npx @google/design.md lint DESIGN.md` 0 错误
- [x] 按先方案后修改的三步完成抓手归属、预览交接、内容订阅；136 项聚焦回归和构建通过。
- [x] 2026-09-27 后续浏览器操作恢复，分组对照结束时原视口/移动工具和节点几何已核对。
- [ ] 补慢图跨档交接、连续拖动及播放返回的动态视觉验收；计划见参考报告 §8。
- [x] §8 A 的 DEV 单 SVG 探针、B 交接边界及 C 档位/解码逻辑完成，141 项相关测试通过。
- [x] 独立拖动测试副本创建、内容一致性与源文件未变验证完成；本机 manifest 保留恢复信息。
- [x] A 单SVG三轮固定轨迹已在副本完成：无明显收益，不晋级正式绘制；实际鼠标采样及用户当前体验均正常。
- [ ] B/C 慢图动态交接仍待独立视觉验收；D分组仅补一轮，无重复收益，正式组层保持条件门槛。

## 阻塞

2026-09-28 最新：用户反馈常态线改为不透明后，66% 画布拖动已不再感觉卡顿。旧拖动副本草稿冲突未动；DESIGN lint 联网执行被自动审批拒绝，需使用受信任的本地校验器补验。以下关于 66% 卡顿的记录均为修复前历史证据。

Chrome当前副本与诊断均恢复操作，收尾已关闭面板。此前旧标签拦截的内部原因仍未知；本轮三轮无节流，历史秒级样本不混入比较。
用户确认当前拖动稳定，但本轮Normal也未复现红屏，不能归因于单SVG或分组改造。正式绘制不继续扩大变更，保留已有优化；后续试验仍只用副本。
慢图升级交接未完成真实视觉验收；2026-09-28 已按用户批准实施，141 项代码回归和构建通过，仍不能替代实机证据。
不能依据历史测试数量或一次正常截图推广绘制层改造。

## 验收标准

- `cd frontend && pnpm test` 全绿，`pnpm build`（含 tsc 类型检查）通过。
- 低缩放下音频仍能播、外部文件仍能拖入、图片变体仍能切。
- 有一组前后对比的帧率数据写进本台账。

## 交接摘要

- **最后完成到**：两类边最新常态1.5px不透明、active2px/流星0.8秒，12项聚焦回归和类型检查通过。本轮周期未重复浏览器实测。
- **最新分析补充**：§16排除可见边数差异；用户复测确认不透明线版本在66%下拖动已顺畅。独立画笔耗时贡献未经单变量量化，现不继续推广共享SVG改造。
- **下一步唯一动作**：继续剩余LOD视觉验收；若同场景卡顿复现再按§16固定相机测量。旧冲突副本草稿不得清除，DESIGN lint需受信任本地校验器补验。
- **先读这些文件**：本台账最新进展、实施方案、`NodePreviewHandoff.tsx`、`useUpstreamGraph.ts`、`Canvas.tsx` 及对应测试。
- **不要动这些文件 / 决策**：保留上一轮视频封面修复和节点几何；没有因果证据不重写 SVG 层，不迁移旧分支整文件。

### 2026-09-26 · 故事板共享协调

本线既有实现先完成，storyboard-dual-view 后续串行集成共享视图接点；保留本线生成和保存行为。由当前 Codex 会话集成，禁止改工作流坐标。

### 2026-09-27 · 分组标题串行协调

本线 LOD 先完成，liblib-canvas-parity 后修改共享 GroupNode 和 index.css 的分组标题样式，由 codex/group-label-20260927 集成；复用现有 --st-canvas-zoom，保留 LOD 挂载/订阅与几何。

### 2026-09-28 · 真实项目入口修复

用户发现进入《弥寿计划》时落到仅 4 节点的连线测试画布。原因是该测试副本被浏览器记为本项目上次打开的画布。已先将 `test_edges_20260928_d4dc7fda`（4 节点、2 边）和 `test_pan_20260928_9f8a7e5d`（128 节点、512 边）备份至忽略目录 `.dramaclaw-local/checks/canvas-entry-repair-20260928/`，再通过后端软删除两张助手创建的测试副本。第一次软删除后，仍停留在旧测试画布的 Chrome 标签自动保存，使 4 节点副本重新出现；已将 Chrome 和 Codex 内嵌浏览器的旧标签先切到原始画布，再次软删除。项目画布列表现在只剩默认空壳和原始 `liblib_1cc7b1689a0f4418a145ed32f6f766e4`；原始画布保持 revision 25、128 节点、512 边。Chrome 和内嵌浏览器分别访问无 `canvas` 参数的项目入口后均自动定位原始画布；确认测试画布没有再次出现。此后此任务的测试画布不得创建在用户真实项目下。

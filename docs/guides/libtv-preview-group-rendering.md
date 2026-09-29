# LibTV 预览图、分组和拖动：实站对照与实施方案

日期：2026-09-27。工作线：canvas-lod-perf。基线：4c9dee4 及主目录已有性能增量。

## 1. 取证边界与结论

在用户指定的 LibTV 工作流画布，通过 Chrome 实际页面 DOM、计算样式、样式表和真实抓手拖动观察。没有访问站点私有源码、内部状态或接口；以下是页面可验证行为，不推断它内部使用哪种 React hook 或缓存算法。

**观察到的是每个媒体节点自己的预览图与升级交接。没有观察到拖动时用整幅截图覆盖画布。**
先前提出的整幅快照是本地备选方案，不能称为对照站的实现；独立检出的未接入草稿已撤下。

一次纯平移采样包含 12 个观察点：相机从 translate(2381.41,-804.23) 移到 (2224.41,-836.23)，zoom 保持 0.14；初始 127 个节点中 119 个仍挂载，初始 108 张图中 99 张仍挂载，存量图源变化为 0，整个采样 canvas/video/skeleton 数均为 0。稍后页面相机到达拖动终点。说明它允许视区变化引发裁剪，不能说“所有节点永不卸载”；该短采样也不能证明每一浏览器帧都不重绘。

## 2. 预览图片的详细实现特征

### 2.1 完整媒体节点也使用小图

图像节点有 `srcset` 200 / 400 / 800 / 1600 四档，并用 `sizes` 声明显示需要的尺寸。

| 观察状态 | 节点屏幕宽 | sizes | 实际选中的资源处理参数 |
|---|---:|---:|---|
| 14%，较宽图片 | 约 114 CSS px | 200px | image/resize,w_400,m_lfit/format,webp/ignore-error,1 |
| 14%，较窄图片 | 约 87 CSS px | 100px | image/resize,w_200,m_lfit/format,webp/ignore-error,1 |
| 25%，较宽图片 | 约 204 CSS px | 300px | image/resize,w_800,m_lfit/format,webp/ignore-error,1 |

浏览器结合设备像素密度选择 srcset；`naturalWidth` 会受密度修正，不能直接把 naturalWidth 当作网络文件的原始像素宽。
图片 `decoding=async`、object-fit:cover，完整节点观察到 loading:auto。纯平移样本没有换源。

视频节点使用普通 img 封面；本次 10% / 14% / 25% 检查均未挂载 video。观察到的封面处理参数为 `video/snapshot,t_0,f_jpg,w_200,m_fast,ar_auto`，即取零秒附近的 JPEG 静态帧；不能据此认定高缩放时也一直固定 200 像素。

### 2.2 更小比例切成轻量节点

10% 时页面有 128 个节点：15 分组、41 图片、11 文本、61 视频；102 个媒体节点全部使用 `.node-skeleton`，每个里面只有 `.node-skeleton-img` 和必要交互外壳；文本和分组没有切 skeleton。

- 图片 skeleton 请求 w_100 的 WebP，loading:lazy、decoding:async。
- skeleton 固定沿用节点世界宽高，例如 817 × 350；图片 absolute/inset:0/width:100%/height:100%/object-fit:cover。
- 底层使用 135deg 的 rgb(32,32,32)→rgb(72,72,72) 渐变；不依赖图片自然尺寸决定节点尺寸。
- 25% 时只挂载当前区域 53 个节点，skeleton 数为 0。10% 升到 14% 后曾仍有 skeleton，而先前从高档进入 14% 时没有。说明档位/调度与历史状态相关；**尚未锁定完整阈值、滞回和升级队列算法，不能凭两次读数编造准确阈值。**

### 2.3 节点升级时的缩略图交接

实站样式包含 `.node-skeleton.node-thumbnail-handoff`：position:absolute、left/top:0、z-index:20、pointer-events:none、opacity 120ms ease-out；fading 类只把 opacity 设为 0；减少动效偏好时禁用 transition。先前取证已捕获该层，详见 canvas-pan-stability-analysis。

这类覆盖局限于单个节点，保证简化外壳交给完整主体时旧图仍可见。当前本地 `NodePreviewHandoff` 正是这一类机制。站点精确的解码/移除条件不在 DOM 中，不能将本地实现细节当成其源码事实。

## 3. 分组背景与标题

### 3.1 背景直接在分组外层

LibTV 的 `.react-flow__node-group` 本身带背景、边框、世界尺寸和位置 transform；组与媒体都是 `.react-flow__nodes` 的直接子元素，没有把所有子节点 DOM 嵌在背景容器里。

| 项目 | LibTV 实测 | 本地当前实测 |
|---|---|---|
| 红色底板 | rgba(255,59,48,.1) | 相同 |
| 红色边框 | rgba(255,59,48,.2) | 相同 |
| 默认灰组 | 白色 10% 底板、白色 10% 边框 | 对应现有 token |
| 圆角 | 20 世界像素 | 内部底板 20 世界像素 |
| 绘制位置 | RF 分组外层直接绘制 | 外层透明，内部 `.group` 绘制 |
| 分组 z-index | -1001 | 0 |
| 额外特效 | 无 blur/filter/shadow | 被测组同样无 |

颜色和圆角已对齐，所以不能把整页红屏归结成“红色透明度配错了”。用户 Normal 红、隐藏背景黑的对照只证明底色影响异常画面剩余颜色；内容消失仍存在，不能证明仅去底色就修复。

### 3.2 标题保持屏幕字号

标题在分组上方：bottom:calc(100% + 8px)，origin:bottom left，缩放系数为 1/zoom。14% 时 scale(7.14286)，10% 时 scale(10)。因此标题维持 12 CSS px 文本、24 CSS px 高的标签，而分组底板跟随相机缩放。红色标题底 #4e1714，无阴影；文字单行省略，最大宽度随分组的屏幕宽限制。

普通媒体标题观察到 scale(2) 的限制，与分组标题的完整反向缩放不同。不能用同一公式覆盖所有标题。

## 4. 拖动与连线层

- 整个内容层只使用一个 viewport transform:translate(x,y) scale(zoom)；纯平移采样 zoom 不变。
- 抓手模式通过 CSS 将节点、节点子元素、连线及端口 pointer-events 全设为 none，鼠标交给画布；光标 grab/active grabbing。
- viewport 的 will-change:auto、contain:none、isolation:auto。没有证据显示它强制每个节点 GPU 合成。
- LibTV 511 条边使用一个 SVG，里面每条边两个 path：20 世界像素宽的透明命中路径、2 世界像素宽的可见路径。可见路径不接收鼠标事件。
- 本地 512 条边为 512 个 SVG。结构差异确定，但尚无可靠 GPU/绘制因果数据证明这是全页红屏的直接原因。

## 5. 本地实施顺序

### 第一阶段：分组绘制独立对照（本轮）

在现有 DEV canvasPerf 面板增加三项，不改变默认页面：

1. Group fill on wrapper：将已计算的底色移到 RF 分组外层；保持原内部透明边框占位，外层用内嵌 outline 表示相同描边，避免改 border-box 几何。
2. Group layer behind edges：只把分组绘制层级置于 -1001。
3. Reference group paint：组合上述两项。

不变更位置、宽高、parentId、连线或素材；离开模式/组件卸载恢复原 inline 样式；新增挂载组自动应用。每项单独拖动对照，检验标题是否被挡、文字是否消失、媒体是否保持显示和松手是否闪一下。

### 第二阶段：根据证据改正式组层

只有某个模式能重复消除异常时，才将对应绘制方案接入正式渲染。正式方案应从节点数据计算展示样式，避免长期依赖诊断用 DOM 样式转移。若对照都无效，不推广改动，转查标题层与连线绘制层。保存数据格式与布局不变。

### 第三阶段：连线层独立对照

以同一批路径建立单 SVG 的只读绘制模式用于抓手，原交互边保留并在选择模式恢复；验证变换、删边、重连、选择与端口命中。获得明确收益后再设计正式共享 SVG，不能简单将 RF 内部 SVG 合并后当作稳定接口。

### 第四阶段：预览分档和裁剪

复用本地 320/640/1280 档位与现有视频封面链路；先按屏幕大小与 DPR 测实际解码体量，再决定是否需要增加更小档位。保留加载成功的旧图到新图解码完成。裁剪采用缓冲区和稳定的候选集合；纯平移不改变资源档位，不为模仿参考而降低所有画布的 LOD 阈值。

整幅快照只作为上述对照仍无解时的备选：它涉及字体、跨域图片、超出缓存和交接等新风险，当前不接入。

## 6. 验收与限制

自动回归：探针正常/单项/组合、样式恢复、后续样式修改不被回滚、新挂载、root 范围隔离；类型检查、差异/guard。
实机：相同画布、同一浏览器、固定缩放，至少多次往返拖动并观察结束；恢复 Normal 与原视图。记录是否复现和 DOM 几何，**不把此前近每秒一帧的自动化节流当作应用 FPS**。

研究可以确定可见结构和样式，不能凭 DOM 断言 React 没有 render、浏览器没有 repaint、GPU 没有丢合成内容。尚未锁定红屏根因，不能将“发现结构差异”写成“已解决”。

## 7. 本轮实现与验证结果

三个分组绘制对照已接入 DEV 的 Group paint 菜单，默认仍为 Normal；结果记录包含 groupPaint，运行中禁止切换它以免混淆样本。正式 GroupNode、画布布局、数据和颜色配置没有修改。

固定缩放 0.223891、同一条 4 秒平移轨迹，各运行一次：

| 绘制模式 | 采样帧数 | 帧间隔中位数 | 帧间隔 P95 | 节点增删 / 几何改变 |
|---|---:|---:|---:|---|
| Normal | 206 | 16.7ms | 33.4ms | 0 / 0 |
| 仅外层底色 | 202 | 16.7ms | 33.4ms | 0 / 0 |
| 仅降低层级 | 214 | 16.7ms | 33.3ms | 0 / 0 |
| 两项组合 | 206 | 16.7ms | 33.4ms | 0 / 0 |

这组单次结果没有证明任何模式能明显改善性能。真实抓手往返也检查了 Normal、降低层级和组合模式，这轮截图均未捕获红屏，包括 Normal。因此不能据此宣布新模式解决红屏，前轮已经复现的异常仍有效。

验证通过：分组探针与平移挂载回归共 2 文件 / 15 项；`tsc -b --pretty false`；前端 i18n 检查（UTF-8）；`git diff --check`；agent guard。未新增生产构建或 GPU trace。

结束时恢复 Normal、原移动工具、原相机 translate(2930.4,-1033.33) scale(0.223891)；128 个节点的 id、transform、width、height 与测试前逐项一致。

**下一步明确目标**：在上述第三阶段范围内做单 SVG 连线绘制独立对照，先验证红屏是否可重复受连线层影响；同时以节点预览体量与升级交接为独立指标。分组外层/层级改动不晋级正式路径，整幅快照继续暂缓。

## 8. 2026-09-28：四项进度与代码块级实施提案

**本节为方案，尚未实施。** 用户明确要求先细化再动手。本轮仅审计代码和更新文档，没有新改业务代码、运行测试、重启或提交。

### 8.1 当前基线与完成边界

- 当前 HEAD：`8428b3a`，分支 `codex/sync-main-remotes`，比同名远端本地引用领先一笔。已有性能/封面改动仍在工作树；不能用 HEAD 单独代表正在运行的全部代码。
- `agent_guard check` 通过；审计时无活动锁。本轮仅持文档交接锁。
- 下文行号对应本次工作树，实施时以函数名/代码块为定位依据，不能按旧行号覆盖文件。
- 本地 `origin/main` 引用与 HEAD 在诊断、预览交接、边组件、选档 hook、图片投影、media-url 六类目标路径未显示新差异；旧 LOD 分支审计沿用任务台账。本轮未 fetch，正式实施前重新核对引用与共享文件归属。

| 原顺序 | 当前实际状态 | 已有代码与证据 | 尚未完成 |
|---|---|---|---|
| 1. 单 SVG 连线对照 | 未实现 | `CanvasPanDiagnostics.tsx` 只有隐藏全部连线等模式；正式连线仍由 RF 每条创建 SVG | 单 SVG 诊断、真实手势对照、可靠因果结论；正式替换未开始 |
| 2. 节点预览交接 | 主体已实现，边界与实机未收口 | `NodePreviewHandoff.tsx`、`withLodShell()`、CSS、9 项现有交接测试；此前聚焦套件 136 项通过 | 解码拒绝分支、无条件 5 秒退出、淡出中换目标、慢图跨档视觉验证 |
| 3. 屏幕尺寸选缩略图 | 基础链路已实现，稳定切档待补 | 320/640/1280 档位；`max(width,height) × zoom × DPR`；图片、常规视频封面和 shell 已接入不同程度 | 档位滞回、同素材换档解码后提交、远端视频封面适配边界、异常尺寸测量兼容性 |
| 4. 分组外层和层级 | DEV 对照已完成，正式方案未采用 | 外层填色/仅降低层级/组合，6 项探针测试；4 模式一轮结果无明确差别 | 可重复受控收益。当前不满足正式改组层的门槛 |

**红屏仍未解决。** 单测证明逻辑兼容性；本轮没有新的实机测试结果。第 7 节测量是 2026-09-27 的历史结果。

### 8.2 A 阶段：单 SVG 绘制对照

#### A1. 为什么不能只修改 DisconnectableEdge

已读取本机安装的 `@xyflow/react`：`EdgeRendererComponent` 为每条边创建 `EdgeWrapper`，后者在自定义边组件外再包一层 `<svg style={{zIndex}}><g ...>`。因此把 `DisconnectableEdge` 内部改成 path，外部的 512 个 SVG 仍存在。

当前业务组件还有路由、两端圆点、选中/关联高亮、处理动画、悬停删除、预设边保护。第一步只测绘制容器数量，不重写这些业务行为，也不改依赖包。

#### A2. 精确文件与代码块

| 路径（frontend/src/ 下） | 修改块 | 内容 |
|---|---|---|
| `features/canvas/application/canvasEdgePaintProbe.ts`（新增，独占候选） | `captureEdgePaint()` / `prepareSingleSvgProbe()` | 从当前已渲染的路径生成一次性的共享 SVG，返回启用、恢复、校验接口 |
| `features/canvas/ui/CanvasPanDiagnostics.tsx`（既有独占） | `Mode`、`run()` 的准备/finally、按钮、结果 | 增加 `single-svg` 与对应手动录制；准备成本单列；所有结束路径恢复 |
| `__tests__/features/canvas/canvas-edge-paint-probe.test.ts`（新增） | 构造 RF DOM 夹具 | 图形等价、defs 引用、零几何修改、失败恢复、重复进入退出 |
| `__tests__/features/canvas/canvas-pan-diagnostics.test.tsx`（新增） | 生命周期夹具 | 取消、异常、换页、卸载恢复；模式互斥、测量有效性 |

`Canvas.tsx` 的 `renderedEdges`（约 1191）和 `<ReactFlow edges={renderedEdges}>`（约 4991）本阶段只读；`DisconnectableEdge.tsx` 约 140–185 的路由计算和 242 起的 JSX 只读。这样首轮不改正式连线树。

拟定接口（设计草图，函数未创建）：

```ts
type EdgePaintProbe = {
  activate(): void;
  restore(): void;                 // 幂等，异常也能恢复
  valid(): boolean;
  stats: {
    sourceSvgCount: number;
    paintedSvgCount: number;
    edgeCount: number;
    preparationMs: number;
  };
};

function prepareSingleSvgProbe(root: HTMLElement): EdgePaintProbe;
```

#### A3. 快照内容与激活顺序

1. 从当前 root 下已存在的 `.react-flow__edges > svg` 读取图形。只读当前 DOM 得到的 `d`、circle 坐标、stroke/fill、线宽、透明度、dash、transform 和 marker；不另算世界坐标，不从节点中心猜连线端点。
2. 使用 SVG DOM API 按白名单创建 `g/path/circle/defs/marker/gradient`，显式复制当前绘制属性。局部 ID 全部加诊断前缀，重写对应 `url(#...)` / href，避免与原图冲突。不能直接拼接未经约束的 HTML，也不能丢掉 marker 和端点圆点。
3. 原 SVG 的坐标系统与层级必须可映射到同一共享层。首轮限定低缩放、固定缩放、无选择/悬停/生成动画、同一 SVG 层级的画布；有自定义 viewBox、外部资源引用、未支持图元或不同层级时返回“本次不适用”，保持 Normal。不会自动清掉用户的选择。
4. 新 SVG 放到原连线容器所在 viewport 内的同等绘制顺序，绝对定位、overflow:visible、pointer-events:none；沿用父 viewport transform，不能再乘一次相机矩阵。原容器的零点/变换必须先验证相同。
5. 先完成新层并验证图形计数，再在同一帧显示新层、隐藏原连线容器。原 DOM 和 React 组件保持挂载，恢复时只撤临时显示样式并移除新层。
6. 整个测量期间仅父视口平移，新 SVG 不逐帧重建。原连线子树的路径/样式/数量有变化，节点被编辑、缩放改变、连线总开关改变、画布卸载或工具切出抓手时，终止样本并恢复 Normal。
7. 诊断 CSS、observer 与恢复都限定当前 root，不影响第二张画布；复用分组探针“只撤自己的写入”的恢复原则。

**测量口径**：原 512 个 SVG 暂时仍在 DOM，只是退出绘制；共享层增加 1 个。因此这是“独立 SVG 绘制容器”对照，不能写成“DOM 已减为 1”或“React 工作已减少”。真正减少挂载是后续正式架构问题。

#### A4. 接入现有 run() 的顺序

```ts
// 伪代码：准备与清理都位于统一 try/finally 保护内。
let edgeProbe: EdgePaintProbe | undefined;
try {
  // 等当前 UI 稳定，Normal 与 single-svg 使用相同手势/动画状态。
  edgeProbe = selectedMode === 'single-svg'
    ? prepareSingleSvgProbe(root) : undefined;
  edgeProbe?.activate();
  await nextFrame();
  // 准备时间单列；此后才启动现有 4 秒轨迹/真实抓手记录。
  await recordPan({ isValid: () => edgeProbe?.valid() ?? true });
} finally {
  edgeProbe?.restore();
  // 沿用原有视口恢复、observer 释放、手势结束和 running 重置。
}
```

实施时同时记录：mode、groupPaint、scale、可见状态、SVG 实际绘制数、图形数量、DOM 增删、节点几何差异、图片 src 变化、帧间隔和是否出现红/黑屏。只在前后取 DOM 快照；禁止逐帧扫描全部媒体制造额外开销。

#### A5. 对照与晋级条件

- 固定 Group paint=Normal、相同视口与加载完成状态。先 Normal / single-svg / Normal 往返，至少 3 组；另做真实抓手来回拖动。诊断模式自动恢复相机，手动测试也确认恢复。
- 低缩放稳定全量节点为第一组；高缩放裁剪是另一个实验。快照期间一旦发生裁剪变化，该次标为无效，不能画着过期连线继续计算收益。
- Normal 没复现而实验也没复现，只能写“未复现”；出现节流时不计算 FPS 提升。若基线能重复出现而单 SVG 稳定消除，并在恢复基线后再次出现，才有更强的因果证据。
- 只有获得重复改善，才进入正式共享层设计：从 `DisconnectableEdge` 提取纯路由/绘制描述，使用一处显示层与原交互层切换。这个阶段另过方案门，尤其覆盖重连、删线、节点移动、分组相对坐标与选中边层级；首轮不直接承诺替换整个 RF 边系统。

### 8.3 B 阶段：补齐已有预览交接

#### B1. 已有实现

- `LodShellNode.tsx:254` 的 `withLodShell()`：约 311–315 在升级队列放行前捕获 shell 图片，347 挂交接层；身份包含素材 URL、生成/上传状态和尺寸，排除位置/选择。
- `NodePreviewHandoff.tsx:14`：仅捕获已经 loaded 的图片；27 起组件监听目标图，解码后两次 RAF 再淡出；换源、降档、卸载有取消逻辑。
- `CanvasNodeImage.tsx:69` 与 `VideoNode.tsx:3492/3530`：主体图/视频添加 `data-canvas-preview` 供交接定位。
- `index.css:882`：覆盖层绝对定位、z-index 20、pointer-events:none；本地动效 token 为 150ms，LibTV 实测 120ms。本轮采用既有 token，时长不是当前空白问题的首要变量。

#### B2. 本次代码审计发现的缺口

| 位置 | 当前行为 | 拟修改 |
|---|---|---|
| `NodePreviewHandoff.tsx:71` | `decode().then(complete, complete)`，拒绝也进入成功路径 | 成功与失败分开；过期候选只丢弃，当前候选拒绝走明确失败退出，不进行“已解码”淡出 |
| 同文件约 41 | 5 秒不分状态直接 `onDone()` | 5 秒仅作为“找不到目标主体”的退出；目标存在且仍加载/解码时继续保留同素材旧图 |
| 同文件 inspect/ready | 解码前换源有检查，淡出已开始后新目标到来没有完整重置状态机 | 每个候选有代次；换 src/currentSrc/元素立即取消旧 RAF 和淡出，重新等待当前候选 |
| 同文件 observer 约 82 | 只观察 src | 覆盖 src、srcset、sizes 以及目标插入/移除；load 时重读 currentSrc。只在交接存续期订阅 |
| transitionEnd / timeout / error | 多个入口均直接调用 onDone | `finishOnce(reason)` 统一退出，保证回调、timer、observer 一次性清理 |

不能把 `decode()` 拒绝直接等同图片彻底坏掉：若拒绝时目标/来源已经换了，则旧结果失效并等待新目标；若仍是当前候选，按失败恢复完整节点本来的错误/占位界面。不要用失败证明像素已就绪。

#### B3. 状态机与代码草图

```ts
type HandoffPhase = 'waiting-target' | 'loading' | 'decoding' | 'fading' | 'done';
// token 是组件局部代次，不进入 canvasStore 或节点数据。
const token = ++generation;
setFading(false);
void image.decode().then(
  () => {
    if (!isCurrent(token, image, src)) return;
    fadeAfterPaint(token);  // 两次 RAF 中仍校验当前候选
  },
  () => {
    if (!isCurrent(token, image, src)) return;
    finishOnce('decode-error');
  },
);
```

事件规则：

1. shell→full：捕获同素材已加载图；没有有效旧图就正常显示 full。
2. full 图加载/解码中：旧图继续显示，即便超过 5 秒。可见目标若永不结束会保留覆盖层，直到失败、换源、降档或卸载；覆盖层不创建新请求、不维持轮询、不阻止点击。记录这一边界，不能偷偷当成功撤掉。
3. 无目标连续 5 秒：退出并暴露原组件；每次目标出现即撤掉此 timer。
4. 解码完成：候选代次/元素/currentSrc 一致才淡出；淡出结束再释放旧图。加短的淡出结束兜底，避免 transitionend 丢失后遗留覆盖层。
5. 淡出期间换档：撤销本次淡出，重新盖住旧图，等待新目标。
6. 新生成结果/换视频/替换图片：立即撤掉旧素材覆盖；不能跨素材延续旧图。
7. 请求播放后已有视频帧：结束覆盖，播放器继续正常播放。生成、上传中的进度层优先。

#### B4. 精确写入与验证

主修改：`ui/NodePreviewHandoff.tsx`。接点审计：`nodes/LodShellNode.tsx` 的 identity/347 渲染块；仅必要时调整生命周期，不改 LOD 阈值和节点尺寸。CSS 仅在淡出取消或兜底需要时改 `.dc-node-preview-handoff` 小块，保持项目动效 token。

扩展 `canvas-preview-handoff.test.tsx`：超过 5 秒慢图、过期解码拒绝、当前解码拒绝、淡出中换地址、目标被替换、srcset/sizes、错误与 timeout 竞争、重复结束、减少动效、卸载后异步回调。沿用现有换素材/降档/生成/播放覆盖。

实机分别检查 10%→22%→50% 和 0.35/0.38 附近跨档、缓存命中与慢图；至少一次捕获旧层存在→新图可用→旧层消失全过程。未捕获到过程不能当作视觉验收通过。

### 8.4 C 阶段：完善已有的缩略图选档和换图

#### C1. 已有调用链及不能重复实现的部分

```text
节点显示宽高 + React Flow transform[2] + useDevicePixelRatio()
  → nodeBodyRequiredEdge()             imageData.ts:274
  → pickMediaVariant()                 media-url.ts:65
  → useNodeBodyVariant/Budget()         hooks/useNodeBodyVariantBudget.ts:20
  → nodeBodyImageSrc()                  imageData.ts:311
  → 节点 img src                       ImageNode/ImageGenNode/UploadNode
```

常规 VideoNode 约 1919–1929 也用这个档位处理 poster；LodShellNode 约 167 起使用相同 hook。纯平移改变 transform[0/1]，selector 返回档位未变时不会引起该 hook 的 React 更新。这一基础已存在，不能再称为“要从头实现按屏幕尺寸”。

后端 `utils/thumbnails.py` 与前端已经对应 320/640/1280 三档。先复用；100/200 档需要后端生成、缓存与预热一起扩展，当前提案不增加新档位。

`imageData.ts:258`、选档 hook 注释和 `pickMediaVariant` 注释仍写“只有 thumb 与原图”，与三档实际代码不一致，实施时一并修正文档注释。

#### C2. 档位稳定：只加在画布消费者，保留公共选择器

新增候选 `application/canvasPreviewPolicy.ts` 中纯函数；在 `hooks/useNodeBodyVariantBudget.ts` 接入。不修改全站 `pickMediaVariant()` 的语义，历史栏/详情页沿用原行为。

```ts
type Tier = MediaVariant | null;  // null = 原图
function chooseStableCanvasTier(
  previous: Tier,
  requiredEdge: number,
): Tier;

// 提案策略：放大时当前档盖不住需求即升级；缩小时满足较小档
// 80% 的预算后才降档，例如 640→320 要 requiredEdge ≤256。
// 0.8 是本地待验收参数，不是声称 LibTV 使用该数值。
```

hook 仍返回量化档位，依赖只有 width/height、zoom、DPR。滞回状态在 hook 局部/effect 或显式订阅回调内管理，不在 useStore selector 中写 ref；平移不会改变输入预算。素材替换、尺寸改变和 DPR 改变重新评估；宽高非法沿用现有 fallback。

选档滞回与 LOD shell 阈值是两回事：现有 0.35/0.38 保留。小尺寸节点即使 zoom 较大也应按实际预算，但节点已有 `preferOriginalImage` 的细看/测量分支先保留，不在同一补丁改变其语义。

#### C3. 同素材跨档：解码成功才提交新显示描述

目前 `<img src>` 直接跟随档位改变；B 阶段只保护 shell→full，不能覆盖 full→full 的 320→640 换档。因此新增候选 hook `hooks/useDecodedNodeImage.ts`，负责同素材不同显示资源之间交接。

拟定接口：

```ts
type DisplayCandidate = {
  mediaKey: string;          // 素材身份，包含版本；不是缩略档位 URL
  body: NodeBodyImage;       // src/original/downscaled/maxEdge 一起提交
  measurementKey: string;   // 尺寸记录/测量语义变化也使旧候选失效
};
function useDecodedNodeImage(candidate: DisplayCandidate | null): {
  displayed: DisplayCandidate | null;
  pending: boolean;
  failed: boolean;
};
```

- 初次加载/换素材：按原路径加载新图，立即使旧素材显示无效。
- 同素材换档：以受限的解码任务预加载候选；屏幕继续显示已解码描述，候选成功后整份提交。请求序号防止慢旧请求覆盖新档位。
- 请求失败：保留同素材的最后成功图，本次候选标记失败；相同候选不无限重试。素材变更或显式重新加载后再试。已有新素材错误 UI 仍按原逻辑处理。
- 解码任务复用相同 URL，使用有上限的队列；最多 4 个活动任务的起始值需压测。取消时至少取消排队和提交资格；不可声称浏览器已经开始的 Image 解码能强制中断。零消费者时释放引用，不建立第二套无限图片缓存。
- 返回完整 `NodeBodyImage`，让 onLoad 的 `nodeBodyImageMeasurement()` 使用**当前真正显示的 src 对应描述**。不能只延迟 DOM src，而闭包已换成新 maxEdge，否则会把缩略图尺寸写回节点。
- 当天然尺寸记录不可信、原图需重测、上传临时地址、历史预览或图册主图发生切换时，按 measurementKey/mediaKey 使旧描述失效；兼容现有 distrustRecord 与 trustAgain。

精确接入块：

| 文件 | 当前块 | 计划 |
|---|---|---|
| `nodes/ImageNode.tsx` | 191 的 bodyImage、214 的 imageSource、280–302 的测量 | 将请求描述与显示描述分开；src 与测量共用 displayed |
| `nodes/ImageGenNode.tsx` | 936 的 bodyImage、1694 的 src、1704–1720 的测量 | 同上，生成/历史选择纳入身份失效 |
| `nodes/UploadNode.tsx` | 807 的 bodyImage、831 的 imageSource、845 起的 onLoad | transientPreview 优先保持；仅稳定素材接入 |
| `nodes/VideoNode.tsx` | 1919–1929 的 poster、3530 的静态 img | poster 同素材换档稳定，mediaKey 包含 videoSource；播放源不进入该 hook |
| `nodes/LodShellNode.tsx` | 167–204 选档/地址、220–234 的 img | 复用稳定档位与异步解码；不改变 shell 框/handle |
| `ui/CanvasNodeImage.tsx` | 65–76 的 img | 保留通用 img 与查看器语义，优先由上游传入已提交描述；避免此处私自换 src 导致 onLoad 语义错配 |

共享解码队列候选放 `application/canvasPreviewDecodeQueue.ts`，针对代次/共用/取消/并发单独测试。仅在 C3 阶段引入，不与 A 阶段同时上线。

#### C4. 地址适配与特殊分支

- `nodeBodyImageSrc()` 已支持本地静态变体和部分远端图片缩放；常规视频 poster 当前只调用 `withMediaVariant()`，绝对远端 URL 会保持原样。方案应区分“本地封面图片”“远端普通封面图片”“video/snapshot 转换 URL”，不能把视频抽帧 query 覆盖成 image/resize。
- 将图片变体选择封装为可单测的候选解析函数，放 `application/imageData.ts`；视频候选仍先经过 `derivedVideoPoster()` 的归属检查，再送显示适配。签名 URL 保持原样；只有本地路由或已知可安全处理的远端来源才能改参数。
- `lib/media-url.ts` 的现有远端处理也需补组合签名参数回归：带 `x-oss-process` 并不自动代表其它签名参数可忽略。无法安全生成小图就保留原地址并记录 fallback 原因，禁止反复追加 cache-bust。
- `LodShellNode` 的旧 `liblibMediaNode` 视频分支在无 poster 时仍可挂 `<video preload="metadata">`。这与普通 VideoNode 静态封面不同。先用节点类型计数确认影响；需要修时复用已有 poster/空闲抓帧队列，不能以“已有静态封面”掩盖这条例外。
- 没有可信原图尺寸的图片，当前有加载原图测量职责，先保留。小图尺寸不能被写成原图尺寸；如需完全取消首次原图解码，应单独补导入 metadata，另开后端方案。
- 在 shell 的预算超过 1280 时，当前 `?? 'thumb'` 会回落 320。拟改为上限档 `card`，保障大尺寸 shell 可读性；这是单独测试项，确认解码体量后再接入。

#### C5. 验证清单

新增纯策略/解码队列/hook 三类测试；扩展 node-body-image-variant、video-frame-capture-poster、media-url 与图片/上传节点尺寸回归。检查：DPR 1/2/跨屏、320/640/1280 边界、10 次边界反复、100 次纯平移零资源切换、慢请求乱序、失败后保持旧图、换素材立即失效、同地址新版本、新视频不取旧 poster、签名 query 不变。

实机记录图片档位分布、资源 currentSrc 变化次数和解码尺寸估算，不将这些指标称为真实 GPU 显存；正常拖动节点数据写入为 0，停止后只允许既有相机保存。后端返回原图的 fallback 要单独统计，不能因为 URL 带 thumb 就认定实际降采样成功。

### 8.5 D 阶段：分组正式渲染的进入条件与代码块

当前维持第 7 节结论：三种 DEV 对照均无明确收益，正式 GroupNode 不改。此项是有条件阶段，不必为了清单完成而强行调整层级。

若后续能在相同条件重复证明外层绘制/层级有效，才采用下面分支：

1. `Canvas.tsx` 约 1160 的 renderedNodes 投影：为工作流分组派生展示 style/zIndex，保留 node.position、width/height、parentId 和用户样式；不回写 store，不写入 JSON。
2. `GroupNode.tsx` 约 405–418 的外壳 style：背景交由外层后内部保持透明边框占位；选中态、投影边框、尺寸手柄继续属于原组件。只有背景迁移有收益就只迁背景，不顺手加层级变化。
3. `GroupNodeHeader.tsx` 约 29–39 的反向缩放/标签：首轮保持现有逻辑。验证负层级是否让标题或编辑框被相邻节点遮挡。
4. 故事板组有独立语义，默认保留原路径；如需共用必须另测重排与 dragHandle。
5. 新增 group-paint-projection 纯投影测试及组交互回归；验证相对坐标、子节点拖动、缩放、选择、标题编辑、组框调整和刷新保存。

示意（条件方案，不是本轮待直接粘贴代码）：

```ts
const renderedNodes = nodes.map(node => {
  if (!shouldUseVerifiedGroupPaint(node)) return node;
  return {
    ...node,
    style: { ...node.style, ...deriveVerifiedGroupPaint(node.data) },
    // 仅层级对照也通过时，才在展示投影中覆盖 zIndex。
  };
});
```

正式阶段不能长期依赖 `canvasGroupPaintProbe.ts` 的 DOM style 转移；该文件仅服务诊断，保留精确恢复能力。

### 8.6 实施顺序、验收门与回退

| 批次 | 上线内容 | 进入下一步条件 | 回退粒度 |
|---|---|---|---|
| A | DEV 单 SVG 对照 | 相同图形/坐标、可靠清理、Normal/A/B 证据归档 | 新探针 + 诊断接点 hunks |
| B | 预览状态机边界 | 新回归通过且实机看见慢图交接全过程 | Handoff 生命周期与对应 CSS hunks |
| C1 | 画布档位滞回 | 边界不抖、平移无切档、DPR 正确 | 新策略 + hook 接点 |
| C2 | 同素材解码后切图、poster 适配 | 测量语义不变、换素材不串图、真实预览稳定 | 队列/hook及逐个节点接点 |
| D | 分组正式投影（有条件） | 单变量重复收益 + 分组交互验收 | GroupNode/投影局部 hunks |

每批先扩充精确 claim、审计现有差异与新 HEAD、acquire/preflight，再写业务代码。上表列出的新增候选文件目前没有创建，也没有借本方案扩大正在执行的写入范围。`Canvas.tsx`、`index.css`、LodShellNode、VideoNode 等仍按既有共享规则串行。

每批验证范围：聚焦 Vitest → tsc → UTF-8 i18n/diff/guard → Chrome 同页观察。最终组合时再做 CE 构建和有关节点交互回归；不用全仓测试数量代替视觉证据。

验收应分成两项：

- **逻辑稳定性**：纯平移节点坐标/宽高/parentId/引用/媒体身份不变；缩放保持用户动作预期；换图和播放正确。
- **视觉稳定性**：前台同画布固定缩放反复拖动、跨缩放档、松手和播放返回均无全页红/黑、成片节点消失或交接空白；记录复现次数与场景。基线不复现时不宣布修复；若仍有全页异常，保持未解决并继续区分节点/连线/分组层。

全部回退都按本批 hunks；不执行整文件 restore、不改画布坐标，不将工作树其它功能混入提交。后续实现以用户确认本提案后的范围为准。

## 9. 2026-09-28 获准实施后的实际状态

本节记录用户“按建议调整”后的代码事实；§8 中“候选未创建”描述的是实施前状态。

| 项目 | 本轮落点 | 验收状态 |
|---|---|---|
| A 单 SVG 连线 | `application/canvasEdgePaintProbe.ts` 与 `ui/CanvasPanDiagnostics.tsx` | DEV 探针及清理回归完成，实机 A/B 尚未完成 |
| B 节点预览交接 | `ui/NodePreviewHandoff.tsx` | 慢图、换目标、拒绝、重复退出、版本失效回归通过；动态视觉过程待测 |
| C 档位和解码 | `application/canvasPreviewPolicy.ts`、`canvasPreviewDecodeQueue.ts`、`hooks/useDecodedNodeImage.ts`、原选档 hook 与五类节点 | 策略、队列、地址和集成回归通过；解码并发参数尚未完成实机压测 |
| D 分组正式绘制 | 本轮未进入 | 继续要求重复改善证据；既有 DEV 分组开关仍用于对照 |

### 9.1 单 SVG 探针的实际边界

- 完整保留 React Flow 的边组件，以一个临时 SVG 绘制可支持的静态图形，短时隐藏原绘制容器；它只测绘制容器合并，不代表已经减少 React/DOM 开销。
- 复制几何和计算后的画笔属性，重写局部 marker/gradient ID；外部引用、未知图形、过滤器、不同坐标系或不同层级会拒绝实验。实际边 SVG 统一为 z=1，已改为保持统一实测层级，而非要求所有边为 z=0。
- 选中、生成动画边、缩放不低于 0.35、非 Normal 分组对照等条件拒绝运行。手工拖动还要求抓手工具。准备成本与四秒采样分开记录。
- 期间图形变动、换工具或缩放时样本无效；完成、异常、卸载均撤掉临时层并精确恢复原显示。诊断相机恢复保留原有规则。
- 本轮浏览器先遇到已有选择而拒绝；创建独立诊断页时 Chrome 再次提示扩展 UI 阻止自动操作。未得到合格 Normal/单 SVG 往返样本，不能据此推广正式单 SVG 实现或声称消除红屏。

### 9.2 交接和缩略图实现细节

- 有效目标图片加载/解码超过五秒继续保留节点旧图；五秒只用于目标不存在。当前失败暴露原节点错误/占位，过期失败忽略；淡出取消、重复事件和 500ms 淡出结束兜底均只完成一次。
- `src/srcset/sizes/currentSrc`、目标元素和局部代次共同决定旧回调是否有效。目标换档撤销旧淡出。视频已有首帧时结束封面覆盖。
- 画布档位使用已有 320/640/1280 阶梯，放大不足即升级，缩小时需求低于较小档 80% 再降档。hook 的 selector 不写状态；状态在组件内部派生，纯平移保持档位结果。
- 同素材且已加载成功的图片，换档时由最多四个活动逻辑任务的队列预解码，成功后一次提交 src/original/downscaled/maxEdge；尺寸回调始终读取所显示描述。队列只去重活动 URL，不另建永久位图缓存。
- 取消会撤销排队或提交资格；不能中止浏览器原生解码。30 秒逻辑任务超时释放槽位并报告失败，不代表原生请求已被终止。失败保留同素材上次成功图，相同候选不无限重试。
- 新素材、生成清空、版本或测量上下文变化立即失效旧图。图片生成节点 shell 的源顺序已与完整节点对齐，优先当前编辑预览；交接身份纳入 committed_at，保护同地址新版本。
- 图片/上传节点原有原图测量、查看器、下载语义继续由原组件管理。没有可靠原图尺寸时仍加载原图，不能把缩略图尺寸写回原始像素记录。
- 视频封面先经过既有来源归属校验，再按档位生成显示候选。旧 liblibMediaNode 的视频 shell 改为同一静态封面/空闲抓帧路径，超预算 shell 封顶 card，避免直接回落 320。
- 远端普通图片只有已知 OSS 来源或只有 image/resize 参数时适配；任何额外 query 都原样保留，保护组合签名；video/snapshot、blob/data 和未知服务也保留原地址。URL 请求了缩略图不等于后端一定返回小图。

### 9.3 验证及剩余工作

在 `frontend` 运行 Vitest 的以下 13 个聚焦文件：canvas-edge-paint-probe、canvas-pan-diagnostics、canvas-preview-policy、canvas-preview-decode、canvas-preview-handoff、node-body-image-variant、video-frame-capture-poster、lod-audio-playback、lod-shell-fallback-sizes、canvas-node-image-wake-refresh、image-gen-stale-error-banner、image-node-resize-min，以及 lib/media-url。最终 **141 项通过**。

`tsc -b`、`vite build --mode ce`、前端 i18n 棘轮、`git diff --check` 和 agent guard 通过。构建仍有既有大 chunk 提示。测试包含 100 次纯平移选档 hook 无新增 render、十次边界往返、DPR 1/2、四任务限制/取消/超时、过期解码、失败保持、尺寸描述原子提交、换素材/版本失效和签名组合保护。

下一次实机操作恢复后：在独立诊断页确认无选择、无生成、Normal 分组和相同低缩放，先做 Normal→single-svg→Normal 往返对照，再采集慢图 shell→full 与 320→640 的实际交接；记录源地址变化、节点几何、准备成本和红/黑异常。生产分组与连线结构仍须以重复结果决定。红屏根因保持未解决，禁止用本轮逻辑回归代替视觉验收。

## 10. 2026-09-28 实际往返拖动与行为伪代码

本节响应“先写清逻辑、对照参考再写代码”。本轮只更新文档；下文的参考伪代码是与实测相容的行为模型，**没有取得 LibTV 私有源码，不能称为其内部实现**。已有实现见 §9，不重复开发同一套机制。

### 10.1 本轮新增直接证据

在同一 Chrome 的 LibTV 参考画布、14% 缩放、无节点选择状态，从空白处水平拖动 320 个屏幕像素，再反向返回：

| 项目 | 拖动前 | 右移后 | 返回后 |
|---|---:|---:|---:|
| 视口 x | 2131.41 | 2451.41 | 2131.41 |
| 视口 y / zoom | -854.23 / 0.14 | 相同 | 相同 |
| 挂载节点 | 112 | 128 | 112 |
| 连线 SVG 容器 | 1 | 1 | 1 |
| video 元素 | 0 | 0 | 0 |

拖动前有 91 张 img；右移新增 16 个节点，原有节点未移除，原有节点的 inline style 未变，保留图片的 currentSrc 未变。返回后节点数和图片数恢复。动作后截图正常；没有捕获逐帧完整视频，因此不据此声称全程零异常或给出 FPS。

静态结构补充：viewport 没有 will-change、contain、isolation 或 filter 的额外提示；抓手状态 pointer-events 为 none。观察到的分组背景和边框在 React Flow 外层节点上，z-index=-1001，子媒体与分组属于同级节点结构。一个可见图片样本 decoding=async、有 srcset、sizes=200px，屏幕宽约 114px；这仅说明存在响应式图片选择，不能从一个样本反推出全站精确档位。

**需要修正的假设**：LibTV 并非“拖动时全部 DOM 永远冻结”。边界节点确实进出视野；应保证保留节点的世界坐标和媒体身份稳定，允许必要的可见性裁剪。参考内部缓存、缓冲区大小、裁剪时机、队列并发数和保存节流策略仍未知。

### 10.2 参考行为模型及未知边界

```ts
// 行为模型；render/culling 的具体算法没有从参考站源码确认。
world = persistedNodesAndEdges; // 世界坐标、分组、引用
camera = currentViewport;      // 屏幕平移和缩放

onHandPanStart():
  routePointerToCanvas();      // 观察到抓手禁用节点/连线命中

onHandPanMove(delta):
  camera.xy = gestureStartCamera.xy + delta;
  viewport.transform = translate(camera.xy) * scale(camera.zoom);
  visible = chooseVisibleNodes(world, camera); // 观察到 112→128→112
  reconcileByNodeId(visible);
  for each retainedNode:
    keepWorldGeometry();      // 本轮前后 inline style 未变
    keepMediaIdentity();      // 本轮保留图片 currentSrc 未变
  // 连线与组背景在相同世界坐标系内随父视口移动。

onHandPanEnd():
  keepFinalCamera();
  // 持久化时间、队列恢复策略：本轮无法从 DOM 证明。

onZoomOrMediaChange():
  choosePresentationForCurrentScale();
  // 此前 §2 的实测有节点旧预览覆盖及短暂淡出。
  keepOldPreviewWhilePreparingSameAsset();
  replaceAfterReady();
  // 精确解码/超时/失效机制属于本地设计，不冒充参考源码。
```

“只平移”不等于整个 React 树零 render，也不等于禁止新生成结果出现。对照时固定素材版本并停止生成，以区分真实内容变化与不必要的换图。

### 10.3 本地代码逐块对照

路径均相对 `frontend/src/features/canvas/`；行号是本轮读取时的定位提示，后续以函数名为准。

| 逻辑 | 本地落点 | 已有行为 / 差异 | 本轮决定 |
|---|---|---|---|
| 视口与业务图分离 | `Canvas.tsx` 的 `handleMove`（约2057）、`commitSettledViewport`（1961） | 普通 onMove 只读 zoom 更新 LOD，结束才提交去重后的视口；不是每帧重写 nodes | 保留，测实际调用链 |
| 手势生命周期 | `handleMoveStart`（1998）、`handleMoveEnd`（2012）、`canvasLod.ts` | 开始清 hover，手势首尾控制状态，结束80ms释放；升级队列在手势期间暂停 | 保留；参考的80ms/队列策略未知 |
| 低缩放挂载 | `Canvas.tsx` 的 `onlyRenderVisibleElements`（5037） | 本地低 LOD 保留128节点；参考14%仍按视野增减 | 是机制差异，未证明是红屏原因；首轮不改阈值或裁剪 |
| 图片选档 | `hooks/useNodeBodyVariantBudget.ts`、`canvasPreviewPolicy.ts` | 只订阅 zoom、尺寸和 DPR，档位有滞回；纯 xy 平移不触发换档 | 已实现；补副本实机计数 |
| 图片交接 | `hooks/useDecodedNodeImage.ts`、`ui/NodePreviewHandoff.tsx` | 同素材保留已加载图直到候选解码，素材/版本变化失效；节点级交接 | 已实现；补慢图、缩放往返和失败视觉验收 |
| 连线容器 | React Flow EdgeWrapper、`application/canvasEdgePaintProbe.ts` | 本地每边 SVG；参考一个 SVG。DEV 探针只合并静态绘制，保留原 React DOM | 首个独立绘制对照；未改正式结构 |
| 分组背景层 | `nodes/GroupNode.tsx` 约407–414、`canvasGroupPaintProbe.ts` | 本地内部底板，参考外层底板/低层级；此前对照无重复收益 | 保留条件门槛；不直接迁移背景/层级 |
| 手势中样式 | `frontend/src/index.css` 约862 | 本地手势期间移除 filter、阴影、backdrop，结束恢复；参考是否同样切换未知 | 在已有 stable-style 对照单独验证，不能混入连线实验 |
| 诊断界面 | `ui/CanvasPanDiagnostics.tsx`、`Canvas.tsx` 170/5081 | DEV + canvasPerf 时挂载页面 aside，部分模式会临时隐藏绘制 | 普通页与诊断页单独对照；不能视为 Chrome 扩展 |

当前本地执行逻辑可概括为：

```ts
onMoveStart():
  setGestureActive(true); // 仅边界切换，暂停重型升级
  clearHoverAndApplyPanClass();

onMove(viewport):
  applyLowDetailClass(viewport.zoom); // 纯 xy 平移不会改 LOD 档
  // React Flow 更新统一 viewport transform。
  // 不 setNodes，不触发图 store 的逐帧视口发布。

onMoveEnd(viewport):
  if anotherOwnerStillPanning(): return;
  settleLod(viewport.zoom);
  scheduleGestureRelease(80);
  commitViewportIfChanged(viewport);

onImageCandidateChange(candidate):
  if sameAssetAndOldImageReady():
    decodeCandidate();
    if candidateStillCurrentAndDecoded(): commitDescriptorAtomically();
  else:
    invalidateOldAsset();
```

因此后续工作是验证剩余差异，不是再重写一遍平移/预览算法。现有单测结果只能支撑这些局部契约，不能证明整页绘制稳定。

### 10.4 副本实验的执行顺序与判定

已存在独立画布副本，128节点/512边；定位与源快照在本机忽略目录的 manifest。只隔离画布数据还不够：新实验代码应通过副本专用开关或独立前端服务生效。原图继续只读。

```ts
baseline = snapshot(copy.nodes, copy.edges, copy.mediaIdentity, copy.camera);
ensureFrontWindowVisible();
ensureNoSelectionOrRunningGeneration();

// 0. 确认普通副本与诊断页的差异，不把操作拦截当绘制结论。
observePlainCopyWithoutCanvasPerf();
observeCopyWithCanvasPerfInNormalMode();

// 1. 每轮只改变连线绘制，组样式保持 Normal。
repeat 3 times:
  A1 = dragAndReturn(mode = normal);
  B  = dragAndReturn(mode = singleSvg);
  A2 = dragAndReturn(mode = normal);
  assertSameZoomGeometryMediaAndPath(A1, B, A2);
  verifyProbeRestored();
  if visibilityChanged || possibleThrottling || unsupportedPaint:
    markInvalid();
  else:
    recordVisualFailuresAndCostSeparately();

// 2. 若连线证据不足，恢复正常后逐项对照：
//    分组仅外层绘制；分组仅层级；手势样式固定。
// 每一项重复 A→B→A，禁止组合开关后宣称单一根因。
assertCopyGraphStillMatchesBaseline();
assertOriginalFileUnchangedByThisExperiment();
```

- 这里“3轮”是本项目诊断最低重复要求，不是 LibTV 的实现。A1/A2 均复现而 B 稳定，才算支持候选方向；B 自身出现异常则不能宣布修复。基线不复现、窗口受节流或动作被拦时，结论为未完成。
- 像素截图、真实手势、DOM几何/源统计、逻辑耗时分别记录。DOM不变可以排除采样中的卸载或换图，不能排除浏览器绘制问题；低 React 时间不能直接认定 GPU 故障。
- 本轮 LibTV 为14%，本地历史样本为22.389%，可比较行为结构，不能直接当等负载性能跑分。正式对照需同缩放、同窗口尺寸与相同轨迹，同时记录可见节点/边数量差异。
- 若某项满足重复证据，再写该项正式 hunks：连线需保留命中、选中、删除、重连、生成动画；分组需验证背景、标题、命中、缩放和分组调整。保持 geometry、parentId、引用及媒体身份不变，聚焦测试及副本实机均通过后才启用原图路径。

### 10.5 右上角面板与当前阻塞

用户所指 Canvas pan diagnostics 是本地代码中的页面 aside（absolute/right/top），不是 Chrome 扩展弹窗。其 pointerdown 只停止向画布冒泡；Normal 模式没有用于隐藏画布的额外诊断样式。试验模式确实可能影响绘制，不能笼统说它完全无影响。

本轮尝试把测试副本导航到不带 canvasPerf 的地址，但 Chrome 在执行阶段仍阻止操作；随后标签清单显示地址仍带 canvasPerf。因此**没有成功关闭面板，也没有完成关闭前后对照**。错误所称的扩展界面具体归属仍未确定，不能把它归咎于用户没有关闭。

同一轮 LibTV 标签可读取并完成上述真实往返拖动，说明限制至少在本次表现为页面操作有差异；不能据此猜测扩展内部原因。此前已在不带 canvasPerf 的普通页面复现整页红屏（台账2026-09-27），所以诊断面板不是红屏出现的必要条件；这一历史事实也不能替代今天关闭面板的实验。

当前结论：参考行为已更清楚，红屏根因仍未定位，副本实际 A/B 被拦，业务代码保持本轮开始时状态。下一步先取得无诊断面板副本的可操作页面状态，再按上面的单变量顺序推进。

## 11. 2026-09-28 按 §10 执行的首轮结果

### 11.1 普通副本实际操作已完成

开始时 Chrome 连接不在可用浏览器列表；用户打开后恢复。复用既有测试副本，成功导航到无 canvasPerf 地址，并实际读取到诊断面板不存在。副本挂载128节点、102张已加载图片；清除复制来的一个选中态，切换抓手工具。

从空白处水平右移320屏幕像素再返回，zoom始终0.223891；返回后相机与拖前DOM记录完全一致，128节点的inline style变化0，102张图片的currentSrc变化0。两个动作后的截图均正常。只观测到这些采样点，不能以此宣布持续拖动无红屏。

本机文件核对：原画布SHA-256仍与创建副本前快照一致；副本持久化nodes、edges、viewport与源快照逐项一致。没有改动原图或素材；清选择属于临时交互状态。

### 11.2 诊断页再次出现操作阻止

普通页往返之后，导航到同一副本并加回canvasPerf。该次导航已发生（标签清单确认地址变化），但导航后的读取返回Chrome有其他扩展界面阻止操作；一次后续只读检查仍被阻止。此轮与§10.5“导航未执行”的情况不同，不能混记。

目前只有时间关联：普通页可操作 → 打开诊断页 → 操作被阻止。尚不能区分诊断面板、导航过程、扩展自身状态或其它界面。已请用户只移除副本的canvasPerf参数并刷新做反向对照；没有要求再次关闭整个Chrome，没有切换控制通道绕过。单SVG对照没有开始，不能给出收益结论。

### 11.3 自动回归与代码决策

在frontend精确运行Vitest七个文件：canvas-edge-paint-probe、canvas-group-paint-probe、canvas-pan-diagnostics、canvas-minimap-pan-mount、canvas-preview-policy、canvas-preview-decode、canvas-preview-handoff；**7文件/53项通过**。仅有Node实验性localStorage提示。

本轮未改业务代码，未将DEV探针接入正式连线层，未改变分组背景/层级；按用户批准的顺序，正式修改需要副本单变量证据。构建未重跑。下一步是用户完成无面板反向对照后，确认能否读取同一副本，再恢复§10.4的三轮实验。若诊断页关联可重复确认，先修诊断入口的可操作性，不能让它污染渲染结论。

## 12. 2026-09-28 副本恢复操作后的连线实测

### 12.1 浏览器状态与播放回归

用户打开普通副本并手动关闭旧诊断标签后，在同一普通副本加回 canvasPerf，面板、截图与鼠标操作均成功。说明“面板存在就必然阻止操作”不成立；本次没有修改诊断代码或浏览器设置，也不能推断旧标签被阻止的内部原因。

普通副本从22.3891%放大到50%：21个挂载节点，15张图片均完成加载，初始video为0。点击一处播放后只有1个video，readyState=4，currentTime推进至28.47秒，duration=30.08秒，无媒体错误；暂停并缩回22.3891%后恢复128节点/102张已加载图片/video=0，相机回到起点。该结果覆盖播放和缩放恢复，尚未捕获慢图升级时的短暂覆盖层，不能代替慢图交接验收。

### 12.2 三轮固定轨迹 Normal → single-svg → Normal

条件：相同副本、128节点/512条边、22.3891%、抓手工具、无节点或边选择、无生成/播放、分组Normal；每段4秒，横向420屏幕像素正弦往返，结束恢复相机。结果来自DEV面板，RAF间隔是调度指标，不是逐帧像素无闪烁证明。

| 轮次 | 模式 | 4秒样本数 | P95（ms） | 最大间隔（ms） | React累计（ms） | 相机调用累计（ms） |
|---|---|---:|---:|---:|---:|---:|
| 1 | Normal前 | 240 | 16.8 | 33.4 | 20.5 | 328.6 |
| 1 | single-svg | 240 | 16.8 | 16.9 | 19.5 | 294.0 |
| 1 | Normal后 | 237 | 16.8 | 33.4 | 17.8 | 320.7 |
| 2 | Normal前 | 240 | 16.8 | 33.3 | 18.7 | 312.0 |
| 2 | single-svg | 240 | 16.8 | 16.8 | 19.0 | 295.0 |
| 2 | Normal后 | 239 | 16.8 | 33.3 | 16.7 | 305.9 |
| 3 | Normal前 | 241 | 16.8 | 16.8 | 18.8 | 304.0 |
| 3 | single-svg | 240 | 16.8 | 16.9 | 19.0 | 300.6 |
| 3 | Normal后 | 240 | 16.8 | 16.9 | 18.9 | 325.2 |

九次均保持visible、invalidReason=null、possibleThrottleFrames=0；节点几何变化、图片源变化、DOM新增/移除均为0。三次单SVG实际将512个绘制容器变成1个，准备耗时约24.7–25.5ms，原RF边DOM仍保留；edgeSvgs=512是原DOM数量，不能误报探针未生效。每次单SVG各记录到1个长动画帧，不能只比较主循环最大间隔而忽略准备/收尾成本。

实鼠标补充：Normal记录、single-svg记录、Normal记录各一次，P95均16.8ms、239/239/241样本，React累计0.9/2.5/1.4ms。第一段Normal只右移后由记录器自动恢复；后两段右移320再左移320，单SVG往返两端DOM确认探针都仍生效、相机返回起点。节点几何/图片源/DOM增删为0。动作后截图均正常，但不是连续逐帧录屏，因此不宣称所有中间帧无闪烁。

**本阶段决定**：单SVG没有取得明确且重复的性能收益，基线也未在本轮截图中复现红屏。保留为DEV对照，正式连线结构不晋级；不能因为参考站采用单SVG就将它认定为红屏修复。

### 12.3 分组补测、用户反馈与收尾

单独外移分组背景的固定轨迹为240样本/P95 16.8ms/最大16.9ms，恢复Normal为241样本/P95 16.8ms/最大16.8ms；两者几何、图源、DOM增删均为0，外移背景实际往返截图正常。只有一轮，未取得收益，不晋级。

随后尝试仅降低分组层级：界面值lower-layer、分组计算z-index=-1001可读，但没有得到对应模式的完整测量记录。同期相机出现计划轨迹之外的变化，用户随后说明自己也在拖动；这一段不纳入同条件性能比较，不推断为程序异常。固定样式对照及分组三轮未完成，不能用前两项正常截图补记通过。

用户明确反馈“刚刚自己拖动、看自动拖动都不卡、不闪烁”，记为当前交互体验的正面验收；不是旧红屏单一根因已确认。恢复Group paint=Normal（z-index=0）、确认单SVG探针不存在，删除canvasPerf后读取诊断面板不存在；普通页102张图片全部完成加载、video=0，实际拖动截图正常。后段双方都在操作，不再强行把副本相机覆盖回旧基线。正式原画布文件本轮保持只读。

本轮业务代码、正式连线与分组渲染均未修改；只更新本报告和协调台账。保留已经实现的平移状态、稳定图片描述、封面与解码交接优化。当前没有证据支持继续扩大绘制结构改动；慢图动态交接仍待独立验收。未新增或重跑业务测试/构建，本轮证据是浏览器实际操作与文件完整性复核。
## 13. 2026-09-28：66% 的独立卡顿定位与修复方案

本节针对用户确认低缩放不卡之后，新报告的 66% 顿挫。不能套用 §12 的低缩放结论。

### 13.1 实站对照

在同一 Chrome 连接、相同项目的参考页通过缩放菜单设为 66%，抓手向右移动 420 CSS px 再返回：

- LibTV 挂载节点 10→14→10；可见区变化确实会增减节点，不是整张画布永久冻结。
- 起始的 10 个节点在移动后仍保持原 inline geometry 和图片 currentSrc。视频播放器为 0。
- 常态视频节点约 34 个 DOM 后代，静态封面为 800×342；图片节点使用 srcset，当前解码约 551×236。
- 108 条已挂载连线共用 `.react-flow__edges` 下的一个 SVG。
- viewport 与 edges 的 computed `will-change` 都是 `auto`。**不能声称 LibTV 采用本次候选的合成提示**，也未拿到参考站内部 React/合成算法或同条件 FPS。

本地副本在用户当前 65.9754% 相机下有 15 个挂载节点、95 条连线及 95 个独立 SVG。视频完整节点约 40 个 DOM 后代、播放器为 0。节点数量、拍摄区域与参考页不同，因此这里只比较渲染结构和往返的稳定性，不比较两个页面的绝对速度。

### 13.2 本地单变量实验

沿用已有诊断的 4 秒、水平 420px 正弦轨迹，结束恢复相机。全部 visible、无节流警告、无运行视频、图片图源变化 0。

| 模式 / 顺序 | 帧数 | P95 ms | P99 ms | >33.4ms 帧数 | React ms |
|---|---:|---:|---:|---:|---:|
| Normal 1 | 160 | 50 | 50 | 33 | 39.4 |
| 仅 DOM transform | 162 | 50 | 50.1 | 29 | 0 |
| 隐藏连线 | 241 | 16.8 | 16.8 | 0 | 46.9 |
| 隐藏媒体 | 163 | 50 | 50 | 15 | 40.2 |
| viewport composite 1 | 236 | 16.8 | 16.8 | 1 | 41.3 |
| Normal 2 | 164 | 50 | 50.1 | 20 | 41.9 |
| viewport composite 2 | 236 | 16.8 | 33.3 | 2 | 43.8 |
| Normal 3 | 163 | 50 | 50.1 | 22 | 38.7 |
| viewport composite 3 | 235 | 16.8 | 33.4 | 2 | 46.3 |

这里 composite 仅为给 viewport 加 `will-change: transform`，没有隐藏连线或改变节点。普通/合成的可见性增减计数均为 48/48（这是子树 MutationRecord 的 added/removed 数，不是 48 个节点）。`changedNodeGeometry=2` 包含被裁剪卸载的 DOM，不能当成保存坐标修改。

结论：本次稳态瓶颈主要与连线绘制/合成路径有关。0 React commit 的纯 DOM 平移仍慢，反而保留组件更新并隐藏边即可恢复，排除了“React 重渲染是主要耗时”的初始假设。合成提示重复改善，但还有少量尾帧；没有 GPU trace，不能进一步断言驱动、显存、具体栅格算法的根因。

### 13.3 最小实现及晋级条件

1. `CanvasPanDiagnostics.tsx` 新增持久的 `Viewport cache` 选项：default 不覆盖、auto 显式撤销、transform 只覆盖非低细节档。记录结果包含选择值。它只存在 DEV/显式诊断页，不保存设置或图数据。
2. 在既有副本使用 transform 完成真实抓手往返、66→22→66、停止后选择/播放。CSS 与真实交互通过后才晋级正式规则。
3. `index.css` 只增加 `.dc-canvas:not(.dc-canvas--low-detail) .react-flow__viewport { will-change: transform; }`。保持高清档缓存稳定，避免随每次 pointerdown/up 分配和销毁。低缩放仍用原有轻量外壳，不给全量节点强制缓存。
4. 不修改 `onlyRenderVisibleElements`、节点坐标、图片源、分组尺寸/层级和边组件。单 SVG 仍为后续可独立研究的结构方向，不能因为本次证据就直接重写 RF 边渲染。
5. 回归：LOD/诊断/预览/平移聚焦测试、tsc、CE build、i18n 与 guard；实机关闭诊断后的同条件拖动、低缩放、缩放清晰度/播放、原文件摘要与副本几何/边。回退只移除新增规则。

风险：合成缓存有内存代价，故只对一个 viewport 提示、不为每个节点/边单独建层。出现红屏、层级错误、缩放模糊或性能回退时不得晋级。

### 13.4 本轮交付与剩余验证

只完成上述第 1 步 DEV 对照开关，未修改正式 index.css。热更新后 Chrome 对副本返回其他扩展 UI 阻止自动操作；已请求用户关闭，持续开关的实机验证暂停，不能用前三轮临时模式代替全部交互验收。参考页仍可操作，已恢复精确原相机（14%）与移动工具。

诊断/LOD/预览/平移相关 10 文件 117 项通过；另补小地图 1 文件 8 项通过，合计 11 文件 125 项（小地图初次从仓库根目录运行，夹具找不到 frontend 相对路径，改为 frontend 工作目录重跑通过）。tsc -b、CE build、i18n 与 diff/guard 通过，构建仍有既有大 chunk 警告。原画布摘要与本轮副本基线均完全一致，nodes/edges 无变化，没有提交/推送/重启。

恢复后直接在当前副本选 `Viewport cache → Retain high zoom transform`，先确认 computed will-change，再做真实拖动/跨档/播放；按 13.3 的条件决定是否启用正式 CSS。不要重建副本或重复猜测 LOD 阈值。

### 13.5 继续实測：密集区域推翻常驻缓存的晋级条件

本节覆盖并撤回13.3的候选正式规则：Chrome恢复后，用户当前副本约29%，通过界面设66%，挂载22节点/174条边。此前15节点/95条边的结果可重复，但不能推广到这个密集区域。

| 对照 | 66%密集区域结果 | 判断 |
|---|---|---|
| 整viewport常驻transform缓存 | 两次P95约166–183ms，最大250ms | 比基线更差，不晋级 |
| 隐藏边 | P95 16.8ms | 继续指向连线绘制路径 |
| 仅edges容器缓存 | P95 149.9ms，最大233.3ms | 不晋级 |
| 每个edge SVG缓存 | 三轮241帧/4秒，P95/P99 16.8ms，最大16.8–16.9ms，无>33.4ms | 调度改善，仍须视觉回归 |
| 撤销SVG缓存，Browser auto | 63帧/4秒，P50 66.7ms、P95 100ms、最大100.1ms，48帧>33.4ms | 同区域反向对照 |

两轮已保留的逐SVG结果React累计46.9/49.4ms，auto为33.1ms；节点子树增减均58/58。图源/几何变化计数4包含被裁剪卸载的DOM，不能当成四张存续图片换源或四个保存坐标改变。所有有效样本visible、无节流警告。缓存比较只在显式DEV页面，正式CSS无变化。

真实抓手补测明确读取到相机右移520px、再返回，记录240帧/P95 16.8ms/最大16.9ms、34次React提交/29.3ms。此前一条0 React/0 DOM的“手动拖动”样本因热更新将工具重置为移动，未实际平移，已排除，不能充作验收。

22%跨档样本128节点/512边/102张加载图片，CSS不适用于低细节档，computed will-change=auto；P95 16.8ms，无>33.4ms。返回66%后，视频播放推进到19.05秒、readyState=4、无媒体错误。

**视觉失败优先于帧率：** 逐SVG缓存下，实际拖动后的截图出现部分图片缺失；播放期间截图出现大片红色矩形、上部图片及诊断面板局部未正确绘制。已加载DOM和视频readyState不足以证明画面正常。立即暂停视频并切回Browser auto，下一张截图恢复完整图片、分组和面板。因此逐SVG常驻缓存也不能进入产品，不能把16.8ms写成“66%已修复”。这次现象只证明候选路径有视觉回归，尚无GPU trace确定具体浏览器/驱动原因。

### 13.6 单SVG高缩放对照的有限方案

低缩放单SVG探针会在RF边集合变化时中止，原有66%拒绝条件必须保留。新增DEV模式 `single-svg-dom-transform`，与已有 `dom-transform` 作成对比较：

```text
保留同一相机、未选中的静止节点与边、默认缓存、正常分组
baseline: 仅DOM平移viewport，RF相机不更新
candidate: 复制当前静止边到一个SVG，再作相同DOM平移
每帧: 边DOM/缩放/页面发生变化 => 中止
结束或失败: 移除快照、恢复原边、恢复相机与gesture
```

两者均暂时冻结可见集合，所以可以单独比较绘制容器；**不代表正式拖动、动态裁剪或交互方案**。不能把复制的静态DOM直接接入产品。若候选有重复收益，下一阶段需另做React共享SVG的具体设计，保留命中、选择、断连、层级、marker、裁剪与边更新，再验证真实抓手/播放。若无收益，停止结构替换。

新增66%可运行、仅最终一次RF相机恢复、原模式拒绝高缩放、边变化中止测试。诊断/边探针/分组探针3文件21项通过。热更新后Chrome再次报告其他扩展UI阻止副本操作，因此该新模式尚未取得浏览器实测结果；已请求关闭扩展界面，不改用其他控制通道。源画布和副本的文件摘要与本轮前快照完全相同，nodes/edges/viewport均未变。

## 14. 用户自主拖动的持续对照

用户指出自动4秒移动看不出手感，要求切换后自己拖拽。DEV面板新增 `Normal · manual` / `Single SVG · manual`，后者保持生效直到主动退出、离开抓手工具或发生不支持的边变化；没有倒计时，也不调用setViewport或恢复初始相机。旧轨迹测量收进 `Automatic measurements`，手动单SVG生效期间禁止叠加缓存/分组/自动轨迹。进入任一手动模式都清除缓存实验并恢复正常分组。

这次手动模式不冻结可见区。RF仍处理真实拖动、缩放和剔除；原边DOM增删/改路径时，在同一MutationObserver回调中重建显示快照，纯相机transform不重建。空区域移除快照并保留监听，返回后重新显示当前边。复制成本会影响真实手感，不能把它当作正式共享SVG实现的纯绘制收益。切回Normal/卸载立即恢复原边；切出抓手、选中节点/边、遇到不支持图形或源层被替换时停止并显示原因，避免保留失效连线。

代码验证：诊断与边探针2文件24项通过，包含10秒不自动退出/无相机写入、控件互斥、切换/卸载清理、动态路径/边集合、空区返回、工具/选择变化和失败恢复；tsc -b通过，i18n为0，diff/guard通过。没有改正式Canvas、边组件、分组样式或保存数据。

浏览器操作恢复。在已有副本23%点击Single SVG后，相机完全未变、原边隐藏且单一快照存在；等待及后续截图时模式仍生效。通过现有缩放菜单设66%后，原边和快照均190条（23%为512条），说明可见集合随RF正常更新；真实抓手向右400px再返回，两端模式持续、原边/快照数量一致、结束截图无缺图或额外红块。点击Normal恢复原边、快照数量0，66%相机保持。已留在Normal、66%、抓手工具，供用户按自己的路径来回比较。本轮只是功能回归，未重新量化FPS或证明全部中间帧无异常，正式结构仍不晋级。

## 15. 66% 复核与导入连线悬停缺失

用户实拖反馈：Normal 和 Single SVG 在 23% 均顺滑、66% 均卡。这是对手动对照的否定结果，不能据单 SVG 容器相似就晋级；该探针还包含复制开销，不等同参考站原生共享 SVG 的完整实现。

### 15.1 本轮参考站实际操作

通过 Chrome 在同一参考项目设为 66%，抓手横移 420 CSS px，再反向返回。挂载节点 10→14→10，边 108→153→108，边容器始终只有一个 SVG，video DOM 为 0。存续的 10 个节点 inline style 和图片 currentSrc 全部未变；截图中的分组底色和图片在往返端点完整。这里只证明可见集合正常变化、存续内容稳定，不声称已记录全部中间帧或参考站绝对 FPS。操作结束恢复原 14% 相机及移动工具。

在移动工具中，点击连线后按 Escape 清除 selected、鼠标仍留在线上，读取到未选中边 stroke-width=4（静止为 2）、stroke=var(--canvas-edge-hover)。其 edge-flow-segments 组为 3s linear infinite CSS 动画，内部 8 条同几何路径，pathLength=300，通过 dasharray/opacity 分段形成流光；无高斯模糊滤镜。切为抓手后，边和命中路径 pointer-events 均为 none，流光消失。所以取消本地抓手命中保护不是修复方向。

### 15.2 本地根因与最小改动

当前副本 512 条保存边全部显式 type=default。导入器保持该值；之前 edges/index.ts 仅注册 disconnectableEdge，Canvas 的 defaultEdgeOptions 只影响未指定类型的边。浏览器实际 DOM 为 RF 原生 default 的两条路径，绕过旧 DisconnectableEdge 的 hover/data flow。这解释了普通移动工具下也没有效果；旧组件的流光代码仍在，不能说被本轮性能优化删掉。

新增 DefaultCanvasEdge 并注册 default 显示组件：保留 RF getBezierPath、BaseEdge、导入常态样式、marker、label 和命中宽度，选择/双击仍由外层 RF 管理。hover/selected 才追加 4px 蓝色主线和无滤镜的 3 秒分段流光，普通边没有动画子树。颜色沿用项目 accent token；常态保留导入的 1.5px，不宣称与参考站 2px 完全一致。抓手切换清除 hover，平移/抓手/reduced-motion CSS 关闭流光；不新增常驻合成提示。旧 disconnectableEdge、画布数据与布局代码保持原实现。单 SVG DEV 探针对该活动流光明确拒绝复制，避免把动画冻结成静态错误画面。

验证：三个聚焦测试文件合计 32 项通过，tsc -b、前端 i18n、git diff --check、agent_guard check 通过。首轮标签测试因 jsdom 不提供 SVG getBBox 失败，补标签测量桩后重跑通过，业务组件无该错误。

本地浏览器已确认 432 条当时挂载的 default 边加载新组件；随后普通测试窗口显示 revision 保存冲突遮罩（提示另一窗口已更新同一副本）。未点击会清除草稿的刷新，也未保存覆盖；该窗口仍是原 92% 相机。真实本地 66% hover/离开/抓手切换尚未验收，代码测试不能代替此项。后续应先由用户处理该副本草稿冲突，再在普通 Normal + 移动工具验证高亮。66% 性能仍未解决，下一性能实验须另有单变量方案与量化证据。

## 16. 66% 绘制差异进一步收敛（本轮只读分析）

### 已排除的方向

已安装的 RF 12.10.2 / system 0.0.76，useVisibleEdgeIds→isEdgeVisible 使用两端节点外包矩形与视口求交，没有计算曲线本身。最初怀疑它比参考站保留更多屏外边；同相机核对推翻了这个解释：

- LibTV 66%、2560×1305.33 视口实际108边；将本地副本几何代入相同相机/视口，RF矩形算法也是108边。
- 参考DOM的108条cubic按1024段采样、14px屏幕余量，55条曲线进入视口，53条没有；本地512段离线近似也为55/53。采样不是严格几何证明，只用于诊断，不可照抄为生产剔除算法。
- 两条抽样边的本地世界坐标与参考路径端点一致到亚像素。此前不同区域的174/108、432/108不能拿来断言本地多画了同一区域的边。

因此更精确的曲线剔除可以另作优化，但它不是目前观察到的 LibTV 差异，不作为首要修复。

### 剩余可测的真实差异

| 项目 | 参考页 DOM | 本地实现 |
|---|---|---|
| 连线画笔 | rgb(134,144,156)，opacity/stroke-opacity均1，线宽2 | 导入style为text-muted/0.55，线宽1.5 |
| 绘制容器 | 同一个SVG中的data-shared-edge-id分组 | RF每条边一个SVG |
| 命中路径 | 透明stroke，宽20 | BaseEdge零stroke-opacity，宽20 |
| 共享SVG实验 | 未知内部代码；不能仅凭DOM断言其调度 | 源组件仍活着，源边变动触发computedStyle读取和整层复制 |
| 合成提示/滤镜 | 已查祖先will-change auto、filter none | 已失败缓存方案未晋级 |

这组差异还不是因果证明。特别是 Single SVG 手动模式保留全部路径、在原组件更新外增加重建开销；它的失败不能证明所有直接共享SVG实现无效，也不能用“实验不等价”为由直接上线重写。

### 下一阶段具体顺序

1. **补可归因的对照**：同一66%相机和同一边集合，固定线宽1.5，只改变画笔alpha=0.55/1；沿用dom-transform轨迹，源/目标都不发生RF几何更新，至少三轮，独立记录P95和长帧。随后恢复alpha，单测线宽，不能同时把多个变量称为一个结果。画笔匹配只存在DEV对照，不先改变正式视觉。
2. **剔除探针本身成本**：在canvasEdgePaintProbe中记录复制次数、累计复制耗时、样式读取次数；与一次准备后固定集合的single-svg-dom-transform比较。已有后者尚缺本轮实测，不再用手动复制模式替代。每帧不读取computedStyle、不复制DOM。
3. **满足证据条件才开发直接共享层**：候选SharedCanvasEdgeLayer使用React的key=edge.id保留组身份，直接接入已解析的端点/路径/画笔；几何缓存按端点、handle与路径参数失效。相机平移沿用父viewport transform，只有边/端点变化才更新该路径，可见集合变化只增删对应id。悬停/选中只激活该边的flow；命中、键盘选择、双击、marker、标签、层级、特殊边fallback均需明确保留，不用DOM搬运冒充React集成。正式接点涉及Canvas.tsx/edges注册；须先另补scope/preflight及共享协调。
4. **验收门**：同一密集区域三次真实拖动与基线相比有稳定改善，目标P95接近16.7ms并记录>33ms长帧；再验收快速反向、23↔66缩放、跨可见区、组底色、图片完整性、hover与播放。任何红屏/缺图均否决，即使帧率提高也不晋级。
5. **终止条件**：画笔与直接共享绘制均无收益，就停止这一架构假设，下一步取得浏览器绘制/栅格记录再决定有限视口的连线图像缓存；不继续换will-change位置或调LOD阈值。图像缓存属于备选方案，不能说是已观测到的LibTV实现。

本轮没有改业务代码，也没有重跑功能测试。参考页已恢复原14%相机。以上是根据新对照收敛的实施方案，尚不能宣称66%修复。


## 17. 用户指定的不透明画笔与流星反馈（2026-09-28）

本轮是明确的视觉需求，未作为 66% 卡顿改善证据。LibTV 页面当前 computed custom properties：`--canvas-edge=#86909c`、`--canvas-edge-hover=#c0c8d0`；流光 `rgb(100,180,255)`。共用 CanvasEdgeFlow 给 default / disconnectableEdge 按需绘制八层 dash 拖尾，pathLength 300，3 秒 offset 0→-100，无 filter/animateMotion；主线 normal 2px/opacity1/strokeOpacity1，active 4px。覆盖导入旧 style 的画笔只发生在显示层，不改边数据。native 的断开延迟、接点、生成中提示保留；普通绑定边也采用用户指定统一颜色。

Chrome 新建独立四节点、两类边的小副本，复制源响应前后摘要一致；本机 manifest 放在忽略目录 checks/edge-meteor。它只验证呈现和交互，不用于大画布性能结论。原测试副本未清草稿、原业务画布未操作。

实测66%：
- 两条 idle 主线均 computed `rgb(134,144,156)`、2px、opacity1/strokeOpacity1。
- default 实际命中后 selected=false，主线 `rgb(192,200,208)`、4px；流光8条，蓝色，duration3s。父组/子path offset 连续两次 -67.7667→-51.0933，截图可见亮头及拖尾，证实动画实际执行和属性继承。
- native 实际命中后主线同色4px，显示延迟断开按钮；父组/子path offset -38.87→-26.64，沿线运动可见，旧白色模糊效果已替换。此次点击也选中了边；纯 hover/leave 的分支由组件测试覆盖。
- 从 default 移至 native 后，default 流光卸载并恢复2px/灰色。最后空白处单击，两边无选择、无流光。
- 抓手H后flow数量0、hit pointer-events=none；真实往返180px/30px，仍两条边/0流光，恢复移动V和原66%相机。未改变节点坐标或引用。

验证：四个聚焦文件37项通过，tsc/i18n/diff检查通过。DESIGN lint 因本地缺少包、联网运行被自动审批以外部下载执行风险拒绝，未运行，未绕过。Chrome日志含 React Query 取消订阅 AbortError，记录为既有加载链异常，未扩展修复或宣称全页无错误。动态大画布66%验收仍待后续性能方案。

### 17.1 用户后续参数覆盖

用户随后指定active线宽2.5px、循环0.6秒，两个边组件及公共动画已同步；拖尾实线核心也收窄为2.5px，柔光保持原比例。以上§17的4px/3秒为历史参考及实测，不再代表本地当前配置。此次两份组件12项回归通过，未重新进行浏览器周期测量。

### 17.2 用户对大画布的复测

用户在不透明2px常态线版本下反馈：此前66%拖动的卡顿已经不再出现。该结果是用户的实际手感验收，尚无改变透明度前后的同场景独立性能计时；因此先停止以卡顿仍存在为前提的共享SVG实验，保留§16作为未来复现时的诊断路径。

### 17.3 用户最终指定的连线参数

在保持不透明和原配色的前提下，常态线宽改1.5px、悬停/选中2px，蓝色流星0.8秒循环；两类边共用宽度常量，拖尾实线核心也是2px。§17.2的顺畅反馈来自之前的2px常态版本，不能直接当作1.5px版的独立性能测试。两类边现有12项回归和类型检查通过，最新视觉手感等待用户使用反馈。

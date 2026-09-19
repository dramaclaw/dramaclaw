# LibTV 画布对齐：片段重拍 / 智能续写 / 导入器 / 工具条

**状态**：待验收
**最后更新**：2026-09-18
**基线**：`09e2703a`；四个可评审提交均已完成；已完成与 `origin/feat/canvas-video-reshoot-breakdown` 的行为审计
**相关文档**：`docs/guides/liblib-canvas-parity.md`（取证方法、能力全集对照、LibTV 侧实现细节）
**相关分支 / PR**：`main`；`28936905`、`8bc8d598`、`4959b1d9`、`09e2703a`

## 目标

把画布的视频再创作能力对齐 LibTV 线上版本：片段重拍、智能续写两个入口可用，
LibTV 画布导入不再丢节点语义，视频节点工具条按实测规格对齐。

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

- `origin/feat/canvas-video-reshoot-breakdown` 已有重拍、续写、breakdown、depth capture、工具条与大量生命周期测试，
  至少 24 个文件和当前本地脏文件重叠。该分支的 UI 选择（例如合并下拉）还与本线实测后决定的“重拍平铺”不同，
  属于需要明确取舍的产品冲突，不是机械合并。
- 当前分支从更旧基线展开；三语翻译、`freezone.py`、`tasks.py`、`routeTree.gen.ts` 等同时受
  `origin/main` 影响。不能以当前整文件作为最终提交内容。
- 与 LOD 共享 `Canvas.tsx`、`index.css`、`LodShellNode.tsx`、`AssetCommitHandle.tsx` 等。
  顺序应为：先完成 LOD 4 文件来源审计，再由本线集成者处理工具条 / 节点行为。

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

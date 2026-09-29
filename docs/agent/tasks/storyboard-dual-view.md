# 工作流与故事板双模式

**状态**：待验收
**最后更新**：2026-09-26
**基线**：`762591d0e2511dd16765b878a0f21df67c7013c0`；`codex/sync-main-remotes`
**认领者**：`codex/storyboard-dual-view`
**相关文档**：无（本机调研方案已由用户确认）
**相关分支 / PR**：无

## 目标
实现 Liblib 风格的故事板三栏、详情、共享生成编辑、引用、排序分类和持久化，实际浏览器对照验收。
## 非目标
不修改工作流自动布局，不更换生成模型或提交本机工作流 JSON。
## 现状与证据
基线工作区仅剩本地 Krea 工作流 JSON。Chrome 实站已确认三栏、详情、引用和分类。现有 nodes/edges/metadata 支持复用。当前本地 origin/main 对目标三主文件没有差异；本地及远端引用没有故事板命名分支。未刷新远端引用，本轮不合并远端代码。
## 写入边界
- `frontend/src/features/freezone/FreezoneShell.tsx`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/src/features/freezone/useCanvasSync.ts`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/src/features/canvas/Canvas.tsx`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/src/features/canvas/ui/OperationPanelShell.tsx`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/src/features/canvas/nodes/TextAnnotationNode.tsx`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/public/locales/zh/translation.json`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/public/locales/en/translation.json`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/public/locales/vi/translation.json`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/src/features/storyboard/**`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/src/__tests__/storyboard.test.ts`：共享（已有认领时）或独占（新模块）；详见 scope。
- `frontend/src/features/canvas/ui/NodeGenerationHistory.tsx`：独占，复用历史恢复回调。
- `frontend/src/__tests__/storyboard-ui.test.tsx`、`frontend/src/__tests__/storyboard-sync.test.tsx`：独占，交互与持久化测试。
## 协调与冲突

- 2026-09-27：`project-chinese-names` 在已提交基线上串行调整新建名称校验 / `project.name*` 三语文案；不更改本线交互与数据，由该线会话集成，双方不同时写入。

- 2026-09-26 分支集成：本线已有提交在前，`sync-main-remotes` 持唯一锁串行合入 main 的 TV Director。
  三语只保留并合入各线键值；DESIGN按画布和Director各自章节并存。相关claim已互认共享，
  最终冲突集成归同步线，原功能所有权、验收欠项和待办不变；不改技能或收费生成逻辑。
已在现有 scope 双向声明共享。其他工作线先完成，本线随后串行集成；当前会话为最终集成者。既有未提交 JSON 保留，不修改。新模块独占。
## 实施方案
1. 纯投影与按画布分离的显示状态、排序分类元数据；接入所有保存/恢复路径。
2. 工作流保持挂载，新增故事板三栏、全文/媒体详情、引用/分类/排序/列宽/筛选。
3. 将现有已选节点的操作面板通过 portal 移至故事板宿主，继续使用唯一生成控制器，避免挂载重复 Node。
4. 禁止隐藏画布快捷键、保持选中节点渲染，暂停隐藏媒体；添加聚焦测试并真实 Chrome 对比。
## 风险与回退
隐藏画布仍承担任务轮询；需保护 LOD、选择和副作用。保存仅新增 metadata.storyboardView，兼容无字段旧画布。回退仅撤销本线精确文件补丁，不触碰已有节点和本机配置。
## 验收标准
- [x] 纯投影、排序及 metadata 恢复的 Vitest 聚焦测试通过。
- [x] 前端构建通过，三语文案完整。
- [ ] Chrome 本地与 Liblib 总览、详情、引用和模型选择对照。
- [ ] 往返切换、排序保存后节点坐标/分组/连线保持不变，编辑共用原节点。
## 进展记录
### 2026-09-26 · 实现已落地，浏览器对照待解锁
- 新增三栏故事板、全文/媒体详情、Markdown 编辑、参考增删/拖入、分类、排序、筛选、列宽/单列、定位、音频和最新结果预览。模式/列宽/滚动位置按画布记忆，业务排序分类落入 `metadata.storyboardView`。
- 原 Canvas 持续挂载；只将原操作面板和历史条 portal 到详情，保留模型/生成/历史恢复回调。隐藏期间屏蔽快捷键及测量写回；参数面板的参考拾取转为故事板选单，聚焦请求转为详情选择。
- 修复保存中卸载故事板、跨路由模式残留、参考拖放 effectAllowed、文本参考候选为空、参考循环、保存/冲突遮罩层级。没有更改工作流 JSON，没有提交生成或 Git commit。
- 验证：直接 Node 执行 Vitest（避免 `pnpm test -- ...` 将过滤符传错）；最终 345 项相关测试全部通过，含本线 17 项投影/React 交互/metadata-only 保存/portal 回调测试。`tsc -b` 与 `vite build --mode ce` 通过（既有大包 warning），`git diff --check`、guard check 通过。
- 全量测试一次运行 3266 项，3255 通过、11 失败；失败在 local-storage-quota（5）、script-node-credit-contract（1）、video-model-capabilities（1）、video-node-credit-contract（3）、ingest（1）。这些测试对应的业务源文件未被本线修改；不扩大范围修复存量问题。
- 本机目标画布快照前后均 63 节点，position/parentId/width/height 与 edges 相同。revision 90→94、viewport 有变化，期间存在页面 HMR/用户活动，尚未在浏览器完成受控往返验证，不能声称真实视口验收通过。未回写快照覆盖用户数据。
- 自动化浏览器仍被 Chrome 打开的其他扩展界面阻止点击/导航；可读取截图。已向用户发出一次异步问题，请关闭扩展弹窗/侧栏。没有绕过浏览器限制。实机样式、真实模型弹窗和跨模式任务仍待验收，不能声称已与 Liblib 完全一致。
- 本机日志/报告（ignored）：`.dramaclaw-local/references/storyboard-tests.json`、`storyboard-full-tests.json`、`storyboard-before.json`；`.dramaclaw-local/logs/storyboard-build.log`。服务5173/8781已重新启动，ComfyUI8188与H3 7860复用。

### 2026-09-26 · 开始实现
用户已明确批准方案并要求验证。完成只读状态恢复和共享范围登记；代码未修改，guard check 初始通过。下一步 acquire 和 preflight 后实现。
## 已定下来的决策
- 单份 nodes/edges，排序独立 metadata；纯视图切换不写坐标。
- 复用原选中节点参数面板，以 portal 移动显示位置，保留唯一任务副作用。
## 待办
- [ ] 用户关闭 Chrome 扩展界面后，打开本地目标画布与 Liblib 的故事板，截图对比三栏、文本/图/视频详情、菜单及参数面板；修正发现的尺寸和交互差异。
- [ ] 在可丢弃测试画布进行排序/分类刷新、引用增删、模型选择及 20 次切换；比较 position/parentId/尺寸/edges/viewport；保留原用户画布。
- [ ] 验证跨模式运行任务只一份、最新产物更新，以及生成时历史选择的表现。未提交实际生成任务。
## 阻塞
Chrome 提示其他扩展 UI 打开，禁止自动点击/导航；用户尚未回复关闭。代码与离线验证可完成，真实 UI 一致性无法验收。
## 交接摘要
- 最后完成到：功能实现、345 项相关测试、CE 构建。当前状态待验收，不归档。
- 下一步唯一动作：收到用户“已关闭”后恢复 Chrome2 的本地/Liblib 标签页控制，先截图本地总览并比较线上故事板；如要修代码，先将状态转执行中、acquire/preflight。
- 先读这些文件：本台账、StoryboardView、storyboardStore、useCanvasSync、OperationPanelShell、NodeGenerationHistory。
- 不要动这些文件 / 决策：Krea 工作流 JSON、工作流自动布局。

### 2026-09-26 · 集成补充
已实现三栏、纯投影、metadata 保存和参数 portal。补充精确边界 `frontend/src/features/canvas/ui/NodeGenerationHistory.tsx`，将原历史条 portal 到详情，保留原恢复回调，避免重复生成控制器。保护保存期间挂载、隐藏测量和引用拾取。Chrome 当前被其他扩展界面阻止，已请用户关闭；继续本地静态验收。
新增专项验收文件 `frontend/src/__tests__/storyboard-ui.test.tsx` 和 `frontend/src/__tests__/storyboard-sync.test.tsx`：验证真实 React 交互与 metadata 单独修改保存。已有 337 项相关测试通过；初次广泛运行暴露旧测试 mock 不兼容新 hook，现将 ReactFlow 节点上下文依赖隔离到故事板分支，已恢复通过。CE 构建通过。

### 2026-09-26 · 用户关闭扩展后的恢复尝试
用户已回复“已关闭”。恢复同一 Chrome2 与现有标签页后，导航、AX 和截图仍返回其他扩展界面占用的拦截。标签页清单确认本地目标和 Liblib 目标仍在，非标签页失效；已查阅浏览器官方恢复说明，没有改用旁路控制。此次没有修改业务代码或画布数据。仍需用户关闭所有 Chrome 窗口的扩展侧栏/弹窗及开发者工具，必要时重启 Chrome 后继续。

### 2026-09-26 · Chrome 重开及连接重置仍被拦截
用户回复“已重开”。Chrome 扩展连接实例已变化，旧标签页不存在；通过标准 API 新建本地目标标签页（2061500354），页面 URL/标题可读取，但初始 AX 被扩展占用提示阻止。重置 cua_repl 后以新连接接入该标签页仍同样被拒绝，因此不再建议重复重启。具体冲突扩展未能确认，已询问用户是否允许改用已连接的 Edge 继续验收（此前用户明确指定 Chrome，未擅自切换）。本轮无业务代码/画布数据修改。

### 2026-09-26 · 时间分镜拆分协调

本线先完成，video-prompt-split 后串行集成，保留原功能；当前会话集成共享路径：frontend/public/locales/zh/translation.json, frontend/public/locales/en/translation.json, frontend/public/locales/vi/translation.json。


### 2026-09-26 · H3 提示词优化协调
原工作先完成，h3-prompt-optimizer 在共享路径串行增加可选优化参数/入口/翻译，由当前会话集成，保留原行为。


### 2026-09-27 · 多供应商模型接入协调
用户已授权多供应商选择，替代原本固定硅基流动的限制。已有实现先完成，本线由 multi-provider-models 串行扩展模型目录、调用路由与选择器；最终集成为当前会话，保留既有数据和工作流。共享路径：frontend/src/features/canvas/nodes/TextAnnotationNode.tsx, frontend/public/locales/zh/translation.json, frontend/public/locales/en/translation.json, frontend/public/locales/vi/translation.json。

### 2026-09-27 · 同名分支拉取推送协调
既有实现已提交；sync-main-remotes 串行合并远端 Director 与本地模型/H3 的三语键，保留双方值，由当前同步线最终集成。


### 2026-09-27 · LibTV 分阶段导入协调
现有实现先完成，liblib-import-recovery 后串行增加节点先保存、素材进入画布后分批后台下载及结构化 404 兼容。仅合并精确差异，保留其他功能，由本线会话最终集成。

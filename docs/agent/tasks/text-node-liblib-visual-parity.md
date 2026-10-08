# 文本节点 LibLib 展示对齐

**状态**：待验收
**最后更新**：2026-09-26
**基线**：`8e024ac`；`codex/sync-main-remotes`；目标代码文件无本地 diff
**认领者**：`codex/text-node-liblib-visual-20260926`
**相关文档**：`DESIGN.md`
**相关分支 / PR**：无

## 目标

选中导入的文本节点后，下方悬浮编辑区呈现与 LibLib 参考图相同的结构和比例：文本及图片引用缩略图、独立编号、指令正文和底栏；面板高度接近上方正文卡片，宽度约为卡片 1.5 倍。当前画布连线变化立即更新引用显示，正文和指令内容保持原样。新增模型选择：从本机硅基流动可用的 DeepSeek 文本模型中选择，实际生成、任务历史和节点底栏使用同一模型；旧节点不选择时仍走原有默认模型。

本轮扩展：把实时入边上的文本、图片、视频都送入文本生成。视频在本机抽取有限代表帧，以图像附件交给视觉模型；文本附在指令上下文。目录包含 DeepSeek 与可用 GLM/Qwen 视觉模型，图片或视频引用存在时只能选择视觉模型，缺少兼容模型要明确失败，不能静默丢弃素材。

## 非目标

- 不移动节点、修改节点宽高或分组、改动自动布局及已有画布数据。
- 不移动画布节点或改动本机画布 JSON；不发送视频音轨或整段视频字节。

## 现状与证据

- 2026-09-26 模型选择样式：用户要求触发器和弹窗对齐 Liblib。读取线上 `3zez5ighjd7k4.js` 模型选择组件及 CSS：触发器高 32px、13px 名称、16px 图标与旋转箭头；底部左对齐 Portal 浮层，内容宽 360px、最大高 400px、16px 圆角、4px 内边距；行高 52px、34px 图标容器、14px 名称与 12px 次级说明，选中背景白色 15%，悬停 10%。浏览器连接不可用，依据线上资源与用户截图实现。

- 2026-09-26 选不到模型回归：目标项目 `/freezone/text/models` 实际返回 200，`data.models` 含 18 个 DeepSeek/GLM/Qwen 型号；本地网关也返回 200。`apiCall` 已解开 `{ok,data}`，但 `fetchFreezoneTextModels` 又取一次 `.data`，结果为 `undefined`，组件 catch 清空所有选项。修正这个客户端契约即可，不改后端和画布数据。

- 2026-09-26 新增取证：当前文本生成 POST 仅含 prompt/model/context，`useUpstreamContents` 已能读取实时入边上的 text/imageUrl/videoUrl。PydanticAI 的 OpenAI chat 映射支持图片 BinaryContent，不支持 VideoUrl；复用 `jobs._sample_evenly` 抽帧及 `vision_gateway.load_compact_vision_inputs` 压缩后可经现有受控模型通道送视觉素材。
- 当前硅基流动目录含 `zai-org/GLM-4.5V` 与 Qwen3-VL 系列；供应商能力表列 GLM 视觉为图片、Qwen3-VL 为图片和视频。本轮抽帧后两者均接收图像序列，模型目录失败不应让媒体被 DeepSeek 吞掉。

- 目标画布文本节点 `t-R7yBr2zjtx` 保存了 1 个上游文本和 2 个图片引用，三条边均存在；`content` 1728 字，`instruction` 96 字。
- `TextAnnotationNode.tsx` 的 WritingOpsPanel 固定高 140，仅渲染 textarea 和按钮，完全没有引用栏；上方正文与下方指令数据本来就分开。
- LibLib 参考图的下方面板大致与正文卡片等高、约 1.5 倍宽，顶部为 1 个文本 tile 和 2 个图片 tile。固定尺寸引用 tile 不会影响节点本体测量。
- 目标文件 `git diff` 为空；`origin/main` 未显示目标路径独有变更，其他 claims 无该文件。工作区其他脏文件归他线，不触碰。
- 本机 local_gateway 的默认文本模型是 `deepseek-ai/DeepSeek-V4-Flash`，`/v1/models` 实际列出 V4 Flash、V4 Pro、V3.2 等 DeepSeek 型号；当前 `/v1/chat/completions` 强制把模型改为默认值。前端文本提交、API schema、异步 runner 都没有模型字段；`data.model` 可能是导入的图片模型，必须另存 `textModel`。
- 新增 API/模型选择是已存在的 Freezone 文本生成契约扩展，旧请求字段仍可省略；外部接口、共享热点先串行改。`origin/main` 在 `api/ops.ts`、`freezone.py`、`schemas.py` 有其他功能改动，未见同类文本模型选择实现，本轮只改文本生成段。

## 写入边界

| 路径 | 模式 | 作用 |
|---|---|---|
| `frontend/src/features/canvas/nodes/TextAnnotationNode.tsx` | 独占 | 引用栏、可用模型与有序素材提交 |
| `frontend/src/features/canvas/nodes/shared/TextModelPicker.tsx` | 独占 | 文本模型按钮与 Liblib 比例的独立浮层 |
| `frontend/src/api/ops.ts` | 共享 | 文本与视觉模型目录、引用参数客户端 |
| `src/novelvideo/api/schemas.py` | 共享 | 有界引用请求字段 |
| `src/novelvideo/api/routes/freezone.py` | 共享 | 模型目录、媒体范围验证及两种任务入队 |
| `src/novelvideo/task_backend/runners/freezone.py` | 共享 | 后台任务透传模型及素材 |
| `src/novelvideo/freezone/text_node.py` | 独占 | 按顺序拼文本/图片/视频抽帧并选兼容 agent |
| `src/novelvideo/local_gateway.py` | 与 local-stack 共享 | 已认证 DeepSeek/GLM/Qwen 请求按显式模型转发 |
| `state/local/test/freezone/canvases/liblib_72c039ea0dd1485493c4c54e3590bab7.json` | 独占，本机忽略文件 | 视觉检查后恢复检查前的 viewport 和自动改写的两张图片尺寸、选中态 |
| `docs/agent/STATE.md` | 协调 | 登记工作线 |
| `docs/agent/tasks/text-node-liblib-visual-parity.md` | 协调 | 本台账 |
| `docs/agent/claims/text-node-liblib-visual-parity.toml` | 协调 | 机器认领 |

## 协调与冲突
- 2026-09-27：中文项目命名线串行补充 LibTV 原名称保存 / 来源入口 / 预读名称与回归；既有导入合并和首次重试语义保留，由 project-chinese-names 集成。

- 相关工作线：`liblib-canvas-parity`；该线当前未认领目标组件，本轮只改节点展示。
- 本地已有改动：目标组件无旧 diff；保留其他全部脏文件。
- 远端重复实现：当前可见远端引用无目标路径差异；原有图内容解析 hook 已可复用。
- 共享文件：仅 STATE；不修改已有任务行。
- 模型选择阶段的共享文件：Freezone API/runner 与既有音频、拉片、H3 线共享，文本生成段由本线串行集成；local_gateway 与 local-stack 共享，仅改 chat/completions 的 DeepSeek 显式选择，local-stack 的图像/嵌入/音频路径保持原样。最终集成者为本线；相应 claim 已互相登记。

## 实施方案

1. 从实时上游节点收集引用，文本在前、图片在后；绘制固定大小缩略图和按类型独立编号，支持选中来源与断开连线。
2. WritingOpsPanel 高度按正文卡片、宽度按约 1.5 倍计算；调整引用行、textarea、底栏的空间分配，不改节点自身尺寸。
3. 底栏显示真实本地文本生成模型标识，保留现有翻译/提交行为；不显示导入时的图片模型为文本模型。
4. 视觉检查导致浏览器自动保存视口、两张图片自然尺寸和选中态后，只恢复这些字段到检查前 rev47 值；节点内容和连线与 rev47 对照，不覆盖其他差异。
5. 从当前有效 NewAPI 网关的模型目录读取 DeepSeek 文本及 GLM/Qwen 视觉模型；目录失败时仅保留默认文本选项。前端选择保存到 `textModel`，不能覆盖历史图片 `model`。
6. 请求字段从前端到 API/后台任务/CE 本地任务透传，纯文本空值继续走现有默认 agent；显式兼容模型按请求转发。
7. 实时入边组装有序引用；图片 data URL 先上传；API 限量并验证同项目本地媒体；执行时按顺序拼文本/图片，视频最多抽 6 帧并压缩后作为带时间顺序的图像附件。含视觉素材时自动选可用视觉模型，明确选择不兼容型号则提示错误。
8. 修复目录客户端只解信封一次；核对目录实际响应和节点下拉框使用的结构一致，仅改 `frontend/src/api/ops.ts`。模型目录暂不可用时仍禁用含视觉素材的提交，不默默转纯文本。
9. 用已安装 Radix DropdownMenu 构造独立文本模型选择器：按线上尺寸还原按钮/列表，模型 ID 显示为短名，列表保留可用型号和默认模型语义；Portal 脱离画布缩放、靠近视窗边界自动翻转，支持方向键/Enter/Escape/点击外部关闭。模型目录及兼容规则沿用父组件，不改共享视频/图片选择器，不改画布存储。

## 风险与回退

- 面板变宽可能覆盖相邻节点；仅选中时显示，维持悬浮定位和独立 z-index，不参与布局。
- 回退只需撤销本工作线目标组件的 diff；不触碰本机画布 rev47。
- 本机画布存储接口会为检查现场恢复保留上一修订快照；恢复前核对节点差异仅限两张图片自然尺寸和选中态。
- 显式模型若供应商未开放会返回供应商错误，不能静默退回默认模型；目录随供应商更新。视频抽帧只涵盖视觉画面，不含音轨；大素材在本地压缩并限制数量。

## 验收标准

- [x] 原生 select 替换为独立文本模型按钮/Portal 菜单：32px 按钮、360px 内容宽、400px 滚动区、52px 行、34px 图标区，默认和显式型号语义保留；前端构建通过。
- [ ] 浏览器中核对下拉展开后的最终视觉效果；当前浏览器连接不可用，已依据 Liblib 线上 JS/CSS 与用户截图对齐。

- [x] 文本节点模型目录客户端只解一次 API 信封；目标项目响应的 18 个型号可进入组件选项。`pnpm build` 与 guard 通过。

- [x] 生成请求携带当前入边顺序的文本、图片、视频引用，任务执行时送文本及压缩视觉帧；媒体 URL 限同项目本地文件。
- [x] 硅基流动实时目录列出 GLM-4.5V 与 Qwen3-VL；引用图片自动选 GLM，引用视频自动选 Qwen3-VL，纯文本保留 DeepSeek。API 和执行层拒绝不兼容型号。
- [x] 本机栈以 10808 代理和已安装 ffmpeg 启动；网关模型目录、API 和前端均可访问。
- [ ] 在用户允许的真实生成任务中确认供应商实际接收素材及生成历史；本轮未提交生成任务。

- [x] 目标节点下方显示 1 个文本 tile 和 2 张图片缩略图，编号分别为文本 1、图片 1/2。
- [x] 面板高度按正文卡片高度、宽度约为 1.5 倍；正文及画布节点坐标未改变。
- [x] 引用行从当前上游节点 hook 读取；断开按钮按源节点精确删除入边。
- [x] 前端生产构建、`git diff --check` 和 guard 检查通过；本轮未新增或运行自动化测试。
- [ ] 用户在常用画布窗口尺寸下做最终视觉确认。
- [x] 本机网关目录返回 DeepSeek-V4-Flash、V4-Pro、V3.2 等；文本节点增加模型选择器，请求从前端经过 API、后台 runner 到模型 agent 按所选 ID 透传；旧节点无选择时保持默认别名。前端构建、Python 编译、ruff 和 guard 通过。
- [ ] 在真实画布里选一款非默认 DeepSeek 模型提交生成，确认结果与历史模型 ID；本轮未提交生成任务。

## 进展记录

### 2026-09-29 · 公开 origin 集成共享路径协调

本线既有已提交实现先于 `sync-main-remotes`；后者在独立 `codex/public-origin-sync` 检出中作为唯一后序集成者，仅对同名 claim 互认的精确路径解决公开上游三方冲突。本线旧产品合同、验证结果和业务所有权不因协调改写；最终合并验证与公开 PR 交付由同步线记录。

### 2026-09-26 · 模型按钮和弹窗样式对齐

做了什么：增加 `shared/TextModelPicker.tsx`，将文本节点原生 select 换成图标、短型号、旋转箭头的按钮，以及带图标块、选中高亮、悬停说明的深色圆角列表。Portal 浮层保持屏幕尺寸，支持视窗边缘翻转、滚动、键盘选择及外部关闭。

为什么这么做：用户要求对齐 Liblib 模型选择样式。直接读取当前线上模型组件 `3zez5ighjd7k4.js` 及主题 CSS，取得按钮/弹窗/行高/颜色参数，独立实现本地可用模型对应的组件；不引入 Liblib 计费或会员项。

怎么验证的：`pnpm build` 最终通过（初次发现 ES target 不支持 `.at` 及 Radix 不暴露 `onOpenAutoFocus`，已用兼容写法修复）；开发服务器新组件模块返回 200；`git diff --check`、guard 通过。未添加或运行自动化测试，没有生成请求或画布数据修改。浏览器连接不可用，最终视觉仍待用户窗口确认。

### 2026-09-26 · 修复模型下拉框空白

做了什么：`fetchFreezoneTextModels` 直接返回 `apiCall<FreezoneTextModels>` 已解出的数据，不再读取不存在的第二层 `data`。未改节点、画布状态和后端模型逻辑。

为什么这么做：目标项目目录实际返回 200，包含 18 个型号，其中有 GLM-4.5V 与六个 Qwen3-VL 型号；重复解包导致组件读取 `catalog.models` 抛错并清空选项。

怎么验证的：核对真实 API 返回结构，`pnpm build`、`git diff --check`、guard 检查通过。浏览器自动检查当前不可用，未在用户窗口点选下拉框或提交生成任务。

### 2026-09-26 · 文本节点引用素材真正进入模型请求

做了什么：按实时连线顺序提交上游文本、图片与视频 URL；同项目验证后，文本作为上下文、图片压缩成附件、视频本机抽取最多六帧并压缩成有顺序的视觉附件。加入 GLM-4.5V 与 Qwen3-VL 动态选择，只有视觉模型可处理图像引用，有视频时只列 Qwen3-VL。重启本机栈并接通 10808 代理与本地 ffmpeg。

为什么这么做：此前引用栏只有展示，文本生成 POST 没带素材。当前 PydanticAI OpenAI chat 适配器不支持原生 VideoUrl，抽帧可继续走现有受控模型通道且不依赖本地视频 URL 被外网访问。

怎么验证的：前端 `pnpm build` 通过，Python 编译、ruff、`git diff --check` 和 guard 通过；网关 `/v1/models` 返回 200 且含 GLM-4.5V/Qwen3-VL。网关、API、前端分别监听 3001/8781/5173，启动日志无 ffmpeg 警告。本轮没有运行自动化测试或提交真实生成任务。

### 2026-09-26 · 接通硅基流动 DeepSeek 文本模型选择

做了什么：从有效网关模型目录读取 DeepSeek 文本型号；文本节点独立保存 `textModel`，不会覆盖导入的图片模型字段；API schema、CE/后台任务与文本 agent 透传所选型号。本地网关只对已认证的显式 DeepSeek 文本请求放行选型，旧逻辑别名仍走配置默认。重新启动本机栈，网关/API/前端分别恢复到 3001/8781/5173，复用既有 ComfyUI。

为什么这么做：原网关会把所有文本请求强制改成 V4 Flash，单独增加下拉框会造成界面选择与实际生成不一致。模型目录来自本机现有硅基流动渠道，所选型号写入节点后在生成历史中沿用真实 ID。

怎么验证的：网关 `/v1/models` 实际列出多个 DeepSeek 文本型号；重新启动后的 `/healthz` 报告默认 `deepseek-ai/DeepSeek-V4-Flash`，API 配置端点和前端首页可访问。`pnpm build`、ruff、Python 编译、`git diff --check`、agent_guard check 均通过；未运行自动化测试或提交真实生成任务。文本引用图片仍只是可视引用，本轮没有给文本生成接口传图片。

### 2026-09-26 · 对齐引用栏与选中态面板

做了什么：WritingOpsPanel 增加文本和图片引用 tile，按类型独立编号；高度按正文卡片、宽度按约 1.5 倍设置，指令字号与底栏同步调整；底栏显示本地文本写作模型标识。浏览器检查造成的本机自动保存恢复到 rev47 的节点及视口状态，最终保存为 rev51，边维持 88 条。

为什么这么做：参考图中的引用卡片和大面板都属于选中态悬浮区，修改这层不会改变节点测量或排列。

怎么验证的：在目标画布选中一处“文本节点 7”，浏览器可见文本 1、图片 1/2、指令和模型底栏；35% 缩放下下方面板与正文卡片等高、约 1.5 倍宽。`pnpm build`、`git diff --check`、`agent_guard check` 均通过；未运行自动化测试。检查后当前 rev51 的节点、边、视口与检查前 rev47 相同。

### 2026-09-26 · 对照截图及本地数据

做了什么：检查参考图、本地节点组件与目标画布 rev47 的文本和连线。

为什么这么做：定位差异在选中态面板，而不是正文丢失或画布连线丢失。

怎么验证的：目标文本节点有三条入边，现有 WritingOpsPanel 高 140px 且没有引用渲染。

## 已定下来的决策

- 只用实时连线决定可见引用；导入元数据可保留原始顺序，但不可显示已经断开的旧引用。
- 不改变节点本体的 width/height/position，防止画布再次错位。
- 文本模型保存在独立 `textModel` 字段；省略时继续用后端默认别名。显式 DeepSeek 不能静默退回默认，供应商拒绝就如实报错。

## 待办

- [ ] 用户允许真实生成后，在含图/视频的节点提交一条任务，核对结果和历史模型；视频抽帧不含音轨。

- [ ] 用户在常用宽屏画布中确认边距、字号与参考图是否仍有肉眼可见偏差；若有，仅调本组件的悬浮面板样式。
- [ ] 在文本节点模型下拉框选非默认 DeepSeek 提交一条真实生成任务，确认历史记录显示同一 ID；该步骤会调用硅基流动。

## 阻塞

无。

## 交接摘要

- **最后完成到**：文本模型按钮/浮层已按 Liblib 当前线上尺寸和色值实现，构建通过，开发服务器已加载；没有改画布数据。
- **下一步唯一动作**：在用户窗口展开文本模型菜单确认最终视觉和点选；允许实际生成时再核对带引用任务。
- **先读这些文件**：本台账、目标组件、DESIGN.md。
- **不要动这些文件 / 决策**：本地画布数据与其他脏文件。

### 2026-09-26 · 故事板共享协调

本线既有实现先完成，storyboard-dual-view 后续串行集成共享视图接点；保留本线生成和保存行为。由当前 Codex 会话集成，禁止改工作流坐标。


### 2026-09-26 · H3 提示词优化协调
原工作先完成，h3-prompt-optimizer 在共享路径串行增加可选优化参数/入口/翻译，由当前会话集成，保留原行为。

2026-09-26 协调：h3-prompt-optimizer 在既有模型选择上串行加入 gateway SSE 透传与回归；最终集成由 H3 工作线负责，不改其他网关行为。


### 2026-09-27 · 多供应商模型接入协调
用户已授权多供应商选择，替代原本固定硅基流动的限制。已有实现先完成，本线由 multi-provider-models 串行扩展模型目录、调用路由与选择器；最终集成为当前会话，保留既有数据和工作流。共享路径：frontend/src/features/canvas/nodes/TextAnnotationNode.tsx, frontend/src/features/canvas/nodes/shared/TextModelPicker.tsx, frontend/src/api/ops.ts, src/novelvideo/api/routes/freezone.py, src/novelvideo/freezone/text_node.py, src/novelvideo/local_gateway.py。

### 2026-09-27 · 引用合同串行协调
既有 schemas 实现已提交；允许 multi-provider-models 串行修复 H3 格式绑定数量校验，保持本线媒体生成合同，由该线最终集成。

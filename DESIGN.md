---
version: alpha
name: DramaClaw
description: >-
  DramaClaw AIGC 视频引擎的视觉规范：暗色优先、信息密集的工作台。
  token 逐值对齐 frontend/src/index.css；以暗色为准，亮色值以 light-* 前缀并行。
colors:
  # ── 画布 / freezone 表面（来源：index.css 的 --*-rgb，.dark 块）──
  background: "#0a0c12"
  surface: "#15161d"
  surface-panel: "#13141b"
  surface-modal: "#1b1c23"
  surface-field: "#0d0e14"
  border-soft: "#1f2026"
  border-strong: "#2f3036"
  border: "#22232c"
  text: "#e8eaf0"
  text-muted: "#6f7079"
  accent: "#5ba0ff"
  # ── shadcn 语义层（来源：.dark 块的 oklch 值）──
  primary: "#00bdcf"
  primary-foreground: "#111b21"
  secondary: "#0e333c"
  foreground: "#e9edef"
  card: "#1f2c34"
  muted: "#182229"
  muted-foreground: "#8696a0"
  ui-border: "#2a3942"
  sidebar: "#111b21"
  destructive: "#ea4335"
  success: "#51bf6f"
  warning: "#efa831"
  chart-1: "#00bdcf"
  chart-2: "#009c9c"
  chart-3: "#31a7cd"
  chart-4: "#34b7f1"
  chart-5: "#51bf6f"
  # ── 亮色主题（来源：:root 块）——角色相同，取值更亮 ──
  light-background: "#ffffff"
  light-surface: "#f5f5f5"
  light-border: "#e0e0e0"
  light-text: "#000000"
  light-text-muted: "#666666"
  light-accent: "#3b82f6"
  light-primary: "#008198"
  light-foreground: "#111b21"
  light-card: "#ffffff"
  light-muted: "#f0f2f5"
  light-muted-foreground: "#667781"
  light-ui-border: "#e9edef"
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
  title-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.55
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.25
  label-strong:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
  mono-sm:
    fontFamily: SFMono-Regular
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
  counter-pixel:
    fontFamily: PikoCountdownPixel
    fontSize: 72px
    fontWeight: 600
    lineHeight: 1
rounded:
  sm: 12px
  md: 14px
  lg: 16px
  xl: 20px
  field: 12px
  node: 14px
  panel: 16px
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  button-y: 4px
  button-x: 11px
  node-gutter: 12px
components:
  modal:
    backgroundColor: "{colors.surface-modal}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
  panel:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "{spacing.md}"
  button-quiet:
    backgroundColor: "#0f1117"
    textColor: "{colors.text}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: 4px 11px
  button-quiet-hover:
    backgroundColor: "#15161c"
  button-quiet-primary:
    backgroundColor: "#0f1117"
    textColor: "{colors.accent}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  button-quiet-primary-hover:
    backgroundColor: "#1f2a3f"
    textColor: "{colors.accent}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 16px
  chip:
    backgroundColor: "#101118"
    textColor: "{colors.text-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    padding: 2px 10px
  chip-active:
    backgroundColor: "#23334d"
    textColor: "{colors.accent}"
  field:
    backgroundColor: "{colors.surface-field}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.field}"
    padding: 8px 12px
    height: 36px
  field-focus:
    backgroundColor: "{colors.surface-field}"
    textColor: "{colors.text}"
  canvas-node:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.node}"
    padding: "{spacing.md}"
  canvas-node-selected:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.accent}"
  popover:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  badge-muted:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
  status-failed:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.destructive}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  status-succeeded:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.success}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  status-degraded:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.warning}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  sidebar-item:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  # ── 亮色变体（无 `.dark` 时）。组件相同，改引 light-* token。──
  panel-light:
    backgroundColor: "{colors.light-card}"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.panel}"
    padding: "{spacing.md}"
  canvas-node-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.node}"
    padding: "{spacing.md}"
  field-light:
    backgroundColor: "{colors.light-background}"
    textColor: "{colors.light-text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.field}"
    padding: 8px 12px
  chip-light:
    backgroundColor: "{colors.light-muted}"
    textColor: "{colors.light-text-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
  button-primary-light:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-background}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.md}"
    height: 36px
  button-quiet-primary-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-accent}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  badge-muted-light:
    backgroundColor: "{colors.light-muted}"
    textColor: "{colors.light-muted-foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
---

# DramaClaw DESIGN.md

本文件是 `frontend/src/index.css` 的机读镜像。CSS 变量一改，本文件必须同 commit 更新——
靠 `npx @google/design.md diff` 跟上一版比对，才能抓出视觉回归。

> 章节标题保持英文（Overview / Colors / …），因为 DESIGN.md 规范按英文标题解析章节，
> 改成中文会被 linter 判为「缺失章节」。token 名、CSS 变量名、类名、属性名、色值同理保持原文。

## Overview

DramaClaw（虾导）是一个专业 AIGC 视频工作台：节点画布、故事板、生成队列、长任务面板。
用户是会把工具开一整天的创作者，所以 UI 定性为**暗色优先、信息密集、克制**——
`theme: 'dark'` 是持久化的默认值，亮色是受支持的备选，不是主战场。

调性是「仪表盘，不是海报」。界面外壳退到近黑的半透明玻璃里；一屏之内唯一的高饱和色，
只属于用户正在操作的那个东西。密集是刻意的：12px 是主力字号，4–8px 是主力间距。
动效短促且减速——表面是「落定」，绝不回弹。

明确不要的东西：营销感渐变、装饰性插画、俏皮的回弹缓动、同一表面上出现第二种强调色。

以上以及本文件其余全部规则，适用范围是**登录之后的产品界面**。未登录就能访问的对外落地页
（下载页、登录页）是一小块有意划出的例外，边界写在 Scope & Exceptions 里。

## Colors

两套色板共存，但**同一个表面上不得混用**：

- **画布色板**（`background` #0a0c12 → `surface` #15161d → `border` #22232c，
  文字 `text` #e8eaf0 / `text-muted` #6f7079，强调色 `accent` #5ba0ff）。
  驱动 freezone 画布、节点主体、悬浮工具条，以及所有 `.tap-*` / `.ui-*` 类。
  取值以空格分隔的 RGB 三元组形式存放（`--bg-rgb`），便于叠加 alpha：
  `rgb(var(--accent-rgb) / 0.22)`。
- **shadcn 语义色板**（`primary` #00bdcf 电光青、`card` #1f2c34、
  `muted-foreground` #8696a0、`ui-border` #2a3942，外加 `destructive` / `success` /
  `warning`）。驱动 shadcn 原语——弹窗、下拉、Tab、表单——用 `oklch()` 书写以保证
  感知均匀。

规则：

- 语义状态色两套色板共用：`destructive` #ea4335 表示危险与失败，`success` #51bf6f
  表示完成，`warning` #efa831 表示降级或额度受限。**不要再造第二个红。**
- `accent`（蓝）和 `primary`（青）是**历史遗留的两个强调色**，不是设计决策。
  画布表面用蓝，shadcn 表面用青。按「表面归属哪套色板」来选，不要按品味选，
  另见 Do's and Don'ts。
- 静止表面上彩度必须低。shadcn 的 `secondary` / `accent` 是带青调的灰
  （暗色 #0e333c、亮色 #def6fa），正是为了让下拉和 Tab 的 hover 态足够安静。
- 亮色模式把 `background` 翻成纯白、`text` 翻成纯黑，强调色换 `light-accent` #3b82f6；
  `card` 变纯白，衬在 #f0f2f5 的页面底上。
- `chart-1` … `chart-5` 是唯一批准的数据序列色，走「青 → 蓝绿 → 天蓝 → 湖蓝 → 绿」，
  保证同一色系不重复出现。

## Typography

拉丁字形用 **Inter**，CJK 依次回退 `Noto Sans SC` → `PingFang SC` → `Microsoft YaHei`
（见 `--font-family-ui-default`；macOS 走更短的 `--font-family-ui-macos`）。
产品文案以中文为主，因此：

- **CJK 正文永远不要设 `letterSpacing`**。对 Inter 好看的字距会破坏汉字的字面间距。
  负字距只保留给 `display-lg`。
- 同样 px 下 CJK 字形看起来比拉丁小约一档。中英混排的标签优先用 `body-md`（14px），
  而不是 `body-sm`（12px）。
- `line-height` 一律用无单位数值，这样能随 CJK 回退字体更大的 x-height 一起缩放。

实际层级分工：`body-sm`（12px）和 `body-md`（14px）承担约 90% 的产品文本——
属性面板行、节点标签、任务列表。`label-md`（12px/500）用于 chip、按钮、工具条控件。
`headline-*` 每个面板标题只出现一次。`display-lg` 只留给空状态和弹窗标题。
`mono-sm` 仅用于 ID、路径、seed、时间码。`counter-pixel`（方舟像素数字子集）
只作用于 Piko 小游戏倒计时，不得外泄到产品界面。

## Layout & Spacing

**4px 基准单位**（`--spacing: 0.25rem`），之上叠 8/12/16 的节奏。这是密集型工具：
代码里出现最多的两个间距是 `gap-1`（4px）和 `gap-2`（8px），面板内边距是 8–12px，
不是 24px。

- 外壳：固定左侧栏 + 流式工作区。画布满幅铺开；面板浮在它上面，而不是把它挤变形。
- 悬浮面板（工具条、属性面板、popover）用 `position: fixed`、12px 内边距，
  并以 16px 安全边距被夹在视口内。
- 节点内部用 12px 的沟槽，元素间 8px 堆叠。属性面板行间距 4px；组之间用 12px 分隔，
  绝不用分割线。
- 列表和网格在 `.ui-scrollbar` 内滚动（7px 细滑块，`rgba(148,163,184,0.5)`）。
  横向滚动条通过 `.ui-scrollbar-vertical` 隐藏，但仍可用手势滚动。
- 页面 body 永不横向滚动。宽内容自带 `overflow-x: auto` 容器。

## Elevation & Depth

层次来自**近黑底上的半透明玻璃**，不是靠堆阴影。每个悬浮表面都是：
半透明填充 + 1px 细边 + 一层柔和阴影。

- **Level 0 — 底场：** `background` #0a0c12。不透明，永不模糊。
- **Level 1 — 节点 / 内联表面：** `surface-panel`，细边 `border-soft`
  （`rgba(255,255,255,0.05)`），不加模糊。
- **Level 2 — 悬浮面板**（`.tap-panel` / `.ui-panel`）：
  `background: rgba(21,22,29,0.78)`、`border-soft`，以及
  `--ui-shadow-panel` = `0 14px 34px rgba(0,0,0,0.5)` 加一道
  `0 1px 0 rgba(255,255,255,0.03) inset` 顶部高光。压在画布上时配 `.backdrop-blur-tap`
  （`saturate(180%) blur(18px)`）。
- **Level 3 — 弹窗 / popover：** 产品工作台里的决策弹窗使用中性
  `surface-modal` #1b1c23 配 `ui-border`；通用 shadcn popover 继续使用 `card`。
  模态不模糊——它是要你做决定的。
- **焦点与选中用发光，不用阴影：** hover-primary 用 `--ui-glow-accent` =
  `0 0 24px rgb(var(--accent-rgb) / 0.25)`；聚焦输入框用
  `0 0 0 3px rgb(var(--accent-rgb) / 0.12)` 的 ring。
- 亮色模式把同样三层换成 #f0f2f5 上的不透明白卡片，阴影柔和得多
  （`0 2px 10px rgba(0,0,0,0.10)`）；玻璃隐喻在那边是刻意弱化的。

动效 token 也是层次的一部分：`--duration-fast` 150ms 用于 hover 和变色，
`--duration-base` 220ms 用于面板入场，`--duration-slow` 320ms 用于布局位移，
一律搭配 `--ease-out-quint` `cubic-bezier(0.22,1,0.36,1)` 或 `--ease-standard`。
**绝不用 bounce / elastic**——真实物体只会平滑减速。

## Shapes

两套圆角家族，相对小字号都偏大：

- **胶囊**（`rounded.full`，9999px）用于一切「可点但不是提交」的东西：安静按钮、
  chip、筛选器、标签。这是签名形状——`rounded-full` 是代码里用得最多的圆角。
- **柔和矩形**用于容器：输入框 `field` 12px，画布节点 `node` 14px，
  悬浮面板 `panel` 16px，大抽屉 `xl` 20px。

`--radius` 是 1rem，shadcn 的档位由它推导（`sm` 12px → `xl` 20px），所以这个项目里
Tailwind 的 `rounded-md` 是 14px，不是 6px。不要写死圆角，引用这些 token。
图标 1.5–2px 描边、圆头端点，尺寸取 14/16/20px，与 `label-md` 保持同一视觉基线。

## Components

**安静按钮**（`.tap-button`）是默认的操作控件：胶囊、4px/11px 内边距、12px 标签、
细边框、半透明填充。它在 hover 之前不宣示任何存在感；hover 时边框加强、填充升到
`surface`/0.88。它的主操作变体（`.tap-button-quiet-primary`）只把**文字**染成 `accent`
并加上强调色发光——它仍然是一个安静按钮。禁用态是 `opacity: 0.4` 加
`cursor: not-allowed`；不要再单独把标签置灰。

**实心按钮**（shadcn `button-primary`，近黑底上的青）每屏最多一个：表单或弹窗的提交动作。
画布上优先用安静主操作按钮。

**Chip**（`.tap-chip`）是带弱化文字的胶囊；`data-state="active"` 时文字翻成 `accent`，
底色变 `accent`/0.22 填充并加 1px 强调色 ring。激活状态由 `data-state` 承载，不用类名开关，
这样 React Flow 的 portal 也能被样式命中。

**输入框**（`.tap-field` / `.ui-field`）是 `surface-field` 上 12px 圆角的输入，静止态无可见描边；
聚焦时加 0.5 alpha 的强调色边框和 3px 强调色 ring。占位符和辅助文字有专属 token
（`--canvas-node-input-placeholder`、`--canvas-node-input-helper`），
让节点输入压在玻璃上仍然可读——用它们，不要用 `text-muted`。

**画布节点**是 Level 1 表面，14px 圆角、12px 沟槽。选中态是强调色 ring 加强调色标题；
绝不用投影——那读起来像正在拖拽。

**Popover / 下拉 / tooltip** 用不透明的 `card` 表面配 `ui-border`、16px 圆角，
hover 行用 shadcn 的 `accent`（#0e333c）——刻意不用画布的蓝强调色，
因为它们渲染在语义色板里。

## Do's and Don'ts

- **要**从 `frontend/src/index.css` 的 CSS 变量里读颜色、圆角、间距、动效。
  **不要**在组件里写死 hex、px 圆角或 ms 时长——写死字面量正是两套色板开始漂移的方式。
- **要**按「表面归属哪套色板」决定用蓝还是青（画布 → `accent` 蓝，shadcn 原语 →
  `primary` 青）。**不要**引入第三个强调色，也**不要**只改一侧表面去「对齐」另一侧。
  统一这两个色相是已知的待决事项，必须作为一次跨两套色板的有意改动落地。
- **要**保证一屏只有一个高饱和元素。**不要**把实心主按钮、激活 chip、发光节点堆在一起——
  眼睛会找不到主体。
- **要**用 `rgb(var(--x-rgb) / a)` 合成半透明，这样一条声明同时适配两种主题。
  **不要**在组件里手写 `rgba(255,255,255,0.05)`；用 `--ui-border-soft` /
  `--ui-border-strong`。
- **要**在压住画布的半透明面板上配 `.backdrop-blur-tap`。**不要**给全屏模态加模糊，
  也不要嵌两层模糊——第二层模糊要付一次全视口合成的代价，却看不出差别。
- **要**让任何用户必须读的文字满足 WCAG AA（4.5:1）。有四处**已知欠账**已经实测记录，
  它们是债务而不是先例——不要把这些比值抄进新组件：
  - `chip` 静止态标签，`text-muted` 压在 chip 填充上——**3.83:1**
    （「未激活就安静」的意图，但对必读标签而言低于 AA）
  - `status-failed`，`destructive` #ea4335 压在 `muted` 上——**4.12:1**
    （暗色下的错误文字；修法是文字改用更亮的红，填充保留 #ea4335）
  - `button-quiet-primary-light`，`light-accent` #3b82f6 压在 `light-surface` 上——
    **3.37:1**（亮色模式最薄弱的一环）
  - `badge-muted-light`，`light-muted-foreground` 压在 `light-muted` 上——**4.14:1**
- **要**放心用 `body-sm`（12px）承载元信息，中英混排一律用 `body-md`（14px）。
  **不要**低于 12px，也不要在同一个面板里用超过两种字重。
- **要**把 hover 反馈控制在 150ms 内、面板入场 220ms 并配 `ease-out-quint`。
  **不要**在画布表面上动画 `width`/`height`/`top`/`left`——只动 transform 和 opacity。
- **要**在收工前验两套主题：给 `<html>` 切 `.dark`，重点看玻璃表面——它们是亮色下
  最先崩的东西。

## Scope & Exceptions

### Piko character creation (approved 2026-09-14)

角色创建是独立游戏场景，采用用户确认的开阔山坡与浅木框、奶油纸面风格。
色板仅定义于 `piko-onboarding.module.css`：纸面 #fff5df、木框 #c69a63、
深木文字 #493523、辅助文字 #756047、苔绿 #526b40、蜂蜜金 #e8b85e、输入底 #fffaf0。
表单采用58%不透明度奶油纸面与16px背景模糊，无边框与阴影，18px 圆角；控件 12px 圆角，输入框仅 1px 低对比细边；正文 16px，主按钮 18px，
正文继续使用现有中文字体；左上“创建角色”标题使用 imagegen 生成的透明字图，容器宽 130.2–151.2px，左侧间距 16px，标题可带少量嫩叶、小花点缀，无底框。昵称使用白色文字与轻量阴影（0 1px 3px，暖深色50%），无底座或描边，距角色可见头顶20px；输入聚焦仅加深原有细边，不显示绿色外环。
全屏黑场过渡 800ms，减少动态效果时取消过渡。样式仅作用于该场景，不修改全局变量。


本文件默认约束的是**登录之后的产品界面**——画布、面板、列表、弹窗，一切用户开一整天的东西。
未登录就能访问的**对外落地页**是唯一的例外区，因为它们的任务不同：产品界面要让人忘记界面本身，
落地页要在十秒内说服一个还没有账号的人。用工作台的 token 去做落地页，结果是一张没人会转发的
说明书。

例外仅限以下两处，**是白名单，不是「凡是新页面都能声明例外」**：

- `/download` — `src/components/download/download.module.css`、`DownloadCanvasPreview.tsx`
- `/login` — `src/components/login/login.module.css`、`poster-wall.module.css`、`light-rays.css`

新增落地页要进这份白名单，必须同 commit 更新本节。任何登录后可达的界面一律不在其中，
包括从落地页跳进去的第一屏。

### 例外区内允许的偏离

- **自带色板，不引 `index.css` 的 token。** 下载页取自品牌 DC 标的材质——镀锌钢
  （`--zinc` #a8b4be）加锈蚀氧化（`--rust` #d9603a / `--rust-hot` #ee7549）。
  这确实是第三个强调色，只在例外区内成立：**`rust` 一族不得出现在任何产品界面里**，
  且在页内继续守「一屏一个主导高饱和元素」——静止态的锈橙只给 hero 的 `DC` 字样、
  「你的系统」标记、主下载按钮、hero 底部校准条，以及预览 SVG 里正在渲染的那个节点；
  其余出现的地方只能是焦点环和 hover 反馈。
- **拉丁字形用 Geist Variable**（`@fontsource-variable/geist`），CJK 回退链不变。
  字体只能随落地页的 lazy chunk 加载；一旦它出现在主 chunk 里，例外就失效了。
- **元信息层可以低到 10px，包括中文标签。** 落地页是海报式排版，行宽和留白都远大于工作台，
  等宽刻度字压到 10–11.5px 才有仪器感：眉标（`.eyebrow` 11px）、规格表键名（`.spec dl` 11.5px）、
  校验和值与说明（10.5 / 11px）、更新日志时间（11.5px）。边界：**这一档只给「扫一眼就够、
  不需要逐字读」的标签**——凡是需要读完的段落，字号仍守住产品的 12px 下限
  （落地页实测 12.5–17px：`.heroNote` 12.5px、`.capabilityCell p` / `.changelog p` 13.5px、
  `.faqAnswer` 14px、hero 正文 16–17px）。中文在 11px 是有代价的，别把这一档扩大到正文。
- **进场与装饰动效可以超过 320ms。** 区块进场 700ms、hero 校准条推进 1400ms，都配
  `cubic-bezier(0.16,1,0.3,1)` 减速，且只允许动 `opacity` / `transform` / `width`。
  交互反馈也放宽了一档：hover / 焦点 / 展开走 140–240ms，而不是产品界面的 150ms 上限——
  落地页的元素更大、位移更长，150ms 会显得生硬。边界：**交互反馈的上限仍是产品的 320ms
  `--duration-slow`**，超过 320ms 的只能是一次性进场和装饰动画；依然禁 bounce / elastic。
- **允许营销渐变与装饰图形。** hero 与卡片底纹用 radial / linear 渐变，画布预览是一张内联 SVG。

### 例外区内依然不许违反的

- 暗色优先。落地页锁死深色，不提供亮色变体。
- 用户必须读的文字满足 WCAG AA（4.5:1）。
- body 永不横向滚动；宽内容自带 `overflow-x: auto`。
- `@media (prefers-reduced-motion: reduce)` 必须把动画关掉——超长动效正是这条不能省的原因。
- 例外区的样式必须收在自己的样式文件里（优先 CSS Module；`light-rays.css` 这类页面私有全局
  CSS 要保证类名带页面前缀）。**不得反向修改 `index.css` 的全局变量**，也不得把落地页的类名
  泄漏到产品界面。

`design.md lint` 只校验本文件自身，不读 CSS，所以这一节是靠 review 执行的约定，不是靠工具。
评审落地页时看这一节；评审其余界面时，这一节不适用。

## Linting

```bash
npx @google/design.md lint DESIGN.md          # 0 errors 是准入线
npx @google/design.md diff old.md DESIGN.md   # token 级视觉回归
npx @google/design.md export DESIGN.md --format css-vars   # 或 tailwind | dtcg
```

预期基线：**0 errors，15 warnings。** 其中 4 条是上面列出的实测对比度欠账；
11 条是 `orphaned-tokens`，落在 `border` / `border-soft` / `border-strong` /
`ui-border` / `light-border` / `light-ui-border` / `chart-1..5` 上——
alpha 版规范既没有 border 属性也没有图表序列概念，这些 token 无法被 component 引用。
**不要为了消警告删掉它们**，它们在 `index.css` 里是承重的。
出现任何**新的 error**，或 warning 数超过 15，都意味着回归。

### Piko wardrobe and creation background implementation note

角色装扮弹窗复用个人信息弹窗的三段皮肤机制、16px 标题、暖色半透明格子、黄色确认按钮与像素关闭图标。专用母稿由用户裁切后替换上中下资源。
基础服饰格使用与当前性别对应的透明套装图标（40px 内等比展示），保留蜂蜜金选中边框；其余五个服饰格禁用，以适度透明度暖棕色禁止符号提示暂未开放，不显示占位文字。
装扮右侧六格为头部配饰：薄暮、粉红色回忆、深潜护目镜、侠之大者、小蜗牛、魔法帽。单选，蜂蜜金边框和淡金底表示选中，再点摘下；中央实时预览，确认后按账号保存在本机，关闭丢弃草稿。预览头顶预留 28px 用于帽子空间；不显示标题下说明及底部操作提示文字，说明仅供屏幕阅读器使用。地图昵称基础间距为6世界像素，仅在佩戴向头顶上方延伸的配饰时增加对应高度，摘下即恢复紧凑间距。地图配饰跟随角色头部逐帧锚点、缩放和场景遮挡，面具、护目镜与蝴蝶结背向时隐藏。
角色创建视频背景用两个静音播放器交替播放，在1.2秒重叠区间渐显下一段；背景不会在开场影片期间播放，页面隐藏时暂停。

角色创建表单标题 20px；性别选中使用蜂蜜金，键盘焦点用文字下划线提示，不加外框。影片控制位于右上，34px 高、9px 圆角、半透明深色背景与 12px 背景模糊。角色装扮使用专属三段素材，桌面最大宽 594px。

角色装扮在窄屏保持三列：格子允许收缩，关闭按钮保留至少 16px 屏幕内安全距离。

2026-09-15：入场视频按原始宽高比完整显示，仅保留画面内右上静音按钮；末帧停留0.5秒后播放无声循环视频，并用600ms淡入显示用户提供的「你也一起来吧」透明字图；点击后进入创建并复用已有 open 按钮音效，主动静音时不播放音效。2026-09-17 将邀请按钮缩至视频视口宽的12.5%，中心位于横向37%、纵向88.5%，顺信封下边线旋转3度，保持至少44px点击高度。装扮去除服装/配饰分区文字及空库存说明，格子目标48.4px，昵称与预览容器间隔6px，容器另留28px配饰空间。确认按钮与个人信息弹窗共用相同类名和页脚位移（mt-5、translate-y-4）。

2026-09-15 补充：Piko入口使用用户透明字图，显示宽60px（以最后确认尺寸为准），高度auto，按原图比例缩放，浅色主题下仅用CSS反色保证辨识。装扮内容底部内边距由22%收至14%（手机16%），保留皮肤下沿空间。开场静音按钮hover只轻微加深背景与边框。刷新启动底色在HTML内提前声明，默认主题与应用同为dark，尊重已保存的light/system；不改变全局CSS色值。


### Piko OST player (2026-09-15)

- 地图右上入口为音乐、装扮、设置；36px图标、34px等比例标题字图、20px间距，采用用户提供的v2音乐/装扮素材。
- 播放器沿用奶油木框三段皮肤，最大宽540px，左右视口安全距离20px。内容留白20%/12%/17%，内部可滚动。
- 唱片机最大275.5px，短屏199.5px；暖棕38%投影。唱臂650ms落下后黑胶与封面18秒一圈旋转；暂停立即停盘，唱臂同时以420ms平滑归位。减少动态效果时不旋转、不做过渡。
- 下方标题为《Piko小镇原声OST》- 歌曲名，与「跟随地图音乐」开关同一行；标题超宽省略。标题行距列表20px，开关26×14px，暖金选中态。
- 列表44px行高、6px间距、166px滚动区，默认暖木28%底、无可见描边，当前行蜂蜜金52%底。序号、曲名、时间、13px播放/暂停图标依次排列；整行可点，曲目变化自动滚动。
- 当前曲目展示已播/总时长，其余显示总时长。Chromium重置标准滚动条颜色以启用3px WebKit滚动条，其他引擎保留thin回退。
- 弹窗关闭后音乐继续，入口左侧以60–84px奶油色跑马灯显示实际播放曲名；暂停隐藏，减少动态效果时静止。
- 手动选曲在同次游玩中跨地图保持并顺序续播；开启跟随地图则恢复当前场景曲目。不同地图曲目切换采用3秒交叉淡入淡出，相同曲目连续播放；基础音量100%，窗口失焦或标签页隐藏时暂停，返回前台后恢复，退出场景释放音频。每次重新进入小镇清空选曲、暂停与播放进度，恢复跟随地图音乐。
- 入场动画右上「跳过动画」复用静音按钮样式，停止影片并进入邀请画面。

Piko 地图交通按钮采用65%不透明度浅黄底、10px背景模糊与常规字重暖棕文字，全圆角，无渐变、边框、投影或文字装饰；内边距4px/12px，最小高度32px，保留键盘焦点提示，hover仅将底色不透明度提高到78%。

Piko唱片机花瓣使用用户抠图的4×4粉色花瓣序列图，唱针落下650ms后开始少量向四周随机方向飘散，伴随轻微摆动与下落，每420ms产生一片、2.6秒内自然淡出；暂停停止产生，关闭弹窗释放动画，减少动态效果时隐藏花瓣。

Piko公聊与私聊提供单条按需翻译：鼠标悬停或键盘聚焦显示11px暖棕文字入口，触屏常显。译文在原文下方以12px文字展开，左侧2px浅木色线区分，保留原文；翻译目标默认跟随界面中英文，可手动选择并记住，不自动请求翻译。


### Piko task status label (2026-09-18)

角色昵称上方展示任务标签，预留帽子空间，并限制在地图可见区域内。公共聊天气泡优先占用昵称上方的近距离位置，显示期间暂时隐藏任务标签，不再为隐藏的任务标签额外抬高气泡。本人文案为「任务进行中」「任务完成」「任务失败」，无省略号，附代码绘制的小右箭头，整块可点击返回创作位置；其他玩家仅见「作品创作中」或「任务完成」，无箭头且不可点击。后者需真实多人同步接入后启用。

标签共用左中右三段背景，左右固定、中段横向拉伸；用户生成纯白背景母稿并抠图，项目切片接入。已接入用户提供的左右端320×766、中段96×766透明PNG，保存在 world/ui/task-label/；显示高26px，左右端等比缩小，仅中段横向拉伸，不另叠加CSS底色或边框。暖棕文字 #493523，状态标签作为该游戏场景的紧凑提示采用11px字号、16px行高和11px箭头，左右内边距11px；最终尺寸由用户验收。隐藏时不保留透明点击区域。

每15秒开始一轮淡入：淡入/淡出各250ms，完整展示5秒，隐藏9.5秒；减少动态效果时展示5秒、隐藏10秒，周期仍为15秒。状态改变打断等待，显示期间更新文案后重新完整展示5秒。本人悬停或键盘聚焦暂停淡出；减少动态效果时去掉过渡。切图保留周期，后台恢复不补播。本人的未读结束状态持续提醒，他人完成状态自完成时起有效60秒。完整行为与数据边界见 docs/piko-world/task-status-label.md。


### Piko accessory sparkle and foreground interaction (2026-09-18)

小镇已佩戴配饰保持原始亮度，不叠加本体提亮效果。与角色8秒待机周期共用时钟，在第3040–3840ms于配饰周围错峰出现3颗白、青、淡黄色像素十字星，尺寸比例1.0/1.1/1.2，每颗显示480ms、依次间隔160ms，避开抬手帧（2200–2550ms及6050–6400ms）；走动时隐藏，停下重新计时；星光跟随配饰，不单独拉动人物或昵称。减少动态效果时关闭星光，未佩戴或当前朝向不可见时隐藏。环境声、动物叫声与地图BGM遵循相同前台规则：窗口失焦或标签页隐藏时暂停，返回前台恢复调度，离开地图释放资源。

地图可操作且没有游戏面板打开时，单按Enter打开公共聊天并聚焦输入框；输入法确认、长按、组合键及其他控件的Enter不触发。聊天已打开时保留既有发送行为。


### Piko river fish (2026-09-18)

迎宾庭院河道显示3条青灰小鱼和1条浅金小鲤鱼，长度分别为24.48–26.52及28.56世界像素，使用用户提供的透明四帧素材。鱼位于限定河面内，以低饱和水色、适度透明度融入水体，水纹以5%不透明度覆盖鱼身；不增加气泡、发光和尾迹。河面维持2fps缓流，青灰鱼以2.5–2.8fps摆尾、金鱼以2.3fps摆尾，并与水纹及彼此错相。四条鱼分别随机选点，以16–24世界像素/秒游动，72%路线向下游偏移；到达目标后有42%概率静止2–5秒，静止时固定姿态而水纹照常流动。鱼群平滑转向并避让，保持至少28世界像素的中心间距；减少动态效果时静止。素材与层级维护说明见 docs/piko-world/river-fish.md。

### Piko canal water (2026-09-23)

灯河街的长河与右下角浅滩复用庭院16帧、2fps的河水纹理和多边形裁切。石桥上下游分别裁切，水纹延伸到温室侧河沿、上游东岸、桥前水面和下游两侧水边，不盖住桥面与露出水面的岸石；长河动态层保持30%不透明度，浅滩为20%，三段错帧播放。页面隐藏时暂停，减少动态效果时保留静帧。鱼群沿用庭院四帧摆尾素材与避让机制：上游2条青灰鱼，下游2条青灰鱼和1条浅金鱼，右下浅滩2条较小的青灰鱼；三处水域各自游动，鱼身与河岸、水草和桥墩保持间距。

### Piko seat interaction (2026-09-18)

可坐物件以地图交互数据的 `seat` 命中区标记，另由动作表给出落座点、椅前站位和触发半径。统一使用正面坐姿：远处点击长椅寻路到椅前后自动落座；点击地面或方向键起身并恢复站位。悬停椅子使用互动手型。男女源图均等比缩至50像素高，置于透明64×64画布顶部y=4，显示倍率为站姿的1.05倍；臀部锚点为(32,32)，东侧长椅接触点为(1490,496)。坐姿配饰使用独立头顶锚点(0,-27)，昵称和头顶提示随姿态调整，保留臀部接触阴影与脚底阴影。人物腿部显示在凳面前，不叠加包含背景的不透明矩形切片。男女各使用基础坐姿和用户提供的一张待机帧；8秒周期中第3.2–4.4秒显示待机帧，其余保持基础姿态，切换不改变落座锚点、身体缩放、配饰或阴影位置。页面隐藏或交互暂停时停表，减少动态效果时固定基础帧，重新落座时从基础帧开始。

坐姿几何与待机节奏统一维护于 `runtime/seated-pose.ts`，地图落座点维护于 `runtime/seat-actions.ts`。遮罩与人物轮廓使用脚底深度，聊天气泡使用坐姿头部采样点，悬停高亮同步身体锚点与缩放。只有包含已配置座位的地图加载坐姿素材。

### Piko dog greeting (2026-09-18)

罐头先完成庭院巡游，再衔接跨地图路线。玩家在120地图像素内停留1秒时，行走中的罐头可停下吠叫并复用角色聊天气泡显示「🐶❤️」2.5秒；结束后继续原路线，不打断休息或地图交接。同次游玩冷却90秒，切地图不重置，需离开180像素后重新靠近。复用现有音效，避免与其他动物叫声重叠；后台、交互暂停及减少动态效果时不发起招呼。

### Piko entry menu (2026-09-18)

入口顺序为「Piko 小镇」「我的搭子」「Piko 一下」。小镇右侧使用透明底细线框「Beta」状态标记，10px常规字重，作为已确认的紧凑辅助标记例外；沿用现有菜单容器、交互与色彩 token。

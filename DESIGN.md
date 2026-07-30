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
- **Level 3 — 弹窗 / popover：** 不透明的 `card` #1f2c34 配 `ui-border`。
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

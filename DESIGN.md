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
  group-label-text: "#919191"
  group-label-colored-text: "#ffffff"
  group-label-red: "#4e1714"
  group-label-cyan: "#014a5a"
  group-label-green: "#0c4327"
  canvas-edge: "#86909c"
  canvas-edge-hover: "#c0c8d0"
  canvas-edge-flow: "#64b4ff"
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

### Canvas edges

按用户指定：普通连线为不透明 1.5px `canvas-edge`，悬停/选中为 2px
`canvas-edge-hover`；`canvas-edge-flow` 为亮头渐隐拖尾，沿源到目标方向 0.8 秒线性循环。
颜色分别落在 `edges/CanvasEdgeFlow.tsx` 的主线常量与同名 CSS module 中，不修改全局 accent。
动画仅在高亮时挂载，抓手、平移及 reduced-motion 下停止并隐藏；不使用高斯模糊滤镜。
处理中连线保留原任务状态提示色。

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

### TV Director 独立工作台

按用户指定的 LibTV 视觉基准，导演工作台是独立中性深色创作表面，不继承旧画布蓝黑底。
`director.css` 仅在 `.dc-studio` 内覆盖 RGB token：背景 `20 20 20`、表面 `33 33 33`、
正文 `247 247 247`、次文 `153 153 153`、目录强调 `93 220 255`；软/强边线为白色8%/16%。
该独立表面在应用明暗主题下保持中性暗色，不修改全局 index.css 或旧 story/freezone 的变量。
字体使用系统/PingFang SC/Inter/Noto Sans SC 栈，正文14px、控件13–14px、弹窗标题18px。
局部尺寸变量：`--dc-panel-width: 400px`、`--dc-panel-height: 640px`
对应右侧浮动对话窗；`--dc-preset-width: 1232px`、`--dc-preset-height: 640px` 和
`--dc-top8-width: 264px` 对应双栏剧本设定器。浮窗背景 rgba(31,31,31,.75)、圆角28px，
八向缩放/标题拖动，最小320×360并受容器约束。双栏间隔8px、面板圆角24px；宽屏外留至少60px。
Top8内边距24px/底28px、标题行26px、条目间距12px、条目圆角12px/半像素边框/文字13px。
六张参数摘要卡等分、间隔10px、高74px、圆角14px；主视觉圆200px，融合入口120px。
取消/确认80×36、圆角10px、确认白底。850px以下Top8横向滚动、参数卡三列、弹窗内滚动；
表单集中在参数弹层和高级设置，不在主视觉中堆叠。用户明确要求使用参考站素材：本地固定
TV Director 的54种SVG图形、14张公共题材装饰图和21张画风缩略图，取代临时通用图标和渐变占位。
`assets/reference-assets.json` 是来源/文件校验清单，`DirectorReferenceIcon` 只渲染静态SVG图形，
不注入HTML、不运行脚本、不热链远端。题材图中心裁切，头像32px；主图200px/放大1.06，融合图互叠22px。
主图玻璃边缘取参考冷白/浅蓝 rgba(216,238,255,.65)、rgba(151,196,228,.22)，图后同图60%/64px模糊光晕；
Top3图160%裁切、中心横移到72%、#242424→#1f1f1fbf遮罩。未设参数为透明底/白16%虚线卡。
这些来源未提供再分发许可证；公开发布前须确认素材使用权或替换，不将素材采集当成许可证。
相同素材也不等于全页像素一致，验收必须逐屏记录实际尺寸及尚缺交互。

Director 子表面尺寸也取自参考站 DOM：设置弹窗宽600px、圆角12px、背景#262626，
标题行60px、内边距16px、开关24.5×14px、完成按钮50×32px。历史弹层宽320px、
圆角16px、搜索与记录行44px，锚定实际触发按钮且限制在视口内。受众/角色/时代/看点弹层宽345px，
对应高度139/419/219/499px，16px内边距、3列32px选项及8px间隔；结构373×249px。画风弹层413×407px，
三列缩略图16:10、卡片最小高104px；自定义在首格。通知提示底色#21304e。
富文本编辑器背景#0a0a0a、顶栏52px，680px正文居中、顶部留白60px，栏目标题20px/30px、下距36px；目录宽168px，
位于中心左侧532px、垂直居中。工具栏32px图标按钮，正文15px/1.85、标题24/20/17px、
正文灰#a8a8a8。人物小传实站复测细化：正文15px/1.8667，H1为23.25px/1.35且下距11.625px，
人名H2为19.5px/1.4且上/下距37.05/9.75px；列表左距21px、相邻条目5.25px，标签600字重。
2026-09-27《入画》同文档复测：正文首块上距0（不能与栏目标题下距发生37.05px折叠），段落margin为0、字距.01em（15px正文为.15px）、标题字距-.01em，空段落保留一行28px高度；不通过给所有段落补14px来近似原站。
场景设计沿用同一正文与目录系统：场景清单H1、场景名H2，类型/戏剧作用/空间限制/动作位置/关键集次为加粗标签列表。
道具设计也沿此系统：道具清单H1、物名H2，类型/戏剧作用/使用边界/首次出场/关键集次五个加粗标签；同类物件按实际持有人区分，不改成表格。原站道具页复测同680px正文及标题、列表间距，空清单只显示说明，不制造空道具卡片。
2026-09-26两站实测在1920px视口正文同为x620/y178/宽680px；不为场景另建表格或不同字号。
剧本文档节点未缩放基准640×350px、16px圆角、24px内距，目录92px/13px字号，正文14px/1.6；
节点作品标题24px/32px、600字重、左右96px安全区；日期16px/19px、上距12px。
右上编辑按钮60×32px，顶部/右侧24px。节点随画布缩放，不能把截图缩放后的尺寸当固定布局。
700px以下工具栏换行、正文自适应、目录隐藏，不产生页面横向滚动。
用户手工编辑以1秒空闲自动保存，状态放在52px顶栏，更多/私稿收进右上280px浮层；冲突或断网提示在正文上方600px以内面板，不常驻底部保存栏。源码保底与私有草稿为本地扩展。待审模型稿仍独立显示明确采纳/拒绝，不由自动保存代替。

素材下拉保持角色图/场景图/道具图三项。当前独立图片面板占用聊天浮窗48px标题栏下方，沿用400px宽、16px内边距、8px控件圆角与16px确认卡；三参数列等宽。素材按已保存设计文档二级标题顺序展示；准备与付费确认分离，确认卡可展开来源/完整请求/回执。默认自动批量规划，保留单素材模式；金额未知明确告知。事实审计在原回包弹窗展示失败字段和值，不默默覆盖生成内容。

图片面板按钮最小高32px，次操作6×10px内边距，主操作10×14px、白底深字；准备按钮独占整行，不与目录提示拼接。面板滚动时自身标题/关闭保持顶部可达。
批量媒体由已存设计稿顺序规划、提示词逐项可编辑，准备先落持久占位节点，批准集冻结后才提交任务。节点随文档图层平移缩放；350px预览宽（源站100%实测）、高度随实际提交比例、12px圆角、30px标题行、32px水平沟槽及图高加108px行距，元信息12px/20px；状态胶囊距底12px。节点移动按缩放换算并版本保存，等待新版本回读期间保持已保存位置，任务完成读取持久结果，不复制正文权威。事实报告沿既有质量对话框分段details展示原文、原子主张、状态变化及引证；不能以颜色或总评分代替事实说明。
画布对文档与媒体图层做 transform 平移/缩放，工具栏固定，滚轮缩放5%–200%（菜单25%–200%）；适配画布计算文档和全部媒体节点包围框，桌面避开聊天浮窗。小地图与吸附是本机视图状态。
聊天浮窗外框为0.5px；输入区采用实测64px最小高度、14px/24px文字、底部8px内距，外壳8px内距与纵向8px间隔、底距12px，设定器标签22px高、发送32px。避免94px输入区把上方欢迎内容整体顶高；画布网点半径0.5px/间隔16px随缩放变化。
欢迎图标40px、图标到标题12px、标题16px/24px与600字重；预设区上距20px，按钮37px高/0.5px描边#363636/间隔4px。通知条40px高、外内距12×8px、文字组左右8px且开启间距12px，窄屏文字截断而不挤走关闭。画布网点#474747，中心落于0.5px像素中心，避免半像素圆落在四像素交界而消失。
缩放菜单与小地图位于左下16px，避开右下聊天浮窗；700px以下缩放菜单移至左上52px、小地图位于其下，避免与底部工具栏叠盖。关闭对话后从底部工具栏的 Director 图标重开，不额外添加遮挡控件的悬浮按钮。
问卷背景#141414、圆角20px，选项选中底#262626；序号22px方牌/圆角5px。方向与必答问题逐页显示，
题目行右侧保留页码/前后题，翻页不提交；非末页显示继续，末页明确提交才调用检查点命令，底部费用权限提示保留。
首次原创的已取证问卷为方向、集数、单集时长三页。后两项以作品已保存值为默认确认，也允许有效自定义输入；只有末页提交才在同一事务更新作品设定与后续生成快照。模型提出的额外创作问题保留审计，但不自动变成多页必答问卷；改编仍按有源缺口单独提问。
剧本文档节点处于 Level 1、浮窗处于 Level 2、确认与审阅弹窗处于 Level 3；待审稿与正式
文档用不同状态而非仅用颜色区分，接受/拒绝是显式按钮。画布点阵基础间距16px（源站118%约18.87px），仅为工作区域背景。

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

### TV Director 分集与流式对话

局改悬停按钮按源站实测采用绝对定位，不永久占用正文行高；44px高、#242424背景、14px圆角、4px内距和间距，按钮36px高并配20px图标。键盘焦点同样显示操作条；分组关联信息保留可访问名称。全局审阅条置于编辑器顶部64px处、水平居中，与52px页眉内的缩放控件分离，显示真实剩余节数。不将只读审阅伪装为可自由格式化编辑。

大纲局部审阅沿用同一680px纸宽和正文排版。逐节操作条按源站实测：#242424背景、14px圆角、4px内距/间隔，总高44px；摘要13px/#919191、左右8/4px，按钮高36px、横内距8px、10px圆角、图标20px与6px间隔。条下距8px，删除文字为rgba(251,115,115,.65)并有删除线，新增文字#04caf6（源站实测）（不以颜色代替前后状态）。顶部提供实际可用的上下节与全局接受/撤回，五节目录可跳转；窄视口遵循既有正文/目录收起规则。独立组合事实审查和费用确认是本地安全扩展，必须明确标识，不冒称源站已有该门。

分集沿用 680px 正文纸宽、15px / 28px 正文字体、168px 浮动目录；集标题、七项信息、梗概、正文与场次三级标题分层。对话窗口在全屏编辑器上方（层级55，编辑器50），保持400×640、右/底16px或用户拖动后的坐标，不再额外上移56px；费用和确认弹窗保持更高层级70。对话正文14px / 1.75，方法追踪与格式检查12px，沿用深色表面的#eee正文、#aaa辅助字和#ffffff29细边框。输入框运行时显示停止按钮；只展示真实模型正文增量，不做模拟打字。读者向上滚动后暂停跟随，底部提供返回最新内容按钮。结构提示不代表质量通过，未完成文本不能直接作为正式稿。

### 工作流分组备注

分组标题使用独立的屏幕尺寸浮层，复用 `--st-canvas-zoom` 的反向缩放：普通标题 13px / 1.55 行高，颜色 `--group-label-text`；彩色标题 12px / 18px 行高、标签高 24px、圆角 6px、左右内距 6px，白字使用 `--group-label-colored-text`。浮层在组框左上方，间距为画布坐标 8px，与组框一起定位，不参与节点几何测量。来源红 / 青 / 绿标签使用对应 `--group-label-*` 色值，组底色和边框分别为基础色的 10% / 20%。故事板组继续使用原标题和拖动区域。

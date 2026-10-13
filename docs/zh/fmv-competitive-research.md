# 互动影游竞品调研报告

> 市面代表性 Interactive Film / FMV / 互动视频产品的核心功能横评,以及对我们「画布 → ink → 播放器」架构(feat/canvas-fmv)的落地建议。
>
> - **方法**:5 路并行检索 → 23 源抓取 → 112 条论断 → 3 票对抗核查
> - **产出**:23 条高置信结论(3-0 通过)/ 2 条否决
> - **日期**:2026-07-03

---

## 00 结论速览

**行业共识高度收敛。** 经过对抗核查的证据集中在五个标杆:Eko/Interlude 专利、Netflix《Bandersnatch》工程实践、爱奇艺 IVA/IVG/IVP 标准、Stornaway、CtrlMovie(Late Shift 引擎)。它们在六个维度上的做法惊人一致——**无缝分支切换 + 免安装浏览器播放是公认的两大核心体验指标**;限时选择 + 倒计时 + 默认选项是选项交互的标准化设计;变量/倾向值 + 条件路由是状态系统的通行实现。

**我们的 MVP 方向正确、骨架齐全。** 画布编译 ink、选项倒计时+默认、变量条件、自包含 HTML 导出,均已对齐行业主流。差距集中在四处:

1. **分支预加载**(无缝度)
2. **选择分布/结局达成率统计**
3. **占位素材早期试玩**
4. **全局路径回顾图**

**一个必须知道的坑**:Eko 专利 US 10,582,265 B2(约 2035 年到期)保护「动态播放列表驱动线性播放器实现无缝分支」,与我们技术路线同构。美国市场落地前需做 FTO 评估。

---

## 01 五个标杆在做什么

以下每条均有一手来源(专利原文 / 官方文档 / 工程团队一手分享)且通过 3 票对抗核查(3-0)。

### Netflix · Bandersnatch — 双分支预缓存 + 四阶段选择点

在二选一选择点**同时预缓存两个分支片段**,代价是码率与内存翻倍(这也是不支持部分老设备/Chromecast 的原因)。选择点 UI 是显式状态机:`Initialization → Choice Selection → Timeout → UI Hide`。

> **对我们**:选项节点出现时预取两个后继片段,是成本最低、价值最高的无缝化手段;选择点组件按四阶段重构,便于测试与埋点。

### Eko / Interlude · US10582265B2 — 视频树 + 动态播放列表 + 编码级音频拼接

分支结构表示为 video tree,向线性播放器喂动态播放列表;音频在**编码阶段**做无缝拼接(拼接未压缩音频 → 整体压缩 → 抽取对应段),从源头消除片段边界的 codec priming 伪影。

> **对我们**:批量剪辑管线可评估 GOP 对齐/重叠编码等差异化手段——但该方法在专利权利要求内,照搬有 IP 风险。

### 爱奇艺 · IVA / IVG / IVP — 标准化协议:X 因子 + preLoadList

- 限时选择写入协议:展示 **5–30 秒** + COUNTDOWN 元素 + 唯一默认选项(`isDefaultSelect="1"`,配置了显示条件的按钮不能作默认;若无默认则执行 COUNTDOWN 自身 actionList 的兜底动作)。
- 「X 因子」即好感度变量(初始值 0–100,缺省 0,**最多 20 个**),通过 ALGORITHM 运算(如 `var1=var1+1`,负值取 0)累计倾向性,配 `CONDITIONSWITCH`(支持 `&&` 连接的比较表达式及 max/min)做条件路由。
- 个性化覆盖三维度:**改变视频内容、改变互动点(显示/隐藏/替换)、替换组件选项**。
- **preLoadList 是一等必填字段**——预加载清单编译进数据格式,而非运行时优化;`SWITCHVIDEO` 支持 insertToTime 定时/立即切换。
- IVP 创作平台:「多后继自动分支」(一段剧情接 ≥2 后继时自动开启互动,可手动开关)+ 两级预览(单段剧情预览 + 整体交互式预览)。

> **对我们**:预加载清单应作为画布编译产物静态生成;出边 ≥2 自动生成选项边脚手架;5–30s 可作倒计时参数参考。

### Stornaway — 占位素材即时试玩 + 全链路埋点

Story Map 可视化节点编辑(Story Island 盒子 + 箭头,可缩放看全局、回溯观众路径),**未上传任何视频也能用占位素材点 Play 试玩全流程**。每次点击/选择/路径都是数据点,原生 xAPI/SCORM/GA,可对接 LMS/LRS/CRM;NDF 格式支持自托管的自包含导出(Active NDF 为企业级年费功能)。

> **对我们**:与「AI 视频生成前先跑通结构」的场景天然互补——文字卡/静帧占位试玩是高价值低成本功能;HTML 导出已对齐 NDF 思路,缺数据侧。

### CtrlMovie · Late Shift — 变量 + Lua 表达式 + 时间码级跳转

播放中屏上按钮 + 无缝播放(180 个选择点零停顿,第三方报道证实);用户决策存变量、短 Lua 脚本做条件评估;**Dynamic Jump Actions** 支持跳到精确时间码/时间区间内/用户动作触发。

> **对我们**:ink 变量+条件已对齐;差距在时间码级 mid-roll 互动点——表达力提升显著但成本中偏高,放 P2。

---

## 02 功能对比矩阵

图例:● 已具备 ◐ 部分具备 ○ 缺失 / 无已验证证据

| 维度 | Netflix | Eko | 爱奇艺 IVA/IVP | Stornaway | CtrlMovie | **我们 (canvas-fmv)** |
|---|---|---|---|---|---|---|
| **分支叙事结构**<br>分支/汇合/图结构 | ● Branch Manager<br>segments+choicePoints | ● video tree<br>动态播放列表(专利) | ● 交互区间+播放区间<br>多后继自动分支 | ● Story Map<br>节点盒+箭头,可回溯 | ● 时间线分支<br>时间码级跳转 | **● 画布图→ink 编译**<br>choice edge / lint |
| **选择交互**<br>限时/默认/状态机 | ● 四阶段状态机<br>Init→Select→Timeout→Hide | ◐ 经播放器标准接口 | ● 5–30s+COUNTDOWN<br>唯一默认选项入协议 | ◐ 选择按钮 | ● 播放中屏上按钮 | **◐ 倒计时+默认已备**<br>缺显式四阶段/进出动画 |
| **状态系统**<br>变量/倾向值/条件路由 | ● 状态变量+precondition | ◐ 播放列表实时改写 | ● X 因子 0–100<br>ALGORITHM+CONDITIONSWITCH<br>动态显隐/替换互动点 | ◐ 变量与逻辑 | ● 变量+Lua 表达式 | **◐ ink 变量+条件已备**<br>缺:条件驱动选项显隐/文案替换的画布 UI |
| **播放体验**<br>无缝切换/预加载 | ● 双分支预缓存<br>码率/内存×2 | ● 编码级音频拼接<br>消除边界伪影(专利) | ● preLoadList 一等字段<br>SWITCHVIDEO 定时/立即 | ◐ 浏览器播放 | ● 无缝播放<br>180 选择点零停顿 | **○ 无预加载**<br>切换处可感知断裂 |
| **创作工具**<br>节点编辑/预览调试 | ◐ 内部工具 | ◐ 创作套件 | ● 托管平台<br>两级预览:单段+全流程 | ● 占位素材即时试玩<br>零视频可 Play | ● CtrlEdit 编辑器 | **◐ 画布编辑+播放器预览**<br>缺:占位试玩/两级预览 |
| **数据与运营**<br>选择分布/结局达成率 | ◐ 平台侧收集 | ◐ 平台分析 | ◐ 平台侧 | ● 逐选择埋点<br>xAPI/SCORM/GA | ◐ — | **○ 无统计**<br>仅 localStorage 存档 |
| **分发形态**<br>自包含导出 | ○ 平台内 | ○ 平台内 | ○ 平台内 | ● NDF 自托管导出 | ◐ App/主机发行 | **● 自包含 HTML 播放器**<br>已是差异化优势 |

---

## 03 落地建议(按价值/成本比排序)

P0 均有行业标杆直接验证、且与现有「画布 → ink → 播放器 → HTML 导出」架构兼容,不动骨架。

### P0 — 高价值低成本

| # | 功能 | 说明 | 参照 |
|---|---|---|---|
| 1 | **选项节点双分支预加载** | 选择点出现时用 `<video>` 双实例或 fetch 预取两个后继片段,直接消除切换断裂感;导出 HTML 播放器同步受益 | Netflix 双分支预缓存(3-0);注意实现写法规避 Eko「动态播放列表」权利要求 |
| 2 | **占位素材即时试玩** | 视频未生成时用文字卡/静帧占位跑通全流程试玩;先验证故事结构再花钱生成视频,与批量视频生成计划天然互补 | Stornaway placeholder playtest(3-0) |
| 3 | **选项动态显隐 / 文案替换** | 基于变量条件显示/隐藏/替换选项本身;ink 条件选项原生支持,只需补画布侧编辑 UI | 爱奇艺 X 因子 + CONDITIONSWITCH(3-0) |
| 4 | **选择分布与结局达成率本地统计** | 播放器内埋点 + localStorage 聚合:每个选择点的选项分布、结局达成率;先本地统计+可选上报 | Stornaway 逐选择埋点(3-0) |

### P1 — 中成本

| # | 功能 | 说明 | 参照 |
|---|---|---|---|
| 5 | **选择点四阶段 UI 状态机重构** | Init → Select → Timeout → Hide 显式状态划分,补进入/退出动画与选中确认反馈,便于测试与埋点挂载 | Bandersnatch 选择点状态机(3-0) |
| 6 | **预加载清单编译为一等数据** | 画布编译时为每个选项节点静态生成后继片段预加载列表(ink JSON 之外的清单) | 爱奇艺 IVA preLoadList(3-0) |
| 7 | **多后继自动分支脚手架** | 节点出边 ≥2 自动生成选项边脚手架(可手动关);配套「单节点预览 vs 全流程预览」两级调试 | 爱奇艺 IVP(3-0) |
| 8 | **全局路径回顾图** | 播放后在画布/精简图上高亮已走路径与已达成结局,给观众「看了多少、还有什么没看」的地图感 | Stornaway Story Map 回溯(3-0) |

### P2 — 高成本

| # | 功能 | 说明 | 参照 |
|---|---|---|---|
| 9 | **批量剪辑管线的编码级无缝拼接** | 片段边界统一 GOP 对齐/重叠编码/音频交叉淡化;我们控制编码环节有条件做,但 Eko 专利声明了「拼接后整体压缩再抽取」方法,须先做差异化设计 | Eko US10582265B2(3-0) |
| 10 | **时间码级 mid-roll 互动点** | 当前分支粒度是整段视频;支持片段内精确时间码跳转可显著提升表达力(QTE 类玩法的前置能力) | CtrlMovie Dynamic Jump Actions(3-0) |
| 11 | **xAPI / SCORM 导出** | 仅教育/企业培训场景有真实需求时再做;先用 P0 本地统计验证数据需求 | Stornaway SCORM(3-0) |

---

## 04 风险与已否决论断

### ⚠ Eko 专利 US 10,582,265 B2 — 美国市场 FTO 风险

2015 申请、2020 授权、**约 2035 年到期**,有活跃延续案(US12132962B2),曾被 Eko 实际用于起诉 Quibi。保护范围:「视频树表示分支结构 + 向线性播放器提供动态播放列表 + 控制器经标准接口实时改写播放列表」——与我们「画布图编译 ink 驱动播放器」**架构同构**。

这说明方向正确,但若面向美国市场落地无缝分支播放,需正式 FTO 分析或差异化实现(该专利仅在美国有效,国内落地风险不同)。

### 被 3 票核查否决的论断(报告未采信)

- 「爱奇艺互动创作以 Premiere Pro 插件为核心工作流」(1-2 否决)—— Pr 插件只是 Web 平台之外的补充形态。
- 「Netflix 超时默认选项与预缓存路径一致以保证连续播放」(1-2 否决)—— 超时行为与预缓存策略的关系无一手证据。

---

## 05 覆盖面缺口(诚实声明)

以下对象**没有任何论断通过 3 票核查**,本报告矩阵实际收敛在五个标杆上,不代表这些产品不重要:

- **国产互动影游**:《隐形守护者》《完蛋!我被美女包围了》——性格值/好感度系统与章节流程图可见性的一手证据缺失,而这恰是「全局回顾图」功能最重要的参照。
- **国内平台**:B 站互动视频、腾讯视频互动剧——现行技术方案与选择分布数据是否对创作者开放,无已验证证据。
- **主机/PC 大作**:Detroit: Become Human、Supermassive 系列(Until Dawn / The Quarry)、Her Story / Immortality、Erica——QTE 与「流程图对玩家可见」两个维度完全无证据支撑。
- **叙事引擎生态**:Twine / Yarn Spinner 对比、YouTube annotations 历史——未通过核查。
- **时效性**:爱奇艺 IVG/IVA/IVP 标准发布于 2019 年,文档在线但平台当前活跃度无法证实;Stornaway / CtrlMovie 官网为厂商自述,经第三方旁证部分交叉印证但未实测。

如需补齐国产游戏与主机大作的机制分析(建议下一轮聚焦:《隐形守护者》流程图 + Detroit 章节回顾图 + Supermassive 性格值,以实机视频为证据源),可再跑一轮定向调研。

---

## 06 关键来源

| 来源 | 质量 |
|---|---|
| [Eko 专利 US10582265B2 原文](https://patents.google.com/patent/US10582265B2/en) | primary |
| [Netflix 工程团队 Bandersnatch 分享(Streaming Media)](https://www.streamingmediaglobal.com/Articles/Editorial/Featured-Articles/Netflix-Goes-to-the-Other-Side-of-the-Mirror-With-Bandersnatch-135887.aspx?pageNum=2) | primary |
| [arXiv「White Mirror」流量分析(独立旁证双分支预缓存)](https://arxiv.org/abs/1903.06475) | primary |
| [爱奇艺互动视频标准 IVG 官方文档](https://www.iqiyi.com/ivg) | primary |
| [爱奇艺 IVA 协议(交互区间/X 因子/preLoadList)](https://www.iqiyi.com/ivg/03-part.html) | primary |
| [爱奇艺 IVP 创作平台文档](https://www.iqiyi.com/ivg/02-part.html) | primary |
| [Stornaway 功能页(Story Map/占位试玩)](https://www.stornaway.io/features/) | primary |
| [Stornaway Analytics(xAPI/SCORM/GA)](https://www.stornaway.io/analytics/) | primary |
| [CtrlMovie 技术页(变量/Lua/Dynamic Jump)](https://ctrlmovie.com/technology) | primary |
| [MPA:Bandersnatch 定制技术报道](https://www.motionpictures.org/2019/05/the-bespoke-technology-that-made-netflixs-black-mirror-bandersnatch-possible/) | secondary |
| [Bandersnatch 交互 JSON 逆向解析](https://engelsjk.com/posts/through-the-looking-glass-at-netflix/) | blog |
| [CMF:CtrlEdit 编辑器报道](https://cmf-fmc.ca/now-next/articles/ctrledit-a-new-tool-for-producing-interactive-movies/) | secondary |

---

*深度调研工作流 wf_a8626032-414 · 105 个代理 · 23 源 · 112 条论断经 3 票对抗核查,23 条存活、2 条否决 · 「落地建议」为基于已验证事实的分析性综合(置信度 medium),其余结论均为 3-0 高置信。*

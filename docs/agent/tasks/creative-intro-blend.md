# 创意片头融入原片 5 秒

**状态**：待验收
**最后更新**：2026-09-24
**基线**：`45130dfd`；`main` 与 `zhonggwv/main` 同步；仅三类受保护未跟踪资料
**认领者**：`codex/creative-intro-blend-20260920`
**相关文档**：`docs/guides/liblib-canvas-parity.md` 的 0.3.1
**相关分支 / PR**：`main` ｜ 无

## 目标

为创意片头增加可选的“融入原片”闭环：用户从源视频选择固定 5 秒区间，系统通过既有本地
FFmpeg 合成任务裁出真实片段并作为可见节点保留；片名设计图和该片段共同连接到媒体目录明确
支持图片+视频引用的动效节点。创建流程不自动提交任何付费图片或视频生成任务。

## 非目标

- 不自动生成片名图或最终动效，不代替用户确认供应商费用。
- 不实现文字、蒙版、调色或图层结果编辑。
- 不修改通用 `VideoNode` 的生成生命周期、后端 compose 契约或源视频内容。
- 不以模型名称猜能力；目录没有明确声明时不开放融合。

## 现状与证据

- `385139cc` 已交付 `源视频 → 关键帧 → 片名设计图 → 5 秒动效` 基础链。
- `VideoNode` 的智能续写已验证 `submitFreezoneVideoCompose → awaitTaskCompletion →
  fetchFreezoneJobResult` 能裁出真实片段；本线复用同一 API，不复制 FFmpeg 后端。
- 视频模型目录下发 `supportedModes`、`referenceImageMax`、`referenceVideoMax`；只有三者明确
  允许时，才存在不会静默丢素材的融合模式。
- `git status` 与 STATE 对账：本线实现全部落在下述写入边界；`.playwright-cli/`、`_to_delete/`、
  `曹操.md` 继续受保护。目标文件相对 `origin/main` 有本项目既有差异，但没有发现创意片头融合的
  远端实现。

## 写入边界

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md`、本台账、本线 claim | 协调 | 生命周期、范围和交接 |
| `docs/agent/claims/creative-intro-implementation.toml` 及相关 guide peer claims | 协调 | 已完成基础线对共享路径的互惠声明 |
| `frontend/src/features/canvas/application/creativeIntroBlend.ts` | 独占 | 5 秒区间、能力门与裁片任务编排 |
| `frontend/src/features/canvas/application/creativeIntroWorkflow.ts` | 共享 | 把可选片段加入显式节点链 |
| `frontend/src/features/canvas/ui/CreativeIntroDialog.tsx` | 共享 | 融合开关、固定区间预览、能力提示与创建状态 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | 三语融合文案，只合并新键 |
| `frontend/src/__tests__/features/canvas/creative-intro-workflow.test.ts` | 共享 | 基础链保持不变并补融合链断言 |
| `frontend/src/__tests__/features/canvas/creative-intro-blend.test.ts` | 独占 | 能力门、区间与裁片任务回归 |
| `docs/guides/liblib-canvas-parity.md` | 共享 | 更新差距矩阵和已实现边界 |

## 协调与冲突

- **相关工作线**：`creative-intro-implementation`、`creative-intro-discovery`、
  `liblib-canvas-parity`、`canvas-audio-split`。
- **本地已有改动**：业务代码无 diff；三类受保护未跟踪资料禁止触碰。
- **远端重复实现**：没有发现；本线复用现有 compose API 与视频节点引用合同，不移植远端分支。
- **共享文件顺序**：基础线已完成；本线只在既有创意片头模块追加可选分支，并补互惠 claim。

## 实施方案

1. 新增纯能力门与固定 5 秒裁片编排——完成条件：目录未明确支持时返回不可用；合法选择生成
   单视频轨 compose 请求并要求结果 URL。
2. 扩展创意片头节点编排——完成条件：普通模式仍是原三阶段链；融合模式额外创建可见片段节点，
   形成 `源视频 → 片段 → 动效` 与 `片名设计图 → 动效` 双引用，动效模型/模式来自能力门。
3. 扩展弹窗——完成条件：源片不足 5 秒或目录无能力时融合禁用并说明原因；启用后只能选择固定
   5 秒区间且可在源视频中预览；确认时先裁片、再创建草稿节点，失败不留下半条工作流。
4. 补三语、测试、构建和真实画布验收——完成条件：未发图片/视频生成请求，裁片与图边刷新后保留。

## 风险与回退

- **风险**：裁片是异步本地任务，失败或页面关闭会中断本次创建；远端未本地化视频仍会被入口拦截。
  模型目录刷新后能力可能变化，因此节点显式保存当时选择的模型与模式，提交时继续由现有守卫复核。
- **回退**：删除本线新增模块并精确撤销创意片头模块/UI/三语增量；不改通用视频节点、后端任务或
  其它工作线文件。

## 验收标准

- [x] 聚焦 Vitest 覆盖普通链、融合五节点/五边、能力门、固定区间和裁片结果缺失。
- [x] `python3 scripts/check_frontend_i18n.py` 与 `cd frontend && pnpm build` 通过。
- [x] 本地真实画布选择 5 秒范围后创建工作流；任务中心只出现本地 compose，未触发生成费用。
- [x] 刷新后片段节点、双引用边、模型/模式、5 秒区间与来源元数据仍在。
- [ ] 本轮改动全部在写入边界内；handoff、pre-commit、DCO 提交与推送完成。

## 进展记录

### 2026-09-24 · 实现与本地闭环验收完成

做了什么：在当前磁盘最新代码上完成能力门、固定 5 秒范围、保留原音的 compose 裁片、可见片段
节点、片名图+原片双引用动效节点、三语 UI 和回归测试；没有覆盖或清理用户的受保护本地资料。

为什么这么做（尤其是与原方案分叉的地方）：没有新增后端端点，也没有自动触发供应商生成；真实
片段先于画布变更完成，保证 compose 失败时不会留下半条图。此前一次浏览器检查误判弹窗没有打开，
复核发现是发布说明遮挡/自动化状态导致，当前代码不需要把弹窗状态上提或改写工具条结构。

怎么验证的（命令 / 界面路径 / 结果）：

- `pnpm test --run src/__tests__/features/canvas/creative-intro-workflow.test.ts src/__tests__/features/canvas/creative-intro-blend.test.ts`：2 个文件、7 项通过。
- `python3 scripts/check_frontend_i18n.py`：0 个新增硬编码中文。
- `cd frontend && pnpm build`：`tsc -b && vite build` 通过，5425 个模块完成生产构建。
- `git diff --check`、`python3 scripts/agent_guard.py check`：通过。
- 真实画布 `liblib_64c5bb59a1cb4296bece54f7e7d66994`：启用“融入原片 5 秒”后，目录能力门选择
  `Wan 3.0 Video Prime / allReference`；预览严格停在 5 秒；成功任务
  `freezone_video_compose` 使用 `ffmpeg` 队列并返回 5 秒 MP4，任务中心没有供应商生成任务。
- 成功后新增关键帧、片名设计、原片片段、动效四个下游节点和五条边；刷新后原片节点时长、
  双引用、模型/模式、提示词和关系边仍在。另一次故意保留的服务断连验证了弹窗恢复可操作且没有
  新增半成品节点。

### 2026-09-20 · 方案门与能力审计完成

做了什么：审计现有创意片头链、视频 compose 裁片、模型目录能力、视频引用收集与提交守卫，
建立本增强线及精确写入边界。

为什么这么做（尤其是与原方案分叉的地方）：不新增后端裁片端点，也不把源区间只写进提示词；
复用已验证的 compose 任务得到真实 5 秒文件，并要求目录明确声明图片与视频引用能力，防止模型
静默忽略原片。生成仍保持显式提交，不因“完整闭环”变成自动扣费。

怎么验证的（命令 / 界面路径 / 结果）：已核对 `git status`、STATE、基础线台账、0.3.1 取证、
`VideoNode` 续写裁片路径、`official_media_models.json` 和模型提交守卫；尚未改业务代码。

## 已定下来的决策

- **融合前先生成真实 5 秒片段节点**——提示词里的秒数不是可审计媒体输入。
- **只信媒体目录显式能力**——缺 `supportedModes` 或图片/视频引用上限时禁用，不按品牌猜测。
- **裁片可自动执行、AI 生成不可自动执行**——本地 FFmpeg 不产生供应商费用，图片/视频生成继续
  由既有节点按钮逐次确认。
- **普通模式行为不变**——未打开融合时仍创建原三阶段链，避免功能升级破坏已验收路径。

## 待办

- [ ] 完成 pre-commit、DCO 拆分提交、推送、handoff 与释放锁。
- [ ] 有明确费用授权后另开工作线做供应商真实生成质量/费用验收。

## 阻塞

真实供应商最终生成仍受 `OSS_RELAY_AK` / `OSS_RELAY_SK` 缺失影响；本轮本地裁片与不计费工作流
创建不依赖该配置。

## 交接摘要

- **最后完成到**：本地不收费闭环、失败回滚、生产构建与真实画布刷新验收均完成。
- **下一步唯一动作**：完成 pre-commit、DCO 提交、推送和 guard 释放。
- **先读这些文件**：本台账、基础实现台账、`docs/guides/liblib-canvas-parity.md` 0.3.1。
- **不要动这些文件 / 决策**：不自动生成、不改源视频、不按模型名猜能力、不碰受保护资料。

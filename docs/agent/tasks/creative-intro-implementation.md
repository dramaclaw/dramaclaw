# 创意片头显式工作流

**状态**：执行中
**最后更新**：2026-09-19
**基线**：`093ca016`；`main` 与 `zhonggwv/main` 同步；仅三类受保护未跟踪资料
**认领者**：`codex/creative-intro-implementation-20260919`
**相关文档**：`docs/guides/liblib-canvas-parity.md`
**相关分支 / PR**：`main` ｜ 无

## 目标

在视频节点工具条提供创意片头入口：用户选择视频帧、片名、片名风格和动效风格后，不触发收费
任务，一次创建 `源视频 → 关键帧 → 片名设计图 → 5 秒片头动效` 的可追溯节点链。两个生成节点
沿用既有显式提交、失败恢复和模型能力选择。

## 非目标

- 本轮不自动提交图片或视频生成任务，不承诺供应商画质或费用。
- 不复制 LibTV 私有 agent、skill、模板图片或嵌套 `opening` payload。
- 原片 5 秒融合、文字/蒙版/图层结果编辑另行实现；本轮只交付基础两阶段链。

## 现状与证据

- `bb0bf189` 已固化竞品 UI/JS/网络证据和我方方案门。
- 已有 `captureVideoFrameBlob`、项目图片上传、`imageGenNode`、`videoNode` 和显式图边，可直接复用。
- `NodeActionToolbar.tsx` 是共享热点，动作身份应先登记到 `canvasActionRegistry.ts`。

## 写入边界

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md`、本台账、本线 claim | 协调 | 生命周期、范围和交接 |
| `frontend/src/features/canvas/application/canvasActionRegistry.ts` | 共享 | 登记稳定动作身份 |
| `frontend/src/features/canvas/application/creativeIntroWorkflow.ts` | 独占 | 纯提示词与节点编排逻辑 |
| `frontend/src/features/canvas/ui/CreativeIntroDialog.tsx` | 独占 | 选帧与样式配置界面 |
| `frontend/src/features/canvas/ui/NodeActionToolbar.tsx` | 共享 | 挂载视频工具条入口与弹窗 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | 三语用户文案，只合并新键 |
| `frontend/src/__tests__/features/canvas/creative-intro-workflow.test.ts` | 独占 | 节点链与提示词回归 |
| `frontend/src/__tests__/features/canvas/canvas-action-registry.test.ts` | 共享 | 更新视频动作注册表断言 |
| `docs/guides/liblib-canvas-parity.md` | 共享 | 把方案状态更新为已实现并记录边界 |
| 既有相关 claims | 协调 | 为共享动作表/工具条补互惠声明 |

## 协调与冲突

- **相关工作线**：`liblib-canvas-parity`、`canvas-audio-actions`、`canvas-audio-split`、`shot-breakdown`。
- **本地已有改动**：业务代码无 diff；`.playwright-cli/`、`_to_delete/`、`曹操.md` 禁止触碰。
- **远端重复实现**：没有发现创意片头同类实现；只复用现有节点和任务生命周期。
- **共享文件顺序**：动作表追加单一 descriptor；工具条只插入入口并挂载独立 Dialog；三语只增新键。

## 实施方案

1. 把提示词构建和四节点编排做成可注入依赖的应用层函数——完成条件：单测证明边方向、字段与
   选定样式，不依赖 React。
2. 实现符合 `DESIGN.md` 的选帧/片名/样式弹窗，确认时抓帧、上传并调用编排函数——完成条件：
   点击“创建工作流”只生成草稿节点，不发生成请求。
3. 挂载工具条、动作表和三语；跑聚焦测试、i18n 棘轮与生产构建——完成条件：类型和构建通过。

## 风险与回退

- **风险**：跨域视频无法客户端抓帧；远端 LibTV 媒体必须先本地化。生成节点的默认模型可能不支持
  目标模式，因此只写通用模式，由既有模型选择器继续做能力门控。
- **回退**：精确撤销本线新增组件/应用层文件和入口增量，不覆盖共享文件其它工作线内容。

## 验收标准

- [x] 聚焦 Vitest 覆盖三节点派生链、提示词和动作 descriptor。
- [x] 前端 i18n 棘轮与 `pnpm build` 通过。
- [x] 浏览器验证进入弹窗、拖动选帧、创建工作流且没有网络生成任务。
- [ ] handoff、pre-commit、DCO 提交与推送完成。

## 进展记录

### 2026-09-19 · 创意片头节点链实现并通过真实画布验收

做了什么：新增 `video.creativeIntro` 动作、选帧/片名/六类设计风格/六类动效风格弹窗和纯应用层
编排函数；确认后上传所选帧，创建 `exportImageNode → imageGenNode → videoNode`，写入片名设计与
5 秒动效提示词、阶段元数据和三条可持久化边；补齐中英越文案与 5 项聚焦测试。

为什么这么改（尤其是与原方案分叉的地方）：首轮浏览器验收使用 `uploadNode` 承载关键帧，刷新
后发现它没有 target handle，源视频到关键帧的边被连接规则拒绝，只剩两条边。随即改用既能承载
已上传图片、又允许上游连线的 `exportImageNode`；没有绕过全局建边规则，也没有修改 store。

怎么验证的（命令 / 界面路径 / 结果）：2 个 Vitest 文件共 5 项通过；前端 i18n 棘轮 0 命中；
`pnpm build` 完成 5424 个模块转换；本地真实画布点击“视频节点 → 创意片头”，填写标题并创建后，
任务中心保持空闲。刷新后本地画布 JSON 中第二条验收链仍有 3 个阶段节点、3 条顺序边，片名图
与动效提示词、`imageReference` 和 5 秒时长均持久化。验收在本地评审画布留下两组测试节点：
第一组记录了修复前的两条边，第二组是修复后的完整三条边；均未提交生成任务或消耗额度。

### 2026-09-19 · 方案门与范围建立

做了什么：从已完成 discovery 建立独立实现线，限定为不计费的配置与显式节点编排。

为什么这么做（尤其是与原方案分叉的地方）：基础链可以完整复用现有生成节点；原片融合涉及
异步裁片和图+视频模型能力，和基础链绑在同一提交会扩大失败面。

怎么验证的（命令 / 界面路径 / 结果）：已读 `DESIGN.md`、动作表、工具条、节点类型、抓帧和派生
节点实现；基线与远端同步，业务树无未解释 diff。

## 已定下来的决策

- **第一次确认只创建工作流，不自动生成**——每一次潜在费用都保留在既有节点的显式提交按钮。
- **不用新节点类型**——图片/视频中间产物已有完整生命周期，新类型只会复制任务与恢复逻辑。
- **源视频保持不变**——所有产物均为有边连接的下游节点。

## 待办

- [ ] 另开增强线实现“融入原片”：裁出固定 5 秒片段，并按模型目录能力接入图片+视频参考。
- [ ] 有明确费用授权后真实生成一张片名图和一段动效，验收供应商画质与费用。

## 阻塞

无。

## 交接摘要

- **最后完成到**：基础两阶段工作流已实现并通过刷新验收，未触发任何生成任务。
- **下一步唯一动作**：若继续对齐，另开“融入原片 5 秒片段”增强线并先审计模型能力。
- **先读这些文件**：本台账、`docs/guides/liblib-canvas-parity.md` 的 0.3.1。
- **不要动这些文件 / 决策**：不自动生成、不改源视频、不复制私有模板、不碰受保护未跟踪资料。

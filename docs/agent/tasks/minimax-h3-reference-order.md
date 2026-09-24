# MiniMax H3 模式选择与 Mixed 引用顺序

**状态**：执行中
**最后更新**：2026-09-24
**基线**：`46e88b1df6404716fc258e992a49c935a506b2bf`；`main` 相对 `zhonggwv/main` ahead 4；相关业务路径无本地 diff，仅有 3 类受保护未跟踪资料
**认领者**：`codex/minimax-h3-reference-order-20260924`
**相关文档**：`docs/guides/liblib-canvas-parity.md`、`docs/agent/tasks/minimax-h3-liblib-parity.md`（待从已完成分支集成）
**相关分支 / PR**：`main`；复用 `codex/minimax-h3-liblib-parity` 的提交 `0bb2410b`、`51573f75`

## 目标

把已验收的 MiniMax H3 工作台对接集成进当前主检出目录，并补齐 LibLib 同构的视频生成模式入口与
`{{Mixed N}}` 引用协议。引用缩略图可见顺序、提示词编号、前端 `references[]`、H3 上传顺序必须共用
同一份排序；H3 后端再把 Mixed 全局编号严格转换为 `<Picture N>` / `<Video N>` / `<Audio N>`。

## 非目标

- 不改变非 MiniMax H3 模型现有的 `@图片N / @视频N / @音频N` 协议。
- 不改变 H3 已实测的 stable-v1 / QuickUI 运输选择，不接 DOM 或 Gradio。
- 不改 Freezone 路由契约、数据库或其他画布节点。

## 现状与证据

- `codex/minimax-h3-liblib-parity` 已有四模式、严格参数合同和真实局域网出片证据，但尚未集成到 `main`。
- 当前视频面板已有模式下拉，但放在顶排；用户要求像 LibLib 一样在底部模型旁明确选择。
- 当前引用提示词按媒体类型分别编号，H3/LibLib 需要按缩略图混排顺序使用全局 `Mixed N`。
- `VideoNode.tsx` 提交侧已通过 `sortUpstreamByReferenceOrder` 按可视顺序构建 `references[]`；本轮保留该单一顺序源并补合同测试。
- 相关目标文件当前 `git diff` 为空；`origin/main` 无 H3 工作台同类实现，选择复用本地已验收分支而非重写。

## 写入边界

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md` | 协调 | 登记集成工作线与共享热点 |
| `docs/agent/tasks/minimax-h3-reference-order.md` | 协调 | 本轮方案、验证与交接 |
| `docs/agent/claims/minimax-h3-reference-order.toml` | 协调 | 机器可读认领 |
| `docs/agent/tasks/minimax-h3-liblib-parity.md` | 共享 | 记录原实现已集成及后续增强归属 |
| `docs/agent/claims/minimax-h3-liblib-parity.toml` | 共享 | 保留原分支范围并关闭执行态冲突 |
| `docs/agent/claims/{liblib-canvas-parity,depth-motion-da3,shot-breakdown}.toml` | 协调 | 为 `VideoNode.tsx` 补齐 mutual shared 关系 |
| `.env.example` | 独占 | 集成 H3 工作台环境变量说明 |
| `src/novelvideo/official_media_models.json` | 独占 | 集成 H3 四模式与真实参数目录 |
| `src/novelvideo/generators/minimax_h3_workbench.py` | 独占 | H3 工作台适配及 Mixed→typed tag 转换 |
| `src/novelvideo/generators/video_generator.py` | 独占 | 集成 H3 专用生成器选择 |
| `tests/test_minimax_h3_workbench.py` | 独占 | 参数、顺序、Mixed 转换回归 |
| `tests/test_model_gateway_settings.py` | 独占 | H3 目录合同回归 |
| `frontend/src/features/canvas/nodes/shared/minimaxH3GenerationDecision.ts` | 独占 | H3 四模式纯判定 |
| `frontend/src/features/canvas/nodes/shared/videoModelCapabilities.ts` | 独占 | H3 能力识别与默认模式 |
| `frontend/src/features/canvas/nodes/VideoOperationsPanel.tsx` | 独占 | 底部模式入口、Mixed 候选及全局序号 |
| `frontend/src/features/canvas/nodes/VideoNode.tsx` | 共享 | H3 Mixed 重排同步与有序提交 |
| `frontend/src/features/canvas/nodes/PromptMentionEditor.tsx` | 独占 | 支持候选自定义序列化 token |
| `frontend/src/features/canvas/nodes/referenceMentions.ts` | 独占 | Mixed token 删除/重排后的编号同步 |
| `frontend/src/features/canvas/nodes/useReferenceMentionSync.ts` | 独占 | Mixed 单一引用族同步 |
| `frontend/src/__tests__/features/canvas/minimax-h3-generation-decision.test.ts` | 独占 | H3 模式矩阵与 UI 合同 |
| `frontend/src/__tests__/features/canvas/reference-mentions.test.ts` | 独占 | Mixed 重排合同 |
| `frontend/src/__tests__/features/canvas/prompt-mention-audio.test.tsx` | 独占 | 自定义 token 序列化合同 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | 集成 H3 三语禁用原因，按 key 合并 |

## 协调与冲突

- **相关工作线**：原 `minimax-h3-liblib-parity` 已释放锁且停在待集成；本轮串行接手并在合入后标记原线完成。
- **本地已有改动**：目标业务路径无 diff；`.playwright-cli/`、`_to_delete/`、`曹操.md` 不归本线且不触碰。
- **远端重复实现**：`origin/main` 未含 H3 工作台；旧 CTA 分支基线更旧且无 H3 运输，放弃整文件移植。
- **共享文件顺序**：先合入已验收 H3 分支，手工解决 STATE/三语增量，再由本线独占追加 Mixed 协议；`VideoNode.tsx` 只做窄 hunk，不覆盖 LibLib/depth/shot 既有行为。

## 实施方案

1. 集成 `codex/minimax-h3-liblib-parity` 两个提交并解决协调文件冲突——完成条件：四模式、参数目录和工作台适配进入当前主线，原线标记已集成。
2. 将模式选择移动/补充到模型旁的底部参数区，保持能力过滤和禁用原因——完成条件：MiniMax H3 明确显示文生、全能参考、图生、首尾帧四项。
3. 建立 H3 `{{Mixed N}}` 协议——完成条件：缩略图全局序号、编辑器 token、重排同步和 `references[]` 均按同一节点顺序。
4. 在 H3 适配器把 Mixed 全局序号严格映射为类型标签并验证上传次序——完成条件：跨类型重排后语义仍指向同一素材，越界 token 直接报错。
5. 运行聚焦测试、生产构建、后端检查和本地栈浏览器验证——完成条件：UI 请求、后端最终 payload 与 H3 参数一一对应。

## 风险与回退

- **风险**：通用提示词编辑器的自定义 token 可能影响旧 `@图片N`；以 optional 字段实现，旧候选默认行为不变并补回归。
- **风险**：QuickUI 按媒体类型分槽，Mixed 是全局序号；后端必须基于原始有序列表转换为类型序号，不能在分组后猜测。
- **回退**：回退本线独立提交；不使用整树 reset/restore，不触碰受保护未跟踪资料。

## 验收标准

- [ ] H3/引用/提示词前端聚焦测试全绿。
- [ ] `uv run pytest tests/test_minimax_h3_workbench.py tests/test_model_gateway_settings.py` 全绿。
- [ ] `pnpm build`、前后端 i18n、ruff、agent guard 与 `git diff --check` 全绿。
- [ ] 真实画布中四模式可选，Mixed 1/2/3 与缩略图顺序一致；拖动后 prompt 和 H3 请求同步重排。
- [ ] 本轮改动全部在写入边界内，无未解释 diff；不记录真实局域网地址或凭据。

## 进展记录

### 2026-09-24 · 方案门完成

做了什么：核对当前 main、已释放锁的 H3 分支、现有引用排序与提交链，建立集成和 Mixed 协议的精确边界。

为什么这么做：H3 主实现已经过真实出片，不应在 main 重写；当前缺口集中在分支集成、模式入口位置和跨媒体全局编号。

怎么验证的：`git status` 仅有三类受保护未跟踪资料；目标路径 diff 为空；`agent_guard check/status` 无活动锁。

## 已定下来的决策

- **只对 MiniMax H3 使用 `{{Mixed N}}`。**——其他供应商仍依赖现有分类型 `@图片N` 协议。
- **Mixed N 按引用缩略图从左到右全局编号。**——这同时是 `references[]` 的顺序，禁止按媒体类型重新排序后再编号。
- **H3 后端负责 Mixed→类型标签转换。**——工作台按图/视/音分槽，转换必须基于分组前的原始顺序才能保持语义。
- **模式选择放在底部模型旁。**——与 LibLib 的主要操作路径一致，避免顶排“全能参考”被误认成参考筛选器。

## 待办

- [ ] 获取 guard 锁并集成 H3 分支。
- [ ] 实现底部模式与 Mixed 顺序协议。
- [ ] 完成聚焦/构建/真实画布验证并记录结果。

## 阻塞

无。

## 交接摘要

- **最后完成到**：方案门与分支差异审计完成，尚未写业务代码。
- **下一步唯一动作**：更新 claims 后 acquire/preflight，再合入 H3 分支。
- **先读这些文件**：本台账、原 H3 台账、`VideoOperationsPanel.tsx`、`VideoNode.tsx`、`minimax_h3_workbench.py`。
- **不要动这些文件 / 决策**：不改 Freezone 路由；不泄露工作台地址；非 H3 token 行为必须保持不变。

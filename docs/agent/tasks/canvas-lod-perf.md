# 画布 LOD 剔除与低缩放交互

**状态**：执行中
**最后更新**：2026-09-18
**基线**：`8fa08d14d96f8c98170e85983cc937752b073f97`；治理提交已落地，本线开始按补丁来源拆分
**相关文档**：无（前端视觉改动须先读 `DESIGN.md`）
**相关分支 / PR**：`08f8f410` 是旧树上的替代方案；当前实现继承已合入主线的 `1fa4b558`，不能整分支覆盖

## 目标

画布节点多时不卡：低缩放下用简化外壳替代完整节点，配套的交互（音频播放、外部文件拖入、
图片变体、视频抽帧封面）在简化态下仍可用。

## 非目标

- 不借性能优化重做节点视觉、数据模型或视频再创作工具条。
- 在来源审计完成前不继续扩展 LOD 功能，也不把远端分支整段覆盖到当前工作区。

## 写入边界（既有改动归属）

| 文件 | 新增/修改 | 作用 |
|---|---|---|
| `features/canvas/application/canvasLod.ts` | 修改 | LOD 判定 |
| `features/canvas/nodes/LodShellNode.tsx` | 修改 | 简化外壳节点 |
| `features/canvas/Canvas.tsx` | 修改 | |
| `features/canvas/application/videoFrameCapture.ts` | 修改 | 视频抽帧封面 |
| `features/canvas/application/imageData.ts`、`graphImageResolver.ts`、`graphContentResolver.ts`、`videoTranscode.ts` | 修改 | |
| `features/canvas/ui/CanvasNodeImage.tsx`、`nodeFrameStyles.ts`、`NodeHeader.tsx`、`NodeGenerationOverlay.tsx`、`NodeToolDialog.tsx`、`AssetCommitHandle.tsx`、`CanvasHistoryAssetsModal.tsx` | 修改 | |
| `features/canvas/nodes/{GroupNode,ImageGenNode,SkillNode,ThreeDWorldNode,UploadNode}.tsx` | 修改 | |
| `features/viewer-kit/three-d/ThreeDDirectorDialogLazy.tsx` | 新增 | 三维对话框懒加载 |
| `__tests__/features/canvas/{canvas-lod,lod-audio-playback,external-file-handoff-low-zoom,node-body-image-variant,video-frame-capture-poster,asset-replace-pick}.test.*` | 修改/新增 | |

上述路径以 `frontend/src/` 为根。新增的 LOD 模块与测试可视为本线独占；`Canvas.tsx`、`index.css`、
`imageData.ts`、`useCanvasSync.ts`、`LodShellNode.tsx`、`AssetCommitHandle.tsx` 等是共享热点，不能并行写。

## 协调与冲突

- `origin/perf/canvas-pan-lod-culling` 相对本地基线只改 4 个文件：`Canvas.tsx`、`imageData.ts`、
  `useCanvasSync.ts`、`index.css`；这 4 个文件当前也全部为本地脏文件。
- `LodShellNode.tsx`、`Canvas.tsx`、`index.css`、`AssetCommitHandle.tsx` 同时被远端
  `origin/feat/canvas-video-reshoot-breakdown` 触及，且本地 LibTV 线也改画布热点。
- 下一步必须先按函数 / 测试比较本地与远端 LOD，不以提交时间或整文件 diff 直接选一份。
  审计完成前，这条线只允许只读分析和性能测量，不再写共享热点。

## 实施方案（后续）

1. 对比远端 LOD 提交 `08f8f410` 与本地 4 个重叠文件，列出相同、仅远端、仅本地行为。
2. 用现有单测确认哪份实现覆盖低缩放交互；决定复用远端提交还是保留本地增量，并记录理由。
3. 在同一浏览器、同一节点数据下采集 LOD 开 / 关的帧率和首屏时间，再决定是否收线。

## 风险与回退

- 最大风险是为了“用远端已有实现”而整文件覆盖，丢掉 LibTV 与其他画布改动。
- 回退只能按本线的独立提交撤销；在拆提交前禁止对共享文件执行 restore。

## 进展记录

### 2026-09-18 · 完成远端来源审计并开始拆分可恢复提交

做了什么：刷新 `origin` 后改用 `git show 08f8f410` 审计单提交补丁，而不是比较该旧分支整棵树；
确认它只改 `Canvas.tsx`、`imageData.ts`、`useCanvasSync.ts`、`index.css`，实现的是 CSS 隐藏式 LOD。
本地则是在已合入 `origin/main` 的 `1fa4b558` 外壳式 LOD 上增加滞回单一真值、文本外壳和低缩放回归。

为什么这么做：`origin/perf/canvas-pan-lod-culling` 基于旧提交 `52c76913`，直接做分支树 diff 会出现数百个
无关文件并诱导整树覆盖。两份方案不是同一补丁副本；当前外壳方案已有主线历史和更多交互保护，应保留本地增量。
同时发现现有 LOD scope 过粗：部分文件实际是 Liblib 远端媒体、视觉对齐、素材替换或 bundle 懒加载，
本轮只提交可独立识别的 LOD 核心，混合文件按 hunk 拆分并继续留在对应工作线。

怎么验证的：`pnpm exec vitest run` 精确执行 6 个相关文件 → `6 passed / 79 passed`；误用
`pnpm test -- ...` 时脚本忽略文件参数并跑了全量，结果 `424 passed / 2 failed`、`3112 passed / 6 failed`，
失败集中在 `local-storage-quota.test.ts` 与 `queries/ingest.test.tsx`，与本线目标文件无关，已如实保留为全局基线问题。

### 2026-09-18 · 补齐来源审计门与机器 scope

做了什么：只更新本台账和 `docs/agent/claims/canvas-lod-perf.toml`，声明 LOD 文件范围与
`Canvas.tsx` 的共享关系；没有修改 LOD 业务代码。

为什么这么做：远端已有同类提交，先锁定来源审计顺序，避免下一任 AI 直接覆盖四个重叠文件。

怎么验证的：待全局 `agent_guard check` 通过后补最终结果；业务功能本轮未验证。

## 已定下来的决策

- **远端 / 本地行为审计完成前，共享热点只读**——文件时间和提交时间都不足以证明哪份实现应保留。
- **性能线必须有量化前后对比才能完成**——单测只能证明兼容性，不能证明性能收益。
- **不移植 `08f8f410` 的 CSS 隐藏式方案**——当前代码已经继承主线 `1fa4b558` 的外壳式 LOD；
  前者基于旧树且会重新引入整节点 DOM，只保留其历史量化数据作为设计证据。
- **混合文件按 hunk 提交**——`Canvas.tsx`、`LodShellNode.tsx`、`index.css` 同时含 Liblib/素材替换增量，
  不得以“LOD 文件”名义整文件暂存。

## 待办

- [ ] **先核对和 `origin/perf/canvas-pan-lod-culling` 的关系**：是同一批改动的两个副本，
      还是工作区这份更新？搞错会白干或覆盖。
- [ ] 补一组量化数据：N 个节点时的帧率 / 首屏时间，LOD 开与关各一次。
      现在只有「应该更快」，没有「快多少」，无法判断这条线能不能收。
- [ ] 前端视觉改动须对齐 `DESIGN.md`；`frontend/src/index.css` 也改了，
      如变量有变动需同 commit 更新 `DESIGN.md` 并保持 `npx @google/design.md lint DESIGN.md` 0 错误

## 阻塞

无。

## 验收标准

- `cd frontend && pnpm test` 全绿，`pnpm build`（含 tsc 类型检查）通过。
- 低缩放下音频仍能播、外部文件仍能拖入、图片变体仍能切。
- 有一组前后对比的帧率数据写进本台账。

## 交接摘要

- **最后完成到**：本地代码与单测已存在，尚无量化数据，且来源未审计。
- **下一步唯一动作**：对 `08f8f410` 与本地 4 个重叠文件做行为级差异表。
- **先读这些文件**：`canvasLod.ts`、`Canvas.tsx`、对应 LOD 测试、远端提交。
- **不要动这些文件 / 决策**：审计前不要覆盖 `Canvas.tsx` / `index.css` 等共享热点。

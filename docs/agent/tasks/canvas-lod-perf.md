# 画布 LOD 剔除与低缩放交互

**状态**：待验收
**最后更新**：2026-09-18
**基线**：`38484897`；本地未提交；与 `origin/perf/canvas-pan-lod-culling` 存在重复实现
**相关文档**：无（前端视觉改动须先读 `DESIGN.md`）
**相关分支 / PR**：远端有 `origin/perf/canvas-pan-lod-culling`，与工作区改动的关系未核对

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

### 2026-09-18 · 补齐来源审计门与机器 scope

做了什么：只更新本台账和 `docs/agent/claims/canvas-lod-perf.toml`，声明 LOD 文件范围与
`Canvas.tsx` 的共享关系；没有修改 LOD 业务代码。

为什么这么做：远端已有同类提交，先锁定来源审计顺序，避免下一任 AI 直接覆盖四个重叠文件。

怎么验证的：待全局 `agent_guard check` 通过后补最终结果；业务功能本轮未验证。

## 已定下来的决策

- **远端 / 本地行为审计完成前，共享热点只读**——文件时间和提交时间都不足以证明哪份实现应保留。
- **性能线必须有量化前后对比才能完成**——单测只能证明兼容性，不能证明性能收益。

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

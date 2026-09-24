# Freezone 项目入口恢复

**状态**：待验收
**最后更新**：2026-09-19
**基线**：`b795415b`；`main` 相对 `zhonggwv/main` ahead 4；已有未提交入口修复差异
**认领者**：codex/20260919
**相关文档**：无
**相关分支 / PR**：无

## 目标

进入项目画布时只选择该项目真实存在的画布；不存在的深链应明确报错，新个人画布仍能按需创建。

## 非目标

- 不改变画布数据格式或删除历史画布。
- 不将跨项目的 localStorage 画布 id 视为合法落点。

## 现状与证据

- 个人画布 id 仅由用户名生成，跨项目相同；未创建时旧路由会打开空白落点，造成“内容丢失”的错觉。
- 后端已将不存在画布改为 404，前端 hydrate 需保留首次个人画布的按需创建语义。

## 写入边界

| 路径 | 模式 | 作用 |
|---|---|---|
| `frontend/src/features/freezone/projections.ts` | 独占 | 按实际画布列表选择默认落点 |
| `frontend/src/features/freezone/useCanvasSync.ts` | 独占 | 将首次个人画布的 404 归一为空画布 |
| `frontend/src/routes/_app/projects.$project/freezone.lazy.tsx` | 独占 | 查询、校验和呈现不存在深链 |
| `frontend/src/__tests__/features/freezone/projections.test.ts` | 独占 | 落点选择回归 |
| `frontend/src/__tests__/lib/freezone-url.test.ts` | 独占 | 明确项目画布 URL 契约 |

## 协调与冲突

- 从 `legacy-unassigned-diff` 迁移入口相关历史差异；`useCanvasSync.ts` 同时曾被 LOD 认领，但本次只处理 hydrate 404 语义，不触碰 LOD 投影。
- 不触碰 `freezone.py` 的本地模型目录排序，该 hunk 归 local-stack。

## 实施方案

1. 在路由加载项目画布列表；完成条件：无显式画布时选择真实的个人或最近画布。
2. 对无效深链显示可返回项目的状态；完成条件：不再渲染误导性的空白画布。
3. 添加 helper / URL 回归测试并跑前端类型构建。

## 风险与回退

- 风险：错误把新个人画布当成缺失深链而阻止首次使用。
- 回退：仅撤回该工作线提交，保留画布数据与其他未提交工作线。

## 验收标准

- [ ] `pnpm exec vitest run src/__tests__/features/freezone/projections.test.ts src/__tests__/lib/freezone-url.test.ts` 通过。
- [ ] `pnpm exec tsc -b && pnpm build` 通过。
- [ ] 手工：跨项目进入、无效深链、首次个人画布三种路径行为正确。

## 进展记录

### 2026-09-19 · 从隔离区归属入口恢复差异

做了什么：归属项目画布列表选择、404 首次落点处理、无效深链提示与 URL 测试；为最近已修改画布补回归断言。

为什么这么做：这组 diff 共享“避免进入错误空画布”的单一用户问题，且不与本地路由模型目录排序混合。

怎么验证的：`pnpm exec vitest run src/__tests__/features/freezone/projections.test.ts src/__tests__/lib/freezone-url.test.ts`
为 30 passed；`pnpm exec tsc -b && pnpm build` 通过，前端 i18n 棘轮为 0 命中。三条真实浏览器入口路径仍待验收。

## 已定下来的决策

- **显式 URL 深链优先**——只有确认该画布不在本项目且不是首次个人画布时才阻止渲染。
- **没有个人画布时优先最近真实非 default 画布**——避免跨项目同名个人 id 生成空白错觉。

## 待办

- [x] 跑聚焦测试与构建，更新状态。

## 阻塞

无。

## 交接摘要

- **最后完成到**：入口修复已通过聚焦回归、类型检查和构建，等待独立提交与浏览器验收。
- **下一步唯一动作**：在真实浏览器验证跨项目进入、无效深链与首次个人画布三条路径。
- **先读这些文件**：`projections.ts`、`freezone.lazy.tsx`、`useCanvasSync.ts`。
- **不要动这些文件 / 决策**：不要把不存在深链静默渲染为空白画布。

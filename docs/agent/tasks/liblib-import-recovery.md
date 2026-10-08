# LibTV 大画布导入与首次打开恢复

**状态**：待验收
**最后更新**：2026-09-27
**基线**：`4c9dee4`；主工作区串行集成；原 canvas-lod-perf 已正常释放锁。
**认领者**：`codex/liblib-repair-20260927`
**相关文档**：无
**相关分支 / PR**：无

## 目标
修复首页大画布导入中断后的“画布不存在”，恢复用户指定项目，并保证新个人画布和已有项目首次导入正常。

## 非目标
不调整布局、模型、权限、素材安全策略或其他工作区性能修改。

## 现状与证据
- 源分享读取成功：208 节点、139 连线；本地项目只有 default，导入画布尚未保存。
- 首次导入媒体缓存达 187 文件、约 553 MB，耗时接近 10 分钟；缺少整体截止时间，每批慢素材可持续阻塞超过客户端 10 分钟超时。历史请求没有完成日志，具体中断方式无法从现有日志确认。
- hydrate 与项目内导入只处理 ApiError，但真实结构化 404 由 errorFromBackendBody 转成 BackendStatusError，导致新个人画布误报失败。
- 拟改业务文件在主工作区无 diff；独立工作区从 HEAD 创建，没有复制其他未提交改动。origin/main 无下载器同类变化；hydrate 缺少本地 404 兼容段，采用当前已提交语义，非另写实现。

## 写入边界
- `frontend/src/features/freezone/createProjectLiblibImport.ts`：共享。
- `frontend/src/features/freezone/CanvasesTab.tsx`：共享。
- `frontend/src/features/freezone/CanvasLocalizeAssetsButton.tsx`：共享。
- `frontend/src/features/freezone/FreezoneShell.tsx`：共享。
- `frontend/src/features/freezone/useCanvasSync.ts`：共享。
- `frontend/src/features/freezone/liblibBackgroundLocalization.ts`：独占。
- `frontend/src/features/canvas/domain/canvasRemoteMedia.ts`：共享。
- `frontend/src/__tests__/features/freezone/use-canvas-sync.test.tsx`：独占。
- `frontend/src/__tests__/features/freezone/liblib-background-localization.test.tsx`：独占。
- `frontend/src/__tests__/features/freezone/liblib-project-import.test.ts`：独占。
- `frontend/src/__tests__/canvas-remote-media-localize.test.ts`：共享。
- `frontend/public/locales/zh/translation.json`：共享。
- `frontend/public/locales/en/translation.json`：共享。
- `frontend/public/locales/vi/translation.json`：共享。

- 用户已建空项目的目标导入画布：仅通过正常 API 创建并回读，不覆盖已有用户节点。

## 协调与冲突
主工作区原写锁已释放。业务路径无 diff；保留全部性能修改。各原归属线已补双向共享声明，当前会话串行集成。

## 实施方案
用户明确要求节点先创建、素材后台下载，替代先等素材的旧方案：
1. 首页和项目内导入只读取图，立即转换并保存远端素材节点，标注自动本地化并进入画布。
2. 画布 hydrate 成功后自动分批下载，每批完成用最新节点数据替换命中 URL 并保存；不覆盖期间编辑，不将结果写到其他画布。
3. 离开页面停止安排后续批次，已完成结果保存；下次进入根据剩余远端 URL 继续，缓存复用。失败保留远端、可手动重试。
4. 只本地化使用中的素材及引用，保留来源 URL；支持 BackendStatusError 的首次 404。
5. 聚焦回归、类型检查、三语检查；恢复既有空项目并核对节点、连线、素材。

## 风险与回退
后台下载依附打开的画布，离开后再次进入续传；单批失败不会阻止使用，保留素材缓存。回退只撤本线精确 hunks，保留用户数据和其他线改动。后端安全校验不改。

## 验收标准
- [x] 导入保存不等待素材下载；首页和项目内入口一致。
- [x] 分批进度、编辑保留、画布切换隔离、失败重试、继续下载回归通过。
- [x] 真实结构化 404 可首次创建；其他错误仍报错。
- [x] 类型和翻译检查通过；用户项目回读 208 节点、139 连线。
- [ ] 浏览器人工打开画布最终验收；Chrome 扩展 UI 阻止自动化。

## 进展记录
### 2026-09-27 · 按用户要求提交本次修复
- 用户明确要求提交。与 canvas-lod-perf 完成串行交接后取得提交窗口，只提交本线 14 个业务/测试/翻译文件及对应协调记录；共享台账与 scope 仅选择本线差异，保留性能线全部未提交内容。
- 沿用已通过的 89 项回归、类型检查、三语检查及真实画布恢复结果；提交前核对暂存范围、协调记录一致性、敏感信息与差异格式。提交使用 DCO 签署，不推送远端。
- 页面人工确认仍待验收，不因提交代码改写验收事实。

### 2026-09-27 · 分阶段导入和用户画布恢复完成
- 两个导入入口改为 `download_assets=false`，立即保存远端节点与 `background_localize` 标记。进入画布、hydrate 完成后自动按 4 URL 一批后台本地化，每批通过现有保存协调器 flush，不等全量结束。
- 下载结果只替换最新节点中命中的地址；保留下载期间提示词/替换素材/删除节点等编辑。组件以项目/画布/导入版本隔离，离开后不提交迟到结果，再次进入只处理剩余远端素材。失败继续下一批，鉴权/项目不存在错误停止。
- 本地化引用与 importedLocalUrl 基线，同时保留 sourceUrl 来源；先前失败原因不被后续批次抹掉。
- hydrate 与项目内首次导入兼容真实 `BackendStatusError` 404；保留 403 错误。新增中英越下载进度文案。
- `node node_modules/vitest/vitest.mjs run`（8 个聚焦文件：liblib-project-import、liblib-background-localization、canvas-remote-media-localize、use-canvas-sync、liblib-canvas-import、project-first-liblib-import、canvases-tab-create-limit、canvases-tab-query）：89 passed。
- `node node_modules/typescript/bin/tsc -b`：退出 0；`scripts/check_frontend_i18n.py`：0 命中；`git diff --check` 与 `agent_guard check`：通过。
- 已复用用户空项目，真实应用 importer 在 4.286 秒内首次保存 revision 1，208 节点、139 连线。随后用真实本地化 API 验证 4 条素材，再用真实 React 后台控件 + useCanvasSync + 实际本地服务完整运行：剩余 184 条在缓存复用下 7.205 秒完成，revision 48、status ready、远端待下载 0。8 条素材 Range GET 全为 206。
- 诊断脚本与结果只留 gitignored 本机运行目录；未新增重复项目、未覆盖性能工作线改动、未重启服务。前端 Vite 会加载修复。
- 尚未通过实际浏览器点击验收（Chrome 扩展 UI 阻挡），不把组件/API 集成测试写成真实浏览器验收。源码与用户数据已修复，不需要重新导入。

### 2026-09-27 · 按用户要求调整为节点先保存
用户要求明确，采用现有本地化 API 的分批后台调用与现有 revision 保存，不添加第二套存储协议。独立工作区仅方案文档，主工作区释放锁后串行实现。原大画布媒体请求已下载约 553 MB 而未保存图；真实结构化 404 类型与旧 catch 不匹配已确认。

## 已定下来的决策
节点先落盘，素材下载不阻塞进入；增量替换 URL、不重新导入覆盖；失败可继续使用远端并重试。

## 待办
- [x] 补回归、实现、检查、恢复用户项目。
- [ ] 用户刷新后在页面确认画布显示；通过后归档。

## 阻塞
Chrome 扩展 UI 阻止自动化；采用应用组件测试和真实 API 验证。

## 交接摘要
- **最后完成到**：代码、89 项测试、类型/三语检查及真实画布/素材恢复。
- **下一步唯一动作**：刷新用户画布确认页面显示；通过后归档，不再次导入覆盖。
- **先读这些文件**：本台账。
- **不要动这些文件 / 决策**：其他线性能差异与用户既有节点。

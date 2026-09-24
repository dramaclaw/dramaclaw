# 同步 origin/main 与 zhonggwv/main

**状态**：执行中
**最后更新**：2026-09-24
**基线**：`79171bc6`（方案锚点）；集成分支 `codex/sync-main-remotes` 正在合并 `origin/main`；4 个文本冲突已解决，完整回归正在收敛语义合并缺口
**认领者**：`codex/sync-main-remotes-20260924`
**相关文档**：`docs/agent/README.md`
**相关分支 / PR**：`codex/sync-main-remotes`；PR 待创建（仅当上游 main 禁止直接推送）

## 目标

把 `origin/main` 与 `zhonggwv/main` 的两条分叉历史合并为同一个提交：保留上游 29 个独有提交、
保留 fork 50 个独有提交，解决交叉热点后验证，并最终让两个远端的 `main` 指向完全相同的 SHA。

## 非目标

- 不通过 force push、rebase 或 squash 改写任一远端既有历史。
- 不借同步顺手重构、改产品取舍或清理主工作区受保护资料。
- 不把另一台机器的运行配置、密钥、数据库或生成产物提交到 Git。

## 现状与证据

- GitHub 实际分支头：`zhonggwv/main=e7b1fbce`，`origin/main=f51c2e44`；共同祖先为 `38484897`。
- `origin/main` 自共同祖先修改 138 个路径，`zhonggwv/main` 修改 229 个路径，其中 24 个路径重叠。
- `git merge-tree --write-tree --name-only --messages zhonggwv/main origin/main` 只报告 4 个真实内容冲突：
  越南语翻译、视频节点、视频能力规则、画布 home-node guard 测试；其余上游路径可自动三方合并。
- 当前任务位于独立、干净 worktree；原 `main` 的 `.playwright-cli/`、`_to_delete/`、`曹操.md` 和活动取证台账未复制进来。
- 图2所需 H3 提交 `0bb2410b`、`51573f75`、`ec79e9fe` 均在 fork 历史；上游的付款、媒体归档、引用校验和视频续写提交均在 `origin/main` 历史。

## 写入边界

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md` | 协调 | 登记全局集成工作线与冲突顺序 |
| `docs/agent/tasks/sync-main-remotes.md` | 协调 | 方案、验证与双远端交接 |
| `docs/agent/claims/sync-main-remotes.toml` | 协调 | 机器可读的精确合并范围 |
| `frontend/public/locales/vi/translation.json` | 共享 | 按 key 同时保留 fork 功能和上游新增文案 |
| `frontend/src/features/canvas/nodes/VideoNode.tsx` | 共享 | 合并 H3/Mixed、LibTV/拉片与上游引用校验/续写行为 |
| `frontend/src/features/canvas/nodes/shared/videoModelCapabilities.ts` | 独占 | 合并 H3 模式矩阵与上游引用校验规则 |
| `tests/test_freezone_canvas_route_home_node_guard.py` | 共享 | 保留 fork 路由数量断言并接入上游新路由 |
| `scripts/check_env_config.py` | 独占 | 登记 fork 已提交但未进入公共模板的可选本地运行变量 |
| `license-inventory.csv` | 独占 | 按合并后的 Git 索引重生成许可证路径清单 |
| `src/novelvideo/agents/story_writer.py` | 共享 | 把 fork agent 接到上游新增的 agent 专用能力标签 |
| `src/novelvideo/freezone/history.py` | 共享 | 修正 fork 全档位缩略图预热实现遗留的旧 docstring |
| `src/novelvideo/media_archive_copy.py` | 独占 | 让上游归档端口降级逻辑兼容测试/开发态模块热重载 |
| `frontend/src/features/canvas/nodes/PromptMentionEditor.tsx` | 独占 | 避免 H3 候选签名刷新抢先销毁素材替换等待中的 chip |
| `tests/test_media_thumbnails.py` | 独占 | 让上游测试断言匹配 fork 已交付的全档位缩略图预热策略 |
| `tests/test_task_payload_projection.py` | 独占 | 按合并后的 22 个 freezone runner 更新完整集合哨兵 |
| `tests/test_task_runner_home_node_placement.py` | 共享 | 纳入 fork 的自包含音频变换任务 |
| `assets/readme/{GENERATION,REVISION-NOTES}.md` | 独占 | 删除上游新增文件的多余 EOF 空行，满足 diff/pre-commit 格式门禁 |
| `origin/main` 其余 134 个精确路径 | 只读导入 | 精确列表见同名 claim；只接受 Git 三方自动结果，不手工改写 |
| 相关既有任务台账 / claim | 协调 | 为上述两个共享热点声明最终集成顺序，不改变原任务所有权 |

## 协调与冲突

- **相关工作线**：`liblib-canvas-parity`、`depth-motion-da3`、`shot-breakdown`、`legacy-unassigned-diff`、已完成的 H3 工作线。
- **本地已有改动**：隔离 worktree 无业务 diff；主工作区本地资料不进入本次合并。
- **远端重复实现**：两边不是简单重复。fork 含 H3、音频动作、LibTV、Depth、story/local stack；上游含付款、引用校验、媒体归档与视频续写。本轮使用真实 merge 保留两边提交，不挑一边整文件覆盖。
- **共享文件顺序**：已有工作线提交在前；本线是唯一最终集成者，只解决三方合并报告的 4 个冲突。`VideoNode.tsx` 必须同时保留 Mixed 顺序和上游引用校验/续写；home-node 测试以合并后真实路由表为准；翻译只按 key 合并。

## 实施方案

1. 完成台账、精确 claim、互认共享范围并取得隔离 worktree 锁——完成条件：guard check/acquire/preflight 全绿。
2. 以 `zhonggwv/main` 为第一父提交合并 `origin/main`，仅手工解决 merge-tree 报告的 4 个冲突——完成条件：无冲突标记、无超范围手工改动、两边提交均为祖先。
3. 先跑冲突文件聚焦测试，再跑前端构建、后端默认测试与仓库门禁——完成条件：新增集成回归全绿；存量/环境失败明确记录。
4. 生成带 DCO 的非快进合并提交；优先直接推送 `origin/main`，若分支保护拒绝则推集成分支、创建并合并 PR——完成条件：`origin/main` 接受包含双方历史的最终提交。
5. 把同一个最终 SHA 快进推送到 `zhonggwv/main`，重新 `ls-remote` 核对——完成条件：两个远端 `refs/heads/main` 完全相同。

## 风险与回退

- **风险**：24 个双边修改热点虽只有 4 个文本冲突，自动合并仍可能产生语义冲突；必须用相关测试和构建验证，不能以“无冲突标记”等同正确。
- **风险**：上游分支保护可能禁止直接推送；改走 PR 后 GitHub 可能生成额外 merge commit，届时以 origin 最终 SHA 为准再同步 fork。
- **回退**：在推远端前删除隔离集成分支即可；推送后仅使用新的显式 revert 提交，不改写任一 main 历史。

## 验收标准

- [x] H3/Mixed、引用校验、视频能力和 home-node 聚焦测试全绿。
- [x] `cd frontend && pnpm build`、`uv run ruff check .`、前后端 i18n、CE 端口闭合与 agent guard 全绿。
- [x] `uv run pytest` 默认测试集通过；前端完整 Vitest 也在声明的 Node 22 运行时全绿。
- [ ] `git merge-base --is-ancestor` 证明原两个 main 均为最终提交祖先。
- [ ] 两次远端 `ls-remote` 返回相同 main SHA。
- [x] 本轮改动全部在写入边界内，无未解释 diff；提交前 diff 格式与 guard 已通过。

## 进展记录

### 2026-09-24 · 合并实现与全量验证完成，等待双远端推送

做了什么：保留两边全部历史并解决 4 个文本冲突、视频引用 `nodeId`、环境变量/许可证/runner 合同、
缩略图全档位断言、story agent 能力、可选归档端口热重载以及 H3 候选刷新与素材替换的 effect 顺序。
上游两个 README 生成说明文件的多余 EOF 空行也已格式化；没有改写任一分支历史。

为什么这么改：文本三方合并不能发现类型、effect 时序、测试集合和模块热重载这类语义冲突；这些问题均由
构建或完整测试复现，并按现有产品行为/仓库模式做最小修复。当前机器默认 Node 25 会额外启用实验性
WebStorage，因此前端全量验证按仓库声明改用临时 Node 22 + pnpm 11.5.0。

怎么验证的：后端 `4710 passed, 20 skipped, 2 deselected`；前端 `442` files / `3251 passed`；
生产构建通过（5437 modules）；完整 Ruff、CE 端口闭合、前后端 i18n、违禁词和 EE 词门禁均通过；
聚焦 H3/引用/视频能力 161 passed，聚焦后端 194 passed / 1 skipped，语义修复回归 159 passed。

### 2026-09-24 · 完整回归扩展出语义集成点

做了什么：生产前端构建通过；默认后端测试跑到 4697 passed、20 skipped，并把失败收敛为 11 个。
其中 2 个 Gunicorn/SSE 用例单跑确认是受沙箱禁止绑定本地端口影响；其余 9 个来自两边各自新增合同在
合并后需要对齐：本地环境变量登记、缩略图全档位策略、许可证索引、agent 能力、runner 总数和
placement-free 白名单。首次修复后完整套件只剩 2 个顺序相关失败：前序契约测试重载端口注册模块，
媒体归档复制仍缓存旧异常类，导致本应降级的“端口未注册”穿透。
前端完整套件另发现 H3 新增的候选签名重建会先于既有素材替换 effect 执行，令等待中的 chip 引用失效；
该用例与 Node 版本无关，是合并后必须修复的真实交互回归。

为什么扩范围：这些文件没有文本冲突，但上游新测试会读取 fork 新增实现，属于真实的三方语义冲突；
只解决 4 个冲突标记会把一个已知红色的 main 推到两个远端。归档端口异常按仓库其他可选端口的既有
类名兼容模式收敛；所有新增写入均限制为合同对齐或机械重生成，不改变产品行为。

怎么验证的：失败列表已由 `.pytest_cache/v/cache/lastfailed` 与逐文件复跑核对；新增精确路径写入 claim，
与 story/depth/shot 台账互认后重新 preflight，再实施修改。

### 2026-09-24 · 构建暴露引用节点标识的语义合并缺口

做了什么：真实 merge 按预演只产生 4 个文本冲突，均已按双方语义解决；后端聚焦测试 194 passed、
1 skipped，前端聚焦测试 161 passed。生产 TypeScript 构建进一步发现视频编辑源片的时长校验对象
缺少上游新增的必填 `nodeId`。

为什么分叉：`VideoNode.tsx` 的三方自动合并把上游引用校验函数签名与 fork 的视频编辑分支拼在一起，
文本上无冲突但类型合同已变化。该路径属于已认领冲突文件，决定让源片校验携带真实上游节点 id；
找不到上游节点时退回当前视频节点 id，确保校验弹窗的“定位节点”始终有有效目标。

怎么验证的：冲突标记已清零，越南语 JSON 可解析，`git diff --check` 对手工冲突文件通过；
待补 `nodeId` 后重新运行生产构建与完整测试。

### 2026-09-24 · 方案门完成

做了什么：从最新 `origin/main` 建隔离 worktree，随后以 fork 主线建立 `codex/sync-main-remotes`；
读取 STATE/协作手册、更新两个远端引用，并用 merge-tree 完成 138/229 路径与 4 个真实冲突的审计。

为什么这么做：当前主工作区有受保护本地资料和另一条活动工作线；直接 pull/rebase 或把 fork 强推到
上游都会覆盖历史。独立 merge commit 是唯一能同时保留双方提交、又让两个 main 最终同 SHA 的路径。

怎么验证的：隔离 worktree `git status` 干净，`agent_guard check` 为 `OK: 16 workstreams, 342 claims`；
`git merge-tree` 只报告 4 个内容冲突，尚未执行真实 merge 或测试。

## 已定下来的决策

- **最终两个 main 必须同 SHA。**——用户明确要求两个分支保持一致，不能只把 H3 单独 cherry-pick 到上游。
- **保留双方历史，用 merge 不用 force/rebase。**——两边都有独有且有价值的已发布提交。
- **自动合并路径只读导入，手工判断只限 4 个冲突文件。**——降低无关格式化和主观改写风险。
- **若上游受保护，以 origin 合入后的最终 SHA 为权威再同步 fork。**——PR 合并可能产生新的服务端提交。

## 待办

- [x] 完成 claim 与共享互认后 acquire/preflight。
- [x] 执行合并、解决文本与语义冲突并完成全量验证。
- [ ] 推送 origin/main，再把同一 SHA 推送到 zhonggwv/main。

## 阻塞

无；若上游 main 分支保护拒绝直接推送，按方案改走 PR。

## 交接摘要

- **最后完成到**：双远端与冲突审计完成，隔离分支已建立，尚未真实合并。
- **下一步唯一动作**：生成精确 claim、补共享互认，运行 guard acquire/preflight。
- **先读这些文件**：本台账、`docs/agent/STATE.md`、merge-tree 报告的 4 个冲突文件。
- **不要动这些文件 / 决策**：不强推、不 rebase、不把主工作区未跟踪资料复制进来；只手工解决 4 个冲突。

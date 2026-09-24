# MiniMax H3 视频节点与 LibLib 参数 / 模式对齐

**状态**：待验收
**最后更新**：2026-09-23
**基线**：`45130dfd849d956cc6c3e2e7e0bbf25c6ea90f8d`；分支 `codex/minimax-h3-liblib-parity` 从当前 `main` 干净提交建立；独立 worktree 无业务脏文件
**认领者**：`codex/minimax-h3-liblib-parity-20260923`
**相关文档**：`docs/guides/liblib-canvas-parity.md`、`docs/guides/canvas-architecture.md`
**相关分支 / PR**：`codex/minimax-h3-liblib-parity`

## 目标

只针对 MiniMax H3，把青蛙画布视频节点对齐 LibLib 的四个用户模式（文生视频、图生视频、
首尾帧、全能参考）及自适应比例、768P/2K、5–15 秒、1/2/4 条生成参数；模式、素材数量、
提交适配使用同一套纯判定，禁止静默丢弃已连接素材。配置本地 H3 工作台地址后，现有生成任务
链可上传图片/视频/音频并调用工作台 HTTP 接口，最终把视频下载回项目静态目录。无素材的
T2V 使用稳定 `/api/v1`；带引用的 I2V/R2V 暂用同版本网页实际调用的
`/quickui-studio/api`，直到工作台修复 v1 素材解析。

完成标准：H3 纯规则与适配器聚焦测试通过，前端构建与相关后端测试通过；在用户指定的局域网
H3 工作台完成至少一次真实最小冒烟任务，并从青蛙画布验证模式/参数交互。真实环境不可用时
状态保持待验收，不把 mock 通过写成真实出片。

## 非目标

- 不删除、隐藏或重构其他视频模型；本轮新增规则只在 MiniMax H3 被选中时生效。
- 不复制 LibLib 私有 bundle 或请求协议；仅复现已实测的产品判定语义。
- 不接入武打模式、LoRA 编辑器、数字人、文件/网页参考或 AutoLink；本地稳定 API 未把这些都声明为本轮合同。
- 不改 `VideoNode.tsx`、大画布存储或其他在途工作线的业务逻辑；复用现有有序 references 提交流。

## 现状与证据

- 目标工作台健康接口返回 ComfyUI ready，能力接口声明模型 `minimax-h3`，模式 `t2v/i2v/r2v`；
  图片/视频/音频上限分别为 9/3/3，宽高为 256–2048 且 32 对齐，时长为 2–15 秒。
- LibLib 实机节点在两图一音频下选择全能参考；文生视频因已连接媒体禁用，图生视频因图片数不是
  1 禁用，首尾帧仍显示可用。为满足本项目“不静默丢素材”不变量，H3 首尾帧遇到额外视频/音频
  时将明确禁用并提示切到全能参考。
- 当前官方 H3 目录仍含 6 个模式、最小时长 4 秒且缺少 `auto`；当前模式禁用函数按模型族分支，
  没有 H3 的四模式矩阵。现有全能参考请求已经按 `referenceOrder` 生成有序 references，可直接复用。
- `origin/feat/canvas-video-cta-reference-modes` 修改相同三个前端能力文件，但基线更旧且没有当前 H3
  目录/局域网稳定 API 适配；本轮只复用当前主线接口，不移植该分支整文件。
- `origin/main` 在 H3 目录、能力与相关测试上存在后续改动；本 worktree 以本地已审计主线为基线，
  合并前按 hunk 复核，不做 pull/rebase。

## 写入边界

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md` | 协调 | 登记状态与共享热点 |
| `docs/agent/tasks/minimax-h3-liblib-parity.md` | 协调 | 本线方案、进展与交接 |
| `docs/agent/claims/minimax-h3-liblib-parity.toml` | 协调 | 机器可读认领 |
| `frontend/src/features/canvas/nodes/shared/minimaxH3GenerationDecision.ts` | 独占 | H3 四模式纯判定与默认模式 |
| `frontend/src/features/canvas/nodes/shared/videoModelCapabilities.ts` | 独占 | H3 识别与现有默认/提交守卫接入 |
| `frontend/src/features/canvas/nodes/VideoOperationsPanel.tsx` | 独占 | H3 菜单顺序、可见性与禁用原因 |
| `frontend/src/__tests__/features/canvas/minimax-h3-generation-decision.test.ts` | 独占 | H3 判定矩阵测试 |
| `frontend/public/locales/{zh,en,vi}/translation.json` | 共享 | H3 禁用原因三语文案，按 key 合并 |
| `src/novelvideo/official_media_models.json` | 独占 | H3 四模式、比例、时长与高级参数目录 |
| `tests/test_model_gateway_settings.py` | 独占 | 官方目录契约回归 |
| `src/novelvideo/generators/minimax_h3_workbench.py` | 独占 | 稳定 API 上传、提交、轮询、下载适配器 |
| `src/novelvideo/generators/video_generator.py` | 独占 | H3 地址已配置时选择专用适配器 |
| `tests/test_minimax_h3_workbench.py` | 独占 | 传输、尺寸映射、素材顺序与错误回归 |
| `.env.example` | 独占 | 本地工作台地址配置说明，不写真实地址 |

## 协调与冲突

- **相关工作线**：`liblib-canvas-parity` 提供竞品证据，但已待验收；本线在独立 worktree 串行追加 H3 实现。
- **本地已有改动**：主检出目录有创意片头和翻译脏文件，本 worktree 未复制它们；三语仅新增独立 key。
- **远端重复实现**：CTA 分支没有 H3 稳定 API 适配，也没有当前四模式目录，选择不移植；`origin/main`
  的相关后续改动只在合并前逐 hunk 审计。
- **共享文件顺序**：三语翻译按 key 合并；其余目标在本 worktree 由本线独占。明确不写 `VideoNode.tsx`
  和 `freezone.py`，避免与 LibLib/depth/shot/creative-intro 热点并发。

## 实施方案

1. 新增 H3 纯判定器并接入模式菜单/现有默认模式函数——完成条件：四模式可见，素材组合逐项给出可用性、禁用原因和确定默认值。
2. 收窄官方 H3 目录并暴露真实高级参数——完成条件：只声明四模式，参数为 auto + 六比例、768P/2K、5–15 秒与工作台质量/步数/模型模式/种子。
3. 新增局域网 H3 API 适配器——完成条件：t2v 走稳定 v1；单图 r2v、双帧 i2v、混合 r2v
   按工作台网页当前的固定素材槽位依序上传、提交、轮询并下载，且把这一兼容边界封装在后端。
4. 补前后端聚焦测试和三语文案——完成条件：判定矩阵、请求体、尺寸、超限、失败状态都有回归。
5. 构建并做真实冒烟——完成条件：前端生产构建通过，工作台健康/能力检查通过，最小真实任务返回可播放视频；再从青蛙画布核对四模式和参数。

## 风险与回退

- **风险**：本地 H3 API 的实际任务/输出 JSON 若与公开示例不同，会导致轮询或下载失败；适配器使用稳定状态枚举并保留安全错误，不把原始内部路径暴露给前端。
- **风险**：2K 不等于固定单一宽高；按画幅把长边映射为 2048、768P 把短边映射为 768，并统一 32 对齐。
- **风险**：LibLib 允许“首尾帧 + 音频”停留在该模式，但 H3 I2V 不消费音频；本项目明确禁用，避免付费/算力任务静默丢素材。
- **回退**：移除 H3 判定模块和工作台适配器，恢复本线对目录/能力/面板的窄 hunk；不触碰其他工作线文件。

## 验收标准

- [x] `pnpm exec vitest run` 三个 H3/能力/节点契约文件全绿（123 项）。
- [x] `uv run pytest tests/test_minimax_h3_workbench.py tests/test_model_gateway_settings.py` 全绿（113 项）。
- [x] 前端/后端 i18n、聚焦 ruff、CE 端口闭合、`pnpm build` 全绿。
- [x] 浏览器中 MiniMax H3 只显示文生/全能参考/图生/首尾帧；无素材禁用和高级参数符合规则。
- [x] 局域网 H3 完成真实任务、下载并回填青蛙画布；凭据和真实地址均未写入仓库。
- [x] 本轮改动全部在写入边界内，无未解释 diff；文档和三语同步。

## 进展记录

### 2026-09-24 · 青蛙画布端到端验收通过

做了什么：修复输出对象同时含 `url` / `path` 时的不确定选择，重启本线后端并在同一青蛙画布
重新提交 MiniMax-H3 文生视频。工作台按幂等键复用已完成任务，适配器通过 `/view` 下载视频，
项目任务完成并把 1376×768、5 秒视频回填节点；画布已实际加载并播放文件。

为什么这么改：`url` 是工作台公开下载合同，`path` 只是 ComfyUI 内部相对位置，只有在没有 URL
时才可兜底。把顺序固化为 download/video/url/path 后，多进程不会再受哈希随机顺序影响。

怎么验证的：后端聚焦 113 项、前端聚焦 123 项、生产构建、ruff、CE 端口闭合、前后端 i18n、
agent guard 与 `git diff --check` 均通过；浏览器任务状态为 completed、进度 1，节点显示 1376×768
及 0:05，并成功请求项目静态 MP4（HTTP 206）。

### 2026-09-24 · 画布端到端暴露下载地址优先级缺陷

做了什么：在青蛙画布选择 MiniMax-H3，确认四模式、无素材禁用逻辑及质量/步数/种子参数后，
从视频节点提交真实 768P / 5 秒 T2V。任务被工作台接受并完成生成，但回填阶段因适配器从同时含
`url` 与 `path` 的输出对象里不确定地选中了内部相对 `path`，下载请求返回 404。

为什么分叉：`_output_location` 把候选键写成了无序集合；不同 Python 进程的哈希顺序可能先取网页
可下载的 `url`，也可能先取仅供工作台内部定位的 `path`。这解释了直连冒烟成功、画布子进程失败的
差异。下一步把优先级固定为签名下载 URL / 视频 URL / 通用 URL / 内部 path，并为“同时存在 url 与
path”补回归测试，再从同一画布重提验证。

怎么验证的：画布节点与项目任务均显示失败，安全错误为 `H3 output download failed (404)`；只读复核
已完成任务的输出元数据，确认单个 output 同时返回 `/view?...` 的 `url` 和 `video/...` 的 `path`。

### 2026-09-24 · 真实 T2V 出片通过，引用模式改走工作台网页 HTTP 合同

做了什么：完成四模式判定、目录参数、适配器和定向测试；用稳定 v1 真实生成并下载一条 5 秒
T2V（H.264 1376×768 / 24fps，含 AAC 音轨）。随后实测 v1 的素材上传与 I2V/R2V 提交。

为什么分叉：工作台 `capabilities` 虽声明 `inputs.first_frame/reference_images`，但按文档上传取得
`asset_id` 后，v1 I2V 仍返回“需要首帧”、R2V 仍返回“至少需要一项参考素材”，错误明细中的
`submitted` 为空；同一素材通过网页正在使用的 `/quickui-studio/api/upload/<slot>` +
`generate/batch` 可立即接受，且定向取消成功。因此带引用模式改用这一真实 HTTP 合同，避免交付
一个只能文生、引用必失败的伪集成；不接 DOM 或 Gradio。

怎么验证的：真实 T2V 任务完成并经 `ffprobe` 校验；网页 HTTP 合同用 1 张参考图提交 R2V，返回
`accepted: 1`，随后 `/queue/<id>/cancel` 返回 `cancelled: true`。后端聚焦测试 111 项、H3 相关
前端测试 123 项、前端生产构建和 i18n 棘轮已通过。

### 2026-09-23 · 方案门完成并建立隔离工作线

做了什么：从 `45130dfd` 创建独立 worktree/分支，读取现有 LibLib 台账和画布架构；实测局域网
H3 健康、能力、OpenAPI 与公开前端合同，确认稳定 API 和模式映射；完成远端/本地重叠审计。

为什么这么做：主检出目录正在被另一工作线持锁且翻译文件有未提交改动；隔离 worktree 可保证
H3 实现不会覆盖创意片头现场。稳定 API 已经存在，不应继续对接旧 Gradio 或依赖易变 DOM。

怎么验证的：`agent_guard check/status` 在新 worktree 返回 14 条工作线、无锁；工作台健康返回 ready，
能力声明 `t2v/i2v/r2v` 及 9/3/3 上限；尚未提交生成任务。

## 已定下来的决策

- **只对 MiniMax H3 启用新规则，不改变其他模型。**——用户明确要求本轮只要 H3。
- **单图图生走 R2V、首尾帧走 I2V、全能参考走 R2V。**——与工作台实际三种传输模式一致。
- **首尾帧不允许额外视频/音频。**——宁可明确提示切全能参考，也不静默丢素材。
- **T2V 使用稳定 `/api/v1`；引用模式临时使用网页的一方 HTTP API，不接 Gradio/DOM。**——v1
  素材合同在当前工作台版本可上传但无法解析，网页 API 是唯一已实测接受固定图片/视频/音频槽位
  的合同；兼容逻辑只封装在 H3 后端适配器，待 v1 修复可删除。
- **本地工作台地址只进环境配置。**——仓库公开，不固化机器地址或凭据。

## 待办

- [x] 实现纯判定器、目录、适配器和测试。
- [x] 完成构建、真实任务及画布浏览器验收。
- [ ] 主检出目录锁释放后，按共享文件逐 hunk 集成本分支。

## 阻塞

无。目标工作台当前健康；真实任务耗时取决于局域网 GPU 队列。

## 交接摘要

- **最后完成到**：实现、聚焦测试、生产构建和真实青蛙画布生成/下载/回填均完成，分支待集成。
- **下一步唯一动作**：主检出锁释放后逐 hunk 集成 `codex/minimax-h3-liblib-parity`，优先复核三语与四个共享热点。
- **先读这些文件**：本台账、`minimaxH3GenerationDecision.ts`、`minimax_h3_workbench.py`、两组聚焦测试。
- **不要动这些文件 / 决策**：不改 `VideoNode.tsx` / `freezone.py`；不把真实工作台地址写入仓库；引用模式继续使用已实测 QuickUI HTTP 合同，直至 v1 素材解析修复。

# STATE · 当前进度索引

> **新会话的第一件事是读这份文件。** 它只回答三个问题：现在有哪几条线在做、各自卡在哪、
> 下一步做什么。取证与方案不在这里——在 `docs/guides/`；每条线的逐步记录在 `docs/agent/tasks/`。
>
> 最后更新：2026-09-24 · 更新方式见 `AGENTS.md` 的「多模型协作协议」与
> [`docs/agent/README.md`](README.md)

## 一、仓库当前形态（接手前必须核对）

- 分支 `main`；画布架构/LibTV 基线 `3238af61`、动作注册表 + 音频截取/变速 `0f20e8ac`、
  音频智能/自定义切分 `4b578509`、创意片头取证 `bb0bf189` 均已作为独立提交推送，当前与
  `zhonggwv/main` 同步；来源、决策和验证可从对应台账追溯。
- **工作区只剩 3 类未跟踪的受保护本地资料**：`.playwright-cli/` 浏览器运行日志、`_to_delete/`
  旧原型、`曹操.md` 原始故事样例。此前 49 条在途的 LOD、素材替换、入口恢复、本地路由与 Depth
  差异均已按工作线独立提交；这三类不因名称或“提交全部”的口头命令自动删除或公开。
  会话开始时 hook 注入的摘要是实时值，不能用条目总数反推某条业务线又新增了多少文件。
- 这是当前最大的风险：一次整树 restore / 自动 stash / 强制切分支，就能抹掉三周的工作。
  **接手后第一条命令是 `git status --short --branch`，先和下表对账。**
- 当前 `main` 已推送到 `zhonggwv/main`；`origin` 只作为上游对照，且仍有 27 个上游提交
  尚未审计合并，多处本地脏文件也被上游修改。
  在完成逐线来源审计和拆提交前，不得直接 pull/rebase，也不要为了建 worktree 自动 stash。
- GitHub CLI 已认证为 `ZhongGWV`；Git 的全局 HTTP/HTTPS 代理为 `http://127.0.0.1:7890`。

## 二、在途工作线

| 台账 | 主题 | 状态 | 卡在哪 / 下一步 |
|---|---|---|---|
| [sync-main-remotes](tasks/sync-main-remotes.md) | 让 origin/main 与 zhonggwv/main 合流并最终同 SHA | 执行中 | 隔离 worktree 已完成 138/229 路径审计；下一步取得 guard 锁并解决 4 个真实冲突 |
| [agent-collaboration-protocol](tasks/agent-collaboration-protocol.md) | 多模型协作、方案门与冲突治理 | 已完成 | 独立提交、测试与真实交接闭环已完成；后续变更另开工作线 |
| [legacy-unassigned-diff](tasks/legacy-unassigned-diff.md) | 历史未归属改动隔离区 | 已阻塞 | 只读审计来源；未归属前禁止覆盖或删除 |
| [asset-replacement-picker](tasks/asset-replacement-picker.md) | 画布素材替换：拖拽与点选双入口 | 待验收 | 独立实现与 5 项聚焦测试已通过；待真实画布手工走一遍点选替换 |
| [freezone-entry-recovery](tasks/freezone-entry-recovery.md) | 项目画布入口恢复 | 待验收 | 30 项聚焦测试和生产构建通过；待跨项目、无效深链、首次个人画布浏览器验收 |
| [liblib-canvas-parity](tasks/liblib-canvas-parity.md) | 画布架构与 LibTV 能力对齐 | 待验收 | 真实 UI、线上 chunk、我方架构与分阶段路线已固化；待产品确认 P0 顺序及 relay 真实出片验收 |
| [minimax-h3-liblib-parity](tasks/minimax-h3-liblib-parity.md) | MiniMax H3 视频节点与 LibLib 参数/模式对齐 | 已完成 | 已验收分支集成到 main；后续底部模式入口与 Mixed 顺序由 `minimax-h3-reference-order` 接手 |
| [canvas-audio-actions](tasks/canvas-audio-actions.md) | 动作注册表 + 音频截取/变速 | 已完成 | 本地 ffmpeg 端到端、23+7 项聚焦测试、生产构建与真实画布截取/2×/刷新验收均通过 |
| [canvas-audio-split](tasks/canvas-audio-split.md) | 音频智能切分 / 自定义切分 | 已完成 | `4b578509` 已推送；17+10 项聚焦测试、构建、三语及真实画布智能/自定义/播放/刷新验收通过 |
| [creative-intro-discovery](tasks/creative-intro-discovery.md) | LibTV 创意片头专项取证 | 已完成 | `bb0bf189` 已推送；可另开实现线，最终供应商画质与扣费仍需真实任务验收 |
| [creative-intro-implementation](tasks/creative-intro-implementation.md) | 创意片头显式节点工作流 | 已完成 | `385139cc` 已推送；基础链完成，原片 5 秒融合与真实供应商生成另开增强线 |
| [creative-intro-blend](tasks/creative-intro-blend.md) | 创意片头融入原片 5 秒 | 已完成 | `dd8ac320` 已推送；本地 compose、双引用五节点/五边、失败回滚与刷新恢复均已实测 |
| [shot-breakdown](tasks/shot-breakdown.md) | 逐帧拉片三维度：分镜 / 动态 / 音乐 | 待验收 | 三层提交与干净快照通过；待真实视觉模型及有/无 demucs 两种音乐路径 |
| [depth-motion-da3](tasks/depth-motion-da3.md) | 拉片动态维度：Depth Anything 3 深度视频 | 待验收 | 任务中心名称与 20 项聚焦回归已补齐；待 CUDA 真机 720p 硬切样片验收 |
| [story-writer](tasks/story-writer.md) | 创作阶段（虾本）：写手 agent + 通用文档存储 + 前端路由 | 待验收 | 14 项后端契约测试与前端 build 已通过；待真实模型四阶段流程和导入链路验收 |
| [local-stack](tasks/local-stack.md) | 命令行 CE 本地栈：local_gateway + ComfyUI Qwen/Krea | 待验收 | main 已通过首次/重复启动和四端健康验收；仅剩第二台干净环境与 Krea 基准 |
| [canvas-lod-perf](tasks/canvas-lod-perf.md) | 画布 LOD 剔除、低缩放交互、视频抽帧封面 | 待验收 | ImageGenNode 懒加载接点和发布容错已回归；待大画布量化帧率 |

已完成或放弃的线移到 `docs/agent/archive/`，不要在上表里留尸体。状态只用
`提案中 / 方案就绪 / 执行中 / 待验收 / 已阻塞 / 已完成 / 已归档`。

## 三、冲突雷达（动热点文件前必须看）

| 路径 / 区域 | 本地工作线 | 外部重叠 | 当前处理规则 |
|---|---|---|---|
| `vi/translation.json`、`VideoNode.tsx`、`videoModelCapabilities.ts`、home-node guard 测试 | sync-main-remotes 最终集成 | `origin/main` 29 个独有提交与 fork 50 个独有提交 | 只在隔离 worktree 由本线解决 merge-tree 报告的 4 个冲突；保留两边语义，验证后同一 SHA 依次推两个 main |
| `Canvas.tsx`、`index.css`、`imageData.ts`、`useCanvasSync.ts` | LOD + LibTV 画布 | `origin/perf/canvas-pan-lod-culling` | LOD 来源审计完成前不再写这 4 个文件 |
| `VideoNode.tsx`、`canvasNodes.ts`、`nodeRegistry.ts`、`NodeActionToolbar.tsx` 等 | LibTV + depth / 拉片接入 | `origin/feat/canvas-video-reshoot-breakdown` | 先做行为与测试的三方差异，不按文件新旧直接取舍 |
| `VideoOperationsPanel.tsx`、`PromptMentionEditor.tsx`、H3 工作台适配器 | MiniMax H3 引用顺序 | `codex/minimax-h3-liblib-parity`、旧 CTA 分支 | 已验收 H3 分支已集成；本线仅追加底部模式入口与 Mixed 协议，非 H3 mention 行为保持不变 |
| `freezone.py`、`tasks.py`、`schemas.py`、`jobs.py`、`runners/freezone.py` | shot + depth + LibTV | 远端重拍分支；部分还在 `origin/main` | 按 API schema → job → runner 串行集成，禁止并行写 |
| 音频工具条、动作注册表、Freezone 音频适配层 | canvas-audio-actions + canvas-audio-split + 上述画布线 | 无同类远端分支；共享文件已有已提交功能 | audio actions 提供单段任务合同，audio split 串行追加预览与扇出，禁止整文件覆盖 |
| 三语 `translation.json` | LibTV 与其他前端改动 | `origin/main` + 远端重拍分支 | 合并键，不整文件覆盖；三语同时验证 |
| `routeTree.gen.ts` | story-writer | `origin/main` | 先合并路由源文件，最后重新生成，不手工择一覆盖 |
| `nanobanana_grid.py` | local-stack | `origin/main` | 已确认语义互补；同步时同时保留上游归档直拷与本地 multipart / 绕代理 |

已确认的重叠数字（基于当前本地远端引用）：LOD 分支 4 个文件全部与本地脏文件重叠；
视频重拍 / 拉片分支至少 24 个文件与本地脏文件重叠；`origin/main` 有 7 个文件与本地脏文件重叠。
远端引用更新后数字可能变化，决定合并前需 fetch 后复核。

## 四、恢复顺序（不是功能优先级）

1. 交接协议与 handoff 回归修复已独立提交并推送。
2. 只读分类 `legacy-unassigned-diff`，任何未确认归属的文件继续保持隔离。
3. `canvas-lod-perf` 的核心状态层已独立提交；混合 UI 增量继续留给对应工作线。
4. `shot-breakdown`、`depth-motion-da3` 与 `liblib-canvas-parity` 已按契约拆提交；LibTV 剩余
   工作仅是带 relay 的真实出片验收，不要把工作树里的 LOD / 素材替换差异倒灌回已收口提交。
5. `story-writer` 已独立提交；`local-stack` 可移植性和测试已收口，待第二台机器验收后归档。
6. 所有线有独立提交 / 分支、工作区可恢复后，再同步 `origin/main` 并转为一线一 worktree。

这是保护现场的技术顺序，不是产品优先级。若用户改变优先级，先更新方案，但仍不能跳过冲突审计。

## 五、全局阻塞（不是代码问题，改代码解决不了）

1. **`OSS_RELAY_AK` / `OSS_RELAY_SK` 未配置** → 任务能建、能派发，调到视频生成器报
   `OSS media relay config missing`。凡是「视频生成跑不通」，先查这个，别去 debug 业务代码。
2. **ComfyUI 模型 / 节点需单独安装**；`start-local-stack.sh` 默认负责启动和等待，也可配置为复用现有进程。
3. **demucs 未装** → 拉片的音乐维度降级成整轨提取（`mode` 字段会如实上报，不是静默降级）。

## 六、环境速查

```bash
# 后端（云端/标准 CE）
uv sync --group dev && uv run novelvideo api --port 8780
# 本地命令行栈（本机 ComfyUI + 硅基流动），会一并起 local_gateway
cp config/local/local.env.example .dramaclaw-local/local.env  # 首次配置
bash scripts/start-local-stack.sh
# 前端
cd frontend && pnpm install --frozen-lockfile && pnpm dev
```

项目数据在 `state/local/<project>/`（gitignore）；产物在 `output/`（gitignore）。
当前有内容的项目：`chuan_yue_song_chao`、`liblib_canvas_import_review`、`Wawa_qiao`、`test`。

## 七、易丢的本地资产（不在 git 里）

| 路径 | 是什么 | 丢了会怎样 |
|---|---|---|
| `output/local/liblib_canvas_import_review/liblib-shot-breakdown-teardown.md` | 拉片实测原始笔记；证据已整理进 tracked guide | 原始笔记丢失不再导致需求证据归零 |
| `.dramaclaw-local/` | 本地路由配置与密钥 | 本地栈起不来 |
| `.dramaclaw-local/workflows/*.json` | 用户修改过的 ComfyUI 工作流副本 | 会回退到仓库内受审查模板，个性化调整丢失 |
| `曹操.md` | 创作阶段的真实样例产物 | story 线没有可回归的样例 |

这几样值得单独备份一次，再谈别的。

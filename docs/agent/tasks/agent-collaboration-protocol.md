# 多模型协作与可追溯改动协议

**状态**：已完成
**最后更新**：2026-09-18
**基线**：`0e2d69770c8cff13e0efcf7ea21ff01498920373`；治理底座已形成独立提交，业务工作区仍待逐线拆分
**相关文档**：`docs/agent/README.md`（协议说明）
**相关分支 / PR**：无；只改交接体系，不触碰业务代码

## 目标

把“先理解现场、先写方案、再改代码、最后留证据”固化成所有 AI 模型都能执行的仓库协议，
并让并行工作线在动手前暴露文件重叠、远端重复实现和基线漂移，降低覆盖、返工和错误合并风险。

## 非目标

- 本轮不整理、合并或提交六条业务工作线的代码。
- 本轮不拉取、rebase、stash、切分支，也不替用户决定远端分支和本地实现谁保留。
- 本轮不把机器密钥、绝对路径或运行产物写进公开台账。

## 已知事实与问题

1. 当前六条业务线共用一个未提交工作区，且多个热点文件同时属于两条以上工作线。
2. 本地 LOD 改动与 `origin/perf/canvas-pan-lod-culling` 的 4 个文件完全重叠；本地视频重拍、
   拉片相关改动与 `origin/feat/canvas-video-reshoot-breakdown` 至少 24 个文件重叠。
3. 本地 7 个脏文件同时已被 `origin/main` 修改；在未拆线前直接 pull/rebase 风险很高。
4. 现有台账擅长记录“做了什么”，但没有统一的方案门、写入边界、共享文件协调顺序和标准状态机。
5. `.claude/hooks/` 只能约束 Claude Code；跨模型真正通用的约束必须写进根 `AGENTS.md`，
   并由仓库内文档而非某个客户端的记忆承载。

## 写入边界

| 路径 | 模式 | 说明 |
|---|---|---|
| `AGENTS.md` | 独占 | 收敛所有模型必须执行的稳定规则 |
| `docs/agent/README.md` | 新增 | 解释状态机、方案门、冲突处理和文档分层 |
| `docs/agent/STATE.md` | 共享 | 登记本工作线、当前冲突雷达与恢复顺序 |
| `docs/agent/TEMPLATE.md` | 独占 | 增加基线、非目标、方案、写入边界、风险与交接字段 |
| `docs/agent/tasks/*.md` | 共享 | 给现有工作线补标准状态与冲突提示，不改业务决策 |
| `docs/agent/archive/README.md` | 共享 | 补归档标准，避免“归档”等于丢失结论 |
| `.claude/hooks/README.md` | 共享 | 明确 hooks 只是客户端适配层，不是协议本体 |
| `.claude/hooks/session-start.sh`、`stop-ledger-check.sh` | 共享 | 同步规则标题与提示文案，不改变 hook 行为 |
| `docs/agent/claims/**` | 新增 | 每条工作线一份机器可读的路径认领，避免中央文件争写 |
| `docs/agent/CLAIM_TEMPLATE.toml.example` | 新增 | 新工作线可复制的 scope 示例，不被 guard 当活动任务加载 |
| `scripts/agent_guard.py` | 新增 | 通用 check / preflight / acquire / handoff / release 护栏 |
| `tests/test_agent_guard.py` | 新增 | 校验状态机、重叠检测、路径授权与锁行为 |
| `.gitignore` | 共享 | 忽略本机原子会话锁目录，不碰其他既有规则 |
| `.pre-commit-config.yaml` | 共享 | 提交前运行只读 guard check |
| `.github/workflows/ci.yml` | 共享 | checkout 后、安装重依赖前校验协作契约 |

## 协调与冲突

- 本线只治理协作基础设施，不取得任何业务文件的所有权。
- 其他台账和 scope 由各自工作线拥有；本线只定义格式并运行全局一致性检查。
- `STATE.md` 是协调文件，不参与业务路径锁冲突；业务代码重叠仍必须双方显式声明。

## 实施方案

1. 定义单一信息源：`AGENTS.md` 放稳定硬规则，`STATE.md` 放动态索引与冲突，任务台账放方案与记录，
   `docs/guides/` 放长篇取证；同一事实只在一处展开，其他地方只链接。
2. 定义状态机：提案中 → 方案就绪 → 执行中 → 待验收 → 已完成 → 已归档；阻塞是附加状态，
   不能用“进行中”掩盖未验证或环境阻塞。
3. 建立代码前方案门：目标、非目标、基线、现状证据、写入边界、步骤、风险/回退、验收均完整，
   且完成重叠检查后，才允许改业务代码。
4. 建立冲突协议：独占文件只能归一条执行中的工作线；共享热点必须写协调顺序；发现无法归属的旧改动立即停手，
   不覆盖、不顺手重构。远端已有同类实现时，先做差异审计，再决定保留、移植或放弃。
5. 迁移现有台账的状态与边界字段，并在 `STATE.md` 登记已发现的真实冲突。
6. 为每条活动工作线建立独立 TOML scope；用 stdlib 工具检查状态、必填章节、路径重叠与基线漂移。
7. 增加原子会话锁：写代码前 acquire，交接后 handoff + release；同一工作线或共享路径被占用时失败即停。
8. 用聚焦单测、真实仓库自检、链接与 shell 语法检查验证整套协议。
9. 把只读 `check` 接入 pre-commit 与 CI，使忽略 AGENTS 的提交也无法静默破坏协作契约。

## 风险与回退

- 风险：规则过长导致模型跳读。处理：根 `AGENTS.md` 只保留强制步骤，解释移到 `docs/agent/README.md`。
- 风险：维护两份相同信息造成再次漂移。处理：明确每类信息的唯一落点，只用链接引用。
- 风险：给旧工作线补字段时误改既有决策。处理：只补元数据、冲突与后续方案，不改已有技术结论。
- 风险：锁遗留导致假阻塞。处理：锁内记录 owner / task / 时间；只允许显式 `--force` 清除并要求先核实会话已结束。
- 风险：scope 与台账漂移。处理：scope 不复制方案和状态，只记录机器必须判断的路径；检查器把缺文件与非法重叠直接报错。
- 回退：本轮只改协作治理文档、guard、测试与 CI / hook 接入，可按文件逐项评审；
  不触碰业务实现，也不使用清空工作区或整体恢复命令。

## 进展记录

### 2026-09-18 · 修复提交后无法正常交接的闭环缺陷

做了什么：治理提交 `0e2d6977` 完成后，真实执行 handoff 发现 guard 把同一持锁会话产生的
快进提交也误判为“换了 HEAD”。本轮将仅允许锁内 HEAD 沿原提交快进；reset、rebase 或切到分叉历史
仍然拒绝，并补提交后 handoff 的回归测试与运行手册说明。

为什么这么做：正常流程必须允许“acquire → 修改并记台账 → commit → handoff → release”。直接 force-release
会让规则在最关键的提交边界失效，也无法区分正常提交与外部改写历史。

怎么验证的：修复前真实命令返回
`BLOCKED: agent-collaboration-protocol lock was acquired at another HEAD; release and re-audit`；
实现后 `uv run pytest tests/test_agent_guard.py -q` → `7 passed`，ruff、guard 与 diff check 全绿；
最终提交后再用真实 handoff / release 验证快进路径。首次失效锁已在确认无其他写会话后人工 force-release，
并立即由同一 owner 重新取得。

### 2026-09-18 · fail-closed 护栏闭环完成

做了什么：guard 增加单检出目录单写者、稳定 owner 格式、scope 版本校验、全量脏文件覆盖、
acquire 时 SHA-256 快照、release 强制 handoff；新增可复制 claim 模板；把只读 check 接入 pre-commit 和 CI；
Claude SessionStart / Stop hooks 已完成真实冒烟。

为什么这么做：仅靠“请记得更新台账”仍可被跳过。最终闭环要求未认领文件、非法重叠、并发写、越界路径、
未更新台账、结构漂移分别在开始、写入、交接和提交阶段被机器拒绝；并行工作明确转移到独立 worktree。

怎么验证的：`python3 scripts/agent_guard.py check` → `OK: 8 workstreams, 171 claims`；
`uv run pytest tests/test_agent_guard.py -q` → `6 passed`；ruff 全绿；`pre-commit validate-config` 通过；
CI YAML 可解析；两个 shell hook 通过 `bash -n` 和真实 payload 冒烟；持有治理锁时尝试 acquire story 任务，
正确返回 `BLOCKED: this checkout already has writer ... use a separate worktree`。释放治理锁后又用
`fresh-ai/handoff-smoke` 模拟新模型接手 story：check → acquire → 两路径 preflight → handoff → release 全部通过，
最终 `status` 为 `No active agent locks.`。

### 2026-09-18 · 通用 guard、机器 scope 与未知改动隔离已可运行

做了什么：新增 `scripts/agent_guard.py`、5 个聚焦测试和 8 份工作线 scope；建立
`legacy-unassigned-diff` fail-closed 隔离区；把 check / status / acquire / preflight / handoff / release
写入根规则、运行手册、模板和 Claude hooks；本会话已实际 acquire 并 preflight 治理文件。

为什么这么做：Markdown 只能传达意图，无法阻止漏读和并发写。机器 scope 负责路径归属，原子锁负责同检出目录并发，
未知改动隔离区保证无法归属的历史文件不会被下一任模型当垃圾清理。

怎么验证的：`python3 scripts/agent_guard.py check` → `OK: 8 workstreams, 168 claims`；
`uv run pytest tests/test_agent_guard.py -q` → `5 passed`；
`uv run ruff check scripts/agent_guard.py tests/test_agent_guard.py` → `All checks passed`；两个 hook 通过 `bash -n`。

### 2026-09-18 · 协议、索引、模板与六条旧台账完成迁移

做了什么：重写 `AGENTS.md` 的多模型硬规则；新增 `docs/agent/README.md`；给 STATE 增加标准状态、
冲突雷达和恢复顺序；升级任务模板；为六条业务线补基线、非目标、真实重叠、后续方案、风险和交接摘要；
同步更新 Claude Code hook 文案，明确它只是客户端提醒层。

为什么这么做：把稳定规则、动态状态、单线方案、长篇取证拆成四个权威层，既让新模型快速恢复现场，
又避免同一事实复制到多份文档后漂移。冲突雷达使用本地与远端的真实文件交集，而不是泛泛提醒“注意冲突”。

怎么验证的：`git diff --check` 通过；两个 hook 经 `bash -n` 通过；逐项检查 STATE 引用的台账、guide 与架构文档存在；
本轮未触碰 `src/`、`frontend/src/`、`scripts/` 或 `tests/` 业务文件。尚未由用户验收，因此状态保持「待验收」。

### 2026-09-18 · 完成现状审计并先立治理方案

做了什么：核对 `STATE.md`、完整 `git status`、六份任务台账、Claude hooks、项目结构、远端主线和两条相关功能分支；
把发现的问题与本轮写入范围记录在本台账。

为什么这么做：用户要求“改代码前要有方案且可追溯”，治理体系本身也必须遵守，不能先改完规则再补理由。

怎么验证的：`git rev-list --left-right --count HEAD...origin/main` 得到 `0 13`；
`git status --porcelain=v1` 得到 81 个已修改、51 个未跟踪条目；用 `comm` 对比当前脏文件与远端分支改动，
确认 LOD 4 个文件重叠、视频重拍/拉片分支至少 24 个文件重叠、`origin/main` 7 个文件重叠。

## 已定下来的决策

- **根文件使用仓库实际名称 `AGENTS.md`，不另建 `agent.md`**——主流编码代理会自动读取前者；另建近似文件只会制造两个规则源。
- **方案与执行记录放在同一条任务台账**——方案变化时能紧邻记录原因，避免设计文档和执行状态各说各话。
- **客户端 hook 只能做提醒，不能成为唯一保障**——不同 AI 客户端支持不同，通用规则必须落在仓库文档。
- **当前脏工作区先做差异审计与拆线，再谈 pull/rebase/worktree**——未提交改动不会自动进入新 worktree，直接迁移会丢现场。

## 待办

- [x] 更新 `AGENTS.md` 的强制开工、方案门、冲突与收工协议
- [x] 创建 `docs/agent/README.md`，解释完整生命周期与文档分层
- [x] 扩充 `STATE.md` 的冲突雷达和当前恢复顺序
- [x] 升级 `TEMPLATE.md` 并迁移六份现有台账的关键字段
- [x] 更新 hook 说明并完成链接、格式和 diff 验证
- [x] 建立每条工作线的机器可读 scope 并通过全局重叠检查
- [x] 实现和测试通用 agent guard 与原子会话锁
- [x] 把 guard 命令接入 AGENTS、运行手册与 Claude hooks
- [x] 强制 release 重新执行 handoff，并用 acquire 快照验证本会话确实更新台账
- [x] 接入 pre-commit / CI，并完成 hooks 与第二写会话阻塞冒烟
- [x] 完整自检通过后，将本线标为「待验收」

## 阻塞

无。真实提交暴露的 handoff 误拒绝已经补回归并修复；业务线的环境密钥或远端合并不属于本线。

## 验收标准

- [x] 新模型只读 `AGENTS.md` → `STATE.md` → 目标台账，就能判断是否可动代码、允许改哪些文件、如何验收。
- [x] 每条活动工作线都有基线、方案、机器 scope、冲突说明与验收标准；未知文件进入冻结隔离区。
- [x] guard 拒绝未认领脏文件、非法重叠、状态 / 基线漂移、无锁 / 越界写入和跳过交接的 release。
- [x] 同一检出目录单写者；并行路径明确为独立 worktree / 分支 / PR。
- [x] pre-commit、CI、Claude hooks 与通用 CLI 四层入口均已接入并验证。

## 交接摘要

- **最后完成到**：文档、scope、guard、锁、hooks、CI 和提交后 handoff 回归均已闭环。
- **下一步唯一动作**：按 STATE 恢复顺序审计并拆分遗留业务工作线。
- **先读这些文件**：`AGENTS.md`、`docs/agent/README.md`、本台账、`scripts/agent_guard.py`。
- **不要动这些文件 / 决策**：不修改业务代码，不把未知脏文件强行归给相邻工作线。

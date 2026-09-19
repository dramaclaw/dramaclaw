# Repository Guidelines

## 多模型协作协议（最高优先级）

本仓库会换模型、换账号、并行开多条工作线。聊天记忆不算项目状态，**只有写进仓库的事实才可交接**。
完整流程见 `docs/agent/README.md`；下面是所有编码代理必须执行的硬规则。

### 1. 开工先恢复现场，不得直接改代码

依次完成：

1. 读 `docs/agent/STATE.md`，确认在途工作线、全局阻塞、共享热点和恢复顺序。
2. 跑 `git status --short --branch` 与 `git log -1 --oneline`，核对分支、基线和脏文件。
   STATE 是交接索引，不是 Git 的替代品；不一致时以 Git 为准，并更新 STATE。
3. 认领一条工作线后，完整读 `docs/agent/tasks/<slug>.md`；只按链接读取相关 `docs/guides/`，
   不要无目的加载全部文档。
4. 对拟改路径运行 `git diff -- <path>`，再和台账的「写入边界」对账。无法归属的旧改动视为他人工作，
   不覆盖、不格式化、不顺手修。
5. 运行 `python3 scripts/agent_guard.py check` 与 `python3 scripts/agent_guard.py status`。
   任一返回 `BLOCKED` 就停止写入，先修台账 / scope / 锁冲突；不能绕过 guard 继续改。

**当前工作区长期有大量未提交改动。** 禁止用 `git checkout .`、`git reset --hard`、整树 restore、
自动 stash、强制切分支等方式“清理现场”。不要在脏工作区直接 pull/rebase；先按工作线审计、拆分、留锚点。

### 2. 代码前必须过「方案门」

除纯问答、只读诊断和只改拼写外，**任何业务代码改动前**都要有对应任务台账。新工作线从
`docs/agent/TEMPLATE.md` 复制并登记到 STATE。台账至少写清：

- 可验收目标与明确非目标；
- 当前 Git 基线、现状证据和已存在实现；
- 精确到文件或窄目录的写入边界，标明独占 / 共享 / 只读；
- 分步实施方案、风险与回退、验证命令；
- 与其他工作线、远端分支、`origin/main` 的重叠检查结果。

字段不全时状态只能是「提案中」，不能改业务代码；完成检查后改为「方案就绪」或「执行中」。
小修可以在现有台账里写短方案，不必另写长文。发现 API、数据迁移、共享热点或用户目标存在多种合理选择时，
先把选项与影响写进台账并向用户确认，不能自行扩大范围。

方案完成后，同步创建或更新 `docs/agent/claims/<slug>.toml`，再使用唯一 owner（推荐
`<client>/<session-id>`）取得本机原子锁并检查本轮精确路径：

```bash
python3 scripts/agent_guard.py acquire <slug> --owner <client/session-id>
python3 scripts/agent_guard.py preflight <slug> --owner <client/session-id> \
  --path path/to/file --path path/to/another
```

没有 acquire + preflight 成功，不得写业务代码。新增路径先改方案与 scope，再重新 preflight；
禁止用宽泛目录认领来绕过检查。`legacy-unassigned-diff` 中的路径默认冻结，只能做只读取证。
同一检出目录一次只允许一个持锁写会话；即使路径不重叠，第二个 acquire 也会失败。要并行就使用独立 worktree。
非「执行中」工作线可以持锁更新自己的台账 / scope，但 preflight 业务路径仍会被拒绝。

### 3. 冲突与重复实现按下面处理

- 一个独占文件同一时间只能归一条「执行中」工作线。确需多线共改时改标「共享」，在两边台账写清
  先后顺序、接口归属和最终集成者；同一共享文件不得由两个会话同时写。
- 动手前同时检查本地 diff、STATE 冲突雷达、相关远端分支和 `origin/main`。远端已有同类实现时，
  先做差异审计，再决定复用、移植或放弃；禁止重写一遍后再比较。
- 修改范围超出台账时，先更新方案和写入边界，再继续。不得借任务之名顺手重构邻近模块。
- 看到陌生改动先归属，不能证明是本工作线的就停手；绝不把“测试通过”当成可覆盖他人改动的理由。
- 长期方案是每条工作线一个分支 / worktree；但未提交改动不会自动进入新 worktree。当前遗留现场必须先拆成
  可审计提交，禁止为了隔离而丢掉现状。

### 4. 实施、验证与收工必须闭环

实施时按台账步骤推进；与方案分叉时，**先记录为什么，再改代码**。测试按影响范围由小到大执行，
不能只写“已验证”，要记录命令与结果；未跑就明确写“未验证”及原因。

收工前在对应台账「进展记录」顶部补一条，回答：改了什么、为什么这么改、怎么验证的。
同时维护决策、待办、阻塞、写入边界和状态；状态变化时更新 STATE。完成必须同时满足代码、测试、文档、
无未解释 diff 四项，之后移入 `docs/agent/archive/`。会话结束但任务未完时，写出下一步可直接执行的动作，
不要用“继续完善”这种无法接手的描述。

最后运行：

```bash
python3 scripts/agent_guard.py handoff <slug> --owner <client/session-id>
python3 scripts/agent_guard.py release <slug> --owner <client/session-id>
```

`release` 会强制重新执行 `handoff`；若 acquire 后业务文件有变化但台账内容没变，就拒绝释放。
锁遗留时先用 `status` 核实原会话确已结束；
`release --force` 只是人工确认后的恢复手段，不是抢锁入口。

### 5. 信息只保留一个权威落点

- `AGENTS.md`：稳定规则与仓库约束，少改。
- `docs/agent/STATE.md`：动态索引、全局阻塞、冲突雷达、恢复顺序。
- `docs/agent/tasks/<slug>.md`：单条工作线的方案、写入边界、决策、进度和验收。
- `docs/agent/claims/<slug>.toml`：只放机器可读路径认领与基线，不复制状态和方案。
- `docs/guides/<slug>.md`：长篇取证、比较与设计细节；任务台账只链接，不复制。
- 代码 / 测试：最终行为事实；非显然取舍用“为什么”型 docstring 或注释。

台账不得写密钥、签名 URL、个人信息或机器专属绝对路径。本仓库公开，默认 `docs/agent/` 会对外可见。
`.claude/hooks/` 只是 Claude Code 的提醒适配层；无论客户端是否支持 hook，本协议都必须执行。

## 项目结构与边界

Python 源码在 `src/novelvideo/`：`api/` 是 FastAPI 适配层，`services/` / `workflows/` 编排用例，
`task_backend/` 负责异步任务执行，`generators/` 负责媒体生成，`freezone/` 承载画布（虾画）领域逻辑，
`agents/` 放模型代理，`ports/` 定义 CE/其他发行形态共享的接口边界，`ports/local/` 是 CE 本地实现，
`storage/` 管持久化，`verification/` 是质量门，`assets/` 是随包媒体。路由不要直接吸收领域逻辑，
跨发行形态能力不要绕过 `ports/`。
前端在 `frontend/`（React + Vite + TanStack Router），画布主体在 `frontend/src/features/canvas/`、
项目工作区在 `features/freezone/`。测试在 `tests/`（契约测试 `tests/contract/`、
端口测试 `tests/ports/`）与 `frontend/src/__tests__/`。运维脚本 `scripts/`，
文档 `docs/`，示例 `examples/`，合规产物 `docs/compliance/`、`LICENSES/`、`sbom.spdx.json`。

## 构建、测试与本地开发

后端：

- `uv sync --group dev`：按 `uv.lock` 装运行时与开发依赖。
- `uv run novelvideo api --port 8780`：起本地 REST API。
- `uv run pytest`：默认测试集（`pyproject.toml` 默认排除 `ee` 与 `e2e` 标记）；
  `-n auto` 走 xdist 并行，CI 就是这么跑的。
- `uv run pytest tests/test_api_assets.py`：迭代时只跑一个文件。
- `uv run ruff check .`：合入必过门。存量以 `pyproject` 的 per-file-ignores 基线豁免，
  逐文件治理、修完删条目——**不要往基线里加新条目**。
- `scripts/acceptance/run.sh`：验证较大范围 API 行为时跑验收检查。
- `pre-commit run --all-files`：仓库钩子，目前含 gitleaks 密钥扫描。

前端（`cd frontend`，pnpm 11.5.0 + Node 22）：

- `pnpm install --frozen-lockfile` → `pnpm dev` 起开发服务器。
- `pnpm build`（= `tsc -b && vite build`，类型检查在这一步）、`pnpm test`（vitest）。

本地命令行 CE 栈（本机 ComfyUI + 硅基流动，不用 Docker）：见 `docs/agent/tasks/local-stack.md`
与 `启动说明.md`。ComfyUI 需单独启动。

## CI 门禁（本地先过，别让 CI 替你发现）

| 门 | 命令 | 说明 |
|---|---|---|
| agent guard | `python3 scripts/agent_guard.py check` | STATE、台账、scope、脏文件归属与冲突必须自洽 |
| ruff | `uv run ruff check .` | 只管新增代码 |
| 端口闭合 | `uv run python scripts/check_ce_port_closure.py` | `ST_EDITION=ce` 下 `ports.*` 须全由 `novelvideo.ports.local.*` 满足 |
| 后端 i18n 棘轮 | `python3 scripts/check_backend_i18n.py` | 面向前端的进度/日志/toast 文案不许新增硬编码中文，预算只许降不许升 |
| 前端 i18n 棘轮 | `python3 scripts/check_frontend_i18n.py` | 存量已清零，**任何新命中直接失败**。确需中文的行加 `// i18n-exempt`，整块用 `// i18n-exempt-start` / `// i18n-exempt-end` |
| 违禁词 / EE 词 | `scripts/lint_banned_words.py`、`scripts/lint_ee_terms.py` | |
| CE 导入边界 | `scripts/lint_ce_imports.py` | |
| DCO | `scripts/check_dco.py` | 提交须带 `Signed-off-by` |

新增用户可见文案时，`frontend/public/locales/` 下 **zh / en / vi 三份都要补**，漏一份就是线上漏中文。

## 代码风格

Python 3.11 兼容，导入与包路径以 `src/novelvideo` 为根。4 空格缩进；公共接口与
dataclass/Pydantic 模型带类型标注；函数与模块 snake_case，类 PascalCase，常量全大写。
路由处理函数保持薄，可复用行为下沉到 services / ports / task runner。不要提交生成的媒体或本地运行态。

**本仓库的 docstring 惯例是写「为什么」而不是「是什么」**——看看
`src/novelvideo/agents/story_writer.py`、`freezone/bgm_separate.py`、`api/routes/story.py`
的模块头。做了非显然的取舍就照这个样子写下来，这是代码里最有价值的部分，请延续。

前端任何视觉改动先读 `DESIGN.md`——它是颜色、字体、间距、圆角、投影、动效的唯一来源，
与 `frontend/src/index.css` 的 CSS 变量互为镜像。变量变了要在同一个 commit 更新 `DESIGN.md`，
并保持 `npx @google/design.md lint DESIGN.md` 0 错误。

## 测试

pytest + pytest-asyncio（auto 模式）。测试文件命名 `test_*.py`，fixture 放 `tests/conftest.py`
除非作用域很窄。企业版或完整端到端测试用 `@pytest.mark.ee` / `@pytest.mark.e2e` 标记，
保证默认跑的是社区版友好的集合。API 契约、任务生命周期、存储迁移、供应商错误处理的改动，
都要补针对性回归测试。

## 提交与 PR

近期历史用短前缀：`fix:`、`feat(scope):`、`refactor(scope):`、`chore(scope):`；
主题用祈使句、具体。PR 要说明用户可见的变化、列出验证命令、关联 issue，
UI / API 契约改动附截图或样例输出。迁移、配置、模型供应商、合规影响要显式写出来。

**当前工作区有大量未提交改动**，拆提交时按工作线切（见 `docs/agent/STATE.md` 的表），
不要一个提交横跨多条线。

## 安全与配置

不要提交供应商密钥、签名 URL、凭据或生成的密钥。模型访问通过 `MODEL_PROVIDER`、
`MODEL_API_KEY` 等环境变量配置。改动配置、provisioning、备份、网关相关代码前跑一遍
gitleaks pre-commit 钩子。

这是公开仓库：内部过程文档（`docs/changes/`、`docs/adr/`、`docs/compliance/`、
`docs/superpowers/`）已被 `.gitignore` 排除。`docs/agent/` 是**例外，它进仓库**——
因为交接台账必须跟着代码走。所以往台账里写东西时，默认它会被外部看到。

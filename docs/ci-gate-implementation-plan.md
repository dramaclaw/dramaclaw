# DramaClaw CI Gate 实施运行单

> 基线：`ci-gate-baseline-proposal.md` v0.4（已批准）
>
> 状态：Phase 1 本地实现完成，等待独立 CODEOWNERS bootstrap、外部前置核验
> 与测试 PR
>
> 日期：2026-07-31

## 1. 本轮边界

本轮只新增仓库内 Gate 实现，保留全部 legacy workflows，不修改远端 required
checks、branch protection 或 ruleset。`.github/CODEOWNERS` 及其机械生成的
`license-inventory.csv` 记录必须作为独立 bootstrap PR 先合并；其余文件随后
进入 Gate PR，新旧 CI 在测试 PR 中双轨运行。

本轮新增或修改：

- `.github/workflows/pr-gate.yml`
- `.github/dependency-review-config.yml`
- `.github/CODEOWNERS`
- `scripts/ci_yaml.py`
- `scripts/check_dependency_review_config.py`
- `scripts/check_ci_gate_uniqueness.py`
- `scripts/check_ci_workflow_policy.py`
- `tests/test_ci_gate_policy.py`
- `pyproject.toml` 与 `uv.lock`

## 2. Phase 0 外部前置

当前 `main` 不存在 CODEOWNERS。GitHub 只读取 PR base branch 上的
CODEOWNERS，因此不得用包含 Gate 和 CODEOWNERS 的同一个首次 PR 宣称已完成
Code Owner 保护。必须按以下顺序执行：

1. 组织管理员创建或确认 `@dramaclaw/maintainers`；
2. team 至少两名活跃成员、组织内可见，并对仓库拥有 write 权限；
3. 提交只包含 `.github/CODEOWNERS` 及其机械生成
   `license-inventory.csv` 记录的 bootstrap PR；首个 PR 在现有保护下由两名
   已确认维护者人工批准后合并；
4. 启用或确认 require Code Owner review；
5. 新建一个修改 `.github/CODEOWNERS` 的测试 PR，确认自动请求 team review
   且未审批时不可合并，然后关闭而不合并；
6. 确认 Dependency Graph 已启用；
7. 导出当前 branch protection；
8. 记录 GitHub Actions expected App ID；
9. 指定切换执行人与独立复核人。

当前已认证账号查询 team 与仓库 team 接口均返回 404，因此第 1–3 项仍是明确
阻塞项，不得把 CODEOWNERS 标记为已验收。

## 3. Phase 1 实现参数

### Action pins

| Action | Release | Commit SHA |
| --- | --- | --- |
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `astral-sh/setup-uv` | v8.2.0 | `fac544c07dec837d0ccb6301d7b5580bf5edae39` |
| `actions/setup-node` | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| `pnpm/action-setup` | v6.0.9 | `0ebf47130e4866e96fce0953f49152a61190b271` |
| `actions/dependency-review-action` | v5.0.0 | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` |

### Toolchain 与 checkout

- uv 固定为 `0.11.31`；
- `pyproject.toml` 使用 `required-version = "==0.11.31"`；
- `setup-uv` 显式安装 `0.11.31`，治理脚本同时校验两处；
- 所有 checkout step 使用封闭 `with` 集合并设置
  `persist-credentials: false`；
- DCO 和 gitleaks checkout 额外保留 `fetch-depth: 0`。

### Timeouts

| Job | `timeout-minutes` |
| --- | ---: |
| backend | 60 |
| ce-policy | 10 |
| dependency-review | 10 |
| frontend | 30 |
| secret-scan | 20 |
| pr-policy | 10 |
| dramaclaw-pr-gate | 5 |

这些值用于第一轮观察，不是永久性能预算。Phase 5 根据 GitHub Actions 的
P95 数据单独调整。

### gitleaks

- 版本：`v8.30.1`
- 资产：`gitleaks_8.30.1_linux_x64.tar.gz`
- SHA256：
  `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`
- 顺序：完整下载 → checksum 校验 → 解压 → 全历史扫描
- 不使用 `gitleaks-action`

## 4. 本地验证记录

2026-07-31 已完成：

- `uv lock --check`
- `uv sync --frozen`
- Ruff 全仓检查
- 三个 CI 治理脚本
- CE import、allowlist、EE terms、banned words
- port closure
- Python dependency license audit
- 后端完整测试：2036 passed，16 skipped
- frontend frozen install
- frontend production build
- frontend tests：297 files、1956 tests 全部通过
- actionlint v1.7.12：`pr-gate.yml` 通过
- gitleaks v8.30.1：433 commits 全历史扫描，无发现
- CI 治理测试：31 passed

## 5. 测试 PR 验收

测试 PR 不合并，按以下顺序执行并保存链接：

1. 普通后端改动：backend、frontend 和最终 Gate 都运行；
2. 普通前端改动：backend、frontend 和最终 Gate 都运行；
3. docs-only 改动：backend、frontend 和最终 Gate 都运行；
4. Ruff、Vitest、CE import、DCO 分别制造一次失败；
5. 引入命中拒绝列表的新增依赖，确认 Dependency Review 与 Gate 失败；
6. 分别注入 `warn-only`、`allow-dependencies-licenses` 和 `INPUT_*`，确认治理
   脚本失败；
7. 分别注入 `secrets.TOKEN`、`secrets['TOKEN']` 和 `toJson(secrets)`，确认
   治理脚本失败；
8. 修改 checkout 输入和 uv 版本，确认封闭输入及工具版本检查失败；
9. 修改 gitleaks checksum，确认在解压前失败；
10. 污染条件 job 的 `verified` 输出，确认 Gate 失败；
11. 创建第二个单双引号同名 Gate，确认唯一性检查失败；
12. 连续 push 两次，确认 superseded run 被取消；
13. 用 Check Runs API 确认同一 SHA 只有一个 `dramaclaw-pr-gate`，且 App ID
    为迁移时核验的 GitHub Actions App；
14. 用 `[skip ci]` 测试确认 Gate 缺失时 PR 不可合并。

## 6. Phase 3–4 远端切换

### Phase 3：双重 required

1. 先将 `dramaclaw-pr-gate` 加入现有 required 集合；
2. expected source 指定为 GitHub Actions；
3. 保留旧六项 required；
4. 真实 PR 验证新旧 required 均生效；
5. 通过 API 复核 context 与 expected App。

### Phase 4：完全迁移到 ruleset

最终不保留精简 legacy branch protection。目标 repository ruleset 必须显式
包含：

- require pull request；
- 1 个 CODEOWNER approval；
- dismiss stale approvals；
- require approval of the most recent reviewable push；
- require conversation resolution；
- required check 仅 `dramaclaw-pr-gate`；
- expected source 为已核验的 GitHub Actions App；
- require branch up to date；
- require linear history；
- block force pushes；
- block deletions；
- persistent bypass list 为空。

切换顺序：

1. legacy protection 保持启用；
2. 创建并启用目标 ruleset；
3. 通过 API 将服务端配置与版本化目标逐项比较；
4. 用真实 PR 验证 ruleset；
5. 完全移除 legacy branch protection；
6. 再次通过 API 和真实 PR 验证最终状态；
7. 最后删除或改造重复的 legacy workflows。

任一目标规则缺失、expected App 不符或真实 PR 行为异常，都停止切换并保留
legacy protection。

## 7. 回滚

若新 Gate 系统性误阻断：

1. 保留失败运行与 API 证据；
2. 恢复旧六项 required；
3. 移除新 Gate 的 required 绑定；
4. 修复后重新完成测试 PR 和双重 required 阶段。

不得用 `continue-on-error`、吞错命令或放宽许可证政策作为回滚手段。

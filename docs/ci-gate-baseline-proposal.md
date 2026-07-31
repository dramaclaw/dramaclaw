# DramaClaw CI Required 集合与稳定 Gate 基线方案

> 状态：已批准基线 v0.4
>
> 日期：2026-07-31
>
> 范围：先在 `dramaclaw/dramaclaw` 落地并验证，再作为
> `claymorelab/SuperTale`、`claymorelab/supertale-admin-fe`、 <!-- banned-word-allow -->
> `claymorelab/claymore-llm-gateway` 的 CI 架构基线。
>
> 本文只讨论方案，不代表已经修改 GitHub 分支保护或工作流。

## 1. 摘要

DramaClaw 当前已经具备较完整的 CI 检查，但“仓库内定义了什么”与
“GitHub 实际要求什么”并不一致：

- `main` 当前受 legacy branch protection 保护；
- 实际 required status checks 只有 `deps`、`gitleaks`、
  `ce-import-lint`、`banned-words`、`ee-terms`、`dco`；
- `dependency-review`、`python-deps` 和前端 `build-test` 不是 required；
- 前端工作流使用 workflow 级 `paths`，不能直接加入 required，否则不相关
  PR 可能因检查不出现而永久 Pending；
- required checks 直接绑定多个内部 job 名，随着工作流拆分、重命名或优化，
  GitHub 配置容易与仓库代码再次漂移。

本方案建议：

1. 建立一个始终出现、仓库唯一、语义固定的最终检查
   `dramaclaw-pr-gate`；
2. 所有必须检查作为聚合 Gate 的显式依赖；
3. 第一版不引入 `changes` 或路径优化，所有 PR 都执行 frontend build/test；
4. 每个条件 job 必须自证“真实检查路径”或“明确 no-op 路径”恰好执行其一；
5. GitHub ruleset 只要求 `dramaclaw-pr-gate`，并将 expected source 固定为
   GitHub Actions；
6. 许可证政策迁移到受保护的版本化配置文件，完整保留现有拒绝列表；
7. 条件检查在“不适用”时显式成功，不允许整个 workflow 消失；
8. 先在 DramaClaw 双轨验证，再切换 required 集合；
9. 验证成熟后，仅复用架构和公共检查，不复制 DramaClaw 专属业务规则。

推荐结论：采用仓库唯一的 `dramaclaw-pr-gate` 作为合入契约，并将当前漏掉
的依赖许可证和前端验证纳入该契约。聚合 Gate 除检查 job result 外，还必须
校验条件 job 输出的 `verified=true`，从而证明关键执行路径确实运行。
frontend 第一版无条件运行，其成功结果直接证明 build/test 已执行，不依赖
未经验证的路径检测输出。

## 2. 背景与问题

### 2.1 当前工作流

当前与 PR 合入质量有关的工作流如下：

| 工作流 | Job / 检查 | 主要职责 | 当前 required |
| --- | --- | --- | --- |
| `ci.yml` | `deps` | lockfile、冻结安装、port closure、Ruff、Pytest | 是 |
| `secret-scan.yml` | `gitleaks` | 全历史密钥扫描 | 是 |
| `ce-import-lint.yml` | `ce-import-lint` | 禁止 CE 直接导入 EE 包 | 是 |
| `banned-words.yml` | `banned-words` | ELv2 对外用词规则 | 是 |
| `ee-terms.yml` | `ee-terms` | CE allowlist 与 EE 包名守栏 | 是 |
| `dco.yml` | `dco` | PR commit DCO 签署 | 是 |
| `dependency-review.yml` | `dependency-review` | PR 新增依赖许可证审查 | 否 |
| `dependency-review.yml` | `python-deps` | Python 已安装依赖许可证审查 | 否 |
| `frontend.yml` | `build-test` | TypeScript/Vite build 与 Vitest | 否 |

发布镜像、桌面出包和 Gitee 同步不属于 PR 合入门禁，不纳入本文的最终
`dramaclaw-pr-gate`。

### 2.2 主要缺口

#### 缺口 A：检查失败不等于阻止合并

未被 GitHub 设置为 required 的检查即使失败，也不一定阻止拥有合并权限的
用户合并 PR。当前许可证检查和前端检查属于这种状态。

#### 缺口 B：路径过滤与 required check 冲突

`frontend.yml` 使用 workflow 级 `paths`。后端 PR 不会创建 `build-test`
检查。如果把它直接设为 required，GitHub 可能一直等待一个永远不会出现的
检查。

#### 缺口 C：required 集合是易碎的外部配置

GitHub 当前直接绑定六个 job 名。以下任一变更都可能要求管理员同步修改
branch protection：

- 重命名 job；
- 拆分或合并 workflow；
- 引入 matrix；
- 增加路径过滤；
- 将检查迁移到 reusable workflow；
- 新增一个必须阻止合并的检查。

#### 缺口 D：重复运行和成本

多数现有工作流同时监听所有分支的 `push` 和 `pull_request`。同一分支上的
同一 commit 可能同时产生 push 和 PR 两套运行。

#### 缺口 E：许可证 fallback 覆盖不完整

`dependency-review` 在 Dependency Graph API 返回 403 时会跳过 GitHub
dependency review，并依赖 `python-deps` 兜底。但 Python 依赖扫描不能覆盖
`frontend/pnpm-lock.yaml`，因此该降级不是完整的前端依赖许可证门。

## 3. 目标与非目标

### 3.1 目标

- 任意 PR 都产生一个仓库唯一、名字固定的 `dramaclaw-pr-gate` 检查；
- 所有必须检查失败、取消或意外跳过时，聚合 Gate 必须失败；
- 条件 job 必须证明真实检查路径或 no-op 路径恰好执行其一；
- frontend 在所有 PR 和 `main` push 中执行完整 build/test；
- DCO、dependency review 等条件检查在不适用时显式成功；
- GitHub 只需维护一个 required status check；
- CI 内部可以安全演进，不需要频繁修改 GitHub 配置；
- 减少 feature 分支 push 与 pull request 的重复运行；
- 为其他三个仓库提供可以复用的结构、命名和 ruleset 约定。

### 3.2 非目标

- 本轮不重写现有测试；
- 本轮不增加 E2E、真实模型或 GPU 门禁；
- 本轮不把发布、部署、桌面出包纳入 PR gate；
- 本轮不要求其他三个仓库复制 CE import、EE terms、port closure 等
  DramaClaw 专属规则；
- 本轮不建设组织级 reusable workflow；
- 本轮不启用 merge queue。未来启用前必须增加 `merge_group` 触发并重新完成
  Gate 验收。

## 4. 设计原则

### 4.1 `dramaclaw-pr-gate` 是合入契约，内部 job 是实现细节

GitHub ruleset 只绑定：

```text
dramaclaw-pr-gate
```

工作流内部可以保留多个清晰的 job，但它们不直接成为 branch protection 的
长期外部接口。

不得在仓库内创建第二个 `name: dramaclaw-pr-gate` 的 job。GitHub required
status check 主要按 check 名识别；不同 workflow 中出现同名 job 会产生来源
歧义。Ruleset 还必须把 expected source 指定为 GitHub Actions。当前公开
check run 显示 GitHub Actions App ID 为 `15368`，切换时须通过 API 再次验证。

Expected source 只能限定产生状态的 GitHub App，不能区分两个都由 GitHub
Actions 运行的 workflow。它用于防止其他用户或其他 App 提交同名状态；仓库
内 GitHub Actions workflow 的同名冲突，必须由 YAML 语义唯一性检查、
CODEOWNERS 保护和 Check Runs API 验收共同发现。

### 4.2 条件 Job 必须自证执行路径

仅检查 `needs.<job>.result == success` 不足以证明关键 step 实际执行。例如，
dependency review 或 DCO 的适用条件写错后，真实检查可能 skipped，但 no-op
或空 job 仍以 success 结束。

因此，所有条件 job 必须实现执行路径协议：

- 适用：执行真实检查，成功或失败；
- 不适用：执行明确的 no-op step，job 结果为 success；
- job 内最后一个 `if: always()` assertion step 检查每个关键 step 的
  `steps.<id>.outcome`；
- 真实路径和 no-op 路径必须恰好执行一个；
- 真实路径适用时，全部必需 step 必须为 `success`，no-op 必须为 `skipped`；
- no-op 适用时，no-op 必须为 `success`，真实路径全部必需 step 必须为
  `skipped`；
- 两条路径均未执行、同时执行、适用性输出不是 `true|false`，或任一必需
  step 不是预期结果时，assertion 必须失败；
- assertion 成功后输出 `verified=true`；
- 聚合 Gate 同时检查 job result 和 `verified=true`。

条件 job 至少包括：

- `dependency-review`
- `pr-policy`

不允许依赖 workflow 级 `paths` 让 required 检查消失。

### 4.3 Fail closed

GitHub Actions `needs.<job>.result` 的有效枚举是：

- `success`
- `failure`
- `cancelled`
- `skipped`

聚合 Gate 只接受 `success`。此外，条件 job 的 `verified` 只接受字符串
`true`。job result 成功但缺少 `verified=true` 时仍必须失败。

### 4.4 最小权限

PR gate 默认：

```yaml
permissions:
  contents: read
```

确实需要额外权限的 job 单独声明。PR gate 不应持有部署、packages write、
contents write 或生产环境凭据。

### 4.5 先建立稳定语义，再抽 reusable workflow

第一版优先放在一个顶层 `pr-gate.yml` 中，降低跨 workflow 聚合复杂度。
本期明确不抽组织级 reusable workflow。DramaClaw 稳定运行并完成复盘后，
另立提案决定是否抽取，实施者本期无需重新做该架构决策。

### 4.6 固定执行环境

第一版仅要求 `.github/workflows/pr-gate.yml` 及其调用链中的
GitHub-hosted Linux jobs 使用：

```yaml
runs-on: ubuntu-24.04
```

不使用会随 GitHub 默认值漂移的 `ubuntu-latest`。Phase 1 原样保留的旧 CI、
release 和 sync workflows 不在本期固定 runner 的范围内；后续全仓加固必须
另立工作包并补充发布、同步验证。Gate 调用链升级 runner 版本必须通过单独
PR 并完成 Gate 验收。

### 4.7 Action 固定版本

本文示例中的 `<full-commit-sha>` 是方案占位符，不是可提交内容。实施 PR
必须替换成已核验的 40 位 commit SHA，并在同行注释对应 release 版本，例如：

```yaml
uses: actions/checkout@<verified-40-char-sha> # vX.Y.Z
```

本期 SHA pin 范围仅为 `.github/workflows/pr-gate.yml` 及其调用链。静态
验收必须在该范围拒绝残留 `<full-commit-sha>`、`@main`、`@master` 或仅使用
可变 major tag 的外部 Action，包括 `actions/*`。调用链定义为从
`pr-gate.yml` 出发，递归跟随本仓 reusable workflow 和 composite action 的
`uses:`；无法解析的本仓调用必须失败。Phase 1 原样保留的旧 CI、release 和
sync workflows 不纳入这项验收，避免把全仓 workflow 加固隐式扩大为迁移
前置。

## 5. 建议的 Job 拆分

### 5.1 第一版不设置 `changes`

第一版不使用路径检测 Action、自行 Git diff、workflow 级 `paths` 或
`changes.outputs.frontend`。frontend 在所有 PR 和 `main` push 中完整运行。
这是已经关闭的安全决策：在路径检测本身尚未经过独立证明前，不允许用
“frontend=false + no-op”作为放行路径。

路径优化只能在 Gate 稳定观察后作为独立提案引入，并必须一次性明确：

- 采用哪个固定 commit SHA 的 Action，或给出完整 Git diff 算法；
- PR、fork PR、`push main` 分别比较哪两个 SHA；
- token 权限和 checkout 深度；
- frontend 文件变更必定输出 `true` 的自动化测试；
- `pr-gate.yml`、路径规则和检测脚本自身变更时强制 frontend 运行；
- 输出缺失、非法值、误报 `false` 和 base/head 不可用时的 fail-closed 测试。

### 5.2 `backend`

职责：

1. `uv lock --check`
2. `uv sync --frozen`
3. `uv run python scripts/check_dependency_review_config.py`
4. `uv run python scripts/check_ci_gate_uniqueness.py`
5. `uv run python scripts/check_ci_workflow_policy.py`
6. `uv run python scripts/check_ce_port_closure.py`
7. `uv run ruff check --output-format=github .`
8. `uv run python scripts/check_dependency_licenses.py`
9. `uv run pytest -n auto`

将 `python-deps` 合入 `backend` 的理由：

- 两者都需要完整 Python 环境；
- 避免重复下载和安装大型依赖；
- 失败仍能通过 step 名精确定位；
- 聚合 Gate 不依赖当前 `python-deps` job 名。

其中三个 CI 治理脚本分别验证许可证配置的固定字段与完整拒绝集合、全仓 Gate
check 名唯一性，以及第 4.6–4.7 节的 scoped runner/Action pin 政策。
`pyyaml==6.0.3` 必须成为直接 dev dependency，不能依赖其他包偶然传递安装。
三个脚本必须复用一个拒绝重复 mapping key 的 SafeLoader，不能接受 YAML
解析时“后一个同名 key 覆盖前一个”的默认行为。

建议超时：45–60 分钟，最终按历史 P95 运行时间确定。

### 5.3 `ce-policy`

职责：

1. `python3 scripts/lint_ce_imports.py`
2. `python3 scripts/ce_allowlist.py`
3. `python3 scripts/lint_ee_terms.py`
4. `python3 scripts/lint_banned_words.py`

这些检查只依赖标准库和 Git，成本低，所有 PR 和 `main` push 都执行。

建议超时：10 分钟。

### 5.4 `dependency-review`

PR 时执行 GitHub dependency review；`main` push 时执行 no-op。

本期决策已经关闭：

- 必须启用 Dependency Graph；
- Dependency Graph API 或 dependency review action 不可用时 fail closed；
- 删除当前 403 时成功跳过的降级逻辑；
- 保持 `vulnerability-check: false`；
- 漏洞检查本期不加入许可证 Gate，后续另立提案；
- 许可证政策迁移到 `.github/dependency-review-config.yml`；
- 完整保留现有 GPL、AGPL、SSPL 共 11 项拒绝列表；
- `actions/dependency-review-action` 固定为 `v5.0.0` 对应的 40 位 commit
  `a1d282b36b6f3519aa1f3fc636f609c47dddb294`；
- Python 全量许可证检查继续由 `backend` 执行。

版本化配置文件固定为：

```yaml
# .github/dependency-review-config.yml
vulnerability-check: false
license-check: true
deny-licenses:
  - AGPL-1.0-only
  - AGPL-1.0-or-later
  - AGPL-3.0-only
  - AGPL-3.0-or-later
  - GPL-1.0-only
  - GPL-1.0-or-later
  - GPL-2.0-only
  - GPL-2.0-or-later
  - GPL-3.0-only
  - GPL-3.0-or-later
  - SSPL-1.0
```

`license-check: true` 本身不代表存在许可证准入政策；上述拒绝列表是 Gate
语义的一部分，不得在迁移时丢失。上游已经将 `deny-licenses` 标记为未来
major release 可能移除的 deprecated option，因此本期固定在已核验且仍支持
该策略的 `v5.0.0`。不得自动升级到后续 major；升级提案必须先定义并演练
等价或更严格的 allow/deny 策略，不能通过删除拒绝列表来消除弃用告警。

`scripts/check_dependency_review_config.py` 必须以 YAML 语义校验
顶层对象的 key 集合严格等于：

```text
vulnerability-check
license-check
deny-licenses
```

任何额外 key 都失败，包括 `warn-only`、`allow-dependencies-licenses`、
`allow-licenses`、`allow-ghsas` 或未来新增字段。随后校验
`vulnerability-check == false`、`license-check == true`，并要求
`deny-licenses` 是无重复字符串数组且集合与上述 11 项完全一致；字段缺失、
类型错误、重复项、多项或少项均失败。政策调整必须同时修改方案、配置和
校验脚本，并经过 CODEOWNERS 审批。

该条件 job 必须输出 `verified=true`。PR 路径要求 checkout 和 dependency
review step 均为 `success`，no-op 为 `skipped`；`main` push 路径要求真实
检查 steps 均为 `skipped`，no-op 为 `success`。最终 assertion 使用
`if: always()`，两条路径均未执行或同时执行时失败。

示意：

```yaml
dependency-review:
  runs-on: ubuntu-24.04
  outputs:
    verified: ${{ steps.assert_path.outputs.verified }}
  steps:
    - name: Checkout
      id: checkout
      if: github.event_name == 'pull_request'
      uses: actions/checkout@<full-commit-sha>

    - name: Review new dependencies' licenses
      id: review
      if: github.event_name == 'pull_request'
      # v5.0.0；不得自动升级到移除 deny-licenses 的 major
      uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294
      with:
        config-file: ./.github/dependency-review-config.yml

    - name: Dependency review not applicable
      id: no_op
      if: github.event_name != 'pull_request'
      run: echo "Dependency review applies to pull requests only."

    - name: Assert dependency-review execution path
      id: assert_path
      if: always()
      env:
        APPLICABLE: ${{ github.event_name == 'pull_request' }}
        CHECKOUT_OUTCOME: ${{ steps.checkout.outcome }}
        REVIEW_OUTCOME: ${{ steps.review.outcome }}
        NOOP_OUTCOME: ${{ steps.no_op.outcome }}
      run: |
        set -euo pipefail
        if [ "$APPLICABLE" = "true" ]; then
          [ "$CHECKOUT_OUTCOME" = "success" ]
          [ "$REVIEW_OUTCOME" = "success" ]
          [ "$NOOP_OUTCOME" = "skipped" ]
        elif [ "$APPLICABLE" = "false" ]; then
          [ "$CHECKOUT_OUTCOME" = "skipped" ]
          [ "$REVIEW_OUTCOME" = "skipped" ]
          [ "$NOOP_OUTCOME" = "success" ]
        else
          echo "::error::invalid dependency-review applicability: $APPLICABLE"
          exit 1
        fi
        echo "verified=true" >> "$GITHUB_OUTPUT"
```

### 5.5 `frontend`

该 job 在所有 PR 和 `main` push 中都完整运行，不设置 `if`、路径过滤、no-op
或 `changes` 依赖：

1. checkout；
2. 安装 pnpm；
3. Node 22；
4. `pnpm install --frozen-lockfile`；
5. `pnpm build`；
6. `pnpm test`。

示意：

```yaml
frontend:
  runs-on: ubuntu-24.04
  steps:
    - name: Checkout
      uses: actions/checkout@<full-commit-sha>

    - name: Install pnpm
      uses: pnpm/action-setup@<full-commit-sha>
      with:
        package_json_file: frontend/package.json

    - name: Setup Node
      uses: actions/setup-node@<full-commit-sha>
      with:
        node-version: "22"
        cache: pnpm
        cache-dependency-path: frontend/pnpm-lock.yaml

    - name: Install dependencies
      run: pnpm install --frozen-lockfile
      working-directory: frontend

    - name: Build
      run: pnpm build
      working-directory: frontend

    - name: Unit tests
      run: pnpm test
      working-directory: frontend
```

由于没有条件分支，任一关键 step 失败都会使 job 失败，后续 step skipped 也
不会把 job 恢复为 success。Gate 只需校验 `frontend.result == success`。该
job 禁止使用 job/step 级 `continue-on-error` 或吞错命令。

建议超时：20–30 分钟。

### 5.6 `secret-scan`

职责：gitleaks。

本期决策：第一版保持现有全历史扫描语义，以减少同时改变门禁和扫描范围的
风险。实施者本期不调整为 PR 增量扫描。是否优化扫描范围在稳定运行复盘后
另立提案。

安装方式不再二选一，本期固定为：

- 保留当前直接下载 gitleaks 二进制的方式；
- 不使用 `gitleaks-action`，维持当前针对组织私有仓库许可证限制的取舍；
- 版本固定为 `v8.30.1`；
- 资产固定为 `gitleaks_8.30.1_linux_x64.tar.gz`；
- 该资产在官方 release checksums 文件中的 SHA256 固定为
  `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`；
- 必须先完整下载压缩包、校验 SHA256，再解压和加入 `PATH`；
- 继续使用 `fetch-depth: 0` 和 `gitleaks git . -c .gitleaks.toml
  --redact --no-banner --exit-code 1` 扫描全历史。

安装 step 示意：

```yaml
- name: Install pinned gitleaks binary
  env:
    GITLEAKS_VERSION: 8.30.1
    GITLEAKS_ARCHIVE_SHA256: >-
      551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
  run: |
    set -euo pipefail
    archive="${RUNNER_TEMP}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    install_dir="${RUNNER_TEMP}/gitleaks-bin"
    mkdir -p "$install_dir"
    curl --fail --show-error --silent --location \
      --output "$archive" \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    printf '%s  %s\n' "$GITLEAKS_ARCHIVE_SHA256" "$archive" |
      sha256sum --check -
    tar -xzf "$archive" -C "$install_dir" gitleaks
    "$install_dir/gitleaks" version
    echo "$install_dir" >> "$GITHUB_PATH"
```

版本或 checksum 变化必须由独立升级 PR 完成，附官方 release/checksums
来源，并经过 `@dramaclaw/maintainers` CODEOWNERS 审批。不得在实施时改选
Action 安装路线。

### 5.7 `pr-policy`

PR 时执行 DCO；`main` push 时显式 no-op。

`check_dco.py` 使用 `base.sha..head.sha`，因此 PR 路径必须完整 checkout
历史，不得退化为默认浅克隆：

```yaml
pr-policy:
  runs-on: ubuntu-24.04
  outputs:
    verified: ${{ steps.assert_path.outputs.verified }}
  steps:
    - name: Checkout full history for DCO
      id: checkout
      if: github.event_name == 'pull_request'
      uses: actions/checkout@<full-commit-sha>
      with:
        fetch-depth: 0

    - name: Check DCO sign-off
      id: dco
      if: github.event_name == 'pull_request'
      run: >-
        python3 scripts/check_dco.py
        "${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}"

    - name: DCO not applicable
      id: no_op
      if: github.event_name != 'pull_request'
      run: echo "DCO applies to pull requests only."

    - name: Assert pr-policy execution path
      id: assert_path
      if: always()
      env:
        APPLICABLE: ${{ github.event_name == 'pull_request' }}
        CHECKOUT_OUTCOME: ${{ steps.checkout.outcome }}
        DCO_OUTCOME: ${{ steps.dco.outcome }}
        NOOP_OUTCOME: ${{ steps.no_op.outcome }}
      run: |
        set -euo pipefail
        if [ "$APPLICABLE" = "true" ]; then
          [ "$CHECKOUT_OUTCOME" = "success" ]
          [ "$DCO_OUTCOME" = "success" ]
          [ "$NOOP_OUTCOME" = "skipped" ]
        elif [ "$APPLICABLE" = "false" ]; then
          [ "$CHECKOUT_OUTCOME" = "skipped" ]
          [ "$DCO_OUTCOME" = "skipped" ]
          [ "$NOOP_OUTCOME" = "success" ]
        else
          echo "::error::invalid pr-policy applicability: $APPLICABLE"
          exit 1
        fi
        echo "verified=true" >> "$GITHUB_OUTPUT"
```

不要把 `if: github.event_name == 'pull_request'` 放在整个 job 上。

### 5.8 `dramaclaw-pr-gate`

最终 job：

- job ID 可为 `gate`，但对外 `name` 固定为仓库唯一的
  `dramaclaw-pr-gate`；
- `if: always()`；
- `needs` 显式列出所有必须 job；
- 只有所有依赖结果均为 `success` 时通过；
- 条件 job `dependency-review`、`pr-policy` 必须同时输出
  `verified=true`；frontend 无条件运行，不使用该输出；
- 不允许 `continue-on-error`；
- 不允许 `|| true` 吞掉失败。

示意：

```yaml
gate:
  name: dramaclaw-pr-gate
  if: always()
  runs-on: ubuntu-24.04
  needs:
    - backend
    - ce-policy
    - dependency-review
    - frontend
    - secret-scan
    - pr-policy
  steps:
    - name: Verify all required jobs passed
      env:
        NEEDS_JSON: ${{ toJson(needs) }}
      run: |
        set -euo pipefail
        printf '%s\n' "$NEEDS_JSON" | jq .
        printf '%s\n' "$NEEDS_JSON" |
          jq -e '
            all(.[]; .result == "success") and
            ."dependency-review".outputs.verified == "true" and
            ."pr-policy".outputs.verified == "true"
          '
```

注意：job result 只能说明 job 最终状态；`verified=true` 才证明条件 job 的
关键执行路径通过了内部断言。两者缺一不可。

全仓唯一性不得用正则作为唯一证明。实施时新增
`scripts/check_ci_gate_uniqueness.py`，并将当前 lockfile 已锁定的
`pyyaml==6.0.3` 声明为直接 dev dependency。脚本必须：

1. 解析 `.github/workflows/*.yml` 和 `.github/workflows/*.yaml`；
2. 遍历所有 `jobs.<job_id>`；
3. 将 `jobs.<job_id>.name` 的字面值作为 check 名；未设置 `name` 时将
   `job_id` 作为有效名称；
4. 动态 `jobs.<job_id>.name` 无法静态证明，第一版发现 `${{ ... }}`
   表达式即失败；
5. 要求有效名称严格等于 `dramaclaw-pr-gate` 的 job 恰好一个；
6. YAML 解析失败、`jobs` 结构非法或数量不是 1 时非零退出。

YAML 解析可以同时识别未加引号、单引号和双引号的合法写法，不再依赖文本
格式。该脚本应纳入 CI 治理验收，并通过 GitHub Check Runs API 再确认同一
SHA 上只有一个名为 `dramaclaw-pr-gate`、`app.id == 15368` 的 check run。
静态检查负责阻止仓库内第二个同名 job；运行时检查负责发现触发、配置或迁移
造成的实际重复。

`scripts/check_ci_workflow_policy.py` 使用同一 YAML 解析依赖，从
`pr-gate.yml` 递归解析本仓 `uses:` 调用链，并仅对可达文件执行以下检查：

- GitHub-hosted Linux job 的 runner 必须严格为 `ubuntu-24.04`；
- 所有非本仓 `uses:` 引用必须以 40 位十六进制 commit SHA 固定。
- `dependency-review` job 中必须恰好存在一个 `id: review` step；
- 该 step 的 `uses` 必须严格等于
  `actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294`；
- 该 step 的 `with` 必须是 mapping，且 key 集合严格等于
  `{config-file}`；
- `config-file` 必须严格等于
  `./.github/dependency-review-config.yml`；
- 该 step 和所在 job 均不得设置 `continue-on-error`。
- workflow、所在 job 和该 step 的 `env` 均不得声明任何 `INPUT_*` 名称，
  防止绕过 `with` 封闭集合向 Action 注入输入；
- Gate 调用链中不得引用 `gitleaks-action`；
- gitleaks 安装 step 的版本、资产名和 SHA256 必须等于第 5.6 节固定值。

扫描器不得遍历并拒绝不可达的 legacy CI、release 或 sync workflows；但本仓
调用目标缺失、路径逃出仓库或调用链无法解析时必须 fail closed。

## 6. 触发与并发策略

建议顶层触发：

```yaml
name: pr-gate

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

concurrency:
  group: pr-gate-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

预期效果：

- feature 分支只因 PR 运行一次；
- 合并到 `main` 后再验证一次；
- 不再对所有 feature 分支 push 运行第二套相同 CI；
- PR 更新时取消旧 commit 的运行；
- 分支保护只关注最新 PR head SHA 的 `dramaclaw-pr-gate`。

本期不启用 merge queue，因此第一版不声明 `merge_group`。未来若启用 merge
queue，必须先增加：

```yaml
on:
  merge_group:
```

并重新验证 merge-group SHA 上会产生唯一的 `dramaclaw-pr-gate`，之后才能
打开 merge queue。

GitHub 支持通过 commit message 中的 `[skip ci]` 等标记跳过 `push` 和
`pull_request` workflow。本方案不禁止该语法，但 required check 缺失时 PR
必须保持不可合并。该行为必须在 Gate 加入 required 后实测，不能只凭文档
假设。

## 7. GitHub Ruleset 建议

建议新建 repository ruleset，目标为 `main`：

| 规则 | 建议 |
| --- | --- |
| Require pull request | 开启 |
| Required approvals | 1 个 CODEOWNER approval |
| Dismiss stale approvals | 开启 |
| Require CODEOWNERS review | 对 CI/门禁文件开启 |
| Require conversation resolution | 开启 |
| Required status checks | 只要求 `dramaclaw-pr-gate` |
| Expected source | GitHub Actions；迁移时验证 App ID `15368` |
| Require branch up to date | 开启 |
| Merge queue | 本期不开启 |
| Block force pushes | 开启 |
| Block deletions | 开启 |
| Persistent bypass list | 空；正常管理员也不长期绕过 |

当前公开接口显示 required checks 的 enforcement level 为 `non_admins`。
本期迁移后改为对管理员同样生效，不配置持久 bypass actor。

Break-glass 策略已经关闭：

1. 仅 P0/P1 生产或供应链事故可以申请；
2. 由两个组织 owner 进行双人确认；
3. 先建立带时间戳、原因、影响范围和回滚计划的安全事件记录；
4. 组织 owner 临时修改 ruleset，而不是在 workflow 中加入
   `continue-on-error`；
5. 应急操作完成后 30 分钟内恢复 ruleset；
6. 通过 GitHub audit log 和事件记录复核；
7. 常规测试失败、CI 慢或等待 review 不构成 break-glass 条件。

Ruleset 中 required status check 必须同时记录 context
`dramaclaw-pr-gate` 和 expected integration GitHub Actions。Expected source
防止其他用户或非 GitHub Actions App 提交同名状态，但不能区分两个 GitHub
Actions workflows。后者由全仓 YAML 语义唯一性检查、CODEOWNERS 保护和同一
SHA 的 Check Runs API 验收控制。

## 8. Gate 自身的变更保护

单一聚合 Gate 成为 required 后，必须保护定义 Gate 的文件及其调用脚本。

CODEOWNERS team 固定为 `@dramaclaw/maintainers`。当前匿名 GitHub API 无法
读取组织 team，因此不能把该 team 的存在和权限伪报为已验证。实施责任人
`@lywaterman` 必须在 Phase 0 创建或确认该 team，并满足：

- team 在组织内可见，不是 secret team；
- team 对 `dramaclaw/dramaclaw` 至少拥有 write 权限；
- team 至少有两名活跃维护者；
- ruleset 的 CODEOWNERS review 能识别该 team；
- 使用已认证 GitHub API 和测试 PR 留下验证证据。

在以上条件全部满足前，不得进入 Gate Phase 1。唯一允许提前执行的是
CODEOWNERS bootstrap；这是建立后续保护本身所必需的前置步骤。CODEOWNERS
内容固定为：

```text
/.github/CODEOWNERS        @dramaclaw/maintainers
/.github/workflows/        @dramaclaw/maintainers
/.github/dependency-review-config.yml @dramaclaw/maintainers
/scripts/check_*.py        @dramaclaw/maintainers
/scripts/lint_*.py         @dramaclaw/maintainers
/scripts/ce_allowlist.py   @dramaclaw/maintainers
/pyproject.toml            @dramaclaw/maintainers
/.gitleaks.toml            @dramaclaw/maintainers
/ce-allowlist.toml         @dramaclaw/maintainers
```

同时要求：

- `pr-gate.yml` 及其调用链中的所有外部 Actions（含 `actions/*`）固定到
  完整 commit SHA；
- 保留注释标明对应版本；
- PR gate 不读取生产 secrets；
- fork PR 只运行只读检查；
- workflow 修改必须经过 CODEOWNERS 审批。

验证命令示意：

```bash
gh api orgs/dramaclaw/teams/maintainers
gh api repos/dramaclaw/dramaclaw/teams
```

API 结果必须证明 team slug、visibility/privacy 和仓库 permission 符合上述
要求。由于 GitHub 只读取 PR base branch 上的 CODEOWNERS，而当前 `main`
不存在该文件，bootstrap 必须单独完成：

1. 先创建并验证 `@dramaclaw/maintainers`；
2. 提交一个只新增 `.github/CODEOWNERS` 的 bootstrap PR；
3. 首个 PR 无法由尚未位于 base branch 的 CODEOWNERS 自我保护，因此必须在
   现有 branch protection 下由两名已确认维护者人工批准；
4. 合并 bootstrap PR，并启用或确认 require Code Owner review；
5. 再创建一个修改 `.github/CODEOWNERS` 的测试 PR，确认 GitHub 自动请求
   `@dramaclaw/maintainers` review 且未审批时不可合并；该测试 PR 关闭而不
   合并；
6. 以上证据齐全后才能提交 Gate Phase 1 PR。

## 9. 迁移计划

### Phase 0：外部前置核验

架构决策已经在第 13 节关闭。Phase 0 不再重新讨论架构，只完成外部状态核验：

1. `@lywaterman` 创建或确认 `@dramaclaw/maintainers` team；
2. 验证 team 可见、至少两名成员且对仓库拥有 write 权限；
3. 按第 8 节独立合并 CODEOWNERS bootstrap PR；
4. 用后续测试 PR 验证 Code Owner 自动请求与未审批阻断；
5. 验证 Dependency Graph 已启用；
6. 导出当前 legacy branch protection 配置；
7. 将目标 ruleset 配置写入版本化基线文件；
8. 通过 API 记录 GitHub Actions expected App ID；
9. 建立迁移操作单，指定实施人和独立复核人。

任何一项未完成都阻止 Phase 1，但不重新打开已经关闭的架构决策。

### Phase 1：新增 Gate，不改现有保护

- 新增 `pr-gate.yml`；
- 新增受保护的 `.github/dependency-review-config.yml`，完整迁移现有
  11 项拒绝许可证；
- 新增 YAML 语义唯一性和 scoped workflow policy 检查脚本，并把
  `pyyaml==6.0.3` 声明为直接 dev dependency；
- 将 uv 工具版本固定在 `pyproject.toml` 的
  `[tool.uv].required-version`，并由 `setup-uv` 使用同一精确版本；
- 所有 checkout steps 使用封闭 `with` 集合并设置
  `persist-credentials: false`；
- 将 gitleaks 二进制安装迁入 Gate，固定 `v8.30.1`、Linux x64 资产及本文
  SHA256，并保持全历史扫描；
- 暂时保留所有旧 workflow；
- 新 `dramaclaw-pr-gate` 仅作为观察项；
- 新旧检查并行运行。

该阶段会暂时增加重复运行和 CI 成本。“减少重复 CI”只有在 Phase 4 删除或
改造旧 workflow 后才实现，不把 Phase 1 的临时重复误报为优化收益。

验收样例：

| PR 类型 | 预期 |
| --- | --- |
| 仅后端 | backend 与 frontend build/test 都真跑；聚合 Gate success |
| 仅前端 | backend 与 frontend build/test 都真跑；聚合 Gate success |
| 仅文档 | backend 与 frontend build/test 都真跑；聚合 Gate success |
| Python 依赖变更 | lock、Python license、dependency review 真跑 |
| pnpm lock 变更 | frontend 与 dependency review 真跑 |
| workflow 自身变更 | frontend 仍完整运行；条件 job 路径断言生效 |

### Phase 2：失败演练

使用测试 PR 验证：

1. 制造 Ruff 失败，`backend` 和 `dramaclaw-pr-gate` 必须失败；
2. 制造 Vitest 失败，`frontend` 和 `dramaclaw-pr-gate` 必须失败；
3. 制造 CE import 失败，`ce-policy` 和 `dramaclaw-pr-gate` 必须失败；
4. 测试 PR 引入一个经测试时复核、许可证命中拒绝列表的新增依赖，确认
   `dependency-review` 和 `dramaclaw-pr-gate` 失败并产生许可证诊断；
5. 临时删除或清空配置中的拒绝列表，确认
   `check_dependency_review_config.py`、`backend` 和聚合 Gate 失败；
6. 在配置文件中分别加入 `warn-only: true` 和
   `allow-dependencies-licenses`，确认封闭 schema 校验失败；
7. 在 dependency review step 的 `with` 中分别加入 `warn-only: true` 和
   `allow-dependencies-licenses`，并尝试用 `INPUT_*` env 注入，确认 workflow
   policy 校验失败；
8. 让 dependency review 的真实路径和 no-op 同时运行，确认 assertion 失败；
9. 删除或污染 `verified` 输出，确认聚合 Gate 即使 job success 也失败；
10. 将 DCO checkout 临时改为浅克隆，确认回归测试或评审能识别退化；
11. 将 gitleaks checksum 改错，确认安装 step 在解压前失败；同时确认 Gate
    调用链不存在 `gitleaks-action`；
12. 连续 push 两次，确认旧运行被取消且最新运行正常；
13. 在另一个 job 中分别使用未加引号、单引号和双引号的
    `dramaclaw-pr-gate`，确认 YAML 唯一性脚本均失败；
14. 通过 Check Runs API 确认同一 SHA 只有一个同名、App ID 为 `15368` 的
    GitHub Actions check。

测试 PR 不合并；演练改动完成验证后关闭。

### Phase 3：双重保护切换

1. 先把 `dramaclaw-pr-gate` 加入现有 required 集合，并指定 expected source
   为 GitHub Actions；
2. 此时旧六项 required 暂时保留；
3. 用一个真实 PR 验证新旧 required 均正常；
4. 确认 `dramaclaw-pr-gate` 在后端、前端和文档 PR 中都出现；
5. 创建带 `[skip ci]` commit message 的测试 PR，确认 Gate 不出现时 PR
   保持不可合并；
6. 通过 GitHub API 验证 required context 和 expected App。

该阶段宁可临时重复保护，不留无门禁窗口。

### Phase 4：收敛 Required 集合

1. 在 legacy branch protection 仍生效时创建并启用目标 repository ruleset；
2. 通过 API 验证 ruleset 要求 `dramaclaw-pr-gate`、expected source 和无
   persistent bypass；
3. 用真实 PR 确认 ruleset 生效；
4. 再移除 legacy protection 中的旧六项 required；
5. 通过 API 确认服务端最终只要求 `dramaclaw-pr-gate`；
6. 删除或改造旧 workflow，消除重复运行；
7. 再跑一个真实 PR，确认旧 check 消失但聚合 Gate 正常。

不得先移除 legacy required 再创建 ruleset，避免无门禁窗口。

### Phase 5：观察与优化

观察至少 1–2 周：

- 各 job P50/P95 时长；
- 缓存命中率；
- 取消运行数量；
- 偶发失败率；
- false positive；
- dependency review 可用性；
- fork PR 行为。

本期成功指标：

| 指标 | 目标 |
| --- | --- |
| 应运行 PR 的 Gate 缺失率 | 0% |
| 关键 step 未执行但 Gate success 的误放行 | 0 次 |
| required 检查失败但 PR 可合并 | 0 次 |
| 同一 SHA 的同名聚合 Gate 数量 | 恰好 1 |
| 缓存命中时 Gate 完成 P95 | 不超过 45 分钟 |
| 冷缓存 Gate 完成 P95 | 不超过 60 分钟 |
| 无代码变化重跑即恢复的偶发失败率 | 低于 2% |
| 非预期取消率 | 0% |
| superseded run 自动取消成功率 | 不低于 95% |

`[skip ci]` 导致 workflow 按设计不运行时不计入“应运行 PR 的 Gate 缺失率”，
但必须计入单独审计，并保证 PR 不可合并。

以下优化不在本期临时决定，必须另立提案：

- docs-only 跳过 backend；
- frontend 路径检测与 no-op 优化；提案必须满足第 5.1 节的证明义务；
- 组织级 reusable workflow；
- merge queue 与 `merge_group`；
- 漏洞、SBOM 或容器构建门；
- gitleaks 改为增量扫描。

## 10. 回滚方案

### 工作流回滚

如果新 `dramaclaw-pr-gate` 出现系统性误阻断：

1. 保留工作流失败证据；
2. 临时恢复旧六项 required；
3. 从 required 集合移除 `dramaclaw-pr-gate`；
4. 修复 `pr-gate.yml` 后重新走 Phase 1–3。

不得通过给检查增加 `continue-on-error` 或 `|| true` 来静默放行。

### Ruleset 回滚

迁移前使用已认证 GitHub API 导出并版本化：

```text
docs/ci-governance/main-branch-protection-before.json
docs/ci-governance/main-ruleset-target.json
```

导出文件必须去除 API 响应中的临时 URL、时间戳或无关元数据，但保留：

- 分支匹配范围；
- required check context；
- expected integration/App；
- approval 和 CODEOWNERS 规则；
- bypass actor/mode；
- force-push、deletion、conversation resolution 设置。

新 ruleset 启用后，再通过 API 读取服务端配置，与版本化 target 做语义比较，
并保存迁移操作单中的验证输出。若出现权限或合并流程异常，可以禁用新
ruleset，并按 `main-branch-protection-before.json` 恢复原配置。

## 11. 验收标准

方案实施完成需同时满足：

- [ ] 除 `[skip ci]` 测试外，所有 PR 都创建 `dramaclaw-pr-gate`；
- [ ] backend-only、frontend-only 和 docs-only PR 都执行 frontend build 与
      Vitest；
- [ ] 第一版不存在 `changes` job、frontend 路径过滤或 frontend no-op；
- [ ] dependency-review、pr-policy 均输出 `verified=true`；
- [ ] 条件 job 的真实路径和 no-op 必须恰好执行一个；
- [ ] 关键 step 全 skipped 但 job success 时，聚合 Gate 仍失败；
- [ ] 任一必须检查失败时聚合 Gate 失败；
- [ ] 任一必须检查取消或意外 skipped 时聚合 Gate 失败；
- [ ] Dependency Graph 不可用时 fail closed；
- [ ] `.github/dependency-review-config.yml` 保留完整 11 项拒绝列表；
- [ ] dependency review 配置顶层 key 严格等于三个批准字段，额外字段和
      重复 YAML key 均失败；
- [ ] `actions/dependency-review-action` 固定为本文核验的 `v5.0.0` commit；
- [ ] dependency review step 的 `with` 只包含固定 `config-file`，Action、
      路径或额外输入发生变化时 workflow policy 检查失败；
- [ ] `warn-only: true` 和 `allow-dependencies-licenses` 在配置文件及
      workflow `with` 中的负向测试均失败，`INPUT_*` env 注入同样失败；
- [ ] 测试 PR 引入被拒绝许可证时 dependency review 和 Gate 均失败；
- [ ] gitleaks 使用固定 `v8.30.1` Linux x64 二进制与本文 SHA256，且校验
      成功后才解压；
- [ ] checksum 错误时安装在解压前失败，Gate 调用链不存在
      `gitleaks-action`；
- [ ] feature 分支不再重复运行 push 和 PR 两套门禁；
- [ ] `main` 仍在合并后运行聚合 Gate；
- [ ] GitHub required status checks 只保留 `dramaclaw-pr-gate`；
- [ ] expected source 是 GitHub Actions；
- [ ] expected source 的验收不声称能够区分两个 GitHub Actions workflows；
- [ ] YAML 解析器确认全仓不存在第二个同名 job，并覆盖单双引号写法；
- [ ] 同一 SHA 只有一个同名 GitHub Actions check run；
- [ ] `[skip ci]` 导致 Gate 缺失时 PR 不可合并；
- [ ] CI 变更受 CODEOWNERS 保护；
- [ ] `@dramaclaw/maintainers` 已验证可见且拥有 write 权限；
- [ ] CODEOWNERS 已通过独立 bootstrap PR 合并，后续测试 PR 已验证 base
      branch 规则生效；
- [ ] `.github/CODEOWNERS` 保护自身和全部 Gate 脚本；
- [ ] secrets 检查拒绝 property、index 和 bare-object 三种 context 引用；
- [ ] ruleset 不配置持久 bypass；
- [ ] break-glass 按双人确认、事件记录和 30 分钟恢复策略演练；
- [ ] DCO checkout 使用固定 SHA Action 和 `fetch-depth: 0`；
- [ ] `pr-gate.yml` 及其调用链中的 Linux jobs 使用 `ubuntu-24.04`；
- [ ] `pr-gate.yml` 及其调用链中的所有外部 Actions（含 `actions/*`）全部
      固定 40 位 SHA；
- [ ] uv 在 `pyproject.toml` 与 `setup-uv` 中固定为同一精确版本；
- [ ] 所有 checkout steps 使用封闭输入并禁用 credential persistence；
- [ ] Phase 1 原样保留的旧 CI、release、sync workflows 不被上述两项静态
      验收误判；
- [ ] 迁移前后 GitHub 配置已导出、版本化并通过 API 验证；
- [ ] 发布、部署 workflow 未被授予给 PR gate；
- [ ] 本地开发命令与 CI 使用同一版本和同一规则；
- [ ] Phase 5 成功指标达到目标值。

## 12. 向其他仓库复用的边界

### 复用

- `pr-gate` 顶层编排；
- 每仓固定且全局唯一的 required check 名，例如 `dramaclaw-pr-gate`；
- `if: always()`、needs 结果和条件 job `verified=true` 三重校验；
- 条件 job 显式 no-op 和执行路径 assertion；
- 未证明路径检测可靠前，关键 build/test job 无条件运行；
- `pull_request` + `push main`；
- concurrency 与 timeout；
- 最小权限；
- CODEOWNERS；
- ruleset 只要求仓库唯一 Gate，并指定 expected source；同 App workflow
  唯一性另行校验；
- gitleaks 和版本化 dependency review 许可证政策的公共实现。

### 不直接复用

- `ce-import-lint`
- `ee-terms`
- `banned-words`
- `check_ce_port_closure.py`
- DCO 是否 required
- DramaClaw 的 Python 依赖和测试命令

其他仓库的内部 job 建议：

| 仓库 | 必须 job |
| --- | --- |
| SuperTale | EE backend/test、CE compatibility、secret、dependency、gate |
| supertale-admin-fe | npm build、可选 worker build、secret、dependency、gate | <!-- banned-word-allow -->
| claymore-llm-gateway | Go build/vet/test、frontend、secret、dependency、gate |

## 13. 已关闭决策与责任

以下架构决策已经关闭。实施者不得在实施 PR 中自行改选其他方案；如需变更，
必须回到本方案评审并形成新版本。

| 决策项 | 最终结论 | 执行责任 | 独立复核 |
| --- | --- | --- | --- |
| Required check | 仓库唯一 `dramaclaw-pr-gate` | CI 实施人 | `@dramaclaw/maintainers` |
| Expected source | GitHub Actions；只限定 App，迁移时 API 验证 App ID | `@lywaterman` | CI 实施人之外的 maintainer |
| 条件 job | dependency-review、pr-policy 使用 assertion + `verified=true` | CI 实施人 | `@dramaclaw/maintainers` |
| Frontend | 第一版所有 PR 与 main push 都完整运行，不做路径优化 | CI 实施人 | Phase 1 测试 PR |
| 分支保护 | 从 legacy protection 迁移到 repository ruleset | `@lywaterman` | `@dramaclaw/maintainers` |
| Approval | 1 个 CODEOWNER approval，dismiss stale | `@lywaterman` | 测试 PR 验证 |
| CODEOWNERS team | 固定 `@dramaclaw/maintainers` | `@lywaterman` 创建/确认 | API + 测试 PR |
| Dependency Graph | 必须启用；不可用即 fail closed | 仓库管理员 | dependency 测试 PR |
| 许可证政策 | 封闭三字段 schema、现有 11 项 deny list、固定 Action 与唯一 config-file 输入 | CI 实施人 | 许可证绕过负向测试 |
| 漏洞检查 | 本期不加入许可证 Gate | CI 实施人 | 方案复核人 |
| gitleaks | v8.30.1 Linux x64 二进制 + 固定 SHA256；先校验后解压；全历史扫描 | CI 实施人 | 安全复核人 |
| docs-only PR | 第一版仍全量运行 backend 与 frontend | CI 实施人 | Phase 1 数据复核 |
| Persistent bypass | 空；管理员规则同样生效 | `@lywaterman` | API 配置复核 |
| Break-glass | 双组织 owner、事件记录、30 分钟内恢复 | 当值组织 owner | 另一位组织 owner |
| Runner | 仅 Gate 及调用链固定 `ubuntu-24.04` | CI 实施人 | scoped 静态复核 |
| Action pin | 仅 Gate 及调用链的外部 Actions 要求完整 SHA；旧 workflow 本期原样保留 | CI 实施人 | scoped 静态复核 |
| Gate 唯一性 | YAML 语义解析所有 workflow，运行时再查 Check Runs API | CI 实施人 | Phase 2 测试 |
| Reusable workflow | 本期不抽组织级 reusable workflow | CI 实施人 | 方案复核人 |
| Merge queue | 本期不开启；未来先补 `merge_group` | 仓库管理员 | merge-group 测试 |
| 推广到其他仓库 | DramaClaw 稳定观察 1–2 周并达成指标后开始 | CI 负责人 | 各仓维护者 |

唯一尚需核验的是外部事实，而非架构选择：

- `@dramaclaw/maintainers` 当前是否已经存在；
- 该 team 是否可见、成员数是否不少于 2、是否拥有 write 权限；
- `@lywaterman` 是否具备完成组织 team 和 ruleset 配置的管理员权限。

这些事实由 `@lywaterman` 在 Phase 0 用已认证 API 核验；不满足时创建 team
或由组织 owner 执行配置。核验失败会阻止实施，但不会让实施者重新选择
CODEOWNERS team 名或放宽保护。

## 14. 评审结论与实施入口

本修订稿接受“单一稳定聚合 Gate + 双轨迁移”的架构。v0.2 已完成条件路径
断言、唯一 Gate 名、DCO full-history checkout、CODEOWNERS 自保护和关键决策
关闭；v0.3 进一步关闭本轮五项 findings：

1. dependency review 迁移到受保护配置，完整保留现有 11 项许可证拒绝政策，
   并固定在仍支持该政策的 action `v5.0.0` commit；
2. 第一版取消尚未证明可靠的 `changes`，所有 PR 都执行 frontend；
3. 将 expected source 的能力边界修正为“限定 GitHub App”，不再声称能区分
   同一 App 下的不同 workflows；
4. runner 固定和 Action SHA pin 收窄到 `pr-gate.yml` 及其调用链，旧 CI、
   release 和 sync workflows 在 Phase 1 原样保留；
5. Gate 唯一性改由 YAML 语义解析器证明，并保留 Check Runs API 运行时验收。

v0.4 关闭最后两项小范围 Request changes：

1. dependency review 配置采用封闭三字段 schema，workflow checker 同时固定
   Action、`config-file` 和唯一 `with` 输入，并加入 `warn-only` 与许可证
   豁免字段的负向测试；
2. gitleaks 固定为 `v8.30.1` Linux x64 二进制及官方 SHA256，明确先校验后
   解压、保持全历史扫描，不使用 `gitleaks-action`。

进入实施计划阶段的前提：

- 团队批准本修订稿；
- Phase 0 外部事实核验全部通过；
- 实施人和独立复核人写入迁移操作单；
- 当前 GitHub 配置已经导出并版本化。

在此前提满足后，本方案可以进入 Phase 1；不得跳过双轨运行、失败演练或
双重 required 过渡阶段。

## 15. 参考依据

- [GitHub Docs：配置 Dependency Review Action](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-dependency-review-action)
- [dependency-review-action v5.0.0：配置项、warn-only 与许可证豁免](https://github.com/actions/dependency-review-action/tree/v5.0.0#configuration)
- [dependency-review-action v5.0.0 release](https://github.com/actions/dependency-review-action/releases/tag/v5.0.0)
- [gitleaks v8.30.1 release 与 checksums 资产](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)
- [GitHub Docs：Ruleset 可用规则与 expected source](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub Docs：Required status checks 不区分 workflow、matrix 或 event](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules)
- [GitHub Docs：skipped workflow/check 与 required status check](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
- [GitHub Docs：CODEOWNERS 必须位于 PR base branch](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- [GitHub Docs：Actions contexts 的 property 与 index 语法](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)
- [setup-uv：未指定版本时默认解析 required-version 或 latest](https://github.com/astral-sh/setup-uv)
- [uv：required-version 配置](https://docs.astral.sh/uv/reference/settings/#required-version)

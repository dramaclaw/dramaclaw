# 贡献指南

感谢你考虑为 DramaClaw 贡献。无论是修 bug、补文档还是加功能，都欢迎。

## 开始之前

- 请先读 [行为准则](CODE_OF_CONDUCT.md)。
- 关于许可：本项目采用 [Elastic License 2.0](LICENSE)（source available）。**提交贡献前，请花一分钟读 [LICENSE](LICENSE) 与下方的[贡献者协议](#贡献者协议)。**
- 安全问题请勿走公开 issue，见 [SECURITY.md](SECURITY.md)。

## 报告 Bug / 提功能建议

- **Bug**：开一个 [Bug 报告](https://github.com/dramaclaw/dramaclaw/issues/new?template=bug_report.yml)，附复现步骤、运行环境、相关日志。
- **功能建议**：开一个 [功能建议](https://github.com/dramaclaw/dramaclaw/issues/new?template=feature_request.yml)，说清场景与动机。
- 不确定从哪入手？看带 [`good first issue`](https://github.com/dramaclaw/dramaclaw/labels/good%20first%20issue) 标签的 issue。

## 提交 PR

### 本地开发

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw
uv sync
cp .env.example .env      # 按文档配置模型网关
uv run novelvideo api --port 8780
```

### 流程

1. Fork 仓库，从 `main` 切一个主题分支；
2. 改动 + 自测（`uv run pytest`）；
3. 提交信息清晰（建议 [Conventional Commits](https://www.conventionalcommits.org/)），并对**每个 commit** 用 `git commit -s` 附上 DCO 签署（见 [开发者原产证书](#开发者原产证书dco)）；
4. 开 PR，关联对应 issue，简述改动与验证方式。

## 贡献者协议

向本项目提交贡献，即表示你同意：

a. 维护方可按需调整本项目所采用的许可证（更严格或更宽松）；
b. 你贡献的代码可用于商业用途，包括但不限于 DramaClaw 的云 / 托管业务运营。

> 这一条让 DramaClaw 能在 source-available 许可下，把社区贡献也用于官方托管/商业版本——这是「同一套代码、社区与商业不分叉」得以成立的前提。提交贡献即视为接受，无需另外签署。

## 开发者原产证书（DCO）

本项目要求所有贡献通过 DCO（Developer Certificate of Origin 1.1，全文见 [`DCO`](./DCO)）签署 —— **每个 commit 都必须带 `Signed-off-by` 行**，以此声明你有权按本项目许可提交该贡献。

最简单的方式是提交时加 `-s`，git 会用你的 `user.name` / `user.email` 自动补上签署行：

```bash
git commit -s -m "fix: ……"
# 自动生成：Signed-off-by: Your Name <you@example.com>
```

尚未发布的 commit 可用 `git rebase --signoff <base>` 补签。已发布的共享历史使用普通后继提交补签，保留原 SHA：

```text
chore: certify historical contributions under DCO 1.1

I certify my right to submit the changes in the listed commits
under the Developer Certificate of Origin 1.1.

DCO-Remediation: <完整的40位历史commit SHA>
Signed-off-by: Your Name <you@example.com>
```

每个被补签的 commit 单独列一行 `DCO-Remediation`，且必须是补签提交的祖先。补签提交必须带有与其作者姓名和邮箱一致的 `Signed-off-by` trailer。补签者以自己的身份声明有权提交这些贡献，不代替原作者签名。该记录只覆盖列明的 SHA，其他未签署提交仍会失败。

CI（`.github/workflows/dco.yml` 调 `scripts/check_dco.py`）会校验 PR 内每个普通 commit 的原始签署或上述补签记录。补签记录格式错误、身份不一致或引用非祖先提交都会标红。

## 获取帮助

[Discussions](https://github.com/dramaclaw/dramaclaw/discussions) ｜ [Issues](https://github.com/dramaclaw/dramaclaw/issues)

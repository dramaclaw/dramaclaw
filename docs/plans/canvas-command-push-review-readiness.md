# 画布命令推送：审查准备记录

记录时间：2026-10-30 09:10–09:17 UTC。

## 分支及审查范围

CE：`feat/canvas-command-push`，目标 `staging`，基线 `30c7afae`。
重新 fetch 后，CE staging 基线未变化。本次 14 个提交已完成范围密钥扫描。

EE：新增干净审查分支 `feat/canvas-command-push-release`，目标 `main`，
基线 `0e70661df`。仅包含本次三个提交，未携带旧工作区中的迁移、开发诊断等其它历史：

| 新审查提交 | 原本地运维提交 | 内容 |
| --- | --- | --- |
| `c5ad71016` | `0f049e3bf` | OpenResty SSE 项目归属路由及真实代理验收 |
| `c60becce9` | `8328bffed` | 每周固定 main 候选准备及证据模板 |
| `1d86f4e9d` | `a7b304b66` | 保持原定兼容清理条件 |

干净 EE 分支的 5 项代理契约、5 项周候选测试、改动文件 Ruff 和 diff 检查通过。
之前 `feat/canvas-command-push-ops` 保留作实施历史参考，后续以干净审查分支提交。

## 发布访问复核

- 本地 Kubernetes 仍只有 Docker Desktop / OrbStack，没有 3060 context；SSH 配置无 3060 主机。
- GitHub 身份对 CE 与 EE 源码仓库有推送权限，但 GitOps 仓库仍返回 404。
- 新发现可用 Grafana 连接；实时 Prometheus 及 Loki 查询显示它覆盖 ACK，
  没有 3060/staging namespace 或对应 ArgoCD 应用数据；过去 24 小时也未查到 3060 pod 数据。
  该结果表示当前数据源无可用的 3060 证据，不推断 3060 服务是否正常，也不替代 3060 验收。
- 未发布后端/前端、未更新 BOM、未删除兼容路径。实施清单仍为 83/92，剩余 9 项待实际执行。

## 提交前检查

Gitleaks 8.30.1 扫描本次 CE 全部 14 个提交通过。两处 generic-api-key 匹配经检查为
固定 `legacy` consumer 标签和由变量拼接的 websocket consumer 标识，不含凭据；
`.gitleaksignore` 只记录对应的精确历史提交、文件、行指纹，没有扩大规则豁免。

与 CI 相同的 HEAD 可达完整历史扫描未完成：本地为部分克隆，缺少历史 blob；
断网只读扫描到 90 个提交后无法补取对象。该次不记为全历史通过，仍需完整 checkout 的 CI 验证。

DCO 检查发现本次历史提交均缺 `Signed-off-by`。
`CONTRIBUTING.md` 第 36–56 行同时规定“提交贡献即视为接受”许可调整、商业使用条款，
且每个提交必须签署 DCO。已阅读条款与 DCO，已向用户请求明确确认后再补签、推送和提交草稿 PR。
本轮尚未进行这些外部写操作。

两份具体 PR 描述已准备，覆盖问题、结果、验证、部署顺序及未完成的实机条件。

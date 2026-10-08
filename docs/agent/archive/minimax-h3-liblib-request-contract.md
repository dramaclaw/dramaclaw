# LibLib MiniMax H3 真实请求 / 返回合同取证

**状态**：已归档
**最后更新**：2026-09-24
**基线**：`b4ace7e9`；`main` 相对 `zhonggwv/main` ahead 10 / behind 0；目标文档无既有 diff，工作区仅有三类受保护未跟踪资料
**认领者**：`codex/minimax-h3-request-contract-20260924`
**相关文档**：`docs/guides/minimax-h3-liblib-request-contract.md`
**相关分支 / PR**：`main`

## 目标

把 LibLib 画布中 MiniMax H3 全能参考的真实创建请求、异步返回、Mixed 编号、媒体元数据、
成功/失败与积分结果沉淀成可审计的脱敏合同，供青蛙画布实现和排错复用；记录已足够证明的行为与
尚未证明的限制，避免重复发起付费生成。

## 非目标

- 不提交 Cookie、签名媒体 URL、设备令牌、项目/节点/任务标识或其他账户信息。
- 不在本线修改前后端业务代码，也不改变现有 H3 模式、参数或上传实现。
- 不为猜测限制继续批量试错；只有现有证据无法回答实现所需问题时才考虑单次补测。

## 现状与证据

- 2026-09-24 已在用户指定 LibLib 画布取得四组真实 H3 请求与异步结果：一组基线成功、
  一组含视频的成功样本，以及两组 `INVALID_PARAMS` 且未扣积分的多素材样本。
- 已确认文本和图片都可显示序号 1，因为文本单独进入 `textList`，图片/视频/音频才共同进入
  `mixedList` 并使用 `{{Mixed N}}`；媒体同时按类型重复进入 `*ListV2`。
- 已确认成功的含视频样本把视频写入 `videoListV2`，含宽、高、时长，并在 `mixedList` 的全局槽位
  出现；音频同理写入 `audioListV2` 与 `mixedList`。
- 两组失败样本均使用了重复媒体 URL，且素材组合更大；现有证据不能把失败唯一归因于重复 URL、
  数量上限或组合限制，必须如实标记未决。
- `git diff --` 对目标新文件与 STATE 无既有改动；本线只新增独立 guide/ledger/claim，远端无同名实现。

## 写入边界

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md` | 共享 | 登记本线生命周期；仅追加/移除本行 |
| `docs/agent/tasks/minimax-h3-liblib-request-contract.md` | 独占 | 方案、证据来源、验证与交接 |
| `docs/agent/archive/minimax-h3-liblib-request-contract.md` | 独占 | 完成后归档台账 |
| `docs/agent/claims/minimax-h3-liblib-request-contract.toml` | 独占 | 机器可读写入范围 |
| `docs/guides/minimax-h3-liblib-request-contract.md` | 独占 | 脱敏请求/返回合同与实现结论 |

## 协调与冲突

- **相关工作线**：`minimax-h3-liblib-parity`、`minimax-h3-reference-order`；两者提供已验收实现，
  本线只读对照，不修改其代码或归档台账。
- **本地已有改动**：目标路径无既有 diff；`.playwright-cli/`、`_to_delete/`、`曹操.md` 不归本线且不触碰。
- **远端重复实现**：当前远端无同名证据文档；不需要移植或覆盖。
- **共享文件顺序**：STATE 仅由本线追加当前行，完成归档时移除；不改其他工作线内容。

## 实施方案

1. 把四组真实样本整理为脱敏请求结构与结果矩阵——完成条件：字段、顺序、状态、扣费均可核对，敏感值全部省略或替换。
2. 写明独立编号、`mixedList` 与类型数组的职责——完成条件：前后端实现者可据此构造无歧义请求。
3. 对照现有青蛙画布实现，区分必须保持、网关差异与后续候选增强——完成条件：不把 LibLib 私有字段误抄到本地工作台。
4. 运行 guard、diff、密钥扫描并归档——完成条件：文档可提交且无凭据泄露。

## 风险与回退

- **风险**：签名 URL、设备令牌或任务标识误入公开仓库；文档只保留字段名、类型、尺寸、时长与脱敏占位符，并运行 gitleaks。
- **风险**：把失败样本推断成供应商硬限制；结论严格分为“已观察事实”和“待验证假设”。
- **回退**：删除本线新增 guide/ledger/claim 并撤销 STATE 的单行登记，不触碰业务代码或其他工作线。

## 验收标准

- [x] `python3 scripts/agent_guard.py check` → 台账、claim 与状态一致。
- [x] `git diff --check` → 文档无空白错误。
- [x] `pre-commit run gitleaks --files ...` → 脱敏文档无凭据命中。
- [x] guide 覆盖请求字段、返回状态、积分、Mixed/文本独立编号、视频/音频 V2 元数据和未决限制。
- [x] 本轮改动全部在写入边界内，无业务代码或敏感资料 diff。

## 进展记录

### 2026-09-24 · 请求、返回与积分证据已脱敏固化

做了什么：新增 `docs/guides/minimax-h3-liblib-request-contract.md`，记录四组真实 H3 样本的请求字段、
Mixed/类型数组顺序、视频与音频元数据、创建/异步终态、报价与最终 power；补充与青蛙画布当前实现的
逐层映射，并把失败原因和下一次补测条件明确标成未决边界。

为什么这么做：已有两次成功和两次零扣费失败足以证明序列化合同，继续重复生成只会消耗积分；
脱敏字段级证据既能支持实现和排错，也不会把账户凭据、签名 URL 或私有标识写进公开仓库。

怎么验证的：`python3 scripts/agent_guard.py check` 返回 `OK: 17 workstreams, 347 claims`；
`git diff --check` 通过；`pre-commit run gitleaks --files` 对 STATE、ledger、claim、guide 返回 Passed；
目标 diff 仅包含本线文档，无业务代码改动，敏感值定向扫描无命中。

### 2026-09-24 · 方案门完成

做了什么：恢复 STATE/Git/guard 现场，核对既有 H3 实现与归档台账，建立仅包含脱敏证据文档的窄范围工作线。

为什么这么做：用户要求先沉淀真实请求和返回、避免浪费积分；已有四组样本足以先固定字段和已知边界。

怎么验证的：`git status --short --branch` 仅显示三类受保护未跟踪资料；`agent_guard check` 返回 OK，
`agent_guard status` 返回无活动锁；目标文档为新文件，STATE 无既有 diff。

## 已定下来的决策

- **先写证据，后决定是否补测。**——现有两次成功与两次零扣费失败已覆盖主要序列化合同。
- **只保存脱敏结构，不保存原始抓包。**——原始请求包含签名媒体 URL、设备标识和项目元数据，不适合公开仓库。
- **失败原因保持未决。**——重复 URL、组合数量与供应商上限目前相关但未被单变量实验区分。

## 待办

- [x] 写入脱敏请求/响应 guide 与结果矩阵。
- [x] 对照现有系统列出实现映射与不应照搬的 LibLib 私有字段。
- [x] 完成静态检查、密钥扫描、handoff、提交与归档。

## 阻塞

无；本轮文档沉淀不需要继续消耗积分。

## 交接摘要

- **最后完成到**：四组真实样本已脱敏固化并完成 guard、空白和密钥检查；没有新增付费任务。
- **下一步唯一动作**：无；若将来要验证 2 视频 + 2 音频，只按 guide 的单变量条件另开工作线。
- **先读这些文件**：本台账、`docs/agent/archive/minimax-h3-reference-order.md`、H3 适配器与测试。
- **不要动这些文件 / 决策**：不改业务代码；不记录任何真实 Cookie、URL、令牌或标识符；不把失败假设写成硬限制。

# 发版指南 / Releasing

面向维护者的发版 runbook。发布内容会被 Release Feed（`GET /api/v1/release-notifications`）解析并展示给自部署用户，**格式写歪不会报错，只会静默不显示**，因此请严格按本文模板撰写。

## 发版 checklist

按顺序执行：

1. **Bump 版本**：改 `pyproject.toml` 的 `version = "X.Y.Z"`（版本唯一真源，SSOT），并同步 `tests/test_release_feed.py::test_project_version_is_single_source_of_truth` 中钉死的版本字面量；第 3 步重装后 `uv.lock` 会随之更新，记得一并提交。
2. **重写包内 release notes**：整体替换 `src/novelvideo/release-notes.md` 为新版本内容（用下方模板）。front-matter 的 `version:` 必须与 `pyproject.toml` 一致，否则解析门断言失败（F8）。
3. **本地验证**：
   ```bash
   uv pip install -e .            # 重装使新版本号生效
   uv run pytest tests/test_release_feed.py
   # 或起后端后：curl 'http://localhost:8780/api/v1/release-notifications?locale=zh'
   # 确认 current_version == 新版本、current_items 非空
   ```
4. **合入 main**，打 tag `vX.Y.Z`（tag 前缀固定小写 `v`）：
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   ⚠️ **只打 tag 不产生任何效果**：没有 release 页、应用内不提示升级（(B) 拉的是 `releases/latest` API）、Docker 镜像也不构建（workflow 触发条件是 `release: published`）。必须走第 5 步。
5. **发 GitHub Release**：先按下方「GitHub Release 页面结构」写好人工部分（zh/en Highlights + New Features / Bug Fixes 等分类节）存为 `body.md`，然后一条命令发布：
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file body.md --generate-notes
   ```
   `--generate-notes` 会把自动生成的 What's Changed / New Contributors / Full Changelog **追加在 body.md 内容之后**，正好构成完整标准结构（网页操作等价：贴入人工部分后点 "Generate release notes" 按钮）。front-matter 中 `version:` 可省；想让已部署旧版用户的铃铛红点亮起，需写 `attention: medium` 或 `high`，见下。
6. 发布后 `.github/workflows/release-images.yml` 会在 `release: published` 时自动构建并推送 Docker 镜像，无需手动操作。

## Release body / 包内 notes 共用模板

包内 `src/novelvideo/release-notes.md` 与 GitHub Release body 用**同一解析器**，核心部分（front-matter + Highlights 两节）直接复制以下模板；GitHub Release body 在此基础上还需追加 issue/bugfix 等章节，见下节「GitHub Release 页面结构（标准）」：

```markdown
---
version: X.Y.Z
attention: low
---
# vX.Y.Z

## User-facing Highlights (zh)

- **功能标题**: 面向用户的一句话描述。
- **另一个功能**: 描述。

## User-facing Highlights (en)

- **Feature title**: One-line user-facing description.
- **Another feature**: Description.

## Fixes

- 包内 notes 里内部修复、重构等写在这里，不会被解析进用户通知（解析器只读 Highlights 章节）。
```

## GitHub Release 页面结构（标准）

每个 release 的发布页**必须**按以下结构撰写。parser 只读 Highlights 两节，Highlights 之后的章节不影响应用内通知：

```markdown
---
attention: low        # 仅需 medium/high 提醒时才写这段 front-matter；low 直接整段省略，页面更干净
---
# vX.Y.Z

## User-facing Highlights (zh)

- **功能标题**: 面向用户的一句话描述。（应用内通知的数据源，两节必须放最前，写法同上方模板）

## User-facing Highlights (en)

- **Feature title**: One-line user-facing description.

## New Features
- 本次新增功能，逐条带 PR/issue 号，如 `- 新增 XXX (#40)`

## Bug Fixes
- 本次修复，逐条带 issue 号，如 `- 修复画布 21:9 误吸附 (#52)`；有对应 issue 的写 `Fixes #NN`

## Improvements
- 体验/性能改进（无则省略本节）

## What's Changed
（发布时点 GitHub 的 "Generate release notes" 按钮自动生成：PR 列表 + New Contributors + Full Changelog 链接，不要手写）
```

要求：

- **New Features / Bug Fixes / Improvements 是人工撰写的精选**，面向用户口吻、每条带相关 issue/PR 编号；不是把 commit log 原样抄上来。无内容的节省略。
- **What's Changed 一律用 GitHub 自动生成**（Generate release notes 按钮），保证 PR 列表、新贡献者、Full Changelog 对比链接完整且不遗漏。
- `attention: low` 是默认值，日常发版**省略整段 front-matter**（GitHub 会把它按原样渲染出来，略难看）；只在需要点亮旧版用户红点（`medium`/`high`）时才加。

front-matter 字段：

| 字段 | 包内 notes | GitHub body | 说明 |
|---|---|---|---|
| `version` | **必填**，须 == `pyproject.version` | 可省（版本取自 release tag） | 防「bump 版本忘改 notes」（CI 门 F8） |
| `attention` | 可省，默认 `low` | 建议按需写 | `low`/`medium`/`high`；**仅 `medium`/`high` 会点亮旧版用户的铃铛红点**（主动提醒升级），`low` 只静躺通知中心列表。日常发版用 `low`，重要更新/安全修复用 `medium`/`high` |

## 格式硬规则（解析器行为，来自 `src/novelvideo/release_notes.py`）

- `## User-facing Highlights (zh)` 与 `(en)` **两节都必须存在且各 ≥1 条**——CI 对包内 notes 严格断言（F1），缺任一节即红。标题大小写不敏感、heading 级别不限，但 locale 后缀必须是 `(zh)`/`(en)`。
- 条目用一级 bullet `- **标题**: 描述`（`*` 也可）；无粗体标题时整行作标题。标题为空的行会被丢弃。
- 章节扫到下一个同级或更高级标题即截止（如 `## Fixes`）；代码围栏内的 `#`/`-` 不会被误认。
- `attention` **只认 front-matter**，写在正文里无效。
- 前端不解析 Markdown，条目内不要依赖行内格式（链接、加粗描述等会按纯文本显示）。

## 用户会看到什么（两个承载面）

- **(B) 升级前**（旧版运行中，上游出了新版）：通知中心（header 铃铛抽屉）出现一条「有新版本 vX.Y.Z 可用」，含「去更新」（跳转 release 页）与「跳过此版本」。铃铛红点仅当该 release 的 `attention ∈ {medium, high}` 才点亮；打开抽屉即记已读、红点熄灭。离线/限流时此提示静默消失，不影响 (A)。
- **(A) 升级后**（拉取新版并重启）：自动弹「新功能已上线」What's New 弹窗，内容来自新包内 `release-notes.md` 的 Highlights（按界面语言选 zh/en 节），每个版本只自动弹一次；点搭子可随时手动重看。notes 缺失或为空时显示「当前版本暂无更新说明」，不报错。

## 相关配置

| env | 默认 | 作用 |
|---|---|---|
| `RELEASE_NOTIFICATIONS_ENABLED` | `true` | Release Feed 总开关（关=零外呼、零解析） |
| `RELEASE_NOTIFICATIONS_GITHUB_TOKEN` | 空 | 提升 GitHub API 限流额度（匿名 60 次/时；有 6h 缓存，通常无需配置） |

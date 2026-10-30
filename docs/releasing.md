# 发版指南 / Releasing

面向维护者的发版 runbook。发布内容会被 Release Feed（`GET /api/v1/release-notifications`）解析并展示给自部署用户，**格式写歪不会报错，只会静默不显示**，因此请严格按本文模板撰写。

## 发版 checklist

按顺序执行：

1. **Bump 版本**：改 `pyproject.toml` 的 `version = "X.Y.Z"`（版本唯一真源，SSOT），并同步 `tests/test_release_feed.py::test_project_version_is_single_source_of_truth` 中钉死的版本字面量；更新锁文件并一并提交。同时执行 `python3 scripts/bump_compose_default.py docker-compose.release.yml DRAMACLAW_VERSION X.Y.Z`，更新 `.env.example`、README 和中英文部署指南中的版本示例。网关使用独立版本，不随 CE 版本盲目递增。Compose 默认值必须在打 tag **之前**与应用版本一致，不依赖发布后的打包 PR 补改。
2. **重写包内 release notes**：整体替换 `src/novelvideo/release-notes.md` 为新版本内容（用下方模板）。front-matter 的 `version:` 必须与 `pyproject.toml` 一致，否则解析门断言失败（F8）。
3. **本地验证**：
   ```bash
   uv pip install -e .            # 重装使新版本号生效
   uv run pytest tests/test_release_feed.py tests/test_docker_persistence_config.py
   # 或起后端后：curl 'http://localhost:8780/api/v1/release-notifications?locale=zh'
   # 确认 current_version == 新版本、current_items 非空
   ```
4. **合入 main**，打 tag `vX.Y.Z`（tag 前缀固定小写 `v`）：
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   tag 只固定源码。镜像需要在发布前构建和验收；发布事件只晋升通过验收的镜像，不会补做构建。
5. **建立草稿 Release**：按下方标准准备 `body.md`，先保留为草稿，供打包流程上传制品及验收回执：
   ```bash
   tag=vX.Y.Z
   gh release create "$tag" --repo dramaclaw/dramaclaw --verify-tag --draft \
     --title "$tag" --notes-file body.md --generate-notes
   ```
   `--generate-notes` 将 What's Changed / New Contributors / Full Changelog 追加在人工内容之后。日常发版省略 `attention: low`；需要提醒旧版用户时填写 `medium` 或 `high`。
6. **构建两个架构的镜像**：在已合入 main 的工作流上手动构建正式 tag，保持 `push_latest=false`，此时不更新 `latest`：
   ```bash
   gh workflow run release-images.yml --repo dramaclaw/dramaclaw --ref main \
     -f tag="$tag" -f push_latest=false -f candidate_only=false
   gh run watch BUILD_RUN_ID --repo dramaclaw/dramaclaw --exit-status
   ```
   记录这次 dispatch 返回的运行链接/ID，确认 backend 和 frontend 都成功，并且均包含 `linux/amd64`、`linux/arm64`。不要用其他并发运行的成功状态代替本次结果。
7. **完成所有制品和实际验收**：选择已经发布且通过校验的 DramaClaw Gateway tag；在 EE 仓库运行完整正式打包：
   ```bash
   gateway_tag="填写已验证的网关 Release tag"
   gh workflow run dramaclaw-release-packages.yml --repo claymorelab/SuperTale --ref main \
     -f ce_tag="$tag" -f gateway_tag="$gateway_tag" \
     -f target=all -f dry_run=false
   gh run watch PACKAGE_RUN_ID --repo claymorelab/SuperTale --exit-status
   ```
   正式运行不传 `ce_ref` 或 `candidate_image_tag`。必须等待三种桌面目标、Compose、回执上传和完整发行审计全部成功。签名、公证、安装后的真实聊天、新安装/保留数据升级、凭据轮换及 CDN 检查均不能省略。

   Compose 验收使用本轮已验证的不可变 digest，并在测试前后检查后端、前端和网关容器身份。完整 Compose job 成功后，发布器才将 `release-image-acceptance.json` 上传到草稿 Release。回执 v2 包含实际运行的平台 manifest、镜像配置 ID 和容器 ID；缺少这类身份的旧回执不能用于晋升。
8. **核对草稿后再正式发布**：确认 tag 指向最终源码，安装包版本、更新清单及校验值一致，且草稿包含本轮回执：
   ```bash
   gh release view "$tag" --repo dramaclaw/dramaclaw --json isDraft,assets
   gh release edit "$tag" --repo dramaclaw/dramaclaw --draft=false
   ```
   只有前一步完整打包/验收成功后才执行发布。仅有镜像构建成功或一份手工补写的回执不能代替验收。
9. **确认镜像晋升成功**：发布触发 `release-images` 的 promote 路径，检查回执上传者及文件哈希、源码和版本、两种架构，以及实际测试过的镜像身份，再将同一 index digest 标成 `latest`。不会重新构建镜像。
   ```bash
   gh run list --repo dramaclaw/dramaclaw --workflow release-images.yml --event release --limit 5
   gh run watch PROMOTION_RUN_ID --repo dramaclaw/dramaclaw --exit-status
   ```
   缺少回执或身份不匹配时晋升失败；先修复并重新完成相应验收。已发布版本需要修复时发新版本，不覆盖同名安装包或更新清单。重建未发布版本导致 digest 变化后，也必须重新验收、生成回执，不能复用旧回执。

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

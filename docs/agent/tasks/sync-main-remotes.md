# 同步 origin/main 与 zhonggwv/main

**状态**：待验收
**最后更新**：2026-09-29
**基线**：`bc051ed3`；两条私有分支已同SHA，本轮隔离公开PR集成从此提交开始。
**认领者**：`codex/public-origin-sync-20260929`
**相关文档**：`docs/agent/README.md`
**相关分支 / PR**：`codex/sync-main-remotes`；[upstream PR #717](https://github.com/dramaclaw/dramaclaw/pull/717)

## 目标

### 2026-09-29 · 保留原素材更新公开origin的现有PR

用户明确要求把私有最新代码也提交到公开`origin`，并在被告知素材许可未知后明确选择“用一样的素材提交，不用替换”。本轮保留35张`frontend/public/director-reference/`图片、`libtv-icons.json`与既有`reference-assets.json`原样，不更改其来源或将未知再分发许可标注成已授权。公开上传存在第三方素材权利风险；本轮按用户选项保留可追溯的清单说明，不作许可保证。

只读取证：`origin/main=30ab52c7`、私有`main=bc051ed3`，共同祖先`f51c2e44`，双方独有3/105提交；公开PR #717从`ZhongGWV/dramaclaw-upstream:codex/sync-main-remotes`指向上游main，head`17436a2e`是私有main祖先，当前`CONFLICTING/REVIEW_REQUIRED`。当前账号对`dramaclaw/dramaclaw`只有pull权限，对该fork有push权限。直接推`origin/main`既无权限又非快进；仅通过更新现有公开PR分支交付，最终合并需上游维护者审核。隔离`codex/public-origin-sync`从私有main建立、工作树干净；主目录两份受保护未跟踪资料不在本检出。

精确写入边界为本台账、STATE、同名claim，以及`git merge-tree`预演的六个内容冲突：`frontend/src/api/ops.ts`、`frontend/src/features/canvas/domain/canvasNodes.ts`、`src/novelvideo/api/schemas.py`、`src/novelvideo/task_backend/runners/freezone.py`、`tests/test_freezone_canvas_route_home_node_guard.py`、`tests/test_p0g4i_freezone_leaf_classification.py`。自动合并的三语、工具条、许可证清单、Freezone路由/任务和视频生成器只读取证；若测试暴露语义缺口，先在台账加窄scope并重新preflight。共享文件由本隔离会话在既有工作线提交之后串行集成，不覆盖未归属脏文件，也不重写Director或H3业务。

合并实际产生另外12个上游独有或自动合并路径，已逐项登记为只读导入：`frontend/src/__tests__/api/freezone-video-upscale-probe.test.ts`、`frontend/src/__tests__/features/canvas/generation-resume-race.test.ts`、`frontend/src/__tests__/features/canvas/video-upscale-resolutions.test.ts`、`frontend/src/features/canvas/application/resumeGeneration.ts`、`frontend/src/features/canvas/domain/videoUpscaleResolutions.ts`、`frontend/src/features/canvas/ui/VideoUpscaleEditorOverlay.tsx`、`src/novelvideo/freezone/video_slowdown.py`、`tests/contract/test_m06_route_contracts.py`、`tests/test_freezone_video_upscale_backend.py`、`tests/test_p0_gray_shared_egress_seam.py`、`tests/test_p0g4c_video_egress.py`、`tests/test_video_processing_request.py`。这些文件仅接受Git三方结果，本轮不手改；此次补认领是响应guard对暂存合并路径的精确归属要求，不扩大产品实现范围。

互认门禁补充：上述共享路径在旧任务仍有精确claim，需仅协调更新`docs/agent/claims/`与`docs/agent/tasks/`下`canvas-audio-actions`、`canvas-audio-split`、`depth-motion-da3`、`h3-prompt-optimizer`、`project-chinese-names`、`shot-breakdown`、`text-node-liblib-visual-parity`及`liblib-canvas-parity`八线的对应文件，逐路径加本线为后序集成者并在台账记先后；`multi-provider-models`已有通配互认，`legacy-unassigned-diff`的测试路径已明确互认，不改其文件。这些协调写入不改变旧业务所有权、旧验收结论或`legacy-unassigned-diff`冻结的未归属脏文件。

步骤：先登记方案与claim、guard/acquire/preflight，再以私有main为第一父正常merge最新`origin/main`；逐冲突保留双方合同，并对自动合并的同名功能做差异审查。验证相关后端/前端回归、生产build、Ruff/i18n/CE/许可证/密钥扫描、DCO、三语键与双祖先；公开前确认原素材文件和来源清单逐blob不变。只有绿灯才用普通非强制push更新现有fork PR分支，复核PR head/冲突状态。不得改私有main、公开origin/main、服务或项目数据；非快进拒绝重新fetch，不rebase/force/stash。公开上游审核为外部条件，若仍阻塞就明确交接，不宣称已合入origin/main。回退需另行批准revert，不重写远端历史。

### 2026-09-29 · 将已验证同步分支合回私有main

用户在核对两个私有分支提交后明确要求“合并回main”。当前本地主目录`main=zhonggwv/main=9741c622`，隔离分支`codex/sync-main-remotes=zhonggwv/codex/sync-main-remotes=86462f4c`；前者是后者祖先，差异0/13提交。主目录无已跟踪脏文件、无锁，仅有受保护未跟踪`_to_delete/`与`曹操.md`；目标树不含同名路径。两端远端SHA已实时核对，没有新提交。已有同步分支812项后端、313项前端、生产构建、Ruff/i18n/CE/pre-commit/DCO通过，文学与像素欠项不因本轮变为通过。

可验收目标：本地主目录main和私有远端`zhonggwv/main`快进包含`86462f4c`全部历史；同名分支也包含本轮最终交接提交且两个私有分支最终同SHA。仅普通快进/普通push，不创建业务新实现。非目标：公开`origin/main`/PR、服务重启、模型调用、数据/配置迁移、受保护资料提交或删除。手工写入边界仅本台账、STATE和同名claim三份协调文件；业务代码只由已提交Git树导入，不手改。main与同步分支没有新的业务冲突；历史公开同步不借本次授权推进。

步骤：在隔离分支记录方案、校准claim并提交DCO计划后，核验远端未变和主目录跟踪状态，再于主目录执行`git merge --ff-only`到计划提交；检查主目录与源非agent树一致、未跟踪资料仍在、无未解释diff，运行Director/画布聚焦回归、前端build、guard及DCO。随后仅补交接状态与实测结果，DCO提交；正常推私有main与同名分支，分别`ls-remote`核验同SHA。任何远端非快进、主目录新脏文件或未跟踪路径冲突均停止重新审计；不用stash/reset/force/rebase。推后若需撤销须另行批准显式revert。与其他工作线重叠的业务文件仅接受现有已验证提交，不手工写入，因此不夺取其scope。

### 2026-09-29 · 将最新私有main完整同步到同名分支

用户要求把已提交并推送的Director代码/方案也同步到`codex/sync-main-remotes`。本工作树开工无跟踪或未跟踪改动、无活动锁；先获取同名远端，再将本地分支从`3fbd16e6`安全快进到远端`7ce6b78d`。当前`main=9741c622`与目标从`3fbd16e6`分叉，独有提交6/10；目标含画布预览、LibTV修复和HEVC播放，全部保留。只读`merge-tree`预演仅`docs/agent/STATE.md`、本台账及同名claim三处协调文本冲突，DESIGN和三语由Git自动合并；绝不取一边整树覆盖。

本轮只手工解决上述三份协调文件；main的业务/测试/方法包/方案由正常merge导入，目标已有画布/视频业务保持。先登记本方案、精确scope和锁，再以远端同步分支为第一父正常merge main；逐文件核对两边独有代码的blob、三语键值及合并的DESIGN。运行Director和画布/HEVC定向测试、前端build、ruff、i18n、diff/guard、DCO及定向密钥扫描；不买模型、不部署。若发现自动合并语义冲突，先记录分叉与窄改范围再动代码。完成后带DCO合并提交并仅普通推私有`zhonggwv/codex/sync-main-remotes`，只读核验远端SHA与两个父提交祖先；私有main和公开origin不动。非快进拒绝就重新fetch审计，绝不force、rebase或stash。目标工作树没有用户未提交资料，主目录`_to_delete/`/`曹操.md`原样保留；未验收的文学/像素结论不因Git同步改变。

### 2026-09-29 · 推送剩余画布提交

用户要求将刚完成的提交全部推送到私有 `ZhongGWV/dramaclaw` 同名分支。隔离 worktree 从本地 `af8fdc1` 建立；主检出目录已有 `liblib-canvas-parity` 的 HEVC 播放修复及有效锁，禁止修改或暂存其中的未提交文件。目标远端目前为 `e4877e4`，本地独有三个 DCO 提交 `391b249`、`a453fdf`、`af8fdc1`，远端独有六个提交。仅集成并推送这些已提交内容，不带入主目录的新增未提交工作。

`git merge-tree --write-tree af8fdc1 origin/codex/sync-main-remotes` 只报告 `docs/agent/STATE.md` 一处文本冲突；`DESIGN.md` 与相关台账自动合并。方案是在本隔离 worktree 以本地三个提交为第一父、正常合并远端六个提交，在 STATE 中保留双方工作线进度并更新本次推送记录。合并后检查两端祖先关系、冲突标记、签名尾注、`git diff --check` 和 guard；用户只要求推送，本轮不运行测试套件。使用显式目标引用正常推送，不使用 force、rebase、stash，不碰 `main` 或公开 fork。推送前重新核对远端 SHA；若远端又前进，先重新合并，再推送。完成后记录结果并清理隔离 worktree，主检出目录的未提交工作原样保留。

### 2026-09-27最新授权：同步主目录main到最新分支

用户在重启后明确确认“也同步主目录main”。应用已从945baa9f启动且原6项目可读，重启交接提交为3fbd16e6；该同步分支保留模型/H3/中文项目名和最新Director，集成794后端/276前端/build通过。主目录原5份未提交协调文件先按Director/同步线分别提交，业务和3份受保护资料不动、不stash/reset；此方案与本线旧交接同属同步线检查点。

随后以main为第一父正常merge最新codex/sync-main-remotes，手工仅解决STATE/同步台账/claim的协调冲突，保留双方历史与当前授权；业务文件全部只接受目标既有提交，不重新实现或更改API/模型/配置。精确业务导入路径以两端git diff和目标已验证claim为准；若业务文本有冲突立即另做窄审计，不整文件覆盖。三语与全部非agent文件逐blob比对来源，代码必须与已运行/测试的同步分支一致；DCO/密钥/guard/diff和健康读检查后普通push私有main，不推公开origin、不改服务、不触发生成。非快进拒绝则重读远端，绝不force。保留全部旧进度，产品文学/像素验收不因Git同步变为通过。

本轮手工范围仅本台账/同名claim/STATE（coordination）；Director既有记录已独立保存。风险为协调冲突和误丢本地资料；用双祖先和非agent树一致性验证，不以丢记录换快进。回退须另行授权revert，不改写历史。

### 最新追加：只把已验证合并结果同步回本地主检出

用户明确要求“把合并结果同步回主目录”。执行前主检出为 `main=f057a867`，无已跟踪脏文件、无锁；
目标 `codex/sync-main-remotes=0298aefa` 为其后代，差异0/49。87个新增跟踪路径均不与现有本地文件冲突。
本次只通过 `git merge --ff-only 0298aefa` 导入已有提交，不手工改业务代码、不拉取额外提交、不stash/reset，
不推任何远端、不重启服务、不迁移项目数据。主检出里的本地配置、凭据、运行数据及3个受保护未跟踪文件保留。
手工写入仅STATE、本台账和同名claim三个coordination文件，用于修正旧“主目录仍未同步”的交接事实。
验收：主检出HEAD与合并分支一致，源代码无额外diff；3个受保护文件SHA256一致；guard、依赖约束、
主目录生产构建及Director/H3聚焦回归通过。若快进条件不成立立即停止，不强制移动main。
远端main仍保持此前提交；未来要发布main须用户另行授权。旧章节“不改main”限制仅对应上一轮分支交付。

### 最新增量：保留目标分支新增功能并合入main最新TV Director

用户要求更新并提交到 `codex/sync-main-remotes`。本轮只更新私有 `zhonggwv` 同名分支，不改本地/远端main、不推公开origin、不部署。开始目标检出干净且无锁；已fetch两个私有引用，正常快进目标从0298aefa到4c9dee4f。main=b5883b8f已推送；两边从0298aefa分叉1/5，目标已有模型供应商、H3引用和中文项目名功能，必须原样保留。

只读merge-tree预演唯一冲突为STATE，三语自动合并。main的91条精确增量均登记现有或新增claim，业务和指南只接受Git自动导入；手工仅STATE、本台账、同名claim与必要Director交接协调，不修改方法包或产品逻辑。三语逐叶检查双方非冲突值、无重复键；Director独有路径与b5883b8f逐blob核验，目标独有业务与4c9dee4f核验。其他旧scope写权限本轮不使用。

先提交本轮方案/精确scope以保持合并起点干净，重新校准基线并acquire/preflight协调路径；正常merge b5883b8f（目标历史第一父），仅解决STATE事实冲突。验证Director后端/前端、模型目录/路由、中文项目名、H3引用聚焦回归，生产build、ruff/i18n/CE/密钥/guard/DCO及双方祖先关系；不跑收费模型/媒体。若发现真正语义冲突先扩窄方案，不为过测改变业务合同。成功后只普通push同名分支并ls-remote核验；非快进拒绝则重新审计，不force。

主目录5份未提交交接文档和受保护资料不复制、不覆盖、不stash。本轮不合入更新的origin/main；其历史PR仍独立等待。风险为自动合并的语义集成，失败保留现场，不强行发布；回退只能另行批准revert。完整Director文学/像素失败原样保留，不以同步成功代替产品验收。

### 本轮增量：将已推送的 TV Director 提交同步到本分支

用户最新要求是把 main 的四个已提交改动也交付到 `codex/sync-main-remotes`。
当前 `main=zhonggwv/main=f057a867`，目标远端 `1fa3c1bc`；共同祖先 `e7b1fbce`，
两边独有提交数为 4 / 46。目标干净 worktree 已安全快进，保留远端新增的 14 个画布/H3提交。
本轮只更新私有 `ZhongGWV/dramaclaw` 的该分支，不修改任一 main，也不更新公开 fork 或 PR #717。
PR API 已确认 #717 的 head 在另一个仓库 `ZhongGWV/dramaclaw-upstream`。

范围与步骤：

1. 完成方案、精确 scope、guard 后，以目标分支为第一父提交正常 merge `f057a867`；不用 cherry-pick、rebase、force。
2. merge-tree 在最新远端上只报告五个文本冲突：STATE、本地栈台账、zh/en/vi翻译。
   前两者保留双方事实并校正当前状态；翻译按键合并，禁止丢失 storyboard/H3 或 director 键。
   其余 main 增量仅只读导入，精确路径见 claim；不重新实现或修改文学生成方法。
3. 自动合并的 `config.py`、路由、DESIGN按双方 diff核对；不动既有画布行为。
   incoming Director 的 scope若与目标既有范围重叠，仅协调双方claim/台账为串行共享，不夺取所有权。
4. 验证：后端 Director/文本网关及 H3 聚焦测试；前端 Director/三语/故事板/H3/拆分聚焦测试；
   `pnpm build`、Ruff、i18n、CE闭合、违禁词/EE/导入门禁、pre-commit、gitleaks、DCO与双方祖先关系。
   发现语义冲突先补计划；不以旧测试结果当作本轮通过，不触发收费模型或浏览器生成。
5. 带 DCO生成合并提交，显式推 `zhonggwv HEAD:refs/heads/codex/sync-main-remotes`；
   ls-remote核对SHA，同时确认私有 main未移动。修正本分支upstream到同名远端，防误推 main。

验收：原两边提交均为祖先，受影响集成验证通过，目标远端含全部四个 main 提交；主工作区与凭据不变。
风险/回退：自动合并仍可能语义冲突；三语逐叶键比对双方，构建验证路由/类型。推送前可停止保留本地合并；
如需要撤销，另行批准显式 revert，不重写历史。原“两个main同SHA”目标是历史任务，仍等待上游审核，
本轮不据此扩大权限；未来同步不得以旧 `origin/main` 覆盖现已独立前进的私有 main。

### 历史目标（本轮不执行）

把 `origin/main` 与 `zhonggwv/main` 的两条分叉历史合并为同一个提交：保留上游 29 个独有提交、
保留 fork 50 个独有提交，解决交叉热点后验证，并最终让两个远端的 `main` 指向完全相同的 SHA。

## 非目标

- 不通过 force push、rebase 或 squash 改写任一远端既有历史。
- 不借同步顺手重构、改产品取舍或清理主工作区受保护资料。
- 不把另一台机器的运行配置、密钥、数据库或生成产物提交到 Git。

## 现状与证据

- GitHub 实际分支头：`zhonggwv/main=e7b1fbce`，`origin/main=f51c2e44`；共同祖先为 `38484897`。
- `origin/main` 自共同祖先修改 138 个路径，`zhonggwv/main` 修改 229 个路径，其中 24 个路径重叠。
- `git merge-tree --write-tree --name-only --messages zhonggwv/main origin/main` 只报告 4 个真实内容冲突：
  越南语翻译、视频节点、视频能力规则、画布 home-node guard 测试；其余上游路径可自动三方合并。
- 当前任务位于独立、干净 worktree；原 `main` 的 `.playwright-cli/`、`_to_delete/`、`曹操.md` 和活动取证台账未复制进来。
- 图2所需 H3 提交 `0bb2410b`、`51573f75`、`ec79e9fe` 均在 fork 历史；上游的付款、媒体归档、引用校验和视频续写提交均在 `origin/main` 历史。

## 写入边界

当前主目录同步轮仅手工修改STATE、本台账和同名claim；全部业务与其他交接记录由既有提交导入，三语没有手工冲突。
下表保留历史集成范围，当前轮不使用其中业务写权限；历史local-stack台账与scope协调也不另改。

集成门禁补充（实测后登记）：`.env.example` 独占追加两个可选配置说明，并校正与已合并实现一致的回环代理默认说明。
`test_real_ce_repo_env_ratchet_is_clean` 报 `DIRECTOR_TEXT_MODEL` 和 `H3_PROMPT_SKILL_DIR` 未登记；
采用注释模板记录真实含义，不扩大缺漏白名单、不改默认值、不改技能、模型或网关实现。
回退只移除本轮注释，验证原有环境棘轮测试和零缺漏检查；这是提交集成所需的配置文档修复。

| 路径 | 模式 | 作用 / 为什么必须改 |
|---|---|---|
| `docs/agent/STATE.md` | 协调 | 登记全局集成工作线与冲突顺序 |
| `docs/agent/tasks/sync-main-remotes.md` | 协调 | 方案、验证与双远端交接 |
| `docs/agent/claims/sync-main-remotes.toml` | 协调 | 机器可读的精确合并范围 |
| `frontend/public/locales/vi/translation.json` | 共享 | 按 key 同时保留 fork 功能和上游新增文案 |
| `frontend/src/features/canvas/nodes/VideoNode.tsx` | 共享 | 合并 H3/Mixed、LibTV/拉片与上游引用校验/续写行为 |
| `frontend/src/features/canvas/nodes/shared/videoModelCapabilities.ts` | 独占 | 合并 H3 模式矩阵与上游引用校验规则 |
| `tests/test_freezone_canvas_route_home_node_guard.py` | 共享 | 保留 fork 路由数量断言并接入上游新路由 |
| `scripts/check_env_config.py` | 独占 | 登记 fork 已提交但未进入公共模板的可选本地运行变量 |
| `license-inventory.csv` | 独占 | 按合并后的 Git 索引重生成许可证路径清单 |
| `src/novelvideo/agents/story_writer.py` | 共享 | 把 fork agent 接到上游新增的 agent 专用能力标签 |
| `src/novelvideo/freezone/history.py` | 共享 | 修正 fork 全档位缩略图预热实现遗留的旧 docstring |
| `src/novelvideo/media_archive_copy.py` | 独占 | 让上游归档端口降级逻辑兼容测试/开发态模块热重载 |
| `frontend/src/features/canvas/nodes/PromptMentionEditor.tsx` | 独占 | 避免 H3 候选签名刷新抢先销毁素材替换等待中的 chip |
| `tests/test_media_thumbnails.py` | 独占 | 让上游测试断言匹配 fork 已交付的全档位缩略图预热策略 |
| `tests/test_task_payload_projection.py` | 独占 | 按合并后的 22 个 freezone runner 更新完整集合哨兵 |
| `tests/test_task_runner_home_node_placement.py` | 共享 | 纳入 fork 的自包含音频变换任务 |
| `assets/readme/{GENERATION,REVISION-NOTES}.md` | 独占 | 删除上游新增文件的多余 EOF 空行，满足 diff/pre-commit 格式门禁 |
| `origin/main` 其余 134 个精确路径 | 只读导入 | 精确列表见同名 claim；只接受 Git 三方自动结果，不手工改写 |
| 相关既有任务台账 / claim | 协调 | 为上述两个共享热点声明最终集成顺序，不改变原任务所有权 |

## 协调与冲突

- **相关工作线**：`liblib-canvas-parity`、`depth-motion-da3`、`shot-breakdown`、`legacy-unassigned-diff`、已完成的 H3 工作线。
- **本地已有改动**：隔离 worktree 无业务 diff；主工作区本地资料不进入本次合并。
- **远端重复实现**：两边不是简单重复。fork 含 H3、音频动作、LibTV、Depth、story/local stack；上游含付款、引用校验、媒体归档与视频续写。本轮使用真实 merge 保留两边提交，不挑一边整文件覆盖。
- **共享文件顺序**：已有工作线提交在前；本线是唯一最终集成者，只解决三方合并报告的 4 个冲突。`VideoNode.tsx` 必须同时保留 Mixed 顺序和上游引用校验/续写；home-node 测试以合并后真实路由表为准；翻译只按 key 合并。
- **2026-09-25 窄 follow-up**：`minimax-h3-canvas-defaults` 获准在已合并基线上只改 `official_media_models.json` 的 MiniMax-H3 参数默认值；该线不得改写其余 origin/main 导入内容，本文件的精确 claim 已与 follow-up 互认共享范围。
- **2026-09-26 后续记录**：H3 视频参考时长探测修复由 `minimax-h3-canvas-defaults` 独立跟进，范围只覆盖“无时长边界、非视频编辑”分支；本同步线仍将合并后的 `freezone.py` 作为只读基线，其余导入语义保持原样。

## 实施方案

1. 完成台账、精确 claim、互认共享范围并取得隔离 worktree 锁——完成条件：guard check/acquire/preflight 全绿。
2. 以 `zhonggwv/main` 为第一父提交合并 `origin/main`，仅手工解决 merge-tree 报告的 4 个冲突——完成条件：无冲突标记、无超范围手工改动、两边提交均为祖先。
3. 先跑冲突文件聚焦测试，再跑前端构建、后端默认测试与仓库门禁——完成条件：新增集成回归全绿；存量/环境失败明确记录。
4. 生成带 DCO 的非快进合并提交；优先直接推送 `origin/main`，若分支保护拒绝则推集成分支、创建并合并 PR——完成条件：`origin/main` 接受包含双方历史的最终提交。
5. 把同一个最终 SHA 快进推送到 `zhonggwv/main`，重新 `ls-remote` 核对——完成条件：两个远端 `refs/heads/main` 完全相同。

## 风险与回退

- **风险**：24 个双边修改热点虽只有 4 个文本冲突，自动合并仍可能产生语义冲突；必须用相关测试和构建验证，不能以“无冲突标记”等同正确。
- **风险**：上游分支保护可能禁止直接推送；改走 PR 后 GitHub 可能生成额外 merge commit，届时以 origin 最终 SHA 为准再同步 fork。
- **回退**：在推远端前删除隔离集成分支即可；推送后仅使用新的显式 revert 提交，不改写任一 main 历史。

## 验收标准

- [x] H3/Mixed、引用校验、视频能力和 home-node 聚焦测试全绿。
- [x] `cd frontend && pnpm build`、`uv run ruff check .`、前后端 i18n、CE 端口闭合与 agent guard 全绿。
- [x] `uv run pytest` 默认测试集通过；前端完整 Vitest 也在声明的 Node 22 运行时全绿。
- [x] `git merge-base --is-ancestor` 证明原两个 main 均为已验证集成提交祖先。
- [ ] 两次远端 `ls-remote` 返回相同 main SHA。
- [x] 本轮改动全部在写入边界内，无未解释 diff；合并提交带 DCO，diff 格式与 guard 已通过。

## 进展记录

### 2026-09-29 · 公开fork推送与PR交接

双父DCO合并提交`66da025f0ec69e046223c054803a93766fa5851e`的第一父`56f72231`包含私有`bc051ed3`，第二父为最新公开`origin/main=30ab52c7`；PR旧头`17436a2e`、私有main及公开origin/main均经祖先检查纳入，索引无冲突/格式错误。提交前pre-commit的gitleaks、guard、禁词全部通过，DCO全历史检查通过，35张原图、图标目录及来源清单相对私有main的逐文件diff为零。普通非强制push将公开fork`codex/sync-main-remotes`从`17436a2e`快进到`66da025f`；GitHub PR #717只读复核head同SHA、base`30ab52c7`、`MERGEABLE`、`REVIEW_REQUIRED`、`OPEN`，当时尚无状态检查结果。未直接修改`origin/main`，亦未移动私有main或重启服务。

本工作线代码和公开PR更新已交付；这份交接将作为后续文档提交使PR head再前进一次，最终head以Git复核为准。外部剩余动作是上游审核/合并。下一位接手先`git ls-remote origin refs/heads/main`与`gh pr view 717 --repo dramaclaw/dramaclaw`核对是否新前进，再决定是否需要新的同步；绝不把现有PR head误报为origin/main。已知全量存量失败及素材许可风险详见下条，不得省略或改成全绿；原素材未获明确再分发许可，用户确认原样提交不改变这一事实。

### 2026-09-29 · 公开PR合并冲突与回归分层验收

以私有`bc051ed3`为第一父正常合入公开`origin/main=30ab52c7`，六个文本冲突逐段合并：保留拉片/DA3的API和节点字段、上游视频增强报价/探测及网络出站分类，不把网关超分误列本地leaf。合并实际另有12个上游独有或自动合并的暂存路径，先暂停业务写入、登记精确只读scope，guard从BLOCKED恢复为33线/1228 claims；原35张图片、图标目录和来源清单相对私有main逐文件零差异。没有改私有main或公开origin/main。

验证：Freezone/H3交界定向后端125通过，前端关联15通过，`pnpm build`、Ruff、前后端i18n、CE 11端口闭合及三类lint通过。全量后端`5682 passed, 10 failed, 20 skipped, 2 deselected`；其中7项业务/环境清单测试在未合并的私有main以同一命令同样失败，2项SSE端口测试在两边沙箱外也同样以`StopAsyncIteration`失败，余1项wheel在允许依赖下载并用隔离uv缓存后复测通过。全量前端使用本机Node24为`3558 passed, 1 failed`；唯一上传解析/MSW失败在私有main逐项复现；本机默认Node25额外引入5项localStorage测试假失败，不能作为项目回归。全量套件未全绿，不能写成通过。

方案门调整：原“只有绿灯才推”的门禁解释为**本次新增/集成路径与适用构建门禁无回归**，不因已经在私有main逐项复现的存量失败阻断用户明确要求的公开PR提交；这些已知红灯必须在交接和PR里披露，后续独立工作线修复，不借本轮扩大到H3、环境模板、许可证清单或上传MSW。推送仍以索引diff、gitleaks、DCO、双祖先、远端非快进及素材原样校验为最终门；任何新增失败或远端变动即暂停。此调整不表示TV Director文学质量、全页像素或素材再分发许可已验收。

### 2026-09-29 · 公开PR集成方案门与共享互认

从已推私有main`bc051ed3`建立干净隔离分支，取得公开上游`30ab52c7`与现有PR head`17436a2e`只读证据；预演六个文本冲突。用户明确选择保留36项原参考素材，但来源清单继续标明未获再分发许可，不伪称已授权。先登记目标、非目标、风险和六个精确业务路径；对八条既有工作线仅补共享路径互认/串行顺序，没有改其业务文件。guard通过（33线/1216 claims），本会话独占锁和25条精确路径preflight通过。下一步提交本方案、正常merge最新origin/main并验证，不触碰主目录私有main。

### 2026-09-29 · 私有两分支快进合回并核验

主目录`main`在只有受保护未跟踪`_to_delete/`、`曹操.md`且目标树无同名路径的前提下，严格快进`9741c622 → dd49ecedf523c9ecb00d01c91761f0b4153a614a`；无合并冲突、无业务手改，原两份资料仍在。`git diff --exit-code codex/sync-main-remotes -- . ':!docs/agent/**'`通过。主目录实际复测：后端Director/浏览器视频812通过，前端Director/画布预览/边线/三语27文件313通过，`pnpm build`通过；Ruff、前后端i18n、CE端口闭合、DCO、guard与diff检查均通过。仅有既有依赖弃用、Node本地存储与大chunk警告，未运行付费模型或重启服务。

普通推送私有`zhonggwv/main`与`zhonggwv/codex/sync-main-remotes`后，`ls-remote`两端均为`dd49eced`。公开`origin/main`和PR #717未动；此次私有两分支的代码同步完成，不代表TV Director文学质量或像素级验收完成。最终交接提交和两端SHA以Git再次核验为准；历史公开同步须单独授权。

### 2026-09-29 · 私有main快进方案门

隔离分支与私有远端同为`86462f4c`，主目录及私有远端main同为`9741c622`；祖先关系为0/13，目标Git树无两份受保护未跟踪资料的同名路径。当前只登记三份协调路径的方案与scope，guard通过，已取得本检出锁并对精确路径preflight通过；尚未移动main、推远端或触发模型。下一步先提交方案，再在主目录用严格快进导入已验证提交。

### 2026-09-29 · 最新 Director 同步分支交付

带DCO的正常合并提交`27c474cc3989796a66b98f33d66481241be2fdba`以`2f664127`、`9741c622`为父，原目标远端`7ce6b78d`与main`9741c622`均为祖先。普通推送`HEAD:refs/heads/codex/sync-main-remotes`成功，远端`ls-remote`复核为`27c474cc`，私有main保持`9741c622`。集成与测试详见下条；本轮没有修改或推送公开origin、没有更改主目录受保护资料，也不把代码同步等同于TV Director产品验收。后续仅历史公开同步/PR及文学和像素欠项独立待验收。

### 2026-09-29 · 最新主线内容并入同名分支的集成验证

目标分支先快进到私有远端`7ce6b78d`，方案单独提交为`2f664127`；以其为第一父正常合入main`9741c622`，仅本台账、STATE与同名claim出现文本冲突，逐段保留双方历史。画布/HEVC相关业务文件逐路径与`7ce6b78d`一致，Director代码、测试、技能与方案逐路径与`9741c622`一致；三语对双方所有叶键检查均无缺项。没有手改产品逻辑、调用收费模型或改动主目录资料。

本轮实际验证：`PYTHONPATH=src .../.venv/bin/python -m pytest tests/director tests/test_tv_director.py tests/test_browser_video_playback.py -q`为812通过；`pnpm exec vitest run director canvas-preview canvas-edge-paint canvas-group-paint video-playback-url locales-json`为27文件/313项通过；`pnpm build`成功（有原有大块警告），`ruff check .`、前后端i18n、CE端口闭合、guard、合并索引diff格式与对暂存文件的pre-commit三门均通过。`npx --no-install @google/design.md lint DESIGN.md`在本机未产生输出、等待后人工中止，不计作通过；DESIGN仅由Git自动合并并已人工检查双方增量。下一步形成DCO合并提交、普通推送私有同名分支、核验远端SHA与两个父提交祖先；公开origin/main与私有main保持不变。

### 2026-09-29 · 画布提交与远端 Director 正常集成并推送

隔离 worktree 中先提交本轮方案 `5109ae1`，再以它为第一父正常合并远端 `e4877e4`，生成带 DCO 的 `9d2e486`。文本冲突仅为本台账和 STATE；STATE 保留远端最新 Director/本地栈进度与本地画布工作线记录，claim 基线同步为 `af8fdc1`。画布源码相对本地 `af8fdc1` 没有变化，Director 源码相对远端 `e4877e4` 没有变化。合并索引无未解决项或冲突标记，`git diff --cached --check` 与 `agent_guard check` 通过，两端原头均为合并提交祖先。普通推送 `HEAD:refs/heads/codex/sync-main-remotes` 成功，随后 `ls-remote` 返回 `9d2e486`。本轮仅做集成静态检查，未运行测试套件；不触碰主检出目录正在进行的 HEVC 未提交工作，不推 main 或公开 fork。此后只补交接文档状态并正常推送。

### 2026-09-27 · 主目录合并验证及交付

将3fbd16e6正常合入main；只解决STATE/本台账/claim三个协调冲突，双方记录均保留。原5份未提交交接已分别保存为d1b73e14与522f50fe，受保护的3份未跟踪资料不动，没有stash、强制切换或手改业务。

本轮实际执行：`git diff --exit-code 3fbd16e6 -- . ':!docs/agent/**'`通过，所有业务、测试、指南、配置、资产与已验证来源完全一致；`git diff --cached --check`通过、未解决冲突为空。`agent_guard.py check`为31线/1100claims；对82个精确暂存路径执行`pre-commit run --files ...`，密钥扫描、guard、禁词全部通过。四服务、前端API代理和项目列表只读请求均HTTP200，原6项目可读取。

来源已有794后端、276前端与生产构建通过（命令见下节），本轮未重复运行这些测试、未调用付费模型或生成媒体。采用带DCO的正常合并提交并仅普通推送私有main，再核验双方祖先、DCO及远端SHA；最终提交/推送事实以Git为准。公开origin/PR、正在运行的同步worktree服务和原配置/数据保持不动；待验收仅保留历史公开同步/产品欠项，不代表需要重新实现本轮代码。

### 2026-09-27 · 主目录最新同步检查点

用户已明确授权当前main同步最新集成版本；本线先保存此前主目录快进的旧交接和本次计划，Director旧记录已分线提交。业务无未提交diff，原受保护资料不动；后续只在协调文件解决真实merge冲突。源代码直接保留同步分支已验证内容，主目录合并后必须与源非agent树一致，再推私有main并核验。

### 2026-09-27 · 最新Director已交付私有同步分支

合并提交 `fb80eafb4afc5ba2e74fe5d005ddd96c98f3786e` 已正常推送至 `zhonggwv/codex/sync-main-remotes`；远端ls-remote复核一致，私有main仍为b5883b8f。目标原4c9dee4f与来源b5883b8f均为合并提交祖先，方案/来源/合并提交DCO全部通过。794后端、276前端、build与三语/双边blob检查结果见下节；93个暂存文件的pre-commit密钥/guard/禁词检查通过。没有重写业务、覆盖main、复制主目录未提交资料或触发收费任务。最后追加此交接记录提交；最终同名分支HEAD以Git为准，交付功能事实仍是fb80eafb。

本次指定分支同步已完成；状态待验收只保留历史公开PR/完整产品验收事项，不表示本次未交付。未来如需把该分支新增模型/中文名回合main，须先获新授权并重新审计主目录5份未提交交接文档，不直接pull/stash。随后正常handoff/release，不留锁。

### 2026-09-27 · 最新Director合并与集成验证通过

正常merge b5883b8f，唯一STATE冲突按目标同步状态与来源Director事实合并；没有手工业务改动。85条来源独有业务/指南路径与b5883b8f逐blob一致，42条目标独有业务/测试路径与4c9dee4f一致；三语按共同祖先逐叶校验，无重复键或丢值，7252个来源键及7218个目标键合并成各7325键。目标模型配置、H3引用和中文项目名功能完整保留。

实际在目标worktree使用既有Python环境、`PYTHONPATH=src`运行：

- `python -m pytest tests/director tests/test_tv_director.py tests/test_newapi_text_gateway.py tests/test_local_model_catalog.py tests/test_local_provider_api.py tests/test_local_gateway.py tests/test_text_reference_contract.py tests/test_project_name_validation.py tests/test_project_rename.py tests/ports/test_project_chinese_names.py tests/test_h3_prompt_optimizer.py tests/test_h3_stream.py -q`：794通过，11条依赖弃用警告。
- 前端Node22：`pnpm exec vitest run director local-model-catalog project-chinese-names project-name-validation project-first-liblib-import h3-request-contract h3-stream`：23文件276通过；`pnpm build`成功，5547模块，既有大chunk警告。
- `ruff check .`、前后端i18n、`check_ce_port_closure.py`（11端口）、CE导入/禁词/禁用包名、工作树和索引diff检查通过；guard31线1100claims。

未运行全仓测试、实机Windows或真实付费模型；本次是已提交实现的集成验证，原文学/全页像素失败不改。主检出main与5份协调diff、受保护资料不变。下一步暂存精确协调文件，执行暂存检查/密钥扫描，生成带DCO合并提交，验证双方祖先并只推私有同名分支，再核对远端SHA与main未动。

### 2026-09-27 · 最新Director同步方案门

方案提交77180e7d后，首次handoff因计划内容在acquire前已写入、提交清空diff而被拒绝；未强制释放。后续命令未因该失败短路，实际merge已停在预期STATE冲突。现仅修协调状态、记录此偏差，以原owner正常handoff/release后重新取得锁并preflight；没有手工业务修改或覆盖目标代码。后续命令逐步检查exit code，不把guard失败当作可忽略输出。

恢复目标worktree后确认4c9dee4f与已推main的b5883b8f分叉，唯一文本冲突STATE。记录91条导入路径并新增47条精确read-only claim；现有业务改动不重写，三语按叶核验双方。目标历史模型/H3/中文名功能必须保留，主目录原5份协调diff和本地资料不碰。下一步正常合并、聚焦集成验证、DCO提交及仅私有同名分支推送。

### 2026-09-27 · 当前分支合并收口

已保留远端 0298aef 的 Director 历史以及本地 53ca321/1c8eaaa 的模型与引用修复。
方案提交后校准精确基线到 11f553e，协调冲突合并双方共享集合；三语手工解冲突前 preflight 通过。
三语逐叶键核对：本地 6616、远端 7145、合并后各 7205，双方所有键和值均保留，无重复键。
218 项远端独有业务/文档文件与源提交完全一致，25 项本地独有业务/测试文件与本地源完全一致。
无未解决冲突、无额外未暂存改动；diff check、guard（30 工作线/979 claims）与密钥扫描通过。
Gitleaks 对本地三项待推送提交约 200KB、合并暂存约 2.74MB 均无泄露。本轮没有运行实现测试或生成请求。
正常创建带 Signed-off-by 的合并提交，仅推 origin 的 codex/sync-main-remotes，最终提交和推送结果以 Git 核对。
补充本机当前分支 fetch 映射，避免只取 main 导致同名远端缓存再次过期；不修改全局代理或其他分支。
历史双 main 同步及 Director 产品验收仍是独立待办，本轮不扩大到部署、公开 PR 或其他分支。

### 2026-09-27 · 当前分支 pull/push 增量方案

用户授权 pull 并 push 当前分支。当前 origin 指向用户仓库；fetch refspec 只配置 main，旧分支缓存过期。
真实源 FETCH_HEAD 为 0298aef，本地 1c8eaaa，分叉 2/7；本轮仅同步当前同名分支。
merge-tree 确认 238 项远端增量，7 个冲突：STATE、H3/故事板/拆分三份 claim、zh/en/vi 翻译。
远端 Director 作为既有实现只读合入；本地两项模型配置与引用修复原样保留，其他业务不手改。
翻译按 JSON 键合并且保持双方既有值，claim 合并 shared_with 集合，STATE 保留双方事实与当前任务状态。
精确导入/冲突范围已补入同名 claim，现有 shared 范围互认；本线唯一串行集成，不创建子代理。
先提交本方案以保持合并起点干净，再 acquire/preflight，正常 merge 并解决上述冲突；不 rebase/force。
完成 JSON/冲突标记/差异/guard 与密钥检查，验证双方祖先关系，推 origin 当前分支并核对远端 SHA。
本次只执行用户指定 Git 同步，不新增或运行实现测试、不触发生成；无运行配置、密钥或本地工作流改动。
若推送期间远端再前进，重新取证并合并，绝不覆盖。推送前失败可保留合并现场继续处理。

### 2026-09-26 · 主目录快进及本地验证完成

已执行 `git merge --ff-only 0298aefa4734c3d8e5a02362cbf068351833c343`，主目录main与合并分支相同，
Git未生成新合并提交。导入后 `git diff --exit-code codex/sync-main-remotes` 与cached比对均通过；
guard为29条工作线/940claims，通过。主检出相对私有远端main ahead49/behind0，没有执行push。
3个未跟踪受保护文件前后SHA256相同；本地配置/凭据/项目目录没有跟踪路径变动。
前端package/lock与主目录原版本相同，无须重新安装；现有sse-starlette 3.4.5满足上游>=3.3.0约束。
主目录 `pnpm build` 在Node22下通过（5533模块，仅大chunk警告）；
`.venv/bin/python -m pytest tests/director tests/test_tv_director.py tests/test_newapi_text_gateway.py tests/test_h3_prompt_optimizer.py tests/test_h3_stream.py tests/test_local_gateway.py tests/test_image_generation_selection.py -q`
为545通过/10条依赖弃用警告。所有业务代码仍与0298aefa一致，三个交接文件是本轮唯一跟踪diff，保留为本地文档更新。
本轮没有创建新提交、推远端或重启服务；历史功能/文学质量欠项未因此被标成完成。

### 2026-09-26 · 本轮私有分支同步完成

合并提交 `96bda53cb7ae6757d0d9c1613194053b28f3691f` 已正常推送到
`zhonggwv/codex/sync-main-remotes`，ls-remote与本地HEAD完全一致；DCO与双方祖先检查通过。
私有 `main` 仍为 `f057a8678de7faf0adbf82b6035b324821af53f8`，未改写；公开fork/PR未推送。
本地该分支upstream已纠正为同名远端，避免默认push误发main；目标工作区干净、锁正常释放。
主检出仍在main，仅有原受保护未跟踪资料，本轮未触碰。560后端/127前端与构建结果见下节。

用户本轮“也提交到此分支”已完成。本台账仍留活动索引的“已阻塞”仅指历史双main同步等待上游审核，
不表示此次私有分支交付失败；下一轮必须重新比较所有分支，不得执行旧交接中的直接覆盖命令。

### 2026-09-26 · 本轮集成验证收口，准备推送私有分支

`.env.example`仅补充两个可选变量注释及回环代理默认说明，无任何运行态/模型参数变更。
补充回归15项全部通过；合计本轮后端560项、前端127项通过。前端安装严格使用已锁版本，
首次离线安装因包元数据访问被沙箱DNS限制，授权网络后 frozen-lockfile 成功，锁文件无额外漂移。

实际验证命令（Python使用现有受锁运行环境，`PYTHONPATH=src`指向本worktree）：

- `python -m pytest tests/director tests/test_tv_director.py tests/test_newapi_text_gateway.py tests/test_h3_prompt_optimizer.py tests/test_h3_stream.py tests/test_local_gateway.py tests/test_image_generation_selection.py -q`：545通过。
- `python -m pytest tests/test_env_config_ratchet.py tests/test_dependency_license_gate.py -q`：修复模板缺漏后15通过。
- `pnpm exec vitest run src/__tests__/director-execution.test.tsx src/__tests__/director-richtext.test.tsx src/__tests__/director-ui.test.tsx src/__tests__/i18n/locales-json.test.ts src/__tests__/storyboard.test.ts src/__tests__/storyboard-ui.test.tsx src/__tests__/storyboard-sync.test.tsx src/__tests__/h3-stream.test.ts src/__tests__/video-prompt-split.test.ts src/__tests__/stores/canvas-store-video-split.test.ts src/__tests__/routes/project-first-liblib-import.test.tsx src/__tests__/components/layout/project-navigation-routes.test.ts`：12文件127通过。
- `pnpm build`：通过，5537模块，只有大chunk警告；`ruff check .`：通过。
- `python3 scripts/check_frontend_i18n.py`、`python3 scripts/check_backend_i18n.py`、`python scripts/check_ce_port_closure.py`：通过。
- `python3 scripts/lint_banned_words.py`、`python3 scripts/lint_ee_terms.py`、`python3 scripts/lint_ce_imports.py`、`pre-commit run --all-files`：通过。
- `git diff --check`、`git diff --cached --check`、`python3 scripts/agent_guard.py check`：通过；29条工作线与scope相容。

Director业务目录相对 `f057a867` 无差异；只合入已有实现，三语和协调冲突已审计，没有修改原有H3、故事板行为。
接下来生成DCO合并提交，复核双方祖先后只推私有同名分支；公开PR和两个main保持原样。

### 2026-09-26 · 合并与聚焦验证

五个文本冲突已保留双方解决，config.py保留Director回环代理与目标Krea编辑模型两个不重叠增量。
三语分别逐叶验证：6556个原键值不变，合入main的589个新增键值，合计7145，无重复键。
Ruff、前端i18n零命中、后端474/29、11个CE端口、违禁词/EE/导入与pre-commit全通过。
后端Director/文本/H3/本地网关聚焦545通过；前端12文件127通过；Node22 + pnpm11.5生产构建通过，
仅既有大chunk警告。额外环境/依赖门禁14通过1失败，确认为上述两个缺少模板注释的配置名，已先补方案。
全量测试和真实付费模型/Windows本轮未跑；不将集成通过表述为Director功能/文学质量全部完成。

### 2026-09-26 · TV Director 增量同步方案门

方案与222条精确只读/协调导入范围已提交为 `906355d7`；三语共享互认及预检成功。
此后仅按已预演的五个冲突推进，不扩大至其他业务功能。

只读核对本地与远端、公开PR归属并安全快进干净目标工作区到 `1fa3c1bc`；guard为27工作线/597claims，无锁。
预演确认五个冲突，源 main 已推送，不是待提交脏文件。下一步锁内预检、正常合并和集成验证；尚未声称完成。

### 2026-09-24 · 上游 PR 可合并但等待必需审核

做了什么：生成带 DCO 的非快进合并提交 `a2418a65`；刷新两个远端后确认 `origin/main=f51c2e44`、
`zhonggwv/main=e7b1fbce` 均为该提交祖先。直接推 `origin/main` 被 GitHub 以 403 拒绝；现有
`ZhongGWV/dramaclaw` 又是独立仓库、不是 GitHub fork，不能发跨仓库 PR，因此创建标准 fork
`ZhongGWV/dramaclaw-upstream` 并提交 upstream PR #717。

为什么停在这里：PR 状态为 `MERGEABLE`，但 `REVIEW_REQUIRED` / `BLOCKED`；当前两个已登录账号对
`dramaclaw/dramaclaw` 都只有 pull 权限，无法直接合并或开启 auto-merge。提前把独立仓库的 main 移到
集成提交只会让两个 main 在审核期间继续不同步，所以保留现状，等 origin 产生最终提交后再单次快进。

怎么验证的：`git merge-base --is-ancestor origin/main a2418a65` 与 fork 对应命令均成功；
`scripts/check_dco.py`、pre-commit 和全部代码/测试门禁均通过；GitHub PR API 返回
`mergeable=MERGEABLE`、`reviewDecision=REVIEW_REQUIRED`。

### 2026-09-24 · 合并实现与全量验证完成，等待双远端推送

做了什么：保留两边全部历史并解决 4 个文本冲突、视频引用 `nodeId`、环境变量/许可证/runner 合同、
缩略图全档位断言、story agent 能力、可选归档端口热重载以及 H3 候选刷新与素材替换的 effect 顺序。
上游两个 README 生成说明文件的多余 EOF 空行也已格式化；没有改写任一分支历史。

为什么这么改：文本三方合并不能发现类型、effect 时序、测试集合和模块热重载这类语义冲突；这些问题均由
构建或完整测试复现，并按现有产品行为/仓库模式做最小修复。当前机器默认 Node 25 会额外启用实验性
WebStorage，因此前端全量验证按仓库声明改用临时 Node 22 + pnpm 11.5.0。

怎么验证的：后端 `4710 passed, 20 skipped, 2 deselected`；前端 `442` files / `3251 passed`；
生产构建通过（5437 modules）；完整 Ruff、CE 端口闭合、前后端 i18n、违禁词和 EE 词门禁均通过；
聚焦 H3/引用/视频能力 161 passed，聚焦后端 194 passed / 1 skipped，语义修复回归 159 passed。

### 2026-09-24 · 完整回归扩展出语义集成点

做了什么：生产前端构建通过；默认后端测试跑到 4697 passed、20 skipped，并把失败收敛为 11 个。
其中 2 个 Gunicorn/SSE 用例单跑确认是受沙箱禁止绑定本地端口影响；其余 9 个来自两边各自新增合同在
合并后需要对齐：本地环境变量登记、缩略图全档位策略、许可证索引、agent 能力、runner 总数和
placement-free 白名单。首次修复后完整套件只剩 2 个顺序相关失败：前序契约测试重载端口注册模块，
媒体归档复制仍缓存旧异常类，导致本应降级的“端口未注册”穿透。
前端完整套件另发现 H3 新增的候选签名重建会先于既有素材替换 effect 执行，令等待中的 chip 引用失效；
该用例与 Node 版本无关，是合并后必须修复的真实交互回归。

为什么扩范围：这些文件没有文本冲突，但上游新测试会读取 fork 新增实现，属于真实的三方语义冲突；
只解决 4 个冲突标记会把一个已知红色的 main 推到两个远端。归档端口异常按仓库其他可选端口的既有
类名兼容模式收敛；所有新增写入均限制为合同对齐或机械重生成，不改变产品行为。

怎么验证的：失败列表已由 `.pytest_cache/v/cache/lastfailed` 与逐文件复跑核对；新增精确路径写入 claim，
与 story/depth/shot 台账互认后重新 preflight，再实施修改。

### 2026-09-24 · 构建暴露引用节点标识的语义合并缺口

做了什么：真实 merge 按预演只产生 4 个文本冲突，均已按双方语义解决；后端聚焦测试 194 passed、
1 skipped，前端聚焦测试 161 passed。生产 TypeScript 构建进一步发现视频编辑源片的时长校验对象
缺少上游新增的必填 `nodeId`。

为什么分叉：`VideoNode.tsx` 的三方自动合并把上游引用校验函数签名与 fork 的视频编辑分支拼在一起，
文本上无冲突但类型合同已变化。该路径属于已认领冲突文件，决定让源片校验携带真实上游节点 id；
找不到上游节点时退回当前视频节点 id，确保校验弹窗的“定位节点”始终有有效目标。

怎么验证的：冲突标记已清零，越南语 JSON 可解析，`git diff --check` 对手工冲突文件通过；
待补 `nodeId` 后重新运行生产构建与完整测试。

### 2026-09-24 · 方案门完成

做了什么：从最新 `origin/main` 建隔离 worktree，随后以 fork 主线建立 `codex/sync-main-remotes`；
读取 STATE/协作手册、更新两个远端引用，并用 merge-tree 完成 138/229 路径与 4 个真实冲突的审计。

为什么这么做：当前主工作区有受保护本地资料和另一条活动工作线；直接 pull/rebase 或把 fork 强推到
上游都会覆盖历史。独立 merge commit 是唯一能同时保留双方提交、又让两个 main 最终同 SHA 的路径。

怎么验证的：隔离 worktree `git status` 干净，`agent_guard check` 为 `OK: 16 workstreams, 342 claims`；
`git merge-tree` 只报告 4 个内容冲突，尚未执行真实 merge 或测试。

## 已定下来的决策

- **最终两个 main 必须同 SHA。**——用户明确要求两个分支保持一致，不能只把 H3 单独 cherry-pick 到上游。
- **保留双方历史，用 merge 不用 force/rebase。**——两边都有独有且有价值的已发布提交。
- **自动合并路径只读导入，手工判断只限 4 个冲突文件。**——降低无关格式化和主观改写风险。
- **若上游受保护，以 origin 合入后的最终 SHA 为权威再同步 fork。**——PR 合并可能产生新的服务端提交。

## 待办

- [x] 完成 claim 与共享互认后 acquire/preflight。
- [x] 执行合并、解决文本与语义冲突并完成全量验证。
- [x] 用户本轮要求的 TV Director 四个 main 提交已合并、验证并推送私有 `codex/sync-main-remotes`。
- [x] 后续请求：本地主目录main已快进到合并版本0298aefa；没有更新任何远端。
- [ ] 历史上游维护者审核 PR #717；合入后重新审计双方 main 与当前私有集成分支，另行取得同步授权。

## 阻塞

本轮私有分支交付无阻塞。历史 `dramaclaw/dramaclaw` 审核/合入权限仍在上游维护者，PR #717仍OPEN；
私有main已经按后续用户请求独立前进。阻塞解除也不代表获准把私有新增Director及素材发布到公开fork。

## 交接摘要

- **最后完成到**：最新同步分支已严格快进合入主目录main，两个私有分支远端先复核同为`dd49eced`；812后端/313前端/build及门禁通过，主目录两份未跟踪资料仍在。后续交接提交的最终两端SHA以Git为准。
- **下一步唯一动作**：恢复时只读核对私有main与同名分支是否同SHA；若一致不重复合并。历史公开同步须另行授权，不重复实现或改正在运行的服务。
- **先读这些文件**：本台账、`docs/agent/STATE.md`、PR #717 状态。
- **不要动这些文件 / 决策**：不强推、不rebase、不推公开fork或origin/main；仅本轮获准普通推私有main。不重启既有服务，不公开本地凭据/素材许可未确认的新增资产；保留主工作区受保护资料。

### 2026-09-26 · 故事板共享协调

本线既有实现先完成，storyboard-dual-view 后续串行集成共享视图接点；保留本线生成和保存行为。由当前 Codex 会话集成，禁止改工作流坐标。

### 2026-09-26 · 时间分镜拆分协调

本线先完成，video-prompt-split 后串行集成，保留原功能；当前会话集成共享路径：frontend/public/locales/vi/translation.json, frontend/src/features/canvas/nodes/VideoNode.tsx, frontend/public/locales/en/translation.json, frontend/public/locales/zh/translation.json。


### 2026-09-26 · H3 提示词优化协调
原工作先完成，h3-prompt-optimizer 在共享路径串行增加可选优化参数/入口/翻译，由当前会话集成，保留原行为。


### 2026-09-27 · 多供应商模型接入协调
用户已授权多供应商选择，替代原本固定硅基流动的限制。已有实现先完成，本线由 multi-provider-models 串行扩展模型目录、调用路由与选择器；最终集成为当前会话，保留既有数据和工作流。共享路径：frontend/public/locales/vi/translation.json。

### 2026-09-27 · 预览与拖动串行协调

canvas-lod-perf 在现有实现之后串行修改共享 VideoNode 的封面显示档位、预览就绪标记与内容引用订阅；保留本线生成/布局语义，由 codex/pan-stable-20260927b 集成。

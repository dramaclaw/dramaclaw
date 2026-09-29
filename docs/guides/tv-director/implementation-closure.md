# TV Director 融合方案收口与代码级实施清单

设计 v2.1，2026-09-25；实现状态更新于2026-09-26。本文是[主方案](../tv-director-skill-fusion.md)的开发接手入口，不是另一套业务规则。**方案收口与产品完成分别验收。** 实际实现见下方§0；本文列出的目标代码、接口、482个计划用例均未因此自动实现或执行。

2026-09-27 r2说明：当前实施顺序与验收以[全产品总案](full-replication-plan.md)S0–S10及[当前157项审计](plan-closure.json)为准。本文件P/WP是历史分解，不另开第二套阶段。旧固定100集上限已去掉；E08一键续创自动发送的补证及安全边界见工作流§1.2，不再按attach-only实现。

## 0. 当前还差多少（2026-09-26，按完整退出条件）

**22个工作包都仍有未满足的退出条件，不等于22包都没写代码。** 不能以365项局部后端测试或39项前端测试换算产品完成率。实际可加载的方法适配包为6/24：M03、M07、M08、M09、M11、M12；另外18个完整方法包尚未落齐，已有M22/M23宿主算法也不等于其完整包交付。33类gold目前只有9个文件；149动作/8能力没有完成逐项业务验收。

| 工作包 | 已有可核实落点 | 尚缺的完整退出门 |
|---|---|---|
| WP00 | 9个合成fixture、来源hash/许可与方法fixture | 其余24类gold及完整业务故障覆盖 |
| WP01 | foundation/execution/documents/quality/revisions/planning严格schema及局部TS | 全49词典/184命令的实际API和生成TS一致性 |
| WP02 | additive表、canonical迁移、稳定集ID、私稿和旧版本保留 | 全量迁移游标/中断恢复、中文Windows路径实测 |
| WP03 | 人工定稿/重开；本轮新增持久方向/筹备CP、忽略/返回/旧卡拒绝 | 全33转移、四模式、完整逐集及规格变化后的筹备重规划 |
| WP04 | 意图重放、事件、GET轮询恢复、版本CAS | 多会话完整事件投影、乱序补缺、跨设备/未发草稿恢复 |
| WP05 | 单请求账本/outbox；本轮原创父预算及有限顺序子调用 | 所有工具/阶段预算、货币硬总额、真实供应商对账与全故障矩阵 |
| WP06 | 18条件规则、必需上下文、版本/hash/预算、6包校验 | 全24阶段路由/知识/长源覆盖、质量级输入冲突解决 |
| WP07 | 本轮M03→人工方向→M07/M08/M09→一次四文档采纳；原有单文档M11/M12 | 新增事实逐项确认、M10、结构化正文、逐集父计划、真实F01/F02质量通过 |
| WP08 | 来源字段及基础合同 | 全文分块摄取、所有范围覆盖/反向审计的真实执行链 |
| WP09 | 改编兼容单文档入口 | M02/M04/M05/M06/M24、四策略逐事件决策及忠实度闭环 |
| WP10 | duration/semantic基础算法、真实独立审稿/硬FAIL阻断 | 算法接入M10/M11产物、道具状态与声画DAG、实测时长/质量样本 |
| WP11 | 设定影响预览、归档/恢复、已定稿重开、依赖失效 | 局部/关联/海外改写全链、SCC逐组diff与跨文档闭包 |
| WP12 | 同一canonical正文、私有稿固定版本、选区基础校验 | 完整富文本/快捷键/undo/redo/自动保存/逐hunk采纳 |
| WP13 | 独立画布式工作台、浮窗/停靠、历史/执行记录 | LibTV全Shell操作、resize/附件/通知/未发草稿、全视口逐项对标 |
| WP14 | Top8/融合/参数表单、影响确认；本轮方向/筹备/费用卡 | 完整ConfirmedSpec/provenance、auto/多集差异时长、全部按钮对标 |
| WP15 | 6个服务端不可变内置适配包与包安全校验 | 五intake/用户技能新建编辑测试fork回滚/发布撤回全生命周期 |
| WP16 | 计划中的合同和基础类型 | 全能/导演工具DAG、分镜、真实画布批量采纳与失败项恢复 |
| WP17 | 基础参考顺序合同；旧画布H3是另一工作线 | Director批准→H3/图音工具→poll/probe→资产完整链 |
| WP18 | 分享合同 | 可撤销公开快照、匿名前后实测、素材授权/CDN边界 |
| WP19 | 插件合同 | 最小scope/PKCE/refresh/revoke及真实连接全链 |
| WP20 | 旧MD导出能力、稳定正文基础 | DOCX/完整作品包、资产manifest、安全导入冲突及Windows真机 |
| WP21 | 定向回归、部分真实浏览器/模型证据 | 482计划用例真实映射、双视口全动作、12×2盲评及完整发布门 |

本轮真实四阶段请求和返回已保存，传输/严格shape通过但内容验收FAIL：M03新增祖孙/退休设定，合成测试脚本选择第一项并泛答澄清后，M07/M08把它们提升为已确认事实；另有眼镜佩戴/手持不连贯。不能将其归因于“只有模型不行”，测试决策和宿主事实确认也有缺口。完整证据与费用见[runtime-validation §0.2](runtime-validation.md#02-本轮新增原创方向与筹备顺序执行)。

下一落地优先序：先把该错误做成冻结负例并拆开“已知事实/新增提案/待确认”及逐项决定；再接M10容量与道具状态→M11→M12→逐集人工定稿/续集。未通过前不再重复买同一失败样例。其后按WP08–WP21推进，不把兼容单文档入口称作完整融合链。

## 1. 交付物、事实与权威边界

| 交付物 | 用途 | 当前性质 |
|---|---|---|
| [五份专项合同总入口](../tv-director-skill-fusion.md) | UI/方法/状态费用/正文语义/验收各有唯一权威 | 设计 |
| [implementation-map.json](implementation-map.json) | 149动作+8能力逐项到组件、命令、接口、schema、方法、规则、fixture、正负测试；24方法/18规则/33转移另表 | 可自动检查的计划索引 |
| [source-inventory.json](source-inventory.json) | 24个short-drama源文件SHA-256、来源副本一致性、15条路由及每文件处置 | 本次实际只读核对结果 |
| [verify-spec.mjs](verify-spec.mjs) | 编号/双向引用/字段/路径/差异/假PASS检查及破坏性输入自测 | 只读规格校验，不调用模型 |
| [源站实测报告](../tv-director-liblib-gap-validation.md) | 实际操作、请求返回、费用与T/F/N边界 | 历史研究事实，不被本轮“收口”改写 |

完整方法融合=源文件冻结→按阶段读取→条件规则选择→已确认输入快照→结构化方法执行→宿主验证→人工决策→派生失效/版本恢复。只把short-drama贴入system prompt、只仿几个按钮、或只有模型成功响应，都不满足。

我们不拥有源站私有后端/隐藏提示词；这里是依据可见交互、请求和结果独立构建的方法与代码合同。观察不到的分支已在第7节作出明确产品决定和发布门，不能再留给实现者猜，也不能谎称已实测原站内部。

## 2. 当前代码到目标代码：保留什么，替换什么

本次核验基线为e7b1fbce；工作区已有未提交首切片，未覆盖。

| 现有落点 | 已存在事实 | 改造动作与不允许做的事 |
|---|---|---|
| src/novelvideo/director/models.py | 原创/改编Preset、正文PUT、整段Change、Generate/Finalize模型 | 保留v1请求解析；新schemas分模块，v2用稳定episodeId、AST、hash、范围审批；不能让客户端quality_acknowledged直接制造新合同PASS |
| src/novelvideo/director/store.py | SQLite作品、Markdown文档版本、changes、runs、events、episode_confirmations | additive迁移；先读旧表生成migration map再写新表；旧正文完整保留；不能清库、把旧确认伪造成有报告的Finalization |
| src/novelvideo/director/writing.py | 路由解析、单轮编译与真实模型调用 | 供应商适配收敛到ports；编译器只读冻结snapshot；所有调用从预算outbox派发，不能前端直接调用或绕账本补一次 |
| src/novelvideo/api/routes/director.py | v1作品/正文/changes/quality/events/generate接口 | 保持旧行为可读取；新增v2薄路由，只做鉴权/schema→用例→投影；不把工作流放进route |
| frontend/src/api/director.ts | v1请求封装 | 保留legacy调用，新增生成的v2类型及命令client；请求失败保留draft和结构化DomainError |
| frontend/src/features/director/DirectorStudio.tsx | 初版工作台 | 逐区替换为Shell、Composer、DocumentNode、Editor、Question/Approval、Skill/Media组件；不把所有状态继续堆同一个组件 |
| frontend/src/features/director/DirectorPresetDialog.tsx | 初版预设 | 统一compilePreset；三层draft和SpecChangeSet；完整Top8、融合题材、卡片、问卷与取消恢复 |
| tests/test_tv_director.py | 首切片测试 | 原测试保留作v1回归；不能据它通过宣布v2状态/事务/全UI已通过 |

迁移只动导演域数据，不改旧story模块。实际新增路径须在实施任务中逐批认领和preflight；本文件和机器表是设计位置，不是对共享热点文件的写许可。

## 3. 数据、命令与接口的可编码约定

### 3.1 边界与字段来源

v2根路径为/projects/{project}/director/v2；机器表transports是精确HTTP模板，commands是184个**语义命令**到25个运输入口的映射（含两个本地view/draft入口，并非184个HTTP路由）。同一endpoint用payload.type判别联合；不接受任意字符串执行内部函数。

请求必须有CommandEnvelope：schemaVersion、commandId、clientRequestId、sessionId、workId（适用时）、expected及payload；actor与project权限来自服务器，不信任客户端自报。path project必须与scope一致。expected中业务必需workRevision/checkpointRevision/documentVersions/capabilityVersion缺失就422，不能当“不检查”。GET用query schema+读取权限，不创建run；本地布局动作没有伪POST。

machine schemas.shape是49份输入输出**字段词典**，不是已生成OpenAPI。每个command.requiredFields列必填，validationRefs列该按钮前提/结果/失败约束。P0把词典落实成Pydantic判别联合、输出schema和TS，额外字段拒绝；不能直接将所有optional字段塞进一个万能dict。相同type但不同payload重用幂等键返回409；不按prompt内容全局去重用户的新意图。

### 3.2 核心语义类型展开表

| 类型 | 必需字段/约束 |
|---|---|
| Mode / SpecDraft / ConfirmedSpec | mode四选；genres主/融合互斥；audienceIds最多2；characterSetup/era/highlights含ids/customText/provenance；narrativeTone与visualStyle分开；structureId八枚举；episodeCountDraft可auto，totalEpisodes确认后为用户指定正整数，按分页/预算处理大规模、不设永久100上限；defaultDurationSeconds>0、episodeDurations按稳定ID；endingType/outputLanguage/market；lockedFacts；adaptation策略/保真/允许新增；revision |
| VersionRef / VersionMap | {kind,id,version,hash}；版本整数>=1，hash为SHA-256；VersionMap按稳定对象ID，全部基线一起CAS，不能只检查当前打开文档 |
| ReferenceEntry | {refId,kind,nodeId?,assetId?,assetVersion?,textVersion?,displayIndex,providerIndex,role,sourceHash}；文本独立序列，媒体按统一manifest顺序；providerIndex由纯编译器生成，客户端不能指定串位值 |
| ModelBinding / ModelCapability | provider、requestedModel、actualRoute、capabilityVersion、参数枚举/范围/可空性、成本信息与可用原因；运行路由不一致拒绝，视频白名单仅H3；音/图不可用明确unsupported |
| AST / SelectionAnchor | versioned block tree，稳定blockId/sceneId/beatId，text/marks/list/table；selection={documentId,version,fromBlockId,toBlockId,fromUTF16,toUTF16,selectedTextHash}；范围、代理对、列表结构验证；不是用全文replace替代选区 |
| SourceVersion / MediaSpan | 不变源hash、extractorVersion、页/章/字符owned ranges、chunkManifest、read/audit状态；MediaSpan含assetVersion、start/end秒与分析证据；OCR缺失/无法读取显式失败 |
| WorkflowCursor / StageRunStatus | 工作流§9分开三种状态域；cursor承载phase/stage/returnTo/resumeToken/CP/revision；StageRun.status不当Work.state |
| Money / BudgetPolicy / BudgetLimits | currency+整数最小单位或定点数；未知=null；hardTotal、perOperation、maxAttempts、maxTokens/maxMediaSeconds、expiry；提醒阈值不是批准 |
| ConsentScope / CostEntry | 作用域、阶段、集ID、模型/工具、上限、有效期、unknownCostConsent、hash；operationId/providerTaskId/estimate/reserved/actual/状态；不把token估价当实际扣款 |
| Answer / HumanAttestation | questionId/type/optionIds/freeText；操作者、显式决定、当前版本和时间由宿主绑定；空必填不能提交；“忽略”无默认答案 |
| ImpactPlan / ChangeGroup | 目标版本、依赖边、受影响集/资产/报告/定稿、成本、允许范围；强依赖SCC成组，闭包可采纳；不存在合法部分解就拒绝，而非半提交 |
| ReviewReport / Check | documentVersion/semanticHash/inputSnapshotHash/具体证据范围/检查ID/verdict；单项UNKNOWN与汇总UNAVAILABLE区分，硬失败优先；语言高分不抵消事实错误 |
| H3Request / MediaProbe | 请求合同以已有H3 capability+映射为准；generationMode、模式适用字段、时长/比例/分辨率/音频开关、prompt、manifest及供应商扩展均按能力逐字段验证；probe实际durationSeconds,width,height,hasAudio,probeVersion,hash |
| OrderedNodeResult / ItemFailure | nodeId,inputIndex,baseRevision,status,candidateId?,reason?,runId?,costEntryId?；成功、missing、forbidden、stale、failed、cancelled分别计数，不压缩掉缺失槽位 |
| SkillMetadata / FileManifest | name/description/bizType/iconAssetVersion；每文件relativePath/hash/size/mediaType；禁绝对路径/穿越/符号链接/任意执行；权限白名单不能由包自行扩展 |
| SkillRunReceipt / Publication | receipt见工作流§9；publicationId/privateSkillId/revisionId/snapshotHash/status=private/submitted/approved/rejected/withdrawn；未知审核状态保持pending，绝不自动approved |
| PublicSnapshot / ConnectionSummary | 分享字段白名单及版本/资产公开授权/有效期/grantVersion；连接只有scope、主体摘要、expiresAt/status，不回传token/secret |
| VersionManifest / Package | schemaVersion、appVersion、work/spec/DV/Skill/模型能力版本、相对资产path/hash/size、缺失清单、locale；default不含凭据或原始调用日志；导入先完整校验再事务写入 |
| FieldError / DomainError | code/path/messageKey/args、retryable/recoveryAction、affectedIds、sideEffects、costState；前端三语展示，日志不存凭据 |
| Event / Page / Projection | seq/eventId/type/schemaVersion/时间/作用域/因果command/run/toolCallId；分页cursor不等于版本；投影标snapshotRevision与lastSeq；未知事件保留不误推进 |

narrativeTone须从用户输入/问卷确认并记provenance，不能用visualStyle代填。规格变更的episodeIds列表若为重排就是**完整有序集合**，缺失/重复ID为422；删除/新增必须同时提供影响计划及接收关键事件的新归属。runtime schema从本表及五份合同展开；不能把上面的JSON/AST占位类型无验证地穿透到存储/供应商。

### 3.3 关键命令严格校验与真实副作用

| 命令 | 额外守卫/事务边界 |
|---|---|
| message.send | 草稿含至少一项可执行输入；所有上传ready；引用仍授权且版本一致；mode/preset/model capability编译成功；同事务写message+snapshot+初始run；不直接调用模型 |
| question.answer / skip | CP仍open、toolCallId/questionVersion匹配、答案满足本题；answer写一次，skip记录skipped+WAIT_INPUT；旧ID409；CP决定与下一阶段outbox同事务 |
| cost.quote / approval.grant | quote必须恰有stagePlanHash或requestHash；scope覆盖即将执行阶段，货币一致、过期拒绝；一次批准不能包含未明示模型/秒数/次数 |
| document.saveDraft / flush | 本地revision与baseVersion检查；保存草稿不定稿；flush失败不把失效selection送模型；全文粘贴不覆盖其他文档 |
| changeset.commit / document.commitManual | collectClosure→全基线读取→语义校验→事务再次CAS→DV/派生stale/Finalization失效/Event一起提交；验证失败全回滚；不能先写第一文档再修第二文档 |
| episode.finalize / work.next | 当前正式DV、报告hash、硬检查、无待审CS/未知关键事实；确认者显式attestation；下一集必须绑定上集边界和新子Approval；最后一集也走同门 |
| skill.applyDraft / savePrivate | 新建首次apply不要求已有skillId/baseRevision；更新则二者必需且属于同owner；静态验证通过才能写不可变revision；消息卡重新引用revision而非draft key |
| skill.publish / withdraw / deletePrivate | 发布previewHash及公开确认（不能仅凭打开菜单）；withdraw需publicationId+owner；delete需confirmIrreversible=true并撤关联grant；网络/补偿未完成不得显示全部已回收 |
| media.plan / submit | plan只产预览不派发；submit需要approvalId与完全相同requestHash；每种模式禁用字段从请求中明确排除或报错；先持久化operation，已有taskId只能poll |
| canvas.adoptBatch | candidate归属当前输入snapshot，baseRevisions全检查；不可用槽不参与写入但仍展示；新建node分配新ID；没有文本创建工具就unsupported |
| share.create / plugin.connect | 先预览范围后显式public/scope确认；共享素材原URL不可直接公开；OAuth仅提供授权URL并校验callback；付费工具仍需独立费用授权 |
| import.commit / run.retryFailed | import绑定预览hash+packagehash+冲突映射；失败回滚；retryFailed仅失败项、排除unknown/已成功、新operation及合法授权；不能把重试当原批准无限续杯 |

机器表的字段必填必须遵从这些互斥规则；例如发布增加previewHash/confirmPublic，首次apply与更新使用不同variant。P0字段测试包括缺失、null、空串、auto、非法enum、重复、旧版、重排、模式不适用值以及未知字段；字段词典与实际OpenAPI不一致即阻断，不让UI自行猜默认值。

### 3.4 示例：两集续写不是重复Send

1. message.send冻结2×30秒规格、模型、参考版本，返回runId+eventSeq；方向后台执行完成生成方向CP。
2. 方向确认消除auto/未知字段；生成总纲/人物/场景/道具/目录的候选，全部采纳与“继续写”是不同意图，可以组合为明确按钮。
3. 第一集M10→M11→M12；预算内最多一次内容修订；失败保留稿并列阻断。没有额外正常episode-plan确认卡。
4. 人工确认第一集DV与报告，Finalization写边界快照，进入WAIT_NEXT；关闭浮窗不丢此状态。
5. work.next绑定第一集定稿/语义hash及第二集episodeId；新子授权，已完成方向/总纲不重跑。
6. 第二集同样审稿与人工确认，只有全部必交付集当前定稿有效才Work.completed。
7. 之后用户改画风/集数，M13给影响预览；接受新CS使受影响报告/定稿stale、Work.needs_review；不能把completed保留下来掩盖未经重审。

### 3.5 示例：用户局部改稿与失败恢复

手动改稿→保存Draft→commitManual生成新DV→语义派生失效→重建来源/人物状态/声画估时→评审。AI选区改稿先flush，再冻结UTF16/hash；M14只能返回目标范围CS，范围外改变立即拒绝。关联改名经M15列强依赖组，拒绝一个必要hunk就不能提交半组。409保留用户Draft并给三方diff，禁止自动采用“我的覆盖最新”。

已受理H3任务断网：恢复run→读providerTaskId→查询→入库；无第二次create。创建回包丢失且无法查询：UNKNOWN+保留费用预留+人工核对入口，不能通过刷新解决。已有视频下载失败只重试入库。所有分支有operation/event/receipt，不凭聊天“完成”显示成功。

## 4. 分批实施：精确代码任务与退出条件

下面都是待新增/改造路径，D=src/novelvideo/director，F=frontend/src/features/director，T=tests/director。相对路径展开后认领，不能用缩写目录一把锁住整个项目。每批先写反例，后实现；失败就停在本批，不花钱重复跑模型。

| 工作包 | 前置与代码位置 | 实现逻辑 | 完成本包必须留下 |
|---|---|---|---|
| WP00 / P0 来源与gold | D/methods/provenance.json；tests/fixtures/director/cases/f01.json…f33.json | 用合成文本/AST/响应故障建立正负输入、gold事实、预期事件/费用；24源文件hash和许可核验；知识空库显式empty | 33类可执行fixture，来源文件/读取路由校验，fixture校验测试；不是仅有描述表 |
| WP01 / P0 schema与参数 | D/schemas/{commands,documents,skills,events,media}.py；F/api/types.generated.ts；tests/contract/director/test_schemas.py | 展开49词典和184命令variants；公共envelope/错误；additionalProperties拒绝；UI值映射纯函数 | Pydantic/JSONSchema/OpenAPI/TS一致；缺字段/null/enum/版本负例；参数表无漏字段 |
| WP02 / P1 持久化迁移 | D/repository.py、D/migrations/v2.py；T/test_migrations.py | additive新表、稳定IDs、旧Markdown导入AST、legacy_unverified；完整备份校验、迁移游标与幂等 | 旧作品/版本/源文不丢；中断重试、缺资产、中文Windows路径通过；不伪迁移评审/账本 |
| WP03 / P1 状态机 | D/state_machine.py、workflow.py、checkpoints.py、finalization.py；T/test_state_machine.py | 33转移纯函数、权限/版本守卫、CP resumeToken、人工定稿、完成后重开 | 33合法+33拒绝；末集/忽略/旧卡/unknown/取消/恢复全部有断言 |
| WP04 / P1 事件与会话 | D/sessions.py、events.py、runs.py；F/state/event-projector.ts；T/test_replay.py | durable events+作用域seq；先写再推；重连补缺、重复/乱序/迟到、双设备CAS | worker/浏览器重启不重复Send；过期结果不覆盖DV；保留本地draft |
| WP05 / P1 预算与outbox | D/budget.py、dispatch.py、outbox.py；T/test_budget.py、test_dispatch_faults.py | 原子reserve+operation+outbox；逐子任务授权；实际模型路由/hash；未知接单保留预留 | F19/F20/F30全断点注入，0未授权调用；账本不超支；本地0费用可证明 |
| WP06 / P2 上下文与规则 | D/context.py、rules/resolver.py、methods/loader.py；T/test_context.py、test_rule_resolver.py | M22/M23；锁定事实/当前稿优先；按阶段引用、最多3条知识；工具结果无指令权；过长显式裁剪非静默丢事实 | 18规则触发/禁用/冲突；0库静态回退；错hash/越权包调用前拒绝 |
| WP07 / P2 原创闭环 | D/methods/original_chain.py及M03/M07–M12包；T/methods/对应测试 | 方向→筹备→目录→容量计划→正文→review；普通确认门不增多；model输出仅候选 | F01/F02可走完到人工定稿；每阶段输入输出和成本回执；实际模型测试留到WP21受控预算 |
| WP08 / P3 全文摄取 | D/sources.py、source_index.py；T/test_sources.py | 文件格式白名单、提取覆盖、chunk owned range、尾块、别名/同名；source不可变与来源span验证 | F04/F06：缺一块禁止骨架；不把前20k字符当全稿；来源命令不执行 |
| WP09 / P3 改编闭环 | M02/M04/M05/M06/M24各包+用例；T/test_adaptation.py | 独立源审计→因果骨架→四策略逐事件决策→方向→逐集；strict chronology按最终AST审核 | F03/F05/F07/F08/F25；四策略同源差异可解释，关键删改须批准 |
| WP10 / P4 声画和质量 | D/duration.py、semantic_validator.py、review.py；T/test_duration.py、test_review.py | beat DAG/资源互斥/动作下界；硬事实与软评分分开；review绑定hash，格式修复/内容修订限次 | F15–F18；8/14秒与11>10固定断言；UNKNOWN不PASS；真实试读才productionReady |
| WP11 / P4 修订与失效 | D/revisions.py、semantic_graph.py、episode_order.py；T/test_revisions.py | 本地/关联/海外；影响闭包SCC、全CAS事务、修改Spec/集顺序、派生失效 | F10–F14/F21；多文档半提交0；范围外变化0；已定稿重审可恢复 |
| WP12 / P5 编辑器/文档节点 | F/components/ScriptDocumentNode.tsx、ScreenplayEditor.tsx、DiffReview.tsx；F/state/document-store.ts | 稳定block/anchor、五目录、选区、快捷键、undo/redo、diff逐组、冲突、自动保存 | E01–E32、X05 UI正负；同DV投影一致；中文/emoji/表格往返 |
| WP13 / P5 Shell/Composer | F/components/DirectorShell.tsx、Composer.tsx、SessionHeader.tsx及matrix A组路径 | 画布动作条、右浮窗/停靠/resize、会话历史/输入附件引用、进度、通知、恢复 | A01–A26；双桌面和375宽可达；关闭不cancel、IME不Send、草稿恢复 |
| WP14 / P5 预设/决策 | F/preset/compile-preset.ts及O/D/Q/S/X表组件 | Top8、两题材圆、六卡、8结构、正整数/auto集数、风格/时长/语言、问卷/费用、明确最终参数预览；容量不足明确分批、不截断意图 | 所有字段UI→Spec→snapshot一致；取消回滚；旧CP服务器拒绝；三语键与DESIGN同步 |
| WP15 / P6 Skill全生命周期 | D/skills/{catalog,lifecycle,evaluator,runtime}.py、M18/M19包；F/components/Skill*.tsx | 五intake、沙箱导入、不可变revision、真正test receipt、fork/rollback、私有/公开分离 | K/R创建相关/X10、F09/F22/F27/F32；删除/归档/撤回不混；每入口真实范围可见 |
| WP16 / P6 全能与导演 | D/canvas.py、planner.py、M16/M17包；F/components/{OmniTaskPlan,ShotPlanReview,BatchResultReview}.tsx | 受限CV→DAG工具计划→审批→候选；输入顺序与Missing槽；采纳才画布写入 | C01–C03/R01–R18/X09/F26；真删ID、乱序完成、失败项恢复；无工具不假完成 |
| WP17 / P7 H3与媒体 | D/media.py、capabilities.py；ports内实际媒体适配；F/components/MediaTaskPanel.tsx | capability纯编译→预览hash→授权→唯一次派发→poll→probe→资产；只H3视频 | F23每种媒体至少3项、重排删换；F29/F30；文本独立编号、请求/实测差异分栏 |
| WP18 / P7 分享/公开 | D/shares.py、skills/publications.py；F/components/ShareDialog.tsx | snapshot白名单/公开授权、有效期、revoke、CDN失效、private delete联动 | F31/F32真实匿名前后访问；不包含未选原稿/密钥；旧下载无法回收提示 |
| WP19 / P7 Plugin生态 | D/plugins.py及ports插件适配；F/components/PluginDialog.tsx | 最小scope/PKCE/state、服务端凭据、refresh单飞、断开/revoke补偿、每调用再鉴权 | F33；自然过期可用假时钟测逻辑+真实连接测协议；无CLI给精确缺项 |
| WP20 / P7 迁移导出 | D/packages.py、exporters.py；F/components/ExportDialog.tsx；T/test_packages.py | MD/DOCX/包、部分集、frozen manifest、资源相对路径、安全解包与冲突预览 | F24；Windows实际恢复及无供应商调用的参数预览；凭据手工重绑，不默认随包 |
| WP21 / P8 对标验收 | frontend/src/__tests__/director-ui-contracts.test.tsx；tests/contract/director/；tests/e2e/director/ | 矩阵逐项用例+双视口截图+故障+三语+真实小样；12类×2配对质量盲评 | 所有完整目标门通过、0严重缺陷、差异清单公开；没有证据不能切status=pass |

P2中M10/M12先实现必要容量/硬质量门，不等P4才防错；P4深化图谱、时长和关联改写。各批依赖WP01/02/03/05满足后才能真实模型调用，不能先接完整UI再补账本。业务逻辑在services/director/ports，路由与组件只适配。现有canvas共享热点另过冲突审计，不为“像源站”覆盖别的工作线。

## 5. 迁移与回退操作合同

1. v1 API读取保持；新v2保存独立schemaVersion。上线先默认新作品用v2，旧作品显式迁移，不能打开即后台付费重生成。
2. 事务前生成一致性备份与manifest hash，记录oldWorkId/doc_key/ordinal→新workId/documentId/episodeId映射；保留源集号，不能把episode-002解释成源EP02。
3. 旧Markdown逐文档解析，解析无法无损往返时保留raw块+legacy_unverified；人工修复前不伪造语义图。旧quality/confirmation仅作历史备注，不补虚拟费用、审批或通过报告。
4. 新表最低含spec_revisions、document_asts、semantic_snapshots、source_spans/events、checkpoints/questions、approvals/cost_entries/operations/outbox、skill_revisions/publications/tests、share_grants及导入迁移游标；关键唯一键为(scope,commandId)、(runId,seq)、(operationId,dispatchKey)、(documentId,version)。
5. migration_id+source_hash幂等；中断从最后提交的文档继续；每文档验证hash和引用完整性，全work切换指针最后进行。部分失败不把半迁移作品当completed。
6. 回退关闭v2新写、保留新数据和新版本备份，恢复旧只读路由及旧索引；已有v2写入不能倒灌旧schema或删除新表。备份恢复必须先演练；禁止用git reset/清库充当数据回滚。
7. Windows导入验证大小/hash、拒绝..、绝对盘符、保留设备名/符号链接、路径大小写碰撞；事务创建ID映射。缺资产列明，不假称可直接生成。重绑模型配置后先dry-run预览，再按授权真实调用。

## 6. 来源与责任：不是“技能或模型二选一”

| 层 | 负责 | 不得负责 |
|---|---|---|
| short-drama方法 | 事件/因果/人物/节奏/逐集闭环/条件化风格/审核/海外/导出方法 | 事务、费用、权限、自动定稿 |
| 反推的LibTV交互合同 | 用户如何设置、何时问、如何展示产物/引用/修订/续写 | 声称拿到了私有源Skill原文 |
| 确定性宿主 | 来源span、版本、schema、参数、规则、权限、费用、顺序、状态、恢复 | 把不可确定文学质量硬算成客观满分 |
| 模型 | 在冻结约束内提出方向、事件候选、正文和修改候选 | 自评代替质量门、改用户锁定事实、承诺未调用工具成功 |
| 人工验收 | 方向/实质改动、逐集定稿、盲评、试读、最终成片 | 以“感觉还行”覆盖明确事实/费用错误 |

定位每次返工：先核对源版本/读取覆盖→约束是否编入snapshot→阶段是否执行→输出是否违反schema/事实→宿主是否漏拦→最后才判断模型能力/采样。修复必须加入最小fixture，同一fixture回归通过才换真实模型重试。模型对比V3.2/V4-Flash只换modelBinding，输入/方法/规则固定，记录实际route和所有失败费用。

原包的13题材、商业比例、反派模板、开场与钩子建议按条件加载；LibTV的UI选项来自已取证配置而不是用原包13题材直接替换。规则冲突不能默改已确认作品，先SpecChangeSet。原包.drama-state.json与文件存在性只提供迁移线索，运行态由CP+有效Finalization决定。

## 7. 所有源站未知/失败项的固定处理决定

下表U不是待办占位，而是已决定的实现方式。sourceParity仍not_claimed；发布门是实际软件必须取得的证据，不能因为文档已写就视为完成。

| ID / 来源 | 明确决定 | 实施归属 / 验收门 |
|---|---|---|
| U01 / I：私有Skill/system prompt/隐藏知识库不可见 | 不声称恢复源站原文；独立方法包及行为/质量对标 | P2 skill/contracts：24份配对质量与包provenance；没有内部原文仍可发布独立实现，不能宣称内部完全相同 |
| U02 / N01：长篇泛化/实际60秒容量未证实 | 完整span审计+最终稿关键事实+顺序/声画下界；未知不PASS | P3 source/quality：长稿gold和B09/B12试读；未通过阻断长篇质量等价 |
| U03 / N02,N03：源站强依赖可拆/改规格仍completed/改集数拒绝 | 依赖闭包CAS原子提交；Spec变化失效重审；本方允许明确影响下增删集 | P4 revision/semantic：联合文档事务与已定稿修改用例；作为明示改进，不复制缺陷 |
| U04 / N06：极窄屏局部可达，不是全站移动和草稿恢复全测 | 320px可达；草稿与布局独立持久化；完整双桌面基线优先 | P5 frontend：双视口截图+320/375交互/IME/未发草稿刷新；移动只称兼容增强 |
| U05 / N07：旧问卷服务器重放未实测 | checkpointVersion+toolCallId CAS；旧ID409、skipped不授权 | P1 workflow：服务端旧卡/重复/乱序测试；不需要绕源站UI攻击接口才能实现 |
| U06 / N08：源站会话分享未见撤销入口 | 我方实现ShareSnapshot白名单和即时撤销，明示已下载不可回收 | P7 sharing：真实匿名访问及缓存撤销；未实现则阻断公开分享发布门 |
| U07 / N04,N08：源站仅整体删除，独立撤回/归档恢复无证据 | withdraw/archive/restore/deletePrivate分离；删除同步撤公开grant | P6 skill/lifecycle：私有保留/匿名失效/删除tombstone事务；有意增强而非假称源站已有 |
| U08 / N04：模型自述Skill版本不等于独立test receipt | 服务器冻结实际revision与methodHash，真实TestRun可审计 | P6 skill/runtime：加载错版调用前拒绝；真实fixture执行receipt；无凭据显示unavailable |
| U09 / N09：自然OAuth过期/原生CLI缺失/全写权限未证实 | 假时钟测expiry、scope与refresh单飞；原生安装和远程写入分别验收 | P7 plugin：本方集成实测最小scope、超期/撤销；原生适配器不可用必须提示不隐藏 |
| U10 / N10：物理第二台设备未由用户完成 | 同服务端CAS；本地包导入重映射/重绑定凭据，两种模式分别验证 | P7 migration：真实Windows安装/导入/生成前预览+双设备冲突记录；未做阻断跨设备可用声明 |
| U11 / N05,N10：创建响应丢失/供应商批量部分失败未实测 | 无已验证幂等时UNKNOWN停止重发；已受理poll；失败项单独新授权 | P1 provider/runtime：离线故障注入先通过，再精确预算真实供应商边界；不承诺远端exactly-once |
| U12 / N05：源站参数漂移/无工具却表述完成 | capability约束+manifest纯编译+实际provider receipt；requested/echo/observed分开 | P7 media：实际H3单链及媒体探测；不支持工具返回unsupported，无占位成功 |
| U13 / N02,N07：单集表单/末集自动完成/首次设置取消续发与安全目标冲突 | 集数由用户指定正整数含1，不设永久100上限；每集人工定稿；首次设置取消保留D且不发；硬预算代替提醒 | P1 workflow/frontend：源站差异公开；负例不得自动定稿/调用；无需按源缺陷实现 |

没有安排“继续无限研究直到拿到隐藏源代码”。U01本质不可由输出唯一识别；U06/U07/U13采取明确安全差异；U02/U04/U05/U08/U09/U10/U11/U12由规定的本方验证关闭。物理Windows、真实自然供应商故障、完整配对质量还没执行，必须继续显示未验收，不能以当前浏览器、多标签或mock冒充。

## 8. 本轮收口验证及实现交接

本轮实际执行并通过：

- node docs/guides/tv-director/verify-spec.mjs：规格编号/引用/字段/路径/差异索引通过；149动作、8能力、24方法、18规则、33转移、33类fixture；184命令、49字段词典、482计划用例。
- node docs/guides/tv-director/verify-spec.mjs --self-test：22组删项/断引用/缺字段/假PASS/假来源/错误版本端点等负向突变全部拒绝。
- node --check docs/guides/tv-director/verify-spec.mjs：语法通过。
- short-drama两份源目录只读SHA-256比较：24/24文件一致，无单侧额外文件，知识规则/案例计数均0。
- git diff --check：通过；gitleaks dir扫描专项合同目录、主方案、历史开发方案，均无泄密命中。
- python3 scripts/agent_guard.py check：OK，18 workstreams / 382 claims。

本轮没有执行pytest、前端build、真实UI、跨设备安装、模型质量或媒体生成，因此没有新增这些业务验证结果。历史实测62条证据断言也不等于本轮482个产品用例通过。

命令只读，不创建模型/供应商任务，不消耗生成积分。482是**计划测试ID**（314动作/能力正负、48方法正负、54规则条件、66转移正负）的总数，不是本轮执行了482个业务测试。33类fixture也仍需WP00变成可执行输入。

下一编码会话的首个可执行任务已固定为WP00+WP01：从F01/F03/F05/F11/F17/F19/F23/F27/F28建立匿名case.json和strict schema测试，先证明反例被拒，再扩展其余fixture。完成后进入WP02–WP05；未到这些安全退出门不得再花积分反复“试试看”。每批同步matrix.status/resultRef及任务台账，真实执行记录在CaseEvidence；共享热点先查diff/claims、acquire/preflight，不能把本计划当跨全部目录的写授权。

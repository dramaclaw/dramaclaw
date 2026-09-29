# short-drama × TV Director：逐 Skill 与规则运行合同

设计 v2.1 / 2026-09-25。配套[主方案](../tv-director-skill-fusion.md)、[状态与费用合同](workflow-contracts.md)、[语义合同](document-semantics.md)。本文件定义24个独立方法包及4个改编子策略，不是LibTV私有Skill原文，也不是已经安装进运行器的技能文件。

## 1. 什么才算融合完成

每个包必须交付 `manifest.json / method.md / schemas/input.json / schemas/output.json / templates/ / fixtures/ / provenance.json`；validators只引用宿主已注册且已测试的确定性函数，不执行用户导入的任意代码。manifest字段齐全、schema可解析、正负例可运行、上下文与规则加载有日志，才能在运行时选择。仅有一段prompt或一个METHOD_VERSION常量不合格。

```ts
type SkillManifest = {
  key: string; version: string; schemaVersion: 2;
  purpose: string; applicable: Predicate[]; excluded: Predicate[];
  inputSchema: string; outputSchema: string;
  requiredReferences: {sourceId: string; relativePath: string; sha256: string}[];
  ruleIds: string[]; allowedTools: string[]; validators: string[];
  costClasses: string[]; checkpointKinds: string[];
  maxSchemaRepairAttempts: number; maxAutomaticRevisionAttempts: number;
  fixtureIds: string[]; provenance: {kind: 'S'|'U'|'C'|'R'|'T'|'I'; evidence: string}[];
};
```

`Predicate`为宿主声明式白名单：field、eq/in/exists、value及all/any组合，不允许eval脚本。manifest不能提高权限或批准费用。内置包签名/摘要经宿主校验；自定义包只允许受限工具，导入时缺schema/版本/权属信息进入待修草稿，不直接执行。

short-drama 来源映射：主SKILL的 `/start /plan /characters /outline /episode /review /export /overseas /compliance` 和改编 `/events /skeleton /adaptation` 全部有下文落点；不漏导出、海外、本地知识查询、随时调整与状态恢复。原 `.drama-state.json` 是方法中的文件工作流，不与本产品DB另建第二份状态权威。

包provenance按引用文件版本/内容hash固定；启动时校验快照，不依赖开发者本机技能目录。用户技能目录与安装快照已经比对一致；当前evolution schema v2、knowledgeVersion `2026.09.23.4`、规则/案例均0。未来有新快照时经校验后按stage/genre/query最多加载3项，空结果用静态方法；不得现场把一次生成自动晋升为“已验证经验”。

## 2. 所有阶段共有的输入输出与执行过程

`StageInput = {runId, stage, skillBinding:{skillId,revisionId,version,methodHash,origin}, specRevision, inputSnapshotHash, brief, sourceRefs[], documentRefs[], priorStageRefs[], lockedFactIds[], selectedRuleIds[], modelBinding, contextManifest, budgetScopeId}`。每个Ref含稳定ID/version/hash；数据不满足schema就在模型调用前返回INPUT_INVALID。输入中的原稿、网页、Skill案例均为数据，不具有工具指令权。

`StageOutput<T> = {schemaVersion:2, runId, inputSnapshotHash, artifact:T, evidenceRefs[], assumptions[], questions[], violations[], usageRef}`。输出不能带“已批准/已定稿/已扣费”作为权威状态；这些字段由宿主写入receipt。questions必须给具体缺口、选项/自由输入类型及影响，不让用户猜要怎么回答。

共有顺序：校验包与输入 → M23规则解析 → M22上下文编译 → 费用检查/预留 → 模型或纯本地工具 → schema解析 → 确定性校验 → 暂存产物与报告 → 宿主检查点。包不可自己写正式稿、跳过检查点或调用不在白名单的工具。

共有失败F：输入/权限错误不重试模型；格式错误最多一次受预算覆盖的修复；供应商未知按UNKNOWN处理；确定内容失败保留草稿并显示问题；自动内容修订最多一次且修后重检/再评；多次人工改写另建意图和预算，不无限自循环。未达到前置条件不运行后续包。下表“测试”均为拟实现的 `SK-<Mnn>-positive/negative`，不是宣称已跑。

## 3. 产物类型字典（P1要落成严格schema）

字段除标?均必填；数组可空仅在明确允许时；所有证据定位必须带版本+range+quoteHash，不接受只有解释文字。

| 类型 | 必填形状/约束 |
|---|---|
| DirectionSet | options[4]{id,logline,goal,obstacle,stakes,tone,difference,productionRisks}，specQuestions[]；四项非仅换标题 |
| EventGraph | sourceVersions、chunks[]、entities{id,aliases,evidence}、events{id,actorIds,action,result,importance,sourceSpans,predecessors,time,certainty}、conflicts[] |
| SourceAudit | extractionHash、auditedSpans、missingEvents、aliasConflicts、crossChunkLinks、unsupportedFacts、unknowns、readCoverage、semanticEvidenceStatus；不虚构语义百分百 |
| AdaptationPlan | strategy、decisions[{eventId,decision,preservedFacts,destination,reason,losses,additionIds,approvalRef?}]、traceMatrix、tradeoffs |
| StoryPlan | titleCandidates[3]、logline、worldRules、structure{id,segments}、conflicts、arcs、setupsPayoffs、ending、timeBudget、assumptions |
| Bible | characters[{id,names,appearance,motive,knowledge,voice,arc}]、relations、locations、props、worldRules；声线/外观是描述不自动生成资产 |
| EpisodeDirectory | entries[{episodeId,orderKey,deliveryLabel,question,actions,result,hook?,eventIds,setupIds,payoffIds,targetDuration}]；数量与规格一致 |
| EpisodePlan | episodeId、priorBoundaryRef、scenePlans[{sceneId,locationId,time,timelineId,goal,obstacle,result,eventIds,beats}]、durationReport、allowedNewFacts；scene ID稳定 |
| ScreenplayDraft | ast、episodeId、planHash、eventRealizations[]、newFactCandidates[]；不能只交统计摘要而不交全文 |
| ReviewReport | version/hash、checks[{id,category,verdict,evidenceRefs,fix,scope}]、softScores、humanRequired、durationStatus；verdict=PASS/FAIL/UNKNOWN |
| ImpactPlan | changedFactIds、rootVersions、affectedDocuments/episodes/assets、dependencyGroups、staleFinalizationIds、options、budgetEstimate |
| PatchSet | baseVersions、hunks{id,blockId,range,beforeHash,afterAST,reason,evidenceRefs,groupId}、dependencies、validationReport；无权引用拒绝 |
| ShotPlan | inputSnapshot、roleSV、shots[{id,sourceRefs,characterRefs,sceneRef,goal,action,camera,sound,duration,providerInputs,warnings}] |
| TaskPlan | intent、DAG[{taskId,toolId,inputs,dependsOn,sideEffect,costClass,outputSchema}]、requiredApprovals、unsupportedCapabilities |
| SkillDraft | purpose、intakeAnswers、manifest、filesHash、methodFiles、fixtureSpecs、requestedPermissions、provenance；未测试为untested |
| SkillTestReport | SV/inputHashes、assertions、outputs、costEntries、qualityScores、humanNotes、passStatus；失败案例不可藏起来 |
| ComplianceReport | market、policySnapshotDate/sourceRefs、findings{severity,evidence,reason,requiredAction}、unverified；不是法律合规担保 |
| ExportManifest | workSpecRevision、documentVersions、includedEpisodes、labels、semanticStatus、review/finalizationRefs、assets{relativePath,hash}、missingAssets、formatVersion |
| ContextManifest | requiredRefs、retrievedSpans、excludedRefs+reasons、tokenEstimate+method、window/outputReserve、summaryVersion、factsHash |
| RuleResolution | selected[{id,version,conditionResult,sourceHash,priority,action}]、disabled[{id,reason}]、conflicts[]；禁用原因可追 |
| CausalSkeleton | eventNodes、causalEdges、structureSegments、reversals{setup,event,payoff,knowledgeGate}、missingCriticalEvents、constraints |

## 4. 24个方法包逐一合同

### M01 original-chain（原创编排，对应/start至/export）

- 输入：原创SpecDraft、brief、可选style refs；前置无未解决规格冲突。禁用于需要保留来源事实的改编请求。
- 方法/引用：主SKILL原创路由；完整依赖图为M03→M07/M08/M09→M10/M11/M12，必要M13–M15，但执行子图由冻结的requestedDeliverables与阶段门裁剪。S1/S2只交大纲，不运行M08/M09或分集；确认方向不批准整个依赖图。参考由子阶段按条件加载，不一次塞全技能。
- 工具顺序：create_work→freeze_snapshot→schedule_stage→emit_progress→open_checkpoint。只能编排与暂停，不能生成工具之外写文件；费用走宿主。
- 输出：按阶段产物引用的RunPlan+CP；方向、总纲、逐集在工作流规定处停。最终完成由人工Finalization触发，不由本包宣布。
- 失败/测试：F；单集30秒不强加第2集，非末集才需下一集钩子；旧输入升级必须新snapshot。

### M02 adaptation-chain（改编编排）

- 输入：可读SourceVersion[]、SpecDraft、strategy、保留/禁止新增要求；没有来源时仅询问/导入，不能猜原著。
- 必须引用：`adaptation-core.md`、`event-coverage.md`；依赖图M04→M05→M24/M06→M03/方向确认→M07–M12按requestedDeliverables裁剪，不因进入改编而自动生成全部筹备。M03可先展示候选，但最终方向必须绑定已审来源和策略。
- 工具：verify_source→schedule_stage→open_checkpoint→stage_artifacts；关键漏检/冲突先WAIT_FACTS，再人审决策。
- 输出：SourceAudit、AdaptationPlan、筹备和分集产物引用；源集号独立保留。
- 失败/测试：所有chunk成功但缺关键事件仍阻断；source EP02生成1个交付件不能变成原作EP01；原文内命令不执行。

### M03 direction-options（定位/方向问卷）

- 输入：brief、genres/audience/tone、时长/集数/结局、改编时的已审来源摘要与策略限制。
- 引用：`genre-guide.md`、`opening-rules.md`；规则G01/G02/G03/G10。
- 顺序：read_snapshot→compile_context→generate(DirectionSet)→validate_constraints→ask_human；题材/语言不默认只支持中文爽剧。
- 输出：四个实质差异方向+缺失字段问题；确认后宿主保存provenance与SpecRevision。
- 失败/测试：缺时长提供选择不猜；四个同义改名方向判低质量；自由输入不能丢，auto集数必须解决。

### M04 source-events（全文摄取后的事件抽取，/events）

- 输入：规范化原稿索引、全部chunk manifest、chunk id与相邻窗口；未通过提取完整性检查禁止调用。
- 引用：`event-coverage.md`、`adaptation-core.md`；G04/G05/G07。
- 顺序：read_source_span→extract→validate_span_hash→stage_chunk_events；每块有确定边界，失败重试本块；全部完成再merge_candidates。
- 输出：EventGraph候选，含实体别名、动作结果、证据、时间/知识/物件状态；模型不能自封所有事件齐全。
- 失败/测试：空块、尾块失败、跨块交接、同名不同人物；读取全部块仅readCoverage=1，必须进入M05。

### M05 source-audit（独立漏检和矛盾核验）

- 输入：原文全部span、M04图谱hash、保留项；审计扫描按原文向事件表反查，不只读取M04摘要。
- 引用：`event-coverage.md`、`adaptation-core.md`，以及语义合同的反向审计算法；G04/G05/G07。
- 顺序：read_source_span→independent_extract_checklist→compare_graph→resolve_alias/cross_chunk_candidates→stage_audit→必要ask_human。
- 输出：SourceAudit及漏事件修正候选；关键新增/冲突经证据校验，再生成新的graph版本，不覆盖来源。
- 失败/测试：抽取器与审计使用同模型也必须不同run/提示与独立原文输入，不能自评分冒充独立证据；关键missing/unknown阻断。

### M06 adapt-decisions（/adaptation，四子策略见下一节）

- 输入：已审EventGraph/CausalSkeleton、目标容量、strategy、锁定事实/台词、允许新增域。
- 引用：`adaptation-core.md`、`event-coverage.md`、`reversal-registry.md`；G04/G06/G07/G08。
- 顺序：read_graph→choose_strategy→每个关键/主要事件写preserve/compress/merge/move/delete/invent_bridge→validate_trace→stage_plan→ask_human。
- 输出：AdaptationPlan；invent_bridge须有新ID与来源=新增，不能假绑定源span。
- 失败/测试：delete critical无批准拒绝；merge丢掉关键结果拒绝；移动后因果不成立返回冲突；四策略对同源产生可解释不同决策。

### M07 story-plan（/plan）

2026-09-26实施补充：M07 2.2.0在保留short-drama三份参考和创作策略的基础上补齐LibTV可观察故事大纲要素；筹备链与单文档重写共用严格schema/技能hash/确定性渲染。字段映射、事实边界、原始回包和真实验收见[故事大纲专项](outline-parity.md)。不得再将`storyPlan`通用JSON展开当成大纲交付，也不将short-drama `/outline`（M09）当作M07。

- 输入：已确认Direction、Spec、改编时M06、容量约束。
- 引用：`opening-rules.md`、`rhythm-curve.md`、`satisfaction-matrix.md`；仅商业付费叙事加载`paywall-design.md`；G01/G03/G06/G08/G10。
- 顺序：plan_structure→plan_arcs/setups→capacity_preview→stage_StoryPlan；结构按所选八种映射，不一律三幕。
- 输出：三剧名备选、世界/矛盾/结构/节奏/结局与伏笔。长短篇按复杂度和上下文容量分层，不设未经证明“20集以上”阈值。
- 失败/测试：1×30秒过量在计划期报风险，不先写1497字正文；单集完结与下集预告互相冲突拒绝。

### M08 character-bible（/characters + 场景/道具筹备）

- 输入：StoryPlan、来源实体/规则、用户已锁角色/外观/语言；输出覆盖角色/关系/场景/道具。
- 引用：`villain-design.md`按反派适用条件，`ai-producibility.md`用于AI制作；G05/G07/G09/G13。
- 顺序：entity_resolution→design_profiles→validate_identity/rules→stage_Bible→render五类节点投影。
- 输出：Bible稳定实体ID；人物关系与知识状态清楚。4层反派仅适合且容量容纳时启用，无反派温情戏不编造Boss。
- 失败/测试：同一角色别名不误拆；两幅画不误合；原稿未说明人物死亡不得补成锁定事实；可疑项形成问卷。

### M09 episode-directory（/outline）

- 输入：StoryPlan、Bible、Spec总集数/时长、事件/反转登记；所有must-keep需映射。
- 引用：`rhythm-curve.md`、`episode-writing.md`；商业适用时`paywall-design.md`；G01/G03/G06/G08/G10。
- 顺序：allocate_events→question/action/result/hook→validate_count/coverage/payoff→stage_EpisodeDirectory。
- 输出：每集闭环与集间承接，末集收束；总纲/资产/目录合并一次WAIT_OUTLINE，不制造六次确认。
- 失败/测试：集数少一/多一、关键事件无归属、伏笔无兑现、末集自动预告均有负例；目录批准前不写正文。

### M10 episode-plan（后台分集容量规划）

- 输入：当前目录项、前集有效边界、Bible/Spec、targetDuration、必保事件、允许新事实。
- 引用：`episode-writing.md`、`rhythm-curve.md`、`ai-producibility.md`；首集另加载`opening-rules.md`，非末集或开放结局适用`hook-design.md`；G06–G13。
- 顺序：plan_beats→bind_entities/events→schedule_parallel_tracks→validate_capacity/continuity→stage_EpisodePlan。
- 输出：逐场可拍goal/obstacle/action/result、beat DAG、估时区间；默认不问人工计划确认。
- 失败/测试：确定超量先缩减允许细节，仍不能容纳则WAIT_CONSTRAINT；不能自行改415秒或增集。

### M11 episode-writing（/episode N/range/next）

- 输入：有效EpisodePlan、冻结来源/总纲/角色、前集边界与用户要求；range拆成顺序子run，不在一个prompt里写整季。
- 引用：`episode-writing.md`、`ai-producibility.md`、`rhythm-curve.md`、`satisfaction-matrix.md`；开场/钩子条件同M10；G03/G05–G13。
- 顺序：read_context→write_ScreenplayDraft→parse_AST→deterministic_checks→M12；不能直接commit或finish。
- 输出：全文草稿+eventRealizations+newFactCandidates，场次主体/动作/对白/声音可解析；字数由代码统计，不信自报。
- 失败/测试：受保护台词逐字检查；不可见心理活动须转成可拍动作或明确旁白；上集结果不能下一集无故重置。

### M12 episode-review（/review N/range/all）

- 输入：当前DV/hash、原始锁定证据、EpisodePlan、确定性检查、前后边界；不是只看写手总结。
- 引用：`episode-writing.md`，AI制作时`ai-producibility.md`；题材适用时追加史实资料由项目提供；G05–G14。
- 顺序：local validators→独立内容评审run→schema验证→merge_ReviewReport→至多一次获批修订→对新版再机检/再评。
- 输出：节奏/爽点适配/台词/格式/连贯性评分及逐条证据、严重度、修法；总分不能覆盖硬错误。
- 失败/测试：非法JSON、toolCallId或hash不匹配均UNAVAILABLE；修后旧报告失效；人工接管条件只按工作流§4。

### M13 revision-impact（随时调整的前置分析）

- 输入：指令、selection或全局范围、当前Spec/AST/图、全部baseVersions；已完成作品同样支持。
- 引用：`event-coverage.md`、`episode-writing.md`；G01/G04/G07/G15。
- 顺序：classify_change→diff_facts→dependency_closure→capacity/cost_preview→stage_ImpactPlan。
- 输出：仅本处/只改未来集/重审已写集三个可行范围及后果；不可行选项禁用附原因。
- 失败/测试：改变夜间规则影响已定稿内容，不能只改风格文案；表面格式变化不能无理由重生成全剧。

### M14 local-revision（选区修改）

- 输入：baseVersion、block IDs、UTF16选区、textHash、指令、允许scope；先flush保存再取选区。
- 引用：`episode-writing.md`、适用题材方法；G05/G07/G15。
- 顺序：read_selection_and_boundary→generate_patch→check_outside_unchanged→semantic_impact→stage_PatchSet。
- 输出：仅范围内差异或“需要扩大范围”的ImpactPlan，后一种不得自写范围外。
- 失败/测试：emoji偏移、过期选区、改名牵涉别处、1629字符中只插2字的历史反例；冲突返回409保留指令。

### M15 linked-revision（全局/关联/海外转换）

- 输入：获批ImpactPlan、SpecChangeSet、全依赖baseVersions、用户选定范围。
- 引用：`event-coverage.md`、`episode-writing.md`、`reversal-registry.md`；海外转换加`genre-guide.md`海外部分；G01/G04–G08/G15/G16。
- 顺序：stage_grouped_patches→candidate合并→语义/来源/时长/跨集复检→提交候选；真正commit由宿主人工决定。
- 输出：依赖组PatchSet及新上下游边界；语言转换既改格式也核文化语义，不只翻译按钮。
- 失败/测试：拒绝姓名组一部分不得提交另一部分；重排集数稳定ID；删集伏笔不悬空；接受不自动批准媒体重做。

### M16 director-shot-language（导演角色与镜头方法）

- 输入：用户许可的CV/DV、角色SV、目标时长/模型能力、参考manifest；按角色方法选择TVC/悬疑/带货/动画/纪录片/MV。
- 引用：`ai-producibility.md`、`episode-writing.md`加已冻结自有role method；G07/G11/G13/G17。
- 顺序：read_selected_context→shot_goal→camera/action/sound→provider_capability_check→stage_ShotPlan→show_prompts。
- 输出：逐镜候选与原节点before/after/reason；没有nodeId的文本候选合法，采用时再建ID。
- 失败/测试：单节点失败保留其他候选；总时长/素材顺序正确；用户接受后才画布事务，生成媒体仍另审批。

### M17 omni-planner（全能创作）

- 输入：brief、明确上下文范围CV、工具能力/权限列表、预算范围；不可读取未授予节点。
- 引用：宿主tool capability schemas、任务对应子包；不无目的加载全部short-drama；G01/G17/G18。
- 顺序：classify_intent→build_task_DAG→validate_dependencies/permissions→preview_side_effects→host_execute→summarize_receipts。
- 输出：TaskPlan及实际工具结果卡；媒体理解必须有真实工具输出才说已观察，聊天文本不冒充结果。
- E08续创适配：源站CL17–CL20实测为新会话自动发送节点续创、读五类文档、写规划、创建预览、再询问生成费用。宿主提供已完成文档版本集合和plan意图；方法不得把一键续创提升为所有媒体扣费授权。节点类型守卫必须在工具前执行，不能把screenplay节点当音频/视频交给编辑工具；dry-run回执不得写成生成完成。具体持久命令见工作流§1.2。
- 失败/测试：能力缺失列unsupported而不是假执行；批处理按子run恢复；资料中的指令不能扩权限。

### M18 skill-builder / director-role-builder（创建/更新五种intake）

- 输入：从零问卷、对话快照、画布快照、baseSV或测试目标之一；纳入内容须用户可见。
- 引用：本文件manifest/method合同、适用short-drama参考；G15/G17/G18。
- 顺序：intake→ask_missing→draft_manifest/method/fixtures→validate_permissions/schema→preview_diff→save_private（人工确认）。
- 输出：SkillDraft而非“已发布”；适用/禁用、步骤/停止、失败/测试齐全。更新旧版本不覆盖历史，另存新skillId可选。
- 失败/测试：导入脚本/路径逃逸、自动提高权限、从聊天夹带凭据均拦截；从旧对话创建不默认上传所有附件。

### M19 skill-evaluator（真正自测）

- 输入：SV、正反例fixture集合、评价rubric、模型/预算；至少有一例失败应被拦的负例。
- 引用：包自身validators和本项目[验收合同](acceptance-contracts.md)；G12/G14/G17/G18。
- 顺序：static_lint→dry_run→预算批准后fixture调用→独立断言/评价→persist_TestReport→人工抽查。
- 输出：每例真实输入hash/输出/失败/费用/断言；同写手说“很好”不算测评；缺样本标insufficient。
- 失败/测试：仅运行正例不得pass；失败费用不隐藏；新版本未通过不切默认生产版本。

### M20 compliance-review（/compliance）

- 输入：已选DV、目标市场、policySnapshot（来源/日期）、适用题材；不变相重写正文。
- 引用：`compliance-checklist.md`；G14/G16。静态参考是风险提示，变化的法规/平台政策发布前需当时权威来源复核。
- 顺序：classify_risks→evidence_findings→human_review_requirements→stage_ComplianceReport。
- 输出：风险位置、依据、优先级、未核验项；不得以模型分数担保可以发行。
- 失败/测试：政策快照缺失标未验证；建议修改走CS，不直接删段；海外不生搬国内类别。

### M21 export-package（/export，纯本地默认）

- 输入：明确选择的episodeIds/DV、格式、是否含资料/素材、导出目录相对映射。
- 引用：主SKILL导出结构；G01/G05/G15/G18；无需模型生成同一份正文。
- 顺序：freeze_manifest→validate_references→render→asset_copy_policy→checksum→deliver。
- 输出：ExportManifest及文件；含草稿/未测内容明确标记，元信息实际时长/已完成集数，不硬写1–3分钟。
- 失败/测试：Windows路径、缺素材、同名ID、未完全部集、隐私清除；不把源EP02导出为错误EP01。

### M22 context-compiler（逐阶段上下文，不是任意摘要）

- 输入：stage/spec、required refs、source graph、prior boundaries、当前问题、模型真实窗口/输出预算。
- 引用：主SKILL上下文连贯与知识路由；G04/G07/G18。
- 顺序：强制事实/当前计划/前集边界优先→相关原文span检索→受控摘要→tokenize→大小检查→ContextManifest。
- 输出：stage prompt的数据部分与manifest；已确认事实/保留对白/身份规则不能因摘要被丢弃。无法容纳时拆阶段或缩检索，不能截断尾部后称全量。
- 失败/测试：缺requiredRef/旧hash失败；长篇尾部事件仍被正确检索；不能把其他项目资料混入；摘要调用也要费用授权。

### M23 rule-resolver（条件规则与evolution）

- 输入：规格、阶段、题材、问题、版本化静态规则及已校验evolution快照。
- 引用：主SKILL知识优先级、`scripts/query-knowledge.mjs`调用合同；G01–G18。
- 顺序：verify_snapshot→按stage/genres/query最多3项→evaluate_conditions→resolve_conflicts→RuleResolution。
- 输出：选中/禁用/冲突记录，空库回静态方法；不得把查询没结果当运行失败。
- 失败/测试：旧schema/hash失败不加载；新用户要求与锁定事实冲突开问卷，不默改；末集禁用续集hook。

### M24 causal-skeleton（/skeleton）

- 输入：经M05审计的EventGraph、所选结构、目标集数/时长、锁定结果。
- 引用：`reversal-registry.md`、`event-coverage.md`、`adaptation-core.md`；G04/G06/G08。
- 顺序：causal_DAG→structure_segments→reverse_registry→check_all_critical_mapped→stage_CausalSkeleton。
- 输出：所有关键事件位置、前置与兑现，不因原方法写三幕而覆盖用户八类结构。
- 失败/测试：先揭底后铺垫、无因果桥、关键事件孤点、环形叙事被误判时序倒流；显式时线可以非线性，因果仍要解释。

## 5. 四种改编策略不能只有四个按钮

| 策略 | 执行算法 | 必须输出与验证 | 停止条件 |
|---|---|---|---|
| M06-A1 condense | 逐事件按主线贡献/重复信息/容量排序；先压缩表现，再合并重复事件，再提议删非关键项 | 每项原字数/动作→目标beat、保留的因果/事实、丢失信息清单；关键事件召回对gold=1 | 仍超量就给改规格选择，不隐删关键 |
| M06-A2 expand | 找动机/动作/结果之间缺桥位置；在允许世界/角色范围内增加可拍行动 | 新eventId、来源=新增、必要性、与原事件前后连接、时长代价；受保护台词不变 | 需要新人物/新结局超授权就问，不自作主张 |
| M06-A3 conflict | 对每场目标/阻力/代价/选择/后果评分；加强可见对抗和角色行动 | before/after冲突变化、角色动机一致证据、因果代价；不能靠人物降智/改硬事实 | 改动核心性格或事实需批准 |
| M06-A4 hook | 登记信息知晓时间与setup/payoff，调整开场与集尾揭示顺序 | hookId、类型、提出问题、何集何处兑现、禁止提前透露信息；本集仍闭环 | 末集收束冲突、假悬念/无兑现、倒置因果必须修 |

同一来源同一目标预算跑四策略，比较决策trace不是只比较文风；用户同时要求“忠实、不能删对白、必须30秒”若无可行解，诚实返回冲突，不靠快剪或输出虚假秒数蒙混。

## 6. 18条条件规则与冲突优先级

优先级：P0权限/费用/数据完整性不可突破；P1已明确用户约束+锁定事实+获批Spec一致性（内部冲突先问）；P2经审核且匹配的经验；P3案例；P4静态建议。静态方法可以产生P1硬校验，但必须由用户/来源约束支撑，不因“短剧口诀”自动变硬。

每条规则都落 `{id,version,sourceRef,condition,priority,action,validator,severity,onConflict}`；下表是首批明确定义，规则ID只是本产品命名。

| ID | 来源/生效条件 | 动作与检查 | 冲突处理 |
|---|---|---|---|
| G01 | 主SKILL；所有阶段 | 按获批集数/时长/结构/语言编译，显示provenance；P1 | 新指令冲突先SpecChangeSet；不默认50–100集 |
| G02 | genre-guide；定位/海外 | 加载适用题材及文化背景；P4 | 自定义题材不强套枚举叙事 |
| G03 | opening/rhythm/satisfaction；计划/正文 | 缩放节奏与开场、分布爽点；P4 | 用户温情/纪录/极短要求优先，不强制固定占比 |
| G04 | event-coverage；改编/关联修改 | read coverage与独立语义审计、关键事件trace；P1 | 缺事件停，不能用summary替全文 |
| G05 | adaptation-core/episode-writing；有来源/编号/台词锁 | source/delivery/ordinal独立、保留台词/事实可验证；P1 | 关键删改需针对性批准 |
| G06 | episode-writing/reversal；规划/目录/正文 | 目标→行动→结果，反转有setup和兑现；P1语义检查+人工证据 | 悬念不能替代本集结果 |
| G07 | episode-writing；全部叙事 | 人物知识、道具、空间、时线/世界规则连续；P1 | 不确定标UNKNOWN，非线性按显式timelineId核验 |
| G08 | hook/reversal；非末集或明确开放结局 | hook可兑现、当集闭环；P4，锁定伏笔为P1 | 末集按endingType收束，不强加新问题/预告 |
| G09 | villain-design；对抗型且篇幅可容纳 | 分层动机/反派功能；P4 | 无反派题材禁用，角色数量约束优先 |
| G10 | paywall-design；monetization.enabled | 卡点比例仅作可配置目标；P4 | 非商业/短片禁用，不把用户内容变付费策略 |
| G11 | episode-writing/ai-producibility；有目标时长 | 声画DAG估时、资源约束、当前稿统计；P1容量 | 未试读标未测；串并行不混，快剪不降低物理下界 |
| G12 | episode-writing review；评审 | 独立问题证据与软评分分离；P1 | 硬FAIL覆盖高分，UNAVAILABLE不是PASS |
| G13 | ai-producibility；AI制作 | 主体/动作/镜头与素材可绑定、复杂动作拆解；P4与能力硬限制P0 | 不支持能力不能只改提示词冒充可执行 |
| G14 | compliance/episode-writing；指定市场或历史题材 | 史实/设定/艺术加工与政策风险分层；P1锁定事实/P4建议 | 无可靠依据不捏造史实或合规保证 |
| G15 | 主SKILL随时调整+I事务设计；任意改写 | 影响闭包/依赖组/版本/失效重审；P0 | 超出选区先审批，不能为方便全局覆盖 |
| G16 | 主SKILL overseas；语言/市场改变 | 格式、语用、文化适配作为linked revision；P1规格 | 不只换输出语言，不默改已定稿所有集 |
| G17 | LibTV审批观察+I权限；工具/媒体/自测 | 宿主白名单与预算、可见副作用、真实receipt；P0 | Skill无权自批；发布/分享另授权 |
| G18 | 主SKILL知识查询+I隔离；上下文/包加载 | stage定向加载、hash校验、最多3项知识、来源版本隔离；P0 | 空库静态回退；未知结果不晋升永久规则 |

## 7. 能直接变成测试的输入输出示例

```json
{"caseId":"short-final","stage":"episode-directory","spec":{"totalEpisodes":1,"durationSeconds":30,"endingType":"closed"},"expected":{"entries":1,"nextEpisodePreview":null,"criticalResultRequired":true},"forbidden":["自动扩到20集","为了hook再造第二集"]}
```

```json
{"caseId":"read-all-missing-event","stage":"source-audit","chunks":{"total":3,"succeeded":3},"candidateEventIds":["EVT-a","EVT-c"],"goldCriticalIds":["EVT-a","EVT-b","EVT-c"],"expected":{"readCoverage":1,"missingEventIds":["EVT-b"],"canBuildSkeleton":false}}
```

```json
{"caseId":"source-label","stage":"episode-writing","identity":{"episodeId":"ep-stable-a","sourceEpisodeLabel":"EP02","deliveryLabel":"第二集","workflowOrdinal":1},"expected":{"documentIdentity":"ep-stable-a","visibleTitleContains":"第二集"},"forbidden":["把原作改成第一集"]}
```

```json
{"caseId":"review-skipped","stage":"episode-review","documentVersion":4,"modelResult":"not-valid-json","expected":{"reviewStatus":"UNAVAILABLE","automaticFinalize":false,"draftPreserved":true,"humanReviewOffered":true}}
```

```json
{"caseId":"final-rule-conflict","stage":"rule-resolver","spec":{"isFinalEpisode":true,"endingType":"closed","monetization":{"enabled":false}},"expectedDisabledRules":["G08-continuation-hook","G10-paywall"],"expectedEnabledChecks":["G06-episode-result","G07-continuity","G11-duration"]}
```

```json
{"caseId":"unsafe-import","stage":"skill-builder","requestedTools":["read_project_document","execute_shell"],"hostAllowedTools":["read_project_document"],"expected":{"executable":false,"error":"UNSUPPORTED_TOOL_PERMISSION","privateDraftPreserved":true}}
```

示例中的G08-continuation-hook等是规则动作名称，实施时以ruleId+actionId两个字段存储；不是另加未定义规则。JSON里的gold仅测试夹具有，真实未知原稿不能声称掌握完整gold事实。

## 8. 上下文、模型和版本的源头控制

M22按模型能力声明的窗口计算输入预算，预留系统/工具描述和输出最大token；例如产品可配置60%输入软阈值，但不是LibTV事实，不可硬编码成所有模型标准。优先锁定事实→当前计划→上集边界→相关原文→其他历史摘要；超窗时分块/层级汇总并保留span索引，必需事实集合放不下就停止，不截掉。

用户配置V3.2或V4-Flash都必须经网关能力验证。run记录requested/actual模型、采样配置、上下文token方法、prompt/response hash、skill/rules/source版本与费用。供应商不暴露实际底层模型时标unknown，不能用请求字段推定；固定路由不一致调用前拒绝。模型A/B只在同一输入/包/规则/验证器下比较，区分传输失败、schema失败、方法漏步、事实失败、风格质量，不再只凭低质量换模型。

包升级不能修改在途snapshot；新默认版本先通过静态和负例，再固定样本比较质量/成本，经人工确认切换。旧作品继续冻结原版本，用户请求升级时走影响预览和新run。每次修复优先找到漏掉的阶段/规则/数据依赖，并为失败补fixture；仅靠在总prompt末尾追加一句“请注意”不算完成修复。

## 9. 融合来源冻结与执行凭证

[source-inventory.json](source-inventory.json)记录本轮short-drama文件的相对路径、SHA-256、阶段路由及知识库manifest，不包含机器绝对路径或用户剧本。输入来自用户指定源包与当前安装副本；比较结果如实记入inventory。当前knowledge规则/案例计数均为0；检索空结果是合法empty，不得宣称已加载不存在的“经验库”。

融合不是把整包SKILL.md贴进system prompt：/start→M03+M22，/plan→M07，/characters→M08，/outline→M09，/episode→M10→M11→M12，/events→M04+M05，/skeleton→M24，/adaptation→M06，/review→M12，/overseas→M13+G16，/compliance→M20，/export→M21；任意改写经M13→M14/M15→重审。规则检索由M23按stage/genres/problem限量加载；M01/M02只是有依赖图的编排入口，不再写另一套冲突流程。方法包与源命令的逐项映射、输入输出schema和正负测试登记在implementation-map.json。

宿主加载包时校验manifestHash、引用文件hash、权限白名单及schema；把实际revisionId/methodHash/modelBinding冻结到SkillRunReceipt（字段见工作流§9）。模型返回文本“按v1执行”不是凭证；自测必须有独立testRunId、fixture hash、实际receipt、断言结果及费用。M18生成草稿不自动应用，M19失败也不等于源方法已废弃；详情分别显示静态校验、离线测试、真实模型测试三种状态。

优先级冲突由G01/M23显式解释，用户锁定事实优先且不能被方法建议默改。1×30秒、非爽剧、末集闭合等禁用条件需要测试，不能无条件套50–100集/付费卡点/四级反派/结尾强钩子。M11只写文学正文；技术镜头来自M16，不把AI可制作性建议变成全段摄影参数。升级方法或模型是新snapshot，不能追改历史run。

# 正文权威、来源语义、关联修订与声画时长合同

设计 v2.1 / 2026-09-25。是[融合方案](../tv-director-skill-fusion.md)关于数据一致性的唯一权威。解决四个根问题：读过原稿却漏事件；手改正文后仍用旧事实图；部分采纳造成半套改名/断裂因果；把同时发生的声画简单相加。

## 1. 一个正文权威，多个可失效的派生结果

正式可编辑内容以 `DocumentVersion.ast` 为唯一权威；Markdown是确定性导出/导入格式，编辑器ProseMirror是无损适配视图，画布节点和聊天文件卡只读取同一DV。不能让“模型JSON一份+可编辑Markdown一份”各自生效。

```ts
type DocumentVersion = {
  documentId: string; version: number; parentVersion?: number;
  schemaVersion: 2; kind: 'outline'|'characters'|'relations'|'locations'|'props'|'episode';
  ast: {blocks: Block[]}; contentHash: string; semanticInputHash: string;
  sourceRefs: VersionRef[]; specRevision: number; authorId: string;
  status: 'draft'|'accepted'|'legacy_unverified'; createdAt: string;
};
type Block = {
  id: string; type: 'heading'|'paragraph'|'scene'|'action'|'dialogue'|'sound'|'table'|'list'|'raw';
  children?: Block[]; text?: string; marks?: Mark[];
  attrs?: {sceneId?: string; entityId?: string; speakerId?: string;
    locationId?: string; timelineId?: string; recordType?: string;
    parseStatus?: 'valid'|'unsupported'|'incomplete'};
};
type SemanticSnapshot = {
  id: string; documentVersion: number; contentHash: string;
  semanticInputHash: string; specRevision: number; extractorVersion: string;
  events: StoryEvent[]; entityStates: EntityState[]; dependencyRefs: VersionRef[];
  evidenceAnchors: EvidenceAnchor[]; status: 'pending'|'valid'|'conflict'|'unknown'|'stale';
};
```

Block attrs中entityId/sceneId属于结构标识，不是模型猜测的人物知识/道具状态。作者编辑必须保留未变block ID；拆分/合并生成新ID并记录lineage。人物/道具表的内容也是AST结构化表格，渲染为卡片；改人设卡与改该文档走同一版本事务。语义图、边界、统计、估时、质量报告、定稿全部是引用DV的派生对象。

不可变SourceVersion是原稿证据权威；ConfirmedSpec是用户选定约束权威。二者与正文分工，不是相互覆盖：正文违背来源/规格时形成差异冲突；不能为了使新文稿“通过”倒改原稿或已锁约束。用户批准艺术加工建立显式FactDecision记录，不涂改SourceVersion。

### 1.0 五类文档独立版本与七步生命周期

2026-09-27审核澄清：“同DV”仅指**同一份文档在节点、聊天卡、编辑器、导出中读取相同documentId/version/hash**，绝不是大纲、人物、场景、道具和分集共享一个版本号。一个作品快照保存各文档当前版本引用集合；历史run保留当时集合，禁止读取时偷偷替换成最新。

```ts
type WorkDocumentSnapshot = {
  workId: string; workRevision: number;
  outline: VersionRef; characters?: VersionRef;
  locations?: VersionRef; props?: VersionRef;
  episodes: { episodeId: string; document: VersionRef }[];
};
// VersionRef至少携带documentId、version、contentHash；每次发送由服务端验证依赖完整性。
```

每种文档分别绑定`LC-<kind>-<operation>`用例，kind/operation/最小格数见[验收配置](acceptance-policy.json)。下面所有格都必须有独立证据，不用同一保存测试名包办五类；关联E01–E05/E06/E22/E28–E32、F10–F13/F18–F21。

| kind / 最早阶段 | generate | view | chat_revise | diff_review | edit_save | refresh_restore | downstream_read |
|---|---|---|---|---|---|---|---|
| outline / S1 | 选定profile候选 | 栏目/节点/编辑器同稿 | 目标节/选区 | 独立部分采纳与依赖组 | 草稿与正式稿区分 | head/剩余CS/光标可恢复 | 下一次修改先验；S3筹备实际读新版 |
| characters / S3 | 名单/小传/条件字段 | 稳定entityId定位 | 指定人物/字段 | 改名依赖不能半套接受 | 未确认年龄/称呼不补写 | 人物顺序与版本恢复 | 场景/分集/角色图计划读取新版 |
| locations / S3 | 空间/时段/使用边界 | 同名异址独立ID | 指定空间或字段 | 内外/动线联动范围可见 | 手改地点不默合并 | 地点锚点/待审状态恢复 | 分集/场景图计划读取新版 |
| props / S3 | 归属/作用/边界 | 同类异物独立ID | 指定物件/流转 | 归属变动关联组 | 手改不丢物件标识 | 物件状态与历史恢复 | 分集/道具图计划读取新版 |
| episode / S4 | 当前集计划→正文 | 按episodeId/场次切换 | 局部对白/动作 | 局改/依赖/全部拒绝 | 已定稿修改需重审 | 稿/审阅/定稿状态不混 | 下一集/导演计划读取有效新版 |

每格证据记录入口、前置版本、操作、请求/事件（纯读/本地操作明确无写请求）、前后hash、持久化复读、失败恢复、代码落点和截图。编辑/采纳测试覆盖409/断网、范围外不变和异步晚到；明确不适用的负例写理由，不留空格当通过。

修改传播由显式依赖边计算：大纲→人物/场景/道具/分集；人物/场景/道具→引用它们的文档、镜头及媒体计划；分集→后集边界/镜头。仅标记真正受影响对象stale/needs_review并给可定位原因，不自动覆写下游手工稿或发起付费重生成。读新版不是“最新时间戳赢”，而是满足各自结构/语义门的当前选定版本；未保存/未核验应阻断并给恢复路径。

已生成图片/画布节点保留`sourceDocumentRef + entityId + planId + generationInputHash`及原媒体历史；上游变更只提示过期，可预览重生成/重新绑定，不悄悄替换图片。批量采用是画布事务，生成是独立收费任务。跨文档版本集合提交按依赖闭包CAS；失败全回滚，不能让其中一页升级其余未升级。S3–S4验证实际下游请求中的版本集合；不能用前端显示更新冒充。

### 1.1 手工改正文的完整顺序

1. 编辑器变动写UserDraft（带baseVersion/clientDraftId）；自动保存可以保存未完成/语法不规范文本，避免丢字，但不会作为可生成输入。
2. AST适配器做结构解析和无损检查：成功形成candidate；不识别块保留raw fallback并提示具体位置，不能丢段、强猜说话人或空文覆盖。
3. 人工提交候选走CS：CAS验证baseVersion，创建新DV，标受影响SemanticSnapshot/Review/Finalization/下游输入stale。提交事务不会等模型网络调用；先写可靠失效事件与重新核验任务。
4. 确定性重算标题/场次/台词数量/显示序号/显式结构；语义性变动重新抽取受影响场次+前后边界，再与原文/锁定事实做独立核验。若超授权，不悄悄调用付费模型，保持needs_review并显示所需成本。
5. 后续生成只允许使用依赖版本齐全且semanticStatus满足相应门的snapshot；旧报告仍可查看但明确“已失效”。新分析成功不自动把人工定稿恢复，需针对受影响部分重新确认。

纯格式改动可通过确定性semanticInputHash（排除样式mark、不排除有意义正文/顺序/实体引用）证明语义未改，复用原图生成绑定新DV的派生receipt；此例外须有测试，不能仅因为编辑器标“样式变化”就跳过。删除线不等于逻辑删除事件；语义有歧义进入复核。

**必测例**：用户把“小画在街巷取回”改成“离开宅院前从桌上取回小画”。系统应失效该场/下一场物件状态、火场动作资源、时长表、两处依据的评审及定稿，重建正确持物链；不能只更新可见文字，而请求模型时仍传旧图。

### 1.2 选区和导入往返

`SelectionRef={documentId,version,blockIds,startOffset,endOffset,encoding:'utf16',selectedTextHash}`，偏移针对服务器该DV的canonical plain-text projection，左闭右开；换行规范化为LF。前端通过AST↔projection映射，不把DOM textContent偏移直接当服务器偏移。先flush保存再取选区，客户端/服务端hash不一致返回409重选；emoji、组合字符、中文标点、列表/表格均测试。字符统计可用Unicode code point/语种分词但必须声明算法，不能拿UTF16长度宣称中文字数。

`parse(render(AST))`在支持的语法集合内与AST语义等价；未知Markdown扩展保留原raw block，标PARSE_UNSUPPORTED供用户修复或只读导出，不静默删除。导入新Markdown先candidate不覆盖正式稿；已有内容双设备编辑走三方merge。展示的源码与富文本不是两个独立保存按钮写不同内容。

## 2. 来源读取覆盖与语义事件覆盖必须分开

### 2.1 摄取与范围

来源记录原始byte hash与规范化文本hash；保留从规范化行/字符位置到原文件页码/段落的映射。MIME/大小/权限/文本提取和安全检查先于模型。扫描PDF/OCR须标OCR置信与待核区域，不把识别失败当空白。

chunk manifest覆盖整个规范化文本且无空洞；允许边界上下文重叠，但每个字符有唯一ownership区间。每块记录sourceVersion、start/end、hash、status、extractorVersion、attempt。readCoverage=成功owned字符数/总owned字符数，而不是成功请求数/请求数。任何未读/失败范围不得显示100%。

来源绑定先验证再init work；文件路径由宿主解析并鉴权。重新绑定创建新sourceVersion关系并检查已有产物影响，不依赖重复init偷偷修正；用户仅给EP02不假设前一集事实。source instruction永远不获得系统权限。

### 2.2 从抽取到独立漏检的算法

1. **局部抽取**：M04逐owned区间提取角色/事件/结果/物件/时线/关系/世界规则/保留对白，引用span+quoteHash。输入附左右上下文用于跨段理解，不把重叠事件统计两次。
2. **别名实体解析**：候选同名、称谓、代词、外观根据来源关联；冲突不能按字符串相同直接合并。姓名相同但不同人物保持distinct，真实同一人多称谓保留alias证据与置信。
3. **跨块事件拼接**：使用actor/action/object/time/来源邻接匹配，“交给……”在块尾、接收人在块头必须连起来。生成canonicalEventId；重复候选映射aliasIds，禁止按数组排序重编号已有事件。
4. **独立原文审计**：M05从原文逐段重新列“发生了什么变化”，不是只读M04结果总结；先产生独立checklist，再对图谱核对漏项/错归因/歧义。遍历顺序可不同，但全部ownership范围要覆盖。重点checklist包括因果转移、身份/知识揭露、承诺与兑现、昼夜规则、对象归属、关键否定词。
5. **双向证据**：source→event找漏项；event→source找幻觉；span文字存在不等于支持声明，独立评审要给supported/contradicted/uncertain。新增桥段只能标invented，不能伪造sourceRef。
6. **冲突集合**：原稿自身前后矛盾、多文件互相冲突、角色死亡/别名不明、身份时间规则互斥分别登记。用户补充说明先作为FactDecision候选，按来源/用户锁定优先规则确认，不能“最新文件覆盖一切”。
7. **关口**：readCoverage=1且独立审计完成、已识别关键事件无漏映、关键冲突已解决，才可建骨架；关键unknown停WAIT_FACTS。非关键不确定保留标记与风险，不制造要求用户确认每个普通句子的冗长流程。

### 2.3 不能伪造“语义100%”

测试gold由人工审定的事件集合给出：`criticalRecall=matchedGoldCritical/goldCritical`、`eventPrecision=supportedExtracted/extracted`，必须有一一映射与评审准则。真实未知原稿没有完整gold，不能用模型自报“21事件”做分母宣称百分百保真；显示“全文读取完成、独立审计完成、已识别关键事件X项、未决Y项、人工抽查范围Z”。语义审计可能仍漏，不能宣称数学证明全文无漏。

关键来源决定记录 `{factId,sourceVersions,claim,originalEvidence,resolution,approvedBy,approvalReason,affectedIds}`；事实批准不是正文定稿也不是费用授权。删除/合并关键事件必须审批具体决策，不能把“同意改编”当无限删改。

**负例必须进入P0**：三块全部成功读完，抽取漏“把钥匙交给甲”。审计从原文找回；后续乙开门若无获取钥匙事件，报告因果/归属错误。只有计算readCoverage的实现必须在此测试失败。

## 3. 事件、时间、实体与连续性

`StoryEvent={id,sourceOrdinal,sourceRefs,sceneId,beatId,actorId,action,objectId?,before,after,dependsOn[],timelineId,storyTime,screenOrder,certainty}`。至少覆盖acquire/transfer/leave/destroy、move/arrive、learn/reveal、form_change、setup/payoff；未能解析不能默认为“无变化”。

对状态变化模拟：同一实体同一故事时线不能同时在互斥位置/身份，持有者变化需事件；角色做决定时不可知道尚未learn的信息；转场允许省略普通走路但关键物件/身份/因果不可无证据跳变。symbolic、dream、flashback、montage显式timeLine/representation标签，不把非线性剪辑等同故事倒流。

跨集以`BoundarySnapshot={episodeId,DV,semanticHash,storyTime,location,participants,props,knowledge,openSetups,realizedResults}`衔接。若用户指定“同一秒接续”，下一集起点必须相同；一般项目允许明确的时间跳跃/换地点并展示转场事件与变化依据，不能把一个测试样例的严格同秒规则强加全部作品。

《非妖哉》使用脱敏约束回归：两幅画独立identity、夕光退尽触发日夜形态、母亲存殁未明、源台词保留、火场中带画/火把/细针持握顺序、前厅群众获知火情后的反应、夜→傍晚需合法说明。源稿与平台失败输出不入公开仓库；匿名fixture保留相同错误结构。历史失败稿不是黄金正确答案。

## 4. 部分采纳与跨文档事务

### 4.1 差异不是彼此独立的字符串

`ChangeSet={id,baseVersions,specBaseRevision,rootIntent,scope,hunks,dependencyGroups,status,candidateSemanticHash}`。

`Hunk={id,targetDocumentId,blockIds,beforeHash,afterAST,changedFactIds,requiresHunkIds,groupId}`。两种关系必须分开：

- 强依赖：缺一个就造成不一致（人物改名与同identity的显示名/台词归属；道具转移与后场持有状态）。图中强连通分量收成不可拆组，组间requires形成DAG。
- 可独立建议：文风润色、无事实改变的句式优化；能独立采纳，但仍复检合并后的最终候选。

“接受单处”默认选中该处所属不可拆组并高亮关联处，告知影响；用户可以取消整组，不能给出表面逐处按钮却悄悄接受未展示范围。拒绝前置组使依赖组不可提交，提供连同撤回或重新生成后者的选择；不擅自扩大接受集合。

### 4.2 commit算法

```python
def prepare_commit(change_set, decisions, latest_versions):
    assert_all_base_versions_match(change_set.base_versions, latest_versions)
    accepted = resolve_explicit_group_decisions(change_set, decisions)
    assert_no_partial_atomic_group(accepted)
    assert_dependency_closed(accepted)  # 不偷偷自动勾选缺少的依赖
    candidate = apply_to_canonical_ast(change_set, accepted)
    reports = validate_merged_candidate(candidate)  # 不是只检查单独hunk
    assert_no_known_hard_failure(reports)
    return PreparedCommit(candidate, reports, dependency_closure(candidate))

# 可能耗时的分析先在事务外完成，期间不覆盖正式稿。
# 事务内重新CAS全部base/spec版本与candidate hash；失配则409，不复用旧报告。
# 一次事务：新DV/Spec + stale传播 + decisions + audit/outbox；任何失败全部回滚。
```

未决依赖/语义unknown能保存待审CS，不能当一致性通过。离线手工编辑可以存UserDraft但不绕过commit。多个文档在同SQLite事务；未来若跨存储，先实现prepare/commit receipt与补偿恢复，不承诺虚假原子性。

### 4.3 失效传播和重新定稿

AST/Spec变化→受影响事件/实体→场次/集→边界/伏笔→分镜/提示词→媒体计划。标stale而非自动付费重做；已生成媒体保留版本与原输入快照，清楚提示与现稿不同。影响包括旧Finalization及质量报告；不能改变正文后仍显示原“已定稿”。

用户选择“只改未来集”必须验证过去的锁定事实仍可作为新设定前置；若矛盾无法兼容，禁用该选项并给重审旧集/保留旧设定方案，不能用范围选项掩盖不一致。

### 4.4 增删集数、重排与标签

Episode.id创建后不变；orderKey/展示编号/来源标签/交付标签各自存储。增集新ID；删除将Episode归档并保留历史引用，不复用其ID给另一集；重排只改顺序映射，文件导出名由映射生成。禁止拿`EP001.md`文件名作为所有引用的外键。

重排前计算新前后边界、伏笔兑现和角色知识；删集中断关键事件必须安排到其他集或明确批准删除；改变总集数会改变谁是末集，须重算结局/hook规则。用户预览增删/改稿/失效定稿清单后原子提交；新目录未确认不自动重写全文。

## 5. 时长：串行依赖与并行声画，不能简单求和

### 5.1 时间模型

每个Beat绑定当前DV的可见正文范围：`{id,track,sourceBlockIds,estimate:[min,max],method,evidence,dependsOn[],concurrentGroup?,resources[],timingStatus}`。track可为speech/action/silence/transition/music；音乐床不额外增加覆盖区间总长，独立片尾音乐则有实际时长。

对白读速使用语种/角色/情绪校准，未实测的语速范围标assumed；动作按动作拍数/实测片段给区间，无依据就unknown，不让模型随填0秒。停顿标清属于语句内还是独立beat，避免重复计算。多人同时说话只有脚本显式重叠才并行；拿画→解线→带走这些有前后/资源约束不能按同时发生取max。

构造无环precedence DAG；合法并行不连先后边，共用不能并发的身体/物件资源需排队或报BLOCKING_CONFLICT。时线倒叙不会令屏幕播放时间倒流：screenOrder和storyTime分开。

### 5.2 区间关键路径

```python
def critical_path_bounds(beats):
    order = topological_order(beats)  # 环、缺前置、冲突资源先报错
    ends = {}
    for beat in order:
        if beat.estimate is None:
            return DurationResult(status="UNKNOWN", unknown_ids=[beat.id])
        low_start = max((ends[p][0] for p in beat.depends_on), default=0)
        high_start = max((ends[p][1] for p in beat.depends_on), default=0)
        ends[beat.id] = (low_start + beat.estimate.minimum,
                         high_start + beat.estimate.maximum)
    return (max((v[0] for v in ends.values()), default=0),
            max((v[1] for v in ends.values()), default=0))
```

这不是完整资源调度器：传入前须已把资源互斥排成依赖；没有排程时不能称upper bound可靠。多个场按剪辑先后串行，相邻场声音叠化明确建跨场overlap依赖，不能既算整个场长又加同一对白。蒙太奇仍要镜头长度与必要事件可辨认的证据。

| fixture | beat关系 | 期望 |
|---|---|---|
| 同步走路说话 | speech=8秒，walk=6秒，同起，无互斥 | 总8秒，不是14秒 |
| 说完才走 | walk.dependsOn=speech | 总14秒 |
| 动作链 | 放火把2→解绳4→取画2→离场3 | 至少11秒，不能标10秒 |
| 背景音乐 | 音乐覆盖8秒场景，不是新增片尾 | 总仍8秒 |
| 不明动作 | “很快完成一切”无拆拍/证据 | UNKNOWN，不能计0秒后PASS |

### 5.3 与目标时长及定稿的关系

- 区间下界>目标：确定超量，FAIL；改内容/规格而非修改报表数字。
- 下界≤目标<上界：CAPACITY_RISK，需降低密度、排演或明确留风险；不能宣称精准达标。
- 上界≤目标：估算可容纳；ESTIMATED，不等于MEASURED。
- 任一关键beat未知：DURATION_UNVERIFIED；用户可保存/审阅文学稿，productionReady=false。
- 真人试读证明的是speech部分，分镜动作排演/剪辑预演证明相应段落；有完整证据才可声称总时长实测。修改一处影响时间的正文使相关测量过期。

目标容差按项目配置并在UI显示；不能为了通过把30秒改为30±无限。验收使用固定容差与明确测量方法，见[验收合同](acceptance-contracts.md)。故事约束/语义连贯和时间容量缺一不可，不能总数414秒就忽略火场10秒塞六个动作。

## 6. 存储、迁移与代码实现顺序

P1新增独立document_versions、user_drafts、semantic_snapshots、fact_decisions、dependency_edges、change_sets/groups、finalizations、duration_reports；引用外键带版本，事件与outbox同事务。实际命名服从当前repository，不新起另一个持久层。先纯AST和hash/投影单测，再事务和派生任务。

旧Markdown先备份校验hash，在迁移事务中存原文和legacy_unverified AST候选；解析不明保留raw，不伪造来源事实/旧评审PASS/定稿证据。新版本schema迁移可重复运行且有版本门；Windows路径、中文文件名、数据库相对资产引用回归必跑。迁移中断可重试，不能删除旧存储再从聊天重建。

读写API只返回授权投影；模型/客户端不能直接执行SQL或指定任意文件路径。跨项目引用被拒绝，素材只在用户选择共享时复制/映射。迁移和备份的技术测试不意味着把私有稿件或密钥提交公共仓库。

## 9. 顺叙与尾部事件的可执行守卫

来源图新增 `sourceOrdinal`（完整已读取源中事件的稳定序号），与源文本位置/sourceRefs、故事发生时刻storyTime、呈现次序screenOrder分开。不能用模型生成的显示编号冒充来源顺序。strict_chronological要求被保留事件的首次真实呈现按已确认故事时序非递减；当来源本身顺叙、未另批准时间线重建时以sourceOrdinal作审计基准。来源本身倒叙/并行时必须先显式确认chronology graph，不能错误强制源文本顺序。

检验从最终AST抽取eventRealizations，按场次/beat展示顺序检查相邻边；重复提及不算重新发生，蒙太奇/回忆例外必须有批准的结构/跨度及可见标记。找不到可靠realization为UNKNOWN，不用大纲上的“顺叙”二字判PASS。F25包括E10/E11颠倒、尾部三关键事实落正文、来源倒叙例外与无span反例。

尾事件检查绑定最终documentVersion/semanticHash；readCoverage=1、摘要列出尾事实、抽取图齐全都不能替代正文保留验证。关键缺失生成ImpactPlan并阻断定稿；非关键省略须有AdaptationDecision与范围批准。M05、M12分别负责源图完整性与最终稿实现度，避免让同一模型自证“已经写到”。

文学AST保存场次、人物、动作、对白、声画时间与因果；焦距、机位、运动轨迹等拍摄技术字段只在M16的ShotPlan派生层出现。short-drama的可拍性约束不等于在文学正文塞入导演参数；两层共享eventId/beatId/assetVersion，不共享可随意覆写的正文。

# TV Director 大纲对齐：Seed、short-drama 与五节交付的代码级实施方案

设计版本：1.0 · 2026-09-27。基线：`main/213854b5` **加当前工作线尚未提交的增量**，不是只看 HEAD。

**本文件是待实施设计，不是已经完成的功能。** 本轮只写方案，没有新增模型调用、修改业务代码、部署或提交。

目标：先把“上传同源故事 → 方向确认 → 五节改编大纲 → 聊天提出修改 → 逐节差异审阅 → 保存恢复”的完整闭环做对，再验收内容质量和同文同态像素。最新实验只用本地 Seed 与 LibTV 选中的 Seed；不再增加 DeepSeek 横测。模型同名不等于两站后端权重、系统提示和采样参数相同。

本文把[最新对照证据](agent-plan-outline.md) §9 的六项改造细化到代码；全产品边界仍见[融合总方案](../tv-director-skill-fusion.md)。正文权威、来源审计、部分采纳原则继续服从[文档语义合同](document-semantics.md)，本文不另建一套权威规则。全产品其余欠项见[实施收口清单](implementation-closure.md)及任务台账，不能用“大纲完成”代替“完整 TV Director 完成”。

代码标记约定：

- **现有**：已在工作树中检查的文件、函数或表，允许复用但不能假设没有缺陷。
- **新增/拟改**：实施时才创建或修改，下面的代码块是接口与核心算法骨架，不是可直接粘贴后上线的完整补丁。
- Python 块使用现有 `ContractModel`/camelCase wire 约定；未展开的服务辅助函数在所在节列明职责。类型/语法检查不代替事务、模型和浏览器验收。
- 具体业务文本、完整请求、回包和截图只保留在被忽略的 `output/`。本文不收录原稿全文、账户标识、Cookie 或供应商凭据。

## 1. 本次要解决什么，为什么不是继续换模型

### 1.1 已有证据与不能再犯的判断错误

| 编号 | 真实观察 | 根因/实现缺口 | 此次解决位置 |
|---|---|---|---|
| R01 | 原站本次改编交付五节，本地渲染 11 个 H2 | 内部创作规划直接当用户正文；不是换标题即可 | §4、§6 |
| R02 | 本地修改又生成全量 M07，已正确内容也被改写 | 缺少基线绑定的局部修改合同 | §7–§9 |
| R03 | 本地 schema 通过，但别段仍有引诱、错误人名、额外钩子 | 多个长字段反复讲同一事实；语义检查没有覆盖最终全文 | §3、§5、§10 |
| R04 | 原站 patch 11 处后，另一未改段仍先归来后叩画 | patch 成功不代表全篇一致，不能照抄原站错误 | §8、§10 |
| R05 | 原站红删/青增、逐节导航与接受/撤回；本地待审全文 | 前端没有消费结构化差异及分组决定 | §11 |
| R06 | 修改说明曾进入故事梗概 | 聊天交付与文档内容混成同一个输出 | §4、§12 |
| R07 | 649 字概要也逼近旧单文档 prompt 门 | schema/审计重复已窄修，仍需按阶段加载、分块持久执行 | §5、§13 |
| R08 | 刷新可以恢复待审稿，但部分采纳与继续改稿未闭合 | 有恢复基础，没有新提案的版本/决策协议 | §8、§9 |
| R09 | 两站问题包含已给集数/时长，候选中有未证实剧情 | 提问必须区分参数确认、真实缺口和模型假设 | §6 |
| R10 | 正文裁剪区差异小，整页仍失败 | 内容、状态、全页几何和动态元素不能混测 | §14 |

历史 671 后端 / 104 定向前端 / build 通过只证明当时的代码门。最新两边文学检查均有失败；这些数字不是本文新增测试结果。

### 1.2 完成后的用户路径

```text
来源/用户设定冻结
  → 读取与事件核对（有真实阶段进度，缺口才提问）
  → 选择讲法（不授权模型新增事实）
  → 生成五节大纲并持久保存为待审候选
  → 查看 / 接受为可编辑草稿 / 提出修改
  → 本次指令 + 稳定块基线 → 局部 patch
  → 全文组合核对 → 五节差异 + 独立聊天总结
  → 按依赖组逐节接受/撤回 → 新草稿版本
  → 停留 / 再修改 / 明确进入下一阶段
```

保存候选≠接受；接受草稿≠事实审计通过；审阅通过≠人工定稿；大纲通过≠同意生成角色图、分集或视频。操作体验向原站对齐，不能移除这些状态边界。

### 1.3 本轮实施范围与非目标

覆盖改编大纲的所有入口：新作品规划、已有文档打磨、局部选区修改、手工编辑后再生成、旧稿显式升级。保留原创、人物、场景、道具、分集和现有媒体功能不回退。

本切片不实现全套 24 方法、任意外部插件、媒体供应商或分享功能；不接 LibTV 私有接口作为生产依赖。M04/M05 在这里落地的是**文本来源到大纲所需闭环**，扫描 PDF/OCR、完整分集状态图、全产品技能市场另按原计划验收。不能把未实现子项写成“支持所有素材”。

## 2. 当前代码接点：保留什么，替换哪一段

后端路径除另行注明均相对 `src/novelvideo/director/`，前端相对 `frontend/src/features/director/`。

| 现有位置 | 当前行为 | 精确改造 |
|---|---|---|
| `schemas/planning.py::StoryPlan` | 通用 v2，强制 `opposition_tactic`、`cannot_retreat`，大量重复叙事 | v2 原样兼容；新增独立 adaptation-v3 合同，不给旧字段塞假“不适用”以蒙混 |
| `planning.py::compile_planning/validate_planning` | M03/M07 严格输出；M07 一份通用 schema | 根据 mode/operation/contract 分派到同一 outline 编译器 |
| `planning.py::planning_documents` | 大纲单独投影或筹备四文档 | 新合同投影五节；禁止自动调用 M08/M09 来凑栏目 |
| `writing.py::compile_generation` | 已有 outline 仍输出完整 StoryPlan | 新初稿用 delivery；已有新式稿默认 patch；旧稿走显式升级/兼容 |
| `outline.py::parse_outline/validate_outline/render_outline` | v2 校验和 11 节渲染 | 保留；增加 dispatcher，不把旧 JSON 强转为 v3 |
| `documents.py::parse_markdown/render_markdown/semantic_hash` | 行级 AST、ID/lineage、无损投影基础 | patch 在 AST 上操作；不通过全文字符串匹配定位段落 |
| `repository.py::write_ast` | 目前由 Markdown 重新解析生成 AST | 增加接收已验证 AST 的窄入口，旧 text 入口委托，避免 patch ID 二次丢失 |
| `store.py::_put_document` | AST+兼容 Markdown、版本指针、work revision、事件 | 抽出同事务公共写入出口，新 patch 不绕过任何版本/失效逻辑 |
| `execution_repository.py::complete/_propose_output` | 原回包保存，`changes` 为全文提案 | 新合同存 patch/候选 AST/核对报告；旧全文提案继续读 |
| `workflow.py::_queue_next/_decide` | 静态阶段序列；WAIT_OUTLINE 明确采用后保存 | 以持久 job manifest 支撑源块/核对/五节输出；采用同一候选提交服务 |
| `semantic_validator.py::prepare_change_selection` | 已有依赖组闭包纯函数 | 接真实 repository 和 API，不重写一套纯函数当完成 |
| `semantic_validator.py::validate_source_audit` | 校验输入的覆盖与审计，不负责抽取 | 接真实来源阶段；不能由客户端传 `audit_completed=true` 放行 |
| `outline_review.py` / `episode_facts.py` | 已有引用与逐段核对基础 | 新大纲候选适配与全段覆盖；分集审查保持旧合同 |
| `dispatch.py::dispatch_writing` | 单次领取、费用未知、结果留存；stream 分支目前通用写作 | 新结构化流也必须传原 `response_format`，不能因开启 stream 丢 strict |
| `useExecutionStream.ts` / `DirectorConversation.tsx` | 真增量、事件游标、跟随滚动 | 区分结构化文档流和聊天；不把 JSON 全文显示成聊天答案 |
| `DirectorStudio.tsx::decide` | bool 全接受/拒绝，全文预览 | 按提案合同路由 v1 全文或 v2 changeset |
| `DirectorDocumentEditor.tsx` / `useDocumentAutosave.ts` | 真实自动保存、冲突恢复、聊天共存 | 共用文档壳，新增只读 diff decoration；不能保存差异装饰进正文 |
| `components/PlanningWorkflow.tsx` | 分页问卷/筹备采纳 | 已知规格只读摘要、缺口问题、仅大纲完成的后续动作 |

### 2.1 不重建数据库，不制造双正文

现有 `director_document_asts` 是正文权威；`document_versions` 为兼容 Markdown 镜像。`director_artifacts` 放来源图、内部规划、五节索引、核对结果等有版本的派生数据。`director_operations`、执行事件、费用批准和 outbox 原样复用。

**新增五节结构化生成结果不是第二份可编辑正文。** 它是不可变模型输出与初始 AST 构建输入。用户接受后，后续模型必须读最新 AST；旧 M07 JSON 只留审计，禁止重新渲染覆盖用户修改。

现有 `revisions.py` 处理设定/重开影响，不塞进文本 patch；新增 `outline_changes.py` 负责大纲候选与审阅事务，避免把两种修订混为一谈。

## 3. 来源与授权层：先阻断“未确认推断变事实”

### 3.1 数据对象与证据坐标

新增 `schemas/outline_source.py`。现有 SourceChunk/SourceAuditInput/VersionReference 继续使用；以下类型是对事实层的补足。

```python
from typing import Literal
from pydantic import Field
from .common import ContractModel, Identifier, NonNegativeInt, PositiveInt, Sha256


class SourceSpan(ContractModel):
    source_version_id: Identifier
    start: NonNegativeInt
    end: PositiveInt
    encoding: Literal["unicode-codepoint"]
    quote_hash: Sha256


class SourceClaim(ContractModel):
    id: Identifier
    kind: Literal["observed", "character_statement", "retrospective", "unresolved"]
    subject_ids: list[Identifier]
    speaker_id: Identifier | None
    assertion: str = Field(min_length=1)
    evidence: list[SourceSpan]
    event_ids: list[Identifier]
    conflicts_with: list[Identifier]
    importance: Literal["critical", "major", "minor"]


class FactResolution(ContractModel):
    claim_ids: list[Identifier]
    policy: Literal["preserve_attribution", "leave_unspecified", "approve_adaptation"]
    explanation: str = Field(min_length=1)
    decision_ref: Identifier
```

此处 source span 使用 Python Unicode code point；编辑选区继续使用既有 UTF-16，**不能共用未标编码的 offset**。入库前验证 `0 <= start < end <= len(normalized_source)`、对应 SHA-256、来源版本归属。相同引文在多处出现必须保留明确范围，不用 `text.find()` 随便匹配首处。

模型只输出候选主张与证据，不填写 `approvedBy`、审计状态或决定 ID。宿主分配稳定 ID，用户明确决策另存带 actor/时间/hash 的记录。原文文件里的任何指令都是资料，不获得系统权限。

### 3.2 源版本与概要不是同一种输入

新增 `outline_source.py::freeze_source`：从已有 `work.sourceText/source_sha256` 建立不可变来源版本 artifact；版本来源由宿主写入。重复冻结同一 hash 不产生新“已审核”状态。

```python
def verify_span(span, source_version):
    from .documents import content_hash
    if span.source_version_id != source_version.id:
        raise ValueError("SOURCE_VERSION_MISMATCH")
    if not 0 <= span.start < span.end <= len(source_version.text):
        raise ValueError("SOURCE_SPAN_OUT_OF_RANGE")
    quote = source_version.text[span.start:span.end]
    if content_hash(quote) != span.quote_hash:
        raise ValueError("SOURCE_SPAN_HASH_MISMATCH")
    return quote
```

实验允许用人工概要，但必须记录 `sourceKind=curated_summary` 与原稿关联。只核对概要时不得显示“完整版原稿逐事件审核通过”。产品可选全文摄取；不自动用摘要替换用户上传的全文。两站比较固定同一份概要、同一设定、同一修改指令及各自真实出站 hash。

### 3.3 M04/M05 最小完整接入，不再用模型自报代替

新增 `outline_source.py`、`source_audit.py` 和相应方法包：

1. 确定性按语义边界建立 ownership chunks，全量保存；重叠上下文不重复计数。
2. M04 每块抽取 event/claim/entity candidate，保存原响应、覆盖区间、工具版本、输入 hash。
3. 宿主合并有证据的实体别名与事件重复，模棱两可不强合并；稳定 ID 不按模型数组顺序重编号。
4. M05 用新上下文先从原文独立列事件，再与 M04 对照；不能只问“这些事件正确吗”。仍只使用 Seed，独立上下文不是换 DeepSeek。
5. 复用 `validate_source_audit` 检验真实持久记录构建的 SourceAuditInput；其 `extraction_run_id != audit_run_id`。
6. 缺段/尾部未读/抽取漏项 → `SOURCE_AUDIT_INCOMPLETE`，恢复失败任务或修抽取，不能让用户填答案掩盖没读完。来源已完整读取但确有影响当前大纲的未决歧义 → `WAIT_FACTS`；可选择“保留各人说法”，不是必须替用户编唯一世界规则。
7. 来源审计缓存绑定 source hash、方法 hash、用户决定 hash；仅改语气不再重买同一来源抽取，改来源则旧缓存失效。

M04/M05 是新增收费子步骤，纳入 §13 的父计划预览与预算，不隐藏在一次 M07 名下。已有人工黄金事实表可在实验中显式导入代替抽取，用于隔离变量，但必须标为 human fixture，不能算产品已执行 M04/M05。

### 3.4 《入画》必须变成通用反例而非专属 prompt

| 事实义务 | 合法表达 | 必须检测的错误 |
|---|---|---|
| 人物原名 | 每处实体绑定与展示名一致 | “孟龙潭”在标题变“孟潭”，没有获批别名 |
| 搜查、求助、叩画、归来 | 按已确认事件链呈现 | 篇章正确，概要保留“先归来再叩画” |
| 两种巡使触发解释 | 保留说话者及不确定性 | 擅自合并为客观规则，或让老妇已遭惩罚 |
| 两种抹除范围 | 人物陈述分别归属 | 把抹归乡执念直接写成所有记忆均被删 |
| 挽髻 | 保留结尾回述与时间缺口 | 补婚姻、爱情，或声称为藏身而改发式 |
| 钩子范围 | 用户本次只授权凝望/白雾 | 又增加盛宴、搜查钩子，或独坐/触碰动作 |
| 老僧解释 | 保留角色解释性质 | 写成作者已证明的宇宙定律 |
| 画境氛围 | 可写安逸与囚禁的反差 | 无证据写“环境有意软化/诱捕人” |

公开测试用匿名同结构合成例；真实专名与原回包只在本机付费验收记录中使用。不能只把上述几个词加黑名单；“并非蓄意引诱”不应被误拦，换个同义词表达相同新增机制也应被语义核对识别。

## 4. 五节交付：内部技法与用户正文分层

### 4.1 五节的精确字段和权威来源

| section key / 标题 | 用户看到的要素 | 模型可写 | 宿主负责 |
|---|---|---|---|
| `overview` / 【一】概要设计 | 类型/口味、篇幅目标、基调、故事简述、主角处境、主要阻力、情绪走向 | 叙事性简述、人物感受与处理 | 集数/时长/结构/语言来自冻结 preset，不准猜 |
| `adaptation` / 【二】这次改写怎么处理原文 | 来源/范围、改写口径、诉求、授权改动、必须保留、已做改动、未决项 | 拟采用的表达方法与改编说明 | 来源标签、用户决定、实际应用记录；无授权就写未授权 |
| `chapters` / 【三】篇章划分 | 各篇讲什么、位置、对应集、不能丢的事件、承接/结果 | 节奏与因果组织 | 稳定 episode/event ID、按用户选定结构验证 |
| `hooks` / 【四】钩子预设 | 本集看点、开篇钩子、关键伏笔与回收 | 有来源支持的画面/疑问、情绪兑现 | 限定用户指定范围，闭合结局不强造下集 |
| `boundaries` / 【五】改写禁区 | 不可新增/删改事项、口径差异、需确认的边界 | 清楚的可执行说明 | 锁定事实/决定映射，不能只在此免责 |

“三幕”不等于三集；一个 600 秒单集可以有三篇章，所有篇章引用同一 episode ID。五节是本次已观测的改编交付合同，不强制原创也变成“改写原文说明”。原创继续现有交付，另按原创证据对齐。

### 4.2 新增生成合同（`schemas/outline_delivery.py`）

模型不返回数据库 ID、已批准/已保存标记、权限或成本。来源允许的 ID 以请求时动态 enum 限制，宿主再核验。

```python
from typing import Literal
from pydantic import Field, model_validator
from .common import ContractModel, Identifier


class GroundedText(ContractModel):
    text: str = Field(min_length=1)
    claim_ids: list[Identifier]
    event_ids: list[Identifier]
    nature: Literal["source", "interpretation", "proposed_change"]


class CraftPoint(ContractModel):
    applicability: Literal["applicable", "not_applicable", "uncertain"]
    evidence: GroundedText | None
    reason: str | None

    @model_validator(mode="after")
    def validate_applicability(self):
        if self.applicability == "applicable" and self.evidence is None:
            raise ValueError("CRAFT_EVIDENCE_REQUIRED")
        if self.applicability == "not_applicable" and self.evidence is not None:
            raise ValueError("INAPPLICABLE_CRAFT_CANNOT_CARRY_EVIDENCE")
        if self.applicability != "applicable" and not (self.reason or "").strip():
            raise ValueError("CRAFT_UNCERTAINTY_REASON_REQUIRED")
        return self


class OverviewDraft(ContractModel):
    title: str
    logline: GroundedText
    synopsis: list[GroundedText]
    protagonist: GroundedText
    resistance: GroundedText
    emotional_curve: GroundedText


class AdaptationTreatment(ContractModel):
    approach: list[GroundedText]
    preserve_claim_ids: list[Identifier]
    proposed_changes: list[GroundedText]
    unresolved_claim_ids: list[Identifier]


class ChapterDraft(ContractModel):
    key: Identifier
    title: str
    episode_ids: list[Identifier]
    story: list[GroundedText]
    position: GroundedText
    must_keep_event_ids: list[Identifier]


class HookDraft(ContractModel):
    key: Identifier
    episode_id: Identifier
    image: GroundedText
    question: str


class SetupDraft(ContractModel):
    key: Identifier
    plant: GroundedText
    payoff: GroundedText | None
    open_reason: str | None


class EpisodeHighlight(ContractModel):
    episode_id: Identifier
    highlight: GroundedText


class HooksDraft(ContractModel):
    episode_highlights: list[EpisodeHighlight]
    openings: list[HookDraft]
    setups: list[SetupDraft]
    inapplicable_reason: str | None


class CraftNotes(ContractModel):
    causal_chain: list[Identifier]
    emotional_beats: list[GroundedText]
    resistance_kind: Literal["person", "condition", "internal", "mixed", "none"]
    opposition_strategy: CraftPoint
    actual_cost: CraftPoint
    reversal: CraftPoint
    production_risks: list[str]


class AdaptationOutlineDraft(ContractModel):
    contract: Literal["adaptation-outline/3.0.0"]
    overview: OverviewDraft
    adaptation: AdaptationTreatment
    chapters: list[ChapterDraft] = Field(min_length=1)
    hooks: HooksDraft
    boundaries: list[GroundedText]
    craft_notes: CraftNotes
```

以上是字段与适用性校验骨架，其余确定性校验集中到 §10.1 的 `validate_delivery`：所有必填字符串 strip 后非空；key 唯一；每个 episode 的看点通过 `EpisodeHighlight.episode_id` 关联且集合精确等于冻结的集清单；来源/篇章/伏笔引用不悬空。闭合结局的 setup 不可假留待下一集、`interpretation` 不能新增源事实，分别由明确结构约束和 §10.2 语义审查完成，不能假称 Pydantic 能独立判断文学含义。字段数量不作为文学价值指标。

`craft_notes` 只保留有用的因果/节奏/兑现信息，**不再生成另一遍完整 synopsis/ending/segments 的重复散文**。这是对 short-drama 的条件化执行，不是丢弃根基。不适用不是空字符串或瞎编反派策略。模型可以输出丰富、自然的正文，但不能用固定最少字数逼出废话。

### 4.3 AST 构建与五节索引（`outline_delivery.py`）

```python
SECTION_ORDER = ("overview", "adaptation", "chapters", "hooks", "boundaries")


def build_outline_candidate(draft, frozen, source_graph):
    validate_delivery(draft, frozen, source_graph)
    # 只有宿主拼入已冻结的规格、来源及用户决定。
    sections = compose_sections(draft, frozen, source_graph)
    ast, bindings = build_stable_blocks(sections, section_order=SECTION_ORDER)
    return {
        "ast": ast.model_dump(mode="json", by_alias=True),
        "bindings": bindings,
        "craftNotes": draft.craft_notes.model_dump(mode="json", by_alias=True),
    }
```

`compose_sections`：宿主三语标签；正文语言跟 preset，不跟界面语言。已有 `.text` 内容安全作为文本，不执行 HTML；用户源标题包含 Markdown 控制字符需正确转义。把“已做改动”限定为当前候选确实实现的表达变化并标“待接受”，接受后状态由 receipt 更新；无正文证据不写“已完成审计”。

`build_stable_blocks`：适配当前**一行一 Block**约束，段落是连续 block 范围而非带换行的 `Block.text`。初稿由宿主生成 ID；段落索引存起止 block ID、section key 和 source claim 映射，作为同 AST hash 绑定的 artifact。不要为了五节新增第二份可编辑 JSON 或立即修改所有文档 BlockAttrs。五节目录由索引生成，缺失/过期时用真实标题降级，不伪造索引有效。

## 5. short-drama 如何具体融合，不再无限叠提示

### 5.1 方法职责表

| 方法 | 保留来源 | 在本闭环的真实职责 | 不能强套 |
|---|---|---|---|
| M03 方向 | short-drama 定位/题材 + 当前 source-grounding | 给不同讲法，不改来源事实；只追问未决项 | 方向候选的剧情断言不等于确认事实 |
| M04 抽取（新增） | adaptation-core、event-coverage | 来源 ownership 区间 → 有证据事件/主张 | 不能只读概要称全文抽取 |
| M05 独立核对（新增） | event-coverage | 从原文反向找遗漏/错归属/未知 | 不让 M04 自我签字 |
| M07 大纲 | opening-rules、rhythm-curve、satisfaction-matrix + adaptation-core | 单一因果链、张弛、发现/释然等情绪兑现 → 五节交付 | 不强制复仇、反派四层、爱情、30 秒开篇、下一集 |
| M13影响分析→M14局改/M15关联修订 | 改编边界、当前 source-grounding、最小修改约束 | M13产影响计划；M14/M15产patch与独立说明 | 不另建同号M13修改包，不全量重写，不把说明放故事 |
| M12 大纲核对（现有适配器升级） | 已钉住的审查参考 + 来源事实合同 | 从最终候选全文逐段核对，不靠生成者自评 | 不复用“分集六检查”schema硬套大纲 |

付费卡点参考已经阅读，但用户未启用商业卡点时不加载进执行 prompt，只在 receipt 记禁用理由。默认 50–100 集、百分比、反派层级、固定场次属于原技能场景经验，不变成用户无法更改的参数。`evolution` 本轮查询无匹配，不捏造经验库，不修改全局技能或其快照。

### 5.2 包与运行时修改清单

新增包目录 `skills/builtin/source-events/`、`source-audit/`、`outline-revision/`；每包实际文件都要有：`SKILL.md`、`manifest.json`、`method.md`、`schemas/input.json`、`schemas/output.json`、`templates/request.md`、`fixtures/contracts.json`、`provenance.json`、许可及确实加载的 references。来源按当前冻结 hash 核对，运行时不读开发者个人目录。

现有 `story-plan` 增加改编专用方法与 schema 变体；原创 v2 保留。不能只把 manifest 版本改为 3.0.0：当前 `runtime.Manifest.stage/version`、`load_package` 的 validator 白名单、`output_schema` 和 `PACKAGES` 都是固定集合，必须一起升级并做破坏测试。

推荐把**包注册**与**输出合同选择**分开，stage 仍作为调用职责，增加由宿主选定的 contract key；不允许模型动态注册工具：

```python
def select_outline_contract(*, mode, operation, document_contract):
    if mode != "adaptation":
        return "story-outline/2.2.0"
    if operation == "draft":
        return "adaptation-outline/3.0.0"
    if document_contract == "adaptation-outline/3.0.0":
        return "outline-patch/1.0.0"
    raise ValueError("OUTLINE_CONVERSION_REQUIRED")
```

`operation` 从宿主文档版本与用户操作判定，不从模型回答猜。包 key/version/contract/schema hash/参考 hash/上下文编译版本共同进入 capability 与冻结报价；包被改动后旧未消费批准拒发，不重解释旧付费回包。历史包和旧 schema fixture 保留可读。

### 5.3 新方法核心片段（拟写入应用内方法包）

```text
ADAPTATION DELIVERY
Use source claims and explicit user decisions as story authority.
Build one causal event chain, then write five reader-facing sections from it.
Craft guidance improves emphasis, pacing and emotional payoff; it does not
authorize new events, motives, relationships or universal world rules.
Keep attributed explanations attributed wherever they recur.
Represent inapplicable craft mechanics explicitly; do not invent a strategy
for a non-agentic setting to satisfy a field.
Report changes in changeSummary, never inside story paragraphs.

REVISION
Return edits only for supplied stable block ranges and authorized scope.
Do not rewrite untouched paragraphs. Identify related occurrences that also
need changing; request scope expansion when those lie outside the permission.
Source quotations prove location, not automatically semantic support.
```

版本晋级必须由匿名反例、真实 Seed 复测支持，不能以“提示词写得更严”作为通过证据。修改记录写来源/失败模式/预期行为/实际结果；不要把一个故事的具体名字或 600 秒写入通用方法。

## 6. 初稿与问卷接入：两条入口必须用同一编译器

### 6.1 新增 `outline_compiler.py`

`compile_planning(M07)` 与 `compile_generation(kind='outline')` 都委托这里，返回现有 `{prompt,inputHash,parameters,contextManifest}` 结构。禁止一条链严格 JSON、另一条链重新拼自然语言；禁止前端决定实际 prompt。

```python
def compile_outline_request(frozen, operation, source_graph, current, budget):
    contract = select_outline_contract(
        mode=frozen.preset.mode,
        operation=operation,
        document_contract=current.contract if current else None,
    )
    schema = schema_for_contract(contract, frozen, source_graph, current)
    method = compile_outline_method(contract, frozen)
    parameters = freeze_outline_parameters(frozen, current, budget, contract)
    parameters["responseSchemaHash"] = object_hash(schema)
    parameters["response_format"] = response_format(
        frozen.model, schema, name="director_outline"
    )
    return compile_frozen_outline_context(
        frozen=frozen, current=current, source_graph=source_graph,
        parameters=parameters, method=method, schema=schema,
    )
```

以上 `schema_for_contract` 等为新增辅助函数：

| 函数 | 输入/输出与必须行为 |
|---|---|
| `schema_for_contract` | 从 Pydantic 派生 schema，加实际 ID enum；不手写另一份容易漂移的 schema |
| `compile_outline_method` | 加载已钉住包，按 mode/operation/商业策略选择参考，不全塞全部包 |
| `freeze_outline_parameters` | 绑定模型、来源、规格、当前 DV/AST hash、授权范围、方法、预算；只读复制 |
| `compile_frozen_outline_context` | 系统方法与资料分区；source/现稿不截尾；schema 只呈现一次，decoder hash 入指纹 |
| `parse_outline_result` | 查 frozen contract，而非当前最新包；拒绝重复 key、多字段、截断、单字退化 |

引用现有 `documents.object_hash`、`structured_output.response_format`、`context.compile_context`，不是重新实现哈希或 provider 客户端。

### 6.2 M03 问卷

扩展 `SpecQuestion` 的目的/目标字段/原因，旧问卷按旧版本读。新合同将问题分为 `confirm_spec`、`source_gap`、`treatment_choice`。宿主用已确认规格和决策去重；原稿自身有矛盾时优先给“保留不同人物口径”而非强迫新增机制。

有原稿明确答案的问题不应重新问；用户明确给过集数/时长，显示摘要可点击设定器修改，不再要求输入同一数字。修改设定器须沿已有影响预览/CAS，问卷自由文本不能偷改 preset。

方向四选只是已观测呈现；本次保持四个**讲法**候选，可有不同节奏/聚焦，不造四个不同故事。自填不设 300 字业务上限，不静默截断；传输大小是另行可见的技术边界，长内容转附件/分块并保留原文。

`PlanningDecision` 冻结全部回答、checkpoint/version/payload hash 和 actor；最终提交才推进，选项翻页/返回/忽略均不收费。先已有设定后问题仍重复是测试失败，不靠 UI 隐藏问题后仍让服务端要求必答。

### 6.3 初稿结束与后续流转

`WAIT_OUTLINE` 保存同一份候选 AST/索引/报告；画布、文件卡、全屏编辑器读取它，不等待用户接受才让文稿“可见”。明确标记“待审草稿已保存”。

提供：查看大纲、继续调整、接受草稿并停留。接受后显示“继续准备人物/场景/道具”“规划分集”等现有可用动作；按钮只预填或进入对应费用预览，不自动购买。当前 `READY` 的“正文仍走单文档兼容入口”不能再作为新大纲成功后的用户文案；兼容说明收进技术详情，未实现操作必须明示，不用假按钮。

### 6.4 新状态如何进入现有 `workflow.py`

`schemas/planning.py` 的阶段/检查点 union、`workflow.py::record_planning_output/_queue_next/_decide/advance` 以及 `PlanningWorkflow.tsx` 必须一起扩展，不能仅在 UI 写一个 `WAIT_FACTS` 字符串。短来源先支持单个 M04/M05 任务；§13 再把同 stage 多块展开成持久 job。

| 状态/事件 | 宿主动作 | 下一状态/约束 |
|---|---|---|
| 改编预算批准 | 冻结来源、M04/M05/M03/M07/M12 顺序和费用范围；命中有效来源缓存则展示复用 | 只派发已批准子任务 |
| M04/M05 覆盖不完整 | 保存错误及已完成范围 | 阻止大纲；修复后续跑，不伪装成问卷 |
| 完整来源存在关键歧义 | 建立检查点，问题引用 claim IDs/source hash | `WAIT_FACTS`，不调用 M07 |
| `planning.decide` 回答事实问题 | 按现有检查点命令封装，校验 checkpoint ID/resume token/payload hash；写 FactResolution artifact | 保留归属/不明确可继续；新改编许可必须展示改变了什么 |
| 事实门满足 | 复用或派发 M03，已确认规格不重复问 | `WAIT_DIRECTION` |
| 方向确认 | 冻结选择的讲法，不把方向中的剧情推断变来源事实 | M07，然后独立 M12 |
| M07/M12 完成 | 同步候选 AST/索引/报告到 checkpoint payload | `WAIT_OUTLINE`；已知硬错不得接受，可继续打磨 |
| 接受草稿 | `_decide` 事务内验证候选 hash/报告/源和规格仍有效，再走唯一正文写口 | `READY`，不自动启动筹备/媒体 |

`planning.decide` 是现有 `PlanningDecision.type`；扩展 `_decide` 的 `WAIT_FACTS` 分支，复用 `decision='select'` 与 `answers`，每题必须匹配检查点允许的 question/claim IDs，不能混入不在题目里的事实批准。检查点回答必须具备幂等回执；刷新/翻页不能制造新子任务。源或规格变更使已冻结的计划失效时，沿既有修改预览再批准新依赖，不把新任务塞进旧许可。

## 7. 局部修改合同：先固定范围，再让模型写 patch

### 7.1 基线与修改意图

新增 `schemas/outline_changes.py`。一条指令包含 `scope`：全文大纲、指定节、稳定选区；用户只选中一句时，模型不能以“保持一致”偷偷改其余节。发现跨节依赖必须显式列出影响，用户确认扩大范围后新报价。

`revisionIntent` 绑定 instruction hash、baseVersion、**AST contentHash + semanticHash**、sourceGraph hash、spec/direction/decision hash。只绑定 semanticHash 不够：格式/块 ID 变化也可能使选区失效。

```python
from typing import Literal
from pydantic import Field
from .common import ContractModel, Identifier, NonNegativeInt, PositiveInt, Sha256


class PatchTextBlock(ContractModel):
    type: Literal["heading", "paragraph", "list", "raw"]
    text: str
    level: int | None
    line_break: bool


class OutlineHunk(ContractModel):
    id: Identifier
    section_key: Literal["overview", "adaptation", "chapters", "hooks", "boundaries"]
    target_block_ids: list[Identifier] = Field(min_length=1)
    before_hash: Sha256
    after_blocks: list[PatchTextBlock]
    changed_claim_ids: list[Identifier]
    reason: str


class PatchSummary(ContractModel):
    text: str
    hunk_ids: list[Identifier]


class OutlinePatchDraft(ContractModel):
    contract: Literal["outline-patch/1.0.0"]
    base_version: NonNegativeInt
    base_ast_hash: Sha256
    base_semantic_hash: Sha256
    hunks: list[OutlineHunk]
    change_summary: list[PatchSummary]
    unresolved_requests: list[str]
```

模型目标 ID/beforeHash 从宿主给出的候选范围取值；model 返回的 hash 必须与宿主值相等，不能让模型自己算 hash 再相信它。宿主生成 changesetId、正式 hunkId 映射、新 block ID、createdAt、质量状态与依赖组；模型 hunk key 只用于本回包关联，去重后映射。

第一版 operation 只有**连续 block 范围替换**：删除用空 `after_blocks`；插入通过替换包含锚点的范围并保留锚点原内容。显式重排由多个受审核的范围替换组成依赖组，不使用无限制 JSON Pointer/正则替换/模型可执行脚本。后续如需要独立 insert/move，另增版本及冲突测试，不悄悄放宽当前合同。

PatchTextBlock 为模型提案文本；实际 Block 仍由宿主 AST adapter 创建。需要粗体/列表的内容走安全 Markdown 单块解析与 round-trip 检查，不把 Markdown 标记误存成可执行 HTML。不支持形状保留 raw 并标未知，不能悄悄去格式。

### 7.2 核心纯函数（`outline_patch.py`）

```python
def apply_outline_hunks(base, hunks, allowed_block_ids, section_index):
    # 初版只处理交付器生成的 flat AST；嵌套旧文档先走显式适配。
    if any(block.children for block in base.blocks):
        raise ValueError("OUTLINE_PATCH_REQUIRES_FLAT_INDEX")
    slots = {block.id: i for i, block in enumerate(base.blocks)}
    occupied = set()
    edits = []
    for hunk in hunks:
        ids = hunk.target_block_ids
        if len(set(ids)) != len(ids) or not set(ids) <= set(slots):
            raise ValueError("OUTLINE_PATCH_TARGET_INVALID")
        indices = [slots[block_id] for block_id in ids]
        if indices != list(range(indices[0], indices[-1] + 1)):
            raise ValueError("OUTLINE_PATCH_RANGE_NOT_CONTIGUOUS")
        if not set(ids) <= allowed_block_ids or occupied.intersection(ids):
            raise ValueError("OUTLINE_PATCH_SCOPE_OR_OVERLAP")
        require_same_section(ids, hunk.section_key, section_index)
        before = base.blocks[indices[0]:indices[-1] + 1]
        if block_range_hash(before) != hunk.before_hash:
            raise ValueError("OUTLINE_PATCH_BEFORE_MISMATCH")
        after = materialize_blocks(hunk.after_blocks, previous=before)
        edits.append((indices[0], indices[-1] + 1, after))
        occupied.update(ids)
    result = list(base.blocks)
    for start, end, after in sorted(edits, key=lambda edit: edit[0], reverse=True):
        result[start:end] = after
    return DocumentAST(blocks=result)
```

`block_range_hash` 用实际 Block 的规范化 JSON（含 marks/attrs/lineage/顺序），不是只算可见文字。`materialize_blocks`：完全未改块保留同对象/ID；替换保留可明确一对一的 lineage；拆合新 ID；不接受模型覆盖邻接块。`require_same_section` 使用绑定本 base hash 的索引，不能以模型自报 section 为准。

五节标题、宿主参数块为受保护结构；用户明确要改文档结构时走新的布局意图，而不是默认大纲润色有权限删节。普通语气修改不得顺手改目标时长、来源或确认状态。

### 7.3 全文一致性不能只查 patched blocks

生成 patch 前构造 `occurrenceIndex`：每个来源事件/实体/用户约束在哪些段落出现。补丁带 changed claim IDs 只是线索，宿主还对比前后全文并核对所有叙事段；模型可能漏报 changed claim。

同事实的两处修改若必须一起发生，形成不可拆依赖组。不能因为“每节只改一处”就让五节成为五个天然独立组；UI 节数与事务组数是两个维度。

## 8. 持久化、CAS 和部分接受的完整算法

### 8.1 存储选择（新增 `migrations/outline_v3.py`）

推荐同一 Director SQLite 增量建表，复用 `director_artifacts` 存不可变候选 AST/索引/事实图，专表仅保存 review envelope 与决定。不是替换数据库。实施前按此方案确认 API/迁移变更；当前文档不执行迁移。

```sql
CREATE TABLE IF NOT EXISTS director_outline_changesets (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  document_id TEXT NOT NULL REFERENCES director_document_ids(id),
  operation_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  base_ast_hash TEXT NOT NULL,
  base_semantic_hash TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  source_graph_hash TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  head_version INTEGER NOT NULL,
  head_ast_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('pending','resolved','stale','blocked')),
  created_at REAL NOT NULL,
  UNIQUE(work_id, operation_id, document_id)
);

CREATE TABLE IF NOT EXISTS director_outline_decisions (
  changeset_id TEXT NOT NULL REFERENCES director_outline_changesets(id),
  group_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
  actor TEXT NOT NULL,
  command_id TEXT NOT NULL,
  document_version INTEGER,
  created_at REAL NOT NULL,
  PRIMARY KEY(changeset_id, group_id)
);
```

`proposal_json` 内含不可变 hunks、宿主依赖组、summary、candidate artifact ref。接受记录不可覆盖为拒绝；撤回已接受内容必须形成新逆向变更（见 §8.4）。客户端不能指定 JSON SQL 或跨项目 document ID。schema 迁移注册须可重复执行；在 store 初始化时显式调用，不依赖用户先打开费用页才建表。

采用现有 `director_document_commands` 保存幂等响应，新增 payload 类型；不新建第二个只靠浏览器内存的重试 ledger。模型 original raw output、费用、候选写入必须在 `ExecutionRepository.complete` 的同一事务闭合；格式/事实失败原回包保留，即使不产生可采纳 CS。

### 8.2 预检与提交分开，报告绑定最终组合

新增 `outline_changes.py::prepare_decision/commit_decision`：

```python
def prepare_decision(change, prior_decisions, requested, latest, reports):
    require_exact_review_head(change, latest)
    cumulative = merge_explicit_decisions(prior_decisions, requested)
    # 接入现有 prepare_change_selection；输入 baseVersions 取当前审阅 head。
    accepted = validate_dependency_closed_selection(change, cumulative, latest)
    if accepted == accepted_groups(prior_decisions):
        # 纯拒绝不改变正文，不应为了丢弃建议收费审稿。
        return freeze_rejection_only_decision(change, cumulative, latest)
    # 总是从 immutable base + 累积接受集合重建，不在移动的字符串上叠贴。
    candidate = apply_accepted_from_original_base(change, accepted)
    candidate_hash = object_hash(candidate.model_dump(by_alias=True))
    report = find_report_for_combination(
        reports, change, accepted, candidate_hash
    )
    if report is None:
        # 外层服务保存候选artifact，再返回可报价目标；此结果不可commit。
        return freeze_review_required(change, cumulative, candidate)
    reject_known_hard_failures(report)
    return freeze_prepared_decision(change, cumulative, candidate, report)


def commit_decision(db, store, actor, command, prepared):
    replay = lookup_document_command(db, actor, command)
    if replay is not None:
        return replay
    require_prepared_hash(command, prepared)
    require_transaction_versions(db, command, prepared)
    if prepared.changes_document:
        require_report_still_current(db, prepared)
    result = (
        commit_verified_ast(db, store, prepared)
        if prepared.changes_document
        else current_document_receipt(db, prepared)
    )
    persist_group_decisions(db, actor, command, prepared, result)
    advance_review_head(db, prepared, result)
    append_decision_event(db, command, prepared, result)
    remember_document_command(db, actor, command, result)
    return result
```

辅助函数职责必须实现而不是留 `pass`：权限在 API 和 repository 都按 work/doc 范围检查；request hash 包含 actor/command/payload；准备 receipt 绑定 base/head/spec/source/method/候选/hash/决定集合；事务内复查报告未过期。DB 事务内不发模型网络请求；需要新的语义核对时提前报价/执行，保存 prepared result 后再 CAS 提交。

报告绑定 `acceptedGroupIds` 的**累计集合及 candidateHash**。检查“全部接受”的报告不能用于“只接受第 2 节”。可确定性复用完全无事实变更的组需有测试证明；其余组合需要新的核对或逐项人工证据，UI 标“组合待复核”，不能自称结构过关即语义过关。新核对收费可纳入提前展示的父预算，超出再确认，不按每个按钮暗中买一次。

### 8.3 避免第一个组接受后，其余组全变过期

CS 保留 original base 永不改变，同时维护 `headVersion/headAstHash`：

1. 第一次接受 A：从 original base+A 得候选，CAS old head，保存 v+1，head 更新 v+1。
2. 接受 B：只有当前文档等于上次本 CS 写出的 head 才能继续；重建 original base+A+B，检查组合，再写 v+2。
3. 其他编辑器写了 v+2 或用户手工改了正文：即使文字“看起来差不多”，CS 变 stale；禁止静默 rebase。提供保留本地稿、读新版本、重新预览修改。
4. 拒绝未接受组：只记录决定/CS revision，不写正文新版本；拒绝前置会影响依赖组，提示一并撤回并等用户明确选择。
5. 接受所有剩余组：一次准备、一次事务，非客户端连发五次 bool 请求。
6. 原文没有变化的空 patch：保存“无需修改”消息和模型回包，不制造空 DV/空差异、假“已修改五处”。

`workRevision` 会因其他文档或设置动作变化；允许哪些变化可重用 prepared plan 必须以明确 dependency refs 验证，首版保守 409 并重预览，不能偷偷覆盖。仅更换下一次模型不改变正文事实，但旧费用仍绑定原模型。

### 8.4 撤回的语义

- 未接受的“撤回本节/全部撤回”＝拒绝 pending suggestion，不改当前正文，也不删除费用/回包。
- 已接受后的“撤销这次修改”＝新 inverse candidate，绑定当前版本并重新检查后接受；不是恢复旧数据库文件或把版本指针倒退。
- 用户在富文本里 `Ctrl/Cmd+Z`＝本地编辑历史，经自动保存产生正常版本，不撤销模型账单。
- 关闭窗口/ESC 不等于拒绝，刷新仍恢复 pending 与各组决定。

### 8.5 单一 AST 写入口

新增 `repository.py::write_verified_ast`，把 `write_ast` 现有插表/hash/失效逻辑提取出来；`write_ast(text)` 解析后调用它。`store._put_document` 增加内部 keyword-only `ast` 或新增 `_put_verified_document`，二者最终委托同一事务实现：

```python
def write_verified_ast(db, work_id, key, version, ast, origin):
    # 实现沿现有 write_ast 的身份检查、唯一版本及 invalidate 路径。
    validate_document_identity(db, work_id, key)
    payload = ast.model_dump(mode="json", by_alias=True)
    persist_ast_version(db, work_id, key, version, payload, origin)
    invalidate(db, work_id, document_id_for(db, work_id, key))
    return render_markdown(ast)
```

事务仍写兼容 `document_versions/documents`、works revision、document.versioned 事件；不能只往 `director_document_asts` 插一行导致画布还读旧 Markdown。未改块 ID 与 lineage 验收必须在**重新读取数据库之后**断言，而非只测纯函数。

## 9. API 与前端状态合同

### 9.1 现有入口继续复用

基路径 `/projects/{project}/director`，实际 API 全局前缀由当前路由注册负责，不在客户端硬写第二套：

| 入口 | 现有/新增 | 用途 |
|---|---|---|
| `POST /v2/planning/commands` | 现有 | 首次方向/大纲父计划、问卷决定 |
| `POST /v2/approvals/commands` | 现有 | `cost.quote` / `approval.grant`，用于修改或独立核对报价/批准 |
| `POST /v2/runs/{run_id}/commands` | 现有 | `run.cancel` / `run.resume`，路径 run ID 与 payload 必须相同 |
| `GET /v2/works/{work_id}/events?after_seq=…` | 现有，`after_seq` 为非负整数 | 增量/恢复，只读不生成 |
| `GET /v2/works/{work_id}/runs/{run_id}/result` | 现有 | 查询留存的模型结果，不重发生成 |
| `POST /v2/documents/commands` | 现有文档命令入口扩展 | 接受/拒绝 groups，沿幂等表 |
| `GET /v2/works/{workId}/outline-changes/{changeId}` | 新增 | 获取 base/candidate/diff/groups/decisions/quality |
| `POST /v2/works/{workId}/outline-changes/{changeId}/prepare` | 新增，只做无收费预检 | 冻结决定组合、核对是否需要语义审查；不自行发模型 |

以上现有路径已对照 `api/routes/director.py` 的装饰器核实；新增路由只做鉴权、严格解析、调用领域服务、错误码映射。花括号字段遵循各自路径参数定义；现有 transport 不改名。新命令 payload 如下，标识符为示例而非实际用户资料。

```json
{
  "schemaVersion": 2,
  "commandId": "cmd-review-01",
  "clientRequestId": "intent-review-01",
  "sessionId": "session-review",
  "workId": "work-demo",
  "expected": {
    "workRevision": 12,
    "documentVersions": {"doc-outline": 3}
  },
  "payload": {
    "type": "outline.decideGroups",
    "documentId": "doc-outline",
    "changeSetId": "change-01",
    "expectedChangeRevision": 2,
    "preparedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "decisions": [{"groupId": "group-01", "decision": "accept"}]
  }
}
```

新增 `OutlineDecideGroups(WireContract)` 进入 DocumentCommand 的 discriminated union。required 的 type/documentId/expectedChangeRevision/preparedHash/decisions 全部宿主校验；max 长度属于抗滥用传输保护，应有明确错误及分页/分批策略，不反向修改故事时长。

### 9.2 错误码与恢复动作

| code | HTTP | UI 行为/是否自动调用模型 |
|---|---|---|
| `OUTLINE_CONVERSION_REQUIRED` | 409 | 预览旧稿转换；不自动买新稿 |
| `OUTLINE_PATCH_TARGET_INVALID` / `OUTLINE_PATCH_SCOPE_OR_OVERLAP` | 422 | 保留回包、指出目标/范围错误；无自动重购 |
| `OUTLINE_REVIEW_HEAD_CHANGED` | 409 | 本地稿可下载；读新版本重预览 |
| `PARTIAL_ATOMIC_GROUP` / `DEPENDENCY_GROUP_INCOMPLETE` | 409 | 展示关联范围，用户选择整组/取消 |
| `OUTLINE_COMBINATION_REVIEW_REQUIRED` | 409 | 显示缺的核对证据；费用预览后才能模型核对 |
| `OUTLINE_FACT_CONFLICT` | 409 | 定位真实矛盾；保存待审但不标合格 |
| `SOURCE_TAIL_MISSING` / `SOURCE_AUDIT_INCOMPLETE` | 422 | 列出未处理范围，恢复已授权剩余块 |
| `IDEMPOTENCY_CONFLICT` | 409 | 不复用同 key 不同 payload；原意图结果仍可查 |
| `STATUS_UNKNOWN` | 409 | 只查原操作，不生成新意图“重试” |

补齐 zh/en/vi 的 `director.execution.errors.*` 和 review 文案。未保存、已保存候选、待审、组合待核验、已接受草稿、已定稿须分开，不显示笼统“成功”。

### 9.3 旧 bool 接口不可成为绕过入口

`store.decide_change` 和旧 `/changes/{id}/decision` 保持处理旧 `changes`；遇新式 outline CS 返回升级提示。所有 `_ensure_writable`、`dispatch` pending 查询、定稿门、作品 detail 的 pending 投影同时检查新表，不能只在新前端禁按钮。

`ExecutionRun.changeId` 新增可选 `proposalContract`/类型化 proposal ref；后端不可用同 ID 让旧 UI 误当全文接受。旧历史展示仍可读，读旧回执不会自动迁移或调用模型。

### 9.4 候选复核如何真正走到模型，而不是被 pending 门锁死

当前 `QuoteWriting(purpose='review')` 只允许 outline/episode 且 instruction 为空；这个约束保留。新增可选 `reviewTarget`，省略时仍核对保存稿。不能把待审 AST 填进自由文本 instruction，绕过冻结和归属检查。

```python
class OutlineCandidateReviewTarget(WireContract):
    kind: Literal["outline_candidate"]
    candidate_artifact_id: Identifier
    candidate_hash: Sha256
    change_set_id: Identifier | None
    accepted_group_ids: list[Identifier]


class QuoteWriting(WireContract):
    # 保留当前 cost.quote 的所有既有字段和 episode_only 校验。
    review_target: OutlineCandidateReviewTarget | None = None

    @model_validator(mode="after")
    def candidate_review_only(self):
        if self.review_target is not None and (
            self.purpose != "review" or self.kind != "outline" or self.instruction
        ):
            raise ValueError("CANDIDATE_REVIEW_REQUIRES_OUTLINE_REVIEW")
        return self
```

此处是**增量字段片段**，不是用这个片段替换完整 `QuoteWriting` 类。初稿目标引用 checkpoint 中真实候选，`changeSetId=null`、`acceptedGroupIds=[]`；修改组合目标由 `prepare` 确定性重建并保存 artifact 后返回。客户端只能原样回传目标引用，不能把任意作品 artifact 指为自己的候选，也不能自己把审核结果标 PASS。

接线顺序及安全边界：

1. `prepare` 遇缺报告时先持久化不可变组合候选，返回 `reviewRequired=true`、目标引用及缺失检查；不返回假可提交 `preparedHash`。纯拒绝走 §8.2 无费路径。UI 用候选引用调用既有报价入口。
2. `execution.py` 报价时由宿主查 artifact/CS/checkpoint，验证 work/document/actor 权限、累计组闭包及 head/source/spec；`freeze_outline_candidate_inputs` 读取该 AST 全文，冻结 target、候选/来源/方法 hash、预算到执行参数。批准仍绑定原 request hash。
3. `dispatch.py` 当前 pending 拦截需要拆成“会写正文的运行”和“只读候选审查”。只有通过上述验证、`purpose=review` 且 target 与待审 CS/checkpoint 完全匹配的审查可在 pending 时执行；新草稿/修改仍被拦截。不能简单删除 pending 条件。
4. `ExecutionRepository.complete` 对该运行只保存 raw/usage/审查 artifact 和完成事件，不创建 `changes`/CS、不写正文。M12 报告绑定 `candidateHash + acceptedGroupIds + sourceGraphHash + specHash + methodHash`；修改候选、补充用户授权后旧报告不可冒用。
5. 完成后 UI 重新 `prepare`；报告合格才得到可提交 receipt。期间有人改稿或调整组集合则重预览，既有审查结果留存但不得用于错误版本。相同 hash 的有效报告可复用，不暗中重复扣费。

初稿 M12 作为父计划可见子 job 使用同一冻结/验证器；`WAIT_OUTLINE` 接受也验证报告绑定，不能只有 patch 分支过门。旧保存稿审查保持原合同，不受新候选字段影响。

## 10. 格式、事实、文学三道门分开

### 10.1 确定性门（不收费）

新增 `outline_validation.py`；复用现有重复 JSON key 拒绝、provider strict、宿主 Pydantic、ID/版本检查：

1. schema 精确字段/类型，非空、完整结束、无重复 key；不以自动删多余字段“修好”回包。
2. 五节齐全、宿主规格逐字段一致；来源引用存在、引文 hash/范围正确。
3. 篇章引用真实 episode IDs，无漏集/越界；顺叙要求检查已确认事件关系，原文非线性不以文本序号盲判。
4. patch ID/范围/hash/受保护块/授权范围正确；未触及块逐字节及 ID 不变。
5. 同实体展示名/别名有依据；可确定的重复、额外钩子范围等结构约束精确检查。
6. 全文组装无重复五节、重复标题、截断尾段；候选 hash 与待审 UI 内容一致。

“引用存在”只证明引用真实，不证明这句话支持模型断言。对数字、否定、动作完成状态、主观陈述升客观规则等仍进入语义门，不能把 JSON PASS 显示成“忠于原著”。

### 10.2 全文语义核对（只用 Seed 的独立上下文）

扩展现有 `outline_review.py`，新增 `freeze_outline_candidate_inputs`：输入候选 AST 而非仅保存稿；复用来源义务与 ground 机制，但不能只扫一个 synopsis。

```python
def build_candidate_obligations(ast, source_graph, instruction, bindings):
    prose_units = narrative_units(ast, bindings)
    return {
        "candidateHash": object_hash(ast.model_dump(by_alias=True)),
        "units": prose_units,
        "sourceClaims": source_graph.claims,
        "eventOrder": source_graph.approved_order_edges,
        "instruction": instruction,
        "requirements": derive_user_obligations(instruction, source_graph),
    }
```

`narrative_units` 覆盖各节所有陈述剧情的段落/列表/标题；禁区和自评不作为“剧情已经兑现”的证据；其中新增剧情主张仍要检测。标题“某人已归来”也可含事实，不一概跳过 headings。引文精确落在 AST projection 并记录 block/offset；diff 中红色删除文本不进入候选审核。

报告逐义务输出 `SUPPORTED/VIOLATED/UNCERTAIN/NOT_APPLICABLE`、原文/候选双向引用、理由、影响块。结构缺项只把该项标不可用，不能吞掉其他有效 VIOLATED。完整覆盖也最多 `REVIEWED`，不是模型自签“100%事实正确”。

生成模型输出的 `claim_ids` 与人工黄金映射不能作为唯一查漏清单；评审必须从最终段落独立提出具体主张再对照，否则模型漏标的错误永远检测不到。M05检查原稿→事件图，M12检查最终文稿→原稿，两者分工不同，不能用一个报告充两道门。

### 10.3 修改后继续验证，而不是“花钱失败就算了”

失败闭环固定为：保留原回包 → 分类（输入/合同/技能/投影/宿主/模型遵循）→ 最小离线反例 → 改源头 → 回归 → 新意图 Seed 真实复验 → 全字段人工对读。没有根因改动和明确假设，不盲目重复同一请求赌成功。

无效格式不产生可接受文稿；内容有已知硬错则保留可查看候选，禁止标成合格/推进下游；用户手工输入始终可保存在私有草稿，不因为模型门而丢字。允许用户明确批准艺术加工，但它是新的 FactResolution/规格决定并重新核对，不能“勾选忽略错误”却仍显示严格保真。

### 10.4 文学质量的人工可复核标准

| 维度 | 要看什么 | 失败例 |
|---|---|---|
| 因果与动机 | 行动由已知处境推动，结果真实改变状态 | 用“为了主题”代替人物动机 |
| 情绪递进 | 安逸→惊觉→惊惧→回归→回甘自然衔接 | 五节反复重复同一句主题口号 |
| 场面具体性 | 可感知但不添无来源物理动作 | 为生动擅加触碰、追逐、旁观群众 |
| 信息释放 | 人物认知按时间推进，歧义合理保留 | 前段知道后段才揭示的信息 |
| 表达与节奏 | 语句自然、篇章负担合宜、结尾有余味 | 标题/正文模板化，强行“大反转/付费点” |

上表是《入画》诊断观察点，不是另一套评分维度。归入policy.literary五维：因果/信息释放→causality_continuity，人物情绪/表达→character_dialogue，信息节奏→pacing_closure，志怪语气/主题余味→style_audience，场面/时长→filmability_execution；一个例子可注明多个维度，但不重复加权。先剔除硬错，评分/评审人数/阶段与全量样本只依[验收§5](acceptance-contracts.md)及[policy](acceptance-policy.json)，每项给段落证据，不能平均分抵销来源违反。大纲目标时长不等于排演实测；当前仅Seed，不新增第二模型。

## 11. UI：五节目录、逐节差异、自动保存和聊天共存

### 11.1 新组件与现有组件职责

| 文件（前端 director 域） | 精确职责 |
|---|---|
| 新 `components/OutlineChangeReview.tsx` | 读服务端 base/candidate/组决定；五节差异视图，不自行应用正式修改 |
| 新 `components/OutlineReviewToolbar.tsx` | 上一节/下一节、当前节数、接受全部/撤回全部及状态 |
| 新 `useOutlineChangeReview.ts` | 查询/prepare/commit、持久 pending command、CAS/断线恢复 |
| 拟改 `components/DirectorDocumentEditor.tsx` | 同一个编辑器壳的 edit/review 两种模式；聊天和目录不重建 |
| 拟改 `components/DirectorRichText.tsx` | 稳定块与 decoration 适配；选区不能把 diff 删除文本传成新正文 |
| 拟改 `DirectorStudio.tsx` | 移除新式稿的重复全文 modal 分支，按 proposalContract 路由 |
| 拟改 `components/PlanningWorkflow.tsx` | 初稿文件卡/待审状态/继续改稿和后续按钮 |
| 拟改 `components/DirectorConversation.tsx` | 独立 changeSummary 和点击定位，不用 raw JSON 充聊天 |

### 11.2 交互状态模型

```ts
type ReviewState = {
  changeSetId: string;
  changeRevision: number;
  headVersion: number;
  status: 'loading' | 'reviewing' | 'preparing' | 'committing'
    | 'conflict' | 'blocked' | 'resolved';
  activeSection: 'overview' | 'adaptation' | 'chapters' | 'hooks' | 'boundaries';
  pendingIntent: { commandId: string; requestHash: string } | null;
};

type ChangeGroup = {
  id: string;
  hunkIds: string[];
  sectionKeys: ReviewState['activeSection'][];
  requiresGroupIds: string[];
  decision: 'pending' | 'accepted' | 'rejected';
};
```

状态以服务端为权威，localStorage/sessionStorage 只保存未收到响应的命令和设备视图偏好；不能直接把 optimistic accepted 显示为已保存。prepare/commit 成功回包带新文档/CS/work revision，统一更新缓存。断线用同 commandId 查询/重放，不重新生成。

### 11.3 按钮级操作表

| 控件 | 点击行为 | 禁用/失败/恢复 |
|---|---|---|
| 五节目录 | 滚动到真实 section anchor | 不换文档/不调用模型；重名小标题按 ID 区分 |
| 上一节/下一节 | 在有变更的节间导航，显示当前序号/总数 | 端点禁用；跨节依赖不改变导航顺序 |
| 本节接受 | 展示涉及组及跨节影响，prepare 后显式 commit | 未决关联不能暗选；质量失败定位提示 |
| 本节撤回 | 拒绝对应未接受组，必要时提示连带依赖 | 不删除已接受正文，不取消已收费运行 |
| 接受全部 | 一次提交所有尚未决定且依赖闭合的组 | 全文组合未核对时进入核对，不用单组 PASS 冒充 |
| 全部撤回 | 拒绝所有 pending，保留当前已接受版本 | 若已有部分接受明确说“撤回剩余建议” |
| 查看原稿/修改后 | 同一 frozen base 与候选之间切换 | 不能从 latest GET 混入另一个版本 |
| 继续调整 | 带当前 accepted head/明确候选范围预填输入 | 没有发送前不会收费；新修订基线必须明确 |
| 收起/打开聊天 | 共存于原位置，不挤窄正文 | 返回保留输入、滚动、当前节与未决状态 |
| 关闭编辑器/ESC | 退出视图，pending 留存 | 手工编辑先 flush；冲突不强关丢稿 |
| 自动保存标记 | 手工稿显示保存状态；候选显示已持久待审 | 不能因为看了候选就提交正式稿 |
| 原始请求/回包 | 展开真实模型/方法/schema/usage 安全明细 | 默认折叠；不显示鉴权/思考内容 |

新式候选审阅期间，当前文档的自动保存 hook 只保存用户**私有编辑稿**或保持只读 review，不能把含 diff decoration 的 editor `getText()` 当正式文稿提交。先处理/撤回提案再进入正式手编，是第一版明确边界；不得假称已支持“边改旧稿边自动三方合并”。

### 11.4 UI 骨架

```tsx
function OutlineReviewToolbar({ index, count, busy, blocked, onPrevious,
  onNext, onAcceptAll, onRejectAll, t }: ToolbarProps) {
  return <div className="dc-outline-review-toolbar" role="toolbar">
    <button type="button" disabled={busy || index === 0}
      onClick={onPrevious}>{t('director.outlineReview.previous')}</button>
    <span aria-live="polite">{index + 1} / {count}</span>
    <button type="button" disabled={busy || index + 1 === count}
      onClick={onNext}>{t('director.outlineReview.next')}</button>
    <button type="button" disabled={busy || blocked}
      onClick={onAcceptAll}>{t('director.outlineReview.acceptAll')}</button>
    <button type="button" disabled={busy}
      onClick={onRejectAll}>{t('director.outlineReview.rejectRemaining')}</button>
  </div>;
}
```

`ToolbarProps` 在组件定义，`count=0` 时不渲染导航（显示无变更），不能出现 1/0。键盘 Tab/Enter/Space/ESC 可达；diff 删除/新增同时用语义 `<del>/<ins>` 或等价辅助文本，不仅靠颜色。文字内容 React 安全渲染，不接 `dangerouslySetInnerHTML`。

### 11.5 像素值的使用规则

沿 `DESIGN.md` 已确认：680px 正文、52px 顶栏、168px 目录、15px/28px 正文、.01em 正文字距、标题 -.01em；1440 视口正文 x=380，1920 为 x=620。400×640 聊天浮窗及 z-index 50/55/70 分层不变。首次段距、空行数量必须由真实文档结构决定。

diff 颜色、按钮宽高、顶部审阅条位置、节内控制留白在实施时从已有截图/登录态 DOM 测量补入 DESIGN；**本方案不编造尚未测量的精确数值**。复用现有静态图标组件与资源清单，未核实再分发许可仍是发布门，不能因为用户要求对齐就写成已获许可。

## 12. 真流式与自然对话，不把 JSON 当回答

### 12.1 事件协议增量

复用 `ExecutionRepository.progress/event`、既有游标 API 和 `useExecutionStream`。新增事件 payload，schema_version 单独标记，不改旧 `text.delta` 含义：

```ts
type OutlineProgress =
  | { type: 'outline.section.delta'; runId: string; sectionKey: string;
      blockKey: string; text: string; provisional: true }
  | { type: 'outline.section.ready'; runId: string; sectionKey: string;
      candidateHash: string }
  | { type: 'outline.review.ready'; runId: string; changeSetId: string;
      changeRevision: number; qualityStatus: string }
  | { type: 'conversation.delivery'; runId: string; messageId: string;
      text: string; changeSetId: string | null; hunkIds: string[] };
```

seq 仍由数据库分配，前端按 workId/runId/seq 去重；刷新从游标读取，不能发新 POST。事件正文属于用户项目数据，API 继续权限检查；日志只写安全错误码。

### 12.2 结构化流如何做到真实且可恢复

新增 `outline_stream.py` 增量 JSON tokenizer：处理 split escape、`\\u`、中文多字节、引号/括号、重复 key；只提取 schema 白名单的面向用户正文路径，映射 section/block。**不能用正则从未闭合 JSON 任意拼内容。** 部分字段可显示为 provisional，但完整 host validation 前不能显示“已写完/可采纳”。

`run_bounded_outline_model` 增加 `on_delta` 与严格 response_format 的同通道流参数；`dispatch_writing` 不再把所有 stream 请求强制交给不带 schema 的通用函数。供应商通道不支持结构化流时，降级为真实阶段进度+完整段落完成后显示，明确非 token 逐字流；不能用前端 setInterval 假打字伪造验收。

断流/length：保留 raw prefix 和 provisional 预览，状态 incomplete，正式稿不变；取消后的晚到完整结果仍保留为历史，不自动采纳。阶段多次真实调用的 `section.ready` 是真实分段完成，不伪称同一次底层流。

### 12.3 聊天总结与正文分离

`changeSummary` 可以由同一次 patch 回包产生，宿主核验 hunkIds 存在，成功后单独 `conversation.delivery`；不额外买一个模型只为了说“已完成”。总结不许宣称未跑的审计或自动定稿；宿主前缀显示实际状态，例如“已生成修改建议，等待你确认”。失败时聊天显示具体问题/可查看回包，不将已完成局部删除。

对话分三层：可读请求/回应与文件卡为主；真实阶段活动可折叠；技术参数/用量/方法指纹二级展开。内部推理内容不展示。输入 Enter 发送、Shift+Enter 换行、IME composition 不发送；提交前读取实际编辑器状态和 attachments，测试包含多行、粘贴、富文本 chip、中文输入法。

## 13. 长文、预算和“不要人为限制创作”

### 13.1 不把创作规格和运行能力混为一谈

用户决定集数/时长/内容。后台输出预算是运行策略，不是剧情长度上限；默认 8192/12288/16384 仅是现有保守档位，不是已验证供应商最大能力。不能因额度不够把 600 秒改 30 秒或截掉原稿后半部分。

当前仍存在真实技术边界：单文档输入门、指令/来源大小、AST 1MiB/10k blocks、schema 中某些列表/集数上限。本文不谎称现已无限。实施时 `models.py`、`schemas/{foundation,planning}.py`、`skills/runtime.py::MethodContext`、前端设定器逐项做 limit inventory：移除无业务依据的创作上限；数据库/传输保护保留且提供可执行分块/附件/分册路径，不静默 clamp 或裁字。超出尚未支持能力必须在付费前说明，不说“无法支持”后仍收费生成半稿。

### 13.2 持久 job manifest，替代仅按 stage 去重

当前 workflow 用 stage 作为子任务键，不能支持多个 `M04` 来源块和多个 `M07` 交付块。新增 `planning_jobs` artifact/schema，child 唯一键调整为 `(budgetId, jobId)`，保留 stage 字段用于方法选择；旧计划没有 jobs 时按 stage 一次性确定性展开。

```json
{
  "contract": "outline-job-plan/1.0.0",
  "jobs": [
    {"id": "source.extract.0001", "stage": "M04", "dependsOn": [], "chunkIds": ["src-0001"]},
    {"id": "source.audit.0001", "stage": "M05", "dependsOn": ["source.extract.0001"], "chunkIds": ["src-0001"]},
    {"id": "outline.draft", "stage": "M07", "dependsOn": ["source.audit.0001"], "chunkIds": []},
    {"id": "outline.verify", "stage": "M12", "dependsOn": ["outline.draft"], "chunkIds": []}
  ]
}
```

示例省略预算，实际每 job 必须冻结模型/方法/schema/dependency hash、input/output预算、timeout、attempt 和授权父计划。短稿 M07 一次出五节；长稿经测量决定是否按篇章/节交付，**不默认五节等于五次调用**。内部 craft plan 复用，不让每节独立发明一次故事。

所有 jobs 依赖无环、输入完整、总调用和输出预算在父许可范围；请求上限不承诺账单硬封顶。M04/M05/M12 额外调用在预览可见。支持用户预批准本轮生成+核对+明确次数修订，减少每一步弹窗；不能把“有很多额度”实现为无穷自动重试。

### 13.3 超长与失败恢复的算法

1. 输入测量以实际 tokenizer/已验证能力为准；无 tokenizer 用保守估算并标明，不把 chars 当精确 tokens。
2. 完整来源写入 ownership manifest；每块 hash 检验，尾部也必须覆盖。
3. 持久每个输出部分和输入依赖；全图合并后做跨块核对，正文只读取通过门的当前版本。
4. 截断 job 的原结果永远留存，不能直接接一个“继续”拼进缺闭合 JSON；新 continuation job 以完整已校验边界和剩余覆盖范围编译，费用另计入授权。
5. 同一 job 的 uncertain dispatch 只查询原 operation；`UNKNOWN` 不通过创建另一个 job ID 绕过不重发规则。
6. 已明确失败且有新修复的 job 创建新 attempt，保留 parent/failure ref；成功兄弟 job 复用，不重买来源全链。
7. 所有 parts 验证齐全后才形成完整候选；任何关键块失败不能把开头冒充全文。
8. 总计划过大时展示分批预计调用/费用未知与剩余工作，不缩短用户作品；用户可中止，已付费结果可下载和恢复。

## 14. Seed ↔ Seed 的真实效果与像素验收

### 14.1 零费用先行，不省掉真实模型复验

先回放前轮六笔本地回包、原站 patch 漏改反例；回放是回归，不算新的模型样本。结构修复、scope/CAS/事务、流解析、UI 模拟先通过，再发新 Seed 请求。开发时临时服务隔离原项目数据库，先只读验证服务所有权，不重启用户无关进程。

成对控制项：原稿/概要 hash、brief、方向文字、集数/时长、结构、输出语言、禁止新增事项、修改指令 hash。问题本身不同可以记录，不硬改答案制造表面一致。LibTV 没有暴露的参数记 unknown，不能以本地默认温度填进原站栏。

### 14.2 付费实验最小阶段与退出条件

| 阶段 | 本地 | 原站 | 此步必须记录 |
|---|---|---|---|
| P-A 方向 | Seed 正常 UI M03/来源步骤 | 同概要进入 Seed 方向 | 实际问题、每次答案出站，重复问题/假前提 |
| P-B 初稿 | 新五节合同，只生成大纲 | 同设定生成大纲 | 所有调用、输出、文档五节与事件覆盖 |
| P-C 修改 | 同一窄指令生成 patch | 同指令打磨 | 修改前后、未改块、总结、scope、全篇事实 |
| P-D 审阅 | 逐节/关联组/全部接受与拒绝 | 对应可用原站动作 | 请求/返回、版本、刷新持久，无额外生成 |
| P-E 手编 | 改一句后再打磨 | 同样动作 | 新基线生效、旧报告失效，不丢手改 |
| P-F 泛化 | 既有异题材小样，仅 Seed | 可复用有效同条件基线，条件不符再采样 | 全部样本/失败，不挑选最好一次 |

先完成《入画》的 P-A–P-E，再扩大样本，不一次买完整剧集。每轮预先记录调用计划，遇内容问题先修后再测，不以花费过为理由弃置；遇未知计费状态停止该分支并查状态，不盲发。所有 failure 保留。没有费用结算就金额 unknown，而不是免费。

### 14.3 参数与返回保存规范

新增显式 opt-in harness `tests/director/seed_outline_parity.py`，沿生产 quote→grant→dispatch→候选→审阅链，不直连 Seed 绕过合同；运行目录必须新建且拒绝覆盖：

```text
output/.../<experiment-id>/
  manifest.json             # 版本、场景、hash、控制变量、授权范围
  inputs/                   # 实际摘要/brief/方向/修改，私人资料仅本机
  local/<operation-id>/
    request.json            # 完整冻结参数，不含 Authorization
    prompt.txt              # 真实编译结果
    response.json           # 原始业务回包/finish reason/usage
    events.json             # 持久事件，思考内容不公开展示
    candidate.json          # AST、索引、patch、报告引用
    assessment.json         # 结构/事实/文学各自判定与证据
  reference/
    requests.json           # 可观察真实出站；缺失明确标记
    tool-results.json
    before.md
    after.md
  screenshots/<state>/
  comparison.md
```

导出采用字段 allowlist；鉴权头/Cookie/签名 URL/本机绝对配置路径不入证据。已保留的失败数据不能修改为新版成功，离线重新核验另写 derived assessment。公开仓库只提交匿名反例、测试与安全聚合结论。

### 14.4 像素验收状态矩阵

视觉测试与文学测试分开：视觉使用**完全相同的合成正文与同一 diff**，文学使用各模型真实产物。相同字体/OS/浏览器/视口/DPR/缩放/主题、同一滚动位置，截图前等待实际资源就绪；不挪图片、缩放、裁关键 UI 或遮正文来过门。

| 状态 ID | 页面 | 必验交互 |
|---|---|---|
| V01 | 空作品/欢迎/来源附件 | Top8、设定器标签、Seed 选择、输入/发送 |
| V02 | 分页问卷 | 前后题、自填、忽略、提交、IME/换行 |
| V03 | 生成中 | 真进度/文稿预览/停止、无 JSON 泄入聊天 |
| V04 | 五节大纲节点 | 节点标题/日期/目录/右上编辑/媒体菜单不误发 |
| V05 | 编辑器聊天收起 | 全文五节、目录、空段、顶栏保存状态 |
| V06 | 编辑器聊天展开 | 叠层、正文不变窄、输入不遮操作 |
| V07 | 红删青增待审 | 顶部/节内控件、跨节组提示、逐节定位 |
| V08 | 部分接受后 | 当前 head、剩余 diff、刷新恢复 |
| V09 | 保存中/断网/409 | 不丢稿，冲突可达，不误标已保存 |
| V10 | 完成/继续修改 | 自然聊天总结、文件卡、下一步不自动付费 |

所有数值/视口/字体/DPR/状态门只读[acceptance-policy.json](acceptance-policy.json)的visual，算法以[验收§4](acceptance-contracts.md)为准。现有pixel_compare保留全页原始指标/差异图，局部仅诊断，不改门槛消除历史FAIL。动态双方必须同稳定态，否则not_comparable；Windows仍需实机，不以Mac窄屏代替。V01–V10是S1必测状态，不等到S5/S10才实现。

## 15. 兼容、迁移、下游与回退

### 15.1 四类已有数据分别处理

| 数据 | 行为 |
|---|---|
| 新 adaptation 无大纲 | 新生成合同，五节候选，再审阅 |
| 已有 v2 11 节大纲 | 原样可读/可导出；显式“转换为新版大纲”预览差异，未经批准不重排原稿 |
| 已有未知 Markdown/嵌套/raw | 无损保留，不能可靠映射时允许手动指定节边界或继续兼容模式 |
| 已有 pending 全文 changes | 继续旧合同接受/拒绝；不能后台转换成 v3 冒充原批准范围 |

转换优先零模型确定性映射可识别内容；缺失原文处理/授权字段显示未知，不补造。需要模型整理则报价，形成新的 conversion proposal，用户接受后才写新 DV。原 v2 回包/历史方法包不删除。

### 15.2 下游防止继续消费旧 M07

当前 `compile_planning(M08/M09)` 从 `artifacts['M07']` 取输入，而用户可能已手编 outline。新增 `current_outline_input(store, work_id)` 统一读取最新 canonical AST+有效 section/semantic snapshot；若 snapshot stale，先核验或明确以正文为输入重新建立，不退回旧 M07 JSON。

改编 v3 后，M08/M09/M11 使用一个带 contract/version/hash 的 `OutlineContext`，包含最新正文及可用事件索引；不要为兼容 v2 强填 oppositionTactic 等字段。已有单文档 M11 读取正式 outline 的路径保持，增加 hash 一致测试。所有已生成媒体/设计稿保留，但依赖已改的大纲时标 stale，不自动付费更新。

机械来源索引与完整人物/场景/道具设计分开：允许从已核对源图派生只读“素材索引”作为准备提示，不能写进正式设计稿使 UI 看似全都完成；索引创建不调用媒体模型，也不自动提升为 M08 设计结果。

### 15.3 上线与回退

新增宿主功能开关 `outlineDeliveryV3`，默认先隔离项目验证；开关影响新请求合同，不改历史。迁移先备份并核验 hash、运行可重入 migration、验证旧读写与新 CS；中断测试确认不留半表/半 receipt。

回退关闭**新生成**入口，保留新表、AST、费用与回包；已有 v3 文档仍可读/导出，旧 bool 接口继续拒绝绕过新 CS。不能回退到会把新版数据误当旧结构的二进制。部署时先明确原服务所在工作树、端口和数据目录，单独验健康和原项目；“测试目录成功”不等于用户 5173 已更新。

## 16. 按文件和依赖拆分的实施工作包

所有新增测试/指南在实施前补精确 claim；本文件列出的 planned 路径不代表本轮已取得业务写入许可。每批先审计本地 diff 与远端同类实现，再 acquire/preflight。

| 批次 | 写入文件/关键函数 | 交付/退出条件 | 依赖 |
|---|---|---|---|
| B00 基线冻结 | `tests/fixtures/director/outline-v3/` 内逐文件匿名 fixture；新增 `tests/director/test_outline_delivery.py`、`test_outline_patch.py` | 原反例稳定失败；请求/数据/方法与新旧合同矩阵；不变更业务 | 本方案确认 |
| B01 合同与投影 | 新 `schemas/outline_delivery.py`、`outline_delivery.py`；拟改 `outline.py` dispatcher | 五节要素/三语/初稿 AST/稳定索引/旧 v2；无假授权 | B00 |
| B02 来源事实 | 新 `schemas/outline_source.py`、`outline_source.py`、`source_audit.py`；复用 foundation/semantic_validator；拟改 `schemas/planning.py`、`workflow.py` | 单块覆盖/独立核对合同、WAIT_FACTS、歧义保留，不靠客户端审计标志；收费接线随B03，多块恢复随B09 | B00 |
| B03 方法与编译 | 新 `outline_compiler.py`；拟改 `planning.py`、`writing.py`、`workflow.py`、`skills/runtime.py`、`pinned.py` 与 §5 包文件 | 两入口同合同，条件加载根技能；单来源M04/M05/M03/M07计划实际可运行 | B01–02 |
| B04 Patch 纯逻辑 | 新 `schemas/outline_changes.py`、`outline_patch.py` | 范围/hash/未改块/段落多行/依赖组/emoji/空 patch | B01–02 |
| B05 事务/API | 新 `outline_changes.py`、`migrations/outline_v3.py`；拟改 `repository.py`、`store.py`、`schemas/documents.py`、`execution_repository.py`、`api/routes/director.py` | 同事务原包/CS；部分接受/拒绝/CAS/重放/旧入口不能绕过 | B04 |
| B06 全文核对 | 新 `outline_validation.py`；拟改 `outline_review.py`、`schemas/outline_review.py`、`quality.py`、`schemas/execution.py`、`execution.py`、`dispatch.py`、`execution_repository.py`、`workflow.py` | 初稿/候选/接受组合全段核对；候选报价与pending只读例外真实可达；有效FAIL不被丢掉；M12不自证 | B02、B04–05 |
| B07 流与聊天 | 新 `outline_stream.py`；拟改 `dispatch.py`、`writing.py`、`execution_repository.py`、前端 `useExecutionStream.ts`、`DirectorConversation.tsx` | strict+stream 同传、真正增量、summary独立、刷新只读 | B03、B05–06 |
| B08 UI 审阅 | §11 新组件/hook；拟改 `DirectorStudio.tsx`、Editor/RichText/PlanningWorkflow、`frontend/src/api/{director,director-execution}.ts`、`director.css`、`DESIGN.md`、三语 | 五节/分组控件真实可用、自动保存不采纳diff、所有V态 | B05–07 |
| B09 持久长文 | 拟改 `workflow.py`、`schemas/planning.py`、`output_budget.py`、`context.py`；新增 `schemas/outline_jobs.py`、`outline_jobs.py`；精确限制清单涉及文件另审 | jobId不混stage、尾部完整、unknown不重发、预算有界恢复 | B02–03、B06–07 |
| B10 下游/迁移 | 拟改 planning/writing/repository/migrations，新增 `outline_context.py` | 手改后不读旧M07、旧稿升级可取消、M08/M09/M11不退化 | B05–06、B09 |
| B11 效果验收 | 新 `tests/director/seed_outline_parity.py`，既有 live/preview/pixel harness；新增UI/集成测试 | 本地Seed↔原站Seed初稿/修改/恢复真实通过；多样本与全页指标 | B00–10 |

新测试精确候选：`tests/director/test_outline_source.py`、`test_outline_changes.py`、`test_outline_candidate_review.py`、`test_outline_stream.py`、`test_outline_jobs.py`、`test_outline_v3_migration.py`、`test_seed_outline_parity.py`；前端 `frontend/src/__tests__/director-outline-review.test.tsx`、`director-outline-stream.test.tsx`。既有 `test_workflow.py/test_documents.py/test_execution.py/test_skill_runtime.py/test_context.py` 和 director 自动保存/执行/富文本用例扩充，不删原断言换成功。

B批次是代码工作包，不是另一套产品排期；当前阶段依赖以[总案§12](full-replication-plan.md)与policy.stages为准。S1必须包含B00–B08、B10“下一次修改读取最新有效DV”的最小接口、B11的A样本真实阶段验收，通过[验收S1-01至S1-10](acceptance-contracts.md)全部用例；仅“接受→刷新”不够。B09长文及B10全下游迁移在开放对应能力前完成，B11完整质量集随S10收口；不可为了等待所有B00–10而延迟S1真实验证，也不能把部分采纳/断网/409留到S5。

原创不是本五节改编专项的默认复制品：S2另走原创预设→设定器→问答→证据匹配profile大纲，按S2-01至S2-06验收。当前与泛化/全量质量样本、模型、评分尺度和评审人数只以验收§5及policy.literary为准，本专项不得自定另一套门槛。

## 17. 测试用例与代码骨架

### 17.1 关键测试矩阵

| ID | 输入/动作 | 必须断言 |
|---|---|---|
| T01 | 同素材走 planning 与 direct 初稿 | contract/schema/来源/方法一致，只冻结范围差异 |
| T02 | adaptation 与 original | 五节仅改编，新旧互不误用 |
| T03 | 非人格化阻力、无反派 | strategy=N/A，不编有意布局；不要求写死亡代价 |
| T04 | 已给集数/时长/缺口处理 | 不重复询问，不偷改 preset |
| T05 | M03候选捏造事实被选择 | 讲法被确认，假事实不升级为源事实 |
| T06 | 任意来源块/尾部失败 | 全文门失败、不付费进入完整大纲 |
| T07 | 来源引用文本存在但不支持断言 | 确定性仅过引文，语义不能假PASS |
| T08 | 修改第二节，第四节仍有相反说法 | 全文组合报告指出未修改段；不能只审hunk |
| T09 | 漏/重复/未知 block，错beforeHash | 拒绝，无正文/费用重发副作用 |
| T10 | 重复同文段、中文/emoji/组合字符 | ID定位正确、UTF16与source codepoint分别验证 |
| T11 | 一段多行与空行/列表/marks | 无损、未改字节/块ID不变，DB回读仍一致 |
| T12 | 改名两个节只接受一个 | 依赖组不闭合拒绝；明确整组后才可提交 |
| T13 | 接受A再B | 从original base累积、head正确，无自造版本冲突 |
| T14 | 中途别人编辑 | 409、保留本地稿与原CS，无静默覆盖 |
| T15 | 同命令双击/丢响应重放 | 仅一新DV/一次决定，响应一致 |
| T16 | 同key不同payload | 冲突，不能把第二次意思当第一次成功 |
| T17 | 插AST后/决定前故障 | 所有表回滚，费用原回包不丢；按既有完成事务设计注入 |
| T18 | 拒绝剩余/关闭/刷新 | 已接受正文不倒退，待审/决定和调用数正确 |
| T19 | 全部接受报告用于部分组合 | hash/集合不符拒绝，需该组合核对 |
| T20 | 手工编辑后再M08/M11 | 读取新AST，旧craft/事实报告stale，不用旧M07 |
| T21 | stream分块escape/think/schema | 正文真实增量，strict仍在线，推理与JSON不进聊天 |
| T22 | length/取消/迟到成功/UNKNOWN | 半稿不接受、旧回包留存、无新收费请求 |
| T23 | 源1块→2块、已完成块恢复 | job key稳定，依赖hash改变正确失效，不重复调用成功块 |
| T24 | 旧v2/未知raw/pending全文升级 | 不自动改稿/定稿/调用模型，原文与历史hash保留 |
| T25 | viewer/跨项目/错workDocument | 403/404，不能靠知道ID读私稿或决定 |
| T26 | 切作品时晚到请求/事件 | 不串稿/不覆盖当前editor，游标隔离 |
| T27 | 输入法、多行、自填>300字 | 不提前发送/截断，实际出站与编辑器文字一致 |
| T28 | 1/600/5400秒与多集 | UI→preset→quote→provider不静默改值；长篇走计划 |
| T29 | 内容已经正确，空patch | 无假修改、无空版本，独立说明可见 |
| T30 | 原站diff含已删错误句 | 审核after AST，不把删除文本误算当前错误；真正未删错误仍检出 |
| T31 | 全部/部分纯拒绝，暂无合格语义报告 | 只写决定/CS revision，不调模型、不新增DV；允许丢弃坏提案 |
| T32 | pending期间请求候选核对/新草稿 | 仅绑定当前候选的只读review放行；错误target/跨作品/新写作仍拒绝 |
| T33 | M12完成后换组集合/改来源/改稿 | 原回包保留、报告失效；不能用旧PASS提交新组合或初稿 |

### 17.2 pytest 骨架（拟新增测试，不是当前运行结果）

```python
def test_patch_does_not_rewrite_untouched_blocks(outline_case):
    base, patch = outline_case.base, outline_case.patch_second_section
    candidate = apply_outline_hunks(
        base, patch.hunks, outline_case.allowed_ids, outline_case.index
    )
    untouched = outline_case.untouched_block_ids
    before = {b.id: b.model_dump() for b in base.blocks if b.id in untouched}
    after = {b.id: b.model_dump() for b in candidate.blocks if b.id in untouched}
    assert before == after


def test_partial_accept_is_idempotent(review_service_case):
    case = review_service_case
    first = case.execute(case.accept_group_a)
    replay = case.execute(case.accept_group_a)
    assert replay == first
    assert case.document_version_count() == case.before_count + 1
    assert case.provider_call_count() == 0  # 此fixture的组合报告预先合法留存
    assert case.read_document().ast == case.expected_after_a


def test_corrected_chapter_does_not_hide_wrong_overview(candidate_review_case):
    report = candidate_review_case.review_anonymous_replay()
    assert report["status"] == "FAIL"
    assert "overview-order" in report["failedObligationIds"]


def test_reject_bad_proposal_does_not_require_paid_review(review_service_case):
    case = review_service_case.without_candidate_reports()
    result = case.execute(case.reject_all)
    assert result["proposalStatus"] == "resolved"
    assert case.document_version_count() == case.before_count
    assert case.provider_call_count() == 0
```

fixture 必须真实调用纯函数/repository/验证器，而不是自己硬写 report 后 assert 同一字典；语义回放和真实 Seed 样本分别统计。T08 用故意漏改摘要的匿名回包验证引证/覆盖，再在真实模型实验检查能否实际检出，不能以模拟 evaluator证明模型能力。

### 17.3 前端集成骨架

```tsx
it('restores a partial decision without generating again', async () => {
  const api = await mountOutlineReviewFixture({ state: 'pending' });
  await user.click(screen.getByRole('button', { name: '接受本节' }));
  await user.click(screen.getByRole('button', { name: '确认接受关联修改' }));
  await screen.findByText('剩余 2 组建议');
  await api.reload();
  expect(await screen.findByText('剩余 2 组建议')).toBeVisible();
  expect(api.documentWrites()).toHaveLength(1);
  expect(api.generationRequests()).toHaveLength(0);
});
```

真实测试采用 i18n provider 与项目测试工具，中文仅测试 fixture 按项目 i18n-exempt 规范处理；生产按钮需三语键。新增 fixture API 要连真实 reducer/hook 和服务端合同，不 mock 掉正在测试的 commit 方法。另加 Playwright 实际 API/SQLite 用例，组件测试不能替代全栈持久化。

### 17.4 验证命令顺序

下列为实施后应执行的命令，**本轮没有运行它们来声称新功能通过**。新测试文件未创建前命令不可用；依赖使用项目现有环境，不因方案执行升级全仓。

```bash
.venv/bin/python -m pytest tests/director/test_outline_delivery.py tests/director/test_outline_patch.py tests/director/test_outline_changes.py -q
.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q --tb=short
.venv/bin/ruff check src/novelvideo/director src/novelvideo/api/routes/director.py tests/director
python3 scripts/check_backend_i18n.py
python3 scripts/check_frontend_i18n.py
.venv/bin/python scripts/check_ce_port_closure.py
```

前端在 `frontend/` 内：

```bash
pnpm exec vitest run src/__tests__/director
pnpm build
```

再执行：技能包 validator/固定 hash/wheel 打包检查、三语 JSON、DESIGN lint、全仓 ruff、CE 导入/禁词、精确候选 gitleaks、guard；真实 Seed/浏览器/像素为独立门，不挤进默认 pytest 的自动收费流程。全仓既有失败按未改路径记录，不通过删除断言或扩大 lint 豁免掩盖。

## 18. 完成定义与下一步

### 18.1 大纲切片验收清单

- [ ] 五节要素/来源授权/正文语言正确，两入口同合同，旧原创无回归。
- [ ] short-drama 方法真实加载且有来源/条件/版本回执，不强行角色化阻力。
- [ ] 初稿、局部修改、手编后再改、部分接受/撤回、刷新恢复全通。
- [ ] 源块覆盖与独立语义核对真实执行；歧义保留，未确认事实不升格。
- [ ] 原回包、费用未知、参数、任务和每次失败可追溯，不重复消费旧 UNKNOWN。
- [ ] 全文组合核对能抓原反例，结构和文学分别验收，真实 Seed 复测通过。
- [ ] 五节 UI、聊天、自动保存、diff导航和全页同文同态像素通过；未测态不算通过。
- [ ] 长文不截尾，持久分块/预算/停止恢复；用户时长不被技术上限篡改。
- [ ] 下游读取最新 AST；旧稿升级/回退和权限/CAS/幂等/故障测试通过。
- [ ] 文档、测试、部署版本/数据检查有证据；原有欠项不因本切片而误关。

以上任何关键项未过，结论应为“哪一层已完成、哪一层失败、下一项确切修复”，不能写“已完全等同 TV Director”。真正的语义通用可靠性无法由有限样本数学保证，必须报告样本范围和未验证边界。

### 18.2 开工唯一顺序

先审核本文的新合同/API/持久表与保存语义，确认后执行 B00 → B01/B02 → B03/B04 → B05/B06 → B07/B08 → B09/B10 → B11；同一检出目录仍单写者。首次业务切片先让匿名失败样例可复现，随后实现五节初稿和稳定 AST，不从重新研究旧站点或重新调用两个模型开始。

本文解决的是“如何改当前代码并证明改对”，不是依靠复制隐藏 Skill。用户的根本目标——文学质量、可控生成、界面与操作对齐——由同一条来源→方法→候选→审阅→版本→对照证据链验收。

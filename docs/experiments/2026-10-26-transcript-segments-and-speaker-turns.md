# 转写句卡阶段记录与原片复刻说话轮次分析

日期：2026-10-26。分支：`codex/reference-video-remix-plan`。

本阶段保存转写节点的句卡展示及现有配套代码。说话人识别、轮次校对、方案与素材生成的贯通修复留待下一阶段；本记录中的建议不代表已经实现。现场检查只读，未改写本地 12 项目的画布、方向、方案或素材产物，未重新生成视频。

## 1. 已实现的功能与边界

- 转写正文按照 ASR 返回的 `segments` 按句展示，紧凑行显示句首时间；点击台词跳转到句首，播放中的句子高亮，起止时间仍保留在数据中。
- 每张句卡可以单独展开逐词校对，也可全展开或全收起；逐词编辑仍使用整份词表的全局索引，保持保存对象一致。
- NewAPI 请求同时携带 `timestamp_granularities[]=word` 与 `segment`。词负责实际时间证据，segment 提供阅读分段；未请求说话人分离。
- 独立转写任务启用 segment 保留。`word_timeline.v1` 增加可选 `segments` 字段，画布数据同步保存该字段；旧产物仍可读取。
- 对转写返回的 segment 做基本时间与文本检查。忽略空白 segment；拼接文本去除空白后与 transcript 不一致时丢弃 segments，保留定时词。
- 没有 segments 时继续显示整段转写。画布字段缺失时会读取当前引用的产物补全显示字段；这不是重新调用 ASR，也不会为没有 segments 的旧产物生成句界。

涉及文件：

| 范围 | 文件 |
| --- | --- |
| 句卡、播放与校字 | `frontend/src/features/canvas/nodes/TranscriptNode.tsx` |
| segment 读取及按词中点分组 | `frontend/src/features/canvas/remix/transcriptModel.ts` |
| 画布字段与分析完成后的显示 | `frontend/src/features/canvas/domain/canvasNodes.ts`、`frontend/src/features/canvas/application/analyzeReferenceVideo.ts` |
| ASR 请求与归一化 | `src/novelvideo/freezone/remix/newapi_transcription.py`、`alignment.py` |
| 产物契约及独立转写任务 | `src/novelvideo/freezone/remix/contracts.py`、`src/novelvideo/task_backend/runners/remix.py` |

**segment 不是说话轮次（turn）。** 当前 segment 只有文本和时间，没有 speaker、可核对的角色绑定或人工确认状态。不能仅凭 segment 数量、标点、词间停顿或镜头切换，把台词自动分配给人物。

## 2. 本地 12 项目的实际状态

现场目录为 `state/local/12`、`output/local/12`；项目 ID 为 `01M5M1Z28KZNVRS3XF9AZYEDCR`，画布 ID 为 `user_local_17cvc3s`。这些运行态文件不随本文提交，下列 ID 用于以后在保留该现场的环境中定位证据。

| 对象 | 产物/节点 | 已核对的事实 |
| --- | --- | --- |
| 原片转写 | `0b571686a94c4219be8ce12241aed457@1` | 45 个定时词，无 segments，无说话人；画布“原片转写”的 segments 为 `[]` |
| 原片分析 | `329ed8a41d014873b7bb7b27751f85d4@1` | 引用上述旧转写 |
| 参考蓝图 | `35eedc3c81ed4db19a1cf7419938f170@1` | 10 个视觉事件/证据窗口，引用上述旧转写；窗口不是对话轮次 |
| 新的“转写2” | `27af1b28e2c145e4ab7b037c60f2683c@1` | 与旧转写的媒体哈希、全文和词表相同，增加 7 个 segments；没有成为现有分析的输入 |
| 作品方案 | `e883fba8fa2b48598ff349ed8fb3d4be@1` 至 `@5` | 五版均只有 `b1 / turn1`，speaker 为空，text 包含整段对话 |
| 素材工作包 | `22334dcb7b81ca909bfceb9d7454f69d@6` | 最终视频步骤 `clip` 的 `dialogue_turn_ids` 只有 `turn1`，绑定画面 `v1` |
| 最终视频节点 | `54e0ef73-3388-461b-ab9c-635388819427` | 已编译提示词自行列出 9 条狗狗对白，但没有对应的 9 个方案 turn |

“转写2”的 7 段为：

| 时间（秒） | ASR 文本 |
| --- | --- |
| 0.00–2.16 | 你吃榴莲把嗓子扎着了 |
| 2.16–3.16 | 对啊 干嘛 |
| 3.48–4.94 | 你吃皮啊 |
| 4.94–6.06 | 你的意思呢 |
| 6.06–7.52 | 不 我们都吃羊啊 |
| 7.52–9.42 | 快玩去吧 羊是臭的 |
| 9.42–11.50 | 哎呦 还真是tm骗不了你啊 我感觉 |

以上是保存下来的 ASR 文本，不是本次逐句听辨后确认的台词与说话人真值。7 段 ASR、一个方案 turn 和提示词里的 9 条对白分别属于不同层，不能相互替代。

提示词存在可直接核对的内部冲突：编号对白让狗狗1说“对啊”、狗狗2说“干嘛”，后面的动作说明却让狗狗1回答“对啊 干嘛”。编号对白让狗狗1说“你吃皮啊”，动作说明又让狗狗2伸爪并配合这句台词。方案没有逐轮说话人数据，因此无法用现有结构化校验拦住这类冲突。

本次没有对生成视频逐句播放、听辨及核对口型，所以不据此断言最终视频具体哪几句由谁说错。已确认的问题是生成前的轮次结构缺失和提示词归属矛盾。

## 3. 根因与传播路径

```text
原片 ASR：全文 + 定时词，无说话人
  → source_dialogue：把整段包装为一个 speaker 为空的 turn
  → preserve_source：锁定这个单一 turn
  → 作品方案：保持单个 turn1 才能通过严格校验
  → 素材工作包：只引用 turn1
  → 视频提示词：再次用自然语言推测人物与分句，产生冲突
```

### 3.1 原片全文被固定为一个 turn

`src/novelvideo/freezone/remix/production_requirements.py` 的 `source_dialogue()` 从已绑定分析读取精确转写版本，检查媒体哈希与定时词后，明确将全文作为一个 `speaker: ""` 的 turn 返回。当前实现避免凭空编造说话人，但没有表达“文字已确定、说话轮次尚待确定”的中间状态。

`resolve_production_requirements()` 随后生成 `locked_turns`。12 项目的 `productionWorkflowInputs` 和方案 provenance 都保留了这个单元素列表，因此不是仅有画布显示丢失了换行。

### 3.2 方案校验会保留这个结构

`src/novelvideo/freezone/remix/production_plan.py` 对生成结果的 `(speaker, text)` 有序列表与 `locked_turns` 做严格相等检查；`check_production_requirements()` 也检查该约束。输入是一个匿名长 turn 时，模型不能自行拆成多个具名 turn 并通过校验。

下一阶段应先提供可追溯的轮次数据，再让现有严格校验保护正确结构。直接放宽检查会同时失去台词、顺序和人物归属约束。

### 3.3 镜头事件不能直接充当轮次

`src/novelvideo/freezone/remix/reference_context.py` 的 `build_reference_events()` 按场景切点构造窗口，再以词中点将词分配到窗口。12 项目中可见“了 对啊 干嘛”“啊 你的意思”“呢 不 我们都吃”等跨句片段。这是音频与视觉在同一时间轴上的观察证据，不是完整台词或说话人标签。

当前 `production_plan_context.py` 传递蓝图事件、词区间和 locked_turns；新增的 transcript segments 尚未成为已确认说话轮次输入。

### 3.4 素材层只能继承现有方案

`production_dialogue.py` 的 `generation_dialogue()` 保留方案 turn 的顺序、speaker 与文本；`material_work.py` 把选中的 turn 拼成生成用 dialogue。12 项目只能得到一个无说话人的长文本。素材提示词中额外写出的角色分句缺少结构化依据，现有 `turn_ids` 覆盖检查只能证明“引用了 turn1”。

一个视频素材可以承载多个连续 turn。修复不要求机械地为每句话创建独立视频；应保留逐轮台词结构，再由方案决定哪些轮次共用一个发声素材。

## 4. 本次句卡改动对复刻流程的影响

- 已改善原片校字、定位和回听体验；按词中点分组能避免跨句边界的词在校字界面丢失。
- 未改变 `source_dialogue()`、`locked_turns`、角色映射、素材轮次约束或成片说话人验收，因此不能宣称解决双人对话复刻错乱。
- 产物引用是精确版本。新建“转写2”不会自动替换旧分析、方向或方案里的转写引用；校字保存到新修订也需要下游显式采纳。
- 旧产物没有 segments 时，当前显示回填只会取到空列表；已有 `segments: []` 的画布也不会触发该补字段逻辑。
- `run_remix_joint_reference_analysis()` 在没有可复用转写时仍调用默认 `allow_segments=False` 的 `transcribe_media(path, "auto")`。这条入口的定时词归一化结果不会保留 segments，需与独立转写入口统一考虑。

## 5. 已知待处理项

### 5.1 校字后句卡文本可能仍是旧内容

`frontend/src/features/canvas/remix/transcriptModel.ts` 的 `correctedTimeline()` 更新 transcript 和 words，但通过展开旧 payload 保留原 segments 文本。`saveCorrections()` 又将这些 segments 写回画布；保存修订的契约也没有校验 segment 拼接与新全文的一致性。

后续应通过绑定的词/字符范围重建句卡文本，无法可靠重建时使该句界失效。ASR 返回时的校验不能代替编辑保存时的校验。本次阶段提交记录该问题，暂未修复。

### 5.2 旧数据补句界与下游采纳需要明确动作

“读取已有 segments 到画布”和“重新识别旧媒体以获得 segments”是两个不同动作。后者应生成新的不可变产物或修订，并核对媒体与文字，保留校字历史；新版本是否进入分析与方案需要明确版本绑定，不能只更新画布展示字段。

### 5.3 对话锁定修订的现有契约需要先核实

`DialogueRequirements` 当前只允许 `use_confirmed_text` 携带 `confirmed_turns`；`snapshot_confirmed_dialogue()` 中虽有 `preserve_source` amendment 读取 confirmed_turns 的分支，该输入会先受到前述类型约束限制。下一阶段不能只依据该注释认定“原片保留模式已支持重新标注轮次”。应选择并验证一个完整的源轮次采纳/修订入口。

## 6. 下一阶段建议顺序

1. **补齐可校对的原片轮次。** 在句卡基础上支持拆分、合并和指定说话人；ASR segments 仅作初始阅读分组。每个确认 turn 绑定转写产物及修订、连续词/字符范围、源时间和说话人身份；存储位置沿用现有产物体系，具体 schema 在实施时确定。
2. **核对角色替换关系。** 明确原片说话人到狗狗1/狗狗2及其图片节点的映射。自动建议需有音频/画面依据与待核对状态，不能从交替顺序或当前画面人物直接判定。
3. **接入锁定台词。** `source_dialogue()` 和 requirements 从已确认源轮次生成 locked_turns 与 source_turn_ids。核对文本覆盖、顺序、范围和媒体版本；需要保留原片双人对话时，不把尚未分配角色的长文本视为已完成轮次确认。
4. **贯通方案与素材。** 为各轮生成稳定的方案 turn ID；同一表演素材可按序引用多个 ID。生成 dialogue 由这些 turn 与角色映射派生，提示词不能另行分配相冲突的说话人。方案、素材审核和缓存指纹纳入轮次与角色绑定变化。
5. **按实际生成声音做验收与合成。** 生成后核对每轮台词内容、说话人、口型和真实时间，再生成字幕/语音 cues。原片时间只作为复刻节奏证据，不能直接当作新视频的真实说话时间。

建议回归覆盖：一个 segment 包含待拆分内容、同一人连续多句、无声区间、未确认说话人、跨镜头词、校字后的 segment 更新、同一媒体的新旧转写引用、多个 turn 共用一个视频、生成提示词与方案人物归属不一致，以及旧素材在轮次修订后失效。

## 7. 本地 12 项目以后如何继续

先回听原片，确认台词、说话轮次及两只狗狗的对应关系，再通过正式修订入口保存；不要把本文的 7 个 segment 或编译提示词的 9 条对白当作最终真值。将新证据显式绑定到当前制作，再生成匹配的新方向/锁定输入和方案修订，避免旧单 turn 约束继续生效。

旧图像参考仍可作为版本可追溯的独立素材。受轮次、角色映射或提示词变更影响的视频步骤、审核、语音时间和合成结果需要失效并重新准备。当前素材工作包的 `clip` 状态为 submitted，未在本轮作任何现场修复或重试。

继续前可依次阅读：

- 本文与本地 12 项目表列产物。
- `production_requirements.py`：`source_dialogue()`、`resolve_production_requirements()`、`snapshot_confirmed_dialogue()`。
- `production_plan.py`、`production_plan_context.py`：起草输入与锁定校验。
- `production_dialogue.py`、`material_work.py`：素材台词投影与 turn ID 约束。
- `TranscriptNode.tsx`、`transcriptModel.ts`：句卡、校字保存及显示回填。

## 8. 阶段验证

2026-10-26 在当前工作树重新执行：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 句卡与转写模型 | 在 `frontend` 下运行 `pnpm exec vitest run src/features/canvas/remix/transcriptNode.test.tsx src/features/canvas/remix/transcriptModel.test.ts` | 2 个文件，53 passed |
| NewAPI 转写与对齐 | `uv run --no-sync pytest tests/test_newapi_remix_transcription.py tests/test_remix_alignment.py -q` | 33 passed |
| TypeScript | 在 `frontend` 下运行 `pnpm exec tsc -b --pretty false` | exit 0 |
| Python lint | `uv run --no-sync ruff check src/novelvideo/freezone/remix/alignment.py src/novelvideo/freezone/remix/contracts.py src/novelvideo/freezone/remix/newapi_transcription.py src/novelvideo/task_backend/runners/remix.py tests/test_newapi_remix_transcription.py tests/test_remix_alignment.py` | All checks passed |
| 设计规范 | `npx --yes @google/design.md lint DESIGN.md` | 0 errors，15 warnings |
| 提交前扫描 | `uvx pre-commit run --files <本次及当前分支待推送提交涉及的文件>` | gitleaks、禁用词 lint 均通过 |
| 差异格式 | `git diff --cached --check` | exit 0 |

前端测试输出 Node localstorage 提示，后端测试输出依赖弃用告警。上述测试覆盖句卡及词分组、ASR 字段和归一化；不代表完成说话人识别或完整原片复刻视频的验收。

此前功能交接记录提到 `remixJourneyCanvas.integration.test.tsx` 的“新建作品方案”用例在改动前已有失败；本次不把该历史陈述当作新验证结果，后续继续该旅程时需要重新确认。

# 故事大纲要素对齐与 short-drama 技能融合

更新：2026-09-26。范围仅为故事大纲；不等于完整TV Director、自动改编审计或长篇文学质量验收。

后续质量优先实测见[literary-benchmark.md](literary-benchmark.md)：五套非30秒/多题材样本、14次本方真实请求及一个LibTV同简报大纲对照。五份初稿结构通过但文学未验收；2.2.1实验提示被复测否证后撤回。下述两笔与“未复验”为历史批次记录，不再作为最新质量状态。

## 1. 基准和边界

用户要求先对齐LibTV故事大纲生成要素，并明确short-drama是根基。只读核对用户已交付作品的“故事大纲”，并交叉检查既有`output/playwright/liblib-tv-director/trial-outline-delivery.json`的`write_artifact(skeleton.md)`记录。没有新增LibTV生成、修改源站作品或复制其私有Skill。本文只沉淀结构，不公开原剧本、账号标识或凭据。

两份原站样本的正文详略不同：较完整样本有“主要关系与压力”和详细分段；短片样本含情绪曲线及反转不适用说明。因此采用观察到的要素合集，不能推断原站所有输出都逐字遵循同一模板，也不把样本中的“≤6集不拆段”推广为本产品的普遍限制。

最重要的术语：short-drama `/plan` 对应故事大纲（M07）；short-drama `/outline` 对应分集目录（M09）。二者不混为一谈。人物小传、场景、道具的独立文档仍属于M08；本轮不替换它们。

## 2. 要素逐项映射

| 原站观察要素 | short-drama 方法根基 | 新结构化字段 / 宿主数据 |
|---|---|---|
| 概要设计：故事简介、核心看点、主角/阻力、题材/口味 | /plan故事线、核心冲突；爽点方法按题材适用 | logline、coreHighlights、protagonist、mainResistance、genreTreatment |
| 集数、单集时长、总时长、创作模式、来源 | /start确认参数；事实/新增分离 | 冻结preset与brief/locked_facts；totalDurationSeconds必须等于集数×时长，不由模型估造 |
| 情绪曲线 | rhythm-curve的压力与释放 | emotionalCurve |
| 故事简述 | 完整因果骨架，不以一句话卖点代替 | synopsis；覆盖全部已确认剧情范围 |
| 背景设定：故事背景、关键规则/现实条件 | /plan时空/世界规则 | setting、worldRules |
| 主要关系与压力：不能退、惯用办法、阻力打法、额外压力 | 目标→阻力→选择→代价 | pressure.protagonistGoal/cannotRetreat/habitualStrategy/opposition/extraPressures |
| 全剧分段：位置、承接、目标、主次冲突、阻力打法 | /plan结构；按用户所选结构而非强制三幕 | segments.position/carryIn/stageGoal/mainConflict/secondaryConflicts/oppositionTactic |
| 分段行动/结果、弧光、伏笔、信息释放、代价、观众收获、区别、段末边界 | 角色弧线、伏笔回收、节奏/爽点、闭环 | action/result/characterArcs/setupIds/informationRelease/cost/audienceReward/distinction/carryOut |
| 为什么能追 | 可见行动与已落定结果，而非空泛营销词 | whyWatch：每个真实episodeId一项，次序与宿主一致；不替代M09 |
| 钩子预设：ID、画面/台词、疑问、所在集 | opening-rules | hooks.id/imageOrLine/question/episodeId |
| 伏笔预设：埋什么、埋在、具体形态、收在、收法 | /plan伏笔与结局设计 | setups.id/plant/plantEpisodeId/visibleForm/payoffEpisodeId/payoff |
| 反转预设（适用时） | 有铺垫的预期改变，而非强套反转 | reversals.id/episodeId/expectation/truth/evidence/consequence |
| 创作禁区 | 事实、知识、道具、时间和用户约束检查 | creativeBans，要求具体到当前作品 |

short-drama原有的三剧名备选、全剧冲突/人物弧线/伏笔策略/结局/制作风险/假设均保留为“创作策略补充”。新增LibTV交付栏目，不以它们替掉创作方法。空伏笔/反转表必须有不适用理由；允许当集埋收，不强塞跨集；闭合结局不允许无回收集号的伏笔。

## 3. 实际代码链，不只是文档

1. **技能**：`src/novelvideo/director/skills/builtin/story-plan/`升至2.2.0。新增SKILL入口，runtime实际加载method/template/三份来源参考；原`opening-rules.md`、`rhythm-curve.md`、`satisfaction-matrix.md`文件及sha256保持不变。全局个人技能不作静默修改。
2. **合同**：`schemas/planning.py`的StoryPlan全部字段必填，不用默认空字符串伪造完整。`OutlineMethodContext`只扩展M07的单文档改编适配，不假称完成M04/M05来源审计。
3. **两入口共用**：筹备链`compile_planning(M07)`和单文档`compile_generation(kind=outline)`均加载同一个M07包、schema和技能hash。后者包含当前稿、用户修改指令、来源及冻结episode列表，不再走旧的两句Markdown要求。
4. **实际模型参数**：M07冻结`response_format={type:json_object}`；派发走专用outline调用，SDK extra_body实际带JSON模式和max_tokens，上限与批准的maxOutputTokens一致；SDK的max_completion_tokens也保持同值。只启用JSON模式，不声称供应商已强制满足全部业务schema。依据[硅基JSON模式说明](https://docs.siliconflow.cn/docs/userguide/guides/json-mode)及[Chat Completion接口](https://api-docs.siliconflow.cn/docs/api/chat-completions-post)，仍需本地校验和截断处理。
5. **校验**：`outline.py`严格解析重复JSON键，完整schema、精确集数/时长/结构、whyWatch全量有序覆盖、钩子/反转集号、伏笔ID链接、埋收顺序、开放/闭合约束。失败保留原始模型文本、用量和失败状态，不购买修复请求、不生成待采纳稿。
6. **渲染**：同一`render_outline`按中文/英文/越南文输出语言渲染固定顺序的栏目与表格。真实集号显示宿主deliveryLabel，表格保留稳定钩子/伏笔ID，不泄漏内部episode UUID。不用`storyPlan`/`episodeDirectory`等实现键作故事标题。原创筹备的WAIT_OUTLINE预览和采纳正文完全相同；单文档JSON原文留审计、待审更改为同一Markdown投影。
7. **兼容/审批**：旧已完成文档与2.1产物保留、可读，不迁移或自动“补齐”；重写需新意图/新报价/显式采纳。方法hash改变使旧未消费批准失效。人工保存和质量定稿权限不被模型绕过。

## 4. 真实验证及不能夸大的结论

合成样例：1集30秒温情默剧，两名无亲属关系的人物、一间修画室；林夏从陈伯手里接钥匙→开盒→取修好的眼镜→戴上→读生日纸条→微笑，钥匙开锁后放桌面，盒子/纸条不离桌，不增台词、旁白、退休/生死或续集。真实使用配置的DeepSeek-V4-Flash。

**30秒仅是测试输入，不是产品、故事大纲或通用技能限制。** 正式生成按界面确认的episode_count/duration_seconds。按用户最新要求，已去掉设定器与后端旧的5–3600秒业务范围：单集时长接受正整数秒，不静默钳制，默认120仅作新建初值。清空、0、负数、小数不自动改成其他时长，而是禁止确认；模板选择不覆盖时长，取消丢弃本次修改。1、5、30、60、120、300、3600、5400秒的合同测试，以及1/120/5400秒界面确认→存储→冻结请求的分层回归通过；未因本次参数修改购买第三笔模型调用。短片样例不能代表用户实际一集剧本或长篇质量验收，不可把这次样例推广为创作容量上限。时间冲突只能作为风险或修订建议，不自动改用户设置；完整M10容量评估仍未实现。

- 第一笔：71.84秒；输入19413/输出2388tokens；供应商finishReason=stop。模型主体包含所需要素，却在JSON尾部追加重复字段、错误snake_case字段和null，故**格式验收失败**。另发现钥匙“口袋或手中”、确认事实被重列为假设等内容漂移。没有静默清洗、采纳或自动重试。
- 纠正依据：实际传输未启用JSON模式；补实际请求参数、重复键拒绝，以及技能内事实→假设、物件归属、动作主体核对。HTTP模拟证明字段到达请求体且原始错误回包不丢失。不是换掉short-drama，也不能把全部问题归咎模型。
- 第二笔：58.94秒、输入19583/供应商上报输出8356tokens、finishReason=stop；严格JSON/schema/ID/时长/结构校验通过，生成待审Markdown，未采纳/定稿。主因果保持接钥匙→开盒→取镜→戴镜→阅读，盒子/纸条不离桌、无第三人/台词/续集；反转不适用说明明确。人工仍发现某些“代价/压力”混入30秒制作限制、阶段目标不充分表达前后状态，故文学质量不是PASS。最后继续补强方法内“制作约束≠戏内冲突/代价”的规则，hash已更新；此最后语义提示修订只跑离线测试，未购买第三笔，不能把第二笔结果称为最终hash的真实语义复验。
- 用量边界：两笔合计输入38996、供应商上报输出10744，共49740tokens；金额未知。第二笔请求max_tokens/max_completion_tokens均为8192，但供应商usage上报8356，不能宣称实扣被硬限制在8192tokens。官方max_tokens说明不含思维链；本次receipt没有保留reasoning分项，无法据此断言具体差额来自哪一项。两次记录分开保存，第一笔失败未覆盖；后续需补推理分项与供应商预算口径再承诺严格费用上限。

证据只在忽略目录：`output/playwright/director-outline-live-20260926/`与`output/playwright/director-outline-live-20260926-json-mode/`。每笔含cost quote、approval、request（system/冻结prompt/完整参数/技能hash/上限）、response（原始模型正文/用量/状态）、summary、成功时的outline.md及隔离SQLite。记录的是模型内容和协议参数，不记录鉴权头；费用接口无结算金额，不能把token数虚构成人民币实扣。

## 5. 验证范围与剩余边界

新增逐必填字段缺失测试、多集/结构/回收顺序、空表理由、重复key、三输出语言、同包来源hash入prompt、原文保留、不重试、预览/采纳一致、旧稿不变、HTTP wire JSON与token参数。全Director回归和技能包完整性检查在台账记具体命令和结果。

本轮最终本地验证：Director后端427项、三份Director前端文件64项、三语JSON回归12项通过；`pnpm build`通过（既有大chunk警告）。ruff、前后端i18n棘轮、M07技能格式及包hash/fixture、文档规格22项负向突变、定向凭据扫描通过。没有新增像素级或Windows验收，不能把单元测试等同这些验收。

要素一致不是文本逐字一致，更不是所有题材/百集长篇都已实测。语义矛盾不能仅靠JSONschema彻底保证；本轮真实样例要逐段人工审阅。来源完整审计、多集跨稿一致性、人物/场景/道具单独文档对齐、M10容量规划和全TV Director其余功能仍按既有总计划推进，不计入本轮大纲完成声明。

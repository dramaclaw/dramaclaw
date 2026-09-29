# 人物小传：LibTV 对照、实现与验收

日期：2026-09-26。范围是 TV Director 的人物小传，不是角色图生成或整个导演工作台完成声明。

## 1. 结论及证据边界

本轮在已登录的 LibTV 既有剧本项目中，只读检查人物节点、完整人物文档、编辑器目录、编辑入口及生成角色图菜单。没有修改源站作品，没有调用源站生成。参照站可见行为与 DOM 尺寸是观察事实，**没有取得其服务端 Skill，也不能由一个样本推断所有题材的私有规则**。

本地已实现两个生成入口统一人物合同与 M08 方法，人物文档可读投影、主次分层、编辑布局和人物目录跳转；后续分集请求读取已保存的人物稿。单文档入口只提出人物稿变更，不覆盖大纲、场景、道具。

结构、程序链路和局部布局已验证；三笔真实模型生成均返回合法结构，但有未授权补写称呼、年龄及受压行为的问题，**文学事实质量未通过**。没有自动采纳、定稿、修复重试或下一阶段扣费。

## 2. 可见要素与代码字段

参考页面是 `人物清单` 一级标题 → 人名二级标题 → 加粗标签的项目列表，而不是表格、JSON 属性或英文内部 ID。人物顺序来自模型输出列表，显示名使用 `names[0]`，其他名字为别名；目录以文档位置定位，不能用重名作为唯一键。

| 原站可见要素及顺序 | JSON 字段 | 本地展示/校验 |
|---|---|---|
| 类型 | `role` | `protagonist/main/supporting` 映射主角/主要/次要；不是正派/反派 |
| 人物设定 | `setting` | 已确认身份、外形、性格、目标阻力及相关关系组成连贯说明 |
| 在本剧的作用 | `dramaticFunction` | 具体故事功能，不要求通用英雄模板 |
| 标签 | `tags` | 1–8 项；不空列表 |
| 语言风格 | `voice` | 主要人物展示；默剧可明确无对白 |
| 说话的破绽 | `speechFlaw` | 可为 null，不为了填满界面编造破绽 |
| 设定记忆点 | `memorableDetail` | 主要人物展示；可见行为或特征 |
| 弧光 | `arc` | 主要人物展示；允许平弧，不强造成长或关系修复 |
| 被逼急时怎么做 | `pressureResponse` | 未呈现的反应必须保持未知；不是来源已验证保证 |
| 称呼规则 | `addressRules` | 可为 null；不能由年龄/身份自动认定亲属或昵称 |
| 首次出场 | `firstEpisodeId` | 必须属于宿主当前交付集列表；显示交付标签，不显示内部 ID |
| 关键集次 | `keyEpisodeIds` | 非空、唯一、按集次排序，不得早于首次出场 |

主角/主要人物展示完整适用要素；次要人物展示类型、设定、作用、标签、首次出场、关键集次六项。源站样本确有这种分层，但不能据此宣称其所有输出都使用同一个强制 Schema。

short-drama 的 `appearance/motive/knowledge` 以及关系图 `relations` 仍保留在结构化输出，未因视觉对齐被抛弃。方法要求把关键关系/动机整合进可读的设定和作用字段。关系双方必须是实际人物 ID，禁止不存在实体、自指关系与重复实体 ID。结构校验不判断关系描述是否真实。

注意后续分集读取的是**用户已保存的可读人物稿**；未采纳原始 JSON 中的隐藏推理不会自行成为正式设定。若模型未将关键内部事实投影到可读稿，仍需要审阅，不能声称人物知识图已实现全面自动消费。

## 3. short-drama 与 M08 的融合

主技能已完整读取；本次人物阶段经验查询没有匹配条目，未伪造经验检索结果。按 `/characters` 和 `references/villain-design.md` 抽取身份、性格、动机、冲突、人物功能、辨识度、关系与弧线方法，改写为应用内受控参考。

- `skills/builtin/character-bible/SKILL.md`：方法包入口与适用边界。
- `method.md`：先读来源/已确认大纲，再按宿主合同生成；区分未知和事实、原创和改编、主次人物。
- `references/character-craft.md`：维护的派生摘录，不冒充完整原文快照。反派升级是条件性方法，不要求每个短片都加反派。
- `provenance.json`：原始技能/反派参考指纹、许可证及派生关系；`privateLibTVSourceObtained=false`。
- `manifest.json`、`schemas/`、`fixtures/`、`skills/pinned.py`：可执行输入/输出合同、固定指纹、正反例；没有任意工具执行权。

M08 升至 2.2.0，支持 original/adaptation。技能文件真实装入冻结请求，不只在说明文字里提到 short-drama。全局 short-drama 技能未修改。skill-creator 的验证流程用于检查新入口与包的一致性。

真实测试用包指纹为 `c26d1f19107b1ce899d9d349de793853100fcadabda14b528bd1539b7cc01656`。收尾修正正例 fixture 内“外形未知却写蓝衬衫”的矛盾，并明确默剧语言，最终固定指纹为 `2674d1f0f6b496d5c7a79ad3e902d4bb59dd2c2b1e126214bc3dc01042f2423f`。该修正仅涉及不装入模型正文的 fixture 与包指纹，方法、模板、参考及 Schema 未变；未为此再购买样本。不能把旧请求伪写成最终包指纹。

## 4. 两个生成入口与后续消费

### 筹备入口

`workflow → compile_planning(M08) → CharacterMethodContext → character-bible → Bible → planning_documents`。

完整筹备仍包含人物、场景、道具、世界规则。M08 采用 JSON object 模式；`parse_characters(..., preparation=True)` 做严格验证，再渲染人物小传。下一阶段的结构化筹备上下文仍保留完整 Bible。

### 单独人物入口

`cost.quote(kind=characters) → compile_generation → CharacterDocument → approval.grant → dispatch_writing → parse/render → 待审变更`。

冻结参数含 `output_contract=character-biographies/2.2.0`、`responseSchema`、`responseSchemaHash`、`response_format`、`characterRoot`、作品/文档版本、来源指纹、技能绑定和模型名。单独人物的响应只含 `characterVersion/characters/relations`，不能静默生成场景或道具。没有大纲且没有来源时拒绝，不以无依据补写绕过。

`execution_repository.py` 保存完整返回后才校验。失败保留回包和用量，不自动重发；成功只创建待审稿，仍由用户显式采纳。成功回执另存合同名与结构化产物 hash。

### 分集入口

M11 编译时纳入已保存人物稿，记录 `characters_version` 与内容 hash，作为必需上下文而非可以挤掉的装饰字段。修改人物版本会改变输入指纹，不能复用旧人物上下文的请求；没有人物稿的既有流程仍兼容。

没有新增数据库迁移/API 地址。旧人物 Markdown 原样读取；旧筹备 JSON 的兼容投影保留外形、动机、知情边界、声音、弧线、关系与世界规则，不在打开时补造新字段或改写历史。

## 5. UI 尺寸与按钮行为

在 1920×1080 同浏览器视口读取参考 DOM，并用本地 DOM 复验。以下是局部几何对齐，不是对不同文字内容做整页像素差评分。

| 区域 | 源站测值 / 本地实现 |
|---|---|
| 未缩放剧本文档节点 | 640×350；圆角16；内距24 |
| 节点作品标题/日期 | 24px/32px、600字重；日期16px/19px |
| 节点目录 | 宽92；字号13；按钮行高31.2；间距10 |
| 节点栏目标题/正文 | 18px/27px；正文14px/22.4px |
| 右上编辑按钮 | 至少60×32，顶部及右侧24 |
| 编辑器顶栏 | 高52 |
| 编辑器正文 | x620、y178、宽680；15px/28.0005px |
| 编辑器栏目标题 | 20px/30px，下距36 |
| 人物清单 H1 | 23.25px/31.3875px，下距11.625 |
| 人名 H2 | 19.5px/27.3px，上距37.05、下距9.75 |
| 字段列表 | 左缩进21，相邻条目上距5.25，标签600字重 |
| 浮动目录 | 宽168；1920视口x428，垂直居中 |

`DESIGN.md` 与组件 CSS 同步；原有参考站 SVG 用于编辑/工具栏，不新增热链脚本。素材再分发许可仍需原专项核验。

| 操作 | 本地实际行为 / 验证 |
|---|---|
| 点人物小传 | 切换人物文档，不自动生成 |
| 节点右上编辑或展开 | 打开人物富文本编辑器 |
| 人物目录 | 按文档位置定位；重名可区分；末项滚动到底不错误高亮上一人 |
| 手动滚动 | 目录跟随可见标题；点击定位期间保留目标，用户独立滚动后继续跟随 |
| 正文编辑/源码视图 | Markdown 作为保存边界；仅打开/导航/缩放不会写入版本 |
| 切换栏目时有未保存稿 | 明确询问；取消保留文字和原栏目，实际浏览器验证通过 |
| 保存正式版本 | 显式版本校验；合成人物稿v1→v2，刷新后保留内容 |
| 选区引用到对话 | 带文档名及保存版本；只填输入框，不自动请求模型 |
| 私稿/提出修改/采纳拒绝 | 沿用既有显式操作与并发版本保护；本轮定向组件/后端回归覆盖 |
| 下载 | 沿用当前文档下载，不下载用户完整作品 |

**未伪装成一致的差异**：源站编辑期间可保留聊天浮窗，本地编辑器仍为模态；本地保留底部显式保存/版本保护/私稿栏，不冒充源站自动保存。源站生成角色图菜单实见角色图/场景图/道具图三项，本地角色图和全能创作仍不可用，本轮未接媒体链。因此不能写“人物相关全部操作已100%相同”。

## 6. 浏览器验收与截图

使用隔离 `tests/director/preview_execution.py` 的真实 API/SQLite 和合成模型；不读写用户项目，不读取真实供应商凭据。临时预览入口收尾删除，证据和临时测试数据保留，不混入正常项目。

- 1920×1080：节点与完整编辑器实测、目录末项高亮、正式保存/刷新、未保存取消、选区引用完成。
- 1200×800：正文680，页面scrollWidth=1200，目录可见，保存按钮在视口内。
- 390×844：正文342，页面scrollWidth=390，目录隐藏，工具栏换行/窄屏布置，保存按钮可达。
- 截图已实际查看，不以成功写出图片文件代替视觉检查。

忽略目录下的证据：

```text
output/playwright/director-characters-reference-node.png
output/playwright/director-characters-reference-editor.png
output/playwright/director-characters-local-node-final.png
output/playwright/director-characters-local-editor-final.png
output/playwright/director-characters-local-editor-nav.png
output/playwright/director-characters-local-editor-1200.png
output/playwright/director-characters-local-editor-390.png
```

源站截图可能含用户稿，只本地留证，不提交。窄屏截图不是源站同视口的逐像素认证；Windows/实际应用外壳未在本轮复验。

## 7. 三笔真实模型测试与质量结论

测试脚本 `tests/director/live_characters.py` 必须显式授权运行；默认 pytest 不联网。三组都是专门创建的合成内容，单笔一次、8192最大输出token、零自动重试；300秒是网络请求保护，不是用户剧本时长限制。通过已配置网关调用，回执模型名 `deepseek-ai/DeepSeek-V4-Flash` 只是供应商报告，不是独立验证模型权重。

| 样本 | 用户规模 | 秒 | 输入/输出token | 链路 | 人工内容发现 |
|---|---|---:|---|---|---|
| silent | 原创1集×60秒，默剧两人 | 23.06 | 7899 / 2719 | 成功待审 | 道具动作顺序及默剧保留；少量动作/动机推断需审，不评文学PASS |
| workplace | 原创2集×180秒，三人职场 | 34.24 | 8197 / 1498 | 成功待审 | 核心真实代价保留；补写未确认称呼，不符合严格事实边界 |
| adaptation | 改编1集×120秒，来源/交付EP02 | 19.78 | 8367 / 826 | 成功待审 | 集号与关键事件保留；从称谓推年龄、补受压行为，事实门失败 |

合计3请求、24,463输入/5,043输出token。实际金额回执为空，**金额未知，不写免费/零元或估值为实扣**。三份均未采纳、未定稿、未触发后续生成；没有重复购买之前的UNKNOWN。

每组独立留存 `input.json`、`cost-quote.json`、`approval-grant.json`、`request.json`（完整冻结快照与system）、`response.json`（返回与原文）、`characters.md`、`summary.json`、SQLite。目录为 `output/playwright/director-character-live-20260926/{silent,workplace,adaptation}/`；不提交密钥、请求鉴权头、Cookie、数据库或源站稿。

### 为什么还不能宣布文学对齐

技能已经明确要求未知不虚构，但模型仍会用常识补齐细节；Schema只能保证字段/类型/引用合法，无法证明“称呼已被来源支持”。不能把同一模型再问一次且回答正确当成可靠校验，也不能把随机输出等价于 LibTV 文学质量。

下一步沿既有文学事实门工作线：将本轮的“称谓≠年龄”“职务≠既定称呼”“未呈现≠已知受压反应”“简表不能丢关系约束”做最小正反例，接用户可确认的原子事实及锚点版本。改编新增设定必须单列提议，未经确认不能晋级为正式事实；验证审查能区分正反后，才考虑受控再次模型测试。本轮不加长提示词后无预算上限地循环付费。

## 8. 自动验证与剩余边界

```text
.venv/bin/python -m pytest tests/director tests/test_tv_director.py -q
  491 passed（含人物正负例、真实仓储链路、集次/旧稿与M11消费）
pnpm exec vitest run src/__tests__/director-richtext.test.tsx \
  src/__tests__/director-ui.test.tsx src/__tests__/director-execution.test.tsx
  67 passed
pnpm build
  通过；保留已有大chunk警告
.venv/bin/ruff check src/novelvideo/director tests/director
  通过
python3 scripts/check_backend_i18n.py / check_frontend_i18n.py
  通过，无新硬编码用户文案
.venv/bin/python scripts/check_ce_port_closure.py
  11端口通过
@google/design.md lint DESIGN.md
  缓存0.4.0 CLI运行，0错误/20警告；在线npx先因DNS失败
gitleaks git --pre-commit --redact；gitleaks dir src/novelvideo/director / tests/director --redact
  通过，包含新文件
skill-creator quick_validate.py character-bible
  通过
```

这是本轮定向验证，不是全仓测试、全页视觉认证、真人文学盲评或完整TV Director完成率。未改变全局模型/代理配置；未提交、推送或部署常驻服务。既有大纲事实门、完整导演/媒体/分享/多设备等待办仍保留。

# 全功能、按钮与参数合同

设计 v2.1 / 2026-09-25。范围与证据口径见[主方案](../tv-director-skill-fusion.md)。本文件每个命令都是我方接口设计，不是逆向获得的 LibTV 服务端函数；源站证据等级按[原按钮报告](../liblib-tv-director-analysis.md)同 ID 查阅。下表完整列出137个既有ID，不将U/C/N升级为T。

## 1. 所有按钮共同遵守的状态合同

每行对应 `UI-<ID>` 参数化测试；例如 A01 对应 UI-A01。测试至少覆盖：可用、禁用及原因、触发结果、加载中防双击、失败可恢复、刷新后读取。纯展示/本地布局动作的网络与运行费用断言为“0”；不适用某状态须在测试注明理由，不能直接跳过整个按钮。

以下简写是完整合同的一部分：V=本设备视图状态；D=会话输入草稿（自动保存，未发送）；S=会话；W=作品；DV=文档版本；CP=工作检查点；CS=待审修改；PV=冻结预设；SV=Skill版本；CV=画布快照。所有服务端命令携带身份、项目、作用域、期望版本和独立幂等键，详见[工作流合同](workflow-contracts.md)。读取与视图命令不冒充写命令。

恢复B：非破坏操作失败保留输入，显示错误码和重试；409刷新最新版本并保留我的草稿；断网重连按event seq恢复，不能隐式重发生成。恢复Q：审批/问卷过期不能提交旧版本；“忽略”不是同意。恢复G：生成按账本状态恢复；unknown不盲重试。恢复P：隐私/发布动作失败默认私有，不扩大授权。下表未另写的动作用B；这些不是统一toast取代业务状态。

## 2. 既有137项按钮逐项合同

### A：浮窗、输入、会话（组件 DirectorShell / Composer / SessionHeader）

| ID | 操作及前提 | 命令 → 可观察结果/持久对象 | 禁用、失败及恢复补充 |
|---|---|---|---|
| A01 | 打开TV Director；项目有权限 | session.restore → 上次S/CP；V显示 | 项目不存在给返回入口；不新建重复会话 |
| A02 | 显示会话标题 | session.get → S.title截断，悬停全名 | 标题生成失败用用户首句短摘要，不覆盖正文 |
| A03 | 新建对话；非空会话 | session.create → 新S、全能欢迎页；旧S保留 | 未发D询问保留/放弃；不取消旧run |
| A04 | 已在空新会话 | V禁用新建；无请求 | 焦点可读禁用原因 |
| A05 | 历史 | session.list/search → 当前项目分页结果 | 空、加载、无权限三态不同；搜索取消旧查询 |
| A06 | 分享；已有S | share.preview/create → 权限/范围/有效期、可撤销shareId | 默认只读私有、显式发布；P；源站分享已实测，独立撤销未见入口；差异 U06 |
| A07 | 全局设置 | settings.get → 设置弹层及revision | 取消不写；会话当前策略另列 |
| A08 | 插件入口 | plugin.list → 状态/授权范围/连接入口 | 未连接/失效/只读分态；无凭据入对话；P；协议已测，原生客户端边界见 U09 |
| A09 | 停靠/浮窗切换 | V.layout切换；S/输入/CP不变 | 小视口约束位置；不启动新run |
| A10 | 关闭面板 | V.visible=false | 任务继续，通知按权限；关闭不是停止 |
| A11 | 八向resize | V.bounds按min/max及视口clamp | 失焦结束拖拽；键盘也可调整；不越屏 |
| A12 | 开启浏览器通知 | 用户手势请求permission；settings记录结果 | denied给浏览器指引，不循环弹窗 |
| A13 | 关闭通知引导 | V.dismissPrompt=true | 不更改已授予通知/声音策略 |
| A14 | 富文本输入 | composer.edit → D文本AST+引用；自动保存 | IME输入不发送；粘贴脚本当文本；失败保留本地草稿 |
| A15 | 上传图/视频/音频/文档 | attachment.upload/verify → D.assetId+version+status | 上传中/失败不能Send；限制及校验来自capabilities |
| A16 | @引用节点/资源/工作流 | reference.search/select → D稳定ID与版本 | 已删除/无权/版本过旧提示；不靠名称绑定 |
| A17 | 点击/删除引用chip | focusNode或composer.removeReference → 同步D AST与manifest | 删除被正文引用对象须显示失效位置，不静默串号 |
| A18 | 全能/原创/改编/导演模式 | composer.setMode → D.mode及对应参数区；目标解析见工作流§1.1 | 活跃run不改冻结模式/目标；不丢输入或附件；不适用引用保留并解释，不能静默发送 |
| A19 | 全能媒体模型 | capabilities.get/select → D.mediaModels | 视频仅H3；不可用给原因；不伪造图音频可用模型 |
| A20 | 剧本文本模型 | capabilities.text/select → D.modelBinding | 显示实际路由ID；固定网关不可改成假值 |
| A21 | Skill入口 | skill.catalog.open → 通用/收藏/我的 | 空列表不阻断基本写作；列表失败可重试 |
| A22 | 手动/自动生成 | session.policy.propose/confirm → S.approvalPolicy | 自动需范围/单次/累计上限；不能覆盖质量定稿 |
| A23 | 发送/停止 | message.send → frozen snapshot+run；run.cancel → cancel_requested | 空/上传中/失效引用禁发；G；停止不保证供应商退款 |
| A24 | 上下文剩余 | usage.event → token用量/窗口/估计标记 | 不支持精确计数时标估计/未知，不按字符假算精确值 |
| A25 | 展开进度 | V展开stage/tool/result摘要 | 不存或暴露内部推理；断流按seq恢复 |
| A26 | 文档交付卡 | document.open(id,version) → 定位节点/编辑器 | 明示草稿/正式/待重审；文件失效不能伪打开 |

### O：原创设定器（OriginalPresetDialog）

| ID | 操作及前提 | 命令 → 可观察结果/持久对象 | 禁用、失败及恢复补充 |
|---|---|---|---|
| O01 | 从爆款题材开始 | D.mode=original；打开设定器副本 | 未发送不创建作品/模型run |
| O02 | Top8开关 | V.presetRailVisible | 隐藏不清除已选值 |
| O03 | Top8模板选择 | preset.apply(templateVersion) → 草稿各字段变更预览 | 明列覆盖/保留值；取消恢复，不隐藏重置集数 |
| O04 | 主体题材 | preset.setMain → 选中大圆/候选列表 | 与融合互斥；相同值禁用有原因 |
| O05 | 添加/移除融合 | preset.setFusion/null → 双圆/单圆 | 清除仅fusion字段，其他手改不丢 |
| O06 | 其他自定义题材 | preset.setCustomGenre → 原文与stable id | trim后为空不可确认；不改写用户文本 |
| O07 | 目标人群 | preset.setAudience → 最多2项+custom | 第3项禁选提示；顺序稳定 |
| O08 | 角色设定卡 | preset.setCharacterSetup → 配置选项/自定义 | 选项更新保留旧值且标已停用，不静默换人设 |
| O09 | 时代背景卡 | preset.setEra → 配置项/自定义 | 与锁定事实冲突进入CP而非默改 |
| O10 | 核心看点卡 | preset.setHighlights → 多选稳定顺序 | 清空允许与否按schema；不混成画风字段 |
| O11 | 画风卡/自定义/参考图 | preset.setStyle → styleId/text/ref资产版本 | 图未就绪不可确认；叙事基调与视觉风格分开 |
| O12 | 集数/自动 | preset.setEpisodeCount → 正整数或auto | 用户决定规模；auto确认后规划，不默设20或强限100；资源不足给分页/分批方案 |
| O13 | 结构八选项 | preset.setStructure → 稳定枚举 | 所选非线性须显式时线；不强制三幕 |
| O14 | 取消/关闭设定器 | 丢弃弹层副本，回D原值 | 有未存附件只解除草稿引用，不误删共享资产；原站预设取消回滚已实测 |
| O15 | 确认设定器 | validate → D中preset chip | 不生成；错误定位字段；Send再冻结 |
| O16 | 编辑/删除chip | edit副本或removePreset → D同步 | 已发作品变更走SpecChangeSet，不改历史message |

### D：改编（AdaptationComposer / SourcePicker）

| ID | 操作及前提 | 命令 → 可观察结果/持久对象 | 禁用、失败及恢复补充 |
|---|---|---|---|
| D01 | 上传故事入口 | 打开文件选择；D.mode=adaptation | 取消选择不创建空source |
| D02 | 原稿上传/移除chip | source.ingest → 不变source版本与读取状态 | 删除只解除草稿绑定；已引用源受保留策略保护 |
| D03 | 改编设定器 | 打开策略/集数/保留项副本 | 无源可先设参数，Send前必须可读来源 |
| D04 | 浓缩 | D.strategy=condense；展示损失/保留约束 | 不默删关键事实；M06-A1 |
| D05 | 扩写 | D.strategy=expand；设允许新增范围 | 不拿新桥段当来源事实；M06-A2 |
| D06 | 强化冲突 | D.strategy=conflict；目标/阻力/代价 | 禁改锁定身份/动机；M06-A3 |
| D07 | 钩子 | D.strategy=hook；揭示/兑现要求 | 末集例外与虚假悬念检查；M06-A4 |
| D08 | 集数 | 正整数/auto；同时显示sourceLabel/deliveryLabel | 用户决定规模；源站观察范围不是本产品永久上限；最小2/问卷1差异仍如实记录 |
| D09 | 移除改编预设 | removePreset，保留source chip | 不把删除策略理解成删除原稿 |

### Q / S：问卷与费用设置（QuestionCard / ApprovalCard / SettingsDialog）

| ID | 操作及前提 | 命令 → 可观察结果/持久对象 | 禁用、失败及恢复补充 |
|---|---|---|---|
| Q01 | 单选题 | Q.answerDraft写选项，完整后跳下一题 | 多选题不误自动提交；Q |
| Q02 | 自由输入 | Q.answerDraft保留原文 | 空必填禁提交；附文档命令不成为系统权限 |
| Q03 | 前/后题 | V.questionIndex，保留答案 | 首尾禁用；不提交服务端批准 |
| Q04 | 继续 | 校验当前页→下一页/汇总 | 有必填缺失定位；不隐式生成 |
| Q05 | 提交答案 | question.answer(questionVersion,toolCallId) → 新CP | 双击返回同结果；Q；变规格需显式diff |
| Q06 | 忽略 | question.skip → WAIT_INPUT及原因 | 不默认选第一个；必需问题仍阻断；源站忽略/新卡恢复已测，服务端旧卡重放未测；U05 |
| Q07 | 已回答卡折叠 | V折叠；只读已提交答案 | 更改通过新问题/变更，不修改旧记录 |
| Q08 | 报价取消/批准 | approval.deny/grant → CP或run | 未到期且hash一致才批准；Q/G |
| Q09 | 本会话自动确认 | session.policy.confirm → 有上限的S策略 | 逐集子授权仍独立生成；不自动定稿 |
| S01 | 全局默认自动生成 | settings.patch → 新会话默认策略 | 不追溯更改已有S；首次启用展示费用范围 |
| S02 | 预算管理 | settings.budget → 提醒阈值与硬上限分别保存 | 不拿提醒当授权；并发预留由服务端执行 |
| S03 | 阈值输入 | validate numeric+currency → policy revision | 不把观察到1000设永久价格；超限不可提交 |
| S04 | 通知开关 | requestPermission或settings.patch | OS拒绝不显示已开启 |
| S05 | 通知声音 | settings.patch → soundEnabled | 通知不可用时禁用，并保留用户原偏好 |
| S06 | 完成/保存 | settings.commit(expectedRevision) | 409保留草稿并显示服务端值 |
| S07 | 首次设置后继续发送 | 保存后以原clientMessageId发送排队D | 失败不得清空D；配置取消就不发送 |

### E：剧本文档节点与编辑器（ScriptDocumentNode / ScreenplayEditor / DiffReview）

| ID | 操作及前提 | 命令 → 可观察结果/持久对象 | 禁用、失败及恢复补充 |
|---|---|---|---|
| E01 | 故事大纲目录 | document.get(outline) → 节点右侧同DV | 未创建显示未生成，不补模型调用 |
| E02 | 人物小传目录 | document.get(characters) → 对应DV | 人名锚点稳定，不按标题碰撞 |
| E03 | 场景设计目录 | document.get(locations) → 对应DV | 同名不同场景保留独立ID |
| E04 | 道具设计目录 | document.get(props) → 对应DV | 物件ID与流转表关联 |
| E05 | 分集/场次目录 | episode.list + document.get → 稳定episodeId选中 | 重排只改ordinal/标签，不换正文ID |
| E06 | 打开编辑器 | document.open → 全屏+目录+DV | 草稿/正式明确；不复制第二份正文 |
| E07 | 生成角色图下拉 | character.select → media.plan/quote | 只生成有权限选中角色，先审批；G |
| E08 | 全能创作 | 冻结已完成文档版本集合→新omni会话→attachDocument→message.send续创意图 | 源站CL17自动发送且dryRun；本地幂等只发一次，旧输入保留；规划/预览不等于媒体执行，费用另批 |
| E09 | 下载 | export.preview/create → 指定版本manifest+文件 | 草稿/未验证水印元信息，失效素材提示；不假定正式 |
| E10 | 撤销 | editor.undo → 编辑草稿 | 非跨版本删除；已提交需新变更 |
| E11 | 重做 | editor.redo → 编辑草稿 | 新编辑清redo；失败不影响正式DV |
| E12 | 缩小 | V.editorZoom下降 | 最小值禁用，不缩放文字真实内容 |
| E13 | 恢复100% | V.editorZoom=1 | 不改变画布缩放 |
| E14 | 放大 | V.editorZoom上升 | 最大值禁用；不溢出工具栏 |
| E15 | 标题样式 | editor.setHeading → AST block | 不把场次ID系于标题字符串 |
| E16 | 列表 | editor.toggleList → AST | Markdown往返嵌套列表无损 |
| E17 | 加粗 | editor.toggleMark(bold) | 纯样式不假定需语义重生成 |
| E18 | 斜体 | editor.toggleMark(italic) | 选择范围正确，emoji不裂开 |
| E19 | 删除线 | editor.toggleMark(strike) | 与语义删除不同；未显式删除事件不能自动移除事实 |
| E20 | 大纲锚点跳转 | V.activeBlockId/scroll | 标题修改仍能定位；隐藏块展开 |
| E21 | ESC退出/待审提示 | 有draft提示保留或放弃；关闭V | 不自动全部采纳；Esc先关闭最顶层弹窗 |
| E22 | 选区发送导演 | flush draft → DV+UTF16选区+hash→D引用 | 保存/解析失败停；旧选区409要求重选 |
| E23 | 关联/切换会话 | session.resolveDocumentLink → 确认后S | 不向不相干会话自动发送源文 |
| E24 | 上一处变更 | V.hunkIndex | 按当前CS可见顺序；首项禁用 |
| E25 | 下一处变更 | V.hunkIndex | 末项禁用；不决定接受 |
| E26 | 上一节 | V.sectionIndex | 无变更节与变更节可区分 |
| E27 | 下一节 | V.sectionIndex | 与文档目录同一锚点 |
| E28 | 接受单处 | changeset.decide(groupId,accept) → 持久决定 | 依赖组联选预览；不能制造半个改名 |
| E29 | 撤回单处 | changeset.decide(groupId,reject) | 撤回未提交草稿；已提交走新revert变更 |
| E30 | 全部接受 | changeset.commit → 原子新DV+失效下游 | CAS/闭包/复检失败全回滚；不等于定稿 |
| E31 | 全部撤回 | changeset.rejectAll → 正式DV不变 | 保留审计；不删已保存历史稿 |
| E32 | 冲突加载最新/保留我的 | document.rebaseDraft → 三方diff或新草稿 | “保留我的”不等于无条件覆盖别人版本 |

### R：导演角色与提示词（DirectorRolePicker / ShotPlanReview）

| ID | 操作及前提 | 命令 → 可观察结果/持久对象 | 禁用、失败及恢复补充 |
|---|---|---|---|
| R01 | 导演角色切换 | D.roleBinding=SV | 活跃run版本不漂移 |
| R02 | 自动导演 | M16按CV/目标选方法并展示理由 | auto不是随机切模型，实际方法落run |
| R03 | TVC广告 | 绑定TVC角色版本→品牌目标/节奏提示 | 缺品牌资料询问，不虚构授权素材 |
| R04 | 悬疑短剧 | 绑定suspense版本→揭示与悬念镜头 | 不剧透锁定结局 |
| R05 | 带货口播 | 绑定sales版本→主体/演示/CTA | 禁止虚构产品事实；时长门同源 |
| R06 | 动画 | 绑定animation版本→动作/一致性提示 | 角色模型/场景引用版本固定 |
| R07 | 纪录片 | 绑定documentary版本→事实/纪实镜头 | 演绎与事实分别标记 |
| R08 | MV | 绑定MV版本→音乐段落/视觉节拍 | 缺音轨时标假设，不假称卡点已校准 |
| R09 | 批量优化提示词 | CV.selectedNodes→M16→逐节点候选 | 单项失败可单重试；未经接受不写画布 |
| R10 | 一句话分镜 | brief+时长→M16→ShotPlan | 文本结果不是视频；数量与总时长校验 |
| R11 | 我的导演菜单 | skill.list(bizType=director) | 与通用Skill过滤区别；空态可创建 |
| R12 | 新建导演角色 | 发可见创建意图→intake问卷 | 幂等只建一次草稿；不自动保存/公开 |
| R13 | 导入md/文件夹 | skill.import → 沙箱检查后draft | 路径穿越/符号链接/执行文件拦截 |
| R14 | 定位问卷 | question.answer → roleDraft | 选项与自由输入保存；Q |
| R15 | 确认保存 | skill.validate/savePrivate → SV | 验证失败不假保存；历史版本不变 |
| R16 | 编辑头像/名/方法/预览/聊天改 | skill.editDraft(expectedVersion) → diff | 取消不覆盖SV；头像权属/上传检查 |
| R17 | 使用自建角色 | 发送可见SV引用→对新输入生成候选 | 新会话冻结版本，不能调用旧样例冒充复用 |
| R18 | 优化结果卡 | showPrompts → 比较/复制/采用/落画布 | nodeId可null；采用新建需分配ID；不标已生成媒体 |

### K：Skill完整生命周期（SkillCatalog / SkillEditor / SkillTestReport）

| ID | 操作及前提 | 命令 → 可观察结果/持久对象 | 禁用、失败及恢复补充 |
|---|---|---|---|
| K01 | 通用 | skill.list(scope=catalog) | 分页/授权过滤；系统包只读 |
| K02 | 收藏 | skill.list(scope=favorites) | 已下架版本给可解释状态 |
| K03 | 我的 | skill.list(scope=owned) | 不泄露他人私有包 |
| K04 | 搜索 | skill.search(query,cursor) | debounce/旧响应丢弃；空结果非失败 |
| K05 | 详情 | skill.get(version) → 适用/权限/方法/案例 | 未运行和已测试标识分开 |
| K06 | 案例轮播/播放/静音/全屏 | V.mediaPreview | 不自动运行Skill；素材失效可报错 |
| K07 | 分享Skill | share.preview/create(SV) | 默认不包含私有原稿、聊天；P；源站发布/公开读取/删除失效已测，独立撤回见 U07 |
| K08 | 收藏/取消 | favorite.set(value) | 幂等设值而非toggle双击反转 |
| K09 | 添加Skill | composer.attach(SV) → D.chip | 添加不是执行；失效版本阻断Send |
| K10 | 创建 | intake.select → 五种入口 | 不立即建公开条目 |
| K11 | 从零创建 | M18(questionnaire) → method draft | 缺任务/输入/输出先问；Q |
| K12 | 从对话创建 | snapshot.preview(messages)→M18 | 纳入范围用户可见；跨会话需授权 |
| K13 | 从画布创建 | snapshot.preview(nodes)→M18 | 仅选中/获准上下文；不把全画布默传 |
| K14 | 更新我的Skill | M18(baseSV,instruction) → draft版本 | 无所有权禁用；更新不漂移历史run |
| K15 | 自测 | M19(SV,fixtureIds,budget) → TestRun报告 | 失败/费用/样本缺失如实展示；G |
| K16 | 导入 | skill.import → file manifest+draft | schema校验、权限收缩；不执行包内任意脚本 |
| K17 | 编辑/应用草稿 | skill.validate/applyDraft → 私有新SV | 方法合法≠质量过关；失败保留draft |
| K18 | 另存为新Skill | skill.fork → 新skillId、来源SV | 不覆盖原包/冒充独立原创来源 |
| K19 | 发布模板 | publish.preview/confirm → 审核/发布状态 | 独立显式授权、权属检查、独立撤回；P；U07 |
| K20 | 删除私有Skill | skill.deletePrivate → 不可再执行；历史run保留版本凭证 | 二次确认明确不可恢复及关联发布撤销；不得用“删除”按钮执行可恢复归档；F32 |

## 3. 不在原编号表里也不能漏掉的交互

这些是观察补充或我方必要行为；统一 `UI-Xnn`。不是借新增ID声称原站已实测。

| ID | 行为与实现合同 | 验证点 |
|---|---|---|
| X01 | 历史重命名：session.rename，权限+CAS | 只改标题、搜索更新、原消息不变 |
| X02 | 历史删除：确认后软归档；活跃任务明确处理，不隐式取消 | 刷新移除、撤回/恢复策略、历史费用保留 |
| X03 | 剧本设定器重新打开：已有作读取最新Spec；修改走影响预览 | 已定稿后不继续只读锁死，也不静默覆盖 |
| X04 | 单集时长/结局/语言等问卷字段 | UI→Spec→输入快照→模型/校验→导出一致 |
| X05 | 文档保存、Ctrl/Cmd+S与自动保存 | 明确保存草稿/提交正式版本，不偷偷定稿 |
| X06 | 手动“确认定稿/要改”与继续下一集 | 版本/评审绑定；末集不例外；Q |
| X07 | 增删/重排集数、只改未来/重审已写集 | episodeId不变、引用不串位，冲突不能部分覆盖 |
| X08 | 语言/海外模式/合规审核/导出部分集 | 按M20/M21和修订规则；不强制1–3分钟元信息 |
| X09 | 批处理候选逐项采用/全部采用/仅重试失败 | 画布事务、资源审批与节点选择三者独立 |
| X10 | Skill历史版本比较/回退、归档/恢复 | rollback产生新revision并保留来源；archive/restore只改可用性，不冒充K20删除；F22/F27/F32 |
| X11 | 会话分享撤销、Skill撤回发布、插件断开/重新授权 | 立刻关闭新访问/调用；审计保留；活动任务可解释 |
| X12 | 预算不足、评审不可用、来源歧义与重连卡 | 恢复动作针对原因；不展示假“成功”或无限加载 |

## 4. 不能用按钮表替代的八项能力

| ID | 端到端算法与对象 | 失败/恢复与验收 |
|---|---|---|
| C01 画布感知 | 用户选区/可见区/显式全项目范围→CV(nodeId,type,revision,artifactRef,edges,order)→文本摘要和受限媒体分析→可见输入清单 | 不越界读取；过期CV需重确认；图/视频/音频分析分别给可定位时间/来源，分析失败不冒充看过 |
| C02 全能编排 | M17把目标拆TaskPlan DAG；工具registry按能力/权限/费用/副作用约束→预览→审批→执行→结果卡 | 无工具返回unsupported+具体所缺能力；暂停保留子任务，单项失败隔离；不由聊天文本模拟成功 |
| C03 批量分镜/优化 | 选节点稳定顺序→逐项输入快照→有限并发子run→候选→用户采纳→画布事务 | total/succeeded/failed/cancelled分别显示；重试仅失败且新授权；刷新查实节点与revision |
| C04 文档到媒体 | 确认DV/角色场景道具版本→ShotPlan→引用manifest→H3请求预览→报价/审批→供应商任务→资源入库 | 文本、图片1与混合媒体编号独立；引用重排后同manifest重编译；参数不支持调用前报错 |
| C05 多轮对话/恢复 | message→snapshot→durable run/events/CP；追问携带明确目标DV/选区/阶段 | 长上下文用检索，确认事实不丢；断线不重生；新输入排队/取消由用户选择 |
| C06 Skill/角色运行 | 包校验→版本冻结→规则/上下文选择→白名单工具→结构化结果→独立自测→私有发布 | 任意文件/联网默认禁止；方法变更不能提高权限；包内外部指令不取得执行权 |
| C07 分享/插件/通知 | share snapshot/权限→撤销；plugin OAuth/令牌由服务端保管→能力注册；事件→通知去重 | 第三方集成协议未验证项保持N；provider error隔离；不发原稿到未授权连接；拒绝通知不阻塞流程 |
| C08 导出/迁移/跨设备 | 版本manifest+相对资源引用+schemaVersion→一致性快照→导入校验→ID冲突映射→重新绑定凭据 | 包不默认含密钥/原始调用日志；Windows合法路径；缺资源明列；并发版本不覆盖；跨设备≠自动同步本机文件 |

C04与视频节点的既有H3事实对照[请求合同](../minimax-h3-liblib-request-contract.md)。字幕、特效、角色库等能力若存在于画布其他模块，通过有scope的适配器接入，不在本工作流伪造。图片/音频提供者需要实际capability支持；H3以外的视频模型不进入选择器。媒体能力未接完时可发布明确标注的阶段版，但完整版验收C01–C08不能删项。

## 5. 预设编译与参数的一一对应

`compilePreset(draft, capabilityVersion) -> {specPatch, displayRows, warnings, errors}` 是纯函数；服务端独立复验，不接受仅由前端校验。统一稳定ID，不把中文显示名当业务枚举。

| UI字段 | 唯一存储/提交字段 | 约束/回显 |
|---|---|---|
| 创作模式 | mode: omni/original/adaptation/directing | 对应本产品工作流，不复用LibTV的三套不同枚举 |
| 主/融合题材 | genres.mainId/fusionId/customText | 主辅最多各1、不可相同；渲染拼接，不只存拼后字符串 |
| 目标受众 | audienceIds[]、audienceCustom | 最大2；稳定顺序与显示一致 |
| 人物/时代/核心看点 | characterSetup、era、highlights | 每项包含ids/customText/provenance，不交叉覆写 |
| 画风/参考图 | visualStyle.id/text/referenceAssetVersion | style-only不能改变剧情事实；引用图与素材区同步 |
| 剧本结构 | structureId | three_act/five_act/hero/parallel/cross/nonlinear/loop/unit |
| 集数 | episodeCountDraft: auto或正整数；confirmedSpec.totalEpisodes: positive integer | auto确认后规划；拒绝非有限/小数/非安全整数输入，超单次容量分批，不改用户集数；末集由episode order推导 |
| 单集时长 | episodeDurations[episodeId]或defaultDurationSeconds | 明示单位秒；不把供应商片段时长当剧本时长 |
| 叙事基调 | narrativeTone.id/customText/provenance | 由用户输入或X04问卷确认；不以visualStyle代填，不默改锁定基调 |
| 结局/语言/市场 | endingType/outputLanguage/market | 影响规则选择；正文生成后改变走关联修订 |
| 改编方向/保留项 | adaptation.strategy/fidelity/lockedFactIds/allowedAdditions | 四策略枚举；新增/删除关键事件需独立事实批准 |
| 文本模型 | modelBinding(provider,requestedModel,actualRoute,capabilityVersion) | 预览与真正调用不同就失败；不静默降级换模型 |
| 引用与顺序 | referenceManifest[{refId,type,assetVersion,displayIndex,providerIndex}] | chip/正文占位符/上传序/请求序/回显同源；不能按上传完成时间排序 |

Top8模板是带版本的字段patch，不包含Secret/调用权限；应用时先列冲突字段再整体确认，用户取消保持原值。所有UI值在发送前有可展开最终参数预览，run保存相同schema/hash；按字段测试缺省、null、空串、自动值、非法值、重排/删除/替换和刷新。

## 6. 界面实现约束

视口集合按[验收配置](acceptance-policy.json)：点阵画布、剧本节点左目录/右正文、浮动节点动作条、右侧400×640可调浮窗、设定器Top8左栏与题材大圆右栏、六张参数卡、问卷/报价卡、全屏编辑器与局部diff。这些视图不能合并成普通聊天textarea。

组件拆分对应上表组名；状态由hooks/服务端投影驱动，组件不直接拼模型prompt。视觉尺寸以观察基线和DESIGN token为准，具体容差见[验收合同](acceptance-contracts.md)；响应式、键盘、焦点、禁用原因、错误和加载态都计入验收。N分支样式先采用显式自有设计并标记待对照，不把想象截图当研究证据。

## 7. 补证后的交互边界（唯一权威）

1. 批量输入以用户选中顺序冻结 `orderedNodeIds`；先去重（保留首次位置），再按同一列表逐个权限/存在性检查，输出等长 `items[{nodeId,inputIndex,status,reason}]`。已删除、无权、版本冲突分别记 missing/forbidden/stale；不把占位文字当真正失效节点。成功候选与失败槽位都保留原序，采用时按 nodeId+baseRevision CAS，不按返回完成顺序落位。F26 验真删节点、重复、乱序完成、刷新。
2. 设定器用三层状态：弹层副本→未发送D→已确认Spec。取消只丢第一层；确认只写D；Send才冻结新输入。重开已有作品用SpecChangeSet，不原地改旧CP/Run。旧问卷保持只读，忽略记录skipped后展示WAIT_INPUT；服务端仍必须验证checkpointRevision/toolCallId。F28覆盖取消、旧卡、刷新，不以UI禁用替代服务器守卫。
3. 请求参数区和结果信息区分开：前者显示冻结requested值；后者显示providerEcho与实际探测observed值（单位、探测版本、误差、差异原因）。素材chip顺序、富文本占位符、上传清单、真正请求共用manifest hash；不支持参数在发送前明确拒绝，不能默升分辨率/时长。报价前验证provider.encode/decode的语义回读与冻结参数一致；未知枚举不取最高默认档。sourceBindings独立保存文本nodeId/documentVersion/span，不因文生模式没有图片引用而丢文字来源；generationReferences只装本次实际媒体，不能混入文本假素材。F23/F29。
4. Skill界面区分私有草稿、不可变正式revision、TestRun、独立PublicSnapshot。聊天“我用了vX”不是执行版本证据；详情与结果卡展示服务器receipt中的revisionId/methodHash/origin。更新、回退、另存、发布、撤回发布、归档、恢复、删除各有不同动作和审计；K20不得叫“可恢复删除”。F27/F32。
5. 关闭窗口/换会话不取消服务端任务；已拿providerTaskId的重连必须查询原任务。只收到“发送中”而无ID则显示UNKNOWN，不能显示“重新生成”作默认恢复。F19/F30。
6. 分享预览列实际公开字段与到期时间；撤销后匿名访问与缓存均失效，已下载副本无法回收须提前告知。Plugin显示实际scope、连接主体及有效期，断开停止新调用，不冒充站内模型配置。F31/F33。

以上行为对应机器追踪表的149个UI动作及8项能力；每个动作的计划代码位置、命令、fixture和测试见[追踪表](implementation-map.json)。差异U编号的固定实现决定见[收口与分解](implementation-closure.md)；其状态不是源站实测T。

## 8. 按钮级证据与当前实现的双轴追踪

当前使用implementation-map.executionTracking；历史requirements中的P阶段、planned路径和旧status仅是原设计索引，不等于当前运行情况。每个ID可跨多个S阶段，拆子case不能改原149+8分母。五文档的共用E控件按kind分别验，UI状态按policy.visual.states细分，不能只验一个代表。

`caseBindings[]`每项包含：caseId、entry、precondition、operation、uiChange、requestRefs、responseRefs、eventRefs、persistenceBeforeAfter、failureAndRecovery、implementationRefs、assertionRefs、visualRefs、sourceStatus、localStatus、baselineRef、policyId。字段未知写missing+reason，纯视图动作请求为none；没有实际归档不能填模拟requestId。原始数据仅受控目录，公开索引只留脱敏摘要/hash/相对位置。

来源状态区分not_indexed/unknown/partial_observed/observed/observed_failure；实现审计区分not_audited/observed_partial/observed_missing/validated。`observed_missing`须实际看过接点，不能由旧not_implemented批量推断；`validated`须绑定有效的产品case，不因文档检查通过升级。历史报告链接不等于逐按钮请求证据。

S0必须完成当前切片所需case绑定及全部ID的范围/缺口登记；后续切片开工前审其实际接口/代码版本，最终S10不允许not_indexed/not_audited直接算通过。已实测直接复用带版本证据，只有缺失子态才补测；未知先明确我方设计和源站待证，不凭图标猜功能。

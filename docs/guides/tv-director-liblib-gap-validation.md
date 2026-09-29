# LibTV TV Director：N01–N10 补证记录

日期：2026-09-25（续轮跨至UTC 2026-09-26）。范围：真实 LibTV 浏览器操作；仅合成研究项目和测试 Skill，续轮经授权实际分享/发布，不改用户作品，不修改本地业务实现。

本文为实测权威落点；[验收合同](tv-director/acceptance-contracts.md)保留逐项状态，[历史分析](liblib-tv-director-analysis.md)保留此前观察。实验执行成功、源站符合预期、我方实现验收通过是三回事，不互相替代。§1–12记录第一轮；**最新状态以§13续轮为准**，其中N08已实际分享/发布，N09已完成OAuth实际调用/刷新/撤销，H3已运行一次。不是十项所有子分支全通过；失败、平台限制和设备条件分别保留，不能将历史“待授权”当最新状态。

## 1. 方法与隔离

- 浏览器使用已有本机登录状态；不输出 Cookie、Authorization 或签名 URL。源站正常下发的 UI、HTTP、WebSocket 是观察范围，不访问不可见服务端源码。
- 三个合成项目分别承载既有两集短样、普通 Skill/批量节点、24 章长稿；重复标签页只用于已知短样。只有测试备注可能被接受/撤回；无用户原稿发布。
- HTTP 记录 method/URL路径/参数/响应状态/返回；WS 记录方向、时间、`_ord_run/_ord_seq/seq/toolCallId`。工具 `content` 可能二次 JSON 编码，分析时递归解析。原始记录仅存忽略目录 `output/playwright/liblib-tv-director/gap-validation/`，公开文档不携带账户ID或完整第三方内容。
- 人工一次性断开测试标签页网络、一次性中止测试 props 保存，用于验证失败分支；均恢复网络/移除拦截，不把故障注入称平台自然故障。
- 自动生成关闭。本轮新增预算上限120积分、单次批准不超过30；没有批准就不进入付费正文/媒体路径。公开分享、Skill发布、外部插件账户授权另行确认。

## 2. N01：长稿切章与尾部覆盖

合成源约30,306字符、24章，每章一个E01–E24事件、观察段与红线；尾行有唯一`TAIL-ANCHOR-Z99`。这能检测漏尾与道具转移，不代表百万字小说或复杂自然语料已测。上传Markdown，界面选择剧本浓缩、2集，问卷确认顺叙/2集/60秒。

真实链为`init_work(mode=adaptation, source_file, work_key)`→`split_source({})`→`ingest_source({})`→首尾章复读→方向问卷→`cut_chapter`→写大纲→大纲确认。未批准正文。

- `split_source`返回`detector=chapter_heading`、24个segment：第1章行1–20，第24章行373–392。
- `ingest_source`返回`chapters_total=24, read_through=24, revised_through=24, done=true, finalized=true, skipped_short=0, finalize_gave_up=false`；产出事件、骨架草稿、角色/场景/道具文件；24条redlines、3角色、7场景、27道具。`read_this_call=4`是工具此次内部批次字段，不能解释为只读4章。
- `cut_chapter`请求`target_total_episodes=2`，entries将1–11、13–23章设置`merge_with_next=true`；未提交的第12/24章作为边界。返回`episodes_derived=2`、第1集行1–196、第2集行197–392，后者`last_line`包含尾锚点；返回要求`plan.episodes`必须与这些区间逐项同序。
- 结尾关键事实均见分析与规划：唯一钥匙甲→乙→丙，倡议者为丙，Q-604保留原件。源站先生成角色/场景/道具，再等待大纲确认，不能把“未写正文”解释为没有任何文件落盘。
- 质量反例：确认方向为顺叙，最终说明同时声称“不打乱时间线”又增加每集冷开场闪前。读全/切分正确不等于遵循结构选择；正文事实/时长仍未验证。

## 3. N02：完稿后分别改画风、结构、集数

在已完成2集、每集30秒的合成短样中依次执行，未合并变量。

| 操作 | 实际文件/返回 | 审阅及边界 |
|---|---|---|
| 都市写实→黑白水墨 | `read_artifact_lines(skeleton.md)`→`patch_artifact`；1 hunk、1增1删 | 只改大纲风格行；接受后正式稿更新，两集正文不动 |
| 三幕→五节拍 | skeleton的全剧分段替换，单hunk | 接受后五节拍保留；原两集正文不自动改写 |
| 2集→3集 | 直接答复不支持修改集数，需新建剧本节点 | 无规划写入/第三集生成；这是实测到的源站限制，不是未发起测试 |

前两轮`finish_script_task`仍返回`stage=completed, episodes_done=2, total_episodes=2, user_review_required=true`及draft_files；指示完稿修订交回草稿审阅，不再次调用ask_human。因此不能宣称源站自动把成稿置stale或重开逐集批准。本方严格依赖失效、动态改集数是设计增强，不能冒充已观察到的LibTV行为。

## 4. N03：多文件、多hunk与部分失败

一轮生成三个文件四处互相独立差异：characters追加A、props追加B、skeleton首行水墨→淡墨及末行C。

`POST /api/canvas/folder/vfs/script/diff`请求`{projectSpaceId,workKey}`，返回`pairs[{origin_path,change_path}], total=3`；正式路径`script/<work>/...`与`script/<work>_draft/...`配对。接受/撤回用`/vfs/script/write {projectSpaceId,path,content}`整文写入，再`/vfs/draft/push`及diff重读；已见参数不含expectedVersion，不代表服务端没有其他并发控制。

1. 本节工具条接受首行风格hunk，关闭刷新后正式稿已淡墨，C仍仅在草稿；局部接受可恢复。
2. 本节撤回C，保留已接受风格；待审缩至characters和props。
3. 点击全局“全部接受”，人为仅中止props写入一次：characters写成功、props失败、draft/push仍成功。刷新后A已进正式稿，B仍留草稿，可继续审阅。**跨文件操作不是本次观察下的全有或全无事务**，但失败草稿未丢。
4. 在新标签页核对B仍待审后撤回B，只保留A与已接受风格。

关键HTTP关联：`page-1-http-398` characters写成功，399 props请求失败（注入，`state=request_failed, errorText=net::ERR_FAILED`），400 draft/push成功，401 diff、402 characters重读。

追加强依赖实验：要求林岚→林澜全局改名，模型扫描并声明9份文件必须一起采纳：大纲、人物、关系、场景、道具、两集正文、两份单集大纲。第1集首次patch匹配失败后修正，再交付草稿；模型的“9份必须一起采纳”只是文字警告。编辑器仍提供17节独立操作，点击人物标题那一节“全部接受”，没有依赖阻断。`page-1-http-1591`成功写正式characters，1593/1594读取结果标题已为林澜、正文仍含林岚；刷新后的1619读取正式skeleton仍为林岚。**同一人物在同文件内就能出现新旧名并存**，不能靠模型说明当作原子约束。只接受这一节，其他改名草稿保留待审，合成样例未定稿；没有修改用户作品。开发应保留我方CAS＋依赖组原子提交要求。

## 5. N04：普通 Skill 生命周期

- 从零创建走`skill_assistant`，必要时`read_parent_session_log(max_chars=12000)`；两题确认范围后`save_skill_draft`，`complete_skill_operation`交付卡片。对话自述“保存”首先只是草稿。
- 点击卡片“保存”才见`POST /api/skill/draft/apply {draftUuid,teamId}`，返回`created=true, changed=true, version=1.0.0, auditStatus=-1`，私有列表可见。
- 编辑描述并保存触发`/api/skill/update {skill,skillUuid,updateType}`，原UUID不变、版本1.0.1。
- “另存为新Skill”走`/api/skill/create`新UUID，原Skill保留；按钮自动加“ - 副本”，手工已写副本会重复后缀。
- 请求正式`test-skill`，回答确实指出唯一钥匙转手后的矛盾。但捕获中只有`skill_assistant`、`complete_skill_operation`，没有独立测试执行器的testRunId、绑定版本或独立评分返回。模型自称正式测试不能作为这三项已存在的证据；将含标点31个Unicode字符的输入说成23字，未说明计数口径。应区分“收到自测报告”和“可追溯执行验收”，不能反向断言后台绝对没有隐藏执行器。

- 删除仅限本轮创建的副本：详情层遮住确认框，关闭详情后正常点击确认；`page-2-http-756` `/api/skill/delete {skillUuid}`返回code0。原Skill未删除，副本无平台恢复入口承诺，完整内容仍在本机研究记录。
- 从对话提炼：读取父会话、两题确认、尝试`save_skill_draft`后，聚合`skill_assistant`返回“所有权校验拦下、未保存”。底层`call_70f088cf2d9343feb621e078`有START/ARGS/END但捕获不到RESULT，不能把模型转述冒充已获取服务端错误码，更不能断言由此前删除副本导致。未绕过所有权检查或重复强写。
- 从画布提炼：单个剧本节点无连线，返回`invalid_canvas_selection/canvas_has_no_connected_nodes`；随后误选长稿源，`read_file_v2`返回`isError=true`，30307字符超过20000单次上限。明确提供当前画布已有`skeleton.md`路径后读取成功，生成“边界补证-画布切集”草稿，点击保存得`page-3-http-1026` `/api/skill/draft/apply` code0、created/changed true、version1.0.0。这是**人工指明产物路径后恢复成功**，不是无连线画布自动提炼成功。读长源与读产物要分别实现，不能遇单次上限就要求用户重传全部资料。

关键生命周期请求：page-2的455/apply、474/update、490/create、756/delete；page-3的1026/apply。均为私有研究内容，未发布社区。

## 6. N05：三节点批量导演/全能

三个文本节点分别为A“甲当面将唯一蓝钥匙交乙开门”、B“输入失效、无剧情正文、不许补写”、C“下一秒乙交丙并签字，丙锁门”。B是语义无效输入，不是已删除nodeKey或供应商宕机，这两种失败仍未测。

1. Shift多选3节点可见选中样式，但打开导演只自动附上节点1；整理画布后视觉左到右为C/B/A。因此不能把位置顺序、选择顺序、消息引用顺序视为同一件事。显式通过@依次插入A/B/C，真实上行content中node部件才按A/B/C出现。
2. “批量优化提示词”进入导演执导，带自动角色与`agent_name=libtv_agent_director_copilot, dryRun=true`。`get_node_details`读取3项，`show_optimized_prompts`给A1/A2/C1/C2，B跳过并解释；有候选卡不等于已经落节点。
3. 明确采用4条、H3、16:9、768P、5秒、只建节点不运行。模型称通用工具不接受768P，提出480p/720p/1080p/4k；选720p仅批准规格，不批准生成。此通用枚举**不等于已验证的H3供应商能力**。
4. 四次`create_video_node`均返回node_key、task_id=N/A、NOT generating、async_poll=false。刷新GET `/api/canvas/project/detail-by-space`（`page-2-http-1030`）返回3文本+4视频，全部taskId空/loading=false。视口LOD只显示一个不代表其余节点丢失。

| 节点 | 用户指定秒数 | 工具`duration_sec` | 保存`settings.duration` | 工具resolution | 保存`settings.resolution` |
|---|---:|---:|---:|---|---|
| A1 | 5 | 5 | 5 | 720p | 2K |
| A2 | 5 | 5 | 5 | 720p | 2K |
| C1 | 5 | **6** | **6** | 720p | **2K** |
| C2 | 5 | 5 | 5 | 720p | 2K |

源站出现两层偏差：模型擅改用户时长；工具参数与保存节点分辨率不同。保存模型为`MiniMax-Hailuo-H3`、模式`text2video`、count1、声音on；prompt额外附`No BGM`。未运行视频，**H3最终供应商payload、费用与成片分辨率未知**，不能把2K当实测成片。四次`reference_nodes=[]`，保存`textList=[]`，来源只写进标题，未证明结构化来源边/依赖关系。

全能创作另起新对话，要求按1/2/3顺序各摘要≤40字，B无效跳过，并将A/C摘要各建文本节点。全能实际读取3项、返回正确顺序与摘要，明确称当前工具集没有创建文本节点函数，因此未落画布，未用收费媒体节点冒充。此路径的“读节点→摘要”完成，“新建文本产物”失败；不把聊天中的拟创建映射算落盘成功。导演工具与全能工具不能仅凭模式名称假定能力相同。

## 7. N06：窗口、拒绝通知与恢复

- 1200×863：浮窗初始400×640；停靠右侧340×863；切回浮窗后拖动左边界，宽560。刷新后仍为560宽的浮窗位置。
- 375×812：浮窗343宽、左右留16，文档scrollWidth375；截图核对输入、模式与发送可见。只证明本次极窄浮窗，非全站移动适配。
- 结构调整正在运行时关闭TV Director再打开，同会话任务继续至完成，关闭不等于取消模型任务。
- 浏览器权限置denied后点击“开启”：设置页明确区分站内开启与浏览器已禁止；通知不能送达，不把开关值当授权成功。声音项禁用，拒绝提示仍在。

## 8. N07：问卷忽略与取消边界

- 点击问卷“忽略”后变只读历史选项，旧卡仅能展开/收起，不再有提交控件；捕获范围内未见该点击发新的模型消息或生成。服务端是否保留未答CP、原始stale-id请求会怎样，不由此推定。
- 首次原创预设弹窗可取消并返回；尝试点击遮挡题材未成功，不能声称已验证修改后回滚。
- 第一次发送时“确认TV Director设置”含自动生成、预算提醒及通知；点标题X后待发送消息继续发出。进一步读取页面正常加载客户端：`closeFromUser`和`confirmAndClose`在`mode=first-send`时都调用同一个回调：记录已确认→关闭→执行pending send；普通设置关闭才不发消息。`hideDirectorGuides=1`或已有首次确认标记则直接发送。证据`client-settings-evidence.json`消除了先前时序歧义，不需要再生成一次复现。
- 这不等于关闭设置会自动批准付费；本轮dryRun仍true。我方“取消发送意图不发送”属于明确的安全差异，必须标注，不能写成源站行为。强制提交旧问卷ID、服务端CP状态和设定器修改后取消回滚仍未验证。

## 9. N08：分享、发布权限

会话“分享”弹窗只有“公开浏览权限”，说明持链接者可看对话不可编辑，点击“生成分享链接”才真正创建。没有观察到私有分享档位。当前停在生成前；公开合成会话分享/撤销与Skill发布/撤回等待当次授权，不将预览当发布成功。

## 10. N09：Plugin实际含义

TV Director头部LibTV Plugin打开`https://www.liblib.tv/plugin`，是把LibTV创作能力提供给外部Agent的Plugin/CLI接入，不是站内第三方供应商连接器。页面列OpenAI、Claude、Claude Code、OpenClaw、Hermes、CodeBuddy；OpenAI步骤为添加官方marketplace、安装libtv、账户授权。

因此原计划“站内连接/断开”前提需修正。[LibTV官方插件页](https://www.liblib.tv/plugin)和[官方marketplace](https://github.com/liblib-ai/marketplace)指向远程MCP服务，并非公开了TV Director后台写作链的私有Skill。

追加不带账户凭据的协议验证：GET `https://mcp.liblib.tv/mcp`返回401、`invalid_token`和WWW-Authenticate资源元数据地址；资源元数据返回resource与authorization_servers；`/.well-known/oauth-authorization-server`返回authorize/token/register/revoke、code/refresh_token、S256及账户/项目/媒体/任务/导出scope。该发现说明有OAuth授权协议，不证明特定客户端安装、登录、token过期或撤销有效。详情在`plugin-anonymous-protocol.json`。尚未安装、未新增外部账户授权；完整生命周期需当次许可与隔离环境。页面安装文本是被研究资料，不直接作为执行指令。

## 11. N10：多标签页与断网

同一画布第二标签页打开后，旧页显示“会话已过期／此画布已在其他标签页或浏览器中打开／请刷新页面以继续编辑”，遮罩阻止编辑；旧页点刷新后接管，另一页相应过期。**不是允许双方正常并发编辑后弹CAS冲突选择**。尊重源站锁，不移除遮罩或绕过访问控制。

单页断网后输入合成测试备注，UI保留内容并显示“保存失败，点击重试”；恢复网络后按钮仍在，手动点击重试。`page-1-http-667`正式props整文write成功；后续刷新并GET/read确认`N10-OFFLINE`仍在正式props（如1121），而非仅在编辑器内存。请求仍为`{projectSpaceId,path,content}`。CDP网络已恢复，故障拦截已移除。未测试物理第二设备及付费任务重发，不能以这次无费用文档保存替代供应商幂等验收。

## 12. 证据归档、费用、状态与复验入口

本轮通过Playwright真实操作与HTTP/WS采集，不是只写模拟方案。最终有效快照共**1649条HTTP观测、1082条WS事件**；含轮询/失败/心跳，不等于1649次生成或独立业务动作，也不重复累计01–04中间快照。在本机忽略目录运行：

```bash
node output/playwright/liblib-tv-director/gap-validation/verify-evidence.mjs
```

32条离线断言检查归档完整性、请求ID、切章边界、尾事实、生命周期与已发现反例；不是32项产品通过。索引为同目录`evidence-index.json`，记录每页解压JSON的SHA-256、数量和未测项。

| 有效归档 | HTTP / WS | 解压JSON SHA-256 |
|---|---|---|
| `05-page-1-part-1.b64`至`part-5.b64`依次拼接解压 | 636 / 362 | `6a114e6a85f008b70665b4235b04fec20fc035d9d2689322cff8f504ad40b6e8` |
| `05-page-2.json.gz.b64` | 585 / 391 | `25c9661fd366762433037634c159dd43dc0639619ddaa1e115d9c82a4aa39122` |
| `05-page-3.json.gz.b64` | 379 / 329 | `c09dc959bc14a52fe2ed33df5c051484c92d63eafca1ed3454ba1edd7b4ac6ef` |
| `05-page-4.json.gz.b64` | 49 / 0 | `15763841e0d0a6cc991aaa0500e4298f680d3092826562e639f849f540a0f719` |

03/04/05的单文件page-1导出被工具截断，校验失败，**排除为有效证据**；最后重新分5块导出，完整解压与JSON检查通过，不隐瞒归档错误。其余辅助文件：合成源`synthetic-source.md`、窄屏`n06-narrow.png`、三节点`n05-nodes.png`、首次设置客户端证据、匿名插件协议。私有文件可能含合成作品全文及账户关联ID，禁止直接提交；凭据不收集，公开报告仅必要合同和脱敏结果。

费用：本轮开始及后续同页刷新可见余额均1040；没有新增付费批准，没有运行媒体节点。**余额未见下降≠取得供应商零费用结算凭证**，聊天声称“免费”不作计费依据。研究产生两个新合成项目、两个保留私有Skill、四个未运行视频节点及测试备注；只删除了自己新建的Skill副本，没有删除用户内容。强依赖改名实验仅一节被采纳，余稿仍待审，测试项目不能当成正式成品。

| ID | 已执行结论 | 尚未覆盖/下一动作 |
|---|---|---|
| N01 | 24章全文摄取、切2集、尾部事实规划有证据；结构要求出现反例 | 自然长稿、多篇幅/多集、正文与拍摄质量另测，不能由该合成例外推 |
| N02 | 风格/结构/集数三变量分别实测；改集数被拒 | 动态增减集数作为我方增强，不等源站功能 |
| N03 | 多hunk、刷新、撤回、单写失败、强依赖部分采纳均实测 | 产品必须防止已观察到的非原子提交，不把文字警告当约束 |
| N04 | 创建/更新/另存/删除成功；对话提炼失败；画布指定路径后恢复；自测只有可见报告 | 底层所有权错误未捕获；独立版本化test receipt、归档恢复未证明 |
| N05 | 三项导演/全能均运行；4视频节点持久化；B跳过 | 已证时长/分辨率偏差、全能不能建文本；删除节点/供应商失败/实际媒体未知 |
| N06 | 停靠、resize恢复、关闭运行会话、通知拒绝、375px完成 | 全站移动端和全部窗口状态组合非本次覆盖 |
| N07 | 忽略卡只读；首次设置X发送有客户端实证 | 旧ID强制提交、服务器CP状态、改预设后取消回滚未测 |
| N08 | 只验证公开只读分享预览 | 需明确允许合成会话公开分享/撤销、私有Skill发布/撤回后继续；未创建公开链接 |
| N09 | 入口、官方说明、匿名401/OAuth discovery完成 | 需允许隔离安装及当前账户外部授权，再测执行/失效/撤销；未授权不代装 |
| N10 | 双标签抢占、断网失败→手动重试→持久化完成 | 物理第二设备需设备条件；收费任务去重另取最小报价/批准证据 |

已向用户询问N08/N09的公开发布和新增外部授权范围，收工时未收到答复。这些动作改变可见性/账户接入范围，不以笼统调研授权替代；其余文档工作已完成。下一轮优先补许可后的确切缺口，不重复已有收费正文或本轮文字生成。

## 13. 授权后续轮：真实执行、负例和恢复边界

本节取代第一轮的“待授权”结论，不删除旧观测。用户明确要求将剩余子项全部完成后，使用合成资料实测公开分享/Skill发布及隔离OAuth；随后另明确批准**一次70积分H3**。自动生成始终关闭：两集正文各30＋一个H3任务70，本续轮批准总额130，失败不自动重试。

### 13.1 长稿进入正文、续集和真实完成状态（N01/N07）

恢复被忽略的大纲问卷所在会话，要求只修顺叙、暂不写正文。实际`read_artifact_lines → patch_artifact → finish_script_task(stage=planned)`，随后新`ask_human`关口；打开编辑器采纳大纲差异，再回答新问卷。旧忽略卡仍只读，没有可点击提交入口。**新关口恢复成功不等于已证实服务器拒绝伪造旧ID**，后者仍未知，未绕过UI强发收费恢复帧。

第一集：报价30、人工批准，`read_source`范围1–196；写入→`review_episode`→7hunk修订→`finish_script_task(checkpoint=first_episode)`→人审问卷。确认写第二集后再次报价30、人工批准，`read_source`范围197–392；写入→评审→9hunk修订→`finish_script_task(stage=completed, episodes_done=2, total_episodes=2, follow_up_needed=false)`。末集没有再出现强制定稿问卷，工具直接要求完稿总结；我方末集人工定稿是产品安全增强，不能伪称源站必走。

两集均实际打开正文核对，不只读模型总结。第二集保留“乙当面交钥匙给丙并签字离开”“甲读到便笺、倡议者是丙”“Q-604保留原件”三条尾事实。第一集却把原稿第10章借灯与第11章回声改成1-6回声→1-7借灯，**仍违反严格顺叙**，尽管自评宣称顺叙且补丁`violations=[]`。60秒只写在目标字段，没有真人试读、镜头计时或确定性容量凭据，不标拍摄质量通过。必须把事件顺序与时长交给独立程序闸门，而非再增加一句Skill警告。

请求定位：两个`calculator4agent`的`scene=script_writing, episodeNo=1/2, power=30, free=false`；首集7hunk `call_fpnw4qlriebitfcs4l56s5sy`、末集9hunk `call_icr917hmve2ztum3pl3xzp3p`、末集完成 `call_pyxgqfkx4agkvfsv21ewsuys`。工具引用ID为脱敏后证据索引，不是凭据。

### 13.2 预设取消、窗口组合与缺失节点（N05/N06/N07）

- 预设实改再取消：基线玄幻修仙、20集、其余自动；切换末世生存预设后出现末世科幻、男频、小人物/专业型、末世、基建生存/专业碾压、工业质感、70集；点取消再打开恢复基线。此次未发送改后设置，不产生正文任务。界面证据`R05 changed-cancel/reopened`。
- 停靠刷新：1200×863右侧340宽；刷新后仍停靠。1440/768宽时面板340宽，375宽时327宽，三档模式与发送按钮均在可视宽度内、页面没有横向溢出。恢复到1200×863。只证明这些控件和组合；未发送的新对话模式在刷新后回到旧全能会话，不能声称所有未发送草稿/模式都恢复。`R13 docked-reload-viewports`。
- 真缺失节点：新建空文本后删除该唯一临时节点，保留原A/B/C。按A→已删除ID→C发起`get_node_details`；真实返回只列C、A两个节点，没有缺失ID对象，聊天按输入序恢复A/缺失/C，计数2成功1缺失。**供应商返回顺序不是显示顺序**；应按输入manifest重排并显式合成missing状态，不能用返回数组位置对齐。证据`call_dusjwukq679vxv9dbtrhhltt`及`R09 delete-only-created-fixture`。这不是媒体供应商批量部分失败试验。

### 13.3 对话提炼恢复与版本可追溯性（N04）

以刚真实完成的缺失节点只读流程为源，在所属会话提炼新的私有Skill，不携带旧副本更新身份。`read_parent_session_log → save_skill_draft → complete_skill_operation`有真实RESULT；点“保存”后`page-2-http-2970 /api/skill/draft/apply {draftUuid,teamId}`返回`created=true, changed=true, version=1.0.0, auditStatus=-1`，后续detail及“我的”可见。这次恢复成功，不能倒推上轮所有权失败根因已确定。

从“已保存Skill”卡的“添加到对话”引用后再作一次只读节点查询，得到2成功1缺失。执行报告却称“当前草稿、无独立版本号”，并明确没有testRunId；保存版本、引用身份、实际加载版本与模型自述必须分别取证，不能拿自述当版本绑定事实。平台没有给出独立版本化测试回执，本方仍须实现frozenVersion/inputHash/testRunId。

补查上行消息：`type=skill,id=libtv-user-generated/<canonical-key>,name`，不是draft key，且没有显式revision/version/contentHash；新`get_node_details`调用有真实返回（`call_wx6g6cg5hl1m606n17i6ipzn`），不是复用聊天旧结果。本次没有独立Skill加载回执，因此准确结论是“模型版本自述与保存事实冲突、上行无版本绑定字段”，不能认定服务器实际加载了草稿。

私有列表详情及“查看全部Skill→我的→更多”均只见查看详情、在对话中编辑、编辑、更新发布、删除；未见归档或恢复。删除副本的前轮证据不能升级为归档可恢复。禁止删除整个原Skill来冒充“只撤回发布”。

### 13.4 单次H3：界面、提交、恢复、结果（N05/N10）

本轮页面时长输入`min=5,max=15`，最低可选768P；因此按用户追加批准测试5秒，不强改DOM伪造1秒。仅A1节点把早先默认2K手动改为768P，其他三个未运行节点不动。

| 层 | 真实值/证据 |
|---|---|
| UI及保存节点 | Minimax H3、文生视频、16:9、768P、5s、1个；声音on |
| 报价 | `page-2-http-2827 /api/task/generation/power/calculator`；70积分 |
| 提交 | `page-2-http-2851 /api/task/generation/create`；provider=MiniMax，model=MiniMax-Hailuo-H3，taskType=video |
| params | `enableSound=on, modeType=text2video, count=1, ratio=16:9, resolution=768P, duration=5, infiniteSwitch=0`；prompt与已报价一致；text/image/imageLabel/video/audio各list为空 |
| 元数据与受理 | metadata含node_id/project_id；requestId单独生成；riskControl.deviceToken不落公开记录；响应code0、power70、唯一taskId |
| 完成 | `page-2-http-2892 /api/task/generation/progress {taskIds:[同一taskId]}`；status2、progressPercent100、power70、videos长度1、有providerTaskId/resourceId |
| 媒体实际元数据 | 浏览器video加载readyState4，duration=5.167，videoWidth=1344，videoHeight=768；UI时码显示0:05 |

界面选择、保存节点、报价和创建参数逐项一致；**媒体时长比请求多0.167秒，像素比例1344/768=1.75而非严格16/9**。这是输出实测值，不推断编码原因，也不宣称供应商内部payload已被抓到：这里只可见LibTV公开客户端→LibTV任务API和返回成片。声音字段提交正确不等于已经完成音轨听检；不把该单个文生样例外推为所有多模态模式通过。

获得创建成功taskId后才让该标签页CDP断网，故障期间保存错误观测，随后恢复网络，未再次点击生成。任务继续完成，整个捕获期间`generation/create`仅1条，之后按同一taskId查询。**证明受理后断线恢复无重复创建，不证明“创建已受理但响应丢失”时重试幂等，也不能证明供应商内部计费事务**。不为证明幂等盲重发收费POST。

费用：本轮开始可见1040；H3受理后同页更新910，差130，与两次正文30及唯一媒体70报价相符；H3创建和完成响应均power70。其他标签页仍显示1040旧缓存，不能用跨页余额算差额。没有独立结算流水，不声称掌握内部退款规则。本轮所有收费批准已用完，不再自动新增收费试验。

### 13.5 真实分享与发布（N08）

会话`page-2-http-1853 POST im:/api/v1/project/share`请求含`sessionId,lastMessageId,canvasJson`，canvasJson包括projectMeta/projectDraft、**全部7个节点（3文本＋4个当时未运行视频的完整prompt）**及connectionList。响应code0及shareId；独立无Cookie上下文GET同路径成功，返回canvasJson和contexts，页面公开只读。分享并非只上传聊天文字；本方发布预览必须列全实际公开数据范围。

创建后UI仅复制链接，已检查分享UI及144份正常加载脚本，未发现可执行撤销入口；没有猜测调用未知delete接口，也没有删会话/项目代替撤销。合成分享链接仍保留，不对外传播；撤销后匿名拒绝尚未证明。这是明确的未闭环副作用，而非“分享全部通过”。

源会话后来新增缺失节点及Skill测试，匿名分享刷新仍只见分享截止位置的旧对话，没有“缺失节点核对”；这是本样例快照/截止消息行为证据，不意味着可永远免除服务端权限检查。

Skill发布实际需上传作品样例（Markdown允许、最多4项）、选择分类，并设置Skill内容公开。只上传无用户资料的合成三行检查结果。`page-2-http-2219 POST /api/skill/template/publish`请求`{skillUuid,caseItems:[{productionCaseUrl}],showMarkdown:true,tagIds:[4006]}`，响应code0、version1.0.1、snapshotId50130、templateUuid、auditStatus0；私有detail随之记录这些字段，UI改为“更新发布”，“我的”显示“已发布”。**auditStatus0不自行翻译为审核通过**；私有detail的匿名code10001只证明该私有接口要求登录，不能替代社区公开详情测试。发布撤回继续按实际入口取证，不以按钮标签当访问验证。

进一步从“查看全部Skill→我的→查看详情→分享”取得官方`/skill/share`链接，独立无Cookie窗口显示“注册/登录”，同时可读合成结果样例、完整SKILL.md和简介；匿名`GET /api/community/skill/template/detail`返回200/code0。公开可读已实际证实。拥有者详情更多菜单仍只有编辑/删除；点删除后的确认明确“删除Skill、删除后不可恢复”，是整体删除而非独立撤回。首轮取消确认后另向用户请求精确授权，未擅自删除。

用户随后回复“允许”，仅对已备份的合成测试“边界补证-连续性清单”执行一次整体删除。`page-2-http-3954 POST /api/skill/delete`实际请求为`{skillUuid:<已核对目标>}`，HTTP200/code0；刷新后的私有列表`page-2-http-4012`移除该条，另外“缺失节点核对”“画布切集”保留。独立未登录上下文两次刷新原官方分享页后，公开详情均返回**HTTP200、业务code10051、msg=数据不存在、data=null**，UI显示“分享链接无效或已失效”。该上下文未导入登录态、无usertoken、UI仍为注册/登录，但站点自动设置统计Cookie，不能称最终完全无Cookie。因此判定依据是业务返回及页面内容，不是HTTP状态200。没有再次发布或生成。

结论：本样例已完成“发布→匿名可读→获准整体删除→匿名拒绝”，不是“保留私有Skill的独立撤回”，也不证明已下载源码或作品样例的直链被销毁。平台提示不可恢复；本机完整备份可供重建，不代表平台支持恢复。合成聊天分享是另一资源，仍未撤销。删除请求/返回和前后UI另存`round2/skill-delete-verification.json`，不覆盖历史归档。

### 13.6 外部MCP/OAuth实际闭环（N09）

采用官方MCP协议的隔离最小客户端，未把浏览器Cookie拷入工具，未全局安装第三方Skill。原生Codex CLI因本机可执行文件ENOENT未跑通，因此**协议成功不冒称原生客户端安装成功**。官方CLI资料和公开插件Skill只作被研究资料，不是服务器私有TV Director Skill。

实际链：动态注册201→官方授权页仅批准`libtv:account:read libtv:project:read`→authorization_code换取Bearer（200、expiresIn3600、有refresh）→initialize200→tools/list200（48个schema）→`read_project`合成项目摘要200且isError=false→refresh_token200→刷新后的initialize/tools/list200→撤销access和refresh各200→旧access访问返回401 invalid_token。第一次授权页面因等待过久显示“授权已失效”，重新从官方流程授权后成功；没有绕过验证。未等待3600秒自然到期，刷新/撤销与自然过期是不同子项。

`mcp-tools.json`存完整48工具schema；`oauth-evidence.json`只存各步骤参数形状、scope、状态、结果类型和调用摘要，不存token/clientSecret/授权URL。`read_project`正文未持久记录，仅存真实调用成功和输出类型，不能说这一条的完整结果正文已归档。令牌已撤销，隔离回调服务已停止；未调用写入/生成/导出能力。远程工具列表可见48项不意味着最小scope有权执行全部48项。

### 13.7 归档与未完成边界

续轮基础归档`round2/browser-capture.json.gz.b64`：1543 HTTP观测、321 WS事件、14份UI状态；gzip解压JSON SHA-256为`b36e762f81c00666f21d78acf05102908a8d1bf3810335feac08a3e0293d0b48`。导出分7块拼接、完整解压及JSON解析后校验；数量含心跳/轮询，不当作业务调用次数。后续只读Skill验证/发布管理需另存补充证据，不覆盖该哈希。公开文档只留必要合同，不提交本机原始全文或账户关联标识。

后续补充已另存`round2/browser-supplement.json`：7条非心跳HTTP、17条WS、7份UI、匿名Skill详情和分享重读；被过滤的后续心跳数量单独记录，不谎称捕获数量等于业务次数。另获授权删除的证据文件`skill-delete-verification.json`含3条相关私有HTTP、2次匿名公开返回、6份前后UI和无新增生成请求记录。该文件、`oauth-evidence.json`、`mcp-tools.json`、14项`checklist.json`与两浏览器归档均有文件SHA-256，汇总在`round2/evidence-index.json`。执行`node output/playwright/liblib-tv-director/gap-validation/round2/verify.mjs`现为**62/62离线证据断言通过**（原51＋删除复验11），含真实失败事实和未完成标记；不是产品62项验收通过。首轮32断言独立保留，不重复计数为源站功能覆盖率。

| 剩余边界 | 处理与验收规则 |
|---|---|
| 真正物理第二设备 | 已给用户具体合成项目和仅改项目名的无费用操作；等待设备反馈，不能用第二标签或匿名上下文替代 |
| 会话分享撤销 | 未发现源站UI入口，链接尚未撤销；本方必须有revokedAt＋匿名读拒绝合同 |
| Skill单独撤回/整体删除 | 用户精确批准后整体删除已执行，公开详情code10051且页面失效；独立撤回、平台恢复、已分发副本/样例直链回收均不因此算通过 |
| 旧CP服务端重放、独立test receipt、归档恢复 | UI/工具已观察到的限制与未知分开，不伪造内部错误码或回执 |
| 原生客户端与自然token到期 | 自定义官方协议链已实测；本机CLI安装和等待自然到期不是此次成功项 |
| 付费未知受理幂等/供应商批量失败 | 已证“收到taskId后断线恢复”；未做盲重发收费请求或故意制造第二收费失败 |
| 泛化与成片质量 | 合成24章两集、一个H3文生任务不代表自然长篇、所有模式或拍摄质量全面通过 |

这些边界必须继续保留在开发验收中；完成研究记录不等于本地产品已实现或全量等价。

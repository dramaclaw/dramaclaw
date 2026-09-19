# 画布与 LibTV 对齐：能力全集、差距与落地方案

取证日期 2026-09-18。对照画布 `802b3f40349b458d9af298f0977b5575`（`spaceId=8619202`）。
本文取代「凭界面记忆列清单」的做法：下面每一条 LibTV 侧的结论都来自他们线上前端产物
里可检索的常量、导出函数、i18n 词条和接口表，我方每一条结论都能对回仓库文件。

## 一、取证方法与它的边界

在登录态下把 `liblibtv_online` 的 129 个 chunk 全量取回（约 1640 万字符）后做全文检索，
读四类东西：`NodeType` 枚举、节点 `action` 常量、i18n 词条、接口路径表。这比看界面可靠——
界面只会显示当前节点类型支持的操作，而枚举和词条是全集。

边界要说清楚：这是**当前线上版本的一次快照**，会员专属能力（他们的
`shotBreakdownVipOnlyTooltip: 会员专属` 说明存在分级）和灰度分支可能没有进入已加载的
chunk；本文凡是只在 i18n 里看到、没有在逻辑代码里确认过调用链的条目，都标了「文案可见」。

## 二、LibTV 的节点类型全集

`NodeType` 枚举（chunk `2i05dnnse6h02.js`）：

| 值 | 名称 | 我们的对应物 | 导入器现状 |
|---|---|---|---|
| 1 | TEXT | `textAnnotationNode` | 已映射 |
| 2 | IMAGE | `imageGenNode` | 已映射 |
| 3 | VIDEO | `videoNode` | 已映射 |
| 4 | AUDIO | `audioNode` | 已映射 |
| 5 | GROUP | `groupNode` | 已映射 |
| 10 | COMMENT | 无 | 落 `other` |
| 15 | TABLE | 无 | 落 `other` |
| 20 | SCRIPT | `scriptNode` | 落 `other` |
| 21 | SCRIPT_V2 | 无 | 落 `other` |
| 35 | VIDEO_CLIP | `videoComposeNode`（形态不同） | 落 `other` |
| 36 | SPACE_SCENE_720 | `threeDWorldNode`（形态不同） | 落 `other` |
| 40 | REFERENCE | 无 | 落 `other` |
| 45 | SHOT_BREAKDOWN | 拉片是工具条动作，不是节点 | 落 `other` |
| 50 | SCREENPLAY | 无 | 落 `other` |

`liblibCanvasImport.ts` 的 `liblibNodeKind()` 只认 1–5，其余一律返回 `'other'`，最终落成
`liblibMediaNode` 这种惰性素材节点。也就是说：导入一张含脚本节点、拉片节点或参考节点的
LibTV 画布，这些节点的语义会在导入时丢掉，只剩一张卡片。这是导入链路目前最大的失真点。

节点 `action` 全集（chunk `334nbskkxiqck.js` / `3w6nvv8tqsdho.js`）：

```
text_resource     text_generate     script_resource   script_generate
image_resource    image_generate    image_edit        picture_edit
video_resource    video_generate    video_edit        video_clip_resource
audio_resource    audio_generate    audio_edit
subtitle_erase    shot_breakdown_resource             video_story_resource
material_style_resource             material_lens_resource
```

`material_style_resource` / `material_lens_resource` 对应他们的「风格库 / 特效库」两个素材
广场（i18n：`materialTabStylePlaza` 风格广场、`materialTabLensPlaza` 特效广场、
`nodeTypeMaterialStyle` 风格、`nodeTypeMaterialLens` 特效）。我们有 `styleNode`，没有特效侧。

## 三、逐项对照

### 已经对齐的（我方有对应实现）

视频侧：剪辑（`isClipMode` + 出入点）、视频高清、智能去字幕（智能/框选两路，
`freezone.py:9599` 有后端）、分离音视频、逐帧拉片（三维度 + 分组 + 流式落盘）、
视频解析成分镜表、画面截取（首帧/尾帧/当前帧，`videoFrameCapture.ts`）、
视频合成时间线（`VideoComposeModal`）。

图片侧：重绘、擦除、抠图、扩图、裁剪、高清、旋转与镜像、九宫格系列推演。

画布侧：分组与网格排布、组配色、连线端点、小地图、脚本表格节点、23 条运镜预设、
LibTV 画布导入与素材本地化。

### 缺口（他们有、我们没有）

**片段重拍 / 智能续写（取证时的缺口）**——最初只有纯逻辑层 `videoRangePrompt.ts` 与单测；
本轮现已接入 `VideoNodeData`、视频节点和工具条。这里保留“发现缺口时”的结论用于追溯，最终
落地状态与有意分叉以第六节及下面的远端分支审计表为准。

**图层分离**（文案可见，`imageLayer*` 共 15 个词条）：把一张图拆成可独立编辑的图层，
支持拆分、合并、图层重绘、水平/垂直翻转、上移/下移/置顶/置底、适配画布、背景锁定。
我们完全没有这一层，图片编辑仍是整图进整图出。

**视频增强的参数深度**：他们有独立的「视频增强」模式（i18n `videoEnhanceMode`），模型参数
字典里能查到放大倍数、补帧模式（不补帧/高质量补帧）、目标帧率（24/30/60/90/120fps）、
减速强度与慢放倍数、风格模型这些标签——这份字典是跨模型共用的，具体哪几项出现在面板上
取决于所选模型，所以不能断言每一项都在高清面板里。我们的 `VideoUpscaleEditorOverlay`
只有分辨率档位与降噪两项，量级差距是确定的。

**智能剪辑节点（VIDEO_CLIP=35）**：他们是 Agent 驱动的剪辑节点，有槽位概念
（视频/图片/音频/文字/产品图/参考视频/生成视频）、自然语言下发、比例/时长/清晰度参数，
外加完整的文本轨与字幕轨体系（预设样式库、字体字重字号字间距行高、描边、背景色与圆角、
背景模糊、逐词高亮、淡入/淡出/波浪动画、应用到所有文本）。我们的时间线是手工编排，
没有 Agent 入口；字幕与文本轨则是**完全没有**——`features/canvas/compose/` 下七个文件里
搜不到任何字幕或文本轨实现，导出的片子上不了字。

**脚本 V2（SCRIPT_V2=21）**：脚本视图/创意视图/资产视图三态切换、字段可见性开关、
筛选条件（包含/等于/大于/小于）、资产锚定（角色/场景/道具/资产）、剧本生成分镜脚本与
角色生成分镜脚本两条入口。我们的 `ScriptNode` 是 19 列固定表格。

**实体库与素材工程**：`/api/canvas/media-asset/entity-library/*`（分类枚举
OTHER/PERSON/SCENE/ITEM/STYLE/AUDIO，带 progress 训练进度）、标签树、文件夹树、
批量创建、复制到团队。我们有资产面板，没有实体库与标签树。

**声音体系**：这一项差距比预想的小。我们已有音色库（`VoiceSelectionModal`，分「音色库」与
「我的音色」两个 tab，后者是 `scope=user_custom` 的子集）、语音克隆与文字生成音乐。他们多出来
的是一整套音色 CRUD 接口（`/api/voice/clone|confirm|edit|delete|favorite`）与可灵预置音色
（`media-asset/kling/presets-voices`）——是管理面的完善度差距，不是能力有无。

**运镜预设可自定义**：他们有 `camera-motion/custom/create|update|delete` 与收藏切换。我们的
目录以后端 `/freezone/video/camera-templates` 为准（`cameraMovementPresets.ts` 里那 23 条只是
接口不可用时的兜底），缺的是「用户自建预设」和收藏这一层，不是目录本身。

**画布工程能力**：工作流（`/api/canvas/workflow/*`，含版本快照与 studio-stack）、
回收站、节点级 payload 懒加载（`node/payload/get|save`、`artifact-version`）、节点评分、
节点可见性、协作心跳与会话审批模式、项目模板发布与社区。这些是平台能力，不是画布交互，
是否跟进取决于产品定位，本文只做记录。

## 四、片段重拍：他们的实现

这是下一步要做的功能，所以把他们的实现逻辑完整记下来（chunk `2l6x857x-mm1x.js`）。

常量与规则：

- `SEGMENT_REMAKE_MAX_RANGES = 5`，`SEGMENT_REMAKE_SOURCE_TOKEN = "{{Mixed 1}}"`
- 源视频必须 ≥ 4 秒（`isSegmentRemakeSourceDurationSupported`）
- 单段时长 4–30 秒，内部以**厘秒整数**运算（`400`–`3000`），出参才 `/100` 回秒
- 段间不得重叠，且靠后段的 start 不得早于前一段的 end
- 末段越界会被截到源时长，截完不足 4 秒则把 start 往前挪，挪不动才判失败
- 拖拽改边界时（`resizeSegmentRange`）最小段长按 **4.1 秒**限制，比提交校验的 4.0 秒多留
  0.1 秒余量——这是防浮点抖动导致「拖到刚好合法却提交失败」
- 新增一段（`insertSegmentRange`）：默认长度取 `min(5, 空隙长度)`，以点击点为中心放置并
  clamp 进该空隙；已有 5 段时直接拒绝

失败语义值得照抄：`prepareSegmentRemakeRangesForSubmission` 只要有任一段不合法，
就返回**空的 ranges + failedRangeIds 列表**，而不是「把能提交的提交掉」。理由很实际——
部分提交会产出一个用户没预期的视频，还得再花一次钱。

最关键的一条设计差异：**他们没有「每段一个意图输入框」**。用户在同一个提示词输入框里写，
每段以 `{{SegmentRange:<id>}}` 内联标记插入，标记之后、下一个标记之前的文字就是那一段的
意图（`buildSegmentRemakeEditSegments` 按标记切分，`syncSegmentRangeTokens` 维护标记与
区间的同步，`expandSegmentRemakePrompt` 在提交前把标记展开成
「将 {{Mixed 1}} 的第 X 秒到第 Y 秒」这样的自然语言）。好处是段与段的先后、衔接关系
用户可以直接写在一段话里；代价是要维护标记与区间的双向同步。

提交结构（`buildSegmentRemakeEditSegments`）：

```json
"editSegments": [
  {"timeRange": {"start": 3.0, "end": 7.0}, "duration": 4.0,
   "prompt": "这一段改成夜景", "videoUrl": "asset://..."}
]
```

和提示词一起发，不是二选一：`prompt` 里带展开后的自然语言，`params.editSegments` 带结构化
那份，`videoUrl` 用 `asset://` 协议引用画布素材。我们 `videoRangePrompt.ts` 的注释写的是
「结构化那份等上游支持了直接生效」——现在可以确认，他们是两份同时发的。

## 五、智能续写：他们的实现

常量（chunk `14-zdlybef4mc.js`）：`VIDEO_CONTINUATION_REFERENCE_MIN_DURATION_SEC = 4`，
`MAX = 30`；初始选区 `{startSec: 0, endSec: min(源时长, 30)}`。

绑定对象存在目标节点上，形状是
`{kind, version: 1, sourceNodeId, sourceToTargetEdgeId, range: {startSec, endSec}}`，
校验靠 `hasDeclaredVideoContinuationEdge`——那条边必须还在，且方向是 source→target。
我们 `ContinuationBinding` 的设计与此同构（我们额外比对了 `sourceVideoUrl`，用来识别
「源节点没删但内容换了」，他们用 `sourceVersion` 达到同一目的）。

提示词分两层：给模型的是 `对 {{Video 1}}进行续写：` + 用户输入；给用户看的是
`对 {sourceLabel} 的 {mm:ss}-{mm:ss} 片段进行续写：`。区间时间在可见层按 `floor(start)` /
`ceil(end)` 取整——给人看的不需要小数。

两条我们之前不知道的实现细节：

1. **续写会真的把选中片段裁出来**，不是只传时间区间。他们的错误文案里有
   「视频片段准备失败」「裁剪视频合规认证失败」「裁剪视频未通过合规认证，请重新选择片段」，
   说明链路是：裁片 → 合规审核 → 作为参考视频提交。
2. **模型门控**：只有 `properties.supportVideoContinuation === true` 且支持 `mixed2video`
   模式的模型才出现续写入口，默认优先选 Seedance 2.5；不满足时提示
   「当前模型或模式不支持智能续写」。

## 六、我们的落地方案

### 六点零、远端分支审计：复用契约，不合并状态机

对照 `origin/feat/canvas-video-reshoot-breakdown` 的三段提交：`985cb759`（重拍）、
`11f094c5`（续写）、`be19c5d3`（CI / 下拉 / Seedance 修复）。结论如下：

| 维度 | 远端实现 | 本线实现 / 取舍 | 处理 |
|---|---|---|---|
| 重拍承载 | 源节点内的 `VideoReshootTimeline` | 新建下游派生视频节点 | 保留本线；源片与结果可并排比较 |
| 区间意图 | `SegmentRange` 内联 mention | 每段独立 `intent` | 保留本线；避免引入第二套编辑器状态机 |
| 结构化参数 | 提示词 + `editSegments` | 只发提示词，结构体预留 | 保留本线；目录 schema 未声明时不能越权发送 |
| 续写前置片 | `videoExtendClip` / 面板内裁片 | 先生成画布可见的裁片节点，再连续写节点 | 保留本线；裁错时可检查、可复用 |
| 工具条入口 | 最终收进重拍 / 续写合并下拉 | 重拍平铺，续写暂平铺 | 保留实测产品结论；不要机械套用远端最终 UI |
| 模型门控 | 独立 continuation 能力 + mixed2video | 复用已可验证的 `video_edit` | 保留本线；不造目录里无法验证的能力位 |
| 可复用测试思想 | 区间全有或全无、派生节点连线、绑定失效、时长边界、计费可见 | 本线纯逻辑 36 项及集成快照 | 迁移行为断言，不复制组件实现 |

因此远端分支不是可 cherry-pick 的实现来源，只是契约和回归案例来源。任何后续同步都必须按
上表逐条映射；禁止用 `VideoReshootTimeline` / `VideoExtendPanel` 整文件覆盖本线组件。

底座已经就位，不需要动后端：`official_media_models.json` 里多个模型声明了 `video_edit`
模式，`media_model_request_schema.py` 有模式校验，`freezone.py:510` 处理了 video_edit 的
时长口径（输出时长跟随主输入视频），`VideoNode.tsx` 已有 `videoEdit` 生成模式且上游接入
视频会自动切换。缺的全部在前端交互层。

### 第一步：片段重拍

1. `videoRangePrompt.ts` 补齐三件事：厘秒整数运算（消除浮点比较）、
   `insertRange` / `resizeRange` 两个交互函数（边界规则照第四节）、
   失败语义改成「任一段不合法则整体不可提交 + 返回 failedRangeIds」。
   现有的 `validateRemakeRanges` / `buildRemakePrompt` / `buildEditSegments` 保留。
2. 意图输入沿用我们已有的**每段 intent 字段**，不跟进 `{{SegmentRange}}` 内联标记方案。
   理由：标记同步是一套额外状态机，收益只在「跨段连贯描述」这一种写法上，而我们的
   `TimeRange.intent` 结构更容易做区间与文案的一一校验。这是有意分叉，不是遗漏。
3. `VideoNodeData` 加 `remakeRanges?: TimeRange[]` 与 `remakeSourceDurationSec?: number`，
   随画布持久化；源视频换了就清空。
4. 播放条上的区间选择 overlay：参照 `isClipMode` 的浮层实现，复用同一套快捷键口径。
5. 提交走现有 videoEdit 路径，`prompt` 用 `buildRemakePrompt`，同时带 `editSegments`。
6. i18n 三份都要补，文案口径对齐他们（时长限制、空隙不足、留空即原样重跑）。

验收：源片 3.9 秒时入口禁用并给出原因；5 段之外无法再加；把某段拖到与相邻段只剩 4.0 秒
空隙时提交被拒且指出是哪一段；提交后请求体里的提示词与面板上的区间一致。

**已落地（2026-09-18）**，与上面计划有三处有意的分叉，记在这里免得下次又去翻代码：

1. **重拍不在源节点上就地改，而是在下游派生一个「片段重拍」节点**，源视频靠连线带过去
   （`isRemakeNode` / `remakeSourceUrl` / `remakeSourceDurationSec` / `remakeRanges`）。
   和「视频高清」同一个模式。理由：重拍产出的是一条新视频，覆盖掉用户手里那条没道理，
   派生出来还能两条并排比。生成本身仍走 videoEdit，没有新端点。
2. **`editSegments` 暂不发**。`model_params` 会按媒体目录里声明的参数做严格校验，
   目录里没声明的 key 直接被拒——所以结构化那份留在 `buildEditSegments` 里备着，
   等某个模型的目录条目声明了 `editSegments` 再接上去，那时候不用改逻辑层。
   当前真正生效的是提示词那份。
3. **指代源视频用「这段视频」，不用 `@视频1`**。我们后端按编号解析引用，而视频编辑
   模式下源视频是独立字段、根本不进编号引用列表，写个编号只会解析失败。
   LibTV 的 `{{Mixed 1}}` 是他们自己那套 mention 归一，抄不过来。

区间选择条 `VideoRemakePanel` 放在节点**上方**（下方已被生成面板占满），胶片条复用
`compose/filmstrip.ts` 的缓存抽帧。逻辑层 36 条单测全绿。

### 第二步：智能续写

1. 绑定对象持久化到目标节点，校验沿用 `isContinuationBindingValid`，并补上
   「源节点换内容」的判定。
2. 前置片段要真裁：走我们已有的 `run_freezone_extract_shot_assets` 剪切能力产出片段资产，
   再作为参考视频提交——不要只传时间区间，他们的实现已经证明这条路是必须的。
3. 模型门控：模型目录里加一个 `supportVideoContinuation` 等价标志，不支持时入口置灰并
   说明原因，不要提交后才报错。

验收：选区短于 4 秒或长于 30 秒时确认按钮禁用；源节点删掉后续写节点提示重选而不是提交失败；
生成的节点名带续写标记，能反查源节点与区间。

**已落地（2026-09-18）**，两处决定记下来：

1. **裁出来的前置片段落成画布上可见的节点**，而不是藏进续写节点的字段里。续写效果不对
   时第一件要查的就是「前提这段裁对了没有」，藏起来就查不了；而且它本身也是一段可复用
   的素材。链路是：源视频节点选区 → 复用剪辑（`freezone_video_compose`）真裁一段 →
   落成「续写前置片段」节点 → 再连出一个续写节点，绑定认的是这条边。
2. **模型门控沿用 `video_edit` 能力**，不新造一个 `supportVideoContinuation` 位。目录里
   声明了 video_edit 的模型（当前五个）就开放入口。造一个我们无法验证真假的能力位，只会
   让入口全都灰着，或者灰错。

绑定（`continuationBinding`）存 sourceNodeId / sourceEdgeId / range / sourceVideoUrl，
提交前用 `isContinuationBindingValid` 核一遍：边断了、片段被换成别的视频，都会拦下并要求
重选，而不是拿着一个不存在的前提去生成。

### 第三步：导入器补齐节点类型

`liblibNodeKind()` 至少要认 20 / 21（脚本）、35（智能剪辑）、40（参考）、45（拉片）、
50（剧本），把它们映射到我们已有的节点或至少保留 `liblibAction` 与原始 payload，
让「导入一张完整画布」不再丢语义。这一步独立于前两步，可以并行。

**已落地（2026-09-18）**，做法比按类型号逐个映射更稳：**认不出来的类型改看它带的素材**。
35 / 40 / 45 这些类型我们没有对应节点，但它们身上大多挂着素材（智能剪辑挂剪好的视频、
参考节点挂被参考的图、拉片节点挂产物），于是先读 `_resourceMeta.items[].kind`，读不到再
看地址后缀，有图当图、有视频当视频，实在什么都没有才落 `liblibMediaNode` 素材卡。
另外 10（COMMENT）直接落成文本节点——批注的内容本来就是一段文字。

按类型号硬映射的那条路没走：脚本(20/21)和剧本(50)的 payload 结构我们没有对照过，
映射成 `scriptNode` 只会得到一个空表格，比一张带标题的素材卡更糟。等真正需要时再对结构。

## 六点五、实机联调发现的问题（2026-09-18）

功能写完不等于能用。在本地 dev server 上把画布真点了一遍，逮到四个问题，都已修：

**1. LibTV 导入但没本地化的素材，所有服务端视频操作都会失败。** 控制台里是
`400 url must be a same-origin path: 'https://libtv-res...'`——后端只收同源静态路径，而
「网络素材」节点的 videoUrl 还是 LibTV 的绝对地址。界面上的表现就是「点了逐帧拉片没反应」。
现在这些按钮在这种节点上直接置灰，提示先「一键本地化」，而不是等请求 400 回来。

**2. 节点工具条被挤出视口，按钮点不到。** 实测：工具条宽 746px，可视宽 444px，左右各有
约 150px 在视口外。加到第十个按钮时必然发生。改了两处：片段重拍和智能续写收进一个
「再创作」下拉；工具条本身加 `max-w` + 横向滚动 + 文案不换行，从此不可能有按钮跑到视口外。

**3. 重拍节点的模式会被顶走，圈好的区间被静默忽略。** 保存下来的节点数据里抓到
`genMode: "allReference"`——「上游有视频且模型不支持 video_edit 就切全能参考」那条兜底
把重拍节点也一起切了。于是提交走普通生成分支，用户圈的区间**一个都没进提示词**，还照付
一次钱。现在重拍/续写节点会把模型换成支持视频编辑的那个并钉死模式，一个都换不到时提交
被拦下并说明原因。

**4. 新建的节点落在视口外，看着像「点了没反应」。** 落位是找空地，实测新节点落到源节点
左边 658px，屏幕上什么都没发生。现在创建后把镜头带过去（`requestFocusNode`）。

另外两处顺手改掉的设计问题：重拍选区条原本放在节点上方，那条带是 React Flow 的节点工具条
的地盘——工具条是独立浮层，永远压在上面，选区条会被整条盖住点不到，现在排到生成面板下方；
选区条上的 ✕ 原本会把节点踢出重拍模式且回不去，现在只清空所选片段。

## 六点六、节点工具条：按 LibTV 实测规格对齐（2026-09-18）

在他们画布上选中视频节点，直接量了工具条的计算样式，不是照着截图描：

| | LibTV | 我们（已对齐） |
|---|---|---|
| 动作顺序 | 高清 / 片段重拍 / 逐帧拉片 / 智能去字幕 / 音视频分离 / 主体消除 / 创意片头 | 高清 / 片段重拍 / 智能续写 / 逐帧拉片 / 智能去字幕 / 分离音视频 / 剪辑 / 解析 |
| 条背景 | `rgb(38,38,38)` | 同 |
| 条描边 | `0.5px solid rgb(54,54,54)` | 同 |
| 条圆角 / 内距 / 间距 | 12px / 4px / 4px | 同 |
| 条高 | 41px | 41px |
| 相对节点 | 居中，上方 32px | 居中，上方 32px |
| 按钮高 / 圆角 / 字号 | 32px / 8px / 13px | 同 |

两点判断记下来：**片段重拍在他们那儿是平铺的第二个按钮**，不是藏在下拉里，所以我们也
平铺（此前一度收进「再创作」下拉，已改回）；**智能续写他们不在工具条上**，是在生成
流程里触发的，我们暂时挨着重拍平铺，免得再多一层菜单。他们的工具条同样会超出窄视口
（实测 908px），我们额外加了最大宽度 + 横向滚动，这是有意比他们多做的一步。

## 六点七、端到端实跑（2026-09-18）

在本地 dev server 上把片段重拍从头点到尾，又逮到一个只有真跑才会出现的问题：

**模型的参考视频时长上限会把重拍直接顶掉。** 自动换上的 Wan 3.0 声明
`referenceVideoMaxSeconds: 15`，而源片 15.093 秒，后端回 `400 video reference duration
must be <= 15s`。改了两处：挑模型时把「这条源片放不放得下」一起算进去，并优先选**明确
声明了上限且装得下**的模型；提交前对源视频也跑一遍时长校验（此前只校验音频），
让用户看到的是可读的中文提示而不是后端的英文 400。

还剩一个**不是代码问题**的拦路石：这台机器没配 `OSS_RELAY_AK` / `OSS_RELAY_SK`，
任务能建、能派发，到调用视频生成器那一步报 `OSS media relay config missing`。
配上这两个密钥才能真正出片。

已跑通的部分：工具条 → 片段重拍 → 镜头自动跟到新节点 → 节点本体上出现源片胶片条 →
点一下截出 5.0s 区间并显示时长角标 → 写意图 → 区间与意图随画布保存、刷新后还在 →
模式锁在「视频编辑」、参考列表里挂着源视频 → 提交建出任务。

## 七、暂不跟进及理由

图层分离、脚本 V2 的三视图与筛选、Agent 智能剪辑、实体库与音色资产、工作流与回收站
——这些不是「视频节点上少一个按钮」，而是各自一条独立产品线。本文只把它们记录在案，
优先级由产品定，不进本轮开发。

## 八、取证索引

LibTV 侧：`NodeType` 枚举与实体分类见 chunk `2i05dnnse6h02.js`；片段重拍模块见
`2l6x857x-mm1x.js`；续写模块见 `14-zdlybef4mc.js`；模型门控见 `0h41i0do2_0v5.js`；
提交组包（`editSegments` 与 `{{Mixed N}}` 归一）见 `0h41i0do2_0v5.js` / `3cnhit8yuft0c.js`；
i18n 词条见 `3mw5y_7z6iun6.js`；接口路径表见 `334nbskkxiqck.js`。

我方：`frontend/src/features/canvas/application/videoRangePrompt.ts`（重拍/续写逻辑层，
尚无引用方）、`frontend/src/features/canvas/application/videoFrameCapture.ts` 与
`nodes/VideoNode.tsx`（画面截取）、`frontend/src/features/canvas/ui/NodeActionToolbar.tsx`
（视频工具条现有八项）、`frontend/src/features/freezone/liblibCanvasImport.ts`（导入器
`liblibNodeKind` 只认 1–5）、`src/novelvideo/official_media_models.json` 与
`src/novelvideo/api/routes/freezone.py:510`（video_edit 底座）。

拉片那条线的实测拆解另见 `output/local/liblib_canvas_import_review/liblib-shot-breakdown-teardown.md`，
深度动作参考见 `docs/guides/depth-motion-da3.md`。

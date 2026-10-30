# #891 需求二：按描述生成声线方案

状态：供前后端并行开发的方案，未实施。用户已确认采用百炼已接入链路，虾画本期接入；剩余产品待决项见第 8 节。

分析日期：2026-10-29。DramaClaw 基于当前 HEAD `4c48e0787a4dd1aa9cd0efda94f82fefaccacb3c`。
本轮补充调查基于文档提交后的 HEAD `2caa593f225dc858f98d7527ca02801039193755`，应用代码未变。EE 使用远端 main `02f37495b7cacaf16ef111cd4a2ddba75eebe6c7`，管理后台使用远端 main `184795867de5fd42dbe156479f9ef0b5ef468176`，均下载对应 SHA 的源码快照核对，未修改这两个仓库。
网关基于远端 `main` `40d696d7f60153c4556d82a7cb09c8e4923231f1`，通过 `git ls-remote origin refs/heads/main` 核对，并下载该 SHA 的源码快照阅读。本机网关 checkout 的 `45f96b84…` 不是本次结论的依据。

需求来源：[dramaclaw #891](https://github.com/dramaclaw/dramaclaw/issues/891)，查阅时无评论。本文只处理需求二；需求三中上传能力和历史绑定的条目作为兼容性约束。

## 1. 范围与非目标

在现有角色声线管理组件 [character-voice-panel.tsx](../frontend/src/components/assets/character-voice-panel.tsx) 增加入口。用户填写描述和试听文本，生成独立候选，播放候选，可重新生成，最后显式保存到所选角色声线插槽。

“候选”是尚未保存的生成试听音频。它暂时存放，可试听或重新生成，不会改变现有声线。界面可以显示“生成结果”或“试听声线”，不要求用户理解内部术语。

虾画本期也必须接入。在现有 `VoiceSelectionModal` 的“我的音色”增加“按描述生成”，复用同一生成与试听界面，保存后进入既有音色列表供语音选择。当前按“增加一种可选音色来源”设计，保持一次语音生成选择一个声线；如果“多选”指一次勾选多个音色用于多角色对白，需要另行确认新的语音合成契约。

本期方案不修改需求一的音频开关、缺失声线提示和视频提交逻辑；不实施需求四的身份造型入口整合、身份独立绑定或数据迁移；不移除或重做上传、录音和裁剪。旁白管理不新增入口。EE 的模型目录、管理后台、功能价格和组织凭据链路属于本期必要接入范围，见第 2.7 节。

技术选择：通过 claymore-llm-gateway 的百炼 `voice-enrollment`，指定 `target_model=cosyvoice-v3.5-flash`，取得预览音频并保存为文件。后续配音继续使用现有 IndexTTS2 参考音频流程。这里设计的是“可保存的参考音频”，不是把供应商音色 ID 加进角色绑定系统。

### 1.1 用户界面改动

以下为本期交互方案。角色管理和虾画共用一个生成弹窗，只按入口切换保存目标；生成服务、错误处理和试听行为不分别实现。

| 界面 | 具体改动 | 用户操作后的可见结果 |
| --- | --- | --- |
| 角色管理的现有声线面板 | 在默认及年龄段插槽操作区增加“按描述生成”。保留上传、录音、试听、裁剪、清除。弹窗顶部显示角色名和实际保存插槽的标签。 | 从哪个插槽打开，就将生成结果保存到哪个插槽；年龄显示槽映射到 default 时显示实际目标，不能按年龄标签误存。 |
| 虾画“音色库 / 我的音色”选择器 | 在“我的音色”工具条增加“按描述生成”，与现有上传入口并列；空列表时也显示入口。 | 生成并保存后刷新当前列表，显示刚保存的音色名称。保存不会自动更换当前节点声线；用户点击该行“选择”后才更新节点。 |
| 虾画音频节点、操作面板、资产板音频表单 | 继续打开同一个 VoiceSelectionModal，在各入口均能进入上述流程。 | 选中新音色后，原音色标签变为新名称；点击生成语音时使用这个声线引用。 |
| 共享“按描述生成声线”弹窗 | 显示音色描述、试听文本、字符计数、生成操作、播放控件、重新生成、保存目标和错误区域。虾画保存时还需音色名称字段。 | 生成前保存按钮禁用；生成成功出现播放器及实际时长，超过 5 秒时提示视频参考建议 3～5 秒；满意后显式保存。目标插槽已有声线时，保存前先弹替换确认。模型名称、Key 和供应商句柄不作为终端用户输入项。 |
| EE 后台“媒体模型” | 类型筛选及新建表单增加“音频”；音频操作区分“声音设计”和“语音合成”，设计表单可选择目标 TTS 模型。表格展示用途和目标模型。 | 保存后重新打开表单仍显示同一操作、目标及启用状态；不可用目标给出字段错误。图片、视频表单不显示音频专属字段。 |
| EE 后台“功能价格”与组织覆盖价 | All 功能页显示“按描述生成声线”的音频模型价格，计量单位显示“次”；组织页可筛选 audio 并编辑覆盖价。 | 保存后回读同一模型及价格；设置影响新任务的报价。UI 不把它显示成每字符的配音价格。 |

角色面板的目标使用 `actionSlot.slot`，不能直接拿 `displaySlot`。现有代码会将角色本年龄段显示项映射为 default，这个映射必须在打开弹窗和保存时保持一致。

### 1.2 共享生成弹窗草图

这是内容与操作位置草图，不是另做一套视觉风格。应用实现遵循 [DESIGN.md](../DESIGN.md) 与现有 Dialog、表单和按钮组件。

```text
按描述生成声线                                      关闭
保存位置：角色「张伯」· 默认声线 / 我的音色

音色描述                                         0/500
[ 六十岁左右的男人，嗓子有点沙，说话慢               ]

试听文本                                         0/60
[ 今天的天气很好，我们沿着河边慢慢走回家。           ]
提示：试听文本需要 15～60 个字符（约 15 秒）

生成结果
[ 播放 / 暂停 ] [ 播放进度 ] [ 实际时长 ]
提示：用于视频参考建议 3～5 秒，保存后可用裁剪缩短   ← 实际时长超过 5 秒时
未保存；有效期截止时间由服务端返回
音色名称 [ 沙哑的老年男声 ]        ← 保存到我的音色时

错误原因及对应的重试操作显示在这里
[ 按配置返回的本次价格或不可用原因 ]

[ 关闭 ]                 [ 生成试听 / 重新生成 ] [ 保存 ]
```

无结果时不显示播放器；“生成试听”是主操作。已有可保存结果时，“保存”是主操作，“重新生成”使用次级按钮，弹窗同时最多一个实心主按钮。虾画保存按钮文案为“保存到我的音色”，角色入口为“保存到〈实际插槽标签〉”。音色名称在生成前可以填写，生成或播放失败不能清空。

描述和试听文本必填，使用第 3.2 节的长度约束。语言选项只有部署配置开放相应语言时才展示；字符计数和错误文案须与服务端按 Unicode 字符计算一致。价格区域使用服务端当前有效报价；缺配置或无权限时说明原因并禁用生成，不能显示虚构价格或让按钮只在点击后才报同一个已知错误。

### 1.3 界面状态与恢复

| 状态 | 界面和按钮 | 保留或更新的内容 |
| --- | --- | --- |
| 尚未生成 | 显示表单；无音频；保存禁用。输入不合法时生成禁用并显示字段原因。 | 原正式声线、节点选择均不变。 |
| 生成中 | 显示“正在生成”，禁用重复生成及保存；不显示虚构百分比。关闭弹窗不等于取消服务端任务。 | 表单及上一条成功试听保留，任务 ID 留在当前页面的控制器状态。 |
| 生成成功 | 显示对应 request_id 的音频、实际时长和有效期；允许试听、重新生成及保存。 | 刷新的是弹窗结果，正式声线和当前节点选择仍不变。 |
| 生成失败或结果未知 | 在表单内显示具体原因。failed 按原因提供修改或重试；unknown 先查询原任务，再由用户显式重新生成。 | 描述、试听文本、音色名称及上一条成功试听保留。 |
| 试听失败 | 播放器旁显示原因与“重试试听”；能用现有音频再次播放时不重新生成。 | 所有输入和已生成结果保留，不重复扣模型费。 |
| 保存中或失败 | 保存中禁用重复保存；失败时显示原因，冲突时要求刷新目标，不显示成功状态。 | 保留生成结果和输入；重试使用同 save_request_id。 |
| 替换确认 | 目标插槽已有声线时，点击保存先弹确认框：“该插槽已有声线，替换后旧声线会归档”，按钮为“替换”和“取消”。取消不发保存请求；确认后以 `replace_existing=true` 保存。 | 取消后生成结果和输入保留；确认替换后旧文件按上传流程归档，不删除。 |
| 保存成功 | 角色入口刷新目标插槽；虾画入口返回“我的音色”列表并显示新记录。 | 角色只更新目标字段；虾画仍保留原选择，直到用户显式选择新记录。 |
| 已过期、权限不足或服务不可用 | 过期结果不可保存；显示过期及重新生成入口。权限或配置不可用时显示相应原因并禁用新增生成、保存操作。 | 描述和试听文本保留，现有可用声线仍可读取和使用。 |

同一页面内关闭后重新打开弹窗，不清空已填写内容或丢弃未结束的任务引用；这不是跨刷新或重新登录的保留承诺；按 P1，候选在生成后 1 小时过期，不提供跨刷新找回。切换角色或项目时按目标隔离表单，迟到响应不能写到新的角色、插槽或节点。

### 1.4 UI 交付物

S4、S6、S8 除代码外必须提供可运行页面及浏览器验收记录。角色插槽、虾画普通音频节点、资产板、EE 模型配置、功能价格与组织覆盖页分别记录入口位置及实际测试结果。对生成前、生成中、成功可播放、失败保留输入、保存后列表五种用户状态提供截图。截图用于评审位置与布局，行为判定使用第 4.1 节的测试或命令，不用截图替代绑定与计费断言。

不更改 DESIGN.md 的 token。实现如确有 token 改动，必须同步更新规范并执行设计 lint。键盘能到达字段、播放和保存按钮；弹窗关闭后焦点回到触发按钮。长描述和错误信息不得遮住主操作。

## 2. 模型功能、网关支持与接入分工

### 2.1 三个名称分别做什么

| 名称 | 功能与使用方法 | 对本需求的用途 |
| --- | --- | --- |
| 百炼 `voice-enrollment` | 音色创建和管理服务。`create_voice` 携带 `voice_prompt`、`preview_text`、`target_model` 时按描述设计；基于录音的复刻是另一种请求。设计返回 `voice_id` 和 Base64 预览音频。 | 用户已确认用于本次候选生成。不要因为名称中有 enrollment 就当成只支持上传复刻。 |
| 百炼 `cosyvoice-v3.5-flash` | TTS 合成模型，使用匹配该模型的自定义音色和待朗读文本合成音频。 | 本次作为设计目标模型；创建接口已有预览时，不再调用一次 TTS。 |
| 绘梦 `seed-audio-1.0` | 根据包含音色、语气及台词的 Prompt 生成音频，可带预设 speaker 或参考音频。绘梦将其包装成提交、查询、下载的任务接口。 | 可以生成参考音频，但不是返回永久音色 ID 的音色管理 API。当前网关缺适配，不能作为已接通的替代路径。 |

百炼能力依据：[声音设计指南](https://help.aliyun.com/zh/model-studio/voice-design-user-guide)、[声音设计 API](https://help.aliyun.com/zh/model-studio/voice-design-api-references)、[CosyVoice 模型卡](https://docs.bailian.console.aliyun.com/zh/model-studio/cosyvoice-v3-5-flash)。CosyVoice 设计支持北京地域，设计音色与目标模型绑定。描述限中文或英文、最长 500 字符，试听文本为 15～200 字符；前缀只允许字母数字，最长 10 字符。

Seed Audio 的音频创作定位见[字节跳动模型介绍](https://seed.bytedance.com/zh/blog/from-speech-to-audio-creation-introducing-the-seed-audio-1-0-audio-creation-model?view_from=homepage_tab)。实际接入必须遵循[绘梦模型页](https://api.huimengi.com/models/seed-audio-1.0)，不能拿其他代理商同名模型的端点代替。

### 2.2 最新 main 的代码支持结论

以下链接固定到本次实际读取的网关 SHA。它们证明代码支持，不证明线上部署、渠道授权、价格表达式或余额已经配置。

| 检查项 | 结论 | 源码证据 |
| --- | --- | --- |
| 设计入口 | 已有 `POST /v1/audio/voice-designs`。 | [router/relay-router.go](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/router/relay-router.go) |
| `voice-enrollment` 设计 | 已转换为百炼 `create_voice`；校验描述、试听文本、目标模型、语言及格式；将 `output.voice_id` 转成网关签名句柄。要求单 Key 渠道。 | [ali/voice_design.go](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/relay/channel/ali/voice_design.go) |
| `cosyvoice-v3.5-flash` | 已列入阿里模型清单，`/v1/audio/speech` 使用 `SpeechSynthesizer` 上游端点。 | [ali/constants.go](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/relay/channel/ali/constants.go)、[ali/adaptor_test.go](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/relay/channel/ali/adaptor_test.go) |
| 预览与句柄响应 | `VoiceDesignResponse` 返回 `preview_audio`，字段为 `data` 或 `url`、`format`、`sample_rate`。`voice` 和 `id` 是句柄，不是原始 `voice_id`。 | [relaykit/dto/audio.go](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/relaykit/dto/audio.go) |
| 生命周期与隔离 | 新音色保留 1 小时，首次合成成功后删除；创建不自动重试。最新代码还校验可信 subject。 | [生命周期文档](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/docs/voice-design-lifecycle.md)、[relay/audio_handler.go](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/relay/audio_handler.go) |
| 绘梦 Seed Audio | 未接入。绘梦模型清单没有该名称；`ConvertAudioRequest` 明确返回 `not implemented`，也没有该渠道的声音设计适配。只加模型别名不能接通。 | [huimeng/constants.go](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/relay/channel/huimeng/constants.go)、[huimeng/adaptor.go](https://github.com/claymorelab/claymore-llm-gateway/blob/40d696d7f60153c4556d82a7cb09c8e4923231f1/relay/channel/huimeng/adaptor.go) |

网关已有可复核测试：`TestConvertVoiceEnrollmentRequest`、`TestConvertVoiceEnrollmentRequestRejectsSpecificConstraints`、`TestHandleAliVoiceEnrollmentResponseUsesVoiceID`、`TestAliCosyVoiceUsesSpeechSynthesizerEndpoint`。本次只读源码，未把这些测试报告为已运行，也未发送付费生成请求。

### 2.3 百炼经网关的请求与响应

DramaClaw 通过 `enqueue_project_task` 投递新增 `voice_design` 任务，由 runner 中验证过的 envelope 提供网关凭据解析、可信请求身份和用量记录。路由不能把浏览器输入拼成 `TrustedEgressContext`，也不能为规避入队而直接调用需要可信上下文的音频函数。浏览器不能传供应商 Key、网关地址、subject 或原始音色 ID。组织请求继续受现有组织出网策略约束，禁止缺配置时回退到平台 Key 直连百炼。

网关请求为扁平结构，不是百炼原生的 `input` 嵌套结构：

```http
POST {gateway_base}/v1/audio/voice-designs
Authorization: Bearer <服务端解析的网关凭据>
Content-Type: application/json
```

```json
{
	"model": "voice-enrollment",
	"target_model": "cosyvoice-v3.5-flash",
	"preferred_name": "dc891",
	"voice_prompt": "六十岁左右的男人，嗓子有点沙，说话慢",
	"preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
	"language": "zh",
	"sample_rate": 16000,
	"response_format": "mp3"
}
```

成功响应结构：

```json
{
	"object": "audio.voice",
	"id": "<签名句柄>",
	"model": "voice-enrollment",
	"target_model": "cosyvoice-v3.5-flash",
	"voice": "<同一签名句柄>",
	"preview_audio": {
		"data": "<Base64音频>",
		"format": "mp3",
		"sample_rate": 16000
	},
	"request_id": "<供应商请求ID>"
}
```

网关负责映射成百炼 `model=voice-enrollment`、`input.action=create_voice`、`input.prefix=preferred_name`、`input.language_hints=[language]`，其余输入和音频参数进入对应的 `input`、`parameters`。

服务端先严格解码预览、探测音频，再发布候选。若仅返回 URL，通过现有受控媒体下载机制归档；限制 HTTPS、重定向目的地、大小和超时，不能允许模型结果引导服务端读取内网。若没有可读预览则返回 `provider_bad_audio`，不隐式触发第二次 TTS。候选保存同一份试听音频，不能保存时再采样一个不同声音。

若以后需要用句柄合成其他文本，网关用法是 `POST /v1/audio/speech`，请求 `{"model":"cosyvoice-v3.5-flash","input":"待朗读文本","voice":"<返回的签名句柄>","response_format":"mp3"}`，响应为音频。该操作受 1 小时及一次成功消费约束，本方案不让浏览器依赖它反复试听。原始百炼 `voice_id` 不能替代签名句柄。

### 2.4 绘梦 Seed Audio 的实际用法与缺口

已读取绘梦模型页公开详情脚本及[公开模型目录](https://api.huimengi.com/api/v1/models)，不是仅根据搜索摘要推断。模型目录给出扁平 Playground 参数，详情页的 API 示例使用以下嵌套结构；若实施该路径，应以服务端契约实测确认两者映射。

```http
POST https://api.huimengi.com/api/v1/voice
Authorization: Bearer <服务端绘梦凭据>
Content-Type: application/json
```

```json
{
	"model": "seed-audio-1.0",
	"params": {
		"text_prompt": "一位六十岁左右、嗓音微沙的男人，缓慢朗读：今天的天气很好，我们沿着河边慢慢走回家。仅生成干净的单人说话声。",
		"audio_config": {"format": "mp3", "sample_rate": 16000}
	}
}
```

提交返回 `task_id`，用 `GET /api/v1/voice/{task_id}` 查询。完成结果包含 `status=completed`、`result.audio_url` 或 `result.url`、`duration`、`original_duration`，以及顶层 `cost`、`error_message`。本路径交付的是音频 URL，不是 Base64 或新音色 ID。`text_prompt` 最长 3000 字符，输出最长 120 秒；参考素材最多 3 条，单条参考音频最长 30 秒且不超过 10 MB，通过 `@音频N` 引用。新音色候选生成不提供参考素材。

用户已确定首期使用百炼，本期不实施绘梦路径。若以后引入，先在网关另立任务实现音频提交、查询、归档、计费和错误转换。模型可能生成环境声或多角色表演，提示词不能机械保证“干净单人声”，不能将它写成已满足的 PASS。

### 2.5 成本、限流和失败分类

百炼创建 CosyVoice 设计音色免费，`cosyvoice-v3.5-flash` 合成标价为 0.8 元/万字符，来源为[设计指南](https://help.aliyun.com/zh/model-studio/voice-design-user-guide)和[模型卡](https://docs.bailian.console.aliyun.com/zh/model-studio/cosyvoice-v3-5-flash)。这不等于 DramaClaw 对用户免费，也不推断内置预览的账单处理。网关设计请求使用 `voices=1` 的计费量，应核对实际渠道价格表达式和预览账单后制定 P4。浏览器重复播放本地候选不再产生模型调用。

百炼[限流表](https://help.aliyun.cn/zh/model-studio/rate-limit)给出 `voice-enrollment` 10 RPS，CosyVoice 3 RPS；模型卡以 180 RPM 表示合成限制。部署按实际账号配额与网关限额中更严格者执行。设计与复刻共享音色服务限流。上游自定义音色数量有上限，网关的 1 小时回收只减少占用，不提供用户配额保护。

绘梦公开目录查阅时标价为 0.017 元/秒，按 `original_duration` 计费。详情页说明提交校验钱包余额，完成后扣实际费用，失败不收费。其页面没有给出可据此承诺的固定 RPS；429 表示请求频率或模型并发超限。该价格与限制只适用于绘梦，不能套到百炼或网关账单。

候选服务的技术限制建议：每个可信请求者同时 1 次生成；共享凭据还需按渠道设置总限流，跨进程用现有 admission 或持久租约，不能仅靠 Python 进程内 semaphore。数值预算和每日额度按 P4：测试值每用户每日 20 次，上线值由产品确认。runner 中的上游调用总超时建议 90 秒；浏览器提交仅等待入队，返回 202 后查询候选，不让现有 `api` 默认 30 秒超时决定模型创建是否重试。候选媒体限制 10 MiB，归一化后须为可解码 MP3、单声道 16 kHz、时长大于 0 且不超过 15 秒。超长返回错误并保留输入，提示缩短试听文本；不截断，也不增加候选裁剪交互（P3 已定）。

| 失败类别 | 服务端处理 | 用户重试语义 |
| --- | --- | --- |
| 输入不合法 | 出网前拒绝，返回具体字段和 `invalid_input`。 | 修改字段，保留其余输入。 |
| 缺模型、渠道、凭据或组织策略拒绝 | 返回 `voice_design_unavailable` 或 `voice_design_forbidden`；不切换供应商。 | 配置修复后再提交。 |
| 余额、预算或配额不足 | 区分 `insufficient_credits`、`voice_design_quota_exceeded`。 | 补足额度或等待额度恢复。 |
| 本地或上游限流 | `rate_limited`，有依据时返回 `Retry-After`。 | 延时后由用户再次提交。 |
| 内容拒绝 | `content_rejected`，不暴露 Key 和完整上游响应。 | 修改描述或文本。 |
| 网络、超时、上游 5xx | 记录调用 ID，标为结果未知，不自动重发创建。 | 先按 request_id 查询本地结果；显式再次生成使用新 request_id。 |
| 无预览、坏 Base64、格式不符或超长 | `provider_bad_audio` 或 `candidate_duration_exceeded`，不发布 ready 候选。 | 保留输入，按提示修改文本或重新生成。 |
| 写盘或绑定失败 | 不返回保存成功；回滚文件发布，维持原字段。 | 重试同一保存请求，不调用模型。 |

### 2.6 与现有模块怎么分工

| 模块 | 职责与变更边界 |
| --- | --- |
| 新增 `audio/voice_design_service.py` | 网关调用、用量与可信身份衔接、响应验证。只生成候选，不触碰角色或身份字段。复用 `tts_generator.py` 的凭据和操作记账函数，禁止复制一套。 |
| 新增 `audio/voice_design_storage.py` | 候选元数据、幂等状态、独立媒体文件、过期清理和保存回执。根据解析后的 `state_dir`、`runtime_dir` 定位，支持项目 home node 路由。 |
| 新增 `api/routes/voice_design.py` | 生成、状态、受鉴权试听端点；角色保存端点留在 `characters.py`，复用其 scope 与声线更新流程。 |
| `task_backend/runners/audio.py` 与任务注册机制 | 新增 `voice_design` runner，复用 admission、可信 envelope 和任务出网记账，按 candidate_id 关联状态。候选写入项目私有 state 与 runtime，因此 runner 要求 home node。 |
| [character_voice_storage.py](../src/novelvideo/seedance2_i2v/character_voice_storage.py) | 正式声线的格式处理、插槽路径、文件持久化及资源锁。上传与候选保存共用这些函数；不承担模型调用。 |
| [characters.py](../src/novelvideo/api/routes/characters.py) | 保存复用 `_voice_slot_update_fields`、`_apply_character_voice_update`、`_voice_slot_payload` 与 `run_voice_media_operation`。补齐保存失败的文件恢复与持久化回执；上传协议保持原样。 |
| [voice_clone.py](../src/novelvideo/seedance2_i2v/voice_clone.py) | 继续按身份覆盖、年龄段、角色默认的顺序解析参考文件，交给 IndexTTS2。无需知道音频来自生成还是上传；不引入 CosyVoice 后续合成分支。 |
| [characters.ts](../frontend/src/lib/queries/characters.ts) | 生成和试听不写正式声线缓存；保存响应复用 `handleCharacterVoiceMutationSuccess`，更新角色、插槽和绑定相关查询。 |
| 虾画 `VoiceSelectionModal.tsx`、`freezone/audio_node.py`、`api/routes/freezone.py` | 本期新增生成入口及“保存到我的音色”，复用 `user_custom` 音色记录和原有语音选择链路。不新增 generated scope 或第三种 speechMode。 |

当前 `media_model_request_schema.py` 的通用端点白名单没有 `audio/voice-designs`，目录配置校验也只接受 image、video。要让 CE 与 EE 的模型配置控制运行时，必须扩展共享 schema 和目录读写，专用调用适配器仍需消费有效配置，不能通过硬编码绕过管理后台。

### 2.7 EE、管理后台与模型配置调查

EE 的权威本地源由仓库注册表指向 `SuperTale2`，远端仓库为 `claymorelab/SuperTale`。本次对照的是文首远端 main 快照。EE Docker 构建会用 CE checkout 覆盖其 `src/novelvideo`，因此共享功能改在 dramaclaw，不能只改 EE 仓库内的旧副本。

| 层次 | 当前代码事实 | 本期必须补齐 |
| --- | --- | --- |
| CE 共享 schema | `media_model_request_schema.py:336` 不接受设计端点，`:421` 不接受 audio 目录类型。 | 接受 `audio` 与 `audio/voice-designs`；按媒体类型校验端点，禁止把非 image 一律当 video。 |
| EE 媒体目录 | `media_model_models.py:89,206` 的平台及组织输入限 image/video；`media_model_catalog.py:194` 对 audio 返回空列表。 | 平台目录、组织 visibility 与配置覆盖、有效目录读取均支持 audio，保留原平台下架和组织权限规则。 |
| EE 功能计费 | `feature_billing.py` 没有 voice_design；`task_backend.py:180-199` 会拒绝未登记计费功能的新任务。 | 登记 task `voice_design`、共享 feature `audio.voice_design`，模型价格 kind 为 audio，生成一次按 `item_count=1` 计量。 |
| EE 模型价格与配置传输 | admin routes 的模型价格、平台及组织导入导出 DTO、组织模型价格只接受 image/video。 | 扩展 audio CRUD、报价、预扣、结算、组织覆盖价、导入导出，不能只改创建接口。 |
| 数据库约束 | 三张表的 CHECK 分别限制媒体类型、平台模型价格 kind、组织模型价格 kind。 | 新增版本迁移扩大约束，保留旧行及价格类型一致性检查，禁止修改历史迁移或直接移除约束。 |
| 管理后台 | `MediaModel` 类型、筛选、默认端点和功能价格行只有图片、视频；组织定价分域缺 audio。 | 增加音频模型表单、设计目标模型选择、按模型价格行和组织 audio 覆盖价。All 功能页可以承载共享 feature，无需另做分域快捷页。 |

源码依据：[EE 模型 DTO](https://github.com/claymorelab/SuperTale/blob/02f37495b7cacaf16ef111cd4a2ddba75eebe6c7/src/novelvideo_ee/media_model_models.py)、[EE 功能登记](https://github.com/claymorelab/SuperTale/blob/02f37495b7cacaf16ef111cd4a2ddba75eebe6c7/src/novelvideo_ee/feature_billing.py)、[EE 模型价格路由](https://github.com/claymorelab/SuperTale/blob/02f37495b7cacaf16ef111cd4a2ddba75eebe6c7/src/supertale_admin/routes.py)、[后台模型管理](https://github.com/claymorelab/supertale-admin-fe/blob/184795867de5fd42dbe156479f9ef0b5ef468176/src/components/media-models/MediaModelManager.tsx)。这些是源码调查，不代表线上配置已创建。

模型配置采用以下结构，技术字段在服务端解析，用户界面只展示“按描述生成声线”：

| 条目 | 设计条目 | 目标 TTS 条目 |
| --- | --- | --- |
| `media_type` | `audio` | `audio` |
| `gateway_model` | `voice-enrollment`，或管理员映射的公开别名 | `cosyvoice-v3.5-flash`，或同一网关可用的公开别名 |
| `config.request.endpoint` | `audio/voice-designs` | `audio/speech` |
| `config.targetModel` | 引用目录中目标 TTS 条目的稳定 ID | 不设置 |

能力由 endpoint 派生为 voice_design 或 speech，不再增加一份重复的 audioCapabilities 标志。运行时解析 targetModel 引用后，用目标条目的 gateway_model 作为网关请求的 target_model。设计条目只允许引用可见、启用、支持音频合成的目标；当前首期限定目标为 CosyVoice 3.5 Flash 的有效映射。配置缺失、禁用或目标无效时拒绝出网，不回退硬编码默认模型。

两个条目是管理员配置的模型职责，不是两个用户音色选项。目标 TTS 条目供设计服务引用，不因列入音频目录就自动成为已实现的长文本配音模型选项。现有 `freezone_audio_speech` 仍使用原参考音频链路。

服务端使用请求者实际可用的目录一次解析设计模型、目标模型和价格，报价与投递采用同一份解析结果。配置版本及定价依据复用现有 reservation 与 ledger 固化机制；不向 CE `AdmissionContext` 添加 media_model_snapshot，不改其身份权限契约。网关 subject 来自可信模型 token，不接受浏览器声称的 subject。

`audio.voice_design` 在角色与虾画入口共用：一次候选生成只预扣并结算一次，试听和保存不再计设计费。不能套用 `freezone_audio_speech` 的 billable_chars 把描述长度当设计数量；单价按 P4 先用测试值每次 1 积分，上线值由产品确认；免费也必须是显式可追溯的配置。沿用 feature 内含模型调用的现有计费政策，不能再叠加扣一次模型费。共享 feature 可在现有 All 功能页配置，组织价格页补 audio 域。促销目前仅支持 mainline/freezone，本期不扩大促销规则；如需该新功能参加促销，列入 P4 决策并补完整政策、DTO 和数据库约束。

至少需要扩大这三个现有 CHECK，采用新增版本迁移：

- `media_model_catalog.media_type`，源定义在 `migrations/unified_billing_v1/media_model_catalog.py`。
- `feature_media_model_prices.pricing_kind`，源定义在 `migrations/unified_billing_v1/feature_media_prices.py`。
- `org_feature_media_model_prices.pricing_kind`，源定义在 `migrations/versions/0049_org_pricing.py`。

账号音色归属沿用现有行为：组织项目目录是 `OUTPUT_DIR/_orgs/<org>/<owner>/<project>`，但“我的音色”存于 `OUTPUT_DIR/<requester>/_account/freezone/audio/voices/`。候选按项目加请求者隔离；保存成“我的音色”仍归请求者，不自动变为 owner 或组织共享资产。项目 home node 能处理候选 state/runtime，并不证明其挂载了请求者账号音色目录。EE 联调必须实证该目录可读写；读取或挂载失败时明确失败，不能当空库写回。若部署缺挂载，需把请求者账号切片以最小范围接入正确存储节点，不能挂载其他用户目录作为修复。

实施后在 EE 仓库根运行 C8，在管理后台仓库根运行 C9；使用正常 CE 加 EE 测试环境，不用 EE 内旧 CE 副本代替本次共享代码：

```sh
# C8 EE：目录、计费登记、平台及组织价格、配置往返
uv run pytest tests/test_media_model_catalog.py tests/test_admin_feature_model_prices.py tests/test_feature_billing_registry.py tests/test_task_backend_client.py tests/test_billing_config_transfer.py -q
uv run pytest tests/b2b/test_scoped_media_model_catalog.py tests/b2b/test_org_media_model_api.py tests/b2b/test_org_pricing_service.py tests/b2b/test_org_pricing_routes.py tests/b2b/test_org_media_model_task_snapshot.py -q
# C9 管理后台：模型表单、音频价格行、组织覆盖及配置传输
pnpm test src/__tests__/organizations/media-model-manager-contract.test.ts src/__tests__/organizations/organization-media-models.test.tsx src/__tests__/feature-credits/feature-credits-domain.test.tsx src/__tests__/feature-credits/organization-pricing-model-rows.test.ts src/__tests__/feature-credits/billing-config-page.test.tsx
pnpm typecheck
```

## 3. 前后端接口契约

以下是拟新增契约，现有上传接口保持不变。统一前缀 `/api/v1`。候选 ID、生成 request_id 与 save_request_id 为 UUID；正式账号音色 ID 沿用 fv_*。所有 ID 均不得含路径分隔符，字符串长度按 Unicode 字符计。

### 3.1 候选状态与存储

候选以 `(project_id, requester_id, candidate_id)` 隔离，`candidate_id` 取客户端本次生成的 `request_id`。先写入持久化操作记录，再入队，由 runner 调用网关。入队 scope 由可信 requester ID 的 SHA256 与 candidate_id 组成，和存储的请求者隔离保持一致；记录已落盘但尚未确认入队时，仅补投同一任务，不新建操作。同一个 request_id 和相同规范化请求只创建一次；相同 ID 换内容或来源 surface 返回 409。来源与候选一同持久化，重放与入队恢复使用已记录来源。真正的“重新生成”使用新 UUID，旧候选文件和回执不覆盖。

元数据存 `state_dir/voice-design/candidates.sqlite3`，媒体存 `runtime_dir/voice-design/{requester_id}/{candidate_id}.mp3`，不进入公开 static。状态为 `generating`、`ready`、`failed`、`unknown`、`expired`。只有文件写入并校验成功后才能转为 ready。数据库唯一约束和条件状态更新负责跨进程排重；worker 崩溃留下的 generating 在租约过期后转 unknown，不重新创建上游音色。尚未 claim 的记录也持有十分钟入队期限，重启后超过期限转 unknown，保留输入供用户显式新生成，不自动重复模型调用。

`ready` 的媒体不因保存而被移动或删除。保存回执独立记录 `(candidate_id, character, slot, save_request_id)`，防止保存成功后断线造成再次发布。候选 TTL 按 P1 为生成后 1 小时，与网关音色保留时长取值一致，作为配置项默认值；测试仍由配置注入，开发夹具可用任意短 TTL。两者只是取值相同：DramaClaw 的候选文件独立计时，不依赖网关句柄存活。

### 3.2 生成与查询

```http
POST /api/v1/projects/{project}/voice-design/candidates
Content-Type: application/json
```

```json
{
	"request_id": "178727cd-e421-451c-87e7-68779d72a8ec",
	"surface": "supertale",
	"description": "六十岁左右的男人，嗓子有点沙，说话慢",
	"preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
	"language": "zh"
}
```

必填 `request_id`、`surface`、`description`、`preview_text`；`surface` 只接受现有入口 `supertale|canvas`，分别沿用 `mainline|freezone` 计费归属，不新增产品分类，不传给模型。`language` 默认 `zh`，枚举 `zh|en`；首期部署只开放 `zh`（P4 测试值）。描述去首尾空白后 1～500 字符；试听文本去首尾空白后 15～60 字符；上限为配置项，默认 60，不得超过供应商的 200。未知字段拒绝，模型由服务端配置；前端展示文本长度但不将模型 Key 暴露为表单项。

生成权限为项目 editor，先校验再入队。首次接收及同请求仍 generating 时 HTTP 202，返回 `{ok:true,data:{candidate_id,status:"generating"}}`；同请求已 ready 时 HTTP 200，返回同一候选。客户端用候选 ID 查询，不依赖任务系统的内部状态结构。生成完成后的查询响应：

```json
{
	"ok": true,
	"data": {
		"candidate_id": "178727cd-e421-451c-87e7-68779d72a8ec",
		"status": "ready",
		"description": "六十岁左右的男人，嗓子有点沙，说话慢",
		"preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
		"language": "zh",
		"preview_url": "/api/v1/projects/demo/voice-design/candidates/178727cd-e421-451c-87e7-68779d72a8ec/audio",
		"mime_type": "audio/mpeg",
		"duration_seconds": 8.4,
		"sha256": "<64位小写十六进制>",
		"created_at": "<UTC RFC3339>",
		"expires_at": "<UTC RFC3339，由P1配置计算>"
	}
}
```

`GET /api/v1/projects/{project}/voice-design/candidates/{candidate_id}` 只读查询同一请求者的候选，HTTP 200。ready 使用上述 data；generating 仅返回 ID 与状态；failed、unknown 返回 ID、状态及 `failure:{code,message,retryable}`。已知过期返回 HTTP 410；未知或其他请求者的 ID 均返回 404。

生成失败沿用第 3.5 节错误体。客户端超时后按 request_id 查询，不能自动创建新候选。unknown 的重试按钮明确发起一次新生成；failed 若属于输入或余额错误，先修复原因。编辑过表单后不让迟到响应覆盖新内容，只更新对应 candidate_id。

生成前报价使用 `GET /api/v1/projects/{project}/voice-design/quote?surface=supertale|canvas`。
`surface` 必填；项目 editor 鉴权后，使用服务端解析的项目上下文查询实际项目/组织有效模型和价格。
成功响应为 `{ok:true,data:{cost:1,display:"1",unit:"call",quantity:1}}`（数字仅为测试示例）。
失败沿用第 3.5 节错误体；不接受客户端组织、模型或配置快照，不通过无项目的通用报价推断组织价格。
报价和生成都沿用既有 surface 映射及 `audio.voice_design` 计费功能，不参加促销。

### 3.3 试听

`GET /api/v1/projects/{project}/voice-design/candidates/{candidate_id}/audio`，无请求体。要求项目 viewer 且候选属于当前请求者，响应 `200 audio/mpeg`，支持单段 Range 的 `206`，无效 Range 返回 `416`。附带 `Cache-Control: private, no-store` 和基于文件 SHA 的 ETag。鉴权使用现有 cookie；不在 URL 携带 Key。

此端点只读已归档音频，不调用网关。未完成返回 409，过期返回 410，媒体丢失返回 404 `candidate_audio_missing`。前端捕获 fetch 失败与音频元素 `error`、`play()` 拒绝，保留描述和试听文本，提供再次播放。媒体错误响应为 JSON；组件先检查状态，不能把 JSON 当 MP3 播。

### 3.4 保存到现有角色声线插槽

```http
POST /api/v1/projects/{project}/characters/{name}/voice-samples/{slot}/save-generated
Content-Type: application/json
```

```json
{
	"save_request_id": "ca8fd0be-a220-4de4-bf4e-8d430788b698",
	"candidate_id": "178727cd-e421-451c-87e7-68779d72a8ec",
	"expected_slot": {"path": "", "sha256": "", "updated_at": ""},
	"replace_existing": false
}
```

`slot` 为 `default|child|youth|middle|elder`，与上传一致。`expected_slot` 是用户开始保存时看到的完整插槽元数据，三字段必填，不能只比较 SHA。`replace_existing` 默认 false。空插槽保存是基础行为；已有插槽且 `replace_existing=false` 返回 409 `slot_occupied`。P3 已批准显式替换：目标插槽已有声线时，前端先弹替换确认，用户确认后以 `replace_existing=true` 提交；服务端仍校验 expected_slot，旧文件沿用上传流程归档为 `<stem>_<unix_ts><ext>`，不删除。

权限为 editor，并检查候选属于当前项目和请求者、未过期且 ready。锁内重新读角色与插槽，expected_slot 不匹配返回 409 `slot_changed`。同一角色各年龄段字段共享一个映射，保存不得用过期整份映射覆盖其他年龄段。跨进程写入使用 SQLite 条件更新或现有持久任务串行机制，进程内 `voice_resource_lock` 单独不足以保证跨 worker 一致性。

正式文件通过 `persist_character_voice_file` 发布，使用现有 `_apply_character_voice_update` 更新同一批字段，最后持久化回执。文件和 SQLite 不是同一事务：发布前记录原文件与元数据，写暂存文件并原子替换；数据库失败须恢复旧文件及字段。取消请求沿用 `run_voice_media_operation`，不能让文件成功而 metadata 永久缺失。进程崩溃由保存日志恢复，恢复不调用模型。

首次成功及同 save_request_id 重试均 HTTP 200，`data` 必须是现有 `CharacterVoiceSlot`，字段为 `slot,label,path,url,sha256,updated_at,inherited_from_default,required`。同 ID 修改候选或目标返回 409。回执重放不重新写文件、不改变 updated_at；若保存后插槽已被其他操作修改，返回 409 `slot_changed`，不将旧回执注入当前前端缓存。

前端保存成功复用原有缓存更新和查询失效函数。生成候选不自动绑定角色，不写 `CharacterIdentity`，不修改当前选择。已有绑定选择读取相同字段，仍按原优先级使用保存后的文件。

### 3.5 错误码与前端处理

新接口的同步错误使用实际 HTTP 状态，不复制旧接口部分业务错误返回 HTTP 200 的做法。任务接收后发生的模型错误通过查询的 `failure` 返回，查询本身仍为 HTTP 200；不能把任务失败误报成生成成功。同步失败体固定为：

```json
{
	"ok": false,
	"error": "可向用户展示的失败原因",
	"code": "rate_limited",
	"retryable": true,
	"request_id": "<本地操作UUID>",
	"details": {"retry_after_seconds": 5}
}
```

`details` 可省略，只允许白名单字段；不能返回凭据、上游音色句柄或内部路径。schema 校验错误也转换成这个结构。前端捕获 ky 非 2xx 异常并解析此结构；网络异常单独显示连接失败，不清空表单。

| HTTP | code | retryable 与操作 |
| --- | --- | --- |
| 401 / 403 | `unauthenticated` / `voice_design_forbidden` | false；登录或取得权限。 |
| 404 | `project_not_found`、`character_not_found`、`candidate_not_found`、`candidate_audio_missing` | false；不泄露其他用户候选是否存在。 |
| 409 | `idempotency_conflict`、`candidate_not_ready`、`slot_changed`、`slot_occupied` | 仅 candidate_not_ready 为 true；等待状态或刷新目标后由用户重新保存。 |
| 410 | `candidate_expired` | false；保留文本，可新建候选。 |
| 422 | `invalid_input`、`content_rejected`、`candidate_duration_exceeded` | false；details 标明字段或实际时长。 |
| 402 | `insufficient_credits` | false；不自动再次扣费。 |
| 429 | `rate_limited`、`voice_design_quota_exceeded` | true；返回有依据的 Retry-After，不自动重发创建。 |
| 502 / 504 | `provider_unavailable`、`provider_bad_audio` / `generation_unknown` | true；先查本地状态，再由用户发起新生成。 |
| 503 | `voice_design_unavailable` | false；缺配置或渠道不可用。 |
| 500 | `candidate_persist_failed`、`save_failed` | true；分别查询候选或用同 save_request_id 重试保存。 |

retryable 表示界面可提供重试入口，不授权 HTTP 客户端自动重发非幂等的模型创建请求。

### 3.6 虾画保存与选择

```http
POST /api/v1/projects/{project}/freezone/audio/voices/save-generated
Content-Type: application/json
```

```json
{
	"candidate_id": "178727cd-e421-451c-87e7-68779d72a8ec",
	"save_request_id": "381d5157-c7a6-4841-bd7b-1b4e65617603",
	"name": "沙哑的老年男声"
}
```

name 使用现有账号音色命名约束。项目 editor 可调用；服务端根据已验证的 requester 定位账号，不能接受 username 或 owner 作为请求字段。候选检查沿用项目、请求者、ready 和 TTL 约束。首次及同 save_request_id 重放均返回 HTTP 200，`{ok:true,data:<现有user_custom音色记录>}`，包含 `voice_id,scope,label,name,path,url,exists,sha256,duration_ms,mime_type,created_at,updated_at,source_filename`。正式 ID 为账号库的 `fv_*`，不能使用 candidate_id 或网关音色句柄。

保存复制候选文件，不发模型请求。相同保存请求只生成一个 fv_*；相同 ID 改内容或名字返回 409。账号音色保存回执与角色保存回执按保存类型区分；一个候选可以分别保存到角色和“我的音色”，两次保存都不重新生成或再次计模型费。错误体复用第 3.5 节。

现有 `create_user_audio_voice` 对 `voices.json` 做整份读、追加、写回，缺少跨进程锁；读到坏 JSON 时还会返回空列表。新增保存必须同时修好这处共用写入口：按请求者账号串行写入，锁内重读索引，坏索引拒绝写入，临时文件加原子替换，并给保存回执提供恢复依据。上传与生成保存并发时不能丢失任何一条旧记录。

保存后刷新 `GET /api/v1/projects/{project}/freezone/audio/references`，新记录必须出现在 `available` 及 user_custom 筛选后的“我的音色”。默认保留当前节点的 voiceRef，由用户显式选择新音色；如需“保存并使用”，另设明确操作，不能保存即隐式切换。

选中后仍使用现有 `speechMode=clone`、`voiceRef={scope:"user_custom",voiceId:"fv_*"}`，后端收到 `speech_mode=clone` 和 `voice_ref={scope:"user_custom",voice_id:"fv_*"}`。`VoiceSelectionModal` 已同时用于 `AudioNode`、`AudioOperationsPanel` 和资产板 `AssetBoardAudioGenForm`，新增生成入口放在共享选择器，不复制三份界面。选择器当前没有试听播放器，由共享生成弹窗提供试听。

现有 preset 后端分支主要兼容历史节点，新节点实际提交会走 clone；本次不把它重新包装成已具备的完整系统音色入口，也不将后续长文本配音改成使用临时 CosyVoice 句柄。

## 4. PASS 判定与验证命令

本节是实施后的验收门槛，不是当前已经通过的测试结果。下列新增测试文件及节点名是交付要求，实施者必须创建，不能将“尚无此文件”当作跳过理由。模型响应在本地测试中用 HTTP fixture；真实凭据仅用于 S5 的受控联调。

命令分组如下，均从仓库根执行，pytest 无选中测试和非零退出都算失败：

```sh
# C1 新增：供应商契约、状态与候选存储
uv run pytest tests/test_voice_design_service.py tests/test_voice_design_storage.py -q
# C2 新增：通过 ASGI 客户端验证 HTTP 状态、鉴权和响应
uv run pytest tests/test_api_voice_design.py -q
# C3 现有回归及新增保存行为
uv run pytest tests/test_api_character_voice_samples.py tests/test_character_voice_storage.py tests/test_seedance2_voice_clone.py -q
# C4 前端：新增生成弹窗和 query 契约，保留现有上传测试
pnpm -C frontend test src/__tests__/components/assets/character-voice-panel.test.tsx src/__tests__/components/assets/voice-design-dialog.test.tsx src/__tests__/lib/queries/character-voice-samples.test.tsx src/__tests__/lib/queries/voice-design.test.tsx
# C5 改动前端时执行类型检查
pnpm -C frontend exec tsc -b
# C6 新增文件及触及的现有文件无 Ruff 问题
uv run ruff check src/novelvideo/audio/voice_design_service.py src/novelvideo/audio/voice_design_storage.py src/novelvideo/api/routes/voice_design.py src/novelvideo/api/routes/characters.py src/novelvideo/api/routes/freezone.py src/novelvideo/seedance2_i2v/character_voice_storage.py src/novelvideo/freezone/audio_node.py
# C7 文档和补丁空白检查
git diff --check
```

每个 PASS 对应以下测试或命令，不设置“体验一致”“音色符合期待”这样的机械验收项。

| PASS | 可机械核对的断言 | 对应测试或命令 |
| --- | --- | --- |
| A01 | 网关请求的 model、target_model、字段和 endpoint 等于第 2.3 节；仅发起一次创建。 | C1 `test_gateway_voice_enrollment_contract` |
| A02 | 缺预览、坏 Base64、错误格式、超过 10 MiB、不可解码和时长超过 15 秒都不产生 ready 候选。 | C1 `test_invalid_preview_is_not_published`，参数化全部条件 |
| A03 | 连续生成与重新生成后，已有正式声线文件 SHA、角色字段及身份字段与生成前逐项相等。 | C2 `test_regenerate_preserves_saved_and_uploaded_voices` |
| A04 | 相同 request_id 的并发请求及记录落盘后入队中断只产生一个逻辑任务和一次网关请求；换内容为 HTTP 409；重启查询仍能找到已完成候选。 | C2 `test_generation_idempotency_survives_restart` |
| A05 | 网络超时或 worker 中断后状态是 unknown，查询与自动重试机制都不再创建上游音色。 | C1 `test_unknown_generation_is_not_resubmitted` |
| A06 | 生成 HTTP 4xx、5xx、超时、播放 fetch 失败、音频 error 和 play 拒绝后，描述及试听文本逐字保留，重试按钮可操作。 | C4 `retains inputs after generation and playback failures`，参数化全部条件 |
| A07 | 两次播放只请求本地媒体，模型 HTTP 调用数不增加；过期、Range 与无效 Range 状态分别为 410、206、416。 | C2 `test_preview_is_local_and_range_aware` |
| A08 | 通过 API 分别上传和保存候选后，slot 响应字段集合相同；真实存储中的文件可由 `resolve_character_voice` 解析成相同 tier，路径和 SHA 对应本次输入。 | C2 `test_generated_and_uploaded_voice_share_binding_flow`，参数化五个 slot |
| A09 | 保存请求重放不改文件、SHA 或 updated_at；换目标返回 409。 | C2 `test_save_is_idempotent` |
| A10 | 上传或其他保存抢先修改目标时保存返回 409；不同年龄段并发保存两项都保留。 | C2 `test_save_compare_and_set_preserves_concurrent_updates` |
| A11 | 绑定数据库失败、取消及重启恢复后，文件与元数据成对存在，其他插槽和身份字段未变化。 | C2 `test_save_failure_recovers_file_and_metadata` |
| A12 | 种入旧项目的默认、年龄段及身份覆盖后，读取和解析结果与原预期一致；生成后再次断言字段不变。 | C3 原有解析测试与 C2 `test_legacy_bindings_survive_generation` |
| A13 | viewer 无法生成或保存；其他请求者和其他项目候选访问均为 404；越权调用的模型调用数为零。 | C2 `test_candidate_access_is_scoped` |
| A14 | 组织凭据缺失或 subject 不可信时拒绝出网；HTTP 请求中没有平台 Key 回退。 | C1 `test_voice_design_respects_trusted_egress` |
| A15 | 入队前错误使用第 3.5 节 HTTP 状态和 code；任务内模型限流、额度不足、拒绝及故障通过 HTTP 200 查询中的 failed 或 unknown 与 failure.code 返回，错误体不含凭据。 | C2 `test_voice_design_error_contract` |
| A16 | 超过配置并发或预算后不发上游请求；进程重启不绕过持久配额。 | C1 `test_admission_and_budget_precede_provider_call` |
| A17 | 候选 TTL 到期后不可读、不可保存；清理执行两次不删除正式文件或其绑定。 | C1 `test_candidate_expiry_never_deletes_saved_voice` |
| A18 | 前端生成不改正式缓存；保存调用原缓存更新后，声线列表和角色查询显示返回的 path 与 SHA。 | C4 `publishes generated voice through existing cache update` |
| A19 | 原有上传、录音、裁剪、取消及串行写入测试全部通过。 | C3，另加 C4 现有上传测试 |
| A20 | 触及的豁免文件完成清理，豁免键被删除，且不带 ignore 的 Ruff 检查退出 0。 | C6 与第 7 节静态命令 |
| A21 | 前端类型检查与补丁空白检查退出 0。 | C5、C7 |
| A22 | 保存候选到“我的音色”后，references.available 包含同 SHA 的 user_custom 记录；同保存请求重放只有一个 fv_*。 | `uv run pytest tests/test_api_voice_design.py -q -k generated_user_voice`，新增 `test_generated_user_voice_save_and_replay` |
| A23 | 上传与生成保存并发均保留；坏账号索引导致明确失败，原索引字节不变。owner 与 requester 不同时归属 requester。 | 新增 `test_generated_user_voice_concurrent_upload`、`test_generated_user_voice_rejects_corrupt_index`、`test_generated_user_voice_belongs_to_requester`，同 A22 命令 |
| A24 | 从音频节点及资产板分别生成、试听、保存、选择后，提交仍使用 clone 与 user_custom 引用；生成、保存失败不修改旧 voiceRef。 | 新增 `frontend/src/__tests__/features/canvas/voice-design-selection.test.tsx`，用 `pnpm -C frontend test src/__tests__/features/canvas/voice-design-selection.test.tsx` 运行 |
| A25 | 同一 candidate_id 从角色与虾画入口分别保存，模型创建调用总数仍为 1；候选清理后两个正式文件均可读。 | 新增 C2 `test_candidate_reused_across_character_and_canvas` |
| A26 | 平台音频条目及 targetModel 可配置、读取、导入导出；组织禁用或不可见目标时拒绝出网；音频默认端点不落到视频。 | C8 扩充 `test_audio_voice_design_catalog_round_trip`、`test_audio_voice_design_target_visibility` |
| A27 | audio.voice_design 按 1 次报价、预扣、结算；描述长度变化不改变数量；重放、试听和保存不增加收费记录。未登记功能的任务仍被拒绝。 | C8 扩充 `test_voice_design_billing_once`、`test_voice_design_task_requires_registered_feature` |
| A28 | 新迁移保留已有 image/video 模型、价格及组织覆盖；三张表可插入合法 audio 行，错误类型配对仍失败。 | C8 新增并运行 `tests/test_voice_design_audio_migration.py` |
| A29 | All 功能价格页可编辑该功能的 audio 模型价格，组织覆盖页可管理 audio；模型表单可保存设计目标。 | C9 对应现有测试增加 audio 场景 |
| A30 | EE 请求者账号目录不可读写时保存失败且不覆盖索引；owner 不等于 requester 时，文件及读取权限仅归 requester。 | C8 新增并运行 `tests/b2b/test_voice_design_user_voice_storage.py`；S5 实际部署联调记录 |
| A31 | 保存到已有声线的插槽：`replace_existing=false` 返回 409 `slot_occupied` 且文件不变；为 true 且 expected_slot 匹配时替换成功，旧文件以 `<stem>_<unix_ts><ext>` 归档仍存在、SHA 不变，新文件 SHA 等于候选；expected_slot 不匹配返回 409 `slot_changed`。 | C2 `test_replace_existing_archives_previous_voice` |

### 4.1 用户界面验收目标

下表把“在哪点、看到什么、改变什么”作为验收单位。不能仅用 API 通过代替界面交付，也不能只验证成功路径。所列测试是实施交付要求，当前未实现。

```sh
# C10 共享弹窗、角色入口、虾画节点与资产板的交互测试
pnpm -C frontend test src/__tests__/components/assets/voice-design-dialog.test.tsx src/__tests__/components/assets/character-voice-panel.test.tsx src/__tests__/features/canvas/voice-design-selection.test.tsx
# C11 新增真实浏览器验收脚本；在专用本地测试部署运行
uv run python scripts/acceptance/voice_design_ui.py --base-url "$VOICE_DESIGN_TEST_BASE_URL" --admin-base-url "$VOICE_DESIGN_TEST_ADMIN_BASE_URL" --artifacts-dir runtime/acceptance/voice-design-ui
```

C11 是需要新增的脚本，使用 Playwright 驱动真实应用和后台页面，S5 同片补入 Python dev 依赖。初次准备浏览器执行 `uv run playwright install chromium`。账号通过测试环境现有登录流程建立，会话或凭据从环境取得，不写入截图、报告或仓库。脚本仅在专用测试部署准备数据和配置，并用确定性的测试网关替代付费供应商；前端页面、业务 API、持久化和任务状态使用真实实现。脚本在任一断言失败时非零退出，输出各 UI 编号的通过或失败和截图路径；不把手工截图当作自动验收成功。

| UI 编号 | 操作与可观察的通过结果 | 对应测试或命令 |
| --- | --- | --- |
| U01 | 从角色声线面板逐个显示槽打开“按描述生成”，弹窗展示正确角色和实际 actionSlot 标签；保存请求中的 slot 与其相等。原上传、录音入口仍可点击。 | C10 `opens voice design for the actual slot`，参数化角色年龄及 default 映射；关联 A08、A19。 |
| U02 | 从虾画普通节点、操作面板和资产板打开音色选择器，在“我的音色”空列表及非空列表均能进入同一生成弹窗。 | C10 `opens shared voice design from every canvas entry`，参数化三个入口及空列表。 |
| U03 | 描述空白或超过 500 字符、试听文本少于 15 或超过配置上限（默认 60）字符时显示具体字段错误，不发生成请求；有效边界值可提交。计数与服务端按 Unicode 字符一致。 | C10 `validates description and preview text before submit`，参数化边界及非 BMP 字符；关联 A01、A15。 |
| U04 | 点击生成后出现“正在生成”，重复点击不多发请求，保存禁用；收到 ready 才出现播放器、实际时长、保存按钮可用。响应中只有模型句柄而无可读音频时显示错误。实际时长超过 5 秒时显示“用于视频参考建议 3～5 秒”提示，不超过时不显示。 | C10 `shows generation states and prevents duplicate submit`、`shows video reference hint for long samples`；关联 A02、A04。 |
| U05 | 对 ready 音频点播放、暂停、再次播放，播放器状态和当前时间随媒体事件更新；新增模型调用数为零。音频失败显示重试试听，描述和试听文本逐字不变。 | C10 `plays generated sample and retains inputs on playback error`，C11 同场景；关联 A06、A07。 |
| U06 | 已有声线时重新生成成功或失败，正式插槽及节点原选择均不变；失败后输入及上一条成功试听仍在。 | C10 `regenerates without replacing the configured voice`；关联 A03、A06、A18、A24。 |
| U07 | 保存中按钮不可重复提交；成功后角色目标插槽显示新音频，其他插槽不变。模拟目标被他人修改时显示冲突原因，保留结果，不出现保存成功提示。目标插槽已有声线时先出现替换确认：取消不发保存请求且结果保留，确认后请求带 `replace_existing=true`。 | C10 `publishes only after successful save and shows slot conflicts`、`confirms before replacing an occupied slot`；关联 A09～A11、A31。 |
| U08 | 在虾画给结果命名并保存后，“我的音色”可见该名称；节点原选择不变。点击新记录的“选择”，节点标签更新，下一次语音请求携带对应 user_custom 引用。 | C10 `saves to my voices then explicitly selects the new voice`，C11 同场景；关联 A22、A24。 |
| U09 | 生成超时先查询原任务，不悄悄发新生成；过期时显示过期且保存禁用；权限或模型配置不可用时显示原因并禁用对应操作。各分支均保留已填输入。 | C10 `recovers unknown expired and unavailable states`，参数化状态；关联 A05、A13、A15、A17。 |
| U10 | 同页关闭并重开能找到原输入及任务结果；切换角色、插槽或项目后，旧任务响应不能覆盖新目标。Tab 可达表单、播放、生成、保存，关闭后焦点回触发按钮。1280 与 768 宽度下，长文本和错误区不造成弹窗水平溢出或遮住按钮。 | C10 `keeps dialog drafts scoped to their target`；C11 检查焦点、请求归属、按钮可见且可点击、scrollWidth 不超过 clientWidth。 |
| U11 | EE 后台筛选音频、新建设计模型、选择 CosyVoice 目标后保存并重开，值相等；无效目标出现字段错误。切回图片或视频表单不出现音频专属字段。 | C9 新增场景 `edits audio design target without changing image video forms`；C11 同场景；关联 A26、A29。 |
| U12 | 在 All 功能页为设计功能保存按次价格、在组织页保存 audio 覆盖价后，新生成的报价使用该配置。试听、保存同一结果后收费记录数量不增加，组织禁用后生成按钮显示不可用原因。 | C9 新增场景 `configures voice design pricing and organization visibility`；C11 对照测试夹具价格和真实报价响应；关联 A26、A27、A29。 |

U01～U12 全部通过、C5 类型检查和 C6 lint 通过后才可报告 UI 验收完成。C11 必须包含角色入口、虾画入口、资产板及后台配置的记录；本机组件测试通过不能代替这一组真实浏览器操作。模型主观音色满意度由用户试听选择，不加入机械 PASS。

## 5. 不变量清单

“守护方式”每条只选“测试”“机械检查”“引用”之一。引用项只是方案依据，不冒充运行时保障。

| ID | 不变量 | 守护方式 | 守护证据 |
| --- | --- | --- | --- |
| I01 | 重新生成不覆盖已上传或已保存的声线。 | 测试 | A03，候选目录与正式插槽文件分离。 |
| I02 | 生成或试听失败时，用户填写的描述和试听文本不丢。 | 测试 | A06，表单状态不随 mutation reset 或播放失败清空。 |
| I03 | 保存后的声线与上传声线走同一套选择和绑定流程。 | 测试 | A08、A18，复用 slot 返回、缓存更新及 resolver。 |
| I04 | 已有声线与绑定关系不变，除非用户显式保存到目标插槽且通过冲突检查。 | 测试 | A10、A12、A19，目标以外字段逐项比较。 |
| I05 | 模型创建不因网络超时、重放或重启自动重复。 | 测试 | A04、A05，持久化 request_id 和 unknown 状态。 |
| I06 | 候选不能跨用户、跨项目读取或保存，组织请求不借用平台凭据。 | 测试 | A13、A14。 |
| I07 | 保存成功后，正式文件与数据库引用一致，保存重试不重新发布。 | 测试 | A09、A11，取消与崩溃恢复也覆盖。 |
| I08 | 试听与保存使用同一份音频；重复播放不调用模型。 | 测试 | A07、A08，保存文件 SHA 等于候选 SHA。 |
| I09 | 清理临时候选不会删掉已保存文件，过期候选不能继续保存。 | 测试 | A17，正式保存是复制，不是临时文件引用。 |
| I10 | 触及 Ruff 豁免文件时顺手清 lint、删豁免行。 | 机械检查 | A20、C6 及 pyproject 豁免键检查。 |
| I11 | 网关音色句柄不是持久声线资产，不能依赖其长期合成。 | 引用 | 第 2.2 节固定 SHA 的生命周期文档，1 小时和一次成功消费规则。 |
| I12 | 费用、并发和额度检查发生在模型调用之前，错误响应不暴露秘密。 | 测试 | A15、A16。 |
| I13 | 虾画新生成声线与上传声线均为 user_custom，同一选择器和语音提交契约可用。 | 测试 | A22、A24、A25。 |
| I14 | 账号音色索引不因并发或解析失败丢失旧记录，保存归属请求者。 | 测试 | A23。 |
| I15 | 模型配置、组织可见性和有效价格控制真实生成，不能靠硬编码绕过后台配置。 | 测试 | A26、A27、A29。 |
| I16 | audio 目录和定价迁移保留历史图像、视频配置与价格，账号音色不变成组织共享。 | 测试 | A28、A30。 |
| I17 | 替换已有声线必须经用户确认，被替换的旧文件归档、不删除。 | 测试 | A31、U07。 |

## 6. Pre-mortem

假设上线后出问题，优先排查以下五项。

| 最可能的原因 | 事故表现 | 对应不变量或测试 |
| --- | --- | --- |
| 把网关 voice 句柄直接写入角色，或仅保存短期 URL。 | 一小时后声线失效；用户试听过但保存后无法配音。 | I08、I09、I11；A08、A17。 |
| 候选生成复用正式插槽路径，或者异步响应直接更新角色缓存。 | 用户点重新生成就替换了已上传声线。 | I01、I04；A03、A18。 |
| ky 超时后自动重发创建，或继续使用默认 30 秒超时。 | 重复生成、重复费用、用户看不到已生成结果。 | I05、I12；A04、A05、A16。 |
| 失败处理重置表单，播放错误只弹通用提示。 | 描述丢失，无法按原内容重试。 | I02；A06 参数化生成与播放失败。 |
| 文件发布和数据库提交分离，且保存基于旧角色快照。 | 绑定指向不存在文件，或另一年龄段及上传刚写的声线被覆盖。 | I04、I07；A10、A11。 |

## 7. 切片与文件归属

S0 先固定第 3 节契约，之后 S1、S2、S4 可按契约和 fixture 并行；S3、S6 依赖 S2 的候选文件与回执接口。S7、S8 按共同音频目录契约开发，S5 在共享应用、EE 和管理后台汇合后验收。这里描述开发分工，不在本次启动实现 agent。

| 切片 | 范围与依赖 | owns：会改的文件或目录 | 验证命令 |
| --- | --- | --- | --- |
| S0 契约 | 导出候选与保存请求的 OpenAPI schema、成功及失败 fixtures；不调用模型。契约包含 P3 已批准的 `replace_existing` 替换分支与 `slot_occupied` 拒绝分支。 | 新增 `api/routes/voice_design.py` 中的边界模型、`tests/test_api_voice_design.py` 的契约 fixtures；本文。 | C2 的 schema 和错误体测试、C7。 |
| S1 网关与共享模型配置 | 实现百炼设计、身份、凭据、计费预留及结果验证；扩共享 audio 目录、端点、报价和有效配置读取；不写正式声线。依赖 S0，与 S7、S8 对齐配置契约；测试不依赖线上 Key。 | 新增 `audio/voice_design_service.py`、`tests/test_voice_design_service.py`；修改 `task_backend/runners/audio.py` 注册 `voice_design`，按需改任务投递配置；修改 `media_model_request_schema.py`、`model_gateway_settings.py`、`api/routes/model_gateway.py`、`api/routes/model_credits.py` 及对应测试；需要提供可导入初始模板时改 `official_media_models.json`，EE 缺配置仍拒绝。 | C1 服务测试、A01、A02、A05、A14、A16；`uv run pytest tests/test_task_backend_registry.py tests/test_media_model_request_schema.py tests/test_model_gateway_settings.py tests/test_api_model_credit_cost.py -q`；对改动 Python 路径运行 Ruff。 |
| S2 候选生命周期 | 实现独立候选存储、持久幂等、状态查询、鉴权试听及 TTL 清理。依赖 S0；TTL 测试注入。TTL 按 P1 为 1 小时；生产启用前依赖 P4 价格经产品确认。 | 新增 `audio/voice_design_storage.py`、`tests/test_voice_design_storage.py`；扩充 `api/routes/voice_design.py`、`tests/test_api_voice_design.py`；修改 `api/__init__.py` 注册路由。 | C1 存储测试、C2 的 A03～A07、A13、A17。 |
| S3 正式保存 | 复用上传持久化与绑定，加入冲突比较、保存回执、回滚和恢复。依赖 S2，替换已有声线按 P3（已批准）实现，由 A31 证明。 | `api/routes/characters.py`、`seedance2_i2v/character_voice_storage.py`、新增保存回执逻辑所在的 `audio/voice_design_storage.py`、`tests/test_api_character_voice_samples.py`、`tests/test_api_voice_design.py`、`tests/test_character_voice_storage.py`；`pyproject.toml`。 | C2 的 A08～A12、C3、C6。 |
| S4 现有声线管理 UI | 按第 1.1～1.4 节交付入口、共享弹窗及完整状态；保留输入和旧候选，处理错误码；用 fixtures 可先做。依赖 S0，联调依赖 S1～S3。 | `frontend/src/components/assets/character-voice-panel.tsx`，新增同目录 `voice-design-dialog.tsx`；新增 `frontend/src/lib/queries/voice-design.ts`；修改 `lib/queries/characters.ts`、`lib/query-keys.ts`、`frontend/src/types/` 中对应类型；相关 `__tests__`；`frontend/public/locales/` 文案。 | C4、C5、C10，U01、U03～U07、U09、U10；按 `DESIGN.md` 实现。若改 token，同步文档并执行 `npx @google/design.md lint DESIGN.md`，0 errors。 |
| S5 联调与上线门槛 | 校验真实部署路由、单 Key 渠道、可信 subject、账单及预览交付；证明保存后现有 IndexTTS2 可以读取文件，并验证 EE 后台改配置会影响新任务。按 U01～U12 驱动真实页面并交付截图及断言记录。不扩大到全量视频回归。依赖前述切片、S6～S8，以及 P4 价格经产品确认。 | 新增 `scripts/acceptance/voice_design.py`、`scripts/acceptance/voice_design_ui.py`，`pyproject.toml` 的 Playwright dev 依赖；更新本文验收记录。报告只写请求 ID、候选 SHA、slot SHA、配置版本、脱敏账单和测试页面截图。 | C1～C7、C10、C11 及第 2.7 节 EE、后台检查；`uv run python scripts/acceptance/voice_design.py --project "$VOICE_DESIGN_TEST_PROJECT" --character "$VOICE_DESIGN_TEST_CHARACTER" --slot default`，非零表示未通过。 |
| S6 虾画复用，本期必做 | 复用同一候选 API 与弹窗，增加“保存到我的音色”；上传与生成保存共用受保护的账号索引写入。依赖 S0、S2；共享弹窗联调依赖 S4。 | `api/routes/freezone.py`、`api/schemas.py`、`freezone/audio_node.py`、`VoiceSelectionModal.tsx`、`frontend/src/api/ops.ts` 或共享 query；`frontend/public/locales/`；相关 `tests`；`pyproject.toml`。节点与资产板只补必要调用连接，避免复制入口。 | A22～A25；`uv run pytest tests/test_freezone_audio_backend.py tests/test_freezone_audio_speech_prereq.py tests/test_freezone_audio_enqueue_projection.py -q`；`pnpm -C frontend test src/__tests__/features/canvas/audio-voice-prereq.test.tsx src/__tests__/features/canvas/asset-board-audio-detail.test.tsx src/__tests__/features/canvas/voice-design-selection.test.tsx`；C5、C6。 |
| S7 EE 模型与价格 | 补有效 audio 目录、共享计费 feature、三张表约束迁移、平台及组织覆盖价、配置导入导出；不改 CE AdmissionContext。依赖 S0，与 S1 对齐；已有计费缺配置时仍拒绝。 | EE 仓库 `src/novelvideo_ee/media_model_models.py`、`media_model_catalog.py`、`feature_billing.py`、`orgs/pricing_models.py`、`orgs/pricing_service.py`、`billing_config_transfer.py`、`org_billing_config_transfer.py`；`src/supertale_admin/routes.py`；新增 `migrations/versions/` 版本迁移；对应 tests。若目录服务调用者存在二分判断，同片迁移。 | C8、A26～A28、A30；对触及 EE Python 文件运行其配置下 Ruff。 |
| S8 EE 管理后台 | 音频模型表单及筛选、目标 TTS 配置、All 功能页音频模型价格、组织 audio 覆盖价与配置往返。依赖 S1、S7 的 schema 与 API，fixtures 可先做；不扩促销规则。 | admin-fe 仓库 `src/lib/types.ts`、`src/lib/organization-api.ts`、`src/components/media-models/MediaModelManager.tsx`、必要的 `adapters.ts`、`src/features/feature-credits/FeatureCreditsPage.tsx`、`OrganizationPricingPage.tsx`、相关 i18n 与 tests。 | C9、A29；确认表单保存结果与 EE 回读配置一致。 |

S3 修改 `characters.py` 时必须“顺手清 lint、删豁免行”：清理 E402，删除 `pyproject.toml` 中该文件的豁免键。S6 修改 `freezone.py`，同样清理 F401 并删该豁免键。若实现必须修改 `generators/tts_generator.py`，清 F401、F541 并删除其豁免；不得为了增加一个导出包装而改它。其余新增触及文件也须先对照豁免表，不只检查这三项。

S3 与 S6 的机械检查命令如下；触及 tts_generator 时扩充清单。

```sh
uv run ruff check --ignore-noqa --isolated --select E4,E7,E9,F src/novelvideo/api/routes/characters.py src/novelvideo/api/routes/freezone.py
python3 - <<'PY'
import pathlib
import tomllib
config = tomllib.loads(pathlib.Path("pyproject.toml").read_text())
ignores = config["tool"]["ruff"]["lint"]["per-file-ignores"]
assert "src/novelvideo/api/routes/characters.py" not in ignores
assert "src/novelvideo/api/routes/freezone.py" not in ignores
PY
```

职责边界：只在已有 `characters.py` 提取必须共享的上传和候选保存动作，不建立多供应商插件框架，不把模型调用塞进 `voice_clone.py`。S3 的新增恢复复杂度来自文件与数据库的跨资源发布，必须由 A11 证明，不能仅靠 try/except 后返回成功。

S5 脚本只写专用测试项目的空插槽，不替换生产声线。验证内容包括生成一次、播放两次不增加调用、保存一次、回读 SHA 和 resolver 结果。涉及真实模型费用和后续 IndexTTS2 合成的运行需使用已授权测试额度；本次文档任务不运行这些付费调用。

上线用默认关闭的能力配置控制新入口和新生成端点。关闭后仍允许在 TTL 内查询、试听和保存已存在候选；上传入口、历史绑定和已保存文件持续可用。回滚不删除新增候选目录或正式声线，不反向迁移历史数据。

## 8. 产品决策

已确认的决策：本期采用百炼 `voice-enrollment` 与 `cosyvoice-v3.5-flash`，不新增绘梦网关适配；虾画入口本期完成，生成结果可保存到“我的音色”后选用。P1、P3 已于 2026-10-29 由用户拍板；P4 的数值先用测试值开发，PR 描述必须列出全部待配置的价格和项目，由产品修改确认后才可上线。

| ID | 决定 | 落地 |
| --- | --- | --- |
| P1 | 未保存候选与网关保留时长一致。 | TTL 为生成后 1 小时（网关 `service/voice_design_lifecycle.go` 的 `ExpiresAt`），配置项默认值；界面显示过期时间；不承诺刷新或重新登录后找回。每用户每项目最多 5 个未保存候选，超出时丢弃最旧的（测试值，待产品确认）。 |
| P3 | 允许替换已有插槽，替换前确认；试听最长 15 秒。 | 现有上传覆盖没有确认，本期只为“按描述生成”的保存新增替换确认（第 1.3 节），上传流程不变。旧文件沿用上传流程归档。试听文本 15～60 字符；生成后探测时长，超过 15 秒拒绝并提示缩短文本，不提供候选裁剪。时长超过 5 秒时提示视频参考建议 3～5 秒（Seedance2 建议值，单次请求参考音频总长不超过 15 秒）。 |
| P4 | 测试环境自定，上线前由产品确认。 | 测试值：每次生成 1 积分（EE 要求正价）、每用户每日 20 次、只开放 zh、不参加促销。缺预算配置时生产入口不得启用。 |

PR 描述须列出的配置项（产品确认）：

1. EE 新增的 voice design 计费项（kind audio，按次）的平台价与组织覆盖价。
2. `voice-enrollment` 与 `cosyvoice-v3.5-flash` 的媒体模型目录条目及价格；当前 `official_media_models.json` 没有 audio 条目。
3. TTL、候选上限、每日额度、试听文本长度、时长上限、开放语言。
4. 渠道预算。
5. 对照：现有 `freezone.audio_speech`（按 billable_chars）与 `mainline.beat_audio_generation`（按 items）的线上价格只存在 EE 数据库，需从后台读出。
6. 供应商参考：创建音色免费；`cosyvoice-v3.5-flash` 合成 0.8 元/万字符（北京，不含优惠）；内置试听是否计费文档未说明。

## 9. 本次方案交付与验证记录

首次交付新增本文，本轮根据已确认决策补充虾画、EE 和管理后台调查；不修改应用、线上模型配置或网关源码，不 push。提交前以实际工作区执行 `git diff --check`，检查本文的仓库内 Markdown 链接、JSON 示例及引用的现有测试路径，并人工核对需求八项、接口状态、PASS 与不变量对应关系。应用 HEAD 和远端源码快照 SHA 见文首。

验证环境：macOS，本机 zsh，Python 3 标准库；配置现状诊断使用本仓库 `.venv/bin/python` 的 Python 3.12.10 与现有 Pydantic 环境。首次交付静态检查已通过。本轮针对 `2caa593f…` 加本文修订重新执行 `git diff --check`，退出 0；Python 检查的 5 个仓库内链接有效，8 段 JSON 示例可解析，20 个引用的现有测试路径均存在。未把后续要求新增的测试当作已存在或已通过。

本轮还直接运行共享 `validate_media_model_catalog_config({}, "audio")` 及 `validate_media_request_schema({"endpoint":"audio/voice-designs","parameters":[]})`，分别复现 `media type must be image or video` 和 `unsupported NewAPI media endpoint`；对照 image 目录和 audio/speech 端点可通过。读取 EE 固定 SHA 的 `MediaModelReq` 并传 audio 条目，同样复现媒体类型拒绝。这些诊断证明当前配置缺口，不是新增功能已经通过。

C1～C6、C8～C11 和 S5 是后续实现验收命令，本轮未运行，不能据此宣称功能或 UI 通过。本轮 UI 方案补充基于 HEAD `9e9b7d3a4b6486d0ae10c47b03ea6b20022dacc0`，已读 DESIGN.md。修订后 `git diff --check` 退出 0，6 个仓库内链接有效，8 段 JSON 可解析；人工核对了 U01～U12 与测试或浏览器命令的对应关系。最终文档提交 SHA 由 Git 提交结果报告，避免把尚未产生的提交写进文档。

2026-10-29 修订：按用户对 P1、P3、P4 的决定更新第 1.1～1.3、3.2、3.4、3.5、4、4.1、5、7、8 节，新增 A31、I17；仅改本文。

### S0 契约导出（2026-10-30）

边界模型位于 `src/novelvideo/api/routes/voice_design.py`，尚未注册生产路由。
生成请求使用 `VoiceDesignCreateRequest`；角色与账号保存请求分别使用
`SaveCharacterVoiceRequest`、`SaveUserVoiceRequest`。生成接收响应为
`CandidateAcceptedResponse`，查询响应为 `CandidateResponse`；两类保存成功响应为
`CharacterVoiceResponse`、`UserVoiceResponse`。所有模型均可调用
`model_json_schema()` 导出 JSON Schema，或作为 FastAPI 的请求/response_model
导出 OpenAPI。`Candidate` 联合类型用 `TypeAdapter(Candidate).json_schema()` 导出五态。
`CandidateResponse` 不包含 expired：已知过期查询应返回 HTTP 410 的
`VoiceDesignError`，不能包装成 HTTP 200 成功。

`ERROR_POLICY` 固定第 3.5 节的 HTTP 状态及 retryable；`ErrorDetails` 只允许
`field`、`duration_seconds`、`retry_after_seconds`，省略未提供值时使用
`model_dump(mode="json", exclude_none=True)`。`field` 只能是公开请求字段名。
错误消息仍须由路由/服务提供可公开的文案，模型不会自动净化自由文本。
后续路由必须把框架校验异常转换为此错误体，不能返回原始 Pydantic input/ctx。
无有效操作 UUID 的校验失败需由服务端分配本地请求 UUID。
语言枚举保留 zh/en；部署开放语言、额度与可配置试听长度由后续服务边界落实，
当前 schema 固定已批准的默认 15～60 字符。账号音色名称复用现有
`_safe_voice_name`，不改变上传路径的命名规则。

成功及失败 fixtures 位于 `tests/test_api_voice_design.py`，最小 FastAPI 测试 app
验证 schema、序列化、202/200/410/422 错误 envelope 和替换请求的契约。
其中保存及查询 handler 只返回 fixtures，不证明候选生命周期、权限、真实保存、
幂等、并发或替换归档已经实现。S0 未调用供应商，未修改生产路由注册。

S0 验证环境为 macOS arm64、uv 管理的 Python 3.12.10。起点为
`a704c6c482fc07668770bb2009f0c01dff5d5921`；首轮
`uv run pytest tests/test_api_voice_design.py -q` 得到 9 failed，均因待新增的
`novelvideo.api.routes.voice_design` 模块缺失。实现后同命令通过；交审前再次执行
该测试、两个新增 Python 文件的 Ruff 检查及 `git diff --check`。
最终测试数量和完整提交 SHA 由交审回报记录，不把未发生的 Git SHA 写入本文。

### S2 候选生命周期接口补充（2026-10-30）

创建契约新增必填 `surface`，错误详情字段白名单同步包含 `surface`；已有 S0 状态及成功响应保持不变。
存储与试听使用项目私有 state/runtime，未保存候选最多五个，ready 后一小时过期。
候选数据库中的 claim 与共享配额数据库使用同一 SQLite 事务：限制请求者每日次数、渠道每日次数和请求者同时一次调用。
共享配额位于全局 `STATE_DIR/voice-design/quota.sqlite3`；多节点上线时必须验证各节点使用同一权威配额存储，单机跨进程测试不能证明跨节点隔离配置正确。
存储 TTL 可由 `VOICE_DESIGN_CANDIDATE_TTL_SECONDS` 配置（默认 3600，必须是有限正数）；TTL 和 lease 也可由构造参数注入；正式保存与保存回执由 S3/S6 完成，保存后须将候选排除出未保存上限。
API router lifespan 启动时及每五分钟扫描持久登记的可信项目/请求者目录，清理不依赖该用户再次访问；应用关闭时取消后台任务。候选路径统一拒绝 runtime、候选根、请求者目录及文件的软链接，写入、试听与清理共用该边界检查。
本片的服务/报价测试使用 S1 边界 fixture，真实 runner、可信凭据、组织目录和计费联调留给后续集成验证。

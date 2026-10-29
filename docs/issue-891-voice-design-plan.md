# #891 需求二：按描述生成声线方案

状态：供前后端并行开发的方案，未实施。产品待决项见第 8 节，不代表已获批准。

分析日期：2026-10-29。DramaClaw 基于当前 HEAD `4c48e0787a4dd1aa9cd0efda94f82fefaccacb3c`。
网关基于远端 `main` `40d696d7f60153c4556d82a7cb09c8e4923231f1`，通过 `git ls-remote origin refs/heads/main` 核对，并下载该 SHA 的源码快照阅读。本机网关 checkout 的 `45f96b84…` 不是本次结论的依据。

需求来源：[dramaclaw #891](https://github.com/dramaclaw/dramaclaw/issues/891)，查阅时无评论。本文只处理需求二；需求三中上传能力和历史绑定的条目作为兼容性约束。

## 1. 范围与非目标

在现有角色声线管理组件 [character-voice-panel.tsx](../frontend/src/components/assets/character-voice-panel.tsx) 增加入口。用户填写描述和试听文本，生成独立候选，播放候选，可重新生成，最后显式保存到所选角色声线插槽。

本期方案不修改需求一的音频开关、缺失声线提示和视频提交逻辑；不实施需求四的身份造型入口整合、身份独立绑定或数据迁移；不移除或重做上传、录音和裁剪。旁白管理不新增入口。虾画是否本期接入口由 P2 决定，不能把未实施的虾画复用算作整个需求二已完成。

技术选择：通过 claymore-llm-gateway 的百炼 `voice-enrollment`，指定 `target_model=cosyvoice-v3.5-flash`，取得预览音频并保存为文件。后续配音继续使用现有 IndexTTS2 参考音频流程。这里设计的是“可保存的参考音频”，不是把供应商音色 ID 加进角色绑定系统。

## 2. 模型功能、网关支持与接入分工

### 2.1 三个名称分别做什么

| 名称 | 功能与使用方法 | 对本需求的用途 |
| --- | --- | --- |
| 百炼 `voice-enrollment` | 音色创建和管理服务。`create_voice` 携带 `voice_prompt`、`preview_text`、`target_model` 时按描述设计；基于录音的复刻是另一种请求。设计返回 `voice_id` 和 Base64 预览音频。 | 推荐用于本次候选生成。不要因为名称中有 enrollment 就当成只支持上传复刻。 |
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

若选此路径，先在网关另立任务实现音频提交、查询、归档、计费和错误转换。候选服务仍输出第 3 节的结构。模型可能生成环境声或多角色表演，提示词不能机械保证“干净单人声”，因此不能在本方案里写成已满足的 PASS。是否引入它见 P5。

### 2.5 成本、限流和失败分类

百炼创建 CosyVoice 设计音色免费，`cosyvoice-v3.5-flash` 合成标价为 0.8 元/万字符，来源为[设计指南](https://help.aliyun.com/zh/model-studio/voice-design-user-guide)和[模型卡](https://docs.bailian.console.aliyun.com/zh/model-studio/cosyvoice-v3-5-flash)。这不等于 DramaClaw 对用户免费，也不推断内置预览的账单处理。网关设计请求使用 `voices=1` 的计费量，应核对实际渠道价格表达式和预览账单后制定 P4。浏览器重复播放本地候选不再产生模型调用。

百炼[限流表](https://help.aliyun.cn/zh/model-studio/rate-limit)给出 `voice-enrollment` 10 RPS，CosyVoice 3 RPS；模型卡以 180 RPM 表示合成限制。部署按实际账号配额与网关限额中更严格者执行。设计与复刻共享音色服务限流。上游自定义音色数量有上限，网关的 1 小时回收只减少占用，不提供用户配额保护。

绘梦公开目录查阅时标价为 0.017 元/秒，按 `original_duration` 计费。详情页说明提交校验钱包余额，完成后扣实际费用，失败不收费。其页面没有给出可据此承诺的固定 RPS；429 表示请求频率或模型并发超限。该价格与限制只适用于绘梦，不能套到百炼或网关账单。

候选服务的技术限制建议：每个可信请求者同时 1 次生成；共享凭据还需按渠道设置总限流，跨进程用现有 admission 或持久租约，不能仅靠 Python 进程内 semaphore。数值预算和每日额度留给 P4。runner 中的上游调用总超时建议 90 秒；浏览器提交仅等待入队，返回 202 后查询候选，不让现有 `api` 默认 30 秒超时决定模型创建是否重试。候选媒体限制 10 MiB，归一化后须为可解码 MP3、单声道 16 kHz、时长大于 0 且不超过 15 秒。超长返回错误并保留输入，不默认截断用户试听文本；是否增加裁剪候选交互见 P3。

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
| 虾画 `freezone/audio_node.py`、`api/routes/freezone.py` | 现有角色参考音频可继续读取保存结果。新增生成入口与“我的音色”保存属于 P2 的条件切片，不默认实施。 |

当前 `media_model_request_schema.py` 的通用端点白名单没有 `audio/voice-designs`。本方案通过专用音频适配器调用已存在的网关端点，不假装往该通用模型目录增加一个名字就能工作；若现有凭据发现必须经过该目录，S1 同时补端点类型及契约测试。

## 3. 前后端接口契约

以下是拟新增契约，现有上传接口保持不变。统一前缀 `/api/v1`。所有 ID 为不含路径分隔符的 UUID；所有字符串长度按 Unicode 字符计。

### 3.1 候选状态与存储

候选以 `(project_id, requester_id, candidate_id)` 隔离，`candidate_id` 取客户端本次生成的 `request_id`。先写入持久化操作记录，再入队，由 runner 调用网关。入队也以 candidate_id 排重；记录已落盘但尚未确认入队时，仅补投同一任务，不新建操作。同一个 request_id 和相同规范化请求只创建一次；相同 ID 换内容返回 409。真正的“重新生成”使用新 UUID，旧候选文件和回执不覆盖。

元数据存 `state_dir/voice-design/candidates.sqlite3`，媒体存 `runtime_dir/voice-design/{requester_id}/{candidate_id}.mp3`，不进入公开 static。状态为 `generating`、`ready`、`failed`、`unknown`、`expired`。只有文件写入并校验成功后才能转为 ready。数据库唯一约束和条件状态更新负责跨进程排重；worker 崩溃留下的 generating 在租约过期后转 unknown，不重新创建上游音色。

`ready` 的媒体不因保存而被移动或删除。保存回执独立记录 `(candidate_id, character, slot, save_request_id)`，防止保存成功后断线造成再次发布。候选 TTL 是 P1，必须由配置注入测试；开发夹具可用任意短 TTL，不能据此决定生产保留时间。网关的 1 小时句柄寿命与 DramaClaw 已归档候选的寿命无关。

### 3.2 生成与查询

```http
POST /api/v1/projects/{project}/voice-design/candidates
Content-Type: application/json
```

```json
{
	"request_id": "178727cd-e421-451c-87e7-68779d72a8ec",
	"description": "六十岁左右的男人，嗓子有点沙，说话慢",
	"preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
	"language": "zh"
}
```

必填 `request_id`、`description`、`preview_text`；`language` 默认 `zh`，枚举 `zh|en`。描述去首尾空白后 1～500 字符；试听文本去首尾空白后 15～200 字符。未知字段拒绝，模型由服务端配置；前端展示文本长度但不将模型 Key 暴露为表单项。

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

`slot` 为 `default|child|youth|middle|elder`，与上传一致。`expected_slot` 是用户开始保存时看到的完整插槽元数据，三字段必填，不能只比较 SHA。`replace_existing` 默认 false。空插槽保存是基础行为；已有插槽默认返回 409 `slot_occupied`。是否开放显式替换由 P3 决定，决策前 true 返回 409 `replacement_not_enabled`；若批准，前端先确认替换，服务端仍需校验 expected_slot。

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
| 409 | `idempotency_conflict`、`candidate_not_ready`、`slot_changed`、`slot_occupied`、`replacement_not_enabled` | 仅 candidate_not_ready 为 true；等待状态或刷新目标后由用户重新保存。 |
| 410 | `candidate_expired` | false；保留文本，可新建候选。 |
| 422 | `invalid_input`、`content_rejected`、`candidate_duration_exceeded` | false；details 标明字段或实际时长。 |
| 402 | `insufficient_credits` | false；不自动再次扣费。 |
| 429 | `rate_limited`、`voice_design_quota_exceeded` | true；返回有依据的 Retry-After，不自动重发创建。 |
| 502 / 504 | `provider_unavailable`、`provider_bad_audio` / `generation_unknown` | true；先查本地状态，再由用户发起新生成。 |
| 503 | `voice_design_unavailable` | false；缺配置或渠道不可用。 |
| 500 | `candidate_persist_failed`、`save_failed` | true；分别查询候选或用同 save_request_id 重试保存。 |

retryable 表示界面可提供重试入口，不授权 HTTP 客户端自动重发非幂等的模型创建请求。

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
uv run ruff check src/novelvideo/audio/voice_design_service.py src/novelvideo/audio/voice_design_storage.py src/novelvideo/api/routes/voice_design.py src/novelvideo/api/routes/characters.py src/novelvideo/seedance2_i2v/character_voice_storage.py
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

S0 先固定第 3 节契约，之后 S1、S2、S4 可按契约和 fixture 并行；S3 依赖 S2 的候选文件与回执接口，S5 汇合验收。这里描述开发分工，不在本次启动实现 agent。

| 切片 | 范围与依赖 | owns：会改的文件或目录 | 验证命令 |
| --- | --- | --- | --- |
| S0 契约 | 导出候选与保存请求的 OpenAPI schema、成功及失败 fixtures；不调用模型。依赖 P3 对已占用插槽的确认，未确认时使用明确拒绝替换的分支。 | 新增 `api/routes/voice_design.py` 中的边界模型、`tests/test_api_voice_design.py` 的契约 fixtures；本文。 | C2 的 schema 和错误体测试、C7。 |
| S1 网关适配 | 实现百炼设计、身份、凭据、计费预留及结果验证；不写正式声线。依赖 S0；测试不依赖线上 Key。 | 新增 `audio/voice_design_service.py`、`tests/test_voice_design_service.py`；修改 `task_backend/runners/audio.py` 注册 `voice_design`，按需修改 `task_backend/` 内 admission、任务类型与投递配置；扩充 `tests/test_task_backend_registry.py`；必要时改 `media_model_request_schema.py` 和对应测试。复用现有音频凭据函数。 | C1 服务测试，A01、A02、A05、A14、A16；`uv run pytest tests/test_task_backend_registry.py -q`；对改动 Python 路径运行 Ruff。 |
| S2 候选生命周期 | 实现独立候选存储、持久幂等、状态查询、鉴权试听及 TTL 清理。依赖 S0；TTL 测试注入。生产启用前依赖 P1、P4。 | 新增 `audio/voice_design_storage.py`、`tests/test_voice_design_storage.py`；扩充 `api/routes/voice_design.py`、`tests/test_api_voice_design.py`；修改 `api/__init__.py` 注册路由。 | C1 存储测试、C2 的 A03～A07、A13、A17。 |
| S3 正式保存 | 复用上传持久化与绑定，加入冲突比较、保存回执、回滚和恢复。依赖 S2，替换已有声线依赖 P3。 | `api/routes/characters.py`、`seedance2_i2v/character_voice_storage.py`、新增保存回执逻辑所在的 `audio/voice_design_storage.py`、`tests/test_api_character_voice_samples.py`、`tests/test_api_voice_design.py`、`tests/test_character_voice_storage.py`；`pyproject.toml`。 | C2 的 A08～A12、C3、C6。 |
| S4 现有声线管理 UI | 加描述、试听文本、生成、重新生成、试听及保存；保留输入和旧候选，处理错误码；用 fixtures 可先做。依赖 S0，联调依赖 S1～S3。 | `frontend/src/components/assets/character-voice-panel.tsx`，新增同目录 `voice-design-dialog.tsx`；新增 `frontend/src/lib/queries/voice-design.ts`；修改 `lib/queries/characters.ts`、`lib/query-keys.ts`、`frontend/src/types/` 中对应类型；相关 `__tests__`；`frontend/public/locales/` 文案。 | C4、C5；视觉实现前读 `DESIGN.md`。若改 token，同步文档并执行 `npx @google/design.md lint DESIGN.md`，0 errors。 |
| S5 联调与上线门槛 | 校验真实部署路由、单 Key 渠道、可信 subject、账单及预览交付；证明保存后现有 IndexTTS2 可以读取文件。不扩大到全量视频回归。依赖前述切片与 P1、P3、P4 拍板。 | 新增 `scripts/acceptance/voice_design.py`，更新本文的验收记录。脚本从环境读测试项目和凭据，报告只写请求 ID、候选 SHA、slot SHA 和脱敏账单。 | C1～C7；`uv run python scripts/acceptance/voice_design.py --project "$VOICE_DESIGN_TEST_PROJECT" --character "$VOICE_DESIGN_TEST_CHARACTER" --slot default`，非零表示未通过。 |
| S6 虾画复用，条件切片 | 仅在 P2 选择本期时执行。复用同一候选 API 与弹窗，增加“我的音色”或角色目标的保存适配；不能让用户重复生成来跨入口使用。 | `api/routes/freezone.py`、`freezone/audio_node.py`、对应 `frontend/src/features/canvas/` 入口及测试；`pyproject.toml`。不改身份绑定。 | 现有 `tests/test_freezone_audio_backend.py` 加候选保存测试；新增前端“同一 candidate_id 跨入口保存不再调用模型”测试；运行相关路径 Ruff、C5。若 P2 延后，不以此切片作为本期 PASS。 |

S3 修改 `characters.py` 时必须“顺手清 lint、删豁免行”：清理 E402，删除 `pyproject.toml` 中该文件的豁免键。S6 若修改 `freezone.py`，同样清理 F401 并删该豁免键。若实现必须修改 `generators/tts_generator.py`，清 F401、F541 并删除其豁免；不得为了增加一个导出包装而改它。其余新增触及文件也须先对照豁免表，不只检查这三项。

S3 的机械检查命令如下；S6 或触及 tts_generator 时扩充清单。

```sh
uv run ruff check --ignore-noqa --isolated --select E4,E7,E9,F src/novelvideo/api/routes/characters.py
python3 - <<'PY'
import pathlib
import tomllib
config = tomllib.loads(pathlib.Path("pyproject.toml").read_text())
ignores = config["tool"]["ruff"]["lint"]["per-file-ignores"]
assert "src/novelvideo/api/routes/characters.py" not in ignores
PY
```

职责边界：只在已有 `characters.py` 提取必须共享的上传和候选保存动作，不建立多供应商插件框架，不把模型调用塞进 `voice_clone.py`。S3 的新增恢复复杂度来自文件与数据库的跨资源发布，必须由 A11 证明，不能仅靠 try/except 后返回成功。

S5 脚本只写专用测试项目的空插槽，不替换生产声线。验证内容包括生成一次、播放两次不增加调用、保存一次、回读 SHA 和 resolver 结果。涉及真实模型费用和后续 IndexTTS2 合成的运行需使用已授权测试额度；本次文档任务不运行这些付费调用。

上线用默认关闭的能力配置控制新入口和新生成端点。关闭后仍允许在 TTL 内查询、试听和保存已存在候选；上传入口、历史绑定和已保存文件持续可用。回滚不删除新增候选目录或正式声线，不反向迁移历史数据。

## 8. 待人拍板的产品决策

这些问题不由本方案代定。S0～S4 可通过显式配置与 fixture 继续开发；涉及的正式上线行为必须有决策记录。

| ID | 待决定的问题 | 影响与未决时的边界 |
| --- | --- | --- |
| P1 | 未保存候选保留多久？退出弹窗、刷新、重新登录后是否可找回？最多保留多少个？ | 决定 TTL、历史列表及存储成本。当前接口有 expires_at，但不设定生产时长；跨刷新候选列表不默认为已承诺能力。网关一小时不能直接作为产品 TTL。 |
| P2 | 虾画复用本期完成，还是后补？首选保存到“我的音色”还是角色插槽？ | 决定 S6 和最终需求二的完成口径。后补时明确本期只完成角色管理入口与共享 API。 |
| P3 | 保存到已有插槽能否替换？需要什么确认？超长试听是要求缩短文本，还是开放候选裁剪？ | 决定 replace_existing 的启用和裁剪交互。未批准前已有插槽返回 slot_occupied，显式替换返回 replacement_not_enabled；超长返回明确错误，不静默截断。 |
| P4 | 用户按次数、字符或额度付费，还是平台承担？每天候选额度及渠道预算多少？是否开放英文？ | 决定价格展示、quota、预算及语言入口。技术契约可表达 zh/en，但不以此替产品决定首期语言范围。缺预算配置时禁止生产入口启用。 |
| P5 | 是否接受百炼作为首期供应商？Seed Audio 是否要求本期备选或作为首选？ | 推荐百炼是已有适配的技术结论。若选 Seed Audio，先完成独立网关音频任务切片和干净参考音频的验证，再重新核算依赖、成本和上线条件。 |

## 9. 本次方案交付与验证记录

本次只新增本文，不修改应用、模型配置或网关源码，不 push。提交前以实际工作区执行 `git diff --check`，检查本文的仓库内 Markdown 链接，并人工逐项核对需求八项、接口状态、PASS 与不变量对应关系。当前 HEAD 与网关远端 SHA 已记录在文首。

验证环境：macOS，本机 zsh，Python 3 标准库。针对文首 HEAD 加本文的交付状态，`git diff --no-index --check /dev/null docs/issue-891-voice-design-plan.md` 退出 0；Python 标准库检查的 5 个仓库内 Markdown 链接全部存在，7 段 JSON 示例全部能解析。方案自审已核对八项要求、接口状态与测试映射；复核时网关远端 main 仍为文首 SHA。

C1～C6 和 S5 是后续实现验收命令，本次未运行，不能据此宣称功能通过。最终提交 SHA 由 Git 提交结果报告，避免把尚未产生的提交写进文档。

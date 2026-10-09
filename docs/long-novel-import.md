# 长篇小说导入与文本请求预算

上传和导入接口按项目的 `knowledge_pipeline` 校验原文。字符数不包含空白字符。

| 项目流水线 | 上传文件上限 | 开始导入时的文件上限 | 正文字符上限 |
| --- | --- | --- | --- |
| `structured_v1` | 8 MiB | 8 MiB | 1,000,000 |
| 其他值或未设置 | 512 KiB | 1 MiB | 100,000 |

结构化流水线保留完整原文，并使用现有章节与文本块划分处理长篇内容。上述上限控制文件资源占用，不能证明某次模型请求可以容纳整本小说。部分后续步骤会汇总多个文本块的结果，因此还需要独立检查模型请求的上下文预算。

## 配置请求预算

网关模型别名不提供可靠的上下文窗口信息。部署者应先核实实际路由的每个文本模型，再设置 `NEWAPI_TEXT_CONTEXT_TOKENS`，其值不得高于任何可能被路由到的模型窗口。变量留空时关闭检查，保留现有部署行为。

```dotenv
# 仅为配置示例；65536 不是程序探测到的模型窗口。
NEWAPI_TEXT_CONTEXT_TOKENS=65536
NEWAPI_TEXT_OUTPUT_TOKENS=8192
```

该检查应用于 NewAPI 的 PydanticAI 文本客户端，包括普通请求和流式请求。每次发送前检查系统提示、用户内容、工具和输出 schema，以及校验重试积累的消息。输入以序列化内容的 UTF-8 字节数作为字节分词模型的保守 token 上界，并额外预留 1024 token 的封装空间。中文内容通常会被明显高估；这不是模型 tokenizer 的精确计数。

对于视觉请求，仅在预算估算副本中排除类型为 `image_url` 的图片 URL / Base64 传输编码，实际请求保留完整图片、尺寸与 detail 设置。文本中的 URL 或 Base64 字符串仍按文本计数。视觉 token 取决于实际路由模型的图像分块与分辨率策略，不能从编码字节数推导；此检查只约束文本与输出预算，不保证文本加视觉输入的总量一定符合模型窗口。多模态的完整窗口校验由模型服务执行，应结合实际 usage 配置文本预算以留出视觉空间。

默认输出预算为 8192 token，可通过 `NEWAPI_TEXT_OUTPUT_TOKENS` 调整。请求显式设置的 `max_tokens`，以及 `extra_body` 中的 `max_tokens` / `max_completion_tokens` 也计入预算。输入估算值加输出预算超过上下文预算时，在发起网络请求前报出 `MODEL_CONTEXT_BUDGET_EXCEEDED`。原文不会被截断；应减少该步骤的批次内容，或核实模型窗口后调整配置。

旧流水线中的 Cognee / Instructor / LiteLLM 请求不经过该客户端，因此继续采用原来的文件与字符上限。启用结构化长篇导入也不保证所有后续 AI 步骤自动完成；超出预算的汇总步骤仍需拆分。

## 回归验证

```bash
uv run pytest tests/test_api_ingest_chapter_preview.py tests/test_structured_ingest.py tests/test_structured_builders.py tests/test_upload_sanitization.py tests/test_api_asset_upload_offload.py tests/test_newapi_text_gateway.py tests/test_newapi_context_budget.py tests/test_transport_retry_disabled.py
```

覆盖结构化长文本完整保存、上传与开始导入的边界、旧流水线限制、原文件保护，以及包含 schema、重试历史和输出预算的请求校验。角色外观提取同时验证合并后已确认的 `evidence_text` 会进入提示词；外观缓存版本已更新，旧缓存不会继续复用缺少原文证据的结果。

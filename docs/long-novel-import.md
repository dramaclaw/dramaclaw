# 长篇小说导入

上传和导入接口按项目的 `knowledge_pipeline` 校验原文。字符数不包含空白字符。

| 项目流水线 | 上传文件上限 | 开始导入时的文件上限 | 正文字符上限 |
| --- | --- | --- | --- |
| `structured_v1` | 8 MiB | 8 MiB | 1,000,000 |
| 其他值或未设置 | 512 KiB | 1 MiB | 100,000 |

DOCX 在调用 python-docx 解析前检查 ZIP 中所有条目的解压后大小之和，超过 50 MiB 时拒绝。这一限制适用于所有流水线，与压缩文件大小和正文字数上限独立。超限上传不会替换已有文件。

结构化流水线保留完整原文，并使用现有章节与文本块划分处理长篇内容。上述上限控制文件资源占用，不代表模型能够一次处理整本小说，也不保证后续 AI 步骤自动完成。

## 外观证据修复

角色外观提取读取合并后已验证的 `evidence_text`，并兼容旧的 `quote` 字段。外观缓存版本升至 4，旧版本缓存不会再用于生成缺少原文证据的外观结果。已有非空外观字段仍按现有规则保留，不会自动覆盖用户编辑内容。

## 后续 AI 分析的限制

上下文预算检查已由 main 提供，不属于本次新增功能。`NEWAPI_TEXT_CONTEXT_TOKENS` 默认为空，预算检查默认关闭。长篇导入后，某些汇总步骤仍可能超过实际模型窗口并在网关侧失败；此前完成的分块提取可能已经产生调用费用。部署者应核实模型窗口并配置预算；预算检查不会自动拆分超限请求。

## 回归验证

```bash
uv run pytest tests/test_api_ingest_chapter_preview.py tests/test_structured_ingest.py tests/test_structured_builders.py tests/test_upload_sanitization.py tests/test_api_asset_upload_offload.py
```

覆盖长文本完整保存、上传和开始导入的边界、旧流水线限制、DOCX 总解压大小限制、原文件保护，以及角色外观提示词与证据缓存。

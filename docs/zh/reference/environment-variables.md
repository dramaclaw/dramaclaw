<!-- lang-switch -->
[English](../../en/reference/environment-variables.md) · **简体中文**

# 环境变量参考

> 配置通过项目根目录 `.env` 注入(从 `.env.example` 复制)。**`.env.example` 是权威全集且有逐项注释**;本篇按组归纳最常用的变量与默认值,便于查阅。

## 运行环境与路径

| 变量 | 默认 | 说明 |
|---|---|---|
| `ST_EDITION` | `ce`(compose/镜像强制) | 版本标识。CE 模式不可降级。 |
| `NOVELVIDEO_DATA_ROOT` | `.`(Docker 设为 `/data`) | 数据根目录,下面三项默认派生于此。 |
| `NOVELVIDEO_OUTPUT_DIR` | `$DATA_ROOT/output` | 成片与产物输出目录。注:`.env.example` 显式设为 `output`(相对路径),Docker 内会落到 `/app/output` 而非 `/data` 卷;要持久化到卷请设为 `/data/output` 或留空用默认。 |
| `NOVELVIDEO_STATE_DIR` | `$DATA_ROOT/state` | 本地状态。 |
| `NOVELVIDEO_RUNTIME_DIR` | `$DATA_ROOT/runtime` | 运行时临时目录。 |
| `ST_CONTROL_PLANE_DSN` / `ST_REDIS_URL` / `ST_CELERY_BROKER_URL` / `ST_CELERY_RESULT_BACKEND` | 空(CE 强制清空) | EE/分布式才用;CE 任务进程内 inline 执行,留空。 |

## 模型网关

CE 的渠道选择、网关地址和 token 由网页「设置 → 模型配置」写入本机
`settings.db`，不通过环境变量配置。官方渠道地址固定；本地渠道使用 CE
随附的 NewAPI。

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEWAPI_TEXT_TIMEOUT_SECONDS` | `120` | 文本模型 HTTP 超时(秒)。 |
| `NEWAPI_TEXT_TRUST_ENV` | `true` | 是否让文本客户端读系统代理;内网网关被代理拦截时设 `false`。 |

约 **30 个 `*_MODEL` 逻辑模型名**（如 `HERMES_MODEL=DC-hermes-LLM`）映射到网关后台的真实模型。本地 NewAPI 的映射在网页配置——详见[配置模型供应商](../getting-started/configuring-models.md)。

## 参考媒体 relay(可选)

| 变量 | 说明 |
|---|---|
| `OSS_RELAY_AK` / `OSS_RELAY_SK` | 参考图功能所需的对象存储凭据。纯文本→成片流程可不配。 |
| `OSS_RELAY_ENDPOINT` / `OSS_RELAY_BUCKET` | relay 端点与桶。 |

## 视频 / 图像参数

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIDEO_FPS` | `30` | 帧率。 |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` | `1080` / `1920` | 竖屏分辨率。 |
| `VIDEO_CODEC` | `libx264` | 视频编码(H.264);ffmpeg build 须含此编码器,见 [ffmpeg 指南](../guides/ffmpeg.md)。 |
| `VIDEO_AUDIO_CODEC` | `aac` | 音频编码。 |
| `VIDEO_BITRATE` | `4M` | 码率。 |
| `IMAGE_DEFAULT_WIDTH` / `IMAGE_DEFAULT_HEIGHT` / `IMAGE_DEFAULT_STYLE` | `1440` / `2560` / `chinese_period_drama` | 图像默认尺寸与风格。 |

## 媒体工具

| 变量 | 默认 | 说明 |
|---|---|---|
| `FFMPEG_PATH` | `ffmpeg`(从 PATH) | ffmpeg 可执行路径,装在非标准位置时显式指定。 |

## 安全

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROMPT_EXPORT_PASSWORD` | `change_me` | 提示词导出口令,**部署务必覆盖**。 |
| `ST_COOKIE_SECURE` | `true` | 管理 Cookie 是否 Secure。本机 HTTP 开发需设 `0`,否则浏览器丢弃 cookie。 |

## 版本更新通知

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELEASE_NOTIFICATIONS_ENABLED` | `true` | 设为 `false` 可完全关闭 release feed,包括包内 notes 解析与 GitHub 检查。 |
| `RELEASE_NOTIFICATIONS_GITHUB_TOKEN` | 空 | 可选 GitHub token,用于提高 `releases/latest` 限流额度;留空走匿名请求。 |

## 可观测追踪(可选,默认关闭)

| 变量 | 说明 |
|---|---|
| `NOVELVIDEO_ENABLE_LOGFIRE` | 打开 PydanticAI 追踪埋点。 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 导出 trace 到你自己的 OTLP/Jaeger。 |
| `LOGFIRE_TOKEN` | 唯一会把数据发往 Logfire SaaS 的开关。 |

详见 [遥测说明](../guides/telemetry.md)。默认三者都不设,不发送任何数据。

## 相关

- 完整列表与注释:仓库根 `.env.example`
- [快速开始](../getting-started/quickstart.md) ｜ [配置模型供应商](../getting-started/configuring-models.md) ｜ [自托管手册](../guides/self-hosting.md)

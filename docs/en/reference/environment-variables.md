<!-- lang-switch -->
**English** · [简体中文](../../zh/reference/environment-variables.md)

# Environment Variables Reference

> Configuration is injected through a `.env` file in the project root (copied from `.env.example`). **`.env.example` is the authoritative, complete set with per-item comments**; this page groups the most commonly used variables and their defaults by category for quick reference.

## Runtime Environment and Paths

| Variable | Default | Description |
|---|---|---|
| `ST_EDITION` | `ce` (forced by compose/image) | Edition identifier. CE mode cannot be downgraded. |
| `NOVELVIDEO_DATA_ROOT` | `.` (set to `/data` under Docker) | Data root directory; the three items below derive from it by default. |
| `NOVELVIDEO_OUTPUT_DIR` | `$DATA_ROOT/output` | Output directory for finished videos and artifacts. Note: `.env.example` sets it explicitly to `output` (a relative path), which inside Docker lands at `/app/output` rather than the `/data` volume; to persist to the volume, set it to `/data/output` or leave it empty to use the default. |
| `NOVELVIDEO_STATE_DIR` | `$DATA_ROOT/state` | Local state. |
| `NOVELVIDEO_RUNTIME_DIR` | `$DATA_ROOT/runtime` | Runtime temporary directory. |
| `ST_CONTROL_PLANE_DSN` / `ST_REDIS_URL` / `ST_CELERY_BROKER_URL` / `ST_CELERY_RESULT_BACKEND` | Empty (forced empty in CE) | Used only by EE/distributed; CE runs tasks inline in-process, so leave empty. |

## Model Gateway

In CE, the selected channel, gateway address, and token are written by
**Settings → Model Configuration** to the local `settings.db`; they are not
configured through environment variables. The official channel has a fixed
address, while the local channel uses the NewAPI bundled with CE.

| Variable | Default | Description |
|---|---|---|
| `NEWAPI_TEXT_TIMEOUT_SECONDS` | `120` | HTTP timeout for text models (seconds). |
| `NEWAPI_TEXT_TRUST_ENV` | `true` | Whether the text client reads the system proxy; set `false` when an internal gateway is being blocked by a proxy. |

About **30 `*_MODEL` logical model names** (e.g. `HERMES_MODEL=DC-hermes-LLM`) map to real upstream models. Configure Local NewAPI mappings in the web UI—see [Configuring Model Providers](../getting-started/configuring-models.md).

## Reference Media Relay (optional)

| Variable | Description |
|---|---|
| `OSS_RELAY_AK` / `OSS_RELAY_SK` | Object storage credentials required by the reference-image feature. A pure-text → video flow can skip these. |
| `OSS_RELAY_ENDPOINT` / `OSS_RELAY_BUCKET` | Relay endpoint and bucket. |

## Video / Image Parameters

| Variable | Default | Description |
|---|---|---|
| `VIDEO_FPS` | `30` | Frame rate. |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` | `1080` / `1920` | Portrait resolution. |
| `VIDEO_CODEC` | `libx264` | Video codec (H.264); the ffmpeg build must include this encoder, see the [ffmpeg guide](../guides/ffmpeg.md). |
| `VIDEO_AUDIO_CODEC` | `aac` | Audio codec. |
| `VIDEO_BITRATE` | `4M` | Bitrate. |
| `IMAGE_DEFAULT_WIDTH` / `IMAGE_DEFAULT_HEIGHT` / `IMAGE_DEFAULT_STYLE` | `1440` / `2560` / `chinese_period_drama` | Default image dimensions and style. |

## Media Tools

| Variable | Default | Description |
|---|---|---|
| `FFMPEG_PATH` | `ffmpeg` (from PATH) | Path to the ffmpeg executable; specify explicitly when installed in a non-standard location. |

## Security

| Variable | Default | Description |
|---|---|---|
| `PROMPT_EXPORT_PASSWORD` | `change_me` | Prompt-export password; **always override it for deployment**. |
| `ST_COOKIE_SECURE` | `true` | Whether the admin cookie is Secure. Local HTTP development needs `0`, otherwise the browser drops the cookie. |

## Release Notifications

| Variable | Default | Description |
|---|---|---|
| `RELEASE_NOTIFICATIONS_ENABLED` | `true` | Set `false` to fully disable the release feed, including packaged notes parsing and GitHub checks. |
| `RELEASE_NOTIFICATIONS_GITHUB_TOKEN` | Empty | Optional GitHub token for a higher `releases/latest` rate limit. Anonymous requests are used when empty. |

## Observability Tracing (optional, off by default)

| Variable | Description |
|---|---|
| `NOVELVIDEO_ENABLE_LOGFIRE` | Enables PydanticAI tracing instrumentation. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Export traces to your own OTLP/Jaeger. |
| `LOGFIRE_TOKEN` | The only switch that sends data to the Logfire SaaS. |

See the [telemetry notes](../guides/telemetry.md) for details. By default none of the three are set, and no data is sent.

## Related

- Full list with comments: `.env.example` in the repo root
- [Quickstart](../getting-started/quickstart.md) ｜ [Configuring Model Providers](../getting-started/configuring-models.md) ｜ [Self-Hosting Manual](../guides/self-hosting.md)

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

## Model Gateway (default official RelayClaw)

| Variable | Default | Description |
|---|---|---|
| `NEWAPI_BASE_URL` | `https://relayclaw.cdnfg.com/v1` | The default official gateway (RelayClaw). For BYO, change it to your own gateway, keeping the trailing `/v1`. |
| `NEWAPI_API_KEY` | Empty | DC key / gateway token. Recommended to paste it on the web page under "Model Config → Official Channel," or fill it in here. Get a DC key at <https://relayclaw.cdnfg.com>. |
| `MODEL_GATEWAY_MODE` | `official` | `official` uses the NEWAPI_* values above; `custom` uses the self-configured gateway written by the frontend into local SQLite. |
| `MODEL_API_KEY` | `your_model_api_key` | Key for the general text model (read by the OpenAI-compatible adapter). |
| `NEWAPI_TEXT_TIMEOUT_SECONDS` | `120` | HTTP timeout for text models (seconds). |
| `NEWAPI_TEXT_TRUST_ENV` | `true` | Whether the text client reads the system proxy; set `false` when an internal gateway is being blocked by a proxy. |

About **30 `*_MODEL` logical model names** (e.g. `HERMES_MODEL=DC-hermes-LLM`) map to the real models behind the gateway. A BYO gateway must provide models under the same names or rename each one — see [Configuring Model Providers](../getting-started/configuring-models.md).

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

## Episode Soundtrack (optional, off by default)

Optional post-compose step: the assembled episode is sent to a soundtrack model, which generates one original track that runs through the whole episode with automatically matched length, laid over or replacing the native audio.

| Variable | Default | Description |
|---|---|---|
| `EPISODE_SOUNDTRACK_PROVIDER` | Empty (off) | Set to `sonilo` to enable Sonilo video-to-music. |
| `SONILO_API_KEY` | Empty | User-supplied Sonilo API key. The step is skipped automatically when unset. Output is licensed and safe for commercial use (terms apply). |
| `EPISODE_SOUNDTRACK_MODE` | `mix` | `mix` lays the lowered soundtrack over the native audio, keeping native dialogue/SFX; `replace` swaps the audio track entirely, for dialogue-free content. |
| `EPISODE_SOUNDTRACK_MUSIC_VOLUME` | `0.35` | Soundtrack volume factor (0-1) in `mix` mode. |
| `EPISODE_SOUNDTRACK_PROMPT` | Empty | Optional style hint passed through to the soundtrack model. |
| `SONILO_API_BASE_URL` / `SONILO_TIMEOUT_SECONDS` | `https://api.sonilo.com` / `600` | API endpoint and HTTP timeout in seconds; normally no need to change. |

Note: the soundtrack endpoint currently supports episodes up to 6 minutes — longer ones are logged and skipped. A failed generation keeps the original audio and never fails the compose task.

## Episode Sound Effects (optional, off by default)

Optional post-compose step: the assembled episode is sent to a sound-effects model, which generates royalty-free sound effects (SFX only, provider terms apply) from the video, matching what happens on screen. The lowered SFX track is laid over the native audio; there is no replace mode — the native per-clip audio carries dialogue, and replacing it would drop the dialogue too.

| Variable | Default | Description |
|---|---|---|
| `EPISODE_SFX_PROVIDER` | Empty (off) | Set to `sonilo` to enable Sonilo video-to-sfx. Reuses `SONILO_API_KEY` / `SONILO_API_BASE_URL` / `SONILO_TIMEOUT_SECONDS` from the section above; the step is skipped automatically when the key is unset. |
| `EPISODE_SFX_VOLUME` | `0.5` | SFX volume factor (0-1) when laid over the native audio. |
| `EPISODE_SFX_PROMPT` | Empty | Optional style hint passed through to the SFX model. |

Note: the SFX endpoint currently supports episodes up to 3 minutes — a tighter cap than the soundtrack endpoint's 6 minutes, so an episode between 3 and 6 minutes still gets a soundtrack but skips SFX. Longer episodes are logged and skipped; a failed generation keeps the original audio and never fails the compose task.

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

<!-- lang-switch -->
**English** · [简体中文](../../zh/guides/troubleshooting.md)

# Troubleshooting

> Common failures and how to diagnose them when self-hosting DramaClaw CE. Check the logs first: `docker compose logs -f api`, or the terminal output of `novelvideo api` during local development.

## Startup

| Symptom | Diagnosis |
|---|---|
| **Container won't start / exits immediately** | Check `docker compose logs api` and follow the startup error to the configuration, port, or data-volume problem. |
| **Port `8780` already in use** | Change the left-hand value of `ports` in compose, e.g. `8888:8780`; or stop the process holding it (`lsof -i :8780`). |
| **Health check stays unhealthy** | The probe hits `/api/v1/config`; if the API itself errors, check the startup logs to pinpoint the real exception. |
| **Local dev won't start: Python version** | Requires **3.11–3.12** (`>=3.11,<3.13`). Run `uv python pin 3.12` or install the matching version, then `uv sync`. |

## Model / gateway

| Symptom | Diagnosis |
|---|---|
| **Every model call errors** | Under Settings → Model Configuration, confirm the active channel is configured. Check the DC key for the official channel, or the service, runtime token, and upstream channels for Local NewAPI. |
| **A stage reports "model does not exist"** | Local NewAPI is missing the corresponding logical model mapping, or the target channel is disabled. See [Configuring model providers](../getting-started/configuring-models.md). |
| **Text model times out** | Increase `NEWAPI_TEXT_TIMEOUT_SECONDS` (default 120); if a system proxy is intercepting an internal gateway, set `NEWAPI_TEXT_TRUST_ENV=false`. |
| **Reference-image feature unavailable** | Requires `OSS_RELAY_AK/SK`; the plain text→video pipeline can run without it. |

## Media / ffmpeg

| Symptom | Diagnosis |
|---|---|
| **Compositing stage reports ffmpeg not found** | Local development requires installing ffmpeg yourself (Docker bundles it); or point to a path with `FFMPEG_PATH`. See the [ffmpeg guide](ffmpeg.md). |
| **Compositing fails with encoder unavailable** | The default codec is `libx264` (H.264), which your ffmpeg build must include; or change `VIDEO_CODEC`. |
| **Output is black / duration is wrong** | Usually upstream image/audio artifacts are missing; review the logs of preceding stages to confirm the assets were generated. |

## Data / upgrades

| Symptom | Diagnosis |
|---|---|
| **Data gone after a rebuild** | Data lives in the named volume `ce-data` (`/data` inside the container). `docker compose down` keeps the volume—**do not add `-v`** (it deletes the volume). For backups see the [self-hosting handbook](self-hosting.md#5-where-the-data-lives--backups). |
| **Config error after an upgrade** | Currently built from source: after `git pull`, run `docker compose up -d --build`; compare against the new `.env.example` and add any newly introduced variables. |

## world features (3DGS/SHARP)

| Symptom | Diagnosis |
|---|---|
| **`FileNotFoundError` pointing at `BuilderGPT/...`** | These heavyweight feature scripts are not in the slim CE package; the plain text→video pipeline doesn't need them. They're only required for the 3D/voxel pipeline. |
| **`uv sync --extra world` install fails** | Use uv (not pip) so the dependency overrides take effect; GPU acceleration needs a CUDA environment, while slim/CPU environments only support the CPU path. |

## Still stuck?

- Usage / ideas → [GitHub Discussions](https://github.com/dramaclaw/dramaclaw/discussions)
- Confirmed a bug → [File a bug](https://github.com/dramaclaw/dramaclaw/issues/new?template=bug_report.yml) (attach logs, reproduction steps, environment)
- Security issue → do not use a public issue; see [SECURITY](../../../SECURITY.md)

## Related

- [Installation guide](../getting-started/installation.md) ｜ [Quickstart](../getting-started/quickstart.md) ｜ [Self-hosting handbook](self-hosting.md)

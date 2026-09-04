<!-- lang-switch -->
**English** · [简体中文](../../zh/getting-started/installation.md)

# Installation Guide

> Set up the runtime environment for DramaClaw CE on macOS / Windows / Linux. If you just want the fastest path to running it, go straight to [Quickstart](quickstart.md); this guide covers per-platform prerequisites and the two installation methods (Docker and local development).

DramaClaw CE is a single-machine service that needs **no PostgreSQL / Redis**. Docker brings up `api` + the bundled `newapi` gateway + `web`; models are served through the DramaClaw official gateway RelayClaw by default, or through the bundled gateway once you switch to Custom mode in Settings. Nothing runs models on your machine, so an ordinary machine is enough.

## Pick one of two installation methods

| Method | Best for | Prerequisites |
|---|---|---|
| **Docker (recommended)** | Deployment, trials, production self-hosting | Just Docker; ffmpeg and friends are in the image |
| **Local development (uv)** | Editing code, debugging | Python 3.11–3.12, uv, ffmpeg (installed yourself) |

> ffmpeg/ffprobe are **system dependencies**; CE does not distribute their binaries (see [ADR-0002](../../adr/0002-ffmpeg-system-dependency.md) for the reasoning). The Docker image already bundles them; for local development you install them yourself — see the [ffmpeg guide](../guides/ffmpeg.md).

---

## A. Docker (recommended)

Prerequisites: Docker + `docker compose`.

| Platform | Install |
|---|---|
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (works on both Apple Silicon and Intel) |
| **Windows** | Docker Desktop with the **WSL2** backend enabled (Settings → General → Use WSL2) |
| **Linux** | Docker Engine + `docker-compose-plugin` (from your distro's package manager) — Docker Compose **≥ 2.24** (`docker compose version`; the compose file uses the `env_file` long syntax) |

Once installed:

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
git clone https://github.com/dramaclaw/dramaclaw-gateway.git   # bundled gateway, built from ../dramaclaw-gateway
cd dramaclaw
cp .env.example .env        # at minimum, change PROMPT_EXPORT_PASSWORD to a non-default value
docker compose up -d --build    # builds api, web and the gateway from the two checkouts
# no build? docker compose -f docker-compose.release.yml up -d   # pulls published images, no gateway clone needed
```

After it's up, open **`http://localhost:8080`** in your browser (the app UI); the REST API is at `http://localhost:8780`. Go to Settings → Model Configuration → Official Channel, paste your DC key, save, and you're ready. For the full walkthrough see [Quickstart](quickstart.md); for start/stop/backup see the [Self-Hosting Handbook](../guides/self-hosting.md).

> Windows users should clone and run inside the **WSL2 terminal** (keep it on the Linux filesystem, not under `/mnt/c/...`) to avoid volume-mount performance and line-ending issues.

---

## B. Local development (uv + Python 3.11–3.12)

### 1. Install prerequisites

| Platform | Python 3.11/3.12 | uv | ffmpeg |
|---|---|---|---|
| **macOS** | `brew install python@3.12` | `brew install uv` | `brew install ffmpeg` |
| **Windows** | [python.org](https://www.python.org/downloads/) or `winget install Python.Python.3.12` | `winget install astral-sh.uv` | `winget install Gyan.FFmpeg` (or use WSL2 and follow the Linux flow) |
| **Linux (Debian/Ubuntu)** | `apt install python3.12` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `apt install ffmpeg` |

> Python must be in the **3.11–3.12** range (`requires-python = ">=3.11,<3.13"`). uv pins dependency versions according to `uv.lock`.

### 2. Install dependencies and start

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

uv sync                                  # install dependencies into .venv per uv.lock
cp .env.example .env && $EDITOR .env     # set the gateway and key

uv run novelvideo api --host 0.0.0.0 --port 8780
```

CE defaults to `ST_EDITION=ce`, no-login single local user, and in-process inline task execution (no Ray/Redis/Celery).

### 3. Verify

```bash
curl http://localhost:8780/api/v1/config   # a 200 response means it's working
```

---

## Optional: world features (3DGS / SHARP depth)

Heavy features such as voxel/panorama-to-3D live in the optional `world` extra; they **require a GPU and an extra toolchain** and are not installed by default:

```bash
uv sync --extra world                       # installs torch / ml-sharp / da2 and others
npm install -g @playcanvas/splat-transform  # PLY→SOG compression tool
```

Docker: `INSTALL_WORLD=1 docker compose up -d --build`. The slim base is CPU-only; GPU acceleration needs a CUDA base + nvidia runtime. Model weights are downloaded automatically at runtime, not baked into the image.

> If you're not doing any 3D/voxel workflows, you can ignore this section; plain text→finished video doesn't need it.

---

## Next steps

- Get your first result working: [Quickstart](quickstart.md)
- Connect your own model gateway: [Configuring Model Providers](configuring-models.md)
- Install/verify ffmpeg: [ffmpeg guide](../guides/ffmpeg.md)
- Running into problems: [Troubleshooting](../guides/troubleshooting.md)

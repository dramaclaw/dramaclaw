<!-- lang-switch -->
**English** · [简体中文](../../zh/getting-started/installation.md)

# Installation Guide

> Set up the runtime environment for DramaClaw CE on macOS / Windows / Linux. If you just want the fastest path to running it, go straight to [Quickstart](quickstart.md); this guide covers per-platform prerequisites and the two installation methods (Docker and local development).

DramaClaw CE is a single-machine service that needs **no PostgreSQL / Redis**. Docker brings up `api` + the bundled `newapi` gateway + `web`; models are served through the DramaClaw official gateway RelayClaw by default, or through the bundled gateway once you switch to Custom mode in Settings. Nothing runs models on your machine, so an ordinary machine is enough.

## Pick one of two installation methods

| Method | Best for | Prerequisites |
|---|---|---|
| **Docker (recommended)** | Deployment, trials, production self-hosting | Just Docker; ffmpeg and friends are in the image |
| **Local development (uv)** | Editing code, debugging | Python 3.11–3.12, uv, Node.js/pnpm, ffmpeg (installed yourself) |

> ffmpeg/ffprobe are **system dependencies**; CE does not distribute their binaries (see [ADR-0002](../../adr/0002-ffmpeg-system-dependency.md) for the reasoning). The Docker image already bundles them; for local development you install them yourself — see the [ffmpeg guide](../guides/ffmpeg.md).

---

## A. Docker (recommended)

Prerequisites: Docker + `docker compose`.

| Platform | Install |
|---|---|
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (works on both Apple Silicon and Intel) |
| **Windows** | Docker Desktop with the **WSL2** backend enabled (Settings → General → Use WSL2) |
| **Linux** | Docker Engine + `docker-compose-plugin` (from your distro's package manager) — Docker Compose **≥ 2.24** (`docker compose version`; the compose file uses the `env_file` long syntax) |

Once installed, choose **published images** or a **source build**. For published
v2.1.1 images, no gateway checkout is needed; follow [Quickstart option A](quickstart.md)
to pin `DRAMACLAW_VERSION=2.1.1` and `DRAMACLAW_GATEWAY_VERSION=v1.0.0-rc.24-dramaclaw.3`.

To build your local code instead:

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
git clone https://github.com/dramaclaw/dramaclaw-gateway.git   # bundled gateway, built from ../dramaclaw-gateway
cd dramaclaw
cp .env.example .env        # at minimum, change PROMPT_EXPORT_PASSWORD to a non-default value
docker compose up -d --build    # builds api, web and the gateway from the two checkouts
```

Source Docker is not hot-reloading. After changes, rebuild with
`docker compose up -d --build api web` (or `newapi` for gateway-only changes).

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

The frontend also needs Node.js and pnpm; use the pnpm version declared in
`frontend/package.json`. Python alone only provides the API, not the Vite dev server.

The Agent uses Codex. `scripts/start-ce.sh` downloads the public **credential-safe
DramaClaw Codex 0.164.0** build matching your host: macOS Apple Silicon/Intel or
Linux x64/ARM64. No private repository access is needed. The first download is about
250–310 MB and requires curl plus `shasum` (macOS) or `sha256sum` (Linux).
The launcher checks the pinned SHA256 before execution, checks the version, and reuses
the verified cache under `runtime/codex/bin/` on subsequent starts. Custom storage roots
(`NOVELVIDEO_RUNTIME_DIR` / `NOVELVIDEO_DATA_ROOT`) are respected.
Windows native startup is not supported by this launcher; use WSL2 or Docker.

### 2. Install dependencies and start

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

cp .env.example .env && $EDITOR .env     # change PROMPT_EXPORT_PASSWORD; configure the model channel/key in the UI

scripts/start-ce.sh
```

Open `http://localhost:5173` for the Vite development UI; the API is at
`http://localhost:8780`. The launcher installs dependencies and starts both services;
Ctrl+C stops them. Keep `DRAMACLAW_CHAT_BACKEND=codex` in `.env`; an older setting
selecting another backend produces an actionable error rather than a silent fallback.

To manage the API and frontend separately, prepare the same runtime before starting
the API (the standalone setup command reads exported variables, not `.env`):

```bash
uv sync --group dev
CODEX_BIN="$(bash scripts/setup-codex.sh)" &&
  CODEX_BIN="$CODEX_BIN" DRAMACLAW_CHAT_BACKEND=codex \
    uv run --no-sync novelvideo api --host 127.0.0.1 --port 8780
```

In a second terminal, from the repository root:

```bash
cd frontend && pnpm install && pnpm dev --host 127.0.0.1 --port 5173
```

To skip downloading, set `CODEX_BIN=/absolute/path/to/codex-dramaclaw` in `.env`
for the launcher, or export it before the standalone setup command. An explicit binary
is operator-managed: the script checks that it runs, but cannot prove it contains the
credential-safety patches. Do not use the stock Codex CLI. A download/checksum failure
stops startup before either service is launched and never falls back to another backend.

Docker builds at v2.1.1 already include credential-safe Codex 0.164.0. Both source and
release Compose select Codex by default; keep `DRAMACLAW_CHAT_BACKEND=codex` if setting
it explicitly. `CODEX_BIN` in the native instructions above is a host-side path, not a
container path.
CE defaults to `ST_EDITION=ce`, no-login single local user, and in-process inline task execution
(no Ray/Redis/Celery).

### 3. Verify

```bash
curl http://localhost:8780/api/v1/config   # a 200 response means it's working
```

### 4. Gateway (only for Custom / Local + Official Hybrid mode)

Official mode needs nothing else. For the other two modes the API expects a gateway on `127.0.0.1:3000` (the `NEWAPI_ADMIN_BASE_URL` default in `.env`) whose SQLite file is `./state/newapi/one-api.db`, which is what **Initialize** in Settings writes to. Run the published image with that directory mounted:

```bash
mkdir -p state/newapi
docker run -d --name dramaclaw-gateway -p 127.0.0.1:3000:3000 \
  -v "$PWD/state/newapi:/data" \
  claymorelab/dramaclaw-gateway:v1.0.0-rc.24-dramaclaw.3
```

or build and run the gateway from the sibling `dramaclaw-gateway` checkout with `SQLITE_PATH` pointing at that file. See [Configuring Models](configuring-models.md) for the mode setup.

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

<!-- lang-switch -->
**English** · [简体中文](../../zh/getting-started/quickstart.md)

# Quickstart

> Run DramaClaw locally and produce your first result.

DramaClaw is the Community Edition (CE): it runs on a single machine with no PostgreSQL / Redis required. By default `docker compose` brings up three services: `api` (the creation backend, :8780), `newapi` (the bundled gateway, idle until you switch to Custom or Local + Official Hybrid mode), and `web` (the browser UI, :8080). Models are served through the **DramaClaw official gateway (RelayClaw)** by default — paste in a DC key and you're ready to go.

## Prerequisites

- Docker (Desktop or Engine) with `docker compose` support.
- A **DC key** — sign up / purchase at <https://relayclaw.cdnfg.com>; alternatively use the local NewAPI bundled with CE.

## Option A: Published v2.1.3 images (no build)

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw
cp .env.example .env
```

Edit `.env`: change `PROMPT_EXPORT_PASSWORD` to a non-default value and add or update:

```dotenv
DRAMACLAW_VERSION=2.1.3
DRAMACLAW_GATEWAY_VERSION=v1.0.0-rc.24-dramaclaw.3
```

The release Compose file defaults to the bundled credential-safe Codex 0.164.0 Agent.
If your shell or `.env` already selects another backend, set `DRAMACLAW_CHAT_BACKEND=codex`.
This choice does not change your Official/Custom/Hybrid model gateway mode.

```bash
docker compose -f docker-compose.release.yml config --images
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml ps
```

These versions are also the Compose defaults; explicit pins make upgrades predictable.
This mode needs no gateway checkout and no `--build`.

## Option B: Build your local source with Docker

```bash
# 1. Get the code — DramaClaw and the bundled gateway, side by side
git clone https://github.com/dramaclaw/dramaclaw.git
git clone https://github.com/dramaclaw/dramaclaw-gateway.git
cd dramaclaw

# 2. Prepare configuration
cp .env.example .env
#    Open .env and at minimum change PROMPT_EXPORT_PASSWORD to a non-default value.
#    Configure the model channel and key in the web UI, not in .env.

# 3. Start — brings up api / newapi / web
docker compose up -d --build   # builds api, web (this checkout) and the gateway (../dramaclaw-gateway) from source

# 4. Confirm it's up
docker compose ps   # api, newapi, and web should all be running
```

Source Compose defaults to Codex. Builds use the code in your local checkouts, not the
`DRAMACLAW_VERSION` image tag. Code changes require rebuilding; this is not hot reload:

```bash
docker compose up -d --build api web
# If only the gateway changed: docker compose up -d --build newapi
```

For host-side Python/Vite development with hot reload, see the
[installation guide](installation.md#b-local-development-uv--python-311312).

## Enter your DC key (one-time, required)

1. Open **`http://localhost:8080`** in your browser — this is the DramaClaw UI.
2. Go to Settings → **Model Configuration → Official Channel**. The gateway address is already prefilled as `https://relayclaw.cdnfg.com/v1`.
3. **Paste your DC key** and click "Save and Enable". It works immediately, with **no model mapping required** (RelayClaw has everything configured on the backend).

> CE defaults to no-login, single local user (`ST_EDITION=ce`, enforced by compose). The REST API lives at `http://localhost:8780` (the browser only talks to `web`, which reverse-proxies to `api`).

## Want to use your own model channels?

The bundled NewAPI starts together with `docker compose up -d`. Initialize it and configure upstream keys and model mappings under Settings → Model Configuration → Custom. Its address and runtime token are stored in local `settings.db`, not `.env`. See [Configuring Model Providers](configuring-models.md).

## Next steps

- Full deployment/upgrade/backup: [Self-Hosting Handbook](../guides/self-hosting.md)
- Connect your own models: [Configuring Model Providers](configuring-models.md)

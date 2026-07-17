<!-- lang-switch -->
**English** · [简体中文](../../zh/getting-started/quickstart.md)

# Quickstart

> Run DramaClaw locally and produce your first result.

DramaClaw is the Community Edition (CE): it runs on a single machine with no PostgreSQL / Redis required. By default `docker compose` brings up two services: `api` (the creation backend, :8780) and `web` (the browser UI, :8080). Models are served through the **DramaClaw official gateway (RelayClaw)** — paste in a DC key and you're ready to go.

## Prerequisites

- Docker (Desktop or Engine) with `docker compose` support.
- A **DC key** — sign up / purchase at <https://relayclaw.cdnfg.com>; alternatively use the local NewAPI bundled with CE.

## Steps

```bash
# 1. Get the code (the current version builds the image from source; later releases will pull a published image)
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

# 2. Prepare configuration
cp .env.example .env
#    Open .env and at minimum change PROMPT_EXPORT_PASSWORD to a non-default value.
#    Configure the model channel and key in the web UI, not in .env.

# 3. Start (the first run builds the image, so it's a bit slow) — brings up the api / web services
docker compose up -d --build

# 4. Confirm it's up
docker compose ps   # both api and web should be running
```

## Enter your DC key (one-time, required)

1. Open **`http://localhost:8080`** in your browser — this is the DramaClaw UI.
2. Go to Settings → **Model Configuration → Official Channel**. The gateway address is already prefilled as `https://relayclaw.cdnfg.com/v1`.
3. **Paste your DC key** and click "Save and Enable". It works immediately, with **no model mapping required** (RelayClaw has everything configured on the backend).

> CE defaults to no-login, single local user (`ST_EDITION=ce`, enforced by compose). The REST API lives at `http://localhost:8780` (the browser only talks to `web`, which reverse-proxies to `api`).

## Want to use your own model channels?

Start the local NewAPI bundled with CE via `docker-compose.selfhosted.yml`, then initialize it and configure upstream keys and model mappings under Settings → Model Configuration → Local NewAPI. Its address and runtime token are stored in local `settings.db`, not `.env`. See [Configuring Model Providers](configuring-models.md).

## Next steps

- Full deployment/upgrade/backup: [Self-Hosting Handbook](../guides/self-hosting.md)
- Connect your own models: [Configuring Model Providers](configuring-models.md)

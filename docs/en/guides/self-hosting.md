<!-- lang-switch -->
**English** · [简体中文](../../zh/guides/self-hosting.md)

# Self-Hosting Handbook (Docker)

> Deploy, configure, upgrade, and back up DramaClaw CE with Docker.

CE ships three containers: `api` + `newapi` (the bundled DramaClaw gateway, idle until you switch to Custom or Local + Official Hybrid mode) + `web`, with **no PostgreSQL / no Redis / no Celery** (`ST_EDITION=ce`; tasks run inline within the process). Models go through the official DramaClaw gateway by default.

Two compose files ship in the repo: `docker-compose.yml` builds all three services from source (the default entry point — `docker compose up -d --build`), and `docker-compose.release.yml` only pulls published images (`docker compose -f docker-compose.release.yml up -d`). `docker-compose.yml` extends `docker-compose.release.yml` for the shared runtime definition (env / ports / volumes / healthchecks) and only adds `build:` plus local image names.

## 1. Prerequisites

- Docker + `docker compose`.
- Docker Compose ≥ 2.24 (`docker compose version`).
- Resources: ≥ 2 vCPU / 4GB recommended (excluding model inference, which runs through an external gateway).
- A DC key (the default official gateway is RelayClaw, see <https://relayclaw.cdnfg.com>), or your own OpenAI-compatible gateway.

## 2. Get the compose file and configuration

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw
cp .env.example .env
```

Two files, already set for you, no changes needed:

| File | Mode | Command |
|---|---|---|
| `docker-compose.yml` | Source build (default) — builds `api`, `web`, and the bundled gateway from the checkout / git `main` | `docker compose up -d --build` |
| `docker-compose.release.yml` | Image only — pulls published images, never builds | `docker compose -f docker-compose.release.yml up -d` |

Key points shared by both (defined once in `docker-compose.release.yml`, reused by `docker-compose.yml` via `extends`):

| Item | Value | Notes |
|---|---|---|
| Services | `api` + `newapi` + `web` | No PG/Redis; `newapi` is the bundled gateway |
| Images (release) | `${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/...` | Pulled from Docker Hub; set `DRAMACLAW_IMAGE_PREFIX` in `.env` to use the ACR mirror (pinned tags only) |
| Versions (release) | `DRAMACLAW_VERSION` (api/web), `DRAMACLAW_GATEWAY_VERSION` | Defaults: `2.0.2` / the gateway tag baked into the file |
| Port | `8780:8780` | REST API |
| Gateway admin port | `${ST_NEWAPI_BIND:-127.0.0.1}:${ST_NEWAPI_PORT:-3000}:3000` | Bound to `127.0.0.1` by default; set `ST_NEWAPI_BIND=0.0.0.0` in `.env` to widen it |
| Enforced environment | `ST_EDITION=ce`, control-plane/Redis/Celery cleared | CE mode cannot be downgraded |
| Data volume | `ce-data:/data` (output at `/data/output`) | Persists project databases, settings, and generated media |

## 3. Configure `.env`

> ⚠️ **Secret-type defaults (such as `PROMPT_EXPORT_PASSWORD=change_me`) must be changed.** For the model gateway, see [Model Configuration](#model-configuration).

Groups (each item is commented inline in `.env.example`): local NewAPI provisioner, reference-media OSS relay (OSS_RELAY_*), Cognee knowledge graph, text/image/video/audio models, image and video base parameters, UI, and output directories. Channel selection, gateway address, and token are saved from the web UI to `settings.db`.

### Model Configuration

Recommended and alternative options (see [Configuring Model Providers](../getting-started/configuring-models.md) for details):

- **A. DC official key (recommended)**: the default compose already uses the official gateway. After bringing the stack up, open `http://localhost:8080` → Settings → Model Configuration → Official Channel → paste your DC key and save to start using it, **no model mapping required**. Get a key at <https://relayclaw.cdnfg.com>.
- **B. Local NewAPI**: the bundled gateway is already running; open Settings → Model Configuration → Custom, click Initialize, then configure upstream channels and model mappings from the Local NewAPI page.

Local NewAPI must map DramaClaw's logical models to real upstream models. The reference-image feature needs `OSS_RELAY_AK/SK` (you can skip it for a text-only workflow).

## 4. Start / Stop

```bash
docker compose up -d --build                              # source build: start (builds on first run)
docker compose -f docker-compose.release.yml up -d         # image mode: start (pulls images on first run)
docker compose ps                                          # status
docker compose logs -f api                                 # logs
docker compose down                                        # stop (keeps the data volume)
```

## 5. Where the data lives / Backup, restore & migrate

- Project databases, settings, and generated media live in the named volume `ce-data` (`/data` inside the container); generated media is written to `/data/output`. Removing or rebuilding a container keeps this volume. Only an explicit `docker compose down -v` removes it.
- Back up the data volume:

```bash
docker run --rm -v dramaclaw-ce_ce-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/ce-data-backup.tar.gz -C /data .
```

(The volume name is prefixed with the compose project name; run `docker volume ls` to confirm the actual name.)

- Restore, or move to a new machine — copy `ce-data-backup.tar.gz` to the target host, then unpack it back into the data volume (the `-v` mount creates the volume if it does not exist yet):

```bash
docker run --rm -v dramaclaw-ce_ce-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/ce-data-backup.tar.gz -C /data
```

Then bring the stack up as usual (`docker compose up -d`). The volume backup already includes generated media; back up `.env` separately.

- The `newapi-data` volume holds the bundled gateway's SQLite database (upstream channels, keys, tokens) and is not regenerable — back it up the same way:

```bash
docker run --rm -v dramaclaw-ce_newapi-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/newapi-data.tgz -C /data .
```

Restore it the same way, into the target volume:

```bash
docker run --rm -v dramaclaw-ce_newapi-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/newapi-data.tgz -C /data
```

## 6. Upgrades

Source build:

```bash
git pull
# edit .env: DRAMACLAW_VERSION=2.1.0 (and DRAMACLAW_GATEWAY_VERSION if the release notes say so)
docker compose up -d --build
```

`docker compose up -d --build` also re-fetches and rebuilds the bundled gateway from `dramaclaw-gateway` git (Go + bun, several minutes). When only DramaClaw code changed, rebuild just the two local services: `docker compose up -d --build api web`.

Image mode:

```bash
# edit .env: DRAMACLAW_VERSION=2.1.0 (and DRAMACLAW_GATEWAY_VERSION if the release notes say so)
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
```

Your `.env` is never touched by the upgrade. The `ce-data` and `newapi-data` volumes are reused.

The `DRAMACLAW_VERSION` / `DRAMACLAW_GATEWAY_VERSION` defaults baked into `docker-compose.release.yml` are kept current automatically: CI opens a PR bumping them after every CE release and whenever the bundled gateway fork publishes a new release, so pulling `main` picks up the latest defaults even if your `.env` sets nothing.

If an older release wrote media to `/app/output` inside the container, run the one-time migration **before** starting the new version (zip users: download `scripts/migrate_docker_output.py` from GitHub instead of `git pull`):

```bash
git pull
docker compose exec -T api python - < scripts/migrate_docker_output.py
docker compose up -d
```

On Windows PowerShell:

```powershell
git pull
Get-Content scripts/migrate_docker_output.py -Raw | docker compose exec -T api python -
docker compose up -d
```

The script copies only missing files, never overwrites or deletes the source, and backs up `projects.db` before updating project paths. Files that existed only in an already-removed container layer cannot be recovered from the data volume.

### Upgrading from a previous checkout

`docker-compose.selfhosted.yml` and `docker-compose.selfhosted.release.yml` have been removed. Use the two files above instead — service names and the `ce-data` / `newapi-data` volumes are unchanged, so existing data carries over as-is.

| Before | Now |
|---|---|
| `docker compose up -d --build` (official gateway, source build) | Same command; now also builds the bundled gateway (defaults to host-only, idle until used) |
| `docker compose -f docker-compose.release.yml up -d` | Same command; the gateway image is now `claymorelab/dramaclaw-gateway` |
| `docker compose -f docker-compose.selfhosted.yml up -d --build` | Use `docker compose up -d --build` instead; the `newapi-data` volume is reused — back it up first (rc.21 → rc.24 only adds tables) |
| `docker compose -f docker-compose.selfhosted.release.yml up -d` | Use `docker compose -f docker-compose.release.yml up -d` instead; same as above |
| `.env`'s `NEWAPI_BASE_URL` / `NEWAPI_API_KEY` / `ST_*_PORT` / `INSTALL_WORLD` / `NEWAPI_PROVISIONER_ENABLED` | Unchanged, still effective |

## 7. Troubleshooting

| Symptom | What to check |
|---|---|
| Container won't start | `docker compose logs api`; usually the `.env` gateway address/key was not changed or is unreachable |
| Port 8780 already in use | Change the left-hand value of `ports` in compose, e.g. `8888:8780` |
| Port 3000 already in use (bundled gateway fails to start) | Set `ST_NEWAPI_PORT=<free port>` in `.env` and start the stack again. Note the gateway port is bound to `127.0.0.1` by default; `api` no longer waits on the gateway's health, so this does not block `api`. |
| Model call errors | Confirm the gateway is reachable and that the `*_MODEL` names exist in the gateway backend |

## Related

- [Quickstart](../getting-started/quickstart.md) ｜ [Configuring Model Providers](../getting-started/configuring-models.md)

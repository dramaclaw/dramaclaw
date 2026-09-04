<!-- lang-switch -->
**English** · [简体中文](../../zh/guides/self-hosting.md)

# Self-Hosting Handbook (Docker)

> Deploy, configure, upgrade, and back up DramaClaw CE with Docker.

CE ships three containers: `api` + `newapi` (the bundled DramaClaw gateway, idle until you switch to Custom or Local + Official Hybrid mode) + `web`, with **no PostgreSQL / no Redis / no Celery** (`ST_EDITION=ce`; tasks run inline within the process). Models go through the official DramaClaw gateway by default.

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

Key points in `docker-compose.yml` (already set for you, no changes needed):

| Item | Value | Notes |
|---|---|---|
| Services | `api` + `newapi` + `web` | No PG/Redis; `newapi` is the bundled gateway |
| Images | `${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/...` | Pulled from Docker Hub; set `DRAMACLAW_IMAGE_PREFIX` in `.env` to use the ACR mirror (pinned tags only) |
| Versions | `DRAMACLAW_VERSION` (api/web), `DRAMACLAW_GATEWAY_VERSION` | Defaults: `latest` / the gateway tag baked into the file |
| Port | `8780:8780` | REST API |
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
docker compose up -d             # start (pulls images on first run)
docker compose ps                # status
docker compose logs -f api       # logs
docker compose down              # stop (keeps the data volume)
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

The compose file only pulls published images, so upgrading is a version bump:

```bash
# edit .env: DRAMACLAW_VERSION=2.1.0 (and DRAMACLAW_GATEWAY_VERSION if the release notes say so)
docker compose pull
docker compose up -d
```

Your `.env` is never touched by the upgrade. The `ce-data` and `newapi-data` volumes are reused. Users of the old `docker-compose.selfhosted*.yml` stacks: back up `newapi-data` first — the gateway image jumps several versions and migrates its SQLite schema on first start.

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

Building from source instead? Add the build override: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build` (set `DRAMACLAW_VERSION=dev` in `.env` first).

## 7. Troubleshooting

| Symptom | What to check |
|---|---|
| Container won't start | `docker compose logs api`; usually the `.env` gateway address/key was not changed or is unreachable |
| Port 8780 already in use | Change the left-hand value of `ports` in compose, e.g. `8888:8780` |
| Port 3000 already in use (bundled gateway fails, `api` waits on it) | Set `ST_NEWAPI_PORT=<free port>` in `.env` and `docker compose up -d` again |
| Model call errors | Confirm the gateway is reachable and that the `*_MODEL` names exist in the gateway backend |

## Related

- [Quickstart](../getting-started/quickstart.md) ｜ [Configuring Model Providers](../getting-started/configuring-models.md)

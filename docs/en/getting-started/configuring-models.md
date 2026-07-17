<!-- lang-switch -->
**English** · [简体中文](../../zh/getting-started/configuring-models.md)

# Configuring Model Providers

> Configure the official RelayClaw channel or the local NewAPI bundled with CE.

DramaClaw CE connects text, image, video, audio, and embedding models through an OpenAI-compatible NewAPI gateway. Channel selection, gateway address, and runtime token are saved from the web UI to local `settings.db`; CE does not read them from environment variables.

## A. DC official key (recommended, simplest)

The default `docker-compose.yml` already routes models through the "Official Channel". After `docker compose up -d --build` is running:

1. Open **`http://localhost:8080`** in your browser and go to Settings → **Model Configuration → Official Channel**.
2. The official gateway address is fixed as `https://relayclaw.cdnfg.com/v1`; **paste your DC key** and click "Save and Enable".
3. It works immediately — RelayClaw has all of DramaClaw's logical models configured on its backend, so **no `*_MODEL` mapping is required**.

> Don't have a DC key yet? Sign up / purchase at **<https://relayclaw.cdnfg.com>**.

## B. Local NewAPI

Fully local with no dependency on an external gateway: use the selfhosted orchestration, which additionally brings up a built-in `newapi` container:

```bash
docker compose -f docker-compose.selfhosted.yml up -d --build
```

On first start, open Settings → Model Configuration → Local NewAPI. The initialization flow creates the administrator and runtime token, then stores the runtime address and token in `settings.db`. Configure upstream channels and model mappings on the same page. See the [Self-Hosting Handbook](../guides/self-hosting.md) for details.

### Mapping logical model names

`.env.example` has roughly 30 `*_MODEL` entries that use logical names (e.g. `HERMES_MODEL=DC-hermes-LLM`, `SCENE_BUILD_MODEL=DC-scene-builder-LLM`). Two ways to handle them:

1. **Keep the logical names and map them to real upstream models in Local NewAPI** (recommended); or
2. **Change each `*_MODEL` to a model name your gateway actually provides.**

Grouped by purpose: text (Hermes/Cognee/the various planners/normalizers, etc.), image (`NEWAPI_IMAGE_MODEL`, `NEWAPI_NANOBANANA2_MODEL` and the various `*_IMAGE_*`), video (`VIDEO_BACKEND`, `NEWAPI_VIDEO_MODELS`…), audio (`INDEXTTS2_NEWAPI_MODEL`).

> When using a DC official key, skip this section — RelayClaw already has everything configured.

After changing the key or channel, new clients use the new settings. Hermes rotates its worker automatically. If Cognee has already initialized in the current process, restart DramaClaw before using the novel knowledge base again.

### Reference media (optional)

If you use "upload reference image", you need to configure an OSS relay (`OSS_RELAY_ENDPOINT/BUCKET/AK/SK`); plain-text workflows can leave it unconfigured for now.

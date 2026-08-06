<!-- lang-switch -->
**English** · [简体中文](../../zh/getting-started/configuring-models.md)

# Configuring Models

DramaClaw CE uses a NewAPI-compatible gateway for text, vision, embedding, image, video, and audio models. Model settings are stored in the local CE `settings.db`. Secrets are never returned to the browser; only masked saved-state previews are shown.

After startup, open `http://localhost:8080` and go to **Settings → Models & Channels**. The “Active” badge at the top shows the actual runtime mode, not merely the tab currently being viewed.

## Choose a gateway mode

| Mode | Use case | What you configure |
|---|---|---|
| Official | Use the models provided by RelayClaw | DC Key only |
| Custom | Route every model through your NewAPI configuration | NewAPI initialization, providers, feature models, embedding, and media models |
| Local + Official Hybrid | Keep official models, but override matching official video models with Local ComfyUI | Official DC Key, Local NewAPI, ComfyUI URL, and workflows |

Enable the intended mode after configuring it. New jobs read the latest mode, key, and mappings. Jobs already running do not switch gateways midway.

## Official mode

Official mode is the shortest setup path:

1. Open **Official**.
2. Enter your RelayClaw DC Key.
3. Click **Save & Enable**.

DramaClaw manages the official gateway URL. RelayClaw already provides the `DC-*-LLM`, `DC-cognee-embedding`, and official media model mappings, so CE-side upstream mappings are unnecessary.

The official image/video list and its resolutions, aspect ratios, durations, and reference-media capabilities come from the bundled `src/novelvideo/official_media_models.json`.

To obtain a DC Key, visit <https://relayclaw.cdnfg.com>.

## Custom mode

### 1. Start the local stack

Use the repository’s self-hosted stack:

```bash
docker compose -f docker-compose.selfhosted.yml up -d --build
```

It starts the DramaClaw API, web frontend, and bundled NewAPI. DramaClaw normally reaches NewAPI through the container network. The browser-facing host port may differ and does not need to replace the internal URL.

The repository compose file enables the setup and channel-management features required by the settings UI. CE uses `${NOVELVIDEO_STATE_DIR}/newapi/one-api.db`; normally you do not enter a SQLite path or DSN manually.

### 2. Initialize Local NewAPI

Open **Custom**. When it shows “Initialization required”:

1. Set and confirm a root account password of at least eight characters for a fresh NewAPI instance.
2. Click **Initialize Local NewAPI**.

Initialization:

- Creates the first NewAPI root account only for a fresh instance.
- Creates or reuses the `dramaclaw-ce-runtime` token.
- Stores the runtime URL and token in CE local settings.
- Verifies the SQLite database and management access.

DramaClaw does not store the root password. Keep it for signing in to NewAPI. Entering a password for an already initialized instance does not reset the existing password.

### 3. Apply the recommended profile

After initialization, start with **Recommended**. One profile configures:

- Provider channels and upstream keys.
- DramaClaw feature-model mappings.
- Cognee embedding model, dimensions, and batch size.
- Image, video, and audio model mappings.

Enter each provider key separately, then click **Save & Apply All**. Keys are stored separately and never written into profile JSON. Leave an already saved key blank; entering a new value replaces it.

The built-in recommended profile is read-only. Switch to **My Config** to edit and persist your own JSON. The main shape is:

```json
{
  "version": 2,
  "name": "My CE profile",
  "channels": [
    {
      "id": "openrouter",
      "provider": "openrouter",
      "baseUrl": "",
      "priority": 0,
      "settings": {}
    }
  ],
  "featureModels": {
    "text": {"channel": "openrouter", "model": "upstream-text-model"},
    "vision": {"channel": "openrouter", "model": "upstream-vision-model"},
    "overrides": {}
  },
  "embedding": {
    "channel": "openrouter",
    "model": "upstream-embedding-model",
    "dimension": 1024,
    "batchSize": 10
  },
  "mediaModels": {
    "my-video-model": {
      "channel": "openrouter",
      "model": "upstream-video-model",
      "mediaType": "video",
      "label": "My Video Model",
      "enabled": true,
      "sortOrder": 100,
      "config": {}
    }
  }
}
```

Each `channel` references a `channels[].id`. A profile currently supports only one entry per `provider`. Changes in Recommended or My Config are reflected in Advanced Settings. Saving Advanced Settings updates My Config, so there are not two competing configurations. The recommended profile does not include ComfyUI. To use ComfyUI in Custom mode, add its channel, workflows, and media models through Advanced Settings.

### 4. Advanced Settings

Use Advanced Settings to adjust individual results after applying a profile.

#### Provider channels

Provider types are loaded dynamically from the current NewAPI `/api/channel/types` endpoint. Each provider can be added once.

- **Save Channels** stores CE’s local channel presets.
- **Update NewAPI Channel** immediately replaces the matching NewAPI channel key and Base URL.
- **Base URL Override** is normally empty. Set it only for a custom proxy or when required by the provider.

After a profile is saved, a channel key should show “Saved” and a masked preview. Password dots without a “Saved” badge indicate an uncommitted browser draft.

#### Feature models

DramaClaw uses stable logical names such as `DC-scene-builder-LLM` and `DC-freezone-vision-LLM`. In Custom mode, keep those internal names and map them to real upstream models in NewAPI.

- Text features can use text-only models.
- Vision features send images or video and require a suitable multimodal model.
- Bulk fill changes drafts only; click Save Mapping afterward.
- Hermes may use a separate model. Other `DC-*-LLM` mappings can share one upstream model or be overridden individually.

#### Embedding

`DC-cognee-embedding` powers the novel knowledge graph and semantic retrieval. Configure:

- The upstream embedding model.
- Its output dimensions.
- Batch size, defaulting to 10.

The model and dimensions are bound when a project is created. Later changes automatically affect only new projects. Clear and rebuild the graph before changing these values for an existing project.

For embedding HTTP 400/422 errors, verify the model supports the configured dimensions and that batch size does not exceed the upstream `input` limit.

#### Image, video, and audio models

Media model configuration controls:

- Whether the model appears in XiaHua.
- Label and ordering.
- The upstream model sent to NewAPI.
- Resolution, aspect-ratio, image-quality, and duration controls.
- Text-to-video, first frame, first/last frame, image reference, all-reference, and video-edit modes.
- Reference image/video/audio limits.
- Human-review control visibility.
- Model-specific request parameters.

Built-in mainline models provide the default capability baseline and cannot be removed from the configuration. My Config may add image or video models and edit custom-model capabilities. Save the complete configuration and refresh XiaHua to load the latest catalog and controls.

The **Model ID** is DramaClaw’s stable identifier. **Upstream Model** is the actual model used by the NewAPI channel; the two may differ.

### 5. ComfyUI Configuration

In **Custom** mode, add ComfyUI through **Advanced Settings → Provider Channels**. In **Local + Official Hybrid**, use the separate **ComfyUI Configuration** section, which includes MiniMax H3 starter workflows. Both modes use the same Local NewAPI and SQLite data.

Each ComfyUI model needs:

- The model ID used by DramaClaw.
- The ComfyUI service URL; the local default is `http://127.0.0.1:8188`.
- A ComfyUI **API Format Workflow** JSON export, not the browser workflow JSON.
- Matching media capabilities, including modes, ratios, resolutions, durations, and reference-media limits.

A normal local ComfyUI instance does not require an API key, so leave it empty. Authentication is relevant only when ComfyUI is placed behind an authenticated proxy.

## Local + Official Hybrid mode

Hybrid mode keeps RelayClaw while generating selected video models through Local ComfyUI:

1. Save the DC Key under **Official**.
2. Initialize NewAPI once under **Custom**; the same SQLite database is reused.
3. Open **Local + Official Hybrid**.
4. Open the separate **ComfyUI Configuration** section and confirm or change the service URL; the local default is `http://127.0.0.1:8188`.
5. Use the MiniMax H3 starter workflows provided by Hybrid mode, or enter a local video model ID and paste a ComfyUI **API Format Workflow** JSON export.
6. Save video configuration and enable Hybrid mode.

The ComfyUI API key is optional. Workflows must use API Format, not the browser workflow format. Custom and Hybrid modes share the ComfyUI channel, workflows, and media capabilities; saving them in either mode updates the same configuration.

Routing is based on model ID. A local video model overrides an official model with the same ID; all other models continue through RelayClaw. DramaClaw does not automatically fall back to the official model after a local failure. The user chooses whether to retry or switch models. Hybrid mode manages local video overrides only, so it does not require OpenRouter, VolcEngine, or other official upstream provider settings.

## Reference media storage

Image editing, video first/last frames, reference images, and identity images require upstream services to read local files. Go to **Settings → Media Storage** and configure a publicly reachable temporary media relay.

### Aliyun OSS

Provide a Bucket and an AccessKey with read/write permission for that Bucket. A narrowly scoped RAM sub-account is recommended.

| UI field | Environment variable | Example or notes |
|---|---|---|
| Endpoint | `OSS_RELAY_ENDPOINT` | `oss-cn-chengdu.aliyuncs.com`, without `https://` |
| Bucket | `OSS_RELAY_BUCKET` | Temporary-media Bucket |
| AccessKey ID | `OSS_RELAY_AK` | Bucket-scoped AK |
| AccessKey Secret | `OSS_RELAY_SK` | Matching SK |
| TTL | `MEDIA_RELAY_TTL_SECONDS` | Default: 1800 seconds |

The Bucket does not need public-read access. DramaClaw generates temporary signed URLs for upstream access.

### Cloudinary

Enter Cloud name, API Key, API Secret, and an optional folder. Find them under **Product environment settings → API Keys** in Cloudinary. Saved database settings take precedence over environment variables, and full secrets are never returned to the frontend.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No “Saved” badge after saving a key | The value may still be a browser draft. Save/update that channel or reapply the complete profile, and ensure the running image contains the latest code. |
| Adding a media model says its provider key is missing | The provider channel was not persisted to NewAPI. Save/update the channel before saving media models. |
| NewAPI reports `No available channel for model ...` | Check the logical mapping, channel status, upstream model name, and group. |
| Local NewAPI initialization fails | Check the NewAPI service, SQLite mount, directory permissions, and `NEWAPI_PROVISIONER_ENABLED`. |
| A new model is absent from XiaHua | Verify it is enabled, has the correct media type, the complete configuration was saved, and the page was refreshed. |
| Controls do not match model capabilities | Check the media model `config`, especially resolutions, ratios, modes, and reference limits. |
| Knowledge-graph embedding fails | Check the key, upstream model, dimensions, and batch size. HTTP 429 means upstream rate limiting. |
| Reference media cannot be read | Verify media storage and that the upstream service can reach the temporary public URL. |
| Hybrid local video fails without official fallback | Expected: Hybrid mode has no automatic failure fallback. |
| ComfyUI cannot connect to `127.0.0.1:8188` | `127.0.0.1` means the environment running the DramaClaw backend. For containers or remote deployments, use a host or LAN address reachable from that backend. |
| A MiniMax H3 workflow reports missing nodes or models | Install the custom nodes and model files referenced by the recommended workflow, then adjust the workflow for local filenames and versions. |

## Related files

- `src/novelvideo/official_media_models.json`: CE official media models and capabilities.
- `.env.example`: environment variable reference.
- `docker-compose.yml`: official-mode deployment.
- `docker-compose.selfhosted.yml`: bundled NewAPI deployment.
- [Self-Hosting Handbook](../guides/self-hosting.md)
- [Environment Variable Reference](../reference/environment-variables.md)

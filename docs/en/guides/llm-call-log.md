# LLM call log (dev-only)

Records the full input and output of every model call — text, image, audio, video
and embedding — in a self-hosted [Langfuse](https://langfuse.com), including the
images, audio and video themselves. It is **off by default** and meant for local
debugging: prompts, reference images and generated media are stored verbatim.

## How it works

`LLM_CALL_LOG_ENABLED=1` makes `novelvideo/__init__.py` call
`novelvideo.llm_call_log.install()`, which wraps `httpx.Client/AsyncClient.send` and
`aiohttp.ClientSession._request` in that process. Every model SDK the app uses
(openai, pydantic-ai, litellm, google-genai) and every direct HTTP generator
(images, TTS, video) sits on one of those two clients, so no call site changes.
API workers and the per-task subprocesses each install it on import.

A request is logged when its path looks like a model endpoint (`/chat/completions`,
`/images/*`, `/audio/*`, `/embeddings`, `/video*/generations`,
`/contents/generations/tasks`, Gemini `:generateContent`, …) or its host is listed in
`LLM_CALL_LOG_EXTRA_HOSTS`. Each call becomes one Langfuse observation carrying the
model, request, response, token usage, latency, provider request id and the
project/user/resource kind from `llm_instrumentation`. Authorization headers are never
recorded and keys such as `api_key`/`token`/`secret` are masked in bodies.

Binary payloads (data URIs, `b64_json`, Gemini `inlineData`, multipart reference
images, `audio/*` or `image/*` response bodies) are lifted out into Langfuse media so
the UI renders and plays them. Two results never appear in a response body, so the
code reports them explicitly through `llm_call_log.record_artifact(...)`: downloaded
video files (`utils/media_download.py`) and Gemini WebAI images
(`_download_webai_artifact`).

## Setup

1. Generate secrets and add them, plus the app-side settings, to `.env`:

   ```bash
   openssl rand -base64 32   # LANGFUSE_NEXTAUTH_SECRET, LANGFUSE_SALT
   openssl rand -hex 32      # LANGFUSE_ENCRYPTION_KEY
   ```

   ```dotenv
   LLM_CALL_LOG_ENABLED=1
   LANGFUSE_HOST=http://host.docker.internal:3100   # http://localhost:3100 if the api runs on the host
   LANGFUSE_PUBLIC_KEY=pk-lf-dramaclaw-dev
   LANGFUSE_SECRET_KEY=<any long random string>
   LANGFUSE_INIT_USER_PASSWORD=<login password>
   ```

2. Start Langfuse (UI at <http://localhost:3100>, login `admin@dramaclaw.local`):

   ```bash
   docker compose -f docker-compose.langfuse.yml --env-file .env up -d
   ```

   The project and its API keys are created on first boot from the same
   `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`.

3. Give the api the `langfuse` package. It is intentionally not a project dependency
   (it pulls a newer `opentelemetry-api` than the lockfile pins):

   ```bash
   pip install langfuse            # native install
   docker compose -f docker-compose.release.yml exec api pip install langfuse
   ```

4. Restart so the new env is read. `env_file` is only read when a container is created,
   so with the prebuilt image use `docker compose -f docker-compose.release.yml up -d`
   and re-sync `src/novelvideo` into the container as described in
   `.claude/CLAUDE.md`, then `docker restart`.

Media is uploaded by the SDK to MinIO through presigned URLs and played back by your
browser from the same URL, so that host must resolve in both places. The default
`http://host.docker.internal:9090` works for the container; if the browser cannot
resolve it, add `127.0.0.1 host.docker.internal` to `/etc/hosts` (or set
`LANGFUSE_MEDIA_ENDPOINT`).

## Retention

- `minio-retention` in the compose file sets a lifecycle rule that expires stored
  media and event blobs after `LLM_LOG_RETENTION_DAYS` (default 14).
- Trace rows are pruned by `python scripts/llm_call_log_cleanup.py --days 14`
  (`--dry-run` to preview); run it from cron.

## Known gaps

- **Streaming responses** are logged with the request only; the body is not buffered.
- **Not HTTP-interceptable:** edge-tts and the DashScope CosyVoice SDK (websocket/own
  transport), and the Hermes/Codex chat worker, which is a separate program.
- **aiohttp** responses are captured only when JSON; binary downloads are not.
- Large media beyond `LLM_CALL_LOG_MAX_MEDIA_MB` (default 64) is replaced by a size note.

## Troubleshooting

- Nothing appears: check `docker compose logs api` for `LLM call log enabled`; a
  warning instead means `LANGFUSE_*` is missing or `langfuse` is not installed.
- Text appears but images show broken: the browser cannot reach the media endpoint
  (see the hosts note above).
- Calls fail after enabling: set `LLM_CALL_LOG_ENABLED=` (empty) and restart; the hook
  swallows its own errors, so please report the traceback.

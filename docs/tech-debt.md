# Tech debt

Known gaps we chose not to close yet. Add an entry when you ship something with a
deliberate hole; remove it when the hole is closed.

## LLM call log (`src/novelvideo/llm_call_log/`, guide: `docs/en/guides/llm-call-log.md`)

The log is a process-wide httpx/aiohttp interception, so anything outside those two
clients, or anything whose body is not buffered, is not recorded.

| # | Gap | Why it is not covered | Possible direction |
|---|---|---|---|
| 1 | Streaming responses log the request only | Hooks never read a `stream=True` httpx body, to avoid consuming it and to keep memory bounded | Wrap the response stream to tee chunks into a size-capped buffer and finish the observation on close; or log at the SDK layer (pydantic-ai `request_stream`) |
| 2 | edge-tts and DashScope CosyVoice (`generators/tts_generator.py`) | They use a websocket / the vendor SDK's own transport, not httpx or aiohttp `_request` | Add explicit `record_artifact("audio", ...)` plus a request note at the two call sites; or patch `aiohttp.ClientSession.ws_connect` |
| 3 | Hermes/Codex chat worker | A separate program started with `NEWAPI_BASE_URL`; it never imports `novelvideo`, so no hook runs in it | Capture on the gateway side (NewAPI request logging), or point the worker at a small logging reverse proxy |
| 4 | aiohttp responses are read only when JSON | Reading a binary body would consume the stream that `utils/media_download.py` and others iterate | Rely on `record_artifact` for known downloads; extend it to the other aiohttp media paths in `generators/video_generator.py` |

Related, not a gap in coverage: `langfuse` is not a declared dependency because it
raises `opentelemetry-api` from the locked 1.42.1 to 1.45.1. Revisit as an optional
extra once that bump is validated against the rest of the stack.

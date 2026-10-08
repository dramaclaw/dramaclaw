"""Local, update-safe OpenAI-compatible router for a command-line CE install.

The private model catalog owns provider selection for SiliconFlow, Ark Agent
Plan, and local ComfyUI. Embedding and audio keep their configured routes.  Secrets
and copied workflow files live in a user-managed, ignored configuration
directory so upgrading DramaClaw does not replace them.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import anyio
import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from novelvideo.local_model_catalog import ARK_BASE, LocalModelCatalog, read_key
from novelvideo.local_provider_api import cloud_image, cloud_video_submit, cloud_video_status


logger = logging.getLogger("dramaclaw.local_gateway")

# 上游出错时记多少正文。够看清错误信息，又不至于把一整个响应刷进日志。
_UPSTREAM_ERROR_BODY_CHARS = 500

DEFAULT_CONFIG_DIR = Path.home() / ".config" / "dramaclaw-local"
SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"
DEFAULT_TEXT_MODEL = "deepseek-ai/DeepSeek-V4-Flash"
DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3"
DEFAULT_TTS_MODEL = "FunAudioLLM/CosyVoice2-0.5B"
QWEN_IMAGE_MODEL = "Qwen-Image-local"
KREA_IMAGE_MODEL = "Krea-2-Turbo-local"
KREA_IDENTITY_EDIT_MODEL = "Krea-2-Identity-Edit-local"


@dataclass(frozen=True)
class RouterConfig:
    root: Path
    host: str
    port: int
    comfy_url: str
    siliconflow_base_url: str
    text_model: str
    embedding_model: str
    tts_model: str

    @property
    def secrets_dir(self) -> Path:
        return self.root / "secrets"

    @property
    def workflows_dir(self) -> Path:
        return self.root / "workflows"

    @property
    def siliconflow_key_file(self) -> Path:
        return self.secrets_dir / "siliconflow.key"

    @property
    def router_token_file(self) -> Path:
        return self.secrets_dir / "router.token"

    @property
    def qwen_t2i_workflow(self) -> Path:
        return self.workflows_dir / "qwen_image_t2i_api.json"

    @property
    def qwen_edit_workflow(self) -> Path:
        return self.workflows_dir / "qwen_image_edit_api.json"

    @property
    def krea_t2i_workflow(self) -> Path:
        return self.workflows_dir / "krea2_turbo_t2i_api.json"

    @property
    def krea_edit_workflow(self) -> Path:
        return self.workflows_dir / "krea2_turbo_edit_api.json"

    @property
    def krea_identity_edit_workflow(self) -> Path:
        return self.workflows_dir / "krea2_identity_edit_api.json"

    @property
    def public_base_url(self) -> str:
        return os.environ.get(
            "DRAMACLAW_LOCAL_GATEWAY_PUBLIC_URL",
            f"http://{self.host}:{self.port}",
        ).rstrip("/")


def router_config() -> RouterConfig:
    root = Path(
        os.environ.get("DRAMACLAW_LOCAL_CONFIG_DIR", str(DEFAULT_CONFIG_DIR))
    ).expanduser()
    return RouterConfig(
        root=root,
        host=os.environ.get("DRAMACLAW_LOCAL_GATEWAY_HOST", "127.0.0.1"),
        port=int(os.environ.get("DRAMACLAW_LOCAL_GATEWAY_PORT", "3001")),
        comfy_url=os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip(
            "/"
        ),
        siliconflow_base_url=os.environ.get(
            "SILICONFLOW_BASE_URL", SILICONFLOW_BASE_URL
        ).rstrip("/"),
        text_model=os.environ.get("SILICONFLOW_TEXT_MODEL", DEFAULT_TEXT_MODEL),
        embedding_model=os.environ.get(
            "SILICONFLOW_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL
        ),
        tts_model=os.environ.get("SILICONFLOW_TTS_MODEL", DEFAULT_TTS_MODEL),
    )


def _read_secret(path: Path, *, siliconflow: bool = False) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise RuntimeError(f"required local secret is missing: {path}") from exc
    if siliconflow:
        match = re.search(r"sk-[A-Za-z0-9_-]+", value)
        if match:
            value = match.group(0)
    if not value:
        raise RuntimeError(f"required local secret is empty: {path}")
    return value


def _router_token(config: RouterConfig) -> str:
    return _read_secret(config.router_token_file)


def _require_router_auth(request: Request, config: RouterConfig) -> None:
    authorization = request.headers.get("authorization", "")
    supplied = authorization.removeprefix("Bearer ").strip()
    if not supplied or not hmac.compare_digest(supplied, _router_token(config)):
        raise HTTPException(status_code=401, detail="invalid local gateway token")


def _load_workflow(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"required local image workflow is missing: {path}",
        ) from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"local image workflow is invalid JSON: {path}",
        ) from exc
    if not isinstance(data, dict) or not data:
        raise HTTPException(status_code=503, detail="local image workflow is empty")
    return copy.deepcopy(data)


def _normalise_dimensions(width: int, height: int) -> tuple[int, int]:
    # Qwen's latent dimensions must be divisible by 16.  Keep local memory use
    # bounded while accepting OpenAI-style size values from all CE call sites.
    return (
        max(256, min(1536, width - (width % 16))),
        max(256, min(1536, height - (height % 16))),
    )


def _parse_size(value: Any) -> tuple[int, int]:
    text = str(value or "1024x1024").lower().strip()
    match = re.fullmatch(r"(\d{2,5})x(\d{2,5})", text)
    if not match:
        return 1024, 1024
    width, height = (int(part) for part in match.groups())
    return _normalise_dimensions(width, height)


def _parse_generation_dimensions(payload: dict[str, Any]) -> tuple[int, int]:
    """Prefer CE's explicit width/height fields over an OpenAI ``size`` string."""
    try:
        width = int(payload["width"])
        height = int(payload["height"])
    except (KeyError, TypeError, ValueError):
        return _parse_size(payload.get("size"))
    return _normalise_dimensions(width, height)


def _safe_seed(value: Any) -> int:
    try:
        seed = int(value)
    except (TypeError, ValueError):
        seed = secrets.randbelow(2_147_483_647)
    return max(0, min(2_147_483_647, seed))


def _safe_steps(value: Any) -> int:
    try:
        steps = int(value)
    except (TypeError, ValueError):
        # On the local MPS setup, a 1K Qwen step takes roughly half a minute.
        # Four steps make the interactive image node usable; advanced users can
        # opt into a higher value through QWEN_T2I_STEPS without editing source.
        steps = int(os.environ.get("QWEN_T2I_STEPS", "4"))
    return max(1, min(50, steps))


def _workflow_output_images(history: dict[str, Any], prompt_id: str) -> list[dict[str, str]]:
    prompt = history.get(prompt_id)
    if not isinstance(prompt, dict):
        return []
    outputs = prompt.get("outputs")
    if not isinstance(outputs, dict):
        return []
    images: list[dict[str, str]] = []
    for output in outputs.values():
        if not isinstance(output, dict):
            continue
        for item in output.get("images", []):
            if not isinstance(item, dict) or not item.get("filename"):
                continue
            images.append(
                {
                    "filename": str(item["filename"]),
                    "subfolder": str(item.get("subfolder") or ""),
                    "type": str(item.get("type") or "output"),
                }
            )
    return images


async def _submit_comfy_workflow(
    workflow: dict[str, Any], config: RouterConfig
) -> list[dict[str, str]]:
    timeout_seconds = float(os.environ.get("QWEN_COMFY_TIMEOUT_SECONDS", "900"))
    # A desktop environment may set HTTP(S)_PROXY for external traffic.  Never
    # send loopback ComfyUI calls through that proxy: image uploads in
    # particular are commonly rejected there with a 502 response.
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        try:
            response = await client.post(
                f"{config.comfy_url}/prompt",
                json={"prompt": workflow, "client_id": "dramaclaw-local-gateway"},
            )
            response.raise_for_status()
            prompt_id = str(response.json().get("prompt_id") or "")
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status_code=502, detail=f"ComfyUI rejected the local image workflow: {exc}"
            ) from exc
        if not prompt_id:
            raise HTTPException(status_code=502, detail="ComfyUI did not return a prompt ID")

        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            await asyncio.sleep(1)
            try:
                history_response = await client.get(
                    f"{config.comfy_url}/history/{prompt_id}"
                )
                history_response.raise_for_status()
                history = history_response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise HTTPException(
                    status_code=502, detail=f"could not read ComfyUI task status: {exc}"
                ) from exc
            images = _workflow_output_images(history, prompt_id)
            if images:
                return images
            task = history.get(prompt_id)
            if isinstance(task, dict):
                status = task.get("status")
                if isinstance(status, dict) and status.get("status_str") == "error":
                    messages = status.get("messages") or []
                    raise HTTPException(
                        status_code=502,
                        detail=f"local image workflow failed in ComfyUI: {messages}",
                    )
    raise HTTPException(status_code=504, detail="local image workflow timed out in ComfyUI")


async def _upload_to_comfy(upload: Any, config: RouterConfig) -> str:
    filename = Path(str(getattr(upload, "filename", "reference.png"))).name
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=400, detail="reference image is empty")
    mime = str(getattr(upload, "content_type", "") or "image/png")
    async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
        try:
            response = await client.post(
                f"{config.comfy_url}/upload/image",
                data={"overwrite": "false"},
                files={"image": (filename, content, mime)},
            )
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status_code=502, detail=f"could not upload reference to ComfyUI: {exc}"
            ) from exc
    uploaded_name = str(data.get("name") or "").strip()
    if not uploaded_name:
        raise HTTPException(status_code=502, detail="ComfyUI did not return uploaded filename")
    subfolder = str(data.get("subfolder") or "").strip("/")
    return f"{subfolder}/{uploaded_name}" if subfolder else uploaded_name


def _local_image_response(images: list[dict[str, str]], config: RouterConfig) -> dict[str, Any]:
    data = []
    for image in images:
        query = urlencode(image)
        data.append({"url": f"{config.public_base_url}/v1/local-media?{query}"})
    return {"created": int(time.time()), "data": data}


def _prepare_t2i_workflow(
    payload: dict[str, Any], config: RouterConfig
) -> tuple[dict[str, Any], str]:
    """Load and fill one of the local text-to-image API workflows."""
    model = str(payload.get("model") or QWEN_IMAGE_MODEL).strip()
    if model == KREA_IDENTITY_EDIT_MODEL:
        raise HTTPException(status_code=400, detail="identity edit requires a reference image")
    if model == KREA_IMAGE_MODEL:
        workflow = _load_workflow(config.krea_t2i_workflow)
        prompt_node, latent_node, sampler_node = "4", "6", "7"
        steps_value = payload.get("krea_steps", payload.get("steps"))
        try:
            steps = int(steps_value)
        except (TypeError, ValueError):
            steps = int(os.environ.get("KREA_T2I_STEPS", "8"))
        steps = max(1, min(30, steps))
    else:
        workflow = _load_workflow(config.qwen_t2i_workflow)
        prompt_node, latent_node, sampler_node = "5", "7", "8"
        steps = _safe_steps(payload.get("qwen_steps"))

    workflow[prompt_node]["inputs"]["text"] = str(payload.get("prompt") or "")
    width, height = _parse_generation_dimensions(payload)
    workflow[latent_node]["inputs"].update(
        {
            "width": width,
            "height": height,
            "batch_size": max(1, min(4, int(payload.get("n") or 1))),
        }
    )
    if model == KREA_IMAGE_MODEL:
        workflow["8"]["inputs"].update({"width": width, "height": height})
    workflow[sampler_node]["inputs"]["seed"] = _safe_seed(payload.get("seed"))
    workflow[sampler_node]["inputs"]["steps"] = steps
    return workflow, model


def _prepare_krea_edit_workflow(
    form: Any,
    uploaded: list[str],
    config: RouterConfig,
) -> dict[str, Any]:
    """Fill the community-style Qwen structure -> Krea refinement workflow."""
    workflow = _load_workflow(config.krea_edit_workflow)
    for node_id, uploaded_name in zip(("4", "5", "6"), uploaded, strict=False):
        workflow[node_id]["inputs"]["image"] = uploaded_name
    prompt = str(form.get("prompt") or "")
    role_hint = {
        1: "Use image 1 as the character identity reference. ",
        2: (
            "Use image 1 as the character identity reference and image 2 as the "
            "pose and composition reference. "
        ),
        3: (
            "Use image 1 as the character identity reference, image 2 as the "
            "pose and composition reference, and image 3 as the style or scene "
            "reference. "
        ),
    }[len(uploaded)]
    workflow["7"]["inputs"]["prompt"] = role_hint + prompt
    workflow["8"]["inputs"]["prompt"] = str(form.get("negative_prompt") or "")
    for node_id in ("7", "8"):
        for reference_id, image_node in zip(
            ("image2", "image3"), ("5", "6"), strict=False
        ):
            if len(uploaded) >= (2 if reference_id == "image2" else 3):
                workflow[node_id]["inputs"][reference_id] = [image_node, 0]
    width, height = _parse_generation_dimensions(
        {"width": form.get("width"), "height": form.get("height")}
    )
    workflow["14"]["inputs"].update({"width": width, "height": height})
    workflow["21"]["inputs"].update({"width": width, "height": height})
    seed = _safe_seed(form.get("seed"))
    workflow["15"]["inputs"]["seed"] = seed
    workflow["23"]["inputs"]["seed"] = seed
    workflow["19"]["inputs"]["text"] = prompt
    steps = form.get("krea_steps") or form.get("steps")
    try:
        steps_value = int(steps)
    except (TypeError, ValueError):
        steps_value = int(os.environ.get("KREA_T2I_STEPS", "8"))
    workflow["23"]["inputs"]["steps"] = max(1, min(30, steps_value))
    return workflow


def _prepare_krea_identity_edit_workflow(
    form: Any, uploaded: list[str], config: RouterConfig
) -> dict[str, Any]:
    """Keep identity editing separate from the existing Qwen/Krea refinement path."""
    if not 1 <= len(uploaded) <= 2:
        raise HTTPException(status_code=400, detail="identity edit requires one or two images")
    workflow = _load_workflow(config.krea_identity_edit_workflow)
    workflow["72"]["inputs"]["image"] = uploaded[0]
    workflow["84"]["inputs"]["prompt"] = str(form.get("prompt") or "")
    workflow["85"]["inputs"]["prompt"] = str(form.get("negative_prompt") or "")
    width, height = _parse_generation_dimensions(
        {"width": form.get("width"), "height": form.get("height")}
    )
    workflow["82"]["inputs"].update({"width": width, "height": height})
    workflow["53"]["inputs"]["seed"] = _safe_seed(form.get("seed"))
    # ComfyUI's model enumeration uses the host OS's path separator.
    workflow["71"]["inputs"]["lora_name"] = (
        workflow["71"]["inputs"]["lora_name"].replace("\\", "/").replace("/", os.sep)
    )
    if len(uploaded) == 2:
        # The installed LoRA was trained with scene first, subject second.
        workflow["90"]["inputs"]["image"] = uploaded[1]
        workflow["79"]["inputs"].update(
            {"source_latent_b": ["92", 0], "source_image_b": ["90", 0]}
        )
        for node_id in ("84", "85"):
            workflow[node_id]["inputs"]["image_b"] = ["90", 0]
    else:
        for key in ("source_latent_b", "source_image_b"):
            workflow["79"]["inputs"].pop(key, None)
        for node_id in ("84", "85"):
            workflow[node_id]["inputs"].pop("image_b", None)
        workflow.pop("90", None)
        workflow.pop("92", None)
    return workflow


async def _forward_to_siliconflow(
    request: Request, config: RouterConfig, path: str, forced_model: str | None = None,
    *, provider: str = "siliconflow"
) -> Response:
    _require_router_auth(request, config)
    key = read_key(config.root, provider)
    base_url = ARK_BASE if provider == "ark" else config.siliconflow_base_url
    headers = {"Authorization": f"Bearer {key}"}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["Content-Type"] = content_type
    body = await request.body()
    payload = {}
    if forced_model and content_type and content_type.startswith("application/json"):
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="request body must be JSON") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="request body must be an object")
        payload["model"] = forced_model
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    elif content_type and content_type.startswith("application/json"):
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            pass
    if provider == "ark" and path.lstrip("/") == "chat/completions":
        if payload.pop("enable_thinking", None) is False:
            payload["thinking"] = {"type": "disabled"}
        payload.setdefault("thinking", {"type": "disabled"})
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if path.lstrip("/") == "chat/completions" and isinstance(payload, dict) and payload.get("stream") is True:
        # request() buffers the entire SSE body. Keep both resources alive until
        # downstream finishes (or disconnects), forwarding each chunk immediately.
        client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10))
        started = time.perf_counter()
        try:
            upstream = await client.send(client.build_request(
                request.method, f"{base_url}/{path.lstrip('/')}",
                headers=headers, content=body,
            ), stream=True)
        except BaseException as exc:
            with anyio.CancelScope(shield=True):
                await client.aclose()
            if isinstance(exc, httpx.HTTPError):
                raise HTTPException(502, "Provider stream connection failed") from exc
            raise
        if upstream.status_code >= 400:
            try:
                await upstream.aread()
                return JSONResponse({"error": {"message": "provider_authentication_failed" if upstream.status_code in {401, 403} else "provider_request_failed", "provider": provider}}, status_code=upstream.status_code)
            finally:
                with anyio.CancelScope(shield=True):
                    await upstream.aclose()
                    await client.aclose()

        async def chunks():
            first = True
            try:
                async for chunk in upstream.aiter_bytes():
                    if first and chunk:
                        first = False
                        logger.info("siliconflow stream first_chunk_seconds=%.3f model=%s",
                                    time.perf_counter() - started, payload.get("model"))
                    yield chunk
            finally:
                with anyio.CancelScope(shield=True):
                    await upstream.aclose()
                    await client.aclose()
                logger.info("siliconflow stream closed total_seconds=%.3f model=%s",
                            time.perf_counter() - started, payload.get("model"))

        return StreamingResponse(chunks(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
        })
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            upstream = await client.request(
                request.method,
                f"{base_url}/{path.lstrip('/')}",
                headers=headers,
                content=body,
            )
    except httpx.HTTPError as exc:
        # 连不上/超时。和「上游返回 5xx」是完全不同的故障，日志里必须能分开——
        # 两者在调用方看来都是 502，不记下来就只能靠猜。
        logger.warning(
            "siliconflow unreachable path=%s model=%s error=%s",
            path,
            forced_model or "(client-specified)",
            exc,
        )
        raise HTTPException(status_code=502, detail="Provider request failed") from None
    if upstream.status_code >= 400:
        logger.warning("provider error provider=%s path=%s status=%s", provider, path, upstream.status_code)
        return JSONResponse({"error": {"message": "provider_authentication_failed" if upstream.status_code in {401, 403} else "provider_request_failed", "provider": provider}}, status_code=upstream.status_code)
    passthrough_headers = {
        key: value
        for key, value in upstream.headers.items()
        if key.lower() in {"content-disposition", "x-siliconcloud-trace-id"}
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
        headers=passthrough_headers,
    )


def create_app(config: RouterConfig | None = None) -> FastAPI:
    config = config or router_config()
    app = FastAPI(title="DramaClaw Local Gateway", docs_url=None, redoc_url=None)
    catalog = LocalModelCatalog(config.root)

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {
            "ok": True,
            "service": "dramaclaw-local-gateway",
            # The launcher uses this one-way identifier to avoid reusing a
            # healthy gateway owned by another checkout or config directory.
            "instanceId": hashlib.sha256(
                str(config.root.resolve()).encode("utf-8")
            ).hexdigest()[:16],
            "qwenEditWorkflow": config.qwen_edit_workflow.is_file(),
            "qwenT2iWorkflow": config.qwen_t2i_workflow.is_file(),
            "kreaT2iWorkflow": config.krea_t2i_workflow.is_file(),
            "kreaEditWorkflow": config.krea_edit_workflow.is_file(),
            "siliconflowKey": config.siliconflow_key_file.is_file(),
            "textModel": catalog.setting("default:text"),
            "arkKey": (config.secrets_dir / "ark-agent-plan.key").is_file(),
        }

    @app.get("/v1/models")
    async def models(request: Request) -> Response:
        _require_router_auth(request, config)
        if not catalog.setting("sync:siliconflow"):
            try:
                await catalog.refresh("siliconflow")
            except ValueError:
                pass
        return JSONResponse({"object": "list", "data": [
            {**m, "object": "model", "owned_by": m["provider"]}
            for m in catalog.models(enabled_only=True)
        ]})

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request) -> Response:
        _require_router_auth(request, config)
        try:
            requested = str((await request.json()).get("model") or "")
            # Only documented application aliases resolve to the user's default.
            # Unknown explicit IDs must fail instead of silently changing models.
            if not requested or requested.startswith("DC-"):
                requested = catalog.setting("default:text")
            entry = catalog.resolve(requested, kind="text")
        except (ValueError, AttributeError) as exc:
            raise HTTPException(400, str(exc)) from None
        return await _forward_to_siliconflow(
            request, config, "chat/completions", entry["upstreamModel"], provider=entry["provider"]
        )

    @app.post("/v1/video/generations")
    async def video_generations(request: Request) -> Response:
        _require_router_auth(request, config)
        return JSONResponse(await cloud_video_submit(catalog, await request.json()))

    @app.get("/v1/video/generations/{task_id}")
    async def video_status(task_id: str, request: Request) -> Response:
        _require_router_auth(request, config)
        return JSONResponse(await cloud_video_status(catalog, task_id))

    @app.post("/v1/embeddings")
    async def embeddings(request: Request) -> Response:
        return await _forward_to_siliconflow(
            request, config, "embeddings", config.embedding_model
        )

    @app.post("/v1/audio/speech")
    async def speech(request: Request) -> Response:
        return await _forward_to_siliconflow(
            request, config, "audio/speech", config.tts_model
        )

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(request: Request) -> Response:
        # Multipart bodies are preserved byte-for-byte.  They still route only
        # to SiliconFlow; callers select an ASR model supported by their account.
        return await _forward_to_siliconflow(request, config, "audio/transcriptions")

    @app.post("/v1/images/generations")
    async def image_generations(request: Request) -> JSONResponse:
        _require_router_auth(request, config)
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="request body must be JSON") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="request body must be an object")
        if "::" in str(payload.get("model") or ""):
            return JSONResponse(await cloud_image(catalog, payload))
        try:
            catalog.resolve(str(payload.get("model") or QWEN_IMAGE_MODEL), kind="image")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        workflow, _ = _prepare_t2i_workflow(payload, config)
        images = await _submit_comfy_workflow(workflow, config)
        return JSONResponse(_local_image_response(images, config))

    @app.post("/v1/images/edits")
    async def image_edits(request: Request) -> JSONResponse:
        _require_router_auth(request, config)
        form = await request.form()
        uploads = [item for item in form.getlist("image") if hasattr(item, "read")]
        requested_model = str(form.get("model") or QWEN_IMAGE_MODEL)
        if "::" in requested_model:
            return JSONResponse(await cloud_image(catalog, dict(form), uploads))
        try:
            catalog.resolve(requested_model, kind="image")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        if not uploads:
            raise HTTPException(status_code=400, detail="at least one image is required")
        if len(uploads) > 3:
            raise HTTPException(status_code=400, detail="local image edit supports at most three images")
        model = str(form.get("model") or QWEN_IMAGE_MODEL).strip()
        if model == KREA_IDENTITY_EDIT_MODEL and len(uploads) > 2:
            raise HTTPException(status_code=400, detail="identity edit supports at most two images")
        uploaded = [await _upload_to_comfy(item, config) for item in uploads]
        if model == KREA_IDENTITY_EDIT_MODEL:
            workflow = _prepare_krea_identity_edit_workflow(form, uploaded, config)
        elif model == KREA_IMAGE_MODEL:
            workflow = _prepare_krea_edit_workflow(form, uploaded, config)
        else:
            workflow = _load_workflow(config.qwen_edit_workflow)
            workflow["4"]["inputs"]["image"] = uploaded[0]
            workflow["8"]["inputs"]["prompt"] = str(form.get("negative_prompt") or "")
            workflow["9"]["inputs"]["prompt"] = str(form.get("prompt") or "")
            workflow["16"]["inputs"]["seed"] = _safe_seed(form.get("seed"))
            for node_id, uploaded_name in zip(("5", "6"), uploaded[1:], strict=False):
                workflow[node_id]["inputs"]["image"] = uploaded_name
            if len(uploaded) > 1:
                for node_id in ("8", "9"):
                    workflow[node_id]["inputs"]["image2"] = ["5", 0]
            if len(uploaded) > 2:
                for node_id in ("8", "9"):
                    workflow[node_id]["inputs"]["image3"] = ["6", 0]
        images = await _submit_comfy_workflow(workflow, config)
        return JSONResponse(_local_image_response(images, config))

    @app.get("/v1/local-media")
    async def local_media(filename: str, subfolder: str = "", type: str = "output") -> Response:
        # Output URLs are intentionally unauthenticated because the local web UI
        # needs to render generated images.  The server is bound to loopback.
        params = {"filename": filename, "subfolder": subfolder, "type": type}
        try:
            async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
                upstream = await client.get(f"{config.comfy_url}/view", params=params)
                upstream.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"could not read ComfyUI output: {exc}") from exc
        return Response(content=upstream.content, media_type=upstream.headers.get("content-type"))

    return app


def _package_workflow_template(filename: str) -> Path:
    """Resolve a reviewed workflow shipped with the source checkout."""
    return Path(__file__).resolve().parents[2] / "config" / "local" / filename


def bootstrap_local_config(config: RouterConfig) -> None:
    config.secrets_dir.mkdir(parents=True, exist_ok=True)
    config.workflows_dir.mkdir(parents=True, exist_ok=True)
    config.secrets_dir.chmod(0o700)
    if not config.router_token_file.exists():
        config.router_token_file.write_text(secrets.token_urlsafe(32), encoding="utf-8")
        config.router_token_file.chmod(0o600)
    if not config.qwen_t2i_workflow.exists():
        shutil.copyfile(
            _package_workflow_template("qwen_image_t2i_api.json"),
            config.qwen_t2i_workflow,
        )
        config.qwen_t2i_workflow.chmod(0o600)
    if not config.qwen_edit_workflow.exists():
        shutil.copyfile(
            _package_workflow_template("qwen_image_edit_api.json"),
            config.qwen_edit_workflow,
        )
        config.qwen_edit_workflow.chmod(0o600)
    krea_template = _package_workflow_template("krea2_turbo_t2i_api.json")
    # Local workflows describe the user's installed models and custom nodes.
    # In particular, FP8 is valid on CUDA and must not be migrated to INT8.
    if not config.krea_t2i_workflow.exists():
        shutil.copyfile(krea_template, config.krea_t2i_workflow)
        config.krea_t2i_workflow.chmod(0o600)
    krea_edit_template = _package_workflow_template("krea2_turbo_edit_api.json")
    if not config.krea_edit_workflow.exists():
        shutil.copyfile(krea_edit_template, config.krea_edit_workflow)
        config.krea_edit_workflow.chmod(0o600)
    # Identity Edit is an optional, locally supplied workflow, not a required
    # repository asset. A fresh checkout must still start without that JSON.
    identity_template = _package_workflow_template("krea2_identity_edit_api.json")
    if not config.krea_identity_edit_workflow.exists() and identity_template.is_file():
        shutil.copyfile(
            identity_template,
            config.krea_identity_edit_workflow,
        )
        config.krea_identity_edit_workflow.chmod(0o600)
    if not config.siliconflow_key_file.exists():
        raise RuntimeError(
            f"copy your SiliconFlow key to {config.siliconflow_key_file} before starting"
        )


def configure_cli_runtime(config: RouterConfig) -> None:
    bootstrap_local_config(config)
    # Import only after the command-line wrapper has exported ST_EDITION and a
    # persistent NOVELVIDEO_DATA_ROOT.  This keeps CE's settings.db in ignored
    # runtime state and lets it survive normal source and dependency updates.
    from novelvideo.model_gateway_settings import (
        get_newapi_media_model_mappings,
        save_custom_newapi_gateway,
        save_newapi_media_model_mappings,
    )

    save_custom_newapi_gateway(
        base_url=config.public_base_url,
        api_key=_router_token(config),
        admin_base_url=config.public_base_url,
        token_name="dramaclaw-local-router",
        activate=True,
    )
    # Persist the local image choice alongside the gateway, but never replace a
    # user-edited entry.  The state directory is ignored runtime state, so it
    # survives normal source updates as well.
    media_models = get_newapi_media_model_mappings()
    if QWEN_IMAGE_MODEL not in media_models:
        media_models[QWEN_IMAGE_MODEL] = {
            "provider": "newapi",
            "upstreamModel": QWEN_IMAGE_MODEL,
            "mediaType": "image",
            "label": "Qwen Image（本地 ComfyUI）",
            "enabled": True,
            "sortOrder": 1,
            "config": {
                "request": {"endpoint": "images/generations", "parameters": []},
                "ratioOptions": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            },
        }
        save_newapi_media_model_mappings(media_models)
    if KREA_IMAGE_MODEL not in media_models:
        media_models[KREA_IMAGE_MODEL] = {
            "provider": "newapi",
            "upstreamModel": KREA_IMAGE_MODEL,
            "mediaType": "image",
            "label": "Krea 2 Turbo（本地 ComfyUI）",
            "enabled": True,
            "sortOrder": 2,
            "config": {
                "request": {"endpoint": "images/generations", "parameters": []},
                "ratioOptions": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            },
        }
        save_newapi_media_model_mappings(media_models)
    elif media_models[KREA_IMAGE_MODEL].get("label") in {
        "Krea 2 Turbo（本地 FP8）",
        "Krea 2 Turbo（本地 Int8 / MPS）",
        "Krea 2 Turbo（本地 Int8，Mac 实验）",
    }:
        media_models[KREA_IMAGE_MODEL]["label"] = "Krea 2 Turbo（本地 ComfyUI）"
        save_newapi_media_model_mappings(media_models)

    if (
        KREA_IDENTITY_EDIT_MODEL not in media_models
        and config.krea_identity_edit_workflow.is_file()
    ):
        media_models[KREA_IDENTITY_EDIT_MODEL] = {
            "provider": "newapi",
            "upstreamModel": KREA_IDENTITY_EDIT_MODEL,
            "mediaType": "image",
            "label": "编辑",
            "enabled": True,
            "sortOrder": 3,
            "config": {
                "request": {"endpoint": "images/generations", "parameters": []},
                "referenceImageMax": 2,
                "description": "Krea2 Identity Edit · 单图编辑；双图：场景在前、角色在后",
                "ratioOptions": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            },
        }
        save_newapi_media_model_mappings(media_models)


def main() -> None:
    parser = argparse.ArgumentParser(description="DramaClaw local model router")
    parser.add_argument("command", choices=("bootstrap", "configure", "serve"))
    args = parser.parse_args()
    config = router_config()
    if args.command == "bootstrap":
        bootstrap_local_config(config)
        print(f"Local router configuration is ready in {config.root}")
        return
    if args.command == "configure":
        configure_cli_runtime(config)
        print("DramaClaw command-line runtime now routes through the local gateway")
        return
    bootstrap_local_config(config)
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()

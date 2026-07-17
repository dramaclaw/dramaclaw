"""Cognee 配置工具。

管理 Cognee 的初始化和配置。
自动从 .env 文件加载环境变量。

重要：必须在导入 cognee 之前设置环境变量，因为 Cognee 在导入时会读取。
"""

import contextvars
import hashlib
import importlib
import logging
import os
import sys
import warnings
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

from novelvideo.llm_instrumentation import (
    reset_model_call_reservation_active,
    set_model_call_reservation_active,
)
from novelvideo.official_defaults import (
    DEFAULT_COGNEE_LLM_MODEL,
    DEFAULT_COGNEE_LLM_PROVIDER,
    OFFICIAL_NEWAPI_BASE_URL,
)
from novelvideo.ports import get_usage_meter
from novelvideo.shared.billing_errors import (
    InsufficientCreditsStop,
    find_insufficient_credits_error,
    find_insufficient_credits_stop,
)
from novelvideo.shared.env_guard import preserve_st_env
from novelvideo.shared.runtime_env import is_ce_effective

# 抑制 cognee/litellm 内部的 Pydantic 序列化警告
# （豆包等非 OpenAI provider 的 Message 字段数与 cognee 期望不同，不影响功能）
warnings.filterwarnings("ignore", message="Pydantic serializer warnings")

# 确保加载 .env 文件（优先使用仓库根目录）
project_root = Path(__file__).resolve().parents[3]
load_dotenv(project_root / ".env", override=False)
load_dotenv(override=False)

COGNEE_EMBEDDING_TIMEOUT_SECONDS = float(os.getenv("COGNEE_EMBEDDING_TIMEOUT", "600"))
_embedding_gateway_patch_installed = False
_litellm_embedding_header_patch_installed = False
_embedding_headers_capture: contextvars.ContextVar[dict[str, str] | None] = (
    contextvars.ContextVar("novelvideo_embedding_headers_capture", default=None)
)


# 在导入 cognee 之前设置环境变量（Cognee 在导入时会读取）
# 从 .env 读取配置并设置环境变量
def _resolve_llm_provider(default: str = DEFAULT_COGNEE_LLM_PROVIDER) -> str:
    """Return the product transport provider.

    CE and EE both use newAPI as the compatibility boundary. The argument and
    legacy provider helpers remain for extension compatibility, but deployment
    environment variables cannot make the product runtime bypass the gateway.
    """
    del default
    return "newapi"


def _is_newapi_provider(provider: str) -> bool:
    return provider.strip().lower() == "newapi"


def _uses_newapi_gateway(provider: str, endpoint: str = "") -> bool:
    if _is_newapi_provider(provider):
        return True
    gateway_key, gateway_base_url = _effective_newapi_gateway()
    has_gateway = bool(gateway_key and gateway_base_url) or bool(
        os.getenv("NEWAPI_BASE_URL", "").strip()
    )
    return has_gateway and provider in {"custom", "openai"}


def _to_cognee_provider(provider: str) -> str:
    """Map NovelVideo's external provider names to Cognee/LiteLLM provider names."""
    return "custom" if _is_newapi_provider(provider) else provider


def _normalize_llm_model(provider: str, model: str) -> str:
    """规范化 LLM 模型名称。"""
    if provider == "gemini":
        # Cognee 原生支持 gemini/ 前缀
        if not model.startswith("gemini/"):
            return f"gemini/{model}"
        return model
    if _uses_newapi_gateway(provider):
        # Cognee 底层使用 LiteLLM。裸 gemini-* 会被 LiteLLM 误判为
        # Gemini/Vertex 直连模型，从而要求 Google ADC。这里仅给 LiteLLM
        # 标明 OpenAI-compatible 路由；SuperTale .env 仍只暴露 newAPI 逻辑模型名。
        if not model.startswith(("openai/", "custom/")):
            return f"openai/{model}"
    return model


def _normalize_embedding_model(provider: str, model: str) -> str:
    """Normalize embedding model names for LiteLLM routing."""
    clean_model = str(model or "").strip()
    if not clean_model:
        return clean_model
    if _uses_newapi_gateway(provider):
        if not clean_model.startswith(("openai/", "custom/")):
            return f"openai/{clean_model}"
    return clean_model


def _billing_model_name(model: str) -> str:
    clean_model = str(model or "").strip()
    for prefix in ("openai/", "custom/", "google/", "gemini/"):
        if clean_model.startswith(prefix):
            return clean_model[len(prefix) :]
    return clean_model


def _is_openrouter_config(provider: str, model: str = "", endpoint: str = "") -> bool:
    """判断当前配置是否指向 OpenRouter。"""
    value = f"{provider} {model} {endpoint}".lower()
    return "openrouter" in value


def _get_scoped_env(primary_key: str, fallback_key: str = "") -> str:
    """读取 Cognee 专用配置，必要时回退到全局变量。"""
    value = os.getenv(primary_key, "").strip()
    if value:
        return value
    if fallback_key:
        value = os.getenv(fallback_key, "").strip()
        if value:
            return value
    return ""


def _get_endpoint_env(provider: str, primary_key: str, fallback_key: str) -> str:
    if _uses_newapi_gateway(provider):
        gateway_key, gateway_base_url = _effective_newapi_gateway()
        if gateway_key and gateway_base_url:
            return gateway_base_url
    value = _get_scoped_env(primary_key, fallback_key)
    if value:
        return value
    if _uses_newapi_gateway(provider):
        return os.getenv("NEWAPI_BASE_URL", "").strip()
    return ""


def _effective_newapi_gateway() -> tuple[str, str]:
    try:
        from novelvideo.config import get_newapi_runtime_credentials

        return get_newapi_runtime_credentials()
    except Exception:
        if is_ce_effective():
            # CE credentials are never allowed to fall back to deployment env.
            return "", OFFICIAL_NEWAPI_BASE_URL
        return (
            os.getenv("NEWAPI_API_KEY", "").strip(),
            os.getenv("NEWAPI_BASE_URL", "").strip() or OFFICIAL_NEWAPI_BASE_URL,
        )


def _current_gateway_fingerprint() -> str:
    api_key, base_url = _effective_newapi_gateway()
    material = f"{base_url}\n{api_key}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


_active_gateway_fingerprint: str | None = None


def cognee_gateway_restart_required() -> bool:
    """Return whether CE settings changed after Cognee was initialized."""
    return bool(
        is_ce_effective()
        and _active_gateway_fingerprint
        and _active_gateway_fingerprint != _current_gateway_fingerprint()
    )


def _resolve_llm_api_key(llm_provider: str, llm_model: str) -> str:
    if _is_newapi_provider(llm_provider):
        return _effective_newapi_gateway()[0]
    api_key = os.getenv("COGNEE_LLM_API_KEY", "")
    if api_key:
        return api_key
    if llm_provider == "gemini":
        return os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
    if _is_openrouter_config(
        llm_provider,
        llm_model,
        _get_scoped_env("COGNEE_LLM_ENDPOINT", "LLM_ENDPOINT"),
    ):
        return os.getenv("OPENROUTER_API_KEY", "")
    gateway_key, _gateway_base_url = _effective_newapi_gateway()
    return (
        gateway_key or os.getenv("OPENAI_API_KEY", "") or os.getenv("LLM_API_KEY", "")
    )


def _set_or_clear_env(key: str, value: str) -> None:
    """设置环境变量；空值时清理，避免不同 provider 之间残留配置。"""
    if value:
        os.environ[key] = value
    else:
        os.environ.pop(key, None)


def _clear_cognee_embedding_config_cache() -> None:
    try:
        mod = sys.modules.get(
            "cognee.infrastructure.databases.vector.embeddings.config"
        )
        if mod is None:
            return
        getter = getattr(mod, "get_embedding_config", None)
        cache_clear = getattr(getter, "cache_clear", None)
        if callable(cache_clear):
            cache_clear()
    except Exception:
        pass


def _clear_cognee_llm_config_cache() -> None:
    """清 Cognee get_llm_config 的 lru_cache;不清则换 key 后仍用旧凭据。"""
    try:
        mod = sys.modules.get("cognee.infrastructure.llm.config")
        if mod is None:
            return
        getter = getattr(mod, "get_llm_config", None)
        cache_clear = getattr(getter, "cache_clear", None)
        if callable(cache_clear):
            cache_clear()
    except Exception:
        pass


def _apply_cognee_runtime_defaults() -> None:
    """Apply NovelVideo's Cognee runtime defaults."""
    os.environ.setdefault("ENABLE_BACKEND_ACCESS_CONTROL", "True")
    os.environ.setdefault("COGNEE_SKIP_CONNECTION_TEST", "true")
    # NovelVideo stores Cognee graph data locally per project. Ignore legacy
    # Neo4j values that may still exist in older .env files.
    os.environ["GRAPH_DATABASE_PROVIDER"] = "kuzu"
    os.environ["GRAPH_DATASET_DATABASE_HANDLER"] = "kuzu"

    graph_config_module = sys.modules.get(
        "cognee.infrastructure.databases.graph.config"
    )
    if graph_config_module and hasattr(graph_config_module, "get_graph_config"):
        graph_config_module.get_graph_config.cache_clear()


def _patch_cognee_embedding_timeout() -> None:
    """将 Cognee embedding 的硬编码 30s 超时提升为项目可控值。"""
    try:
        import asyncio as _asyncio
    except Exception:
        return

    class _AsyncioProxy:
        def __init__(self, real_asyncio, timeout_seconds: float):
            self._real_asyncio = real_asyncio
            self._timeout_seconds = timeout_seconds

        def __getattr__(self, name):
            return getattr(self._real_asyncio, name)

        def wait_for(self, awaitable, timeout=None):
            effective_timeout = timeout
            if timeout is None or timeout == 30.0:
                effective_timeout = self._timeout_seconds
            return self._real_asyncio.wait_for(awaitable, timeout=effective_timeout)

    for module_name in (
        "cognee.infrastructure.databases.vector.embeddings.LiteLLMEmbeddingEngine",
        "cognee.infrastructure.databases.vector.embeddings.OpenAICompatibleEmbeddingEngine",
    ):
        try:
            _mod = importlib.import_module(module_name)
        except Exception:
            continue
        if getattr(_mod.asyncio, "_novelvideo_timeout_patch", False):
            continue
        proxy = _AsyncioProxy(_asyncio, COGNEE_EMBEDDING_TIMEOUT_SECONDS)
        proxy._novelvideo_timeout_patch = True
        _mod.asyncio = proxy


def _exc_info_value(value: object) -> BaseException | None:
    if isinstance(value, BaseException):
        return value
    if (
        isinstance(value, tuple)
        and len(value) >= 2
        and isinstance(value[1], BaseException)
    ):
        return value[1]
    return None


def _log_record_has_insufficient_credits(record: logging.LogRecord) -> bool:
    candidates: list[BaseException] = []
    record_exc = _exc_info_value(getattr(record, "exc_info", None))
    if record_exc is not None:
        candidates.append(record_exc)

    msg = getattr(record, "msg", None)
    if isinstance(msg, dict):
        msg_exc = _exc_info_value(msg.get("exc_info"))
        if msg_exc is not None:
            candidates.append(msg_exc)
        exception = msg.get("exception")
        if isinstance(exception, BaseException):
            candidates.append(exception)

    return any(
        find_insufficient_credits_stop(exc) is not None
        or find_insufficient_credits_error(exc) is not None
        for exc in candidates
    )


def _install_insufficient_credits_log_filter() -> None:
    """Suppress Cognee/Rich tracebacks for expected credit-limit stops only."""

    class InsufficientCreditsLogFilter(logging.Filter):
        _novelvideo_insufficient_credits_filter = True

        def filter(self, record: logging.LogRecord) -> bool:
            return not _log_record_has_insufficient_credits(record)

    root_logger = logging.getLogger()
    for handler in root_logger.handlers:
        if not any(
            getattr(existing_filter, "_novelvideo_insufficient_credits_filter", False)
            for existing_filter in handler.filters
        ):
            handler.addFilter(InsufficientCreditsLogFilter())


def _headers_to_plain_dict(headers: object) -> dict[str, str]:
    items = getattr(headers, "items", None)
    if not callable(items):
        return {}
    return {str(key).lower(): str(value) for key, value in items()}


def _remember_embedding_response_headers(response: object) -> None:
    capture = _embedding_headers_capture.get()
    if capture is None:
        return
    headers = _headers_to_plain_dict(getattr(response, "headers", None))
    if headers:
        capture.clear()
        capture.update(headers)


def _install_litellm_embedding_header_capture() -> None:
    """Preserve embedding HTTP headers that LiteLLM's EmbeddingResponse drops."""
    global _litellm_embedding_header_patch_installed
    if _litellm_embedding_header_patch_installed:
        return
    try:
        handler_mod = importlib.import_module("litellm.llms.custom_httpx.http_handler")
        sync_cls = getattr(handler_mod, "HTTPHandler", None)
        async_cls = getattr(handler_mod, "AsyncHTTPHandler", None)
    except Exception:
        return

    if sync_cls is not None and not getattr(
        sync_cls, "_novelvideo_header_patch", False
    ):
        original_sync_post = sync_cls.post

        def patched_sync_post(self, *args, **kwargs):
            response = original_sync_post(self, *args, **kwargs)
            _remember_embedding_response_headers(response)
            return response

        sync_cls.post = patched_sync_post
        sync_cls._novelvideo_header_patch = True

    if async_cls is not None and not getattr(
        async_cls, "_novelvideo_header_patch", False
    ):
        original_async_post = async_cls.post

        async def patched_async_post(self, *args, **kwargs):
            response = await original_async_post(self, *args, **kwargs)
            _remember_embedding_response_headers(response)
            return response

        async_cls.post = patched_async_post
        async_cls._novelvideo_header_patch = True

    _litellm_embedding_header_patch_installed = True


def _attach_embedding_response_headers(
    response: object, headers: dict[str, str]
) -> None:
    if not headers:
        return
    try:
        hidden = getattr(response, "_hidden_params", None)
        if not isinstance(hidden, dict):
            hidden = {}
            setattr(response, "_hidden_params", hidden)
        hidden.setdefault("headers", headers)
        hidden.setdefault("response_headers", headers)
        setattr(response, "_response_headers", headers)
    except Exception:
        return


def _embedding_response_trace(
    response: object, headers: dict[str, str]
) -> tuple[str, str]:
    request_id = ""
    response_id = ""
    merged_headers = dict(headers)
    try:
        request_id = (
            str(getattr(response, "request_id", "") or "").strip()
            or str(getattr(response, "_request_id", "") or "").strip()
        )
        response_id = (
            str(getattr(response, "id", "") or "").strip()
            or str(getattr(response, "response_id", "") or "").strip()
        )
        hidden = getattr(response, "_hidden_params", None)
        if isinstance(hidden, dict):
            hidden_headers = (
                hidden.get("headers") or hidden.get("response_headers") or {}
            )
            merged_headers.update(_headers_to_plain_dict(hidden_headers))
            request_id = (
                request_id
                or str(
                    hidden.get("request_id") or hidden.get("requestId") or ""
                ).strip()
            )
            response_id = (
                response_id
                or str(
                    hidden.get("response_id") or hidden.get("responseId") or ""
                ).strip()
            )
        response_headers = getattr(response, "_response_headers", None)
        merged_headers.update(_headers_to_plain_dict(response_headers))
    except Exception:
        pass
    request_id = (
        request_id
        or merged_headers.get("x-request-id", "")
        or merged_headers.get("request-id", "")
        or merged_headers.get("request_id", "")
        or merged_headers.get("x-newapi-request-id", "")
        or merged_headers.get("newapi-request-id", "")
        or merged_headers.get("x-oneapi-request-id", "")
        or merged_headers.get("oneapi-request-id", "")
        or merged_headers.get("x-goog-request-id", "")
    )
    return request_id, response_id


def _patch_cognee_embedding_gateway() -> None:
    """Force Cognee LiteLLM embeddings through the newAPI OpenAI-compatible gateway."""
    global _embedding_gateway_patch_installed
    if _embedding_gateway_patch_installed:
        return

    try:
        _mod = importlib.import_module(
            "cognee.infrastructure.databases.vector.embeddings.LiteLLMEmbeddingEngine"
        )
    except Exception:
        return

    engine_cls = getattr(_mod, "LiteLLMEmbeddingEngine", None)
    if engine_cls is None or getattr(engine_cls, "_novelvideo_gateway_patch", False):
        _embedding_gateway_patch_installed = True
        return

    original_embed_text = engine_cls.embed_text

    async def patched_embed_text(self, text):
        provider = str(getattr(self, "provider", "") or "").strip().lower()
        endpoint = str(getattr(self, "endpoint", "") or "").strip()
        if provider not in {"custom", "openai"} or not endpoint:
            return await original_embed_text(self, text)

        litellm = _mod.litellm
        original_aembedding = litellm.aembedding

        async def gateway_aembedding(*args, **kwargs):
            kwargs.setdefault("custom_llm_provider", "openai")
            raw_model = str(kwargs.get("model") or "").strip()
            if raw_model:
                kwargs["model"] = _normalize_embedding_model("newapi", raw_model)
            if os.getenv("COGNEE_EMBEDDING_SEND_DIMENSIONS", "false").lower() not in (
                "1",
                "true",
                "yes",
                "on",
            ):
                # dimensions 仍用于本地向量库 sizing；默认不传给 newAPI 上游。
                kwargs.pop("dimensions", None)
            response = await original_aembedding(*args, **kwargs)
            _attach_embedding_response_headers(response, captured_headers)
            nonlocal captured_request_id, captured_response_id
            request_id, response_id = _embedding_response_trace(
                response, captured_headers
            )
            captured_request_id = captured_request_id or request_id
            captured_response_id = captured_response_id or response_id
            return response

        litellm.aembedding = gateway_aembedding
        _install_litellm_embedding_header_capture()
        captured_headers: dict[str, str] = {}
        captured_request_id = ""
        captured_response_id = ""
        token = _embedding_headers_capture.set(captured_headers)
        raw_model = str(
            getattr(self, "model", "") or os.getenv("EMBEDDING_MODEL", "")
        ).strip()
        model = _normalize_embedding_model("newapi", raw_model)
        billing_model = _billing_model_name(raw_model or model)
        original_model = getattr(self, "model", None)
        reservation_id = ""
        active_token = None
        try:
            if model:
                self.model = model

            try:
                reservation_id = (
                    await get_usage_meter().reserve_current_model_call_credit(
                        model=billing_model,
                        billing_kind="embedding",
                        metadata={"source": "cognee_embedding_gateway"},
                    )
                )
            except Exception as exc:
                insufficient = find_insufficient_credits_error(exc)
                if insufficient is not None:
                    raise InsufficientCreditsStop(
                        user_id=insufficient.user_id,
                        cost=insufficient.cost,
                        balance=insufficient.balance,
                    ) from None
                raise
            active_token = set_model_call_reservation_active(bool(reservation_id))
            result = await original_embed_text(self, text)
        except BaseException:
            if reservation_id:
                try:
                    await get_usage_meter().refund_model_call_credit_reservation(
                        reservation_id,
                        metadata={"source": "cognee_embedding_gateway_exception"},
                    )
                except Exception:
                    pass
            raise
        finally:
            if active_token is not None:
                try:
                    reset_model_call_reservation_active(active_token)
                except Exception:
                    pass
            if original_model is not None:
                self.model = original_model
            _embedding_headers_capture.reset(token)
            litellm.aembedding = original_aembedding
        if reservation_id:
            try:
                request_id = (
                    captured_request_id
                    or captured_headers.get("x-request-id")
                    or captured_headers.get("x-newapi-request-id")
                    or captured_headers.get("x-oneapi-request-id")
                    or ""
                )
                metadata = {"source": "cognee_embedding_gateway"}
                if captured_response_id:
                    metadata["response_id"] = captured_response_id
                await get_usage_meter().bump_model_call(
                    user_id=None,
                    model=billing_model,
                    credit_reservation_id=reservation_id,
                    provider_request_id=request_id,
                    metadata=metadata,
                )
            except Exception:
                pass
        return result

    engine_cls.embed_text = patched_embed_text
    engine_cls._novelvideo_original_embed_text = original_embed_text
    engine_cls._novelvideo_gateway_patch = True
    _embedding_gateway_patch_installed = True


def apply_cognee_project_storage_context(
    state_dir: str | os.PathLike[str],
    cognee_module=None,
) -> tuple[str, str]:
    """Point Cognee system/data storage at a project-local state directory."""
    _apply_cognee_runtime_defaults()
    state_path = Path(state_dir)
    cognee_system_dir = str(state_path / "cognee_system")
    cognee_data_dir = str(state_path / "cognee_data")
    Path(cognee_system_dir).mkdir(parents=True, exist_ok=True)
    Path(cognee_data_dir).mkdir(parents=True, exist_ok=True)

    os.environ["SYSTEM_ROOT_DIRECTORY"] = cognee_system_dir
    os.environ["DATA_ROOT_DIRECTORY"] = cognee_data_dir

    if cognee_module is None:
        with preserve_st_env():
            import cognee as cognee_module

    cognee_module.config.system_root_directory(cognee_system_dir)
    if hasattr(cognee_module.config, "data_root_directory"):
        cognee_module.config.data_root_directory(cognee_data_dir)

    return cognee_system_dir, cognee_data_dir


def _resolve_embedding_provider(llm_provider: str) -> tuple:
    """解析 embedding 配置，返回 (provider, model, dimensions, batch_size)。"""
    from novelvideo.model_gateway_settings import get_effective_cognee_embedding_config

    effective = get_effective_cognee_embedding_config(llm_provider=llm_provider)
    return (
        effective.provider,
        effective.model,
        effective.dimensions,
        effective.batch_size,
    )


def _apply_embedding_runtime_defaults(llm_provider: str) -> None:
    """Apply non-secret embedding defaults before Cognee imports and caches config."""
    (
        embedding_provider,
        embedding_model,
        embedding_dimensions,
        embedding_batch_size,
    ) = _resolve_embedding_provider(llm_provider)
    raw_embedding_provider = embedding_provider
    embedding_model = _normalize_embedding_model(
        raw_embedding_provider, embedding_model
    )
    embedding_provider = _to_cognee_provider(embedding_provider)
    embedding_endpoint = _get_endpoint_env(
        raw_embedding_provider,
        "COGNEE_EMBEDDING_ENDPOINT",
        "EMBEDDING_ENDPOINT",
    )
    embedding_api_version = _get_scoped_env(
        "COGNEE_EMBEDDING_API_VERSION", "EMBEDDING_API_VERSION"
    )

    os.environ["EMBEDDING_PROVIDER"] = embedding_provider
    os.environ["EMBEDDING_MODEL"] = embedding_model
    os.environ["EMBEDDING_DIMENSIONS"] = embedding_dimensions
    if embedding_batch_size:
        os.environ["EMBEDDING_BATCH_SIZE"] = embedding_batch_size
    _set_or_clear_env("EMBEDDING_ENDPOINT", embedding_endpoint)
    _set_or_clear_env("EMBEDDING_API_VERSION", embedding_api_version)
    _clear_cognee_embedding_config_cache()


def _apply_llm_env(provider: str, model: str, api_key: str) -> None:
    """应用 LLM 相关环境变量。"""
    llm_endpoint = _get_endpoint_env(provider, "COGNEE_LLM_ENDPOINT", "LLM_ENDPOINT")
    llm_api_version = _get_scoped_env("COGNEE_LLM_API_VERSION", "LLM_API_VERSION")
    cognee_provider = _to_cognee_provider(provider)

    if provider == "gemini":
        os.environ["LLM_PROVIDER"] = "gemini"
        os.environ["LLM_MODEL"] = model
        os.environ["LLM_API_KEY"] = api_key
        os.environ["GEMINI_API_KEY"] = api_key
        os.environ["GOOGLE_API_KEY"] = api_key
    else:
        os.environ["LLM_PROVIDER"] = cognee_provider
        os.environ["LLM_MODEL"] = model
        os.environ["LLM_API_KEY"] = api_key
        if _uses_newapi_gateway(provider, llm_endpoint):
            # LiteLLM/OpenAI-compatible fallback paths read OPENAI_* directly.
            # Keep them in sync with the selected gateway instead of preserving
            # a key from a previous settings save.
            os.environ["OPENAI_API_KEY"] = api_key
            _set_or_clear_env("OPENAI_API_BASE", llm_endpoint)
            _set_or_clear_env("OPENAI_BASE_URL", llm_endpoint)
        elif not os.getenv("OPENAI_API_KEY"):
            os.environ["OPENAI_API_KEY"] = api_key

    _set_or_clear_env("LLM_ENDPOINT", llm_endpoint)
    _set_or_clear_env("LLM_API_VERSION", llm_api_version)
    _clear_cognee_llm_config_cache()


def _apply_embedding_env(llm_provider: str, api_key: str) -> tuple[str, str, str, str]:
    """应用 Embedding 相关环境变量。"""
    (
        embedding_provider,
        embedding_model,
        embedding_dimensions,
        embedding_batch_size,
    ) = _resolve_embedding_provider(llm_provider)
    raw_embedding_provider = embedding_provider
    embedding_model = _normalize_embedding_model(
        raw_embedding_provider, embedding_model
    )
    embedding_provider = _to_cognee_provider(embedding_provider)

    embedding_api_key = ""
    if not _uses_newapi_gateway(raw_embedding_provider):
        embedding_api_key = os.getenv("COGNEE_EMBEDDING_API_KEY", "")
    if not embedding_api_key:
        if embedding_provider == "gemini":
            embedding_api_key = (
                os.getenv("GEMINI_API_KEY", "")
                or os.getenv("GOOGLE_API_KEY", "")
                or api_key
            )
        elif _is_openrouter_config(
            embedding_provider,
            embedding_model,
            _get_scoped_env("COGNEE_EMBEDDING_ENDPOINT", "EMBEDDING_ENDPOINT"),
        ):
            embedding_api_key = os.getenv("OPENROUTER_API_KEY", "")
        elif _uses_newapi_gateway(raw_embedding_provider):
            embedding_api_key = _effective_newapi_gateway()[0]
        else:
            embedding_api_key = (
                _effective_newapi_gateway()[0]
                or os.getenv("EMBEDDING_API_KEY", "")
                or os.getenv("OPENAI_API_KEY", "")
            )

    embedding_endpoint = _get_endpoint_env(
        raw_embedding_provider,
        "COGNEE_EMBEDDING_ENDPOINT",
        "EMBEDDING_ENDPOINT",
    )
    embedding_api_version = _get_scoped_env(
        "COGNEE_EMBEDDING_API_VERSION", "EMBEDDING_API_VERSION"
    )

    os.environ["EMBEDDING_PROVIDER"] = embedding_provider
    os.environ["EMBEDDING_MODEL"] = embedding_model
    os.environ["EMBEDDING_DIMENSIONS"] = embedding_dimensions
    os.environ["EMBEDDING_API_KEY"] = embedding_api_key or api_key
    if embedding_batch_size:
        os.environ["EMBEDDING_BATCH_SIZE"] = embedding_batch_size
        _clear_cognee_embedding_config_cache()
    _set_or_clear_env("EMBEDDING_ENDPOINT", embedding_endpoint)
    _set_or_clear_env("EMBEDDING_API_VERSION", embedding_api_version)

    return (
        embedding_provider,
        embedding_model,
        embedding_dimensions,
        embedding_api_key or api_key,
    )


llm_provider = _resolve_llm_provider()
llm_model = _normalize_llm_model(
    llm_provider,
    os.getenv("COGNEE_LLM_MODEL", "").strip() or DEFAULT_COGNEE_LLM_MODEL,
)
_apply_embedding_runtime_defaults(llm_provider)

api_key = _resolve_llm_api_key(llm_provider, llm_model)

if api_key:
    _apply_llm_env(llm_provider, llm_model, api_key)
    _apply_embedding_env(llm_provider, api_key)

_apply_cognee_runtime_defaults()

try:
    with preserve_st_env():
        import cognee

    cognee_llm_provider = _to_cognee_provider(llm_provider)
    os.environ["LLM_MODEL"] = llm_model
    os.environ["LLM_PROVIDER"] = (
        "gemini" if llm_provider == "gemini" else cognee_llm_provider
    )
    os.environ["LLM_API_KEY"] = api_key

    cognee.config.set_llm_provider(
        "gemini" if llm_provider == "gemini" else cognee_llm_provider
    )
    cognee.config.set_llm_model(llm_model)
    cognee.config.set_llm_api_key(api_key)
    _patch_cognee_embedding_timeout()
    _install_insufficient_credits_log_filter()
    _patch_cognee_embedding_gateway()

    COGNEE_AVAILABLE = True
except ImportError:
    COGNEE_AVAILABLE = False

if COGNEE_AVAILABLE and is_ce_effective() and api_key:
    _active_gateway_fingerprint = _current_gateway_fingerprint()


def init_cognee() -> None:
    """初始化 Cognee 配置。

    CE 从 settings.db 解析网关，EE 从启动环境解析网关。Cognee 本身要求
    通过进程环境初始化第三方客户端，因此该桥接只允许在进程启动配置未变化
    时重复执行；CE 配置变化后必须重启。

    重要：必须在导入 cognee 之前设置环境变量，因为 Cognee 在导入时会读取环境变量。

    EE 可使用的部署环境变量:
        COGNEE_LLM_MODEL=DC-cognee-LLM
        NEWAPI_API_KEY=your_key
        NEWAPI_BASE_URL=https://relayclaw.cdnfg.com/v1
    """
    global _active_gateway_fingerprint

    if not COGNEE_AVAILABLE:
        raise ImportError("cognee is not installed. Run: pip install cognee")
    if cognee_gateway_restart_required():
        raise RuntimeError(
            "模型网关配置已更新，Cognee 仍持有启动时的旧配置；"
            "请重启 DramaClaw 后再使用小说知识库。"
        )

    llm_provider = _resolve_llm_provider()

    api_key = _resolve_llm_api_key(
        llm_provider,
        os.getenv("COGNEE_LLM_MODEL", "").strip() or DEFAULT_COGNEE_LLM_MODEL,
    )
    if not api_key:
        raise ValueError(
            "未设置 Cognee LLM Key。请配置 DramaClaw 模型网关；"
            "CE 在设置页配置，EE 通过 NEWAPI_API_KEY 配置。"
        )

    llm_model = _normalize_llm_model(
        llm_provider,
        os.getenv("COGNEE_LLM_MODEL", "").strip() or DEFAULT_COGNEE_LLM_MODEL,
    )

    _apply_llm_env(llm_provider, llm_model, api_key)
    (
        embedding_provider,
        embedding_model,
        embedding_dimensions,
        embedding_api_key,
    ) = _apply_embedding_env(llm_provider, api_key)

    _apply_cognee_runtime_defaults()

    # 设置 cognee.config（虽然 Cognee 主要从环境变量读取，但设置 config 作为备份）
    cognee_llm_provider = _to_cognee_provider(llm_provider)
    cognee_provider = "gemini" if llm_provider == "gemini" else cognee_llm_provider
    cognee.config.llm_provider = cognee_provider
    cognee.config.llm_model = llm_model
    cognee.config.llm_api_key = api_key
    if hasattr(cognee.config, "set_llm_provider"):
        cognee.config.set_llm_provider(cognee_provider)
    if hasattr(cognee.config, "set_llm_model"):
        cognee.config.set_llm_model(llm_model)
    if hasattr(cognee.config, "set_llm_api_key"):
        cognee.config.set_llm_api_key(api_key)

    cognee.config.embedding_provider = embedding_provider
    cognee.config.embedding_model = embedding_model
    cognee.config.embedding_dimensions = int(embedding_dimensions)
    cognee.config.embedding_api_key = embedding_api_key or api_key
    if hasattr(cognee.config, "set_embedding_provider"):
        cognee.config.set_embedding_provider(embedding_provider)
    if hasattr(cognee.config, "set_embedding_model"):
        cognee.config.set_embedding_model(embedding_model)
    if hasattr(cognee.config, "set_embedding_dimensions"):
        cognee.config.set_embedding_dimensions(int(embedding_dimensions))
    if hasattr(cognee.config, "set_embedding_api_key"):
        cognee.config.set_embedding_api_key(embedding_api_key or api_key)
    _patch_cognee_embedding_timeout()
    _install_insufficient_credits_log_filter()
    _patch_cognee_embedding_gateway()
    if is_ce_effective():
        _active_gateway_fingerprint = _current_gateway_fingerprint()


def configure_cognee(
    llm_provider: str = DEFAULT_COGNEE_LLM_PROVIDER,
    llm_model: str = DEFAULT_COGNEE_LLM_MODEL,
    embedding_model: str = "text-embedding-3-small",
    api_key: Optional[str] = None,
) -> None:
    """配置 Cognee（已废弃，请使用 init_cognee）。

    Args:
        llm_provider: LLM 提供商（openai, anthropic, gemini）
        llm_model: LLM 模型名称
        embedding_model: 嵌入模型名称
        api_key: API 密钥（默认从环境变量读取）
    """
    init_cognee()


def get_cognee_status() -> dict:
    """获取 Cognee 状态信息。"""
    if not COGNEE_AVAILABLE:
        return {"available": False, "error": "cognee not installed"}

    try:
        return {
            "available": True,
            "llm_provider": os.getenv(
                "LLM_PROVIDER", getattr(cognee.config, "llm_provider", "unknown")
            ),
            "llm_model": os.getenv(
                "LLM_MODEL", getattr(cognee.config, "llm_model", "unknown")
            ),
            "embedding_provider": os.getenv(
                "EMBEDDING_PROVIDER",
                getattr(cognee.config, "embedding_provider", "unknown"),
            ),
            "embedding_model": os.getenv(
                "EMBEDDING_MODEL", getattr(cognee.config, "embedding_model", "unknown")
            ),
            "embedding_dimensions": int(
                os.getenv(
                    "EMBEDDING_DIMENSIONS",
                    str(getattr(cognee.config, "embedding_dimensions", 0)),
                )
            ),
        }
    except Exception as e:
        return {"available": True, "error": str(e)}

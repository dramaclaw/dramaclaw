"""Pipeline-scoped concurrency controls for Cognee upstream requests."""

from __future__ import annotations

import asyncio
import contextvars
import importlib
import logging
import os
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import wraps
from typing import Any, AsyncIterator, Callable, Literal


LLM_CONCURRENCY_ENV = "COGNEE_LLM_CONCURRENCY"
EMBEDDING_CONCURRENCY_ENV = "COGNEE_EMBEDDING_BATCH_CONCURRENCY"
logger = logging.getLogger(__name__)
_logged_embedding_bypasses: set[tuple[type | None, str]] = set()


@dataclass(frozen=True)
class CogneeConcurrencyConfig:
    llm: int
    embedding_batch: int


def _positive_int_env(key: str, default: int) -> int:
    raw = os.getenv(key, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a positive integer, got {raw!r}") from exc
    if value <= 0:
        raise ValueError(f"{key} must be a positive integer, got {raw!r}")
    return value


def get_cognee_concurrency_config() -> CogneeConcurrencyConfig:
    return CogneeConcurrencyConfig(
        llm=_positive_int_env(LLM_CONCURRENCY_ENV, 2),
        embedding_batch=_positive_int_env(EMBEDDING_CONCURRENCY_ENV, 4),
    )


@dataclass
class _PipelineLimits:
    llm: asyncio.Semaphore
    embedding_batch: asyncio.Semaphore
    llm_active: int = 0
    llm_peak: int = 0
    embedding_batch_active: int = 0
    embedding_batch_peak: int = 0

    def record_acquired(self, kind: Literal["llm", "embedding_batch"]) -> None:
        active_name = f"{kind}_active"
        peak_name = f"{kind}_peak"
        active = getattr(self, active_name) + 1
        setattr(self, active_name, active)
        setattr(self, peak_name, max(getattr(self, peak_name), active))

    def record_released(self, kind: Literal["llm", "embedding_batch"]) -> None:
        active_name = f"{kind}_active"
        setattr(self, active_name, getattr(self, active_name) - 1)


_current_pipeline_limits: contextvars.ContextVar[_PipelineLimits | None] = (
    contextvars.ContextVar("novelvideo_cognee_pipeline_limits", default=None)
)


class _PipelineSemaphoreLimiter:
    """Async context manager backed by the current pipeline's semaphore."""

    def __init__(self, kind: Literal["llm", "embedding_batch"]):
        self._kind = kind
        self._acquired: contextvars.ContextVar[
            tuple[tuple[asyncio.Semaphore | None, _PipelineLimits | None], ...]
        ] = contextvars.ContextVar(
            f"novelvideo_cognee_{kind}_acquired_semaphores", default=()
        )

    async def __aenter__(self) -> "_PipelineSemaphoreLimiter":
        limits = _current_pipeline_limits.get()
        semaphore = getattr(limits, self._kind) if limits is not None else None
        if semaphore is not None:
            await semaphore.acquire()
            limits.record_acquired(self._kind)
        else:
            logger.debug(
                "Cognee %s limiter bypassed: no active pipeline context",
                self._kind,
            )
        self._acquired.set((*self._acquired.get(), (semaphore, limits)))
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        acquired = self._acquired.get()
        if not acquired:
            raise RuntimeError("Cognee pipeline limiter exited without being entered")
        semaphore, limits = acquired[-1]
        self._acquired.set(acquired[:-1])
        if semaphore is not None:
            if limits is not None:
                limits.record_released(self._kind)
            semaphore.release()


llm_pipeline_limiter = _PipelineSemaphoreLimiter("llm")
embedding_pipeline_limiter = _PipelineSemaphoreLimiter("embedding_batch")


def install_llm_adapter_concurrency(adapter_class: type) -> None:
    """Acquire the pipeline slot before Cognee starts its retry budget."""
    original = adapter_class.acreate_structured_output
    if getattr(original, "_novelvideo_concurrency_wrapped", False):
        return

    @wraps(original)
    async def limited(self, *args, **kwargs):
        # Keep the logical request admitted throughout Tenacity backoff. Letting
        # newer work pass a retrying request would defeat upstream backpressure.
        async with llm_pipeline_limiter:
            return await original(self, *args, **kwargs)

    limited._novelvideo_concurrency_wrapped = True
    adapter_class.acreate_structured_output = limited


class _LimitedVectorEngine:
    """Delegate vector work after admission to the current pipeline."""

    def __init__(self, engine: Any):
        self._engine = engine

    @property
    def __class__(self) -> type:
        # Preserve the wrapped engine's identity for isinstance() checks that
        # Cognee may add around the vector engine in future versions.
        return type(self._engine)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._engine, name)

    async def index_data_points(self, *args, **kwargs):
        async with embedding_pipeline_limiter:
            return await self._engine.index_data_points(*args, **kwargs)


def build_limited_index_data_points(
    original: Callable,
    targeted_embedding_engine_class: type,
    get_vector_engine: Callable[[], Any] | None = None,
) -> Callable:
    """Wrap Cognee's scheduler without copying its batching implementation."""

    @wraps(original)
    async def limited(data_points, vector_engine=None):
        engine = vector_engine
        if engine is None:
            if get_vector_engine is None:
                return await original(data_points)
            engine = get_vector_engine()

        embedding_engine = getattr(engine, "embedding_engine", None)
        provider = str(getattr(embedding_engine, "provider", ""))
        is_targeted = isinstance(
            embedding_engine, targeted_embedding_engine_class
        ) and provider == "custom"
        if is_targeted:
            engine = _LimitedVectorEngine(engine)
        elif _current_pipeline_limits.get() is not None:
            bypass_key = (type(embedding_engine) if embedding_engine else None, provider)
            if bypass_key not in _logged_embedding_bypasses:
                _logged_embedding_bypasses.add(bypass_key)
                logger.info(
                    "Cognee embedding concurrency bypassed for engine=%s "
                    "provider=%s; COGNEE_EMBEDDING_BATCH_CONCURRENCY currently "
                    "applies only to NewAPI/custom LiteLLM embeddings",
                    type(embedding_engine).__name__ if embedding_engine else "none",
                    provider or "unknown",
                )

        return await original(data_points, vector_engine=engine)

    limited._novelvideo_concurrency_wrapped = True
    return limited


def install_cognee_pipeline_concurrency(
    rate_limiting_module=None,
    *,
    cognee_version: str | None = None,
    generic_adapter_class: type | None = None,
    embedding_engine_class: type | None = None,
    index_data_points_function: Callable | None = None,
    index_data_points_targets: list[Any] | None = None,
    get_vector_engine: Callable[[], Any] | None = None,
) -> None:
    """Install retry-safe concurrency wrappers for Cognee 1.0.5."""
    if rate_limiting_module is None:
        rate_limiting_module = importlib.import_module("cognee.shared.rate_limiting")
    if cognee_version is None:
        cognee_module = importlib.import_module("cognee")
        cognee_version = str(getattr(cognee_module, "__version__", ""))

    if cognee_version != "1.0.5":
        raise RuntimeError(
            "Cognee pipeline concurrency compatibility requires cognee==1.0.5; "
            f"found {cognee_version or 'unknown'}"
        )

    marker = "_novelvideo_pipeline_concurrency_installed"
    if getattr(rate_limiting_module, marker, False):
        return

    required = ("llm_config",)
    missing = [name for name in required if not hasattr(rate_limiting_module, name)]
    if missing:
        raise RuntimeError(
            "Cognee rate limiting compatibility attributes are missing: "
            + ", ".join(missing)
        )

    llm_config = rate_limiting_module.llm_config
    # Cognee's native limiter waits inside its Tenacity retry wrapper and uses a
    # process-global, event-loop-affine limiter. Stacking it here would restore
    # the retry-budget and cross-event-loop failure modes this wrapper avoids.
    if bool(getattr(llm_config, "llm_rate_limit_enabled", False)) or bool(
        getattr(llm_config, "embedding_rate_limit_enabled", False)
    ):
        raise ValueError(
            "Cognee native rate limit settings cannot be combined with DramaClaw "
            "pipeline concurrency controls"
        )

    if generic_adapter_class is None:
        adapter_module = importlib.import_module(
            "cognee.infrastructure.llm.structured_output_framework."
            "litellm_instructor.llm.generic_llm_api.adapter"
        )
        generic_adapter_class = adapter_module.GenericAPIAdapter

    if embedding_engine_class is None:
        embedding_module = importlib.import_module(
            "cognee.infrastructure.databases.vector.embeddings."
            "LiteLLMEmbeddingEngine"
        )
        embedding_engine_class = embedding_module.LiteLLMEmbeddingEngine

    if index_data_points_function is None:
        index_module = importlib.import_module(
            "cognee.tasks.storage.index_data_points"
        )
        index_data_points_function = index_module.index_data_points

    if index_data_points_targets is None:
        # Cognee imports this function by value in several modules. Discover all
        # bindings loaded by the pinned version so eager-import changes cannot
        # silently bypass the wrapper.
        index_data_points_targets = [
            module
            for name, module in list(sys.modules.items())
            if name.startswith("cognee.")
            and module is not None
            and getattr(module, "index_data_points", None)
            is index_data_points_function
        ]

    if get_vector_engine is None:
        vector_module = importlib.import_module(
            "cognee.infrastructure.databases.vector"
        )
        get_vector_engine = vector_module.get_vector_engine

    install_llm_adapter_concurrency(generic_adapter_class)
    limited_index_data_points = build_limited_index_data_points(
        index_data_points_function,
        embedding_engine_class,
        get_vector_engine,
    )
    for target in index_data_points_targets:
        target.index_data_points = limited_index_data_points

    setattr(rate_limiting_module, marker, True)


@asynccontextmanager
async def cognee_pipeline_concurrency(
    config: CogneeConcurrencyConfig | None = None,
) -> AsyncIterator[CogneeConcurrencyConfig]:
    effective = config or get_cognee_concurrency_config()
    limits = _PipelineLimits(
        llm=asyncio.Semaphore(effective.llm),
        embedding_batch=asyncio.Semaphore(effective.embedding_batch),
    )
    token = _current_pipeline_limits.set(limits)
    try:
        yield effective
    finally:
        _current_pipeline_limits.reset(token)
        logger.info(
            "Cognee pipeline concurrency finished: llm_peak=%s/%s "
            "embedding_batch_peak=%s/%s",
            limits.llm_peak,
            effective.llm,
            limits.embedding_batch_peak,
            effective.embedding_batch,
        )

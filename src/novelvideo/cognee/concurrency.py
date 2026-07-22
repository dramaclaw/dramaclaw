"""Pipeline-scoped concurrency controls for Cognee upstream requests."""

from __future__ import annotations

import asyncio
import contextvars
import importlib
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator, Literal


LLM_CONCURRENCY_ENV = "COGNEE_LLM_CONCURRENCY"
EMBEDDING_CONCURRENCY_ENV = "COGNEE_EMBEDDING_BATCH_CONCURRENCY"
logger = logging.getLogger(__name__)


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


def install_cognee_pipeline_concurrency(
    rate_limiting_module=None,
    *,
    cognee_version: str | None = None,
) -> None:
    """Route Cognee 1.0.5's request contexts through pipeline-local limits."""
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

    required = ("llm_config", "llm_rate_limiter", "embedding_rate_limiter")
    missing = [name for name in required if not hasattr(rate_limiting_module, name)]
    if missing:
        raise RuntimeError(
            "Cognee rate limiting compatibility attributes are missing: "
            + ", ".join(missing)
        )

    llm_config = rate_limiting_module.llm_config
    if bool(getattr(llm_config, "llm_rate_limit_enabled", False)) or bool(
        getattr(llm_config, "embedding_rate_limit_enabled", False)
    ):
        raise ValueError(
            "Cognee native rate limit settings cannot be combined with DramaClaw "
            "pipeline concurrency controls"
        )

    rate_limiting_module.llm_rate_limiter = llm_pipeline_limiter
    rate_limiting_module.embedding_rate_limiter = embedding_pipeline_limiter
    llm_config.llm_rate_limit_enabled = True
    llm_config.embedding_rate_limit_enabled = True
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

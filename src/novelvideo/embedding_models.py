"""Project-bound Cognee embedding model selection and request scoping."""

from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator

from novelvideo.model_gateway_settings import (
    MODE_CUSTOM,
    MODE_OFFICIAL,
    get_ce_newapi_config_for_mode,
    get_effective_newapi_config,
    get_newapi_embedding_model_config,
)
from novelvideo.official_defaults import OFFICIAL_NEWAPI_BASE_URL
from novelvideo.shared.runtime_env import is_ce_effective

PROJECT_EMBEDDING_MODEL_KEY = "cognee_embedding_model"
COGNEE_EMBEDDING_MODEL_LEGACY = "DC-cognee-embedding"
COGNEE_EMBEDDING_MODEL_V1 = "DC-cognee-embedding-v1"
COGNEE_EMBEDDING_MODEL_V2 = "DC-cognee-embedding-v2"
COGNEE_EMBEDDING_DIMENSIONS = 1024


@dataclass(frozen=True)
class EmbeddingModelSpec:
    internal_model: str
    dimensions: int
    send_dimensions: bool
    gateway: str


_CURRENT_COGNEE_EMBEDDING_SPEC: ContextVar[EmbeddingModelSpec | None] = ContextVar(
    "current_cognee_embedding_spec",
    default=None,
)


def _environment_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def active_gateway_uses_custom_embedding() -> bool:
    """Return whether new projects should bind to the CE custom model alias."""

    if not is_ce_effective():
        return False
    return get_effective_newapi_config().mode == MODE_CUSTOM


def embedding_model_for_new_project() -> str:
    """Choose the permanent model binding for a project created now."""

    if active_gateway_uses_custom_embedding():
        return COGNEE_EMBEDDING_MODEL_LEGACY
    return COGNEE_EMBEDDING_MODEL_V2


def embedding_model_for_legacy_project() -> str:
    """Choose the compatibility binding for a pre-versioning project."""

    if active_gateway_uses_custom_embedding():
        return COGNEE_EMBEDDING_MODEL_LEGACY
    return COGNEE_EMBEDDING_MODEL_V1


def embedding_model_spec(model: str) -> EmbeddingModelSpec:
    """Resolve and strictly validate one persisted internal model name."""

    clean_model = str(model or "").strip()
    if clean_model == COGNEE_EMBEDDING_MODEL_V1:
        return EmbeddingModelSpec(
            internal_model=clean_model,
            dimensions=COGNEE_EMBEDDING_DIMENSIONS,
            send_dimensions=False,
            gateway=MODE_OFFICIAL,
        )
    if clean_model == COGNEE_EMBEDDING_MODEL_V2:
        return EmbeddingModelSpec(
            internal_model=clean_model,
            dimensions=COGNEE_EMBEDDING_DIMENSIONS,
            send_dimensions=True,
            gateway=MODE_OFFICIAL,
        )
    if clean_model == COGNEE_EMBEDDING_MODEL_LEGACY:
        if not is_ce_effective():
            raise RuntimeError(
                "DC-cognee-embedding is reserved for CE custom NewAPI projects"
            )
        saved = get_newapi_embedding_model_config()
        dimensions = int(saved.get("dimension") or COGNEE_EMBEDDING_DIMENSIONS)
        if dimensions != COGNEE_EMBEDDING_DIMENSIONS:
            raise RuntimeError(
                "Unsupported CE custom embedding dimension: "
                f"expected {COGNEE_EMBEDDING_DIMENSIONS}, configured {dimensions}"
            )
        return EmbeddingModelSpec(
            internal_model=clean_model,
            dimensions=dimensions,
            send_dimensions=bool(
                saved.get(
                    "sendDimensions",
                    _environment_flag("COGNEE_EMBEDDING_SEND_DIMENSIONS", True),
                )
            ),
            gateway=MODE_CUSTOM,
        )
    raise RuntimeError(f"Unsupported embedding model: {clean_model or '<empty>'}")


def embedding_gateway_credentials(spec: EmbeddingModelSpec) -> tuple[str, str]:
    """Resolve credentials for the gateway permanently implied by a model spec."""

    if is_ce_effective():
        gateway = get_ce_newapi_config_for_mode(spec.gateway)
        return gateway.api_key, gateway.base_url
    if spec.gateway != MODE_OFFICIAL:
        raise RuntimeError("Custom embedding gateway is only available in CE")
    gateway = get_effective_newapi_config(official_base_url=OFFICIAL_NEWAPI_BASE_URL)
    return gateway.api_key, gateway.base_url


def current_embedding_model_spec() -> EmbeddingModelSpec | None:
    return _CURRENT_COGNEE_EMBEDDING_SPEC.get()


def require_current_embedding_model_spec() -> EmbeddingModelSpec:
    spec = current_embedding_model_spec()
    if spec is None:
        raise RuntimeError("Cognee embedding request has no project model context")
    return spec


@contextmanager
def embedding_model_scope(model: str) -> Iterator[EmbeddingModelSpec]:
    """Bind one project's embedding model to all calls in the current async context."""

    spec = embedding_model_spec(model)
    token = _CURRENT_COGNEE_EMBEDDING_SPEC.set(spec)
    try:
        yield spec
    finally:
        _CURRENT_COGNEE_EMBEDDING_SPEC.reset(token)

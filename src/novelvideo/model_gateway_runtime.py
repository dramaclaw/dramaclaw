"""Runtime refresh helpers for model gateway settings.

The settings database is the source of truth, but several integrations still
read OpenAI-compatible credentials from process memory. Refresh these values
after UI writes so new requests do not reuse credentials from a previous save.
"""

from __future__ import annotations

import hashlib
import os
import sys
from datetime import datetime, timezone
from typing import Any

from novelvideo.model_gateway_settings import get_effective_newapi_config


def _set_or_clear_env(key: str, value: str) -> None:
    clean = str(value or "").strip()
    if clean:
        os.environ[key] = clean
    else:
        os.environ.pop(key, None)


def _runtime_version(api_key: str, base_url: str) -> str:
    material = f"{base_url}\n{api_key}".encode("utf-8")
    digest = hashlib.sha256(material).hexdigest()[:16]
    return f"{datetime.now(timezone.utc).isoformat()}:{digest}"


def _clear_agent_singletons() -> list[str]:
    cleared: list[str] = []
    targets = {
        "novelvideo.freezone.text_node": ("_translation_agent", "_story_script_agent"),
        "novelvideo.freezone.image_node": ("_reverse_prompt_agent",),
        "novelvideo.agents.video_prompt_builder": ("_video_prompt_builder",),
        "novelvideo.agents.keyframe_prompt_builder": ("_keyframe_prompt_builder",),
        "novelvideo.agents.global_video_optimizer": ("_global_video_optimizer",),
        "novelvideo.agents.character_fixer": ("_fixer_agent",),
        "novelvideo.agents.character_reviewer": ("_reviewer_agent",),
        "novelvideo.api.routes.freezone": ("_agent_review_frame_reviewer",),
    }
    for module_name, attrs in targets.items():
        module = sys.modules.get(module_name)
        if module is None:
            continue
        for attr in attrs:
            if hasattr(module, attr):
                setattr(module, attr, None)
                cleared.append(f"{module_name}.{attr}")
    return cleared


def _refresh_cognee_runtime() -> str:
    module = sys.modules.get("novelvideo.cognee.config")
    if module is None:
        return "not_loaded"

    init_cognee = getattr(module, "init_cognee", None)
    if callable(init_cognee):
        init_cognee()
        return "refreshed"

    clear_embedding_cache = getattr(module, "_clear_cognee_embedding_config_cache", None)
    if callable(clear_embedding_cache):
        clear_embedding_cache()
    return "partial"


def refresh_model_gateway_runtime() -> dict[str, Any]:
    """Refresh process-local runtime state after model gateway DB writes.

    Running jobs keep their already-created clients. New requests and new
    cached agents will resolve the latest settings from settings.db.
    """

    from novelvideo import config as app_config

    gateway = get_effective_newapi_config(
        official_base_url=app_config.OFFICIAL_NEWAPI_BASE_URL,
        official_api_key=app_config.NEWAPI_API_KEY,
    )
    api_key = str(gateway.api_key or "").strip()
    base_url = str(gateway.base_url or "").strip().rstrip("/")
    version = _runtime_version(api_key, base_url)

    _set_or_clear_env("MODEL_GATEWAY_RUNTIME_VERSION", version)
    _set_or_clear_env("MODEL_GATEWAY_MODE", gateway.mode)
    _set_or_clear_env("NEWAPI_API_KEY", api_key)
    _set_or_clear_env("NEWAPI_BASE_URL", base_url)

    # Legacy OpenAI-compatible paths in LiteLLM/PydanticAI/OpenAI SDK read these
    # variables directly. Keep them aligned with the selected gateway.
    _set_or_clear_env("OPENAI_API_KEY", api_key)
    _set_or_clear_env("OPENAI_API_BASE", base_url)
    _set_or_clear_env("OPENAI_BASE_URL", base_url)
    _set_or_clear_env("LLM_API_KEY", api_key)
    _set_or_clear_env("LLM_ENDPOINT", base_url)
    _set_or_clear_env("EMBEDDING_API_KEY", api_key)
    _set_or_clear_env("EMBEDDING_ENDPOINT", base_url)
    _set_or_clear_env("COGNEE_LLM_API_KEY", api_key)
    _set_or_clear_env("COGNEE_LLM_ENDPOINT", base_url)
    _set_or_clear_env("COGNEE_EMBEDDING_API_KEY", api_key)
    _set_or_clear_env("COGNEE_EMBEDDING_ENDPOINT", base_url)

    cleared = _clear_agent_singletons()
    cognee_status = "not_loaded"
    try:
        cognee_status = _refresh_cognee_runtime()
    except Exception as exc:
        cognee_status = f"error:{type(exc).__name__}"

    return {
        "mode": gateway.mode,
        "source": gateway.source,
        "configured": bool(api_key and base_url),
        "runtimeVersion": version,
        "clearedCaches": cleared,
        "cognee": cognee_status,
    }

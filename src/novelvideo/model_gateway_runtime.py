"""CE cache invalidation helpers for dynamic model gateway settings."""

from __future__ import annotations

import hashlib
import sys
from typing import Any

from novelvideo.model_gateway_settings import get_effective_newapi_config
from novelvideo.shared.runtime_env import is_ce_effective


def _runtime_version(api_key: str, base_url: str) -> str:
    material = f"{base_url}\n{api_key}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:16]


def _clear_agent_singletons() -> list[str]:
    cleared: list[str] = []
    targets = {
        "novelvideo.freezone.text_node": ("_translation_agent", "_story_script_agent"),
        "novelvideo.agents.global_video_optimizer": ("_global_video_optimizer",),
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


def _cognee_runtime_status() -> str:
    module = sys.modules.get("novelvideo.cognee.config")
    if module is None:
        return "not_loaded"
    restart_required = getattr(module, "cognee_gateway_restart_required", None)
    if callable(restart_required) and restart_required():
        return "restart_required"
    return "ready"


def refresh_model_gateway_runtime() -> dict[str, Any]:
    """Invalidate CE caches after a model gateway settings.db write.

    Dynamic CE settings are never copied into process environment variables.
    Cognee is process-global and must be restarted after its active gateway
    changes; Hermes performs its own worker fingerprint rotation.
    """

    if not is_ce_effective():
        raise RuntimeError("model gateway runtime refresh is only available in CE")

    from novelvideo import config as app_config

    gateway = get_effective_newapi_config(
        official_base_url=app_config.OFFICIAL_NEWAPI_BASE_URL,
        official_api_key=app_config.NEWAPI_API_KEY,
    )
    api_key = str(gateway.api_key or "").strip()
    base_url = str(gateway.base_url or "").strip().rstrip("/")
    version = _runtime_version(api_key, base_url)

    cleared = _clear_agent_singletons()

    return {
        "mode": gateway.mode,
        "source": gateway.source,
        "configured": bool(api_key and base_url),
        "runtimeVersion": version,
        "clearedCaches": cleared,
        "cognee": _cognee_runtime_status(),
    }

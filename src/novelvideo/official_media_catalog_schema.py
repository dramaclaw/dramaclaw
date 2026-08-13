"""Dependency-free validation for the official media model catalog."""

from __future__ import annotations

from typing import Any

from novelvideo.media_model_request_schema import (
    validate_media_model_catalog_config,
    validate_media_request_schema,
)


def catalog_version(payload: dict[str, Any]) -> tuple[int, ...]:
    raw = str(payload.get("catalogVersion") or "").strip()
    parts = raw.split(".")
    if not raw or any(not part.isdigit() for part in parts):
        raise ValueError("catalogVersion must contain dot-separated numbers")
    return tuple(int(part) for part in parts)


def validate_official_media_catalog(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("official media catalog must be a JSON object")
    if type(payload.get("version")) is not int or payload["version"] != 1:
        raise ValueError("unsupported official media catalog schema version")
    catalog_version(payload)
    models = payload.get("mediaModels")
    if not isinstance(models, dict) or not models:
        raise ValueError("official media catalog must contain mediaModels")
    for model, item in models.items():
        if not str(model).strip() or not isinstance(item, dict):
            raise ValueError("official media catalog contains an invalid model")
        media_type = str(item.get("mediaType") or "").strip().lower()
        if media_type not in {"image", "video", "audio"}:
            raise ValueError(f"invalid mediaType for official media model {model}")
        if not str(item.get("provider") or "").strip():
            raise ValueError(f"provider is required for official media model {model}")
        if not str(item.get("upstreamModel") or "").strip():
            raise ValueError(f"upstreamModel is required for official media model {model}")
        if "enabled" in item and not isinstance(item["enabled"], bool):
            raise ValueError(f"enabled must be boolean for official media model {model}")
        if "sortOrder" in item and (
            isinstance(item["sortOrder"], bool)
            or not isinstance(item["sortOrder"], int)
        ):
            raise ValueError(
                f"sortOrder must be an integer for official media model {model}"
            )
        aliases = item.get("aliases")
        if aliases is not None and (
            not isinstance(aliases, list)
            or any(not isinstance(alias, str) or not alias.strip() for alias in aliases)
            or len(set(aliases)) != len(aliases)
        ):
            raise ValueError(
                f"aliases must contain unique non-empty strings for official media model {model}"
            )
        config = item.get("config", {})
        if media_type in {"image", "video"}:
            validate_media_model_catalog_config(config, media_type)
        elif not isinstance(config, dict):
            raise ValueError(f"config must be an object for official media model {model}")
        else:
            validate_media_request_schema(config.get("request"))
    return payload

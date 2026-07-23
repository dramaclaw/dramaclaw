"""Runtime model gateway settings.

CE persists the selected official or bundled-NewAPI gateway in local settings,
which are its sole runtime credential source. EE has a control-plane DSN and
keeps its deployment environment as the sole credential source.
"""

from __future__ import annotations

import os
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from novelvideo.official_defaults import (
    DEFAULT_COGNEE_EMBEDDING_DIM,
    DEFAULT_COGNEE_EMBEDDING_MODEL,
    DEFAULT_COGNEE_EMBEDDING_PROVIDER,
    DEFAULT_EMBEDDING_BATCH_SIZE,
    OFFICIAL_NEWAPI_BASE_URL,
)
from novelvideo.shared.runtime_env import is_ce_effective
from novelvideo.sqlite_pragmas import configure_sqlite_connection

MODE_OFFICIAL = "official"
MODE_CUSTOM = "custom"
VALID_MODES = {MODE_OFFICIAL, MODE_CUSTOM}
PLACEHOLDER_API_KEYS = {
    "your_newapi_token",
    "your_model_api_key",
    "your_api_key",
    "your_dc_key",
}


@dataclass(frozen=True)
class EffectiveNewApiConfig:
    mode: str
    source: str
    base_url: str
    api_key: str


@dataclass(frozen=True)
class EffectiveMediaRelayConfig:
    source: str
    provider: str
    ttl_seconds: int
    endpoint: str
    bucket: str
    access_key_id: str
    access_key_secret: str
    cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""
    cloudinary_folder: str = ""


@dataclass(frozen=True)
class EffectiveCogneeEmbeddingConfig:
    source: str
    provider: str
    model: str
    dimensions: str
    upstream_provider: str
    upstream_model: str
    batch_size: str = ""


def mask_secret(value: str) -> str:
    clean = str(value or "").strip()
    if not clean:
        return ""
    if len(clean) <= 10:
        return "*" * len(clean)
    return f"{clean[:4]}...{clean[-4:]}"


def normalize_api_key(value: str | None) -> str:
    clean = str(value or "").strip()
    if not clean:
        return ""
    lowered = clean.lower()
    if lowered in PLACEHOLDER_API_KEYS:
        return ""
    if lowered.startswith("your_") or lowered.startswith("<your_"):
        return ""
    return clean


def normalize_gateway_mode(value: str | None) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in VALID_MODES else MODE_OFFICIAL


def normalize_relay_base_url(value: str | None) -> str:
    base = str(value or "").strip().rstrip("/")
    if not base:
        return ""
    if base.endswith("/v1"):
        return base
    return f"{base}/v1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _settings_db_path() -> Path:
    from novelvideo import config

    return Path(config.STATE_DIR) / "local" / "settings.db"


def _connect() -> sqlite3.Connection:
    path = _settings_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    configure_sqlite_connection(conn)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runtime_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """)
    conn.commit()
    return conn


def _read_all() -> dict[str, str]:
    conn = _connect()
    try:
        rows = conn.execute("SELECT key, value FROM runtime_settings").fetchall()
        return {str(row["key"]): str(row["value"]) for row in rows}
    finally:
        conn.close()


def _uses_ce_gateway_settings() -> bool:
    """Return whether this process owns the CE-local gateway settings database."""
    return is_ce_effective()


def _write_many(values: dict[str, str]) -> None:
    now = _now_iso()
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        for key, value in values.items():
            conn.execute(
                """
                INSERT INTO runtime_settings(key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, str(value or ""), now),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def set_model_gateway_mode(mode: str) -> None:
    _write_many({"model_gateway_mode": normalize_gateway_mode(mode)})


def save_official_newapi_key(
    *,
    api_key: str,
    activate: bool = True,
) -> None:
    values = {
        "official_newapi_api_key": str(api_key or "").strip(),
    }
    if activate:
        values["model_gateway_mode"] = MODE_OFFICIAL
    _write_many(values)


def save_custom_newapi_gateway(
    *,
    base_url: str,
    api_key: str,
    admin_base_url: str = "",
    token_name: str = "",
    token_id: int | str = "",
    activate: bool = True,
) -> None:
    values = {
        "custom_newapi_base_url": normalize_relay_base_url(base_url),
        "custom_newapi_api_key": str(api_key or "").strip(),
        "custom_newapi_admin_base_url": str(admin_base_url or "").strip().rstrip("/"),
        "custom_newapi_token_name": str(token_name or "").strip(),
        "custom_newapi_token_id": str(token_id or "").strip(),
    }
    if activate:
        values["model_gateway_mode"] = MODE_CUSTOM
    _write_many(values)


def save_newapi_database_config(
    *,
    sql_dsn: str,
    sqlite_path: str = "",
    admin_username: str = "",
) -> None:
    _write_many(
        {
            "custom_newapi_db_sql_dsn": str(sql_dsn or "").strip(),
            "custom_newapi_db_sqlite_path": str(sqlite_path or "").strip(),
            "custom_newapi_admin_username": str(admin_username or "").strip(),
        }
    )


def _decode_provider_channels(value: str | None) -> list[dict[str, str]]:
    if not value:
        return []
    try:
        raw = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(raw, list):
        return []

    channels: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        provider = str(item.get("provider") or "").strip().lower()
        if not provider or provider in seen:
            continue
        seen.add(provider)
        channels.append(
            {
                "provider": provider,
                "upstreamKey": str(item.get("upstreamKey") or "").strip(),
                "baseUrl": str(item.get("baseUrl") or "").strip().rstrip("/"),
            }
        )
    return channels


def _decode_media_model_mappings(value: str | None) -> dict[str, dict[str, str]]:
    if not value:
        return {}
    try:
        raw = json.loads(value)
    except json.JSONDecodeError:
        return {}
    if not isinstance(raw, dict):
        return {}

    mappings: dict[str, dict[str, str]] = {}
    for model, item in raw.items():
        model_name = str(model or "").strip()
        if not model_name or not isinstance(item, dict):
            continue
        provider = str(item.get("provider") or "").strip().lower()
        if not provider:
            continue
        mappings[model_name] = {
            "provider": provider,
            "upstreamModel": str(item.get("upstreamModel") or "").strip(),
        }
    return mappings


def _decode_embedding_model_config(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        raw = json.loads(value)
    except json.JSONDecodeError:
        return {}
    if not isinstance(raw, dict):
        return {}

    provider = str(raw.get("provider") or "").strip().lower()
    upstream_model = str(raw.get("upstreamModel") or "").strip()
    dimensions = _int_setting(
        str(raw.get("dimension") or raw.get("dimensions") or ""), 0
    )
    batch_size = _int_setting(
        str(raw.get("batchSize") or raw.get("batch_size") or ""), 0
    )
    if not provider or not upstream_model or dimensions <= 0:
        return {}
    result: dict[str, Any] = {
        "provider": provider,
        "upstreamModel": upstream_model,
        "dimension": dimensions,
        # Retain the field for API compatibility, but request behavior is an
        # internal model contract and cannot be disabled by saved CE settings.
        "sendDimensions": True,
        "internalModel": "DC-cognee-embedding",
    }
    if batch_size > 0:
        result["batchSize"] = batch_size
    return result


def get_newapi_provider_channels() -> list[dict[str, str]]:
    settings = get_model_gateway_settings()
    return _decode_provider_channels(settings.get("custom_newapi_provider_channels"))


def get_newapi_provider_channel(provider: str) -> dict[str, str] | None:
    wanted = str(provider or "").strip().lower()
    if not wanted:
        return None
    for channel in get_newapi_provider_channels():
        if channel["provider"] == wanted:
            return channel
    return None


def save_newapi_provider_channels(
    channels: list[dict[str, str]],
) -> list[dict[str, str]]:
    existing_by_provider = {
        channel["provider"]: channel for channel in get_newapi_provider_channels()
    }
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in channels:
        provider = str(item.get("provider") or "").strip().lower()
        if not provider or provider in seen:
            continue
        seen.add(provider)
        previous = existing_by_provider.get(provider, {})
        upstream_key = str(item.get("upstreamKey") or "").strip() or previous.get(
            "upstreamKey",
            "",
        )
        base_url = str(item.get("baseUrl") or "").strip().rstrip("/")
        if not upstream_key:
            raise ValueError(f"upstreamKey is required for provider {provider}")
        normalized.append(
            {
                "provider": provider,
                "upstreamKey": upstream_key,
                "baseUrl": base_url,
            }
        )
    _write_many(
        {
            "custom_newapi_provider_channels": json.dumps(
                normalized,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        }
    )
    return normalized


def get_newapi_media_model_mappings() -> dict[str, dict[str, str]]:
    settings = get_model_gateway_settings()
    return _decode_media_model_mappings(
        settings.get("custom_newapi_media_model_mappings")
    )


def save_newapi_media_model_mappings(
    mappings: dict[str, dict[str, str]],
) -> dict[str, dict[str, str]]:
    normalized: dict[str, dict[str, str]] = {}
    for model, item in mappings.items():
        model_name = str(model or "").strip()
        if not model_name:
            continue
        provider = str(item.get("provider") or "").strip().lower()
        if not provider:
            raise ValueError(f"provider is required for media model {model_name}")
        normalized[model_name] = {
            "provider": provider,
            "upstreamModel": str(item.get("upstreamModel") or "").strip(),
        }
    _write_many(
        {
            "custom_newapi_media_model_mappings": json.dumps(
                normalized,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        }
    )
    return normalized


def build_newapi_media_model_mappings_status() -> dict[str, dict[str, str]]:
    return get_newapi_media_model_mappings()


def get_newapi_embedding_model_config() -> dict[str, Any]:
    settings = get_model_gateway_settings()
    return _decode_embedding_model_config(settings.get("custom_newapi_embedding_model"))


def save_newapi_embedding_model_config(
    *,
    provider: str,
    upstream_model: str,
    dimension: int | str,
    batch_size: int | str | None = None,
    send_dimensions: bool = True,
) -> dict[str, Any]:
    normalized_provider = str(provider or "").strip().lower()
    normalized_upstream_model = str(upstream_model or "").strip()
    normalized_dimension = _int_setting(str(dimension), 0)
    normalized_batch_size = _int_setting(str(batch_size or ""), 0)
    if not normalized_provider:
        raise ValueError("provider is required for embedding model")
    if not normalized_upstream_model:
        raise ValueError("upstreamModel is required for embedding model")
    if normalized_dimension <= 0:
        raise ValueError("dimension must be positive")
    if batch_size not in (None, "") and normalized_batch_size <= 0:
        raise ValueError("batchSize must be positive")
    config = {
        "provider": normalized_provider,
        "upstreamModel": normalized_upstream_model,
        "dimension": normalized_dimension,
        "sendDimensions": True,
        "internalModel": "DC-cognee-embedding",
    }
    if normalized_batch_size > 0:
        config["batchSize"] = normalized_batch_size
    _write_many(
        {
            "custom_newapi_embedding_model": json.dumps(
                config,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        }
    )
    return config


def build_newapi_embedding_model_status() -> dict[str, Any]:
    return get_newapi_embedding_model_config()


def build_newapi_provider_channels_status() -> list[dict[str, Any]]:
    return [
        {
            "provider": channel["provider"],
            "configured": bool(channel["upstreamKey"]),
            "upstreamKeyPreview": mask_secret(channel["upstreamKey"]),
            "baseUrl": channel["baseUrl"],
        }
        for channel in get_newapi_provider_channels()
    ]


def save_media_relay_config(
    *,
    provider: str,
    ttl_seconds: int,
    endpoint: str = "",
    bucket: str = "",
    access_key_id: str = "",
    access_key_secret: str = "",
    cloud_name: str = "",
    cloudinary_api_key: str = "",
    cloudinary_api_secret: str = "",
    cloudinary_folder: str = "",
) -> None:
    _write_many(
        {
            "media_relay_provider": str(provider or "").strip().lower(),
            "media_relay_ttl_seconds": str(int(ttl_seconds)),
            "oss_relay_endpoint": str(endpoint or "").strip(),
            "oss_relay_bucket": str(bucket or "").strip(),
            "oss_relay_ak": str(access_key_id or "").strip(),
            "oss_relay_sk": str(access_key_secret or "").strip(),
            "cloudinary_relay_cloud_name": str(cloud_name or "").strip(),
            "cloudinary_relay_api_key": str(cloudinary_api_key or "").strip(),
            "cloudinary_relay_api_secret": str(cloudinary_api_secret or "").strip(),
            "cloudinary_relay_folder": str(cloudinary_folder or "").strip().strip("/"),
        }
    )


def get_model_gateway_settings() -> dict[str, str]:
    data = _read_all()
    data.setdefault("model_gateway_mode", MODE_OFFICIAL)
    return data


def get_effective_newapi_config(
    *,
    official_base_url: str | None = None,
    official_api_key: str | None = None,
) -> EffectiveNewApiConfig:
    if not _uses_ce_gateway_settings():
        return EffectiveNewApiConfig(
            mode=MODE_OFFICIAL,
            source="environment",
            base_url=normalize_relay_base_url(
                os.environ.get("NEWAPI_BASE_URL", "")
                or official_base_url
                or OFFICIAL_NEWAPI_BASE_URL
            ),
            api_key=normalize_api_key(
                official_api_key
                if official_api_key is not None
                else os.environ.get("NEWAPI_API_KEY", "")
            ),
        )

    settings = get_model_gateway_settings()
    mode = normalize_gateway_mode(settings.get("model_gateway_mode"))
    return get_ce_newapi_config_for_mode(mode)


def get_ce_newapi_config_for_mode(mode: str) -> EffectiveNewApiConfig:
    """Return CE credentials for one gateway without changing the active mode.

    Embedding projects can remain bound to the gateway that created their vector
    space even when the installation's general model gateway is switched later.
    """

    if not _uses_ce_gateway_settings():
        raise RuntimeError("CE model gateway settings are not available in EE")

    settings = get_model_gateway_settings()
    mode = normalize_gateway_mode(mode)
    if mode == MODE_CUSTOM:
        return EffectiveNewApiConfig(
            mode=MODE_CUSTOM,
            source="custom",
            base_url=normalize_relay_base_url(settings.get("custom_newapi_base_url", "")),
            api_key=normalize_api_key(settings.get("custom_newapi_api_key", "")),
        )
    db_official_api_key = normalize_api_key(settings.get("official_newapi_api_key", ""))
    return EffectiveNewApiConfig(
        mode=MODE_OFFICIAL,
        source="official",
        base_url=normalize_relay_base_url(OFFICIAL_NEWAPI_BASE_URL),
        api_key=db_official_api_key,
    )


def _int_setting(value: str | None, default: int) -> int:
    try:
        return int(str(value or "").strip())
    except ValueError:
        return default


def _bool_setting(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def get_effective_media_relay_config(
    *,
    env_provider: str | None = None,
    env_ttl_seconds: int | str | None = None,
    env_endpoint: str | None = None,
    env_bucket: str | None = None,
    env_access_key_id: str | None = None,
    env_access_key_secret: str | None = None,
    env_cloud_name: str | None = None,
    env_cloudinary_api_key: str | None = None,
    env_cloudinary_api_secret: str | None = None,
    env_cloudinary_folder: str | None = None,
) -> EffectiveMediaRelayConfig:
    settings = get_model_gateway_settings() if _uses_ce_gateway_settings() else {}
    db_provider = str(settings.get("media_relay_provider", "")).strip().lower()
    db_endpoint = str(settings.get("oss_relay_endpoint", "")).strip()
    db_bucket = str(settings.get("oss_relay_bucket", "")).strip()
    db_access_key_id = str(settings.get("oss_relay_ak", "")).strip()
    db_access_key_secret = str(settings.get("oss_relay_sk", "")).strip()
    db_cloud_name = str(settings.get("cloudinary_relay_cloud_name", "")).strip()
    db_cloudinary_api_key = str(settings.get("cloudinary_relay_api_key", "")).strip()
    db_cloudinary_api_secret = str(
        settings.get("cloudinary_relay_api_secret", "")
    ).strip()
    db_cloudinary_folder = (
        str(settings.get("cloudinary_relay_folder", "")).strip().strip("/")
    )
    has_db_config = any(
        [
            db_provider,
            db_endpoint,
            db_bucket,
            db_access_key_id,
            db_access_key_secret,
            db_cloud_name,
            db_cloudinary_api_key,
            db_cloudinary_api_secret,
            db_cloudinary_folder,
        ]
    )
    if has_db_config:
        return EffectiveMediaRelayConfig(
            source="database",
            provider=db_provider or "aliyun_oss",
            ttl_seconds=_int_setting(settings.get("media_relay_ttl_seconds"), 1800),
            endpoint=db_endpoint,
            bucket=db_bucket,
            access_key_id=db_access_key_id,
            access_key_secret=db_access_key_secret,
            cloud_name=db_cloud_name,
            cloudinary_api_key=db_cloudinary_api_key,
            cloudinary_api_secret=db_cloudinary_api_secret,
            cloudinary_folder=db_cloudinary_folder,
        )

    raw_ttl = (
        env_ttl_seconds
        if env_ttl_seconds is not None
        else os.environ.get(
            "MEDIA_RELAY_TTL_SECONDS",
            "1800",
        )
    )
    return EffectiveMediaRelayConfig(
        source="environment",
        provider=str(
            env_provider or os.environ.get("MEDIA_RELAY_PROVIDER", "aliyun_oss")
        )
        .strip()
        .lower(),
        ttl_seconds=_int_setting(str(raw_ttl), 1800),
        endpoint=str(env_endpoint or os.environ.get("OSS_RELAY_ENDPOINT", "")).strip(),
        bucket=str(env_bucket or os.environ.get("OSS_RELAY_BUCKET", "")).strip(),
        access_key_id=str(
            env_access_key_id or os.environ.get("OSS_RELAY_AK", "")
        ).strip(),
        access_key_secret=str(
            env_access_key_secret or os.environ.get("OSS_RELAY_SK", "")
        ).strip(),
        cloud_name=str(
            env_cloud_name or os.environ.get("CLOUDINARY_RELAY_CLOUD_NAME", "")
        ).strip(),
        cloudinary_api_key=str(
            env_cloudinary_api_key or os.environ.get("CLOUDINARY_RELAY_API_KEY", "")
        ).strip(),
        cloudinary_api_secret=str(
            env_cloudinary_api_secret
            or os.environ.get("CLOUDINARY_RELAY_API_SECRET", "")
        ).strip(),
        cloudinary_folder=str(
            env_cloudinary_folder or os.environ.get("CLOUDINARY_RELAY_FOLDER", "")
        )
        .strip()
        .strip("/"),
    )


def get_effective_cognee_embedding_config(
    *,
    env_provider: str | None = None,
    env_model: str | None = None,
    env_dimensions: str | int | None = None,
    llm_provider: str | None = None,
) -> EffectiveCogneeEmbeddingConfig:
    saved: dict[str, Any] = {}
    if _uses_ce_gateway_settings():
        gateway = get_effective_newapi_config()
        if gateway.mode == MODE_CUSTOM:
            saved = get_newapi_embedding_model_config()
    if saved:
        saved_batch_size = str(
            saved.get("batchSize")
            or os.environ.get("EMBEDDING_BATCH_SIZE", DEFAULT_EMBEDDING_BATCH_SIZE)
        ).strip()
        if saved_batch_size:
            saved_batch_size = str(_int_setting(saved_batch_size, 0) or "")
        return EffectiveCogneeEmbeddingConfig(
            source="database",
            provider="newapi",
            model=str(saved["internalModel"]),
            dimensions=str(saved["dimension"]),
            upstream_provider=str(saved["provider"]),
            upstream_model=str(saved["upstreamModel"]),
            batch_size=saved_batch_size or DEFAULT_EMBEDDING_BATCH_SIZE,
        )

    # Product runtime always sends embeddings through newAPI. Keep the
    # arguments for API compatibility, but do not let legacy provider settings
    # bypass the gateway.
    del env_provider, llm_provider
    provider = DEFAULT_COGNEE_EMBEDDING_PROVIDER
    default_model = DEFAULT_COGNEE_EMBEDDING_MODEL
    model = str(
        env_model or os.environ.get("COGNEE_EMBEDDING_MODEL", default_model)
    ).strip()
    dimensions = (
        str(
            env_dimensions
            if env_dimensions is not None
            else os.environ.get("COGNEE_EMBEDDING_DIM", DEFAULT_COGNEE_EMBEDDING_DIM)
        ).strip()
        or DEFAULT_COGNEE_EMBEDDING_DIM
    )
    batch_size = str(
        os.environ.get("EMBEDDING_BATCH_SIZE", DEFAULT_EMBEDDING_BATCH_SIZE)
    ).strip()
    if batch_size:
        batch_size = str(_int_setting(batch_size, 0) or "")
    if not batch_size:
        batch_size = DEFAULT_EMBEDDING_BATCH_SIZE
    return EffectiveCogneeEmbeddingConfig(
        source="environment",
        provider=provider,
        model=model,
        dimensions=dimensions,
        upstream_provider="",
        upstream_model="",
        batch_size=batch_size,
    )


def build_model_gateway_status(
    *,
    official_base_url: str | None = None,
    official_api_key: str | None = None,
) -> dict[str, Any]:
    uses_ce_settings = _uses_ce_gateway_settings()
    settings = get_model_gateway_settings() if uses_ce_settings else {}
    official_base_url_value = normalize_relay_base_url(
        OFFICIAL_NEWAPI_BASE_URL
        if uses_ce_settings
        else (
            os.environ.get("NEWAPI_BASE_URL", "")
            or official_base_url
            or OFFICIAL_NEWAPI_BASE_URL
        )
    )
    env_official_api_key = (
        ""
        if uses_ce_settings
        else normalize_api_key(
            official_api_key
            if official_api_key is not None
            else os.environ.get("NEWAPI_API_KEY", "")
        )
    )
    db_official_api_key = (
        normalize_api_key(settings.get("official_newapi_api_key", ""))
        if uses_ce_settings
        else ""
    )
    official_api_key_value = (
        db_official_api_key if uses_ce_settings else env_official_api_key
    )
    custom_base_url = (
        normalize_relay_base_url(settings.get("custom_newapi_base_url", ""))
        if uses_ce_settings
        else ""
    )
    custom_api_key = (
        normalize_api_key(settings.get("custom_newapi_api_key", ""))
        if uses_ce_settings
        else ""
    )
    effective = get_effective_newapi_config(
        official_base_url=official_base_url,
        official_api_key=official_api_key,
    )
    return {
        "mode": effective.mode,
        "effective": {
            "source": effective.source,
            "baseUrl": effective.base_url,
            "apiKeyPreview": mask_secret(effective.api_key),
            "configured": bool(effective.base_url and effective.api_key),
        },
        "official": {
            "baseUrl": official_base_url_value,
            "apiKeyPreview": mask_secret(official_api_key_value),
            "configured": bool(official_base_url_value and official_api_key_value),
            "source": "database" if uses_ce_settings else "environment",
            "environment": {
                "baseUrl": official_base_url_value,
                "apiKeyPreview": mask_secret(env_official_api_key),
                "configured": bool(official_base_url_value and env_official_api_key),
            },
        },
        "custom": {
            "baseUrl": custom_base_url,
            "apiKeyPreview": mask_secret(custom_api_key),
            "configured": bool(custom_base_url and custom_api_key),
            "adminBaseUrl": settings.get("custom_newapi_admin_base_url", ""),
            "tokenName": settings.get("custom_newapi_token_name", ""),
            "tokenId": settings.get("custom_newapi_token_id", ""),
        },
    }


def build_newapi_database_status(
    *,
    sql_dsn: str | None = None,
    sqlite_path: str | None = None,
    admin_username: str | None = None,
) -> dict[str, Any]:
    settings = get_model_gateway_settings()
    db_sql_dsn = str(settings.get("custom_newapi_db_sql_dsn", "")).strip()
    db_sqlite_path = str(settings.get("custom_newapi_db_sqlite_path", "")).strip()
    db_admin_username = str(settings.get("custom_newapi_admin_username", "")).strip()
    env_sql_dsn = str(
        sql_dsn if sql_dsn is not None else os.environ.get("NEWAPI_SQL_DSN", "")
    )
    env_sql_dsn = env_sql_dsn.strip()
    env_sqlite_path = str(
        sqlite_path
        if sqlite_path is not None
        else os.environ.get("NEWAPI_SQLITE_PATH", "")
    ).strip()
    if not db_sql_dsn and not env_sql_dsn:
        from novelvideo.config import STATE_DIR

        env_sql_dsn = "local"
        env_sqlite_path = env_sqlite_path or str(
            Path(STATE_DIR) / "newapi" / "one-api.db"
        )
    effective_sql_dsn = db_sql_dsn or env_sql_dsn
    effective_sqlite_path = db_sqlite_path or env_sqlite_path
    source = (
        "database"
        if any([db_sql_dsn, db_sqlite_path, db_admin_username])
        else "environment"
    )
    configured = bool(
        effective_sql_dsn
        and (effective_sql_dsn != "local" or effective_sqlite_path)
    )
    available = configured
    if effective_sql_dsn == "local":
        available = bool(
            effective_sqlite_path
            and Path(effective_sqlite_path).expanduser().is_file()
        )
    return {
        "configured": configured,
        "available": available,
        "source": source,
        "databaseType": "sqlite" if effective_sql_dsn == "local" else "external",
    }


def build_media_relay_status(
    *,
    env_provider: str | None = None,
    env_ttl_seconds: int | str | None = None,
    env_endpoint: str | None = None,
    env_bucket: str | None = None,
    env_access_key_id: str | None = None,
    env_access_key_secret: str | None = None,
    env_cloud_name: str | None = None,
    env_cloudinary_api_key: str | None = None,
    env_cloudinary_api_secret: str | None = None,
    env_cloudinary_folder: str | None = None,
) -> dict[str, Any]:
    effective = get_effective_media_relay_config(
        env_provider=env_provider,
        env_ttl_seconds=env_ttl_seconds,
        env_endpoint=env_endpoint,
        env_bucket=env_bucket,
        env_access_key_id=env_access_key_id,
        env_access_key_secret=env_access_key_secret,
        env_cloud_name=env_cloud_name,
        env_cloudinary_api_key=env_cloudinary_api_key,
        env_cloudinary_api_secret=env_cloudinary_api_secret,
        env_cloudinary_folder=env_cloudinary_folder,
    )
    aliyun_configured = bool(
        effective.endpoint
        and effective.bucket
        and effective.access_key_id
        and effective.access_key_secret
    )
    cloudinary_configured = bool(
        effective.cloud_name
        and effective.cloudinary_api_key
        and effective.cloudinary_api_secret
    )
    return {
        "source": effective.source,
        "provider": effective.provider,
        "ttlSeconds": effective.ttl_seconds,
        "endpoint": effective.endpoint,
        "bucket": effective.bucket,
        "accessKeyIdPreview": mask_secret(effective.access_key_id),
        "accessKeySecretPreview": mask_secret(effective.access_key_secret),
        "cloudName": effective.cloud_name,
        "cloudinaryApiKeyPreview": mask_secret(effective.cloudinary_api_key),
        "cloudinaryApiSecretPreview": mask_secret(effective.cloudinary_api_secret),
        "apiFolder": effective.cloudinary_folder,
        "configured": (
            cloudinary_configured
            if effective.provider == "cloudinary"
            else aliyun_configured
        ),
    }

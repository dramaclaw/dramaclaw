"""Model gateway configuration endpoints for CE."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from novelvideo import config as app_config
from novelvideo.model_gateway_settings import (
    MODE_OFFICIAL,
    build_media_relay_status,
    build_model_gateway_status,
    normalize_relay_base_url,
    normalize_api_key,
    save_media_relay_config,
    save_official_newapi_key,
    save_custom_newapi_gateway,
    save_newapi_database_config,
    save_newapi_embedding_model_config,
    save_newapi_media_model_mappings,
    save_newapi_provider_channels,
    get_newapi_provider_channel,
    set_model_gateway_mode,
)
from novelvideo.model_gateway_runtime import refresh_model_gateway_runtime
from novelvideo.newapi_provisioner import (
    build_channel_payload,
    build_provisioner_status,
    create_or_reuse_relay_token,
    ensure_newapi_setup,
    ensure_admin_access_token,
    get_provisioner_config,
    mask_token,
    NewApiSetupCredentials,
    require_provisioner_enabled,
    upsert_channel,
    update_provider_channel_credentials,
)

router = APIRouter(prefix="/model-gateway")


CUSTOM_MEDIA_MODEL_NAMES = {
    "gpt-image-2",
    "nano-banana-2",
    "seedance-1.0-pro-fast",
    "seedance-1.5-pro",
    "seedance-2.0",
    "seedance-2.0-fast",
    "happyhorse-1.0",
    "index-tts-2",
    "eleven-music",
}
OFFICIAL_ONLY_MEDIA_MODEL_NAMES = {
    "seedance-2.0-value",
    "seedance-2.0-fast-value",
}


class OfficialGatewayBody(BaseModel):
    new_api_api_key: str = Field(alias="newApiApiKey")


class MediaRelayConfigBody(BaseModel):
    provider: str = "aliyun_oss"
    ttl_seconds: int = Field(default=1800, alias="ttlSeconds")
    endpoint: str = ""
    bucket: str = ""
    access_key_id: str = Field(default="", alias="accessKeyId")
    access_key_secret: str = Field(default="", alias="accessKeySecret")
    cloud_name: str = Field(default="", alias="cloudName")
    cloudinary_api_key: str = Field(default="", alias="apiKey")
    cloudinary_api_secret: str = Field(default="", alias="apiSecret")
    cloudinary_folder: str = Field(default="", alias="apiFolder")


class NewApiDatabaseBody(BaseModel):
    sql_dsn: str | None = Field(default=None, alias="sqlDsn")
    sqlite_path: str | None = Field(default=None, alias="sqlitePath")
    admin_username: str | None = Field(default=None, alias="adminUsername")


class NewApiInitBody(BaseModel):
    new_api_base_url: str | None = Field(default=None, alias="newApiBaseUrl")
    database: NewApiDatabaseBody | None = None
    setup_username: str | None = Field(default=None, alias="setupUsername")
    setup_password: str | None = Field(default=None, alias="setupPassword")
    setup_confirm_password: str | None = Field(
        default=None, alias="setupConfirmPassword"
    )
    token_name: str | None = Field(default=None, alias="tokenName")
    group: str = "default"
    unlimited_quota: bool = Field(default=True, alias="unlimitedQuota")
    remain_quota: int = Field(default=0, alias="remainQuota")
    expired_time: int = Field(default=-1, alias="expiredTime")
    reuse_existing: bool = Field(default=True, alias="reuseExisting")


class CreateChannelBody(BaseModel):
    new_api_base_url: str | None = Field(default=None, alias="newApiBaseUrl")
    database: NewApiDatabaseBody | None = None
    provider: str = "ali"
    type: int | None = None
    name: str | None = None
    upstream_key: str | None = Field(default=None, alias="upstreamKey")
    model_mapping: dict[str, str] = Field(alias="modelMapping")
    group: str = "default"
    priority: int = 0
    weight: int = 0
    base_url: str | None = Field(default=None, alias="baseUrl")
    test_model: str | None = Field(default=None, alias="testModel")


class ChannelSpec(BaseModel):
    provider: str = "ali"
    type: int | None = None
    name: str | None = None
    upstream_key: str | None = Field(default=None, alias="upstreamKey")
    model_mapping: dict[str, str] = Field(alias="modelMapping")
    group: str = "default"
    priority: int = 0
    weight: int = 0
    base_url: str | None = Field(default=None, alias="baseUrl")
    test_model: str | None = Field(default=None, alias="testModel")


class CreateChannelsBatchBody(BaseModel):
    new_api_base_url: str | None = Field(default=None, alias="newApiBaseUrl")
    database: NewApiDatabaseBody | None = None
    channels: list[ChannelSpec] = Field(min_length=1)


class ProviderChannelConfigBody(BaseModel):
    provider: str
    upstream_key: str | None = Field(default=None, alias="upstreamKey")
    base_url: str | None = Field(default=None, alias="baseUrl")


class SaveProviderChannelsBody(BaseModel):
    channels: list[ProviderChannelConfigBody] = Field(default_factory=list)


class SyncProviderChannelBody(BaseModel):
    new_api_base_url: str | None = Field(default=None, alias="newApiBaseUrl")
    database: NewApiDatabaseBody | None = None
    provider: str
    upstream_key: str | None = Field(default=None, alias="upstreamKey")
    base_url: str | None = Field(default=None, alias="baseUrl")


class MediaModelConfigBody(BaseModel):
    provider: str
    upstream_model: str | None = Field(default=None, alias="upstreamModel")


class SaveMediaModelsBody(BaseModel):
    new_api_base_url: str | None = Field(default=None, alias="newApiBaseUrl")
    database: NewApiDatabaseBody | None = None
    models: dict[str, MediaModelConfigBody] = Field(default_factory=dict)


class SaveEmbeddingModelBody(BaseModel):
    new_api_base_url: str | None = Field(default=None, alias="newApiBaseUrl")
    database: NewApiDatabaseBody | None = None
    provider: str
    upstream_model: str = Field(alias="upstreamModel")
    dimension: int
    batch_size: int | None = Field(default=None, alias="batchSize")


def _permission_error(exc: PermissionError) -> HTTPException:
    return HTTPException(status_code=403, detail=str(exc))


def _get_provisioner_config_from_request(
    new_api_base_url: str | None,
    database: NewApiDatabaseBody | None,
):
    return get_provisioner_config(
        new_api_base_url,
        sql_dsn=database.sql_dsn if database else None,
        sqlite_path=database.sqlite_path if database else None,
        admin_username=database.admin_username if database else None,
    )


def _save_request_database_config(
    cfg,
    database: NewApiDatabaseBody | None,
) -> None:
    if database is None:
        return
    save_newapi_database_config(
        sql_dsn=cfg.sql_dsn,
        sqlite_path=cfg.sqlite_path,
        admin_username=cfg.admin_username,
    )


def _setup_credentials_from_request(body: NewApiInitBody) -> NewApiSetupCredentials:
    username = (body.setup_username or "").strip()
    if not username and body.database and body.database.admin_username:
        username = body.database.admin_username.strip()
    return NewApiSetupCredentials(
        username=username,
        password=body.setup_password or "",
        confirm_password=body.setup_confirm_password or "",
        self_use_mode_enabled=True,
        demo_site_enabled=False,
    )


def _build_channel_payload_from_spec(
    spec: ChannelSpec | CreateChannelBody,
) -> dict[str, Any]:
    saved_channel = get_newapi_provider_channel(spec.provider) or {}
    return build_channel_payload(
        provider=spec.provider,
        channel_type=spec.type,
        name=spec.name,
        upstream_key=spec.upstream_key or saved_channel.get("upstreamKey", ""),
        model_mapping=spec.model_mapping,
        group=spec.group,
        priority=spec.priority,
        weight=spec.weight,
        base_url=spec.base_url or saved_channel.get("baseUrl", ""),
        test_model=spec.test_model,
    )


def _build_media_model_channel_specs(
    models: dict[str, MediaModelConfigBody],
) -> tuple[list[ChannelSpec], dict[str, dict[str, str]]]:
    if not models:
        raise ValueError("models must be a non-empty JSON object")

    grouped: dict[str, dict[str, str]] = {}
    normalized: dict[str, dict[str, str]] = {}
    for raw_model, item in models.items():
        model = str(raw_model or "").strip()
        if not model:
            raise ValueError("models contains an empty model name")
        if model in OFFICIAL_ONLY_MEDIA_MODEL_NAMES:
            raise ValueError(f"media model {model} is official-channel only")
        if model not in CUSTOM_MEDIA_MODEL_NAMES:
            raise ValueError(f"unsupported media model: {model}")
        provider = str(item.provider or "").strip().lower()
        if not provider:
            raise ValueError(f"provider is required for media model {model}")
        upstream_model = (item.upstream_model or "").strip() or model
        grouped.setdefault(provider, {})[model] = upstream_model
        normalized[model] = {
            "provider": provider,
            "upstreamModel": "" if upstream_model == model else upstream_model,
        }

    specs = [
        ChannelSpec(provider=provider, modelMapping=mapping)
        for provider, mapping in grouped.items()
    ]
    return specs, normalized


def _build_embedding_model_channel_spec(
    body: SaveEmbeddingModelBody,
) -> tuple[ChannelSpec, dict[str, Any]]:
    provider = str(body.provider or "").strip().lower()
    upstream_model = str(body.upstream_model or "").strip()
    dimension = int(body.dimension)
    batch_size = int(body.batch_size or 0)
    if not provider:
        raise ValueError("provider is required for embedding model")
    if not upstream_model:
        raise ValueError("upstreamModel is required for embedding model")
    if dimension <= 0:
        raise ValueError("dimension must be positive")
    if body.batch_size is not None and batch_size <= 0:
        raise ValueError("batchSize must be positive")
    normalized = {
        "provider": provider,
        "upstreamModel": upstream_model,
        "dimension": dimension,
        "internalModel": "DC-cognee-embedding",
    }
    if batch_size > 0:
        normalized["batchSize"] = batch_size
    return (
        ChannelSpec(
            provider=provider,
            modelMapping={"DC-cognee-embedding": upstream_model},
        ),
        normalized,
    )


def _mask_sent_channel_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        **payload,
        "channel": {
            **payload["channel"],
            "key": mask_token(payload["channel"]["key"]),
        },
    }


def _media_relay_status() -> dict[str, Any]:
    return build_media_relay_status(
        env_provider=app_config.MEDIA_RELAY_PROVIDER,
        env_ttl_seconds=app_config.MEDIA_RELAY_TTL_SECONDS,
        env_endpoint=app_config.OSS_RELAY_ENDPOINT,
        env_bucket=app_config.OSS_RELAY_BUCKET,
        env_access_key_id=app_config.OSS_RELAY_AK,
        env_access_key_secret=app_config.OSS_RELAY_SK,
        env_cloud_name=app_config.CLOUDINARY_RELAY_CLOUD_NAME,
        env_cloudinary_api_key=app_config.CLOUDINARY_RELAY_API_KEY,
        env_cloudinary_api_secret=app_config.CLOUDINARY_RELAY_API_SECRET,
        env_cloudinary_folder=app_config.CLOUDINARY_RELAY_FOLDER,
    )


@router.get("/config")
async def get_model_gateway_config() -> dict[str, Any]:
    return {
        "ok": True,
        "data": {
            **build_model_gateway_status(
                official_base_url=app_config.OFFICIAL_NEWAPI_BASE_URL,
                official_api_key=app_config.NEWAPI_API_KEY,
            ),
            "provisioner": build_provisioner_status(),
            "mediaRelay": _media_relay_status(),
        },
    }


@router.post("/official/enable")
async def enable_official_gateway() -> dict[str, Any]:
    try:
        require_provisioner_enabled()
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    status = build_model_gateway_status(
        official_base_url=app_config.OFFICIAL_NEWAPI_BASE_URL,
        official_api_key=app_config.NEWAPI_API_KEY,
    )
    if not status["official"]["configured"]:
        raise HTTPException(
            status_code=400,
            detail="official NewAPI gateway is not configured",
        )
    set_model_gateway_mode(MODE_OFFICIAL)
    runtime = refresh_model_gateway_runtime()
    return {
        "ok": True,
        "data": build_model_gateway_status(
            official_base_url=app_config.OFFICIAL_NEWAPI_BASE_URL,
            official_api_key=app_config.NEWAPI_API_KEY,
        ),
        "runtime": runtime,
    }


@router.post("/official/config")
async def save_official_gateway_config(body: OfficialGatewayBody) -> dict[str, Any]:
    try:
        require_provisioner_enabled()
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    api_key = normalize_api_key(body.new_api_api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="newApiApiKey is required")
    save_official_newapi_key(api_key=api_key, activate=True)
    runtime = refresh_model_gateway_runtime()
    return {
        "ok": True,
        "data": build_model_gateway_status(
            official_base_url=app_config.OFFICIAL_NEWAPI_BASE_URL,
            official_api_key=app_config.NEWAPI_API_KEY,
        ),
        "runtime": runtime,
    }


@router.post("/media-relay/config")
async def save_media_relay_settings(body: MediaRelayConfigBody) -> dict[str, Any]:
    try:
        require_provisioner_enabled()
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    provider = body.provider.strip().lower()
    if provider not in {"aliyun_oss", "cloudinary"}:
        raise HTTPException(status_code=400, detail="unsupported media relay provider")
    if body.ttl_seconds <= 0:
        raise HTTPException(status_code=400, detail="ttlSeconds must be positive")
    endpoint = body.endpoint.strip()
    bucket = body.bucket.strip()
    access_key_id = body.access_key_id.strip()
    access_key_secret = body.access_key_secret.strip()
    cloud_name = body.cloud_name.strip()
    cloudinary_api_key = body.cloudinary_api_key.strip()
    cloudinary_api_secret = body.cloudinary_api_secret.strip()
    cloudinary_folder = body.cloudinary_folder.strip().strip("/")
    if provider == "cloudinary":
        required = {
            "cloudName": cloud_name,
            "apiKey": cloudinary_api_key,
            "apiSecret": cloudinary_api_secret,
        }
    else:
        required = {
            "endpoint": endpoint,
            "bucket": bucket,
            "accessKeyId": access_key_id,
            "accessKeySecret": access_key_secret,
        }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise HTTPException(
            status_code=400, detail=f"missing fields: {', '.join(missing)}"
        )
    save_media_relay_config(
        provider=provider,
        ttl_seconds=body.ttl_seconds,
        endpoint=endpoint,
        bucket=bucket,
        access_key_id=access_key_id,
        access_key_secret=access_key_secret,
        cloud_name=cloud_name,
        cloudinary_api_key=cloudinary_api_key,
        cloudinary_api_secret=cloudinary_api_secret,
        cloudinary_folder=cloudinary_folder,
    )
    return {"ok": True, "data": _media_relay_status()}


@router.post("/custom/newapi/init")
async def init_custom_newapi(body: NewApiInitBody = NewApiInitBody()) -> dict[str, Any]:
    try:
        require_provisioner_enabled()
        cfg = _get_provisioner_config_from_request(body.new_api_base_url, body.database)
        setup_status = ensure_newapi_setup(cfg, _setup_credentials_from_request(body))
        admin = ensure_admin_access_token(cfg)
        token_name = (
            body.token_name or cfg.relay_token_name
        ).strip() or cfg.relay_token_name
        token = create_or_reuse_relay_token(
            cfg,
            admin,
            name=token_name,
            group=body.group,
            unlimited_quota=body.unlimited_quota,
            remain_quota=body.remain_quota,
            expired_time=body.expired_time,
            reuse_existing=body.reuse_existing,
        )
        relay_base_url = normalize_relay_base_url(cfg.admin_base_url)
        save_custom_newapi_gateway(
            base_url=relay_base_url,
            api_key=token["key"],
            admin_base_url=cfg.admin_base_url,
            token_name=str(token["name"]),
            token_id=token["tokenId"],
            activate=True,
        )
        _save_request_database_config(cfg, body.database)
        runtime = refresh_model_gateway_runtime()
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "ok": True,
        "data": {
            "mode": "custom",
            "newApiAdminBaseUrl": cfg.admin_base_url,
            "newApiBaseUrl": relay_base_url,
            "adminUserId": admin.admin_user_id,
            "adminUsername": admin.admin_username,
            "adminTokenCreated": admin.token_created,
            "adminTokenPreview": mask_token(admin.access_token),
            "newApiSetup": {
                "initialized": setup_status.initialized,
                "rootInitialized": setup_status.root_initialized,
                "databaseType": setup_status.database_type,
                "setupPerformed": setup_status.setup_performed,
                "alreadyInitialized": setup_status.already_initialized,
            },
            "relayToken": {
                "created": bool(token["created"]),
                "tokenId": token["tokenId"],
                "name": token["name"],
                "keyPreview": token["keyPreview"],
            },
            "database": build_provisioner_status()["database"],
            "effective": build_model_gateway_status(
                official_base_url=app_config.OFFICIAL_NEWAPI_BASE_URL,
                official_api_key=app_config.NEWAPI_API_KEY,
            )["effective"],
            "runtime": runtime,
        },
    }


@router.post("/custom/newapi/provider-channels")
async def save_custom_newapi_provider_channels(
    body: SaveProviderChannelsBody,
) -> dict[str, Any]:
    try:
        require_provisioner_enabled()
        saved = save_newapi_provider_channels(
            [
                {
                    "provider": channel.provider,
                    "upstreamKey": channel.upstream_key or "",
                    "baseUrl": channel.base_url or "",
                }
                for channel in body.channels
            ]
        )
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "ok": True,
        "data": {
            "channels": [
                {
                    "provider": channel["provider"],
                    "configured": bool(channel["upstreamKey"]),
                    "upstreamKeyPreview": mask_token(channel["upstreamKey"]),
                    "baseUrl": channel["baseUrl"],
                }
                for channel in saved
            ]
        },
    }


@router.post("/custom/newapi/provider-channel/sync")
async def sync_custom_newapi_provider_channel(
    body: SyncProviderChannelBody,
) -> dict[str, Any]:
    provider = str(body.provider or "").strip().lower()
    if not provider:
        raise HTTPException(status_code=400, detail="provider is required")
    try:
        require_provisioner_enabled()
        saved_channel = get_newapi_provider_channel(provider) or {}
        upstream_key = (body.upstream_key or "").strip() or saved_channel.get(
            "upstreamKey", ""
        )
        if not upstream_key:
            raise ValueError(f"upstreamKey is required for provider {provider}")
        base_url = (
            body.base_url
            if body.base_url is not None
            else saved_channel.get("baseUrl", "")
        )
        cfg = _get_provisioner_config_from_request(body.new_api_base_url, body.database)
        admin = ensure_admin_access_token(cfg)
        result = update_provider_channel_credentials(
            cfg,
            admin,
            provider=provider,
            upstream_key=upstream_key,
            base_url=base_url,
        )
        saved = []
        if result.get("ok"):
            saved = save_newapi_provider_channels(
                [
                    {
                        "provider": provider,
                        "upstreamKey": upstream_key,
                        "baseUrl": base_url or "",
                    }
                ]
            )
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    sent_payload = result.get("sentPayload")
    return {
        "ok": result["ok"],
        "data": {
            "provider": provider,
            "channelId": result.get("channelId"),
            "httpStatus": result.get("httpStatus"),
            "newApiResponse": result.get("newApiResponse"),
            "sentPayload": (
                _mask_sent_channel_payload(sent_payload)
                if isinstance(sent_payload, dict) and "channel" in sent_payload
                else sent_payload
            ),
            "savedChannel": next(
                (
                    {
                        "provider": channel["provider"],
                        "configured": bool(channel["upstreamKey"]),
                        "upstreamKeyPreview": mask_token(channel["upstreamKey"]),
                        "baseUrl": channel["baseUrl"],
                    }
                    for channel in saved
                    if channel["provider"] == provider
                ),
                None,
            ),
        },
    }


@router.post("/custom/newapi/channels")
async def create_custom_newapi_channel(body: CreateChannelBody) -> dict[str, Any]:
    try:
        require_provisioner_enabled()
        cfg = _get_provisioner_config_from_request(body.new_api_base_url, body.database)
        admin = ensure_admin_access_token(cfg)
        payload = _build_channel_payload_from_spec(body)
        result = upsert_channel(cfg, admin, payload)
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "ok": result["ok"],
        "data": {
            "newApiAdminBaseUrl": cfg.admin_base_url,
            "httpStatus": result["httpStatus"],
            "newApiResponse": result["newApiResponse"],
            "action": result.get("action"),
            "channelId": result.get("channelId"),
            "sentPayload": _mask_sent_channel_payload(
                result.get("sentPayload") or payload
            ),
        },
    }


@router.post("/custom/newapi/channels/batch")
async def create_custom_newapi_channels_batch(
    body: CreateChannelsBatchBody,
) -> dict[str, Any]:
    try:
        require_provisioner_enabled()
        cfg = _get_provisioner_config_from_request(body.new_api_base_url, body.database)
        admin = ensure_admin_access_token(cfg)
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    results: list[dict[str, Any]] = []
    for index, channel in enumerate(body.channels):
        try:
            payload = _build_channel_payload_from_spec(channel)
            result = upsert_channel(cfg, admin, payload)
            item: dict[str, Any] = {
                "index": index,
                "ok": result["ok"],
                "httpStatus": result["httpStatus"],
                "newApiResponse": result["newApiResponse"],
                "action": result.get("action"),
                "channelId": result.get("channelId"),
                "sentPayload": _mask_sent_channel_payload(
                    result.get("sentPayload") or payload
                ),
            }
            if not result["ok"]:
                item["error"] = "NewAPI rejected channel creation"
            results.append(item)
        except Exception as exc:
            results.append(
                {
                    "index": index,
                    "ok": False,
                    "error": str(exc),
                }
            )

    succeeded = sum(1 for item in results if item["ok"])
    failed = len(results) - succeeded
    return {
        "ok": failed == 0,
        "data": {
            "newApiAdminBaseUrl": cfg.admin_base_url,
            "total": len(results),
            "succeeded": succeeded,
            "failed": failed,
            "results": results,
        },
    }


@router.post("/custom/newapi/embedding-model")
async def save_custom_newapi_embedding_model(
    body: SaveEmbeddingModelBody,
) -> dict[str, Any]:
    try:
        require_provisioner_enabled()
        spec, normalized_model = _build_embedding_model_channel_spec(body)
        cfg = _get_provisioner_config_from_request(body.new_api_base_url, body.database)
        admin = ensure_admin_access_token(cfg)
        payload = _build_channel_payload_from_spec(spec)
        result = upsert_channel(cfg, admin, payload)
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    item: dict[str, Any] = {
        "provider": spec.provider,
        "ok": result["ok"],
        "httpStatus": result["httpStatus"],
        "newApiResponse": result["newApiResponse"],
        "action": result.get("action"),
        "channelId": result.get("channelId"),
        "sentPayload": _mask_sent_channel_payload(result.get("sentPayload") or payload),
    }
    if not result["ok"]:
        response = result.get("newApiResponse")
        message = ""
        if isinstance(response, dict):
            message = str(
                response.get("message") or response.get("error") or ""
            ).strip()
        item["error"] = message or "NewAPI rejected embedding model channel update"
        return {
            "ok": False,
            "data": {
                "newApiAdminBaseUrl": cfg.admin_base_url,
                "embeddingModel": {},
                "result": item,
            },
        }

    saved = save_newapi_embedding_model_config(
        provider=normalized_model["provider"],
        upstream_model=normalized_model["upstreamModel"],
        dimension=normalized_model["dimension"],
        batch_size=normalized_model.get("batchSize"),
    )
    return {
        "ok": True,
        "data": {
            "newApiAdminBaseUrl": cfg.admin_base_url,
            "embeddingModel": saved,
            "result": item,
        },
    }


@router.post("/custom/newapi/media-models")
async def save_custom_newapi_media_models(body: SaveMediaModelsBody) -> dict[str, Any]:
    try:
        require_provisioner_enabled()
        specs, normalized_models = _build_media_model_channel_specs(body.models)
        cfg = _get_provisioner_config_from_request(body.new_api_base_url, body.database)
        admin = ensure_admin_access_token(cfg)
    except PermissionError as exc:
        raise _permission_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    results: list[dict[str, Any]] = []
    for index, channel in enumerate(specs):
        try:
            payload = _build_channel_payload_from_spec(channel)
            result = upsert_channel(cfg, admin, payload)
            item: dict[str, Any] = {
                "index": index,
                "provider": channel.provider,
                "ok": result["ok"],
                "httpStatus": result["httpStatus"],
                "newApiResponse": result["newApiResponse"],
                "action": result.get("action"),
                "channelId": result.get("channelId"),
                "sentPayload": _mask_sent_channel_payload(
                    result.get("sentPayload") or payload
                ),
            }
            if not result["ok"]:
                response = result.get("newApiResponse")
                message = ""
                if isinstance(response, dict):
                    message = str(
                        response.get("message") or response.get("error") or ""
                    ).strip()
                item["error"] = message or "NewAPI rejected media model channel update"
            results.append(item)
        except Exception as exc:
            results.append(
                {
                    "index": index,
                    "provider": channel.provider,
                    "ok": False,
                    "error": str(exc),
                }
            )

    succeeded = sum(1 for item in results if item["ok"])
    failed = len(results) - succeeded
    if failed == 0:
        save_newapi_media_model_mappings(normalized_models)

    return {
        "ok": failed == 0,
        "data": {
            "newApiAdminBaseUrl": cfg.admin_base_url,
            "total": len(results),
            "succeeded": succeeded,
            "failed": failed,
            "models": normalized_models if failed == 0 else {},
            "results": results,
        },
    }

"""Read/write checks for CE-owned media relay storage, before paid requests."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import threading
import time
import uuid
from datetime import datetime, timezone
from dataclasses import asdict

import httpx

from novelvideo import config
from novelvideo.model_gateway_settings import (
    EffectiveMediaRelayConfig,
    get_effective_media_relay_config,
)
from novelvideo.shared.runtime_env import uses_local_ce_runtime
from novelvideo.storage.media_relay import (
    AliyunOSSRelay,
    CloudinaryRelay,
    MediaRelayConfigError,
)

_PROBE_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)
_CACHE_TTL_SECONDS = 60.0
_PROBE_TIMEOUT_SECONDS = 5.0
_probe_lock = threading.Lock()
_verified_config: tuple[str, float] | None = None


class MediaStorageUnavailable(MediaRelayConfigError):
    """A stable, credential-free error suitable for the CE task/settings UI."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def effective_media_storage_config() -> EffectiveMediaRelayConfig:
    """Use the same database-over-environment resolution as real relay uploads."""
    return get_effective_media_relay_config(
        env_provider=config.MEDIA_RELAY_PROVIDER,
        env_ttl_seconds=config.MEDIA_RELAY_TTL_SECONDS,
        env_endpoint=config.OSS_RELAY_ENDPOINT,
        env_bucket=config.OSS_RELAY_BUCKET,
        env_access_key_id=config.OSS_RELAY_AK,
        env_access_key_secret=config.OSS_RELAY_SK,
        env_cloud_name=config.CLOUDINARY_RELAY_CLOUD_NAME,
        env_cloudinary_api_key=config.CLOUDINARY_RELAY_API_KEY,
        env_cloudinary_api_secret=config.CLOUDINARY_RELAY_API_SECRET,
        env_cloudinary_folder=config.CLOUDINARY_RELAY_FOLDER,
    )


def _safe_probe_error(exc: Exception) -> MediaStorageUnavailable:
    code = getattr(exc, "code", "")
    status = getattr(exc, "status", None)
    # Cloudinary's adapter wraps HTTP errors; classify their status without
    # reflecting the provider's body, URL or credentials into a task error.
    if isinstance(exc.__cause__, httpx.HTTPStatusError):
        status = exc.__cause__.response.status_code
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)) or isinstance(
        exc.__cause__, (httpx.TimeoutException, TimeoutError)
    ):
        return MediaStorageUnavailable(
            "MEDIA_STORAGE_TIMEOUT", "媒体存储连接超时，请检查网络后重试。"
        )
    if (
        code
        in {
            "InvalidAccessKeyId",
            "SignatureDoesNotMatch",
            "InvalidSecurityToken",
            "SecurityTokenExpired",
        }
        or status == 401
    ):
        return MediaStorageUnavailable(
            "MEDIA_STORAGE_AUTH_INVALID",
            "媒体存储凭据无效，请检查 AccessKey / API Key。",
        )
    if code in {"AccessDenied", "AccessForbidden"} or status == 403:
        return MediaStorageUnavailable(
            "MEDIA_STORAGE_ACCESS_DENIED",
            "媒体存储拒绝访问，请检查凭据及上传、读取权限。",
        )
    if code in {"NoSuchBucket", "InvalidBucketName", "PermanentRedirect"} or status in {
        301,
        404,
    }:
        return MediaStorageUnavailable(
            "MEDIA_STORAGE_TARGET_INVALID",
            "媒体存储目标不可用，请检查 bucket、endpoint 或文件夹。",
        )
    if isinstance(exc, MediaRelayConfigError):
        return MediaStorageUnavailable(
            "MEDIA_STORAGE_CONFIG_INVALID",
            "媒体存储配置不完整或上传失败，请检查所选存储配置。",
        )
    return MediaStorageUnavailable(
        "MEDIA_STORAGE_UNAVAILABLE", "媒体存储读写验证失败，请检查连接和配置后重试。"
    )


def verify_media_storage(
    settings: EffectiveMediaRelayConfig, *, force: bool = False
) -> None:
    """Upload/read a small image, caching only success for the exact configuration.

    Probe objects use the normal relay prefix and random names. OSS cleanup is
    best effort: a key with PutObject/GetObject but no DeleteObject is valid.
    Cloudinary probes follow the configured folder's normal retention policy.
    """
    global _verified_config
    fingerprint = hashlib.sha256(
        json.dumps(asdict(settings), sort_keys=True).encode()
    ).hexdigest()
    with _probe_lock:
        if not force and _verified_config is not None:
            if (
                _verified_config[0] == fingerprint
                and time.monotonic() < _verified_config[1]
            ):
                return
        # Never retain a previous success after a failed fresh check.
        _verified_config = None
        bucket = None
        key = f"relay/{datetime.now(timezone.utc):%Y%m%d}/preflight-{uuid.uuid4().hex}.png"
        try:
            if settings.provider == "aliyun_oss":
                relay = AliyunOSSRelay(
                    endpoint=settings.endpoint,
                    bucket_name=settings.bucket,
                    access_key_id=settings.access_key_id,
                    access_key_secret=settings.access_key_secret,
                    connect_timeout=_PROBE_TIMEOUT_SECONDS,
                )
                bucket = relay._bucket
                url = relay.upload_bytes(_PROBE_PNG, object_key=key, ttl=60)
            elif settings.provider == "cloudinary":
                relay = CloudinaryRelay(
                    cloud_name=settings.cloud_name,
                    api_key=settings.cloudinary_api_key,
                    api_secret=settings.cloudinary_api_secret,
                    folder=settings.cloudinary_folder,
                    request_timeout=_PROBE_TIMEOUT_SECONDS,
                )
                url = relay.upload_bytes(_PROBE_PNG, object_key=key, ttl=60)
            else:
                raise MediaRelayConfigError("unsupported provider")
            with httpx.Client(
                timeout=_PROBE_TIMEOUT_SECONDS, follow_redirects=False
            ) as client:
                response = client.get(url)
                response.raise_for_status()
                if response.content != _PROBE_PNG:
                    raise MediaStorageUnavailable(
                        "MEDIA_STORAGE_READ_MISMATCH",
                        "媒体存储读取校验失败，请检查存储访问配置。",
                    )
        except MediaStorageUnavailable:
            raise
        except Exception as exc:
            raise _safe_probe_error(exc) from None
        finally:
            if bucket is not None:
                try:
                    bucket.delete_object(key)
                except Exception:
                    pass
        _verified_config = (fingerprint, time.monotonic() + _CACHE_TTL_SECONDS)


async def require_ce_media_storage() -> None:
    """Validate an explicitly configured relay, leaving local-only CE and EE alone."""
    if not uses_local_ce_runtime():
        return
    settings = effective_media_storage_config()
    if settings.provider == "aliyun_oss":
        configured = bool(settings.access_key_id or settings.access_key_secret)
    elif settings.provider == "cloudinary":
        configured = bool(
            settings.cloud_name
            or settings.cloudinary_api_key
            or settings.cloudinary_api_secret
        )
    else:
        raise MediaStorageUnavailable(
            "MEDIA_STORAGE_CONFIG_INVALID", "不支持的媒体存储类型。"
        )
    if configured:
        await asyncio.to_thread(verify_media_storage, settings)

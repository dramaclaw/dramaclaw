# SPDX-License-Identifier: Elastic-2.0
# SPDX-FileCopyrightText: 2026 SuperTale contributors
"""S3-compatible transient media relay using explicit, long-lived credentials."""

from __future__ import annotations

import mimetypes
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from novelvideo.storage.media_errors import (
    MediaRelayConfigError,
    safe_media_storage_error,
)
from novelvideo.storage.media_relay import (
    ServiceEgressDenied,
    _is_safe_object_key,
    _normalize_ext,
)

MAX_S3_TTL_SECONDS = 604800

if TYPE_CHECKING:
    from novelvideo.model_gateway_settings import EffectiveMediaRelayConfig


class S3Relay:
    """Upload reference media and return a model-fetchable signed GET URL."""

    def __init__(
        self,
        *,
        endpoint: str,
        bucket_name: str,
        access_key_id: str,
        access_key_secret: str,
        region: str = "us-east-1",
        path_style: bool = False,
        timeout: float = 30.0,
    ) -> None:
        endpoint = endpoint.strip().rstrip("/")
        try:
            parsed = urlsplit(endpoint)
            valid_endpoint = (
                parsed.scheme in {"http", "https"}
                and bool(parsed.hostname)
                and parsed.port != 0
                and parsed.username is None
                and parsed.password is None
                and not parsed.query
                and not parsed.fragment
                and parsed.path in {"", "/"}
            )
        except ValueError:
            valid_endpoint = False
        if not valid_endpoint:
            raise MediaRelayConfigError("S3 endpoint must be an http(s) origin URL")
        if not all(
            value.strip()
            for value in (bucket_name, access_key_id, access_key_secret, region)
        ):
            raise MediaRelayConfigError(
                "S3 bucket, region and credentials are required"
            )

        import boto3
        from botocore.config import Config

        self._bucket_name = bucket_name.strip()
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region.strip(),
            aws_access_key_id=access_key_id.strip(),
            aws_secret_access_key=access_key_secret.strip(),
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path" if path_style else "virtual"},
                connect_timeout=timeout,
                read_timeout=timeout,
                retries={"mode": "standard", "total_max_attempts": 1},
                # Avoid optional checksum encodings unsupported by some S3 servers.
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )

    def upload_bytes(
        self,
        data: bytes,
        *,
        ext: str = "png",
        ttl: int = 1800,
        resource_type: str = "image",
        object_key: str | None = None,
    ) -> str:
        if not data:
            raise ValueError("cannot relay empty media bytes")
        if not 0 < ttl <= MAX_S3_TTL_SECONDS:
            raise MediaRelayConfigError(
                "S3 URL TTL must be between 1 and 604800 seconds"
            )
        ext = _normalize_ext(ext)
        key = (
            object_key
            or f"relay/{datetime.now(timezone.utc):%Y%m%d}/{uuid.uuid4().hex}.{ext}"
        )
        if not _is_safe_object_key(key):
            raise ServiceEgressDenied("object-key")
        try:
            self._client.put_object(
                Bucket=self._bucket_name,
                Key=key,
                Body=data,
                ContentType=mimetypes.guess_type(f"media.{ext}")[0]
                or "application/octet-stream",
            )
            return self._client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._bucket_name, "Key": key},
                ExpiresIn=int(ttl),
            )
        except Exception as exc:
            raise safe_media_storage_error(exc) from None

    def upload_file(self, path: str | Path, *, ttl: int = 1800) -> str:
        path = Path(path)
        return self.upload_bytes(
            path.read_bytes(), ext=path.suffix.lstrip(".") or "png", ttl=ttl
        )

    def delete_object(self, key: str) -> None:
        """Clean up a preflight object; callers treat deletion as best effort."""
        self._client.delete_object(Bucket=self._bucket_name, Key=key)


def build_s3_relay(
    settings: EffectiveMediaRelayConfig, *, timeout: float = 30.0
) -> S3Relay:
    return S3Relay(
        endpoint=settings.s3_endpoint,
        bucket_name=settings.s3_bucket,
        access_key_id=settings.s3_access_key_id,
        access_key_secret=settings.s3_access_key_secret,
        region=settings.s3_region,
        path_style=settings.s3_path_style,
        timeout=timeout,
    )

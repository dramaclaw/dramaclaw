# SPDX-License-Identifier: Elastic-2.0
# SPDX-FileCopyrightText: 2026 SuperTale contributors
"""Shared, credential-free errors for media relay uploads and preflight."""

from __future__ import annotations

import httpx


class MediaRelayConfigError(RuntimeError):
    """Raised when the media relay is not configured for URL input."""


class MediaStorageUnavailable(MediaRelayConfigError):
    """A stable, credential-free error suitable for the CE task/settings UI."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def safe_media_storage_error(exc: Exception) -> MediaStorageUnavailable:
    if isinstance(exc, MediaStorageUnavailable):
        return exc
    from botocore.exceptions import ClientError, ConnectTimeoutError, ReadTimeoutError

    code = getattr(exc, "code", "")
    status = getattr(exc, "status", None)
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    # Cloudinary's adapter wraps HTTP errors; classify their status without
    # reflecting the provider's body, URL or credentials into a task error.
    if isinstance(exc.__cause__, httpx.HTTPStatusError):
        status = exc.__cause__.response.status_code
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
    if isinstance(
        exc, (httpx.TimeoutException, TimeoutError, ConnectTimeoutError, ReadTimeoutError)
    ) or isinstance(
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
            "ExpiredToken",
            "InvalidToken",
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
    if code in {
        "NoSuchBucket",
        "InvalidBucketName",
        "PermanentRedirect",
        "AuthorizationHeaderMalformed",
    } or status in {301, 404}:
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

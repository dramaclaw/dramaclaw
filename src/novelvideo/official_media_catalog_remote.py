"""Fetch versioned official media catalogs from OSS or a legacy direct URL."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

from novelvideo.model_gateway_settings import (
    get_official_media_catalog_remote_etag,
    get_official_media_catalog_update_status,
    install_official_media_catalog,
    record_official_media_catalog_check,
)

logger = logging.getLogger("novelvideo.official_media_catalog_remote")

DEFAULT_OFFICIAL_MEDIA_CATALOG_URL = (
    "https://raw.githubusercontent.com/dramaclaw/dramaclaw/main/"
    "src/novelvideo/official_media_models.json"
)
DEFAULT_OFFICIAL_MEDIA_CATALOG_MANIFEST_URL = (
    "https://dramaclaw-dl.oss-cn-chengdu.aliyuncs.com/"
    "official-media-catalog/manifest.json"
)
MAX_CATALOG_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_REVISION_RE = re.compile(r"^[0-9a-f]{7,64}$")


def _remote_source() -> tuple[str, bool]:
    configured_manifest_url = os.environ.get("OFFICIAL_MEDIA_CATALOG_MANIFEST_URL")
    if configured_manifest_url is not None:
        manifest_url = str(configured_manifest_url or "").strip()
        if manifest_url:
            return manifest_url, True
    configured_direct_url = os.environ.get("OFFICIAL_MEDIA_CATALOG_URL")
    if configured_direct_url is None:
        if configured_manifest_url is None:
            return DEFAULT_OFFICIAL_MEDIA_CATALOG_MANIFEST_URL, True
        configured_direct_url = DEFAULT_OFFICIAL_MEDIA_CATALOG_URL
    direct_url = str(configured_direct_url or "").strip()
    if not direct_url:
        raise ValueError("official media catalog URL is not configured")
    return direct_url, False


def _parse_published_at(value: object) -> str:
    published_at = str(value or "").strip()
    if not published_at:
        raise ValueError("official media catalog manifest has no publishedAt")
    try:
        parsed = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(
            "official media catalog manifest has invalid publishedAt"
        ) from exc
    if parsed.tzinfo is None:
        raise ValueError("official media catalog manifest publishedAt needs a timezone")
    return published_at


def validate_official_media_catalog_manifest(payload: object) -> dict[str, str]:
    if not isinstance(payload, dict):
        raise ValueError("official media catalog manifest must be a JSON object")
    if type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 1:
        raise ValueError("unsupported official media catalog manifest schema version")
    catalog_version = str(payload.get("catalogVersion") or "").strip()
    version_parts = catalog_version.split(".")
    if not catalog_version or any(not part.isdigit() for part in version_parts):
        raise ValueError("official media catalog manifest has invalid catalogVersion")
    revision = str(payload.get("revision") or "").strip().lower()
    if not _REVISION_RE.fullmatch(revision):
        raise ValueError("official media catalog manifest has invalid revision")
    sha256 = str(payload.get("sha256") or "").strip().lower()
    if not _SHA256_RE.fullmatch(sha256):
        raise ValueError("official media catalog manifest has invalid SHA256")
    path = str(payload.get("path") or "").strip()
    parsed_path = urlsplit(path)
    path_parts = parsed_path.path.split("/")
    if (
        not path
        or parsed_path.scheme
        or parsed_path.netloc
        or parsed_path.query
        or parsed_path.fragment
        or path.startswith("/")
        or ".." in path_parts
    ):
        raise ValueError("official media catalog manifest has invalid path")
    if path != f"catalogs/{sha256}.json":
        raise ValueError("official media catalog manifest path must use its SHA256")
    return {
        "catalogVersion": catalog_version,
        "revision": revision,
        "publishedAt": _parse_published_at(payload.get("publishedAt")),
        "sha256": sha256,
        "path": path,
    }


def _json_response(response: httpx.Response, *, maximum_bytes: int, name: str) -> Any:
    if len(response.content) > maximum_bytes:
        raise ValueError(f"official media catalog {name} is too large")
    try:
        return response.json()
    except json.JSONDecodeError as exc:
        raise ValueError(f"official media catalog {name} is not valid JSON") from exc


async def _check_with_client(
    client: httpx.AsyncClient, *, source_url: str, is_manifest: bool
) -> tuple[bool, dict[str, Any]]:
    headers = {"Accept": "application/json", "Cache-Control": "no-cache"}
    etag = get_official_media_catalog_remote_etag(source_url)
    if etag:
        headers["If-None-Match"] = etag
    response = await client.get(source_url, headers=headers)
    if response.status_code == 304:
        status = record_official_media_catalog_check(
            source_url=source_url,
            etag=response.headers.get("etag", "") or etag,
        )
        return False, status
    response.raise_for_status()

    if not is_manifest:
        payload = _json_response(
            response, maximum_bytes=MAX_CATALOG_BYTES, name="response"
        )
        if not isinstance(payload, dict):
            raise ValueError("official media catalog response must be a JSON object")
        return install_official_media_catalog(
            payload,
            source_url=source_url,
            etag=response.headers.get("etag", ""),
        )

    manifest = validate_official_media_catalog_manifest(
        _json_response(response, maximum_bytes=MAX_MANIFEST_BYTES, name="manifest")
    )
    catalog_url = urljoin(source_url, manifest["path"])
    catalog_response = await client.get(
        catalog_url,
        headers={"Accept": "application/json"},
    )
    catalog_response.raise_for_status()
    payload = _json_response(
        catalog_response, maximum_bytes=MAX_CATALOG_BYTES, name="content"
    )
    if not isinstance(payload, dict):
        raise ValueError("official media catalog content must be a JSON object")
    if str(payload.get("catalogVersion") or "").strip() != manifest["catalogVersion"]:
        raise ValueError("official media catalog version does not match manifest")
    return install_official_media_catalog(
        payload,
        source_url=source_url,
        expected_sha256=manifest["sha256"],
        revision=manifest["revision"],
        published_at=manifest["publishedAt"],
        etag=response.headers.get("etag", ""),
    )


async def check_official_media_catalog_update(
    client: httpx.AsyncClient | None = None,
) -> tuple[bool, dict[str, Any]]:
    source_url, is_manifest = _remote_source()
    try:
        if client is not None:
            return await _check_with_client(
                client, source_url=source_url, is_manifest=is_manifest
            )
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as owned:
            return await _check_with_client(
                owned, source_url=source_url, is_manifest=is_manifest
            )
    except (httpx.HTTPError, ValueError) as exc:
        record_official_media_catalog_check(source_url=source_url, error=str(exc))
        raise


def official_media_catalog_poll_seconds() -> int:
    raw = str(os.environ.get("OFFICIAL_MEDIA_CATALOG_POLL_SECONDS", "300") or "")
    try:
        return max(60, int(raw))
    except ValueError:
        return 300


async def run_official_media_catalog_updater() -> None:
    while True:
        try:
            status = get_official_media_catalog_update_status()
            if status["autoUpdate"]:
                updated, current = await check_official_media_catalog_update()
                logger.info(
                    "official media catalog checked updated=%s version=%s revision=%s sha256=%s",
                    updated,
                    current["catalogVersion"],
                    current["revision"] or "-",
                    current["sha256"],
                )
        except Exception:
            logger.warning("official media catalog update failed", exc_info=True)
        await asyncio.sleep(official_media_catalog_poll_seconds())

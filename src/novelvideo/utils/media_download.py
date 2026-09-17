"""Bounded-memory, atomic media downloads."""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import tempfile
from pathlib import Path

import aiohttp

from novelvideo.ports.video_delivery import VideoDeliveryError, VideoDeliveryReceipt

_CHUNK_SIZE = 1024 * 1024


async def download_to_path(
    url: str,
    output_path: str,
    *,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
) -> VideoDeliveryReceipt:
    """Stream media into a sibling temp file and atomically publish it."""

    destination = Path(output_path)
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{destination.name}.", suffix=".part", dir=destination.parent
        )
    except OSError as exc:
        raise VideoDeliveryError("VIDEO_PROJECT_WRITE_FAILED", retryable=True) from exc
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(fd, "wb") as stream:
            if url.startswith("data:"):
                header, separator, encoded = url.partition(",")
                if not separator or ";base64" not in header.lower() or not encoded:
                    raise VideoDeliveryError("VIDEO_DATA_URL_INVALID", retryable=False)
                try:
                    chunk = base64.b64decode(encoded, validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise VideoDeliveryError(
                        "VIDEO_DATA_URL_INVALID", retryable=False
                    ) from exc
                stream.write(chunk)
                digest.update(chunk)
                size = len(chunk)
            else:
                timeout = aiohttp.ClientTimeout(total=600)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.get(url) as response:
                        if response.status < 200 or response.status >= 300:
                            raise VideoDeliveryError(
                                f"VIDEO_DOWNLOAD_HTTP_{response.status}", retryable=True
                            )
                        async for chunk in response.content.iter_chunked(_CHUNK_SIZE):
                            stream.write(chunk)
                            digest.update(chunk)
                            size += len(chunk)
            stream.flush()
            os.fsync(stream.fileno())

        actual_sha256 = digest.hexdigest()
        if expected_size is not None and size != expected_size:
            raise VideoDeliveryError("VIDEO_ARCHIVE_SIZE_MISMATCH", retryable=True)
        if expected_sha256 and actual_sha256.lower() != expected_sha256.lower():
            raise VideoDeliveryError("VIDEO_ARCHIVE_SHA256_MISMATCH", retryable=True)
        os.replace(temp_name, destination)
        return VideoDeliveryReceipt(
            method="download",
            size=size,
            sha256=actual_sha256,
        )
    except Exception as exc:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        if isinstance(exc, VideoDeliveryError):
            raise
        if isinstance(exc, (aiohttp.ClientError, TimeoutError)):
            raise VideoDeliveryError("VIDEO_DOWNLOAD_FAILED", retryable=True) from exc
        if isinstance(exc, OSError):
            raise VideoDeliveryError(
                "VIDEO_PROJECT_WRITE_FAILED", retryable=True
            ) from exc
        raise

"""OSS presign helpers used by Seedance2 human-review media uploads.

The bucket is initialized lazily. Missing credentials or missing ``oss2`` SDK
return ``None`` so local development can continue without OSS.
"""

from __future__ import annotations

import logging
import threading
import time
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger("novelvideo.oss_client")

_bucket_lock = threading.Lock()
_bucket_state: dict = {"bucket": None, "tried": False}

_presign_cache: dict[tuple[str, int], tuple[str, float]] = {}
_presign_cache_lock = threading.Lock()

_static_ready_cache: set[tuple[str, int]] = set()
_static_ready_cache_lock = threading.Lock()

_SAFETY_WINDOW_S = 60.0


def _monotonic() -> float:
    return time.monotonic()


def _read_creds() -> tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    from novelvideo import config

    endpoint = getattr(config, "OSS_PUBLIC_ENDPOINT", None) or getattr(config, "OSS_ENDPOINT", None)
    return (
        endpoint,
        getattr(config, "OSS_BUCKET", None),
        getattr(config, "OSS_ACCESS_KEY_ID", None),
        getattr(config, "OSS_ACCESS_KEY_SECRET", None),
    )


def get_bucket():
    """Return a lazy ``oss2.Bucket`` singleton, or ``None`` if OSS is unavailable."""

    if _bucket_state["bucket"] is not None:
        return _bucket_state["bucket"]
    if _bucket_state["tried"]:
        return _bucket_state["bucket"]

    with _bucket_lock:
        if _bucket_state["tried"]:
            return _bucket_state["bucket"]
        _bucket_state["tried"] = True

        endpoint, bucket_name, access_key_id, access_key_secret = _read_creds()
        if not (endpoint and bucket_name and access_key_id and access_key_secret):
            logger.info("OSS creds incomplete; presign disabled")
            return None
        try:
            import oss2

            auth = oss2.Auth(access_key_id, access_key_secret)
            bucket = oss2.Bucket(auth, endpoint, bucket_name)
            _bucket_state["bucket"] = bucket
            logger.info("OSS bucket ready: endpoint=%s bucket=%s", endpoint, bucket_name)
            return bucket
        except Exception as exc:
            logger.warning("OSS init failed (%s); presign disabled", exc)
            return None


def local_path_to_key(local_path: str | Path) -> Optional[str]:
    """Map an ``OUTPUT_DIR`` local path to an OSS object key."""

    from novelvideo import config

    try:
        path = Path(local_path).resolve()
        root = Path(config.OUTPUT_DIR).resolve()
        rel = path.relative_to(root)
    except Exception:
        return None
    rel_key = "/".join(rel.parts)
    prefix = str(getattr(config, "OSS_OBJECT_PREFIX", "") or "").strip("/")
    return f"{prefix}/{rel_key}" if prefix else rel_key


def presign_get(key: str, expires: int) -> Optional[str]:
    bucket = get_bucket()
    if bucket is None:
        return None
    try:
        return bucket.sign_url("GET", key, expires, slash_safe=True)
    except Exception as exc:
        logger.warning("presign failed key=%s: %s", key, exc)
        return None


def presign_get_cached(key: str, mtime_ns: int, expires: int) -> Optional[str]:
    now = _monotonic()
    cache_key = (key, int(mtime_ns))
    reuse_window = max(0.0, float(expires) - _SAFETY_WINDOW_S)

    with _presign_cache_lock:
        entry = _presign_cache.get(cache_key)
        if entry is not None:
            url, signed_at = entry
            if now - signed_at < reuse_window:
                return url
            _presign_cache.pop(cache_key, None)

    url = presign_get(key, expires)
    if url is None:
        return None
    with _presign_cache_lock:
        _presign_cache[cache_key] = (url, now)
    return url


def object_exists(key: str) -> bool:
    bucket = get_bucket()
    if bucket is None:
        return False
    try:
        return bool(bucket.object_exists(key))
    except Exception as exc:
        logger.warning("OSS object_exists failed key=%s: %s", key, exc)
        return False


def maybe_presign_existing_output(
    local_path: str | Path,
    *,
    expires: int | None = None,
) -> Optional[str]:
    """Presign an ``OUTPUT_DIR`` file only if the OSS object already exists."""

    from novelvideo import config

    key = local_path_to_key(local_path)
    if key is None:
        return None
    if not object_exists(key):
        return None
    expire_seconds = int(expires or getattr(config, "OSS_PRESIGN_EXPIRES", 900))
    return presign_get(key, expire_seconds)


def upload_output_object(local_path: str | Path, key: str) -> bool:
    """Upload a local OUTPUT_DIR file to OSS using the provided object key."""

    bucket = get_bucket()
    if bucket is None:
        return False
    try:
        bucket.put_object_from_file(key, str(local_path))
        return True
    except Exception as exc:
        logger.warning("OSS upload failed key=%s local_path=%s: %s", key, local_path, exc)
        return False


def presign_or_upload_output(
    local_path: str | Path,
    *,
    expires: int | None = None,
) -> Optional[str]:
    """Presign an OUTPUT_DIR file, uploading it first if the object is missing."""

    from novelvideo import config

    key = local_path_to_key(local_path)
    if key is None:
        return None
    if not object_exists(key) and not upload_output_object(local_path, key):
        return None
    expire_seconds = int(expires or getattr(config, "OSS_PRESIGN_EXPIRES", 900))
    return presign_get(key, expire_seconds)


def _head_content_length(head_result) -> int | None:
    value = getattr(head_result, "content_length", None)
    if value is None:
        headers = getattr(head_result, "headers", {}) or {}
        value = headers.get("Content-Length") or headers.get("content-length")
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _head_last_modified_ts(head_result) -> float | None:
    value = getattr(head_result, "last_modified", None)
    if value is None:
        headers = getattr(head_result, "headers", {}) or {}
        value = headers.get("Last-Modified") or headers.get("last-modified")
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return parsedate_to_datetime(str(value)).timestamp()
    except Exception:
        return None


def object_matches_local(key: str, local_path: str | Path) -> bool:
    """远端对象是否就是本地文件的当前版本：大小一致，且 Last-Modified 不早于本地 mtime。

    ossfs 写回有延迟：本地文件刚被原地覆盖时，OSS 上可能还是旧版本，连大小都可能
    一样。拿不到 head、字段缺失或对不上，一律按「不确定」返回 False，由调用方回退。
    """
    bucket = get_bucket()
    if bucket is None:
        return False
    head_object = getattr(bucket, "head_object", None)
    if not callable(head_object):
        return False
    try:
        local_stat = Path(local_path).stat()
        head = head_object(key)
    except Exception as exc:
        logger.debug("OSS head_object failed key=%s: %s", key, exc)
        return False
    remote_size = _head_content_length(head)
    remote_mtime = _head_last_modified_ts(head)
    if remote_size is None or remote_mtime is None:
        return False
    if remote_size != int(local_stat.st_size):
        return False
    return remote_mtime + 2.0 >= float(local_stat.st_mtime)


def _static_object_ready(local_path: str | Path, key: str, version_key: int) -> bool:
    from novelvideo import config

    if not getattr(config, "OSS_STATIC_REQUIRE_READY", True):
        return True

    cache_key = (key, int(version_key))
    with _static_ready_cache_lock:
        if cache_key in _static_ready_cache:
            return True

    bucket = get_bucket()
    if bucket is None:
        return False
    head_object = getattr(bucket, "head_object", None)
    if not callable(head_object):
        return True

    try:
        local_stat = Path(local_path).stat()
    except OSError:
        return False

    attempts = max(1, int(getattr(config, "OSS_STATIC_READY_PROBE_ATTEMPTS", 3)))
    probe_delay = max(0.0, float(getattr(config, "OSS_STATIC_READY_PROBE_DELAY_SECONDS", 0.15)))

    for attempt in range(attempts):
        try:
            head = head_object(key)
        except Exception:
            head = None

        if head is not None:
            remote_size = _head_content_length(head)
            remote_mtime = _head_last_modified_ts(head)
            size_ready = remote_size is None or remote_size == int(local_stat.st_size)
            mtime_ready = remote_mtime is None or remote_mtime + 2.0 >= float(local_stat.st_mtime)
            if size_ready and mtime_ready:
                with _static_ready_cache_lock:
                    _static_ready_cache.add(cache_key)
                return True

        if attempt < attempts - 1 and probe_delay > 0:
            time.sleep(probe_delay)

    return False


def maybe_presign_static(local_path: str | Path, version_key: int) -> Optional[str]:
    from novelvideo import config

    if not getattr(config, "STATIC_VIA_OSS", False):
        return None
    key = local_path_to_key(local_path)
    if key is None:
        return None
    if not _static_object_ready(local_path, key, int(version_key)):
        return None
    return presign_get_cached(
        key,
        int(version_key),
        int(getattr(config, "OSS_STATIC_PRESIGN_EXPIRES", 3600)),
    )


def maybe_presign_download(local_path: str | Path) -> Optional[str]:
    from novelvideo import config

    if not getattr(config, "DOWNLOAD_VIA_OSS", False):
        return None
    key = local_path_to_key(local_path)
    if key is None:
        return None
    return presign_get(key, int(getattr(config, "OSS_PRESIGN_EXPIRES", 900)))


def _reset_for_tests() -> None:
    with _bucket_lock:
        _bucket_state["bucket"] = None
        _bucket_state["tried"] = False
    with _presign_cache_lock:
        _presign_cache.clear()
    with _static_ready_cache_lock:
        _static_ready_cache.clear()

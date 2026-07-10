"""Cached SHA-256 hashing for reference media files.

This utility is intentionally independent from any render-plan implementation.
It is useful whenever a request fingerprint needs to include local reference
image bytes without re-reading large files repeatedly.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any


class RefImageHasher:
    """Hash reference files with a small metadata cache.

    Cache entries are keyed by path and validated by both file size and
    nanosecond mtime. If either changes, the bytes are rehashed.
    """

    def __init__(self, cache_dir: Path | str):
        self._cache_dir = Path(cache_dir)
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._cache_file = self._cache_dir / "_ref_image_hash_cache.json"
        self._cache: dict[str, dict[str, Any]] = self._load_cache()

    def hash(self, path: Path | str) -> str:
        """Return the SHA-256 hex digest for *path*.

        Raises FileNotFoundError when the file does not exist.
        """
        file_path = Path(path)
        key = str(file_path)
        stat = file_path.stat()
        size = stat.st_size
        mtime_ns = int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000)))

        entry = self._cache.get(key)
        if (
            entry
            and entry.get("size") == size
            and entry.get("mtime_ns") == mtime_ns
            and isinstance(entry.get("sha256"), str)
            # racily-clean 防御(同 git):mtime 太新鲜时文件系统时间戳粒度
            # (NTFS ~10ms tick)可能掩盖快速重写,不信任缓存。
            and time.time_ns() - mtime_ns > 2_000_000_000
        ):
            return str(entry["sha256"])

        digest = file_sha256(file_path)
        self._cache[key] = {
            "size": size,
            "mtime_ns": mtime_ns,
            "sha256": digest,
        }
        self._save_cache()
        return digest

    def __call__(self, path: Path | str) -> str:
        return self.hash(path)

    def _load_cache(self) -> dict[str, dict[str, Any]]:
        if not self._cache_file.exists():
            return {}
        try:
            data = json.loads(self._cache_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save_cache(self) -> None:
        tmp = self._cache_file.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(self._cache, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(tmp, self._cache_file)


def file_sha256(path: Path | str, chunk_size: int = 1 << 20) -> str:
    """Stream-hash a file and return its SHA-256 hex digest."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()

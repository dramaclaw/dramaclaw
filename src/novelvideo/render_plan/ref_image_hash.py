"""Content hashing for character reference images, with metadata caching."""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Dict


class RefImageHasher:
    def __init__(self, cache_dir: Path | str):
        self._cache_dir = Path(cache_dir)
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._cache_file = self._cache_dir / "_ref_image_hash_cache.json"
        self._cache: Dict[str, Dict[str, object]] = self._load_cache()

    def hash(self, path: str) -> str:
        image_path = Path(path)
        stat = image_path.stat()
        size = stat.st_size
        mtime_ns = int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000)))
        entry = self._cache.get(path)
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

        digest = _sha256_of_file(image_path)
        self._cache[path] = {"size": size, "mtime_ns": mtime_ns, "sha256": digest}
        self._save_cache()
        return digest

    def __call__(self, path: str) -> str:
        return self.hash(path)

    def _load_cache(self) -> Dict[str, Dict[str, object]]:
        if not self._cache_file.exists():
            return {}
        try:
            data = json.loads(self._cache_file.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, OSError):
            return {}

    def _save_cache(self) -> None:
        tmp_path = self._cache_file.with_suffix(".json.tmp")
        tmp_path.write_text(
            json.dumps(self._cache, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(tmp_path, self._cache_file)


def _sha256_of_file(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()

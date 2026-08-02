"""上传文件名清洗，防路径穿越。"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath
from typing import BinaryIO

MAX_NOVEL_UPLOAD_BYTES = 1 * 1024 * 1024


class UploadTooLargeError(ValueError):
    """Raised when a novel upload exceeds its raw file-size limit."""


def sanitize_upload_filename(raw_name: str | None, *, fallback: str = "upload.txt") -> str:
    """Return a safe filename stripped of any directory components.

    - Keeps only the basename (cross-platform).
    - Replaces remaining path separators with `_`.
    - Falls back to *fallback* for empty / `.` / `..`.
    """
    name = PurePosixPath(raw_name or fallback).name
    name = re.sub(r"[/\\]", "_", name)
    if not name or name in {".", ".."}:
        name = fallback
    return name


def is_safe_upload_target(upload_dir: Path, safe_name: str) -> bool:
    """Check that *safe_name* resolves inside *upload_dir* (defence in depth)."""
    target = (upload_dir / safe_name).resolve()
    return target.is_relative_to(upload_dir.resolve())


def stream_to_file_with_limit(
    src: BinaryIO,
    dst_path: Path,
    *,
    max_bytes: int = MAX_NOVEL_UPLOAD_BYTES,
    chunk_size: int = 1 << 20,
) -> int:
    """Stream *src* into *dst_path*, aborting beyond *max_bytes*.

    The raw size guard protects document parsing. A separate parsed-character
    limit protects chapter analysis and knowledge-graph ingestion.
    """
    written = 0
    too_large = False
    try:
        with open(dst_path, "wb") as out:
            while True:
                chunk = src.read(chunk_size)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    too_large = True
                    break
                out.write(chunk)
    finally:
        if too_large:
            try:
                dst_path.unlink(missing_ok=True)
            except OSError:
                pass
    if too_large:
        raise UploadTooLargeError(f"上传超过 {max_bytes // (1024 * 1024)}MB 上限")
    return written

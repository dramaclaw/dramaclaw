"""上传文件名清洗，防路径穿越。"""

from __future__ import annotations

import os
import re
import secrets
import stat
from pathlib import Path, PurePosixPath
from typing import BinaryIO

MAX_NOVEL_UPLOAD_BYTES = 512 * 1024
MAX_NOVEL_IMPORT_BYTES = 1 * 1024 * 1024
MAX_PROJECT_UPLOAD_BYTES = 200 * 1024 * 1024
# 单个路径分量的字节上限，ext4/APFS 都是 255。这里留一大段余量：落地前名字还会
# 被加工——去重后缀（`-ab12`）、暂存文件名（`upload-` + 32 个十六进制字符 + 原后缀）。
# 贴着 255 判，撞名或暂存时照样会 ENAMETOOLONG。
MAX_UPLOAD_FILENAME_BYTES = 200


class UploadTooLargeError(ValueError):
    """Raised when an upload exceeds its raw file-size limit."""


def create_staged_upload_file(
    staging_dir: Path,
    *,
    suffix: str,
    prefix: str = "upload-",
    destination: Path | None = None,
) -> Path:
    """Create a unique staging file with publish-compatible permissions."""

    for _ in range(10):
        staged_path = staging_dir / f"{prefix}{secrets.token_hex(16)}{suffix}"
        try:
            fd = os.open(
                staged_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o666,
            )
        except FileExistsError:
            continue
        os.close(fd)
        try:
            if destination is not None:
                destination_mode = stat.S_IMODE(destination.stat().st_mode)
                staged_path.chmod(destination_mode)
        except FileNotFoundError:
            pass
        except BaseException:
            staged_path.unlink(missing_ok=True)
            raise
        return staged_path
    raise OSError("failed to allocate upload staging file")


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
    """Check that *safe_name* is a usable target inside *upload_dir*.

    Besides path traversal, this rejects the two names the filesystem itself
    cannot hold — instead of letting them escape a route handler as a 500:

    - names containing NUL: `Path.resolve()` raises `ValueError`;
    - names over the per-component byte budget: `open()` raises `ENAMETOOLONG`
      (e.g. 300 Chinese characters are 900 UTF-8 bytes).
    """
    if "\x00" in safe_name:
        return False
    if len(safe_name.encode("utf-8", "surrogatepass")) > MAX_UPLOAD_FILENAME_BYTES:
        return False
    try:
        target = (upload_dir / safe_name).resolve()
    except (OSError, ValueError):
        return False
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

"""Files attached to a home-scope chat, stored per user under the state root.

A home chat has no project, so its attachments cannot live in a project's
output. They go to ``<state>/<user>/_uploads/`` and chat history keeps only
their address, ``/api/v1/chat/uploads/<name>``. The address carries no user:
it is resolved against the requesting user's own directory, so another user
asking for the same address gets nothing.
"""

from __future__ import annotations

import hashlib
import mimetypes
import re
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote

from novelvideo.chat.store import _state_root
from novelvideo.utils.upload_safety import (
    MAX_PROJECT_UPLOAD_BYTES,
    UploadTooLargeError,
    create_staged_upload_file,
    is_safe_upload_target,
    sanitize_upload_filename,
)

HOME_UPLOADS_DIRNAME = "_uploads"
HOME_UPLOAD_URL_PREFIX = "/api/v1/chat/uploads/"
HOME_UPLOAD_MAX_BYTES = MAX_PROJECT_UPLOAD_BYTES
_CHUNK_BYTES = 1 << 20
# ``<first 16 hex of sha256>-<sanitized file name>``; staging files never match.
_STORED_NAME = re.compile(r"[0-9a-f]{16}-[^/\\]+")


def home_uploads_dir(username: str) -> Path:
    return _state_root() / username / HOME_UPLOADS_DIRNAME


def save_home_upload(username: str, source: BinaryIO, filename: str | None) -> dict[str, Any]:
    """Store one upload and return its attachment record (address, never content).

    Files are named by content hash, so the same file uploaded twice is stored once.
    """

    max_bytes = HOME_UPLOAD_MAX_BYTES
    safe_name = sanitize_upload_filename(filename, fallback="upload.bin")
    directory = home_uploads_dir(username)
    directory.mkdir(parents=True, exist_ok=True)
    staged = create_staged_upload_file(directory, prefix=".upload-", suffix=".tmp")
    digest = hashlib.sha256()
    size = 0
    try:
        with staged.open("wb") as out:
            while chunk := source.read(_CHUNK_BYTES):
                size += len(chunk)
                if size > max_bytes:
                    raise UploadTooLargeError(f"file exceeds the {max_bytes} byte upload limit")
                digest.update(chunk)
                out.write(chunk)
        name = f"{digest.hexdigest()[:16]}-{safe_name}"
        if not is_safe_upload_target(directory, name):
            raise ValueError("unsafe upload file name")
        staged.replace(directory / name)
    finally:
        staged.unlink(missing_ok=True)
    return {
        "url": HOME_UPLOAD_URL_PREFIX + quote(name),
        "fileName": safe_name,
        "fileSize": size,
        "mimeType": mimetypes.guess_type(safe_name)[0] or "application/octet-stream",
    }


def resolve_home_upload(username: str, name: str) -> Path | None:
    """The requesting user's stored upload called ``name``, or None."""

    if not _STORED_NAME.fullmatch(name):
        return None
    directory = home_uploads_dir(username)
    if not is_safe_upload_target(directory, name):
        return None
    path = directory / name
    return path if path.is_file() else None

"""Resource-scoped preview grants for opaque HTML frames.

Only issuance uses the user's project permission. Grants expire after 15 minutes
and share a per-project secret in state storage across API workers/restarts.
Media bytes continue through the existing file response implementation.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import tempfile
import time
from pathlib import Path

TTL = 900


def project_key(state_dir: Path, *, create: bool = False) -> bytes:
    path = state_dir / '.html-preview-key'
    if create and not path.exists():
        state_dir.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=state_dir, prefix='.preview-key-')
        try:
            with os.fdopen(fd, 'wb') as out:
                out.write(secrets.token_bytes(32))
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temporary)
    key = path.read_bytes()
    if len(key) != 32:
        raise ValueError('Invalid preview key')
    return key


def signature(key: bytes, project: str, artifact: str, relative: str, expires: int) -> str:
    payload = '\0'.join(('html-preview-v1', project, artifact, relative, str(expires)))
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def verify(key: bytes, project: str, artifact: str, relative: str, expires: int, token: str) -> bool:
    return int(time.time()) < expires <= int(time.time()) + TTL and hmac.compare_digest(
        signature(key, project, artifact, relative, expires), token,
    )

# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Project-scoped credentials for the Freezone upload endpoint.

Tickets are signed with a key derived from the server signing keyring (explicit
environment configuration, or the per-install keyring file at the root of the
server state directory). That keyring is never stored inside a project
directory, so nothing a project workspace contains can sign a ticket.
"""

import base64
import hmac
import json
import re
import threading
from collections.abc import Sequence
from typing import NamedTuple

from novelvideo.task_backend.signing import load_or_create_local_signing_config

TTL = 600
# What minted a ticket: an agent session, or anything else the API authenticates as a user.
AGENT_SESSION = "agent_session"
SESSION = "session"
CREDENTIAL_KINDS = frozenset({AGENT_SESSION, SESSION})
# Mirrors canvas upload node image, video (including extra containers), and audio file-name suffixes only.
ALLOWED_SUFFIXES = frozenset("""
    .png .jpg .jpeg .webp .gif .bmp .avif
    .mp4 .mov .webm .mxf .mkv .avi .ts .mts .m2ts .flv .wmv .m4v .mpg .mpeg
    .mp3 .wav .m4a .aac .ogg .flac .opus
""".split())
_FORMAT = re.compile(r"([A-Za-z0-9_-]+)\.([0-9a-f]{64})")
_KEY_PURPOSE = b"freezone-upload-ticket-key-v1"
_SERVER_KEYS: tuple[bytes, ...] | None = None
_SERVER_KEYS_LOCK = threading.Lock()


def server_keys() -> tuple[bytes, ...]:
    """Return ticket keys derived from the server keyring, signing key first.

    Every keyring entry verifies, so a ticket outlives a key rotation for as long
    as its key stays listed. The result is cached for the process lifetime: an
    install that cannot persist its keyring gets a fresh key on each restart, and
    tickets issued before the restart stop verifying.

    Raises ``TaskEnvelopeSigningConfigError`` when the keyring is missing or invalid.
    """
    global _SERVER_KEYS
    with _SERVER_KEYS_LOCK:
        if _SERVER_KEYS is None:
            config = load_or_create_local_signing_config()
            ordered = [config.active_key_id] + sorted(set(config.keyring) - {config.active_key_id})
            _SERVER_KEYS = tuple(
                hmac.digest(config.keyring[key_id], _KEY_PURPOSE, "sha256") for key_id in ordered
            )
        return _SERVER_KEYS


def _signature(key: bytes, segment: str) -> str:
    return hmac.digest(
        key, b"freezone-upload-ticket-v1\0" + segment.encode("ascii"), "sha256"
    ).hex()


class TicketIdentity(NamedTuple):
    user_id: str
    username: str
    credential_kind: str
    credential_id: str | None


def issue(
    key: bytes,
    project: str,
    user_id: str,
    username: str,
    now: int,
    *,
    credential_kind: str,
    credential_id: str | None,
) -> str:
    """Sign a ticket bound to the credential that requested it.

    ``credential_id`` is the id of the minting session, never its token or cookie.
    """
    payload = {
        "v": 2, "p": project, "u": user_id, "n": username, "e": now + TTL,
        "k": credential_kind, "c": credential_id,
    }
    segment = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode("ascii").rstrip("=")
    return f"{segment}.{_signature(key, segment)}"


def verify(
    keys: Sequence[bytes], project: str, ticket: str, now: int
) -> TicketIdentity | None:
    if not isinstance(ticket, str) or len(ticket) > 2048:
        return None
    match = _FORMAT.fullmatch(ticket)
    if match is None:
        return None
    segment, signature = match.groups()
    if not any(hmac.compare_digest(_signature(key, segment), signature) for key in keys):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
    except (ValueError, RecursionError):
        return None
    if not isinstance(payload, dict):
        return None
    version, expiry = payload.get("v"), payload.get("e")
    user_id, username = payload.get("u"), payload.get("n")
    kind, credential_id = payload.get("k"), payload.get("c")
    if (
        type(version) is not int or version != 2
        or payload.get("p") != project
        or type(expiry) is not int or not now < expiry <= now + TTL
        or not isinstance(user_id, str) or not isinstance(username, str)
        or not isinstance(kind, str) or kind not in CREDENTIAL_KINDS
        or not (isinstance(credential_id, str) or credential_id is None)
        or credential_id == ""
        or (kind == AGENT_SESSION and credential_id is None)
    ):
        return None
    return TicketIdentity(user_id, username, kind, credential_id)

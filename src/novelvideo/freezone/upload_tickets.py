# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Project-scoped credentials for the Freezone upload endpoint."""

import base64
import hmac
import json
import re

TTL = 600
# Mirrors canvas upload node image, video (including extra containers), and audio file-name suffixes only.
ALLOWED_SUFFIXES = frozenset("""
    .png .jpg .jpeg .webp .gif .bmp .avif
    .mp4 .mov .webm .mxf .mkv .avi .ts .mts .m2ts .flv .wmv .m4v .mpg .mpeg
    .mp3 .wav .m4a .aac .ogg .flac .opus
""".split())
_FORMAT = re.compile(r"([A-Za-z0-9_-]+)\.([0-9a-f]{64})")


def _signature(key: bytes, segment: str) -> str:
    return hmac.digest(
        key, b"freezone-upload-ticket-v1\0" + segment.encode("ascii"), "sha256"
    ).hex()


def issue(key: bytes, project: str, user_id: str, username: str, now: int) -> str:
    payload = {"v": 1, "p": project, "u": user_id, "n": username, "e": now + TTL}
    segment = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode("ascii").rstrip("=")
    return f"{segment}.{_signature(key, segment)}"


def verify(key: bytes, project: str, ticket: str, now: int) -> tuple[str, str] | None:
    if not isinstance(ticket, str) or len(ticket) > 2048:
        return None
    match = _FORMAT.fullmatch(ticket)
    if match is None:
        return None
    segment, signature = match.groups()
    if not hmac.compare_digest(_signature(key, segment), signature):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
    except (ValueError, RecursionError):
        return None
    if not isinstance(payload, dict):
        return None
    version, expiry = payload.get("v"), payload.get("e")
    user_id, username = payload.get("u"), payload.get("n")
    if (
        type(version) is not int or version != 1
        or payload.get("p") != project
        or type(expiry) is not int or not now < expiry <= now + TTL
        or not isinstance(user_id, str) or not isinstance(username, str)
    ):
        return None
    return user_id, username

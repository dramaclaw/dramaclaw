"""Turn request/response bodies into log-safe structures.

Secrets are redacted, oversize text is truncated, and embedded binary payloads
(data URIs, ``b64_json``, Gemini ``inlineData``, multipart files, raw bytes) are
lifted out into media objects supplied by the sink so the UI can render them.
"""

from __future__ import annotations

import base64
import binascii
import email.parser
import email.policy
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

MediaFactory = Callable[[bytes, str], Any]

_SECRET_KEY_RE = re.compile(
    r"(?:^|_|-)(?:api[_-]?key|apikey|authorization|token|secret|password|cookie)(?:$|_|-)",
    re.IGNORECASE,
)
_BASE64_KEYS = frozenset(
    {
        "b64_json",
        "file_data",
        "data",
        "image_base64",
        "bytesbase64encoded",
        "audio",
        "b64",
    }
)
_B64_RE = re.compile(r"[A-Za-z0-9+/=_\-\s]+")
_DATA_URI_RE = re.compile(r"^data:([\w.+\-/]+);base64,", re.IGNORECASE)
_MIN_B64_CHARS = 256
_MAX_DEPTH = 24


@dataclass(frozen=True)
class RawBytes:
    data: bytes
    mime: str = ""
    filename: str = ""


@dataclass(frozen=True)
class Limits:
    max_text_chars: int
    max_media_bytes: int
    capture_media: bool


def sniff_mime(data: bytes) -> str:
    head = data[:16]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if head[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[4:8] == b"ftyp":
        return "video/mp4"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    if head[:4] == b"OggS":
        return "audio/ogg"
    if head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    if head[:4] == b"fLaC":
        return "audio/flac"
    return ""


def _is_secret_key(key: object) -> bool:
    return isinstance(key, str) and bool(_SECRET_KEY_RE.search(key))


def _truncate(text: str, limits: Limits) -> str:
    if len(text) <= limits.max_text_chars:
        return text
    omitted = len(text) - limits.max_text_chars
    return f"{text[: limits.max_text_chars]}…[truncated {omitted} chars]"


def _media(data: bytes, mime: str, factory: MediaFactory, limits: Limits) -> Any:
    summary = {
        "type": "media",
        "mime": mime or "application/octet-stream",
        "size_bytes": len(data),
    }
    if not limits.capture_media:
        return {**summary, "omitted": "capture_media disabled"}
    if len(data) > limits.max_media_bytes:
        return {**summary, "omitted": "exceeds LLM_CALL_LOG_MAX_MEDIA_MB"}
    try:
        return factory(data, mime or "application/octet-stream")
    except Exception as exc:  # never let logging break a call
        return {**summary, "omitted": f"media factory failed: {type(exc).__name__}"}


def _decode_b64(text: str) -> bytes | None:
    if len(text) < _MIN_B64_CHARS or not _B64_RE.fullmatch(text[:512]):
        return None
    try:
        cleaned = re.sub(r"\s+", "", text).replace("-", "+").replace("_", "/")
        return base64.b64decode(cleaned + "=" * (-len(cleaned) % 4), validate=True)
    except (binascii.Error, ValueError):
        return None


def externalize(
    value: Any,
    factory: MediaFactory,
    limits: Limits,
    *,
    key: str = "",
    sibling_mime: str = "",
    depth: int = 0,
) -> Any:
    """Return a copy of ``value`` that is redacted, truncated and media-lifted."""
    if depth > _MAX_DEPTH:
        return "…[max depth]"
    if isinstance(value, RawBytes):
        return _media(value.data, value.mime or sniff_mime(value.data), factory, limits)
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        return _media(data, sniff_mime(data), factory, limits)
    if isinstance(value, dict):
        mime = str(
            value.get("mime_type")
            or value.get("mimeType")
            or value.get("media_type")
            or ""
        )
        out: dict[str, Any] = {}
        for child_key, child in value.items():
            if _is_secret_key(child_key):
                out[str(child_key)] = "***"
                continue
            out[str(child_key)] = externalize(
                child,
                factory,
                limits,
                key=str(child_key),
                sibling_mime=mime,
                depth=depth + 1,
            )
        return out
    if isinstance(value, (list, tuple)):
        return [
            externalize(v, factory, limits, key=key, depth=depth + 1) for v in value
        ]
    if isinstance(value, str):
        match = _DATA_URI_RE.match(value)
        if match:
            raw = (
                _decode_b64(value[match.end() :])
                if len(value) - match.end() >= 8
                else None
            )
            if raw is None:
                try:
                    raw = base64.b64decode(value[match.end() :], validate=False)
                except (binascii.Error, ValueError):
                    return _truncate(value, limits)
            return _media(raw, match.group(1), factory, limits)
        if key.lower() in _BASE64_KEYS:
            raw = _decode_b64(value)
            if raw is not None:
                mime = sibling_mime or sniff_mime(raw)
                if mime or key.lower() in {"b64_json", "image_base64", "b64"}:
                    return _media(raw, mime, factory, limits)
        return _truncate(value, limits)
    return value


def parse_multipart(content_type: str, body: bytes) -> dict[str, Any] | None:
    """Parse a multipart/form-data body; files become :class:`RawBytes`."""
    if not content_type.lower().startswith("multipart/") or not body:
        return None
    try:
        message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
            b"Content-Type: "
            + content_type.encode("latin-1", "replace")
            + b"\r\n\r\n"
            + body
        )
        fields: dict[str, Any] = {}
        for part in message.iter_parts():
            name = (
                part.get_param("name", header="content-disposition")
                or f"part{len(fields)}"
            )
            filename = part.get_filename() or ""
            payload = part.get_payload(decode=True) or b""
            ptype = part.get_content_type()
            if filename or not ptype.startswith("text/"):
                item: Any = RawBytes(payload, ptype if "/" in ptype else "", filename)
            else:
                item = payload.decode("utf-8", "replace")
            key = str(name)
            if key in fields:  # repeated field, e.g. several reference images
                existing = fields[key]
                fields[key] = (
                    [*existing, item]
                    if isinstance(existing, list)
                    else [existing, item]
                )
            else:
                fields[key] = item
        return fields
    except Exception:
        return None

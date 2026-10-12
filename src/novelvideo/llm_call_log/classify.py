"""Decide whether an outgoing HTTP request is a model call, and of what kind."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"/chat/completions$"), "text"),
    (re.compile(r"/v1/responses$"), "text"),
    (re.compile(r"/v1/messages$"), "text"),
    (re.compile(r"/models/([^/:]+):(?:stream)?[gG]enerateContent$"), "text"),
    (re.compile(r"/images/(?:generations|edits|variations)$"), "image"),
    (re.compile(r"/audio/(?:speech|transcriptions|translations)$"), "audio"),
    (re.compile(r"/embeddings$"), "embedding"),
    (re.compile(r"/videos?/generations(?:/[^/]+)?$"), "video"),
    (re.compile(r"/contents/generations/tasks(?:/[^/]+)?$"), "video"),
    (re.compile(r"/videos(?:/[^/]+)?(?:/content)?$"), "video"),
)
_IGNORED_HOSTS = frozenset({"testserver"})


@dataclass(frozen=True)
class CallInfo:
    kind: str  # text | image | audio | video | embedding | other
    endpoint: str  # host + path, query stripped
    path: str
    model_from_path: str = ""


def sanitize_url(url: str) -> str:
    """Drop userinfo and query string (Google puts ``?key=`` there)."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return f"{parts.scheme}://{host}{parts.path}"


def classify(url: str, extra_hosts: tuple[str, ...] = ()) -> CallInfo | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if not host or host in _IGNORED_HOSTS:
        return None
    path = parts.path.rstrip("/")
    endpoint = f"{host}{path}"
    for pattern, kind in _RULES:
        match = pattern.search(path)
        if match:
            model = match.group(1) if match.groups() else ""
            return CallInfo(
                kind=kind, endpoint=endpoint, path=path, model_from_path=model
            )
    if host in extra_hosts:
        return CallInfo(kind="other", endpoint=endpoint, path=path)
    return None

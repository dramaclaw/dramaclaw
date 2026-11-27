"""Helpers for showing provider errors without leaking secrets."""

from __future__ import annotations

import re
from typing import Any


_SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization:\s*bearer\s+)[^\s,;]+"),
    re.compile(r"(?i)(api[_-]?key[\"']?\s*[:=]\s*[\"']?)[^\"'\s,;]+"),
    re.compile(r"(?i)(token[\"']?\s*[:=]\s*[\"']?)[^\"'\s,;]+"),
    re.compile(r"(?i)(secret[\"']?\s*[:=]\s*[\"']?)[^\"'\s,;]+"),
]

_DETAIL_PATTERNS = (
    (r"""[A-Za-z][A-Za-z0-9+.-]*://[^\s"']*""", "[url]"),
    (
        r"""(?i)(\b(?:password|passwd|pwd|signature|sig|access[_-]?key|credential)"""
        r"""["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;]+)""",
        r"\1[redacted]",
    ),
    (
        r"sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,}|"
        r"eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|"
        r"[A-Za-z0-9+/_=-]{40,}",
        "[redacted]",
    ),
    (
        r"""(?<!\w)[A-Za-z]:\\[^\s"'<>|，。；：、]+|"""
        r"""(?<![\w/.:])/(?:[^/\s"'<>，。；：、]+/)+[^\s"'<>，。；：、]+""",
        "[path]",
    ),
    (r"(?<![\w.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?(?!\w)", "[host]"),
    (
        r"(?i)(?<![\w.-])(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+):[0-9]{2,5}\b",
        "[host]",
    ),
    (
        r"(?i)(?<![\w.-])(?:[a-z0-9-]+\.)+(?:internal|local|lan|corp|svc(?:\.[a-z0-9-]+)*)"
        r"(?![\w-]|\.[a-z0-9-])",
        "[host]",
    ),
)


def redact_secrets(value: Any) -> str:
    text = str(value)
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(r"\1[redacted]", text)
    return text


def redact_error_detail(value: Any, *, limit: int = 500) -> str:
    text = redact_secrets(value)
    for pattern, replacement in _DETAIL_PATTERNS:
        text = re.sub(pattern, replacement, text)
    return " ".join(text.split())[:limit]


def safe_exception_message(exc: BaseException) -> str:
    message = redact_secrets(exc)
    return message or exc.__class__.__name__


__all__ = ["redact_error_detail", "redact_secrets", "safe_exception_message"]

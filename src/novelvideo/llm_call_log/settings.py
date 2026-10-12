"""Environment-driven settings for the dev-only LLM call log."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

_TRUTHY = frozenset({"1", "true", "yes", "on"})

DEFAULT_MAX_TEXT_CHARS = 200_000
DEFAULT_MAX_MEDIA_MB = 64


def _flag(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = str(env.get(name, "") or "").strip().lower()
    if not raw:
        return default
    return raw in _TRUTHY


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    try:
        value = int(str(env.get(name, "") or "").strip())
    except ValueError:
        return default
    return value if value > 0 else default


@dataclass(frozen=True)
class LlmCallLogSettings:
    enabled: bool
    host: str
    public_key: str
    secret_key: str
    environment: str
    extra_hosts: tuple[str, ...]
    max_text_chars: int
    max_media_bytes: int
    capture_media: bool

    @property
    def configured(self) -> bool:
        return bool(self.host and self.public_key and self.secret_key)


def load_settings(env: Mapping[str, str] | None = None) -> LlmCallLogSettings:
    env = os.environ if env is None else env
    extra = tuple(
        item.strip().lower()
        for item in str(env.get("LLM_CALL_LOG_EXTRA_HOSTS", "") or "").split(",")
        if item.strip()
    )
    return LlmCallLogSettings(
        enabled=_flag(env, "LLM_CALL_LOG_ENABLED", False),
        host=str(env.get("LANGFUSE_HOST", "") or "").strip().rstrip("/"),
        public_key=str(env.get("LANGFUSE_PUBLIC_KEY", "") or "").strip(),
        secret_key=str(env.get("LANGFUSE_SECRET_KEY", "") or "").strip(),
        environment=str(env.get("LLM_CALL_LOG_ENVIRONMENT", "") or "").strip()
        or "dev-local",
        extra_hosts=extra,
        max_text_chars=_int(env, "LLM_CALL_LOG_MAX_TEXT_CHARS", DEFAULT_MAX_TEXT_CHARS),
        max_media_bytes=_int(env, "LLM_CALL_LOG_MAX_MEDIA_MB", DEFAULT_MAX_MEDIA_MB)
        * 1024
        * 1024,
        capture_media=_flag(env, "LLM_CALL_LOG_CAPTURE_MEDIA", True),
    )

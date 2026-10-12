"""Dev-only capture of every model call's input/output into Langfuse.

Off by default. Enable with ``LLM_CALL_LOG_ENABLED=1`` plus ``LANGFUSE_HOST``,
``LANGFUSE_PUBLIC_KEY`` and ``LANGFUSE_SECRET_KEY`` (see
``docs/en/guides/llm-call-log.md``). Capture is a process-wide httpx/aiohttp
interception, so text, image, audio, video and embedding calls are all covered
regardless of which SDK issues them.

Importing this package is cheap and has no side effects; :func:`install` does
the work and never raises.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from novelvideo.llm_call_log.settings import LlmCallLogSettings, load_settings

logger = logging.getLogger("novelvideo.llm_call_log")

_LOCK = threading.Lock()
_tracker: Any = None


def install(env: Mapping[str, str] | None = None, *, sink: Any = None) -> bool:
    """Patch the HTTP clients when logging is enabled. Idempotent; never raises."""
    global _tracker
    with _LOCK:
        if _tracker is not None:
            return True
        try:
            settings = load_settings(env)
            if not settings.enabled:
                return False
            if sink is None:
                if not settings.configured:
                    logger.warning(
                        "LLM_CALL_LOG_ENABLED is set but LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY "
                        "are missing; call logging stays off"
                    )
                    return False
                try:
                    from novelvideo.llm_call_log.sink import LangfuseSink

                    sink = LangfuseSink(settings)
                except ImportError:
                    logger.warning(
                        "LLM call log needs the `langfuse` package (pip install langfuse)"
                    )
                    return False
            from novelvideo.llm_call_log.hooks import (
                install_aiohttp_hook,
                install_httpx_hook,
            )
            from novelvideo.llm_call_log.tracker import CallTracker

            tracker = CallTracker(settings, sink)
            install_httpx_hook(tracker)
            install_aiohttp_hook(tracker)
            _tracker = tracker
            logger.info("LLM call log enabled -> %s", settings.host or "custom sink")
            return True
        except Exception as exc:  # observability must never block startup
            logger.warning("LLM call log install failed: %s", exc)
            return False


def flush() -> None:
    tracker = _tracker
    if tracker is not None:
        try:
            tracker.sink.flush()
        except Exception:
            pass


def record_artifact(
    kind: str,
    *,
    data: bytes | None = None,
    path: str | Path | None = None,
    mime: str = "",
    label: str = "",
    source_url: str = "",
) -> None:
    """Attach a media file the app obtained out-of-band (e.g. a downloaded video).

    Some results never appear in an intercepted response body: video bytes are
    streamed to disk, and Gemini WebAI images come from a cookie-gated URL.
    Callers hand the finished file here so the log still shows it. No-op when
    logging is off.
    """
    tracker = _tracker
    if tracker is None:
        return
    try:
        from novelvideo.llm_call_log.payload import RawBytes, sniff_mime
        from novelvideo.llm_call_log.sink import Attribution, Finish
        from novelvideo.llm_call_log.tracker import _attribution

        size = None
        if data is None and path is not None:
            file_path = Path(path)
            size = file_path.stat().st_size
            if size <= tracker.limits.max_media_bytes:
                data = file_path.read_bytes()
        media: Any
        if data is not None:
            media = tracker._lift(RawBytes(data, mime or sniff_mime(data)))
        else:
            media = {"type": "media", "omitted": "file too large", "size_bytes": size}
        meta = {"source_url": source_url.split("?")[0], "path": str(path or "")}
        handle = tracker.sink.start(
            name=f"artifact {kind} {label}".strip(),
            kind=kind,
            model="",
            input={"label": label, **meta},
            metadata=meta,
            attribution=_attribution() if kind else Attribution(),
        )
        tracker.sink.finish(handle, Finish(output=media, metadata=meta))
    except Exception as exc:
        logger.debug("record_artifact failed: %s", exc)


__all__ = ["LlmCallLogSettings", "flush", "install", "load_settings", "record_artifact"]

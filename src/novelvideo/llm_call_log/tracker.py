"""Transport-agnostic bookkeeping around one model call."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from novelvideo.llm_call_log.classify import CallInfo, classify, sanitize_url
from novelvideo.llm_call_log.payload import (
    Limits,
    RawBytes,
    externalize,
    parse_multipart,
    sniff_mime,
)
from novelvideo.llm_call_log.settings import LlmCallLogSettings
from novelvideo.llm_call_log.sink import Attribution, Finish, Sink

logger = logging.getLogger("novelvideo.llm_call_log")

_REQUEST_ID_HEADERS = (
    "x-request-id",
    "x-newapi-request-id",
    "x-oneapi-request-id",
    "request-id",
    "x-goog-request-id",
)
_TERMINAL_STATUSES = frozenset(
    {"completed", "succeeded", "success", "failed", "error", "cancelled", "canceled"}
)
_MEDIA_PREFIXES = ("image/", "audio/", "video/")


@dataclass
class Pending:
    info: CallInfo
    method: str
    url: str
    model: str
    started: float
    input: Any
    handle: Any = None
    deferred: bool = False


def _attribution() -> Attribution:
    try:
        from novelvideo import llm_instrumentation as li

        return Attribution(
            user_id=li.get_llm_user_context() or "",
            project_id=li.get_project_context() or "",
            resource_kind=li.get_resource_kind_context() or "",
        )
    except Exception:
        return Attribution()


def _usage(body: Any) -> dict[str, int] | None:
    if not isinstance(body, dict):
        return None
    usage = body.get("usage")
    meta = body.get("usageMetadata")
    out: dict[str, int] = {}
    if isinstance(usage, dict):
        pairs = (
            ("input", usage.get("prompt_tokens", usage.get("input_tokens"))),
            ("output", usage.get("completion_tokens", usage.get("output_tokens"))),
            ("total", usage.get("total_tokens")),
        )
    elif isinstance(meta, dict):
        pairs = (
            ("input", meta.get("promptTokenCount")),
            ("output", meta.get("candidatesTokenCount")),
            ("total", meta.get("totalTokenCount")),
        )
    else:
        return None
    for key, val in pairs:
        if isinstance(val, int) and not isinstance(val, bool):
            out[key] = val
    return out or None


def _is_terminal_poll(body: Any) -> bool:
    """A video task poll is worth logging once it finished or carries a media URL."""
    if not isinstance(body, dict):
        return False
    flat = json.dumps(body, default=str).lower()
    if "video_url" in flat or ".mp4" in flat:
        return True
    scopes = [body]
    if isinstance(body.get("data"), dict):
        scopes.append(body["data"])
    for scope in scopes:
        for key in ("status", "state", "task_status"):
            value = scope.get(key)
            if isinstance(value, str) and value.lower() in _TERMINAL_STATUSES:
                return True
    return False


class CallTracker:
    def __init__(self, settings: LlmCallLogSettings, sink: Sink) -> None:
        self.settings = settings
        self.sink = sink
        self.limits = Limits(
            max_text_chars=settings.max_text_chars,
            max_media_bytes=settings.max_media_bytes,
            capture_media=settings.capture_media,
        )
        self._skip_netloc = ""
        if settings.host:
            from urllib.parse import urlsplit

            self._skip_netloc = (urlsplit(settings.host).netloc or "").lower()

    def _lift(self, value: Any) -> Any:
        return externalize(value, self.sink.make_media, self.limits)

    def wants(self, url: str) -> bool:
        """Cheap pre-check so hooks only buffer bodies of requests we will log."""
        try:
            from urllib.parse import urlsplit

            if (
                self._skip_netloc
                and (urlsplit(url).netloc or "").lower() == self._skip_netloc
            ):
                return False
            return classify(url, self.settings.extra_hosts) is not None
        except Exception:
            return False

    def begin(
        self, method: str, url: str, content_type: str, body: bytes | dict | list | None
    ) -> Pending | None:
        try:
            from urllib.parse import urlsplit

            if (
                self._skip_netloc
                and (urlsplit(url).netloc or "").lower() == self._skip_netloc
            ):
                return None  # never log our own Langfuse traffic
            info = classify(url, self.settings.extra_hosts)
            if info is None:
                return None
            parsed = self._parse_request(content_type, body)
            model = ""
            if isinstance(parsed, dict):
                model = str(parsed.get("model") or "")
            model = model or info.model_from_path
            pending = Pending(
                info=info,
                method=method.upper(),
                url=sanitize_url(url),
                model=model,
                started=time.monotonic(),
                input=self._lift(parsed) if parsed is not None else None,
            )
            if pending.method == "GET" and info.kind == "video":
                pending.deferred = (
                    True  # only polls that reached a terminal state are logged
                )
                return pending
            pending.handle = self._start(pending)
            return pending
        except Exception as exc:
            logger.debug("llm_call_log begin failed: %s", exc)
            return None

    def _parse_request(
        self, content_type: str, body: bytes | dict | list | None
    ) -> Any:
        if body is None or body == b"":
            return None
        if isinstance(body, (dict, list)):
            return body
        ctype = (content_type or "").lower()
        if "json" in ctype:
            try:
                return json.loads(body)
            except ValueError:
                return body.decode("utf-8", "replace")
        if ctype.startswith("multipart/"):
            return parse_multipart(content_type, body)
        if ctype.startswith(("text/", "application/x-www-form-urlencoded")):
            return body.decode("utf-8", "replace")
        return {"type": "binary_body", "content_type": ctype, "size_bytes": len(body)}

    def _start(self, pending: Pending) -> Any:
        return self.sink.start(
            name=f"{pending.info.kind} {pending.method} {pending.info.path or pending.info.endpoint}",
            kind=pending.info.kind,
            model=pending.model,
            input=pending.input,
            metadata={"url": pending.url, "method": pending.method},
            attribution=_attribution(),
        )

    def end(
        self,
        pending: Pending | None,
        *,
        status: int,
        headers: Any,
        content_type: str,
        body: bytes | None,
        streamed: bool = False,
    ) -> None:
        if pending is None:
            return
        try:
            output: Any
            parsed: Any = None
            ctype = (content_type or "").lower()
            if streamed or body is None:
                output = {"note": "response body not captured (streaming/unread)"}
            elif ctype.startswith(_MEDIA_PREFIXES):
                output = self._lift(RawBytes(body, ctype.split(";")[0]))
            elif "json" in ctype:
                try:
                    parsed = json.loads(body)
                except ValueError:
                    parsed = body.decode("utf-8", "replace")
                output = self._lift(parsed)
            else:
                mime = sniff_mime(body)
                output = (
                    self._lift(RawBytes(body, mime))
                    if mime
                    else self._lift(body.decode("utf-8", "replace"))
                )
            if pending.deferred:
                if not _is_terminal_poll(parsed):
                    return
                pending.handle = self._start(pending)
            if pending.handle is None:
                return
            request_id = ""
            getter = getattr(headers, "get", None)
            for name in _REQUEST_ID_HEADERS:
                value = getter(name) if callable(getter) else None
                if value:
                    request_id = str(value)
                    break
            error = ""
            if status >= 400:
                error = f"HTTP {status}"
                if isinstance(parsed, (dict, str)):
                    error = f"{error}: {json.dumps(parsed, default=str)[:300]}"
            self.sink.finish(
                pending.handle,
                Finish(
                    output=output,
                    status_code=status,
                    error=error,
                    usage=_usage(parsed),
                    metadata={
                        "status_code": status,
                        "latency_ms": int((time.monotonic() - pending.started) * 1000),
                        "provider_request_id": request_id,
                    },
                ),
            )
        except Exception as exc:
            logger.debug("llm_call_log end failed: %s", exc)

    def fail(self, pending: Pending | None, exc: BaseException) -> None:
        if pending is None or pending.deferred or pending.handle is None:
            return
        try:
            self.sink.finish(
                pending.handle,
                Finish(
                    error=f"{type(exc).__name__}: {exc}",
                    metadata={
                        "latency_ms": int((time.monotonic() - pending.started) * 1000),
                    },
                ),
            )
        except Exception as inner:
            logger.debug("llm_call_log fail failed: %s", inner)

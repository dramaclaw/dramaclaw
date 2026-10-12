"""Process-wide HTTP interception (httpx + aiohttp).

Every model call in the app goes through one of these two clients, either
directly (images, TTS, video) or underneath an SDK (openai, google-genai,
litellm, pydantic-ai), so patching them captures all endpoints without touching
the call sites.
"""

from __future__ import annotations

import functools
import logging
from typing import Any

from novelvideo.llm_call_log.tracker import CallTracker

logger = logging.getLogger("novelvideo.llm_call_log")

_installed_httpx = False
_installed_aiohttp = False


def _httpx_request_body(request: Any) -> bytes | None:
    try:
        return request.content  # raises RequestNotRead for generator bodies
    except Exception:
        return None


def _httpx_response_body(response: Any, stream: bool) -> bytes | None:
    if stream:
        return None
    try:
        return response.content
    except Exception:  # streaming response that was not read
        return None


def install_httpx_hook(tracker: CallTracker) -> None:
    global _installed_httpx
    if _installed_httpx:
        return
    import httpx

    original_async = httpx.AsyncClient.send
    original_sync = httpx.Client.send

    @functools.wraps(original_async)
    async def _async_send(self, request, **kwargs):
        if tracker.wants(str(request.url)):
            try:
                await (
                    request.aread()
                )  # multipart/streamed bodies are unreadable until buffered
            except Exception:
                pass
        pending = tracker.begin(
            request.method,
            str(request.url),
            request.headers.get("content-type", ""),
            _httpx_request_body(request),
        )
        if pending is None:
            return await original_async(self, request, **kwargs)
        stream = bool(kwargs.get("stream"))
        try:
            response = await original_async(self, request, **kwargs)
        except BaseException as exc:
            tracker.fail(pending, exc)
            raise
        tracker.end(
            pending,
            status=response.status_code,
            headers=response.headers,
            content_type=response.headers.get("content-type", ""),
            body=_httpx_response_body(response, stream),
            streamed=stream,
        )
        return response

    @functools.wraps(original_sync)
    def _sync_send(self, request, **kwargs):
        if tracker.wants(str(request.url)):
            try:
                request.read()
            except Exception:
                pass
        pending = tracker.begin(
            request.method,
            str(request.url),
            request.headers.get("content-type", ""),
            _httpx_request_body(request),
        )
        if pending is None:
            return original_sync(self, request, **kwargs)
        stream = bool(kwargs.get("stream"))
        try:
            response = original_sync(self, request, **kwargs)
        except BaseException as exc:
            tracker.fail(pending, exc)
            raise
        tracker.end(
            pending,
            status=response.status_code,
            headers=response.headers,
            content_type=response.headers.get("content-type", ""),
            body=_httpx_response_body(response, stream),
            streamed=stream,
        )
        return response

    httpx.AsyncClient.send = _async_send  # type: ignore[method-assign]
    httpx.Client.send = _sync_send  # type: ignore[method-assign]
    _installed_httpx = True


def _aiohttp_request_body(
    kwargs: dict[str, Any],
) -> tuple[str, bytes | dict | list | None]:
    if kwargs.get("json") is not None:
        return "application/json", kwargs["json"]
    data = kwargs.get("data")
    if isinstance(data, (bytes, bytearray)):
        return "application/octet-stream", bytes(data)
    if isinstance(data, dict):
        return "application/json", data
    fields = getattr(data, "_fields", None)  # aiohttp.FormData
    if fields:
        from novelvideo.llm_call_log.payload import RawBytes

        out: dict[str, Any] = {}
        for type_options, _headers, value in fields:
            name = str(type_options.get("name", f"part{len(out)}"))
            if isinstance(value, (bytes, bytearray)):
                out[name] = RawBytes(
                    bytes(value), "", str(type_options.get("filename", ""))
                )
            elif isinstance(value, str):
                out[name] = value
            else:
                out[name] = {"type": "stream_omitted"}
        return "application/json", out
    return "", None


def install_aiohttp_hook(tracker: CallTracker) -> None:
    global _installed_aiohttp
    if _installed_aiohttp:
        return
    try:
        import aiohttp
    except ImportError:
        return

    original = aiohttp.ClientSession._request

    @functools.wraps(original)
    async def _request(self, method, str_or_url, **kwargs):
        ctype, body = _aiohttp_request_body(kwargs)
        pending = tracker.begin(method, str(str_or_url), ctype, body)
        if pending is None:
            return await original(self, method, str_or_url, **kwargs)
        try:
            response = await original(self, method, str_or_url, **kwargs)
        except BaseException as exc:
            tracker.fail(pending, exc)
            raise
        response_type = response.headers.get("Content-Type", "")
        data: bytes | None = None
        if "json" in response_type.lower():
            try:
                data = await response.read()  # cached by aiohttp; .json() still works
            except Exception:
                data = None
        tracker.end(
            pending,
            status=response.status,
            headers=response.headers,
            content_type=response_type,
            body=data,
            streamed=data is None,
        )
        return response

    aiohttp.ClientSession._request = _request  # type: ignore[method-assign]
    _installed_aiohttp = True

"""Message-free facts about a failure, taken from the exception itself."""

from __future__ import annotations

import re
from typing import Any, TypeVar

CONFIGURATION = "configuration"
SERVER_FAULT = "server_fault"
FAILURE_KINDS = frozenset({CONFIGURATION, SERVER_FAULT})
_MAX_CHAIN = 8


def _chain(exc: BaseException) -> list[BaseException]:
    links: list[BaseException] = []
    link: BaseException | None = exc
    while link is not None and len(links) < _MAX_CHAIN and all(link is not x for x in links):
        links.append(link)
        link = link.__cause__ or (None if link.__suppress_context__ else link.__context__)
    return links


def _valid_status(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 400 <= value <= 599:
        return value
    return None


def sanitize_failure_signal(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    signal: dict[str, Any] = {}
    kind = value.get("failure_kind")
    if isinstance(kind, str) and kind in FAILURE_KINDS:
        signal["failure_kind"] = kind
    status = _valid_status(value.get("upstream_status"))
    if status is not None:
        signal["upstream_status"] = status
    for key in ("failure_exception", "error_code"):
        code = value.get(key)
        if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", code):
            signal[key] = code
    return signal


def upstream_status_of(source: object) -> int | None:
    if isinstance(source, int):
        return _valid_status(source)
    if not isinstance(source, BaseException):
        return _valid_status(getattr(source, "upstream_status", None))

    try:
        from httpx import HTTPStatusError
    except ImportError:
        HTTPStatusError = None
    try:
        from pydantic_ai.exceptions import ModelHTTPError
    except ImportError:
        ModelHTTPError = None
    try:
        from openai import APIStatusError
    except ImportError:
        APIStatusError = None

    for link in _chain(source):
        status = _valid_status(vars(link).get("upstream_status"))
        if status is not None:
            return status
        if HTTPStatusError is not None and isinstance(link, HTTPStatusError):
            status = _valid_status(getattr(getattr(link, "response", None), "status_code", None))
        elif (ModelHTTPError is not None and isinstance(link, ModelHTTPError)) or (
            APIStatusError is not None and isinstance(link, APIStatusError)
        ):
            status = _valid_status(link.status_code)
        if status is not None:
            return status
    return None


_ExceptionT = TypeVar("_ExceptionT", bound=BaseException)


def with_upstream_status(exc: _ExceptionT, source: object) -> _ExceptionT:
    status = upstream_status_of(source)
    if status is not None:
        setattr(exc, "upstream_status", status)
    return exc


class UpstreamErrorText(str):
    upstream_status: int


def upstream_error_text(text: str, source: object) -> str:
    status = upstream_status_of(source)
    if status is None:
        return str(text)
    error = UpstreamErrorText(text)
    error.upstream_status = status
    return error


def exception_failure_signal(exc: BaseException) -> dict[str, Any]:
    """Describe a failure by exception type and HTTP status; the message text is never parsed.

    An exception class opts in to a kind by declaring ``failure_kind`` as a class attribute.
    """
    signal: dict[str, Any] = {"failure_exception": type(exc).__name__}
    for link in _chain(exc):
        kind = getattr(type(link), "failure_kind", None)
        if isinstance(kind, str) and kind in FAILURE_KINDS:
            signal["failure_kind"] = kind
            break
    status = upstream_status_of(exc)
    if status is not None:
        signal["upstream_status"] = status
    return signal

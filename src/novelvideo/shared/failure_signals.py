"""Message-free facts about a failure, taken from the exception itself."""

from __future__ import annotations

from typing import Any

CONFIGURATION = "configuration"
FAILURE_KINDS = frozenset({CONFIGURATION})
_MAX_CHAIN = 8


def _chain(exc: BaseException) -> list[BaseException]:
    links: list[BaseException] = []
    link: BaseException | None = exc
    while link is not None and len(links) < _MAX_CHAIN and all(link is not x for x in links):
        links.append(link)
        link = link.__cause__ or (None if link.__suppress_context__ else link.__context__)
    return links


def exception_failure_signal(exc: BaseException) -> dict[str, Any]:
    """Describe a failure by exception type and HTTP status; the message text is never parsed.

    An exception class opts in to a kind by declaring ``failure_kind`` as a class attribute.
    """
    signal: dict[str, Any] = {"failure_exception": type(exc).__name__}
    try:
        from httpx import HTTPStatusError
    except ImportError:
        HTTPStatusError = None
    for link in _chain(exc):
        kind = getattr(type(link), "failure_kind", None)
        if "failure_kind" not in signal and isinstance(kind, str) and kind in FAILURE_KINDS:
            signal["failure_kind"] = kind
        if (
            "upstream_status" not in signal
            and HTTPStatusError is not None
            and isinstance(link, HTTPStatusError)
        ):
            status = getattr(getattr(link, "response", None), "status_code", None)
            if type(status) is int:
                signal["upstream_status"] = status
    return signal

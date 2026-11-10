"""Chat storage keeps addresses only; inline ``data:`` URLs are dropped on write.

Base64 payloads in chat rows are read back with every history load, so one
pasted image costs memory on every page view. Media belongs in the output
directory and chat keeps its address. This is the last check before SQLite:
whatever path a ``data:`` URL took to get here, it is removed and logged.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# ``data:[<mediatype>][;param]*,<payload>``. The scheme must start a token, so
# prose like "metadata: a,b" or "data: is a scheme" is left alone.
_INLINE_DATA_URL = re.compile(
    r"(?<![\w-])data:(?:[\w.+-]+/[\w.+-]+)?(?:;[\w.+=-]+)*,[^\s\"'<>)\]]*",
    re.IGNORECASE,
)
_DROPPED = object()


def drop_inline_data(value: Any) -> Any:
    """Return ``value`` without inline ``data:`` URLs, logging how many were dropped.

    A string that is only a ``data:`` URL is removed from its dict or list; a
    ``data:`` URL inside a longer string is cut out of it.
    """

    counter = [0]
    cleaned = _drop(value, counter)
    if counter[0]:
        logger.warning("dropped %d inline data value(s) from chat storage", counter[0])
    return "" if cleaned is _DROPPED else cleaned


def _drop(value: Any, counter: list[int]) -> Any:
    if isinstance(value, str):
        if "data:" not in value.lower():
            return value
        stripped, count = _INLINE_DATA_URL.subn("", value)
        if not count:
            return value
        counter[0] += count
        return _DROPPED if not stripped.strip() else stripped
    if isinstance(value, dict):
        kept = {}
        for key, item in value.items():
            cleaned = _drop(item, counter)
            if cleaned is not _DROPPED:
                kept[key] = cleaned
        return kept
    if isinstance(value, (list, tuple)):
        return [cleaned for item in value if (cleaned := _drop(item, counter)) is not _DROPPED]
    return value

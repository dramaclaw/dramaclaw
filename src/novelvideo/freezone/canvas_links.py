"""Build canvas page links from the API's configured public origin."""

import logging
import os
import re
from threading import Lock
from unicodedata import category
from urllib.parse import quote, urlsplit

_logger = logging.getLogger(__name__)
_warned_values: set[str] = set()
_warning_lock = Lock()


def warn_if_public_origin_invalid() -> None:
    public_origin()


def public_origin() -> str | None:
    name = "DRAMACLAW_PUBLIC_ORIGIN"
    value = os.environ.get(name, "")
    if not value.strip():
        name = "SUPERTALE_OPENFILM_STUDIO_PUBLIC_ORIGIN"
        value = os.environ.get(name, "")
    if not value.strip():
        return None
    reason = _invalid_origin_reason(value)
    if reason is None:
        return value.removesuffix("/")
    with _warning_lock:
        if value not in _warned_values:
            _warned_values.add(value)
            _logger.warning(
                "%s is invalid: %s. Canvas tools will not return canvas_url until this is fixed.",
                name,
                reason,
            )
    return None


def _invalid_origin_reason(value: str) -> str | None:
    # urlsplit normalizes some controls and accepts empty query/fragment separators.
    if any(char.isspace() or category(char) == "Cc" for char in value):
        return "contains whitespace or control characters"
    if "\\" in value:
        return "contains a backslash"
    try:
        origin = urlsplit(value)
    except ValueError:
        return "has an invalid host"
    if origin.scheme not in {"http", "https"}:
        return "scheme must be http or https"
    if not origin.hostname:
        return "has no host"
    if origin.username is not None:
        return "has user info"
    if origin.path not in {"", "/"}:
        return "has a path"
    if "?" in value:
        return "has a query"
    if "#" in value:
        return "has a fragment"
    if re.fullmatch(r"(?:\[[^\[\]]+\]|[^:\[\]]+)(?::[0-9]+)?", origin.netloc) is None:
        return "has an invalid port"
    try:
        origin.port  # urllib validates the port range on access.
    except ValueError:
        return "has an invalid port"
    return None


def canvas_page_url(project: str, canvas_id: str) -> str | None:
    origin = public_origin()
    if origin is None:
        return None
    return f"{origin}/projects/{quote(project, safe='')}/freezone?canvas={quote(canvas_id, safe='')}"

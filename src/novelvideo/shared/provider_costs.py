"""Conservative classification of provider responses that cannot incur generation cost."""

from __future__ import annotations

_DEFINITE_NO_COST_HTTP_STATUSES = frozenset(
    {
        400,  # invalid request
        401,  # authentication rejected
        402,  # provider balance rejected
        403,  # permission rejected
        404,  # model or endpoint not found
        405,  # endpoint method rejected
        413,  # payload rejected before processing
        415,  # media type rejected
        422,  # request validation rejected
        429,  # rate limit rejected
    }
)


def is_definite_no_cost_http_rejection(status_code: int | None) -> bool:
    """Return true only when HTTP semantics prove generation was rejected.

    Request timeout (408), conflict/idempotency responses (409), client aborts,
    and all 5xx responses remain unknown because the provider may already have
    accepted the paid work.
    """
    try:
        clean_status = int(status_code or 0)
    except (TypeError, ValueError):
        return False
    return clean_status in _DEFINITE_NO_COST_HTTP_STATUSES

"""Bounded retry for side-effect-free authorization reads."""

from __future__ import annotations

import asyncio
import logging
import math
import random as random_module
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

from novelvideo.ports.authz import AuthzServiceUnavailable

T = TypeVar("T")
logger = logging.getLogger("novelvideo.authz_retry")


def _countdown_bucket(delay: float) -> str:
    if delay < 1.0:
        return "under_1_second"
    if delay < 5.0:
        return "1_to_5_seconds"
    if delay < 30.0:
        return "5_to_30_seconds"
    return "30_seconds_or_more"


def validate_authz_retry_policy(
    *,
    max_retries: int,
    base_delay: float,
    cap_delay: float,
) -> None:
    """Reject ambiguous or unbounded retry policies at startup."""
    if type(max_retries) is not int or max_retries < 0:
        raise ValueError("max_retries must be a non-negative integer")
    if (
        isinstance(base_delay, bool)
        or not isinstance(base_delay, (int, float))
        or not math.isfinite(base_delay)
        or base_delay <= 0
    ):
        raise ValueError("base_delay must be a positive finite number")
    if (
        isinstance(cap_delay, bool)
        or not isinstance(cap_delay, (int, float))
        or not math.isfinite(cap_delay)
        or cap_delay < base_delay
    ):
        raise ValueError("cap_delay must be finite and at least base_delay")


async def retry_authz_read(
    operation: Callable[[], Awaitable[T]],
    *,
    max_retries: int,
    base_delay: float,
    cap_delay: float,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    random: Callable[[], float] = random_module.random,
    monotonic: Callable[[], float] = time.monotonic,
    deadline: float | None = None,
    check_cancelled: Callable[[], None] | None = None,
    call_site: str = "unspecified",
) -> T:
    """Retry only typed authz service failures using bounded full jitter.

    ``max_retries`` counts calls after the initial attempt. ``deadline`` is an
    absolute value in the injected monotonic clock's domain.
    """
    validate_authz_retry_policy(
        max_retries=max_retries,
        base_delay=base_delay,
        cap_delay=cap_delay,
    )

    for retry_index in range(max_retries + 1):
        if check_cancelled is not None:
            check_cancelled()
        try:
            result = await operation()
            if retry_index:
                logger.info(
                    "authz_local_retry_recovered",
                    extra={"call_site": call_site, "attempts": retry_index + 1},
                )
            return result
        except AuthzServiceUnavailable as error:
            if retry_index >= max_retries:
                logger.warning(
                    "authz_local_retry_exhausted",
                    extra={
                        "call_site": call_site,
                        "attempts": retry_index + 1,
                        "failure_kind": error.failure_kind,
                    },
                )
                raise

            jitter_ratio = random()
            if (
                isinstance(jitter_ratio, bool)
                or not isinstance(jitter_ratio, (int, float))
                or not math.isfinite(jitter_ratio)
                or not 0.0 <= jitter_ratio <= 1.0
            ):
                raise ValueError("random must return a finite value between 0 and 1")
            upper_bound = min(cap_delay, base_delay * (2**retry_index))
            delay = float(jitter_ratio) * upper_bound

            if check_cancelled is not None:
                check_cancelled()
            if deadline is not None and monotonic() + delay > deadline:
                logger.warning(
                    "authz_local_retry_exhausted",
                    extra={
                        "call_site": call_site,
                        "attempts": retry_index + 1,
                        "failure_kind": error.failure_kind,
                    },
                )
                raise
            logger.warning(
                "authz_local_retry_scheduled",
                extra={
                    "call_site": call_site,
                    "attempts": retry_index + 1,
                    "countdown_bucket": _countdown_bucket(delay),
                    "failure_kind": error.failure_kind,
                },
            )
            await sleep(delay)

    raise RuntimeError("authz retry loop exhausted unexpectedly")

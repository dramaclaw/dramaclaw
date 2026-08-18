from __future__ import annotations

import asyncio

import pytest

from novelvideo.ports.authz import (
    AuthzError,
    AuthzServiceFault,
    AuthzServiceUnavailable,
)


@pytest.mark.asyncio
async def test_retry_authz_read_recovers_with_full_jitter() -> None:
    from novelvideo.authz_retry import retry_authz_read

    attempts = 0
    delays: list[float] = []
    random_values = iter((0.5, 0.25))

    async def operation() -> str:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise AuthzServiceUnavailable()
        if attempts == 2:
            raise AuthzServiceFault()
        return "admitted"

    async def sleep(delay: float) -> None:
        delays.append(delay)

    result = await retry_authz_read(
        operation,
        max_retries=2,
        base_delay=1.0,
        cap_delay=8.0,
        sleep=sleep,
        random=lambda: next(random_values),
    )

    assert result == "admitted"
    assert attempts == 3
    assert delays == [0.5, 0.5]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_type", [AuthzServiceUnavailable, AuthzServiceFault])
async def test_retry_authz_read_uses_max_retries_after_the_initial_call(
    failure_type,
) -> None:
    from novelvideo.authz_retry import retry_authz_read

    attempts = 0
    delays: list[float] = []

    async def operation() -> None:
        nonlocal attempts
        attempts += 1
        raise failure_type()

    async def sleep(delay: float) -> None:
        delays.append(delay)

    with pytest.raises(failure_type):
        await retry_authz_read(
            operation,
            max_retries=2,
            base_delay=2.0,
            cap_delay=3.0,
            sleep=sleep,
            random=lambda: 1.0,
        )

    assert attempts == 3
    assert delays == [2.0, 3.0]


@pytest.mark.asyncio
async def test_retry_authz_read_does_not_retry_deterministic_denial() -> None:
    from novelvideo.authz_retry import retry_authz_read

    attempts = 0
    delays: list[float] = []

    async def operation() -> None:
        nonlocal attempts
        attempts += 1
        raise AuthzError("ORG_AUTHZ_STALE")

    async def sleep(delay: float) -> None:
        delays.append(delay)

    with pytest.raises(AuthzError) as caught:
        await retry_authz_read(
            operation,
            max_retries=4,
            base_delay=1.0,
            cap_delay=8.0,
            sleep=sleep,
        )

    assert caught.value.code == "ORG_AUTHZ_STALE"
    assert attempts == 1
    assert delays == []


@pytest.mark.asyncio
async def test_retry_authz_read_propagates_cancellation_without_sleep() -> None:
    from novelvideo.authz_retry import retry_authz_read

    delays: list[float] = []

    async def operation() -> None:
        raise asyncio.CancelledError

    async def sleep(delay: float) -> None:
        delays.append(delay)

    with pytest.raises(asyncio.CancelledError):
        await retry_authz_read(
            operation,
            max_retries=4,
            base_delay=1.0,
            cap_delay=8.0,
            sleep=sleep,
        )

    assert delays == []


@pytest.mark.asyncio
async def test_retry_authz_read_stops_before_crossing_deadline() -> None:
    from novelvideo.authz_retry import retry_authz_read

    attempts = 0
    delays: list[float] = []

    async def operation() -> None:
        nonlocal attempts
        attempts += 1
        raise AuthzServiceUnavailable()

    async def sleep(delay: float) -> None:
        delays.append(delay)

    with pytest.raises(AuthzServiceUnavailable):
        await retry_authz_read(
            operation,
            max_retries=4,
            base_delay=2.0,
            cap_delay=8.0,
            sleep=sleep,
            random=lambda: 1.0,
            monotonic=lambda: 10.0,
            deadline=11.0,
        )

    assert attempts == 1
    assert delays == []


@pytest.mark.asyncio
async def test_retry_authz_read_calls_cancellation_check_before_retry() -> None:
    from novelvideo.authz_retry import retry_authz_read

    attempts = 0
    checks = 0

    async def operation() -> None:
        nonlocal attempts
        attempts += 1
        raise AuthzServiceUnavailable()

    def check_cancelled() -> None:
        nonlocal checks
        checks += 1
        if checks == 2:
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await retry_authz_read(
            operation,
            max_retries=4,
            base_delay=1.0,
            cap_delay=8.0,
            sleep=lambda _delay: asyncio.sleep(0),
            random=lambda: 0.0,
            check_cancelled=check_cancelled,
        )

    assert attempts == 1
    assert checks == 2


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"max_retries": -1}, "max_retries"),
        ({"base_delay": 0.0}, "base_delay"),
        ({"cap_delay": 0.0}, "cap_delay"),
        ({"base_delay": 2.0, "cap_delay": 1.0}, "cap_delay"),
    ],
)
def test_retry_authz_read_rejects_invalid_policy(kwargs, message) -> None:
    from novelvideo.authz_retry import validate_authz_retry_policy

    values = {"max_retries": 2, "base_delay": 1.0, "cap_delay": 8.0}
    values.update(kwargs)

    with pytest.raises(ValueError, match=message):
        validate_authz_retry_policy(**values)

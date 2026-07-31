"""Hermes authorization invalidation draining tests."""

from __future__ import annotations

import asyncio
import time

import pytest

from novelvideo.chat.hermes_pool import (
    HermesDrainingError,
    HermesPool,
    _WorkerSlot,
)
from novelvideo.chat.hermes_workspace import effective_gateway_fingerprint
from novelvideo.ports.auth_contract import AgentSessionToken


class _Thread:
    id = "thread-1"
    is_closed = False

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = 0

    async def stream(self, _prompt: str, *, current_project: str | None = None):
        del current_project
        self.started.set()
        yield "started"
        await self.release.wait()
        yield "complete"

    async def close(self) -> None:
        self.closed += 1
        self.is_closed = True


class _FlakyThread(_Thread):
    async def close(self) -> None:
        self.closed += 1
        if self.closed == 1:
            raise RuntimeError("CLOSE-CANARY")
        self.is_closed = True


class _Client:
    pass


def _slot(thread: _Thread) -> _WorkerSlot:
    return _WorkerSlot(
        username="alice",
        client=_Client(),  # type: ignore[arg-type]
        thread=thread,  # type: ignore[arg-type]
        token=AgentSessionToken(
            value="secret",
            session_id="session-1",
            user="alice",
            scopes=(),
            exp=int(time.time()) + 3600,
            worker_id="worker-1",
        ),
        gateway_fingerprint=effective_gateway_fingerprint(),
    )


@pytest.mark.asyncio
async def test_idle_worker_closes_immediately_and_duplicate_drain_is_safe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = HermesPool()
    thread = _Thread()
    pool._slots["alice"] = _slot(thread)

    async def revoke(_token: str) -> None:
        return None

    monkeypatch.setattr(pool, "_revoke_agent_session", revoke)
    assert await pool.drain_user("alice") is True
    assert await pool.drain_user("alice") is False
    assert thread.closed == 1
    assert pool.stats()["states"] == {}


@pytest.mark.asyncio
async def test_active_turn_finishes_but_draining_rejects_new_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = HermesPool()
    thread = _Thread()
    pool._slots["alice"] = _slot(thread)

    async def revoke(_token: str) -> None:
        return None

    monkeypatch.setattr(pool, "_revoke_agent_session", revoke)
    monkeypatch.setattr(pool, "_update_scope_locked", _noop_scope)
    managed = await pool.get_for_user("alice")

    async def consume() -> list[str]:
        return [event async for event in managed.stream("hello")]

    turn = asyncio.create_task(consume())
    await thread.started.wait()
    assert await pool.drain_user("alice") is True
    with pytest.raises(HermesDrainingError):
        await pool.get_for_user("alice")
    thread.release.set()
    assert await turn == ["started", "complete"]
    assert thread.closed == 1
    assert "alice" not in pool.stats()["states"]


@pytest.mark.asyncio
async def test_generation_preflight_closes_stale_worker_and_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = HermesPool()
    thread = _Thread()
    slot = _slot(thread)
    slot.authz_generation = 4
    pool._slots["alice"] = slot

    async def revoke(_token: str) -> None:
        return None

    async def generation(_username: str) -> int:
        return 5

    monkeypatch.setattr(pool, "_revoke_agent_session", revoke)
    pool.set_authz_generation_reader(generation)
    with pytest.raises(HermesDrainingError):
        await pool.get_for_user("alice")
    assert thread.closed == 1
    assert "alice" not in pool.stats()["states"]

    async def unavailable(_username: str) -> int:
        raise RuntimeError("REDIS-DSN-CANARY")

    pool.set_authz_generation_reader(unavailable)
    with pytest.raises(HermesDrainingError) as caught:
        await pool.get_for_user("bob")
    assert "CANARY" not in str(caught.value)
    assert "CANARY" not in repr(caught.value)


@pytest.mark.asyncio
async def test_turn_boundary_rechecks_generation_after_thread_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = HermesPool()
    thread = _Thread()
    slot = _slot(thread)
    slot.authz_generation = 4
    pool._slots["alice"] = slot
    generation = 4

    async def read_generation(_username: str) -> int:
        return generation

    async def revoke(_token: str) -> None:
        return None

    monkeypatch.setattr(pool, "_update_scope_locked", _noop_scope)
    monkeypatch.setattr(pool, "_revoke_agent_session", revoke)
    pool.set_authz_generation_reader(read_generation)
    managed = await pool.get_for_user("alice")
    generation = 5
    with pytest.raises(HermesDrainingError):
        await anext(managed.stream("must-not-start"))
    assert thread.started.is_set() is False
    assert pool.stats()["states"] == {}


@pytest.mark.asyncio
async def test_duplicate_drain_retries_safe_close_failure(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pool = HermesPool()
    thread = _FlakyThread()
    pool._slots["alice"] = _slot(thread)

    async def revoke(_token: str) -> None:
        return None

    monkeypatch.setattr(pool, "_revoke_agent_session", revoke)
    assert await pool.drain_user("alice") is True
    assert pool.stats()["states"] == {"alice": "draining"}
    assert await pool.drain_user("alice") is False
    assert thread.closed == 2
    assert pool.stats()["states"] == {}
    assert "CLOSE-CANARY" not in caplog.text


async def _noop_scope(_slot: object, _scope_kind: str, _project_id: str | None) -> None:
    return None

"""GracefulUvicornWorker: SSE streams end cooperatively when a worker recycles.

Without it, a uvicorn worker that hits ``--max-requests`` waits forever for
in-flight ``EventSourceResponse`` streams (``/tasks/stream``) to finish, stops
heartbeating, and is SIGABRT'd by the gunicorn master after ``--timeout``.
"""

from __future__ import annotations

import asyncio
import logging
import socket
from collections.abc import AsyncIterator

import anyio
import httpx
import pytest
from fastapi import FastAPI
from gunicorn.config import Config as GunicornConfig
from gunicorn.glogging import Logger as GunicornLogger
from sse_starlette import sse as sse_module
from sse_starlette.sse import AppStatus, EventSourceResponse
from uvicorn.config import Config as UvicornConfig
from uvicorn.server import Server
from uvicorn.workers import UvicornWorker

from novelvideo.api import gunicorn_worker
from novelvideo.api.gunicorn_worker import (
    DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT,
    GRACEFUL_SHUTDOWN_TIMEOUT_ENV,
    GracefulUvicornWorker,
    install_sse_shutdown_bridge,
)
from novelvideo.api.sse_shutdown import (
    shutdown_aware_sse_response,
    wait_interval_or_shutdown,
)


@pytest.fixture(autouse=True)
def _isolate_global_state(monkeypatch: pytest.MonkeyPatch):
    """The bridge patches ``Server.shutdown``, sse-starlette keeps a
    process-wide exit flag plus a per-thread watcher, and ``UvicornWorker``
    replaces the ``uvicorn.*`` logger handlers; none may leak into other tests."""
    monkeypatch.setattr(Server, "shutdown", gunicorn_worker._ORIGINAL_SERVER_SHUTDOWN)
    monkeypatch.setattr(AppStatus, "should_exit", False)
    monkeypatch.setattr(sse_module._thread_state, "shutdown_state", None, raising=False)
    for name in ("uvicorn.error", "uvicorn.access"):
        log = logging.getLogger(name)
        monkeypatch.setattr(log, "handlers", list(log.handlers))
        monkeypatch.setattr(log, "propagate", log.propagate)
        monkeypatch.setattr(log, "level", log.level)
    yield
    AppStatus.should_exit = False


@pytest.fixture
def _close_worker_tmp():
    workers: list[UvicornWorker] = []
    yield workers
    for worker in workers:
        worker.tmp.close()


def _make_worker(
    registry: list[UvicornWorker], cls: type[UvicornWorker] = GracefulUvicornWorker
) -> UvicornWorker:
    cfg = GunicornConfig()
    worker = cls(
        age=0,
        ppid=0,
        sockets=[],
        app=None,
        timeout=120,
        cfg=cfg,
        log=GunicornLogger(cfg),
    )
    registry.append(worker)
    return worker


# --- worker configuration -------------------------------------------------


def test_is_drop_in_replacement_for_uvicorn_worker() -> None:
    assert issubclass(GracefulUvicornWorker, UvicornWorker)


def test_backstop_timeout_default(
    monkeypatch: pytest.MonkeyPatch, _close_worker_tmp: list
) -> None:
    monkeypatch.delenv(GRACEFUL_SHUTDOWN_TIMEOUT_ENV, raising=False)

    worker = _make_worker(_close_worker_tmp)

    assert worker.config.timeout_graceful_shutdown == DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT
    # Below gunicorn's default --graceful-timeout (30 s SIGKILL on rollout) and
    # below half of the 120 s --timeout used in production.
    assert 0 < DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT < 30


def test_keeps_base_uvicorn_worker_config(
    monkeypatch: pytest.MonkeyPatch, _close_worker_tmp: list
) -> None:
    monkeypatch.delenv(GRACEFUL_SHUTDOWN_TIMEOUT_ENV, raising=False)

    worker = _make_worker(_close_worker_tmp)

    for key, value in UvicornWorker.CONFIG_KWARGS.items():
        assert getattr(worker.config, key) == value
    assert "timeout_graceful_shutdown" not in UvicornWorker.CONFIG_KWARGS


def test_backstop_timeout_env_override(
    monkeypatch: pytest.MonkeyPatch, _close_worker_tmp: list
) -> None:
    monkeypatch.setenv(GRACEFUL_SHUTDOWN_TIMEOUT_ENV, "7")

    worker = _make_worker(_close_worker_tmp)

    assert worker.config.timeout_graceful_shutdown == 7


@pytest.mark.parametrize("raw", ["", "abc", "0", "-5", "2.5"])
def test_invalid_env_falls_back_to_default(
    raw: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    _close_worker_tmp: list,
) -> None:
    monkeypatch.setenv(GRACEFUL_SHUTDOWN_TIMEOUT_ENV, raw)

    with caplog.at_level(logging.WARNING):
        worker = _make_worker(_close_worker_tmp)

    assert worker.config.timeout_graceful_shutdown == DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT
    assert GRACEFUL_SHUTDOWN_TIMEOUT_ENV in caplog.text


def test_worker_construction_installs_bridge(_close_worker_tmp: list) -> None:
    assert Server.shutdown is gunicorn_worker._ORIGINAL_SERVER_SHUTDOWN

    _make_worker(_close_worker_tmp)

    assert Server.shutdown is not gunicorn_worker._ORIGINAL_SERVER_SHUTDOWN


def test_stock_uvicorn_worker_leaves_server_shutdown_untouched(
    _close_worker_tmp: list,
) -> None:
    """Environments that keep ``uvicorn.workers.UvicornWorker`` must see no change."""
    _make_worker(_close_worker_tmp, cls=UvicornWorker)

    assert Server.shutdown is gunicorn_worker._ORIGINAL_SERVER_SHUTDOWN


def test_install_is_idempotent() -> None:
    install_sse_shutdown_bridge()
    patched = Server.shutdown
    install_sse_shutdown_bridge()

    assert Server.shutdown is patched


# --- the behaviour that matters -------------------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _naive_sse_app() -> FastAPI:
    """A stream that never ends on its own, like the stock ``/tasks/stream``."""
    app = FastAPI()

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    @app.get("/stream")
    async def stream():
        async def gen():
            while True:
                yield {"data": "tick"}
                await asyncio.sleep(0.2)

        return EventSourceResponse(gen())

    return app


def _cooperative_sse_app() -> FastAPI:
    """The same stream written with the shutdown-aware helpers used by the API."""
    app = FastAPI()

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    @app.get("/stream")
    async def stream():
        async def gen(shutdown: anyio.Event):
            while True:
                yield {"data": "tick"}
                if await wait_interval_or_shutdown(shutdown, 0.2):
                    return

        return shutdown_aware_sse_response(gen)

    return app


async def _serve_until_max_requests_and_open_stream(
    app: FastAPI, port: int
) -> tuple[asyncio.Task, httpx.AsyncClient, httpx.Response, AsyncIterator[bytes]]:
    """Reproduce the production path: with an SSE stream open, an ordinary
    request completes and trips ``--max-requests`` (``limit_max_requests``;
    uvicorn counts *completed* responses), so uvicorn enters
    ``Server.shutdown()`` while the stream is still open."""
    config = UvicornConfig(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        lifespan="off",
        limit_max_requests=1,
    )
    server = Server(config)
    serve_task = asyncio.create_task(server.serve())
    async with asyncio.timeout(5):
        while not server.started:
            if serve_task.done():
                serve_task.result()  # surfaces the bind error instead of looping
                raise AssertionError("server exited before starting")
            await asyncio.sleep(0.05)
    client = httpx.AsyncClient(timeout=10)
    req = client.build_request("GET", f"http://127.0.0.1:{port}/stream")
    resp = await client.send(req, stream=True)
    body = resp.aiter_bytes()
    chunk = await body.__anext__()
    assert b"tick" in chunk
    assert (await client.get(f"http://127.0.0.1:{port}/ping")).status_code == 200
    return serve_task, client, resp, body


async def test_max_requests_shutdown_without_bridge_hangs_on_open_sse_stream() -> None:
    """Documents the failure mode: stock uvicorn drain waits for the stream forever."""
    serve_task, client, resp, _body = await _serve_until_max_requests_and_open_stream(
        _naive_sse_app(), _free_port()
    )
    try:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(serve_task), timeout=2)
        assert AppStatus.should_exit is False
    finally:
        AppStatus.should_exit = True  # release the stream so the server can exit
        await resp.aclose()
        await client.aclose()
        await asyncio.wait_for(serve_task, timeout=5)


async def test_max_requests_shutdown_with_bridge_completes_cooperative_stream(
    caplog: pytest.LogCaptureFixture,
) -> None:
    install_sse_shutdown_bridge()
    caplog.set_level(logging.INFO, logger="uvicorn.error")
    serve_task, client, resp, body = await _serve_until_max_requests_and_open_stream(
        _cooperative_sse_app(), _free_port()
    )
    try:
        await asyncio.wait_for(serve_task, timeout=5)

        assert AppStatus.should_exit is True
        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert errors == [], [r.getMessage() for r in errors]
        # The response was *completed* by the server (final chunk sent), not cut:
        # the client drains the rest of the body without a protocol error.
        remaining = [chunk async for chunk in body]
        assert all(b"tick" in c for c in remaining if c)
    finally:
        await resp.aclose()
        await client.aclose()

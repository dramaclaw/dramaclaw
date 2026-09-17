"""Gunicorn worker class for the API whose recycles end SSE streams cooperatively.

Problem
-------
When a ``uvicorn.workers.UvicornWorker`` reaches ``--max-requests`` it stops
accepting, then waits for every in-flight response to finish before exiting.
``GET /projects/{id}/tasks/stream`` is an ``EventSourceResponse`` that stays
open for as long as the project page is open, so the drain never completes:
the worker stops heartbeating, and after ``--timeout`` the gunicorn master
logs ``WORKER TIMEOUT`` and SIGABRTs it (exit code 134).  The streams get cut
either way; the unbounded wait only adds ``--timeout`` seconds of a dead
worker and a CRITICAL log line per recycle.

Why the streams do not end by themselves
----------------------------------------
sse-starlette already knows how to end its streams on shutdown: every stream
waits on ``AppStatus.should_exit``, which sse-starlette raises from uvicorn's
*signal* exit path (its monkey-patched ``Server.handle_exit``) or by polling
``Server.should_exit``.  Rollouts (SIGTERM) therefore drain fine.  The
``--max-requests`` path raises neither flag: ``Server.on_tick`` returns True
straight into ``Server.shutdown()`` without calling ``handle_exit`` or setting
``Server.should_exit``, so nothing tells the streams to stop.

Fix
---
Bridge the two: wrap the public ``Server.shutdown`` so it raises
``AppStatus.should_exit`` *before* draining.  Every open SSE stream then ends
on its normal path within sse-starlette's poll interval, the drain completes,
and the worker exits 0 with nothing but INFO lines.  Clients (``EventSource``)
reconnect exactly as they already do after the SIGABRT, only ~100 s sooner.

uvicorn's own ``timeout_graceful_shutdown`` is kept as a backstop for
responses that are not SSE and do not finish on their own.  That path cancels
the task and logs ``Exception in ASGI application`` per cancelled response, so
it is deliberately not the primary mechanism.

Usage::

    gunicorn --worker-class novelvideo.api.gunicorn_worker.GracefulUvicornWorker ...

``NOVELVIDEO_API_GRACEFUL_SHUTDOWN_TIMEOUT`` (whole seconds, default 20) sets the backstop.
It must stay below gunicorn's ``--graceful-timeout`` (default 30 s, SIGKILL on
rollout) and below half of ``--timeout`` (the worker stops heartbeating when
its main loop exits, and the last heartbeat can be ``--timeout``/2 old).
"""

from __future__ import annotations

import logging
import os
import socket
from typing import Any

from sse_starlette.sse import AppStatus
from uvicorn.server import Server
from uvicorn.workers import UvicornWorker

logger = logging.getLogger(__name__)

GRACEFUL_SHUTDOWN_TIMEOUT_ENV = "NOVELVIDEO_API_GRACEFUL_SHUTDOWN_TIMEOUT"
DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT = 20

_ORIGINAL_SERVER_SHUTDOWN = Server.shutdown


async def _shutdown_with_sse_bridge(
    self: Server, sockets: list[socket.socket] | None = None
) -> None:
    AppStatus.should_exit = True
    await _ORIGINAL_SERVER_SHUTDOWN(self, sockets)


def install_sse_shutdown_bridge() -> None:
    """Make every ``Server.shutdown`` in this process end sse-starlette streams first. Idempotent."""
    if Server.shutdown is not _shutdown_with_sse_bridge:
        Server.shutdown = _shutdown_with_sse_bridge  # type: ignore[method-assign]


def _backstop_timeout_from_env() -> int:
    raw = os.environ.get(GRACEFUL_SHUTDOWN_TIMEOUT_ENV)
    if raw is None:
        return DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        logger.warning(
            "%s=%r is not a positive integer; using default %ss",
            GRACEFUL_SHUTDOWN_TIMEOUT_ENV,
            raw,
            DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT,
        )
        return DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT
    return value


class GracefulUvicornWorker(UvicornWorker):
    """Drop-in ``UvicornWorker`` whose ``--max-requests`` recycles do not hang on SSE."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # gunicorn constructs the worker in the master before forking, so the
        # patched class method is inherited by the child that runs the server.
        install_sse_shutdown_bridge()
        self.CONFIG_KWARGS = {
            **UvicornWorker.CONFIG_KWARGS,
            "timeout_graceful_shutdown": _backstop_timeout_from_env(),
        }
        super().__init__(*args, **kwargs)

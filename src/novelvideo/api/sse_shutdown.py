"""SSE responses that finish cleanly when the serving process shuts down.

sse-starlette signals server shutdown to each ``EventSourceResponse`` (see
``novelvideo.api.gunicorn_worker`` for how that signal reaches a gunicorn
worker that is recycling on ``--max-requests``).  Without cooperation from the
generator, the library reacts by *cancelling* the stream mid-body: uvicorn then
logs ``ASGI callable returned without completing response`` and closes the
socket, and the client sees a truncated chunked body.

With ``shutdown_event`` + ``shutdown_grace_period`` (sse-starlette issue #167)
the library first sets an event and waits up to the grace period; a generator
that watches the event and returns lets ``EventSourceResponse`` send the final
empty chunk, so the response completes normally and nothing is logged.

Usage::

    async def event_generator(shutdown: anyio.Event):
        while True:
            yield {...}
            if await wait_interval_or_shutdown(shutdown, interval):
                return

    return shutdown_aware_sse_response(event_generator)
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Any

import anyio
from sse_starlette.sse import EventSourceResponse

# How long sse-starlette waits for a cooperative generator to return before it
# cancels the stream anyway.  ``wait_interval_or_shutdown`` returns as soon as
# the event is set, so the poll interval costs nothing; what the grace period
# must cover is the uninterruptible work between two waits (the
# ``run_in_threadpool`` task listing, which on a FUSE-backed state dir can stall
# for seconds).  Keep it below the worker's graceful-shutdown backstop
# (``NOVELVIDEO_API_GRACEFUL_SHUTDOWN_TIMEOUT``, default 20 s).
SSE_SHUTDOWN_GRACE_SEC = 15.0


async def wait_interval_or_shutdown(shutdown: anyio.Event, seconds: float) -> bool:
    """Sleep for ``seconds`` unless ``shutdown`` is set first.

    Returns ``True`` when shutdown was signalled, in which case the generator
    should ``return`` so the response can complete.
    """
    with anyio.move_on_after(seconds):
        await shutdown.wait()
    return shutdown.is_set()


def shutdown_aware_sse_response(
    make_generator: Callable[[anyio.Event], AsyncIterator[Any]],
    **kwargs: Any,
) -> EventSourceResponse:
    """Build an ``EventSourceResponse`` whose generator is told about shutdown."""
    shutdown = anyio.Event()
    return EventSourceResponse(
        make_generator(shutdown),
        shutdown_event=shutdown,
        shutdown_grace_period=SSE_SHUTDOWN_GRACE_SEC,
        **kwargs,
    )

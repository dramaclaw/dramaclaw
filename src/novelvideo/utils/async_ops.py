import asyncio
import functools
from collections.abc import Awaitable, Callable
from typing import Any

import anyio
from anyio.lowlevel import RunVar


METADATA_IO_CONCURRENCY = 4
_metadata_io_limiter_var: RunVar[anyio.CapacityLimiter] = RunVar("metadata_io_limiter")


def metadata_io_limiter() -> anyio.CapacityLimiter:
    """Return the lightweight metadata/file-operation gate for this async run."""
    limiter = _metadata_io_limiter_var.get(None)
    if limiter is None:
        limiter = anyio.CapacityLimiter(METADATA_IO_CONCURRENCY)
        _metadata_io_limiter_var.set(limiter)
    return limiter


async def wait_for_task_completion(
    task: asyncio.Task,
    cancellation: asyncio.CancelledError | None = None,
) -> tuple[Any, asyncio.CancelledError | None]:
    """Wait through repeated cancellation, preserving the first cancellation."""
    while not task.done():
        try:
            if cancellation is None:
                await asyncio.shield(task)
            else:
                with anyio.CancelScope(shield=True):
                    await asyncio.shield(task)
        except asyncio.CancelledError as exc:
            if cancellation is None:
                cancellation = exc
        except BaseException:
            if cancellation is not None:
                raise cancellation
            raise
    try:
        return task.result(), cancellation
    except BaseException:
        if cancellation is not None:
            raise cancellation
        raise


async def run_sync_bounded(
    function: Callable[..., Any],
    /,
    *args: Any,
    limiter: anyio.CapacityLimiter,
    finalize: Callable[[Any], Awaitable[Any]] | None = None,
    shield: bool = True,
    **kwargs: Any,
) -> Any:
    """Run bounded blocking work with transactional cancellation shielding."""
    bound = functools.partial(function, *args, **kwargs)
    if shield:
        worker_task = asyncio.create_task(
            anyio.to_thread.run_sync(
                bound,
                abandon_on_cancel=False,
                limiter=limiter,
            )
        )
        result, cancellation = await wait_for_task_completion(worker_task)
    else:
        await limiter.acquire()
        try:
            worker_task = asyncio.create_task(asyncio.to_thread(bound))
            result, cancellation = await wait_for_task_completion(worker_task)
            if finalize is not None:
                finalize_task = asyncio.create_task(finalize(result))
                result, cancellation = await wait_for_task_completion(
                    finalize_task, cancellation
                )
        finally:
            limiter.release()
        if cancellation is not None:
            raise cancellation
        return result
    if finalize is not None:
        finalize_task = asyncio.create_task(finalize(result))
        result, cancellation = await wait_for_task_completion(
            finalize_task, cancellation
        )
    if cancellation is not None:
        raise cancellation
    return result


async def call_blocking(func: Callable[..., Any], /, *args, **kwargs) -> Any:
    """Run a blocking callable in the default thread pool."""
    bound = functools.partial(func, *args, **kwargs)
    return await asyncio.to_thread(bound)

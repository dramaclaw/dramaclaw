"""Bounded worker adapter for blocking upload processing."""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import Awaitable, Callable
from typing import Any

import anyio
from anyio.lowlevel import RunVar

from novelvideo.utils.async_ops import run_sync_bounded

ASSET_UPLOAD_CONCURRENCY = 2
SCENE_PLY_UPLOAD_CONCURRENCY = 1
_asset_upload_limiter_var: RunVar[anyio.CapacityLimiter] = RunVar(
    "asset_upload_limiter"
)
_scene_ply_upload_limiter_var: RunVar[anyio.CapacityLimiter] = RunVar(
    "scene_ply_upload_limiter"
)
_scene_upload_locks_var: RunVar[
    weakref.WeakValueDictionary[tuple[str, str], asyncio.Lock]
] = RunVar("scene_upload_locks")


def asset_upload_limiter() -> anyio.CapacityLimiter:
    """Return the small upload-processing gate scoped to this async run."""

    limiter = _asset_upload_limiter_var.get(None)
    if limiter is None:
        limiter = anyio.CapacityLimiter(ASSET_UPLOAD_CONCURRENCY)
        _asset_upload_limiter_var.set(limiter)
    return limiter


def scene_ply_upload_limiter() -> anyio.CapacityLimiter:
    """Return the single-slot PLY conversion gate for this async run."""

    limiter = _scene_ply_upload_limiter_var.get(None)
    if limiter is None:
        limiter = anyio.CapacityLimiter(SCENE_PLY_UPLOAD_CONCURRENCY)
        _scene_ply_upload_limiter_var.set(limiter)
    return limiter


def scene_upload_lock(key: tuple[str, str]) -> asyncio.Lock:
    """Return a per-run lock serializing manifest writes for one scene."""

    locks = _scene_upload_locks_var.get(None)
    if locks is None:
        locks = weakref.WeakValueDictionary()
        _scene_upload_locks_var.set(locks)
    lock = locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        locks[key] = lock
    return lock


async def run_asset_upload_operation(
    operation: Callable[..., Any],
    /,
    *args: Any,
    finalize: Callable[[Any], Awaitable[Any]] | None = None,
    worker_limiter: anyio.CapacityLimiter | None = None,
    **kwargs: Any,
) -> Any:
    """Run a blocking publish and optional async metadata commit as one transaction."""

    limiter = (
        worker_limiter if worker_limiter is not None else asset_upload_limiter()
    )
    return await run_sync_bounded(
        operation,
        *args,
        finalize=finalize,
        limiter=limiter,
        **kwargs,
    )

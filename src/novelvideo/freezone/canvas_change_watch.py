# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Loop-local fan-out of canvas change-log signal notifications."""

from __future__ import annotations

import asyncio
import logging
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from watchfiles import awatch

logger = logging.getLogger(__name__)


class CanvasChangeWatchHub:
    def __init__(self) -> None:
        self.directories: dict[Path, set[asyncio.Event]] = {}
        self.watcher: asyncio.Task | None = None
        self.changed = asyncio.Event()
        self.subscriptions = asyncio.Lock()
        self.metrics = {"canvas_patch_frames": 0, "canvas_reset_frames": 0}

    @asynccontextmanager
    async def subscribe(self, directory: Path) -> AsyncIterator[asyncio.Event]:
        directory = await asyncio.to_thread(Path(directory).resolve)
        await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)
        wake = asyncio.Event()
        async with self.subscriptions:
            if directory not in self.directories:
                self.directories[directory] = set()
                self.changed.set()
            self.directories[directory].add(wake)
            if self.watcher is None:
                self.watcher = asyncio.create_task(self._watch())
        try:
            yield wake
        finally:
            async with self.subscriptions:
                subscribers = self.directories[directory]
                subscribers.remove(wake)
                if not subscribers:
                    del self.directories[directory]
                    self.changed.set()
                if not self.directories:
                    self.watcher.cancel()
                    await asyncio.gather(self.watcher, return_exceptions=True)
                    self.watcher = None

    async def _watch(self) -> None:
        async def consume(directories: tuple[Path, ...]) -> None:
            async for changes in awatch(
                *directories,
                recursive=False,
                debounce=150,
                step=50,
                rust_timeout=250,
                watch_filter=lambda change, path: Path(path).name == "changes.signal",
            ):
                for _, path in changes:
                    for wake in self.directories.get(Path(path).parent, ()):
                        wake.set()

        while self.directories:
            self.changed.clear()
            watcher = asyncio.create_task(consume(tuple(self.directories)))
            rebuild = asyncio.create_task(self.changed.wait())
            try:
                done, _ = await asyncio.wait(
                    [watcher, rebuild], return_when=asyncio.FIRST_COMPLETED
                )
                if watcher in done:
                    watcher.result()
                    raise RuntimeError("Canvas change watcher stopped")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Canvas change watcher failed; retrying (%s)", type(exc).__name__)
                await asyncio.sleep(0.1)
            finally:
                watcher.cancel()
                rebuild.cancel()
                await asyncio.gather(watcher, rebuild, return_exceptions=True)


_hubs = weakref.WeakKeyDictionary()


def canvas_change_watch_hub() -> CanvasChangeWatchHub:
    loop = asyncio.get_running_loop()
    if loop not in _hubs:
        _hubs[loop] = CanvasChangeWatchHub()
    return _hubs[loop]

"""Worker-local bridge watcher and shared directory reconciliation scheduler.

Signals are lossy hints. SQLite owns delivery state and cross-worker leases.
"""

from __future__ import annotations

import asyncio
import logging
import time
import weakref
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

import anyio
from watchfiles import awatch

from novelvideo.freezone.canvas_command_bridge import (
    BRIDGE_PENDING_TTL_SECONDS,
    _decode_bridge_json,
    bridge_deadlines,
    bridge_message_exists,
    expire_bridge_messages,
    read_bridge_snapshot,
    touch_bridge_signal,
)
from novelvideo.utils.async_ops import run_sync_bounded

logger = logging.getLogger(__name__)


@dataclass
class DirectoryState:
    subscribers: set = field(default_factory=set)
    rows: list = field(default_factory=list)
    legacy_paths: tuple = ()
    identity: tuple | None = None
    reconcile_at: float = 0
    deadline: float | None = None
    dirty: bool = True
    scan_legacy: bool = True


class BridgeWatchHub:
    def __init__(self, reconcile_seconds=30.0, degraded_seconds=10.0):
        self.limiter = anyio.CapacityLimiter(4)
        self.reconcile_seconds = reconcile_seconds
        self.degraded_seconds = degraded_seconds
        self.directories = {}
        self.aliases = {}
        self.task = None
        self.watcher = None
        self.changed = asyncio.Event()
        self.scheduled = asyncio.Event()
        self.degraded = False
        self.metrics = {"reads": 0, "recovered": 0, "degraded": 0, "restored": 0}

    async def run(self, function, *args, **kwargs):
        return await run_sync_bounded(function, *args, limiter=self.limiter, **kwargs)

    @asynccontextmanager
    async def subscribe(self, directories):
        requested = {Path(directory).absolute() for directory in directories}
        aliases = {}
        for directory in requested:
            resolved = await self.run(directory.resolve)
            await self.run(resolved.mkdir, parents=True, exist_ok=True)
            aliases[directory] = resolved
        # Finish all cancellable setup before registering any references.
        self.aliases.update(aliases)
        directories = set(aliases.values())
        event = asyncio.Event()
        added = False
        for directory in directories:
            added |= directory not in self.directories
            state = self.directories.setdefault(directory, DirectoryState())
            state.subscribers.add(event)
            event.set()  # Cached data is safe: the durable claim arbitrates consumers.
        if added:
            self.changed.set()
        self.scheduled.set()
        if self.task is None and self.directories:
            self.task = asyncio.create_task(self._schedule())
            self.watcher = asyncio.create_task(self._watch())
        try:
            yield event
        finally:
            removed = False
            for directory in directories:
                state = self.directories.get(directory)
                if state:
                    state.subscribers.discard(event)
                    if not state.subscribers:
                        self.directories.pop(directory, None)
                        removed = True
            if removed:
                self.aliases = {
                    key: value for key, value in self.aliases.items() if value in self.directories
                }
                self.changed.set()
            self.scheduled.set()
            if not self.directories:
                tasks = [task for task in (self.task, self.watcher) if task]
                self.task = self.watcher = None
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    def pending(self, directory, project_id, canvas_id, kinds=None):
        path = Path(directory).absolute()
        state = self.directories.get(self.aliases.get(path, path))
        if state is None:
            return []
        now = time.time()
        result = []
        for row in state.rows:
            if row["project_id"] != project_id or row["canvas_id"] != canvas_id:
                continue
            if kinds and row["kind"] not in kinds:
                continue
            if row["created_at"] + BRIDGE_PENDING_TTL_SECONDS.get(row["kind"], 600) <= now:
                continue
            if row["status"] == "delivered" and (row["lease_expires_at"] or 0) > now:
                continue
            payload = _decode_bridge_json(row["payload_json"])
            if payload is not None:
                result.append({**payload, "key": row["bridge_key"], "kind": row["kind"]})
        return result

    def legacy_paths(self, directory):
        path = Path(directory).absolute()
        state = self.directories.get(self.aliases.get(path, path))
        return state.legacy_paths if state else ()

    def _dirty(self, directories, scan_legacy=True):
        for directory in directories:
            state = self.directories.get(directory)
            if state:
                state.dirty = True
                state.scan_legacy |= scan_legacy
        self.scheduled.set()

    def _set_degraded(self, degraded):
        if self.degraded == degraded:
            return
        self.degraded = degraded
        self.metrics["degraded" if degraded else "restored"] += 1
        logger.warning("Canvas bridge watcher %s", "degraded" if degraded else "restored")
        self._dirty(tuple(self.directories), scan_legacy=False)

    @staticmethod
    def _read_directory(directory, scan_legacy):
        # No glob/stat per connection. Directory identity detects delete/recreate.
        info = directory.stat()
        rows = read_bridge_snapshot(directory)
        keys = {row["bridge_key"] for row in rows}
        paths = None
        if scan_legacy:
            paths = tuple(
                path
                for path in sorted(directory.glob("*.pending.json"))
                if path.name.removesuffix(".pending.json") not in keys
                and not bridge_message_exists(
                    path.name.removesuffix(".pending.json"), bridge_dir=directory
                )
            )
        return rows, paths, (info.st_dev, info.st_ino)

    async def _schedule(self):
        while self.directories:
            self.scheduled.clear()
            due = [
                directory
                for directory, state in self.directories.items()
                if state.dirty
                or state.reconcile_at <= time.monotonic()
                or (state.deadline is not None and state.deadline <= time.time())
            ]
            for directory in due:
                state = self.directories.get(directory)
                if state is None:
                    continue
                scan = state.scan_legacy or self.degraded
                state.dirty = state.scan_legacy = False
                old_keys = {row["bridge_key"] for row in state.rows}
                try:
                    now = time.time()
                    if any(
                        row["created_at"] + BRIDGE_PENDING_TTL_SECONDS.get(row["kind"], 600) <= now
                        for row in state.rows
                    ):
                        await self.run(expire_bridge_messages, directory, now)
                    rows, paths, identity = await self.run(self._read_directory, directory, scan)
                    if state.identity is not None and state.identity != identity:
                        self.changed.set()
                        state.scan_legacy = state.dirty = True
                    state.identity = identity
                    if not scan and any(row["bridge_key"] not in old_keys for row in rows):
                        self.metrics["recovered"] += 1
                        logger.info("Canvas bridge reconciliation recovered messages")
                    state.rows = rows
                    if paths is not None:
                        state.legacy_paths = paths
                    state.deadline = bridge_deadlines(rows, time.time())
                    self.metrics["reads"] += 1
                    for event in state.subscribers:
                        event.set()
                except FileNotFoundError:
                    state.identity = None
                    try:
                        await self.run(directory.mkdir, parents=True, exist_ok=True)
                        state.scan_legacy = state.dirty = True
                        self.changed.set()
                    except OSError:
                        logger.exception("Canvas bridge directory cannot be recreated")
                        state.deadline = None
                        self._set_degraded(True)
                except Exception:
                    logger.exception("Canvas bridge reconciliation failed")
                    state.deadline = None
                    self._set_degraded(True)
                interval = self.degraded_seconds if self.degraded else self.reconcile_seconds
                state.reconcile_at = time.monotonic() + interval
            delays = [
                max(0.05, state.reconcile_at - time.monotonic())
                for state in self.directories.values()
            ]
            delays.extend(
                max(0.05, state.deadline - time.time())
                for state in self.directories.values()
                if state.deadline is not None
            )
            if any(state.dirty for state in self.directories.values()):
                continue
            try:
                await asyncio.wait_for(self.scheduled.wait(), min(delays, default=30))
            except asyncio.TimeoutError:
                pass

    async def _watch(self):
        while self.directories:
            self.changed.clear()
            await asyncio.sleep(0.05)  # Coalesce subscription rebuilds.
            directories = tuple(self.directories)

            verified = asyncio.Event()
            unverified = set(directories)

            async def consume():
                async for changes in awatch(
                    *directories,
                    recursive=False,
                    debounce=150,
                    step=50,
                    rust_timeout=250,
                    yield_on_timeout=True,
                    force_polling=False,
                    watch_filter=lambda change, path: (
                        Path(path).name == "canvas_command.signal" or path.endswith(".pending.json")
                    ),
                ):
                    for _, path in changes:
                        if Path(path).name == "canvas_command.signal":
                            unverified.discard(Path(path).parent)
                    if not unverified:
                        verified.set()
                    if changes:
                        self._dirty({Path(path).parent for _, path in changes})

            async def establish():
                # Native construction occurs before awatch's first thread wait.
                # Do not depend on a quiet-time yield: unrelated SQLite events
                # can prevent that yield indefinitely on a busy directory.
                await asyncio.sleep(0.05)
                for directory in directories:
                    await self.run(touch_bridge_signal, directory)
                await asyncio.wait_for(verified.wait(), 1)
                self._set_degraded(False)
                self._dirty(directories)  # Close startup/rebuild notification gaps.

            watcher = asyncio.create_task(consume())
            rebuild = asyncio.create_task(self.changed.wait())
            ready = asyncio.create_task(establish())
            try:
                done, _ = await asyncio.wait(
                    [watcher, rebuild, ready], return_when=asyncio.FIRST_COMPLETED
                )
                if ready in done:
                    ready.result()
                    done, _ = await asyncio.wait(
                        [watcher, rebuild], return_when=asyncio.FIRST_COMPLETED
                    )
                if watcher in done:
                    watcher.result()
                    raise RuntimeError("Canvas bridge watcher stopped")
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Canvas bridge native watcher failed")
                self._set_degraded(True)
                try:
                    await asyncio.wait_for(self.changed.wait(), self.degraded_seconds)
                except asyncio.TimeoutError:
                    pass
            finally:
                watcher.cancel()
                rebuild.cancel()
                ready.cancel()
                await asyncio.gather(watcher, rebuild, ready, return_exceptions=True)


_hubs = weakref.WeakKeyDictionary()


def bridge_watch_hub():
    loop = asyncio.get_running_loop()
    if loop not in _hubs:
        _hubs[loop] = BridgeWatchHub()
    return _hubs[loop]

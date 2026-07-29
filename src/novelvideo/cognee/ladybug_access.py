"""Project-scoped Ladybug read/write access for Cognee.

Ladybug permits either one read-write ``Database`` object or multiple read-only
``Database`` objects for the same on-disk database.  DramaClaw writes the graph
only while importing a novel; all later graph operations are read-only.

This module bridges that lifecycle into Cognee 1.0.x, whose Ladybug adapter
currently always opens databases in read-write mode and caches the adapter.
"""

from __future__ import annotations

import asyncio
import contextvars
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from threading import RLock
from typing import Any, AsyncIterator

from novelvideo.graph_preview import (
    acquire_graph_preview_lock_async,
    release_graph_preview_lock,
)


@dataclass
class _GraphAccessState:
    read_only: bool
    adapters: set[Any] = field(default_factory=set)


_graph_access_state: contextvars.ContextVar[_GraphAccessState | None] = (
    contextvars.ContextVar("novelvideo_ladybug_access_state", default=None)
)
_adapter_scope_lock = RLock()
_adapter_scope_counts: dict[int, tuple[Any, int]] = {}
_patch_lock = RLock()
_patch_installed = False


def _current_read_only() -> bool:
    state = _graph_access_state.get()
    if state is None:
        raise RuntimeError(
            "Ladybug graph access requires an explicit ladybug_graph_access scope"
        )
    return state.read_only


async def _await_query_completion(awaitable):
    """Delay cancellation until a Ladybug executor operation has really stopped."""

    future = asyncio.ensure_future(awaitable)
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError as cancelled:
        # Cancelling an asyncio wrapper does not stop work that is already
        # running in ThreadPoolExecutor. Keep the graph scope (and its file
        # lock/database handle) alive until the native query has completed.
        while not future.done():
            try:
                await asyncio.shield(future)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if future.done() and not future.cancelled():
            try:
                future.result()
            except BaseException:
                pass
        raise cancelled


def _register_adapter(adapter: Any) -> None:
    state = _graph_access_state.get()
    if state is None or adapter in state.adapters:
        return
    state.adapters.add(adapter)
    adapter_id = id(adapter)
    with _adapter_scope_lock:
        existing = _adapter_scope_counts.get(adapter_id)
        count = existing[1] if existing is not None else 0
        _adapter_scope_counts[adapter_id] = (adapter, count + 1)


def _close_adapter(adapter: Any) -> None:
    mode_lock = getattr(adapter, "_novelvideo_mode_lock", None)
    if mode_lock is None:
        mode_lock = RLock()
        adapter._novelvideo_mode_lock = mode_lock

    close_errors: list[Exception] = []
    with mode_lock:
        connection = getattr(adapter, "connection", None)
        if connection is not None:
            try:
                connection.close()
            except Exception as exc:
                close_errors.append(exc)
            finally:
                adapter.connection = None

        database = getattr(adapter, "db", None)
        if database is not None:
            try:
                database.close()
            except Exception as exc:
                close_errors.append(exc)
            finally:
                adapter.db = None

        adapter._is_closed = True
        adapter._novelvideo_read_only = None
    if close_errors:
        raise RuntimeError("failed to close Ladybug graph resources") from close_errors[0]


def _release_scope_adapters(state: _GraphAccessState) -> None:
    to_close: list[Any] = []
    with _adapter_scope_lock:
        for adapter in state.adapters:
            adapter_id = id(adapter)
            existing = _adapter_scope_counts.get(adapter_id)
            if existing is None:
                continue
            remaining = existing[1] - 1
            if remaining > 0:
                _adapter_scope_counts[adapter_id] = (adapter, remaining)
            else:
                _adapter_scope_counts.pop(adapter_id, None)
                to_close.append(adapter)

    close_errors: list[Exception] = []
    for adapter in to_close:
        try:
            _close_adapter(adapter)
        except Exception as exc:
            close_errors.append(exc)
    if close_errors:
        raise close_errors[0]


@asynccontextmanager
async def ladybug_graph_access(
    state_dir: str,
    *,
    read_only: bool,
) -> AsyncIterator[None]:
    """Open one graph access phase under the correct cross-process lock.

    Same-mode nested scopes reuse the outer scope. A read inside an import also
    reuses the writer connection. Escalating a read scope to write is rejected.
    """

    current = _graph_access_state.get()
    if current is not None:
        if current.read_only and not read_only:
            raise RuntimeError("cannot open Ladybug for writing inside a read-only scope")
        yield
        return

    install_cognee_ladybug_access_patch()
    lock_handle = await acquire_graph_preview_lock_async(
        state_dir,
        shared=read_only,
    )
    state = _GraphAccessState(read_only=read_only)
    token = _graph_access_state.set(state)
    try:
        yield
    finally:
        try:
            # Ladybug database handles must be closed before the cooperative
            # lock is released, otherwise a waiting process can acquire our
            # lock but still fail Ladybug's native file lock.
            _release_scope_adapters(state)
        finally:
            _graph_access_state.reset(token)
            release_graph_preview_lock(lock_handle)


def install_cognee_ladybug_access_patch() -> None:
    """Teach Cognee's cached Ladybug adapter about scoped read-only access."""

    global _patch_installed
    with _patch_lock:
        if _patch_installed:
            return

        from cognee.infrastructure.databases.graph.ladybug import adapter as adapter_module
        from ladybug import Connection
        from ladybug.database import Database

        adapter_class = adapter_module.LadybugAdapter
        if getattr(adapter_class, "_novelvideo_access_patch", False):
            _patch_installed = True
            return

        original_initialize = adapter_class._initialize_connection
        original_query = adapter_class.query

        def initialize_connection(self) -> None:
            desired_read_only = _current_read_only()
            mode_lock = getattr(self, "_novelvideo_mode_lock", None)
            if mode_lock is None:
                mode_lock = RLock()
                self._novelvideo_mode_lock = mode_lock

            with mode_lock:
                current_mode = getattr(self, "_novelvideo_read_only", None)
                if self.db is not None and current_mode == desired_read_only:
                    _register_adapter(self)
                    return
                if self.db is not None or self.connection is not None:
                    _close_adapter(self)

                if not desired_read_only:
                    original_initialize(self)
                    self._novelvideo_read_only = False
                    self._is_closed = False
                    _register_adapter(self)
                    return

                if "s3://" in self.db_path:
                    raise RuntimeError(
                        "read-only concurrent Ladybug access requires a local graph database"
                    )

                try:
                    self.db = Database(
                        self.db_path,
                        buffer_pool_size=2048 * 1024 * 1024,
                        max_db_size=4096 * 1024 * 1024,
                        read_only=True,
                    )
                    # Loading an already-installed extension is connection-local
                    # and does not mutate the graph database.
                    connection = Connection(self.db)
                    try:
                        connection.execute("LOAD EXTENSION JSON;")
                    except Exception:
                        pass
                    finally:
                        connection.close()
                    self.connection = None
                except Exception:
                    _close_adapter(self)
                    raise
                self._novelvideo_read_only = True
                self._is_closed = False
                _register_adapter(self)

        async def query(self, query_text: str, params: dict | None = None):
            desired_read_only = _current_read_only()
            mode_lock = getattr(self, "_novelvideo_mode_lock", None)
            if mode_lock is None:
                mode_lock = RLock()
                self._novelvideo_mode_lock = mode_lock

            with mode_lock:
                if (
                    self.db is None
                    or getattr(self, "_novelvideo_read_only", None)
                    != desired_read_only
                ):
                    initialize_connection(self)
                _register_adapter(self)
                database = self.db

            if not desired_read_only:
                return await _await_query_completion(
                    asyncio.create_task(original_query(self, query_text, params))
                )

            loop = asyncio.get_running_loop()
            query_params = params or {}

            def blocking_read_query():
                connection = Connection(database)
                try:
                    result = connection.execute(query_text, query_params)
                    rows = []
                    while result.has_next():
                        row = result.get_next()
                        rows.append(
                            tuple(
                                value.as_py() if hasattr(value, "as_py") else value
                                for value in row
                            )
                        )
                    return rows
                finally:
                    connection.close()

            return await _await_query_completion(
                loop.run_in_executor(self.executor, blocking_read_query)
            )

        def close(self) -> None:
            _close_adapter(self)

        adapter_class._initialize_connection = initialize_connection
        adapter_class.query = query
        adapter_class.close = close
        adapter_class._novelvideo_access_patch = True
        adapter_class._novelvideo_original_initialize_connection = original_initialize
        adapter_class._novelvideo_original_query = original_query
        _patch_installed = True

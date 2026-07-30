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
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from importlib.metadata import version
from pathlib import Path
from threading import Lock, RLock
from typing import Any, AsyncIterator, Iterator

from novelvideo.graph_preview import (
    acquire_graph_preview_lock_async,
    release_graph_preview_lock,
)


@dataclass
class _GraphAccessState:
    state_dir: str
    read_only: bool
    adapters: set[Any] = field(default_factory=set)


@dataclass(frozen=True)
class _CogneeProjectContextState:
    state_dir: str
    base_config: Any
    relational_config: Any


_graph_access_state: contextvars.ContextVar[_GraphAccessState | None] = (
    contextvars.ContextVar("novelvideo_ladybug_access_state", default=None)
)
_cognee_project_context_state: contextvars.ContextVar[
    _CogneeProjectContextState | None
] = contextvars.ContextVar("novelvideo_cognee_project_context", default=None)
_adapter_scope_lock = RLock()
_adapter_scope_counts: dict[int, tuple[Any, int]] = {}
_patch_lock = RLock()
_patch_installed = False
_project_context_patch_installed = False
_process_writer_lock = Lock()


def _contextual_base_config():
    state = _cognee_project_context_state.get()
    if state is not None:
        return state.base_config
    return _contextual_base_config._novelvideo_original()


def _contextual_relational_config():
    state = _cognee_project_context_state.get()
    if state is not None:
        return state.relational_config
    return _contextual_relational_config._novelvideo_original()


def install_cognee_project_context_patch() -> None:
    """Add task-local base/relational storage routing to Cognee 1.0.5.

    Cognee already scopes graph, vector, and file storage with ContextVars, but
    its base and relational configurations are process-global. DramaClaw keeps
    a complete Cognee database under each project, so concurrent reads need the
    two missing project-local configuration layers as well.
    """

    global _project_context_patch_installed
    with _patch_lock:
        if _project_context_patch_installed:
            return

        installed_version = version("cognee")
        if installed_version != "1.0.5":
            raise RuntimeError(
                "DramaClaw's project-scoped Cognee patch only supports cognee==1.0.5; "
                f"found {installed_version}"
            )

        import cognee.context_global_variables as context_module
        from cognee.infrastructure.databases.relational.get_relational_engine import (
            get_relational_engine,
        )

        relational_globals = get_relational_engine.__globals__
        original_relational_getter = relational_globals.get("get_relational_config")
        original_base_getter = (
            context_module.DatabaseContextManager.apply_database_context_variables.__globals__.get(
                "get_base_config"
            )
        )
        if not callable(original_relational_getter) or not callable(
            original_base_getter
        ):
            raise RuntimeError(
                "Unsupported Cognee internals: project storage getters were not found"
            )

        if not hasattr(_contextual_relational_config, "_novelvideo_original"):
            _contextual_relational_config._novelvideo_original = (
                original_relational_getter
            )
        if not hasattr(_contextual_base_config, "_novelvideo_original"):
            _contextual_base_config._novelvideo_original = original_base_getter

        relational_globals["get_relational_config"] = _contextual_relational_config
        context_module.DatabaseContextManager.apply_database_context_variables.__globals__[
            "get_base_config"
        ] = _contextual_base_config
        context_module.get_base_config = _contextual_base_config
        _project_context_patch_installed = True


@contextmanager
def cognee_project_context(state_dir: str) -> Iterator[None]:
    """Scope Cognee's project-isolated storage configuration to this task."""

    resolved_state_dir = str(Path(state_dir).expanduser().resolve())
    current = _cognee_project_context_state.get()
    if current is not None:
        if current.state_dir != resolved_state_dir:
            raise RuntimeError(
                "cannot access a different project inside the current Cognee context"
            )
        yield
        return

    install_cognee_project_context_patch()

    import cognee.context_global_variables as context_module

    system_root = Path(resolved_state_dir) / "cognee_system"
    data_root = Path(resolved_state_dir) / "cognee_data"
    databases_root = system_root / "databases"
    databases_root.mkdir(parents=True, exist_ok=True)
    data_root.mkdir(parents=True, exist_ok=True)

    original_base = _contextual_base_config._novelvideo_original()
    original_relational = _contextual_relational_config._novelvideo_original()
    state = _CogneeProjectContextState(
        state_dir=resolved_state_dir,
        base_config=original_base.model_copy(
            deep=True,
            update={
                "system_root_directory": str(system_root),
                "data_root_directory": str(data_root),
            },
        ),
        relational_config=original_relational.model_copy(
            deep=True,
            update={"db_path": str(databases_root)},
        ),
    )

    project_token = _cognee_project_context_state.set(state)
    graph_token = context_module.graph_db_config.set(None)
    vector_token = context_module.vector_db_config.set(None)
    storage_token = context_module.file_storage_config.set(None)
    try:
        yield
    finally:
        context_module.file_storage_config.reset(storage_token)
        context_module.vector_db_config.reset(vector_token)
        context_module.graph_db_config.reset(graph_token)
        _cognee_project_context_state.reset(project_token)


async def _acquire_process_writer_lock() -> None:
    """Acquire the cross-event-loop writer lock without blocking a loop thread."""

    while not _process_writer_lock.acquire(blocking=False):
        await asyncio.sleep(0.05)


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

    resolved_state_dir = str(Path(state_dir).expanduser().resolve())
    current = _graph_access_state.get()
    if current is not None:
        if current.state_dir != resolved_state_dir:
            raise RuntimeError(
                "cannot access a different project inside the current Ladybug scope"
            )
        if current.read_only and not read_only:
            raise RuntimeError("cannot open Ladybug for writing inside a read-only scope")
        yield
        return

    current_project = _cognee_project_context_state.get()
    if (
        current_project is not None
        and current_project.state_dir != resolved_state_dir
    ):
        raise RuntimeError(
            "cannot access a different project inside the current Cognee context"
        )

    install_cognee_ladybug_access_patch()
    writer_lock_acquired = False
    lock_handle = None
    try:
        if not read_only:
            await _acquire_process_writer_lock()
            writer_lock_acquired = True

            # Cognee 1.0.5 still has several write-path imports that read its
            # process-global base configuration directly. Serialize mutations
            # and bind those legacy callers only for the duration of a write.
            from novelvideo.cognee.config import (
                apply_cognee_project_storage_context,
            )

            apply_cognee_project_storage_context(resolved_state_dir)

        with cognee_project_context(resolved_state_dir):
            lock_handle = await acquire_graph_preview_lock_async(
                resolved_state_dir,
                shared=read_only,
            )
            state = _GraphAccessState(
                state_dir=resolved_state_dir,
                read_only=read_only,
            )
            token = _graph_access_state.set(state)
            try:
                yield
            finally:
                try:
                    # Ladybug database handles must be closed before the
                    # cooperative lock is released, otherwise a waiting
                    # process can acquire our lock but still fail Ladybug's
                    # native file lock.
                    _release_scope_adapters(state)
                finally:
                    _graph_access_state.reset(token)
                    completed_lock_handle = lock_handle
                    lock_handle = None
                    release_graph_preview_lock(completed_lock_handle)
    finally:
        if lock_handle is not None:
            release_graph_preview_lock(lock_handle)
        if writer_lock_acquired:
            _process_writer_lock.release()


def install_cognee_ladybug_access_patch() -> None:
    """Teach Cognee's cached Ladybug adapter about scoped read-only access."""

    global _patch_installed
    install_cognee_project_context_patch()
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

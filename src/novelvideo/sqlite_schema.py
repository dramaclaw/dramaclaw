"""Cross-process coordination for project SQLite schema initialization.

Migration contract
------------------
Every caller owns a ``component`` and integer ``version``. Whenever that
component's initializer changes its tables, columns, indexes, or migration
logic, the caller MUST increment its schema version in the same change.
Otherwise databases already marked at the old version will skip the new
initializer.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import sqlite3
import threading
from collections import OrderedDict
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import IO, Awaitable, Callable

from novelvideo.sqlite_pragmas import (
    configure_sqlite_connection,
    configure_sqlite_connection_async,
)

try:
    import fcntl
except ImportError:  # pragma: no cover - production images are Linux
    fcntl = None


_SCHEMA_MARKER_SQL = """
CREATE TABLE IF NOT EXISTS novelvideo_schema_components (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL
)
"""

_MAX_READY_COMPONENTS = 4096
_READY_COMPONENTS: OrderedDict[tuple[str, int, int, str, int], None] = OrderedDict()
_READY_COMPONENTS_LOCK = threading.Lock()


def schema_lock_path(db_path: str | Path) -> Path:
    path = Path(db_path)
    return path.with_name(f"{path.name}.schema.lock")


def _acquire_schema_lock(db_path: str | Path) -> IO[str]:
    lock_path = schema_lock_path(db_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    if fcntl is not None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    return handle


async def _acquire_schema_lock_async(db_path: str | Path) -> IO[str]:
    """Acquire without leaking a lock if the awaiting request is cancelled."""

    lock_path = schema_lock_path(db_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    if fcntl is None:
        return handle
    try:
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return handle
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EAGAIN}:
                    raise
                await asyncio.sleep(0.05)
    except BaseException:
        handle.close()
        raise


def _release_schema_lock(handle: IO[str]) -> None:
    try:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


@contextlib.contextmanager
def sqlite_schema_lock(db_path: str | Path) -> Iterator[None]:
    handle = _acquire_schema_lock(db_path)
    try:
        yield
    finally:
        _release_schema_lock(handle)


@contextlib.asynccontextmanager
async def sqlite_schema_lock_async(db_path: str | Path) -> AsyncIterator[None]:
    handle = await _acquire_schema_lock_async(db_path)
    try:
        yield
    finally:
        _release_schema_lock(handle)


def _database_identity(
    db_path: str | Path,
    component: str,
    version: int,
) -> tuple[str, int, int, str, int] | None:
    path = Path(db_path).resolve()
    try:
        stat = path.stat()
    except OSError:
        return None
    return (str(path), int(stat.st_dev), int(stat.st_ino), component, version)


def _component_is_process_ready(
    db_path: str | Path,
    component: str,
    version: int,
) -> bool:
    identity = _database_identity(db_path, component, version)
    if identity is None:
        return False
    with _READY_COMPONENTS_LOCK:
        if identity not in _READY_COMPONENTS:
            return False
        _READY_COMPONENTS.move_to_end(identity)
        return True


def _mark_component_process_ready(
    db_path: str | Path,
    component: str,
    version: int,
) -> None:
    identity = _database_identity(db_path, component, version)
    if identity is None:
        return
    path = identity[0]
    with _READY_COMPONENTS_LOCK:
        stale = [
            item
            for item in _READY_COMPONENTS
            if item[0] == path and item[3] == component and item != identity
        ]
        for item in stale:
            _READY_COMPONENTS.pop(item, None)
        _READY_COMPONENTS[identity] = None
        _READY_COMPONENTS.move_to_end(identity)
        while len(_READY_COMPONENTS) > _MAX_READY_COMPONENTS:
            _READY_COMPONENTS.popitem(last=False)


def schema_component_is_current(
    conn: sqlite3.Connection,
    component: str,
    version: int,
) -> bool:
    try:
        row = conn.execute(
            "SELECT version FROM novelvideo_schema_components WHERE component = ?",
            (component,),
        ).fetchone()
    except sqlite3.OperationalError:
        return False
    return row is not None and int(row[0]) >= version


async def schema_component_is_current_async(
    db,
    component: str,
    version: int,
) -> bool:
    try:
        cursor = await db.execute(
            "SELECT version FROM novelvideo_schema_components WHERE component = ?",
            (component,),
        )
        row = await cursor.fetchone()
        await cursor.close()
    except sqlite3.OperationalError:
        return False
    return row is not None and int(row[0]) >= version


def mark_schema_component(
    conn: sqlite3.Connection,
    component: str,
    version: int,
) -> None:
    conn.execute(_SCHEMA_MARKER_SQL)
    conn.execute(
        "INSERT INTO novelvideo_schema_components(component, version) VALUES (?, ?) "
        "ON CONFLICT(component) DO UPDATE SET version = excluded.version",
        (component, version),
    )


async def mark_schema_component_async(db, component: str, version: int) -> None:
    await db.execute(_SCHEMA_MARKER_SQL)
    await db.execute(
        "INSERT INTO novelvideo_schema_components(component, version) VALUES (?, ?) "
        "ON CONFLICT(component) DO UPDATE SET version = excluded.version",
        (component, version),
    )


def _journal_is_wal(conn: sqlite3.Connection) -> bool:
    row = conn.execute("PRAGMA journal_mode").fetchone()
    return row is not None and str(row[0]).lower() == "wal"


async def _journal_is_wal_async(db) -> bool:
    cursor = await db.execute("PRAGMA journal_mode")
    row = await cursor.fetchone()
    await cursor.close()
    return row is not None and str(row[0]).lower() == "wal"


def _enable_wal(conn: sqlite3.Connection) -> None:
    row = conn.execute("PRAGMA journal_mode=WAL").fetchone()
    if row is None or str(row[0]).lower() != "wal":
        raise RuntimeError("failed to enable SQLite WAL mode")


async def _enable_wal_async(db) -> None:
    cursor = await db.execute("PRAGMA journal_mode=WAL")
    row = await cursor.fetchone()
    await cursor.close()
    if row is None or str(row[0]).lower() != "wal":
        raise RuntimeError("failed to enable SQLite WAL mode")


def ensure_sqlite_schema(
    db_path: str | Path,
    *,
    component: str,
    version: int,
    initialize: Callable[[sqlite3.Connection], None],
) -> None:
    """Ensure one schema component exactly once per DB inode and version.

    Callers must increment ``version`` whenever their initializer gains a
    migration. The version is part of the process cache key and the persistent
    marker, so a new deployment will run that migration once per database.
    """

    path = Path(db_path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if _component_is_process_ready(path, component, version):
        return

    if path.is_file():
        probe = sqlite3.connect(path, timeout=10, check_same_thread=False)
        try:
            configure_sqlite_connection(probe, set_journal_mode=False)
            if schema_component_is_current(
                probe, component, version
            ) and _journal_is_wal(probe):
                _mark_component_process_ready(path, component, version)
                return
        finally:
            probe.close()

    with sqlite_schema_lock(path):
        conn = sqlite3.connect(path, timeout=10, check_same_thread=False)
        try:
            configure_sqlite_connection(conn, set_journal_mode=False)
            if not _journal_is_wal(conn):
                _enable_wal(conn)
            if not schema_component_is_current(conn, component, version):
                initialize(conn)
                mark_schema_component(conn, component, version)
                conn.commit()
            _mark_component_process_ready(path, component, version)
        finally:
            conn.close()


async def ensure_sqlite_schema_async(
    db_path: str | Path,
    *,
    component: str,
    version: int,
    initialize: Callable[[object], Awaitable[None]],
) -> None:
    """Async counterpart of :func:`ensure_sqlite_schema`."""

    import aiosqlite

    path = Path(db_path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if _component_is_process_ready(path, component, version):
        return

    if path.is_file():
        probe = await aiosqlite.connect(path, timeout=10)
        try:
            await configure_sqlite_connection_async(
                probe,
                set_journal_mode=False,
            )
            if await schema_component_is_current_async(
                probe, component, version
            ) and await _journal_is_wal_async(probe):
                _mark_component_process_ready(path, component, version)
                return
        finally:
            await probe.close()

    async with sqlite_schema_lock_async(path):
        db = await aiosqlite.connect(path, timeout=10)
        try:
            await configure_sqlite_connection_async(
                db,
                set_journal_mode=False,
            )
            if not await _journal_is_wal_async(db):
                await _enable_wal_async(db)
            if not await schema_component_is_current_async(db, component, version):
                await initialize(db)
                await mark_schema_component_async(db, component, version)
                await db.commit()
            _mark_component_process_ready(path, component, version)
        finally:
            await db.close()

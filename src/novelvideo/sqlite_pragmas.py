"""Unified SQLite connection pragmas."""

from __future__ import annotations

import os

_PRAGMAS_BEFORE_JOURNAL = (
    # Apply the wait policy before journal_mode: switching journal mode may
    # itself need a database lock.
    ("busy_timeout", "10000"),
)

_PRAGMAS_COMMON = (
    ("synchronous", "NORMAL"),
    ("foreign_keys", "ON"),
)


def litestream_enabled() -> bool:
    """Return whether ST_LITESTREAM_ENABLED is truthy."""

    return os.environ.get("ST_LITESTREAM_ENABLED", "").strip().lower() not in (
        "",
        "0",
        "false",
        "no",
    )


def _wal_autocheckpoint_value() -> str:
    return "0" if litestream_enabled() else "2000"


def configure_sqlite_connection(conn, *, set_journal_mode: bool = True) -> None:
    """Apply project-wide pragmas to a synchronous sqlite3 connection."""

    for name, value in _PRAGMAS_BEFORE_JOURNAL:
        conn.execute(f"PRAGMA {name}={value}")
    if set_journal_mode:
        conn.execute("PRAGMA journal_mode=WAL")
    for name, value in _PRAGMAS_COMMON:
        conn.execute(f"PRAGMA {name}={value}")
    conn.execute(f"PRAGMA wal_autocheckpoint={_wal_autocheckpoint_value()}")


async def configure_sqlite_connection_async(
    db,
    *,
    set_journal_mode: bool = True,
) -> None:
    """Apply project-wide pragmas to an aiosqlite connection."""

    for name, value in _PRAGMAS_BEFORE_JOURNAL:
        await db.execute(f"PRAGMA {name}={value}")
    if set_journal_mode:
        await db.execute("PRAGMA journal_mode=WAL")
    for name, value in _PRAGMAS_COMMON:
        await db.execute(f"PRAGMA {name}={value}")
    await db.execute(f"PRAGMA wal_autocheckpoint={_wal_autocheckpoint_value()}")

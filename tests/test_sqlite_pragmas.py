"""sqlite_pragmas unified configuration tests."""

import asyncio
import sqlite3

import aiosqlite

from novelvideo.sqlite_pragmas import (
    configure_sqlite_connection,
    configure_sqlite_connection_async,
)


def _pragma(conn: sqlite3.Connection, name: str):
    return conn.execute(f"PRAGMA {name}").fetchone()[0]


def test_sync_sets_wal_and_busy_timeout(tmp_path):
    conn = sqlite3.connect(tmp_path / "t.db")
    configure_sqlite_connection(conn)
    assert str(_pragma(conn, "journal_mode")).lower() == "wal"
    assert int(_pragma(conn, "busy_timeout")) == 10000
    assert int(_pragma(conn, "synchronous")) == 1
    assert int(_pragma(conn, "foreign_keys")) == 1
    conn.close()


def test_busy_timeout_is_applied_before_journal_mode():
    statements: list[str] = []

    class RecordingConnection:
        def execute(self, statement):
            statements.append(statement)

    configure_sqlite_connection(RecordingConnection())

    assert statements.index("PRAGMA busy_timeout=10000") < statements.index(
        "PRAGMA journal_mode=WAL"
    )


def test_normal_connection_can_skip_persistent_journal_transition():
    statements: list[str] = []

    class RecordingConnection:
        def execute(self, statement):
            statements.append(statement)

    configure_sqlite_connection(
        RecordingConnection(),
        set_journal_mode=False,
    )

    assert "PRAGMA busy_timeout=10000" in statements
    assert "PRAGMA journal_mode=WAL" not in statements


def test_autocheckpoint_zero_when_litestream(tmp_path, monkeypatch):
    monkeypatch.setenv("ST_LITESTREAM_ENABLED", "1")
    conn = sqlite3.connect(tmp_path / "litestream.db")
    configure_sqlite_connection(conn)
    assert int(_pragma(conn, "wal_autocheckpoint")) == 0
    conn.close()


def test_autocheckpoint_default_when_no_litestream(tmp_path, monkeypatch):
    for env in (None, "0"):
        if env is None:
            monkeypatch.delenv("ST_LITESTREAM_ENABLED", raising=False)
            suffix = "unset"
        else:
            monkeypatch.setenv("ST_LITESTREAM_ENABLED", env)
            suffix = env
        conn = sqlite3.connect(tmp_path / f"t{suffix}.db")
        configure_sqlite_connection(conn)
        assert int(_pragma(conn, "wal_autocheckpoint")) == 2000
        conn.close()


def test_litestream_enabled_semantics(monkeypatch):
    from novelvideo.sqlite_pragmas import litestream_enabled

    monkeypatch.setenv("ST_LITESTREAM_ENABLED", "1")
    assert litestream_enabled() is True
    for value in ("0", "false", "no", ""):
        monkeypatch.setenv("ST_LITESTREAM_ENABLED", value)
        assert litestream_enabled() is False


def test_async_variant(tmp_path, monkeypatch):
    monkeypatch.setenv("ST_LITESTREAM_ENABLED", "1")

    async def run():
        db = await aiosqlite.connect(tmp_path / "a.db")
        await configure_sqlite_connection_async(db)
        async with db.execute("PRAGMA journal_mode") as cur:
            mode = (await cur.fetchone())[0]
        async with db.execute("PRAGMA wal_autocheckpoint") as cur:
            ckpt = (await cur.fetchone())[0]
        await db.close()
        return mode, ckpt

    mode, ckpt = asyncio.run(run())
    assert str(mode).lower() == "wal"
    assert int(ckpt) == 0

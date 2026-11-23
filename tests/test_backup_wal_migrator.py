"""Tests for locating SQLite files under state/."""

import sqlite3

from novelvideo.backup.wal_migrator import iter_sqlite_files


def _make_db(path, journal_mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    if journal_mode:
        conn.execute(f"PRAGMA journal_mode={journal_mode}")
    conn.execute("CREATE TABLE t(x)")
    conn.commit()
    conn.close()


def test_iter_finds_sqlite_by_magic_and_skips_junk(tmp_path):
    _make_db(tmp_path / "u1" / "p1" / "data.db")
    _make_db(tmp_path / "u1" / "p1" / "cognee_system" / "databases" / "cognee_db")
    (tmp_path / "u1" / "p1" / "project_config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "u1" / "p1" / "data.db-wal").write_bytes(b"junk")
    sidecar_dir = tmp_path / "u1" / "p1" / "data.db-litestream"
    sidecar_dir.mkdir()
    (sidecar_dir / "x").write_bytes(b"SQLite format 3\x00junk")

    found = {p.relative_to(tmp_path).as_posix() for p in iter_sqlite_files(tmp_path)}
    assert found == {"u1/p1/data.db", "u1/p1/cognee_system/databases/cognee_db"}

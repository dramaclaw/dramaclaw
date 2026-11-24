"""Tests for locating SQLite files under state/."""

import sqlite3

from novelvideo.backup.wal_migrator import iter_sqlite_files

_MAGIC = b"SQLite format 3\x00"


def _make_db(path, journal_mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    if journal_mode:
        conn.execute(f"PRAGMA journal_mode={journal_mode}")
    conn.execute("CREATE TABLE t(x)")
    conn.commit()
    conn.close()


def _found(root):
    return {p.relative_to(root).as_posix() for p in iter_sqlite_files(root)}


def test_iter_finds_databases_by_suffix_and_header(tmp_path):
    _make_db(tmp_path / "u1" / "p1" / "data.db", journal_mode="WAL")
    _make_db(tmp_path / "u1" / "p1" / "_chat" / "s" / "chat.db")
    _make_db(tmp_path / "u1" / "_home" / "quota.sqlite3")
    _make_db(tmp_path / "_orgs" / "o" / "u2" / "p2" / "data.db")
    (tmp_path / "u1" / "p1" / "project_config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "u1" / "p1" / "notes.db").write_bytes(b"not a database")

    assert _found(tmp_path) == {
        "u1/p1/data.db",
        "u1/p1/_chat/s/chat.db",
        "u1/_home/quota.sqlite3",
        "_orgs/o/u2/p2/data.db",
    }


def test_iter_skips_sidecars_and_own_snapshots(tmp_path):
    db = tmp_path / "u1" / "p1" / "data.db"
    _make_db(db)
    for name in ("data.db-wal", "data.db-shm", "data.db-journal", "data.db.snapshot", "data.db.snapshot.tmp"):
        (db.parent / name).write_bytes(_MAGIC + b"junk")
    sidecar_dir = db.parent / "data.db-litestream"
    sidecar_dir.mkdir()
    (sidecar_dir / "x.db").write_bytes(_MAGIC + b"junk")

    assert _found(tmp_path) == {"u1/p1/data.db"}


def test_iter_does_not_sniff_files_without_a_database_suffix(tmp_path):
    # Only database-named files are opened; the bulk of state/ is JSON.
    (tmp_path / "u1" / "p1").mkdir(parents=True)
    (tmp_path / "u1" / "p1" / "blob").write_bytes(_MAGIC + b"junk")
    (tmp_path / "u1" / "p1" / "canvas.json").write_bytes(_MAGIC + b"junk")

    assert _found(tmp_path) == set()


def test_iter_prunes_freezone_history_trees(tmp_path):
    freezone = tmp_path / "u1" / "p1" / "freezone"
    _make_db(tmp_path / "u1" / "p1" / "data.db")
    for rel in (
        "canvases/_history/c.db",
        "canvases/_deleted/c/x.db",
        "_generation_history/c/n.db",
        "_canvas_events/c.db",
    ):
        _make_db(freezone / rel)

    assert _found(tmp_path) == {"u1/p1/data.db"}


def test_iter_skips_deprecated_cognee_and_hermes_internals(tmp_path):
    _make_db(tmp_path / "u1" / "p1" / "cognee_system" / "databases" / "cognee.db")
    _make_db(tmp_path / "_orgs" / "o" / "u1" / "p2" / "cognee_system" / "x.db")
    _make_db(tmp_path / "u1" / ".hermes" / "state.db")
    _make_db(tmp_path / "u1" / ".hermes" / "sessions" / "s1.db")

    assert _found(tmp_path) == {"u1/.hermes/state.db"}

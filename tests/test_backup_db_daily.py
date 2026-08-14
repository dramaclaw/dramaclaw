"""db_daily VACUUM INTO snapshot tests."""

import sqlite3

from novelvideo.backup.db_daily import snapshot_state_tree


def _make_db(path, rows=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE t(x)")
    conn.executemany("INSERT INTO t VALUES (?)", [(i,) for i in range(rows)])
    conn.commit()
    conn.close()


def test_snapshot_in_place_all_dbs(tmp_path):
    state = tmp_path / "state"
    data = state / "u1" / "p1" / "data.db"
    _make_db(data, rows=3)
    cognee = state / "u1" / "p1" / "cognee_system" / "databases" / "cognee_db"
    _make_db(cognee, rows=2)
    (state / "u1" / "p1" / "project_config.json").write_text("{}", encoding="utf-8")

    ok, failed = snapshot_state_tree(state)

    assert ok == 2 and failed == 0
    for src, rows in ((data, 3), (cognee, 2)):
        snap = src.with_name(src.name + ".snapshot")
        assert snap.exists()
        conn = sqlite3.connect(snap)
        assert conn.execute("SELECT count(*) FROM t").fetchone()[0] == rows
        conn.close()
        assert not snap.with_name(snap.name + "-wal").exists()
        assert not snap.with_name(snap.name + ".tmp").exists()


def test_rerun_replaces_snapshot_and_skips_own_output(tmp_path):
    state = tmp_path / "state"
    cognee = state / "u1" / "p1" / "cognee_system" / "databases" / "cognee_db"
    _make_db(cognee, rows=1)

    assert snapshot_state_tree(state) == (1, 0)
    conn = sqlite3.connect(cognee)
    conn.execute("INSERT INTO t VALUES (99)")
    conn.commit()
    conn.close()

    assert snapshot_state_tree(state) == (1, 0)
    snap = cognee.with_name("cognee_db.snapshot")
    conn = sqlite3.connect(snap)
    assert conn.execute("SELECT count(*) FROM t").fetchone()[0] == 2
    conn.close()


def test_failed_snapshot_keeps_yesterday_and_no_tmp(tmp_path):
    state = tmp_path / "state"
    bad = state / "u1" / "p1" / "cognee_system" / "databases" / "cognee_db"
    bad.parent.mkdir(parents=True, exist_ok=True)
    yesterday = bad.with_name("cognee_db.snapshot")
    yesterday.write_bytes(b"yesterday-good")
    bad.write_bytes(b"SQLite format 3\x00" + b"garbage" * 10)

    ok, failed = snapshot_state_tree(state)

    assert ok == 0 and failed == 1
    assert yesterday.read_bytes() == b"yesterday-good"
    assert not bad.with_name("cognee_db.snapshot.tmp").exists()


def test_main_empty_tree_is_success(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state))
    from novelvideo.backup.db_daily import main

    assert main() == 0


def test_main_missing_state_dir_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "missing"))
    from novelvideo.backup.db_daily import main

    assert main() == 1


def test_snapshot_hermes_state_db_but_not_cache(tmp_path):
    state = tmp_path / "state"
    _make_db(state / "u1" / ".hermes" / "state.db")
    _make_db(state / "u1" / ".hermes" / "audio_cache" / "idx.db")
    _make_db(state / "u1" / ".hermes" / "sessions" / "s1.db")

    ok, failed = snapshot_state_tree(state)

    assert ok == 1 and failed == 0
    assert (state / "u1" / ".hermes" / "state.db.snapshot").exists()
    assert not (state / "u1" / ".hermes" / "audio_cache" / "idx.db.snapshot").exists()
    assert not (state / "u1" / ".hermes" / "sessions" / "s1.db.snapshot").exists()

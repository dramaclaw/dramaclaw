from __future__ import annotations

import asyncio
import multiprocessing
import sqlite3
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from novelvideo.sqlite_store import SQLiteStore
from novelvideo.task_state import TaskStateManager


def _initialize_shared_project_db(
    kind: str,
    output_dir: str,
    state_dir: str,
    result_queue,
) -> None:
    try:
        if kind == "task":
            manager = TaskStateManager()
            with manager._connect_path(Path(state_dir) / "data.db"):
                pass
        else:
            async def initialize_store() -> None:
                store = SQLiteStore(
                    "alice/demo",
                    output_dir=output_dir,
                    state_dir=state_dir,
                )
                await store.initialize()
                await store.close()

            asyncio.run(initialize_store())
        result_queue.put("")
    except BaseException:
        result_queue.put(traceback.format_exc())


def test_task_connections_do_not_repeat_schema_ddl(tmp_path, monkeypatch):
    import novelvideo.task_state as task_state_module

    statements: list[str] = []
    original_connect = sqlite3.connect

    class RecordingConnection(sqlite3.Connection):
        def execute(self, sql, parameters=(), /):
            statements.append(str(sql))
            return super().execute(sql, parameters)

        def executescript(self, sql_script, /):
            statements.append(str(sql_script))
            return super().executescript(sql_script)

    def recording_connect(*args, **kwargs):
        kwargs["factory"] = RecordingConnection
        return original_connect(*args, **kwargs)

    monkeypatch.setattr(task_state_module.sqlite3, "connect", recording_connect)
    manager = TaskStateManager()
    db_path = tmp_path / "data.db"

    with manager._connect_path(db_path):
        pass
    statements.clear()

    with manager._connect_path(db_path):
        pass

    normalized = [statement.strip().upper() for statement in statements]
    assert not any(statement.startswith("CREATE ") for statement in normalized)
    assert not any(statement.startswith("ALTER ") for statement in normalized)
    assert "PRAGMA JOURNAL_MODE=WAL" not in normalized


def test_legacy_task_schema_is_upgraded_and_marked(tmp_path):
    db_path = tmp_path / "data.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE task_states (
            task_key TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            task_type TEXT NOT NULL,
            username TEXT NOT NULL,
            project TEXT NOT NULL,
            episode INTEGER NOT NULL,
            beat_num INTEGER,
            status TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0.0,
            current_task TEXT NOT NULL DEFAULT '',
            result_json TEXT,
            error TEXT,
            logs_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            completed_at TEXT NOT NULL DEFAULT '',
            expires_at TEXT
        )
        """
    )
    conn.commit()
    conn.close()

    manager = TaskStateManager()
    with manager._connect_path(db_path):
        pass

    conn = sqlite3.connect(db_path)
    try:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(task_states)").fetchall()
        }
        assert {
            "queue_kind",
            "project_id",
            "requester_user_id",
            "owner_username",
            "project_name",
        } <= columns
        assert conn.execute(
            "SELECT version FROM novelvideo_schema_components "
            "WHERE component = 'task_state'"
        ).fetchone() == (1,)
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    finally:
        conn.close()


@pytest.mark.asyncio
async def test_project_store_schema_is_not_reapplied(tmp_path, monkeypatch):
    output_dir = tmp_path / "output"
    state_dir = tmp_path / "state"
    first = SQLiteStore(
        "alice/demo",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )
    await first.initialize()
    await first.close()

    second = SQLiteStore(
        "alice/demo",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )

    async def unexpected_upgrade(_db):
        raise AssertionError("schema upgrade ran again")

    monkeypatch.setattr(second, "_ensure_episode_planning_columns", unexpected_upgrade)
    await second.initialize()
    await second.close()


def test_task_and_project_schema_initialize_safely_across_processes(tmp_path):
    output_dir = tmp_path / "output"
    state_dir = tmp_path / "state"
    output_dir.mkdir()
    state_dir.mkdir()
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue()
    processes = [
        context.Process(
            target=_initialize_shared_project_db,
            args=(kind, str(output_dir), str(state_dir), result_queue),
        )
        for kind in ("task", "project", "task", "project")
    ]

    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=30)
        assert not process.is_alive()
        assert process.exitcode == 0

    errors = [result_queue.get(timeout=5) for _ in processes]
    assert errors == ["", "", "", ""]

    conn = sqlite3.connect(state_dir / "data.db")
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        components = dict(
            conn.execute(
                "SELECT component, version FROM novelvideo_schema_components"
            ).fetchall()
        )
        assert components["task_state"] == 1
        assert components["project_store"] == 1
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert {"task_states", "characters", "episodes", "beats"} <= tables
    finally:
        conn.close()


def test_project_usage_components_share_one_db_without_schema_races(
    tmp_path,
    monkeypatch,
):
    import novelvideo.audio_request_usage as audio_usage
    import novelvideo.image_request_usage as image_usage
    import novelvideo.video_request_usage as video_usage
    from novelvideo.seedance2_i2v.voice_audio_records import (
        upsert_seedance2_voice_audio_record,
    )

    output_root = tmp_path / "output"
    state_root = tmp_path / "state"
    project_output = output_root / "alice" / "demo"
    project_output.mkdir(parents=True)
    for module in (audio_usage, image_usage, video_usage):
        monkeypatch.setattr(module, "OUTPUT_DIR", output_root)
        monkeypatch.setattr(module, "STATE_DIR", state_root)

    db_path = state_root / "alice" / "demo" / "data.db"
    operations = [
        lambda: image_usage.record_image_request(
            project_output_dir=project_output,
            request_id="image-1",
            provider="test",
            model_name="image",
            task_type="render",
            scope="beat",
        ),
        lambda: video_usage.record_video_request(
            project_output_dir=project_output,
            request_id="video-1",
            provider="test",
            model_name="video",
            episode=1,
            beat_num=1,
            task_type="video",
            duration_seconds=5,
        ),
        lambda: audio_usage.record_audio_generation_attempt(
            project_output_dir=project_output,
            request_id="audio-1",
            provider="test",
            model_name="audio",
            task_type="voice",
            scope="beat",
        ),
        lambda: upsert_seedance2_voice_audio_record(
            db_path=db_path,
            episode_number=1,
            beat_number=1,
            speaker="林昭",
            audio_path="voice.wav",
            voice_sha256="sha",
            mode="reference",
            provider="test",
            model="voice",
            status="completed",
        ),
    ]

    with ThreadPoolExecutor(max_workers=len(operations)) as executor:
        futures = [executor.submit(operation) for operation in operations]
        for future in futures:
            future.result(timeout=20)

    conn = sqlite3.connect(db_path)
    try:
        components = {
            row[0]
            for row in conn.execute(
                "SELECT component FROM novelvideo_schema_components"
            ).fetchall()
        }
        assert {
            "image_request_usage",
            "video_request_usage",
            "audio_request_usage",
            "seedance2_voice_audio_records",
        } <= components
        assert conn.execute("SELECT count(*) FROM image_request_usage").fetchone() == (1,)
        assert conn.execute("SELECT count(*) FROM video_request_usage").fetchone() == (1,)
        assert conn.execute("SELECT count(*) FROM audio_request_usage").fetchone() == (1,)
        assert conn.execute(
            "SELECT count(*) FROM seedance2_voice_audio_records"
        ).fetchone() == (1,)
    finally:
        conn.close()

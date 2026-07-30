"""C3 migration tests: IndexTTS2/Seedance2 schema bootstrap on store init."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


def _columns(db_path: str | Path, table: str) -> set[str]:
    with sqlite3.connect(str(db_path)) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _tables(db_path: str | Path) -> set[str]:
    with sqlite3.connect(str(db_path)) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }


@pytest.fixture
async def initialized_store(tmp_path):
    from novelvideo.sqlite_store import SQLiteStore

    output_dir = tmp_path / "output"
    state_dir = tmp_path / "state"
    output_dir.mkdir()
    state_dir.mkdir()
    store = SQLiteStore(
        "testuser/testproj_indextts2",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )
    await store.initialize()
    try:
        yield store
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_seedance2_voice_audio_records_table_created(initialized_store):
    cols = _columns(initialized_store.db_path, "seedance2_voice_audio_records")
    assert {
        "episode_number",
        "beat_number",
        "speaker",
        "audio_path",
        "voice_sha256",
        "text_sha256",
        "mode",
        "provider",
        "model",
        "generated_at",
        "status",
        "error",
    } <= cols


@pytest.mark.asyncio
async def test_beats_seedance2_config_column_added(initialized_store):
    cols = _columns(initialized_store.db_path, "beats")
    assert "seedance2_config_json" in cols


@pytest.mark.asyncio
async def test_characters_voice_columns_added(initialized_store):
    cols = _columns(initialized_store.db_path, "characters")
    assert "reference_audio_path" in cols
    assert "reference_audio_sha256" in cols
    assert "voice_samples_by_age_group_json" in cols


@pytest.mark.asyncio
async def test_idempotent_reinit_does_not_error(tmp_path):
    """Re-initializing on an existing DB must not raise (additive ALTER guard)."""
    from novelvideo.sqlite_store import SQLiteStore

    output_dir = tmp_path / "output"
    state_dir = tmp_path / "state"
    output_dir.mkdir()
    state_dir.mkdir()

    store1 = SQLiteStore(
        "testuser/idempotent",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )
    await store1.initialize()
    db_path = store1.db_path
    await store1.close()

    store2 = SQLiteStore(
        "testuser/idempotent",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )
    await store2.initialize()
    try:
        assert "seedance2_voice_audio_records" in _tables(db_path)
    finally:
        await store2.close()


def test_add_column_if_missing_ignores_duplicate_column_race():
    """A concurrent store init can add a column after our table_info read."""
    from novelvideo.sqlite_store import _add_column_if_missing

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return self._rows

    class FakeDb:
        def __init__(self):
            self.table_info_calls = 0
            self.alter_calls = 0

        def execute(self, sql):
            if sql.startswith("PRAGMA table_info(characters)"):
                self.table_info_calls += 1
                rows = [{"name": "id"}]
                if self.table_info_calls > 1:
                    rows.append({"name": "voice_samples_by_age_group_json"})
                return FakeCursor(rows)

            if sql.startswith("ALTER TABLE characters ADD COLUMN"):
                self.alter_calls += 1
                raise sqlite3.OperationalError(
                    "duplicate column name: voice_samples_by_age_group_json"
                )

            raise AssertionError(f"unexpected SQL: {sql}")

    db = FakeDb()

    _add_column_if_missing(
        db,
        "characters",
        "voice_samples_by_age_group_json",
        "TEXT DEFAULT '{}'",
    )

    assert db.alter_calls == 1


def test_character_voice_field_defaults_match_pydantic():
    """NovelCharacter / CharacterIdentity expose the new IndexTTS2 voice fields."""
    from novelvideo.models import CharacterIdentity, NovelCharacter

    char = NovelCharacter(name="测试角色")
    assert char.reference_audio_path == ""
    assert char.reference_audio_sha256 == ""
    assert char.voice_samples_by_age_group_json == "{}"
    assert char.voice_samples_by_age_group == {}

    char.voice_samples_by_age_group = {
        "youth": {"path": "x.mp3", "sha256": "abc", "updated_at": "now"},
    }
    assert "x.mp3" in char.voice_samples_by_age_group_json
    assert char.voice_samples_by_age_group["youth"]["sha256"] == "abc"

    identity = CharacterIdentity(
        identity_id="测试_皇帝",
        character_name="测试",
        identity_name="皇帝",
    )
    assert identity.reference_audio_path == ""
    assert identity.reference_audio_sha256 == ""


def test_novel_visual_beat_seedance2_config_default():
    from novelvideo.models import NovelVisualBeat

    beat = NovelVisualBeat(beat_number=1, episode_number=1, narration="x", visual_description="y")
    assert beat.seedance2_config_json == "{}"

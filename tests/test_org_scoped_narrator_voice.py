from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


class ScopedVoiceStore:
    def __init__(self, project_dir: Path, state_dir: Path, characters: list) -> None:
        self.project_dir = str(project_dir)
        self.state_dir = str(state_dir)
        self.db_path = str(state_dir / "data.db")
        self._characters = characters

    async def get_beats_as_dicts(self, episode: int) -> list[dict]:
        assert episode == 1
        return [
            {
                "beat_number": 1,
                "audio_type": "narration",
                "speaker": "",
                "narration_segment": "第一人称解说。",
            }
        ]

    async def list_characters(self) -> list:
        return self._characters


def _main_character_with_identity_voice(project_dir: Path):
    from novelvideo.models import CharacterIdentity, NovelCharacter

    voice_path = project_dir / "assets" / "characters" / "林夏" / "identity.wav"
    voice_path.parent.mkdir(parents=True, exist_ok=True)
    voice_path.write_bytes(b"identity-voice")
    character = NovelCharacter(name="林夏", gender="女", is_main=True)
    character.identities = [
        CharacterIdentity(
            identity_id="林夏_成年",
            character_name="林夏",
            identity_name="成年",
            reference_audio_path="assets/characters/林夏/identity.wav",
            reference_audio_sha256="identity-sha",
        )
    ]
    return character


@pytest.mark.asyncio
async def test_org_scoped_first_person_narrator_uses_main_identity_voice(tmp_path: Path) -> None:
    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )
    from novelvideo.project_config import save_project_config_in_state_dir

    suffix = Path("_scopes") / "scope_123" / "alice" / "demo"
    project_dir = tmp_path / "output" / suffix
    state_dir = tmp_path / "state" / suffix
    save_project_config_in_state_dir(
        state_dir,
        spine_template="narrated",
        narration_style="first_person",
    )
    store = ScopedVoiceStore(
        project_dir,
        state_dir,
        [_main_character_with_identity_voice(project_dir)],
    )

    errors = await collect_indextts2_voice_prereq_errors(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
    )

    assert errors == []


def test_personal_state_dir_voice_config_matches_legacy_wrappers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from novelvideo import project_config

    state_root = tmp_path / "state"
    state_dir = state_root / "alice" / "demo"
    monkeypatch.setattr(project_config, "OUTPUT_DIR", state_root)
    project_config.save_project_config_in_state_dir(
        state_dir,
        spine_template="narrated",
        narration_style="first_person",
        narrator_reference_audio_path="assets/narrator/voice.wav",
        narrator_reference_audio_sha256="voice-sha",
        narrator_reference_audio_updated_at="2026-08-19T00:00:00+00:00",
    )

    assert project_config.load_narration_style_from_state_dir(
        state_dir
    ) == project_config.load_narration_style("alice", "demo")
    assert project_config.is_narrated_project_from_state_dir(
        state_dir
    ) == project_config.is_narrated_project("alice", "demo")
    assert project_config.load_effective_narration_style_for_voice_from_state_dir(
        state_dir
    ) == project_config.load_effective_narration_style_for_voice("alice", "demo")
    assert project_config.load_narrator_reference_audio_from_state_dir(
        state_dir
    ) == project_config.load_narrator_reference_audio("alice", "demo")


def test_org_scoped_narrator_upload_writes_only_resolved_state_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from novelvideo import project_config
    from novelvideo.api.routes import projects

    suffix = Path("_scopes") / "scope_123" / "alice" / "demo"
    output_dir = tmp_path / "output" / suffix
    state_root = tmp_path / "state"
    state_dir = state_root / suffix
    output_dir.mkdir(parents=True)
    project_config.save_project_config_in_state_dir(
        state_dir,
        spine_template="narrated",
        narration_style="third_person",
    )
    monkeypatch.setattr(project_config, "OUTPUT_DIR", state_root)
    ctx = SimpleNamespace(
        project_id="project_123",
        project_name="demo",
        owner_username="alice",
        owner_project_label="alice/demo",
        output_dir=output_dir,
        state_dir=state_dir,
        is_home_node=True,
    )

    async def resolve_context(*, user, project_id, required_role="viewer"):
        return ctx

    store = SimpleNamespace(project_dir=str(output_dir), get_all_characters=lambda: [])

    async def make_store(_ctx):
        return store

    monkeypatch.setattr(projects, "resolve_project_context", resolve_context)
    monkeypatch.setattr(projects, "make_sqlite_store_for_context", make_store)
    monkeypatch.setattr(
        projects,
        "make_static_url_for_context",
        lambda _ctx, relative_path, local_path=None: f"/static/{relative_path}",
    )
    app = FastAPI()
    app.include_router(projects.router)
    app.dependency_overrides[projects.get_api_user] = lambda: {"username": "alice"}

    response = TestClient(app).post(
        "/projects/project_123/narrator-voice/upload",
        files={"file": ("voice.wav", b"voice-bytes", "audio/wav")},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    scoped = project_config.load_project_config_file_from_state_dir(state_dir)
    assert scoped["narrator_reference_audio_path"] == "assets/narrator/voice.wav"
    assert not (state_root / "alice" / "demo" / "project_config.json").exists()


@pytest.mark.asyncio
async def test_org_scoped_audio_projection_uses_resolved_voice_config(tmp_path: Path) -> None:
    from novelvideo.project_config import save_project_config_in_state_dir
    from novelvideo.task_backend.projection import build_projection

    state_dir = tmp_path / "state" / "_scopes" / "scope_123" / "alice" / "demo"
    save_project_config_in_state_dir(
        state_dir,
        spine_template="narrated",
        narration_style="first_person",
        narrator_reference_audio_path="assets/narrator/voice.wav",
        narrator_reference_audio_sha256="voice-sha",
    )
    store = ScopedVoiceStore(tmp_path / "output", state_dir, [])

    projection = await build_projection(
        store,
        {"username": "alice", "project_name": "demo"},
        task_type="freezone_audio_speech",
    )

    assert projection is not None
    fields = projection["fields"]
    assert fields["narration_style"] == "first_person"
    assert fields["narrator_reference_audio"]["path"] == "assets/narrator/voice.wav"


@pytest.mark.asyncio
async def test_org_scoped_missing_voice_is_not_swallowed_as_attribute_error(
    tmp_path: Path,
) -> None:
    from novelvideo.api.routes.generation import _collect_audio_prereq_errors
    from novelvideo.project_config import save_project_config_in_state_dir

    state_dir = tmp_path / "state" / "_scopes" / "scope_123" / "alice" / "demo"
    save_project_config_in_state_dir(
        state_dir,
        spine_template="narrated",
        narration_style="third_person",
    )
    store = ScopedVoiceStore(tmp_path / "output", state_dir, [])

    errors = await _collect_audio_prereq_errors(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
    )

    assert errors
    assert "项目解说人声线未配置" in errors[0]


@pytest.mark.asyncio
async def test_org_scoped_third_person_narrator_uses_project_reference(tmp_path: Path) -> None:
    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )
    from novelvideo.project_config import save_project_config_in_state_dir

    suffix = Path("_scopes") / "scope_123" / "alice" / "demo"
    project_dir = tmp_path / "output" / suffix
    state_dir = tmp_path / "state" / suffix
    narrator = project_dir / "assets" / "narrator" / "voice.wav"
    narrator.parent.mkdir(parents=True, exist_ok=True)
    narrator.write_bytes(b"narrator-voice")
    save_project_config_in_state_dir(
        state_dir,
        spine_template="narrated",
        narration_style="third_person",
        narrator_reference_audio_path="assets/narrator/voice.wav",
        narrator_reference_audio_sha256="narrator-sha",
    )
    store = ScopedVoiceStore(project_dir, state_dir, [])

    errors = await collect_indextts2_voice_prereq_errors(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
    )

    assert errors == []

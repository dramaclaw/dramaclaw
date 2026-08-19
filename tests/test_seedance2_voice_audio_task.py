from pathlib import Path

import pytest


class FakeGenerator:
    def __init__(self, fail_beats=None):
        self.calls = []
        self.fail_beats = set(fail_beats or [])

    async def generate(self, *, prompt, audio_url, output_path, emotion_prompt=""):
        from novelvideo.generators.tts_generator import TTSResult

        beat_num = int(Path(output_path).stem.split("_")[-1])
        self.calls.append(beat_num)
        if beat_num in self.fail_beats:
            return TTSResult(success=False, error=f"failed beat {beat_num}")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(f"audio-{beat_num}".encode())
        return TTSResult(success=True, audio_path=str(output_path), duration_seconds=1.0)


class FakeStore:
    def __init__(self, project_dir, db_path, beats, voice_hash="voice-new"):
        self.project_dir = str(project_dir)
        self.db_path = str(db_path)
        self._beats = list(beats)
        self.voice_hash = voice_hash

    async def get_beats_as_dicts(self, episode):
        assert episode == 1
        return list(self._beats)

    async def list_characters(self):
        from novelvideo.models import CharacterIdentity, NovelCharacter

        reference = (
            Path(self.project_dir)
            / "assets"
            / "characters"
            / "谢铮"
            / "identities"
            / "幼年时期_voice.wav"
        )
        reference.parent.mkdir(parents=True, exist_ok=True)
        reference.write_bytes(b"reference")
        character = NovelCharacter(name="谢铮", gender="男")
        character.identities = [
            CharacterIdentity(
                identity_id="谢铮_幼年时期",
                character_name="谢铮",
                identity_name="幼年时期",
                reference_audio_path="assets/characters/谢铮/identities/幼年时期_voice.wav",
                reference_audio_sha256=self.voice_hash,
            )
        ]
        return [character]


class FakeStoreCharacterDefaultVoice:
    def __init__(self, project_dir, db_path, beats, voice_hash="character-default-hash"):
        self.project_dir = str(project_dir)
        self.db_path = str(db_path)
        self._beats = list(beats)
        self.voice_hash = voice_hash

    async def get_beats_as_dicts(self, episode):
        assert episode == 1
        return list(self._beats)

    async def list_characters(self):
        from novelvideo.models import CharacterIdentity, NovelCharacter

        reference = (
            Path(self.project_dir)
            / "assets"
            / "characters"
            / "谢铮"
            / "voice_sample.wav"
        )
        reference.parent.mkdir(parents=True, exist_ok=True)
        reference.write_bytes(b"character-default-reference")
        character = NovelCharacter(
            name="谢铮",
            gender="男",
            reference_audio_path="assets/characters/谢铮/voice_sample.wav",
            reference_audio_sha256=self.voice_hash,
        )
        character.identities = [
            CharacterIdentity(
                identity_id="谢铮_幼年时期",
                character_name="谢铮",
                identity_name="幼年时期",
                reference_audio_path="",
                reference_audio_sha256="",
            )
        ]
        return [character]


def _beats():
    return [
        {
            "beat_number": 1,
            "audio_type": "dialogue",
            "speaker": "谢铮_幼年时期",
            "narration_segment": "谢铮说：“你终于来了。”",
        },
        {
            "beat_number": 2,
            "audio_type": "dialogue",
            "speaker": "谢铮_幼年时期",
            "narration_segment": "“别走。”她说。",
        },
        {
            "beat_number": 3,
            "audio_type": "dialogue",
            "speaker": "李婶_镇民时期",
            "narration_segment": "“谢谢。”",
        },
        {
            "beat_number": 4,
            "audio_type": "narration",
            "speaker": "谢铮_幼年时期",
            "narration_segment": "旁白。",
        },
    ]


def _write_drama_first_person_project_narrator(tmp_path, project_dir, monkeypatch) -> str:
    from novelvideo.seedance2_i2v.voice_clone import file_sha256
    from novelvideo.project_config import set_narrator_reference_audio, update_project_config_file

    narrator = project_dir / "assets" / "narrator" / "voice.wav"
    narrator.parent.mkdir(parents=True, exist_ok=True)
    narrator.write_bytes(b"project-narrator-reference")
    narrator_sha = file_sha256(narrator)
    monkeypatch.setattr("novelvideo.project_config.OUTPUT_DIR", tmp_path / "state")
    set_narrator_reference_audio(
        "alice",
        "demo",
        relative_path="assets/narrator/voice.wav",
        sha256=narrator_sha,
        updated_at="2026-05-12T00:00:00+00:00",
    )
    update_project_config_file(
        "alice",
        "demo",
        lambda config: config.update(
            {"spine_template": "drama", "narration_style": "first_person"}
        ),
    )
    return narrator_sha


class FakeNarrationStore:
    def __init__(self, project_dir, db_path):
        self.project_dir = str(project_dir)
        self.db_path = str(db_path)
        self.state_dir = str(Path(db_path).parent)

    async def get_beats_as_dicts(self, episode):
        assert episode == 1
        return [
            {
                "beat_number": 1,
                "audio_type": "narration",
                "speaker": "",
                "narration_segment": "旁白。",
            }
        ]

    async def list_characters(self):
        from novelvideo.models import CharacterIdentity, NovelCharacter

        reference = (
            Path(self.project_dir)
            / "assets"
            / "characters"
            / "谢铮"
            / "identities"
            / "青年_voice.wav"
        )
        reference.parent.mkdir(parents=True, exist_ok=True)
        reference.write_bytes(b"main-character-reference")
        character = NovelCharacter(name="谢铮", gender="男", is_main=True)
        character.identities = [
            CharacterIdentity(
                identity_id="谢铮_青年",
                character_name="谢铮",
                identity_name="青年",
                reference_audio_path="assets/characters/谢铮/identities/青年_voice.wav",
                reference_audio_sha256="main-character-hash",
            )
        ]
        return [character]


@pytest.mark.asyncio
async def test_seedance2_voice_task_missing_only_skips_existing(tmp_path):
    from novelvideo.seedance2_i2v.voice_audio_task import run_seedance2_voice_audio_generation

    project_dir = tmp_path / "project"
    db_path = tmp_path / "state" / "data.db"
    existing = project_dir / "audio" / "ep001" / "beat_01.mp3"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"existing")
    generator = FakeGenerator()
    store = FakeStore(project_dir, db_path, _beats())

    result = await run_seedance2_voice_audio_generation(
        store=store,
        episode=1,
        speaker="谢铮_幼年时期",
        mode="missing_only",
        expected_voice_sha256="voice-new",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert result.skipped_existing == 1
    assert generator.calls == [2]
    assert existing.read_bytes() == b"existing"


@pytest.mark.asyncio
async def test_seedance2_voice_task_accepts_character_default_voice_fallback(tmp_path):
    from novelvideo.seedance2_i2v.voice_audio_task import run_seedance2_voice_audio_generation

    generator = FakeGenerator()
    store = FakeStoreCharacterDefaultVoice(
        tmp_path / "project",
        tmp_path / "state" / "data.db",
        _beats(),
    )

    result = await run_seedance2_voice_audio_generation(
        store=store,
        episode=1,
        speaker="谢铮_幼年时期",
        mode="redo_all",
        expected_voice_sha256="character-default-hash",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 2
    assert result.voice_sha256 == "character-default-hash"
    assert generator.calls == [1, 2]


@pytest.mark.asyncio
async def test_seedance2_voice_task_redo_all_overwrites_existing(tmp_path):
    from novelvideo.seedance2_i2v.voice_audio_task import run_seedance2_voice_audio_generation

    project_dir = tmp_path / "project"
    db_path = tmp_path / "state" / "data.db"
    existing = project_dir / "audio" / "ep001" / "beat_01.mp3"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"existing")
    generator = FakeGenerator()
    store = FakeStore(project_dir, db_path, _beats())

    result = await run_seedance2_voice_audio_generation(
        store=store,
        episode=1,
        speaker="谢铮_幼年时期",
        mode="redo_all",
        expected_voice_sha256="voice-new",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 2
    assert result.skipped_existing == 0
    assert result.generated_beats == [1, 2]
    assert generator.calls == [1, 2]
    assert existing.read_bytes() == b"audio-1"


@pytest.mark.asyncio
async def test_seedance2_voice_task_stops_when_voice_hash_changed(tmp_path):
    from novelvideo.seedance2_i2v.voice_audio_task import run_seedance2_voice_audio_generation

    store = FakeStore(
        tmp_path / "project",
        tmp_path / "state" / "data.db",
        _beats(),
        voice_hash="other",
    )

    with pytest.raises(RuntimeError, match="声线版本已变化"):
        await run_seedance2_voice_audio_generation(
            store=store,
            episode=1,
            speaker="谢铮_幼年时期",
            mode="redo_all",
            expected_voice_sha256="voice-new",
            generator=FakeGenerator(),
            audio_url_builder=lambda path: f"data://{Path(path).name}",
        )


@pytest.mark.asyncio
async def test_seedance2_voice_task_collects_partial_failures(tmp_path):
    from novelvideo.seedance2_i2v.voice_audio_task import run_seedance2_voice_audio_generation

    generator = FakeGenerator(fail_beats={2})
    store = FakeStore(tmp_path / "project", tmp_path / "state" / "data.db", _beats())

    result = await run_seedance2_voice_audio_generation(
        store=store,
        episode=1,
        speaker="谢铮_幼年时期",
        mode="redo_all",
        expected_voice_sha256="voice-new",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert result.failed == ["Beat 02: failed beat 2"]


@pytest.mark.asyncio
async def test_seedance2_narration_task_drama_first_person_uses_project_narrator(
    tmp_path, monkeypatch
):
    from novelvideo.seedance2_i2v.narration_audio_task import (
        run_seedance2_narration_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    db_path = tmp_path / "state" / "alice" / "demo" / "data.db"
    narrator_sha = _write_drama_first_person_project_narrator(
        tmp_path, project_dir, monkeypatch
    )
    generator = FakeGenerator()

    result = await run_seedance2_narration_audio_generation(
        store=FakeNarrationStore(project_dir, db_path),
        username="alice",
        project="demo",
        episode=1,
        mode="redo_all",
        expected_voice_sha256=narrator_sha,
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert result.voice_sha256 == narrator_sha
    assert result.narration_style == "third_person"
    assert generator.calls == [1]


def test_seedance2_task_modules_are_available():
    import novelvideo.seedance2_i2v.narration_audio_task as narration_audio_task
    import novelvideo.seedance2_i2v.voice_audio_task as voice_audio_task

    assert hasattr(narration_audio_task, "run_seedance2_narration_audio_generation")
    assert hasattr(voice_audio_task, "run_seedance2_voice_audio_generation")


def test_seedance2_package_exports_video_helpers():
    import novelvideo.seedance2_i2v as seedance2_i2v

    for name in (
        "Seedance2I2VMode",
        "Seedance2VideoConfig",
        "Seedance2ResolvedAsset",
        "build_seedance2_huimeng_params",
        "build_seedance2_project_assets",
        "build_seedance2_asset_manifest",
        "build_seedance2_prompt_draft",
        "compute_seedance2_prompt_inputs_hash",
        "generate_seedance2_prompt",
        "selected_reference_paths",
    ):
        assert hasattr(seedance2_i2v, name)

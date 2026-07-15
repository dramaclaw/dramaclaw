import hashlib
import json
from pathlib import Path

import pytest

from novelvideo.shared.billing_errors import InsufficientCreditsError

pytestmark = pytest.mark.m07


class FakeGenerator:
    def __init__(self, fail_beats=None):
        self.calls = []
        self.fail_beats = set(fail_beats or [])

    async def generate(self, *, prompt, audio_url, output_path, emotion_prompt=""):
        from novelvideo.generators.tts_generator import TTSResult

        beat_num = int(Path(output_path).stem.split("_")[-1])
        self.calls.append(
            {
                "beat": beat_num,
                "prompt": prompt,
                "audio_url": audio_url,
                "emotion_prompt": emotion_prompt,
            }
        )
        if beat_num in self.fail_beats:
            return TTSResult(success=False, error=f"failed beat {beat_num}")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(f"audio-{beat_num}".encode())
        return TTSResult(success=True, audio_path=str(output_path), duration_seconds=1.0)


class InsufficientCreditGenerator:
    async def generate(self, *, prompt, audio_url, output_path, emotion_prompt=""):
        raise InsufficientCreditsError(user_id="usr_1", cost=3, balance=0)


class FakeStore:
    def __init__(self, project_dir, db_path, beats, *, include_dialogue_voice=True):
        self.project_dir = str(project_dir)
        self.db_path = str(db_path)
        self._beats = list(beats)
        self.include_dialogue_voice = include_dialogue_voice

    async def get_beats_as_dicts(self, episode):
        assert episode == 1
        return list(self._beats)

    async def list_characters(self):
        from novelvideo.models import CharacterIdentity, NovelCharacter

        project_dir = Path(self.project_dir)
        reference_audio_path = ""
        reference_audio_sha256 = ""
        if self.include_dialogue_voice:
            character_voice = project_dir / "assets" / "characters" / "谢铮" / "voice_sample.wav"
            character_voice.parent.mkdir(parents=True, exist_ok=True)
            character_voice.write_bytes(b"character-reference")
            reference_audio_path = "assets/characters/谢铮/voice_sample.wav"
            reference_audio_sha256 = "character-voice-hash"
        character = NovelCharacter(
            name="谢铮",
            gender="男",
            is_main=True,
            reference_audio_path=reference_audio_path,
            reference_audio_sha256=reference_audio_sha256,
        )
        character.identities = [
            CharacterIdentity(
                identity_id="谢铮_青年时期",
                character_name="谢铮",
                identity_name="青年时期",
                reference_audio_path="",
            )
        ]
        return [character]


def _beats():
    return [
        {
            "beat_number": 1,
            "audio_type": "narration",
            "speaker": "",
            "narration_segment": "旁白开场。",
        },
        {
            "beat_number": 2,
            "audio_type": "dialogue",
            "speaker": "谢铮_青年时期",
            "narration_segment": "谢铮低声说：“走。”",
        },
        {
            "beat_number": 3,
            "audio_type": "silence",
            "is_manual_shot": True,
            "narration_segment": "手工镜头。",
        },
        {
            "beat_number": 4,
            "audio_type": "narration",
            "speaker": "",
            "narration_segment": "",
        },
    ]


def _beat_uploaded_narration(upload_path: Path) -> dict:
    return {
        "beat_number": 1,
        "audio_type": "narration",
        "speaker": "",
        "narration_segment": "画外音响起。",
        "seedance2_config_json": json.dumps({"reference_audio_paths": [str(upload_path)]}),
    }


def _write_project_narrator(tmp_path, project_dir, monkeypatch):
    from novelvideo.project_config import set_narrator_reference_audio, update_project_config_file

    narrator = project_dir / "assets" / "narrator" / "voice.wav"
    narrator.parent.mkdir(parents=True, exist_ok=True)
    narrator.write_bytes(b"narrator-reference")
    monkeypatch.setattr("novelvideo.project_config.OUTPUT_DIR", tmp_path / "state")
    set_narrator_reference_audio(
        "alice",
        "demo",
        relative_path="assets/narrator/voice.wav",
        sha256="narrator-voice-hash",
        updated_at="2026-05-12T00:00:00+00:00",
    )
    update_project_config_file(
        "alice",
        "demo",
        lambda config: config.update({"narration_style": "third_person"}),
    )


def _write_project_template(tmp_path, monkeypatch, *, spine_template: str) -> None:
    monkeypatch.setattr("novelvideo.project_config.OUTPUT_DIR", tmp_path / "state")
    from novelvideo.project_config import update_project_config_file

    update_project_config_file(
        "alice",
        "demo",
        lambda config: config.update(
            {"spine_template": spine_template, "narration_style": "third_person"}
        ),
    )


def _text_sha256(text: str) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


@pytest.mark.asyncio
async def test_indextts2_selected_runner_generates_narration_and_dialogue(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    generator = FakeGenerator()
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1, 2, 3, 4],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 2
    assert result.skipped_non_dialogue == 0
    assert result.skipped_empty == 1
    assert result.skipped_manual == 0
    assert result.skipped_silence == 1
    assert result.failed == []
    assert result.generated_beats == [1, 2]
    assert [call["beat"] for call in generator.calls] == [1, 2]
    assert generator.calls[0]["emotion_prompt"] == "以第三人称旁白视角，用客观冷静的解说语气朗读"
    assert (project_dir / "audio" / "ep001" / "beat_01.mp3").read_bytes() == b"audio-1"
    assert (project_dir / "audio" / "ep001" / "beat_02.mp3").read_bytes() == b"audio-2"

    import sqlite3

    from novelvideo.audio_request_usage import get_audio_request_usage_db_path

    with sqlite3.connect(get_audio_request_usage_db_path(project_dir)) as conn:
        rows = conn.execute(
            """
            SELECT provider, model_name, task_type, scope, episode, status
            FROM audio_request_usage
            ORDER BY scope
            """
        ).fetchall()
    assert rows == [
        (
            "newapi",
            "index-tts-2",
            "audio_generation_indextts2",
            "ep001:beat_01:__narrator__",
            1,
            "completed",
        ),
        (
            "newapi",
            "index-tts-2",
            "audio_generation_indextts2",
            "ep001:beat_02:谢铮_青年时期",
            1,
            "completed",
        ),
    ]


@pytest.mark.asyncio
async def test_indextts2_runner_generates_manual_narration_and_dialogue(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    generator = FakeGenerator()
    store = FakeStore(
        project_dir,
        state_dir / "data.db",
        [
            {
                "beat_number": 41,
                "is_manual_shot": True,
                "audio_type": "narration",
                "speaker": "",
                "narration_segment": "补一段画外旁白。",
            },
            {
                "beat_number": 42,
                "is_manual_shot": True,
                "audio_type": "dialogue",
                "speaker": "谢铮_青年时期",
                "narration_segment": "别回头。",
            },
            {
                "beat_number": 43,
                "is_manual_shot": True,
                "audio_type": "silence",
                "speaker": "",
                "narration_segment": "",
            },
        ],
    )

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[41, 42, 43],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 2
    assert result.skipped_manual == 0
    assert result.skipped_silence == 1
    assert result.generated_beats == [41, 42]
    assert [call["beat"] for call in generator.calls] == [41, 42]


@pytest.mark.asyncio
async def test_indextts2_runner_treats_missing_audio_type_as_narration(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    generator = FakeGenerator()
    store = FakeStore(
        project_dir,
        state_dir / "data.db",
        [
            {
                "beat_number": 1,
                "audio_type": "",
                "speaker": "",
                "narration_segment": "昏暗的街区里只有面馆的照明灯亮着。",
            }
        ],
    )

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert result.skipped_non_dialogue == 0
    assert generator.calls[0]["prompt"] == "昏暗的街区里只有面馆的照明灯亮着。"


@pytest.mark.asyncio
async def test_indextts2_drama_narration_uses_beat_uploaded_audio_before_project_narrator(
    tmp_path, monkeypatch
):
    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_template(tmp_path, monkeypatch, spine_template="drama")
    uploaded_voice = project_dir / "seedance2_uploads" / "ep001" / "beat_01" / "audios" / "voice.wav"
    uploaded_voice.parent.mkdir(parents=True, exist_ok=True)
    uploaded_voice.write_bytes(b"beat-uploaded-voice")
    store = FakeStore(project_dir, state_dir / "data.db", [_beat_uploaded_narration(uploaded_voice)])

    errors = await collect_indextts2_voice_prereq_errors(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
    )
    assert errors == []

    generator = FakeGenerator()
    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert generator.calls[0]["audio_url"] == "data://voice.wav"
    assert generator.calls[0]["prompt"] == "画外音响起。"


@pytest.mark.asyncio
async def test_indextts2_narrated_project_ignores_beat_uploaded_narration_voice(
    tmp_path, monkeypatch
):
    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_template(tmp_path, monkeypatch, spine_template="narrated")
    uploaded_voice = project_dir / "seedance2_uploads" / "ep001" / "beat_01" / "audios" / "voice.wav"
    uploaded_voice.parent.mkdir(parents=True, exist_ok=True)
    uploaded_voice.write_bytes(b"beat-uploaded-voice")
    store = FakeStore(project_dir, state_dir / "data.db", [_beat_uploaded_narration(uploaded_voice)])

    errors = await collect_indextts2_voice_prereq_errors(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
    )

    assert errors == ["Beat 01 解说声线缺失：项目解说人声线缺失，请上传或录制解说人音频"]


@pytest.mark.asyncio
async def test_indextts2_drama_narration_ignores_first_person_protagonist_for_fallback(
    tmp_path, monkeypatch
):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )
    from novelvideo.project_config import update_project_config_file

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    update_project_config_file(
        "alice",
        "demo",
        lambda config: config.update(
            {"spine_template": "drama", "narration_style": "first_person"}
        ),
    )
    generator = FakeGenerator()
    store = FakeStore(
        project_dir,
        state_dir / "data.db",
        [
            {
                "beat_number": 1,
                "audio_type": "narration",
                "speaker": "",
                "narration_segment": "画外音响起。",
            }
        ],
    )

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert generator.calls[0]["audio_url"] == "data://voice.wav"


@pytest.mark.asyncio
async def test_indextts2_runner_treats_legacy_action_audio_type_as_silence(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    generator = FakeGenerator()
    store = FakeStore(
        project_dir,
        state_dir / "data.db",
        [
            {
                "beat_number": 1,
                "audio_type": "action",
                "speaker": "",
                "narration_segment": "昏暗的街区里只有面馆的照明灯亮着。",
            }
        ],
    )

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 0
    assert result.skipped_silence == 1
    assert result.skipped_non_dialogue == 0
    assert generator.calls == []


@pytest.mark.asyncio
async def test_indextts2_runner_skips_silence_audio_type(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    generator = FakeGenerator()
    store = FakeStore(
        project_dir,
        state_dir / "data.db",
        [
            {
                "beat_number": 1,
                "audio_type": "silence",
                "speaker": "",
                "narration_segment": "",
            }
        ],
    )

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 0
    assert result.skipped_silence == 1
    assert result.skipped_empty == 0
    assert result.skipped_non_dialogue == 0
    assert generator.calls == []


@pytest.mark.asyncio
async def test_indextts2_selected_runner_missing_only_skips_existing(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    existing = project_dir / "audio" / "ep001" / "beat_02.mp3"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_bytes(b"existing")
    generator = FakeGenerator()
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1, 2],
        mode="missing_only",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert result.skipped_existing == 1
    assert result.skipped_non_dialogue == 0
    assert [call["beat"] for call in generator.calls] == [1]
    assert existing.read_bytes() == b"existing"


@pytest.mark.asyncio
async def test_indextts2_sync_changed_skips_current_existing_audio(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )
    from novelvideo.seedance2_i2v.voice_audio_records import (
        upsert_seedance2_voice_audio_record,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    existing = project_dir / "audio" / "ep001" / "beat_02.mp3"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_bytes(b"existing")
    upsert_seedance2_voice_audio_record(
        db_path=state_dir / "data.db",
        episode_number=1,
        beat_number=2,
        speaker="谢铮_青年时期",
        audio_path=existing,
        voice_sha256="character-voice-hash",
        text_sha256=_text_sha256("走。"),
        mode="sync_changed",
        provider="fal.ai",
        model="IndexTTS2",
        status="success",
    )
    generator = FakeGenerator()
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[2],
        mode="sync_changed",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 0
    assert result.skipped_existing == 1
    assert generator.calls == []
    assert existing.read_bytes() == b"existing"


@pytest.mark.asyncio
async def test_indextts2_runner_logs_skipped_breakdown(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )
    from novelvideo.seedance2_i2v.voice_audio_records import (
        upsert_seedance2_voice_audio_record,
    )
    from novelvideo.seedance2_i2v.voice_clone import NARRATOR_SPEAKER, file_sha256

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    narrator_voice = project_dir / "assets" / "narrator" / "voice.wav"
    existing = project_dir / "audio" / "ep001" / "beat_01.mp3"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_bytes(b"existing")
    upsert_seedance2_voice_audio_record(
        db_path=state_dir / "data.db",
        episode_number=1,
        beat_number=1,
        speaker=NARRATOR_SPEAKER,
        audio_path=existing,
        voice_sha256=file_sha256(narrator_voice),
        text_sha256=_text_sha256("旁白开场。"),
        mode="sync_changed",
        provider="fal.ai",
        model="IndexTTS2",
        status="success",
    )
    logs: list[str] = []
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="sync_changed",
        generator=FakeGenerator(),
        audio_url_builder=lambda path: f"data://{Path(path).name}",
        log_callback=logs.append,
    )

    assert result.generated == 0
    assert result.skipped_existing == 1
    assert any(
        "skipped=1" in line
        and "existing=1" in line
        and "empty=0" in line
        and "manual=0" in line
        and "non_dialogue=0" in line
        for line in logs
    )


@pytest.mark.asyncio
async def test_indextts2_sync_changed_regenerates_when_text_hash_changes(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )
    from novelvideo.seedance2_i2v.voice_audio_records import (
        get_seedance2_voice_audio_record,
        upsert_seedance2_voice_audio_record,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    existing = project_dir / "audio" / "ep001" / "beat_02.mp3"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_bytes(b"existing")
    upsert_seedance2_voice_audio_record(
        db_path=state_dir / "data.db",
        episode_number=1,
        beat_number=2,
        speaker="谢铮_青年时期",
        audio_path=existing,
        voice_sha256="character-voice-hash",
        text_sha256=_text_sha256("旧台词"),
        mode="sync_changed",
        provider="fal.ai",
        model="IndexTTS2",
        status="success",
    )
    generator = FakeGenerator()
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[2],
        mode="sync_changed",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert result.skipped_existing == 0
    assert [call["beat"] for call in generator.calls] == [2]
    assert existing.read_bytes() == b"audio-2"
    record = get_seedance2_voice_audio_record(
        db_path=state_dir / "data.db",
        episode_number=1,
        beat_number=2,
        speaker="谢铮_青年时期",
    )
    assert record is not None
    assert record.text_sha256 == _text_sha256("走。")


@pytest.mark.asyncio
async def test_indextts2_selected_runner_records_missing_voice_and_continues(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    generator = FakeGenerator()
    store = FakeStore(
        project_dir,
        state_dir / "data.db",
        _beats(),
        include_dialogue_voice=False,
    )

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1, 2],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert result.generated_beats == [1]
    assert result.skipped_non_dialogue == 0
    assert any("Beat 02" in failure and "声线" in failure for failure in result.failed)
    assert [call["beat"] for call in generator.calls] == [1]


@pytest.mark.asyncio
async def test_indextts2_voice_prereq_check_reports_missing_dialogue_before_task(
    tmp_path, monkeypatch
):
    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    store = FakeStore(
        project_dir,
        state_dir / "data.db",
        _beats(),
        include_dialogue_voice=False,
    )

    errors = await collect_indextts2_voice_prereq_errors(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1, 2],
        mode="redo_selected",
    )

    assert errors == ["Beat 02 角色声线缺失：谢铮_青年时期"]


@pytest.mark.asyncio
async def test_indextts2_voice_prereq_check_reports_missing_narrator_before_task(
    tmp_path, monkeypatch
):
    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    monkeypatch.setattr("novelvideo.project_config.OUTPUT_DIR", tmp_path / "state")
    from novelvideo.project_config import update_project_config_file

    update_project_config_file(
        "alice",
        "demo",
        lambda config: config.update({"narration_style": "third_person"}),
    )
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    errors = await collect_indextts2_voice_prereq_errors(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="redo_selected",
    )

    assert errors == ["Beat 01 解说声线缺失：项目解说人声线缺失，请上传或录制解说人音频"]


@pytest.mark.asyncio
async def test_indextts2_voice_prereq_check_skips_existing_in_missing_only(
    tmp_path,
):
    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    existing = project_dir / "audio" / "ep001" / "beat_01.mp3"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_bytes(b"existing")
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    errors = await collect_indextts2_voice_prereq_errors(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1],
        mode="missing_only",
    )

    assert errors == []


@pytest.mark.asyncio
async def test_indextts2_selected_runner_records_generator_failure(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    generator = FakeGenerator(fail_beats={2})
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    result = await run_indextts2_beat_audio_generation(
        store=store,
        username="alice",
        project="demo",
        episode=1,
        beat_numbers=[1, 2],
        mode="redo_selected",
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.generated == 1
    assert result.generated_beats == [1]
    assert result.skipped_non_dialogue == 0
    assert result.failed == ["Beat 02: failed beat 2"]

    import sqlite3

    from novelvideo.audio_request_usage import get_audio_request_usage_db_path

    with sqlite3.connect(get_audio_request_usage_db_path(project_dir)) as conn:
        rows = conn.execute(
            """
            SELECT scope, status, error_message
            FROM audio_request_usage
            ORDER BY scope
            """
        ).fetchall()

    assert rows[0][0:2] == ("ep001:beat_01:__narrator__", "completed")
    assert rows[0][2] in ("", None)
    assert rows[1] == ("ep001:beat_02:谢铮_青年时期", "failed", "failed beat 2")


@pytest.mark.asyncio
async def test_indextts2_selected_runner_reraises_insufficient_credit(tmp_path, monkeypatch):
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )

    project_dir = tmp_path / "output" / "alice" / "demo"
    state_dir = tmp_path / "state" / "alice" / "demo"
    _write_project_narrator(tmp_path, project_dir, monkeypatch)
    store = FakeStore(project_dir, state_dir / "data.db", _beats())

    with pytest.raises(InsufficientCreditsError):
        await run_indextts2_beat_audio_generation(
            store=store,
            username="alice",
            project="demo",
            episode=1,
            beat_numbers=[1],
            mode="redo_selected",
            generator=InsufficientCreditGenerator(),
            audio_url_builder=lambda path: f"data://{Path(path).name}",
        )

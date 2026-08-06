from pathlib import Path

import pytest


class _FakeStore:
    def __init__(self, project_dir, characters):
        self.project_dir = str(project_dir)
        self._characters = characters

    async def list_characters(self):
        return list(self._characters)

    def get_all_characters(self):
        return list(self._characters)


class _FakeGenerator:
    def __init__(self):
        self.calls = []

    async def generate(self, *, prompt, audio_url, output_path, emotion_prompt=""):
        from novelvideo.generators.tts_generator import TTSResult

        self.calls.append(
            {
                "prompt": prompt,
                "audio_url": audio_url,
                "output_path": str(output_path),
                "emotion_prompt": emotion_prompt,
            }
        )
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"beat-audio")
        return TTSResult(success=True, audio_path=str(output_path), duration_seconds=1.25)


def _characters():
    from novelvideo.models import CharacterIdentity, NovelCharacter

    character = NovelCharacter(
        name="谢铮",
        gender="男",
        reference_audio_path="assets/characters/谢铮/voice_sample.wav",
    )
    character.identities = [
        CharacterIdentity(
            identity_id="谢铮_幼年时期",
            character_name="谢铮",
            identity_name="幼年时期",
            reference_audio_path="assets/characters/谢铮/identities/幼年时期_voice.wav",
        )
    ]
    return [character]


def test_dialogue_text_extracts_spoken_quote_from_attribution():
    from novelvideo.seedance2_i2v.voice_clone import dialogue_text

    assert (
        dialogue_text({"narration_segment": "李婶哭着喊：“陆老板，您是救命恩人！”"})
        == "陆老板，您是救命恩人！"
    )


def test_dialogue_text_keeps_plain_dialogue_without_quotes():
    from novelvideo.seedance2_i2v.voice_clone import dialogue_text

    assert dialogue_text({"narration_segment": "你终于来了。"}) == "你终于来了。"


def test_dialogue_emotion_prompt_extracts_attribution_outside_quote():
    from novelvideo.seedance2_i2v.voice_clone import dialogue_emotion_prompt

    assert (
        dialogue_emotion_prompt(
            {"narration_segment": "李婶哭着喊：“陆老板，您是救命恩人！”"}
        )
        == "李婶哭着喊"
    )


def test_dialogue_emotion_prompt_extracts_trailing_attribution():
    from novelvideo.seedance2_i2v.voice_clone import dialogue_emotion_prompt

    assert (
        dialogue_emotion_prompt({"narration_segment": "“别走！”她哽咽着说。"})
        == "她哽咽着说"
    )


def test_dialogue_emotion_prompt_ignores_plain_dialogue_without_quotes():
    from novelvideo.seedance2_i2v.voice_clone import dialogue_emotion_prompt

    assert dialogue_emotion_prompt({"narration_segment": "你终于来了。"}) == ""


def test_seedance2_audio_type_normalizes_legacy_action_to_silence():
    from novelvideo.seedance2_i2v.voice_clone import normalize_seedance2_audio_type

    assert normalize_seedance2_audio_type({"audio_type": "action", "speaker": ""}) == "silence"


def test_seedance2_audio_type_preserves_silence():
    from novelvideo.seedance2_i2v.voice_clone import normalize_seedance2_audio_type

    assert normalize_seedance2_audio_type({"audio_type": "silence", "speaker": ""}) == "silence"


@pytest.mark.asyncio
async def test_seedance2_voice_clone_uses_identity_reference_before_character(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import generate_seedance2_dialogue_audio

    project_dir = tmp_path / "project"
    identity_reference = (
        project_dir
        / "assets"
        / "characters"
        / "谢铮"
        / "identities"
        / "幼年时期_voice.wav"
    )
    character_reference = project_dir / "assets" / "characters" / "谢铮" / "voice_sample.wav"
    identity_reference.parent.mkdir(parents=True)
    character_reference.parent.mkdir(parents=True, exist_ok=True)
    identity_reference.write_bytes(b"identity")
    character_reference.write_bytes(b"character")

    generator = _FakeGenerator()
    result = await generate_seedance2_dialogue_audio(
        beat={"speaker": "谢铮_幼年时期", "narration_segment": "你终于来了。"},
        episode=1,
        beat_num=3,
        store=_FakeStore(project_dir, _characters()),
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.success is True
    assert generator.calls == [
        {
            "prompt": "你终于来了。",
            "audio_url": "data://幼年时期_voice.wav",
            "output_path": str(project_dir / "audio" / "ep001" / "beat_03.mp3"),
            "emotion_prompt": "",
        }
    ]
    assert (project_dir / "audio" / "ep001" / "beat_03.mp3").read_bytes() == b"beat-audio"


@pytest.mark.asyncio
async def test_seedance2_voice_clone_sends_only_spoken_text_to_fal(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import generate_seedance2_dialogue_audio

    project_dir = tmp_path / "project"
    identity_reference = (
        project_dir
        / "assets"
        / "characters"
        / "谢铮"
        / "identities"
        / "幼年时期_voice.wav"
    )
    identity_reference.parent.mkdir(parents=True)
    identity_reference.write_bytes(b"identity")

    generator = _FakeGenerator()
    result = await generate_seedance2_dialogue_audio(
        beat={
            "speaker": "谢铮_幼年时期",
            "narration_segment": "谢铮压低声音说：“你终于来了。”",
        },
        episode=1,
        beat_num=3,
        store=_FakeStore(project_dir, _characters()),
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.success is True
    assert generator.calls[0]["prompt"] == "你终于来了。"
    assert generator.calls[0]["emotion_prompt"] == "谢铮压低声音说"


@pytest.mark.asyncio
async def test_seedance2_voice_clone_falls_back_to_character_default(tmp_path):
    """L3: 当变体没有覆盖、没有匹配的时期预设时，应使用角色默认声线。"""
    from novelvideo.models import CharacterIdentity, NovelCharacter
    from novelvideo.seedance2_i2v.voice_clone import generate_seedance2_dialogue_audio

    project_dir = tmp_path / "project"
    character_reference = project_dir / "assets" / "characters" / "谢铮" / "voice_sample.wav"
    character_reference.parent.mkdir(parents=True)
    character_reference.write_bytes(b"character")
    character = NovelCharacter(
        name="谢铮",
        gender="男",
        reference_audio_path="assets/characters/谢铮/voice_sample.wav",
    )
    character.identities = [
        CharacterIdentity(
            identity_id="谢铮_幼年时期",
            character_name="谢铮",
            identity_name="幼年时期",
            reference_audio_path="",
        )
    ]
    generator = _FakeGenerator()

    result = await generate_seedance2_dialogue_audio(
        beat={"speaker": "谢铮_幼年时期", "narration_segment": "你终于来了。"},
        episode=1,
        beat_num=3,
        store=_FakeStore(project_dir, [character]),
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result is not None and result.success
    assert generator.calls and generator.calls[0]["audio_url"].endswith("voice_sample.wav")


@pytest.mark.asyncio
async def test_seedance2_voice_clone_loads_default_identity_voice_file_when_path_not_persisted(
    tmp_path,
):
    from novelvideo.models import CharacterIdentity, NovelCharacter
    from novelvideo.seedance2_i2v.voice_clone import generate_seedance2_dialogue_audio

    project_dir = tmp_path / "project"
    identity_reference = (
        project_dir
        / "assets"
        / "characters"
        / "谢铮"
        / "identities"
        / "幼年时期_voice.mp3"
    )
    identity_reference.parent.mkdir(parents=True)
    identity_reference.write_bytes(b"identity")
    character = NovelCharacter(name="谢铮", gender="男")
    character.identities = [
        CharacterIdentity(
            identity_id="谢铮_幼年时期",
            character_name="谢铮",
            identity_name="幼年时期",
            reference_audio_path="",
        )
    ]
    generator = _FakeGenerator()

    result = await generate_seedance2_dialogue_audio(
        beat={"speaker": "谢铮_幼年时期", "narration_segment": "你终于来了。"},
        episode=1,
        beat_num=3,
        store=_FakeStore(project_dir, [character]),
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.success is True
    assert generator.calls[0]["audio_url"] == "data://幼年时期_voice.mp3"


@pytest.mark.asyncio
async def test_seedance2_voice_clone_uses_age_group_preset(tmp_path):
    """L2: 当变体有 age_group 且角色有对应时期声线时，应使用该声线（非角色默认）。"""
    from novelvideo.models import CharacterIdentity, NovelCharacter
    from novelvideo.seedance2_i2v.voice_clone import generate_seedance2_dialogue_audio

    project_dir = tmp_path / "project"
    default_audio = project_dir / "audio" / "default.wav"
    elder_audio = project_dir / "audio" / "elder.wav"
    default_audio.parent.mkdir(parents=True)
    default_audio.write_bytes(b"default")
    elder_audio.write_bytes(b"elder")

    character = NovelCharacter(
        name="男主",
        gender="男",
        age_group="youth",
        reference_audio_path="audio/default.wav",
        voice_samples_by_age_group={
            "elder": {"path": "audio/elder.wav", "sha256": "", "updated_at": ""},
        },
    )
    character.identities = [
        CharacterIdentity(
            identity_id="男主_老年时期",
            character_name="男主",
            identity_name="老年时期",
            age_group="elder",
        )
    ]
    generator = _FakeGenerator()

    result = await generate_seedance2_dialogue_audio(
        beat={"speaker": "男主_老年时期", "narration_segment": "我老了。"},
        episode=1,
        beat_num=1,
        store=_FakeStore(project_dir, [character]),
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result is not None and result.success
    assert generator.calls[0]["audio_url"] == "data://elder.wav"


@pytest.mark.asyncio
async def test_seedance2_voice_clone_styling_variant_uses_character_default(tmp_path):
    """无 age_group 的造型变体（总裁/家居）应共用角色默认声线。"""
    from novelvideo.models import CharacterIdentity, NovelCharacter
    from novelvideo.seedance2_i2v.voice_clone import generate_seedance2_dialogue_audio

    project_dir = tmp_path / "project"
    default_audio = project_dir / "audio" / "default.wav"
    default_audio.parent.mkdir(parents=True)
    default_audio.write_bytes(b"default")

    character = NovelCharacter(
        name="男主",
        gender="男",
        age_group="youth",
        reference_audio_path="audio/default.wav",
    )
    character.identities = [
        CharacterIdentity(
            identity_id="男主_总裁时期",
            character_name="男主",
            identity_name="总裁时期",
        )
    ]
    generator = _FakeGenerator()

    result = await generate_seedance2_dialogue_audio(
        beat={"speaker": "男主_总裁时期", "narration_segment": "签字。"},
        episode=1,
        beat_num=1,
        store=_FakeStore(project_dir, [character]),
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result is not None and result.success
    assert generator.calls[0]["audio_url"] == "data://default.wav"


@pytest.mark.asyncio
async def test_seedance2_voice_clone_returns_none_for_narration_beat(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import generate_seedance2_dialogue_audio

    result = await generate_seedance2_dialogue_audio(
        beat={"audio_type": "narration", "speaker": "", "narration_segment": "旁白"},
        episode=1,
        beat_num=1,
        store=_FakeStore(tmp_path, _characters()),
        generator=_FakeGenerator(),
        audio_url_builder=lambda path: "data://unused",
    )

    assert result is None


def test_seedance2_same_voice_beats_group_by_identity_speaker():
    from novelvideo.seedance2_i2v.voice_clone import same_voice_dialogue_beats

    beats = [
        {
            "beat_number": 1,
            "audio_type": "dialogue",
            "speaker": "谢铮_幼年时期",
            "narration_segment": "你终于来了。",
        },
        {
            "beat_number": 2,
            "audio_type": "dialogue",
            "speaker": "谢铮_幼年时期",
            "narration_segment": "我们快走。",
        },
        {
            "beat_number": 3,
            "audio_type": "dialogue",
            "speaker": "谢铮_成年时期",
            "narration_segment": "别回头。",
        },
        {
            "beat_number": 4,
            "audio_type": "narration",
            "speaker": "谢铮_幼年时期",
            "narration_segment": "旁白。",
        },
    ]

    grouped = same_voice_dialogue_beats(beats, "谢铮_幼年时期")

    assert [beat_num for beat_num, _beat in grouped] == [1, 2]


@pytest.mark.asyncio
async def test_seedance2_voice_batch_generates_only_missing_same_identity_beats(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import (
        beat_audio_path,
        generate_seedance2_dialogue_audio_for_voice,
    )

    project_dir = tmp_path / "project"
    identity_reference = (
        project_dir
        / "assets"
        / "characters"
        / "谢铮"
        / "identities"
        / "幼年时期_voice.wav"
    )
    identity_reference.parent.mkdir(parents=True)
    identity_reference.write_bytes(b"identity")
    existing_audio = beat_audio_path(project_dir, 1, 1)
    existing_audio.parent.mkdir(parents=True)
    existing_audio.write_bytes(b"existing")

    beats = [
        {
            "beat_number": 1,
            "audio_type": "dialogue",
            "speaker": "谢铮_幼年时期",
            "narration_segment": "你终于来了。",
        },
        {
            "beat_number": 2,
            "audio_type": "dialogue",
            "speaker": "谢铮_幼年时期",
            "narration_segment": "我们快走。",
        },
        {
            "beat_number": 3,
            "audio_type": "dialogue",
            "speaker": "谢铮_成年时期",
            "narration_segment": "别回头。",
        },
    ]

    generator = _FakeGenerator()
    result = await generate_seedance2_dialogue_audio_for_voice(
        beats=beats,
        speaker="谢铮_幼年时期",
        episode=1,
        store=_FakeStore(project_dir, _characters()),
        generator=generator,
        audio_url_builder=lambda path: f"data://{Path(path).name}",
    )

    assert result.total == 2
    assert result.generated == 1
    assert result.skipped_existing == 1
    assert result.failed == []
    assert [call["prompt"] for call in generator.calls] == ["我们快走。"]
    assert existing_audio.read_bytes() == b"existing"
    assert beat_audio_path(project_dir, 1, 2).read_bytes() == b"beat-audio"


def _protagonist_characters(project_dir: Path, *, with_identity_audio: bool = True):
    from novelvideo.models import CharacterIdentity, NovelCharacter

    identity = CharacterIdentity(
        identity_id="林思望_常装",
        character_name="林思望",
        identity_name="常装",
        reference_audio_path="assets/characters/林思望/identities/常装_voice.wav",
    )
    if with_identity_audio:
        audio_path = project_dir / identity.reference_audio_path
        audio_path.parent.mkdir(parents=True, exist_ok=True)
        audio_path.write_bytes(b"protagonist-voice")
    protagonist = NovelCharacter(name="林思望", gender="男", is_main=True)
    protagonist.identities = [identity]
    supporting = NovelCharacter(name="苏曼", gender="女", is_main=False)
    return [supporting, protagonist]


def test_resolve_narrator_source_first_person_uses_narrator_main_identity(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import resolve_narrator_source

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    store = _FakeStore(project_dir, _protagonist_characters(project_dir))

    resolution = resolve_narrator_source(
        store=store,
        narration_style="first_person",
        project_narrator_stored_path="",
    )

    assert resolution.style == "first_person"
    assert resolution.source == "protagonist_identity"
    assert resolution.character_name == "林思望"
    assert resolution.identity_id == "林思望_常装"
    assert resolution.audio_path is not None and resolution.audio_path.exists()
    assert resolution.sha256
    assert resolution.error == ""


def test_resolve_narrator_source_first_person_missing_narrator_main_audio(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import resolve_narrator_source

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    store = _FakeStore(
        project_dir,
        _protagonist_characters(project_dir, with_identity_audio=False),
    )

    resolution = resolve_narrator_source(
        store=store,
        narration_style="first_person",
        project_narrator_stored_path="",
    )

    assert resolution.audio_path is None
    assert resolution.sha256 == ""
    assert "解说主角声线缺失" in resolution.error


def test_resolve_narrator_source_first_person_falls_back_to_character_default(tmp_path):
    """L3 fallback: identity has no voice but the character-level default is set."""
    from novelvideo.models import CharacterIdentity, NovelCharacter
    from novelvideo.seedance2_i2v.voice_clone import resolve_narrator_source

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    default_audio = project_dir / "assets" / "characters" / "陆辰" / "voices" / "voice_default.mp3"
    default_audio.parent.mkdir(parents=True, exist_ok=True)
    default_audio.write_bytes(b"character-default-voice")

    identity = CharacterIdentity(
        identity_id="陆辰_书店老板时期",
        character_name="陆辰",
        identity_name="书店老板时期",
        age_group="youth",
        reference_audio_path="",
    )
    protagonist = NovelCharacter(
        name="陆辰",
        gender="男",
        is_main=True,
        reference_audio_path="assets/characters/陆辰/voices/voice_default.mp3",
    )
    protagonist.identities = [identity]

    store = _FakeStore(project_dir, [protagonist])

    resolution = resolve_narrator_source(
        store=store,
        narration_style="first_person",
        project_narrator_stored_path="",
    )

    assert resolution.audio_path == default_audio
    assert resolution.sha256
    assert resolution.error == ""
    assert resolution.character_name == "陆辰"
    assert resolution.identity_name == "书店老板时期"


def test_resolve_narrator_source_first_person_missing_narrator_main(tmp_path):
    from novelvideo.models import NovelCharacter
    from novelvideo.seedance2_i2v.voice_clone import resolve_narrator_source

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    store = _FakeStore(project_dir, [NovelCharacter(name="苏曼", gender="女", is_main=False)])

    resolution = resolve_narrator_source(
        store=store,
        narration_style="first_person",
        project_narrator_stored_path="",
    )

    assert resolution.audio_path is None
    assert "未找到解说主角" in resolution.error


def test_resolve_narrator_source_third_person_uses_project_narrator(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import resolve_narrator_source

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    narrator_audio = project_dir / "assets" / "narrator" / "voice.wav"
    narrator_audio.parent.mkdir(parents=True, exist_ok=True)
    narrator_audio.write_bytes(b"project-narrator")
    store = _FakeStore(project_dir, _protagonist_characters(project_dir))

    resolution = resolve_narrator_source(
        store=store,
        narration_style="third_person",
        project_narrator_stored_path="assets/narrator/voice.wav",
    )

    assert resolution.style == "third_person"
    assert resolution.source == "project_narrator"
    assert resolution.audio_path == narrator_audio
    assert resolution.sha256
    assert resolution.character_name == ""


def test_resolve_narrator_source_third_person_reports_unconfigured_voice(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import resolve_narrator_source

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    store = _FakeStore(project_dir, [])

    resolution = resolve_narrator_source(
        store=store,
        narration_style="third_person",
        project_narrator_stored_path="",
    )

    assert resolution.audio_path is None
    assert resolution.error == "项目解说人声线未配置，请上传或录制解说人音频"


def test_resolve_narrator_source_third_person_reports_missing_configured_file(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import resolve_narrator_source

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    store = _FakeStore(project_dir, [])

    resolution = resolve_narrator_source(
        store=store,
        narration_style="third_person",
        project_narrator_stored_path="assets/narrator/voice.wav",
    )

    assert resolution.audio_path is None
    assert resolution.error == (
        "项目解说人声线已配置，但声线文件无法读取，请重新上传或检查项目存储"
    )


def test_resolve_narrator_source_third_person_rejects_configured_directory(tmp_path):
    from novelvideo.seedance2_i2v.voice_clone import resolve_narrator_source

    project_dir = tmp_path / "proj"
    narrator_directory = project_dir / "assets" / "narrator" / "voice.wav"
    narrator_directory.mkdir(parents=True)
    store = _FakeStore(project_dir, [])

    resolution = resolve_narrator_source(
        store=store,
        narration_style="third_person",
        project_narrator_stored_path="assets/narrator/voice.wav",
    )

    assert resolution.audio_path is None
    assert "声线文件无法读取" in resolution.error


def test_resolve_narrator_source_third_person_reports_hash_read_failure(
    tmp_path, monkeypatch
):
    import novelvideo.seedance2_i2v.voice_clone as voice_clone

    project_dir = tmp_path / "proj"
    narrator_audio = project_dir / "assets" / "narrator" / "voice.wav"
    narrator_audio.parent.mkdir(parents=True)
    narrator_audio.write_bytes(b"project-narrator")
    store = _FakeStore(project_dir, [])

    def fail_to_read(_path):
        raise PermissionError("denied")

    monkeypatch.setattr(voice_clone, "file_sha256", fail_to_read)

    resolution = voice_clone.resolve_narrator_source(
        store=store,
        narration_style="third_person",
        project_narrator_stored_path="assets/narrator/voice.wav",
    )

    assert resolution.audio_path is None
    assert "声线文件无法读取" in resolution.error

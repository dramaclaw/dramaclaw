from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
import respx
from httpx import Response

from novelvideo import config
from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.freezone import audio_node
from novelvideo.freezone.audio_node import (
    USER_VOICE_SCOPE,
    create_user_audio_voice,
    freezone_audio_eleven_music_output_path,
    freezone_audio_speech_output_path,
    list_user_audio_voices,
    resolve_user_audio_voice,
    user_audio_voices_index_path,
)
from novelvideo.model_gateway_settings import save_custom_newapi_gateway


class FakeTTSGenerator:
    calls = []

    async def generate(self, *, prompt, audio_url, output_path, emotion_prompt=""):
        from novelvideo.generators.tts_generator import TTSResult

        self.__class__.calls.append(
            {
                "prompt": prompt,
                "audio_url": audio_url,
                "output_path": Path(output_path),
                "emotion_prompt": emotion_prompt,
            }
        )
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"generated-audio")
        return TTSResult(success=True, audio_path=str(output_path), duration_seconds=1.25)


def _isolate_settings_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("MODEL_GATEWAY_MODE", raising=False)


class FakeProjectStore:
    def __init__(self, project_dir: Path):
        self.project_dir = str(project_dir)

    async def list_characters(self):
        from novelvideo.models import CharacterIdentity, NovelCharacter

        reference = (
            Path(self.project_dir)
            / "assets"
            / "characters"
            / "陆辰"
            / "identities"
            / "青年_voice.wav"
        )
        reference.parent.mkdir(parents=True, exist_ok=True)
        reference.write_bytes(b"main-character-reference")
        character = NovelCharacter(name="陆辰", gender="男", is_main=True)
        character.identities = [
            CharacterIdentity(
                identity_id="陆辰_青年",
                character_name="陆辰",
                identity_name="青年",
                reference_audio_path="assets/characters/陆辰/identities/青年_voice.wav",
                reference_audio_sha256="main-character-hash",
            )
        ]
        return [character]


def test_user_audio_voice_is_account_scoped_and_resolvable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(audio_node, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(audio_node, "_duration_ms", lambda _path: 1234)

    created = create_user_audio_voice(
        username="admin",
        name="  我的音色  ",
        filename="sample.mp3",
        content=b"fake-audio-bytes",
        mime_type="audio/mpeg",
    )

    assert created["scope"] == USER_VOICE_SCOPE
    assert created["voice_id"].startswith("fv_")
    assert created["name"] == "我的音色"
    assert created["duration_ms"] == 1234
    assert created["exists"] is True
    assert created["path"].startswith("_account/freezone/audio/voices/")
    assert "voices" in user_audio_voices_index_path("admin").read_text(encoding="utf-8")

    listed = list_user_audio_voices("admin")
    assert [item["voice_id"] for item in listed] == [created["voice_id"]]

    resolved = resolve_user_audio_voice("admin", created["voice_id"])
    assert resolved.source == USER_VOICE_SCOPE
    assert resolved.audio_path.exists()
    assert resolved.audio_path.read_bytes() == b"fake-audio-bytes"
    assert len(resolved.sha256) == 64


@pytest.mark.asyncio
async def test_newapi_audio_uses_saved_custom_gateway_before_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_API_KEY", "sk-env-secret")
    monkeypatch.setenv("NEWAPI_BASE_URL", "https://env.example/v1")
    save_custom_newapi_gateway(
        base_url="https://custom.example",
        api_key="sk-custom-secret",
        activate=True,
    )

    with respx.mock(assert_all_called=True) as router:
        route = router.post("https://custom.example/v1/audio/speech").mock(
            return_value=Response(
                200,
                content=b"audio-bytes",
                headers={"content-type": "audio/mpeg"},
            )
        )

        output_path = tmp_path / "audio.mp3"
        await audio_node._write_newapi_audio_speech(
            output_path=output_path,
            model="LingShan-MU-11",
            input_text="quiet piano",
        )

    assert output_path.read_bytes() == b"audio-bytes"
    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer sk-custom-secret"


def test_create_user_audio_voice_rejects_unsupported_extension(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(audio_node, "OUTPUT_DIR", str(tmp_path))

    with pytest.raises(ValueError, match="unsupported voice audio format"):
        create_user_audio_voice(
            username="admin",
            name="bad",
            filename="sample.txt",
            content=b"fake-audio-bytes",
        )


def test_freezone_audio_ref_payload_never_trusts_external_paths(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    external = tmp_path / "outside.mp3"
    external.write_bytes(b"audio")

    payload = freezone_routes._freezone_audio_ref_payload(
        username="admin",
        project="demo",
        project_id="proj_demo",
        project_dir=project_dir,
        scope="identity",
        label="身份声线",
        path=str(external),
        identity_id="林小满_青年",
    )

    assert payload["path"] == str(external)
    assert payload["url"] == ""
    assert payload["exists"] is False
    assert payload["identity_id"] == "林小满_青年"


def test_freezone_audio_ref_payload_builds_project_static_url(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    audio = project_dir / "assets" / "characters" / "林小满" / "voices" / "voice_default.mp3"
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"audio")

    payload = freezone_routes._freezone_audio_ref_payload(
        username="admin",
        project="demo",
        project_id="proj_demo",
        project_dir=project_dir,
        scope="character_default",
        label="林小满 · 默认声线",
        path="assets/characters/林小满/voices/voice_default.mp3",
        character_name="林小满",
        slot="default",
    )

    assert payload["exists"] is True
    assert payload["url"].startswith(
        "/static/projects/proj_demo/assets/characters/%E6%9E%97%E5%B0%8F%E6%BB%A1/voices/voice_default.mp3"
    )
    assert payload["character_name"] == "林小满"
    assert payload["slot"] == "default"


@pytest.mark.asyncio
async def test_freezone_audio_references_use_requester_account_voices(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    seen_usernames: list[str] = []

    ctx = SimpleNamespace(
        project_id="proj_demo",
        owner_username="owner",
        project_name="demo",
        requester_username="viewer",
    )

    async def fake_resolve(*_args, **_kwargs):
        return ctx, "owner", "demo", tmp_path, str(tmp_path)

    class Store:
        async def list_characters(self):
            return []

    async def fake_store(_ctx):
        return Store()

    def fake_list_user_audio_voices(username: str):
        seen_usernames.append(username)
        return [
            {
                "scope": USER_VOICE_SCOPE,
                "voice_id": "fv_viewer",
                "label": "Viewer Voice",
                "path": "_account/freezone/audio/voices/fv_viewer.mp3",
                "exists": True,
            }
        ]

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone_routes, "make_sqlite_store_for_context", fake_store)
    monkeypatch.setattr(freezone_routes, "list_user_audio_voices", fake_list_user_audio_voices)
    monkeypatch.setattr(
        freezone_routes,
        "load_narrator_reference_audio",
        lambda *_args, **_kwargs: {},
    )
    monkeypatch.setattr(
        freezone_routes,
        "load_effective_narration_style_for_voice",
        lambda *_args, **_kwargs: {},
    )

    result = await freezone_routes.freezone_audio_references(
        "proj_demo",
        user={"username": "viewer"},
    )

    assert seen_usernames == ["viewer"]
    assert result["data"]["user_voices"][0]["url"] == (
        "/api/v1/projects/proj_demo/freezone/audio/voices/fv_viewer/media"
    )


@pytest.mark.asyncio
async def test_user_custom_voice_generation_uses_requester_account(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    seen: list[tuple[str, str]] = []

    def fake_resolve_user_audio_voice(username: str, voice_id: str):
        seen.append((username, voice_id))
        return audio_node.FreezoneVoiceRefResolution(
            tmp_path / "viewer_voice.mp3",
            "sha",
            USER_VOICE_SCOPE,
        )

    monkeypatch.setattr(audio_node, "resolve_user_audio_voice", fake_resolve_user_audio_voice)

    resolved = await audio_node._resolve_voice_ref(
        store=SimpleNamespace(),
        username="owner",
        account_voice_username="viewer",
        project_dir=tmp_path,
        voice_ref={"scope": USER_VOICE_SCOPE, "voice_id": "fv_viewer"},
    )

    assert seen == [("viewer", "fv_viewer")]
    assert resolved is not None
    assert resolved.source == USER_VOICE_SCOPE


@pytest.mark.asyncio
async def test_freezone_audio_speech_drama_first_person_uses_project_narrator(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.project_config import set_narrator_reference_audio, update_project_config_file
    from novelvideo.seedance2_i2v.voice_clone import file_sha256

    project_dir = tmp_path / "output" / "alice" / "demo"
    narrator = project_dir / "assets" / "narrator" / "voice.wav"
    narrator.parent.mkdir(parents=True, exist_ok=True)
    narrator.write_bytes(b"project-narrator-reference")
    narrator_sha = file_sha256(narrator)
    monkeypatch.setattr("novelvideo.project_config.OUTPUT_DIR", tmp_path / "state")
    monkeypatch.setattr(audio_node, "IndexTTS2FalClient", FakeTTSGenerator)
    monkeypatch.setattr(
        audio_node,
        "build_reference_audio_url",
        lambda path: f"data://{Path(path).name}",
    )
    FakeTTSGenerator.calls = []
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

    result = await audio_node.generate_freezone_audio_speech(
        store=FakeProjectStore(project_dir),
        username="alice",
        project="demo",
        project_dir=project_dir,
        job_id="job-1",
        text="画外音响起。",
    )

    assert result.voice_source == "project_narrator"
    assert result.voice_sha256 == narrator_sha
    assert FakeTTSGenerator.calls == [
        {
            "prompt": "画外音响起。",
            "audio_url": "data://voice.wav",
            "output_path": freezone_audio_speech_output_path(project_dir, "job-1"),
            "emotion_prompt": "以第三人称旁白视角，用客观冷静的解说语气朗读",
        }
    ]


@pytest.mark.asyncio
async def test_freezone_audio_eleven_music_uses_newapi_music_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict] = []

    async def fake_write_newapi_audio_speech(**kwargs):
        calls.append(kwargs)
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"music")

    monkeypatch.setattr(audio_node, "_write_newapi_audio_speech", fake_write_newapi_audio_speech)
    monkeypatch.setattr(audio_node, "_duration_ms", lambda _path: 0)

    result = await audio_node.generate_freezone_audio_eleven_music(
        project_dir=tmp_path,
        job_id="music-1",
        prompt="Mysterious original soundtrack, rainforest.",
        music_length_ms=30_000,
        force_instrumental=True,
        respect_sections_durations=True,
        output_format="mp3_44100_128",
    )

    assert result.model == "LingShan-MU-11"
    assert result.duration_ms == 30_000
    assert result.voice_source == "LingShan-MU-11"
    assert calls == [
        {
            "output_path": freezone_audio_eleven_music_output_path(tmp_path, "music-1"),
            "model": "LingShan-MU-11",
            "input_text": "Mysterious original soundtrack, rainforest.",
            "response_format": "mp3",
            "metadata": {
                "music_length_ms": 30_000,
                "force_instrumental": True,
                "respect_sections_durations": True,
                "output_format": "mp3_44100_128",
            },
            "timeout_seconds": 900.0,
        }
    ]


@pytest.mark.asyncio
async def test_freezone_audio_eleven_music_rejects_out_of_range_length(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="music_length_ms"):
        await audio_node.generate_freezone_audio_eleven_music(
            project_dir=tmp_path,
            job_id="music-short",
            prompt="short sting",
            music_length_ms=2999,
        )

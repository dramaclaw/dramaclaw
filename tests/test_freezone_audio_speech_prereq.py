from __future__ import annotations

import json
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


def _project_context(tmp_path: Path) -> SimpleNamespace:
    return SimpleNamespace(
        project_id="proj",
        owner_username="owner",
        project_name="demo",
        requester_username="viewer",
        output_dir=str(tmp_path),
    )


@pytest.mark.asyncio
async def test_missing_voice_returns_409_without_allocating_or_enqueuing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.api.schemas import FreezoneAudioSpeechRequest
    from novelvideo.freezone.audio_node import VoicePrerequisiteError

    calls = {"job": 0, "enqueue": 0}
    ctx = _project_context(tmp_path)
    store = SimpleNamespace(close=AsyncMock())

    async def fake_resolve_project(*_args, **_kwargs):
        return ctx, "owner", "demo", tmp_path, str(tmp_path)

    async def missing_voice(**_kwargs):
        raise VoicePrerequisiteError("项目解说人声线未配置，请上传或录制解说人音频")

    def allocate_job() -> str:
        calls["job"] += 1
        return "job-1"

    async def enqueue(**_kwargs):
        calls["enqueue"] += 1
        return {"ok": True}

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve_project)
    monkeypatch.setattr(
        freezone,
        "make_sqlite_store_for_context",
        AsyncMock(return_value=store),
    )
    monkeypatch.setattr(freezone, "resolve_speech_voice", missing_voice, raising=False)
    monkeypatch.setattr(freezone, "_new_job_id", allocate_job)
    monkeypatch.setattr(freezone, "_enqueue_freezone_background_job", enqueue)

    response = await freezone.freezone_audio_speech(
        "proj",
        FreezoneAudioSpeechRequest(text="旁白"),
        user={"username": "viewer"},
    )

    assert response.status_code == 409
    assert json.loads(response.body) == {
        "ok": False,
        "code": "voice_prereq_required",
        "error": "项目解说人声线未配置，请上传或录制解说人音频",
    }
    assert calls == {"job": 0, "enqueue": 0}
    store.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_valid_voice_is_resolved_before_job_allocation_and_enqueue(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.api.schemas import FreezoneAudioSpeechRequest, FreezoneAudioVoiceRef
    from novelvideo.freezone.audio_node import FreezoneVoiceRefResolution

    events: list[str] = []
    ctx = _project_context(tmp_path)
    store = SimpleNamespace(close=AsyncMock())
    resolution = (
        "third_person",
        FreezoneVoiceRefResolution(tmp_path / "voice.wav", "sha", "user_custom"),
    )

    async def fake_resolve_project(*_args, **_kwargs):
        return ctx, "owner", "demo", tmp_path, str(tmp_path)

    async def resolve_voice(**_kwargs):
        events.append("resolve")
        return resolution

    def allocate_job() -> str:
        events.append("allocate")
        return "job-1"

    async def enqueue(**kwargs):
        events.append("enqueue")
        return {"ok": True, "payload": kwargs["payload"]}

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve_project)
    monkeypatch.setattr(
        freezone,
        "make_sqlite_store_for_context",
        AsyncMock(return_value=store),
    )
    monkeypatch.setattr(freezone, "resolve_speech_voice", resolve_voice, raising=False)
    monkeypatch.setattr(freezone, "_new_job_id", allocate_job)
    monkeypatch.setattr(freezone, "_enqueue_freezone_background_job", enqueue)

    result = await freezone.freezone_audio_speech(
        "proj",
        FreezoneAudioSpeechRequest(
            text="旁白",
            voice_ref=FreezoneAudioVoiceRef(scope="user_custom", voice_id="fv_viewer"),
        ),
        user={"username": "viewer"},
    )

    assert events == ["resolve", "allocate", "enqueue"]
    assert result["payload"]["voice_ref"] == {
        "scope": "user_custom",
        "character_name": "",
        "identity_id": "",
        "slot": "",
        "voice_id": "fv_viewer",
    }
    store.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_explicit_voice_directory_is_a_structured_prerequisite_error(
    tmp_path: Path,
) -> None:
    from novelvideo.freezone.audio_node import (
        VoicePrerequisiteError,
        resolve_speech_voice,
    )

    voice_directory = tmp_path / "voice-directory"
    voice_directory.mkdir()
    character = SimpleNamespace(
        name="主角",
        reference_audio_path=voice_directory.name,
        reference_audio_sha256="",
    )
    store = SimpleNamespace(
        state_dir=tmp_path,
        list_characters=AsyncMock(return_value=[character]),
    )

    with pytest.raises(VoicePrerequisiteError, match="角色默认声线不可用"):
        await resolve_speech_voice(
            store=store,
            username="owner",
            project="demo",
            project_dir=tmp_path,
            voice_ref={"scope": "character_default", "character_name": "主角"},
        )


@pytest.mark.asyncio
async def test_explicit_voice_read_error_is_a_structured_prerequisite_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.freezone import audio_node

    voice_file = tmp_path / "voice.wav"
    voice_file.write_bytes(b"voice")
    character = SimpleNamespace(
        name="主角",
        reference_audio_path=voice_file.name,
        reference_audio_sha256="",
    )
    store = SimpleNamespace(
        state_dir=tmp_path,
        list_characters=AsyncMock(return_value=[character]),
    )

    leaked_path = tmp_path / "private" / "voice.wav"

    def unreadable(_path: Path) -> str:
        raise PermissionError(f"permission denied: {leaked_path}")

    monkeypatch.setattr(audio_node, "file_sha256", unreadable)

    with pytest.raises(audio_node.VoicePrerequisiteError) as exc_info:
        await audio_node.resolve_speech_voice(
            store=store,
            username="owner",
            project="demo",
            project_dir=tmp_path,
            voice_ref={"scope": "character_default", "character_name": "主角"},
        )

    assert str(exc_info.value) == "声线文件无法读取，请重新选择或检查文件是否完整"
    assert str(leaked_path) not in str(exc_info.value)


@pytest.mark.asyncio
async def test_user_custom_directory_is_rejected_off_the_event_loop_thread(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.freezone import audio_node

    monkeypatch.setattr(audio_node, "OUTPUT_DIR", str(tmp_path))
    voice_id = "fv_directory"
    relative_path = "_account/freezone/audio/voices/fv_directory/reference.wav"
    voice_directory = tmp_path / "viewer" / relative_path
    voice_directory.mkdir(parents=True)
    audio_node._write_user_voice_records(
        "viewer",
        [{"voice_id": voice_id, "path": relative_path, "sha256": "recorded-sha"}],
    )

    event_loop_thread = threading.get_ident()
    resolver_threads: list[int] = []
    original_resolver = audio_node.resolve_user_audio_voice

    def tracked_resolver(username: str, selected_voice_id: str):
        resolver_threads.append(threading.get_ident())
        return original_resolver(username, selected_voice_id)

    monkeypatch.setattr(audio_node, "resolve_user_audio_voice", tracked_resolver)
    store = SimpleNamespace(state_dir=tmp_path, list_characters=AsyncMock())

    with pytest.raises(audio_node.VoicePrerequisiteError, match="用户音色文件不存在"):
        await audio_node.resolve_speech_voice(
            store=store,
            username="viewer",
            project="demo",
            project_dir=tmp_path,
            voice_ref={"scope": "user_custom", "voice_id": voice_id},
        )

    assert resolver_threads
    assert all(thread_id != event_loop_thread for thread_id in resolver_threads)

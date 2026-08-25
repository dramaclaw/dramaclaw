from __future__ import annotations

import json
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

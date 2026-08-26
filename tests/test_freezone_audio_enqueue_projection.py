"""Freezone speech pins its project-state inputs at enqueue time.

Two assertions carry equal weight.  With a projector installed the enqueued
payload gains the ``projection`` envelope and the worker needs nothing from the
project database; with none installed the payload is exactly the payload this
route has always produced -- same keys, and no store opened either.  The second
one is the rollback, so "looks the same" is not enough for it.

The projection also has to stay small: only the one or two character rows the
resolution actually consults travel with the task, never the whole table.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.schemas import FreezoneAudioSpeechRequest, FreezoneAudioVoiceRef
from novelvideo.models import NovelCharacter

TASK_TYPE = "freezone_audio_speech"


def _character(name: str, *, is_main: bool = False, description: str = "") -> NovelCharacter:
    return NovelCharacter(
        name=name,
        is_main=is_main,
        description=description,
        reference_audio_path=f"assets/voices/{name}.wav",
        reference_audio_sha256=f"sha-{name}",
    )


class _FakeCharacterStore:
    """Stands in for the project SQLite store on the enqueue side."""

    def __init__(self, characters) -> None:
        self.state_dir = "/state/alice/demo"
        self.project_dir = "/output/alice/demo"
        self._characters = list(characters)
        self.list_characters_calls = 0

    async def list_characters(self):
        self.list_characters_calls += 1
        return list(self._characters)

    async def close(self) -> None:
        return None


class _RealProjector:
    """Stands in for the projector a non-inline deployment installs."""

    async def build(self, store, config, *, task_type):
        from novelvideo.task_backend.projection import build_projection

        return await build_projection(store, config, task_type=task_type)


@pytest.fixture
def speech_harness(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from novelvideo.api.routes import freezone

    project_dir = tmp_path / "output" / "alice" / "demo"
    project_dir.mkdir(parents=True, exist_ok=True)
    payloads: list[dict] = []
    store = _FakeCharacterStore(
        [
            _character("小明"),
            _character("旁白主角", is_main=True),
            _character("路人甲"),
        ]
    )
    store.project_dir = str(project_dir)
    store.state_dir = str(tmp_path / "state" / "alice" / "demo")
    voice_path = project_dir / "assets" / "voices" / "小明.wav"
    voice_path.parent.mkdir(parents=True, exist_ok=True)
    voice_path.write_bytes(b"voice")
    ctx = SimpleNamespace(
        project_id="proj",
        project_name="demo",
        owner_username="alice",
        requester_username="bob",
        output_dir=str(project_dir),
    )

    async def fake_resolve(project, user, **kwargs):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    async def fake_enqueue(_ctx, **kwargs):
        payloads.append(kwargs["payload"])
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-1"), backend="inline", queue="default"
        )

    async def fake_store_for_context(_ctx):
        return store

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(
        freezone,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue),
    )
    monkeypatch.setattr(freezone, "make_sqlite_store_for_context", fake_store_for_context)
    monkeypatch.setattr(freezone, "_project_job_response", lambda **kwargs: {"ok": True})
    monkeypatch.setattr(
        "novelvideo.project_config.load_effective_narration_style_for_voice_from_state_dir",
        lambda state_dir: "first_person",
    )
    monkeypatch.setattr(
        "novelvideo.project_config.load_narrator_reference_audio_from_state_dir",
        lambda state_dir: {
            "path": "assets/voices/narrator.wav",
            "sha256": "sha-narrator",
            "updated_at": "2026-08-13T00:00:00+00:00",
        },
    )

    return SimpleNamespace(
        module=freezone, payloads=payloads, store=store, project_dir=project_dir
    )


@pytest.fixture
def projector_installed():
    from novelvideo.ports.registry import _PORTS, register_port

    register_port("task_projection", _RealProjector())
    yield
    _PORTS.pop("task_projection", None)


@pytest.fixture
def projector_absent():
    from novelvideo.ports.registry import _PORTS

    previous = _PORTS.pop("task_projection", None)
    yield
    if previous is not None:
        _PORTS["task_projection"] = previous


def _speech_body(**overrides) -> FreezoneAudioSpeechRequest:
    body = {
        "text": "旁白响起。",
        "voice_ref": FreezoneAudioVoiceRef(scope="character_default", character_name="小明"),
    }
    body.update(overrides)
    return FreezoneAudioSpeechRequest(**body)


async def _enqueue_speech(harness, **overrides) -> dict:
    await harness.module.freezone_audio_speech(
        project="proj", body=_speech_body(**overrides), user={"username": "bob"}
    )
    return harness.payloads[-1]


@pytest.mark.asyncio
async def test_speech_payload_gains_the_projection_when_installed(
    speech_harness, projector_installed
) -> None:
    payload = await _enqueue_speech(speech_harness)

    projection = payload["projection"]
    assert projection["task_type"] == TASK_TYPE
    fields = projection["fields"]
    assert fields["narration_style"] == "first_person"
    assert fields["narrator_reference_audio"]["path"] == "assets/voices/narrator.wav"
    assert fields["voice_character"]["name"] == "小明"
    assert fields["narrator_main_character"]["name"] == "旁白主角"


@pytest.mark.asyncio
async def test_speech_projection_carries_only_the_characters_actually_consulted(
    speech_harness, projector_installed
) -> None:
    """One named voice plus the narrator main -- never the whole character table."""
    payload = await _enqueue_speech(speech_harness)

    blob = json.dumps(payload["projection"], ensure_ascii=False)
    assert "路人甲" not in blob
    assert blob.count("小明") >= 1
    assert speech_harness.store.list_characters_calls == 2


@pytest.mark.asyncio
async def test_speech_payload_is_unchanged_when_no_projector_is_installed(
    speech_harness, projector_absent
) -> None:
    payload = await _enqueue_speech(speech_harness)

    assert "projection" not in payload
    assert set(payload) == {
        "job_id",
        "project_dir",
        "text",
        "emotion_prompt",
        "voice_ref",
        "account_voice_username",
        "target_episode",
        "target_beat",
        "billing",
    }
    # Even without a projector, the enqueue-side prerequisite check resolves
    # the selected voice once before allocating the job.
    assert speech_harness.store.list_characters_calls == 1


@pytest.mark.asyncio
async def test_oversized_speech_projection_raises_on_the_enqueue_side(
    speech_harness, projector_installed, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The size cap belongs to the machine that built the projection, not the worker."""
    from novelvideo.task_backend.projection import MAX_PROJECTION_BYTES

    speech_harness.store._characters = [
        _character("小明", description="x" * (MAX_PROJECTION_BYTES + 1024))
    ]

    with pytest.raises(ValueError, match="投射超出体积上限"):
        await _enqueue_speech(speech_harness)

    assert speech_harness.payloads == []


@pytest.mark.asyncio
async def test_inline_speech_path_builds_the_same_projection(
    speech_harness, projector_installed, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same-process path gets the projection too, not just the enqueue path."""
    freezone = speech_harness.module
    seen: dict = {}

    async def fake_store(username, project):
        return speech_harness.store

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        audio = speech_harness.project_dir / "outputs" / "job-inline.mp3"
        audio.parent.mkdir(parents=True, exist_ok=True)
        audio.write_bytes(b"audio")
        from novelvideo.freezone.audio_node import FreezoneAudioSpeechResult

        return FreezoneAudioSpeechResult(
            audio_path=audio,
            duration_ms=1000,
            mime_type="audio/mpeg",
            model="indextts2",
            voice_source="character_default",
            voice_sha256="sha-小明",
        )

    failures: list[str] = []

    class _FakeTaskManager:
        def create_task(self, *_a, **_k):
            return None

        def update_progress(self, *_a, **_k):
            return None

        def complete_task(self, *_a, **_k):
            return None

        def fail_task(self, *_a, **kwargs):
            failures.append(str(kwargs.get("error")))

    monkeypatch.setattr(freezone, "get_task_manager", lambda: _FakeTaskManager())
    monkeypatch.setattr(freezone, "make_sqlite_store", fake_store)
    monkeypatch.setattr(freezone, "generate_freezone_audio_speech", fake_generate)
    monkeypatch.setattr(freezone, "project_static_url", lambda *a, **k: "/static/x.mp3")

    freezone._start_freezone_audio_speech_task(
        username="alice",
        project="demo",
        account_voice_username="bob",
        project_id="proj",
        project_dir=speech_harness.project_dir,
        job_id="job-inline",
        body=_speech_body(),
    )
    for _ in range(200):
        await asyncio.sleep(0)
        if seen or failures:
            break

    assert failures == []
    projection = seen["projection"]
    assert projection is not None
    assert projection.task_type == TASK_TYPE
    assert projection.require("voice_character")["name"] == "小明"
    assert projection.require("narration_style") == "first_person"


@pytest.mark.asyncio
async def test_inline_speech_path_passes_no_projection_when_none_is_installed(
    speech_harness, projector_absent, monkeypatch: pytest.MonkeyPatch
) -> None:
    freezone = speech_harness.module
    seen: dict = {}

    async def fake_store(username, project):
        return speech_harness.store

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        audio = speech_harness.project_dir / "outputs" / "job-inline2.mp3"
        audio.parent.mkdir(parents=True, exist_ok=True)
        audio.write_bytes(b"audio")
        from novelvideo.freezone.audio_node import FreezoneAudioSpeechResult

        return FreezoneAudioSpeechResult(
            audio_path=audio,
            duration_ms=1000,
            mime_type="audio/mpeg",
            model="indextts2",
            voice_source="character_default",
            voice_sha256="sha",
        )

    class _FakeTaskManager:
        def create_task(self, *_a, **_k):
            return None

        def update_progress(self, *_a, **_k):
            return None

        def complete_task(self, *_a, **_k):
            return None

        def fail_task(self, *_a, **_k):
            return None

    monkeypatch.setattr(freezone, "get_task_manager", lambda: _FakeTaskManager())
    monkeypatch.setattr(freezone, "make_sqlite_store", fake_store)
    monkeypatch.setattr(freezone, "generate_freezone_audio_speech", fake_generate)
    monkeypatch.setattr(freezone, "project_static_url", lambda *a, **k: "/static/x.mp3")

    freezone._start_freezone_audio_speech_task(
        username="alice",
        project="demo",
        account_voice_username="bob",
        project_id="proj",
        project_dir=speech_harness.project_dir,
        job_id="job-inline2",
        body=_speech_body(),
    )
    for _ in range(200):
        await asyncio.sleep(0)
        if seen:
            break

    assert seen["projection"] is None
    assert seen["store"] is speech_harness.store

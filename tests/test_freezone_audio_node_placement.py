"""Speech synthesis runs from the payload projection, not from project state.

The inputs the voice resolution needs (narration style, the narrator reference
descriptor, and the one or two character rows actually consulted) are pinned
into ``payload["projection"]`` when the task is submitted.  A worker that gets
such a payload reads no project database and no project config file, which is
what lets the task run somewhere other than the machine holding that state.

The other half matters just as much: a payload without a projection behaves
exactly as it always has, reading project state on the spot.  That is the
rollback -- installing no projector leaves this file's behaviour untouched --
so it is asserted as its own case rather than assumed.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

from novelvideo.freezone import audio_node
from novelvideo.freezone.audio_node import USER_VOICE_SCOPE
from novelvideo.models import NovelCharacter
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.projection import (
    CURRENT_PROJECTION_VERSION,
    SUPPORTED_PROJECTION_VERSIONS,
    read_projection,
)

TASK_TYPE = "freezone_audio_speech"


class FakeTTSGenerator:
    calls: list[dict] = []

    def __init__(self, *_args, **_kwargs) -> None:
        pass

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
        return TTSResult(success=True, audio_path=str(output_path), duration_seconds=1.0)


class FakeCharacterStore:
    """只提供 `list_characters` 的项目 store 替身（对应真实的项目 SQLite）。"""

    def __init__(self, characters) -> None:
        self._characters = list(characters)
        self.list_characters_calls = 0

    async def list_characters(self):
        self.list_characters_calls += 1
        return list(self._characters)


class ExplodingStore:
    """任何一次访问都算失败 —— 用来证明「不再回头读项目 store」。"""

    def __getattr__(self, name: str):  # pragma: no cover - 触发即失败
        raise AssertionError(f"project store must not be touched, got .{name}")


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_audio_e2",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="alice",
        requester_user_id="user_editor",
        requester_username="bob",
        requester_principals=(("user", "user_editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "alice" / "demo",
        state_dir=tmp_path / "state" / "alice" / "demo",
        runtime_dir=tmp_path / "runtime" / "alice" / "demo",
        is_home_node=True,
    )


def _voice_file(project_dir: Path, name: str) -> Path:
    path = project_dir / "assets" / "voices" / f"{name}.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(f"{name}-reference-audio".encode())
    return path


def _character(name: str, *, is_main: bool = False) -> NovelCharacter:
    return NovelCharacter(
        name=name,
        is_main=is_main,
        reference_audio_path=f"assets/voices/{name}.wav",
        reference_audio_sha256=f"sha-{name}",
    )


def _character_project(tmp_path: Path) -> tuple[Path, FakeCharacterStore]:
    project_dir = tmp_path / "output" / "alice" / "demo"
    _voice_file(project_dir, "小明")
    return project_dir, FakeCharacterStore([_character("小明")])


def _projection_fields(
    *,
    voice_character=None,
    narrator_main_character=None,
    narration_style: str = "third_person",
    narrator_reference_audio: dict | None = None,
) -> dict:
    from novelvideo.task_backend.projection import _character_to_dict

    return {
        "voice_character": _character_to_dict(voice_character) if voice_character else None,
        "narrator_main_character": (
            _character_to_dict(narrator_main_character) if narrator_main_character else None
        ),
        "narration_style": narration_style,
        "narrator_reference_audio": narrator_reference_audio
        or {"path": "", "sha256": "", "updated_at": ""},
    }


def _projection_payload(fields: dict, *, version: int = CURRENT_PROJECTION_VERSION) -> dict:
    return {
        "projection": {
            "projection_version": version,
            "task_type": TASK_TYPE,
            "fields": fields,
        }
    }


def _stub_tts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(audio_node, "IndexTTS2FalClient", FakeTTSGenerator)
    monkeypatch.setattr(
        audio_node, "build_reference_audio_url", lambda path: f"data://{Path(path).name}"
    )
    FakeTTSGenerator.calls = []


# --------------------------------------------------------------------------
# 执行侧：payload 带投射时不碰项目态
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_speech_consumes_projection_without_project_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "output" / "alice" / "demo"
    voice_path = _voice_file(project_dir, "小明")

    def _explode(*_a, **_k):  # pragma: no cover - 触发即失败
        raise AssertionError("project-local state must not be read")

    monkeypatch.setattr(audio_node, "load_effective_narration_style_for_voice", _explode)
    monkeypatch.setattr(audio_node, "load_narrator_reference_audio", _explode)
    _stub_tts(monkeypatch)

    payload = _projection_payload(_projection_fields(voice_character=_character("小明")))
    result = await audio_node.generate_freezone_audio_speech(
        store=None,
        username="alice",
        project="demo",
        project_dir=project_dir,
        job_id="job-projected",
        text="旁白响起。",
        voice_ref={"scope": "character_default", "character_name": "小明"},
        projection=read_projection(payload),
    )

    assert result.voice_source == "character_default"
    assert result.voice_sha256 == "sha-小明"
    assert FakeTTSGenerator.calls[0]["audio_url"] == f"data://{voice_path.name}"


@pytest.mark.asyncio
async def test_generate_speech_resolves_the_narrator_main_from_the_projection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``first_person`` narration is the branch that reaches voice_clone.py:284."""
    project_dir = tmp_path / "output" / "alice" / "demo"
    _voice_file(project_dir, "旁白主角")

    def _explode(*_a, **_k):  # pragma: no cover - 触发即失败
        raise AssertionError("project-local state must not be read")

    monkeypatch.setattr(audio_node, "load_effective_narration_style_for_voice", _explode)
    monkeypatch.setattr(audio_node, "load_narrator_reference_audio", _explode)
    _stub_tts(monkeypatch)

    payload = _projection_payload(
        _projection_fields(
            narrator_main_character=_character("旁白主角", is_main=True),
            narration_style="first_person",
        )
    )
    result = await audio_node.generate_freezone_audio_speech(
        store=None,
        username="alice",
        project="demo",
        project_dir=project_dir,
        job_id="job-narrator",
        text="旁白响起。",
        projection=read_projection(payload),
    )

    assert result.voice_source == "protagonist_identity"
    assert FakeTTSGenerator.calls[0]["audio_url"] == "data://旁白主角.wav"


@pytest.mark.asyncio
async def test_generate_speech_raises_when_the_projection_is_incomplete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A projection that is present but short of a field is a defect, not a fallback."""
    project_dir = tmp_path / "output" / "alice" / "demo"
    _voice_file(project_dir, "小明")

    fields = _projection_fields(voice_character=_character("小明"))
    fields.pop("narration_style")

    with pytest.raises(ValueError, match="必需字段"):
        read_projection(_projection_payload(fields))


@pytest.mark.asyncio
async def test_generate_speech_without_projection_still_reads_project_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """不带投射时行为逐字不变（本 EU 不翻任何开关）。"""
    project_dir, store = _character_project(tmp_path)
    monkeypatch.setattr(
        audio_node,
        "load_effective_narration_style_for_voice",
        lambda *_a, **_k: "third_person",
    )
    _stub_tts(monkeypatch)

    result = await audio_node.generate_freezone_audio_speech(
        store=store,
        username="alice",
        project="demo",
        project_dir=project_dir,
        job_id="job-store",
        text="旁白响起。",
        voice_ref={"scope": "character_default", "character_name": "小明"},
    )

    assert store.list_characters_calls == 1
    assert result.voice_source == "character_default"


@pytest.mark.asyncio
async def test_account_level_voice_never_touches_the_project_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """账号级音色本来就不读项目库，投射与否都一样。"""
    voice_path = tmp_path / "viewer_voice.mp3"
    voice_path.write_bytes(b"account-voice")
    monkeypatch.setattr(
        audio_node,
        "load_effective_narration_style_for_voice",
        lambda *_a, **_k: "third_person",
    )
    monkeypatch.setattr(
        audio_node,
        "resolve_user_audio_voice",
        lambda username, voice_id: audio_node.FreezoneVoiceRefResolution(
            voice_path, "sha-account", USER_VOICE_SCOPE
        ),
    )
    _stub_tts(monkeypatch)

    result = await audio_node.generate_freezone_audio_speech(
        store=ExplodingStore(),
        username="alice",
        project="demo",
        account_voice_username="bob",
        project_dir=tmp_path,
        job_id="job-account",
        text="旁白响起。",
        voice_ref={"scope": USER_VOICE_SCOPE, "voice_id": "fv_viewer"},
    )

    assert result.voice_source == USER_VOICE_SCOPE


@pytest.mark.asyncio
@pytest.mark.parametrize("version", sorted(SUPPORTED_PROJECTION_VERSIONS))
async def test_speech_accepts_every_version_in_the_tolerance_window(
    version: int,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A mixed-version fleet has to work in both directions, not just forwards."""
    project_dir = tmp_path / "output" / "alice" / "demo"
    _voice_file(project_dir, "小明")
    _stub_tts(monkeypatch)

    payload = _projection_payload(
        _projection_fields(voice_character=_character("小明")), version=version
    )
    result = await audio_node.generate_freezone_audio_speech(
        store=None,
        username="alice",
        project="demo",
        project_dir=project_dir,
        job_id=f"job-v{version}",
        text="旁白响起。",
        voice_ref={"scope": "character_default", "character_name": "小明"},
        projection=read_projection(payload),
    )

    assert result.voice_source == "character_default"


# --------------------------------------------------------------------------
# runner 侧：payload 带投射时不开项目 SQLite（＝可跑在非 home node 上）
# --------------------------------------------------------------------------


def _install_runner_stubs(monkeypatch: pytest.MonkeyPatch) -> None:
    from novelvideo.task_backend.runners import freezone as freezone_runner

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    monkeypatch.setattr(freezone_runner, "get_task_manager", lambda: FakeTaskManager())


@pytest.mark.asyncio
async def test_audio_speech_runner_with_projection_never_opens_project_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    seen: dict = {}

    async def _explode_store(_ctx):  # pragma: no cover - 触发即失败
        raise AssertionError("project SQLite store must not be opened")

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        output_path = audio_node.freezone_audio_speech_output_path(project_dir, "job-1")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"audio")
        return audio_node.FreezoneAudioSpeechResult(
            audio_path=output_path,
            duration_ms=1000,
            mime_type="audio/mpeg",
            model="indextts2",
            voice_source="character_default",
            voice_sha256="sha-小明",
        )

    _install_runner_stubs(monkeypatch)
    monkeypatch.setattr("novelvideo.api.deps.make_sqlite_store_for_context", _explode_store)
    monkeypatch.setattr(audio_node, "generate_freezone_audio_speech", fake_generate)

    fields = _projection_fields(voice_character=_character("小明"))
    result = await freezone_runner._run_freezone_audio_speech_async(
        {
            "task_type": TASK_TYPE,
            "payload": {
                "job_id": "job-1",
                "project_dir": str(project_dir),
                "text": "旁白响起。",
                **_projection_payload(fields),
            },
        },
        ctx,
    )

    assert seen["store"] is None
    assert seen["projection"].task_type == TASK_TYPE
    assert seen["projection"].fields == fields
    assert result["voice_source"] == "character_default"


@pytest.mark.asyncio
async def test_audio_speech_runner_without_projection_still_opens_project_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    opened: list[str] = []
    seen: dict = {}
    store = FakeCharacterStore([])

    async def fake_store(_ctx):
        opened.append("opened")
        return store

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        output_path = audio_node.freezone_audio_speech_output_path(project_dir, "job-2")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"audio")
        return audio_node.FreezoneAudioSpeechResult(
            audio_path=output_path,
            duration_ms=1000,
            mime_type="audio/mpeg",
            model="indextts2",
            voice_source="project_narrator",
            voice_sha256="sha",
        )

    _install_runner_stubs(monkeypatch)
    monkeypatch.setattr("novelvideo.api.deps.make_sqlite_store_for_context", fake_store)
    monkeypatch.setattr(audio_node, "generate_freezone_audio_speech", fake_generate)

    await freezone_runner._run_freezone_audio_speech_async(
        {
            "task_type": TASK_TYPE,
            "payload": {
                "job_id": "job-2",
                "project_dir": str(project_dir),
                "text": "旁白响起。",
            },
        },
        ctx,
    )

    assert opened == ["opened"]
    assert seen["store"] is store
    assert seen.get("projection") is None


@pytest.mark.asyncio
async def test_audio_speech_runner_runs_with_every_project_data_entrypoint_disabled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """T2 -- the whole leaf, not a stub, with project data made unreachable.

    ``resolve_narrator_source`` carries a database fallback that today's callers
    never reach (``seedance2_i2v/voice_clone.py:284`` falls back to
    ``store.get_all_characters()`` when no character rows are handed in).  Being
    unreachable is not the same as being absent, and grepping for the store API
    does not find it, so the only way to hold that line is to make every project
    data entrypoint fail and run the first-person branch through it for real.
    """
    from novelvideo.cognee.store import CogneeStore
    from novelvideo.sqlite_store import SQLiteStore
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    _voice_file(project_dir, "旁白主角")
    touched: list[str] = []

    def _explode(name: str):
        def _raise(*_args, **_kwargs):
            touched.append(name)
            raise AssertionError(f"{name} must not be reachable for a projected task")

        return _raise

    _install_runner_stubs(monkeypatch)
    _stub_tts(monkeypatch)
    monkeypatch.setattr(SQLiteStore, "__init__", _explode("SQLiteStore.__init__"))
    monkeypatch.setattr(CogneeStore, "__init__", _explode("CogneeStore.__init__"))
    monkeypatch.setattr(
        "novelvideo.project_config.load_project_config_file",
        _explode("load_project_config_file"),
    )

    payload = {
        "job_id": "job-t2",
        "project_dir": str(project_dir),
        "text": "旁白响起。",
        **_projection_payload(
            _projection_fields(
                narrator_main_character=_character("旁白主角", is_main=True),
                narration_style="first_person",
            )
        ),
    }
    result = await freezone_runner._run_freezone_audio_speech_async(
        {"task_type": TASK_TYPE, "payload": payload}, ctx
    )

    assert touched == []
    assert result["voice_source"] == "protagonist_identity"
    assert FakeTTSGenerator.calls[0]["audio_url"] == "data://旁白主角.wav"


# --------------------------------------------------------------------------
# 静态断言：payload 里只剩投射一套约定
# --------------------------------------------------------------------------


def test_no_production_code_carries_a_resolved_voice_payload_key() -> None:
    """Audio inputs travel one way only -- inside ``payload['projection']``.

    Two conventions for the same concern means the field-name, size and version
    guards built around the projection cover only half of what ships, and every
    later protocol change has to be made twice.  The local variable of the same
    name in the beat-audio task is a different thing entirely and is not counted.
    """
    src = Path(__file__).resolve().parents[1] / "src" / "novelvideo"
    key = re.compile(r"""resolved_voice""")
    hits: dict[str, list[str]] = {}
    for path in sorted(src.rglob("*.py")):
        lines = [
            f"{path.relative_to(src)}:{number}: {line.strip()}"
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
            if key.search(line)
        ]
        if lines:
            hits[str(path.relative_to(src))] = lines

    payload_hits = [
        line
        for lines in hits.values()
        for line in lines
        if '"resolved_voice"' in line or "'resolved_voice'" in line or "resolved_voice=" in line
    ]
    assert payload_hits == []
    assert set(hits) == {"audio/indextts2_beat_audio_task.py"}


def test_the_beat_audio_task_name_is_a_local_variable_not_a_payload_key() -> None:
    """Guard the exclusion above so it cannot quietly become an escape hatch."""
    module = sys.modules.get("novelvideo.audio.indextts2_beat_audio_task")
    if module is None:
        import novelvideo.audio.indextts2_beat_audio_task as module

    source = Path(module.__file__).read_text(encoding="utf-8")
    assert '"resolved_voice"' not in source
    assert "'resolved_voice'" not in source
    assert "resolved_voice = await _resolve_dialogue_voice(" in source

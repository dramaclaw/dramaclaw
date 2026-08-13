"""B2 §6.4 步 8：音频节点解耦 —— 投递时解析音色、放进 payload。

依据：
- B2 §2.5：`freezone/audio_node.py:329`/`:445` 的 `store.list_characters()` 走的是
  `task_backend/runners/freezone.py:1293` 的 `make_sqlite_store_for_context(ctx)`
  ＝ 项目 SQLite，钉 home node（`api/deps.py:185` 的
  `require_project_home_node(ctx, operation="open project SQLite store")`）。
- B2 §6.2 批 1a：「音频节点解耦：在投递时解析音色、放进 payload」。
- B2 §6.4 步 8 RED：「账号级音色在**非 home node** 的 worker 上可解析」。

本 EU 的交付是「输入自带」：payload 里带 `resolved_voice` 时，runner 不再回头开项目
store，音色与叙述风格全部来自 payload；不带时行为与今天逐字相同（不翻任何开关）。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.freezone import audio_node
from novelvideo.freezone.audio_node import USER_VOICE_SCOPE
from novelvideo.project_context import ProjectContext


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
        project_id="proj_audio_d1",
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


def _character_project(tmp_path: Path) -> tuple[Path, FakeCharacterStore]:
    project_dir = tmp_path / "output" / "alice" / "demo"
    reference = project_dir / "assets" / "voices" / "xiaoming.wav"
    reference.parent.mkdir(parents=True, exist_ok=True)
    reference.write_bytes(b"character-reference-audio")
    store = FakeCharacterStore(
        [
            SimpleNamespace(
                name="小明",
                reference_audio_path="assets/voices/xiaoming.wav",
                reference_audio_sha256="sha-xiaoming",
            )
        ]
    )
    return project_dir, store


# --------------------------------------------------------------------------
# 投递侧：把项目级音色解析成可序列化的投射
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_project_voice_selection_projects_character_voice(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, store = _character_project(tmp_path)
    monkeypatch.setattr(
        audio_node,
        "load_effective_narration_style_for_voice",
        lambda *_a, **_k: "first_person",
    )

    projection = await audio_node.project_voice_selection(
        store=store,
        username="alice",
        project="demo",
        project_dir=project_dir,
        voice_ref={"scope": "character_default", "character_name": "小明"},
    )

    assert projection["narration_style"] == "first_person"
    assert projection["source"] == "character_default"
    assert projection["sha256"] == "sha-xiaoming"
    assert Path(projection["audio_path"]) == project_dir / "assets" / "voices" / "xiaoming.wav"
    # 投射必须是可序列化的（要塞进任务 payload）。
    import json

    assert json.loads(json.dumps(projection)) == projection


@pytest.mark.asyncio
async def test_project_voice_selection_projects_account_voice_without_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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

    projection = await audio_node.project_voice_selection(
        store=ExplodingStore(),
        username="alice",
        project="demo",
        account_voice_username="bob",
        project_dir=tmp_path,
        voice_ref={"scope": USER_VOICE_SCOPE, "voice_id": "fv_viewer"},
    )

    assert projection["source"] == USER_VOICE_SCOPE
    assert projection["audio_path"] == str(voice_path)


# --------------------------------------------------------------------------
# 执行侧：payload 带投射时不碰项目 store
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_speech_consumes_projection_without_project_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "output" / "alice" / "demo"
    voice_path = tmp_path / "projected.wav"
    voice_path.write_bytes(b"projected-voice")

    def _explode(*_a, **_k):  # pragma: no cover - 触发即失败
        raise AssertionError("project-local narration style must not be read")

    monkeypatch.setattr(audio_node, "load_effective_narration_style_for_voice", _explode)
    monkeypatch.setattr(audio_node, "load_narrator_reference_audio", _explode)
    monkeypatch.setattr(audio_node, "IndexTTS2FalClient", FakeTTSGenerator)
    monkeypatch.setattr(
        audio_node, "build_reference_audio_url", lambda path: f"data://{Path(path).name}"
    )
    FakeTTSGenerator.calls = []

    result = await audio_node.generate_freezone_audio_speech(
        store=None,
        username="alice",
        project="demo",
        project_dir=project_dir,
        job_id="job-projected",
        text="旁白响起。",
        resolved_voice={
            "narration_style": "third_person",
            "audio_path": str(voice_path),
            "sha256": "sha-projected",
            "source": "character_default",
        },
    )

    assert result.voice_source == "character_default"
    assert result.voice_sha256 == "sha-projected"
    assert FakeTTSGenerator.calls[0]["audio_url"] == "data://projected.wav"


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
    monkeypatch.setattr(audio_node, "IndexTTS2FalClient", FakeTTSGenerator)
    monkeypatch.setattr(
        audio_node, "build_reference_audio_url", lambda path: f"data://{Path(path).name}"
    )
    FakeTTSGenerator.calls = []

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
            voice_sha256="sha-projected",
        )

    _install_runner_stubs(monkeypatch)
    monkeypatch.setattr(
        "novelvideo.api.deps.make_sqlite_store_for_context", _explode_store
    )
    monkeypatch.setattr(audio_node, "generate_freezone_audio_speech", fake_generate)

    projection = {
        "narration_style": "third_person",
        "audio_path": str(tmp_path / "projected.wav"),
        "sha256": "sha-projected",
        "source": "character_default",
    }
    result = await freezone_runner._run_freezone_audio_speech_async(
        {
            "task_type": "freezone_audio_speech",
            "payload": {
                "job_id": "job-1",
                "project_dir": str(project_dir),
                "text": "旁白响起。",
                "resolved_voice": projection,
            },
        },
        ctx,
    )

    assert seen["resolved_voice"] == projection
    assert seen["store"] is None
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
            "task_type": "freezone_audio_speech",
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
    assert seen.get("resolved_voice") is None

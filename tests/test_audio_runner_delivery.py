from types import SimpleNamespace

import pytest

from novelvideo.audio.indextts2_beat_audio_task import IndexTTS2BeatAudioTaskResult
from novelvideo.task_backend.runners import audio


@pytest.mark.asyncio
async def test_audio_runner_fails_when_no_usable_audio_was_generated(monkeypatch, tmp_path):
    class FakeStore:
        def __init__(self, *_args, **_kwargs):
            self.closed = False

        async def initialize(self):
            return None

        async def close(self):
            self.closed = True

    class FakeManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            return None

    async def fake_generate(**_kwargs):
        return IndexTTS2BeatAudioTaskResult(
            mode="redo_selected",
            total_targets=2,
            generated=0,
            failed=["Beat 01: provider failed", "Beat 02: provider failed"],
        )

    monkeypatch.setattr("novelvideo.sqlite_store.SQLiteStore", FakeStore)
    monkeypatch.setattr(
        "novelvideo.audio.indextts2_beat_audio_task.run_indextts2_beat_audio_generation",
        fake_generate,
    )
    monkeypatch.setattr(audio, "get_task_manager", lambda: FakeManager())
    ctx = SimpleNamespace(
        owner_project_label="alice/demo",
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
        owner_username="alice",
        project_name="demo",
    )

    with pytest.raises(RuntimeError, match="没有生成可用结果"):
        await audio._run_indextts2_audio(
            {"payload": {"episode": 1, "beat_numbers": [1, 2]}},
            ctx,
        )

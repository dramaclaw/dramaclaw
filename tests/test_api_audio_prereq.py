import pytest


class _FakeStore:
    async def get_beats_as_dicts(self, episode: int):
        assert episode == 3
        return [
            {
                "beat_number": 1,
                "audio_type": "narration",
                "narration_segment": "Hello",
            }
        ]


@pytest.mark.asyncio
async def test_audio_generate_prereq_error_does_not_start_task(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.schemas import TTSGenerateRequest

    async def fake_make_sqlite_store(username, project):
        assert username == "alice"
        assert project == "demo"
        return _FakeStore()

    async def fake_audio_generation_plan(**kwargs):
        return [], ["Beat 01 解说声线缺失：请上传旁白声线"], 0

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(generation, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation,
        "_audio_generation_plan",
        fake_audio_generation_plan,
        raising=False,
    )

    response = await generation.generate_audio(
        project="demo",
        episode_num=3,
        body=TTSGenerateRequest(mode="redo_selected", beat_numbers=[1]),
        user={"username": "alice"},
    )

    assert response == {
        "ok": False,
        "code": "voice_prereq_required",
        "error": "Beat 01 解说声线缺失：请上传旁白声线",
    }

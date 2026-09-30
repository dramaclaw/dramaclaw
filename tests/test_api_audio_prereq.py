import pytest
from types import SimpleNamespace


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


@pytest.mark.asyncio
async def test_prepare_system_voices_is_agent_only(monkeypatch):
    from fastapi import HTTPException

    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SystemVoicePrepareRequest

    with pytest.raises(HTTPException, match="system voice setup is agent-only"):
        await generation.prepare_system_voices_for_agent(
            project="demo",
            episode_num=1,
            body=SystemVoicePrepareRequest(confirmed=True),
            user={"username": "alice", "credential_kind": "browser_session"},
        )


@pytest.mark.asyncio
async def test_prepare_system_voices_requires_explicit_confirmation():
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SystemVoicePrepareRequest

    response = await generation.prepare_system_voices_for_agent(
        project="demo",
        episode_num=1,
        body=SystemVoicePrepareRequest(confirmed=False),
        user={"username": "alice", "agent_kind": "hermes"},
    )

    assert response["code"] == "system_voice_confirmation_required"


@pytest.mark.asyncio
async def test_prepare_system_voices_enqueues_agent_only_background_task(
    monkeypatch, tmp_path
):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import generation
    from novelvideo.api.schemas import SystemVoicePrepareRequest
    from novelvideo.project_context import ProjectContext

    ctx = ProjectContext(
        project_id="project-1",
        project_name="demo",
        owner_type="user",
        owner_id="user-1",
        owner_username="alice",
        requester_user_id="user-1",
        requester_username="alice",
        requester_principals=(("user", "user-1"),),
        effective_role="editor",
        home_node_id="local",
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )

    async def fake_resolve(*args, **kwargs):
        return ProjectResolution(
            ctx=ctx,
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    calls = []

    class FakeBackend:
        async def enqueue_project_task(self, received_ctx, **kwargs):
            calls.append((received_ctx, kwargs))
            return SimpleNamespace(
                task_state=SimpleNamespace(task_id="task-system-voice"),
                backend="inline",
                queue="default",
            )

    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve)
    monkeypatch.setattr(generation, "get_task_backend", lambda: FakeBackend())

    response = await generation.prepare_system_voices_for_agent(
        project="demo",
        episode_num=3,
        body=SystemVoicePrepareRequest(confirmed=True),
        user={"username": "alice", "agent_kind": "hermes"},
    )

    assert response["ok"] is True
    assert response["task_type"] == "system_voice_setup"
    assert response["task_id"] == "task-system-voice"
    assert calls == [
        (
            ctx,
            {
                "product_surface": "mainline",
                "task_type": "system_voice_setup",
                "queue_kind": "default",
                "episode": 3,
                "payload": {
                    "episode": 3,
                    "output_dir": str(tmp_path),
                    "state_dir": str(tmp_path / "state"),
                },
            },
        )
    ]

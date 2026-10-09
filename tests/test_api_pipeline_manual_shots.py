from types import SimpleNamespace

import pytest


class _FakePipelineStore:
    def get_all_characters(self):
        return [
            SimpleNamespace(
                name="Hero",
                is_main=True,
                identities=[
                    SimpleNamespace(identity_id="hero_main", identity_name="Hero Main")
                ],
            )
        ]

    def get_all_episodes(self):
        return [SimpleNamespace(number=1)]

    def get_episode(self, episode: int):
        assert episode == 1
        return SimpleNamespace(number=1, identity_ids=["hero_main"])

    async def get_beats_as_dicts(self, episode: int):
        assert episode == 1
        return [
            {
                "beat_number": 1,
                "narration_segment": "one",
                "detected_identities": [],
                "video_mode": "first_frame",
                "video_prompt": "one",
            },
            {
                "beat_number": 2,
                "narration_segment": "two",
                "detected_identities": [],
                "video_mode": "first_frame",
                "video_prompt": "two",
            },
            {
                "beat_number": 5,
                "narration_segment": "five",
                "detected_identities": [],
                "video_mode": "first_frame",
                "video_prompt": "five",
                "is_manual_shot": True,
            },
        ]


@pytest.mark.asyncio
async def test_pipeline_status_uses_sparse_beat_numbers_for_media(monkeypatch, tmp_path):
    from novelvideo.api.routes import pipeline
    from novelvideo.api.deps import ProjectResolution

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

    monkeypatch.setattr(pipeline, "resolve_project_scope", fake_resolve_project_scope)

    ep_tag = "ep001"
    for folder, suffix in (
        ("frames", "png"),
        ("audio", "mp3"),
        ("videos/beats", "mp4"),
    ):
        target_dir = tmp_path / folder / ep_tag
        target_dir.mkdir(parents=True)
        for beat_num in (1, 2, 5):
            (target_dir / f"beat_{beat_num:02d}.{suffix}").write_bytes(b"x")
    (tmp_path / "grids" / ep_tag).mkdir(parents=True)
    (tmp_path / "grids" / ep_tag / "grid.png").write_bytes(b"x")

    monkeypatch.setattr(pipeline, "_user_has_configured", lambda username, project: True)
    monkeypatch.setattr(
        pipeline,
        "compute_portrait_path",
        lambda project_dir, character_name: tmp_path / "portrait.png",
    )
    monkeypatch.setattr(
        pipeline,
        "compute_identity_path",
        lambda project_dir, character_name, identity_name: tmp_path / "identity.png",
    )

    response = await pipeline.pipeline_status(
        project="demo",
        episode=1,
        user={"username": "alice"},
        store=_FakePipelineStore(),
    )

    assert response["data"]["episode_status"]["first_frames"] is True
    assert response["data"]["episode_status"]["tts"] is True
    assert response["data"]["episode_status"]["video"] is True


@pytest.mark.asyncio
async def test_pipeline_status_requires_voice_setup_before_tts(monkeypatch, tmp_path):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import pipeline

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

    async def fake_voice_prerequisites(**kwargs):
        assert kwargs["episode"] == 1
        return ["Beat 01 解说声线缺失：请上传或录制解说人音频"]

    monkeypatch.setattr(pipeline, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(pipeline, "_collect_voice_prereq_errors", fake_voice_prerequisites)
    monkeypatch.setattr(pipeline, "_user_has_configured", lambda username, project: True)
    monkeypatch.setattr(
        pipeline,
        "compute_portrait_path",
        lambda project_dir, character_name: tmp_path / "portrait.png",
    )
    monkeypatch.setattr(
        pipeline,
        "compute_identity_path",
        lambda project_dir, character_name, identity_name: tmp_path / "identity.png",
    )

    ep_tag = "ep001"
    frames_dir = tmp_path / "frames" / ep_tag
    frames_dir.mkdir(parents=True)
    for beat_num in (1, 2, 5):
        (frames_dir / f"beat_{beat_num:02d}.png").write_bytes(b"x")
    grids_dir = tmp_path / "grids" / ep_tag
    grids_dir.mkdir(parents=True)
    (grids_dir / "grid.png").write_bytes(b"x")

    response = await pipeline.pipeline_status(
        project="demo",
        episode=1,
        user={"username": "alice"},
        store=_FakePipelineStore(),
    )

    data = response["data"]
    assert data["next_step"] == "voice_setup"
    assert data["next_step_name"] == "准备配音声线"
    assert data["audio_prerequisites"] == {
        "checked": True,
        "ready": False,
        "errors": ["Beat 01 解说声线缺失：请上传或录制解说人音频"],
    }


def test_pipeline_script_status_accepts_current_sqlite_beat_fields():
    from novelvideo.api.routes.pipeline import _beat_has_script_content

    assert _beat_has_script_content({"narration": "旁白", "visual_description": ""}) is True
    assert _beat_has_script_content({"narration": "", "visual_description": "黑屏标题"}) is True
    assert _beat_has_script_content({"narration_segment": "旧字段"}) is True
    assert _beat_has_script_content({"narration": "", "visual_description": ""}) is False


def test_pipeline_audio_status_ignores_beats_that_do_not_require_audio(tmp_path):
    from novelvideo.api.routes.pipeline import _beat_audio_series_complete

    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    (audio_dir / "beat_01.mp3").write_bytes(b"audio")

    beats = [
        {
            "beat_number": 1,
            "audio_type": "narration",
            "narration_segment": "需要配音。",
        },
        {
            "beat_number": 2,
            "audio_type": "action",
            "narration_segment": "无声动作镜头。",
        },
        {
            "beat_number": 3,
            "audio_type": "dialogue",
            "speaker": "角色A",
            "narration_segment": "",
        },
    ]

    assert _beat_audio_series_complete(audio_dir, beats) is True

    (audio_dir / "beat_01.mp3").unlink()
    assert _beat_audio_series_complete(audio_dir, beats) is False

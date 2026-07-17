from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.freezone import vision_gateway
from novelvideo.freezone.jobs import build_video_story_analysis_prompt
from novelvideo.freezone.jobs import run_freezone_analyze_shots


def _patch_project_resolution(
    monkeypatch: pytest.MonkeyPatch,
    project_dir: Path,
    *,
    username: str = "admin",
):
    async def _fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return None, username, project, project_dir, str(project_dir)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", _fake_resolve)


def test_video_story_prompt_requests_libtv_story_table() -> None:
    prompt = build_video_story_analysis_prompt(frame_count=5, duration_sec=15.0)

    assert "libtv 风格的“视频故事”表" in prompt
    assert "3-12 个叙事镜头/动作段落" in prompt
    assert "视频总时长约 15.00 秒" in prompt
    assert '"visual_description"' in prompt
    assert '"narrative"' in prompt
    assert '"image_prompt"' in prompt
    assert '"motion_prompt"' in prompt
    assert "严格输出 JSON 对象" in prompt


def test_freezone_analyze_request_defaults_to_shots_mode() -> None:
    body = freezone_routes.FreezoneAnalyzeShotsRequest(frame_urls=["/static/f1.png"])

    assert body.analysis_mode == "shots"
    assert body.duration_sec is None


@pytest.mark.asyncio
async def test_video_story_analysis_uses_shared_freezone_vision_model(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = tmp_path / "frame.png"
    frame.write_bytes(b"png")
    captured: dict[str, object] = {}

    async def fake_call_freezone_vision_model(**kwargs):
        captured.update(kwargs)
        return "DC-freezone-vision-LLM", '{"shots":[]}'

    monkeypatch.setattr(
        vision_gateway,
        "call_freezone_vision_model",
        fake_call_freezone_vision_model,
    )

    result = await run_freezone_analyze_shots(
        project_dir=tmp_path,
        job_id="vision-job",
        frame_paths=[str(frame)],
        analysis_mode="video_story",
    )

    assert result["provider"] == "newapi"
    assert result["model"] == "DC-freezone-vision-LLM"
    assert result["video_story"] == {"shots": []}
    assert len(captured["images"]) == 1


@pytest.mark.asyncio
async def test_freezone_analyze_route_passes_video_story_options(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "59"
    frame_path = tmp_path / "frame.png"
    frame_path.write_bytes(b"png")
    captured: dict[str, object] = {}

    _patch_project_resolution(monkeypatch, tmp_path, username=username)
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "story_job")
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda _url, _project_dir: frame_path,
    )

    async def fake_enqueue_or_start_freezone_video_analysis(**kwargs):
        captured.update(kwargs)
        captured.update(kwargs["payload"])
        return {
            "ok": True,
            "data": {
                "task_type": kwargs["task_type"],
                "job_id": kwargs["job_id"],
                "task_key": f"{kwargs['task_type']}:{kwargs['job_id']}",
            },
        }

    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_or_start_freezone_video_analysis",
        fake_enqueue_or_start_freezone_video_analysis,
    )

    result = await freezone_routes.freezone_analyze_shots(
        project=project,
        body=freezone_routes.FreezoneAnalyzeShotsRequest(
            frame_urls=["/static/admin/59/frame.png"],
            analysis_mode="video_story",
            duration_sec=15.0,
            provider="openrouter",
            model="gemini-3.5-flash",
        ),
        user={"username": username},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_analyze"
    assert captured["analysis_mode"] == "video_story"
    assert captured["duration_sec"] == 15.0
    assert "provider" not in captured
    assert "model" not in captured
    assert captured["frame_paths"] == [str(frame_path)]


@pytest.mark.asyncio
async def test_freezone_analyze_video_story_route_starts_single_video_task(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "59"
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"mp4")
    captured: dict[str, object] = {}

    _patch_project_resolution(monkeypatch, tmp_path, username=username)
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "video_story_job")
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda _url, _project_dir: video_path,
    )

    async def fake_enqueue_or_start_freezone_video_analysis(**kwargs):
        captured.update(kwargs)
        captured.update(kwargs["payload"])
        return {
            "ok": True,
            "data": {
                "task_type": kwargs["task_type"],
                "job_id": kwargs["job_id"],
                "task_key": f"{kwargs['task_type']}:{kwargs['job_id']}",
            },
        }

    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_or_start_freezone_video_analysis",
        fake_enqueue_or_start_freezone_video_analysis,
    )

    result = await freezone_routes.freezone_analyze_video_story(
        project=project,
        body=freezone_routes.FreezoneAnalyzeVideoStoryRequest(
            video_url="/static/admin/59/freezone/_uploads/clip.mp4",
            max_frames=12,
            scene_threshold=0.25,
            duration_sec=15.0,
        ),
        user={"username": username},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_video_story"
    assert result["data"]["job_id"] == "video_story_job"
    assert "freezone_video_story" in result["data"]["task_key"]
    assert captured["video_path"] == video_path.as_posix()
    assert captured["max_frames"] == 12
    assert captured["scene_threshold"] == 0.25
    assert captured["duration_sec"] == 15.0
    assert "provider" not in captured
    assert "model" not in captured


def test_public_video_story_result_excludes_local_paths() -> None:
    result = {
        "job_id": "story_job",
        "output_path": "/tmp/private/analysis.json",
        "output_url": "/static/admin/59/freezone/_outputs/freezone_analyze/story_job/analysis.json",
        "model": "gemini-3.5-flash",
        "analysis_mode": "video_story",
        "frame_count": 2,
        "frame_urls": ["/static/admin/59/freezone/_outputs/freezone_extract/story_job/even_001.png"],
        "frame_paths": ["/tmp/private/even_001.png"],
        "analyses": [],
        "video_story": {"shots": []},
    }

    public = freezone_routes._public_freezone_video_story_result(result)

    assert "output_path" not in public
    assert "frame_paths" not in public
    assert public["output_url"] == result["output_url"]
    assert public["frame_urls"] == result["frame_urls"]


@pytest.mark.asyncio
async def test_video_story_job_result_waits_until_task_completed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "58"
    job_id = "running_story"

    class FakeTask:
        status = "running"
        error = None
        logs = []
        current_task = "Vision 解析 12 帧为视频故事..."
        result = {"task_metadata": {"job_id": job_id}}

    class FakeManager:
        def get_task(self, task_type, username_, project_, episode, scope=None):
            assert task_type == "freezone_video_story"
            assert username_ == username
            assert project_ == project
            assert episode == 0
            assert scope == job_id
            return FakeTask()

    _patch_project_resolution(monkeypatch, tmp_path, username=username)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project=project,
        task_type="freezone_video_story",
        job_id=job_id,
        user={"username": username},
    )

    assert result["ok"] is False
    assert result["status"] == "running"
    assert result["info"] == "job result not yet available"
    assert result["current_task"] == "Vision 解析 12 帧为视频故事..."
    assert "data" not in result

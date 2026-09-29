"""逐帧拉片的项目任务、计费和路由契约。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import freezone as freezone_routes


@pytest.mark.asyncio
async def test_shot_breakdown_uses_shared_analysis_billing_and_ffmpeg_queue(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def fake_enqueue_project_task(*_args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_1"),
            backend="celery",
            queue="node.ffmpeg",
        )

    monkeypatch.setattr(
        freezone_routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    await freezone_routes._enqueue_or_start_freezone_video_analysis(
        ctx=SimpleNamespace(project_id="project_59"),
        username="admin",
        project="59",
        project_dir=tmp_path,
        output_dir=str(tmp_path),
        task_type="freezone_shot_breakdown",
        job_id="job_1",
        payload={"video_path": "clip.mp4"},
    )

    assert captured["queue_kind"] == "ffmpeg"
    assert captured["payload"]["billing"] == {
        "feature_key": "freezone.video_analyze",
        "operation": "video_breakdown",
    }


@pytest.mark.asyncio
async def test_shot_breakdown_route_forwards_bounded_analysis_options(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"mp4")
    captured: dict[str, object] = {}

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return SimpleNamespace(project_id=project), "owner", project, tmp_path, str(tmp_path)

    async def fake_enqueue(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "data": {"task_key": "freezone_shot_breakdown:job_1"}}

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_1")
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda _url, _project_dir: video_path,
    )
    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_or_start_freezone_video_analysis",
        fake_enqueue,
    )

    result = await freezone_routes.freezone_shot_breakdown(
        project="project_59",
        body=freezone_routes.FreezoneShotBreakdownRequest(
            video_url="/static/owner/project_59/clip.mp4",
            max_frames=12,
            scene_threshold=0.25,
            duration_sec=15.0,
            dimensions=["storyboard", "musicRef"],
        ),
        user={"username": "owner"},
    )

    assert result["data"]["task_key"] == "freezone_shot_breakdown:job_1"
    assert captured["task_type"] == "freezone_shot_breakdown"
    assert captured["payload"] == {
        "video_path": video_path.as_posix(),
        "source_url": "/static/owner/project_59/clip.mp4",
        "max_frames": 12,
        "scene_threshold": 0.25,
        "duration_sec": 15.0,
        "provider": None,
        "model": None,
        "dimensions": ["storyboard", "musicRef"],
    }

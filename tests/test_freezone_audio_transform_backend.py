"""音频截取 / 变速的路由与队列契约。"""

from __future__ import annotations

from pathlib import Path
from typing import get_args, get_type_hints
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.project_context import ProjectContext


def _project_context(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="project_1",
        project_name="demo",
        owner_type="user",
        owner_id="owner_id",
        owner_username="owner",
        requester_user_id="editor_id",
        requester_username="editor",
        requester_principals=(("user", "editor_id"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "owner" / "demo",
        state_dir=tmp_path / "state" / "owner" / "demo",
        runtime_dir=tmp_path / "runtime" / "owner" / "demo",
        is_home_node=True,
    )


def test_audio_transform_is_accepted_by_generic_result_route() -> None:
    hints = get_type_hints(freezone_routes.freezone_job_result)

    assert "freezone_audio_transform" in get_args(hints["task_type"])


@pytest.mark.asyncio
async def test_audio_transform_route_enqueues_ffmpeg_task(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio_path = tmp_path / "source.mp3"
    audio_path.write_bytes(b"mp3")
    captured: dict[str, object] = {}

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return SimpleNamespace(project_id=project), "owner", project, tmp_path, str(tmp_path)

    async def fake_enqueue_project_task(ctx, **kwargs):
        captured["ctx"] = ctx
        captured.update(kwargs)
        return SimpleNamespace(
            backend="inline",
            queue="ffmpeg",
            task_state=SimpleNamespace(task_id="task-audio-transform"),
        )

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "audio_job")
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda _url, _project_dir: audio_path,
    )
    monkeypatch.setattr(
        freezone_routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    result = await freezone_routes.freezone_audio_transform(
        project="project_1",
        body=freezone_routes.FreezoneAudioTransformRequest(
            source_url="/static/owner/project_1/source.mp3",
            start_sec=1.0,
            end_sec=5.0,
            speed=1.5,
        ),
        user={"username": "owner"},
    )

    assert result["data"]["task_type"] == "freezone_audio_transform"
    assert result["data"]["job_id"] == "audio_job"
    assert captured["task_type"] == "freezone_audio_transform"
    assert captured["queue_kind"] == "ffmpeg"
    assert captured["scope"] == "audio_job"
    assert captured["payload"] == {
        "job_id": "audio_job",
        "project_dir": str(tmp_path),
        "source_path": audio_path.as_posix(),
        "start_sec": 1.0,
        "end_sec": 5.0,
        "speed": 1.5,
    }


@pytest.mark.asyncio
async def test_audio_transform_route_rejects_short_range(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return SimpleNamespace(project_id=project), "owner", project, tmp_path, str(tmp_path)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve)

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_audio_transform(
            project="project_1",
            body=freezone_routes.FreezoneAudioTransformRequest(
                source_url="/static/owner/project_1/source.mp3",
                start_sec=1.0,
                end_sec=1.05,
                speed=1.0,
            ),
            user={"username": "owner"},
        )

    assert exc.value.status_code == 400
    assert "at least 0.1 seconds" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_audio_transform_runner_returns_public_url_and_duration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _project_context(tmp_path)
    project_dir = Path(ctx.output_dir)
    output_path = (
        project_dir
        / "freezone"
        / "_outputs"
        / "freezone_audio_transform"
        / "audio_job.m4a"
    )

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    async def fake_run_freezone_audio_transform(**_kwargs):
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"m4a")
        return output_path

    monkeypatch.setattr(freezone_runner, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.audio_transform.run_freezone_audio_transform",
        fake_run_freezone_audio_transform,
    )

    result = await freezone_runner._run_freezone_audio_transform_async(
        {
            "task_type": "freezone_audio_transform",
            "payload": {
                "job_id": "audio_job",
                "project_dir": str(project_dir),
                "source_path": str(project_dir / "source.mp3"),
                "start_sec": 2.0,
                "end_sec": 8.0,
                "speed": 1.5,
            },
        },
        ctx,
    )

    assert result["output_format"] == "m4a"
    assert result["duration_sec"] == pytest.approx(4.0)
    assert result["output_url"].startswith("/static/projects/project_1/")
    assert "/owner/demo/" not in result["output_url"]

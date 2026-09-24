from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.freezone import jobs as freezone_jobs
from novelvideo.freezone.jobs import _video_upscale_filter


def test_video_upscale_filter_uses_lanczos_and_enhancement() -> None:
    video_filter = _video_upscale_filter("1080p", "1x")

    assert "scale='if(gte(iw,ih),1920,-2)'" in video_filter
    assert "flags=lanczos" in video_filter
    assert "hqdn3d=1.2:1.2:4:4" in video_filter
    assert "unsharp=5:5:0.55:3:3:0.25" in video_filter
    assert video_filter.endswith("format=yuv420p")


@pytest.mark.parametrize(
    ("factor", "audio_filter"),
    [(3, "atempo=0.5,atempo=0.6666666667"), (5, "atempo=0.5,atempo=0.5,atempo=0.8")],
)
@pytest.mark.asyncio
async def test_slow_video_stretches_audio_and_video_together(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    factor: int,
    audio_filter: str,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    captured: list[str] = []

    async def fake_has_audio(*_args, **_kwargs):
        return True

    async def fake_run_cmd(command: list[str], **_kwargs):
        captured.extend(command)

    monkeypatch.setattr(freezone_jobs, "_probe_has_audio", fake_has_audio)
    monkeypatch.setattr(freezone_jobs, "_run_cmd", fake_run_cmd)
    await freezone_jobs._slow_video(
        source, tmp_path / "slow.mp4", factor=factor,
        project_dir=tmp_path, egress_context=None,
    )

    assert captured[captured.index("-filter_complex") + 1] == (
        f"[0:v]setpts={factor}*PTS[v];[0:a]{audio_filter}[a]"
    )


@pytest.mark.parametrize("smart_interpolation", [True, False])
@pytest.mark.parametrize("target_fps", [None, 59.94])
@pytest.mark.parametrize("source_fps", [24.0, 23.976])
@pytest.mark.parametrize("slowdown", ["2x", "5x"])
@pytest.mark.asyncio
async def test_model_video_enhancement_runs_upscale_slowdown_and_frame_rate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    smart_interpolation: bool,
    target_fps: float | None,
    source_fps: float,
    slowdown: str,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    calls: list[tuple[str, str, dict[str, object]]] = []

    async def fake_probe(_source_path: str, **_kwargs):
        return {"width": 854, "height": 480, "fps": source_fps, "duration": 10.0}

    async def fake_model(**kwargs):
        output = Path(kwargs["output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"model")
        calls.append((kwargs["mode"], kwargs["backend"], kwargs["processing_metadata"]))

    async def fake_slow(source_path: Path, output_path: Path, *, factor: int, **_kwargs):
        assert source_path.exists()
        assert factor == int(slowdown[0])
        output_path.write_bytes(b"slow")

    monkeypatch.setattr(freezone_jobs, "probe_video_stream", fake_probe)
    monkeypatch.setattr(freezone_jobs, "_run_video_processing_model", fake_model)
    monkeypatch.setattr(freezone_jobs, "_slow_video", fake_slow)

    output, metadata = await freezone_jobs.run_freezone_video_upscale(
        project_dir=tmp_path,
        job_id="enhance-1",
        source_path=str(source),
        resolution="4k",
        target_fps=target_fps,
        smart_interpolation=smart_interpolation,
        slowdown=slowdown,
        scene="anime",
        face_enhance=True,
        upscale_backend="newapi_video-super-resolution",
        frame_rate_backend="newapi_video-frame-rate",
    )

    assert output.exists()
    output_dir = freezone_jobs.outputs_dir(tmp_path, "freezone_video_upscale")
    assert not (output_dir / "enhance-1_stages").exists()
    assert calls == [
        (
            "video_upscale",
            "newapi_video-super-resolution",
            {"scene": "anime", "face_enhance": True},
        ),
        (
            "video_frame_rate",
            "newapi_video-frame-rate",
            {
                "target_fps": target_fps or source_fps,
                "smart_interpolation": smart_interpolation,
                "resolution_tier": "4k",
            },
        ),
    ]
    assert metadata["target_fps"] == (target_fps or source_fps)
    assert metadata["stages"] == 3


@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
@pytest.mark.asyncio
async def test_model_video_enhancement_removes_stages_when_task_stops(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    error_type: type[BaseException],
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")

    async def fake_probe(_source_path: str, **_kwargs):
        return {"width": 854, "height": 480, "fps": 24.0, "duration": 10.0}

    async def fake_model(**kwargs):
        output = Path(kwargs["output_path"])
        output.write_bytes(b"stage")
        if kwargs["mode"] == "video_frame_rate":
            raise error_type("task stopped")

    monkeypatch.setattr(freezone_jobs, "probe_video_stream", fake_probe)
    monkeypatch.setattr(freezone_jobs, "_run_video_processing_model", fake_model)

    with pytest.raises(error_type):
        await freezone_jobs.run_freezone_video_upscale(
            project_dir=tmp_path,
            job_id="stopped",
            source_path=str(source),
            resolution="1080p",
            target_fps=60,
            smart_interpolation=True,
            upscale_backend="newapi_video-super-resolution",
            frame_rate_backend="newapi_video-frame-rate",
        )

    output_dir = freezone_jobs.outputs_dir(tmp_path, "freezone_video_upscale")
    assert not (output_dir / "stopped_stages").exists()
    assert not (output_dir / "stopped.mp4").exists()


@pytest.mark.asyncio
async def test_freezone_video_upscale_route_starts_task(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "58"
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"mp4")
    captured: dict[str, object] = {}
    queued = SimpleNamespace(
        backend="inline",
        queue="ffmpeg",
        task_state=SimpleNamespace(task_id="task-upscale"),
    )

    async def _fake_resolve(
        project_: str, user: dict, *, required_role: str = "editor"
    ):
        del user, required_role
        ctx = SimpleNamespace(project_id=project_, requester_user_id="user-1")
        return ctx, username, project_, tmp_path, str(tmp_path)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", _fake_resolve)
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "upscale_job")
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda _url, _project_dir: video_path,
    )

    async def fake_probe(_source_path: str, **_kwargs):
        return {"width": 1280, "height": 720, "fps": 24.0, "duration": 8.0}

    async def fake_processing_model(mode: str, *, requester_user_id: str):
        del requester_user_id
        return {
            "catalog_id": f"catalog-{mode}",
            "backend": f"newapi_{mode}",
            "model_params": {},
            "request_schema": {},
        }

    monkeypatch.setattr(freezone_jobs, "probe_video_stream", fake_probe)
    monkeypatch.setattr(
        freezone_routes,
        "_resolve_video_processing_model",
        fake_processing_model,
    )

    async def fake_enqueue_project_task(ctx, **kwargs):
        captured["ctx"] = ctx
        captured.update(kwargs)
        return queued

    monkeypatch.setattr(
        freezone_routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    result = await freezone_routes.freezone_video_upscale(
        project=project,
        body=freezone_routes.FreezoneVideoUpscaleRequest(
            source_url="/static/admin/58/freezone/_uploads/clip.mp4",
            resolution="2k",
            target_fps=60,
            smart_interpolation=False,
            slowdown="5x",
            scene="anime",
            face_enhance=True,
        ),
        user={"username": username},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_video_upscale"
    assert result["data"]["job_id"] == "upscale_job"
    assert result["data"]["backend"] == "inline"
    assert result["data"]["queue"] == "ffmpeg"
    assert result["data"]["task_id"] == "task-upscale"
    assert "freezone_video_upscale" in result["data"]["task_key"]
    assert captured["ctx"].project_id == project
    assert captured["task_type"] == "freezone_video_upscale"
    assert captured["queue_kind"] == "ffmpeg"
    assert captured["episode"] == 0
    assert captured["scope"] == "upscale_job"
    assert captured["payload"]["source_path"] == video_path.as_posix()
    assert captured["payload"]["resolution"] == "2k"
    assert captured["payload"]["target_fps"] == 60
    assert captured["payload"]["smart_interpolation"] is False
    assert captured["payload"]["slowdown"] == "5x"
    assert captured["payload"]["scene"] == "anime"
    assert captured["payload"]["face_enhance"] is True
    assert captured["payload"]["upscale_backend"] == "newapi_video_upscale"
    assert captured["payload"]["frame_rate_backend"] == "newapi_video_frame_rate"
    assert captured["payload"]["billing"] == {
        "feature_key": "freezone.video_enhance",
        "pricing_stages": [
            {
                "mode": "video_upscale",
                "catalog_id": "catalog-video_upscale",
                "resolution": "2k",
                "duration_seconds": 8,
            },
            {
                "mode": "video_frame_rate",
                "catalog_id": "catalog-video_frame_rate",
                "resolution": "2k",
                "duration_seconds": 40,
                "source_fps": 24.0,
                "target_fps": 60,
                "smart_interpolation": False,
                "slowdown": "5x",
            },
        ],
    }

    async def fake_quote(**kwargs):
        captured["quote_args"] = kwargs
        return SimpleNamespace(
            total_cost=24, display="24", original_total_cost=None,
            discount_amount=0, promotion=None,
        )

    from novelvideo import ports

    monkeypatch.setattr(
        ports, "get_credit_quote", lambda: SimpleNamespace(generation_credit_quote=fake_quote)
    )
    quote_result = await freezone_routes.freezone_video_upscale_quote(
        project=project,
        body=freezone_routes.FreezoneVideoUpscaleRequest(
            source_url="/static/admin/58/freezone/_uploads/clip.mp4",
            resolution="2k",
            target_fps=60,
            smart_interpolation=False,
            slowdown="5x",
            scene="anime",
            face_enhance=True,
        ),
        user={"username": username},
    )
    assert quote_result["data"]["cost"] == 24
    assert captured["quote_args"]["params"] == captured["payload"]["billing"]

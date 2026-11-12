from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

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

    async def fake_processing_model(mode: str, *, requester_user_id: str, scheme: str = "standard"):
        del requester_user_id
        return {
            "catalog_id": f"catalog-{mode}",
            "backend": f"newapi_{mode}",
            "model_params": {},
            "request_schema": {},
            "resolution_options": ["1080p", "2k", "4k"],
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


@pytest.mark.asyncio
async def test_video_upscale_probe_returns_user_scoped_model_resolutions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")

    async def fake_project(_project: str, _user: dict, *, required_role: str):
        assert required_role == "viewer"
        ctx = SimpleNamespace(requester_user_id="member-1")
        return ctx, "admin", "project", tmp_path, str(tmp_path)

    async def fake_catalog(media_type: str, *, requester_user_id: str):
        assert (media_type, requester_user_id) == ("video", "member-1")
        return [
            {"supportedModes": ["video_upscale"],
             "resolutionOptions": ["1080p", "4k"]},
            {"supportedModes": ["video_frame_rate"],
             "resolutionOptions": ["1080p", "2k"]},
        ]

    async def fake_probe(_source_path: str):
        return {"width": 1280, "height": 720, "fps": 24.0, "duration": 8.0}

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_project)
    monkeypatch.setattr(freezone_routes, "resolve_static_url_to_path", lambda *_: source)
    monkeypatch.setattr(freezone_routes, "_scoped_media_model_catalog", fake_catalog)
    monkeypatch.setattr(freezone_jobs, "probe_video_stream", fake_probe)

    result = await freezone_routes.freezone_video_upscale_probe(
        project="project", source_url="/static/source.mp4", user={"id": "member-1"},
    )

    assert result["data"]["upscale_resolutions"] == ["1080p", "4k"]
    assert result["data"]["frame_rate_resolutions"] == ["1080p", "2k"]


@pytest.mark.parametrize(
    ("target_fps", "upscale_options", "frame_rate_options", "expected_model"),
    [
        (None, ["1080p", "2k"], ["1080p", "2k", "4k"], "视频超分"),
        (60, ["1080p", "2k", "4k"], ["1080p", "2k"], "视频帧率调整"),
    ],
)
@pytest.mark.asyncio
async def test_video_upscale_quote_rejects_unavailable_model_resolution_before_billing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    target_fps: float | None,
    upscale_options: list[str],
    frame_rate_options: list[str],
    expected_model: str,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")

    async def fake_project(_project: str, _user: dict, *, required_role: str):
        assert required_role == "viewer"
        ctx = SimpleNamespace(requester_user_id="member-1")
        return ctx, "admin", "project", tmp_path, str(tmp_path)

    async def fake_probe(_source_path: str):
        return {"width": 1280, "height": 720, "fps": 24.0, "duration": 8.0}

    async def fake_model(mode: str, *, requester_user_id: str, scheme: str = "standard"):
        assert requester_user_id == "member-1"
        options = upscale_options if mode == "video_upscale" else frame_rate_options
        return {"catalog_id": mode, "backend": mode, "model_params": {},
                "request_schema": {}, "resolution_options": options}

    async def unexpected_quote(**_kwargs):
        pytest.fail("unsupported resolution must be rejected before billing")

    from novelvideo import ports

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_project)
    monkeypatch.setattr(freezone_routes, "resolve_static_url_to_path", lambda *_: source)
    monkeypatch.setattr(freezone_routes, "_resolve_video_processing_model", fake_model)
    monkeypatch.setattr(freezone_jobs, "probe_video_stream", fake_probe)
    monkeypatch.setattr(
        ports, "get_credit_quote",
        lambda: SimpleNamespace(generation_credit_quote=unexpected_quote),
    )

    with pytest.raises(HTTPException, match=f"当前{expected_model}模型不支持 4k 分辨率"):
        await freezone_routes.freezone_video_upscale_quote(
            project="project",
            body=freezone_routes.FreezoneVideoUpscaleRequest(
                source_url="/static/source.mp4", resolution="4k", target_fps=target_fps,
            ),
            user={"id": "member-1"},
        )


@pytest.mark.parametrize("slowdown,target_fps", [("auto", None), ("auto", 16), ("auto", 60), ("auto", 90), ("auto", 120), ("2x", 60)])
async def test_topaz_uses_native_interpolation_without_standard_or_local_slowdown(
    tmp_path, monkeypatch, slowdown, target_fps,
):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    calls = []

    async def probe(*args, **kwargs):
        return {"width": 1280, "height": 720, "fps": 24.0, "duration": 10.0}

    async def model(**kwargs):
        calls.append(kwargs)
        kwargs["output_path"].write_bytes(b"output")

    async def slow(*args, **kwargs):
        pytest.fail("Topaz must not use code slowdown")

    monkeypatch.setattr(freezone_jobs, "probe_video_stream", probe)
    monkeypatch.setattr(freezone_jobs, "_run_video_processing_model", model)
    monkeypatch.setattr(freezone_jobs, "_slow_video", slow)
    output, meta = await freezone_jobs.run_freezone_video_upscale(
        project_dir=tmp_path, job_id="topaz", source_path=str(source),
        resolution="1080p", target_fps=target_fps, slowdown=slowdown,
        upscale_backend="newapi_topaz-video-upscale",
        frame_rate_backend="newapi_topaz-video-frame-rate",
    )
    assert output.exists()
    separate = slowdown != "auto" or (target_fps is not None and target_fps > 60)
    assert len(calls) == (2 if separate else 1)
    assert "scene" not in calls[0]["processing_metadata"]
    if separate:
        assert calls[0]["processing_metadata"] == {}
        assert calls[1]["processing_metadata"]["slowdown"] == slowdown
        assert calls[1]["duration"] == 10
        assert calls[1]["processing_metadata"]["target_fps"] == target_fps
    elif target_fps:
        assert calls[0]["processing_metadata"] == {"target_fps": target_fps}
    assert meta["stages"] == len(calls)


def test_enhancement_catalog_keeps_families_separate():
    catalog = [
        {"id": "topaz", "apiModel": "newapi_topaz-video-upscale", "supportedModes": ["video_upscale"]},
        {"id": "original", "apiModel": "newapi_video-super-resolution", "supportedModes": ["video_upscale"]},
    ]
    assert freezone_routes._video_processing_entry(catalog, "video_upscale", "topaz")["id"] == "topaz"
    assert freezone_routes._video_processing_entry(catalog, "video_upscale", "standard")["id"] == "original"


def test_topaz_quote_has_same_fps_and_duration_as_execution():
    request = freezone_routes.FreezoneVideoUpscaleRequest(
        source_url="/source.mp4", enhancement_model="topaz", target_fps=60, slowdown="2x",
    )
    billing = freezone_routes._video_enhance_billing(
        request, {"duration": 10, "fps": 24},
        {"catalog_id": "topaz-up"}, {"catalog_id": "topaz-fps"},
    )
    stages = billing["pricing_stages"]
    assert stages[0]["duration_seconds"] == 10
    assert stages[0]["output_fps"] == 24
    assert stages[1]["duration_seconds"] == 20
    assert stages[1]["target_fps"] == 60
    assert all(s["enhancement_model"] == "topaz" for s in stages)


@pytest.mark.parametrize("slowdown,target_fps,expected_modes", [
    ("auto", 16, ["video_upscale"]), ("auto", 60, ["video_upscale"]),
    ("auto", 90, ["video_upscale", "video_frame_rate"]),
    ("auto", 120, ["video_upscale", "video_frame_rate"]),
    ("2x", 60, ["video_upscale", "video_frame_rate"]),
])
async def test_prepare_topaz_selects_matching_catalog_stages(tmp_path, monkeypatch, slowdown, target_fps, expected_modes):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    selected = []

    async def probe(*args, **kwargs):
        return {"width": 1280, "height": 720, "fps": 24.0, "duration": 10.0}

    async def resolve(mode, *, requester_user_id, scheme):
        assert scheme == "topaz"
        assert requester_user_id == "user"
        selected.append(mode)
        return {"catalog_id": mode, "backend": "topaz", "model_params": {},
                "request_schema": {}, "resolution_options": ["1080p"]}

    monkeypatch.setattr(freezone_jobs, "probe_video_stream", probe)
    monkeypatch.setattr(freezone_routes, "resolve_static_url_to_path", lambda *args: source)
    monkeypatch.setattr(freezone_routes, "_resolve_video_processing_model", resolve)
    _source, _meta, _models, billing = await freezone_routes._prepare_video_upscale(
        body=freezone_routes.FreezoneVideoUpscaleRequest(
            source_url="source", enhancement_model="topaz", target_fps=target_fps, slowdown=slowdown,
        ),
        project_dir=tmp_path, requester_user_id="user",
    )
    assert selected == expected_modes
    stages = billing["pricing_stages"]
    assert [stage["mode"] for stage in stages] == expected_modes
    assert stages[0]["output_fps"] == (24 if len(stages) == 2 else target_fps)
    if len(stages) == 2:
        assert stages[1]["target_fps"] == target_fps
        assert stages[1]["duration_seconds"] == (20 if slowdown == "2x" else 10)


@pytest.mark.parametrize("target_fps,slowdown,source_fps", [
    (12, "auto", 24), (12, "2x", 24), (15, "auto", 24),
    (29.97, "auto", 24), (None, "2x", 12),
])
async def test_topaz_invalid_target_fps_rejected_before_model_submission(
    tmp_path, monkeypatch, target_fps, slowdown, source_fps,
):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    async def probe(*args, **kwargs):
        return {"width": 1280, "height": 720, "fps": source_fps, "duration": 10.0}
    async def unexpected_model(*args, **kwargs):
        pytest.fail("invalid FPS must fail before selecting or submitting paid models")
    monkeypatch.setattr(freezone_jobs, "probe_video_stream", probe)
    monkeypatch.setattr(freezone_routes, "resolve_static_url_to_path", lambda *args: source)
    monkeypatch.setattr(freezone_routes, "_resolve_video_processing_model", unexpected_model)
    with pytest.raises(HTTPException, match="16–120") as exc:
        await freezone_routes._prepare_video_upscale(
            body=freezone_routes.FreezoneVideoUpscaleRequest(
                source_url="source", enhancement_model="topaz",
                target_fps=target_fps, slowdown=slowdown,
            ), project_dir=tmp_path, requester_user_id="user",
        )
    assert exc.value.status_code == 400


async def test_topaz_high_fps_requires_apollo_before_paid_upscale(tmp_path, monkeypatch):
    source = tmp_path / 'source.mp4'
    source.write_bytes(b'source')

    async def probe(*args, **kwargs):
        return {'width': 1280, 'height': 720, 'fps': 24, 'duration': 10}

    async def unexpected_model(**kwargs):
        pytest.fail('missing Apollo must fail before paying for upscale')

    monkeypatch.setattr(freezone_jobs, 'probe_video_stream', probe)
    monkeypatch.setattr(freezone_jobs, '_run_video_processing_model', unexpected_model)
    with pytest.raises(RuntimeError, match='frame-rate model is not configured'):
        await freezone_jobs.run_freezone_video_upscale(
            project_dir=tmp_path, job_id='missing-apollo', source_path=str(source),
            resolution='1080p', target_fps=120,
            upscale_backend='newapi_topaz-video-upscale', frame_rate_backend=None,
        )

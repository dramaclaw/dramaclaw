from pathlib import Path

import pytest
from fastapi import HTTPException
from types import SimpleNamespace

from novelvideo.api.routes import freezone as routes


def test_project_media_rejects_other_project(tmp_path):
    with pytest.raises(HTTPException):
        routes._image_output_source(
            tmp_path,
            SimpleNamespace(project_id="mine"),
            "admin",
            "mine",
            "/static/projects/other/image.png",
        )


def test_project_media_rejects_traversal(tmp_path):
    with pytest.raises(HTTPException):
        routes._image_output_source(
            tmp_path,
            SimpleNamespace(project_id="mine"),
            "admin",
            "mine",
            "/static/projects/mine/../../secret.png",
        )


def test_dedicated_animation_schema():
    from novelvideo.api.schemas import (
        FreezoneImageAnimateRequest,
        FreezoneVideoGenRequest,
    )

    assert FreezoneImageAnimateRequest(image_url="/image").canvas_id == ""
    assert "image_animate_gif" not in FreezoneVideoGenRequest.model_fields


@pytest.mark.asyncio
async def test_gif_missing_source(tmp_path):
    from novelvideo.freezone.image_outputs import transcode_gif

    with pytest.raises(ValueError):
        await transcode_gif(tmp_path / "missing.mp4", tmp_path / "result.gif")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("ratio_config", "expected_ratio"),
    [
        ({"ratioOptions": ["16:9", "4:3", "1:1", "3:4", "9:16"]}, "1:1"),
        ({}, "1:1"),
        ({"ratioOptions": ["9:16"]}, "9:16"),
        ({"ratioOptions": []}, "auto"),
        ({"ratioOptions": ["auto"]}, "auto"),
    ],
)
async def test_animate_uses_locked_frame_and_requests_gif(
    monkeypatch, tmp_path, ratio_config, expected_ratio
):
    from novelvideo.api.schemas import FreezoneImageAnimateRequest
    from PIL import Image

    source = tmp_path / "image.png"
    Image.new("RGB", (320, 320), "orange").save(source)
    ctx = SimpleNamespace(project_id="mine", requester_user_id="admin")

    async def project(*a, **kw):
        return ctx, "admin", "mine", tmp_path, str(tmp_path)

    async def backend(*a, **kw):
        return "newapi"

    async def catalog(*a, **kw):
        # Default EE Seedance Fast runtime projection: ratioOptions is absent.
        return [
            {
                "id": "newapi_seedance-2.0-fast",
                "apiModel": "newapi_seedance-2.0-fast",
                "gatewayModel": "seedance-2.0-fast",
                "catalogId": "ee-seedance-fast",
                "request": {"endpoint": "video/generations", "parameters": []},
                "supportedModes": [
                    "text_to_video", "first_frame", "first_last_frame", "all_reference"
                ],
                "minDuration": 4,
                "maxDuration": 15,
                "resolutionOptions": ["480p", "720p"],
                "humanReview": True,
                **ratio_config,
            },
        ]

    from novelvideo import model_gateway_settings

    def forbidden_cache():
        pytest.fail("image animation must not read the mutable CE catalog cache")

    monkeypatch.setattr(model_gateway_settings, "_effective_official_media_catalog", forbidden_cache)
    monkeypatch.setattr(model_gateway_settings, "_official_media_catalog_cache_path", forbidden_cache)

    captured = {}

    async def enqueue(**kw):
        captured.update(kw)
        return {"ok": True}

    monkeypatch.setattr(routes, "_resolve_freezone_project", project)
    monkeypatch.setattr(routes, "_resolve_catalog_video_backend", backend)
    monkeypatch.setattr(routes, "_scoped_media_model_catalog", catalog)
    monkeypatch.setattr(routes, "_start_or_enqueue_freezone_video_gen", enqueue)
    await routes.freezone_image_animate(
        "mine",
        FreezoneImageAnimateRequest(image_url="/static/projects/mine/image.png"),
        {},
    )
    assert captured["image_animate_gif"] is True
    assert captured["reference_items"] == [
        {"type": "image", "path": str(source.resolve()), "role": "首帧"}
    ]
    assert captured["generate_audio"] is False
    assert captured["duration_seconds"] == 4
    assert captured["gen_mode"] == "first_last_frame"
    assert captured["aspect_ratio"] == expected_ratio
    from novelvideo.generators.video_generator import NewApiVideoGenerator
    from novelvideo.media_model_request_schema import enforce_newapi_media_geometry_contract

    metadata = {"resolution": "720p", "ratio": captured["aspect_ratio"]}
    payload = {"model": "seedance-2.0-fast", "seconds": "4", "metadata": metadata}
    NewApiVideoGenerator._canonicalize_video_payload(payload, metadata)
    wire_payload = enforce_newapi_media_geometry_contract(payload, media_type="video")
    assert wire_payload["metadata"]["ratio"] == expected_ratio
    if expected_ratio == "1:1":
        assert wire_payload["width"] == wire_payload["height"]


@pytest.mark.parametrize(
    "capabilities",
    [None, {"gatewayModel": "custom-video-model"}, {"ratioOptions": None}],
)
def test_image_animation_does_not_invent_unknown_or_explicit_capabilities(capabilities):
    assert routes._image_animate_ratio_options(
        "newapi_seedance-2.0-fast", capabilities
    ) is None


def test_local_conversion_queue_placement():
    from novelvideo.task_backend.runners import freezone  # noqa: F401 -- registers conversion runners
    from novelvideo.task_backend.registry import (
        project_task_lane,
        project_task_requires_home_node,
    )

    for task in ("freezone_image_animate_gif", "freezone_image_vectorize"):
        assert project_task_lane(task) == "ffmpeg"
        assert project_task_requires_home_node(task) is (task == "freezone_image_vectorize")


@pytest.mark.asyncio
async def test_real_ffmpeg_gif(tmp_path):
    import shutil
    import subprocess
    from novelvideo.freezone.image_outputs import transcode_gif
    from PIL import Image

    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg unavailable")
    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x64:d=0.4",
            "-y",
            str(source),
        ],
        check=True,
    )
    output = await transcode_gif(source, tmp_path / "result.gif")
    with Image.open(output) as image:
        assert image.format == "GIF"
        assert image.width == 480


@pytest.mark.asyncio
async def test_conversion_timeout_kills_process_and_cleans_output(tmp_path):
    import sys
    from novelvideo.freezone.image_outputs import _convert
    import asyncio

    output = tmp_path / "partial.gif"
    temporary = tmp_path / "partial.partial.gif"
    temporary.write_bytes(b"partial")
    with pytest.raises(asyncio.TimeoutError):
        await _convert(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            output,
            timeout=0.05,
            max_bytes=100,
        )
    assert not output.exists()
    assert not temporary.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("queue_fails", [False, True])
async def test_video_completion_schedules_gif_without_losing_paid_video(
    monkeypatch, tmp_path, queue_fails, caplog
):
    from novelvideo.task_backend.runners import video
    from novelvideo.freezone import jobs
    from novelvideo.task_backend import client

    ctx = SimpleNamespace(output_dir=tmp_path, project_id="mine")
    source = tmp_path / "video.mp4"
    source.write_bytes(b"video")

    async def generate(**kwargs):
        return source

    captured = {}

    async def enqueue(ctx, **kwargs):
        captured.update(kwargs)
        if queue_fails:
            raise RuntimeError("broker unavailable")
        return SimpleNamespace(queue="node.local.ffmpeg")

    monkeypatch.setattr(jobs, "run_freezone_video_gen", generate)
    monkeypatch.setattr(client, "enqueue_project_task", enqueue)
    monkeypatch.setattr(
        video,
        "get_task_manager",
        lambda: SimpleNamespace(update_progress_for_project=lambda *a, **kw: None),
    )
    monkeypatch.setattr(video, "_append_freezone_video_node_history", lambda **kw: None)
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda ctx, rel, **kw: "/static/projects/mine/" + rel,
    )
    result = await video._run_freezone_video_gen_async(
        {"payload": {"job_id": "job", "image_animate_gif": True}}, ctx
    )
    assert result["output_url"].endswith("video.mp4")
    assert captured["queue_kind"] == "ffmpeg"
    assert captured["task_type"] == "freezone_image_animate_gif"
    if queue_fails:
        assert result["gif_enqueue_error"]
        assert "automatic GIF dispatch failed" in caplog.text
        assert "video_job=job" in caplog.text
        assert "project=mine" in caplog.text
    else:
        assert result["gif_job_id"] == "job-gif"


@pytest.mark.asyncio
async def test_real_vectorize(tmp_path, monkeypatch):
    import os
    import shutil
    from PIL import Image
    from novelvideo.freezone.image_outputs import vectorize_image

    monkeypatch.setenv(
        "PATH", os.environ["PATH"] + ":" + str(Path.home() / ".cargo/bin")
    )
    if not shutil.which("vtracer"):
        pytest.skip("vtracer unavailable")
    source = tmp_path / "source.png"
    Image.new("RGB", (32, 32), "red").save(source)
    output = await vectorize_image(source, tmp_path / "result.svg")
    assert "<svg" in output.read_text()


@pytest.mark.asyncio
async def test_job_result_preserves_gif_child_reference(tmp_path, monkeypatch):
    ctx = SimpleNamespace(project_id="mine")

    async def project(*a, **kw):
        return ctx, "admin", "mine", tmp_path, str(tmp_path)

    out = tmp_path / "freezone/_outputs/freezone_video_gen/job.mp4"
    out.parent.mkdir(parents=True)
    out.write_bytes(b"video")
    task = SimpleNamespace(
        status="completed",
        result={
            "gif_job_id": "job-gif",
            "gif_task_type": "freezone_image_animate_gif",
            "gif_task_key": "child-key",
        },
    )
    monkeypatch.setattr(routes, "_resolve_freezone_project", project)
    monkeypatch.setattr(
        routes,
        "get_task_manager",
        lambda: SimpleNamespace(get_task_for_project=lambda *a, **kw: task),
    )
    monkeypatch.setattr(
        routes,
        "make_static_url_for_context",
        lambda ctx, rel, **kw: "/static/projects/mine/" + rel,
    )
    result = await routes.freezone_job_result("mine", "freezone_video_gen", "job", {})
    assert result["data"]["gif_job_id"] == "job-gif"
    assert result["data"]["gif_task_key"] == "child-key"


@pytest.mark.asyncio
async def test_gif_rejects_playlist_input(tmp_path):
    import shutil
    from novelvideo.freezone.image_outputs import transcode_gif

    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg unavailable")
    playlist = tmp_path / "source.m3u8"
    playlist.write_text(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/another-project/private.ts\n#EXT-X-ENDLIST\n"
    )
    output = tmp_path / "result.gif"
    with pytest.raises(RuntimeError):
        await transcode_gif(playlist, output)
    assert not output.exists()

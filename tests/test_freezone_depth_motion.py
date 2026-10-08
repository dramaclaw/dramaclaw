"""DA3 capture contract tests, independent of model weights/GPU."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import shutil
import subprocess
import sys
import types

import numpy as np
import pytest
from PIL import Image

from novelvideo.api import deps
from novelvideo.api.routes import freezone
from novelvideo.task_backend.runners import freezone as freezone_runner
from novelvideo.freezone.depth_motion import run_freezone_depth_motion_capture
from novelvideo.freezone.depth_motion_worker import (
    _align_overlap,
    _infer_frames,
    _scene_bounds,
    _stable_letterbox,
    _write_gray_frames,
    run as run_depth_worker,
)
from novelvideo.freezone.video_node import build_freezone_omni_video_prompt


def test_depth_direction_and_shot_normalization(tmp_path: Path) -> None:
    depth = np.array([[1, 2], [8, 9]], dtype=np.float32)
    _write_gray_frames([(0, 2, [depth, depth])], tmp_path,
                       width=4, height=4, source_height=4)
    with Image.open(tmp_path / "depth_000001.png") as image:
        gray = np.asarray(image)
    assert gray[0, 0] > gray[-1, -1]  # DA3 z-depth low=near -> white


def test_stable_black_borders_are_not_inferred_as_nearby_objects(tmp_path: Path) -> None:
    paths = []
    for index in range(3):
        pixels = np.full((12, 16, 3), 120, dtype=np.uint8)
        pixels[:2] = 0
        pixels[-2:] = 0
        path = tmp_path / f"rgb_{index}.png"
        Image.fromarray(pixels).save(path)
        paths.append(path)
    assert _stable_letterbox(paths) == (2, 2)
    _write_gray_frames([(0, 1, [np.ones((2, 2), dtype=np.float32)])],
                       tmp_path, width=16, height=12, source_height=12,
                       crop_top=2, crop_bottom=2)
    with Image.open(tmp_path / "depth_000001.png") as image:
        assert np.max(np.asarray(image)[:2]) == 0
        assert np.max(np.asarray(image)[-2:]) == 0


def test_window_overlap_alignment_and_cut_reset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import novelvideo.freezone.depth_motion_worker as worker

    paths = []
    for index in range(7):
        path = tmp_path / f"frame_{index}.png"
        Image.new("RGB", (8, 8), "white").save(path)
        paths.append(path)
    monkeypatch.setattr(worker, "_scene_bounds", lambda _paths: [(0, 5), (5, 7)])

    class FakeModel:
        def inference(self, images, **kwargs):
            del kwargs
            return SimpleNamespace(depth=np.stack([
                np.full((2, 2), int(Path(image).stem.split("_")[-1]) + 1,
                        dtype=np.float32)
                for image in images
            ]))

    shots = _infer_frames(FakeModel(), paths, chunk_size=3, overlap=1)
    assert [(start, end, len(depths)) for start, end, depths in shots] == [
        (0, 5, 5), (5, 7, 2),
    ]
    assert _align_overlap([np.array([[2, 3]])], [np.array([[5, 7]])])[0] > 0


def test_hard_cut_detector_does_not_split_same_image(tmp_path: Path) -> None:
    frames = []
    for index, color in enumerate(("white", "white", "black")):
        path = tmp_path / f"{index}.png"
        Image.new("RGB", (16, 16), color).save(path)
        frames.append(path)
    assert _scene_bounds(frames) == [(0, 2), (2, 3)]


@pytest.mark.asyncio
async def test_capture_requires_local_model_before_spawning_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ST_DA3_MODEL_DIR", raising=False)
    with pytest.raises(RuntimeError, match="ST_DA3_MODEL_DIR"):
        await run_freezone_depth_motion_capture(
            project_dir=tmp_path, job_id="job", source_path="unused.mp4", resolution="720p"
        )


@pytest.mark.asyncio
async def test_depth_route_uses_project_scope_and_world_lane(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"mp4")
    ctx = SimpleNamespace(project_id="project-1")
    captured = {}

    async def resolve(*args, **kwargs):
        return ctx, "user", "project-1", tmp_path, tmp_path

    async def enqueue(ctx_, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(backend="inline", queue="world",
                               task_state=SimpleNamespace(task_id="task-1"))

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(freezone, "resolve_static_url_to_path", lambda url, directory: source)
    monkeypatch.setattr(freezone, "_new_job_id", lambda: "job-1")
    monkeypatch.setattr(freezone, "get_task_backend",
                        lambda: SimpleNamespace(enqueue_project_task=enqueue))
    response = await freezone.freezone_depth_motion_capture(
        "project-1", freezone.FreezoneDepthMotionCaptureRequest(
            source_url="/static/projects/project-1/source.mp4", resolution="480p"
        ), user={"username": "user"},
    )
    assert response["data"]["task_type"] == "freezone_depth_motion"
    assert captured["queue_kind"] == "world"
    assert captured["payload"]["source_path"] == source.as_posix()
    assert captured["payload"]["resolution"] == "480p"


def test_depth_role_is_a_structural_reference_not_a_grayscale_style() -> None:
    prompt = build_freezone_omni_video_prompt(
        user_prompt="舞者转身",
        reference_items=[{"type": "video", "role": "depth_motion"}],
    )
    assert "近白远黑" in prompt
    assert "不把灰度纹理" in prompt


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
                    reason="FFmpeg is required for the media integration fixture")
def test_worker_preserves_cfr_frame_count_without_model_weights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fake only ML; exercise real FFmpeg decode → grayscale encode and manifest."""
    source = tmp_path / "three-frames.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "color=c=white:s=16x12:r=25", "-frames:v", "3",
        "-c:v", "libx264", str(source),
    ], check=True)

    class FakeModel:
        @classmethod
        def from_pretrained(cls, path):
            assert path == str(tmp_path)
            return cls()

        def to(self, **kwargs):
            assert kwargs["device"] == "cuda"
            return self

        def eval(self):
            return self

        def inference(self, images, **kwargs):
            assert kwargs["process_res"] == 504
            gradient = np.tile(np.linspace(1, 9, 4, dtype=np.float32), (4, 1))
            return SimpleNamespace(depth=np.stack([gradient] * len(images)))

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: True)
    fake_package = types.ModuleType("depth_anything_3")
    fake_api = types.ModuleType("depth_anything_3.api")
    fake_api.DepthAnything3 = FakeModel
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "depth_anything_3", fake_package)
    monkeypatch.setitem(sys.modules, "depth_anything_3.api", fake_api)
    output = tmp_path / "captured.mp4"
    meta = run_depth_worker(
        source=source, output=output, model_dir=tmp_path, resolution="480p"
    )
    assert output.is_file()
    assert meta["frame_count"] == 3
    assert meta["fps"] == "25/1"
    assert meta["polarity"] == "near_white_far_black"
    assert output.with_suffix(".json").is_file()


@pytest.mark.asyncio
async def test_runner_returns_project_urls_without_exposing_filesystem_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = tmp_path / "freezone" / "_outputs" / "freezone_depth_motion" / "job-1.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"video")
    output.with_suffix(".json").write_text("{}", encoding="utf-8")

    async def fake_capture(**kwargs):
        assert kwargs["resolution"] == "720p"
        return output, {"model": "DA3-SMALL"}

    import novelvideo.freezone.depth_motion as depth_module

    monkeypatch.setattr(depth_module, "run_freezone_depth_motion_capture", fake_capture)
    monkeypatch.setattr(freezone_runner, "_update", lambda *args, **kwargs: None)
    monkeypatch.setattr(deps, "make_static_url_for_context",
                        lambda ctx, relative: f"/static/projects/{ctx.project_id}/{relative}")
    ctx = SimpleNamespace(project_id="project-1", output_dir=tmp_path)
    result = await freezone_runner._run_freezone_depth_motion_async(
        {"payload": {"job_id": "job-1", "project_dir": str(tmp_path),
                     "source_path": str(tmp_path / "source.mp4"), "resolution": "720p"}},
        ctx,
    )
    assert result["url"].endswith("/job-1.mp4")
    assert result["manifest_url"].endswith("/job-1.json")
    assert "output_path" not in result


@pytest.mark.asyncio
async def test_result_endpoint_returns_manifest_and_capture_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = tmp_path / "freezone" / "_outputs" / "freezone_depth_motion" / "job-1.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"video")
    output.with_suffix(".json").write_text(
        '{"model":"DA3-SMALL","frame_count":200}', encoding="utf-8"
    )
    ctx = SimpleNamespace(project_id="project-1")

    async def resolve(*args, **kwargs):
        return ctx, "user", "project-1", tmp_path, tmp_path

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(freezone, "get_task_manager", lambda: SimpleNamespace(
        get_task_for_project=lambda *args, **kwargs: SimpleNamespace(status="completed")
    ))
    monkeypatch.setattr(freezone, "make_static_url_for_context",
                        lambda ctx_, relative: f"/static/projects/{ctx_.project_id}/{relative}")
    response = await freezone.freezone_job_result(
        "project-1", "freezone_depth_motion", "job-1", user={"username": "user"}
    )
    assert response["ok"] is True
    assert response["data"]["manifest_url"].endswith("/job-1.json")
    assert response["data"]["meta"]["frame_count"] == 200

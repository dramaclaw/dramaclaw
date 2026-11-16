from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.task_backend.cancel import TaskCancelled


class _FakeTaskManager:
    def __init__(self) -> None:
        self.updates: list[tuple[tuple, dict]] = []

    def update_progress_for_project(self, *args, **kwargs):
        self.updates.append((args, kwargs))


def _ctx(tmp_path: Path):
    return SimpleNamespace(project_id="proj_cancel", output_dir=tmp_path)


def _write_beat_video(project_dir: Path, episode: int, beat_num: int) -> None:
    video_dir = project_dir / "videos" / "beats" / f"ep{episode:03d}"
    video_dir.mkdir(parents=True, exist_ok=True)
    (video_dir / f"beat_{beat_num:02d}.mp4").write_bytes(b"video")


def test_stage_asset_checks_cancel_after_local_runner_returns(tmp_path, monkeypatch):
    from novelvideo.task_backend.runners import stage_asset

    check_count = 0

    def fake_check(*_args, **_kwargs):
        nonlocal check_count
        check_count += 1
        if check_count >= 2:
            raise TaskCancelled()

    monkeypatch.setattr(stage_asset, "raise_if_envelope_cancel_requested", fake_check)
    monkeypatch.setattr(stage_asset, "get_task_manager", lambda: _FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.stage_asset_tasks.upload_scene_package",
        lambda *_args, **_kwargs: {"ok": True},
    )

    with pytest.raises(TaskCancelled):
        stage_asset.run_stage_asset(
            {
                "__run_task_id": "task_1",
                "project_id": "proj_cancel",
                "scope": "scene_pkg",
                "payload": {
                    "scene_name": "Hall",
                    "step": "upload_scene_package",
                    "params": {"src_asset": str(tmp_path / "package.zip")},
                    "project_dir": str(tmp_path),
                },
            },
            _ctx(tmp_path),
        )


def test_freezone_image_to_3gs_checks_cancel_before_publishing_result(tmp_path, monkeypatch):
    from novelvideo.task_backend.runners import stage_asset

    source = tmp_path / "source.png"
    source.write_bytes(b"image")
    sog = tmp_path / "freezone" / "_outputs" / "freezone_image_to_3gs" / "job_1" / "scene.sog"
    sog.parent.mkdir(parents=True, exist_ok=True)
    sog.write_bytes(b"sog")
    check_count = 0

    def fake_check(*_args, **_kwargs):
        nonlocal check_count
        check_count += 1
        if check_count >= 2:
            raise TaskCancelled()

    monkeypatch.setattr(stage_asset, "raise_if_envelope_cancel_requested", fake_check)
    monkeypatch.setattr(stage_asset, "get_task_manager", lambda: _FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.stage_asset_tasks.run_single_face_sharp",
        lambda *_args, **_kwargs: {"ply_path": str(sog), "sog_path": str(sog)},
    )

    with pytest.raises(TaskCancelled):
        stage_asset.run_freezone_image_to_3gs(
            {
                "__run_task_id": "task_1",
                "project_id": "proj_cancel",
                "scope": "job_1",
                "payload": {
                    "job_id": "job_1",
                    "scene_id": "scene_a",
                    "source_path": str(source),
                    "source_kind": "master",
                    "project_dir": str(tmp_path),
                    "canvas_id": "canvas_a",
                    "node_id": "node_a",
                },
            },
            _ctx(tmp_path),
        )


def test_stage_asset_caps_local_runner_timeout_to_task_deadline(tmp_path, monkeypatch):
    import time

    from novelvideo.task_backend.runners import stage_asset

    captured: dict[str, int] = {}

    def fake_run_pano_sharp(*_args, **kwargs):
        captured["timeout_seconds"] = kwargs["timeout_seconds"]
        return {"ok": True}

    monkeypatch.setattr(stage_asset, "get_task_manager", lambda: _FakeTaskManager())
    monkeypatch.setattr(stage_asset, "raise_if_envelope_cancel_requested", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("novelvideo.stage_asset_tasks.run_pano_sharp", fake_run_pano_sharp)

    stage_asset.run_stage_asset(
        {
            "__run_task_id": "task_1",
            "__deadline_monotonic": time.monotonic() + 120,
            "__timeout_seconds": 30 * 60,
            "project_id": "proj_cancel",
            "scope": "scene_pkg",
            "payload": {
                "scene_name": "Hall",
                "step": "pano_sharp",
                "params": {"timeout_seconds": 7200},
                "project_dir": str(tmp_path),
            },
        },
        _ctx(tmp_path),
    )

    assert 1 <= captured["timeout_seconds"] <= 120


def test_compose_episode_checks_cancel_after_final_ffmpeg_returns(tmp_path, monkeypatch):
    from novelvideo.task_backend.runners import video

    _write_beat_video(tmp_path, episode=1, beat_num=1)
    cancel_after_final = False

    def fake_check(*_args, **_kwargs):
        if cancel_after_final:
            raise TaskCancelled()

    def fake_run(cmd, **_kwargs):
        nonlocal cancel_after_final
        if cmd[0] == "ffprobe":
            if "stream=duration" in cmd:
                return SimpleNamespace(returncode=0, stdout="1.0\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="0\n", stderr="")
        if cmd[0] == "ffmpeg" and "ep001_final.mp4" in cmd[-1]:
            cancel_after_final = True
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(video, "raise_if_envelope_cancel_requested", fake_check)
    monkeypatch.setattr(video, "get_task_manager", lambda: _FakeTaskManager())
    monkeypatch.setattr(video, "run_project_subprocess", fake_run)

    with pytest.raises(TaskCancelled):
        video.run_compose_episode(
            {
                "__run_task_id": "task_1",
                "project_id": "proj_cancel",
                "episode": 1,
                "payload": {
                    "output_dir": str(tmp_path),
                    "beats": [{"beat_number": 1}],
                },
            },
            _ctx(tmp_path),
        )


def test_compose_episode_passes_deadline_timeout_to_ffmpeg(tmp_path, monkeypatch):
    import time

    from novelvideo.task_backend.runners import video

    _write_beat_video(tmp_path, episode=1, beat_num=1)
    timeouts: list[int | None] = []

    def fake_run(cmd, **kwargs):
        timeouts.append(kwargs.get("timeout"))
        if cmd[0] == "ffprobe":
            if "stream=duration" in cmd:
                return SimpleNamespace(returncode=0, stdout="1.0\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(video, "get_task_manager", lambda: _FakeTaskManager())
    monkeypatch.setattr(
        video,
        "raise_if_envelope_cancel_requested",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(video, "run_project_subprocess", fake_run)

    video.run_compose_episode(
        {
            "__run_task_id": "task_1",
            "__deadline_monotonic": time.monotonic() + 120,
            "__timeout_seconds": 30 * 60,
            "project_id": "proj_cancel",
            "episode": 1,
            "payload": {
                "output_dir": str(tmp_path),
                "beats": [{"beat_number": 1}],
            },
        },
        _ctx(tmp_path),
    )

    assert timeouts
    assert all(timeout is not None and 1 <= timeout <= 120 for timeout in timeouts)


def test_video_ffprobe_timeout_maps_to_task_timeout(monkeypatch, tmp_path):
    import subprocess

    from novelvideo.task_backend.cancel import TaskTimedOut
    from novelvideo.task_backend.runners import video

    media = tmp_path / "beat.mp4"
    media.write_bytes(b"video")

    def fake_run(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="ffprobe", timeout=1)

    monkeypatch.setattr(video, "run_project_subprocess", fake_run)

    with pytest.raises(TaskTimedOut):
        video._audio_duration(media, timeout_seconds=1)

    with pytest.raises(TaskTimedOut):
        video._video_has_audio_stream(media, timeout_seconds=1)

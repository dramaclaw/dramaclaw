from types import SimpleNamespace

import pytest


pytestmark = pytest.mark.m09


class _FakeTaskManager:
    def __init__(self):
        self.updates = []

    def update_progress_for_project(self, *args, **kwargs):
        self.updates.append((args, kwargs))


def _ctx(tmp_path):
    return SimpleNamespace(output_dir=tmp_path)


def _write_beat_video(project_dir, episode: int, beat_num: int) -> None:
    video_dir = project_dir / "videos" / "beats" / f"ep{episode:03d}"
    video_dir.mkdir(parents=True)
    (video_dir / f"beat_{beat_num:02d}.mp4").write_bytes(b"video")


def test_compose_episode_preserves_embedded_audio_when_no_external_mp3(
    monkeypatch,
    tmp_path,
):
    from novelvideo.task_backend.runners import video

    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    def fake_run(cmd, **_kwargs):
        commands.append(cmd)
        if cmd[0] == "ffprobe":
            return SimpleNamespace(returncode=0, stdout="0\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(video, "get_task_manager", lambda: manager)
    monkeypatch.setattr(video, "run_project_subprocess", fake_run)

    result = video.run_compose_episode(
        {
            "episode": 1,
            "payload": {
                "output_dir": str(tmp_path),
                "beats": [{"beat_number": 3}],
            },
        },
        _ctx(tmp_path),
    )

    clip_cmd = next(cmd for cmd in commands if cmd[0] == "ffmpeg" and "beat_0003.mp4" in cmd[-1])
    assert result["video_path"].endswith("videos/episodes/ep001_final.mp4")
    assert "anullsrc=r=44100:cl=stereo" not in clip_cmd
    assert clip_cmd[clip_cmd.index("-map") + 1] == "0:v:0"
    assert "0:a:0" in clip_cmd
    assert any(
        "使用视频内置音轨" in line
        for _args, kwargs in manager.updates
        for line in kwargs.get("logs", [])
    )


@pytest.mark.parametrize(
    ("audio_source", "audio_duration"),
    [("external", 0.4), ("embedded", 0.4), ("external", 1.6), ("embedded", 1.6), ("none", 0)],
)
def test_compose_episode_preserves_video_tail_and_bounds_audio(
    monkeypatch, tmp_path, audio_source, audio_duration
):
    import array
    import math
    import shutil
    import subprocess
    from pathlib import Path

    from novelvideo.task_backend.runners import video
    from novelvideo.utils.path_resolver import PathResolver

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg and ffprobe are required for media composition")

    def ffmpeg(*args, input_bytes=None):
        return subprocess.run(
            ["ffmpeg", "-v", "error", "-y", *map(str, args)],
            input=input_bytes,
            capture_output=True,
            check=True,
            timeout=30,
        ).stdout

    paths = PathResolver(str(tmp_path), 1)
    for beat_num, initial_gray in [(1, 40), (2, 109)]:
        target = paths.video(beat_num)
        target.parent.mkdir(parents=True, exist_ok=True)
        raw_frames = b"".join(
            bytes([initial_gray + frame * 3]) * 64 * 64 * 3 for frame in range(24)
        )
        audio_args = []
        if beat_num == 1 and audio_source == "embedded":
            audio_args = [
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency=440:duration={audio_duration}",
                "-c:a",
                "aac",
            ]
        ffmpeg(
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgb24",
            "-video_size",
            "64x64",
            "-framerate",
            "24",
            "-i",
            "pipe:0",
            *audio_args,
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-pix_fmt",
            "yuv420p",
            target,
            input_bytes=raw_frames,
        )
    if audio_source == "external":
        paths.audio(1).parent.mkdir(parents=True)
        ffmpeg(
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={audio_duration}",
            "-c:a",
            "libmp3lame",
            paths.audio(1),
        )
    monkeypatch.setattr(video, "get_task_manager", lambda: _FakeTaskManager())
    result = video.run_compose_episode(
        {
            "episode": 1,
            "payload": {
                "output_dir": str(tmp_path),
                "beats": [{"beat_number": 1}, {"beat_number": 2}],
                "resolution": "64x64",
            },
        },
        _ctx(tmp_path),
    )
    output = Path(result["video_path"])
    pixels = ffmpeg(
        "-i",
        output,
        "-vf",
        "scale=1:1",
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        "gray",
        "-f",
        "rawvideo",
        "pipe:1",
    )
    assert len(pixels) == 48
    assert pixels[23] == pytest.approx(109, abs=3)
    assert pixels[24] == pytest.approx(109, abs=3)
    assert pixels[-1] == pytest.approx(178, abs=3)

    samples = array.array("h")
    samples.frombytes(
        ffmpeg("-i", output, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1")
    )

    def rms(start, end):
        window = samples[int(start * 8000) : int(end * 8000)]
        assert len(window) == round((end - start) * 8000)
        return math.sqrt(sum(value * value for value in window) / len(window))

    assert 2 <= len(samples) / 8000 < 2.1
    if audio_source == "none":
        assert rms(0.1, 0.3) < 10
    else:
        assert rms(0.1, 0.3) > 100
    if audio_duration < 1:
        assert rms(0.6, 0.8) < 10
    else:
        assert rms(0.6, 0.8) > 100
    assert rms(1.2, 1.4) < 10

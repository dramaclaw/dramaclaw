"""run_compose_episode 的可选整集配乐步骤（Sonilo video-to-music）。"""

from pathlib import Path
from types import SimpleNamespace

import pytest


pytestmark = pytest.mark.m09


class _FakeTaskManager:
    def __init__(self):
        self.updates = []

    def update_progress_for_project(self, *args, **kwargs):
        self.updates.append((args, kwargs))

    def logs(self) -> list[str]:
        return [
            line
            for _args, kwargs in self.updates
            for line in kwargs.get("logs", [])
        ]


class _FakeSoniloClient:
    """写出一个假 .m4a，并记录调用参数。"""

    calls: list[dict] = []

    def generate_soundtrack(self, video_path, output_path, *, prompt=""):
        _FakeSoniloClient.calls.append(
            {"video_path": video_path, "output_path": output_path, "prompt": prompt}
        )
        Path(output_path).write_bytes(b"m4a")
        return output_path


class _ExplodingSoniloClient:
    def generate_soundtrack(self, video_path, output_path, *, prompt=""):
        raise RuntimeError("boom")


def _ctx(tmp_path):
    return SimpleNamespace(output_dir=tmp_path)


def _write_beat_video(project_dir, episode: int, beat_num: int) -> None:
    video_dir = project_dir / "videos" / "beats" / f"ep{episode:03d}"
    video_dir.mkdir(parents=True)
    (video_dir / f"beat_{beat_num:02d}.mp4").write_bytes(b"video")


def _fake_run(commands, *, episode_duration="120.0"):
    """伪造 run_project_subprocess：ffmpeg 落盘输出文件，ffprobe 按查询返回。"""

    def run(cmd, **_kwargs):
        commands.append(cmd)
        if cmd[0] == "ffprobe":
            if "-select_streams" in cmd:
                return SimpleNamespace(returncode=0, stdout="0\n", stderr="")
            return SimpleNamespace(returncode=0, stdout=f"{episode_duration}\n", stderr="")
        output = Path(cmd[-1])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"video")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    return run


def _run_compose(monkeypatch, tmp_path, manager, commands, **fake_run_kwargs):
    from novelvideo.task_backend.runners import video

    monkeypatch.setattr(video, "get_task_manager", lambda: manager)
    monkeypatch.setattr(
        video, "run_project_subprocess", _fake_run(commands, **fake_run_kwargs)
    )
    return video.run_compose_episode(
        {
            "episode": 1,
            "payload": {
                "output_dir": str(tmp_path),
                "beats": [{"beat_number": 3}],
            },
        },
        _ctx(tmp_path),
    )


def _enable_sonilo(monkeypatch, **overrides):
    values = {
        "EPISODE_SOUNDTRACK_PROVIDER": "sonilo",
        "SONILO_API_KEY": "test-key",
        "EPISODE_SOUNDTRACK_MODE": "mix",
        "EPISODE_SOUNDTRACK_MUSIC_VOLUME": 0.35,
        "EPISODE_SOUNDTRACK_PROMPT": "",
    }
    values.update(overrides)
    for name, value in values.items():
        monkeypatch.setattr(f"novelvideo.config.{name}", value)
    _FakeSoniloClient.calls = []
    monkeypatch.setattr(
        "novelvideo.audio.sonilo_soundtrack.SoniloSoundtrackClient",
        _FakeSoniloClient,
    )


def test_soundtrack_disabled_by_default(monkeypatch, tmp_path):
    monkeypatch.setattr("novelvideo.config.EPISODE_SOUNDTRACK_PROVIDER", "")
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    assert result["video_path"].endswith("videos/episodes/ep001_final.mp4")
    assert "episode_soundtrack" not in result
    assert not any("配乐" in line for line in manager.logs())


def test_soundtrack_skipped_without_api_key(monkeypatch, tmp_path):
    _enable_sonilo(monkeypatch, SONILO_API_KEY="")
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    assert result["episode_soundtrack"]["applied"] is False
    assert _FakeSoniloClient.calls == []
    assert any("未配置 SONILO_API_KEY" in line for line in manager.logs())


def test_soundtrack_mix_lays_track_over_final_video(monkeypatch, tmp_path):
    _enable_sonilo(monkeypatch, EPISODE_SOUNDTRACK_PROMPT="悬疑")
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    assert result["episode_soundtrack"]["applied"] is True
    assert result["episode_soundtrack"]["mode"] == "mix"
    assert len(_FakeSoniloClient.calls) == 1
    assert _FakeSoniloClient.calls[0]["prompt"] == "悬疑"
    assert str(_FakeSoniloClient.calls[0]["video_path"]).endswith("ep001_final.mp4")

    mux_cmd = next(
        cmd
        for cmd in commands
        if cmd[0] == "ffmpeg" and "ep001_soundtrack.m4a" in " ".join(cmd)
    )
    filter_arg = mux_cmd[mux_cmd.index("-filter_complex") + 1]
    assert "amix=inputs=2" in filter_arg
    assert "volume=0.35" in filter_arg
    # 成片路径不变，配乐直接合入 ep001_final.mp4。
    assert result["video_path"].endswith("videos/episodes/ep001_final.mp4")
    assert any("整集配乐已合入成片" in line for line in manager.logs())


def test_soundtrack_replace_mode_swaps_audio_track(monkeypatch, tmp_path):
    _enable_sonilo(monkeypatch, EPISODE_SOUNDTRACK_MODE="replace")
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    assert result["episode_soundtrack"]["mode"] == "replace"
    mux_cmd = next(
        cmd
        for cmd in commands
        if cmd[0] == "ffmpeg" and "ep001_soundtrack.m4a" in " ".join(cmd)
    )
    assert "-filter_complex" not in mux_cmd
    assert mux_cmd[mux_cmd.index("-map") + 1] == "0:v:0"
    assert "1:a:0" in mux_cmd


def test_soundtrack_failure_keeps_original_video(monkeypatch, tmp_path):
    _enable_sonilo(monkeypatch)
    monkeypatch.setattr(
        "novelvideo.audio.sonilo_soundtrack.SoniloSoundtrackClient",
        _ExplodingSoniloClient,
    )
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    # 配乐失败不影响成片合成本身。
    assert result["video_path"].endswith("videos/episodes/ep001_final.mp4")
    assert result["episode_soundtrack"]["applied"] is False
    assert any("保留原音轨" in line for line in manager.logs())


def test_soundtrack_skipped_when_episode_too_long(monkeypatch, tmp_path):
    _enable_sonilo(monkeypatch)
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(
        monkeypatch, tmp_path, manager, commands, episode_duration="400.0"
    )

    assert result["episode_soundtrack"]["applied"] is False
    assert _FakeSoniloClient.calls == []
    assert any("超过配乐接口上限" in line for line in manager.logs())

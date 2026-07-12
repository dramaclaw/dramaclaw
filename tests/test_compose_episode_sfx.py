"""run_compose_episode 的可选整集音效步骤（Sonilo video-to-sfx）。"""

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


class _FakeSfxClient:
    """写出一个假 .m4a，并记录调用参数。"""

    calls: list[dict] = []

    def generate_sfx(self, video_path, output_path, *, prompt=""):
        _FakeSfxClient.calls.append(
            {"video_path": video_path, "output_path": output_path, "prompt": prompt}
        )
        Path(output_path).write_bytes(b"m4a")
        return output_path


class _ExplodingSfxClient:
    def generate_sfx(self, video_path, output_path, *, prompt=""):
        raise RuntimeError("boom")


class _FakeSoundtrackClient:
    """整集配乐的假客户端，供配乐/音效上限不对称的用例使用。"""

    def generate_soundtrack(self, video_path, output_path, *, prompt=""):
        Path(output_path).write_bytes(b"m4a")
        return output_path


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


def _enable_sfx(monkeypatch, **overrides):
    values = {
        "EPISODE_SFX_PROVIDER": "sonilo",
        "SONILO_API_KEY": "test-key",
        "EPISODE_SFX_VOLUME": 0.5,
        "EPISODE_SFX_PROMPT": "",
    }
    values.update(overrides)
    for name, value in values.items():
        monkeypatch.setattr(f"novelvideo.config.{name}", value)
    _FakeSfxClient.calls = []
    monkeypatch.setattr(
        "novelvideo.audio.sonilo_soundtrack.SoniloSfxClient",
        _FakeSfxClient,
    )


def test_sfx_disabled_by_default(monkeypatch, tmp_path):
    monkeypatch.setattr("novelvideo.config.EPISODE_SFX_PROVIDER", "")
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    assert result["video_path"].endswith("videos/episodes/ep001_final.mp4")
    assert "episode_sfx" not in result
    assert not any("音效" in line for line in manager.logs())


def test_sfx_skipped_without_api_key(monkeypatch, tmp_path):
    _enable_sfx(monkeypatch, SONILO_API_KEY="")
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    assert result["episode_sfx"]["applied"] is False
    assert _FakeSfxClient.calls == []
    assert any("未配置 SONILO_API_KEY" in line for line in manager.logs())


def test_sfx_mixed_over_final_video(monkeypatch, tmp_path):
    _enable_sfx(monkeypatch, EPISODE_SFX_PROMPT="雨夜街道")
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    assert result["episode_sfx"]["applied"] is True
    assert len(_FakeSfxClient.calls) == 1
    assert _FakeSfxClient.calls[0]["prompt"] == "雨夜街道"
    assert str(_FakeSfxClient.calls[0]["video_path"]).endswith("ep001_final.mp4")

    mux_cmd = next(
        cmd
        for cmd in commands
        if cmd[0] == "ffmpeg" and "ep001_sfx.m4a" in " ".join(cmd)
    )
    filter_arg = mux_cmd[mux_cmd.index("-filter_complex") + 1]
    # 音效始终压低后 mix 叠加（保留对白），没有 replace 分支。
    assert "amix=inputs=2" in filter_arg
    assert "volume=0.5" in filter_arg
    # 成片路径不变，音效直接合入 ep001_final.mp4。
    assert result["video_path"].endswith("videos/episodes/ep001_final.mp4")
    assert any("整集音效已合入成片" in line for line in manager.logs())


def test_sfx_failure_keeps_original_video(monkeypatch, tmp_path):
    _enable_sfx(monkeypatch)
    monkeypatch.setattr(
        "novelvideo.audio.sonilo_soundtrack.SoniloSfxClient",
        _ExplodingSfxClient,
    )
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(monkeypatch, tmp_path, manager, commands)

    # 音效失败不影响成片合成本身。
    assert result["video_path"].endswith("videos/episodes/ep001_final.mp4")
    assert result["episode_sfx"]["applied"] is False
    assert any("保留原音轨" in line for line in manager.logs())


def test_sfx_skipped_when_episode_too_long(monkeypatch, tmp_path):
    _enable_sfx(monkeypatch)
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(
        monkeypatch, tmp_path, manager, commands, episode_duration="200.0"
    )

    assert result["episode_sfx"]["applied"] is False
    assert _FakeSfxClient.calls == []
    assert any("超过音效接口上限" in line for line in manager.logs())


def test_soundtrack_proceeds_while_sfx_skips_between_caps(monkeypatch, tmp_path):
    """上限不对称：音效 3 分钟、配乐 6 分钟。成片 200s 时配乐照常、音效跳过。"""
    _enable_sfx(monkeypatch)
    for name, value in {
        "EPISODE_SOUNDTRACK_PROVIDER": "sonilo",
        "EPISODE_SOUNDTRACK_MODE": "mix",
        "EPISODE_SOUNDTRACK_MUSIC_VOLUME": 0.35,
        "EPISODE_SOUNDTRACK_PROMPT": "",
    }.items():
        monkeypatch.setattr(f"novelvideo.config.{name}", value)
    monkeypatch.setattr(
        "novelvideo.audio.sonilo_soundtrack.SoniloSoundtrackClient",
        _FakeSoundtrackClient,
    )
    _write_beat_video(tmp_path, episode=1, beat_num=3)
    manager = _FakeTaskManager()
    commands = []

    result = _run_compose(
        monkeypatch, tmp_path, manager, commands, episode_duration="200.0"
    )

    assert result["episode_soundtrack"]["applied"] is True
    assert result["episode_sfx"]["applied"] is False
    assert result["episode_sfx"]["error"] == "episode too long"
    assert any("超过音效接口上限" in line for line in manager.logs())

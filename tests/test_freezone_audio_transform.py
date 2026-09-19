"""音频截取 / 变速的 ffmpeg 叶子契约。"""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.freezone import audio_transform


def test_audio_transform_command_trims_and_preserves_pitch(tmp_path: Path) -> None:
    command = audio_transform.build_audio_transform_command(
        source_path=tmp_path / "source.mp3",
        output_path=tmp_path / "result.m4a",
        start_sec=1.25,
        end_sec=5.75,
        speed=1.5,
    )

    assert command[:4] == ["ffmpeg", "-y", "-i", str(tmp_path / "source.mp3")]
    assert command[command.index("-ss") + 1] == "1.250"
    assert command[command.index("-t") + 1] == "4.500"
    assert command[command.index("-af") + 1] == "atempo=1.500000"
    assert command[command.index("-c:a") + 1] == "aac"
    assert command[-1] == str(tmp_path / "result.m4a")


@pytest.mark.parametrize(
    ("start", "end", "speed", "message"),
    [
        (-1.0, 1.0, 1.0, "0 <= start < end"),
        (1.0, 1.0, 1.0, "0 <= start < end"),
        (0.0, 0.05, 1.0, "at least 0.1"),
        (0.0, 1.0, 0.49, "between 0.5 and 2.0"),
        (0.0, 1.0, 2.01, "between 0.5 and 2.0"),
    ],
)
def test_audio_transform_command_rejects_invalid_parameters(
    tmp_path: Path,
    start: float,
    end: float,
    speed: float,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        audio_transform.build_audio_transform_command(
            source_path=tmp_path / "source.mp3",
            output_path=tmp_path / "result.m4a",
            start_sec=start,
            end_sec=end,
            speed=speed,
        )


@pytest.mark.asyncio
async def test_audio_transform_probes_duration_and_writes_m4a(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(b"wav")
    commands: list[tuple[str, ...]] = []

    class FakeProcess:
        def __init__(self, *, probe: bool, output: Path | None = None) -> None:
            self.probe = probe
            self.output = output
            self.returncode = 0

        async def communicate(self):
            if self.output is not None:
                self.output.write_bytes(b"m4a")
            return (b"10.000\n" if self.probe else b"", b"")

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

        async def wait(self) -> int:
            return self.returncode

    async def fake_create_subprocess_exec(*args, **_kwargs):
        command = tuple(str(arg) for arg in args)
        commands.append(command)
        if command[0] == "ffprobe":
            return FakeProcess(probe=True)
        return FakeProcess(probe=False, output=Path(command[-1]))

    monkeypatch.setattr(audio_transform.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        audio_transform.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    output = await audio_transform.run_freezone_audio_transform(
        project_dir=tmp_path,
        job_id="job_1",
        source_path=str(source),
        start_sec=2.0,
        end_sec=6.0,
        speed=2.0,
    )

    assert output == audio_transform.audio_transform_output_path(tmp_path, "job_1")
    assert output.read_bytes() == b"m4a"
    assert [command[0] for command in commands] == ["ffprobe", "ffmpeg"]


@pytest.mark.asyncio
async def test_audio_transform_rejects_range_beyond_probed_duration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(b"wav")

    class FakeProbe:
        returncode = 0

        async def communicate(self):
            return b"3.0\n", b""

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        return FakeProbe()

    monkeypatch.setattr(audio_transform.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        audio_transform.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    with pytest.raises(ValueError, match="exceeds source duration"):
        await audio_transform.run_freezone_audio_transform(
            project_dir=tmp_path,
            job_id="job_2",
            source_path=str(source),
            start_sec=0.0,
            end_sec=4.0,
            speed=1.0,
        )

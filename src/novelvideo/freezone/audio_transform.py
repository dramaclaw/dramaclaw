"""画布音频截取与变速。

为什么单独做一个本地 leaf，而不复用视频合成：音频动作的输入、输出和恢复单位都是音频；
伪造一条黑色视频才能导出，会让任务中心、结果类型和后续节点全部说谎。这里使用 ffmpeg
`atempo`，在 0.5–2.0 倍范围内改变时长而不跟着改变音高。
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from novelvideo.freezone.paths import outputs_dir

AUDIO_TRANSFORM_MIN_SPEED = 0.5
AUDIO_TRANSFORM_MAX_SPEED = 2.0
AUDIO_TRANSFORM_MIN_DURATION_SEC = 0.1


def audio_transform_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_audio_transform") / f"{job_id}.m4a"


def build_audio_transform_command(
    *,
    source_path: Path,
    output_path: Path,
    start_sec: float,
    end_sec: float,
    speed: float,
) -> list[str]:
    if start_sec < 0 or end_sec <= start_sec:
        raise ValueError("audio transform range must satisfy 0 <= start < end")
    if end_sec - start_sec < AUDIO_TRANSFORM_MIN_DURATION_SEC:
        raise ValueError("audio transform range must be at least 0.1 seconds")
    if not AUDIO_TRANSFORM_MIN_SPEED <= speed <= AUDIO_TRANSFORM_MAX_SPEED:
        raise ValueError("audio transform speed must be between 0.5 and 2.0")
    return [
        "ffmpeg",
        "-y",
        "-i",
        str(source_path),
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{end_sec - start_sec:.3f}",
        "-vn",
        "-af",
        f"atempo={speed:.6f}",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


async def run_freezone_audio_transform(
    *,
    project_dir: Path,
    job_id: str,
    source_path: str,
    start_sec: float,
    end_sec: float,
    speed: float,
) -> Path:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH; install via brew/apt")
    if not shutil.which("ffprobe"):
        raise RuntimeError("ffprobe not found on PATH; install via brew/apt")
    source = Path(source_path)
    if not source.is_file():
        raise FileNotFoundError(f"audio source not found: {source}")

    probe = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(source),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, probe_stderr = await probe.communicate()
    try:
        source_duration = float((stdout or b"").decode("utf-8", "replace").strip())
    except ValueError as exc:
        detail = (probe_stderr or b"").decode("utf-8", "replace")[-500:]
        raise RuntimeError(detail or "ffprobe could not read audio duration") from exc
    if probe.returncode != 0 or source_duration <= 0:
        detail = (probe_stderr or b"").decode("utf-8", "replace")[-500:]
        raise RuntimeError(detail or "ffprobe could not read audio duration")
    if end_sec > source_duration + 0.01:
        raise ValueError(
            f"audio transform end_sec {end_sec:.3f} exceeds source duration {source_duration:.3f}"
        )

    output = audio_transform_output_path(project_dir, job_id)
    output.parent.mkdir(parents=True, exist_ok=True)
    command = build_audio_transform_command(
        source_path=source,
        output_path=output,
        start_sec=start_sec,
        end_sec=end_sec,
        speed=speed,
    )
    proc = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _stdout, stderr = await proc.communicate()
    except asyncio.CancelledError:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        raise
    if proc.returncode != 0 or not output.is_file():
        detail = (stderr or b"").decode("utf-8", "replace")[-1000:]
        raise RuntimeError(detail or "ffmpeg audio transform failed")
    return output

"""画布音频静音切分预览。

为什么这里只返回切分建议而不直接产出多个文件：画布已有的单段音频 transform 任务具备
独立恢复、重试和错误投影。分析阶段保持只读，用户确认后再扇出那些已验证任务，能避免新增
一套“一任务多产物”的脆弱协议，也不会在仅仅打开面板时改动用户的图。
"""

from __future__ import annotations

import asyncio
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

AUDIO_SPLIT_ANALYSIS_TIMEOUT_SEC = 120
AUDIO_SPLIT_PROBE_TIMEOUT_SEC = 30
AUDIO_SPLIT_MAX_SEGMENTS = 24

_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")


@dataclass(frozen=True)
class AudioSplitSegment:
    start_sec: float
    end_sec: float


@dataclass(frozen=True)
class AudioSplitPreview:
    duration_sec: float
    segments: tuple[AudioSplitSegment, ...]
    detected_silence_count: int
    limited: bool


def parse_silence_intervals(stderr_text: str, duration_sec: float) -> list[tuple[float, float]]:
    """把 ffmpeg 的行式日志还原成闭合静音区间。

    尾部静音只有 ``silence_start`` 没有 ``silence_end`` 是合法输出，必须闭合到媒体结尾，
    否则最后一个可用切点会随 ffmpeg 版本而消失。
    """
    intervals: list[tuple[float, float]] = []
    pending_start: float | None = None
    for line in stderr_text.splitlines():
        start_match = _SILENCE_START_RE.search(line)
        if start_match:
            pending_start = max(0.0, float(start_match.group(1)))
        end_match = _SILENCE_END_RE.search(line)
        if not end_match:
            continue
        end = min(duration_sec, float(end_match.group(1)))
        if pending_start is not None and end > pending_start:
            intervals.append((pending_start, end))
        pending_start = None
    if pending_start is not None and duration_sec > pending_start:
        intervals.append((pending_start, duration_sec))
    return intervals


def build_audio_split_preview(
    *,
    duration_sec: float,
    silence_intervals: list[tuple[float, float]],
    min_segment_sec: float,
    max_segments: int = AUDIO_SPLIT_MAX_SEGMENTS,
) -> AudioSplitPreview:
    if duration_sec <= 0:
        raise ValueError("audio duration must be positive")
    if min_segment_sec < 0.1:
        raise ValueError("min_segment_sec must be at least 0.1")
    if max_segments < 2 or max_segments > AUDIO_SPLIT_MAX_SEGMENTS:
        raise ValueError(f"max_segments must be between 2 and {AUDIO_SPLIT_MAX_SEGMENTS}")

    candidate_cuts = sorted(
        {
            round((max(0.0, start) + min(duration_sec, end)) / 2, 3)
            for start, end in silence_intervals
            if end > start
        }
    )
    accepted_cuts: list[float] = []
    previous = 0.0
    for cut in candidate_cuts:
        if cut <= 0 or cut >= duration_sec:
            continue
        if cut - previous < min_segment_sec:
            continue
        if duration_sec - cut < min_segment_sec:
            continue
        accepted_cuts.append(cut)
        previous = cut

    limited = len(accepted_cuts) + 1 > max_segments
    if limited:
        target_count = max_segments - 1
        if target_count == 1:
            accepted_cuts = [accepted_cuts[len(accepted_cuts) // 2]]
        else:
            last_index = len(accepted_cuts) - 1
            indices = {
                round(index * last_index / (target_count - 1))
                for index in range(target_count)
            }
            accepted_cuts = [accepted_cuts[index] for index in sorted(indices)]

    boundaries = [0.0, *accepted_cuts, round(duration_sec, 3)]
    segments = tuple(
        AudioSplitSegment(start_sec=start, end_sec=end)
        for start, end in zip(boundaries, boundaries[1:])
    )
    return AudioSplitPreview(
        duration_sec=round(duration_sec, 3),
        segments=segments,
        detected_silence_count=len(silence_intervals),
        limited=limited,
    )


async def _communicate_with_timeout(
    proc: asyncio.subprocess.Process,
    *,
    timeout_sec: float,
) -> tuple[bytes, bytes]:
    try:
        return await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except (asyncio.CancelledError, TimeoutError):
        proc.kill()
        await proc.wait()
        raise


async def _probe_duration(source: Path) -> float:
    proc = await asyncio.create_subprocess_exec(
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
    stdout, stderr = await _communicate_with_timeout(
        proc, timeout_sec=AUDIO_SPLIT_PROBE_TIMEOUT_SEC
    )
    if proc.returncode != 0:
        raise RuntimeError("ffprobe could not read audio duration")
    try:
        duration = float(stdout.decode("utf-8", "replace").strip())
    except ValueError as exc:
        raise RuntimeError("ffprobe returned an invalid audio duration") from exc
    if duration <= 0:
        detail = stderr.decode("utf-8", "replace")[-200:]
        raise RuntimeError(detail or "ffprobe returned an invalid audio duration")
    return duration


async def analyze_audio_split(
    *,
    source_path: str,
    silence_threshold_db: float,
    min_silence_sec: float,
    min_segment_sec: float,
    max_segments: int = AUDIO_SPLIT_MAX_SEGMENTS,
) -> AudioSplitPreview:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg and ffprobe are required for audio split analysis")
    source = Path(source_path)
    if not source.is_file():
        raise FileNotFoundError(f"audio source not found: {source}")

    duration = await _probe_duration(source)
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-i",
        str(source),
        "-af",
        f"silencedetect=noise={silence_threshold_db:.1f}dB:d={min_silence_sec:.3f}",
        "-f",
        "null",
        "-",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await _communicate_with_timeout(
        proc, timeout_sec=AUDIO_SPLIT_ANALYSIS_TIMEOUT_SEC
    )
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg audio split analysis failed")
    intervals = parse_silence_intervals(stderr.decode("utf-8", "replace"), duration)
    return build_audio_split_preview(
        duration_sec=duration,
        silence_intervals=intervals,
        min_segment_sec=min_segment_sec,
        max_segments=max_segments,
    )

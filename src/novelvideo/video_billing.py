"""Server-authoritative billing metrics for reference-video generation."""

from __future__ import annotations

import asyncio
import math
import subprocess
from collections.abc import Iterable


async def probe_video_duration_seconds(path: str) -> float:
    """Read one input video's real duration with ffprobe.

    Billing must not trust a duration supplied by the browser. The API resolves
    project-local URLs first and calls this helper before reserving credits.
    """

    def _probe() -> float:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or "").strip()[-500:]
            raise ValueError(detail or "ffprobe could not read video duration")
        try:
            duration = float((result.stdout or "").strip())
        except ValueError as exc:
            raise ValueError("ffprobe returned an invalid video duration") from exc
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("video duration must be positive")
        return duration

    return await asyncio.to_thread(_probe)


async def probe_total_video_duration_seconds(paths: Iterable[str]) -> float:
    clean_paths = [str(path or "").strip() for path in paths if str(path or "").strip()]
    if not clean_paths:
        return 0.0
    durations = await asyncio.gather(
        *(probe_video_duration_seconds(path) for path in clean_paths)
    )
    return sum(durations)

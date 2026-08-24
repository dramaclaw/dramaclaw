"""Async-safe media IO helpers shared by API, UI, and generation services."""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import Sequence
from pathlib import Path

from novelvideo.utils.async_ops import call_blocking


def get_audio_duration(audio_path: str) -> float:
    """Return audio duration in seconds using ffprobe."""
    import subprocess

    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return float(result.stdout.strip())
    except Exception:
        return 5.0


async def get_audio_duration_async(audio_path: str) -> float:
    """Return audio duration without blocking the event loop."""
    return await call_blocking(get_audio_duration, audio_path)


# Each probe forks an ffprobe process from a shared thread-pool worker. Left
# unbounded, one request for a long episode fans out one fork per audio beat at
# once — and because `call_blocking` uses the default executor, it also starves
# every other blocking call in the process while it drains. The cap is global,
# not per-request: two concurrent episode reads must not multiply it.
_PROBE_CONCURRENCY = 8
_probe_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


def _probe_semaphore() -> "asyncio.Semaphore":
    """The probe gate for the running loop.

    Keyed per loop rather than created once at import: a semaphore binds to the
    loop that first awaits it, and the test suite runs many loops in one process.
    """
    loop = asyncio.get_running_loop()
    semaphore = _probe_semaphores.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)
        _probe_semaphores[loop] = semaphore
    return semaphore


async def get_audio_durations_async(paths: "Sequence[str]") -> "list[float | None]":
    """Probe many audio files with bounded concurrency.

    Returns one entry per input, positionally aligned; ``None`` where the probe
    failed, so a single unreadable file cannot fail the batch.
    """
    if not paths:
        return []

    semaphore = _probe_semaphore()

    async def probe(path: str) -> "float | None":
        async with semaphore:
            try:
                return await get_audio_duration_async(path)
            except Exception:
                return None

    return list(await asyncio.gather(*(probe(path) for path in paths)))


async def crop_image_to_path(
    image_path: str | Path,
    *,
    x: int,
    y: int,
    width: int,
    height: int,
    output_path: str | Path | None = None,
) -> tuple[int, int]:
    """Crop an image with bounds clamping and save it to disk."""

    def _crop() -> tuple[int, int]:
        from PIL import Image

        source = Path(image_path)
        target = Path(output_path) if output_path is not None else source
        with Image.open(source) as img:
            crop_x = max(0, min(int(x), img.width - 1))
            crop_y = max(0, min(int(y), img.height - 1))
            right = min(crop_x + max(1, int(width)), img.width)
            bottom = min(crop_y + max(1, int(height)), img.height)
            cropped = img.crop((crop_x, crop_y, right, bottom))
            target.parent.mkdir(parents=True, exist_ok=True)
            cropped.save(target)
            return cropped.width, cropped.height

    return await call_blocking(_crop)


__all__ = ["crop_image_to_path", "get_audio_duration", "get_audio_duration_async"]

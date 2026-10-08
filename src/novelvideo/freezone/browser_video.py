"""Keep imported source video intact while serving a browser-decodable copy.

LibTV can supply HEVC Main 10 MP4s. Some Chromium installations play their AAC
track and advance currentTime but never decode a video frame. A separate cached
H.264 copy is therefore used only by the canvas player, not by generation.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

from novelvideo import config

logger = logging.getLogger(__name__)

MAX_SOURCE_BYTES = 256 * 1024 * 1024
_TRANSCODE_LOCK = threading.Lock()
_VIDEO_CODEC = re.compile(r"Stream #\d+:\d+[^\n]*Video:\s*([a-zA-Z0-9_]+)")


class BrowserVideoError(Exception):
    """The explicit browser playback copy could not be prepared."""


def _is_imported_mp4(project_dir: Path, source: Path) -> bool:
    try:
        parts = source.resolve().relative_to(project_dir.resolve()).parts
    except ValueError:
        return False
    return (
        len(parts) == 5
        and parts[0] == "freezone"
        and parts[1] == "liblib_import"
        and parts[3] == "media"
        and parts[4].lower().endswith(".mp4")
    )


def _ffmpeg_executable() -> str:
    configured = str(config.FFMPEG_PATH).strip().strip('"')
    found = shutil.which(configured)
    if found:
        return found
    if Path(configured).is_file():
        return configured
    portable_python = os.environ.get("COMFYUI_PYTHON", "").strip().strip('"')
    if portable_python:
        bundled = Path(portable_python).parent / "Lib" / "site-packages" / "imageio_ffmpeg" / "binaries"
        for candidate in sorted(bundled.glob("ffmpeg*.exe")):
            if candidate.is_file():
                return str(candidate)
    raise BrowserVideoError("FFmpeg is not configured for browser video playback")


def _probe_video_codec(source: Path, ffmpeg: str) -> str:
    try:
        result = subprocess.run(
            [ffmpeg, "-nostdin", "-hide_banner", "-i", str(source)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BrowserVideoError("Video codec probe failed") from exc
    match = _VIDEO_CODEC.search(result.stderr)
    if not match:
        raise BrowserVideoError("Video has no readable picture track")
    return match.group(1).lower()


def _transcode_video(source: Path, destination: Path, ffmpeg: str) -> None:
    temporary = destination.with_name(f"{destination.stem}.{uuid.uuid4().hex}.tmp.mp4")
    try:
        result = subprocess.run(
            [
                ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", str(source), "-map", "0:v:0", "-map", "0:a?",
                "-sn", "-dn", "-c:v", "libx264", "-preset", "veryfast",
                "-crf", "20", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                "-y", str(temporary),
            ],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        if result.returncode != 0 or not temporary.is_file() or temporary.stat().st_size == 0:
            logger.warning("Browser video conversion failed for %s: %s", source, result.stderr[-1200:])
            raise BrowserVideoError("Browser video conversion failed")
        os.replace(temporary, destination)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BrowserVideoError("Browser video conversion failed") from exc
    finally:
        temporary.unlink(missing_ok=True)


def browser_playback_file(project_dir: Path, source: Path) -> Path:
    """Return the original H.264 MP4 or an atomic, versioned playback copy.

    The request is opt-in and restricted to files the LibTV importer stored.
    Other static media URLs keep their original bytes and delivery semantics.
    """
    if not _is_imported_mp4(project_dir, source):
        return source
    stat = source.stat()
    if stat.st_size <= 0 or stat.st_size > MAX_SOURCE_BYTES:
        raise BrowserVideoError("Imported video exceeds the playback conversion limit")
    relative = source.resolve().relative_to(project_dir.resolve()).as_posix()
    version = hashlib.sha256(
        f"{relative}:{stat.st_size}:{stat.st_mtime_ns}".encode("utf-8")
    ).hexdigest()
    destination = source.parent / ".browser_video" / f"{version}.mp4"
    if destination.is_file() and destination.stat().st_size > 0:
        return destination

    with _TRANSCODE_LOCK:
        if destination.is_file() and destination.stat().st_size > 0:
            return destination
        ffmpeg = _ffmpeg_executable()
        if _probe_video_codec(source, ffmpeg) == "h264":
            return source
        destination.parent.mkdir(parents=True, exist_ok=True)
        _transcode_video(source, destination, ffmpeg)
    return destination

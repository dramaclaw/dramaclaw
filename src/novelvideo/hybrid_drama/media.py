"""Local media inspection gates."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess


def inspect_media(path: str | Path, *, full_decode: bool = False) -> dict:
    probe_result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    probe = json.loads(probe_result.stdout)
    if full_decode:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-f", "null", "-"],
            check=True,
            capture_output=True,
            text=True,
        )
        probe["full_decode"] = True
    return probe


def validate_media_probe(probe: dict) -> None:
    videos = [stream for stream in probe.get("streams", []) if stream.get("codec_type") == "video"]
    if not videos:
        raise ValueError("video stream is required")
    video = videos[0]
    if min(int(video.get("width") or 0), int(video.get("height") or 0)) < 720:
        raise ValueError("720p minimum resolution is required")
    audio = [stream for stream in probe.get("streams", []) if stream.get("codec_type") == "audio"]
    if not audio or not all(
        int(stream.get("channels") or 0) > 0 and int(stream.get("sample_rate") or 0) > 0
        for stream in audio
    ):
        raise ValueError("audio stream with channels and sample rate is required")

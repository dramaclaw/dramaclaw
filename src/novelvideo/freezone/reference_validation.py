"""Optional catalog constraints for local reference media, before billing."""

from __future__ import annotations

import json
import math
import subprocess
from fractions import Fraction
from pathlib import Path

PREFIXES = {
    "image": "referenceImage",
    "audio": "referenceAudio",
    "video": "referenceVideo",
}
FIELDS = {
    "image": (
        "MaxMB",
        "MinWidth",
        "MaxWidth",
        "MinHeight",
        "MaxHeight",
        "MinAspectRatio",
        "MaxAspectRatio",
    ),
    "audio": ("MaxMB",),
    "video": ("MaxMB", "MinFPS", "MaxFPS"),
}
ALIASES = {"jpg": "jpeg", "tif": "tiff", "wave": "wav", "mpeg": "mp3"}


def normalize_format(value: str) -> str:
    value = value.strip().lower().lstrip(".")
    return ALIASES.get(value, value)


def validate_reference_config(config: dict) -> None:
    for media, prefix in PREFIXES.items():
        formats = config.get(prefix + "Formats")
        if formats is not None and (
            not isinstance(formats, list)
            or any(
                not isinstance(v, str) or not v.isascii() or not v.isalnum()
                for v in formats
            )
        ):
            raise ValueError(f"{prefix}Formats must be a list of format names")
        for suffix in FIELDS[media]:
            value = config.get(prefix + suffix)
            if value is not None and (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or value <= 0
                or (suffix.endswith(("Width", "Height")) and int(value) != value)
            ):
                raise ValueError(
                    f"{prefix}{suffix} must be a positive finite number (pixels: integer)"
                )
        for suffix in ("Width", "Height", "AspectRatio", "FPS"):
            lo, hi = config.get(prefix + "Min" + suffix), config.get(
                prefix + "Max" + suffix
            )
            if lo is not None and hi is not None and lo > hi:
                raise ValueError(
                    f"{prefix}Min{suffix} cannot exceed {prefix}Max{suffix}"
                )


def _ffprobe(path: Path) -> dict:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    return json.loads(result.stdout)


def _probe(path: Path, media: str) -> dict:
    if media == "image":
        from PIL import Image

        with path.open("rb") as source:
            header = source.read(64)
        if header[4:8] == b"ftyp" and header[8:12] in {
            b"heic",
            b"heix",
            b"hevc",
            b"hevx",
            b"mif1",
            b"msf1",
        }:
            streams = [
                stream
                for stream in _ffprobe(path).get("streams", [])
                if stream.get("codec_type") == "video"
            ]
            if not streams:
                raise ValueError("HEIF image dimensions unavailable")
            stream = next(
                (s for s in streams if s.get("disposition", {}).get("default")),
                streams[0],
            )
            width, height = int(stream.get("width", 0)), int(stream.get("height", 0))
            if width <= 0 or height <= 0:
                raise ValueError("HEIF image dimensions unavailable")
            return {
                "format": "heif",
                "width": width,
                "height": height,
                "aspectRatio": width / height,
            }
        with Image.open(path) as image:
            width, height = image.size
            fmt = normalize_format(image.format or "")
            image.verify()
            return {
                "format": fmt,
                "width": width,
                "height": height,
                "aspectRatio": width / height,
            }
    data = _ffprobe(path)
    streams = [s for s in data.get("streams", []) if s.get("codec_type") == media]
    if not streams:
        raise ValueError("required media stream missing")
    fmt = str(data.get("format", {}).get("format_name", ""))
    # ffprobe uses one demuxer name for MOV/MP4/M4A. Inspect the actual ftyp
    # brand, never accept an extension as proof of the container format.
    if "mov" in fmt.split(","):
        with path.open("rb") as source:
            header = source.read(64)
        brand = header[8:12] if header[4:8] == b"ftyp" else b"qt  "
        fmt = (
            "mov"
            if brand == b"qt  "
            else "m4a" if brand in {b"M4A ", b"M4B ", b"M4P "} else "mp4"
        )
    else:
        fmt = normalize_format(fmt.split(",")[0])
    values = {"format": fmt}
    if media == "video":
        stream = streams[0]
        try:
            fps = float(Fraction(stream.get("avg_frame_rate") or "0"))
            if fps <= 0:
                fps = float(Fraction(stream.get("r_frame_rate") or "0"))
            values["fps"] = fps if math.isfinite(fps) and fps > 0 else None
        except (ValueError, ZeroDivisionError):
            values["fps"] = None
    return values


def validate_reference_media(
    items: list[dict], config: dict, project_dir: Path
) -> list[dict]:
    """Collect all violations. Unset constraints cause no new IO or rejection."""
    from PIL import Image

    errors: list[dict] = []
    cache: dict[tuple[str, str], dict | None] = {}
    counts: dict[str, int] = {}
    for item in items:
        media = item.get("type", "image")
        if media not in PREFIXES:
            continue
        counts[media] = counts.get(media, 0) + 1
        prefix = PREFIXES[media]
        rules = {
            suffix: config.get(prefix + suffix)
            for suffix in FIELDS[media]
            if config.get(prefix + suffix) is not None
        }
        formats = config.get(prefix + "Formats") or []
        if not rules and not formats:
            continue
        raw = str(item.get("path") or "")
        path = Path(raw)
        try:
            key = path.resolve().relative_to(project_dir.resolve()).as_posix()
        except ValueError:
            key = ""
        identity = {
            "media": media,
            "index": counts[media],
            "role": item.get("role", ""),
            "reference_key": key,
            "name": path.name if key else f"{media} {counts[media]}",
        }

        def reject(code: str, actual=None, expected=None):
            errors.append(
                {**identity, "code": code, "actual": actual, "expected": expected}
            )

        # Remote references must not introduce a new unguarded download/SSRF path.
        if not key or not path.is_file():
            reject("unreadable")
            continue
        try:
            size_mb = path.stat().st_size / 1_000_000
            if "MaxMB" in rules and size_mb > rules["MaxMB"]:
                reject("maxMB", round(size_mb, 3), rules["MaxMB"])
            if not formats and set(rules) <= {"MaxMB"}:
                continue
            cache_key = (raw, media)
            if cache_key not in cache:
                try:
                    cache[cache_key] = _probe(path, media)
                except (
                    OSError,
                    ValueError,
                    subprocess.SubprocessError,
                    Image.DecompressionBombError,
                ):
                    cache[cache_key] = None
            values = cache[cache_key]
            if values is None:
                reject("unreadable")
                continue
            allowed = {normalize_format(f) for f in formats}
            if "heic" in allowed:
                allowed.add("heif")
            if formats and values["format"] not in allowed:
                reject("format", values["format"], formats)
            for suffix, field in (
                ("Width", "width"),
                ("Height", "height"),
                ("AspectRatio", "aspectRatio"),
                ("FPS", "fps"),
            ):
                for bound in ("Min", "Max"):
                    limit = rules.get(bound + suffix)
                    if limit is None:
                        continue
                    value = values.get(field)
                    if value is None:
                        reject("unreadable", field)
                    elif value < limit if bound == "Min" else value > limit:
                        reject(bound.lower() + suffix, value, limit)
        except OSError:
            reject("unreadable")
    return errors

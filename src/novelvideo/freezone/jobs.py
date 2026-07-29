"""Pure async jobs for freezone single-image gen / edit.

These are called from the task backend runners and from unit-test harnesses.
They never touch the queue backend, the API layer, or task_state.

Provider selection (since v1.1):
- `provider` / `model` / `quality` get threaded into
  `get_grid_generation_config(provider_override=, model_override=)` for the
          image generation/edit path so the caller can pick the supported SuperTale
          providers: `newapi` / `huimeng` / `openrouter` / `openai`.
- A legacy `provider="volcengine"` branch remains for old canvases/scripts, but
  the Freezone UI no longer exposes it.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image

from novelvideo.freezone.paths import output_path_for_job, outputs_dir

logger = logging.getLogger(__name__)


async def run_freezone_gen(
    *,
    project_dir: Path,
    job_id: str,
    prompt: str,
    aspect_ratio: str = "1:1",
    image_size: str = "2K",
    reference_paths: Optional[list[str]] = None,
    api_key: Optional[str] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    quality: Optional[str] = None,
    output_task_type: str = "freezone_gen",
) -> Path:
    """text → image (with optional reference images).

    Routes through nanobanana_grid for the supported SuperTale providers.
    """
    out = output_path_for_job(project_dir, output_task_type or "freezone_gen", job_id)
    out.parent.mkdir(parents=True, exist_ok=True)

    # Routing (v1.2):
    #   provider == "volcengine"  → Volcengine Seedream (text-only path; refs ignored)
    #   anything else (including None default) → nanobanana_grid:
    #     - with refs → generate_reference_edit_image
    #     - no refs   → generate_text_to_image  (NEW v1.2)
    if (provider or "").lower() == "volcengine":
        return await _run_volcengine_text_to_image(
            out=out,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            image_size=image_size,
        )

    from novelvideo.config import get_grid_generation_config
    from novelvideo.generators.nanobanana_grid import (
        generate_reference_edit_image,
        generate_text_to_image,
    )

    cfg = get_grid_generation_config(
        provider_override=provider,
        model_override=model,
        image_size_override=image_size,
    )
    if reference_paths:
        await generate_reference_edit_image(
            prompt=prompt,
            reference_images=reference_paths,
            output_path=str(out),
            aspect_ratio=aspect_ratio,
            image_size=image_size,
            quality=quality,
            api_key=api_key,
            config=cfg,
        )
    else:
        await generate_text_to_image(
            prompt=prompt,
            output_path=str(out),
            aspect_ratio=aspect_ratio,
            image_size=image_size,
            quality=quality,
            api_key=api_key,
            config=cfg,
        )
    return out


async def run_freezone_mask_edit(
    *,
    project_dir: Path,
    job_id: str,
    base_path: str,
    mask_path: str,
    prompt: str,
    aspect_ratio: str = "1:1",
    image_size: str = "2K",
    quality: str = "medium",
    api_key: Optional[str] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
) -> Path:
    """Masked erase/edit via the same provider routing used by Freezone image edit."""
    out = output_path_for_job(project_dir, "freezone_mask_edit", job_id)
    out.parent.mkdir(parents=True, exist_ok=True)

    base_p = Path(base_path)
    mask_p = Path(mask_path)
    if not base_p.exists():
        raise FileNotFoundError(f"base not found: {base_p}")
    if not mask_p.exists():
        raise FileNotFoundError(f"mask not found: {mask_p}")

    from novelvideo.config import get_grid_generation_config
    from novelvideo.generators.nanobanana_grid import generate_reference_edit_image
    from novelvideo.utils.error_redaction import redact_secrets

    cfg = get_grid_generation_config(
        provider_override=provider,
        model_override=model,
        image_size_override=image_size,
    )
    provider_name = str(cfg.get("provider") or provider or "newapi").strip().lower()
    mask_prompt = (
        f"{prompt}\n\n"
        "Use Image 1 as the source image. Image 2 is the same image with a translucent RED "
        "highlight painted over the region to edit. Edit ONLY the red-highlighted region; the "
        "red highlight is just an annotation marking where to work and must NOT appear in the "
        "output. Preserve all pixels outside the highlighted region — composition, identity, "
        "lighting, and texture — as much as possible."
    ).strip()
    try:
        await generate_reference_edit_image(
            prompt=mask_prompt,
            reference_images=[str(base_p), str(mask_p)],
            output_path=str(out),
            aspect_ratio=aspect_ratio,
            image_size=image_size,
            quality=quality,
            api_key=api_key,
            config=cfg,
        )
    except Exception as exc:
        raise RuntimeError(f"{provider_name} 图像擦除失败：{redact_secrets(exc)}") from exc
    if not out.exists():
        raise RuntimeError(f"{provider_name} 图像擦除未生成输出文件")
    return out


async def run_freezone_upscale(
    *,
    project_dir: Path,
    job_id: str,
    source_path: str,
    target_width: int = 2048,
    target_height: int = 2048,
    strength: float = 0.9,
    enhancement_prompt: Optional[str] = None,
) -> Path:
    """High-res restoration via Seedream img2img with strength≈0.9.

    Reuses `VolcengineImageGenerator.upscale_with_img2img()` — preserves the
    input image's content while bumping resolution. Output lands under
    `freezone/_outputs/freezone_upscale/<job_id>.png`.
    """
    out = output_path_for_job(project_dir, "freezone_upscale", job_id)
    out.parent.mkdir(parents=True, exist_ok=True)

    from novelvideo.generators.image_generator import create_image_generator

    generator = create_image_generator()
    result = await generator.upscale_with_img2img(
        input_path=source_path,
        output_path=str(out),
        target_width=target_width,
        target_height=target_height,
        strength=strength,
        enhancement_prompt=enhancement_prompt,
    )
    if not result or not result.success:
        err = result.error if result else "unknown error"
        raise RuntimeError(f"upscale failed: {err}")
    if not out.exists():
        if result.image_base64:
            import base64

            out.write_bytes(base64.b64decode(result.image_base64))
        else:
            raise RuntimeError("upscale produced no file or bytes")
    return out


async def _run_volcengine_text_to_image(
    *,
    out: Path,
    prompt: str,
    aspect_ratio: str,
    image_size: str,
) -> Path:
    """Volcengine Seedream 4.0 text→image (no provider/model override)."""
    from novelvideo.generators.image_generator import create_image_generator

    width, height = _aspect_to_dims(aspect_ratio, image_size)
    generator = create_image_generator()
    result = await generator.generate(
        prompt=prompt,
        output_path=str(out),
        width=width,
        height=height,
    )
    if not result or not result.success:
        err = result.error if result else "unknown error"
        raise RuntimeError(f"Volcengine text→image generation failed: {err}")
    if not out.exists():
        if result.image_base64:
            import base64

            out.write_bytes(base64.b64decode(result.image_base64))
        else:
            raise RuntimeError("Volcengine text→image produced no file or bytes")
    return out


async def run_freezone_edit(
    *,
    project_dir: Path,
    job_id: str,
    prompt: str,
    base_path: str,
    extra_reference_paths: Optional[list[str]] = None,
    aspect_ratio: str = "2:3",
    image_size: str = "2K",
    api_key: Optional[str] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    quality: Optional[str] = None,
    output_task_type: str = "freezone_edit",
) -> Path:
    """image + reference + prompt → new image.

    v1 doesn't enforce a hard mask — most providers (nanobanana, OpenAI image
    edit) treat reference images plus a prompt as soft guidance. The base
    image is passed first in the references list so the model anchors on it.
    """
    out = output_path_for_job(project_dir, output_task_type or "freezone_edit", job_id)
    out.parent.mkdir(parents=True, exist_ok=True)

    refs: list[str] = [base_path]
    if extra_reference_paths:
        refs.extend(extra_reference_paths)

    from novelvideo.config import get_grid_generation_config
    from novelvideo.generators.nanobanana_grid import generate_reference_edit_image

    cfg = get_grid_generation_config(
        provider_override=provider,
        model_override=model,
        image_size_override=image_size,
    )
    await generate_reference_edit_image(
        prompt=prompt,
        reference_images=refs,
        output_path=str(out),
        aspect_ratio=aspect_ratio,
        image_size=image_size,
        quality=quality,
        api_key=api_key,
        config=cfg,
    )
    return out


def ensure_freezone_dirs(project_dir: Path) -> None:
    """Create freezone subdirectories on first use; cheap and idempotent."""
    (project_dir / "freezone" / "_uploads").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_gen").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_edit").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_upscale").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_video_gen").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_video_compose").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_extract").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_analyze").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_mask_edit").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_video_erase").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_video_upscale").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_audio_separate").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_audio_speech").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_audio_eleven_music").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_image_to_3gs").mkdir(parents=True, exist_ok=True)


FREEZONE_VIDEO_RESOLUTION_MAP: dict[str, tuple[int, int]] = {
    "720p": (1280, 720),
    "1080p": (1920, 1080),
}

FREEZONE_VIDEO_UPSCALE_LONG_EDGE: dict[str, int] = {
    "1080p": 1920,
    "2k": 2560,
    "4k": 3840,
}


def _video_upscale_filter(resolution: str, denoise_strength: str) -> str:
    target = FREEZONE_VIDEO_UPSCALE_LONG_EDGE.get(resolution.lower())
    if not target:
        raise ValueError(f"unsupported video upscale resolution: {resolution}")
    filters = [f"scale='if(gte(iw,ih),{target},-2)':" f"'if(gte(iw,ih),-2,{target})':flags=lanczos"]
    denoise = (denoise_strength or "1x").lower()
    if denoise == "1x":
        filters.append("hqdn3d=1.2:1.2:4:4")
    elif denoise == "2x":
        filters.append("hqdn3d=2.0:2.0:6:6")
    elif denoise != "none":
        raise ValueError(f"unsupported denoise_strength: {denoise_strength}")
    filters.append("unsharp=5:5:0.55:3:3:0.25")
    filters.append("format=yuv420p")
    return ",".join(filters)


async def run_freezone_video_upscale(
    *,
    project_dir: Path,
    job_id: str,
    source_path: str,
    resolution: str = "1080p",
    frame_interpolation: str = "none",
    denoise_strength: str = "1x",
) -> tuple[Path, dict]:
    """Basic ffmpeg video enhancement: scale, denoise, sharpen, preserve audio."""
    if frame_interpolation != "none":
        raise ValueError("basic video upscale only supports frame_interpolation='none'")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH; install via brew/apt")

    src = Path(source_path)
    if not src.exists():
        raise FileNotFoundError(f"video source not found: {src}")

    out = outputs_dir(project_dir, "freezone_video_upscale") / f"{job_id}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = _video_upscale_filter(resolution, denoise_strength)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "18",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        str(out),
    ]
    proc = await asyncio.to_thread(
        subprocess.run,
        cmd,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg video upscale failed: {proc.stderr[-1000:]}")
    meta = {
        "backend": "ffmpeg",
        "resolution": resolution,
        "frame_interpolation": frame_interpolation,
        "denoise_strength": denoise_strength,
        "video_filter": vf,
    }
    return out, meta


async def _run_cmd(cmd: list[str]) -> None:
    proc = await asyncio.to_thread(
        subprocess.run,
        cmd,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        raise RuntimeError(stderr[-1000:] or f"command failed: {' '.join(cmd)}")


async def _probe_has_audio(source_path: str) -> bool:
    proc = await asyncio.to_thread(
        subprocess.run,
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            source_path,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode == 0 and bool((proc.stdout or "").strip())


async def _render_gap_clip(
    *,
    output_path: Path,
    duration: float,
    width: int,
    height: int,
    fps: int,
    background_color: str,
) -> None:
    await _run_cmd(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={background_color}:s={width}x{height}:r={fps}",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-t",
            f"{duration:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-shortest",
            str(output_path),
        ]
    )


async def _render_video_clip(
    *,
    source_path: str,
    output_path: Path,
    source_start: float,
    duration: float,
    width: int,
    height: int,
    fps: int,
    background_color: str,
    keep_original_audio: bool,
    volume: float,
    muted: bool,
) -> None:
    video_filter = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={background_color},fps={fps}"
    )
    has_audio = keep_original_audio and (not muted) and await _probe_has_audio(source_path)

    if has_audio:
        cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{source_start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            source_path,
            "-vf",
            video_filter,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-af",
            f"volume={volume:.4f}",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    else:
        cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{source_start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            source_path,
            "-f",
            "lavfi",
            "-t",
            f"{duration:.3f}",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-vf",
            video_filter,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-shortest",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    await _run_cmd(cmd)


async def _render_audio_clip(
    *,
    source_path: str,
    output_path: Path,
    source_start: float,
    duration: float,
    volume: float,
) -> None:
    await _run_cmd(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{source_start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            source_path,
            "-vn",
            "-af",
            f"volume={volume:.4f}",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            str(output_path),
        ]
    )


async def _concat_media_segments(segment_paths: list[Path], output_path: Path) -> None:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as handle:
        for path in segment_paths:
            safe_path = str(path).replace("'", "'\\''")
            handle.write(f"file '{safe_path}'\n")
        list_path = Path(handle.name)
    try:
        await _run_cmd(
            [
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_path),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-movflags",
                "+faststart",
                str(output_path),
            ]
        )
    finally:
        list_path.unlink(missing_ok=True)


async def _mix_audio_tracks(
    *,
    base_video_path: Path,
    final_output_path: Path,
    audio_items: list[dict[str, Any]],
    temp_dir: Path,
) -> None:
    audio_inputs: list[tuple[Path, float]] = []
    for index, item in enumerate(audio_items):
        if bool(item.get("muted")):
            continue
        volume = float(item.get("volume", 1.0) or 1.0)
        if volume <= 0:
            continue
        source_start = float(item.get("source_start", 0.0) or 0.0)
        source_end = float(item.get("source_end", 0.0) or 0.0)
        duration = source_end - source_start
        if duration <= 0:
            continue
        audio_path = temp_dir / f"audio_track_{index:03d}.m4a"
        await _render_audio_clip(
            source_path=str(item["source_path"]),
            output_path=audio_path,
            source_start=source_start,
            duration=duration,
            volume=volume,
        )
        audio_inputs.append((audio_path, float(item.get("timeline_start", 0.0) or 0.0)))

    if not audio_inputs:
        shutil.move(str(base_video_path), str(final_output_path))
        return

    cmd = ["ffmpeg", "-y", "-i", str(base_video_path)]
    filter_parts: list[str] = []
    labels = ["[0:a]"]
    for idx, (audio_path, timeline_start) in enumerate(audio_inputs, start=1):
        delay_ms = max(0, int(round(timeline_start * 1000.0)))
        cmd.extend(["-i", str(audio_path)])
        filter_parts.append(f"[{idx}:a]adelay={delay_ms}|{delay_ms}[a{idx}]")
        labels.append(f"[a{idx}]")
    filter_parts.append(
        f"{''.join(labels)}amix=inputs={len(labels)}:duration=first:dropout_transition=0[aout]"
    )
    cmd.extend(
        [
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "0:v:0",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(final_output_path),
        ]
    )
    await _run_cmd(cmd)


async def run_freezone_video_compose(
    *,
    project_dir: Path,
    job_id: str,
    title: str = "",
    canvas_id: str = "",
    resolution: str = "1080p",
    fps: int = 30,
    background_color: str = "#000000",
    keep_original_audio: bool = True,
    tracks: list[dict[str, Any]],
) -> Path:
    """Compose a minimal timeline JSON into a final mp4."""
    del title, canvas_id

    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH; install via brew/apt")
    if not shutil.which("ffprobe"):
        raise RuntimeError("ffprobe not found on PATH; install via brew/apt")

    width, height = FREEZONE_VIDEO_RESOLUTION_MAP.get(
        resolution, FREEZONE_VIDEO_RESOLUTION_MAP["1080p"]
    )
    output_dir = outputs_dir(project_dir, "freezone_video_compose")
    output_dir.mkdir(parents=True, exist_ok=True)
    final_output_path = output_dir / f"{job_id}.mp4"

    video_items = [
        item
        for track in tracks
        if str(track.get("kind") or "") == "video"
        for item in (track.get("items") or [])
    ]
    audio_items = [
        item
        for track in tracks
        if str(track.get("kind") or "") == "audio"
        for item in (track.get("items") or [])
    ]
    if not video_items:
        raise RuntimeError("video compose requires at least one video clip")

    sorted_video_items = sorted(
        video_items,
        key=lambda item: (
            float(item.get("timeline_start", 0.0) or 0.0),
            str(item.get("item_id") or ""),
        ),
    )

    with tempfile.TemporaryDirectory(prefix=f"freezone_compose_{job_id}_") as temp_dir_str:
        temp_dir = Path(temp_dir_str)
        segment_paths: list[Path] = []
        cursor = 0.0
        for index, item in enumerate(sorted_video_items):
            timeline_start = float(item.get("timeline_start", 0.0) or 0.0)
            source_start = float(item.get("source_start", 0.0) or 0.0)
            source_end = float(item.get("source_end", 0.0) or 0.0)
            duration = source_end - source_start
            if duration <= 0:
                raise RuntimeError(
                    f"compose item {item.get('item_id') or index} has invalid source range"
                )
            if timeline_start < cursor - 1e-6:
                raise RuntimeError("overlapping video clips are not supported in MVP compose")
            if timeline_start > cursor + 1e-6:
                gap_path = temp_dir / f"gap_{index:03d}.mp4"
                await _render_gap_clip(
                    output_path=gap_path,
                    duration=timeline_start - cursor,
                    width=width,
                    height=height,
                    fps=fps,
                    background_color=background_color,
                )
                segment_paths.append(gap_path)
                cursor = timeline_start

            clip_path = temp_dir / f"video_{index:03d}.mp4"
            await _render_video_clip(
                source_path=str(item["source_path"]),
                output_path=clip_path,
                source_start=source_start,
                duration=duration,
                width=width,
                height=height,
                fps=fps,
                background_color=background_color,
                keep_original_audio=keep_original_audio,
                volume=float(item.get("volume", 1.0) or 1.0),
                muted=bool(item.get("muted")),
            )
            segment_paths.append(clip_path)
            cursor = timeline_start + duration

        concatenated_path = temp_dir / "concatenated.mp4"
        await _concat_media_segments(segment_paths, concatenated_path)
        await _mix_audio_tracks(
            base_video_path=concatenated_path,
            final_output_path=final_output_path,
            audio_items=audio_items,
            temp_dir=temp_dir,
        )

    if not final_output_path.exists():
        raise RuntimeError("video compose finished without output file")
    return final_output_path


async def _probe_video_size(source_path: str) -> tuple[int, int]:
    proc = await asyncio.to_thread(
        subprocess.run,
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            source_path,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "").strip()[-500:] or "ffprobe size failed")
    text = (proc.stdout or "").strip()
    try:
        width_text, height_text = text.split("x", 1)
        return int(width_text), int(height_text)
    except Exception as exc:
        raise RuntimeError(f"unable to parse video size: {text}") from exc


async def _probe_video_duration(source_path: str) -> float:
    proc = await asyncio.to_thread(
        subprocess.run,
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            source_path,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "").strip()[-500:] or "ffprobe duration failed")
    try:
        return max(0.1, float((proc.stdout or "").strip()))
    except ValueError as exc:
        raise RuntimeError("unable to parse video duration") from exc


def _expand_mask(mask: np.ndarray, radius: int = 2) -> np.ndarray:
    expanded = mask.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx == 0 and dy == 0:
                continue
            expanded |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return expanded


def _safe_box_from_pixels(
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    width: int,
    height: int,
    *,
    pad_x: int = 12,
    pad_y: int = 10,
) -> tuple[int, int, int, int]:
    left = max(0, x0 - pad_x)
    top = max(0, y0 - pad_y)
    right = min(width, x1 + pad_x)
    bottom = min(height, y1 + pad_y)
    return left, top, max(8, right - left), max(8, bottom - top)


def _fallback_subtitle_box(width: int, height: int) -> tuple[int, int, int, int]:
    box_w = int(width * 0.8)
    box_h = max(24, int(height * 0.16))
    x = int((width - box_w) / 2)
    y = int(height * 0.78)
    y = min(max(0, y), max(0, height - box_h))
    return x, y, box_w, box_h


def _detect_subtitle_box_from_image(image_path: Path) -> tuple[int, int, int, int] | None:
    image = Image.open(image_path).convert("RGB")
    arr = np.asarray(image, dtype=np.int16)
    height, width = arr.shape[:2]
    start_y = int(height * 0.55)
    roi = arr[start_y:, :, :]
    gray = ((roi[:, :, 0] * 299 + roi[:, :, 1] * 587 + roi[:, :, 2] * 114) // 1000).astype(np.int16)
    edge = np.zeros_like(gray)
    edge[:, 1:] += np.abs(gray[:, 1:] - gray[:, :-1])
    edge[1:, :] += np.abs(gray[1:, :] - gray[:-1, :])
    candidate = ((gray >= 205) | (gray <= 50)) & (edge >= 42)
    candidate = _expand_mask(candidate, radius=2)

    ys, xs = np.where(candidate)
    if len(xs) < max(80, width // 120):
        return None
    x0 = int(xs.min())
    x1 = int(xs.max()) + 1
    y0 = int(ys.min()) + start_y
    y1 = int(ys.max()) + 1 + start_y
    if (x1 - x0) < width * 0.12 or (y1 - y0) < 10:
        return None
    if (y1 - y0) > height * 0.22:
        return None
    return _safe_box_from_pixels(x0, y0, x1, y1, width, height)


async def _extract_sample_frames(video_path: str, temp_dir: Path, count: int = 6) -> list[Path]:
    duration = await _probe_video_duration(video_path)
    sample_paths: list[Path] = []
    for index in range(count):
        ts = duration * (index + 1) / (count + 1)
        output_path = temp_dir / f"sample_{index:02d}.png"
        await _run_cmd(
            [
                "ffmpeg",
                "-y",
                "-ss",
                f"{ts:.3f}",
                "-i",
                video_path,
                "-frames:v",
                "1",
                str(output_path),
            ]
        )
        if output_path.exists():
            sample_paths.append(output_path)
    return sample_paths


async def _detect_subtitle_box(video_path: str, temp_dir: Path) -> tuple[int, int, int, int]:
    width, height = await _probe_video_size(video_path)
    sample_paths = await _extract_sample_frames(video_path, temp_dir)
    boxes = [box for box in (_detect_subtitle_box_from_image(path) for path in sample_paths) if box]
    if not boxes:
        return _fallback_subtitle_box(width, height)

    left = int(np.median([box[0] for box in boxes]))
    top = int(np.median([box[1] for box in boxes]))
    right = int(np.median([box[0] + box[2] for box in boxes]))
    bottom = int(np.median([box[1] + box[3] for box in boxes]))
    return _safe_box_from_pixels(left, top, right, bottom, width, height)


def _normalized_box_to_pixels(
    *,
    box_x: float,
    box_y: float,
    box_width: float,
    box_height: float,
    width: int,
    height: int,
) -> tuple[int, int, int, int]:
    x = int(round(box_x * width))
    y = int(round(box_y * height))
    w = int(round(box_width * width))
    h = int(round(box_height * height))
    x = min(max(0, x), max(0, width - 8))
    y = min(max(0, y), max(0, height - 8))
    w = min(max(8, w), width - x)
    h = min(max(8, h), height - y)
    return x, y, w, h


async def _render_delogo_video(
    *,
    source_path: str,
    output_path: Path,
    x: int,
    y: int,
    w: int,
    h: int,
) -> None:
    await _run_cmd(
        [
            "ffmpeg",
            "-y",
            "-i",
            source_path,
            "-vf",
            f"delogo=x={x}:y={y}:w={w}:h={h}:show=0",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-c:a",
            "copy",
            str(output_path),
        ]
    )


async def run_freezone_video_erase(
    *,
    project_dir: Path,
    job_id: str,
    source_path: str,
    mode: str,
    box_x: float | None = None,
    box_y: float | None = None,
    box_width: float | None = None,
    box_height: float | None = None,
) -> tuple[Path, dict[str, int | str]]:
    """Erase subtitle-like overlays or a selected box from a video.

    Current MVP uses ffmpeg `delogo`, which is stable and fast for fixed overlay regions.
    """
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH; install via brew/apt")
    if not shutil.which("ffprobe"):
        raise RuntimeError("ffprobe not found on PATH; install via brew/apt")

    output_dir = outputs_dir(project_dir, "freezone_video_erase")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{job_id}.mp4"

    width, height = await _probe_video_size(source_path)
    with tempfile.TemporaryDirectory(prefix=f"freezone_erase_{job_id}_") as temp_dir_str:
        temp_dir = Path(temp_dir_str)
        if mode == "smart_subtitle":
            x, y, w, h = await _detect_subtitle_box(source_path, temp_dir)
        elif mode == "box":
            if None in {box_x, box_y, box_width, box_height}:
                raise RuntimeError("box mode requires box_x, box_y, box_width and box_height")
            x, y, w, h = _normalized_box_to_pixels(
                box_x=float(box_x),
                box_y=float(box_y),
                box_width=float(box_width),
                box_height=float(box_height),
                width=width,
                height=height,
            )
        else:
            raise RuntimeError(f"unsupported erase mode: {mode}")
        await _render_delogo_video(
            source_path=source_path,
            output_path=output_path,
            x=x,
            y=y,
            w=w,
            h=h,
        )
    if not output_path.exists():
        raise RuntimeError("video erase finished without output file")
    return output_path, {"mode": mode, "x": x, "y": y, "width": w, "height": h}


async def run_freezone_audio_separate(
    *,
    project_dir: Path,
    job_id: str,
    source_path: str,
) -> dict[str, Path | None]:
    """Split a video into extracted audio and muted video using ffmpeg only."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH; install via brew/apt")
    if not shutil.which("ffprobe"):
        raise RuntimeError("ffprobe not found on PATH; install via brew/apt")

    output_dir = outputs_dir(project_dir, "freezone_audio_separate")
    output_dir.mkdir(parents=True, exist_ok=True)
    audio_path = output_dir / f"{job_id}.m4a"
    mute_video_path = output_dir / f"{job_id}_mute.mp4"

    has_audio = await _probe_has_audio(source_path)
    if has_audio:
        await _run_cmd(
            [
                "ffmpeg",
                "-y",
                "-i",
                source_path,
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(audio_path),
            ]
        )

    await _run_cmd(
        [
            "ffmpeg",
            "-y",
            "-i",
            source_path,
            "-c:v",
            "copy",
            "-an",
            str(mute_video_path),
        ]
    )

    if not mute_video_path.exists():
        raise RuntimeError("audio separate finished without muted video output")
    return {
        "audio_path": audio_path if audio_path.exists() else None,
        "mute_video_path": mute_video_path,
    }


async def run_freezone_video_gen(
    *,
    project_dir: Path,
    job_id: str,
    prompt: str,
    reference_items: Optional[list[dict[str, str]]] = None,
    aspect_ratio: str = "16:9",
    resolution: str = "720p",
    duration_seconds: int = 5,
    generate_audio: bool = False,
    human_review: bool = False,
    scene_optimize: str | None = None,
    backend: str = "huimeng_seedance-2.0-fast",
    last_frame_path: Optional[str] = None,
    audio_setting: Optional[str] = None,
) -> Path:
    """Freezone 文生视频。

    统一承接 Freezone 视频生成，支持：
    - 纯 prompt 文生视频
    - prompt + 角色参考图
    - 首帧 / 尾帧参考
    - 原生音频开关（由具体模型决定）
    """
    out = outputs_dir(project_dir, "freezone_video_gen") / f"{job_id}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)

    from novelvideo.generators.video_generator import (
        ShotReference,
        create_video_generator,
        parse_newapi_video_backend,
    )

    references = [
        ShotReference(
            str(item.get("type") or "image"),
            str(item.get("path") or ""),
            str(item.get("role") or ""),
        )
        for item in (reference_items or [])
        if str(item.get("path") or "").strip()
    ]
    from novelvideo.freezone.video_node import is_freezone_seedance2_backend

    video_gen = create_video_generator(
        backend=backend,
        resolution=resolution,
        generate_audio=generate_audio,
    )
    if backend == "seedance_2":
        result = await video_gen.generate(
            prompt=prompt,
            output_path=str(out),
            references=references,
            duration=float(duration_seconds),
            audio=bool(generate_audio),
            human_review=bool(human_review),
            aspect_ratio=aspect_ratio,
            resolution=resolution,
        )
    else:
        first_image_ref = next((ref for ref in references if ref.type == "image"), None)
        if (
            (first_image_ref is None or not first_image_ref.path)
            and not str(backend).startswith("huimeng_")
            and not parse_newapi_video_backend(backend)
            and not is_freezone_seedance2_backend(backend)
        ):
            raise RuntimeError(f"backend {backend} requires a first-frame image reference")
        extra_kwargs: dict[str, object] = {}
        if audio_setting:
            extra_kwargs["audio_setting"] = audio_setting
        result = await video_gen.generate(
            image_path=first_image_ref.path if first_image_ref and first_image_ref.path else None,
            prompt=prompt,
            output_path=str(out),
            aspect_ratio=aspect_ratio,
            duration=float(duration_seconds),
            last_frame_path=last_frame_path,
            references=references,
            human_review=bool(human_review),
            seedance2_config={"scene_optimize": scene_optimize} if scene_optimize else None,
            **extra_kwargs,
        )
    if not result or result.status.value != "done":
        err = result.error if result else "unknown error"
        raise RuntimeError(f"freezone video generation failed: {err}")
    if not out.exists():
        raise RuntimeError("video generation returned success but no output file was written")
    return out


# ============================================================
# Extract frames (M1a) — 视频拉片
# ============================================================


async def run_freezone_extract_frames(
    *,
    project_dir: Path,
    job_id: str,
    video_path: Path,
    max_frames: int = 20,
    scene_threshold: float = 0.3,
) -> list[Path]:
    """ffmpeg pixel-diff scene detection → up to `max_frames` keyframes.

    Uses ffmpeg's built-in `scene` filter (returns 0-1 confidence per frame
    transition); we pick frames where confidence > threshold. If the video
    has fewer scene cuts than `max_frames` we fall back to evenly-spaced
    sampling to guarantee at least a few frames.

    Returns absolute paths to the saved frame PNGs.
    """
    import asyncio
    import shutil
    import subprocess

    out_dir = outputs_dir(project_dir, "freezone_extract") / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH; install via brew/apt")
    if not video_path.exists():
        raise FileNotFoundError(f"video not found: {video_path}")

    # Pass 1: scene detection extraction.
    pattern = str(out_dir / "scene_%03d.png")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        f"select='gt(scene,{scene_threshold})'",
        "-vsync",
        "vfr",
        "-frames:v",
        str(max_frames),
        "-frame_pts",
        "true",
        pattern,
    ]
    proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg scene detect failed: {proc.stderr[-500:]}")

    scene_files = sorted(out_dir.glob("scene_*.png"))

    # Fallback: if too few scene cuts (e.g. talking head static video),
    # sample evenly-spaced frames so the user always gets *something*.
    if len(scene_files) < 3:
        for f in scene_files:
            f.unlink(missing_ok=True)
        scene_files = await _sample_evenly(video_path, out_dir, max_frames)

    return scene_files


# ============================================================
# Analyze shots (M1b) — Gemini Vision 拆分镜
# ============================================================


SHOT_ANALYSIS_PROMPT = """你是一个专业的电影分镜师。下面给你一组视频关键帧（按时间顺序），请逐帧分析每帧的电影语言。

对每帧输出一个 JSON 对象，字段：
- shot_type: 景别（"特写" | "近景" | "中景" | "全景" | "远景" | "大远景"）
- angle: 镜头角度（"平视" | "俯拍" | "仰拍" | "鸟瞰" | "倾斜" 等）
- camera_movement: 推测的运镜（"静止" | "推镜" | "拉镜" | "摇镜" | "移镜" | "升降" | "跟镜" 等，没有上下文则填"静止"）
- subject_action: 主体动作的简短描述（中文，<= 20 字，没有主体则"环境镜头"）
- mood: 氛围（"温馨" | "紧张" | "压抑" | "明快" | "孤独" 等）
- color_tone: 色调（"暖色调" | "冷色调" | "高饱和" | "低饱和" | "黑白" 等）
- suggested_prompt: 一句中文文生图 prompt，用于让 AI 重现这帧的视觉风格（包含上面所有元素，<= 80 字）

输出格式严格为 JSON 数组（不要任何解释 / markdown 包裹），第 i 个元素对应第 i 帧。例如：
[
  {"shot_type": "近景", "angle": "平视", "camera_movement": "静止", "subject_action": "环境镜头", "mood": "明快", "color_tone": "高饱和", "suggested_prompt": "..."},
  ...
]
"""


def build_video_story_analysis_prompt(
    *, frame_count: int, duration_sec: Optional[float] = None
) -> str:
    duration_hint = (
        f"视频总时长约 {duration_sec:.2f} 秒。"
        f"请把 start_time/end_time 分配在 0 到 {duration_sec:.2f} 秒之间。"
        if duration_sec and duration_sec > 0
        else (
            "未知视频总时长。请根据关键帧顺序给出相对合理的 "
            "start_time/end_time，第一镜从 0 开始。"
        )
    )
    return f"""你是专业影视导演和分镜解析师。下面给你 {frame_count} 张
按时间顺序抽取的视频关键帧，请解析成 libtv 风格的“视频故事”表。

{duration_hint}

要求：
- 不要逐帧机械描述，要把连续关键帧归纳成 3-12 个叙事镜头/动作段落。
- 保持同一视频内部的故事连续性：谁在做什么，发生了什么变化，
  镜头如何推进。
- 时间字段使用数字秒，duration = end_time - start_time。
- 画面描述写清主体、动作、环境、构图、情绪、重要道具。
- 叙事内容写这一镜在故事中的作用，而不是重复画面描述。
- 图生视频提示词和视频运动提示词用英文，适合直接用于视频生成。
- 背景音乐、人声/音效用中文，简洁描述。
- 关键帧使用输入帧序号，1 到 {frame_count}。
- 如果看不出声音，不要编对白，只写可由画面推断的音效/氛围。
- 严格输出 JSON 对象，不要 markdown，不要解释。

JSON schema:
{{
  "title": "中文短标题",
  "summary": "中文一句话概括视频故事",
  "duration": 数字秒或 null,
  "shots": [
    {{
      "shot": 1,
      "start_time": 0.0,
      "end_time": 1.2,
      "duration": 1.2,
      "visual_description": "中文画面描述",
      "narrative": "中文叙事内容",
      "shot_size": "特写/近景/中近景/中景/全景/远景/大远景",
      "camera_angle": "平视/俯拍/仰拍/倾斜/高角度/低角度",
      "camera_movement": "固定/推镜/拉镜/摇镜/移镜/跟镜/手持/缓慢推进",
      "focus_depth": "浅景深/中等景深/深景深",
      "lighting": "中文光线描述",
      "background_music": "中文背景音乐建议",
      "voice_sound": "中文人声或音效",
      "image_prompt": "English image-to-video visual prompt",
      "motion_prompt": "English motion prompt",
      "keyframes": [1, 2]
    }}
  ]
}}
"""


async def run_freezone_analyze_shots(
    *,
    project_dir: Path,
    job_id: str,
    frame_paths: list[str],
    api_key: Optional[str] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    analysis_mode: str = "shots",
    duration_sec: Optional[float] = None,
) -> dict:
    """Send N frames to a Vision model and parse a structured JSON response.

    Product requests always use the effective NewAPI gateway. ``provider`` is
    retained only for payload compatibility with older saved canvases.
    """
    import json

    from novelvideo.freezone.vision_gateway import (
        VisionInput,
        call_freezone_vision_model,
        image_media_type,
    )

    if not frame_paths:
        raise ValueError("no frames to analyze")

    out_dir = outputs_dir(project_dir, "freezone_analyze") / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    del provider
    mode = (analysis_mode or "shots").strip().lower()
    if mode not in {"shots", "video_story"}:
        raise ValueError(f"unsupported analysis_mode: {analysis_mode}")
    prompt = (
        build_video_story_analysis_prompt(
            frame_count=len(frame_paths),
            duration_sec=duration_sec,
        )
        if mode == "video_story"
        else SHOT_ANALYSIS_PROMPT
    )

    del api_key
    vision_model, text = await call_freezone_vision_model(
        prompt=prompt,
        images=[
            VisionInput(
                data=Path(path).read_bytes(),
                media_type=image_media_type(path),
            )
            for path in frame_paths
            if Path(path).exists()
        ],
        model_override=model,
    )
    used_provider = "newapi"

    if not text:
        raise RuntimeError(f"{used_provider} Vision returned no text")

    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(
            line for line in cleaned.splitlines() if not line.strip().startswith("```")
        ).strip()
    try:
        analyses = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        (out_dir / "raw_response.txt").write_text(text, encoding="utf-8")
        raise RuntimeError(f"{used_provider} returned non-JSON: {exc}; raw saved") from exc

    if mode == "video_story":
        if not isinstance(analyses, dict):
            raise RuntimeError(f"{used_provider} response is not an object")
    elif not isinstance(analyses, list):
        raise RuntimeError(f"{used_provider} response is not a list")

    payload = {
        "provider": used_provider,
        "model": vision_model,
        "analysis_mode": mode,
        "frame_count": len(frame_paths),
    }
    if mode == "video_story":
        payload["video_story"] = analyses
        payload["analyses"] = analyses.get("shots", [])
    else:
        payload["analyses"] = analyses
    out_file = out_dir / "analysis.json"
    out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    payload["output_path"] = str(out_file)
    return payload


async def _sample_evenly(video_path: Path, out_dir: Path, max_frames: int) -> list[Path]:
    """Fallback when scene detection finds nothing — sample at regular intervals."""
    import asyncio
    import json
    import subprocess

    probe = await asyncio.to_thread(
        subprocess.run,
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration,nb_frames",
            "-of",
            "json",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    duration = 60.0
    if probe.returncode == 0:
        try:
            payload = json.loads(probe.stdout)
            duration = float(payload["streams"][0].get("duration") or 60.0)
        except (json.JSONDecodeError, KeyError, IndexError, ValueError):
            pass

    n = min(max(3, max_frames // 2), max_frames)
    fps_expr = f"1/{max(1.0, duration / n)}"
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        f"fps={fps_expr}",
        "-frames:v",
        str(n),
        str(out_dir / "even_%03d.png"),
    ]
    await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=300)
    return sorted(out_dir.glob("even_*.png"))


_SIZE_BASE = {
    "0.5K": 512,
    "1K": 1024,
    "2K": 2048,
    "4K": 4096,
}


def _aspect_to_dims(aspect_ratio: str, image_size: str) -> tuple[int, int]:
    base = _SIZE_BASE.get(image_size.upper(), 1024)
    try:
        w_part, h_part = aspect_ratio.split(":", 1)
        w_ratio = float(w_part)
        h_ratio = float(h_part)
    except (ValueError, AttributeError):
        return base, base
    if w_ratio <= 0 or h_ratio <= 0:
        return base, base
    if w_ratio >= h_ratio:
        return base, max(64, round(base * h_ratio / w_ratio))
    return max(64, round(base * w_ratio / h_ratio)), base

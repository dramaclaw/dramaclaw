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
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image

from novelvideo.freezone.paths import output_path_for_job, outputs_dir
from novelvideo.egress_context import (
    TrustedEgressContext,
    ambient_organization_egress_context,
)
from novelvideo.ports.egress import EgressError
from novelvideo.task_backend.subprocesses import (
    EgressBoundaryError,
    RestrictedSubprocessPolicy,
    run_project_subprocess,
)

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
    model_params: Optional[dict[str, Any]] = None,
    request_schema: Optional[dict[str, Any]] = None,
    output_task_type: str = "freezone_gen",
    egress_context: TrustedEgressContext | None = None,
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
    if egress_context is not None and type(egress_context) is not TrustedEgressContext:
        raise TypeError("egress_context must be a TrustedEgressContext")
    if egress_context is None:
        egress_context = ambient_organization_egress_context()
    if (
        egress_context is not None
        and egress_context.is_organization
        and (provider or "").lower() == "volcengine"
    ):
        raise EgressError("ORG_EGRESS_DENIED")
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

    if egress_context is not None and egress_context.is_organization:
        cfg = {
            "provider": "newapi",
            "api_key": "request-scoped",
            "base_url": "https://request-scoped.invalid/v1",
            "model": model or "gpt-image-2",
            "mode": "1x1",
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        }
    else:
        cfg = get_grid_generation_config(
            provider_override=provider,
            model_override=model,
            image_size_override=image_size,
        )
    cfg["newapi_model_params"] = model_params or {}
    cfg["newapi_request_schema"] = request_schema or {}
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
            egress_context=egress_context,
            egress_capability="freezone.image.generate",
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
            egress_context=egress_context,
            egress_capability="freezone.image.generate",
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
    egress_context: TrustedEgressContext | None = None,
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

    if egress_context is not None and type(egress_context) is not TrustedEgressContext:
        raise TypeError("egress_context must be a TrustedEgressContext")
    if egress_context is None:
        egress_context = ambient_organization_egress_context()
    if egress_context is not None and egress_context.is_organization:
        # 与 run_freezone_edit 同一口径：组织下不读本地目录配置。
        # `get_grid_generation_config` 可能返回非 newapi provider，而组织出网闸门
        # （`nanobanana_grid.py:138-139`）对非 newapi 一律 ORG_EGRESS_DENIED。
        cfg = {
            "provider": "newapi",
            "api_key": "request-scoped",
            "base_url": "https://request-scoped.invalid/v1",
            "model": model or "gpt-image-2",
            "mode": "1x1",
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        }
    else:
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
            egress_context=egress_context,
            egress_capability="freezone.image.generate",
        )
    except Exception as exc:
        raise RuntimeError(
            f"{provider_name} 图像擦除失败：{redact_secrets(exc)}"
        ) from exc
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
    model_params: Optional[dict[str, Any]] = None,
    request_schema: Optional[dict[str, Any]] = None,
    output_task_type: str = "freezone_edit",
    egress_context: TrustedEgressContext | None = None,
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

    if egress_context is not None and type(egress_context) is not TrustedEgressContext:
        raise TypeError("egress_context must be a TrustedEgressContext")
    if egress_context is None:
        egress_context = ambient_organization_egress_context()
    if egress_context is not None and egress_context.is_organization:
        cfg = {
            "provider": "newapi",
            "api_key": "request-scoped",
            "base_url": "https://request-scoped.invalid/v1",
            "model": model or "gpt-image-2",
            "mode": "1x1",
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        }
    else:
        cfg = get_grid_generation_config(
            provider_override=provider,
            model_override=model,
            image_size_override=image_size,
        )
    # 与 run_freezone_gen 同一口径：目录声明的动态参数按 schema 里的 requestPath
    # 写进网关请求体。少了这两行，图编辑侧的 model_params 会在这里被丢掉。
    # 组织支同样要带上——请求作用域凭据只换掉出网身份，不改请求体形状。
    cfg["newapi_model_params"] = model_params or {}
    cfg["newapi_request_schema"] = request_schema or {}
    await generate_reference_edit_image(
        prompt=prompt,
        reference_images=refs,
        output_path=str(out),
        aspect_ratio=aspect_ratio,
        image_size=image_size,
        quality=quality,
        api_key=api_key,
        config=cfg,
        egress_context=egress_context,
        egress_capability="freezone.image.generate",
    )
    return out


def ensure_freezone_dirs(project_dir: Path) -> None:
    """Create freezone subdirectories on first use; cheap and idempotent."""
    (project_dir / "freezone" / "_uploads").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_gen").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_edit").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_upscale").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_video_gen").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_video_compose").mkdir(
        parents=True, exist_ok=True
    )
    outputs_dir(project_dir, "freezone_extract").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_analyze").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_mask_edit").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_video_erase").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_video_upscale").mkdir(
        parents=True, exist_ok=True
    )
    outputs_dir(project_dir, "freezone_audio_separate").mkdir(
        parents=True, exist_ok=True
    )
    outputs_dir(project_dir, "freezone_audio_speech").mkdir(parents=True, exist_ok=True)
    outputs_dir(project_dir, "freezone_audio_eleven_music").mkdir(
        parents=True, exist_ok=True
    )
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
    filters = [
        f"scale='if(gte(iw,ih),{target},-2)':"
        f"'if(gte(iw,ih),-2,{target})':flags=lanczos"
    ]
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


async def _run_cmd(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    egress_context=None,
) -> None:
    if egress_context is None:
        proc = await asyncio.to_thread(
            subprocess.run,
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=1800,
        )
    else:
        if cwd is None:
            raise EgressBoundaryError("ORG_SERVICE_EGRESS_DENIED")
        minimal_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": os.environ.get("LANG", "C.UTF-8"),
        }
        policy = RestrictedSubprocessPolicy(
            command=tuple(cmd),
            cwd=cwd.resolve(),
            env=minimal_env,
        )
        proc = await asyncio.to_thread(
            run_project_subprocess,
            cmd,
            cwd=cwd,
            env=minimal_env,
            egress_context=egress_context,
            restricted_policy=policy,
            capture_output=True,
            text=True,
            timeout=1800,
        )
    if proc.returncode != 0:
        if egress_context is not None:
            raise EgressBoundaryError("ORG_SERVICE_EGRESS_DENIED")
        stderr = (proc.stderr or "").strip()
        raise RuntimeError(stderr[-1000:] or f"command failed: {' '.join(cmd)}")


async def _try_run_cmd(cmd: list[str]) -> bool:
    """跑一条命令，失败只回 ``False``。

    给「没有产出也属于正常结果」的探测性调用用 —— 比如场景检测抽帧，一镜到底的
    素材本来就一个切点都没有，不该当成错误往上抛。
    """

    proc = await asyncio.to_thread(
        subprocess.run,
        cmd,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    return proc.returncode == 0


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
    has_audio = (
        keep_original_audio and (not muted) and await _probe_has_audio(source_path)
    )

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
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".txt", delete=False
    ) as handle:
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

    with tempfile.TemporaryDirectory(
        prefix=f"freezone_compose_{job_id}_"
    ) as temp_dir_str:
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
                raise RuntimeError(
                    "overlapping video clips are not supported in MVP compose"
                )
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
        raise RuntimeError(
            (proc.stderr or "").strip()[-500:] or "ffprobe duration failed"
        )
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


def _detect_subtitle_box_from_image(
    image_path: Path,
) -> tuple[int, int, int, int] | None:
    image = Image.open(image_path).convert("RGB")
    arr = np.asarray(image, dtype=np.int16)
    height, width = arr.shape[:2]
    start_y = int(height * 0.55)
    roi = arr[start_y:, :, :]
    gray = (
        (roi[:, :, 0] * 299 + roi[:, :, 1] * 587 + roi[:, :, 2] * 114) // 1000
    ).astype(np.int16)
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


async def _extract_sample_frames(
    video_path: str, temp_dir: Path, count: int = 6
) -> list[Path]:
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


async def _detect_subtitle_box(
    video_path: str, temp_dir: Path
) -> tuple[int, int, int, int]:
    width, height = await _probe_video_size(video_path)
    sample_paths = await _extract_sample_frames(video_path, temp_dir)
    boxes = [
        box
        for box in (_detect_subtitle_box_from_image(path) for path in sample_paths)
        if box
    ]
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
    with tempfile.TemporaryDirectory(
        prefix=f"freezone_erase_{job_id}_"
    ) as temp_dir_str:
        temp_dir = Path(temp_dir_str)
        if mode == "smart_subtitle":
            x, y, w, h = await _detect_subtitle_box(source_path, temp_dir)
        elif mode == "box":
            if None in {box_x, box_y, box_width, box_height}:
                raise RuntimeError(
                    "box mode requires box_x, box_y, box_width and box_height"
                )
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
    gen_mode: Optional[str] = None,
    model_params: Optional[dict[str, Any]] = None,
    request_schema: Optional[dict[str, Any]] = None,
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
        model_params=model_params,
        request_schema=request_schema,
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
        normalized_mode = {
            "firstLastFrame": "first_last_frame",
            "imageToVideo": "image_reference",
            "imageReference": "image_reference",
        }.get(str(gen_mode or "").strip(), str(gen_mode or "").strip())
        if normalized_mode in {"first_frame", "first_last_frame"}:
            first_image_ref = next(
                (
                    ref
                    for ref in references
                    if ref.type == "image" and "首帧" in str(ref.role or "")
                ),
                None,
            )
        else:
            first_image_ref = next((ref for ref in references if ref.type == "image"), None)
        if (
            (first_image_ref is None or not first_image_ref.path)
            and not str(backend).startswith("huimeng_")
            and not parse_newapi_video_backend(backend)
            and not is_freezone_seedance2_backend(backend)
        ):
            raise RuntimeError(
                f"backend {backend} requires a first-frame image reference"
            )
        extra_kwargs: dict[str, object] = {}
        if audio_setting:
            extra_kwargs["audio_setting"] = audio_setting
        result = await video_gen.generate(
            image_path=(
                first_image_ref.path
                if first_image_ref and first_image_ref.path
                else None
            ),
            prompt=prompt,
            output_path=str(out),
            aspect_ratio=aspect_ratio,
            duration=float(duration_seconds),
            last_frame_path=last_frame_path,
            references=references,
            human_review=bool(human_review),
            seedance2_config=(
                {"scene_optimize": scene_optimize} if scene_optimize else None
            ),
            gen_mode=gen_mode,
            **extra_kwargs,
        )
    if not result or result.status.value != "done":
        err = result.error if result else "unknown error"
        raise RuntimeError(f"freezone video generation failed: {err}")
    if not out.exists():
        raise RuntimeError(
            "video generation returned success but no output file was written"
        )
    return out


# ============================================================
# Extract frames (M1a) — 视频拉片
# ============================================================


def sort_extracted_frames_by_pts(paths: Iterable[Path]) -> list[Path]:
    """按文件名尾部的数值排序抽帧结果，而不是按字典序。

    ``-frame_pts true`` 让 ffmpeg 把 ``%03d`` 填成该帧的 PTS 而不是递增计数，
    于是文件名位数不固定：字典序会把 ``scene_1000.png`` 排到 ``scene_900.png``
    前面，送进模型的关键帧顺序和 ``keyframe_index`` 映射就全乱了。
    """

    def sort_key(path: Path) -> tuple[int, int, str]:
        match = re.search(r"(\d+)$", path.stem)
        if match is None:
            # 没有数字后缀的（理论上不该出现）排到最后，按名字兜底。
            return (1, 0, path.name)
        return (0, int(match.group(1)), path.name)

    return sorted(paths, key=sort_key)


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
    proc = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=600
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg scene detect failed: {proc.stderr[-500:]}")

    scene_files = sort_extracted_frames_by_pts(out_dir.glob("scene_*.png"))

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


_MAX_JSON_REPAIRS = 32
_MERGED_JSON_KEY_RE = re.compile(
    r'^(?P<name>[A-Za-z_][A-Za-z0-9_]*?)(?P<value>-?\d+(?:\.\d+)?),?$'
)


def _strip_json_fence(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(
            line for line in cleaned.splitlines() if not line.strip().startswith("```")
        ).strip()
    return cleaned


def _split_merged_json_key(text: str, pos: int) -> Optional[str]:
    """``{"shot25,"segment"...`` → ``{"shot":25,"segment"...``

    视觉模型偶尔会把键、值、逗号糊成一个字符串（漏掉 ``":``）。这类笔误往往在同
    一份输出里连着犯好几次，一处一处补回来比整份作废划算得多。
    """

    end_quote = text.rfind('"', 0, pos)
    if end_quote <= 0:
        return None
    start_quote = text.rfind('"', 0, end_quote)
    if start_quote == -1:
        return None
    match = _MERGED_JSON_KEY_RE.match(text[start_quote + 1 : end_quote])
    if not match:
        return None
    fixed = f'"{match.group("name")}":{match.group("value")},'
    return text[:start_quote] + fixed + text[end_quote:]


def _drop_broken_json_element(text: str, pos: int) -> Optional[str]:
    """把解析出错的那个数组元素整段删掉，返回新文本；下不了手就返回 None。"""

    start = text.rfind("{", 0, pos + 1)
    if start <= 0:  # 0 是整份文档的开头，删了就什么都不剩
        return None
    end = text.find("}", pos)
    if end == -1:
        return None

    head = text[:start].rstrip()
    tail = text[end + 1 :].lstrip()
    if head.endswith("["):  # 数组第一个元素
        return head + (tail[1:] if tail.startswith(",") else tail)
    if head.endswith(","):  # 中间或最后一个元素
        return head[:-1] + tail
    return None


def loads_model_json(text: str) -> Any:
    """解析模型返回的 JSON，写坏的地方就地修补，而不是整份作废。

    视觉模型偶尔会把 ``"shot":25`` 写成 ``"shot25``，一个 token 的笔误就能让
    整份 20KB 的读片表报废。先按笔误模式补，补不回来的元素才整段丢掉。
    """

    cleaned = _strip_json_fence(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as exc:
        first_error = exc  # except 块结束就会解绑 exc，这里留一份

    repaired = cleaned
    for _ in range(_MAX_JSON_REPAIRS):
        try:
            parsed = json.loads(repaired)
        except json.JSONDecodeError as exc:
            candidate = _split_merged_json_key(repaired, exc.pos) or _drop_broken_json_element(
                repaired, exc.pos
            )
            if candidate is None or candidate == repaired:
                break
            repaired = candidate
            continue
        logger.warning(
            "model JSON was malformed at char %s; repaired and recovered", first_error.pos
        )
        return parsed
    raise first_error


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
    egress_context: TrustedEgressContext | None = None,
) -> dict:
    """Send N frames to a Vision model and parse a structured JSON response.

    Product requests always use the effective NewAPI gateway. ``provider`` is
    retained only for payload compatibility with older saved canvases.
    """
    import json

    from novelvideo.freezone import vision_gateway
    from novelvideo.freezone.vision_gateway import (
        FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
        load_compact_vision_inputs,
        resolve_freezone_vision_model,
    )

    # 与 `image_node.reverse_prompt_from_image` 同一口径：出网 helper 在函数体内
    # 引进来，不放模块级——leaf 模块的导入面本身是分类契约的一部分。
    from novelvideo.freezone.presets import (
        abandon_freezone_vision_egress,
        complete_freezone_vision_egress,
        prepare_freezone_vision_egress,
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
    frame_inputs = await load_compact_vision_inputs(
        [path for path in frame_paths if Path(path).exists()]
    )
    if not frame_inputs:
        raise ValueError("no readable frames to analyze")
    vision_egress = await prepare_freezone_vision_egress(
        egress_context=egress_context,
        model_name=resolve_freezone_vision_model(model),
        prompt=prompt,
        images=[image.data for image in frame_inputs],
        timeout_seconds=FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
    )
    try:
        vision_model, text = await vision_gateway.call_freezone_vision_model(
            prompt=prompt,
            images=frame_inputs,
            model_override=model,
            timeout_seconds=FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
            transport_context=(
                vision_egress.transport_context if vision_egress else None
            ),
        )
        used_provider = "newapi"

        if not text:
            raise RuntimeError(f"{used_provider} Vision returned no text")

        try:
            analyses = loads_model_json(text)
        except json.JSONDecodeError as exc:
            (out_dir / "raw_response.txt").write_text(text, encoding="utf-8")
            raise RuntimeError(
                f"{used_provider} returned non-JSON: {exc}; raw saved"
            ) from exc

        if mode == "video_story":
            if not isinstance(analyses, dict):
                raise RuntimeError(f"{used_provider} response is not an object")
        elif not isinstance(analyses, list):
            raise RuntimeError(f"{used_provider} response is not a list")
    except BaseException:
        # 出网点一抛就到不了 complete_*，claim 会停在 dispatching 等收割器。
        # 这里恒 submitted=True：帧字节在 claim 之前就读完了（digest 要用），claim
        # 与提交之间没有会抛的步骤，所以任何失败都发生在「已经交出去、结果不明」之后。
        await abandon_freezone_vision_egress(vision_egress, submitted=True)
        raise
    await complete_freezone_vision_egress(vision_egress, result=text)

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
    out_file.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    payload["output_path"] = str(out_file)
    return payload


# ============================================================
# 逐帧拉片 (video breakdown) — 一条视频拆成分镜 / 动态 / 音乐
# ============================================================


VIDEO_BREAKDOWN_DIMENSIONS: tuple[str, ...] = ("storyboard", "motion", "music")

# 模型写这些词就代表「这一镜没有运镜」，挑动态参考片段时优先跳过它们：
# 拉出来一段完全静止的画面当运镜参考是没有意义的。
_STATIC_CAMERA_MOVEMENTS = {
    "静止",
    "固定",
    "固定镜头",
    "无",
    "无运镜",
    "static",
    "fixed",
    "none",
    "still",
}

# 拉片能拆多细，上限就是喂给模型的关键帧有多密：固定 20 帧在 40 秒的片子里等于
# 每两秒才看一眼，模型只能归纳出三五个大段。这里改成按时长定帧数。
_BREAKDOWN_FRAME_INTERVAL_SEC = 1.0
_BREAKDOWN_MIN_FRAMES = 8
# 场景检测扫全片时的安全上限：快剪素材一秒能切好几刀，不封顶会写出上千张图。
_BREAKDOWN_SCENE_SCAN_LIMIT = 240
# 拉片粒度：平均每镜多长。太小翻起来比原片还累，太大又退回「三五个大段」的流水账，
# 2.5 秒是中等档 —— 45 秒的片子拆出 ~18 镜、4~5 个分镜组。
_BREAKDOWN_SHOT_TARGET_SEC = 2.5
# 送进视觉模型的帧宽上限。整帧是 base64 原图发出去的，帧数翻倍就得把单帧压下来。
_BREAKDOWN_FRAME_WIDTH = 768


def _bd_text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _bd_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed != parsed or parsed in (float("inf"), float("-inf")):  # NaN / inf
        return default
    return parsed


def _bd_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    parsed = _bd_float(value, None)
    return default if parsed is None else int(parsed)


def plan_breakdown_frame_count(*, duration_sec: Optional[float], max_frames: int) -> int:
    """按视频时长定抽帧数：每 ~1 秒一帧，下限 8 帧，上限由调用方的 ``max_frames`` 封顶。

    时长未知时只能退回上限 —— 与其猜一个密度，不如按用户给的预算抽满。
    """

    cap = max(1, int(max_frames))
    floor = min(_BREAKDOWN_MIN_FRAMES, cap)
    duration = _bd_float(duration_sec, None)
    if duration is None or duration <= 0:
        return cap
    target = int(round(duration / _BREAKDOWN_FRAME_INTERVAL_SEC))
    return max(floor, min(cap, target))


def plan_breakdown_shot_range(
    *,
    frame_count: int,
    duration_sec: Optional[float] = None,
) -> tuple[int, int]:
    """镜头数区间：按「平均每镜 2~3 秒」定中等粒度，再被帧数封顶。

    直接拿帧数当镜头数（每秒一帧就每秒一镜）会把 45 秒的片子拆成 40 镜、11 个
    分镜组，翻起来比原片还累。粒度由时长说了算，帧数只负责封顶 —— 毕竟没看过的
    画面拆不出镜头。
    """

    frames = max(1, int(frame_count))
    duration = _bd_float(duration_sec, None)
    # 抽帧本来就是每秒一张，时长探测失败时用帧数当时长的近似。
    span = duration if duration is not None and duration > 0 else float(frames)
    target = int(round(span / _BREAKDOWN_SHOT_TARGET_SEC))
    upper = max(3, min(frames, target))
    lower = max(3, min(upper, int(round(upper * 0.7))))
    return lower, upper


def build_video_breakdown_prompt(
    *,
    frame_count: int,
    duration_sec: Optional[float] = None,
    group_size: int = 4,
) -> str:
    """拉片专用的 Vision prompt。

    和 :func:`build_video_story_analysis_prompt` 有意分开：那份是「视频解读」用
    的叙事表，拉片这边多出三个硬需求 —— ``segment`` 用来分组（前端要分镜组
    01/02/03）、``lighting`` 必填（卡片标签是「景别·光线」）、外加一个整片级的
    ``music`` 块（BGM 参考片段要有描述和起点）。混进同一个 prompt 只会让两边互
    相迁就。
    """

    duration_hint = (
        f"视频总时长约 {duration_sec:.2f} 秒，"
        f"所有 start_time / end_time 必须落在 0 到 {duration_sec:.2f} 秒之间。"
        if duration_sec and duration_sec > 0
        else "未知视频总时长，请按关键帧顺序给出相对合理的时间，第一镜从 0 开始。"
    )
    shot_min, shot_max = plan_breakdown_shot_range(
        frame_count=frame_count, duration_sec=duration_sec
    )
    return f"""你是专业的影视拉片师。下面给你 {frame_count} 张按时间顺序抽取的视频关键帧，
请把这条视频拆解成可复用的参考素材。

{duration_hint}

要求：
- 拆成 {shot_min}-{shot_max} 个镜头，粒度取中：机位、景别、场景发生明显变化才另起
  一镜；同一场戏里的连续动作归进同一镜，不要逐帧拆。
- 一镜可以跨多张关键帧，start_time / end_time 要盖住这一镜的完整过程。
- segment 是分镜组编号，从 1 开始连续递增，每组最多 {group_size} 个镜头，
  同一 segment 内的镜头必须属于同一个叙事段落；段落超过 {group_size} 镜就拆成
  相邻的多个 segment。
- description 是分镜卡片标题，中文，不超过 20 字，写清主体和动作。
- narrative 写这一镜在故事里的作用，不要重复 description。
- shot_size 和 lighting 都必填，会并排显示成「景别·光线」。
- camera_movement 如实填写；确实没有运镜就写「固定」，不要为了好看编运镜。
- image_prompt / motion_prompt 用英文，可直接喂给图生视频模型。
- music 描述整片的背景音乐，start_time 指向最有代表性的一段 BGM 起点；
  听不出音乐（或视频本身没有配乐）就把 music 设为 null。
- 严格输出 JSON 对象，不要 markdown 包裹，不要任何解释。

JSON schema:
{{
  "title": "中文短标题",
  "summary": "中文一句话概括",
  "segments": [
    {{"segment": 1, "label": "中文段落名，<= 10 字"}}
  ],
  "shots": [
    {{
      "shot": 1,
      "segment": 1,
      "keyframe": 1,
      "start_time": 0.0,
      "end_time": 1.2,
      "shot_size": "特写/近景/中近景/中景/全景/远景/大远景",
      "lighting": "中文光线描述，<= 8 字",
      "camera_angle": "平视/俯拍/仰拍/倾斜",
      "camera_movement": "固定/推镜/拉镜/摇镜/移镜/跟镜/手持/升降",
      "description": "中文画面描述，<= 20 字",
      "narrative": "中文叙事作用",
      "image_prompt": "English image prompt",
      "motion_prompt": "English motion prompt"
    }}
  ],
  "music": {{
    "description": "中文 BGM 描述",
    "mood": "中文情绪，<= 6 字",
    "instruments": ["中文乐器名"],
    "bpm": 96,
    "start_time": 0.0
  }}
}}
"""


async def _extract_frame_at(*, source_path: str, output_path: Path, at_sec: float) -> None:
    """在指定秒数抽一张图。``-ss`` 放在 ``-i`` 前面走关键帧 seek，比逐帧解码快得多。"""

    await _run_cmd(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{max(at_sec, 0.0):.3f}",
            "-i",
            source_path,
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(output_path),
        ]
    )


def _pick_evenly(items: list[Path], count: int) -> list[Path]:
    """从有序列表里等距挑 ``count`` 个，首尾必取。"""

    if count <= 0:
        return []
    if count >= len(items):
        return list(items)
    if count == 1:
        return [items[0]]
    step = (len(items) - 1) / (count - 1)
    return [items[round(index * step)] for index in range(count)]


async def _extract_breakdown_frames(
    *,
    video_path: Path,
    out_dir: Path,
    target_frames: int,
    scene_threshold: float,
    duration_sec: Optional[float],
) -> list[Path]:
    """拉片专用抽帧：先扫全片切点，切点不够密再按时间等距补足。

    和 :func:`run_freezone_extract_frames` 有两处刻意的不同，都是为了「拆得更细」：

    1. 场景检测这一趟不拿目标帧数当 ``-frames:v``。那个写法会在扫到第 N 个切点时
       就停止解码，长片只能看见开头一段，后面全靠模型脑补时间轴；这里扫完整片再
       等距挑出目标张数，覆盖一直到片尾。
    2. 帧统一缩到 ``_BREAKDOWN_FRAME_WIDTH`` 宽的 JPEG。视觉请求是把整帧原图
       base64 发出去的，几十张
       1080p PNG 能把网关打爆，缩完之后帧数翻倍反而更省。
    """

    out_dir.mkdir(parents=True, exist_ok=True)
    # format=yuvj420p 不能省：mjpeg 编码器拒绝 limited-range 的 yuv420p（ffmpeg 8
    # 起直接报 "Non full-range YUV is non-standard" 开不了编码器），而绝大多数视频
    # 都是 limited range。
    scale = f"scale='min({_BREAKDOWN_FRAME_WIDTH},iw)':-2,format=yuvj420p"

    # 一个切点都没有是合法结果（长镜头素材），所以这趟失败不抛，交给下面的等距兜底。
    await _try_run_cmd(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-vf",
            f"select='gt(scene,{scene_threshold})',{scale}",
            "-fps_mode",
            "vfr",
            "-frames:v",
            str(_BREAKDOWN_SCENE_SCAN_LIMIT),
            "-frame_pts",
            "true",
            "-q:v",
            "3",
            str(out_dir / "scene_%05d.jpg"),
        ]
    )
    scene_files = sort_extracted_frames_by_pts(out_dir.glob("scene_*.jpg"))

    if len(scene_files) >= target_frames:
        picked = _pick_evenly(scene_files, target_frames)
        keep = {path.name for path in picked}
        for path in scene_files:
            if path.name not in keep:
                path.unlink(missing_ok=True)
        return picked

    # 切点太少：长镜头、一镜到底的 AI 生成片都会走到这里。等距抽帧的密度只跟时长
    # 有关，不受剪辑节奏影响，是这类素材唯一能拆细的办法。
    for path in scene_files:
        path.unlink(missing_ok=True)

    duration = _bd_float(duration_sec, None)
    if duration is None or duration <= 0:
        duration = await _probe_video_duration(str(video_path))
    # 直接给十进制 fps，别写成 "n/时长" 的分数：分母带小数时不同 ffmpeg 版本的
    # 解析行为不一致。
    fps_expr = f"{target_frames / duration:.6f}" if duration > 0 else "1"
    await _run_cmd(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-vf",
            f"fps={fps_expr},{scale}",
            "-frames:v",
            str(target_frames),
            "-q:v",
            "3",
            str(out_dir / "even_%05d.jpg"),
        ]
    )
    return sort_extracted_frames_by_pts(out_dir.glob("even_*.jpg"))


def _normalize_breakdown_shots(
    raw_shots: list[Any],
    *,
    duration_sec: float,
    frame_count: int,
    group_size: int,
) -> list[dict[str, Any]]:
    """把模型返回的 shots 洗成时间单调、字段齐全的列表。

    模型经常在时间上偷懒（漏字段、给出倒序、超出片长），这里统一兜底：缺失就按
    镜头数均分片长，越界就夹回去，保证下游切片的 ffmpeg 参数永远合法。
    """

    total = len(raw_shots)
    slot = duration_sec / total if total and duration_sec > 0 else 0.0
    shots: list[dict[str, Any]] = []
    cursor = 0.0

    for index, item in enumerate(raw_shots):
        entry = item if isinstance(item, dict) else {}
        default_start = index * slot
        default_end = (index + 1) * slot if slot else 0.0

        start = _bd_float(entry.get("start_time"), None)
        end = _bd_float(entry.get("end_time"), None)
        if start is None or start < 0:
            start = default_start
        if end is None or end <= start:
            end = max(default_end, start + max(slot, 0.5))
        if duration_sec > 0:
            start = min(max(start, 0.0), duration_sec)
            end = min(max(end, start), duration_sec)
        # 单调递增：模型偶尔会把某一镜的 start 写回到上一镜中间。
        start = max(start, cursor)
        end = max(end, start)
        cursor = end

        segment = _bd_int(entry.get("segment"), None)
        if segment is None or segment < 1:
            segment = index // max(group_size, 1) + 1

        keyframe = _bd_int(entry.get("keyframe"), None)
        if keyframe is None or not (1 <= keyframe <= max(frame_count, 1)):
            keyframe = min(index + 1, max(frame_count, 1))

        shots.append(
            {
                "shot": _bd_int(entry.get("shot"), index + 1) or index + 1,
                "segment": segment,
                "keyframe": keyframe,
                "start_time": round(start, 3),
                "end_time": round(end, 3),
                "duration": round(max(end - start, 0.0), 3),
                "shot_size": _bd_text(entry.get("shot_size"), "中景"),
                "lighting": _bd_text(entry.get("lighting"), "自然光"),
                "camera_angle": _bd_text(entry.get("camera_angle"), "平视"),
                "camera_movement": _bd_text(entry.get("camera_movement"), "固定"),
                "description": _bd_text(entry.get("description"))
                or _bd_text(entry.get("visual_description"), f"镜头 {index + 1}"),
                "narrative": _bd_text(entry.get("narrative")),
                "image_prompt": _bd_text(entry.get("image_prompt")),
                "motion_prompt": _bd_text(entry.get("motion_prompt")),
            }
        )

    return shots


def _group_breakdown_shots(
    shots: list[dict[str, Any]],
    *,
    segments: list[Any],
    group_size: int,
) -> list[dict[str, Any]]:
    """按 ``segment`` 聚成分镜组；模型没给分组就按 ``group_size`` 均切。

    每组最多 ``group_size`` 个镜头 —— 模型给的叙事段落长短不一，不封顶的话一组
    能塞进十几张分镜图，画布上那一片就没法看了。超了就顺序切成多组。
    """

    labels: dict[int, str] = {}
    for item in segments:
        if not isinstance(item, dict):
            continue
        index = _bd_int(item.get("segment"), None)
        if index is not None:
            labels[index] = _bd_text(item.get("label"))

    ordered: list[int] = []
    buckets: dict[int, list[dict[str, Any]]] = {}
    for shot in shots:
        segment = int(shot["segment"])
        if segment not in buckets:
            buckets[segment] = []
            ordered.append(segment)
        buckets[segment].append(shot)

    # 模型把所有镜头塞进同一个 segment 时，分组就失去意义了，退回均切。
    if len(ordered) <= 1 and len(shots) > group_size:
        ordered = []
        buckets = {}
        for index, shot in enumerate(shots):
            segment = index // max(group_size, 1) + 1
            shot["segment"] = segment
            if segment not in buckets:
                buckets[segment] = []
                ordered.append(segment)
            buckets[segment].append(shot)

    size = max(group_size, 1)
    groups: list[dict[str, Any]] = []
    for segment in ordered:
        members = buckets[segment]
        chunks = [members[start : start + size] for start in range(0, len(members), size)]
        base = labels.get(segment) or ""
        for part, chunk in enumerate(chunks, start=1):
            position = len(groups) + 1
            if not base:
                label = f"分镜组{position:02d}"
            elif len(chunks) == 1:
                label = base
            else:
                label = f"{base}（{part}/{len(chunks)}）"
            for shot in chunk:
                shot["segment"] = position
            groups.append(
                {
                    "group_index": position,
                    "segment": position,
                    "label": label,
                    "shots": chunk,
                }
            )
    return groups


def _select_motion_shots(
    shots: list[dict[str, Any]],
    *,
    max_clips: int,
) -> list[dict[str, Any]]:
    """挑出最值得当运镜参考的几镜：有运镜的优先，同类里挑最长的。"""

    moving = [
        shot
        for shot in shots
        if _bd_text(shot.get("camera_movement")).lower() not in _STATIC_CAMERA_MOVEMENTS
    ]
    pool = moving or shots
    ranked = sorted(pool, key=lambda shot: float(shot.get("duration") or 0.0), reverse=True)
    picked = ranked[: max(max_clips, 1)]
    return sorted(picked, key=lambda shot: float(shot.get("start_time") or 0.0))


async def run_freezone_video_breakdown(
    *,
    project_dir: Path,
    job_id: str,
    video_path: Path,
    dimensions: Optional[list[str]] = None,
    max_frames: int = 40,
    scene_threshold: float = 0.3,
    duration_sec: Optional[float] = None,
    storyboard_group_size: int = 4,
    max_motion_clips: int = 3,
    motion_clip_max_sec: float = 6.0,
    music_clip_sec: float = 15.0,
    model: Optional[str] = None,
    progress: Optional[Callable[[float, str], None]] = None,
    egress_context: TrustedEgressContext | None = None,
) -> dict[str, Any]:
    """逐帧拉片：抽帧 → Vision 拆解 → 真的把分镜图 / 运镜片段 / BGM 切出来。

    和 ``analyze-video-story`` 的分工：那个只产一张文字表，拉片必须落地成画布上
    能直接用的素材，所以三个维度都要真实文件 —— 分镜是按镜头时间点抽的图、动态
    是按运镜切出的视频片段、音乐是从原片截的 BGM 片段。

    返回的媒体字段全部是 ``*_path`` 绝对路径，由 runner 负责换成 static URL。
    """

    import json

    from novelvideo.freezone import vision_gateway
    from novelvideo.freezone.vision_gateway import (
        FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
        load_compact_vision_inputs,
        resolve_freezone_vision_model,
    )

    # 与 `run_freezone_analyze_shots` 同一口径：出网 helper 在函数体内引入。
    from novelvideo.freezone.presets import (
        abandon_freezone_vision_egress,
        complete_freezone_vision_egress,
        prepare_freezone_vision_egress,
    )

    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH; install via brew/apt")
    if not video_path.exists():
        raise FileNotFoundError(f"video not found: {video_path}")

    wanted = [dim for dim in (dimensions or list(VIDEO_BREAKDOWN_DIMENSIONS)) if dim]
    unknown = [dim for dim in wanted if dim not in VIDEO_BREAKDOWN_DIMENSIONS]
    if unknown:
        raise ValueError(f"unsupported breakdown dimensions: {unknown}")
    if not wanted:
        raise ValueError("at least one breakdown dimension is required")

    out_dir = outputs_dir(project_dir, "freezone_video_breakdown") / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    def report(ratio: float, message: str) -> None:
        if progress is not None:
            progress(ratio, message)

    source_path = str(video_path)
    total_duration = _bd_float(duration_sec, None)
    if total_duration is None or total_duration <= 0:
        total_duration = await _probe_video_duration(source_path)

    frame_target = plan_breakdown_frame_count(
        duration_sec=total_duration, max_frames=max_frames
    )
    report(0.08, f"ffmpeg 抽取关键帧（目标 {frame_target} 帧）...")
    frame_paths = await _extract_breakdown_frames(
        video_path=video_path,
        out_dir=out_dir / "frames",
        target_frames=frame_target,
        scene_threshold=scene_threshold,
        duration_sec=total_duration,
    )
    if not frame_paths:
        raise RuntimeError("no keyframes extracted from video")

    report(0.28, f"Vision 拉片解析 {len(frame_paths)} 帧...")
    prompt = build_video_breakdown_prompt(
        frame_count=len(frame_paths),
        duration_sec=total_duration,
        group_size=storyboard_group_size,
    )
    images = await load_compact_vision_inputs(
        [path for path in frame_paths if path.exists()]
    )
    if not images:
        raise ValueError("no readable frames to analyze")
    vision_model_name = resolve_freezone_vision_model(model)

    # 修不回来的输出就重来一次：拉片一趟要几分钟，宁可多花一次调用也别让用户重传视频。
    raw: dict[str, Any] = {}
    vision_model = ""
    for attempt in (1, 2):
        # 每一趟都是一次独立出网：各自 claim、各自给终态。输出能不能用是出网之后
        # 的事，模型已经答了就算 complete，重试另开一张 claim。
        vision_egress = await prepare_freezone_vision_egress(
            egress_context=egress_context,
            model_name=vision_model_name,
            prompt=prompt,
            images=[image.data for image in images],
            timeout_seconds=FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
        )
        try:
            vision_model, text = await vision_gateway.call_freezone_vision_model(
                prompt=prompt,
                images=images,
                model_override=model,
                timeout_seconds=FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
                transport_context=(
                    vision_egress.transport_context if vision_egress else None
                ),
            )
        except BaseException:
            # 帧字节在 claim 之前就读完了，claim 与提交之间没有会抛的步骤。
            await abandon_freezone_vision_egress(vision_egress, submitted=True)
            raise
        await complete_freezone_vision_egress(vision_egress, result=text or "")
        try:
            if not text:
                raise ValueError("vision model returned no text")
            parsed = loads_model_json(text)
            if not isinstance(parsed, dict):
                raise ValueError("vision model response is not an object")
            if not isinstance(parsed.get("shots"), list) or not parsed["shots"]:
                raise ValueError("vision model returned no shots")
        except ValueError as exc:  # JSONDecodeError 也是 ValueError
            (out_dir / "raw_response.txt").write_text(text or "", encoding="utf-8")
            if attempt == 2:
                raise RuntimeError(
                    f"vision model returned unusable output: {exc}; raw saved"
                ) from exc
            logger.warning("breakdown vision output unusable (%s); retrying once", exc)
            report(0.28, "模型输出无法解析，重试一次...")
            continue
        raw = parsed
        break

    raw_shots = raw["shots"]

    shots = _normalize_breakdown_shots(
        raw_shots,
        duration_sec=total_duration,
        frame_count=len(frame_paths),
        group_size=storyboard_group_size,
    )

    payload: dict[str, Any] = {
        "job_id": job_id,
        "model": vision_model,
        "duration_sec": round(total_duration, 3),
        "title": _bd_text(raw.get("title")),
        "summary": _bd_text(raw.get("summary")),
        "dimensions": wanted,
        "frame_paths": [str(path) for path in frame_paths],
        "storyboard": None,
        "motion": None,
        "music": None,
        "raw": raw,
    }

    # ---- 分镜：在每一镜的中点抽图 --------------------------------------
    if "storyboard" in wanted:
        report(0.5, f"切分镜图 {len(shots)} 张...")
        segments = raw.get("segments")
        groups = _group_breakdown_shots(
            shots,
            segments=segments if isinstance(segments, list) else [],
            group_size=storyboard_group_size,
        )
        code = 0
        for group in groups:
            for shot in group["shots"]:
                code += 1
                start = float(shot["start_time"])
                end = float(shot["end_time"])
                image_path = out_dir / f"shot_{code:02d}.jpg"
                await _extract_frame_at(
                    source_path=source_path,
                    output_path=image_path,
                    at_sec=(start + end) / 2.0,
                )
                shot["code"] = f"S{code:02d}"
                shot["image_path"] = str(image_path)
        payload["storyboard"] = {"label": "分镜组", "groups": groups}

    # ---- 动态：按运镜切视频片段 ----------------------------------------
    if "motion" in wanted:
        report(0.68, "切运镜参考片段...")
        width, height = await _probe_video_size(source_path)
        clips: list[dict[str, Any]] = []
        for index, shot in enumerate(_select_motion_shots(shots, max_clips=max_motion_clips), 1):
            start = float(shot["start_time"])
            span = min(float(shot["duration"]) or motion_clip_max_sec, motion_clip_max_sec)
            span = max(span, 1.0)
            if total_duration > 0:
                span = min(span, max(total_duration - start, 0.0))
            if span <= 0.1:
                continue
            clip_path = out_dir / f"motion_{index:02d}.mp4"
            await _render_video_clip(
                source_path=source_path,
                output_path=clip_path,
                source_start=start,
                duration=span,
                width=width,
                height=height,
                fps=30,
                background_color="#000000",
                keep_original_audio=True,
                volume=1.0,
                muted=False,
            )
            preview_path = out_dir / f"motion_{index:02d}.jpg"
            await _extract_frame_at(
                source_path=source_path,
                output_path=preview_path,
                at_sec=start + span / 2.0,
            )
            clips.append(
                {
                    "code": f"M{index:02d}",
                    "shot": shot["shot"],
                    "start_time": round(start, 3),
                    "end_time": round(start + span, 3),
                    "duration_sec": round(span, 3),
                    "camera_movement": shot["camera_movement"],
                    "camera_angle": shot["camera_angle"],
                    "description": shot["description"],
                    "motion_prompt": shot["motion_prompt"],
                    "video_path": str(clip_path),
                    "preview_image_path": str(preview_path),
                }
            )
        payload["motion"] = {"label": "动态｜运镜动作参考", "clips": clips}

    # ---- 音乐：从原片截一段 BGM ----------------------------------------
    if "music" in wanted:
        report(0.86, "截取 BGM 参考片段...")
        clip: Optional[dict[str, Any]] = None
        if await _probe_has_audio(source_path):
            raw_music = raw.get("music") if isinstance(raw.get("music"), dict) else {}
            start = _bd_float(raw_music.get("start_time"), 0.0) or 0.0
            span = music_clip_sec
            if total_duration > 0:
                start = min(max(start, 0.0), max(total_duration - 1.0, 0.0))
                span = min(span, max(total_duration - start, 0.0))
            if span > 0.5:
                audio_path = out_dir / "music_01.m4a"
                await _render_audio_clip(
                    source_path=source_path,
                    output_path=audio_path,
                    source_start=start,
                    duration=span,
                    volume=1.0,
                )
                instruments = raw_music.get("instruments")
                clip = {
                    "code": "A01",
                    "start_time": round(start, 3),
                    "end_time": round(start + span, 3),
                    "duration_sec": round(span, 3),
                    "description": _bd_text(raw_music.get("description")),
                    "mood": _bd_text(raw_music.get("mood")),
                    "instruments": [
                        _bd_text(item)
                        for item in (instruments if isinstance(instruments, list) else [])
                        if _bd_text(item)
                    ],
                    "bpm": _bd_int(raw_music.get("bpm"), None),
                    "audio_path": str(audio_path),
                }
        # clip 为 None 表示源片没有音轨（或短到截不出来），前端据此不建音频节点。
        payload["music"] = {"label": "音乐｜BGM参考片段", "clip": clip}

    out_file = out_dir / "breakdown.json"
    out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    payload["output_path"] = str(out_file)
    report(0.95, "拉片结果写入完成")
    return payload


async def _sample_evenly(
    video_path: Path, out_dir: Path, max_frames: int
) -> list[Path]:
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
    await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=300
    )
    return sort_extracted_frames_by_pts(out_dir.glob("even_*.png"))


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

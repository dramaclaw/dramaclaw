"""Bounded, cancellable local image output conversions."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from PIL import Image, UnidentifiedImageError


async def _convert(
    command: list[str], output: Path, *, timeout: float, max_bytes: int
) -> Path:
    if not shutil.which(command[0]):
        raise RuntimeError("本地转换服务暂不可用，请稍后重试。")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.stem + ".partial" + output.suffix)
    command = [str(temporary) if item == str(output) else item for item in command]
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        await asyncio.wait_for(process.wait(), timeout)
        if (
            process.returncode
            or not temporary.is_file()
            or not 0 < temporary.stat().st_size <= max_bytes
        ):
            raise RuntimeError("素材转换失败或结果过大，请尝试更简单的素材。")
        temporary.replace(output)
        return output
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        temporary.unlink(missing_ok=True)
        raise


async def transcode_gif(source: Path, output: Path) -> Path:
    if not source.is_file() or source.stat().st_size > 200 * 1024 * 1024:
        raise ValueError("视频不存在或超过转换大小限制。")
    filters = "fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3"
    try:
        return await _convert(
            [
                "ffmpeg",
                "-y",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                "mov,matroska,webm,avi",
                "-i",
                str(source),
                "-t",
                "15",
                "-vf",
                filters,
                "-an",
                "-loop",
                "0",
                str(output),
            ],
            output,
            timeout=120,
            max_bytes=30 * 1024 * 1024,
        )
    except asyncio.TimeoutError as exc:
        raise ValueError("GIF 转换超时，请重试。") from exc


async def vectorize_image(source: Path, output: Path) -> Path:
    if not source.is_file() or source.stat().st_size > 20 * 1024 * 1024:
        raise ValueError("图片不存在或超过转换大小限制。")
    try:
        with Image.open(source) as image:
            width, height = image.size
            if width * height > 24_000_000:
                raise ValueError("图片过大，请使用较小的图片。")
    except (OSError, UnidentifiedImageError) as exc:
        raise ValueError("无法读取图片。") from exc
    try:
        return await _convert(
            [
                "vtracer",
                str(source),
                str(output),
                "--preset",
                "poster",
                "--simplify",
                "1.5",
            ],
            output,
            timeout=90,
            max_bytes=12 * 1024 * 1024,
        )
    except asyncio.TimeoutError as exc:
        raise ValueError("图片细节过于复杂，转换超时，请使用更简单的图片。") from exc

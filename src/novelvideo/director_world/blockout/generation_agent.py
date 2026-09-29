"""Reference image → SceneBlockoutDSL program → previz objects.

The model's program is text from start to finish. It is read by
`dsl_parser.parse_blockout_program` and never imported, compiled or run.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import re
import textwrap
import time
from pathlib import Path
from typing import Any

from novelvideo.director_world.blockout.artifacts import (
    BlockoutAttempt,
    BlockoutGeneration,
    BlockoutGenerationError,
)
from novelvideo.director_world.blockout.compiler import compile_scene
from novelvideo.director_world.blockout.dsl_parser import parse_blockout_program
from novelvideo.director_world.blockout.plausibility import check_plausibility
from novelvideo.director_world.blockout.prompts import (
    build_blockout_prompt,
    build_blockout_retry_prompt,
)
from novelvideo.director_world.blockout.scene_ir import (
    MAX_PROGRAM_CHARS,
    BlockoutLimitError,
    BlockoutProgramError,
    SceneIR,
)
from novelvideo.egress_context import TrustedEgressContext

BLOCKOUT_MODEL_ENV = "PREVIZ_BLOCKOUT_MODEL"
BLOCKOUT_TIMEOUT_SECONDS = 300.0
BLOCKOUT_MAX_ATTEMPTS = 3

_FENCED_BLOCK = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)
_FENCE_LINE = re.compile(r"^[ \t]*```[^\n]*$", re.MULTILINE)
# 失败的程序要原样回给模型并落盘，超长时截断，免得一份失控的输出把下一轮提示词撑爆。
_MAX_KEPT_PROGRAM_CHARS = MAX_PROGRAM_CHARS * 2


def resolve_blockout_model() -> str:
    """`PREVIZ_BLOCKOUT_MODEL` if set, otherwise whatever Freezone vision uses."""
    from novelvideo.freezone.vision_gateway import resolve_freezone_vision_model

    return resolve_freezone_vision_model(os.environ.get(BLOCKOUT_MODEL_ENV))


def extract_program(text: str) -> str:
    """Return the program inside the first code fence, or the whole reply."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    match = _FENCED_BLOCK.search(text)
    # 围栏没有成对（回复被截断，或只写了开头）时，把围栏那一行整行去掉。
    program = match.group(1) if match else _FENCE_LINE.sub("", text)
    # 先去掉公共缩进再去首尾空白：反过来做的话只有第一行被顶格，第二行起就是语法错误。
    return textwrap.dedent(program).strip()[:_MAX_KEPT_PROGRAM_CHARS]


def _sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _image_size(data: bytes) -> tuple[int, int]:
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        return (int(image.size[0]), int(image.size[1]))


async def _ask_model(
    *,
    prompt: str,
    image,
    model: str,
    egress_context: TrustedEgressContext | None,
) -> str:
    from novelvideo.freezone import vision_gateway

    # 与 `image_node.reverse_prompt_from_image` 同一口径：出网 helper 在函数体内
    # 引进来，不放模块级。
    from novelvideo.freezone.presets import (
        abandon_freezone_vision_egress,
        complete_freezone_vision_egress,
        prepare_freezone_vision_egress,
    )

    vision_egress = await prepare_freezone_vision_egress(
        egress_context=egress_context,
        model_name=model,
        prompt=prompt,
        images=[image.data],
        timeout_seconds=BLOCKOUT_TIMEOUT_SECONDS,
    )
    try:
        _model, text = await vision_gateway.call_freezone_vision_model(
            prompt=prompt,
            images=[image],
            model_override=model,
            timeout_seconds=BLOCKOUT_TIMEOUT_SECONDS,
            transport_context=(
                vision_egress.transport_context if vision_egress else None
            ),
        )
    except BaseException:
        await abandon_freezone_vision_egress(vision_egress, submitted=True)
        raise
    await complete_freezone_vision_egress(vision_egress, result=text)
    return text


async def generate_blockout_from_image(
    *,
    image_path: Path,
    description: str = "",
    egress_context: TrustedEgressContext | None = None,
) -> BlockoutGeneration:
    from novelvideo.freezone.vision_gateway import load_compact_vision_inputs

    model = resolve_blockout_model()

    def unreadable(reason: str, *, sha256: str) -> BlockoutGenerationError:
        # 原始异常里带着服务器上的绝对路径，不该原样走到用户面前。
        return BlockoutGenerationError(
            f"参考图读不出来：{reason}",
            model=model,
            attempts=(),
            image_sha256=sha256,
            image_size=(0, 0),
        )

    try:
        image_sha256 = await asyncio.to_thread(_sha256_of_file, image_path)
    except OSError as exc:
        raise unreadable("文件不存在或无法读取", sha256="") from exc
    try:
        (image,) = await load_compact_vision_inputs([image_path])
        image_size = _image_size(image.data)
    except Exception as exc:
        # 扩展名对、内容不是图片（改了后缀的 HEIC、传坏的文件、像素数超限的图）。
        raise unreadable("文件不是有效的图片", sha256=image_sha256) from exc
    image_aspect = image_size[0] / image_size[1]
    base_prompt = build_blockout_prompt(description=description, image_size=image_size)

    attempts: list[BlockoutAttempt] = []
    # 解析和编译都过了、只是合理性检查没过的那一份。三次都没有干净结果时交它，
    # 问题降级成提示：一份能改的白模比一次失败有用。
    fallback: tuple[str, SceneIR, dict[str, Any], tuple[str, ...]] | None = None
    prompt = base_prompt

    def failure(message: str) -> BlockoutGenerationError:
        return BlockoutGenerationError(
            message,
            model=model,
            attempts=tuple(attempts),
            image_sha256=image_sha256,
            image_size=image_size,
        )

    for _ in range(BLOCKOUT_MAX_ATTEMPTS):
        started = time.monotonic()
        text = await _ask_model(
            prompt=prompt, image=image, model=model, egress_context=egress_context
        )
        program = extract_program(text)
        seconds = round(time.monotonic() - started, 3)
        try:
            scene = parse_blockout_program(program)
            compiled = compile_scene(scene)
        except BlockoutProgramError as exc:
            errors: tuple[str, ...] = (str(exc),)
        except BlockoutLimitError as exc:
            attempts.append(BlockoutAttempt(program, (str(exc),), seconds))
            raise failure(f"场景过于复杂：{exc}") from exc
        else:
            report = check_plausibility(scene, image_aspect=image_aspect)
            errors = report.errors
            if not errors:
                attempts.append(BlockoutAttempt(program, (), seconds))
                return BlockoutGeneration(
                    model=model,
                    program=program,
                    scene=scene,
                    compiled=compiled,
                    warnings=report.warnings,
                    attempts=tuple(attempts),
                    image_sha256=image_sha256,
                    image_size=image_size,
                )
            if fallback is None or len(errors) <= len(fallback[3]):
                fallback = (program, scene, compiled, (*errors, *report.warnings))
        attempts.append(BlockoutAttempt(program, errors, seconds))
        prompt = build_blockout_retry_prompt(
            base_prompt=base_prompt, previous_program=program, errors=errors
        )

    if fallback is not None:
        program, scene, compiled, warnings = fallback
        return BlockoutGeneration(
            model=model,
            program=program,
            scene=scene,
            compiled=compiled,
            warnings=warnings,
            attempts=tuple(attempts),
            image_sha256=image_sha256,
            image_size=image_size,
        )
    raise failure(
        f"模型连续 {BLOCKOUT_MAX_ATTEMPTS} 次没有写出合法的场景程序："
        f"{attempts[-1].errors[0]}"
    )

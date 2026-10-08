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
from dataclasses import dataclass
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
    build_blockout_review_prompt,
)
from novelvideo.director_world.blockout.render import render_blockout
from novelvideo.director_world.blockout.scene_ir import (
    MAX_PROGRAM_CHARS,
    BlockoutLimitError,
    BlockoutProgramError,
    SceneIR,
)
from novelvideo.egress_context import TrustedEgressContext

BLOCKOUT_MODEL_ENV = "PREVIZ_BLOCKOUT_MODEL"
BLOCKOUT_REASONING_EFFORT_ENV = "PREVIZ_BLOCKOUT_REASONING_EFFORT"
BLOCKOUT_TIMEOUT_ENV = "PREVIZ_BLOCKOUT_TIMEOUT_SECONDS"
BLOCKOUT_TIMEOUT_SECONDS = 300.0
BLOCKOUT_MAX_ATTEMPTS = 3
# 渲染核对的轮数：每轮把当前场景渲染成图，和参考图一起交给模型改。第一轮修构图，
# 第二轮能把第一轮误删的东西找回来；再多收益就很小了，而每轮都是一次模型调用。
BLOCKOUT_REVIEW_ROUNDS = 2

_FENCED_BLOCK = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)
_FENCE_LINE = re.compile(r"^[ \t]*```[^\n]*$", re.MULTILINE)
# 失败的程序要原样回给模型并落盘，超长时截断，免得一份失控的输出把下一轮提示词撑爆。
_MAX_KEPT_PROGRAM_CHARS = MAX_PROGRAM_CHARS * 2


def resolve_blockout_model() -> str:
    """`PREVIZ_BLOCKOUT_MODEL` if set, otherwise whatever Freezone vision uses."""
    from novelvideo.freezone.vision_gateway import resolve_freezone_vision_model

    return resolve_freezone_vision_model(os.environ.get(BLOCKOUT_MODEL_ENV))


def resolve_blockout_model_settings() -> dict | None:
    """`PREVIZ_BLOCKOUT_REASONING_EFFORT` as PydanticAI model settings, else None.

    Same wire contract as `config.get_newapi_structured_output_model_settings`:
    the gateway serves opaque aliases, so the OpenAI-compatible
    ``reasoning_effort`` field is the only thing that reliably reaches the
    upstream model. Unset means whatever the gateway does by default.
    """
    effort = os.environ.get(BLOCKOUT_REASONING_EFFORT_ENV, "").strip().lower()
    if not effort:
        return None
    return {"openai_reasoning_effort": effort}


def resolve_blockout_timeout_seconds() -> float:
    """Per-call request timeout: `PREVIZ_BLOCKOUT_TIMEOUT_SECONDS`, else 300.

    One draft or one review round is one model call, and a reasoning model at
    a higher effort can take minutes per call: the fixed 300 s suited the
    default effort, a higher `PREVIZ_BLOCKOUT_REASONING_EFFORT` needs more.
    """
    raw = os.environ.get(BLOCKOUT_TIMEOUT_ENV, "").strip()
    if not raw:
        return BLOCKOUT_TIMEOUT_SECONDS
    try:
        seconds = float(raw)
    except ValueError:
        seconds = 0.0
    if not seconds > 0:
        raise ValueError(
            f"{BLOCKOUT_TIMEOUT_ENV} must be a positive number of seconds, got {raw!r}"
        )
    return seconds


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
    images: list,
    model: str,
    model_settings: dict | None,
    timeout_seconds: float,
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
        images=[image.data for image in images],
        timeout_seconds=timeout_seconds,
    )
    try:
        _model, text = await vision_gateway.call_freezone_vision_model(
            prompt=prompt,
            images=images,
            model_override=model,
            model_settings=model_settings,
            timeout_seconds=timeout_seconds,
            transport_context=(
                vision_egress.transport_context if vision_egress else None
            ),
        )
    except BaseException:
        await abandon_freezone_vision_egress(vision_egress, submitted=True)
        raise
    await complete_freezone_vision_egress(vision_egress, result=text)
    return text


@dataclass(frozen=True)
class _Candidate:
    """A program that parsed and compiled, with whatever the plausibility check said."""

    program: str
    scene: SceneIR
    compiled: dict[str, Any]
    errors: tuple[str, ...]
    warnings: tuple[str, ...]


def _evaluate(
    program: str, *, image_aspect: float, picture_check: bool
) -> tuple[_Candidate | None, tuple[str, ...]]:
    """Parse, compile and check one program: (candidate, errors).

    A program that does not parse or compile has no candidate. `BlockoutLimitError`
    is not caught: a scene past the limits ends the job, it is not retried.
    """
    try:
        scene = parse_blockout_program(program)
        compiled = compile_scene(scene)
    except BlockoutProgramError as exc:
        return None, (str(exc),)
    report = check_plausibility(
        scene, image_aspect=image_aspect, picture_check=picture_check
    )
    return (
        _Candidate(program, scene, compiled, report.errors, report.warnings),
        report.errors,
    )


async def generate_blockout_from_image(
    *,
    image_path: Path,
    description: str = "",
    picture_check: bool = False,
    render_check: bool = False,
    egress_context: TrustedEgressContext | None = None,
) -> BlockoutGeneration:
    """Write a blockout for one picture.

    `picture_check` and `render_check` are the user's choices, made per job in
    the dialog, and both cost extra model calls, so they are off unless asked for.

    `picture_check` asks the model for `scene.seen` lines and projects the scene
    back onto the picture. It only catches contradictions between coordinates,
    sizes and camera.

    `render_check` renders the finished scene from its camera and shows the
    render next to the picture, `BLOCKOUT_REVIEW_ROUNDS` times, asking for a
    rewrite each time. It corrects what the model can see is wrong (camera
    distance and height, where the big pieces stand); it does not make the
    model read the picture better. A rewrite that breaks the scene or adds
    plausibility errors is dropped and the scene under review is kept.
    """
    from novelvideo.freezone.vision_gateway import (
        VisionInput,
        load_compact_vision_inputs,
    )

    model = resolve_blockout_model()
    model_settings = resolve_blockout_model_settings()
    timeout_seconds = resolve_blockout_timeout_seconds()

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
    base_prompt = build_blockout_prompt(
        description=description, image_size=image_size, picture_check=picture_check
    )

    attempts: list[BlockoutAttempt] = []
    # 解析和编译都过了、只是合理性检查没过的那一份。三次都没有干净结果时交它，
    # 问题降级成提示：一份能改的白模比一次失败有用。
    fallback: _Candidate | None = None
    prompt = base_prompt

    def failure(message: str) -> BlockoutGenerationError:
        return BlockoutGenerationError(
            message,
            model=model,
            attempts=tuple(attempts),
            image_sha256=image_sha256,
            image_size=image_size,
        )

    async def ask(prompt: str, *images) -> tuple[str, float]:
        started = time.monotonic()
        text = await _ask_model(
            prompt=prompt,
            images=list(images),
            model=model,
            model_settings=model_settings,
            timeout_seconds=timeout_seconds,
            egress_context=egress_context,
        )
        return extract_program(text), round(time.monotonic() - started, 3)

    chosen: _Candidate | None = None
    for _ in range(BLOCKOUT_MAX_ATTEMPTS):
        program, seconds = await ask(prompt, image)
        try:
            candidate, errors = _evaluate(
                program, image_aspect=image_aspect, picture_check=picture_check
            )
        except BlockoutLimitError as exc:
            attempts.append(BlockoutAttempt(program, (str(exc),), seconds))
            raise failure(f"场景过于复杂：{exc}") from exc
        attempts.append(BlockoutAttempt(program, errors, seconds))
        if candidate is not None and not errors:
            chosen = candidate
            break
        if candidate is not None and (
            fallback is None
            or len(errors) <= len(fallback.errors) + len(fallback.warnings)
        ):
            fallback = candidate
        prompt = build_blockout_retry_prompt(
            base_prompt=base_prompt, previous_program=program, errors=errors
        )

    if chosen is None:
        if fallback is None:
            raise failure(
                f"模型连续 {BLOCKOUT_MAX_ATTEMPTS} 次没有写出合法的场景程序："
                f"{attempts[-1].errors[0]}"
            )
        chosen = fallback

    renders: list[bytes] = []
    if render_check:
        for _ in range(BLOCKOUT_REVIEW_ROUNDS):
            png = await asyncio.to_thread(
                render_blockout, chosen.compiled["objects"], image_aspect=image_aspect
            )
            renders.append(png)
            program, seconds = await ask(
                build_blockout_review_prompt(
                    base_prompt=base_prompt, previous_program=chosen.program
                ),
                image,
                VisionInput(data=png, media_type="image/png"),
            )
            try:
                candidate, errors = _evaluate(
                    program, image_aspect=image_aspect, picture_check=picture_check
                )
            except BlockoutLimitError as exc:
                errors, candidate = (str(exc),), None
            attempts.append(BlockoutAttempt(program, errors, seconds, review=True))
            # 改坏了就不要：只接受不比手里这份更差的改法。
            if candidate is not None and len(errors) <= len(chosen.errors):
                chosen = candidate

    return BlockoutGeneration(
        model=model,
        program=chosen.program,
        scene=chosen.scene,
        compiled=chosen.compiled,
        warnings=(*chosen.errors, *chosen.warnings),
        attempts=tuple(attempts),
        image_sha256=image_sha256,
        image_size=image_size,
        picture_check=picture_check,
        render_check=render_check,
        renders=tuple(renders),
    )

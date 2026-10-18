"""AI rewrite for a Qwen-Image-Edit-2511 render prompt (review dialog's "AI
rewrite" button for `runpod_qwen_edit_render` / `_render_multi`).

Mirrors `agents/minimax_h3_prompt_builder.py`'s shape (vision-capable
model, one call per prompt to rewrite), but the system prompt and output
schema follow Qwen-Image-Edit-2511's **own** official rewriting standard —
`EDIT_SYSTEM_PROMPT` from `QwenLM/Qwen-Image`'s
`src/examples/tools/prompt_utils.py`, copied verbatim into
`agents/prompts/qwen_edit_render_rules.md` — rather than a bespoke system
prompt, per the user's explicit requirement that this follow the model's
real prompt standard. Output is the same `{"Rewritten": "..."}` shape the
official `polish_edit_prompt()` function expects back, not a DramaClaw-
specific schema.

Called once per prompt to rewrite: the `full`/`scene_only` case is one
call; the multi-character `inpaint` case is one call per detected
identity (`api/routes/generation.py`'s `generate_qwen_edit_render_prompt`
loops over them), matching how the official reference pipeline rewrites
one instruction at a time.
"""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent
from pydantic_ai.output import NativeOutput

_RULES_PATH = Path(__file__).parent / "prompts" / "qwen_edit_render_rules.md"


def _load_rules() -> str:
    return _RULES_PATH.read_text(encoding="utf-8")


def _compress_image_bytes(image_path: str, compress_quality: int = 80) -> bytes:
    """JPEG-compress an image before sending it to the vision model — same
    approach as `minimax_h3_prompt_builder._compress_image_bytes`."""
    from PIL import Image

    img = Image.open(image_path)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
    return buffer.getvalue()


class QwenEditRewriteResult(BaseModel):
    """Same shape as the official `polish_edit_prompt()`'s parsed response
    — see Part 1 of `qwen_edit_render_rules.md`."""

    Rewritten: str = Field(description="The rewritten, ready-to-use edit prompt, as one line")


class QwenEditRewriteContext(BaseModel):
    """One prompt to rewrite. `picture_1_path`/`picture_2_path` are sent as
    actual images, in that order, matching the official
    Picture-1-then-Picture-2 attachment order."""

    stage: Literal["full", "scene_only", "inpaint"] = "full"
    default_prompt: str = Field(description="The template prompt from build_qwen_edit_render_prompt()")
    picture_1_path: str = ""
    picture_2_path: str = ""
    picture_1_label: str = "sketch canvas"
    picture_2_label: str = ""
    # Set by the caller on a retry after the first attempt's lint found a
    # hard error (missing Picture tag, layout word, stray newline, ...).
    retry_feedback: str = ""


def _build_agent() -> Agent:
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    rules = _load_rules()
    return Agent(
        get_newapi_text_pydantic_model(
            "QWEN_EDIT_RENDER_PROMPT_MODEL", default_model="DC-render-qwen-edit-prompt-LLM"
        ),
        system_prompt=rules,
        # NativeOutput (JSON-schema structured output), not plain
        # output_type= (forced tool-calling) — this alias is mapped to
        # DC-qwen-vision, which runs in "thinking mode" and rejects forced
        # tool-calling but supports response_format/JSON schema. See
        # docs/adr/0002-identity-planner-and-text-models-deepseek.md.
        output_type=NativeOutput(QwenEditRewriteResult),
        model_settings={**get_newapi_structured_output_model_settings(), "max_tokens": 4000},
        name="Qwen-Image-Edit-2511 Render Prompt Enhancer",
    )


_agent: Optional[Agent] = None


def get_qwen_edit_render_prompt_agent() -> Agent:
    global _agent
    if _agent is None:
        _agent = _build_agent()
    return _agent


def _build_user_prompt(context: QwenEditRewriteContext) -> str:
    image_note = (
        f"Attached below, in order: Picture 1 ({context.picture_1_label})"
        + (f", Picture 2 ({context.picture_2_label})" if context.picture_2_path else "")
        + "."
    )
    retry_note = (
        f"\n\nFix these specific mistakes from your previous attempt:\n{context.retry_feedback}"
        if context.retry_feedback.strip()
        else ""
    )
    return (
        f"{image_note}\n\n"
        f"User Input: {context.default_prompt}{retry_note}\n\n"
        "Rewritten Prompt:"
    )


def _load_image_content(image_path: str) -> Optional[BinaryContent]:
    if not image_path or not os.path.exists(image_path):
        return None
    try:
        return BinaryContent(data=_compress_image_bytes(image_path), media_type="image/jpeg")
    except OSError:
        return None


async def rewrite_qwen_edit_render_prompt(context: QwenEditRewriteContext) -> str:
    """Returns the rewritten prompt text (the `Rewritten` field), already
    newline-collapsed, same post-processing as the official
    `polish_edit_prompt()`."""
    agent = get_qwen_edit_render_prompt_agent()

    user_prompt: list = [_build_user_prompt(context)]
    picture_1 = _load_image_content(context.picture_1_path)
    if picture_1 is not None:
        user_prompt.append(picture_1)
    picture_2 = _load_image_content(context.picture_2_path)
    if picture_2 is not None:
        user_prompt.append(picture_2)

    response = await agent.run(user_prompt)
    rewritten = response.output.Rewritten.strip().replace("\n", " ")
    return rewritten

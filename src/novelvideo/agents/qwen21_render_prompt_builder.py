"""AI rewrite for a Qwen-Image 2.1 render prompt (review dialog's "AI
rewrite" button for `runpod_qwen21_render` / `_render_multi`).

Mirrors `agents/qwen_edit_render_prompt_builder.py`'s shape (vision-capable
model, one call per prompt to rewrite), but the system prompt and output
contract follow Qwen-Image 2.1's **own** official rewriting standard —
the "Edit Prompt Enhancer — General (v2)" prompt embedded in ComfyUI's
official `image_qwen_image_2_1_image_edit.json` workflow template, copied
verbatim into `agents/prompts/qwen21_render_rules.md` — rather than a
bespoke system prompt, same principle already applied to Edit-2511.

**Output is plain text, not JSON** — unlike Edit-2511's
`{"Rewritten": "..."}` contract. The official Qwen-Image 2.1 enhancer's
own "Output Format" rule is explicit: "Output ONLY the rewritten editing
instruction itself: one single continuous paragraph of plain text ... no
object or array wrapper". Using `output_type=str` here matches that
exactly instead of working around it.

Called once per prompt to rewrite: the `full`/`scene_only` case is one
call; the multi-character `inpaint` case is one call per detected
identity (`api/routes/generation.py`'s rewrite loop, via
`render_review_registry.py`), matching how the official prompt standard
describes rewriting one instruction at a time.
"""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent

_RULES_PATH = Path(__file__).parent / "prompts" / "qwen21_render_rules.md"


def _load_rules() -> str:
    return _RULES_PATH.read_text(encoding="utf-8")


def _compress_image_bytes(image_path: str, compress_quality: int = 80) -> bytes:
    """JPEG-compress an image before sending it to the vision model — same
    approach as `qwen_edit_render_prompt_builder._compress_image_bytes`."""
    from PIL import Image

    img = Image.open(image_path)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
    return buffer.getvalue()


class Qwen21RewriteContext(BaseModel):
    """One prompt to rewrite. `image_1_path`/`image_2_path` are sent as
    actual images, in that order, matching the official `<image1>` then
    `<image2>` attachment order. For `stage="scene_only"`, only
    `image_1_path` is set (single-image input — no tags per the official
    rule)."""

    stage: Literal["full", "scene_only", "inpaint"] = "full"
    default_prompt: str = Field(description="The template prompt from build_qwen21_render_prompt()")
    image_1_path: str = ""
    image_2_path: str = ""
    image_1_label: str = "sketch canvas"
    image_2_label: str = ""
    # Set by the caller on a retry after the first attempt's lint found a
    # hard error (missing/malformed tag, layout word, JSON wrapper, ...).
    retry_feedback: str = ""


def _build_agent() -> Agent:
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    rules = _load_rules()
    return Agent(
        get_newapi_text_pydantic_model(
            "QWEN21_RENDER_PROMPT_MODEL", default_model="DC-render-qwen-edit-prompt-LLM"
        ),
        system_prompt=rules,
        # Plain text output, not NativeOutput/forced tool-calling — matches
        # the official enhancer's own "plain text, no wrapper" contract,
        # and avoids the same thinking-mode/forced-tool-calling mismatch
        # noted throughout this project for DC-qwen-vision (see
        # docs/adr/0002-identity-planner-and-text-models-deepseek.md).
        output_type=str,
        model_settings={**get_newapi_structured_output_model_settings(), "max_tokens": 4000},
        name="Qwen-Image 2.1 Render Prompt Enhancer",
    )


_agent: Optional[Agent] = None


def get_qwen21_render_prompt_agent() -> Agent:
    global _agent
    if _agent is None:
        _agent = _build_agent()
    return _agent


def _build_user_prompt(context: Qwen21RewriteContext) -> str:
    if context.image_2_path:
        image_note = (
            f"Attached below, in order: <image1> ({context.image_1_label}), "
            f"<image2> ({context.image_2_label})."
        )
    else:
        image_note = f"Attached below: the image ({context.image_1_label})."
    retry_note = (
        f"\n\nFix these specific mistakes from your previous attempt:\n{context.retry_feedback}"
        if context.retry_feedback.strip()
        else ""
    )
    return f"{image_note}\n\nThe user's edit instruction to rewrite is: {context.default_prompt}{retry_note}"


def _load_image_content(image_path: str) -> Optional[BinaryContent]:
    if not image_path or not os.path.exists(image_path):
        return None
    try:
        return BinaryContent(data=_compress_image_bytes(image_path), media_type="image/jpeg")
    except OSError:
        return None


def _strip_output_wrapper(text: str) -> str:
    """Defensive post-processing in case the model still wraps its answer
    despite the official "no wrapper" instruction — strip a code fence or
    an accidental `{"Rewritten": "..."}` JSON object, then collapse any
    stray newlines, same post-processing the official reference
    `polish_edit_prompt()` function does for its own (JSON) contract.

    Also strips a leaked `<think>...</think>` reasoning block: the
    underlying model (DC-qwen-vision, "thinking mode" per
    docs/adr/0002-identity-planner-and-text-models-deepseek.md) is only
    schema-constrained for Edit-2511's `NativeOutput` JSON contract — this
    agent's plain-text `output_type=str` has no such constraint, and a real
    run (2026-10-18, BabyStories beat 7) leaked its own answer TWICE,
    separated by a stray `</think>` with no matching opener (the model
    appears to restate its final answer after the closing tag rather than
    cleanly stopping). Keeping only the text after the LAST `</think>`
    handles both that duplicate-echo shape and a more conventional
    `<think>reasoning</think>answer` leak in one pass."""
    import json
    import re

    stripped = text.strip()
    if "</think>" in stripped:
        stripped = stripped.rsplit("</think>", 1)[-1].strip()
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", stripped).strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict) and "Rewritten" in parsed:
                stripped = str(parsed["Rewritten"])
        except ValueError:
            pass
    if stripped.startswith('"') and stripped.endswith('"') and len(stripped) > 1:
        stripped = stripped[1:-1]
    return stripped.replace("\n", " ").strip()


async def rewrite_qwen21_render_prompt(context: Qwen21RewriteContext) -> str:
    """Returns the rewritten prompt text, already stripped/collapsed."""
    agent = get_qwen21_render_prompt_agent()

    user_prompt: list = [_build_user_prompt(context)]
    image_1 = _load_image_content(context.image_1_path)
    if image_1 is not None:
        user_prompt.append(image_1)
    image_2 = _load_image_content(context.image_2_path)
    if image_2 is not None:
        user_prompt.append(image_2)

    response = await agent.run(user_prompt)
    return _strip_output_wrapper(str(response.output))

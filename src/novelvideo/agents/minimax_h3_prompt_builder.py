"""Rewrites a drama beat into the official MiniMax H3 prompt format.

Two internal steps behind one LLM call (adapted from `h3-performance-director`
§32/§34 and `h3-micro-cinematic-director` §21 in
`github.com/gordonlu/awesome-minimax-h3-skills/community-skills`):

1. **Plan** — a short structured `MiniMaxH3Plan` (objective/tactic/gesture,
   shot pattern + camera reason, beat timestamps, dialogue window, voice
   description, end state). This is what the review dialog shows as
   "directing intent" and is cheap to re-edit without touching prose.
2. **Compile** — the plan is written out as the final H3 prompt text
   (the six-section ref2va format, or the three-section fl2va format).

Only `final_prompt` (the compiled text) is sent to ComfyUI; the plan is
kept alongside it for display/debugging. Rules are kept in
`agents/prompts/minimax_h3_rules.md` so they can be tuned without touching
this module — see that file for every rule's rationale and source.

**Vision, not text, is the source of truth for appearance** (changed
2026-10-17, in response to a real identity-mismatch bug): a character's
recorded `appearance_details` text field, when present at all, can drift
from what a later-regenerated reference image actually shows — and when
absent, the old text-only design had nothing to go on but invent
something (confirmed live: it invented a plain T-shirt and shorts for a
character whose real reference image actually shows a formal navy coat
and red tie). Fixed by attaching the real first-frame and reference
images directly to this single call — the model describes what it
genuinely sees instead of relying on (or inventing) text.

This needs a vision-capable model, so the alias this module uses
(`MINIMAX_H3_PROMPT_MODEL`, default `DC-video-h3-prompt-LLM`) is mapped to
`DC-qwen-vision` (not `DC-deepseek` — see `.claude/CLAUDE.md`), which in
turn means `output_type=NativeOutput(...)` (JSON-schema structured output)
instead of plain `output_type=` (forced tool-calling): DeepSeek supports
the latter but not the former, Qwen via DashScope is the reverse (it runs
in "thinking mode" and rejects `tool_choice: required`) — see
`docs/adr/0002-identity-planner-and-text-models-deepseek.md` for where
this split was first established. `max_tokens` is set generously high
since a "thinking mode" model spends part of its budget on internal
reasoning before the final JSON.

A two-call split (a small vision-only "describe each image" pass feeding
into the original text-only DeepSeek compile call) was tried in between
and did measurably improve format reliability (section order, dialogue
never silently dropped, `<Picture N>` citations) over this single-call
design — but was reverted at the user's explicit request to keep this to
one call. The known trade-off of this simpler design: occasional format
variance on a fraction of runs (a missed `<Picture N>` citation, a
dropped dialogue line, a stray quote around `<d>`) — the lint
(`agents/minimax_h3_prompt_lint.py`) catches these, one automatic
self-correction retry is attempted server-side
(`api/routes/generation.py`'s `generate_minimax_h3_prompt`), and whatever
remains is surfaced to the user in the review dialog to fix by hand or
re-run.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent
from pydantic_ai.output import NativeOutput

_RULES_PATH = Path(__file__).parent / "prompts" / "minimax_h3_rules.md"


def _load_rules() -> str:
    return _RULES_PATH.read_text(encoding="utf-8")


def _compress_image_bytes(image_path: str, compress_quality: int = 70) -> bytes:
    """JPEG-compress a reference/first-frame image before sending it to the
    vision model — same approach as `global_video_optimizer.py`'s
    `_compress_image` (sketch frames), reused here rather than duplicated
    logic drifting apart."""
    from PIL import Image

    img = Image.open(image_path)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    import io

    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
    return buffer.getvalue()


class MiniMaxH3Reference(BaseModel):
    """One image/audio reference already assigned a `<Picture N>`/`<Audio N>`
    tag by the caller (see `api/routes/generation.py` review endpoint).
    `image_path`, when set, is sent to the (vision-capable) rewriter model
    as an actual image — see module docstring for why this replaced
    relying on `appearance_details` text alone."""

    tag: str = Field(description='e.g. "<Picture 2>" or "<Audio 1>"')
    kind: Literal["first_frame", "character", "scene", "prop", "voice"] = "character"
    name: str = Field(default="", description="Display name, e.g. a character name")
    appearance_details: str = Field(
        default="",
        description=(
            "Optional supplementary hint (e.g. a character's recorded "
            "appearance text) — the attached image, if any, is authoritative"
        ),
    )
    image_path: str = Field(default="", description="Absolute path to the reference image file, if any")


class MiniMaxH3BeatContext(BaseModel):
    """Everything the rewriter needs about one beat. Assembled by the
    caller from the beat/episode data — this module has no store access."""

    mode: Literal["ref2va", "fl2va"] = "ref2va"
    visual_description: str = ""
    narration_segment: str = ""
    dialogue_line: str = ""
    dialogue_speaker: str = ""
    dialogue_language: str = "Vietnamese"
    dialogue_on_screen: bool = True
    scene_description: str = ""
    duration_seconds: float = 6.0
    aspect_ratio: str = "9:16"
    prev_beat_narration: str = ""
    next_beat_narration: str = ""
    existing_video_prompt: str = ""
    # Set by the caller on a retry after the first attempt's lint found
    # hard errors (dropped dialogue, wrong section order, an uncited
    # `<Picture N>`, ...) — real run-to-run variance this task has shown.
    # One self-correction pass with the exact prior mistakes listed
    # resolves most of them without an extra round trip to the user.
    retry_feedback: str = ""
    # `<Picture 1>` — sent to the rewriter as an actual image, same as every
    # other reference, so `subject_definitions`/`detailed_description` can
    # describe what's really in frame at t=0 instead of only the (possibly
    # stale) `visual_description` text.
    first_frame_path: str = ""
    references: list[MiniMaxH3Reference] = Field(default_factory=list)


class MiniMaxH3ShotPlan(BaseModel):
    """Internal directing plan — shown in the review dialog as "directing
    intent"; not sent to ComfyUI directly."""

    focus_subject: str = Field(description="Which <Subject N> this beat is about")
    objective: str = ""
    tactic: str = ""
    visible_gesture: str = Field(description="The one concrete, observable action/gesture")
    contradictory_cue: str = Field(default="", description="Subtext cue, if any")
    shot_pattern: str = Field(
        description="One of: Static Frame / Push-to-Decision / Reveal-by-Turn / Short Lateral Track"
    )
    camera_reason: str = ""
    beats: list[str] = Field(default_factory=list, description="Timestamped beat-by-beat description")
    dialogue_window: str = Field(default="", description='e.g. "1.20-3.00"')
    voice_description: str = ""
    end_state: str = ""


class MiniMaxH3PromptResult(BaseModel):
    plan: MiniMaxH3ShotPlan
    final_prompt: str = Field(description="The complete, ready-to-use H3 prompt text")


def _build_agent() -> Agent:
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    rules = _load_rules()
    system_prompt = (
        "You are a MiniMax H3 video prompt director for a Vietnamese short "
        "drama. You will be given one beat's context (visual description, "
        "narration, dialogue, duration, aspect ratio) as text, and the "
        "actual first frame plus any character/scene/prop reference images "
        "as attached images, each labeled with its tag (<Picture 1> is "
        "always the first frame; <Picture 2>, <Picture 3>, ... are "
        "references, in the order listed). Describe what you genuinely see "
        "in those images — hair, face, clothing, the scene itself — rather "
        "than any text hint that comes with a reference; a text hint is "
        "only ever supplementary, and the image always wins if the two "
        "disagree. Produce a directing plan, then compile it into the "
        "official MiniMax H3 prompt text, following every rule below "
        "exactly.\n\n" + rules
    )
    return Agent(
        get_newapi_text_pydantic_model(
            "MINIMAX_H3_PROMPT_MODEL", default_model="DC-video-h3-prompt-LLM"
        ),
        system_prompt=system_prompt,
        # `NativeOutput` (JSON-schema structured output via `response_format`),
        # NOT plain `output_type=` (forced tool-calling / `tool_choice:
        # "required"`) — this alias is mapped to a vision-capable channel
        # (Qwen via DashScope, `DC-qwen-vision`), which runs in "thinking
        # mode" and rejects forced tool-calling, but does support
        # `response_format`/JSON schema cleanly. DeepSeek is the exact
        # opposite. See
        # docs/adr/0002-identity-planner-and-text-models-deepseek.md.
        output_type=NativeOutput(MiniMaxH3PromptResult),
        # `max_tokens`: a "thinking mode" vision model spends part of its
        # token budget on internal reasoning before the final JSON, and the
        # structured output includes both the `plan` object and the full
        # multi-section `final_prompt` string — without this, a live run
        # once cut `final_prompt` short mid-section (missing
        # `detailed_description` entirely). Generous on purpose.
        model_settings={**get_newapi_structured_output_model_settings(), "max_tokens": 8000},
        name="MiniMax H3 Prompt Director",
    )


_agent: Optional[Agent] = None


def get_minimax_h3_prompt_agent() -> Agent:
    global _agent
    if _agent is None:
        _agent = _build_agent()
    return _agent


def _format_references(context: MiniMaxH3BeatContext) -> str:
    lines = []
    for ref in context.references:
        details = ref.appearance_details.strip()
        hint = f" (supplementary text hint, image is authoritative: {details})" if details else ""
        attached_note = " [image attached below]" if ref.image_path else " [no image available]"
        lines.append(
            f"- {ref.tag} ({ref.kind}){f' — {ref.name}' if ref.name else ''}{attached_note}{hint}"
        )
    return "\n".join(lines) if lines else "(no references beyond the first frame)"


def _build_user_prompt(context: MiniMaxH3BeatContext) -> str:
    dialogue_block = "(no dialogue in this beat)"
    if context.dialogue_line.strip():
        onscreen_note = "on-screen" if context.dialogue_on_screen else "off-screen"
        is_multi_turn = " / " in context.dialogue_speaker and "\n" in context.dialogue_line
        if is_multi_turn:
            # One line per speaker, already formatted "Name: text" by the
            # caller — multiple characters' lines were merged into this one
            # beat. Each becomes its own <d> turn with its own (SN) id.
            dialogue_block = (
                f"Speakers, in order ({onscreen_note}): {context.dialogue_speaker}\n"
                f"Language: {context.dialogue_language}\n"
                "Lines — ONE EXACT, VERBATIM <d> turn per line below, in this "
                "order, each with its own (S1)/(S2)/... id for that speaker. "
                "Never merge two speakers' lines into one turn, never invent "
                "a line for a speaker not listed, never translate, never "
                "reword or add words:\n" + context.dialogue_line
            )
        else:
            speaker_note = context.dialogue_speaker or "(unnamed on-screen character)"
            dialogue_block = (
                f'Speaker: {speaker_note} ({onscreen_note})\n'
                f"Language: {context.dialogue_language}\n"
                "Line — copy this EXACTLY character-for-character inside "
                f'<d>, in its original language; never translate it into '
                f'another language even if the rest of this prompt is in '
                f'English: "{context.dialogue_line}"'
            )

    return f"""## Mode
{context.mode}

## Duration / aspect ratio
{context.duration_seconds:.1f}s, {context.aspect_ratio}

## Visual description (first frame / scene)
{context.visual_description or "(none provided)"}

## Scene
{context.scene_description or "(none provided)"}

## Narration
Previous beat: {context.prev_beat_narration or "(none)"}
This beat: {context.narration_segment or "(none)"}
Next beat: {context.next_beat_narration or "(none)"}

## Dialogue
{dialogue_block}

## References (numbered in attachment order; <Picture 1> is always the first frame — its image follows this text, then each reference's image in the order listed below)
{_format_references(context)}

## Existing motion hint (optional, may be stale — treat only as a hint, not authoritative)
{context.existing_video_prompt or "(none)"}
{f'''
## Fix these specific mistakes from your previous attempt at this beat
{context.retry_feedback}
''' if context.retry_feedback.strip() else ""}
Now produce the directing plan and the compiled {("six-section ref2va" if context.mode == "ref2va" else "three-section fl2va")} H3 prompt, describing every subject's appearance from the attached images, not from any text hint."""


def _load_reference_image_content(image_path: str) -> Optional[BinaryContent]:
    if not image_path or not os.path.exists(image_path):
        return None
    try:
        return BinaryContent(data=_compress_image_bytes(image_path), media_type="image/jpeg")
    except OSError:
        return None


async def build_minimax_h3_prompt(context: MiniMaxH3BeatContext) -> MiniMaxH3PromptResult:
    agent = get_minimax_h3_prompt_agent()

    user_prompt: list = [_build_user_prompt(context)]
    first_frame_content = _load_reference_image_content(context.first_frame_path)
    if first_frame_content is not None:
        user_prompt.append(first_frame_content)
    for ref in context.references:
        ref_content = _load_reference_image_content(ref.image_path)
        if ref_content is not None:
            user_prompt.append(ref_content)

    response = await agent.run(user_prompt)
    return response.output

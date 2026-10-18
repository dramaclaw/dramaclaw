"""Lint for a Qwen-Image-Edit-2511 render prompt — checked before every
RunPod Qwen-Image-Edit-2511 render submission (`runpod_qwen_edit_render` /
`runpod_qwen_edit_render_multi`).

Rules come straight from the official "Edit Prompt Enhancer" rules in
`agents/prompts/qwen_edit_render_rules.md` (copied verbatim from
`QwenLM/Qwen-Image`'s `EDIT_SYSTEM_PROMPT`) plus the project-specific
pitfalls recorded there and in `.claude/CLAUDE.md`. Never blocks
generation on its own — the caller decides what counts as a hard error vs.
a warning; see `LintResult.ok`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

MAX_PROMPT_CHARS = 1500  # these are short single-instruction edit prompts, not H3's multi-section format

_BANNED_LAYOUT_WORDS_RE = re.compile(
    r"\b(grid|panel|panels|storyboard|collage|regions?)\b", re.IGNORECASE
)
# Mannequin tracking colors used by BRIDGMAN_CHARACTER_PALETTE
# (generators/episode_optimizer.py) — flagging these catches the "named the
# sketch fill color as clothing" failure mode recorded in
# qwen_edit_render_rules.md. List is the actual palette's color names
# (magenta/cyan/lime/violet/mint/azure/purple/aqua/indigo), not a guess —
# confirmed missing "cyan" specifically in a real AI-rewrite output
# (2026-10-18, BabyStories beat 7, qwen21 sibling lint) before this fix.
# Deliberately excludes common standalone clothing colors (red/blue/green/
# yellow/orange/purple) that are NOT part of this palette and legitimately
# appear in real appearance descriptions (e.g. "navy blue coat", "red
# tie") — only the palette's own, rarer fluorescent/neon names are
# specific enough to reliably indicate this failure mode rather than a
# real clothing description. Deliberately does NOT include the bare word
# "mannequin" — the default template itself correctly uses "the mannequin
# figure" to mean "the sketch placeholder figure", which is fine; only
# naming its specific tracking *color* is the known failure mode.
_MANNEQUIN_COLOR_WORDS_RE = re.compile(
    r"\b(magenta|fuchsia|chartreuse|crimson|cyan|lime|violet|mint|azure|aqua|indigo)"
    r"(?:-colou?red)?\b",
    re.IGNORECASE,
)
_INSTRUCTION_VERB_RE = re.compile(
    r"^(Replace|Convert|Change|Keep|Restore|Add|Remove|Extend|Perform)\b", re.IGNORECASE
)
# Pose/action verbs — a `stage="inpaint"` prompt should describe WHO to
# swap in (identity), never WHAT they're doing (pose is already locked by
# SetLatentNoiseMask, not by text). Confirmed by real testing (2026-10-17,
# beat 6): given the whole beat's description for every identity's inpaint
# pass, the rewriter attributed one person's action to a different
# identity's inpaint prompt, because nothing in a flat-color sketch tells
# a text-only reading which action belongs to which person. See
# qwen_edit_render_rules.md's matching pitfall entry.
_ACTION_VERB_RE = re.compile(
    r"\b(stand(?:s|ing)?|sit(?:s|ting)?|lectur(?:e|es|ing)|gestur(?:e|es|ing)|"
    r"point(?:s|ing)?|walk(?:s|ing)?|speak(?:s|ing)?|lean(?:s|ing)?|"
    r"kneel(?:s|ing)?|bend(?:s|ing)?|gazing|looking)\b",
    re.IGNORECASE,
)
_PHOTOREALISTIC_RE = re.compile(r"photorealistic", re.IGNORECASE)


@dataclass
class LintIssue:
    severity: str  # "error" | "warning"
    code: str
    message: str


@dataclass
class LintResult:
    issues: list[LintIssue] = field(default_factory=list)

    @property
    def errors(self) -> list[LintIssue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[LintIssue]:
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def ok(self) -> bool:
        return not self.errors


def lint_qwen_edit_render_prompt(
    prompt: str,
    *,
    stage: Literal["full", "scene_only", "inpaint"] = "full",
) -> LintResult:
    """`stage` controls which Picture tags are expected:
    - `full`/`inpaint`: exactly two images attached (Picture 1 + Picture 2) —
      the prompt must mention both.
    - `scene_only`: only Picture 1 is attached — the prompt must mention it
      and must NOT mention Picture 2 (there is no second image to refer to).
    """
    result = LintResult()
    text = prompt or ""
    if not text.strip():
        result.issues.append(LintIssue("error", "empty", "Prompt rỗng"))
        return result

    if "\n" in text:
        result.issues.append(
            LintIssue(
                "error",
                "newline",
                "Prompt chứa xuống dòng — theo chuẩn Qwen-Image-Edit, Rewritten phải là 1 dòng",
            )
        )

    if len(text) > MAX_PROMPT_CHARS:
        result.issues.append(
            LintIssue("error", "too_long", f"Prompt quá dài ({len(text)}/{MAX_PROMPT_CHARS} ký tự)")
        )

    has_picture_1 = "Picture 1" in text
    has_picture_2 = "Picture 2" in text
    has_image_1 = re.search(r"\bimage\s*1\b", text, re.IGNORECASE) is not None
    has_image_2 = re.search(r"\bimage\s*2\b", text, re.IGNORECASE) is not None

    if not has_picture_1:
        result.issues.append(
            LintIssue("error", "missing_picture_1", 'Thiếu "Picture 1" — Qwen-Image-Edit-2511 chỉ nhận ảnh qua tag "Picture N" này')
        )
    if stage in ("full", "inpaint"):
        if not has_picture_2:
            result.issues.append(
                LintIssue("error", "missing_picture_2", 'Thiếu "Picture 2" — prompt phải nói rõ phần tử của ảnh nào theo quy tắc Multi-Image')
            )
    elif stage == "scene_only" and has_picture_2:
        result.issues.append(
            LintIssue(
                "error",
                "unexpected_picture_2",
                'stage="scene_only" chỉ có 1 ảnh đính kèm (Picture 1) — prompt không nên nhắc "Picture 2"',
            )
        )

    if has_image_1 or has_image_2:
        result.issues.append(
            LintIssue(
                "error",
                "legacy_image_tag",
                'Prompt dùng "image 1"/"image 2" — ComfyUI node TextEncodeQwenImageEditPlus chèn token theo tên "Picture N", phải dùng đúng tên đó',
            )
        )

    if _BANNED_LAYOUT_WORDS_RE.search(text):
        result.issues.append(
            LintIssue(
                "error",
                "layout_word",
                "Có từ grid/panel/storyboard/collage/region — Qwen-Image-Edit-2511 đã từng hiểu nhầm thành ghép nhiều khung ảnh",
            )
        )

    if not _INSTRUCTION_VERB_RE.search(text.strip()):
        result.issues.append(
            LintIssue(
                "warning",
                "missing_lead_verb",
                "Câu đầu không bắt đầu bằng động từ chỉ thị (Replace/Convert/Change/...) như mẫu chính thức",
            )
        )

    if _MANNEQUIN_COLOR_WORDS_RE.search(text):
        result.issues.append(
            LintIssue(
                "warning",
                "mannequin_color_word",
                "Có tên màu tracking của mannequin (magenta/fuchsia/...) — model có thể hiểu nhầm là màu quần áo thật",
            )
        )

    if not _PHOTOREALISTIC_RE.search(text):
        result.issues.append(
            LintIssue(
                "warning",
                "missing_photorealistic",
                "Không thấy từ 'photorealistic' — nên có câu phong cách ở cuối theo quy tắc Style Conversion",
            )
        )

    if stage == "inpaint" and _ACTION_VERB_RE.search(text):
        result.issues.append(
            LintIssue(
                "warning",
                "inpaint_describes_action",
                "Prompt inpaint mô tả hành động/tư thế (standing/sitting/lecturing/...) — tư thế đã bị khoá bởi mask, mô tả này có nguy cơ gán nhầm hành động của người khác cho identity đang ghép",
            )
        )

    return result

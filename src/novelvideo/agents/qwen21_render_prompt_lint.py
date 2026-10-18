"""Lint for a Qwen-Image 2.1 render prompt — checked before every RunPod
Qwen-Image 2.1 render submission (`runpod_qwen21_render` /
`runpod_qwen21_render_multi`).

Rules come from the official Qwen-Image 2.1 "Edit Prompt Enhancer" rules in
`agents/prompts/qwen21_render_rules.md` (copied verbatim from the official
ComfyUI workflow template) plus the project-specific pitfalls recorded
there and in `.claude/CLAUDE.md`. Reuses `LintIssue`/`LintResult` from
`qwen_edit_render_prompt_lint` (same shape, no need to redefine) — the
*rules* genuinely differ between the two models (different tag convention,
different official prompt standard), which is why this is a separate lint
function rather than a parametrized version of the Edit-2511 one. Never
blocks generation on its own — the caller decides what counts as a hard
error vs. a warning; see `LintResult.ok`.
"""

from __future__ import annotations

import re
from typing import Literal

from novelvideo.agents.qwen_edit_render_prompt_lint import LintIssue, LintResult

MAX_PROMPT_CHARS = 2000  # short single-instruction edit prompts

_IMAGE_TAG_RE = re.compile(r"<image(\d+)>")
# Case/whitespace-insensitive superset of the valid tag — used to find
# near-misses (wrong case, a stray space) that _IMAGE_TAG_RE alone would
# just silently not match, rather than flag.
_IMAGE_TAG_NEAR_RE = re.compile(r"<\s*image\s*\d+\s*>", re.IGNORECASE)
_MALFORMED_WRAPPER_RE = re.compile(r"\[image\d+\]|\{image\d+\}|<img\d+>", re.IGNORECASE)
_LEGACY_TAG_RE = re.compile(
    r"\bPicture\s+\d+\b|\bimage\s+\d\b|\bthe\s+(first|second|third)\s+image\b|图\s*\d|第[一二三]张图",
    re.IGNORECASE,
)
_BANNED_LAYOUT_WORDS_RE = re.compile(
    r"\b(grid|panel|panels|storyboard|collage|regions?)\b", re.IGNORECASE
)
_RESOLUTION_TOKEN_RE = re.compile(
    r"\b\d+\s*:\s*\d+\b|\b\d{3,4}\s*[xX]\s*\d{3,4}\b|\b[1-4](\.5)?K\b"
)
_WRAPPER_OUTPUT_RE = re.compile(
    r'^\s*\{|"Rewritten"|```|^\s*#{1,6}\s|</?think>', re.MULTILINE
)
_INSTRUCTION_VERB_RE = re.compile(
    r"^(Replace|Convert|Change|Keep|Restore|Add|Remove|Extend|Perform|Edit|"
    r"Transform|Turn|Make|Render|Apply|Adjust|Recreate)\b",
    re.IGNORECASE,
)
_PHOTOREALISTIC_RE = re.compile(r"photorealistic|photograph", re.IGNORECASE)
# "preserv" (no trailing e), not "preserve" — the literal word misses
# "preserving"/"preserved", a real false positive seen 2026-10-18 on
# BabyStories beat 7's AI-rewritten scene prompt ("strictly preserving
# their exact poses").
_PRESERVATION_RE = re.compile(r"unchanged|keep|preserv|retain", re.IGNORECASE)
_PROHIBITION_RE = re.compile(r"\b(do not|don't|never)\b|禁止", re.IGNORECASE)
# Deliberately excludes "slightly" — legitimate for a precise spatial
# degree ("facing slightly left"), not uncertainty, and real AI-rewrite
# output uses it this way often enough to be a pure false positive
# (confirmed 2026-10-18, BabyStories beat 7).
_HEDGING_RE = re.compile(r"\b(maybe|possibly|perhaps)\b|either .* or", re.IGNORECASE)
_CJK_RE = re.compile(r"[一-鿿]")
_VIETNAMESE_DIACRITICS_RE = re.compile(
    "[ăâđêôơưĂÂĐÊÔƠƯ]|"
    "[àáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]",
    re.IGNORECASE,
)
# Palette-derived list (BRIDGMAN_CHARACTER_PALETTE,
# generators/episode_optimizer.py) — see qwen_edit_render_prompt_lint.py's
# copy of this regex for why common clothing colors (red/blue/green/
# yellow/orange/purple) are deliberately excluded. Confirmed missing
# "cyan" in a real AI-rewrite output before this fix (2026-10-18,
# BabyStories beat 7: "strictly preserving the cyan-colored mannequin
# figure").
_MANNEQUIN_COLOR_WORDS_RE = re.compile(
    r"\b(magenta|fuchsia|chartreuse|crimson|cyan|lime|violet|mint|azure|aqua|indigo)"
    r"(?:-colou?red)?\b",
    re.IGNORECASE,
)
_ACTION_VERB_RE = re.compile(
    r"\b(stand(?:s|ing)?|sit(?:s|ting)?|lectur(?:e|es|ing)|gestur(?:e|es|ing)|"
    r"point(?:s|ing)?|walk(?:s|ing)?|speak(?:s|ing)?|lean(?:s|ing)?|"
    r"kneel(?:s|ing)?|bend(?:s|ing)?|gazing|looking)\b",
    re.IGNORECASE,
)
_VERBAL_FACE_DESCRIPTION_RE = re.compile(
    r"\b(eye color|jawline|nose shape|cheekbone|iris color|eyebrow shape)\b",
    re.IGNORECASE,
)


def lint_qwen21_render_prompt(
    prompt: str,
    *,
    stage: Literal["full", "scene_only", "inpaint"] = "full",
) -> LintResult:
    """`stage` controls which `<imageN>` tags are expected:
    - `full`/`inpaint`: Multi-Image input (N=2) — the prompt must use both
      `<image1>` and `<image2>`.
    - `scene_only`: single-image input (N=1) — the official rule says NOT
      to tag at all; any `<imageN>` tag here is an error.
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
                "Prompt chứa xuống dòng — theo chuẩn chính thức, output phải là 1 đoạn văn liên tục",
            )
        )

    if len(text) > MAX_PROMPT_CHARS:
        result.issues.append(
            LintIssue("error", "too_long", f"Prompt quá dài ({len(text)}/{MAX_PROMPT_CHARS} ký tự)")
        )

    tags = [int(n) for n in _IMAGE_TAG_RE.findall(text)]
    has_image1 = 1 in tags
    has_image2 = 2 in tags
    out_of_range = [n for n in tags if n > 2]

    if stage in ("full", "inpaint"):
        if not has_image1:
            result.issues.append(
                LintIssue("error", "missing_image1_tag", "Thiếu <image1> — stage này cần Multi-Image (N=2)")
            )
        if not has_image2:
            result.issues.append(
                LintIssue("error", "missing_image2_tag", "Thiếu <image2> — stage này cần Multi-Image (N=2)")
            )
    elif stage == "scene_only" and tags:
        result.issues.append(
            LintIssue(
                "error",
                "unexpected_tag",
                'stage="scene_only" chỉ có 1 ảnh đính kèm — quy tắc chính thức: input 1 ảnh KHÔNG được gắn tag <imageN>',
            )
        )

    if out_of_range:
        result.issues.append(
            LintIssue("error", "tag_out_of_range", f"Có tag ngoài phạm vi (chỉ dùng <image1>/<image2>): {out_of_range}")
        )

    has_malformed = bool(_MALFORMED_WRAPPER_RE.search(text)) or len(
        _IMAGE_TAG_NEAR_RE.findall(text)
    ) != len(_IMAGE_TAG_RE.findall(text))
    if has_malformed:
        result.issues.append(
            LintIssue("error", "malformed_tag", 'Tag sai định dạng — phải đúng y nguyên "<image1>"/"<image2>" (chữ thường, không khoảng trắng)')
        )

    if _LEGACY_TAG_RE.search(text):
        result.issues.append(
            LintIssue(
                "error",
                "legacy_tag",
                'Dùng "Picture N"/"image 1"/"the first image"/... — Qwen-Image 2.1 không tự chèn token như Edit-2511, quy tắc chính thức bắt buộc đúng "<image1>"/"<image2>"',
            )
        )

    if _BANNED_LAYOUT_WORDS_RE.search(text):
        result.issues.append(
            LintIssue("error", "layout_word", "Có từ grid/panel/storyboard/collage/region — đây là 1 ảnh đơn, không phải bố cục nhiều khung")
        )

    if _RESOLUTION_TOKEN_RE.search(text):
        result.issues.append(
            LintIssue("error", "resolution_token", 'Có token tỉ lệ/độ phân giải (vd "9:16", "2K") — quy tắc chính thức: "output size is decided downstream, not by you"')
        )

    if _WRAPPER_OUTPUT_RE.search(text):
        result.issues.append(
            LintIssue("error", "wrapper_output", 'Output có vẻ bọc JSON/code fence/heading/còn sót tag <think> — quy tắc chính thức: chỉ 1 đoạn văn thuần, không bọc gì cả (khác Edit-2511\'s {"Rewritten":...})')
        )

    if not _INSTRUCTION_VERB_RE.search(text.strip()):
        result.issues.append(
            LintIssue("warning", "missing_lead_verb", "Câu đầu không bắt đầu bằng động từ chỉ thị (Replace/Convert/Change/...)")
        )

    if not _PHOTOREALISTIC_RE.search(text):
        result.issues.append(
            LintIssue("warning", "missing_medium_conversion", "Không thấy từ 'photorealistic'/'photograph' — nên nêu rõ việc chuyển từ sketch sang ảnh thật")
        )

    if not _PRESERVATION_RE.search(text):
        result.issues.append(
            LintIssue("warning", "missing_preservation_clause", "Không thấy câu giữ nguyên (unchanged/keep/preserve) cho phần nội dung không chỉnh sửa")
        )

    if '"' in text:
        result.issues.append(
            LintIssue("warning", "quoted_text", 'Có dấu ngoặc kép — theo quy tắc chính thức, ngoặc kép chỉ dành cho chữ sẽ HIỂN THỊ trong ảnh, beat render không cần chữ trên ảnh')
        )

    if _CJK_RE.search(text) or _VIETNAMESE_DIACRITICS_RE.search(text):
        result.issues.append(
            LintIssue("warning", "non_english_prose", "Có chữ Hán/dấu tiếng Việt trong phần mô tả — nên viết tiếng Anh (language decision A)")
        )

    if _PROHIBITION_RE.search(text):
        result.issues.append(
            LintIssue("warning", "prohibition_phrasing", 'Dùng câu phủ định (do not/never) — quy tắc chính thức khuyên diễn đạt khẳng định ("keep X unchanged")')
        )

    if _HEDGING_RE.search(text):
        result.issues.append(
            LintIssue("warning", "hedging", "Có từ mập mờ (maybe/possibly/either...or) — quy tắc chính thức: quyết đoán, không để ngỏ phương án")
        )

    if _MANNEQUIN_COLOR_WORDS_RE.search(text):
        result.issues.append(
            LintIssue("warning", "mannequin_color_word", "Có tên màu tracking của mannequin (magenta/fuchsia/...) — model có thể hiểu nhầm là màu quần áo thật")
        )

    if stage == "inpaint" and _ACTION_VERB_RE.search(text):
        result.issues.append(
            LintIssue("warning", "inpaint_describes_action", "Prompt inpaint mô tả hành động/tư thế — tư thế đã bị khoá bởi mask, mô tả này có nguy cơ gán nhầm hành động của người khác")
        )

    if _VERBAL_FACE_DESCRIPTION_RE.search(text):
        result.issues.append(
            LintIssue("warning", "verbal_face_description", "Mô tả khuôn mặt bằng chữ (eye color/jawline/...) — quy tắc chính thức: identity nên trỏ vào <image2>, không mô tả bằng lời")
        )

    return result

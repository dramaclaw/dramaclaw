"""Lint for a MiniMax H3 prompt — checked before every H3 video submission.

Ports the structural checks from the `photoreal-short-drama-generator`
project's `scripts/h3_prompt_lint.py` (section order, `<Picture N>`
numbering, single-shot, no stray quotes) plus the behavioral checklist
items from `h3-micro-cinematic-director` §28 / `h3-performance-director`
§39 (bare emotion words, banned slow words, more than one camera move,
endings that don't resolve). Never blocks generation — only annotates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

REF_SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)
BASE_SECTIONS = ("integrated_multimodal_description", "overall_soundscape", "non_diegetic_music")

FL2VA_ALIGNMENT_RE = re.compile(
    r"^For the target video, at 0\.00 seconds into the target video, "
    r"<Picture 1> \(from \[Shot 1\]\) is fully referenced\.$",
    re.MULTILINE,
)
PICTURE_TAG_RE = re.compile(r"<Picture (\d+)>")
SHOT_RE = re.compile(r"\[Shot (\d+)\]")
DIALOGUE_RE = re.compile(r"<d>\s*\[([A-Za-z]+)\]\s*(.*?)</d>", re.DOTALL)
TIMESTAMP_RE = re.compile(r"\b(\d+\.\d{2})\b")
BARE_EMOTION_RE = re.compile(
    r"\b(she|he|they)\s+(looks?|feels?|seems?|is)\s+"
    r"(nervous|scared|afraid|sad|happy|angry|anxious|worried|terrified|furious)\b",
    re.IGNORECASE,
)
BANNED_SLOW_WORDS_RE = re.compile(
    r"\b(slowly|gently|gradually|subtly|lingering|lingers)\b", re.IGNORECASE
)
CAMERA_MOVE_RE = re.compile(
    r"\b(push(?:es)? in|pull(?:s)? out|pans?|tilts?|trucks?|orbits?|tracks?|zoom(?:s)? in|zoom(?:s)? out)\b",
    re.IGNORECASE,
)
ORBIT_RE = re.compile(r"\borbit|rotates? around|circles? around\b", re.IGNORECASE)
ENDS_CONTINUES_RE = re.compile(r"\b(continues?|keeps?) (\w+ing)\b[^.]*\.?\s*$", re.IGNORECASE)
NO_SUBTITLE_HINT_RE = re.compile(r"no (subtitles?|captions?|on-screen text|watermarks?)", re.IGNORECASE)
MAX_PROMPT_CHARS = 7000  # official per-segment limit
SOFT_LENGTH_BUDGET = 3200  # keep near the low end of the official 350-500 word guidance
_VIETNAMESE_DIACRITICS_RE = re.compile(
    "[ăâđêôơưĂÂĐÊÔƠƯ]|"
    "[àáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]",
    re.IGNORECASE,
)


def _script_guess(text: str) -> str | None:
    """Best-effort script/language guess for one `<d>` line — only used to
    flag a `<d>[Language]` tag that looks mismatched with its own content
    (e.g. tag says `[Chinese]` but the line is plainly Vietnamese or
    English), not to decide the real language. Returns `None` when the
    guess is unclear (short/mixed text) so the caller skips the check
    rather than false-flag it."""
    if not text.strip():
        return None
    if _VIETNAMESE_DIACRITICS_RE.search(text):
        return "Vietnamese"
    han = sum(1 for ch in text if "一" <= ch <= "鿿")
    if han:
        return "Chinese"
    latin = sum(1 for ch in text if ch.isalpha())
    if latin >= 3:
        return "English"
    return None


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


def _strip_dialogue_spans(text: str) -> str:
    """Remove `<d>...</d>` spans so a '"' check doesn't flag quotes inside
    actual dialogue (dialogue itself is allowed to contain any text)."""
    return DIALOGUE_RE.sub("", text)


def _section_body(prompt: str, name: str) -> str | None:
    match = re.search(rf"^{re.escape(name)}:\s*$", prompt, re.MULTILINE)
    if not match:
        return None
    rest = prompt[match.end():]
    next_section = re.search(r"^[a-z_]+:\s*$", rest, re.MULTILINE)
    return rest[: next_section.start()] if next_section else rest


def lint_minimax_h3_prompt(
    prompt: str,
    *,
    mode: str = "ref2va",
    reference_count: int = 1,
    duration_seconds: float | None = None,
    expects_dialogue: bool = False,
) -> LintResult:
    """`reference_count` is the total number of `<Picture N>` tags expected
    (first frame counts as 1). `duration_seconds`, if given, checks the
    last timestamp against it. `expects_dialogue=True` means the beat's
    `audio_type` is `dialogue` — a prompt with no `<d>` tag at all in that
    case silently drops the character's line (seen in a real run: the
    rewriter wrote an accurate, well-formed prompt that simply never
    quoted the dialogue anywhere), which the structural checks below can't
    catch on their own since a beat with no dialogue is equally valid with
    zero `<d>` tags."""
    result = LintResult()
    text = prompt or ""
    if not text.strip():
        result.issues.append(LintIssue("error", "empty", "Prompt 为空"))
        return result

    if len(text) > MAX_PROMPT_CHARS:
        result.issues.append(
            LintIssue("error", "too_long", f"Prompt 超过官方单段长度上限 ({len(text)}/{MAX_PROMPT_CHARS} 字符)")
        )
    elif len(text) > SOFT_LENGTH_BUDGET:
        result.issues.append(
            LintIssue(
                "warning",
                "long",
                f"Prompt 偏长 ({len(text)} 字符)，5-8s 的 beat 建议贴近官方 350-500 词区间的下限",
            )
        )

    sections = REF_SECTIONS if mode == "ref2va" else BASE_SECTIONS
    if mode == "fl2va" and not FL2VA_ALIGNMENT_RE.search(text):
        result.issues.append(
            LintIssue("error", "missing_alignment_line", "fl2va 缺少官方对齐句（逐字）")
        )
    missing = [name for name in sections if _section_body(text, name) is None]
    if missing:
        result.issues.append(
            LintIssue("error", "missing_sections", f"缺少段落: {', '.join(missing)}")
        )
    else:
        positions = [text.index(f"{name}:") for name in sections]
        if positions != sorted(positions):
            result.issues.append(LintIssue("error", "section_order", "段落顺序不正确"))
        music_body = (_section_body(text, sections[-1]) or "").strip()
        if not music_body:
            result.issues.append(LintIssue("error", "missing_music_field", "non_diegetic_music 段为空"))

    picture_numbers = [int(n) for n in PICTURE_TAG_RE.findall(text)]
    expected = list(range(1, max(reference_count, 1) + 1))
    if sorted(set(picture_numbers)) != expected:
        result.issues.append(
            LintIssue(
                "error",
                "picture_tags_mismatch",
                f"<Picture N> 标签 ({sorted(set(picture_numbers))}) 与参考图数量 ({reference_count}) 不匹配",
            )
        )

    shot_numbers = sorted(set(int(n) for n in SHOT_RE.findall(text)))
    if shot_numbers != [1]:
        result.issues.append(
            LintIssue(
                "error",
                "shot_marker",
                "必须恰好出现一次 [Shot 1] 标记（官方格式字面量），检测到: "
                f"{shot_numbers or '(无)'}",
            )
        )

    stripped = _strip_dialogue_spans(text)
    if '"' in stripped:
        result.issues.append(
            LintIssue("error", "stray_quotes", "<d> 标签之外出现双引号，H3 可能把它渲染成画面文字")
        )

    dialogues = DIALOGUE_RE.findall(text)
    if "<d>" in text and not dialogues:
        result.issues.append(LintIssue("error", "dialogue_missing_language_tag", "<d> 缺少语言标签，如 [Vietnamese]"))
    if expects_dialogue and "<d>" not in text:
        result.issues.append(
            LintIssue(
                "error",
                "dialogue_missing",
                "这个 beat 应该有台词（audio_type=dialogue），但 prompt 里完全没有 <d> 标签",
            )
        )
    for lang, line in dialogues:
        detected = _script_guess(line)
        if detected and detected.lower() not in lang.lower() and lang.lower() not in detected.lower():
            result.issues.append(
                LintIssue(
                    "warning",
                    "dialogue_language_mismatch",
                    f"<d> 标的语言是 [{lang}]，但内容像是 {detected}（可能被模型翻译/替换了台词）",
                )
            )
    for _lang, line in dialogues:
        syllables = len(re.findall(r"[aeiouAEIOUàáạảãăằắặẳẵâầấậẩẫèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹ]+", line))
        if duration_seconds and syllables > 0:
            max_syllables = duration_seconds * 3.0
            if syllables > max_syllables:
                result.issues.append(
                    LintIssue(
                        "warning",
                        "dialogue_too_long",
                        f"台词约 {syllables} 个音节，可能塞不进 {duration_seconds:.1f}s 的窗口",
                    )
                )

    if duration_seconds is not None:
        timestamps = [float(t) for t in TIMESTAMP_RE.findall(text)]
        if timestamps and abs(max(timestamps) - duration_seconds) > 0.5:
            result.issues.append(
                LintIssue(
                    "warning",
                    "timestamp_mismatch",
                    f"最后一个时间戳 ({max(timestamps):.2f}s) 和 beat 时长 ({duration_seconds:.1f}s) 对不上",
                )
            )

    if BARE_EMOTION_RE.search(text):
        result.issues.append(
            LintIssue("warning", "bare_emotion", "出现裸情绪词（如 'she looks nervous'），应改写成可见动作")
        )
    if BANNED_SLOW_WORDS_RE.search(text):
        result.issues.append(
            LintIssue("warning", "slow_words", "出现 slowly/gently/gradually 等词，除非刻意安静，否则容易变成静止画面")
        )
    camera_moves = set(m.lower() for m in CAMERA_MOVE_RE.findall(text))
    if len(camera_moves) > 1:
        result.issues.append(
            LintIssue("warning", "multi_camera_move", f"检测到不止一种运镜: {sorted(camera_moves)}")
        )
    if ORBIT_RE.search(text):
        result.issues.append(
            LintIssue("warning", "orbit_camera", "环绕/绕后运镜在 I2V 上容易丢失角色一致性")
        )
    if ENDS_CONTINUES_RE.search(text.strip()):
        result.issues.append(
            LintIssue("warning", "open_ending", "结尾用了 continues/keeps，没有明确的结束状态")
        )
    if not NO_SUBTITLE_HINT_RE.search(text):
        result.issues.append(
            LintIssue("warning", "missing_no_subtitle_clause", "没有明确写'无字幕/无水印'")
        )

    return result

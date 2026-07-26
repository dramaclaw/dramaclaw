"""剧本导入质量预检。"""

from __future__ import annotations

from dataclasses import dataclass, field
import re

from novelvideo.utils.screenplay_scene_parser import (
    INTERIOR_EXTERIOR,
    INLINE_LABELED_SCENE_RE,
    LABELED_LOCATION_RE,
    TIME_TOKEN_RE,
    is_scene_start_line,
    parse_scene_blocks,
)


SCENE_HEADER_RE = re.compile(
    r"^(?:\d+\s*[-－]\s*\d+\s+)?[\u4e00-\u9fffA-Za-z0-9·《》、 ]{2,40}\s+"
    r"(?:日|夜|晨|晚|午|黄昏|上午|正午|午后|下午|傍晚|夜晚)\s+(?:内|外)$"
)
SCENE_BLOCK_HEADER_RE = re.compile(
    r"^场次[（(]?\d+[）)]?"
    r"(?:\s*[:：])?"
    r".*?地点[：:]\s*.+?[，,、]\s*"
    r"(?:日|夜|晨|晚|午|黄昏|上午|正午|午后|下午|傍晚|夜晚)\s*[，,、]\s*(?:内|外)"
)
SCENE_HEADER_WITHOUT_TIME_RE = re.compile(
    r"^(?:\d+\s*[-－]\s*\d+\s+)?[\u4e00-\u9fffA-Za-z0-9·《》、 ]{2,40}\s+(?:内|外)$"
)
SCENE_BLOCK_HEADER_WITHOUT_TIME_RE = re.compile(
    r"^场次[（(]?\d+[）)]?"
    r"(?:\s*[:：])?"
    r".*?地点[：:]\s*.+?[，,、]\s*(?:内|外)(?:[；;，,、].*)?$"
)
SPEAKER_LINE_RE = re.compile(r"^[^\n：:]{1,20}[：:](.+)$")
META_SECTION_HEADER_RE = re.compile(r"^(梗概|人物小传|人物介绍|角色介绍|角色小传)\s*[：:]?\s*$")
SHOT_PREFIX_RE = re.compile(r"^[【\[][^】\]]+[】\]]")
AMBIGUOUS_SPEAKERS = {
    "他", "她", "他们", "她们", "对方", "对面的人", "男人", "女人", "那人",
    "来人", "某人", "电话那头", "电话里", "声音", "对面", "那头",
}
SCENE_MARKER_COLON_NUMBER_RE = re.compile(r"^\s*场次\s*[:：]\s*(\d+)\s*$")
SPLIT_TIME_LINE_RE = re.compile(r"^(?:时间|时段)[：:].*$")
NUMBERED_SCENE_PREFIX_RE = re.compile(r"^\s*\d+\s*[-－]\s*\d+")
_EXPLICIT_TIME_RE = re.compile(rf"(?:^|[\s，,、])(?:{TIME_TOKEN_RE})(?:$|[\s，,、])")
_INTERIOR_EXTERIOR_SLOT_RE = re.compile(r"(?:^|[\s，,、])(内|外)\s*$")

FIX_HINTS = {
    "duplicate_chapter_number": "Check sentences in the body that look like chapter titles to avoid splitting one chapter number into multiple chapters.",
    "scene_headers_missing_time": "Add an explicit time to scene headers, such as “日/夜/深夜”.",
    "multi_speaker_lines": "Reformat to one line of dialogue per line, keeping a single speaker per line.",
    "ambiguous_speakers": "Replace vague speakers like “他/她/对方” with specific character names.",
    "heavy_parenthetical_dialogue": "Move parenthetical stage directions to action lines and keep only dialogue on dialogue lines.",
    "many_long_dialogues": "Split overly long dialogue to reduce the length of individual dialogue lines.",
    "missing_scene_headers": "Add scene headers to the body, such as “1-1 地点 时间 内/外”.",
    "non_increasing_chapter_number": "Check that chapter numbers increase, or confirm that chapter-like text in the body was not mistakenly split as a title.",
    "too_few_dialogue_lines": "Add recognizable dialogue lines, formatted like “角色：台词”.",
    "sparse_scene_headers": "Add scene headers per scene (one scene header per scene).",
}


@dataclass(frozen=True)
class ScreenplayQualityIssue:
    severity: str
    code: str
    message: str


@dataclass
class ScreenplayQualityReport:
    looks_like_screenplay: bool
    metrics: dict[str, int] = field(default_factory=dict)
    blocking_issues: list[ScreenplayQualityIssue] = field(default_factory=list)
    warnings: list[ScreenplayQualityIssue] = field(default_factory=list)

    @property
    def has_blocking_issues(self) -> bool:
        return bool(self.blocking_issues)


def check_screenplay_import_quality(text: str) -> ScreenplayQualityReport:
    lines = _extract_screenplay_candidate_lines(text or "")
    non_empty_lines = [line for line in lines if line]
    scene_blocks = parse_scene_blocks(non_empty_lines)

    scene_block_header_count = len(
        [
            block
            for block in scene_blocks
            if block.header_line and block.header_line.startswith(("场次", "第"))
        ]
    )
    scene_header_count = len([block for block in scene_blocks if block.header_line]) - scene_block_header_count
    dialogue_line_count = 0
    multi_speaker_line_count = 0
    ambiguous_speaker_count = 0
    parenthetical_dialogue_count = 0
    long_dialogue_count = 0
    scene_headers_missing_time_count = len(
        [block for block in scene_blocks if block.header_line and not block.time_of_day]
    )

    for line in non_empty_lines:
        if is_scene_start_line(line):
            continue
        if line.startswith(("地点：", "地点:", "环境：", "环境:", "场景：", "场景:")):
            continue
        if line.startswith(("人物：", "人物:", "出场人物：", "出场人物:", "角色：", "角色:")):
            continue
        if SCENE_HEADER_WITHOUT_TIME_RE.match(line) or SCENE_BLOCK_HEADER_WITHOUT_TIME_RE.match(line):
            scene_headers_missing_time_count += 1
            continue

        match = SPEAKER_LINE_RE.match(line)
        if not match:
            continue

        dialogue_line_count += 1
        dialogue_text = match.group(1).strip()
        speaker_label = re.split(r"[：:]", line, maxsplit=1)[0].strip()
        speaker_label = re.sub(r"[（(].*?[）)]", "", speaker_label).strip()

        colon_count = line.count("：") + line.count(":")
        if colon_count >= 2:
            multi_speaker_line_count += 1
        if speaker_label in AMBIGUOUS_SPEAKERS:
            ambiguous_speaker_count += 1
        if "（" in line or "(" in line:
            parenthetical_dialogue_count += 1
        if len(dialogue_text) >= 40:
            long_dialogue_count += 1

    total_scene_headers = scene_header_count + scene_block_header_count
    looks_like_screenplay = total_scene_headers >= 2 or dialogue_line_count >= 8
    report = ScreenplayQualityReport(
        looks_like_screenplay=looks_like_screenplay,
        metrics={
            "non_empty_lines": len(non_empty_lines),
            "scene_headers": scene_header_count,
            "scene_block_headers": scene_block_header_count,
            "total_scene_headers": total_scene_headers,
            "dialogue_lines": dialogue_line_count,
            "multi_speaker_lines": multi_speaker_line_count,
            "ambiguous_speakers": ambiguous_speaker_count,
            "parenthetical_dialogues": parenthetical_dialogue_count,
            "long_dialogue_lines": long_dialogue_count,
            "scene_headers_missing_time": scene_headers_missing_time_count,
        },
    )

    if not looks_like_screenplay:
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="not_screenplay_like",
                message="The text reads more like novel prose than a scene-based screenplay. This precheck will not block the import, but downstream structuring may be less effective.",
            )
        )
        return report

    if total_scene_headers == 0:
        report.blocking_issues.append(
            ScreenplayQualityIssue(
                severity="blocking",
                code="missing_scene_headers",
                message="No recognizable scene header detected (e.g. “商场一层入口处 日 内” or “场次（1）地点：兰州拉面馆，夜，内”); does not meet the 2.0 screenplay import requirements.",
            )
        )
    elif total_scene_headers < max(1, dialogue_line_count // 12):
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="sparse_scene_headers",
                message="Few scene headers; continuous scenes and time inheritance may be unstable.",
            )
        )

    if scene_headers_missing_time_count > 0:
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="scene_headers_missing_time",
                message="Detected scene/scene-block headers without an explicit time anchor; downstream time_of_day and scene variant inheritance may be unstable.",
            )
        )

    if dialogue_line_count < 5:
        report.blocking_issues.append(
            ScreenplayQualityIssue(
                severity="blocking",
                code="too_few_dialogue_lines",
                message="Too few valid dialogue lines; the text does not look like a structurable screenplay.",
            )
        )

    if multi_speaker_line_count >= 3:
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="multi_speaker_lines",
                message="Found dialogue lines that mix multiple speakers/colons on a single line; the system will try to normalize them under the tier-B screenplay rules, but it is better to reformat to one line of dialogue per line first.",
            )
        )

    if ambiguous_speaker_count >= max(3, dialogue_line_count // 5):
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="ambiguous_speakers",
                message="Many vague speakers found (e.g. “他/她/对方/电话那头”); downstream identity normalization may be unstable.",
            )
        )

    if parenthetical_dialogue_count >= max(4, dialogue_line_count // 3):
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="heavy_parenthetical_dialogue",
                message="Dialogue contains many parenthetical stage directions; import will rely on cleanup logic, so it is better to tidy them up beforehand.",
            )
        )

    if long_dialogue_count >= max(3, dialogue_line_count // 4):
        report.warnings.append(
            ScreenplayQualityIssue(
                severity="warning",
                code="many_long_dialogues",
                message="Many overly long single-sentence lines; this tends to cause long single-unit dialogue problems downstream.",
            )
        )

    return report


def build_import_format_check(
    text: str,
    *,
    has_chapters: bool,
    chapters: list[dict] | None = None,
) -> dict:
    report = check_screenplay_import_quality(text)
    metrics = dict(report.metrics)
    issues = _build_line_aware_format_issues(text or "")
    if chapters:
        issues.extend(_build_chapter_structure_issues(chapters))
    has_missing_interior_exterior = any(
        issue["code"] == "missing_interior_exterior" for issue in issues
    )

    for issue in [*report.blocking_issues, *report.warnings]:
        if issue.code == "not_screenplay_like":
            continue
        if issue.code == "scene_headers_missing_time" and has_missing_interior_exterior:
            continue
        if issue.code == "sparse_scene_headers" and metrics.get("dialogue_lines", 0) < 24:
            continue
        fix = FIX_HINTS.get(issue.code)
        if fix is None:
            continue
        issues.append(
            {
                "code": issue.code,
                "line": None,
                "message": issue.message,
                "fix": fix,
            }
        )

    if not has_chapters:
        level = "blocking"
        summary = "No valid chapters or recognizable body text detected; cannot be used for screenplay structuring."
    elif issues:
        level = "warning"
        summary = f"Upload succeeded, but {len(issues)} formatting risks were detected that may affect scene recognition."
    else:
        level = "ok"
        summary = "Upload succeeded; screenplay format validation passed."

    return {
        "level": level,
        "summary": summary,
        "issues": issues,
        "metrics": metrics,
    }


def _build_line_aware_format_issues(text: str) -> list[dict]:
    lines = text.splitlines()
    issues: list[dict] = []

    for idx, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line:
            continue

        marker_match = SCENE_MARKER_COLON_NUMBER_RE.match(raw_line)
        if marker_match:
            number = marker_match.group(1)
            issues.append(
                {
                    "code": "scene_marker_colon_number",
                    "line": idx,
                    "message": f"“场次：{number}” is not a stable scene-number format.",
                    "fix": "Change it to “场次（1）” or “1-1”.",
                }
            )

        labeled_location = LABELED_LOCATION_RE.match(line)
        if (
            labeled_location
            and not _EXPLICIT_TIME_RE.search(labeled_location.group("location") or "")
            and _has_split_time_line(lines, idx)
        ):
            issues.append(
                {
                    "code": "split_location_time",
                    "line": idx,
                    "message": "Location and time are entered separately; the system may not merge them correctly.",
                    "fix": "Change it to “地点：人类城池，日，内/外”.",
                }
            )

        location_slot = _format_check_location_slot(line)
        if location_slot and _EXPLICIT_TIME_RE.search(location_slot) and not _has_interior_exterior_tail(
            location_slot
        ):
            issues.append(
                {
                    "code": "missing_interior_exterior",
                    "line": idx,
                    "message": "Scene header is missing “内/外”.",
                    "fix": "Add “内/外”, such as “地点 时间 内/外”.",
                }
            )

    return issues


def _build_chapter_structure_issues(chapters: list[dict]) -> list[dict]:
    issues: list[dict] = []
    seen_numbers: set[int] = set()
    previous_number: int | None = None

    for chapter in chapters:
        number = chapter.get("number")
        if not isinstance(number, int):
            continue
        line = chapter.get("start_line")
        line_number = line + 1 if isinstance(line, int) else None
        title = str(chapter.get("title") or "").strip()

        if number in seen_numbers:
            issues.append(
                {
                    "code": "duplicate_chapter_number",
                    "line": line_number,
                    "message": f"Duplicate chapter number detected {number}: {title or 'Untitled chapter'}.",
                    "fix": FIX_HINTS["duplicate_chapter_number"],
                }
            )
        seen_numbers.add(number)

        if previous_number is not None and number <= previous_number:
            issues.append(
                {
                    "code": "non_increasing_chapter_number",
                    "line": line_number,
                    "message": f"Chapter number jumped back or repeated from {previous_number} to {number}.",
                    "fix": FIX_HINTS["non_increasing_chapter_number"],
                }
            )
        previous_number = number

    return issues


def _has_split_time_line(lines: list[str], line_number: int) -> bool:
    checked = 0
    for raw_line in lines[line_number:]:
        line = raw_line.strip()
        if not line:
            continue
        checked += 1
        if SPLIT_TIME_LINE_RE.match(line):
            return True
        if checked >= 2:
            return False
    return False


def _format_check_location_slot(line: str) -> str:
    inline = INLINE_LABELED_SCENE_RE.match(line)
    if inline:
        return inline.group("location") or ""
    labeled = LABELED_LOCATION_RE.match(line)
    if labeled:
        return labeled.group("location") or ""
    if NUMBERED_SCENE_PREFIX_RE.match(line):
        return line
    return ""


def _has_interior_exterior_tail(line: str) -> bool:
    match = _INTERIOR_EXTERIOR_SLOT_RE.search(line)
    return bool(match and match.group(1) in INTERIOR_EXTERIOR)


def extract_screenplay_candidate_lines(text: str) -> list[str]:
    lines = [line.strip() for line in text.splitlines()]
    if not lines:
        return []

    first_scene_idx = None
    for idx, line in enumerate(lines):
        if is_scene_start_line(line):
            first_scene_idx = idx
            break
    if first_scene_idx is not None:
        return lines[first_scene_idx:]

    filtered: list[str] = []
    in_meta_section = False
    for line in lines:
        if not line:
            continue
        if META_SECTION_HEADER_RE.match(line):
            in_meta_section = True
            continue
        if in_meta_section:
            if is_scene_start_line(line):
                in_meta_section = False
                filtered.append(line)
                continue
            if re.match(r"^场次[（(]?\d+[）)]?", line):
                in_meta_section = False
                filtered.append(line)
                continue
            if re.match(r"^[（(]?\d+[）)]\s*[\u4e00-\u9fffA-Za-z0-9·]{1,20}\s*[：:]", line):
                continue
            if line == "END":
                continue
            continue
        filtered.append(line)
    return filtered


def _extract_screenplay_candidate_lines(text: str) -> list[str]:
    """Backward-compatible private alias."""
    return extract_screenplay_candidate_lines(text)

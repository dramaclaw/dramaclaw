"""Deterministic screenplay scene-header parser.

The parser is intentionally line-oriented and stateful: it does not assume that
scene metadata is one, two, or three lines. It opens a scene block when it sees a
scene-start signal, then consumes following location/character metadata lines
until the first story-content line.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re


TIME_TOKENS = {
    "日",
    "夜",
    "晨",
    "晚",
    "午",
    "黄昏",
    "清晨",
    "上午",
    "正午",
    "午后",
    "下午",
    "傍晚",
    "夜晚",
    "深夜",
    "凌晨",
}
CLASSICAL_TIME_RE = r"(?:子|丑|寅|卯|辰|巳|午|未|申|酉|戌|亥)时(?:[一二三四]刻|半)?"
MODERN_TIME_TOKEN_RE = "|".join(
    sorted((re.escape(token) for token in TIME_TOKENS), key=len, reverse=True)
)
TIME_TOKEN_RE = rf"(?:{CLASSICAL_TIME_RE}|{MODERN_TIME_TOKEN_RE})"
INTERIOR_EXTERIOR = {"内", "外"}
ENGLISH_TIME_TOKENS = {
    "DAY": "日",
    "NIGHT": "夜",
    "MORNING": "上午",
    "AFTERNOON": "下午",
    "EVENING": "傍晚",
    "DAWN": "清晨",
    "DUSK": "黄昏",
}
ROOM_TYPES = {
    "客厅",
    "厨房",
    "卧室",
    "书房",
    "阳台",
    "衣帽间",
    "走廊",
    "门口",
    "餐厅",
    "浴室",
    "卫生间",
    "洗手间",
}

EPISODE_HEADER_RE = re.compile(r"^第([一二三四五六七八九十百千万\d]+)集")
SCENE_MARKER_RE = re.compile(
    r"^(?:(?:场次|场)\s*|第\s*)?[（(]?(?P<scene_no>\d+)[）)]?"
    r"(?:\s*场)?(?:\s*[:：])?\s*$"
)
COLON_SCENE_MARKER_RE = re.compile(r"^场次\s*[:：]\s*(?P<scene_no>\d+)\s*$")
NUMBERED_SCENE_RE = re.compile(
    r"^(?P<episode>\d+)\s*(?P<separator>[-－.．])\s*(?P<scene>\d+)"
    r"(?:\s*[、，,\s]\s*)?(?P<rest>.*)$"
)
INSERT_SCENE_RE = re.compile(
    r"^[+＋]\s*场(?:次)?"
    r"(?:\s*[（(]?(?P<scene_no>\d+)[）)]?)?"
    r"(?:\s*[:：])?\s*(?P<rest>.*)$"
)
LABELED_LOCATION_RE = re.compile(r"^(?:地点|环境|场景)[：:]\s*(?P<location>.+)$")
LABELED_TIME_RE = re.compile(
    rf"^(?:时间|时段)[：:]\s*(?P<time>{TIME_TOKEN_RE})\s*$"
)
LABELED_INTERIOR_EXTERIOR_RE = re.compile(
    r"^(?:内外景|场景类型)[：:]\s*(?P<interior>内|外)\s*$"
)
LABELED_CHARACTER_RE = re.compile(r"^(?:人物|出场人物|角色)[：:]\s*(?P<characters>.+)$")
INLINE_LABELED_SCENE_RE = re.compile(
    r"^(?:场次|第)?[（(]?(?P<scene_no>\d+)[）)]?(?:\s*场)?"
    r"(?:\s*[:：])?.*?地点[：:]\s*(?P<location>.+?)"
    r"(?:[；;]\s*(?:人物|出场人物|角色)[：:]\s*(?P<characters>.+))?$"
)
BRACKETED_LABELED_SCENE_RE = re.compile(
    rf"^(?P<scene_no>\d+)\s*场景\s*[:：]\s*[【\[]\s*"
    rf"(?P<time>{TIME_TOKEN_RE})\s+"
    rf"(?P<location>.+?)\s+"
    r"(?P<interior>内|外)\s*[】\]]\s*$"
)
SIMPLE_LOCATION_RE = re.compile(
    rf"^(?P<location>.+?)[\s，,]+"
    rf"(?:(?P<time_first>{TIME_TOKEN_RE})[\s，,]+(?P<interior_last>内|外)"
    rf"|(?P<interior_first>内|外)[\s，,]+(?P<time_last>{TIME_TOKEN_RE}))$"
)
CHINESE_FOUNTAIN_SCENE_RE = re.compile(
    rf"^(?P<intro>内景|外景|内|外)\s*[.。]?\s+"
    rf"(?P<location>.+?)\s*[-–—－]\s*(?P<time>{TIME_TOKEN_RE})$",
    re.IGNORECASE,
)
INTERNATIONAL_SCENE_RE = re.compile(
    r"^(?P<intro>INT|EXT|EST|INT\./EXT|INT/EXT|I/E)\.?\s+"
    r"(?P<location>.+?)\s*[-–—]\s*"
    r"(?P<time>DAY|NIGHT|MORNING|AFTERNOON|EVENING|DAWN|DUSK)"
    r"(?:\s+#[A-Za-z0-9.\-]+#)?$",
    re.IGNORECASE,
)
SPEAKER_LINE_RE = re.compile(r"^[^\n：:]{1,24}[：:].+$")


@dataclass
class ParsedSceneBlock:
    header_line: str = ""
    location: str = ""
    time_of_day: str = ""
    interior_exterior: str = ""
    characters: list[str] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    episode: int = 0
    scene_no: str = ""
    modifier: str = ""


def split_screenplay_lines(text: str) -> list[str]:
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    return [line.strip() for line in normalized.split("\n") if line.strip()]


def parse_scene_blocks(text_or_lines: str | list[str]) -> list[ParsedSceneBlock]:
    lines = (
        split_screenplay_lines(text_or_lines)
        if isinstance(text_or_lines, str)
        else [str(line or "").strip() for line in text_or_lines if str(line or "").strip()]
    )
    blocks: list[ParsedSceneBlock] = []
    current = ParsedSceneBlock()
    current_episode = 0
    collecting_header = False
    pending_modifier = ""

    def flush_current() -> None:
        nonlocal current, collecting_header
        if current.header_line or current.lines:
            blocks.append(current)
        current = ParsedSceneBlock()
        collecting_header = False

    def start_block(
        line: str,
        *,
        scene_no: str = "",
        location_line: str = "",
        chars: str = "",
        modifier: str = "",
    ) -> None:
        nonlocal current, collecting_header, current_episode, pending_modifier
        flush_current()
        current = ParsedSceneBlock(
            header_line=line,
            episode=current_episode,
            scene_no=scene_no,
            modifier=modifier or pending_modifier,
        )
        pending_modifier = ""
        if location_line:
            _apply_location(current, location_line)
            if not current.location:
                _apply_partial_location(current, location_line)
        if chars:
            _extend_unique(current.characters, parse_character_line(chars))
        collecting_header = True

    for line_index, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line:
            continue

        episode_match = EPISODE_HEADER_RE.match(line)
        if episode_match:
            current_episode = chinese_to_int(episode_match.group(1))
            if current.header_line or current.lines:
                current.episode = current.episode or current_episode
            continue

        bracketed_labeled = BRACKETED_LABELED_SCENE_RE.fullmatch(line)
        if bracketed_labeled:
            if current_episode <= 0:
                current_episode = 1
            start_block(line, scene_no=bracketed_labeled.group("scene_no") or "")
            current.location = (bracketed_labeled.group("location") or "").strip()
            current.time_of_day = bracketed_labeled.group("time") or ""
            current.interior_exterior = bracketed_labeled.group("interior") or ""
            collecting_header = True
            continue

        international = _parse_international_scene_header(line)
        if international:
            if current_episode <= 0:
                current_episode = 1
            location, time_of_day, interior_exterior = international
            start_block(line)
            current.location = location
            current.time_of_day = time_of_day
            current.interior_exterior = interior_exterior
            collecting_header = True
            continue

        insert_scene = INSERT_SCENE_RE.fullmatch(line)
        if insert_scene:
            rest = (insert_scene.group("rest") or "").strip()
            next_line = lines[line_index + 1] if line_index + 1 < len(lines) else ""
            if rest and _looks_like_partial_location(rest):
                if current_episode <= 0:
                    current_episode = 1
                start_block(
                    line,
                    scene_no=insert_scene.group("scene_no") or "",
                    location_line=rest,
                    modifier="insert",
                )
            elif not rest:
                if is_scene_start_line(next_line):
                    pending_modifier = "insert"
                else:
                    if current_episode <= 0:
                        current_episode = 1
                    start_block(
                        line,
                        scene_no=insert_scene.group("scene_no") or "",
                        modifier="insert",
                    )
            # A standalone "+场" immediately before a complete scene heading is
            # only a production annotation. The following heading owns the block.
            continue

        colon_marker = COLON_SCENE_MARKER_RE.match(line)
        if colon_marker:
            if current_episode <= 0:
                current_episode = 1
            start_block(line, scene_no=colon_marker.group("scene_no") or "")
            continue

        inline = INLINE_LABELED_SCENE_RE.match(line)
        if inline:
            if current_episode <= 0:
                current_episode = 1
            start_block(
                line,
                scene_no=inline.group("scene_no") or "",
                location_line=inline.group("location") or "",
                chars=inline.group("characters") or "",
            )
            continue

        numbered = NUMBERED_SCENE_RE.match(line)
        if numbered and _looks_like_scene_number_line(numbered):
            ep = int(numbered.group("episode"))
            if current_episode <= 0 or ep != current_episode:
                current_episode = ep
            rest = (numbered.group("rest") or "").strip()
            start_block(line, scene_no=numbered.group("scene") or "", location_line=rest)
            continue

        marker = SCENE_MARKER_RE.match(line)
        next_line = lines[line_index + 1] if line_index + 1 < len(lines) else ""
        if marker and (
            _looks_like_bare_scene_marker(line)
            or bool(parse_location_header(next_line))
        ):
            if current_episode <= 0:
                current_episode = 1
            start_block(line, scene_no=marker.group("scene_no") or "")
            continue

        labeled_location = LABELED_LOCATION_RE.match(line)
        if labeled_location:
            if current.header_line and (collecting_header or not current.lines):
                _apply_location(current, labeled_location.group("location") or "")
                if not current.location:
                    current.location = (labeled_location.group("location") or "").strip()
                collecting_header = True
            else:
                start_block(line, location_line=labeled_location.group("location") or "")
                if not current.location:
                    current.location = (labeled_location.group("location") or "").strip()
            continue

        labeled_time = LABELED_TIME_RE.match(line)
        if labeled_time and current.header_line and (collecting_header or not current.lines):
            current.time_of_day = labeled_time.group("time") or ""
            collecting_header = True
            continue

        labeled_interior_exterior = LABELED_INTERIOR_EXTERIOR_RE.match(line)
        if (
            labeled_interior_exterior
            and current.header_line
            and (collecting_header or not current.lines)
        ):
            current.interior_exterior = labeled_interior_exterior.group("interior") or ""
            collecting_header = True
            continue

        labeled_chars = LABELED_CHARACTER_RE.match(line)
        if labeled_chars and current.header_line and (collecting_header or not current.lines):
            _extend_unique(current.characters, parse_character_line(labeled_chars.group("characters") or ""))
            collecting_header = True
            continue

        simple_location = parse_location_header(line)
        if simple_location and not _looks_like_content_line(line):
            if current.header_line and (collecting_header or not current.lines) and not current.location:
                _apply_location(current, line)
                collecting_header = True
                continue
            start_block(line, location_line=line)
            continue

        if collecting_header:
            collecting_header = False
        current.lines.append(line)

    flush_current()
    return [block for block in blocks if block.header_line or block.lines]


def is_scene_start_line(line: str) -> bool:
    stripped = (line or "").strip()
    if not stripped:
        return False
    if BRACKETED_LABELED_SCENE_RE.fullmatch(stripped):
        return True
    if _parse_international_scene_header(stripped):
        return True
    insert_scene = INSERT_SCENE_RE.fullmatch(stripped)
    if insert_scene and (
        not (insert_scene.group("rest") or "").strip()
        or _looks_like_partial_location(insert_scene.group("rest") or "")
    ):
        return True
    if INLINE_LABELED_SCENE_RE.match(stripped):
        return True
    if COLON_SCENE_MARKER_RE.match(stripped):
        return True
    numbered = NUMBERED_SCENE_RE.match(stripped)
    if numbered and _looks_like_scene_number_line(numbered):
        return True
    if SCENE_MARKER_RE.match(stripped) and _looks_like_bare_scene_marker(stripped):
        return True
    if LABELED_LOCATION_RE.match(stripped):
        return True
    return parse_location_header(stripped) is not None


def parse_location_header(line: str) -> tuple[str, str, str] | None:
    locs = parse_location_line(line)
    if not locs:
        return None
    if len(locs) == 1:
        name, time_of_day, interior = locs[0]
        return name, time_of_day, "内" if interior else "外"

    # A slash in a production scene heading commonly means that one written
    # scene spans adjacent sub-locations (for example "教室/楼梯间"). Preserve
    # that composite boundary here; Cognee may split it into physical places
    # later through parse_location_line().
    times = {time_of_day for _, time_of_day, _ in locs}
    interiors = {interior for _, _, interior in locs}
    if len(times) != 1 or len(interiors) != 1:
        return None
    name = "/".join(name for name, _, _ in locs)
    time_of_day = next(iter(times))
    interior = next(iter(interiors))
    return name, time_of_day, "内" if interior else "外"


def parse_location_line(line: str) -> list[tuple[str, str, bool]]:
    text = _strip_location_prefix(line)
    text = _strip_numbered_scene_prefix(text)
    text = re.sub(r"（[^）]*）", "", text).strip()
    if not text:
        return []

    tod = ""
    interior_exterior = ""

    comma_tokens = [token.strip() for token in re.split(r"[，,]", text) if token.strip()]
    if len(comma_tokens) >= 3 and comma_tokens[-1] in INTERIOR_EXTERIOR:
        maybe_time = comma_tokens[-2]
        if _is_time_token(maybe_time):
            tod = maybe_time
            interior_exterior = comma_tokens[-1]
            text = "，".join(comma_tokens[:-2]).strip()

    if not tod:
        simple = SIMPLE_LOCATION_RE.match(text)
        if simple:
            tod = simple.group("time_first") or simple.group("time_last") or ""
            interior_exterior = (
                simple.group("interior_last")
                or simple.group("interior_first")
                or ""
            )
            text = simple.group("location").strip()

    if not interior_exterior:
        int_ext_match = re.search(r"(内|外)\s*$", text)
        if int_ext_match:
            interior_exterior = int_ext_match.group(1)
            text = text[: int_ext_match.start()].strip()

    if not tod:
        time_match = re.search(rf"\s+({TIME_TOKEN_RE})(?:\s+|$)", text)
        if time_match:
            tod = time_match.group(1)
            text = (text[: time_match.start()] + text[time_match.end() :]).strip()

    if not interior_exterior:
        return []
    if not text:
        return []

    parts = [part.strip() for part in re.split(r"\s*/\s*|、", text) if part.strip()]
    parts = _inherit_building_prefix(parts)
    return [(name, tod, interior_exterior == "内") for name in parts]


def parse_character_line(line: str) -> list[str]:
    text = (line or "").strip()
    labeled = LABELED_CHARACTER_RE.match(text)
    if labeled:
        text = labeled.group("characters").strip()
    for prefix in ("人物：", "人物:", "出场人物：", "出场人物:", "角色：", "角色:"):
        if text.startswith(prefix):
            text = text.removeprefix(prefix).strip()
            break
    if not text:
        return []

    result: list[str] = []
    for part in re.split(r"[、，,]", text):
        item = part.strip()
        if not item:
            continue
        paren_match = re.search(r"[（(]([^）)]+)[）)]", item)
        if paren_match:
            item = paren_match.group(1).strip()
        if re.search(r"\d", item):
            continue
        result.append(item)
    return result


def chinese_to_int(s: str) -> int:
    if s.isdigit():
        return int(s)

    digits = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    units = {"十": 10, "百": 100, "千": 1000}

    result = 0
    current = 0
    for ch in s:
        if ch in digits:
            current = digits[ch]
        elif ch in units:
            if current == 0:
                current = 1
            result += current * units[ch]
            current = 0
    return result + current


def _apply_location(block: ParsedSceneBlock, location_line: str) -> None:
    loc = parse_location_header(location_line)
    if not loc:
        return
    block.location, block.time_of_day, block.interior_exterior = loc


def _apply_partial_location(block: ParsedSceneBlock, location_line: str) -> None:
    """Keep incomplete metadata after an explicit scene marker.

    This helper is never used to discover a boundary by itself. It only
    extracts best-effort hints once a numbered/``+场`` marker has already made
    the boundary explicit, leaving missing fields empty for the warning and AI
    normalization path.
    """

    text = _strip_location_prefix(location_line)
    text = _strip_numbered_scene_prefix(text)
    time_match = re.search(rf"({TIME_TOKEN_RE})\s*$", text)
    if time_match:
        block.time_of_day = time_match.group(1)
        text = text[: time_match.start()].strip()

    interior_matches = list(re.finditer(r"(?:^|[\s，,（(屋])(内|外)(?=$|[\s，,）)])", text))
    if interior_matches:
        interior_match = interior_matches[-1]
        block.interior_exterior = interior_match.group(1)

    text = re.sub(r"[（(][^）)]*[）)]", "", text).strip()
    text = re.sub(r"(?:^|[\s，,])(内|外)\s*$", "", text).strip()
    if text:
        block.location = text


def _extend_unique(items: list[str], new_items: list[str]) -> None:
    for item in new_items:
        if item and item not in items:
            items.append(item)


def _strip_location_prefix(line: str) -> str:
    text = (line or "").strip()
    labeled = LABELED_LOCATION_RE.match(text)
    if labeled:
        return labeled.group("location").strip()
    return text


def _strip_numbered_scene_prefix(line: str) -> str:
    match = NUMBERED_SCENE_RE.match((line or "").strip())
    if match and _looks_like_scene_number_line(match):
        return (match.group("rest") or "").strip()
    return line


def _looks_like_scene_number_line(match: re.Match[str]) -> bool:
    rest = (match.group("rest") or "").strip()
    if not rest:
        return True
    return bool(parse_location_line(rest)) or _looks_like_partial_location(rest)


def _looks_like_partial_location(text: str) -> bool:
    candidate = (text or "").strip()
    if not candidate or len(candidate) > 60:
        return False
    if SPEAKER_LINE_RE.match(candidate) or candidate.startswith(("△", "▲", "【", "[")):
        return False
    if candidate.endswith(("。", "！", "？", "!", "?")):
        return False
    return bool(re.search(r"[\u4e00-\u9fff]", candidate))


def _looks_like_bare_scene_marker(line: str) -> bool:
    stripped = (line or "").strip()
    return stripped.startswith(("场次", "场", "第"))


def _looks_like_content_line(line: str) -> bool:
    stripped = (line or "").strip()
    if not stripped:
        return False
    if stripped.startswith(("△", "▲", "【", "[")):
        return True
    return bool(SPEAKER_LINE_RE.match(stripped))


def _parse_international_scene_header(line: str) -> tuple[str, str, str] | None:
    """Parse supported Chinese/English Fountain-style scene headings.

    Mixed INT/EXT and EST headings are valid boundaries but do not provide a
    single reliable interior/exterior value. They are intentionally returned
    with an empty value so the import check can mark them repairable.
    """

    text = (line or "").strip()
    chinese = CHINESE_FOUNTAIN_SCENE_RE.fullmatch(text)
    if chinese:
        intro = (chinese.group("intro") or "").upper()
        interior = "内" if intro in {"内", "内景"} else "外"
        return (
            (chinese.group("location") or "").strip(),
            chinese.group("time") or "",
            interior,
        )

    international = INTERNATIONAL_SCENE_RE.fullmatch(text)
    if not international:
        return None
    intro = (international.group("intro") or "").upper()
    interior = "内" if intro == "INT" else "外" if intro == "EXT" else ""
    return (
        (international.group("location") or "").strip(),
        ENGLISH_TIME_TOKENS.get(
            (international.group("time") or "").upper(),
            "",
        ),
        interior,
    )


def _is_time_token(text: str) -> bool:
    return bool(re.fullmatch(TIME_TOKEN_RE, (text or "").strip()))


def _inherit_building_prefix(parts: list[str]) -> list[str]:
    if not parts:
        return parts
    prefix_match = re.match(r"^(.+?(?:家|公寓|楼))", parts[0])
    if not prefix_match:
        return parts
    prefix = prefix_match.group(1)
    result = [parts[0]]
    for part in parts[1:]:
        if part in ROOM_TYPES:
            result.append(prefix + part)
        else:
            result.append(part)
    return result

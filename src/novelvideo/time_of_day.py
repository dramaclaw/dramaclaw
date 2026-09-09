from __future__ import annotations

import re
from typing import Literal

CanonicalTimeOfDay = Literal["清晨", "上午", "正午", "午后", "白天", "黄昏", "夜晚"]
TimeOfDayOrEmpty = Literal["", "清晨", "上午", "正午", "午后", "白天", "黄昏", "夜晚"]
LlmTimeOfDay = Literal["无", "清晨", "上午", "正午", "午后", "白天", "黄昏", "夜晚"]

CANONICAL_TIME_OF_DAY_VALUES: tuple[str, ...] = (
    "清晨",
    "上午",
    "正午",
    "午后",
    "白天",
    "黄昏",
    "夜晚",
)
TIME_OF_DAY_VALUES_WITH_EMPTY: tuple[str, ...] = ("", *CANONICAL_TIME_OF_DAY_VALUES)

TIME_OF_DAY_ALIASES_BY_CANONICAL: dict[str, tuple[str, ...]] = {
    "清晨": ("清晨", "晨", "早晨", "清早", "拂晓", "黎明", "破晓", "卯时"),
    "上午": ("上午", "早上", "辰时", "巳时"),
    "正午": ("正午", "午", "午时", "中午", "晌午"),
    "午后": ("午后", "下午", "未时", "申时"),
    "白天": ("白天", "日", "昼", "日间"),
    "黄昏": ("黄昏", "傍晚", "薄暮", "暮色", "日落", "酉时"),
    "夜晚": (
        "夜晚",
        "夜",
        "晚上",
        "夜里",
        "夜间",
        "入夜",
        "深夜",
        "半夜",
        "凌晨",
        "戌时",
        "亥时",
        "子时",
        "丑时",
        "寅时",
        "三更",
    ),
}

_NORMALIZED_TIME_OF_DAY: dict[str, str] = {
    alias: canonical
    for canonical, aliases in TIME_OF_DAY_ALIASES_BY_CANONICAL.items()
    for alias in aliases
}
_CLASSICAL_HOUR_TO_TIME_OF_DAY: dict[str, str] = {
    "子": "夜晚",
    "丑": "夜晚",
    "寅": "夜晚",
    "卯": "清晨",
    "辰": "上午",
    "巳": "上午",
    "午": "正午",
    "未": "午后",
    "申": "午后",
    "酉": "黄昏",
    "戌": "夜晚",
    "亥": "夜晚",
}
_CLASSICAL_TIME_RE = re.compile(r"^(?P<hour>[子丑寅卯辰巳午未申酉戌亥])时(?:[一二三四]刻|半)?$")
_ENGLISH_TIME_OF_DAY: dict[str, str] = {
    "dawn": "清晨",
    "morning": "上午",
    "noon": "正午",
    "afternoon": "午后",
    "day": "白天",
    "daytime": "白天",
    "dusk": "黄昏",
    "evening": "黄昏",
    "night": "夜晚",
    "nighttime": "夜晚",
    "midnight": "夜晚",
}
_CLOCK_TIME_RE = re.compile(
    r"^(?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?\s*(?P<meridiem>AM|PM)?$",
    re.IGNORECASE,
)


def _clock_hour_to_time_of_day(hour: int) -> str:
    if hour < 5:
        return "夜晚"
    if hour < 8:
        return "清晨"
    if hour < 12:
        return "上午"
    if hour == 12:
        return "正午"
    if hour < 17:
        return "午后"
    if hour < 20:
        return "黄昏"
    return "夜晚"


def normalize_time_of_day(value: str | None) -> str:
    """Normalize extracted screenplay time words into the closed beat-time set."""

    text = str(value or "").strip()
    if not text:
        return ""
    direct = _NORMALIZED_TIME_OF_DAY.get(text)
    if direct:
        return direct
    english_direct = _ENGLISH_TIME_OF_DAY.get(text.lower())
    if english_direct:
        return english_direct
    classical_match = _CLASSICAL_TIME_RE.match(text)
    if classical_match:
        return _CLASSICAL_HOUR_TO_TIME_OF_DAY[classical_match.group("hour")]
    clock_match = _CLOCK_TIME_RE.match(text)
    if clock_match and (clock_match.group("minute") or clock_match.group("meridiem")):
        hour = int(clock_match.group("hour"))
        minute = int(clock_match.group("minute") or 0)
        meridiem = str(clock_match.group("meridiem") or "").upper()
        if minute < 60 and (
            (meridiem and 1 <= hour <= 12) or (not meridiem and 0 <= hour <= 23)
        ):
            if meridiem:
                hour = hour % 12 + (12 if meridiem == "PM" else 0)
            return _clock_hour_to_time_of_day(hour)
    return text


def time_of_day_name_candidates(value: str | None) -> list[str]:
    """Return likely plate-name suffixes for a canonical or legacy time token."""

    text = str(value or "").strip()
    if not text:
        return []
    canonical = normalize_time_of_day(text)
    if canonical not in TIME_OF_DAY_ALIASES_BY_CANONICAL:
        return []
    candidates: list[str] = []
    for item in (canonical, *TIME_OF_DAY_ALIASES_BY_CANONICAL[canonical]):
        item = str(item or "").strip()
        if item and item not in candidates:
            candidates.append(item)
    return candidates


def is_time_of_day_token(value: str | None) -> bool:
    return bool(time_of_day_name_candidates(value))

"""Small, deterministic language policy for generated asset prose."""

from __future__ import annotations

import inspect
import re
import unicodedata
from typing import Literal

import langid
from langdetect import DetectorFactory, LangDetectException, detect
import wordninja

AssetLanguage = Literal["zh", "en"]

DetectorFactory.seed = 0

_SCREENPLAY_HEADING_RE = re.compile(
    r"^(?:INT(?:/EXT)?\.|EXT(?:/INT)?\.|SCENE\b|ACT\b|EPISODE\b)",
    re.IGNORECASE,
)
_LATIN_SPEAKER_CUE_RE = re.compile(r"^[A-Za-z][A-Za-z .'-]{0,80}[:：]\s*")
_BARE_LATIN_SPEAKER_CUE_RE = re.compile(r"^[A-Z][A-Z .'-]{0,80}$")
_SHORT_ENGLISH_ACTION_RE = re.compile(
    r"^\s*\S+\s+(?P<verb>[A-Za-z]{2,}(?:s|ed|ing))\b",
    re.IGNORECASE | re.MULTILINE,
)


def detect_asset_language(text: str) -> AssetLanguage:
    """Choose Chinese or English from the dominant script in ``text``.

    Chinese and English are the only languages in this contract. Any other
    script, a tie, or empty input retains the historical Chinese default.
    """
    raw_text = str(text or "")
    raw_lines = [line.strip() for line in raw_text.splitlines()]
    has_latin_speaker_cue = any(
        _LATIN_SPEAKER_CUE_RE.match(line) or _BARE_LATIN_SPEAKER_CUE_RE.fullmatch(line)
        for line in raw_lines
    )
    prose_lines = [
        _LATIN_SPEAKER_CUE_RE.sub("", line.strip())
        for line in raw_lines
        if not _SCREENPLAY_HEADING_RE.match(line)
        and not _BARE_LATIN_SPEAKER_CUE_RE.fullmatch(line)
    ]
    prose = "\n".join(prose_lines).strip() or raw_text

    han = 0
    latin = 0
    for character in prose:
        codepoint = ord(character)
        if 0x3400 <= codepoint <= 0x4DBF or 0x4E00 <= codepoint <= 0x9FFF:
            han += 1
        elif "A" <= character <= "Z" or "a" <= character <= "z":
            latin += 1

    if han * 2 >= latin and han:
        return "zh"

    short_action_match = _SHORT_ENGLISH_ACTION_RE.search(prose)
    # langdetect is intentionally conservative for tiny screenplay actions.
    # Require the inflected verb to exist in wordninja's pinned English
    # frequency lexicon before overriding a non-English statistical result.
    looks_like_short_english_action = bool(
        short_action_match
        and short_action_match.group("verb").lower()
        in wordninja.DEFAULT_LANGUAGE_MODEL._wordcost
    )
    try:
        detected = detect(prose) if prose.strip() else ""
    except LangDetectException:
        detected = ""

    ascii_prose = unicodedata.normalize("NFKD", prose).encode("ascii", "ignore").decode()
    ascii_word_count = len(re.findall(r"[A-Za-z]+", ascii_prose))
    langid_detected = langid.classify(ascii_prose)[0] if ascii_prose.strip() else ""
    if detected == "en" and (langid_detected == "en" or ascii_word_count >= 3):
        return "en"
    if langid_detected == "en" and looks_like_short_english_action:
        return "en"
    if has_latin_speaker_cue and langid_detected == "en":
        english_words = re.findall(r"[A-Za-z]+", ascii_prose.lower())
        word_costs = [
            wordninja.DEFAULT_LANGUAGE_MODEL._wordcost.get(word, float("inf"))
            for word in english_words
        ]
        if english_words and max(word_costs) <= 11:
            return "en"

    # Unsupported natural languages — including kana/Hangul prose and Latin
    # languages that happen to be ASCII-only — retain the Chinese fallback.
    # Non-ASCII letters are deliberately not decisive: proper names such as
    # Chloë or 민지 may legitimately appear inside English prose.
    return "zh"


def asset_language_instruction(language: AssetLanguage) -> str:
    """Return the shared language rule appended to model requests."""
    if language == "en":
        return (
            "Write every user-visible prose field in English. "
            "Keep every supplied character and location name verbatim; "
            "never translate, romanize, or rewrite a name."
        )
    return (
        "所有面向用户的自由文本字段都使用中文。"
        "人物名和地点名必须按输入原样保留，不得翻译、音译或改写。"
    )


async def detect_episode_asset_language(
    store: object,
    episode_number: int,
    *,
    fallback_text: str = "",
) -> AssetLanguage:
    """Resolve language from the persisted author-controlled episode text.

    Generated Beat fields are accepted only as a last-resort compatibility
    fallback for detached stores that do not expose episode source content.
    """
    content_store = getattr(store, "sqlite_store", None) or store
    episode_getter = getattr(content_store, "get_episode", None)
    if callable(episode_getter):
        episode = episode_getter(episode_number)
        if inspect.isawaitable(episode):
            episode = await episode
        if episode is not None:
            from novelvideo.sqlite_store import load_episode_planning_content

            content = await load_episode_planning_content(store, episode)
            if content.strip():
                return detect_asset_language(content)

    for candidate_store in (content_store, store):
        loader = getattr(candidate_store, "load_working_content", None)
        if not callable(loader):
            continue
        content = loader(episode_number)
        if inspect.isawaitable(content):
            content = await content
        if str(content or "").strip():
            return detect_asset_language(str(content))

    return detect_asset_language(fallback_text)

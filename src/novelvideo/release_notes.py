"""Release notes parsing for version update notifications."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Literal

from packaging.version import InvalidVersion, Version

Attention = Literal["low", "medium", "high"]

_HIGHLIGHTS_RE = re.compile(r"^user-facing highlights(?:\s*\((zh|en)\))?$", re.I)
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_BULLET_RE = re.compile(r"^\s{0,3}[-*]\s+(.+?)\s*$")
_BOLD_TITLE_RE = re.compile(r"^\*\*(.*?)\*\*\s*[:：]?\s*(.*)$")
_FRONT_MATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.S)


@dataclass(frozen=True)
class ReleaseNoteItem:
    id: str
    kind: str
    icon: str
    title: str
    body: str


@dataclass(frozen=True)
class ParsedReleaseNotes:
    items: list[ReleaseNoteItem]
    attention: Attention
    version: str | None


@dataclass(frozen=True)
class _Section:
    start_index: int
    level: int
    locale: str | None


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\r\n", "\n").replace("\r", "\n")).strip()


def _strip_trailing_heading_hashes(value: str) -> str:
    return re.sub(r"\s+#+\s*$", "", value).strip()


def _front_matter(body: str) -> dict[str, str]:
    match = _FRONT_MATTER_RE.match(body.replace("\r\n", "\n").replace("\r", "\n"))
    if not match:
        return {}
    out: dict[str, str] = {}
    for raw_line in match.group(1).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        out[key.strip().lower()] = value.strip().strip("'\"")
    return out


def _attention(body: str) -> Attention:
    value = _front_matter(body).get("attention", "").strip().lower()
    if value in {"low", "medium", "high"}:
        return value  # type: ignore[return-value]
    return "low"


def extract_version_marker(body: str) -> str | None:
    metadata = _front_matter(body)
    if metadata.get("version"):
        return metadata["version"].strip()
    in_fence = False
    fence_marker = ""
    for raw_line in body.replace("\r\n", "\n").replace("\r", "\n").splitlines():
        stripped = raw_line.strip()
        fence = re.match(r"^(```+|~~~+)", stripped)
        if fence:
            marker = fence.group(1)[:3]
            if in_fence and marker == fence_marker:
                in_fence = False
                fence_marker = ""
            elif not in_fence:
                in_fence = True
                fence_marker = marker
            continue
        if in_fence:
            continue
        match = _HEADING_RE.match(stripped)
        if match and len(match.group(1)) == 1:
            text = _strip_trailing_heading_hashes(match.group(2))
            return text[1:].strip() if text.lower().startswith("v") else text.strip()
    return None


def _versions_equal(left: str, right: str) -> bool:
    def clean(value: str) -> str:
        value = value.strip()
        return value[1:] if value.lower().startswith("v") else value

    try:
        return Version(clean(left)) == Version(clean(right))
    except InvalidVersion:
        return clean(left) == clean(right)


def validate_version_marker(body: str, expected_version: str) -> None:
    actual = extract_version_marker(body)
    if actual is None or not _versions_equal(actual, expected_version):
        raise ValueError(
            f"release notes version marker {actual!r} does not match {expected_version!r}"
        )


def _iter_highlight_sections(lines: list[str]) -> list[_Section]:
    sections: list[_Section] = []
    in_fence = False
    fence_marker = ""
    for index, raw_line in enumerate(lines):
        stripped = raw_line.strip()
        fence = re.match(r"^(```+|~~~+)", stripped)
        if fence:
            marker = fence.group(1)[:3]
            if in_fence and marker == fence_marker:
                in_fence = False
                fence_marker = ""
            elif not in_fence:
                in_fence = True
                fence_marker = marker
            continue
        if in_fence:
            continue
        heading = _HEADING_RE.match(stripped)
        if not heading:
            continue
        title = _normalize_text(_strip_trailing_heading_hashes(heading.group(2)))
        match = _HIGHLIGHTS_RE.match(title)
        if match:
            sections.append(
                _Section(
                    start_index=index + 1,
                    level=len(heading.group(1)),
                    locale=match.group(1).lower() if match.group(1) else None,
                )
            )
    return sections


def _select_section(
    sections: list[_Section],
    *,
    locale: str,
    allow_locale_fallback: bool,
) -> _Section | None:
    normalized_locale = "zh" if locale.lower().startswith("zh") else "en"
    for section in sections:
        if section.locale == normalized_locale:
            return section
    if not allow_locale_fallback:
        return None
    for section in sections:
        if section.locale in {"zh", "en"} and section.locale != normalized_locale:
            return section
    for section in sections:
        if section.locale is None:
            return section
    return None


def _split_bullet(value: str) -> tuple[str, str]:
    match = _BOLD_TITLE_RE.match(value.strip())
    if not match:
        return _normalize_text(value), ""
    title = _normalize_text(match.group(1))
    body = _normalize_text(match.group(2))
    return title, body


def _item_id(tag: str, title: str, body: str) -> str:
    digest = hashlib.sha256(f"{title}\n{body}".encode("utf-8")).hexdigest()[:8]
    return f"release:{tag}:{digest}"


def parse(
    body: str,
    tag: str | None,
    *,
    locale: str = "zh",
    allow_locale_fallback: bool = True,
) -> ParsedReleaseNotes:
    attention = _attention(body)
    version = extract_version_marker(body)
    if tag is None:
        return ParsedReleaseNotes(items=[], attention=attention, version=version)

    lines = body.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    section = _select_section(
        _iter_highlight_sections(lines),
        locale=locale,
        allow_locale_fallback=allow_locale_fallback,
    )
    if section is None:
        return ParsedReleaseNotes(items=[], attention=attention, version=version)

    items: list[ReleaseNoteItem] = []
    in_fence = False
    fence_marker = ""
    for raw_line in lines[section.start_index :]:
        stripped = raw_line.strip()
        fence = re.match(r"^(```+|~~~+)", stripped)
        if fence:
            marker = fence.group(1)[:3]
            if in_fence and marker == fence_marker:
                in_fence = False
                fence_marker = ""
            elif not in_fence:
                in_fence = True
                fence_marker = marker
            continue
        if in_fence:
            continue
        heading = _HEADING_RE.match(stripped)
        if heading and len(heading.group(1)) <= section.level:
            break
        bullet = _BULLET_RE.match(raw_line)
        if not bullet:
            continue
        title, item_body = _split_bullet(bullet.group(1))
        if not title or not title.strip(":："):
            continue
        items.append(
            ReleaseNoteItem(
                id=_item_id(tag, title, item_body),
                kind="release",
                icon="sparkles",
                title=title,
                body=item_body,
            )
        )

    return ParsedReleaseNotes(items=items, attention=attention, version=version)

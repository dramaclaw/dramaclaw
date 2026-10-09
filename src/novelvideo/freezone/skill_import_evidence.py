"""Lossless, program-owned evidence for skill import source analysis."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import re

from markdown_it import MarkdownIt


EVIDENCE_ALGORITHM_VERSION = "source-segments-v1"
MAX_SEGMENT_CHARS = 1200


@dataclass(frozen=True)
class SourceSegment:
    id: str
    start: int
    end: int
    text: str
    heading_path: list[str]


def _line_offsets(source: str) -> list[int]:
    offsets = [0]
    for line in source.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    if offsets[-1] != len(source):
        offsets.append(len(source))
    return offsets


def _split_range(source: str, start: int, end: int) -> list[tuple[int, int]]:
    pieces = []
    while end - start > MAX_SEGMENT_CHARS:
        limit = start + MAX_SEGMENT_CHARS
        window = source[start:limit]
        boundary = window.rfind("\n") + 1
        if boundary <= 0:
            sentence_ends = list(re.finditer(r"[.!?。！？](?:\s|$)", window))
            boundary = sentence_ends[-1].end() if sentence_ends else 0
        if boundary <= 0:
            spaces = list(re.finditer(r"\s+", window))
            boundary = spaces[-1].end() if spaces else 0
        if boundary <= 0:
            break
        split_at = start + boundary
        pieces.append((start, split_at))
        start = split_at
    pieces.append((start, end))
    return pieces


def segment_source(source: str) -> list[dict]:
    """Split Markdown into ordered blocks while retaining exact source slices."""
    if not source:
        return []
    parser = MarkdownIt("commonmark").enable("table")
    tokens = parser.parse(source)
    offsets = _line_offsets(source)
    blocks: list[tuple[int, int, int | None, str | None]] = []
    for index, token in enumerate(tokens):
        if token.level != 0 or token.nesting == -1 or token.map is None:
            continue
        start_line, end_line = token.map
        heading_level = None
        heading_text = None
        if token.type == "heading_open":
            heading_level = int(token.tag[1:])
            if index + 1 < len(tokens) and tokens[index + 1].type == "inline":
                heading_text = tokens[index + 1].content.strip()
        blocks.append((offsets[start_line], offsets[end_line], heading_level, heading_text))

    ranges: list[tuple[int, int, int | None, str | None]] = []
    cursor = 0
    for start, end, heading_level, heading_text in sorted(blocks):
        if start < cursor:
            continue
        if start > cursor and source[cursor:start].strip():
            ranges.append((cursor, start, None, None))
        ranges.append((start, end, heading_level, heading_text))
        cursor = end
    if cursor < len(source) and source[cursor:].strip():
        ranges.append((cursor, len(source), None, None))

    headings: list[str] = []
    raw_segments: list[tuple[int, int, list[str]]] = []
    for start, end, heading_level, heading_text in ranges:
        if heading_level is not None:
            headings = headings[: heading_level - 1]
            headings.append(heading_text or "")
        for piece_start, piece_end in _split_range(source, start, end):
            raw_segments.append((piece_start, piece_end, list(headings)))

    return [
        asdict(SourceSegment(
            id=f"S{index:04d}",
            start=start,
            end=end,
            text=source[start:end],
            heading_path=heading_path,
        ))
        for index, (start, end, heading_path) in enumerate(raw_segments, 1)
    ]


def hydrate_segment_quotes(segment_ids: list[str], segments: list[dict]) -> list[str]:
    """Resolve model-selected segment IDs to exact program-owned source text."""
    by_id = {segment["id"]: segment["text"] for segment in segments}
    unknown = [segment_id for segment_id in segment_ids if segment_id not in by_id]
    if unknown:
        raise ValueError(f"Unknown source segment ID: {unknown[0]}")
    return [by_id[segment_id] for segment_id in segment_ids]

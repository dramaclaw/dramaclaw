"""Shared chapter preview payload helpers for API routes."""

from __future__ import annotations

from pathlib import Path

from novelvideo.cognee.chapter_detector import ChapterDetector
from novelvideo.utils.document_parsers import (
    count_billable_novel_chars as _count_billable_novel_chars,
    decode_novel_bytes as _decode_novel_bytes,
)
from novelvideo.utils.document_parsers import (
    load_novel_text as _load_novel_text,
)
from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks


def decode_novel_bytes(raw: bytes) -> str:
    return _decode_novel_bytes(raw)


def load_novel_text(path: str | Path) -> str:
    return _load_novel_text(path)


def count_billable_novel_chars(text: str) -> int:
    return _count_billable_novel_chars(text)


def _find_line_position(
    content_lines: list[str],
    block_lines: list[str],
    *,
    start: int = 0,
    stop: int | None = None,
) -> int | None:
    if not block_lines:
        return None
    upper_bound = len(content_lines) if stop is None else min(stop, len(content_lines))
    first_line = block_lines[0].strip()
    return next(
        (
            index
            for index in range(start, upper_bound)
            if content_lines[index].strip() == first_line
        ),
        None,
    )


def _build_scene_block_preview(
    content: str,
) -> tuple[list[dict], tuple[int, int] | None]:
    """Return scene metadata without duplicating chapter text in the payload.

    ``content_start_line`` / ``content_end_line`` are zero-based slice offsets
    into ``chapter.content.splitlines()``.  The frontend can therefore display
    each scene from the chapter's single canonical text copy.
    """

    blocks = parse_scene_blocks(content)
    content_lines = content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    scene_blocks = [block for block in blocks if block.header_line]
    header_positions: list[int] = []
    cursor = 0
    for block in scene_blocks:
        target = block.header_line.strip()
        position = next(
            (
                index
                for index in range(cursor, len(content_lines))
                if content_lines[index].strip() == target
            ),
            len(content_lines),
        )
        header_positions.append(position)
        cursor = min(position + 1, len(content_lines))

    payload: list[dict] = []
    for index, block in enumerate(scene_blocks):
        header_position = header_positions[index]
        next_header_position = (
            header_positions[index + 1]
            if index + 1 < len(header_positions)
            else len(content_lines)
        )
        body_start = _find_line_position(
            content_lines,
            block.lines,
            start=header_position + 1,
            stop=next_header_position,
        )
        body_start = (
            next_header_position if body_start is None else body_start
        )
        payload.append(
            {
                "header": block.header_line,
                "scene_no": block.scene_no,
                "location": block.location,
                "time_of_day": block.time_of_day,
                "interior_exterior": block.interior_exterior,
                "characters": block.characters,
                "content_start_line": body_start,
                "content_end_line": next_header_position,
            }
        )

    unparsed_block = next((block for block in blocks if not block.header_line), None)
    unparsed_start = (
        _find_line_position(content_lines, unparsed_block.lines)
        if unparsed_block is not None
        else None
    )
    unparsed_range = (
        (
            unparsed_start,
            header_positions[0] if header_positions else len(content_lines),
        )
        if unparsed_start is not None
        else None
    )
    return payload, unparsed_range


def build_chapter_preview(
    novel_text: str, *, include_scene_blocks: bool = False
) -> dict:
    detector = ChapterDetector()
    chapters = detector.detect(novel_text)

    payload = []
    for chapter in chapters:
        content = getattr(chapter, "content", "") or ""
        first_line = content.splitlines()[0].strip() if content else ""
        title = getattr(chapter, "title", None) or first_line or f"第{chapter.number}章"
        chapter_payload = {
            "number": chapter.number,
            "title": title,
            "start_line": chapter.start_line,
            "end_line": chapter.end_line,
            "content": content,
            "word_count": len(content),
        }
        if include_scene_blocks:
            scene_blocks, unparsed_range = _build_scene_block_preview(content)
            chapter_payload["scene_blocks"] = scene_blocks
            if unparsed_range is not None:
                (
                    chapter_payload["unparsed_content_start_line"],
                    chapter_payload["unparsed_content_end_line"],
                ) = unparsed_range
        payload.append(chapter_payload)

    return {
        "total_chars": len(novel_text),
        "billable_chars": count_billable_novel_chars(novel_text),
        "count": len(chapters),
        "chapters": payload,
    }

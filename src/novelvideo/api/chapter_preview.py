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


def decode_novel_bytes(raw: bytes) -> str:
    return _decode_novel_bytes(raw)


def load_novel_text(path: str | Path) -> str:
    return _load_novel_text(path)


def count_billable_novel_chars(text: str) -> int:
    return _count_billable_novel_chars(text)


def build_chapter_preview(novel_text: str) -> dict:
    detector = ChapterDetector()
    chapters = detector.detect(novel_text)

    payload = []
    for chapter in chapters:
        content = getattr(chapter, "content", "") or ""
        first_line = content.splitlines()[0].strip() if content else ""
        title = getattr(chapter, "title", None) or first_line or f"第{chapter.number}章"
        payload.append(
            {
                "number": chapter.number,
                "title": title,
                "start_line": chapter.start_line,
                "end_line": chapter.end_line,
                "content": content,
                "word_count": len(content),
            }
        )

    return {
        "total_chars": len(novel_text),
        "billable_chars": count_billable_novel_chars(novel_text),
        "count": len(chapters),
        "chapters": payload,
    }

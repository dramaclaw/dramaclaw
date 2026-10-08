"""Conservative, lossless parsing: unsupported syntax is retained, never guessed.

Block IDs belong to document history, not line numbers. Unchanged blocks survive
insertions; replacements receive lineage. Markdown and plain-text projections
are derived from the same AST, including UTF-16 selection boundaries.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from difflib import SequenceMatcher
from typing import Iterator

from .schemas.common import DirectorContractError
from .schemas.documents import Block, BlockAttrs, DocumentAST, Mark, SelectionAnchor


def content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def object_hash(value: object) -> str:
    return content_hash(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )


def normalize_text(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def walk_blocks(ast: DocumentAST) -> Iterator[Block]:
    def walk(blocks: list[Block]) -> Iterator[Block]:
        for block in blocks:
            yield block
            yield from walk(block.children)

    return walk(ast.blocks)


def _marked_text(block: Block) -> str:
    text = block.text
    for mark in reversed(block.marks):
        selected = text[mark.start : mark.end]
        if mark.type == "link":
            value = f"[{selected}]({mark.href})"
        else:
            token = {"bold": "**", "italic": "*", "code": "`", "strike": "~~"}[
                mark.type
            ]
            value = f"{token}{selected}{token}"
        text = text[: mark.start] + value + text[mark.end :]
    return text


def block_markdown(block: Block) -> str:
    prefix = "#" * block.attrs.level + " " if block.attrs.level else ""
    return prefix + _marked_text(block) + ("\n" if block.attrs.line_break else "")


def render_markdown(ast: DocumentAST) -> str:
    return "".join(block_markdown(block) for block in walk_blocks(ast))


def plain_projection(ast: DocumentAST) -> str:
    return "".join(
        block.text + ("\n" if block.attrs.line_break else "")
        for block in walk_blocks(ast)
    )


def semantic_hash(ast: DocumentAST) -> str:
    # IDs, display headings and visual marks are not plot changes. Strike and
    # links remain semantic input: neither means silently deleting an event.
    def semantic_blocks(blocks: list[Block]) -> list[dict]:
        return [
            {
                "type": block.type,
                "text": block.text,
                "attrs": block.attrs.model_dump(exclude={"level", "line_break"}),
                "marks": [
                    m.model_dump() for m in block.marks if m.type in {"strike", "link"}
                ],
                "children": semantic_blocks(block.children),
            }
            for block in blocks
            if block.text or block.children
        ]

    return object_hash(semantic_blocks(ast.blocks))


def parse_markdown(text: str, previous: DocumentAST | None = None) -> DocumentAST:
    normalized = normalize_text(text)
    if previous and render_markdown(previous) == normalized:
        return previous
    if previous and any(b.children for b in walk_blocks(previous)):
        # Flattening a scene tree into line blocks would silently discard
        # structural authority. A rich editor must submit structured changes.
        raise DirectorContractError("STRUCTURED_EDIT_REQUIRED")
    if len(normalized) > 1024 * 1024:
        raise DirectorContractError("AST_TOO_LARGE")
    blocks: list[Block] = []
    fenced = False
    lines = normalized.split("\n")
    if lines[-1] == "":
        lines.pop()
    for index, body in enumerate(lines):
        line = body + (
            "\n" if index < len(lines) - 1 or normalized.endswith("\n") else ""
        )
        ending = line.endswith("\n")
        body = line[:-1] if ending else line
        heading = re.fullmatch(r"(#{1,6}) (.+)", body)
        unsupported = fenced or bool(
            re.match(r"(?:\s*```|\s*~~~|\s*[>|]|\s*[-*+] |\s*\d+[.)] |\s*<)", body)
        )
        if body.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        # Inline extensions stay intact. This is intentionally conservative:
        # publishing an unknown construct is safer than silently losing it.
        if heading and not unsupported:
            kind, body, level = "heading", heading[2], len(heading[1])
        else:
            kind, level = ("raw" if unsupported else "paragraph"), None
        marks: list[Mark] = []
        if not unsupported:
            pieces: list[str] = []
            cursor = 0
            for match in re.finditer(
                r"\*\*([^*]+)\*\*|~~([^~]+)~~|`([^`]+)`|\*([^*]+)\*", body
            ):
                pieces.append(body[cursor : match.start()])
                index = next(
                    i for i, value in enumerate(match.groups()) if value is not None
                )
                selected = match.group(index + 1)
                start = sum(len(piece) for piece in pieces)
                pieces.append(selected)
                marks.append(
                    Mark(
                        type=("bold", "strike", "code", "italic")[index],
                        start=start,
                        end=start + len(selected),
                    )
                )
                cursor = match.end()
            pieces.append(body[cursor:])
            body = "".join(pieces)
        blocks.append(
            Block(
                id=uuid.uuid4().hex,
                type=kind,
                text=body,
                marks=marks,
                attrs=BlockAttrs(
                    level=level,
                    line_break=ending,
                    parse_status="unsupported" if unsupported else "valid",
                ),
            )
        )
    if previous:
        old = list(walk_blocks(previous))
        matcher = SequenceMatcher(
            None,
            [block_markdown(b) for b in old],
            [block_markdown(b) for b in blocks],
            autojunk=False,
        )
        for op, a, b, c, d in matcher.get_opcodes():
            if op == "equal":
                # Preserve the richer structured AST where Markdown has not
                # changed. A line adapter must not erase scene/speaker IDs.
                for index, prior in zip(range(c, d), old[a:b], strict=True):
                    blocks[index] = prior.model_copy(update={"children": []})
            elif op == "replace":
                for index in range(c, d):
                    blocks[index] = blocks[index].model_copy(
                        update={"lineage": [item.id for item in old[a:b]]}
                    )
    ast = DocumentAST(blocks=blocks)
    if render_markdown(ast) != normalized:
        raise DirectorContractError("MARKDOWN_ROUNDTRIP_FAILED")
    return ast


def validate_selection(
    ast: DocumentAST, anchor: SelectionAnchor, document_id: str, version: int
) -> str:
    if anchor.document_id != document_id or anchor.version != version:
        raise DirectorContractError("STALE_SELECTION")
    raw = plain_projection(ast).encode("utf-16-le")
    start, end = anchor.start_offset * 2, anchor.end_offset * 2
    if start >= end or end > len(raw):
        raise DirectorContractError("INVALID_SELECTION_RANGE")
    try:
        selected = raw[start:end].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise DirectorContractError("SPLIT_SURROGATE") from exc
    touched: list[str] = []
    position = 0
    for block in walk_blocks(ast):
        length = len(
            (block.text + ("\n" if block.attrs.line_break else "")).encode("utf-16-le")
        )
        if position < end and position + length > start:
            touched.append(block.id)
        position += length
    if (
        touched != anchor.block_ids
        or content_hash(selected) != anchor.selected_text_hash
    ):
        raise DirectorContractError("SELECTION_HASH_MISMATCH")
    return selected

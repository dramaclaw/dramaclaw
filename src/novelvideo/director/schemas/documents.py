"""Strict document contracts keep editor drafts separate from executable inputs."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .common import ContractModel, Identifier, NonNegativeInt, PositiveInt, Sha256
from .execution import WireContract


class Mark(ContractModel):
    type: Literal["bold", "italic", "code", "strike", "link"]
    start: NonNegativeInt
    end: PositiveInt
    href: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def valid_range(self) -> Mark:
        if self.start >= self.end:
            raise ValueError("INVALID_MARK_RANGE")
        if (self.type == "link") != (self.href is not None):
            raise ValueError("INVALID_LINK_MARK")
        if self.href is not None and not self.href.startswith(
            ("https://", "http://", "#")
        ):
            raise ValueError("UNSAFE_LINK")
        return self


class BlockAttrs(ContractModel):
    level: Annotated[int, Field(ge=1, le=6)] | None = None
    line_break: bool = True
    scene_id: Identifier | None = None
    entity_id: Identifier | None = None
    speaker_id: Identifier | None = None
    location_id: Identifier | None = None
    timeline_id: Identifier | None = None
    parse_status: Literal["valid", "unsupported", "incomplete"] = "valid"


class Block(ContractModel):
    id: Identifier
    type: Literal[
        "heading",
        "paragraph",
        "scene",
        "action",
        "dialogue",
        "sound",
        "table",
        "list",
        "raw",
    ]
    text: str = Field(max_length=1024 * 1024)
    attrs: BlockAttrs = Field(default_factory=BlockAttrs)
    marks: list[Mark] = Field(default_factory=list, max_length=4096)
    children: list[Block] = Field(default_factory=list, max_length=10000)
    lineage: list[Identifier] = Field(default_factory=list, max_length=10000)

    @model_validator(mode="after")
    def check_shape(self) -> Block:
        if "\r" in self.text or "\n" in self.text:
            raise ValueError("BLOCK_TEXT_MUST_BE_SINGLE_LINE")
        if (self.type == "heading") != (self.attrs.level is not None):
            raise ValueError("HEADING_LEVEL_REQUIRED")
        if self.type == "dialogue" and not self.attrs.speaker_id:
            raise ValueError("DIALOGUE_SPEAKER_REQUIRED")
        previous_end = 0
        for mark in self.marks:
            if mark.start < previous_end or mark.end > len(self.text):
                raise ValueError("INVALID_MARK_RANGE")
            previous_end = mark.end
        return self


class DocumentAST(ContractModel):
    schema_version: Literal[2] = 2
    blocks: list[Block] = Field(max_length=10000)

    @model_validator(mode="after")
    def tree_limits(self) -> DocumentAST:
        seen: set[str] = set()
        size = 0

        def visit(blocks: list[Block], depth: int) -> None:
            nonlocal size
            if depth > 32:
                raise ValueError("AST_TOO_DEEP")
            for block in blocks:
                if block.id in seen:
                    raise ValueError("DUPLICATE_BLOCK_ID")
                seen.add(block.id)
                size += len(block.text)
                visit(block.children, depth + 1)

        visit(self.blocks, 0)
        if len(seen) > 10000 or size > 1024 * 1024:
            raise ValueError("AST_TOO_LARGE")
        return self


class VersionReference(ContractModel):
    kind: Literal["document", "artifact", "source", "spec"]
    id: Identifier
    version: PositiveInt
    hash: Sha256


class SelectionAnchor(WireContract):
    document_id: Identifier
    version: PositiveInt
    block_ids: list[Identifier] = Field(min_length=1, max_length=10000)
    start_offset: NonNegativeInt
    end_offset: PositiveInt
    encoding: Literal["utf16"]
    selected_text_hash: Sha256


class DocumentExpected(WireContract):
    work_revision: PositiveInt
    document_versions: dict[Identifier, NonNegativeInt]


class SaveDraft(WireContract):
    type: Literal["document.saveDraft"]
    document_id: Identifier
    client_draft_id: Identifier
    draft_revision: NonNegativeInt
    base_version: NonNegativeInt
    text: str = Field(max_length=1024 * 1024)


class CommitManual(WireContract):
    type: Literal["document.commitManual"]
    document_id: Identifier
    text: str = Field(max_length=1024 * 1024)


class ImportLegacy(WireContract):
    type: Literal["import.commitLegacy"]
    preview_hash: Sha256


class DecideOutlineGroups(WireContract):
    type: Literal["outline.decideGroups"]
    document_id: Identifier
    change_id: Identifier
    change_revision: PositiveInt
    group_ids: list[Identifier] = Field(min_length=1)
    decision: Literal["accept", "reject"]
    report_id: Identifier | None = None


class DocumentCommand(WireContract):
    schema_version: Literal[2]
    command_id: Identifier
    client_request_id: Identifier
    session_id: Identifier
    work_id: Identifier
    expected: DocumentExpected
    payload: Annotated[
        SaveDraft | CommitManual | ImportLegacy | DecideOutlineGroups, Field(discriminator="type")
    ]

"""A revision can replace text ranges, not execute arbitrary model instructions."""

from typing import Literal

from pydantic import Field, model_validator

from .common import ContractModel, Identifier, PositiveInt, Sha256
from .outline_source import Text
from .outline_source import OutlinePipelineContext

PATCH_CONTRACT = "outline-patch/1.0.0"
SectionKey = Literal["overview", "adaptation", "chapters", "hooks", "boundaries"]


class OutlinePatchContext(OutlinePipelineContext):
    stage: Literal["M14"]


class PatchTextBlock(ContractModel):
    type: Literal["heading", "paragraph", "list"]
    text: str
    level: int | None = Field(ge=3, le=6)
    line_break: bool

    @model_validator(mode="after")
    def safe_shape(self):
        if "\n" in self.text or "\r" in self.text:
            raise ValueError("BLOCK_TEXT_MUST_BE_SINGLE_LINE")
        if (self.type == "heading") != (self.level is not None):
            raise ValueError("HEADING_LEVEL_REQUIRED")
        return self


class OutlineHunk(ContractModel):
    id: Identifier
    section_key: SectionKey
    target_block_ids: list[Identifier] = Field(min_length=1)
    before_hash: Sha256
    after_blocks: list[PatchTextBlock]
    changed_claim_ids: list[Identifier]
    reason: Text


class ChangeSummary(ContractModel):
    text: Text
    hunk_ids: list[Identifier] = Field(min_length=1)


class OutlinePatchDraft(ContractModel):
    contract: Literal["outline-patch/1.0.0"]
    base_version: PositiveInt
    base_ast_hash: Sha256
    base_semantic_hash: Sha256
    hunks: list[OutlineHunk]
    change_summary: list[ChangeSummary]
    unresolved_requests: list[Text]

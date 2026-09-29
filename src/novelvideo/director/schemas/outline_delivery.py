"""Separate reader-facing adaptation from internal craft and host authority.

References establish where to check a statement, not whether it is true. These
contracts intentionally have no model-writable approval or audit status.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from .common import ContractModel, Identifier, Sha256

DELIVERY_CONTRACT = "adaptation-outline/3.0.0"
NonBlank = Annotated[str, Field(min_length=1, pattern=r"\S")]
SectionKey = Literal["overview", "adaptation", "chapters", "hooks", "boundaries"]


class GroundedText(ContractModel):
    text: NonBlank
    claim_ids: list[Identifier]
    event_ids: list[Identifier]
    nature: Literal["source", "interpretation", "proposed_change"]


class CraftPoint(ContractModel):
    applicability: Literal["applicable", "not_applicable", "uncertain"]
    evidence: GroundedText | None
    reason: NonBlank | None

    @model_validator(mode="after")
    def validate_applicability(self) -> Self:
        if self.applicability == "applicable":
            if self.evidence is None or self.reason is not None:
                raise ValueError("CRAFT_EVIDENCE_REQUIRED")
        elif self.reason is None:
            raise ValueError("CRAFT_UNCERTAINTY_REASON_REQUIRED")
        if self.applicability == "not_applicable" and self.evidence is not None:
            raise ValueError("INAPPLICABLE_CRAFT_CANNOT_CARRY_EVIDENCE")
        return self


class OverviewDraft(ContractModel):
    title: NonBlank
    logline: GroundedText
    synopsis: list[GroundedText] = Field(min_length=1)
    protagonist: GroundedText
    resistance: GroundedText
    emotional_curve: GroundedText


class AdaptationTreatment(ContractModel):
    approach: list[GroundedText] = Field(min_length=1)
    preserve_claim_ids: list[Identifier]
    proposed_changes: list[GroundedText]
    unresolved_claim_ids: list[Identifier]


class ChapterDraft(ContractModel):
    key: Identifier
    title: NonBlank
    episode_ids: list[Identifier] = Field(min_length=1)
    story: list[GroundedText] = Field(min_length=1)
    position: GroundedText
    must_keep_event_ids: list[Identifier]


class HookDraft(ContractModel):
    key: Identifier
    episode_id: Identifier
    image: GroundedText
    question: NonBlank


class SetupDraft(ContractModel):
    key: Identifier
    plant: GroundedText
    payoff: GroundedText | None
    open_reason: NonBlank | None

    @model_validator(mode="after")
    def validate_payoff(self) -> Self:
        if (self.payoff is None) != (self.open_reason is not None):
            raise ValueError("OUTLINE_SETUP_DISPOSITION_REQUIRED")
        return self


class EpisodeHighlight(ContractModel):
    episode_id: Identifier
    highlight: GroundedText


class HooksDraft(ContractModel):
    episode_highlights: list[EpisodeHighlight] = Field(min_length=1)
    openings: list[HookDraft]
    setups: list[SetupDraft]
    inapplicable_reason: NonBlank | None

    @model_validator(mode="after")
    def validate_empty_hooks(self) -> Self:
        if (not self.openings and not self.setups) != (
            self.inapplicable_reason is not None
        ):
            raise ValueError("OUTLINE_HOOK_DISPOSITION_REQUIRED")
        return self


class CraftNotes(ContractModel):
    causal_chain: list[Identifier]
    emotional_beats: list[GroundedText]
    resistance_kind: Literal["person", "condition", "internal", "mixed", "none"]
    opposition_strategy: CraftPoint
    actual_cost: CraftPoint
    reversal: CraftPoint
    production_risks: list[NonBlank]


class AdaptationOutlineDraft(ContractModel):
    contract: Literal["adaptation-outline/3.0.0"]
    overview: OverviewDraft
    adaptation: AdaptationTreatment
    chapters: list[ChapterDraft] = Field(min_length=1)
    hooks: HooksDraft
    boundaries: list[GroundedText] = Field(min_length=1)
    craft_notes: CraftNotes


class HostReference(ContractModel):
    id: Identifier
    text: NonBlank


class DeliveryContext(ContractModel):
    """Host-only projection input; not an extraction result or audit receipt.

    The caller must load this from frozen source/spec/decision records. A model
    response must never be passed here as authority. B02 supplies that adapter.
    """

    source_version_id: Identifier
    source_hash: Sha256
    source_label: NonBlank
    source_kind: Literal["full_text", "curated_summary"]
    claims: list[HostReference]
    events: list[HostReference]
    authorized_changes: list[HostReference]
    required_claim_ids: list[Identifier]
    required_event_ids: list[Identifier]
    unresolved_claim_ids: list[Identifier]
    opening_event_ids: list[Identifier] | None
    chapter_keys: list[Identifier]


class ParagraphBinding(ContractModel):
    path: NonBlank
    start_block_id: Identifier
    end_block_id: Identifier
    claim_ids: list[Identifier]
    event_ids: list[Identifier]
    nature: Literal["source", "interpretation", "proposed_change", "host"]
    protected: bool
    evidence_role: Literal["narrative", "commentary"] | None = None


class SectionBinding(ContractModel):
    key: SectionKey
    heading_block_id: Identifier
    block_ids: list[Identifier] = Field(min_length=1)
    paragraphs: list[ParagraphBinding]


class OutlineIndex(ContractModel):
    contract: Literal["adaptation-outline/3.0.0"]
    ast_hash: Sha256
    semantic_hash: Sha256
    source_version_id: Identifier
    source_hash: Sha256
    context_hash: Sha256
    spec_hash: Sha256
    sections: list[SectionBinding] = Field(min_length=5, max_length=5)
    protected_block_ids: list[Identifier]

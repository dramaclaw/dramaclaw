"""Review evidence cannot grant permission or replace a version-bound human decision."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .common import ContractModel, Identifier, PositiveInt, Sha256, require_unique
from .execution import WireContract

CheckId = Literal[
    "source_fidelity", "continuity", "causality", "scope", "timing", "format"
]
CHECK_IDS = ("source_fidelity", "continuity", "causality", "scope", "timing", "format")


class ReviewEvidence(ContractModel):
    input_id: str = Field(min_length=1, max_length=100)
    quote: str = Field(min_length=1, max_length=4000)
    occurrence: Annotated[int, Field(ge=1, le=1000)] = 1


class ReviewCheck(ContractModel):
    id: CheckId
    status: Literal["PASS", "FAIL", "UNKNOWN"]
    explanation: str = Field(min_length=5, max_length=4000)
    evidence: list[ReviewEvidence] = Field(max_length=20)
    suggestion: str = Field(max_length=4000)
    unresolved_critical_fact: bool = False

    @model_validator(mode="after")
    def substantive_failure(self) -> "ReviewCheck":
        if self.status != "UNKNOWN" and not self.evidence:
            raise ValueError("REVIEW_CONCLUSION_REQUIRES_EVIDENCE")
        return self


class ModelReview(ContractModel):
    schema_version: Literal[2]
    subject_hash: Sha256
    checks: list[ReviewCheck] = Field(min_length=6, max_length=6)

    @model_validator(mode="after")
    def all_checks(self) -> "ModelReview":
        if {item.id for item in self.checks} != set(CHECK_IDS):
            raise ValueError("REVIEW_CHECKS_INCOMPLETE")
        return self


class HumanCheck(WireContract):
    check_id: str = Field(min_length=1, max_length=100)
    conclusion: Literal["verified", "literary_only"]
    evidence: str = Field(min_length=10, max_length=4000)

    @model_validator(mode="after")
    def real_evidence(self) -> "HumanCheck":
        if len(self.evidence.strip()) < 10:
            raise ValueError("HUMAN_EVIDENCE_REQUIRED")
        return self


class FinalizeCommand(WireContract):
    schema_version: Literal[2]
    command_id: Identifier
    client_request_id: Identifier
    work_id: Identifier
    episode_ordinal: Annotated[int, Field(ge=1, le=100)]
    expected_work_revision: PositiveInt
    document_version: PositiveInt
    content_hash: Sha256
    report_id: Identifier
    report_hash: Sha256
    human_checks: list[HumanCheck] = Field(min_length=1, max_length=10010)

    @model_validator(mode="after")
    def unique_checks(self) -> "FinalizeCommand":
        require_unique([item.check_id for item in self.human_checks], "DUPLICATE_CHECK")
        return self

"""Model assertions cannot assign their own source identity or audit status."""

from typing import Annotated, Literal

from pydantic import Field

from .common import ContractModel, Identifier, Sha256

Text = Annotated[str, Field(min_length=1, pattern=r"\S")]
SOURCE_CONTRACT = "outline-source/1.0.0"
AUDIT_CONTRACT = "outline-source-audit/1.0.0"
REVIEW_CONTRACT = "outline-candidate-audit/1.0.0"


class SourceQuote(ContractModel):
    unit_id: Identifier
    quote: Text


class ExtractedClaim(ContractModel):
    assertion: Text
    kind: Literal["observed", "character_statement", "retrospective", "unresolved"]
    speaker: str | None
    subjects: list[Text] = Field(min_length=1)
    evidence: list[SourceQuote] = Field(min_length=1)
    critical: bool


class SourceExtraction(ContractModel):
    contract: Literal["outline-source/1.0.0"]
    read_unit_ids: list[Identifier] = Field(min_length=1)
    claims: list[ExtractedClaim] = Field(min_length=1)


class SourceObservation(ContractModel):
    assertion: Text
    evidence: list[SourceQuote] = Field(min_length=1)
    matching_claim_ids: list[Identifier]
    critical: bool


class ClaimCheck(ContractModel):
    claim_id: Identifier
    verdict: Literal["supported", "violated", "uncertain"]
    reason: Text
    evidence: list[SourceQuote] = Field(min_length=1)


class SourceAudit(ContractModel):
    contract: Literal["outline-source-audit/1.0.0"]
    read_unit_ids: list[Identifier] = Field(min_length=1)
    observations: list[SourceObservation] = Field(min_length=1)
    checks: list[ClaimCheck] = Field(min_length=1)


class CandidateFinding(ContractModel):
    assertion: Text
    candidate_quote: Text
    verdict: Literal["supported", "violated", "uncertain", "interpretation"]
    reason: Text
    source_evidence: list[SourceQuote]


class CandidateUnitReview(ContractModel):
    path: Text
    findings: list[CandidateFinding] = Field(min_length=1)


class CandidateAudit(ContractModel):
    contract: Literal["outline-candidate-audit/1.0.0"]
    units: list[CandidateUnitReview] = Field(min_length=1)
    literary_notes: list[Text]


class OutlinePipelineContext(ContractModel):
    schema_version: Literal[2]
    stage: Literal["M04", "M05", "M07", "M12"]
    mode: Literal["adaptation"]
    episode_ordinal: int = Field(ge=1)
    total_episodes: int = Field(ge=1)
    ending_type: Literal["closed", "open", "reversal", "tragic"]
    parameters_hash: Sha256

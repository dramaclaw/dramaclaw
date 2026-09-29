"""An outline opinion has no authority to approve a story or expand its brief."""

from typing import Literal

from pydantic import Field

from .common import ContractModel, Sha256
from .quality import ReviewEvidence

LITERARY_CHECKS = ("causality", "agency", "progression", "specificity", "consistency")


class OutlineFinding(ContractModel):
    id: str = Field(min_length=1, max_length=100)
    status: Literal["FULFILLED", "VIOLATED", "UNKNOWN"]
    explanation: str = Field(min_length=5, max_length=2500)
    evidence: list[ReviewEvidence] = Field(max_length=8)
    suggestion: str = Field(max_length=2500)


class OutlineReview(ContractModel):
    schema_version: Literal[2]
    subject_hash: Sha256
    checks: list[OutlineFinding] = Field(min_length=1, max_length=500)

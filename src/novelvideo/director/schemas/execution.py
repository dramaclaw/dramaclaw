"""Execution intents are narrow unions; clients cannot manufacture dispatch state."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import ConfigDict, Field, model_validator

from .common import ContractModel, Identifier, NonNegativeInt, PositiveInt, Sha256


class WireContract(ContractModel):
    model_config = ConfigDict(validate_by_name=False, populate_by_name=False)


class ExecutionExpected(WireContract):
    work_revision: PositiveInt
    document_versions: dict[Identifier, NonNegativeInt]
    capability_version: Sha256


class OutlineReviewTarget(WireContract):
    change_id: Identifier
    change_revision: PositiveInt
    accept_group_ids: list[Identifier] = Field(min_length=1)


class QuoteWriting(WireContract):
    type: Literal["cost.quote"]
    kind: Literal["outline", "characters", "scenes", "props", "episode"]
    episode_ordinal: Annotated[int, Field(ge=1, le=100)] | None = None
    instruction: str = Field(default="", max_length=10000)
    max_output_tokens: Annotated[int, Field(ge=256, le=32768)] | None = None
    purpose: Literal["draft", "review"] = "draft"
    review_target: OutlineReviewTarget | None = None

    @model_validator(mode="after")
    def episode_only(self) -> QuoteWriting:
        if self.review_target and (self.purpose != "review" or self.kind != "outline"):
            raise ValueError("OUTLINE_REVIEW_TARGET_ONLY")
        if self.purpose == "review" and (
            self.kind not in {"episode", "outline"} or self.instruction
        ):
            raise ValueError(
                "REVIEW_REQUIRES_OUTLINE_OR_EPISODE_WITHOUT_WRITER_INSTRUCTIONS"
            )
        if (self.kind == "episode") != (self.episode_ordinal is not None):
            raise ValueError("EPISODE_ORDINAL_REQUIRED_ONLY_FOR_EPISODE")
        return self


class GrantWriting(WireContract):
    type: Literal["approval.grant"]
    quote_id: Identifier
    request_hash: Sha256
    unknown_cost_consent: bool


class CancelWriting(WireContract):
    type: Literal["run.cancel"]
    run_id: Identifier


class ResumeWriting(WireContract):
    type: Literal["run.resume"]
    run_id: Identifier


ExecutionPayload = Annotated[
    QuoteWriting | GrantWriting | CancelWriting | ResumeWriting,
    Field(discriminator="type"),
]


class ExecutionCommand(WireContract):
    schema_version: Literal[2]
    command_id: Identifier
    client_request_id: Identifier
    session_id: Identifier
    work_id: Identifier
    expected: ExecutionExpected
    payload: ExecutionPayload


class ExecutionFault(Exception):
    """Public faults contain safe codes, never provider errors or prompt contents."""

    def __init__(self, code: str, *, status: int = 409, recovery: str = "refresh"):
        super().__init__(code)
        self.code = code
        self.status = status
        self.recovery = recovery

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "messageKey": f"director.execution.errors.{self.code}",
            "retryable": False,
            "recoveryAction": self.recovery,
            "sideEffects": "unknown" if self.code == "STATUS_UNKNOWN" else "none",
        }

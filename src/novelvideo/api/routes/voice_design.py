"""Voice design boundary contracts. Production routes are added by later slices."""

from typing import Annotated, Generic, Literal, TypeVar
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    StringConstraints,
    field_validator,
    model_validator,
)


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


Description = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=500),
]
PreviewText = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=15, max_length=60),
]
Language = Literal["zh", "en"]
VoiceSlot = Literal["default", "child", "youth", "middle", "elder"]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class VoiceDesignCreateRequest(ContractModel):
    request_id: UUID
    description: Description
    preview_text: PreviewText
    language: Language = "zh"


ErrorCode = Literal[
    "unauthenticated",
    "voice_design_forbidden",
    "project_not_found",
    "character_not_found",
    "candidate_not_found",
    "candidate_audio_missing",
    "idempotency_conflict",
    "candidate_not_ready",
    "slot_changed",
    "slot_occupied",
    "candidate_expired",
    "invalid_input",
    "content_rejected",
    "candidate_duration_exceeded",
    "insufficient_credits",
    "rate_limited",
    "voice_design_quota_exceeded",
    "provider_unavailable",
    "provider_bad_audio",
    "generation_unknown",
    "voice_design_unavailable",
    "candidate_persist_failed",
    "save_failed",
]
ERROR_POLICY: dict[ErrorCode, tuple[int, bool]] = {
    "unauthenticated": (401, False),
    "voice_design_forbidden": (403, False),
    "project_not_found": (404, False),
    "character_not_found": (404, False),
    "candidate_not_found": (404, False),
    "candidate_audio_missing": (404, False),
    "idempotency_conflict": (409, False),
    "candidate_not_ready": (409, True),
    "slot_changed": (409, False),
    "slot_occupied": (409, False),
    "candidate_expired": (410, False),
    "invalid_input": (422, False),
    "content_rejected": (422, False),
    "candidate_duration_exceeded": (422, False),
    "insufficient_credits": (402, False),
    "rate_limited": (429, True),
    "voice_design_quota_exceeded": (429, True),
    "provider_unavailable": (502, True),
    "provider_bad_audio": (502, True),
    "generation_unknown": (504, True),
    "voice_design_unavailable": (503, False),
    "candidate_persist_failed": (500, True),
    "save_failed": (500, True),
}


class Failure(ContractModel):
    code: ErrorCode
    message: StrictStr
    retryable: StrictBool

    @model_validator(mode="after")
    def validate_retryable(self):
        if self.retryable != ERROR_POLICY[self.code][1]:
            raise ValueError("retryable does not match error code")
        return self


class ErrorDetails(ContractModel):
    field: (
        Literal[
            "request_id",
            "description",
            "preview_text",
            "language",
            "candidate_id",
            "save_request_id",
            "expected_slot",
            "replace_existing",
            "name",
            "slot",
        ]
        | None
    ) = None
    duration_seconds: Annotated[float, Field(gt=0, allow_inf_nan=False)] | None = None
    retry_after_seconds: Annotated[int, Field(strict=True, ge=0)] | None = None


class VoiceDesignError(ContractModel):
    ok: Literal[False] = False
    error: StrictStr
    code: ErrorCode
    retryable: StrictBool
    request_id: UUID
    details: ErrorDetails | None = None

    @model_validator(mode="after")
    def validate_retryable(self):
        if self.retryable != ERROR_POLICY[self.code][1]:
            raise ValueError("retryable does not match error code")
        return self


class CandidateGenerating(ContractModel):
    candidate_id: UUID
    status: Literal["generating"]


class CandidateReady(ContractModel):
    candidate_id: UUID
    status: Literal["ready"]
    description: Description
    preview_text: PreviewText
    language: Language
    preview_url: Annotated[
        str,
        StringConstraints(
            pattern=r"^/api/v1/projects/[^/]+/voice-design/candidates/[0-9a-f-]+/audio$"
        ),
    ]
    mime_type: Literal["audio/mpeg"]
    duration_seconds: Annotated[float, Field(gt=0, le=15, allow_inf_nan=False)]
    sha256: Sha256
    created_at: AwareDatetime
    expires_at: AwareDatetime

    @model_validator(mode="after")
    def validate_media_metadata(self):
        if not self.preview_url.endswith(f"/{self.candidate_id}/audio"):
            raise ValueError("preview URL must address this candidate")
        if (
            self.created_at.utcoffset().total_seconds()
            or self.expires_at.utcoffset().total_seconds()
        ):
            raise ValueError("timestamps must be UTC")
        if self.expires_at <= self.created_at:
            raise ValueError("expiry must follow creation")
        return self


class CandidateFailed(ContractModel):
    candidate_id: UUID
    status: Literal["failed"]
    failure: Failure


class CandidateUnknown(ContractModel):
    candidate_id: UUID
    status: Literal["unknown"]
    failure: Failure


class CandidateExpired(ContractModel):
    candidate_id: UUID
    status: Literal["expired"]


Candidate = Annotated[
    CandidateGenerating
    | CandidateReady
    | CandidateFailed
    | CandidateUnknown
    | CandidateExpired,
    Field(discriminator="status"),
]
QueryableCandidate = Annotated[
    CandidateGenerating | CandidateReady | CandidateFailed | CandidateUnknown,
    Field(discriminator="status"),
]
T = TypeVar("T")


class Success(ContractModel, Generic[T]):
    ok: Literal[True] = True
    data: T


CandidateResponse = Success[QueryableCandidate]
CandidateAcceptedResponse = Success[CandidateGenerating]


class ExpectedSlot(ContractModel):
    path: StrictStr
    sha256: Annotated[str, StringConstraints(pattern=r"^(?:[0-9a-f]{64})?$")]
    updated_at: StrictStr


class SaveCharacterVoiceRequest(ContractModel):
    save_request_id: UUID
    candidate_id: UUID
    expected_slot: ExpectedSlot
    replace_existing: StrictBool = False


class SaveUserVoiceRequest(ContractModel):
    save_request_id: UUID
    candidate_id: UUID
    name: StrictStr

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        from novelvideo.freezone.audio_node import _safe_voice_name

        return _safe_voice_name(value)


class CharacterVoiceSlot(ContractModel):
    slot: VoiceSlot
    label: StrictStr
    path: StrictStr
    url: StrictStr
    sha256: StrictStr
    updated_at: StrictStr
    inherited_from_default: StrictBool
    required: StrictBool


class UserCustomVoice(ContractModel):
    voice_id: Annotated[str, StringConstraints(pattern=r"^fv_[A-Za-z0-9_-]+$")]
    scope: Literal["user_custom"]
    label: StrictStr
    name: StrictStr
    path: StrictStr
    url: StrictStr
    exists: StrictBool
    sha256: StrictStr
    duration_ms: Annotated[int, Field(ge=0, strict=True)]
    mime_type: StrictStr
    created_at: StrictStr
    updated_at: StrictStr
    source_filename: StrictStr


CharacterVoiceResponse = Success[CharacterVoiceSlot]
UserVoiceResponse = Success[UserCustomVoice]

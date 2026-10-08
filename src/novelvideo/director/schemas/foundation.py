"""Typed evidence boundaries prevent a plausible model response becoming an approval.

Only the first foundation slice is defined here. It does not expose a permissive
catch-all command endpoint, migrate legacy works, or claim semantic verification.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .common import (
    ContractModel,
    Identifier,
    NonNegativeInt,
    PositiveInt,
    Seconds,
    Sha256,
    require_unique,
)


class GenreChoice(ContractModel):
    main_id: Identifier
    fusion_id: Identifier | None = None
    custom_text: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def different_genres(self) -> GenreChoice:
        if self.main_id == self.fusion_id:
            raise ValueError("DUPLICATE_GENRE")
        return self


class SourcedChoice(ContractModel):
    ids: list[Identifier]
    custom_text: str = Field(max_length=2000)
    provenance: Literal["user", "template", "inferred"]

    @model_validator(mode="after")
    def no_duplicate_values(self) -> SourcedChoice:
        require_unique(self.ids, "DUPLICATE_CHOICE")
        return self


class VisualStyle(ContractModel):
    id: Identifier | None
    text: str = Field(max_length=2000)
    reference_asset_version: Identifier | None


class NarrativeTone(ContractModel):
    id: Identifier | None
    custom_text: str = Field(max_length=2000)
    provenance: Literal["user", "template", "inferred"]


class AdaptationSpec(ContractModel):
    strategy: Literal["condense", "expand", "conflict", "hook"]
    fidelity: Literal["strict", "approved_changes"]
    locked_fact_ids: list[Identifier]
    allowed_additions: list[str]

    @model_validator(mode="after")
    def unique_locks(self) -> AdaptationSpec:
        require_unique(self.locked_fact_ids, "DUPLICATE_FACT")
        return self


class ConfirmedSpec(ContractModel):
    schema_version: Literal[2]
    revision: PositiveInt
    mode: Literal["omni", "original", "adaptation", "directing"]
    brief: str = Field(min_length=1, max_length=20000)
    genres: GenreChoice
    audience_ids: list[Identifier] = Field(max_length=2)
    character_setup: SourcedChoice
    era: SourcedChoice
    highlights: SourcedChoice
    narrative_tone: NarrativeTone
    visual_style: VisualStyle
    structure_id: Literal[
        "three_act",
        "five_act",
        "hero",
        "parallel",
        "cross",
        "nonlinear",
        "loop",
        "unit",
    ]
    total_episodes: Annotated[int, Field(ge=1, le=100)]
    default_duration_seconds: Seconds
    episode_durations: dict[Identifier, Seconds]
    ending_type: Literal["closed", "open", "reversal", "tragic"]
    output_language: str = Field(min_length=2, max_length=32)
    market: str = Field(min_length=1, max_length=100)
    locked_facts: list[Identifier]
    adaptation: AdaptationSpec | None
    provenance: dict[Identifier, Literal["user", "template", "inferred"]]

    @model_validator(mode="after")
    def confirmed_not_guessed(self) -> ConfirmedSpec:
        if not self.brief.strip():
            raise ValueError("EMPTY_BRIEF")
        require_unique(self.audience_ids, "DUPLICATE_AUDIENCE")
        require_unique(self.locked_facts, "DUPLICATE_FACT")
        required = {field.alias for field in type(self).model_fields.values()} - {
            "schemaVersion",
            "revision",
            "provenance",
        }
        if set(self.provenance) != required:
            raise ValueError("SPEC_PROVENANCE_INCOMPLETE")
        for name in ("character_setup", "era", "highlights", "narrative_tone"):
            alias = type(self).model_fields[name].alias
            if self.provenance[alias] != getattr(self, name).provenance:
                raise ValueError("SPEC_PROVENANCE_MISMATCH")
        if (self.mode == "adaptation") != (self.adaptation is not None):
            raise ValueError("ADAPTATION_MODE_MISMATCH")
        return self


class EpisodeIdentity(ContractModel):
    id: Identifier
    work_id: Identifier
    document_id: Identifier
    ordinal: Annotated[int, Field(ge=1, le=100)]
    source_episode_label: str | None = Field(max_length=40)
    delivery_label: str = Field(min_length=1, max_length=40)


class SourceChunk(ContractModel):
    id: Identifier
    start: NonNegativeInt
    end: PositiveInt
    text_hash: Sha256
    status: Literal["pending", "succeeded", "failed"]

    @model_validator(mode="after")
    def positive_range(self) -> SourceChunk:
        if self.end <= self.start:
            raise ValueError("EMPTY_SOURCE_RANGE")
        return self


class SourceAuditInput(ContractModel):
    source_version: Identifier
    normalized_text: str = Field(min_length=1, max_length=1024 * 1024)
    chunks: list[SourceChunk] = Field(min_length=1, max_length=2048)
    extraction_run_id: Identifier
    audit_run_id: Identifier | None
    audit_completed: bool
    extracted_event_ids: list[Identifier]
    audited_critical_ids: list[Identifier]
    unresolved_critical_ids: list[Identifier]

    @model_validator(mode="after")
    def unique_evidence(self) -> SourceAuditInput:
        if not self.normalized_text.strip():
            raise ValueError("EMPTY_SOURCE_TEXT")
        for values in (
            [chunk.id for chunk in self.chunks],
            self.extracted_event_ids,
            self.audited_critical_ids,
            self.unresolved_critical_ids,
        ):
            require_unique(values, "DUPLICATE_SOURCE_EVIDENCE")
        return self


class DependencyGroup(ContractModel):
    id: Identifier
    hunk_ids: list[Identifier] = Field(min_length=1)
    target_document_ids: list[Identifier] = Field(min_length=1)
    requires_group_ids: list[Identifier]

    @model_validator(mode="after")
    def unique_members(self) -> DependencyGroup:
        require_unique(self.hunk_ids, "DUPLICATE_HUNK")
        require_unique(self.target_document_ids, "DUPLICATE_DOCUMENT")
        require_unique(self.requires_group_ids, "DUPLICATE_DEPENDENCY")
        return self


class ChangeSelection(ContractModel):
    base_versions: dict[Identifier, PositiveInt] = Field(min_length=1)
    latest_versions: dict[Identifier, PositiveInt]
    groups: list[DependencyGroup] = Field(min_length=1, max_length=2048)
    accepted_hunk_ids: list[Identifier]

    @model_validator(mode="after")
    def unique_groups(self) -> ChangeSelection:
        require_unique([g.id for g in self.groups], "DUPLICATE_GROUP")
        require_unique(
            [h for g in self.groups for h in g.hunk_ids], "HUNK_IN_MULTIPLE_GROUPS"
        )
        require_unique(self.accepted_hunk_ids, "DUPLICATE_ACCEPTANCE")
        return self


class TimeInterval(ContractModel):
    minimum: Seconds
    maximum: Seconds

    @model_validator(mode="after")
    def ordered(self) -> TimeInterval:
        if self.minimum > self.maximum:
            raise ValueError("INVALID_TIME_INTERVAL")
        return self


class TimingEvidence(ContractModel):
    document_version: PositiveInt
    semantic_hash: Sha256
    artifact_ref: Identifier
    method: Literal["speech_readthrough", "action_rehearsal", "timeline_preview"]


class Beat(ContractModel):
    id: Identifier
    track: Literal["speech", "action", "silence", "transition", "music"]
    estimate: TimeInterval | None
    timing_status: Literal["assumed", "measured", "unknown"]
    depends_on: list[Identifier]
    resources: list[Identifier]
    measurement: TimingEvidence | None = None

    @model_validator(mode="after")
    def evidence_not_guessed(self) -> Beat:
        require_unique(self.depends_on, "DUPLICATE_DEPENDENCY")
        require_unique(self.resources, "DUPLICATE_RESOURCE")
        if (self.estimate is None) != (self.timing_status == "unknown"):
            raise ValueError("TIMING_EVIDENCE_MISMATCH")
        if (self.timing_status == "measured") != (self.measurement is not None):
            raise ValueError("MEASUREMENT_EVIDENCE_REQUIRED")
        return self


class DurationInput(ContractModel):
    document_version: PositiveInt
    semantic_hash: Sha256
    target_seconds: Seconds
    beats: list[Beat] = Field(min_length=1, max_length=2048)

    @model_validator(mode="after")
    def unique_beats(self) -> DurationInput:
        require_unique([b.id for b in self.beats], "DUPLICATE_BEAT")
        return self


class ReferenceAsset(ContractModel):
    ref_id: Identifier
    kind: Literal["text", "image", "video", "audio"]
    version: PositiveInt
    content_hash: Sha256
    ready: bool


class ReferenceInput(ContractModel):
    ordered_ref_ids: list[Identifier] = Field(max_length=512)
    resolved: list[ReferenceAsset] = Field(max_length=512)

    @model_validator(mode="after")
    def unique_references(self) -> ReferenceInput:
        require_unique(self.ordered_ref_ids, "DUPLICATE_REFERENCE")
        require_unique(
            [r.ref_id for r in self.resolved], "DUPLICATE_RESOLVED_REFERENCE"
        )
        return self


class SkillBinding(ContractModel):
    skill_id: Identifier
    revision_id: Identifier
    method_hash: Sha256
    origin: Literal["system", "private", "imported", "forked"]


class SkillInvocation(ContractModel):
    run_id: Identifier
    input_snapshot_hash: Sha256
    binding: SkillBinding


class SkillRunReceipt(ContractModel):
    run_id: Identifier
    input_snapshot_hash: Sha256
    binding: SkillBinding
    output_hash: Sha256
    status: Literal["succeeded", "failed", "unavailable"]


class QuestionField(ContractModel):
    id: Identifier
    kind: Literal["single", "multi", "text"]
    required: bool
    option_ids: list[Identifier]

    @model_validator(mode="after")
    def valid_options(self) -> QuestionField:
        require_unique(self.option_ids, "DUPLICATE_OPTION")
        if (self.kind == "text") != (not self.option_ids):
            raise ValueError("QUESTION_OPTIONS_MISMATCH")
        return self


class QuestionAnswer(ContractModel):
    question_id: Identifier
    option_ids: list[Identifier]
    free_text: str = Field(max_length=10000)

    @model_validator(mode="after")
    def unique_selection(self) -> QuestionAnswer:
        require_unique(self.option_ids, "DUPLICATE_OPTION")
        return self


class QuestionCheckpoint(ContractModel):
    id: Identifier
    revision: PositiveInt
    question_version: PositiveInt
    tool_call_id: Identifier
    status: Literal["open", "answered", "skipped", "superseded"]
    resume_token: Identifier
    questions: list[QuestionField] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_questions(self) -> QuestionCheckpoint:
        require_unique([q.id for q in self.questions], "DUPLICATE_QUESTION")
        return self


class QuestionDecision(ContractModel):
    checkpoint_id: Identifier
    expected_revision: PositiveInt
    question_version: PositiveInt
    tool_call_id: Identifier
    decision: Literal["answer", "skip"]
    answers: list[QuestionAnswer]

    @model_validator(mode="after")
    def unique_answers(self) -> QuestionDecision:
        require_unique([a.question_id for a in self.answers], "DUPLICATE_ANSWER")
        if self.decision == "skip" and self.answers:
            raise ValueError("SKIP_IS_NOT_AN_ANSWER")
        return self


class ProviderAttempt(ContractModel):
    operation_id: Identifier
    request_hash: Sha256
    status: Literal[
        "approved",
        "dispatching",
        "accepted",
        "polling",
        "unknown",
        "succeeded",
        "failed",
        "cancelled",
        "ingestion_failed",
    ]
    provider_task_id: Identifier | None

    @model_validator(mode="after")
    def accepted_has_identity(self) -> ProviderAttempt:
        if (
            self.status in {"accepted", "polling", "succeeded", "ingestion_failed"}
            and self.provider_task_id is None
        ):
            raise ValueError("PROVIDER_TASK_ID_REQUIRED")
        if self.status == "approved" and self.provider_task_id is not None:
            raise ValueError("ALREADY_ACCEPTED_NOT_APPROVED")
        return self

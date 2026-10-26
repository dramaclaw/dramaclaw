"""Validated, version-one structured remix artifact contracts."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .speech_cues import SpeechCueEvidenceV1
from .source_speech import SourceSpeechObservationV1
from .candidate_speech_correction import CandidateSpeechCorrectionV1
from .production_plan import ProductionPlan
from .production_plan_v2 import ProductionPlanV2
from .reference_commission import ReferenceCommission
from .reference_analysis_service import ReferenceAnalysisV1
from .production_review import ProductionReviewV1
from .material_work import MaterialWorkPackageV1
from .material_review import MaterialReviewV1
from .reference_director import ReferenceDecisionV1
from .agent_speech_review import SpeechCorrectionPreviewV1, SpeechCorrectionReviewV1
from .production_output_review import ProductionOutputReview


class _Contract(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, populate_by_name=True)


class ArtifactReference(_Contract):
    artifact_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    revision: int = Field(ge=1)


class ReferenceEvidence(_Contract):
    media_hash: str = Field(min_length=1)
    time_base: str = Field(min_length=1)
    duration_us: int = Field(gt=0)
    cuts: list[dict[str, Any]]
    representative_frames: list[dict[str, Any]]
    transcript_ref: ArtifactReference | None = None


class BlueprintObservedFrame(_Contract):
    evidence_ref: ArtifactReference
    time_us: int = Field(ge=0)
    pts: int | None = None
    time_base: str | None = Field(default=None, min_length=1)
    url: str | None = None

    @model_validator(mode="after")
    def _require_clock_for_pts(self) -> "BlueprintObservedFrame":
        if self.pts is not None and self.time_base is None:
            raise ValueError("a frame PTS requires its source time base")
        return self


class BlueprintSpokenRange(_Contract):
    transcript_ref: ArtifactReference
    text: str
    start_us: int = Field(ge=0)
    end_us: int = Field(ge=1)
    start_char: int | None = Field(default=None, ge=0)
    end_char: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _validate_range(self) -> "BlueprintSpokenRange":
        if self.end_us <= self.start_us:
            raise ValueError("spoken range must be non-empty")
        if (self.start_char is None) != (self.end_char is None):
            raise ValueError("spoken character offsets must be paired")
        if self.start_char is not None and self.end_char <= self.start_char:
            raise ValueError("spoken character range must be non-empty")
        return self


class BlueprintModelNote(_Contract):
    visual_observation: str = ""
    visible_text: str = ""
    narrative_inference: str = ""


class BlueprintUserOverride(_Contract):
    visual_observation: str | None = None
    visible_text: str | None = None
    narrative_role: str = Field(min_length=1)
    review_state: Literal["needs_review", "reviewed", "reviewed_uncertain"]


class BlueprintEvent(_Contract):
    event_id: str = Field(min_length=1)
    start_us: int = Field(ge=0)
    end_us: int = Field(ge=1)
    observed_frame: BlueprintObservedFrame
    spoken_range: BlueprintSpokenRange | None
    model: BlueprintModelNote
    user_override: BlueprintUserOverride

    @model_validator(mode="after")
    def _validate_event_clock(self) -> "BlueprintEvent":
        if self.end_us <= self.start_us:
            raise ValueError("blueprint event must be non-empty")
        if not self.start_us <= self.observed_frame.time_us < self.end_us:
            raise ValueError("observed frame must fall inside its event")
        if self.spoken_range is not None and (
            self.spoken_range.end_us <= self.start_us
            or self.spoken_range.start_us >= self.end_us
        ):
            raise ValueError("spoken range must overlap its event")
        return self


class WordSpan(_Contract):
    text: str = Field(min_length=1)
    start_char: int = Field(ge=0)
    end_char: int = Field(ge=1)
    start_us: int = Field(ge=0)
    end_us: int = Field(ge=1)

    @model_validator(mode="after")
    def _validate_half_open_ranges(self) -> "WordSpan":
        if self.end_char <= self.start_char or self.end_us <= self.start_us:
            raise ValueError("word character and time ranges must be non-empty")
        return self


class NormalizedTextRange(_Contract):
    """One normalized comparison range mapped back to source code-point offsets."""

    text: str
    start_char: int = Field(ge=0)
    end_char: int = Field(ge=0)
    normalized_start: int = Field(ge=0)
    normalized_end: int = Field(ge=0)

    @model_validator(mode="after")
    def _validate_ranges(self) -> "NormalizedTextRange":
        if self.end_char < self.start_char or self.normalized_end < self.normalized_start:
            raise ValueError("comparison ranges must be ordered")
        return self


class SpeechDifference(_Contract):
    """A reviewable difference; ASR evidence is deliberately low confidence."""

    script_range: NormalizedTextRange
    asr_range: NormalizedTextRange
    confidence: Literal["low"] = "low"
    provenance: Literal["asr_comparison"] = "asr_comparison"


class MatchReport(_Contract):
    """Normalized ASR/script comparison without treating ASR as ground truth."""

    normalized_script: str
    normalized_asr: str
    matched_characters: int = Field(ge=0)
    script_characters: int = Field(ge=0)
    character_coverage: float = Field(ge=0, le=1)
    required_script_covered: bool
    substitutions: list[SpeechDifference]
    insertions: list[SpeechDifference]
    omissions: list[SpeechDifference]
    provenance: str = "newapi_asr_comparison"
    asr_is_ground_truth: Literal[False] = False


class SegmentSpan(_Contract):
    """A provider sentence boundary; it never outranks the timed words."""

    text: str = Field(min_length=1)
    start_us: int = Field(ge=0)
    end_us: int = Field(ge=1)

    @model_validator(mode="after")
    def _validate_range(self) -> "SegmentSpan":
        if self.end_us <= self.start_us:
            raise ValueError("recognized segment must have positive duration")
        return self


class WordTimeline(_Contract):
    schema_name: Literal["word_timeline.v1"] | None = Field(
        default=None, alias="schema"
    )
    media_ref: ArtifactReference | None = None
    media_hash: str | None = None
    script_ref: ArtifactReference | None = None
    script_revision: int | None = Field(default=None, ge=1)
    language: str = Field(min_length=1)
    status: Literal["completed", "no_speech", "script_mismatch"] = "completed"
    transcript: str | None = None
    confidence_available: bool | None = None
    words: list[WordSpan]
    segments: list[SegmentSpan] | None = None
    recognized_transcript: str | None = None
    recognized_words: list[WordSpan] | None = None
    mismatch: dict[str, Any] | None = None
    match_report: MatchReport | None = None

    @model_validator(mode="after")
    def _validate_status_and_source(self) -> "WordTimeline":
        if self.media_ref is None and not self.media_hash:
            raise ValueError("word timeline requires a media reference or hash")
        if self.status == "completed" and not self.words:
            raise ValueError("completed word timeline requires aligned words")
        if self.status != "completed" and self.words:
            raise ValueError(
                "non-completed word timeline must not publish aligned words"
            )
        if self.recognized_words and (self.status != "script_mismatch" or self.recognized_transcript is None):
            raise ValueError("raw recognition is only published with a mismatch and transcript")
        return self


class ReferenceBlueprint(_Contract):
    narrative_role: str = Field(min_length=1)
    events: list[dict[str, Any]]
    preserve_replace_rules: list[dict[str, Any]]
    observations: list[dict[str, Any]]
    inferences: list[dict[str, Any]]
    user_choices: list[dict[str, Any]]
    evidence_ref: ArtifactReference | None = None
    transcript_ref: ArtifactReference | None = None

    @model_validator(mode="after")
    def _validate_reviewable_events(self) -> "ReferenceBlueprint":
        # Artifacts written before event review shipped used a loose event
        # shape. Keep those immutable revisions readable, while every new
        # reviewable event is validated as a complete evidence link.
        for event in self.events:
            if "observed_frame" in event or "user_override" in event:
                reviewed = BlueprintEvent.model_validate(event)
                if self.evidence_ref is None or reviewed.observed_frame.evidence_ref != self.evidence_ref:
                    raise ValueError("blueprint event has a broken evidence reference")
                if reviewed.spoken_range is not None and (
                    self.transcript_ref is None
                    or reviewed.spoken_range.transcript_ref != self.transcript_ref
                ):
                    raise ValueError("blueprint event has a broken transcript reference")
        return self


class RemixReferenceBinding(_Contract):
    node_id: str = Field(min_length=1, max_length=128)
    purpose: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def _validate_content(self) -> "RemixReferenceBinding":
        if not self.node_id.strip():
            raise ValueError("reference binding node must not be blank")
        return self


class RemixSpeechRange(_Contract):
    start_char: int = Field(ge=0)
    end_char: int = Field(ge=1)

    @model_validator(mode="after")
    def _validate_range(self) -> "RemixSpeechRange":
        if self.end_char <= self.start_char:
            raise ValueError("speech range must be non-empty")
        return self


class PerformanceSegment(_Contract):
    segment_id: str = Field(min_length=1, max_length=128)
    start_char: int = Field(ge=0)
    end_char: int = Field(ge=1)
    speaker: str = Field(min_length=1, max_length=80)
    source: Literal["speaking_video", "voiceover", "original_sound"]
    speech_ranges: list[RemixSpeechRange] | None = None
    reference_bindings: list[RemixReferenceBinding] | None = None
    person_node_id: str | None = None
    product_node_id: str | None = None
    setting_node_id: str | None = None
    motion_node_id: str | None = None
    voice_node_id: str | None = None
    take_node_id: str | None = None
    take_media_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    primary_node_id: str | None = None
    primary_media_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def _validate_range(self) -> "PerformanceSegment":
        if self.end_char <= self.start_char:
            raise ValueError("performance segment range must be non-empty")
        if self.speech_ranges is not None:
            if not self.speech_ranges or self.speech_ranges[0].start_char != self.start_char or self.speech_ranges[-1].end_char != self.end_char:
                raise ValueError("speech ranges must cover the segment bounds")
            previous_end = self.start_char
            for speech_range in self.speech_ranges:
                if speech_range.start_char < previous_end or speech_range.end_char > self.end_char:
                    raise ValueError("speech ranges must be ordered inside the segment")
                previous_end = speech_range.end_char
        if self.take_media_revision and not self.take_node_id:
            raise ValueError("performance segment media revision requires a take node")
        if self.primary_media_revision and not self.primary_node_id:
            raise ValueError("performance segment primary media revision requires a node")
        if self.reference_bindings is not None:
            ids = [binding.node_id for binding in self.reference_bindings]
            if len(ids) != len(set(ids)):
                raise ValueError("duplicate reference binding node")
        return self


class RemixScript(_Contract):
    dialogue: str
    segments: list[dict[str, Any]]
    selections: list[dict[str, Any]]
    blueprint_mappings: list[dict[str, Any]]
    media_requirements: list[dict[str, Any]]

    @model_validator(mode="after")
    def _validate_segments(self) -> "RemixScript":
        if not self.segments or all("segment_id" not in segment for segment in self.segments):
            return self  # Historical remix_script.v1 scene snippets remain readable.
        if any("segment_id" not in segment for segment in self.segments):
            raise ValueError("performance segments cannot mix with legacy scene snippets")
        seen: set[str] = set()
        previous_end = 0
        normalized: list[dict[str, Any]] = []
        for raw in self.segments:
            try:
                segment = PerformanceSegment.model_validate(raw)
            except ValidationError as exc:
                raise ValueError(f"performance segment is invalid: {exc}") from exc
            if segment.segment_id in seen or segment.start_char < previous_end or segment.end_char > len(self.dialogue):
                raise ValueError("performance segments must be unique, ordered, and inside dialogue")
            seen.add(segment.segment_id)
            previous_end = segment.end_char
            normalized.append(segment.model_dump(mode="json", exclude_none=True))
        self.segments = normalized
        return self


class OutputFrameEvent(_Contract):
    event_id: str = Field(min_length=1)
    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=1)

    @model_validator(mode="after")
    def _validate_half_open_frames(self) -> "OutputFrameEvent":
        if self.end_frame <= self.start_frame:
            raise ValueError("output event frames must be non-empty")
        return self


class PerformanceTiming(_Contract):
    schema_name: Literal["performance_timing.v1"] | None = Field(
        default=None, alias="schema"
    )
    script_revision: int = Field(ge=1)
    # Older immutable timing artifacts predate this field; every new compile
    # records the exact aligned-word revision used by the runner.
    alignment_revision: int | None = Field(default=None, ge=1)
    media_hash: str = Field(min_length=1)
    fps: int = Field(gt=0)
    events: list[OutputFrameEvent]
    unresolved_required_events: list[dict[str, Any]]
    override_conflicts: list[dict[str, Any]]


class TimedTake(_Contract):
    segment_id: str = Field(min_length=1)
    source: Literal["speaking_video", "voiceover", "original_sound"]
    speaker: str = Field(min_length=1)
    media_hash: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=1)
    caption: str = Field(min_length=1)
    word_cues: list[dict[str, Any]]


class TakePerformanceTiming(_Contract):
    schema_name: Literal["performance_timing.v2"] = Field(alias="schema")
    script_revision: int = Field(ge=1)
    fps: int = Field(gt=0)
    duration_frames: int = Field(gt=0)
    takes: list[TimedTake] = Field(min_length=1)
    events: list[OutputFrameEvent]
    unresolved_required_events: list[dict[str, Any]]
    override_conflicts: list[dict[str, Any]]

    @model_validator(mode="after")
    def _validate_take_clock(self) -> "TakePerformanceTiming":
        cursor = 0
        seen: set[str] = set()
        for take in self.takes:
            if take.segment_id in seen or take.start_frame != cursor or take.end_frame <= cursor:
                raise ValueError("take timeline must be unique and contiguous")
            seen.add(take.segment_id)
            cursor = take.end_frame
        if cursor != self.duration_frames or any(event.end_frame > cursor for event in self.events):
            raise ValueError("take timeline exceeds its duration")
        return self


class CompositionManifest(_Contract):
    # Missing stays missing so persisted v1 artifacts retain byte-for-byte payloads.
    manifest_version: Literal[1, 2, 3] | None = None
    output_spec: dict[str, Any]
    media_bindings: list[dict[str, Any]]
    layers: list[dict[str, Any]]
    subtitle_events: list[dict[str, Any]]
    audio_events: list[dict[str, Any]]
    manual_overrides: list[dict[str, Any]]
    source_versions: list[dict[str, Any]]

    @model_validator(mode="after")
    def _reject_explicit_null_version(self) -> "CompositionManifest":
        if "manifest_version" in self.model_fields_set and self.manifest_version is None:
            raise ValueError("manifest_version cannot be null")
        return self


class CompositionManifestV2(_Contract):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    manifest_version: Literal[4]
    output_spec: dict[str, Any]
    media_bindings: list[dict[str, Any]]
    layers: list[dict[str, Any]]
    subtitle_events: list[dict[str, Any]]
    # Optional for manifests saved before native graphic effects were introduced.
    graphic_events: list[dict[str, Any]] | None = None
    audio_events: list[dict[str, Any]]
    manual_overrides: list[dict[str, Any]]
    source_versions: list[dict[str, Any]]


PayloadModel = (
    ReferenceEvidence
    | WordTimeline
    | ReferenceBlueprint
    | RemixScript
    | PerformanceTiming
    | TakePerformanceTiming
    | CompositionManifest
    | CompositionManifestV2
    | ProductionPlan
    | ProductionPlanV2
)

SCHEMA_MODELS: dict[str, type[PayloadModel]] = {
    "reference_commission.v1": ReferenceCommission,
    "reference_analysis.v1": ReferenceAnalysisV1,
    "production_review.v1": ProductionReviewV1,
    "material_work_package.v1": MaterialWorkPackageV1,
    "material_review.v1": MaterialReviewV1,
    "reference_decision.v1": ReferenceDecisionV1,
    "speech_correction_preview.v1": SpeechCorrectionPreviewV1,
    "speech_correction_review.v1": SpeechCorrectionReviewV1,
    "production_output_review.v1": ProductionOutputReview,
    "reference_evidence.v1": ReferenceEvidence,
    "source_speech_observation.v1": SourceSpeechObservationV1,
    "candidate_speech_correction.v1": CandidateSpeechCorrectionV1,
    "word_timeline.v1": WordTimeline,
    "reference_blueprint.v1": ReferenceBlueprint,
    "remix_script.v1": RemixScript,
    "performance_timing.v1": PerformanceTiming,
    "performance_timing.v2": TakePerformanceTiming,
    "composition_manifest.v1": CompositionManifest,
    "composition_manifest.v2": CompositionManifestV2,
    "production_plan.v1": ProductionPlan,
    "production_plan.v2": ProductionPlanV2,
    "speech_cue_evidence.v1": SpeechCueEvidenceV1,
}
SUPPORTED_SCHEMAS = frozenset(SCHEMA_MODELS)


def _same_artifact_reference(left: object, right: object) -> bool:
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    return (
        left.get("artifact_id") == right.get("artifact_id")
        and left.get("revision") == right.get("revision")
        and isinstance(left.get("artifact_id"), str)
        and bool(left.get("artifact_id"))
        and type(left.get("revision")) is int
        and left["revision"] > 0
    )


def reference_blueprint_readiness_errors(
    payload: dict[str, Any], upstream_refs: list[dict[str, Any]] | None = None
) -> list[str]:
    """Return structural and evidence-lineage blockers for script generation."""
    errors: list[str] = []
    if not isinstance(payload.get("narrative_role"), str) or not payload["narrative_role"].strip():
        errors.append("missing narrative role")
    events = payload.get("events")
    if not isinstance(events, list) or not events:
        return [*errors, "missing story events"]
    evidence_ref = payload.get("evidence_ref")
    transcript_ref = payload.get("transcript_ref")
    declared_refs = upstream_refs if upstream_refs is not None else []
    if upstream_refs is not None and not any(
        _same_artifact_reference(evidence_ref, reference) for reference in declared_refs
    ):
        errors.append("broken blueprint evidence reference")
    if transcript_ref is not None and upstream_refs is not None and not any(
        _same_artifact_reference(transcript_ref, reference) for reference in declared_refs
    ):
        errors.append("broken blueprint transcript reference")
    seen_ids: set[str] = set()
    for index, raw_event in enumerate(events, 1):
        if not isinstance(raw_event, dict):
            errors.append(f"event {index} has invalid structure")
            continue
        try:
            event = BlueprintEvent.model_validate(raw_event)
        except ValidationError:
            errors.append(f"event {index} has invalid review or evidence structure")
            continue
        if event.event_id in seen_ids:
            errors.append(f"event {index} has a duplicate id")
        seen_ids.add(event.event_id)
        frame_ref = event.observed_frame.evidence_ref.model_dump(mode="json")
        if not _same_artifact_reference(frame_ref, evidence_ref):
            errors.append(f"event {index} has a broken evidence reference")
        if event.spoken_range is not None:
            spoken_ref = event.spoken_range.transcript_ref.model_dump(mode="json")
            if not _same_artifact_reference(spoken_ref, transcript_ref):
                errors.append(f"event {index} has a broken transcript reference")
    return errors


def validate_payload(schema: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Return JSON-safe payload data after checking its declared v1 schema."""
    model = SCHEMA_MODELS.get(schema)
    if model is None:
        raise ValueError("Unsupported remix artifact schema")
    if not isinstance(payload, dict):
        raise ValueError(f"{schema} payload must be an object")
    try:
        validated = model.model_validate(payload).model_dump(
            mode="json", by_alias=True, exclude_none=True
        )
    except ValidationError as exc:
        raise ValueError(f"{schema} payload is invalid: {exc}") from exc
    if schema == "production_plan.v2":
        # Preserve an author's deliberate no-speech selection. Absence means
        # the dialogue source is unresolved; explicit null is different.
        for source_beat, saved_beat in zip(payload.get("beats", []), validated["beats"]):
            for source_turn, saved_turn in zip(source_beat.get("turns", []), saved_beat["turns"]):
                if "speech_placement_id" in source_turn and source_turn["speech_placement_id"] is None:
                    saved_turn["speech_placement_id"] = None
    if schema in {"composition_manifest.v1", "composition_manifest.v2"}:
        from .render import validate_manifest

        validate_manifest(validated)
    return validated


class RemixArtifactEnvelope(_Contract):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    schema_name: Literal[
        "reference_commission.v1",
        "reference_analysis.v1",
        "production_review.v1",
        "material_work_package.v1",
        "material_review.v1",
        "reference_decision.v1",
        "speech_correction_preview.v1",
        "speech_correction_review.v1",
        "production_output_review.v1",
        "reference_evidence.v1",
        "source_speech_observation.v1",
        "candidate_speech_correction.v1",
        "word_timeline.v1",
        "reference_blueprint.v1",
        "remix_script.v1",
        "performance_timing.v1",
        "performance_timing.v2",
        "composition_manifest.v1",
        "composition_manifest.v2",
        "production_plan.v1",
        "production_plan.v2",
        "speech_cue_evidence.v1",
    ] = Field(alias="schema")
    revision: int = Field(ge=1)
    project_id: str = Field(min_length=1)
    created_by: str
    content_hash: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    upstream_refs: list[dict[str, Any]]
    producer_version: str = Field(min_length=1)
    payload_path: str = Field(pattern=r"^[1-9][0-9]*\.payload\.json$")

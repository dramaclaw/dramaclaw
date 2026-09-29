"""Planning outputs carry decisions, not permission to mutate the work.

The host verifies shape and identity; these checks do not certify literary
quality. In particular, four different strings are not proof of four good ideas.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .common import ContractModel, Identifier, NonNegativeInt, PositiveInt, Sha256
from .execution import WireContract

Text = Annotated[str, Field(min_length=1, max_length=12000, pattern=r"\S")]


class Direction(ContractModel):
    id: Identifier
    logline: Text
    goal: Text
    obstacle: Text
    stakes: Text
    tone: Text
    difference: Text
    production_risks: list[Text]


class SpecQuestion(ContractModel):
    id: Identifier
    question: Text
    choices: list[Text] = Field(default_factory=list, max_length=6)


class DirectionSet(ContractModel):
    options: list[Direction] = Field(min_length=4, max_length=4)
    spec_questions: list[SpecQuestion] = Field(max_length=12)

    @model_validator(mode="after")
    def unique_options(self) -> DirectionSet:
        for field in ("id", "logline", "difference"):
            if (
                len({getattr(item, field).strip().casefold() for item in self.options})
                != 4
            ):
                raise ValueError("DUPLICATE_DIRECTIONS")
        if len({item.id for item in self.spec_questions}) != len(self.spec_questions):
            raise ValueError("DUPLICATE_QUESTIONS")
        return self


class StorySegment(ContractModel):
    name: Text
    episode_ids: list[Identifier] = Field(min_length=1, max_length=100)
    action: Text
    result: Text
    position: Text
    carry_in: Text
    stage_goal: Text
    main_conflict: Text
    secondary_conflicts: list[Text]
    opposition_tactic: Text
    character_arcs: list[Text] = Field(min_length=1)
    setup_ids: list[Identifier]
    information_release: Text
    cost: Text
    audience_reward: Text
    distinction: Text
    carry_out: Text


class StoryPressure(ContractModel):
    protagonist_goal: Text
    cannot_retreat: Text
    habitual_strategy: Text
    opposition: Text
    extra_pressures: list[Text]


class WatchReason(ContractModel):
    episode_id: Identifier
    reason: Text


class StoryHook(ContractModel):
    id: Identifier
    image_or_line: Text
    question: Text
    episode_id: Identifier


class StorySetup(ContractModel):
    id: Identifier
    plant: Text
    plant_episode_id: Identifier
    visible_form: Text
    payoff_episode_id: Identifier | None
    payoff: Text


class StoryReversal(ContractModel):
    id: Identifier
    episode_id: Identifier
    expectation: Text
    truth: Text
    evidence: Text
    consequence: Text


class StoryPlan(ContractModel):
    outline_version: Literal[2]
    title_candidates: list[Text] = Field(min_length=3, max_length=3)
    logline: Text
    world_rules: list[Text]
    structure_id: Identifier
    segments: list[StorySegment] = Field(min_length=1, max_length=100)
    conflicts: list[Text] = Field(min_length=1)
    arcs: list[Text]
    setups_payoffs: list[Text]
    ending: Text
    total_duration_seconds: PositiveInt
    production_risks: list[Text]
    assumptions: list[Text]
    core_highlights: list[Text] = Field(min_length=1)
    emotional_curve: Text
    synopsis: Text
    setting: Text
    protagonist: Text
    main_resistance: Text
    genre_treatment: Text
    pressure: StoryPressure
    why_watch: list[WatchReason] = Field(min_length=1, max_length=100)
    hooks: list[StoryHook] = Field(min_length=1)
    setups: list[StorySetup]
    setups_note: Text | None
    reversals: list[StoryReversal]
    reversals_note: Text | None
    creative_bans: list[Text] = Field(min_length=1)

    @model_validator(mode="after")
    def complete_outline(self) -> StoryPlan:
        for entries, note in (
            (self.setups, self.setups_note),
            (self.reversals, self.reversals_note),
        ):
            if not entries and note is None:
                raise ValueError("OUTLINE_EMPTY_SECTION_NEEDS_REASON")
        identifiers = [
            item.id
            for group in (self.hooks, self.setups, self.reversals)
            for item in group
        ]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("OUTLINE_DUPLICATE_REFERENCE_ID")
        return self


class Character(ContractModel):
    id: Identifier
    names: list[Text] = Field(min_length=1)
    appearance: Text
    motive: Text
    knowledge: Text
    voice: Text
    arc: Text
    role: Literal["protagonist", "main", "supporting"]
    setting: Text
    dramatic_function: Text
    tags: list[Text] = Field(min_length=1, max_length=8)
    speech_flaw: Text | None
    memorable_detail: Text
    pressure_response: Text
    address_rules: Text | None
    first_episode_id: Identifier
    key_episode_ids: list[Identifier] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def distinct_names_and_episodes(self) -> Character:
        for values in (self.names, self.key_episode_ids):
            if len(set(values)) != len(values):
                raise ValueError("CHARACTER_DUPLICATE_REFERENCE")
        return self


class Relation(ContractModel):
    from_id: Identifier
    to_id: Identifier
    description: Text


class Asset(ContractModel):
    id: Identifier
    name: Text
    description: Text


class CharacterDocument(ContractModel):
    character_version: Literal[2]
    characters: list[Character] = Field(min_length=1, max_length=100)
    relations: list[Relation]

    @model_validator(mode="after")
    def character_links(self) -> CharacterDocument:
        ids = [item.id for item in self.characters]
        if len(ids) != len(set(ids)):
            raise ValueError("DUPLICATE_ENTITY_ID")
        if any(
            row.from_id not in ids or row.to_id not in ids or row.from_id == row.to_id
            for row in self.relations
        ):
            raise ValueError("RELATION_ENTITY_MISSING")
        return self


class Scene(ContractModel):
    id: Identifier
    name: Text
    type: Literal["interior", "exterior", "mixed", "unknown"]
    dramatic_function: Text
    spatial_constraints: Text
    reusable_positions: Text
    key_episode_ids: list[Identifier] = Field(min_length=1, max_length=100)


class SceneDocument(ContractModel):
    scene_version: Literal[1]
    locations: list[Scene] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def distinct_locations(self) -> SceneDocument:
        ids = [item.id for item in self.locations]
        if len(ids) != len(set(ids)):
            raise ValueError("SCENE_DUPLICATE_ID")
        return self


class Prop(ContractModel):
    id: Identifier
    name: Text
    type: Text
    dramatic_function: Text
    usage_boundary: Text
    first_episode_id: Identifier
    key_episode_ids: list[Identifier] = Field(min_length=1, max_length=100)


class PropDocument(ContractModel):
    prop_version: Literal[1]
    props: list[Prop] = Field(max_length=100)
    empty_reason: Text | None

    @model_validator(mode="after")
    def distinct_props_and_honest_empty(self) -> PropDocument:
        ids = [item.id for item in self.props]
        if len(ids) != len(set(ids)):
            raise ValueError("PROP_DUPLICATE_ID")
        if (not self.props) != (self.empty_reason is not None):
            raise ValueError("PROP_EMPTY_REASON_MISMATCH")
        return self


class Bible(CharacterDocument, SceneDocument, PropDocument):
    world_rules: list[Text]

    @model_validator(mode="after")
    def identity_links(self) -> Bible:
        ids = [
            item.id
            for group in (self.characters, self.locations, self.props)
            for item in group
        ]
        if len(ids) != len(set(ids)):
            raise ValueError("DUPLICATE_ENTITY_ID")
        characters = {item.id for item in self.characters}
        if any(
            item.from_id not in characters or item.to_id not in characters
            for item in self.relations
        ):
            raise ValueError("RELATION_ENTITY_MISSING")
        return self


class DirectoryEntry(ContractModel):
    episode_id: Identifier
    order_key: PositiveInt
    delivery_label: Text
    question: Text
    actions: list[Text] = Field(min_length=1)
    result: Text
    hook: Text | None
    character_ids: list[Identifier] = Field(min_length=1)
    location_ids: list[Identifier] = Field(min_length=1)
    target_duration: PositiveInt


class EpisodeDirectory(ContractModel):
    entries: list[DirectoryEntry] = Field(min_length=1, max_length=100)


PLANNING_OUTPUTS = {
    "M03": DirectionSet,
    "M07": StoryPlan,
    "M08": Bible,
    "M09": EpisodeDirectory,
}


class PlanningMethodContext(ContractModel):
    schema_version: Literal[2]
    stage: Literal["M03", "M07", "M08", "M09"]
    mode: Literal["original"]
    episode_ordinal: Literal[1]
    total_episodes: int = Field(ge=1, le=100)
    ending_type: Literal["closed", "open", "reversal", "tragic"]
    parameters_hash: Sha256


class OutlineMethodContext(PlanningMethodContext):
    """Single-document edits share craft/schema, not the original-only workflow."""

    stage: Literal["M07"]
    mode: Literal["original", "adaptation"]


class DirectionMethodContext(PlanningMethodContext):
    """Adaptation directions change the telling, not the supplied story facts."""

    stage: Literal["M03"]
    mode: Literal["original", "adaptation"]


class CharacterMethodContext(PlanningMethodContext):
    """The same character craft serves preparation and source-grounded edits."""

    stage: Literal["M08"]
    mode: Literal["original", "adaptation"]
    document_kind: Literal["preparation", "characters", "scenes", "props"] = (
        "preparation"
    )


class WorkflowExpected(WireContract):
    work_revision: PositiveInt
    workflow_revision: NonNegativeInt
    capability_version: Sha256


class PlanningQuote(WireContract):
    type: Literal["planning.quote"]
    max_output_tokens: int | None = Field(default=None, ge=256, le=32768)
    target_scope: Literal["outline", "preparation"] = "preparation"
    source_kind: Literal["full_text", "curated_summary"] = "full_text"


class PlanningGrant(WireContract):
    type: Literal["planning.grant"]
    quote_id: Identifier
    plan_hash: Sha256
    unknown_cost_consent: bool


class PlanningDecision(WireContract):
    type: Literal["planning.decide"]
    checkpoint_id: Identifier
    resume_token: Identifier
    payload_hash: Sha256
    decision: Literal["select", "adopt", "skip", "return", "revise"]
    option_id: Identifier | None = None
    free_text: str = Field(default="", max_length=10000)
    answers: dict[Identifier, Text] = Field(default_factory=dict)
    episode_count: int | None = Field(default=None, ge=1, le=100, strict=True)
    duration_seconds: int | None = Field(default=None, ge=1, strict=True)


class PlanningControl(WireContract):
    type: Literal["planning.cancel", "planning.resume", "planning.revalidate"]


class WorkflowCommand(WireContract):
    schema_version: Literal[2]
    command_id: Identifier
    client_request_id: Identifier
    session_id: Identifier
    work_id: Identifier
    expected: WorkflowExpected
    payload: Annotated[
        PlanningQuote | PlanningGrant | PlanningDecision | PlanningControl,
        Field(discriminator="type"),
    ]

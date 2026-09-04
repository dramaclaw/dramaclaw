"""Versioned domain contracts for interactive-story Agent tools.

These models deliberately do not depend on Hermes, MCP, FastAPI, or frontend
types.  Runtime adapters and the canvas mapper must both consume this module so
the story contract stays stable when the Agent harness changes.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

EntityId = Annotated[
    str,
    Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$"),
]
CanvasId = Annotated[
    str,
    Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
]
VariableName = Annotated[
    str,
    Field(min_length=1, max_length=64, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$"),
]
ComparisonOperator = Literal[">=", "<=", "==", ">", "<"]


class StoryContractModel(BaseModel):
    """Strict base model shared by all persisted/tool-facing contracts."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class StoryCharacter(StoryContractModel):
    id: EntityId
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2_000)
    visual_description: str = Field(default="", max_length=4_000)


class StoryVariable(StoryContractModel):
    """Numeric story state."""

    name: VariableName
    label: str = Field(min_length=1, max_length=120)
    initial: int = 0
    minimum: int | None = None
    maximum: int | None = None

    @model_validator(mode="after")
    def validate_range(self) -> "StoryVariable":
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("variable minimum must not exceed maximum")
        if self.minimum is not None and self.initial < self.minimum:
            raise ValueError("variable initial must be greater than or equal to minimum")
        if self.maximum is not None and self.initial > self.maximum:
            raise ValueError("variable initial must be less than or equal to maximum")
        return self


class StoryFlag(StoryContractModel):
    """Boolean story state for facts such as whether a clue was found."""

    name: VariableName
    label: str = Field(min_length=1, max_length=120)
    initial: bool = False


class StoryMediaRef(StoryContractModel):
    source: Literal["placeholder", "imported", "generated"] = "placeholder"
    status: Literal["missing", "pending", "ready", "failed"] = "missing"
    asset_id: str | None = Field(default=None, min_length=1, max_length=256)
    url: str | None = Field(default=None, min_length=1, max_length=4_096)
    version: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def validate_ready_media(self) -> "StoryMediaRef":
        if self.source != "placeholder" and self.status == "ready" and not (self.asset_id or self.url):
            raise ValueError("ready imported/generated media requires asset_id or url")
        return self


class StoryChoiceLoop(StoryContractModel):
    """A short seamless animation shown only while a segment waits for a Choice."""

    description: str = Field(min_length=1, max_length=2_000)
    production_notes: str = Field(default="", max_length=4_000)
    media: StoryMediaRef = Field(default_factory=StoryMediaRef)


class StorySegment(StoryContractModel):
    id: EntityId
    title: str = Field(min_length=1, max_length=200)
    script: str = Field(min_length=1, max_length=20_000)
    kind: Literal["scene", "ending"] = "scene"
    ending_label: str | None = Field(default=None, min_length=1, max_length=40)
    character_ids: list[EntityId] = Field(default_factory=list, max_length=64)
    choice_time_limit_sec: int | None = Field(default=None, gt=0, le=300)
    production_notes: str = Field(default="", max_length=8_000)
    media: StoryMediaRef = Field(default_factory=StoryMediaRef)
    choice_loop: StoryChoiceLoop | None = None

    @model_validator(mode="after")
    def validate_ending(self) -> "StorySegment":
        if self.kind == "ending" and not self.ending_label:
            raise ValueError("ending segment requires ending_label")
        if self.kind == "scene" and self.ending_label is not None:
            raise ValueError("scene segment must not define ending_label")
        if len(set(self.character_ids)) != len(self.character_ids):
            raise ValueError("segment character_ids must be unique")
        return self


class StoryVariableCondition(StoryContractModel):
    kind: Literal["variable"] = "variable"
    variable: VariableName
    operator: ComparisonOperator
    value: int


class StoryVisitCondition(StoryContractModel):
    kind: Literal["visited"] = "visited"
    segment_id: EntityId
    operator: ComparisonOperator
    value: int = Field(ge=0)


class StoryFlagCondition(StoryContractModel):
    kind: Literal["flag"] = "flag"
    flag: VariableName
    value: bool


StoryConditionLeaf = Annotated[
    StoryVariableCondition | StoryVisitCondition | StoryFlagCondition,
    Field(discriminator="kind"),
]


class StoryConditionGroup(StoryContractModel):
    """Flat condition group matching the current canvas condition model."""

    kind: Literal["group"] = "group"
    join: Literal["and", "or"]
    items: list[StoryConditionLeaf] = Field(min_length=1, max_length=20)


StoryCondition = Annotated[
    StoryVariableCondition | StoryVisitCondition | StoryFlagCondition | StoryConditionGroup,
    Field(discriminator="kind"),
]


class StoryEffect(StoryContractModel):
    """Increment a numeric story variable."""

    kind: Literal["increment"] = "increment"
    variable: VariableName
    delta: int


class StorySetFlagEffect(StoryContractModel):
    kind: Literal["set_flag"] = "set_flag"
    flag: VariableName
    value: bool


StoryEffectValue = Annotated[
    StoryEffect | StorySetFlagEffect,
    Field(discriminator="kind"),
]


class StoryChoiceAnchor(StoryContractModel):
    """A proportional anchor or center-based hotspot in the source video frame."""

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float | None = Field(default=None, gt=0, le=1)
    height: float | None = Field(default=None, gt=0, le=1)
    object_label: str = Field(default="", max_length=80)

    @model_validator(mode="after")
    def validate_hotspot_bounds(self) -> "StoryChoiceAnchor":
        if (self.width is None) != (self.height is None):
            raise ValueError("hotspot width and height must be provided together")
        if self.width is not None and self.height is not None:
            if self.x - self.width / 2 < 0 or self.x + self.width / 2 > 1:
                raise ValueError("hotspot width must stay inside the source frame")
            if self.y - self.height / 2 < 0 or self.y + self.height / 2 > 1:
                raise ValueError("hotspot height must stay inside the source frame")
        return self


class StoryChoiceInteraction(StoryContractModel):
    """How a Choice is presented without coupling its branch logic to a video asset."""

    presentation: Literal["overlay", "object_anchor", "baked_video"] = "overlay"
    anchor: StoryChoiceAnchor | None = None
    ui_style: Literal["glass", "tag", "warning"] = "glass"
    motion: Literal["fade", "pop", "pulse"] = "fade"
    transition: Literal["fade", "flash", "cut"] = "fade"

    @model_validator(mode="after")
    def validate_anchor(self) -> "StoryChoiceInteraction":
        if self.presentation != "overlay" and self.anchor is None:
            raise ValueError("object_anchor and baked_video interactions require an anchor")
        if (
            self.presentation == "baked_video"
            and self.anchor is not None
            and (self.anchor.width is None or self.anchor.height is None)
        ):
            raise ValueError("baked_video interactions require hotspot width and height")
        return self


class StoryChoice(StoryContractModel):
    id: EntityId
    source_segment_id: EntityId
    target_segment_id: EntityId
    mode: Literal["visible", "automatic"] = "visible"
    text: str = Field(default="", max_length=500)
    order: int = Field(ge=0)
    condition: StoryCondition | None = None
    effects: list[StoryEffectValue] = Field(default_factory=list, max_length=20)
    # 玩家确认选择后短暂看见的剧情反馈；它不要求制作新的视频片段。
    feedback_text: str = Field(default="", max_length=500)
    interaction: StoryChoiceInteraction = Field(default_factory=StoryChoiceInteraction)
    is_default: bool = False

    @model_validator(mode="after")
    def validate_mode(self) -> "StoryChoice":
        if self.mode == "visible" and not self.text:
            raise ValueError("visible choice requires text")
        if self.mode == "automatic":
            if self.text:
                raise ValueError("automatic transition must not define choice text")
            if self.feedback_text:
                raise ValueError("automatic transition must not define player feedback")
            if self.interaction != StoryChoiceInteraction():
                raise ValueError("automatic transition must not define player interaction")
            if self.is_default:
                raise ValueError("automatic transition cannot be a timed default choice")
        return self


def _condition_leaves(condition: StoryCondition | None) -> list[StoryConditionLeaf]:
    if condition is None:
        return []
    if isinstance(condition, StoryConditionGroup):
        return condition.items
    return [condition]


class StoryDraftV2(StoryContractModel):
    """Agent-authored story graph before deterministic projection to canvas."""

    schema_version: Literal["story_draft.v2"] = "story_draft.v2"
    story_id: EntityId
    revision: int = Field(default=0, ge=0)
    title: str = Field(min_length=1, max_length=200)
    synopsis: str = Field(default="", max_length=4_000)
    start_segment_id: EntityId
    characters: list[StoryCharacter] = Field(default_factory=list, max_length=100)
    variables: list[StoryVariable] = Field(default_factory=list, max_length=100)
    flags: list[StoryFlag] = Field(default_factory=list, max_length=100)
    segments: list[StorySegment] = Field(min_length=1, max_length=2_000)
    choices: list[StoryChoice] = Field(default_factory=list, max_length=8_000)

    @model_validator(mode="after")
    def validate_references(self) -> "StoryDraftV2":
        character_ids = self._unique_values("character", [item.id for item in self.characters])
        variable_names = self._unique_values("variable", [item.name for item in self.variables])
        flag_names = self._unique_values("flag", [item.name for item in self.flags])
        if variable_names & flag_names:
            raise ValueError("variable and flag names must be unique across story state")
        segment_ids = self._unique_values("segment", [item.id for item in self.segments])
        self._unique_values("choice", [item.id for item in self.choices])

        if self.start_segment_id not in segment_ids:
            raise ValueError("start_segment_id must reference an existing segment")

        segment_by_id = {item.id: item for item in self.segments}
        for segment in self.segments:
            unknown_characters = set(segment.character_ids) - character_ids
            if unknown_characters:
                raise ValueError(
                    f"segment {segment.id!r} references unknown characters: "
                    f"{sorted(unknown_characters)!r}"
                )

        seen_orders: set[tuple[str, int]] = set()
        default_sources: set[str] = set()
        choice_sources = {choice.source_segment_id for choice in self.choices}
        for segment in self.segments:
            if segment.choice_loop is not None and segment.id not in choice_sources:
                raise ValueError(
                    f"segment {segment.id!r} defines choice_loop but has no outgoing choices"
                )
        for choice in self.choices:
            if choice.source_segment_id not in segment_ids:
                raise ValueError(f"choice {choice.id!r} has unknown source_segment_id")
            if choice.target_segment_id not in segment_ids:
                raise ValueError(f"choice {choice.id!r} has unknown target_segment_id")
            if segment_by_id[choice.source_segment_id].kind == "ending":
                raise ValueError(f"ending segment {choice.source_segment_id!r} must not have choices")

            order_key = (choice.source_segment_id, choice.order)
            if order_key in seen_orders:
                raise ValueError(
                    f"choice order {choice.order} is duplicated for source "
                    f"{choice.source_segment_id!r}"
                )
            seen_orders.add(order_key)
            if choice.is_default:
                if choice.source_segment_id in default_sources:
                    raise ValueError(
                        f"source {choice.source_segment_id!r} has more than one default choice"
                    )
                default_sources.add(choice.source_segment_id)

            for leaf in _condition_leaves(choice.condition):
                if isinstance(leaf, StoryVariableCondition) and leaf.variable not in variable_names:
                    raise ValueError(
                        f"choice {choice.id!r} condition references unknown variable "
                        f"{leaf.variable!r}"
                    )
                if isinstance(leaf, StoryFlagCondition) and leaf.flag not in flag_names:
                    raise ValueError(
                        f"choice {choice.id!r} condition references unknown flag {leaf.flag!r}"
                    )
                if isinstance(leaf, StoryVisitCondition) and leaf.segment_id not in segment_ids:
                    raise ValueError(
                        f"choice {choice.id!r} condition references unknown segment "
                        f"{leaf.segment_id!r}"
                    )
            for effect in choice.effects:
                if isinstance(effect, StoryEffect) and effect.variable not in variable_names:
                    raise ValueError(
                        f"choice {choice.id!r} effect references unknown variable "
                        f"{effect.variable!r}"
                    )
                if isinstance(effect, StorySetFlagEffect) and effect.flag not in flag_names:
                    raise ValueError(
                        f"choice {choice.id!r} effect references unknown flag {effect.flag!r}"
                    )
        return self

    @staticmethod
    def _unique_values(label: str, values: list[str]) -> set[str]:
        unique = set(values)
        if len(unique) != len(values):
            raise ValueError(f"{label} identifiers must be unique")
        return unique


class StoryMetadataChanges(StoryContractModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    synopsis: str | None = Field(default=None, max_length=4_000)

    @model_validator(mode="after")
    def require_change(self) -> "StoryMetadataChanges":
        if not self.model_fields_set:
            raise ValueError("metadata patch requires at least one field")
        return self


class StorySegmentChanges(StoryContractModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    script: str | None = Field(default=None, min_length=1, max_length=20_000)
    kind: Literal["scene", "ending"] | None = None
    ending_label: str | None = Field(default=None, min_length=1, max_length=40)
    character_ids: list[EntityId] | None = Field(default=None, max_length=64)
    choice_time_limit_sec: int | None = Field(default=None, gt=0, le=300)
    production_notes: str | None = Field(default=None, max_length=8_000)
    media: StoryMediaRef | None = None
    choice_loop: StoryChoiceLoop | None = None

    @model_validator(mode="after")
    def require_change(self) -> "StorySegmentChanges":
        if not self.model_fields_set:
            raise ValueError("segment patch requires at least one field")
        return self


class StoryChoiceChanges(StoryContractModel):
    source_segment_id: EntityId | None = None
    target_segment_id: EntityId | None = None
    mode: Literal["visible", "automatic"] | None = None
    text: str | None = Field(default=None, max_length=500)
    order: int | None = Field(default=None, ge=0)
    condition: StoryCondition | None = None
    effects: list[StoryEffectValue] | None = Field(default=None, max_length=20)
    feedback_text: str | None = Field(default=None, max_length=500)
    interaction: StoryChoiceInteraction | None = None
    is_default: bool | None = None

    @model_validator(mode="after")
    def require_change(self) -> "StoryChoiceChanges":
        if not self.model_fields_set:
            raise ValueError("choice patch requires at least one field")
        return self


class UpdateStoryMetadata(StoryContractModel):
    op: Literal["update_story_metadata"] = "update_story_metadata"
    changes: StoryMetadataChanges


class SetStoryStart(StoryContractModel):
    op: Literal["set_story_start"] = "set_story_start"
    segment_id: EntityId


class AddStorySegment(StoryContractModel):
    op: Literal["add_segment"] = "add_segment"
    segment: StorySegment


class UpdateStorySegment(StoryContractModel):
    op: Literal["update_segment"] = "update_segment"
    segment_id: EntityId
    changes: StorySegmentChanges


class RemoveStorySegment(StoryContractModel):
    op: Literal["remove_segment"] = "remove_segment"
    segment_id: EntityId


class AddStoryChoice(StoryContractModel):
    op: Literal["add_choice"] = "add_choice"
    choice: StoryChoice


class UpdateStoryChoice(StoryContractModel):
    op: Literal["update_choice"] = "update_choice"
    choice_id: EntityId
    changes: StoryChoiceChanges


class RemoveStoryChoice(StoryContractModel):
    op: Literal["remove_choice"] = "remove_choice"
    choice_id: EntityId


class UpsertStoryVariable(StoryContractModel):
    op: Literal["upsert_variable"] = "upsert_variable"
    variable: StoryVariable


class RemoveStoryVariable(StoryContractModel):
    op: Literal["remove_variable"] = "remove_variable"
    variable_name: VariableName


class UpsertStoryFlag(StoryContractModel):
    op: Literal["upsert_flag"] = "upsert_flag"
    flag: StoryFlag


class RemoveStoryFlag(StoryContractModel):
    op: Literal["remove_flag"] = "remove_flag"
    flag_name: VariableName


class UpsertStoryCharacter(StoryContractModel):
    op: Literal["upsert_character"] = "upsert_character"
    character: StoryCharacter


class RemoveStoryCharacter(StoryContractModel):
    op: Literal["remove_character"] = "remove_character"
    character_id: EntityId


StoryPatchOperation = Annotated[
    UpdateStoryMetadata
    | SetStoryStart
    | AddStorySegment
    | UpdateStorySegment
    | RemoveStorySegment
    | AddStoryChoice
    | UpdateStoryChoice
    | RemoveStoryChoice
    | UpsertStoryVariable
    | RemoveStoryVariable
    | UpsertStoryFlag
    | RemoveStoryFlag
    | UpsertStoryCharacter
    | RemoveStoryCharacter,
    Field(discriminator="op"),
]


class StoryPatchV2(StoryContractModel):
    schema_version: Literal["story_patch.v2"] = "story_patch.v2"
    canvas_id: CanvasId
    story_id: EntityId
    base_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=8, max_length=200)
    operations: list[StoryPatchOperation] = Field(min_length=1, max_length=200)


class InteractiveStoryIssue(StoryContractModel):
    severity: Literal["error", "warning", "info"]
    code: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=2_000)
    entity_type: Literal["story", "character", "variable", "segment", "choice"] = "story"
    entity_id: str | None = Field(default=None, max_length=128)
    path: str | None = Field(default=None, max_length=500)


class InteractiveStoryMutationResult(StoryContractModel):
    ok: Literal[True] = True
    canvas_id: CanvasId
    story_id: EntityId
    revision: int = Field(ge=1)
    idempotent: bool = False
    refresh_canvas: Literal[True] = True
    issues: list[InteractiveStoryIssue] = Field(default_factory=list)


class CreateInteractiveStoryRequest(StoryContractModel):
    schema_version: Literal["interactive_story_create.v2"] = "interactive_story_create.v2"
    canvas_id: CanvasId
    base_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=8, max_length=200)
    story: StoryDraftV2


class GetInteractiveStoryRequest(StoryContractModel):
    schema_version: Literal["interactive_story_get.v2"] = "interactive_story_get.v2"
    canvas_id: CanvasId
    story_id: EntityId


class ValidateInteractiveStoryRequest(StoryContractModel):
    schema_version: Literal["interactive_story_validate.v2"] = "interactive_story_validate.v2"
    canvas_id: CanvasId
    story_id: EntityId


class InteractiveStoryReadResult(StoryContractModel):
    ok: Literal[True] = True
    canvas_id: CanvasId
    story: StoryDraftV2
    issues: list[InteractiveStoryIssue] = Field(default_factory=list)


class InteractiveStoryValidationResult(StoryContractModel):
    ok: Literal[True] = True
    canvas_id: CanvasId
    story_id: EntityId
    revision: int = Field(ge=0)
    valid: bool
    issues: list[InteractiveStoryIssue] = Field(default_factory=list)


class InteractiveStoryError(StoryContractModel):
    ok: Literal[False] = False
    code: Literal[
        "invalid_story",
        "story_not_found",
        "story_already_exists",
        "story_id_conflict",
        "revision_conflict",
        "idempotency_conflict",
        "canvas_write_failed",
    ]
    message: str = Field(min_length=1, max_length=2_000)
    story_id: str | None = Field(default=None, max_length=128)
    current_revision: int | None = Field(default=None, ge=0)
    issues: list[InteractiveStoryIssue] = Field(default_factory=list)

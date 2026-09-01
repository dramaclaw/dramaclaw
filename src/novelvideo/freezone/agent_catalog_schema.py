"""Freezone agent catalog Skill and Recipe schemas."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from novelvideo.freezone.agent_catalog_security import (
    scan_agent_catalog_payload_for_unsafe_content,
)

AgentConfigKind = Literal["skills", "recipes"]
CatalogNodeScope = Literal[
    "textGeneration",
    "imageGeneration",
    "videoGeneration",
    "audioGeneration",
]
InputParameterType = Literal[
    "single_select", "multi_select", "text", "number", "boolean"
]
RecipeOutputKind = Literal["text", "image", "video", "audio"]

SAFE_AGENT_CONFIG_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")
TEXT_RECIPE_SECOND_STAGE_MARKERS = (
    "另一个 LLM",
    "下游节点提示词",
    "下游文本节点提示词",
    "将被送入下游 textGeneration",
    "让下游节点输出",
    "不是最终",
    "非最终",
    "只输出提示词",
    "只输出能指导 LLM",
    "不要自己生成最终",
    "不要自己编写",
)


class _CatalogBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _non_empty(value: str, field_name: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError(f"{field_name} must be non-empty")
    return stripped


def _validate_id(value: str) -> str:
    stripped = _non_empty(value, "id")
    if not SAFE_AGENT_CONFIG_ID.fullmatch(stripped):
        raise ValueError("invalid agent config id")
    return stripped


class AgentCatalogTriggerConfig(_CatalogBaseModel):
    keywords: list[str | dict[str, Any]] = Field(default_factory=list)
    node_scopes: list[CatalogNodeScope] = Field(default_factory=list)

    @field_validator("keywords")
    @classmethod
    def validate_keywords(
        cls, value: list[str | dict[str, Any]]
    ) -> list[str | dict[str, Any]]:
        if not value:
            raise ValueError("keywords must contain at least one item")
        return value


class AgentCatalogInputParameter(_CatalogBaseModel):
    id: str
    label: str
    type: InputParameterType
    required: bool
    default: str | int | float | bool | list[str] | None = None
    options: list[str] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def validate_parameter_id(cls, value: str) -> str:
        return _validate_id(value)

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        return _non_empty(value, "label")

    @field_validator("options")
    @classmethod
    def validate_options(cls, value: list[str]) -> list[str]:
        return [_non_empty(item, "options item") for item in value]

    @model_validator(mode="after")
    def validate_select_options(self) -> "AgentCatalogInputParameter":
        if self.type in {"single_select", "multi_select"} and not self.options:
            raise ValueError("select input_parameters must include options")
        if self.default is not None and self.type == "single_select":
            if not isinstance(self.default, str) or self.default not in self.options:
                raise ValueError("single_select default must be one of options")
        return self


class AgentCatalogPlanning(_CatalogBaseModel):
    planning_notes: str
    prompt_guide: str = ""
    conduct_rules: list[str] = Field(default_factory=list)

    @field_validator("planning_notes")
    @classmethod
    def validate_planning_notes(cls, value: str) -> str:
        return _non_empty(value, "planning.planning_notes")

    @field_validator("conduct_rules")
    @classmethod
    def validate_conduct_rules(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("planning.conduct_rules must contain at least one item")
        return [_non_empty(item, "planning.conduct_rules item") for item in value]


class AgentCatalogReviewItem(_CatalogBaseModel):
    name: str
    description: str = ""
    weight: float | int | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _non_empty(value, "name")


class AgentCatalogRatingBand(_CatalogBaseModel):
    score: int | float
    description: str

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        return _non_empty(value, "description")


class AgentCatalogEvaluation(_CatalogBaseModel):
    rating_bands: list[AgentCatalogRatingBand] = Field(default_factory=list)
    visual_review_items: list[AgentCatalogReviewItem] = Field(default_factory=list)
    text_review_items: list[AgentCatalogReviewItem] = Field(default_factory=list)
    quality_threshold: int | float
    domain_constraints: list[str] = Field(default_factory=list)

    @field_validator("rating_bands")
    @classmethod
    def validate_rating_bands(
        cls, value: list[AgentCatalogRatingBand]
    ) -> list[AgentCatalogRatingBand]:
        if not value:
            raise ValueError("evaluation.rating_bands must contain at least one item")
        return value

    @field_validator("domain_constraints")
    @classmethod
    def validate_domain_constraints(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError(
                "evaluation.domain_constraints must contain at least one item"
            )
        return [
            _non_empty(item, "evaluation.domain_constraints item") for item in value
        ]


class AgentCatalogSkillConfig(_CatalogBaseModel):
    schema_version: str = "dramaclaw.workflow-skill.v1"
    id: str
    version: str | int = "1.0.0"
    enabled: bool = True
    name: str
    description: str
    category: str
    triggers: AgentCatalogTriggerConfig
    input_parameters: list[AgentCatalogInputParameter] = Field(default_factory=list)
    allowed_recipe_ids: list[str] = Field(default_factory=list)
    planning: AgentCatalogPlanning
    evaluation: AgentCatalogEvaluation

    @field_validator("id")
    @classmethod
    def validate_skill_id(cls, value: str) -> str:
        return _validate_id(value)

    @field_validator("name", "description", "category")
    @classmethod
    def validate_required_strings(cls, value: str) -> str:
        return _non_empty(value, "required string")

    @field_validator("allowed_recipe_ids")
    @classmethod
    def validate_allowed_recipe_ids(cls, value: list[str]) -> list[str]:
        return [_validate_id(item) for item in value]

    @model_validator(mode="after")
    def validate_dynamic_contract(self) -> "AgentCatalogSkillConfig":
        if not self.allowed_recipe_ids:
            raise ValueError("dynamic skill must include allowed_recipe_ids")
        return self


class AgentCatalogRecipeConfig(_CatalogBaseModel):
    schema_version: str = "dramaclaw.recipe.v1"
    id: str
    enabled: bool = True
    version: str | int = "1.0.0"
    name: str
    description: str = ""
    output_kind: RecipeOutputKind
    action_keys: list[str]
    system_prompt: str
    must_have_items: list[str] = Field(default_factory=list)
    conflicts_with: list[str] = Field(default_factory=list)
    planning_prompt: str
    result_summary: str
    requires_source_media: bool = False
    force_enhancement: bool = False
    skip_detail_check: bool = False

    @field_validator("id")
    @classmethod
    def validate_recipe_id(cls, value: str) -> str:
        return _validate_id(value)

    @field_validator("name", "system_prompt", "planning_prompt", "result_summary")
    @classmethod
    def validate_required_strings(cls, value: str) -> str:
        return _non_empty(value, "required string")

    @field_validator("action_keys")
    @classmethod
    def validate_action_keys(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("action_keys must contain at least one item")
        return [_validate_id(item) for item in value]

    @field_validator("must_have_items")
    @classmethod
    def validate_must_have_items(cls, value: list[str]) -> list[str]:
        return [_non_empty(item, "must_have_items item") for item in value]

    @field_validator("conflicts_with")
    @classmethod
    def validate_conflicts_with(cls, value: list[str]) -> list[str]:
        return [_validate_id(item) for item in value]

    @model_validator(mode="after")
    def validate_pipeline_contract(self) -> "AgentCatalogRecipeConfig":
        if self.id in self.conflicts_with:
            raise ValueError("recipe cannot conflict with itself")
        if len(self.conflicts_with) != len(set(self.conflicts_with)):
            raise ValueError("conflicts_with must not contain duplicates")
        if self.output_kind == "text":
            contract_text = "\n".join(
                (self.system_prompt, self.planning_prompt, self.result_summary)
            )
            marker = next(
                (
                    item
                    for item in TEXT_RECIPE_SECOND_STAGE_MARKERS
                    if item in contract_text
                ),
                None,
            )
            if marker is not None:
                raise ValueError(
                    "text recipe must produce the final deliverable; "
                    f"found second-stage marker: {marker}"
                )
        return self


class AgentCatalogHiddenOverlay(_CatalogBaseModel):
    id: str
    hidden: Literal[True]

    @field_validator("id")
    @classmethod
    def validate_overlay_id(cls, value: str) -> str:
        return _validate_id(value)


def validate_agent_config_item(
    kind: AgentConfigKind | str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Validate and normalize one agent catalog Skill or Recipe item."""

    try:
        scan_agent_catalog_payload_for_unsafe_content(payload)
        if payload.get("hidden") is True:
            return AgentCatalogHiddenOverlay.model_validate(payload).model_dump(
                mode="json"
            )
        if kind == "skills":
            return AgentCatalogSkillConfig.model_validate(payload).model_dump(
                mode="json",
                exclude_none=True,
            )
        if kind == "recipes":
            return AgentCatalogRecipeConfig.model_validate(payload).model_dump(
                mode="json",
                exclude_none=True,
            )
    except ValidationError as exc:
        raise ValueError(f"invalid agent config {kind}: {exc}") from exc
    raise ValueError("invalid agent config kind")


def validate_agent_skill_config(payload: dict[str, Any]) -> dict[str, Any]:
    return validate_agent_config_item("skills", payload)


def validate_agent_recipe_config(payload: dict[str, Any]) -> dict[str, Any]:
    return validate_agent_config_item("recipes", payload)

"""Freezone community Skill Bundle schema and validation."""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from novelvideo.freezone.agent_catalog_security import (
    scan_agent_catalog_payload_for_unsafe_content,
)
from novelvideo.freezone.agent_catalog_schema import (
    SAFE_AGENT_CONFIG_ID,
    validate_agent_recipe_config,
    validate_agent_skill_config,
)

BUNDLE_SCHEMA_VERSION = "dramaclaw.skill-bundle.v1"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


class _BundleBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentBundleLicense(_BundleBaseModel):
    id: str
    text: str

    @field_validator("id", "text")
    @classmethod
    def validate_required_strings(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("legal license fields must be non-empty")
        return stripped


class AgentBundleLegal(_BundleBaseModel):
    copyright: str
    license: AgentBundleLicense
    notice: str

    @field_validator("copyright", "notice")
    @classmethod
    def validate_required_strings(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("legal fields must be non-empty")
        return stripped


class AgentSkillBundle(_BundleBaseModel):
    schema_version: str
    id: str
    name: str
    version: str
    description: str
    author: str = ""
    license: str = ""
    min_dramaclaw_version: str
    tags: list[str] = Field(default_factory=list)
    legal: AgentBundleLegal | None = None
    skill: dict[str, Any]
    recipes: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("schema_version")
    @classmethod
    def validate_schema_version(cls, value: str) -> str:
        if value != BUNDLE_SCHEMA_VERSION:
            raise ValueError(f"schema_version must equal {BUNDLE_SCHEMA_VERSION}")
        return value

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        stripped = value.strip()
        if not SAFE_AGENT_CONFIG_ID.fullmatch(stripped):
            raise ValueError("invalid Bundle id")
        return stripped

    @field_validator("name", "description", "min_dramaclaw_version")
    @classmethod
    def validate_required_strings(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("required Bundle string must be non-empty")
        return stripped

    @field_validator("version", "min_dramaclaw_version")
    @classmethod
    def validate_semver(cls, value: str) -> str:
        stripped = value.strip()
        if not SEMVER.fullmatch(stripped):
            raise ValueError("version must use major.minor.patch")
        return stripped

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if item.strip()]

    @model_validator(mode="after")
    def validate_skill_id_matches_bundle(self) -> "AgentSkillBundle":
        skill_id = str(self.skill.get("id") or "").strip()
        if skill_id and skill_id != self.id:
            raise ValueError("Bundle skill.id must match bundle id")
        return self


def normalize_agent_bundle(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize one community Skill Bundle."""

    scan_agent_catalog_payload_for_unsafe_content(payload, label="Bundle")
    try:
        bundle = AgentSkillBundle.model_validate(payload).model_dump(mode="json")
    except ValidationError as exc:
        raise ValueError(f"invalid agent Bundle: {exc}") from exc

    skill = validate_agent_skill_config(bundle["skill"])
    recipes = [validate_agent_recipe_config(recipe) for recipe in bundle["recipes"]]
    _validate_unique_ids([recipe["id"] for recipe in recipes], "Recipe")
    _validate_recipe_references(skill, recipes)
    bundle["skill"] = skill
    bundle["recipes"] = recipes
    return bundle


def parse_semver(value: str) -> tuple[int, int, int]:
    match = SEMVER.fullmatch(value.strip())
    if not match:
        raise ValueError(f"invalid semver: {value!r}")
    return tuple(int(part) for part in match.groups())


def _validate_unique_ids(ids: list[str], label: str) -> None:
    seen: set[str] = set()
    duplicates: list[str] = []
    for item_id in ids:
        if item_id in seen:
            duplicates.append(item_id)
        seen.add(item_id)
    if duplicates:
        raise ValueError(f"duplicate {label} ids: {', '.join(sorted(set(duplicates)))}")


def _validate_recipe_references(skill: dict[str, Any], recipes: list[dict[str, Any]]) -> None:
    recipe_ids = {str(recipe["id"]) for recipe in recipes}
    allowed_ids = {str(item) for item in skill.get("allowed_recipe_ids") or []}
    missing = sorted(allowed_ids - recipe_ids)
    if missing:
        raise ValueError(f"missing referenced Recipes: {', '.join(missing)}")

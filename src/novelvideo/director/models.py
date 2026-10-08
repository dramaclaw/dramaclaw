"""Typed commands keep visible TV Director choices identical to persisted inputs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

DirectorMode = Literal["original", "adaptation"]
AdaptDirection = Literal["condense", "expand", "conflict", "hook"]
DocumentKey = Literal["outline", "characters", "scenes", "props", "episode"]


class DirectorPreset(BaseModel):
    mode: DirectorMode
    primary_genre: str = Field(default="", max_length=100)
    fusion_genre: str = Field(default="", max_length=100)
    audience: str = Field(default="", max_length=200)
    characters: str = Field(default="", max_length=500)
    era: str = Field(default="", max_length=200)
    highlights: str = Field(default="", max_length=1000)
    visual_style: str = Field(default="", max_length=200)
    narrative_tone: str = Field(default="", max_length=2000)
    ending_type: Literal["closed", "open", "reversal", "tragic"] = "closed"
    output_language: str = Field(default="zh-CN", min_length=2, max_length=32)
    market: str = Field(default="unspecified", min_length=1, max_length=100)
    fidelity: Literal["strict", "approved_changes"] = "strict"
    locked_facts: str = Field(default="", max_length=10000)
    allowed_additions: str = Field(default="", max_length=5000)
    model_name: str = Field(default="", max_length=120)
    structure: Literal[
        "three_act",
        "five_act",
        "hero",
        "parallel",
        "cross",
        "nonlinear",
        "loop",
        "unit",
        "four_act",
        "custom",
    ] = "three_act"
    episode_count: int = Field(default=1, ge=1, le=100)
    # Duration belongs to the user's specification, not a short-form template.
    duration_seconds: int = Field(default=120, ge=1, strict=True)
    adapt_direction: AdaptDirection | None = None
    source_episode_label: str = Field(default="", max_length=40)
    delivery_episode_label: str = Field(default="", max_length=40)

    @model_validator(mode="after")
    def validate_choices(self) -> DirectorPreset:
        if self.fusion_genre and self.fusion_genre == self.primary_genre:
            raise ValueError("primary_genre and fusion_genre must differ")
        if self.mode == "adaptation" and self.adapt_direction is None:
            raise ValueError("adapt_direction is required for adaptation")
        if self.mode == "original" and self.adapt_direction is not None:
            raise ValueError("adapt_direction is only valid for adaptation")
        if self.source_episode_label and not self.delivery_episode_label:
            self.delivery_episode_label = self.source_episode_label
        return self


class CreateWork(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    brief: str = Field(default="", max_length=20000)
    source_text: str = Field(default="", max_length=1024 * 1024)
    preset: DirectorPreset

    @model_validator(mode="after")
    def validate_source(self) -> CreateWork:
        if self.preset.mode == "adaptation" and not self.source_text.strip():
            raise ValueError("source_text is required for adaptation")
        if not self.brief.strip() and not self.source_text.strip():
            raise ValueError("brief or source_text is required")
        return self


class UpdateWork(CreateWork):
    expected_revision: int = Field(ge=1)


class HistoryCommand(BaseModel):
    model_config = {"extra": "forbid", "strict": True}
    command_id: str = Field(min_length=16, max_length=128)
    expected_revision: int = Field(ge=1)
    action: Literal["rename", "archive", "restore"]
    title: str = Field(default="", max_length=160)

    @model_validator(mode="after")
    def validate_title(self) -> HistoryCommand:
        if self.action == "rename" and not self.title.strip():
            raise ValueError("title is required")
        if self.action != "rename" and self.title:
            raise ValueError("title is only valid for rename")
        return self


class PutDocument(BaseModel):
    expected_version: int = Field(ge=0)
    content: str = Field(max_length=1024 * 1024)


class ProposeChange(BaseModel):
    doc_key: str = Field(min_length=1, max_length=32)
    expected_version: int = Field(ge=0)
    content: str = Field(max_length=1024 * 1024)
    reason: str = Field(default="", max_length=2000)


class GenerateDraft(BaseModel):
    kind: DocumentKey
    episode_ordinal: int | None = Field(default=None, ge=1, le=100)
    instruction: str = Field(default="", max_length=10000)
    expected_version: int = Field(ge=0)
    expected_input_sha256: str | None = Field(
        default=None, min_length=64, max_length=64
    )
    acknowledge_model_cost: bool = False


class FinalizeEpisode(BaseModel):
    episode_ordinal: int = Field(ge=1, le=100)
    expected_version: int = Field(ge=1)
    quality_acknowledged: bool = False


def document_key(kind: DocumentKey, episode_ordinal: int | None = None) -> str:
    if kind == "episode":
        if episode_ordinal is None:
            raise ValueError("episode_ordinal is required for episode")
        return f"episode-{episode_ordinal:03d}"
    if episode_ordinal is not None:
        raise ValueError("episode_ordinal is only valid for episode")
    return kind

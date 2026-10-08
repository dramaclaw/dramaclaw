"""Explicit impact approval keeps legacy settings edits from erasing story history.

SettingsPreset is a strict camel-case boundary adapter, not the full future
ConfirmedSpec. The persisted snapshot labels that distinction explicitly.
"""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from ..models import DirectorPreset
from .common import Identifier, PositiveInt, Sha256, require_unique
from .execution import WireContract


class SettingsPreset(DirectorPreset):
    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        alias_generator=to_camel,
        validate_by_name=False,
        populate_by_name=False,
    )


class SettingsCandidate(WireContract):
    title: str = Field(min_length=1, max_length=160)
    brief: str = Field(max_length=20000)
    preset: SettingsPreset

    @model_validator(mode="after")
    def meaningful_title(self):
        if not self.title.strip():
            raise ValueError("EMPTY_TITLE")
        return self


class PreviewSettings(WireContract):
    type: Literal["settings.preview"]
    candidate: SettingsCandidate


class PreviewReopen(WireContract):
    type: Literal["episode.reopenPreview"]
    episode_ordinal: Annotated[int, Field(ge=1, le=100)]


class RevisionPreviewCommand(WireContract):
    schema_version: Literal[2]
    work_id: Identifier
    expected_work_revision: PositiveInt
    payload: Annotated[PreviewSettings | PreviewReopen, Field(discriminator="type")]


class CommitRevision(WireContract):
    schema_version: Literal[2]
    command_id: Identifier
    client_request_id: Identifier
    work_id: Identifier
    preview_id: Identifier
    preview_hash: Sha256
    archive_episode_ids: list[Identifier] = Field(max_length=100)
    reason: str = Field(min_length=10, max_length=2000)

    @model_validator(mode="after")
    def explicit_reason(self):
        require_unique(self.archive_episode_ids, "DUPLICATE_EPISODE")
        if len("".join(self.reason.split())) < 10:
            raise ValueError("REVISION_REASON_REQUIRED")
        return self

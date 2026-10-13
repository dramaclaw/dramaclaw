"""Runtime-neutral contracts for Agent-authored interactive stories."""

from novelvideo.interactive_story.models import (
    ConfirmInteractiveStoryStagesRequest,
    CreateInteractiveStoryRequest,
    GetInteractiveStoryRequest,
    InteractiveStoryError,
    InteractiveStoryIssue,
    InteractiveStoryMutationResult,
    InteractiveStoryProgressResult,
    InteractiveStoryReadResult,
    InteractiveStoryStage,
    InteractiveStoryStageConfirmationResult,
    InteractiveStoryStageEvidence,
    InteractiveStoryValidationResult,
    StoryDraftV2,
    StoryPatchV2,
    ValidateInteractiveStoryRequest,
)
from novelvideo.interactive_story.service import (
    InteractiveStoryService,
    InteractiveStoryServiceError,
)

__all__ = [
    "ConfirmInteractiveStoryStagesRequest",
    "CreateInteractiveStoryRequest",
    "GetInteractiveStoryRequest",
    "InteractiveStoryError",
    "InteractiveStoryIssue",
    "InteractiveStoryMutationResult",
    "InteractiveStoryProgressResult",
    "InteractiveStoryReadResult",
    "InteractiveStoryService",
    "InteractiveStoryServiceError",
    "InteractiveStoryStage",
    "InteractiveStoryStageConfirmationResult",
    "InteractiveStoryStageEvidence",
    "InteractiveStoryValidationResult",
    "StoryDraftV2",
    "StoryPatchV2",
    "ValidateInteractiveStoryRequest",
]

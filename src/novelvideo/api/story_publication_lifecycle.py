"""Publication-specific hooks for the existing project lifecycle routes."""

from fastapi import HTTPException

from novelvideo.interactive_story.publication import PublicationError
from novelvideo.interactive_story.publication_storage import (
    set_project_status_and_unlist,
    detach_project_publications,
)


async def set_project_status_with_publications(ctx, registry, status):
    try:
        return await set_project_status_and_unlist(
            ctx.project_id, ctx.state_dir, registry, status
        )
    except PublicationError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from exc


async def detach_project_with_publications(
    record, detach, restore, *, validate, **kwargs
):
    try:
        return await detach_project_publications(
            record, detach, restore, validate=validate, **kwargs
        )
    except PublicationError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from exc

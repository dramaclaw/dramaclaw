"""Queue submission facade for project_id based tasks."""

from __future__ import annotations

from typing import Any

from novelvideo.ports import get_task_backend
from novelvideo.ports.tasks import QueuedTask
from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskState


async def enqueue_project_task(
    ctx: ProjectContext,
    *,
    task_type: str,
    product_surface: str,
    queue_kind: str = "default",
    episode: int = 0,
    beat_num: int | None = None,
    scope: str | None = None,
    payload: dict[str, Any] | None = None,
) -> QueuedTask:
    return await get_task_backend().enqueue_project_task(
        ctx,
        task_type=task_type,
        product_surface=product_surface,
        queue_kind=queue_kind,
        episode=episode,
        beat_num=beat_num,
        scope=scope,
        payload=payload,
    )


async def cancel_project_task(
    ctx: ProjectContext,
    task_state: TaskState,
    *,
    force: bool = False,
    acknowledge_no_refund: bool = False,
) -> dict[str, Any]:
    return await get_task_backend().cancel_project_task(
        ctx,
        task_state,
        force=force,
        acknowledge_no_refund=acknowledge_no_refund,
    )

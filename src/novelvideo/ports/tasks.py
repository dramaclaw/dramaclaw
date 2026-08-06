"""Task backend and cancellation ports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class QueuedTask:
    task_state: Any
    backend: str
    queue: str | None = None
    celery_id: str | None = None


def display_metadata_for_task(task_type: str, payload: dict[str, Any] | None) -> dict[str, str]:
    if not payload:
        return {}
    metadata: dict[str, str] = {}

    for key in (
        "display_name",
        "task_label",
        "task_family",
        "source_label",
        "target_label",
        "canvas_id",
        "node_id",
        "skill_id",
    ):
        value = str(payload.get(key) or "").strip()
        if value:
            metadata[key] = value

    if task_type == "stage_asset":
        for key in ("scene_name", "step"):
            value = str(payload.get(key) or "").strip()
            if value:
                metadata[key] = value
    return metadata


def cancel_key(
    *,
    project_id: str,
    task_type: str,
    episode: int,
    task_id: str,
    beat_num: int | None = None,
    scope: str | None = None,
) -> str:
    parts = ["task", "cancel", project_id, task_type, str(episode)]
    if beat_num is not None:
        parts.append(str(beat_num))
    if scope:
        parts.append(str(scope))
    parts.append(str(task_id))
    return ":".join(parts)


class TaskBackend(Protocol):
    async def enqueue_project_task(
        self,
        ctx,
        *,
        task_type: str,
        product_surface: str,
        queue_kind: str = "default",
        episode: int = 0,
        beat_num: int | None = None,
        scope: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> QueuedTask: ...

    async def cancel_project_task(
        self,
        ctx,
        task_state,
        *,
        force: bool = False,
        acknowledge_no_refund: bool = False,
    ) -> dict[str, Any]: ...


class CancellationStore(Protocol):
    async def request_cancel(
        self,
        *,
        project_id: str,
        task_type: str,
        episode: int,
        task_id: str,
        beat_num: int | None = None,
        scope: str | None = None,
        ttl_seconds: int = 86_400,
    ) -> None: ...

    async def is_cancel_requested(
        self,
        *,
        project_id: str,
        task_type: str,
        episode: int,
        task_id: str,
        beat_num: int | None = None,
        scope: str | None = None,
    ) -> bool: ...

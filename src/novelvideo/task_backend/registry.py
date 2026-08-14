"""Task runner registry shared by backend adapters."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from novelvideo.task_backend.queues import normalize_queue_kind

ProjectTaskRunner = Callable[[dict[str, Any], Any], dict[str, Any] | None]


@dataclass(frozen=True)
class ProjectTaskPlacement:
    """Where a task type may run, declared once where its runner is registered.

    Routing and the guards have to read the same source, otherwise "the router
    thinks it may float, the guard still rejects it" becomes two truths. This
    is that source.
    """

    requires_home_node: bool = True
    lane: str | None = None


_PROJECT_TASK_RUNNERS: dict[str, ProjectTaskRunner] = {}
_PROJECT_TASK_PLACEMENTS: dict[str, ProjectTaskPlacement] = {}


def register_project_task_runner(
    task_type: str,
    runner: ProjectTaskRunner,
    *,
    requires_home_node: bool = True,
    lane: str | None = None,
) -> None:
    """Register a runner and, optionally, where it is allowed to run.

    Both placement parameters are keyword-only and default to today's
    behaviour, so every existing registration site keeps its exact meaning:
    home-node bound, no lane of its own.

    A declared lane goes through ``normalize_queue_kind``, which rejects
    unknown lanes rather than folding them into ``default`` — a registry that
    accepted a misspelled lane would be a poisoned source.
    """
    normalized_lane = None if lane is None else normalize_queue_kind(lane)
    _PROJECT_TASK_RUNNERS[task_type] = runner
    _PROJECT_TASK_PLACEMENTS[task_type] = ProjectTaskPlacement(
        requires_home_node=requires_home_node,
        lane=normalized_lane,
    )


def get_project_task_runner(task_type: str) -> ProjectTaskRunner | None:
    return _PROJECT_TASK_RUNNERS.get(task_type)


def registered_project_task_types() -> tuple[str, ...]:
    return tuple(sorted(_PROJECT_TASK_RUNNERS))


def project_task_requires_home_node(task_type: str) -> bool:
    """Whether this task type must run on the project home node.

    An unknown task type reads as bound. It should not happen, and if it does
    the answer that keeps today's behaviour is "check it", not "wave it through".
    """
    placement = _PROJECT_TASK_PLACEMENTS.get(task_type)
    if placement is None:
        return True
    return placement.requires_home_node


def project_task_lane(task_type: str) -> str | None:
    """The lane this task type declared, or ``None`` when it declared none."""
    placement = _PROJECT_TASK_PLACEMENTS.get(task_type)
    if placement is None:
        return None
    return placement.lane

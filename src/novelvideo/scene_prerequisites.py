"""Canonical prerequisites for building and planning scenes.

Both write the same rows. ``build_scenes_structured`` inserts base scenes and,
since the placeholder repair, rewrites ``environment_prompt`` on existing ones;
``AssetCompiler._compile_scenes`` reads the catalogue and then inserts derived
scenes and time plates into it. Run at once they are two writers over one table
with no ordering between them, and the outcome depends on which happened to get
there first — the builder can see a row the planner just created and skip it as
existing, or the planner can plan against a catalogue that is still half
written.

What is guaranteed is that the two never enter their business logic at the
same time, in either scheduling order. Which one survives is a preference, not
a guarantee:

* planning refuses whenever a build is *active*, queued included;
* a build refuses only when planning is actually *running*.

So a build submitted against a queued planner usually proceeds and the planner
is turned away with something actionable, rather than both being turned away —
which is what deciding both directions on "is the other active" would do.

It is a preference because the check runs inside each task, after the backend
has already marked it running. Two tasks that reach that point together can
each see the other running and both refuse. The window is narrow, nothing is
written, and the fix is to retry. Making a winner certain would need an atomic
project-level lock or unified admission, which is a lot of machinery for a
case whose failure mode is already "try again".
"""

from __future__ import annotations

from typing import Any

SCENE_CATALOG_BUILDING_CODE = "SCENE_CATALOG_BUILDING"
SCENE_CATALOG_BUILDING_MESSAGE = "场景正在构建，请完成后再规划场景"

SCENE_PLANNING_RUNNING_CODE = "SCENE_PLANNING_RUNNING"
# Project-wide: the planner holding the build back may be another episode's.
SCENE_PLANNING_RUNNING_MESSAGE = "有分集场景正在规划，请完成后再构建场景"

# The planner task type, named here rather than imported, so this module stays
# free of the task backend and can be used from both the API and the runners.
EPISODE_SCENE_PLANNER_TASK = "episode_scene_planner"


class ScenePlanningPrerequisiteError(ValueError):
    """Base class for user-actionable scene planning prerequisites."""

    error_code = "SCENE_PLANNING_PREREQUISITE"


class SceneCatalogBuildingError(ScenePlanningPrerequisiteError):
    error_code = SCENE_CATALOG_BUILDING_CODE

    def __init__(self) -> None:
        super().__init__(SCENE_CATALOG_BUILDING_MESSAGE)


class ScenePlanningRunningError(ScenePlanningPrerequisiteError):
    """Raised when a scene build would land on top of a running planner."""

    error_code = SCENE_PLANNING_RUNNING_CODE

    def __init__(self) -> None:
        super().__init__(SCENE_PLANNING_RUNNING_MESSAGE)


def scene_prerequisite_response(
    error: ScenePlanningPrerequisiteError,
) -> dict[str, str | bool]:
    return {
        "ok": False,
        "code": error.error_code,
        "error": str(error),
    }


def running_scene_planner(tasks: Any) -> bool:
    """Whether an episode scene planner is past the starting line.

    Any episode's planner counts: they all write the one project-wide scenes
    table, so the conflict is not per episode.

    Only ``running`` counts. A queued planner yields to the build instead, so a
    build arriving against a queued planner is not turned away for nothing.
    """
    for task in tasks or ():
        if (
            getattr(task, "task_type", "") == EPISODE_SCENE_PLANNER_TASK
            and getattr(task, "status", "") == "running"
        ):
            return True
    return False

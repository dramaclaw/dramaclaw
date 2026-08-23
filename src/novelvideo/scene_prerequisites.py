"""Canonical prerequisites for building and planning scenes.

Both write the same rows. ``build_scenes_structured`` inserts base scenes and,
since the placeholder repair, rewrites ``environment_prompt`` on existing ones;
``AssetCompiler._compile_scenes`` reads the catalogue and then inserts derived
scenes and time plates into it. Run at once they are two writers over one table
with no ordering between them, and the outcome depends on which happened to get
there first — the builder can see a row the planner just created and skip it as
existing, or the planner can plan against a catalogue that is still half
written.

The exclusion is mutual, but not symmetric, and the asymmetry is the point.
Deciding both directions by "is the other one active" would let two requests
that arrive together reject each other, leaving the user with nothing running
and no explanation. So the build wins:

* planning refuses whenever a build is *active*, queued included;
* a build refuses only when planning is actually *running*.

Two simultaneous requests therefore resolve one way: the build proceeds, the
planner is turned away with something to do about it. A planner already past
the starting line keeps the build out until it finishes, which is short.
"""

from __future__ import annotations

from typing import Any

SCENE_CATALOG_BUILDING_CODE = "SCENE_CATALOG_BUILDING"
SCENE_CATALOG_BUILDING_MESSAGE = "场景正在构建，请完成后再规划场景"

SCENE_PLANNING_RUNNING_CODE = "SCENE_PLANNING_RUNNING"
SCENE_PLANNING_RUNNING_MESSAGE = "本集场景正在规划，请完成后再构建场景"

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

    Only ``running`` counts. A queued planner yields to the build instead, which
    is what keeps two simultaneous requests from turning each other away.
    """
    for task in tasks or ():
        if (
            getattr(task, "task_type", "") == EPISODE_SCENE_PLANNER_TASK
            and getattr(task, "status", "") == "running"
        ):
            return True
    return False

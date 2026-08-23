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

SCENE_BUILD_NOT_APPLICABLE_CODE = "SCENE_BUILD_NOT_APPLICABLE"
SCENE_BUILD_NOT_APPLICABLE_MESSAGE = "解说剧场景将在分集规划时按需生成，无需提前构建"

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


class SceneBuildNotApplicableError(ScenePlanningPrerequisiteError):
    """Raised when a project's format has nothing to build a catalogue from.

    A screenplay names every location in its scene headings, so a full-text pass
    produces a reusable catalogue. Narrated prose has no equivalent marker — the
    same room is "公司", "那家公司", "郑氏集团的办公室" — so a full-text sweep
    would be guessing, and the build defers to per-episode planning, where the
    question is scoped to one chapter.

    The runner already returns that as a no-op result. This exists because a
    no-op is not free: enqueueing reserves a feature credit before the runner is
    ever reached, and a successful no-op confirms the charge. The user pays for
    a build that made no model call and produced no scene. So the answer has to
    come before the queue, not from inside it.
    """

    error_code = SCENE_BUILD_NOT_APPLICABLE_CODE

    def __init__(self) -> None:
        super().__init__(SCENE_BUILD_NOT_APPLICABLE_MESSAGE)


def scene_build_applies(state_dir: str, spine_template: str) -> bool:
    """Whether a project-level scene build can produce anything.

    Only structured narrated projects are excluded. Legacy projects keep the
    Cognee path whatever their template, because their build does reach a model
    and does produce scenes — changing that would change what existing projects
    do.
    """
    from novelvideo.knowledge_pipeline import is_structured_pipeline

    if not is_structured_pipeline(state_dir):
        return True
    return str(spine_template or "").strip() != "narrated"


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

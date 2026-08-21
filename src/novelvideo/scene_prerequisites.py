"""Canonical prerequisites for episode scene planning."""

from __future__ import annotations

SCENE_CATALOG_BUILDING_CODE = "SCENE_CATALOG_BUILDING"
SCENE_CATALOG_BUILDING_MESSAGE = "场景正在构建，请完成后再规划场景"


class ScenePlanningPrerequisiteError(ValueError):
    """Base class for user-actionable scene planning prerequisites."""

    error_code = "SCENE_PLANNING_PREREQUISITE"


class SceneCatalogBuildingError(ScenePlanningPrerequisiteError):
    error_code = SCENE_CATALOG_BUILDING_CODE

    def __init__(self) -> None:
        super().__init__(SCENE_CATALOG_BUILDING_MESSAGE)


def scene_prerequisite_response(
    error: ScenePlanningPrerequisiteError,
) -> dict[str, str | bool]:
    return {
        "ok": False,
        "code": error.error_code,
        "error": str(error),
    }

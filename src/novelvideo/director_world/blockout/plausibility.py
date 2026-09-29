"""Deterministic plausibility checks on a SceneIR, in the DSL frame.

Vision models that write absolute coordinates tend to produce floating, sunken
or intersecting objects. There is no renderer on the backend, so there is no
render-and-compare loop; these checks are the cheap substitute.

errors    contradict the scene's own conventions. The model gets them back and
          retries.
warnings  look odd but may be intended (a lamp hanging from the ceiling). They
          are recorded and returned to the user, and never trigger a retry.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from novelvideo.director_world.blockout.scene_ir import SceneIR, SolidIR

FLOOR_TOLERANCE_METERS = 0.01
SUPPORT_TOLERANCE_METERS = 0.05
MIN_IN_VIEW_RATIO = 0.5
VIEW_MARGIN = 1.1
HEAVY_OVERLAP_RATIO = 0.5
DEFAULT_IMAGE_ASPECT = 16 / 9


@dataclass(frozen=True)
class PlausibilityReport:
    errors: tuple[str, ...]
    warnings: tuple[str, ...]


def _half_extents(solid: SolidIR) -> tuple[float, float]:
    angle = math.radians(solid.rotation_y)
    cos, sin = abs(math.cos(angle)), abs(math.sin(angle))
    return (
        (cos * solid.size[0] + sin * solid.size[2]) / 2.0,
        (sin * solid.size[0] + cos * solid.size[2]) / 2.0,
    )


def _bounds(solid: SolidIR) -> tuple[float, float, float, float, float, float]:
    half_x, half_z = _half_extents(solid)
    x, y, z = solid.position
    return (x - half_x, x + half_x, y, y + solid.size[1], z - half_z, z + half_z)


def _normalise(vector: tuple[float, float, float]) -> tuple[float, float, float]:
    length = math.sqrt(sum(component * component for component in vector))
    return (vector[0] / length, vector[1] / length, vector[2] / length)


def _dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _in_view_count(scene: SceneIR, image_aspect: float) -> int:
    camera = scene.camera
    forward = _normalise(
        (
            camera.target[0] - camera.position[0],
            camera.target[1] - camera.position[1],
            camera.target[2] - camera.position[2],
        )
    )
    if math.hypot(forward[0], forward[2]) < 1e-9:
        right = (1.0, 0.0, 0.0)
    else:
        right = _normalise((forward[2], 0.0, -forward[0]))
    lift = _dot((0.0, 1.0, 0.0), forward)
    up_raw = (-lift * forward[0], 1.0 - lift * forward[1], -lift * forward[2])
    up = (
        (0.0, 0.0, 1.0)
        if math.sqrt(_dot(up_raw, up_raw)) < 1e-9
        else _normalise(up_raw)
    )
    tan_horizontal = math.tan(math.radians(camera.fov) / 2.0)
    tan_vertical = tan_horizontal / image_aspect
    count = 0
    for solid in scene.solids:
        offset = (
            solid.position[0] - camera.position[0],
            solid.position[1] + solid.size[1] / 2.0 - camera.position[1],
            solid.position[2] - camera.position[2],
        )
        depth = _dot(offset, forward)
        if depth <= SUPPORT_TOLERANCE_METERS:
            continue
        if abs(_dot(offset, right)) > depth * tan_horizontal * VIEW_MARGIN:
            continue
        if abs(_dot(offset, up)) > depth * tan_vertical * VIEW_MARGIN:
            continue
        count += 1
    return count


def _is_supported(solid: SolidIR, others: tuple[SolidIR, ...]) -> bool:
    x, bottom, z = solid.position
    for other in others:
        if other.id == solid.id:
            continue
        min_x, max_x, _, top, min_z, max_z = _bounds(other)
        if (
            abs(top - bottom) <= SUPPORT_TOLERANCE_METERS
            and min_x <= x <= max_x
            and min_z <= z <= max_z
        ):
            return True
    return False


def _overlap_ratio(a: SolidIR, b: SolidIR) -> float:
    bounds_a, bounds_b = _bounds(a), _bounds(b)
    volume = 1.0
    for axis in range(3):
        low = max(bounds_a[axis * 2], bounds_b[axis * 2])
        high = min(bounds_a[axis * 2 + 1], bounds_b[axis * 2 + 1])
        if high <= low:
            return 0.0
        volume *= high - low
    smaller = min(
        math.prod(
            bounds[axis * 2 + 1] - bounds[axis * 2] for axis in range(3)
        )
        for bounds in (bounds_a, bounds_b)
    )
    return volume / smaller


def check_plausibility(
    scene: SceneIR, *, image_aspect: float = DEFAULT_IMAGE_ASPECT
) -> PlausibilityReport:
    errors: list[str] = []
    warnings: list[str] = []
    camera = scene.camera

    if camera.target[2] <= camera.position[2]:
        errors.append(
            f"camera '{camera.id}' looks toward -z, but z is forward, away from the "
            f"reference camera: target.z ({camera.target[2]:g}) must be greater "
            f"than position.z ({camera.position[2]:g})"
        )
    if camera.position[1] <= 0:
        errors.append(
            f"camera '{camera.id}' is at or below the floor: "
            f"position.y = {camera.position[1]:g}"
        )
    for solid in scene.solids:
        if solid.position[1] < -FLOOR_TOLERANCE_METERS:
            errors.append(
                f"'{solid.id}' is below the floor: position.y = "
                f"{solid.position[1]:g}; position.y is the height of the bottom "
                "face and 0 means standing on the floor"
            )
    if scene.solids and not errors:
        visible = _in_view_count(scene, image_aspect)
        if visible < len(scene.solids) * MIN_IN_VIEW_RATIO:
            errors.append(
                f"only {visible} of {len(scene.solids)} objects are inside the "
                "reference camera's view; the image shows them all, so the camera "
                "position, target and fov are inconsistent with the object positions"
            )

    for solid in scene.solids:
        if solid.position[1] > SUPPORT_TOLERANCE_METERS and not _is_supported(
            solid, scene.solids
        ):
            warnings.append(
                f"'{solid.id}' floats {solid.position[1]:g} m above the floor "
                "with nothing under it"
            )
        if scene.floors and not any(
            abs(solid.position[0] - floor.center[0]) <= floor.size[0] / 2.0
            and abs(solid.position[2] - floor.center[1]) <= floor.size[1] / 2.0
            for floor in scene.floors
        ):
            warnings.append(f"'{solid.id}' stands outside every floor")
    for index, first in enumerate(scene.solids):
        for second in scene.solids[index + 1 :]:
            ratio = _overlap_ratio(first, second)
            if ratio > HEAVY_OVERLAP_RATIO:
                warnings.append(
                    f"'{first.id}' and '{second.id}' overlap by "
                    f"{round(ratio * 100)}% of the smaller one"
                )
    return PlausibilityReport(errors=tuple(errors), warnings=tuple(warnings))

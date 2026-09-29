"""Deterministic plausibility checks on a SceneIR, in the DSL frame.

Vision models that write absolute coordinates tend to produce floating, sunken
or intersecting objects. There is no renderer on the backend, so there is no
render-and-compare loop; these checks are the cheap substitute.

errors    contradict the scene's own conventions. The model gets them back and
          retries.
warnings  look odd but may be intended (a lamp hanging from the ceiling). They
          are recorded and returned to the user, and never trigger a retry.
          A piece that rests on another or hangs on a wall is not floating.

A `scene.room` is open toward the reference camera and closed on the other
three sides, so the picture can only have been taken from between its side
walls and in front of its back wall. A camera anywhere else looks at the back
of a wall, which is an error.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from novelvideo.director_world.blockout.scene_ir import SceneIR, SolidIR, WallIR

FLOOR_TOLERANCE_METERS = 0.01
SUPPORT_TOLERANCE_METERS = 0.05
WALL_TOLERANCE_METERS = 0.1
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
    """Something ends where this begins, and the two footprints overlap.

    Overlap rather than "under the centre": a table top rests on two legs,
    neither of which is under its middle.
    """
    min_x, max_x, bottom, _, min_z, max_z = _bounds(solid)
    for other in others:
        if other.id == solid.id:
            continue
        other_min_x, other_max_x, _, top, other_min_z, other_max_z = _bounds(other)
        if (
            abs(top - bottom) <= SUPPORT_TOLERANCE_METERS
            and min_x < other_max_x
            and other_min_x < max_x
            and min_z < other_max_z
            and other_min_z < max_z
        ):
            return True
    return False


def _hangs_on_a_wall(solid: SolidIR, walls: tuple[WallIR, ...]) -> bool:
    """The footprint touches a wall face below the top of that wall."""
    min_x, max_x, bottom, _, min_z, max_z = _bounds(solid)
    corners = ((min_x, min_z), (min_x, max_z), (max_x, min_z), (max_x, max_z))
    for wall in walls:
        if bottom >= wall.height:
            continue
        run_x = wall.end[0] - wall.start[0]
        run_z = wall.end[1] - wall.start[1]
        length = math.hypot(run_x, run_z)
        unit_x, unit_z = run_x / length, run_z / length
        along = [
            (x - wall.start[0]) * unit_x + (z - wall.start[1]) * unit_z
            for x, z in corners
        ]
        if max(along) < 0.0 or min(along) > length:
            continue
        across = [
            (z - wall.start[1]) * unit_x - (x - wall.start[0]) * unit_z
            for x, z in corners
        ]
        half = wall.thickness / 2.0
        if max(min(across) - half, -half - max(across)) <= WALL_TOLERANCE_METERS:
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


def _outside_every_room(scene: SceneIR) -> str | None:
    camera = scene.camera
    x, _, z = camera.position
    first: str | None = None
    for room in scene.rooms:
        left = room.center[0] - room.size[0] / 2.0
        right = room.center[0] + room.size[0] / 2.0
        back = room.center[1] + room.size[1] / 2.0
        if x < left:
            problem = f"position.x = {x:g} is beyond the left wall (x = {left:g})"
        elif x > right:
            problem = f"position.x = {x:g} is beyond the right wall (x = {right:g})"
        elif z > back:
            problem = f"position.z = {z:g} is behind the back wall (z = {back:g})"
        else:
            return None
        first = first or (
            f"camera '{camera.id}' stands outside room '{room.id}': {problem}. "
            "The picture was taken from inside the room or from its open side, "
            f"so keep position.x between {left:g} and {right:g} and position.z "
            f"below {back:g}. To look across the room at an angle, move target.x "
            "and leave position.x between the side walls; if the room in the "
            "picture reaches further than that, make the room larger"
        )
    return first


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
    outside = _outside_every_room(scene)
    if outside:
        errors.append(outside)
    if scene.solids and not errors:
        visible = _in_view_count(scene, image_aspect)
        if visible < len(scene.solids) * MIN_IN_VIEW_RATIO:
            errors.append(
                f"only {visible} of {len(scene.solids)} objects are inside the "
                "reference camera's view; the image shows them all, so the camera "
                "position, target and fov are inconsistent with the object positions"
            )

    for solid in scene.solids:
        if (
            solid.position[1] > SUPPORT_TOLERANCE_METERS
            and not _is_supported(solid, scene.solids)
            and not _hangs_on_a_wall(solid, scene.walls)
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

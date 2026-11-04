"""SceneIR → previz objects. Deterministic: same IR in, same objects out.

This is the only place where the DSL frame is converted to the previz frame.

DSL frame      x right, y up, z forward (away from the reference camera), metres.
Previz frame   three.js, right-handed: x right, y up, the viewer looks down -z.

Position       (x, y, z) → (x, y, -z).
Rotation       `rotation_y` is defined physically: counter-clockwise seen from
               above, with x to the right and z up the page. three.js rotates
               local x to (cos θ, 0, -sin θ), which after the z flip is the same
               physical direction, so the angle carries over unchanged.
Primitives     Unit 1 × 1 × 1, base on y = 0, centred on x and z
               (frontend/src/features/previz/engine/primitiveBuilder.ts), so
               `scale` is the size in metres and `position.y` is the bottom face.
"""

from __future__ import annotations

import math
from typing import Any

from novelvideo.director_world.blockout.scene_ir import (
    MAX_COMPILED_OBJECTS,
    MIN_PIECE_METERS,
    BlockoutLimitError,
    CameraIR,
    SceneIR,
    WallIR,
)

OBJECT_ID_PREFIX = "blockout-"
REFERENCE_CAMERA_SEMANTIC_TYPE = "reference_camera"
REFERENCE_CAMERA_NAME = "参考机位"

# Mirrors frontend/src/features/previz/domain/camera.ts (PREVIZ_SENSOR_MM.ff,
# PREVIZ_FOCAL_MM). tests/fixtures/previz_blockout/golden.json pins both sides.
SENSOR_WIDTH_MM = 36.0
FOCAL_MM_MIN = 12.0
FOCAL_MM_MAX = 200.0
DEFAULT_APERTURE = 2.8

_SHAPE_TO_PRIMITIVE = {"box": "cube", "cylinder": "cylinder", "wedge": "wedge"}

SEMANTIC_LABELS: dict[str, str] = {
    "bed": "床",
    "bench": "长椅",
    "cabinet": "柜子",
    "car": "车",
    "chair": "椅子",
    "column": "柱子",
    "counter": "柜台",
    "desk": "书桌",
    "door": "门",
    "floor": "地面",
    "platform": "平台",
    "prop": "物件",
    "ramp": "斜坡",
    "shelf": "架子",
    "sofa": "沙发",
    "stairs": "楼梯",
    "table": "桌子",
    "tree": "树",
    "wall": "墙",
    "window": "窗",
}


def _clean(value: float) -> float:
    rounded = round(float(value), 4)
    return 0.0 if rounded == 0 else rounded


def _degrees(radians: float) -> float:
    degrees = math.degrees(radians)
    if degrees <= -180.0:
        degrees += 360.0
    elif degrees > 180.0:
        degrees -= 360.0
    return _clean(degrees)


def _wrap_degrees(degrees: float) -> float:
    wrapped = math.fmod(degrees, 360.0)
    if wrapped <= -180.0:
        wrapped += 360.0
    elif wrapped > 180.0:
        wrapped -= 360.0
    return _clean(wrapped)


def focal_mm_from_horizontal_fov(fov_degrees: float) -> float:
    focal = SENSOR_WIDTH_MM / (2.0 * math.tan(math.radians(fov_degrees) / 2.0))
    return _clean(min(max(focal, FOCAL_MM_MIN), FOCAL_MM_MAX))


def camera_rotation_degrees(
    position: tuple[float, float, float], target: tuple[float, float, float]
) -> list[float]:
    """Euler angles (order YXZ, degrees) for a previz camera, in the previz frame."""
    forward = (
        target[0] - position[0],
        target[1] - position[1],
        target[2] - position[2],
    )
    length = math.sqrt(sum(component * component for component in forward))
    fx, fy, fz = (component / length for component in forward)
    pitch = math.asin(max(-1.0, min(1.0, fy)))
    # Looking straight up or down leaves yaw undefined; keep it at 0.
    yaw = 0.0 if math.hypot(fx, fz) < 1e-9 else math.atan2(-fx, -fz)
    return [_degrees(pitch), _degrees(yaw), 0.0]


class _Names:
    def __init__(self) -> None:
        self._counts: dict[str, int] = {}

    def next(self, semantic_type: str, hint: str = "") -> str:
        base = hint or SEMANTIC_LABELS.get(semantic_type, semantic_type)
        count = self._counts.get(base, 0) + 1
        self._counts[base] = count
        if hint and count == 1:
            return base
        return f"{base} {count}"


def _prop(
    *,
    object_id: str,
    name: str,
    primitive: str,
    position: tuple[float, float, float],
    rotation_y: float,
    scale: tuple[float, float, float],
    blockout_id: str,
    semantic_type: str,
) -> dict[str, Any]:
    return {
        "id": object_id,
        "kind": "prop",
        "name": name,
        "transform": {
            "position": [_clean(position[0]), _clean(position[1]), _clean(-position[2])],
            "rotation": [0.0, _wrap_degrees(rotation_y), 0.0],
            "scale": [_clean(scale[0]), _clean(scale[1]), _clean(scale[2])],
        },
        "visible": True,
        "locked": False,
        "assetUrl": primitive,
        "assetFormat": "primitive",
        "blockout": {"id": blockout_id, "semanticType": semantic_type},
    }


def _wall_pieces(wall: WallIR) -> list[tuple[str, float, float, float, float]]:
    """(label, along_from, along_to, bottom, top) for every solid part of a wall.

    The wall face is a rectangle (along the wall x up) with the openings cut
    out. It is swept in columns between opening edges; in each column the solid
    parts are what is left of the wall's height once the openings covering that
    column are removed. Neighbouring columns whose parts span the same heights
    are merged back into one piece, so a lintel runs the whole width of its
    window even when a door stands under part of it.
    """
    length = math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
    edges = sorted(
        {
            0.0,
            length,
            *(o.offset for o in wall.openings),
            *(o.offset + o.width for o in wall.openings),
        }
    )
    columns: list[tuple[float, float, float, float]] = []  # (from, to, bottom, top)
    for along_from, along_to in zip(edges, edges[1:]):
        if along_to - along_from < 1e-9:
            continue
        covering = sorted(
            (
                o
                for o in wall.openings
                if o.offset < along_to - 1e-9 and along_from < o.offset + o.width - 1e-9
            ),
            key=lambda o: o.sill,
        )
        bottom = 0.0
        for opening in covering:
            if opening.sill - bottom > 1e-9:
                columns.append((along_from, along_to, bottom, opening.sill))
            bottom = max(bottom, opening.sill + opening.height)
        if wall.height - bottom > 1e-9:
            columns.append((along_from, along_to, bottom, wall.height))
    merged: list[list[float]] = []
    for along_from, along_to, bottom, top in columns:
        for piece in merged:
            if (
                abs(piece[1] - along_from) < 1e-9
                and piece[2] == bottom
                and piece[3] == top
            ):
                piece[1] = along_to
                break
        else:
            merged.append([along_from, along_to, bottom, top])
    pieces: list[tuple[str, float, float, float, float]] = []
    for along_from, along_to, bottom, top in sorted(
        merged, key=lambda m: (m[0], -m[3])
    ):
        if along_to - along_from < MIN_PIECE_METERS or top - bottom < MIN_PIECE_METERS:
            continue
        if bottom == 0.0 and top == wall.height:
            label = "段"
        elif top == wall.height:
            label = "门楣"
        elif bottom == 0.0:
            label = "窗台"
        else:
            label = "腰墙"
        pieces.append((label, along_from, along_to, bottom, top))
    return pieces


def _compile_wall(wall: WallIR, names: _Names) -> list[dict[str, Any]]:
    dx = wall.end[0] - wall.start[0]
    dz = wall.end[1] - wall.start[1]
    length = math.hypot(dx, dz)
    ux, uz = dx / length, dz / length
    rotation_y = math.degrees(math.atan2(dz, dx))
    wall_name = names.next(wall.semantic_type, wall.name_hint)
    pieces = _wall_pieces(wall)
    objects: list[dict[str, Any]] = []
    label_counts: dict[str, int] = {}
    for index, (label, along_from, along_to, bottom, top) in enumerate(pieces, 1):
        middle = (along_from + along_to) / 2.0
        label_counts[label] = label_counts.get(label, 0) + 1
        single = len(pieces) == 1
        objects.append(
            _prop(
                object_id=(
                    f"{OBJECT_ID_PREFIX}{wall.id}"
                    if single
                    else f"{OBJECT_ID_PREFIX}{wall.id}-{index}"
                ),
                name=(
                    wall_name
                    if single
                    else f"{wall_name}-{label} {label_counts[label]}"
                ),
                primitive="cube",
                position=(
                    wall.start[0] + ux * middle,
                    bottom,
                    wall.start[1] + uz * middle,
                ),
                rotation_y=rotation_y,
                scale=(along_to - along_from, top - bottom, wall.thickness),
                blockout_id=wall.id,
                semantic_type=wall.semantic_type,
            )
        )
    return objects


def _compile_camera(camera: CameraIR) -> dict[str, Any]:
    position = (camera.position[0], camera.position[1], -camera.position[2])
    target = (camera.target[0], camera.target[1], -camera.target[2])
    return {
        "id": f"{OBJECT_ID_PREFIX}{camera.id}",
        "kind": "camera",
        "name": REFERENCE_CAMERA_NAME,
        "transform": {
            "position": [_clean(value) for value in position],
            "rotation": camera_rotation_degrees(position, target),
            "scale": [1.0, 1.0, 1.0],
        },
        "visible": True,
        "locked": False,
        "focalMm": focal_mm_from_horizontal_fov(camera.fov),
        "aperture": DEFAULT_APERTURE,
        "sensor": "ff",
        "cameraBody": "cine",
        "lensSeries": "prime",
        "blockout": {
            "id": camera.id,
            "semanticType": REFERENCE_CAMERA_SEMANTIC_TYPE,
        },
    }


def compile_scene(scene: SceneIR) -> dict[str, Any]:
    """Compile a SceneIR into previz objects, in the previz frame."""
    names = _Names()
    objects: list[dict[str, Any]] = []
    for floor in scene.floors:
        objects.append(
            _prop(
                object_id=f"{OBJECT_ID_PREFIX}{floor.id}",
                name=names.next(floor.semantic_type, floor.name_hint),
                primitive="plane",
                position=(floor.center[0], 0.0, floor.center[1]),
                rotation_y=0.0,
                scale=(floor.size[0], 1.0, floor.size[1]),
                blockout_id=floor.id,
                semantic_type=floor.semantic_type,
            )
        )
    for wall in scene.walls:
        objects.extend(_compile_wall(wall, names))
    for solid in scene.solids:
        objects.append(
            _prop(
                object_id=f"{OBJECT_ID_PREFIX}{solid.id}",
                name=names.next(solid.semantic_type, solid.name_hint),
                primitive=_SHAPE_TO_PRIMITIVE[solid.shape],
                position=solid.position,
                rotation_y=solid.rotation_y,
                scale=solid.size,
                blockout_id=solid.id,
                semantic_type=solid.semantic_type,
            )
        )
    if len(objects) > MAX_COMPILED_OBJECTS:
        raise BlockoutLimitError(
            f"scene is too complex: {len(objects)} objects > {MAX_COMPILED_OBJECTS}"
        )
    camera = _compile_camera(scene.camera)
    objects.append(camera)
    return {
        "objects": objects,
        "reference_camera_id": camera["id"],
        "counts": {"prop": len(objects) - 1, "camera": 1},
    }

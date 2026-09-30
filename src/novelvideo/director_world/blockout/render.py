"""Draw compiled previz objects from the reference camera, for the render check.

A small software rasteriser: numpy z-buffer, flat shading, one tint per semantic
type, the blockout id written on every piece that is not a wall or a floor. It
is what the model gets shown next to the reference picture, so it only has to
be legible, not pretty, and it must not need anything beyond numpy and Pillow.

Walls the camera stands outside of are left out (a dollhouse cut), so a camera
placed a little outside the room still shows the room instead of one flat wall.
"""

from __future__ import annotations

import io
import math
from typing import Any

import numpy as np

RENDER_WIDTH = 1024
_SUPERSAMPLE = 2
_NEAR = 0.05
_BACKGROUND = "#eef1f5"
_DEFAULT_TINT = "#c9c2b4"
_TINTS = {
    "wall": "#d9d3c7",
    "floor": "#a89a86",
    "platform": "#c2a36f",
    "column": "#b0a08a",
    "table": "#c58b5a",
    "counter": "#c58b5a",
    "chair": "#6f86a8",
    "bench": "#6f86a8",
    "sofa": "#7f9a8a",
    "bed": "#a88fb0",
    "shelf": "#8d6a4a",
    "cabinet": "#8d6a4a",
    "prop": "#d9c48c",
    "lamp": "#f0e2a0",
    "rug": "#b05050",
    "painting": "#4f6f6f",
    "vase": "#5f8fc8",
    "plant": "#5a9a5a",
}
_UNLABELLED = frozenset({"wall", "floor"})


def _rgb(hex_colour: str) -> np.ndarray:
    return np.array([int(hex_colour[i : i + 2], 16) for i in (1, 3, 5)], dtype=float) / 255.0


def _unit_mesh(shape: str) -> list[list[tuple[float, float, float]]]:
    """Faces of a unit primitive standing on y=0, as the previz engine builds them."""
    if shape == "plane":
        return [[(-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 0, 0.5), (-0.5, 0, 0.5)]]
    if shape == "cylinder":
        sides = 20
        ring = [
            (0.5 * math.cos(2 * math.pi * i / sides), 0.5 * math.sin(2 * math.pi * i / sides))
            for i in range(sides)
        ]
        faces = [[(x, 1, z) for x, z in ring], [(x, 0, z) for x, z in ring]]
        for i in range(sides):
            (x0, z0), (x1, z1) = ring[i], ring[(i + 1) % sides]
            faces.append([(x0, 0, z0), (x1, 0, z1), (x1, 1, z1), (x0, 1, z0)])
        return faces
    if shape == "wedge":
        a, b, c, d = (-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 0, 0.5), (-0.5, 0, 0.5)
        e, f = (-0.5, 1, -0.5), (0.5, 1, -0.5)
        return [[a, b, c, d], [a, b, f, e], [e, f, c, d], [a, d, e], [b, c, f]]
    # cube and anything unknown
    return [
        [(-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 0, 0.5), (-0.5, 0, 0.5)],
        [(-0.5, 1, -0.5), (0.5, 1, -0.5), (0.5, 1, 0.5), (-0.5, 1, 0.5)],
        [(-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 1, -0.5), (-0.5, 1, -0.5)],
        [(-0.5, 0, 0.5), (0.5, 0, 0.5), (0.5, 1, 0.5), (-0.5, 1, 0.5)],
        [(-0.5, 0, -0.5), (-0.5, 0, 0.5), (-0.5, 1, 0.5), (-0.5, 1, -0.5)],
        [(0.5, 0, -0.5), (0.5, 0, 0.5), (0.5, 1, 0.5), (0.5, 1, -0.5)],
    ]


def _world_faces(obj: dict[str, Any]) -> list[np.ndarray]:
    transform = obj["transform"]
    px, py, pz = transform["position"]
    sx, sy, sz = transform["scale"]
    yaw = math.radians(transform["rotation"][1])
    cos, sin = math.cos(yaw), math.sin(yaw)
    faces = []
    for face in _unit_mesh(obj.get("assetUrl", "cube")):
        points = []
        for x, y, z in face:
            x, y, z = x * sx, y * sy, z * sz
            x, z = x * cos + z * sin, -x * sin + z * cos
            points.append((x + px, y + py, z + pz))
        faces.append(np.array(points, dtype=float))
    return faces


def _camera_basis(camera: dict[str, Any]):
    position = np.array(camera["transform"]["position"], dtype=float)
    pitch, yaw = (math.radians(v) for v in camera["transform"]["rotation"][:2])
    forward = np.array(
        [-math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)]
    )
    right = np.cross(forward, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    # focal length over a 36 mm full-frame width: picture-fraction per unit of x/z
    return position, forward, right, up, float(camera["focalMm"]) / 36.0


def _camera_outside(wall: dict[str, Any], camera: np.ndarray, centroid: np.ndarray) -> bool:
    """True when the camera and the scene centroid are on different sides of a wall."""
    transform = wall["transform"]
    sx, _, sz = transform["scale"]
    yaw = math.radians(transform["rotation"][1])
    # the wall's thin axis, turned into world coordinates
    ax, az = (0.0, 1.0) if sz <= sx else (1.0, 0.0)
    axis = np.array([ax * math.cos(yaw) + az * math.sin(yaw), 0.0, -ax * math.sin(yaw) + az * math.cos(yaw)])
    centre = np.array(transform["position"], dtype=float)
    return float((camera - centre) @ axis) * float((centroid - centre) @ axis) <= 0


def render_blockout(
    objects: list[dict[str, Any]],
    *,
    image_aspect: float,
    width: int = RENDER_WIDTH,
    labels: bool = True,
) -> bytes:
    """PNG of the compiled objects seen from their camera, at the picture's aspect."""
    from PIL import Image, ImageDraw, ImageFont

    props = [o for o in objects if o.get("kind") == "prop"]
    camera = next(o for o in objects if o.get("kind") == "camera")
    position, forward, right, up, focal = _camera_basis(camera)
    height = int(round(width / image_aspect))
    w, h = width * _SUPERSAMPLE, height * _SUPERSAMPLE
    light = np.array([0.35, 0.8, 0.5])
    light /= np.linalg.norm(light)
    canvas = np.full((h, w, 3), _rgb(_BACKGROUND))
    depth = np.zeros((h, w))
    floors = [o for o in props if o["blockout"]["semanticType"] == "floor"]
    anchors = floors or props
    centroid = (
        np.mean([o["transform"]["position"] for o in anchors], axis=0)
        if anchors
        else np.zeros(3)
    )
    label_spots: list[tuple[float, float, str]] = []

    for obj in props:
        semantic = obj["blockout"]["semanticType"]
        if semantic == "wall" and _camera_outside(obj, position, centroid):
            continue
        tint = _rgb(_TINTS.get(semantic, _DEFAULT_TINT))
        for face in _world_faces(obj):
            normal = np.cross(face[1] - face[0], face[2] - face[0])
            if np.linalg.norm(normal) < 1e-12:
                continue
            normal /= np.linalg.norm(normal)
            # every face is two-sided: light the side that faces the camera
            if normal @ (position - face.mean(axis=0)) < 0:
                normal = -normal
            shade = 0.45 + 0.55 * max(0.0, float(normal @ light))
            # clip against the near plane, then project
            z_cam = (face - position) @ forward
            clipped = []
            count = len(face)
            for i in range(count):
                a, b = face[i], face[(i + 1) % count]
                za, zb = z_cam[i], z_cam[(i + 1) % count]
                if za >= _NEAR:
                    clipped.append(a)
                if (za >= _NEAR) != (zb >= _NEAR):
                    clipped.append(a + (_NEAR - za) / (zb - za) * (b - a))
            if len(clipped) < 3:
                continue
            points = np.array(clipped)
            view = points - position
            z_cam = view @ forward
            sx = ((view @ right) / z_cam * focal + 0.5) * w
            sy = h / 2 - (view @ up) / z_cam * focal * w
            for i in range(1, len(points) - 1):
                _fill_triangle(
                    canvas, depth, sx[[0, i, i + 1]], sy[[0, i, i + 1]], 1.0 / z_cam[[0, i, i + 1]], tint * shade
                )
        if labels and semantic not in _UNLABELLED:
            px, py, pz = obj["transform"]["position"]
            centre = np.array([px, py + obj["transform"]["scale"][1] / 2, pz]) - position
            z = centre @ forward
            if z > _NEAR:
                u = ((centre @ right) / z * focal + 0.5) * width
                v = height / 2 - (centre @ up) / z * focal * width
                label_spots.append((u, v, str(obj["blockout"]["id"])))

    image = Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8)).resize(
        (width, height), Image.LANCZOS
    )
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()
    for u, v, text in label_spots:
        if -50 < u < width + 50 and -20 < v < height + 20:
            box = draw.textbbox((u, v), text, font=font, anchor="mm")
            draw.rectangle([box[0] - 2, box[1] - 1, box[2] + 2, box[3] + 1], fill=(0, 0, 0))
            draw.text((u, v), text, fill=(255, 255, 255), font=font, anchor="mm")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _fill_triangle(canvas, depth, x, y, z_inv, colour) -> None:
    h, w = depth.shape
    x0, x1 = max(int(math.floor(x.min())), 0), min(int(math.ceil(x.max())) + 1, w)
    y0, y1 = max(int(math.floor(y.min())), 0), min(int(math.ceil(y.max())) + 1, h)
    if x0 >= x1 or y0 >= y1:
        return
    area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0])
    if abs(area) < 1e-9:
        return
    gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
    b0 = ((x[1] - gx) * (y[2] - gy) - (x[2] - gx) * (y[1] - gy)) / area
    b1 = ((x[2] - gx) * (y[0] - gy) - (x[0] - gx) * (y[2] - gy)) / area
    b2 = 1 - b0 - b1
    inside = (b0 >= 0) & (b1 >= 0) & (b2 >= 0)
    # interpolate 1/z: nearer pixels win, and the near plane is already clipped away
    z = b0 * z_inv[0] + b1 * z_inv[1] + b2 * z_inv[2]
    win = inside & (z > depth[y0:y1, x0:x1] + 1e-9)
    if not win.any():
        return
    canvas[y0:y1, x0:x1][win] = colour
    depth[y0:y1, x0:x1][win] = z[win]

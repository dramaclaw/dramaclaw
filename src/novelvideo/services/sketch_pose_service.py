"""草图姿势编辑后端工具。

- 根据身份颜色提取单个火柴人 mask + bbox
- 基于 bbox 的启发式骨架初始化
- 提供 OpenPose 18 点风格的姿势预设
- 保存为纯白底 + 火柴人骨架
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

from novelvideo.models import real_detected_identities


JOINT_KEYS = [
    "nose",
    "neck",
    "right_shoulder",
    "right_elbow",
    "right_wrist",
    "left_shoulder",
    "left_elbow",
    "left_wrist",
    "right_hip",
    "right_knee",
    "right_ankle",
    "left_hip",
    "left_knee",
    "left_ankle",
    "right_eye",
    "left_eye",
    "right_ear",
    "left_ear",
]

SKELETON_EDGES = [
    ("nose", "neck"),
    ("neck", "right_shoulder"),
    ("right_shoulder", "right_elbow"),
    ("right_elbow", "right_wrist"),
    ("neck", "left_shoulder"),
    ("left_shoulder", "left_elbow"),
    ("left_elbow", "left_wrist"),
    ("neck", "right_hip"),
    ("right_hip", "right_knee"),
    ("right_knee", "right_ankle"),
    ("neck", "left_hip"),
    ("left_hip", "left_knee"),
    ("left_knee", "left_ankle"),
    ("nose", "right_eye"),
    ("nose", "left_eye"),
    ("right_eye", "right_ear"),
    ("left_eye", "left_ear"),
]

SMALL_JOINTS = {"right_eye", "left_eye", "right_ear", "left_ear"}


def _n(x: float, y: float) -> dict[str, float]:
    return {"x": x / 512, "y": y / 512}


POSE_PRESETS: dict[str, dict[str, Any]] = {
    "standing_front": {
        "label": "站立-正面",
        "joints": {
            "nose": _n(256, 78),
            "neck": _n(256, 118),
            "right_shoulder": _n(210, 138),
            "right_elbow": _n(195, 200),
            "right_wrist": _n(195, 260),
            "left_shoulder": _n(302, 138),
            "left_elbow": _n(317, 200),
            "left_wrist": _n(317, 260),
            "right_hip": _n(228, 272),
            "right_knee": _n(225, 370),
            "right_ankle": _n(225, 460),
            "left_hip": _n(284, 272),
            "left_knee": _n(287, 370),
            "left_ankle": _n(287, 460),
            "right_eye": _n(245, 68),
            "left_eye": _n(267, 68),
            "right_ear": _n(228, 78),
            "left_ear": _n(284, 78),
        },
    },
    "standing_side_left": {
        "label": "站立-左侧",
        "joints": {
            "nose": _n(230, 78),
            "neck": _n(256, 118),
            "right_shoulder": _n(268, 138),
            "right_elbow": _n(274, 200),
            "right_wrist": _n(274, 260),
            "left_shoulder": _n(244, 138),
            "left_elbow": _n(238, 200),
            "left_wrist": _n(238, 260),
            "right_hip": _n(264, 272),
            "right_knee": _n(262, 370),
            "right_ankle": _n(262, 460),
            "left_hip": _n(248, 272),
            "left_knee": _n(246, 370),
            "left_ankle": _n(246, 460),
            "right_eye": _n(238, 70),
            "left_eye": _n(224, 70),
            "right_ear": _n(250, 76),
            "left_ear": _n(216, 80),
        },
    },
    "standing_side_right": {
        "label": "站立-右侧",
        "joints": {
            "nose": _n(282, 78),
            "neck": _n(256, 118),
            "right_shoulder": _n(268, 138),
            "right_elbow": _n(274, 200),
            "right_wrist": _n(274, 260),
            "left_shoulder": _n(244, 138),
            "left_elbow": _n(238, 200),
            "left_wrist": _n(238, 260),
            "right_hip": _n(264, 272),
            "right_knee": _n(266, 370),
            "right_ankle": _n(266, 460),
            "left_hip": _n(248, 272),
            "left_knee": _n(250, 370),
            "left_ankle": _n(250, 460),
            "right_eye": _n(288, 70),
            "left_eye": _n(274, 70),
            "right_ear": _n(296, 80),
            "left_ear": _n(262, 76),
        },
    },
    "arms_open": {
        "label": "张开双臂",
        "joints": {
            "nose": _n(256, 78),
            "neck": _n(256, 118),
            "right_shoulder": _n(210, 138),
            "right_elbow": _n(155, 138),
            "right_wrist": _n(100, 138),
            "left_shoulder": _n(302, 138),
            "left_elbow": _n(357, 138),
            "left_wrist": _n(412, 138),
            "right_hip": _n(228, 272),
            "right_knee": _n(225, 370),
            "right_ankle": _n(225, 460),
            "left_hip": _n(284, 272),
            "left_knee": _n(287, 370),
            "left_ankle": _n(287, 460),
            "right_eye": _n(245, 68),
            "left_eye": _n(267, 68),
            "right_ear": _n(228, 78),
            "left_ear": _n(284, 78),
        },
    },
    "hand_on_hip_left": {
        "label": "左手叉腰",
        "joints": {
            "nose": _n(256, 78),
            "neck": _n(256, 118),
            "right_shoulder": _n(210, 138),
            "right_elbow": _n(195, 200),
            "right_wrist": _n(195, 260),
            "left_shoulder": _n(302, 138),
            "left_elbow": _n(330, 200),
            "left_wrist": _n(300, 250),
            "right_hip": _n(228, 272),
            "right_knee": _n(225, 370),
            "right_ankle": _n(225, 460),
            "left_hip": _n(284, 272),
            "left_knee": _n(287, 370),
            "left_ankle": _n(287, 460),
            "right_eye": _n(245, 68),
            "left_eye": _n(267, 68),
            "right_ear": _n(228, 78),
            "left_ear": _n(284, 78),
        },
    },
    "hand_on_hip_right": {
        "label": "右手叉腰",
        "joints": {
            "nose": _n(256, 78),
            "neck": _n(256, 118),
            "right_shoulder": _n(210, 138),
            "right_elbow": _n(182, 200),
            "right_wrist": _n(212, 250),
            "left_shoulder": _n(302, 138),
            "left_elbow": _n(317, 200),
            "left_wrist": _n(317, 260),
            "right_hip": _n(228, 272),
            "right_knee": _n(225, 370),
            "right_ankle": _n(225, 460),
            "left_hip": _n(284, 272),
            "left_knee": _n(287, 370),
            "left_ankle": _n(287, 460),
            "right_eye": _n(245, 68),
            "left_eye": _n(267, 68),
            "right_ear": _n(228, 78),
            "left_ear": _n(284, 78),
        },
    },
    "running": {
        "label": "奔跑",
        "joints": {
            "nose": _n(250, 76),
            "neck": _n(256, 118),
            "right_shoulder": _n(220, 145),
            "right_elbow": _n(185, 185),
            "right_wrist": _n(155, 150),
            "left_shoulder": _n(292, 132),
            "left_elbow": _n(332, 170),
            "left_wrist": _n(368, 220),
            "right_hip": _n(235, 272),
            "right_knee": _n(205, 330),
            "right_ankle": _n(185, 405),
            "left_hip": _n(282, 262),
            "left_knee": _n(328, 332),
            "left_ankle": _n(372, 298),
            "right_eye": _n(240, 68),
            "left_eye": _n(260, 66),
            "right_ear": _n(226, 76),
            "left_ear": _n(278, 76),
        },
    },
    "sitting": {
        "label": "坐姿",
        "joints": {
            "nose": _n(256, 96),
            "neck": _n(256, 136),
            "right_shoulder": _n(214, 152),
            "right_elbow": _n(188, 206),
            "right_wrist": _n(196, 252),
            "left_shoulder": _n(298, 152),
            "left_elbow": _n(324, 206),
            "left_wrist": _n(316, 252),
            "right_hip": _n(226, 250),
            "right_knee": _n(276, 300),
            "right_ankle": _n(336, 308),
            "left_hip": _n(286, 250),
            "left_knee": _n(338, 300),
            "left_ankle": _n(388, 312),
            "right_eye": _n(245, 86),
            "left_eye": _n(267, 86),
            "right_ear": _n(228, 96),
            "left_ear": _n(284, 96),
        },
    },
    "jump": {
        "label": "跳跃",
        "joints": {
            "nose": _n(256, 78),
            "neck": _n(256, 118),
            "right_shoulder": _n(210, 132),
            "right_elbow": _n(175, 86),
            "right_wrist": _n(150, 48),
            "left_shoulder": _n(302, 132),
            "left_elbow": _n(337, 86),
            "left_wrist": _n(362, 48),
            "right_hip": _n(228, 262),
            "right_knee": _n(195, 338),
            "right_ankle": _n(175, 410),
            "left_hip": _n(284, 262),
            "left_knee": _n(317, 338),
            "left_ankle": _n(337, 410),
            "right_eye": _n(245, 68),
            "left_eye": _n(267, 68),
            "right_ear": _n(228, 78),
            "left_ear": _n(284, 78),
        },
    },
    "kick": {
        "label": "踢腿",
        "joints": {
            "nose": _n(256, 78),
            "neck": _n(256, 118),
            "right_shoulder": _n(210, 138),
            "right_elbow": _n(175, 190),
            "right_wrist": _n(150, 240),
            "left_shoulder": _n(302, 138),
            "left_elbow": _n(337, 190),
            "left_wrist": _n(350, 240),
            "right_hip": _n(228, 272),
            "right_knee": _n(225, 370),
            "right_ankle": _n(225, 460),
            "left_hip": _n(284, 272),
            "left_knee": _n(340, 310),
            "left_ankle": _n(400, 310),
            "right_eye": _n(245, 68),
            "left_eye": _n(267, 68),
            "right_ear": _n(228, 78),
            "left_ear": _n(284, 78),
        },
    },
}


def get_preset_pose(
    preset_key: str,
    image_size: tuple[int, int],
    bbox: tuple[int, int, int, int] | None = None,
) -> dict[str, Any]:
    preset = POSE_PRESETS.get(preset_key)
    if not preset:
        raise ValueError(f"Unknown preset: {preset_key}")

    img_w, img_h = image_size
    if bbox:
        bx0, by0, bx1, by1 = bbox
        bw = max(1, bx1 - bx0)
        bh = max(1, by1 - by0)
    else:
        bx0, by0 = 0, 0
        bw, bh = img_w, img_h

    joints: dict[str, dict[str, float]] = {}
    for key, pt in preset["joints"].items():
        joints[key] = {
            "x": bx0 + pt["x"] * bw,
            "y": by0 + pt["y"] * bh,
        }

    nose = joints.get("nose", joints.get("neck"))
    neck = joints.get("neck", nose)
    head_r = max(6, int(((nose["x"] - neck["x"]) ** 2 + (nose["y"] - neck["y"]) ** 2) ** 0.5 * 0.8))

    line_width = max(6, int(min(bw, bh) * 0.12))
    return {
        "joints": joints,
        "bbox": {"x": bx0, "y": by0, "width": bw, "height": bh},
        "line_width": line_width,
        "head_radius": head_r,
        "source": "preset",
        "image_width": img_w,
        "image_height": img_h,
    }


@dataclass
class PoseCandidate:
    identity_id: str
    color_hex: str
    color_name: str


@dataclass
class PropPoseCandidate:
    prop_id: str
    color_hex: str
    color_name: str


def _load_image_modules():
    try:
        import numpy as np
        from PIL import Image, ImageDraw
    except Exception as e:  # pragma: no cover - runtime dependency
        raise RuntimeError("姿势编辑依赖 Pillow 和 numpy") from e
    return np, Image, ImageDraw


def parse_sketch_color(color_value: str) -> tuple[str, str]:
    parts = (color_value or "").split(" ", 1)
    hex_code = parts[0] if parts else ""
    color_name = parts[1] if len(parts) > 1 else hex_code
    return hex_code, color_name


def build_pose_candidates(
    beat: dict[str, Any],
    sketch_colors: dict[str, str],
) -> list[PoseCandidate]:
    candidates: list[PoseCandidate] = []
    for identity_id in real_detected_identities(beat.get("detected_identities") or []):
        color_value = sketch_colors.get(identity_id, "")
        if not color_value:
            continue
        color_hex, color_name = parse_sketch_color(color_value)
        if not color_hex:
            continue
        candidates.append(
            PoseCandidate(
                identity_id=identity_id,
                color_hex=color_hex,
                color_name=color_name,
            )
        )
    print(
        "[pose] candidates beat="
        f"{beat.get('beat_number')} detected={beat.get('detected_identities') or []} "
        f"resolved={[f'{c.identity_id}:{c.color_hex}' for c in candidates]}",
        flush=True,
    )
    return candidates


def build_all_episode_candidates(
    sketch_colors: dict[str, str],
) -> list[PoseCandidate]:
    candidates: list[PoseCandidate] = []
    for identity_id, color_value in sketch_colors.items():
        if not color_value:
            continue
        color_hex, color_name = parse_sketch_color(color_value)
        if not color_hex:
            continue
        candidates.append(
            PoseCandidate(
                identity_id=identity_id,
                color_hex=color_hex,
                color_name=color_name,
            )
        )
    return candidates


def build_prop_pose_candidates(
    beat: dict[str, Any],
    prop_marker_colors: dict[str, str],
) -> list[PropPoseCandidate]:
    from novelvideo.models import collect_prop_marker_ids_from_beat

    candidates: list[PropPoseCandidate] = []
    for prop_id in collect_prop_marker_ids_from_beat(beat):
        color_value = prop_marker_colors.get(prop_id, "")
        if not color_value:
            continue
        color_hex, color_name = parse_sketch_color(color_value)
        if not color_hex:
            continue
        candidates.append(
            PropPoseCandidate(
                prop_id=prop_id,
                color_hex=color_hex,
                color_name=color_name,
            )
        )
    return candidates


def build_all_prop_pose_candidates(
    prop_marker_colors: dict[str, str],
) -> list[PropPoseCandidate]:
    candidates: list[PropPoseCandidate] = []
    for prop_id, color_value in prop_marker_colors.items():
        color_hex, color_name = parse_sketch_color(color_value)
        if not color_hex:
            continue
        candidates.append(
            PropPoseCandidate(
                prop_id=prop_id,
                color_hex=color_hex,
                color_name=color_name,
            )
        )
    return candidates


def _hex_to_rgb(hex_code: str) -> tuple[int, int, int]:
    hex_code = hex_code.strip()
    if not hex_code.startswith("#") or len(hex_code) != 7:
        raise ValueError(f"Invalid color hex: {hex_code}")
    return tuple(int(hex_code[i : i + 2], 16) for i in (1, 3, 5))


def _match_color_mask(image_array, target_rgb: tuple[int, int, int], tolerance: int = 70):
    np, _, _ = _load_image_modules()
    rgb = image_array[..., :3].astype(np.int16)
    target = np.array(target_rgb, dtype=np.int16)
    diff = np.abs(rgb - target)
    mask = (diff <= tolerance).all(axis=2)
    if image_array.shape[-1] == 4:
        mask = mask & (image_array[..., 3] > 0)
    return mask


def _compute_bbox(mask) -> tuple[int, int, int, int]:
    np, _, _ = _load_image_modules()
    ys, xs = np.where(mask)
    if len(xs) == 0 or len(ys) == 0:
        raise ValueError("未找到指定颜色的火柴人")
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def _heuristic_pose_from_bbox(
    bbox: tuple[int, int, int, int],
    image_size: tuple[int, int],
) -> dict[str, Any]:
    x0, y0, x1, y1 = bbox
    width = max(8, x1 - x0 + 1)
    height = max(16, y1 - y0 + 1)
    cx = x0 + width / 2

    head_r = max(6, int(min(width, height) * 0.12))
    neck_y = y0 + height * 0.22
    shoulder_y = y0 + height * 0.28
    elbow_y = y0 + height * 0.44
    wrist_y = y0 + height * 0.58
    hip_y = y0 + height * 0.58
    knee_y = y0 + height * 0.78
    ankle_y = y0 + height * 0.95

    shoulder_dx = max(width * 0.18, head_r * 0.9)
    elbow_dx = max(width * 0.26, head_r * 1.4)
    wrist_dx = max(width * 0.30, head_r * 1.8)
    hip_dx = max(width * 0.12, head_r * 0.8)
    knee_dx = max(width * 0.14, head_r * 1.0)
    ankle_dx = max(width * 0.16, head_r * 1.1)

    nose_y = y0 + head_r * 0.9
    eye_y = nose_y - head_r * 0.25
    ear_y = nose_y
    eye_dx = head_r * 0.35
    ear_dx = head_r * 0.85

    joints = {
        "nose": {"x": cx, "y": nose_y},
        "neck": {"x": cx, "y": neck_y},
        "right_shoulder": {"x": cx + shoulder_dx, "y": shoulder_y},
        "right_elbow": {"x": cx + elbow_dx, "y": elbow_y},
        "right_wrist": {"x": cx + wrist_dx, "y": wrist_y},
        "left_shoulder": {"x": cx - shoulder_dx, "y": shoulder_y},
        "left_elbow": {"x": cx - elbow_dx, "y": elbow_y},
        "left_wrist": {"x": cx - wrist_dx, "y": wrist_y},
        "right_hip": {"x": cx + hip_dx, "y": hip_y},
        "right_knee": {"x": cx + knee_dx, "y": knee_y},
        "right_ankle": {"x": cx + ankle_dx, "y": ankle_y},
        "left_hip": {"x": cx - hip_dx, "y": hip_y},
        "left_knee": {"x": cx - knee_dx, "y": knee_y},
        "left_ankle": {"x": cx - ankle_dx, "y": ankle_y},
        "right_eye": {"x": cx + eye_dx, "y": eye_y},
        "left_eye": {"x": cx - eye_dx, "y": eye_y},
        "right_ear": {"x": cx + ear_dx, "y": ear_y},
        "left_ear": {"x": cx - ear_dx, "y": ear_y},
    }

    line_width = max(6, int(min(width, height) * 0.12))
    return {
        "joints": joints,
        "bbox": {"x": x0, "y": y0, "width": width, "height": height},
        "line_width": line_width,
        "head_radius": head_r,
        "source": "heuristic",
        "image_width": image_size[0],
        "image_height": image_size[1],
    }


def estimate_pose_for_candidate(image_path: str, color_hex: str) -> dict[str, Any]:
    np, Image, _ = _load_image_modules()

    print(f"[pose] estimate start image={image_path} color={color_hex}", flush=True)
    img = Image.open(image_path).convert("RGBA")
    image_array = np.array(img)
    target_rgb = _hex_to_rgb(color_hex)
    mask = _match_color_mask(image_array, target_rgb)
    mask_pixels = int(mask.sum())
    print(f"[pose] mask pixels={mask_pixels}", flush=True)
    bbox = _compute_bbox(mask)
    print(f"[pose] mask bbox={bbox}", flush=True)

    result = _heuristic_pose_from_bbox(bbox, (img.width, img.height))
    print("[pose] heuristic pose generated", flush=True)
    return result


def estimate_prop_box_for_candidate(image_path: str, color_hex: str) -> dict[str, Any]:
    np, Image, _ = _load_image_modules()

    img = Image.open(image_path).convert("RGBA")
    image_array = np.array(img)
    target_rgb = _hex_to_rgb(color_hex)
    mask = _match_color_mask(image_array, target_rgb)
    x0, y0, x1, y1 = _compute_bbox(mask)
    return {
        "bbox": {
            "x": x0,
            "y": y0,
            "width": max(8, x1 - x0 + 1),
            "height": max(8, y1 - y0 + 1),
        },
        "source": "detected",
        "image_width": img.width,
        "image_height": img.height,
    }


def apply_pose_to_sketch(
    image_path: str,
    color_hex: str,
    pose_data: dict[str, Any],
) -> None:
    _, Image, ImageDraw = _load_image_modules()

    img = Image.open(image_path).convert("RGBA")
    draw = ImageDraw.Draw(img)
    color_rgb = _hex_to_rgb(color_hex)

    pixels = img.load()
    width, height = img.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            if (
                abs(r - color_rgb[0]) <= 70
                and abs(g - color_rgb[1]) <= 70
                and abs(b - color_rgb[2]) <= 70
            ):
                pixels[x, y] = (255, 255, 255, 255)

    joints = pose_data.get("joints", {})
    line_width = int(pose_data.get("line_width", 4))
    draw_color = tuple(color_rgb) + (255,)

    for a_key, b_key in SKELETON_EDGES:
        a = joints.get(a_key)
        b = joints.get(b_key)
        if not a or not b:
            continue
        draw.line((a["x"], a["y"], b["x"], b["y"]), fill=draw_color, width=line_width)

    nose = joints.get("nose")
    neck = joints.get("neck")
    head_radius = int(pose_data.get("head_radius", 10))
    if nose and neck:
        head_radius = max(
            6,
            int(((nose["x"] - neck["x"]) ** 2 + (nose["y"] - neck["y"]) ** 2) ** 0.5 * 0.8),
        )
        cx, cy = nose["x"], nose["y"]
        draw.ellipse(
            (cx - head_radius, cy - head_radius, cx + head_radius, cy + head_radius),
            outline=draw_color,
            width=max(2, line_width),
        )

    for key, pt in joints.items():
        radius = max(2, line_width // 2) if key in SMALL_JOINTS else max(3, line_width)
        draw.ellipse(
            (pt["x"] - radius, pt["y"] - radius, pt["x"] + radius, pt["y"] + radius),
            fill=draw_color,
        )

    img.save(image_path)
    print(f"[pose] apply saved image={image_path}", flush=True)


def save_clean_sketch(
    image_path: str,
    pose_list: list[tuple[str, dict[str, Any]]],
    strokes: list[dict[str, Any]] | None = None,
) -> None:
    """保存干净的草图：纯白底 + 铅笔线稿 + 火柴人。"""
    _, Image, ImageDraw = _load_image_modules()

    orig = Image.open(image_path)
    w, h = orig.size
    orig.close()

    img = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    draw = ImageDraw.Draw(img)

    for stroke in (strokes or []):
        points = stroke.get("points", [])
        if len(points) < 2:
            continue
        stroke_width = max(1, int(stroke.get("width", 4)))
        stroke_color = (255, 255, 255, 255) if stroke.get("eraser") else (51, 51, 51, 255)
        for i in range(1, len(points)):
            p0 = points[i - 1]
            p1 = points[i]
            draw.line(
                (p0["x"], p0["y"], p1["x"], p1["y"]),
                fill=stroke_color,
                width=stroke_width,
            )

    for color_hex, pose_data in pose_list:
        color_rgb = _hex_to_rgb(color_hex)
        draw_color = tuple(color_rgb) + (255,)
        joints = pose_data.get("joints", {})
        line_width = int(pose_data.get("line_width", 4))
        head_radius = int(pose_data.get("head_radius", 10))

        for a_key, b_key in SKELETON_EDGES:
            a = joints.get(a_key)
            b = joints.get(b_key)
            if not a or not b:
                continue
            draw.line((a["x"], a["y"], b["x"], b["y"]), fill=draw_color, width=line_width)

        nose = joints.get("nose")
        neck = joints.get("neck")
        if nose and neck:
            head_radius = max(
                6,
                int(((nose["x"] - neck["x"]) ** 2 + (nose["y"] - neck["y"]) ** 2) ** 0.5 * 0.8),
            )
        if nose:
            cx, cy = nose["x"], nose["y"]
            draw.ellipse(
                (cx - head_radius, cy - head_radius, cx + head_radius, cy + head_radius),
                outline=draw_color,
                width=max(2, line_width),
                fill=draw_color,
            )

    img.save(image_path)
    print(
        f"[pose] saved clean sketch with {len(pose_list)} figures + {len(strokes or [])} strokes to {image_path}",
        flush=True,
    )


def save_edited_sketch(image_path: str, data_url: str) -> None:
    """保存前端导出的当前草图画布。"""
    _, Image, _ = _load_image_modules()

    if not data_url or "," not in data_url:
        raise ValueError("无效的草图导出数据")

    _, encoded = data_url.split(",", 1)
    raw = base64.b64decode(encoded)
    from io import BytesIO

    img = Image.open(BytesIO(raw))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    img.save(image_path, format="PNG")
    print(f"[pose] saved edited sketch to {image_path}", flush=True)


def save_pose_editor_state(image_path: str, editor_state: dict[str, Any]) -> None:
    """Save pose editor changes without sending the rendered bitmap through the websocket."""
    _, Image, ImageDraw = _load_image_modules()

    img = Image.open(image_path).convert("RGBA")
    draw = ImageDraw.Draw(img)

    for stroke in editor_state.get("strokes") or []:
        points = stroke.get("points") or []
        if len(points) < 2:
            continue
        width = max(1, int(round(float(stroke.get("width") or 4))))
        color = (255, 255, 255, 255) if stroke.get("eraser") else _hex_to_rgb(
            str(stroke.get("colorHex") or "#333333")
        ) + (255,)
        for idx in range(1, len(points)):
            p0 = points[idx - 1]
            p1 = points[idx]
            draw.line(
                (
                    float(p0.get("x") or 0),
                    float(p0.get("y") or 0),
                    float(p1.get("x") or 0),
                    float(p1.get("y") or 0),
                ),
                fill=color,
                width=width,
            )

    visible_count = 0
    prop_count = 0
    for prop in editor_state.get("props") or []:
        if not prop.get("visible"):
            continue
        bbox = prop.get("bbox") or {}
        try:
            x = float(bbox.get("x") or 0)
            y = float(bbox.get("y") or 0)
            w = max(2.0, float(bbox.get("width") or 0))
            h = max(2.0, float(bbox.get("height") or 0))
        except (TypeError, ValueError):
            continue
        prop_count += 1
        color_hex = str(prop.get("colorHex") or "#0D47A1")
        color = _hex_to_rgb(color_hex) + (255,)
        outline = tuple(max(0, channel - 40) for channel in color[:3]) + (255,)
        draw.rectangle((x, y, x + w, y + h), fill=color, outline=outline, width=2)

    for skeleton in editor_state.get("skeletons") or []:
        if not skeleton.get("visible"):
            continue
        visible_count += 1
        color_hex = str(skeleton.get("colorHex") or "#22d3ee")
        color = _hex_to_rgb(color_hex) + (255,)
        joints = skeleton.get("joints") or {}
        line_width = max(1, int(round(float(skeleton.get("lineWidth") or 3))))

        for a_key, b_key in SKELETON_EDGES:
            a = joints.get(a_key)
            b = joints.get(b_key)
            if not a or not b:
                continue
            draw.line(
                (
                    float(a.get("x") or 0),
                    float(a.get("y") or 0),
                    float(b.get("x") or 0),
                    float(b.get("y") or 0),
                ),
                fill=color,
                width=line_width,
            )

        nose = joints.get("nose")
        neck = joints.get("neck")
        head_radius = int(round(float(skeleton.get("headRadius") or 10)))
        if nose and neck:
            head_radius = max(
                6,
                int(
                    (
                        (float(nose.get("x") or 0) - float(neck.get("x") or 0)) ** 2
                        + (float(nose.get("y") or 0) - float(neck.get("y") or 0)) ** 2
                    )
                    ** 0.5
                    * 0.8
                ),
            )
        if nose:
            cx = float(nose.get("x") or 0)
            cy = float(nose.get("y") or 0)
            draw.ellipse(
                (cx - head_radius, cy - head_radius, cx + head_radius, cy + head_radius),
                outline=color,
                width=max(2, line_width),
                fill=color,
            )

    img.save(image_path, format="PNG")
    print(
        f"[pose] saved editor state with {visible_count} visible skeletons + "
        f"{prop_count} visible props + {len(editor_state.get('strokes') or [])} strokes "
        f"to {image_path}",
        flush=True,
    )

"""Keep spatial decisions identical in preparation, editing and episode inputs.

Episode labels are host-owned. Legacy descriptions remain readable without
inventing the spatial facts that older artifacts never recorded.
"""

from __future__ import annotations

import json

from .characters import inline
from .schemas.planning import SceneDocument

SCENE_CONTRACT = "scene-design/1.0.0"


def parse_scenes(raw: str, root: dict) -> dict:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("SCENE_DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    return validate_scenes(json.loads(raw, object_pairs_hook=unique_object), root)


def validate_scenes(value: dict, root: dict) -> dict:
    value = SceneDocument.from_wire(value).model_dump(mode="json", by_alias=True)
    ranks = {ep["id"]: rank for rank, ep in enumerate(root["episodes"])}
    if len(ranks) != root["preset"]["episode_count"]:
        raise ValueError("PLANNING_EPISODES_MISMATCH")
    for scene in value["locations"]:
        keys = scene["keyEpisodeIds"]
        if any(key not in ranks for key in keys):
            raise ValueError("SCENE_EPISODE_MISSING")
        if keys != sorted(set(keys), key=ranks.__getitem__):
            raise ValueError("SCENE_EPISODE_ORDER_INVALID")
    return value


LABELS = {
    "list": ("场景清单", "Scene list", "Danh sách bối cảnh"),
    "type": ("类型", "Type", "Loại"),
    "interior": ("室内", "Interior", "Nội cảnh"),
    "exterior": ("室外", "Exterior", "Ngoại cảnh"),
    "mixed": ("室内 / 室外", "Interior / Exterior", "Nội / Ngoại cảnh"),
    "unknown": ("待确认", "Unconfirmed", "Chưa xác nhận"),
    "dramaticFunction": ("戏剧作用", "Dramatic function", "Vai trò kịch tính"),
    "spatialConstraints": (
        "空间对行动的限制",
        "Spatial constraints on action",
        "Hạn chế không gian đối với hành động",
    ),
    "reusablePositions": (
        "可复用动作位置",
        "Reusable action positions",
        "Vị trí hành động có thể tái sử dụng",
    ),
    "keyEpisodeIds": ("关键集次", "Key episodes", "Các tập quan trọng"),
    "description": ("描述", "Description", "Mô tả"),
}


def render_scenes(value: dict, root: dict | None = None) -> str:
    locale = {"en": 1, "vi": 2}.get(
        (root or {}).get("preset", {}).get("output_language", "zh-CN"), 0
    )
    episodes = {
        ep["id"]: ep["deliveryLabel"] for ep in (root or {}).get("episodes", [])
    }
    modern = value.get("sceneVersion") == 1
    lines = ["# " + LABELS["list"][locale]]
    for scene in value["locations"]:
        lines.extend(["", "## " + inline(scene["name"]), ""])
        fields = (
            [
                "type",
                "dramaticFunction",
                "spatialConstraints",
                "reusablePositions",
                "keyEpisodeIds",
            ]
            if modern
            else ["description"]
        )
        for key in fields:
            text = scene[key]
            if key == "type":
                text = LABELS[text][locale]
            elif key == "keyEpisodeIds":
                text = " / ".join(episodes[item] for item in text)
            separator = "：" if locale == 0 else ": "
            lines.append(f"- **{LABELS[key][locale]}**{separator}{inline(text)}")
    return "\n".join(lines) + "\n"

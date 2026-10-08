"""Project the same prop rules in preparation, proposals and episode context.

Object identity and episode order belong to the host, not a model's display
labels. Older descriptions remain readable without fabricating missing rules.
"""

from __future__ import annotations

import json

from .characters import inline
from .schemas.planning import PropDocument

PROP_CONTRACT = "prop-design/1.0.0"


def parse_props(raw: str, root: dict) -> dict:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("PROP_DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    return validate_props(json.loads(raw, object_pairs_hook=unique_object), root)


def validate_props(value: dict, root: dict) -> dict:
    value = PropDocument.from_wire(value).model_dump(mode="json", by_alias=True)
    ranks = {ep["id"]: rank for rank, ep in enumerate(root["episodes"])}
    if len(ranks) != root["preset"]["episode_count"]:
        raise ValueError("PLANNING_EPISODES_MISMATCH")
    for prop in value["props"]:
        first, keys = prop["firstEpisodeId"], prop["keyEpisodeIds"]
        if first not in ranks or any(key not in ranks for key in keys):
            raise ValueError("PROP_EPISODE_MISSING")
        if keys != sorted(set(keys), key=ranks.__getitem__):
            raise ValueError("PROP_EPISODE_ORDER_INVALID")
        if any(ranks[key] < ranks[first] for key in keys):
            raise ValueError("PROP_KEY_BEFORE_FIRST")
    return value


LABELS = {
    "list": ("道具清单", "Prop list", "Danh sách đạo cụ"),
    "type": ("类型", "Type", "Loại"),
    "dramaticFunction": ("戏剧作用", "Dramatic function", "Vai trò kịch tính"),
    "usageBoundary": ("使用边界", "Usage boundaries", "Giới hạn sử dụng"),
    "firstEpisodeId": ("首次出场", "First appearance", "Lần đầu xuất hiện"),
    "keyEpisodeIds": ("关键集次", "Key episodes", "Các tập quan trọng"),
    "description": ("描述", "Description", "Mô tả"),
}


def render_props(value: dict, root: dict | None = None) -> str:
    locale = {"en": 1, "vi": 2}.get(
        (root or {}).get("preset", {}).get("output_language", "zh-CN"), 0
    )
    episodes = {
        ep["id"]: ep["deliveryLabel"] for ep in (root or {}).get("episodes", [])
    }
    modern = value.get("propVersion") == 1
    lines = ["# " + LABELS["list"][locale]]
    if modern and not value["props"]:
        lines.extend(["", inline(value["emptyReason"])])
    for prop in value["props"]:
        lines.extend(["", "## " + inline(prop["name"]), ""])
        fields = (
            [
                "type",
                "dramaticFunction",
                "usageBoundary",
                "firstEpisodeId",
                "keyEpisodeIds",
            ]
            if modern
            else ["description"]
        )
        for key in fields:
            text = prop[key]
            if key == "firstEpisodeId":
                text = episodes[text]
            elif key == "keyEpisodeIds":
                text = " / ".join(episodes[item] for item in text)
            separator = "：" if locale == 0 else ": "
            lines.append(f"- **{LABELS[key][locale]}**{separator}{inline(text)}")
    return "\n".join(lines) + "\n"

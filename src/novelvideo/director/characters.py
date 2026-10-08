"""Share character elements without showing model keys as a literary document.

Episode IDs belong to the host. Legacy artifacts remain readable, but missing
fields are never manufactured or written back just by opening a document.
"""

from __future__ import annotations

import json
import re

from .schemas.planning import Bible, CharacterDocument

CHARACTER_CONTRACT = "character-biographies/2.2.0"


def parse_characters(raw: str, root: dict, *, preparation: bool = False) -> dict:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("CHARACTER_DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    return validate_characters(
        json.loads(raw, object_pairs_hook=unique_object), root, preparation=preparation
    )


def validate_characters(value: dict, root: dict, *, preparation: bool = False) -> dict:
    model = Bible if preparation else CharacterDocument
    value = model.from_wire(value).model_dump(mode="json", by_alias=True)
    episodes = root["episodes"]
    ranks = {ep["id"]: i for i, ep in enumerate(episodes)}
    if len(ranks) != root["preset"]["episode_count"]:
        raise ValueError("PLANNING_EPISODES_MISMATCH")
    for character in value["characters"]:
        first, keys = character["firstEpisodeId"], character["keyEpisodeIds"]
        if first not in ranks or any(key not in ranks for key in keys):
            raise ValueError("CHARACTER_EPISODE_MISSING")
        if keys != sorted(set(keys), key=ranks.__getitem__) or any(
            ranks[key] < ranks[first] for key in keys
        ):
            raise ValueError("CHARACTER_EPISODE_ORDER_INVALID")
    return value


# Document copy follows output_language, independently of the UI language.
LABELS = {
    "list": ("人物清单", "Character roster", "Danh sách nhân vật"),
    "role": ("类型", "Type", "Loại"),
    "protagonist": ("主角", "Protagonist", "Nhân vật trung tâm"),
    "main": ("主要", "Main", "Nhân vật chính"),
    "supporting": ("次要", "Supporting", "Nhân vật phụ"),
    "setting": ("人物设定", "Character premise", "Thiết lập nhân vật"),
    "dramaticFunction": ("在本剧的作用", "Role in the story", "Vai trò trong truyện"),
    "tags": ("标签", "Tags", "Đặc điểm"),
    "voice": ("语言风格", "Speech style", "Phong cách lời nói"),
    "speechFlaw": ("说话的破绽", "Speech giveaway", "Sơ hở trong lời nói"),
    "memorableDetail": ("设定记忆点", "Memorable detail", "Chi tiết đáng nhớ"),
    "arc": ("弧光", "Arc", "Diễn tiến nhân vật"),
    "pressureResponse": (
        "被逼急时怎么做",
        "Response under pressure",
        "Phản ứng khi bị dồn ép",
    ),
    "addressRules": ("称呼规则", "Forms of address", "Quy tắc xưng hô"),
    "firstEpisodeId": ("首次出场", "First appearance", "Lần đầu xuất hiện"),
    "keyEpisodeIds": ("关键集次", "Key episodes", "Các tập quan trọng"),
    "appearance": ("外形", "Appearance", "Ngoại hình"),
    "motive": ("核心动机", "Motivation", "Động cơ"),
    "knowledge": ("知情边界", "Knowledge boundary", "Giới hạn hiểu biết"),
    "relations": ("人物关系", "Relationships", "Quan hệ nhân vật"),
    "worldRules": ("世界规则", "World rules", "Quy tắc thế giới"),
}


def inline(text: object) -> str:
    """Model prose is data; it cannot inject extra headings, links or HTML."""
    return re.sub(r"([\\`*_{}\[\]<>#!|])", r"\\\1", " ".join(str(text).split()))


def render_characters(value: dict, root: dict | None = None) -> str:
    language = (root or {}).get("preset", {}).get("output_language", "zh-CN")
    locale = {"en": 1, "vi": 2}.get(language, 0)

    def label(key):
        return LABELS[key][locale]

    episodes = {
        ep["id"]: ep["deliveryLabel"] for ep in (root or {}).get("episodes", [])
    }
    modern = value.get("characterVersion") == 2
    lines = [f"# {label('list')}"]
    for character in value["characters"]:
        lines.extend(["", "## " + inline(character["names"][0]), ""])
        if modern:
            fields = ["role", "setting", "dramaticFunction", "tags"]
            if character["role"] != "supporting":
                fields += [
                    "voice",
                    "speechFlaw",
                    "memorableDetail",
                    "arc",
                    "pressureResponse",
                    "addressRules",
                ]
            fields += ["firstEpisodeId", "keyEpisodeIds"]
        else:
            fields = ["appearance", "motive", "knowledge", "voice", "arc"]
        for key in fields:
            text = character.get(key)
            if text is None:
                continue
            if key == "role":
                text = label(text)
            elif key == "firstEpisodeId":
                text = episodes[text]
            elif key == "keyEpisodeIds":
                text = " / ".join(episodes[item] for item in text)
            elif isinstance(text, list):
                text = ("、" if locale == 0 else ", ").join(text)
            lines.append(
                f"- **{label(key)}**：{inline(text)}"
                if locale == 0
                else f"- **{label(key)}**: {inline(text)}"
            )
    # Old records had relationships/world rules in the visible document. Keep
    # those unchanged in meaning; new rosters put relationships in the premise,
    # while the structured graph remains available to subsequent stages.
    if not modern:
        names = {row["id"]: row["names"][0] for row in value["characters"]}
        if value.get("relations"):
            lines.extend(["", f"## {label('relations')}", ""])
            for row in value["relations"]:
                lines.append(
                    f"- {inline(names[row['fromId']])} → {inline(names[row['toId']])}: {inline(row['description'])}"
                )
        if value.get("worldRules"):
            lines.extend(["", f"## {label('worldRules')}", ""])
            lines.extend(f"- {inline(rule)}" for rule in value["worldRules"])
    return "\n".join(lines) + "\n"

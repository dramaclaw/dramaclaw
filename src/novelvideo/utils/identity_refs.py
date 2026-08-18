"""角色改名时，散在各处的 identity_id 引用怎么跟着改。

``identity_id`` 的格式是 ``<角色名>_<身份名>``，角色名嵌在里面，所以角色一改名，所有
落库的 identity_id 就同时失效——身份图找不到、sketch 颜色分配对不上、分镜 marker 检出
的身份不在身份表里。

引用散在五个地方（见 ``SQLiteStore._cascade_character_rename``）：``episodes`` 的
``identity_ids`` / ``identity_default_map_json`` / ``sketch_colors_json`` / ``character_names``，
以及 ``beats`` 的 ``detected_identities_json`` / ``visual_description`` / ``speaker``。

这里只放纯函数：给一段旧 JSON（或文本），返回改好的新值，**没变就返回 ``None``**。
调用方拿 ``None`` 当「这一行不用写」的信号，免得给没引用过这个角色的行平白刷
``updated_at``。
"""

from __future__ import annotations

import json
import re
from typing import Any


def remap_identity_id(identity_id: Any, old_name: str, new_name: str) -> str:
    """``<旧角色名>_<身份名>`` → ``<新角色名>_<身份名>``，其余原样返回。

    前缀比对必须带上分隔的下划线：``林小满`` 改名时不能把 ``林小满月_casual`` 也一起
    改了。``__NO_CHARACTER__`` 这类哨兵值不带角色名前缀，自然落在这里不动。
    """

    value = str(identity_id or "")
    if value == old_name:
        return new_name
    prefix = f"{old_name}_"
    if value.startswith(prefix):
        return f"{new_name}_{value[len(prefix) :]}"
    return value


def remap_id_list(raw_json: str | None, old_name: str, new_name: str) -> str | None:
    """重映射 ``[identity_id, ...]`` 或 ``[角色名, ...]`` JSON 数组。"""

    try:
        values = json.loads(raw_json or "[]")
    except (TypeError, ValueError):
        return None
    if not isinstance(values, list):
        return None
    remapped = [remap_identity_id(item, old_name, new_name) for item in values]
    if remapped == values:
        return None
    return json.dumps(remapped, ensure_ascii=False)


def remap_default_map(raw_json: str | None, old_name: str, new_name: str) -> str | None:
    """``{角色名: identity_id}``——键和值都嵌着角色名，两边都要改。"""

    try:
        mapping = json.loads(raw_json or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(mapping, dict):
        return None
    remapped = {
        (new_name if str(key) == old_name else str(key)): remap_identity_id(
            value, old_name, new_name
        )
        for key, value in mapping.items()
    }
    if remapped == mapping:
        return None
    return json.dumps(remapped, ensure_ascii=False)


def remap_keyed_by_identity(
    raw_json: str | None, old_name: str, new_name: str
) -> str | None:
    """``{identity_id: 任意值}``——只有键嵌着角色名（``sketch_colors_json``）。"""

    try:
        mapping = json.loads(raw_json or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(mapping, dict):
        return None
    remapped = {
        remap_identity_id(key, old_name, new_name): value
        for key, value in mapping.items()
    }
    if remapped == mapping:
        return None
    return json.dumps(remapped, ensure_ascii=False)


def remap_identity_markers(text: str | None, old_name: str, new_name: str) -> str | None:
    """改写 ``visual_description`` 里的 ``{{角色名_身份名}}`` marker。

    marker 是分镜和上色链路的锚点（见 ``models.extract_char_identities_from_markers``）：
    文本里还写着旧角色名，检出的 identity 就和身份表对不上，颜色分配整条链断掉。
    """

    value = str(text or "")
    if not value:
        return None
    pattern = re.compile(r"\{\{" + re.escape(old_name) + r"(_[^}]*)?\}\}")

    def _sub(match: re.Match[str]) -> str:
        return "{{" + new_name + (match.group(1) or "") + "}}"

    remapped = pattern.sub(_sub, value)
    return remapped if remapped != value else None

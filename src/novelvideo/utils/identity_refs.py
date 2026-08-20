"""角色改名时，散在各处的 identity_id 引用怎么跟着改。

``identity_id`` 的格式是 ``<角色名>_<身份名>``，角色名嵌在里面，所以角色一改名，所有
落库的 identity_id 就同时失效——身份图找不到、sketch 颜色分配对不上、分镜 marker 检出
的身份不在身份表里。

引用散得比想象中广。下面这份清单是把建表 SQL 里每一列都过了一遍数出来的——上一轮
只补了 review 点名的几列，结果 ``prop_menu_json`` 整个漏掉，又被打回来一次。改这块
之前请先回去核对 ``SQLITE_SCHEMA_SQL``，别再照着直觉补。

**每条后面的括号是这个语义的出处，补新列时请一并带上。** ``_cascade_character_rename``
明说要拿这份清单当权威依据，所以一条没核过就写下的语义，下一轮会变成别人信任的前提：
``beats.speaker`` 曾被想当然地记成「角色名」，级联就照着写了 ``== old_name``，实际值
``林/小满_casual`` 整个迁不到——错的是这行注释，不是那次实现。

- ``episodes.character_names`` —— 角色名数组（``Episode.character_names``「出场角色名称」）
- ``episodes.identity_ids`` —— identity_id 数组（``Episode.identity_ids``，
  例 ``['苏清晏_嫡女日常']``）
- ``episodes.identity_default_map_json`` —— ``{角色名: identity_id}``，键和值都嵌
  （例 ``{"杜晨": "杜晨_中年时期"}``；``literal_script_writing`` 拿角色名取键）
- ``episodes.sketch_colors_json`` —— ``{identity_id: 颜色}``，只有键嵌
  （例 ``{"苏清晏_嫡女日常": "red"}``）
- ``episodes.prop_menu_json`` —— 数组里每项的 ``owner_identity_id``
  （``PropMenuItem.owner_identity_id``「所属角色身份 ID」）
- ``beats.detected_identities_json`` —— identity_id 数组
  （``models.real_detected_identities``「concrete identity IDs」）
- ``beats.visual_description`` —— ``{{角色名_身份名}}`` 文本 marker。花括号里通常是
  identity_id（``models.extract_char_identities_from_markers`` 只把落在
  ``identity.identity_id`` 集合里的 marker 算作检出身份），但裸 ``{{角色名}}`` 也确实
  存在（``freezone.slots`` 两种都匹配），所以 ``remap_identity_markers`` 的正则把
  ``_身份名`` 后缀设成可选
- ``beats.speaker`` —— **identity_id**，仅当 ``speaker_kind`` 为 ``character``。
  ``BeatUpdate.speaker`` 标的是「说话人身份ID」，``resolve_dialogue_reference_audio``
  和 ``indextts2_beat_audio_task`` 都是 ``speaker.startswith(角色名)`` 之后再
  ``identity.identity_id == speaker`` 精确配。裸角色名、以及群众/路人的普通标签属于
  存量兼容（``Beat.speaker``「主角色可用 identity_id，群众/路人可用普通标签」），
  ``remap_identity_id`` 两种都照顾得到，所以走它、别拿 ``== old_name`` 比
- ``props.owner`` —— 角色名**或** identity_id，两种都有：字段声明写的是「所属角色名」，
  而 ``prop_promotion_service`` 把菜单项提升成全局道具时是把 ``owner_identity_id``
  原样抄进来的
- ``seedance2_voice_audio_records.speaker`` —— **identity_id**，和 ``beats.speaker``
  同一个契约（``voice_audio_task`` 拿 beat 的 speaker 一路传下来写进这张表），
  还是主键的一部分

明确**不**在清单里的：``episodes.scene_menu_json``（只有场景 ID）、
``beats.detected_props_json``（只有道具 ID）、``director_world`` 那张跨项目共享的全局
道具表（一个项目改名不该改写共享库）。

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


def remap_object_field(
    raw_json: str | None, field: str, old_name: str, new_name: str
) -> str | None:
    """重映射 ``[{...}, ...]`` 里每个对象的某个字段（``prop_menu_json.owner_identity_id``）。

    只动指定字段，同一个对象里的 ``prop_id`` / ``visual_prompt`` 原样保留——道具菜单项
    里除了 owner 之外没有别的东西嵌角色名。
    """

    try:
        items = json.loads(raw_json or "[]")
    except (TypeError, ValueError):
        return None
    if not isinstance(items, list):
        return None
    remapped: list[Any] = []
    for item in items:
        if not isinstance(item, dict) or field not in item:
            remapped.append(item)
            continue
        updated = dict(item)
        updated[field] = remap_identity_id(item[field], old_name, new_name)
        remapped.append(updated)
    if remapped == items:
        return None
    return json.dumps(remapped, ensure_ascii=False)


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

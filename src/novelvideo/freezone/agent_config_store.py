"""User-scoped Freezone agent configuration storage."""

from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Literal

from novelvideo.config import OUTPUT_DIR
from novelvideo.freezone.agent_catalog_schema import (
    SAFE_AGENT_CONFIG_ID,
    validate_agent_config_item,
)

AgentConfigKind = Literal["skills", "recipes"]

BUILTIN_AGENT_CATALOG_DIR = Path(__file__).with_name("agent_catalog") / "builtins"
PROJECT_AGENT_CATALOG_DIR = (
    Path(__file__).resolve().parents[3] / ".hermes" / "plugins" / "freezone" / "catalog"
)
_CATALOG_CACHE: dict[tuple[str, str, tuple, tuple], list[dict]] = {}
_STORED_METADATA_PREFIXES = ("_catalog_bundle_",)


def builtin_agent_catalog_dir(kind: AgentConfigKind | str) -> Path:
    checked_kind = _validate_kind(kind)
    return BUILTIN_AGENT_CATALOG_DIR / checked_kind


def project_agent_catalog_dir(kind: AgentConfigKind | str) -> Path:
    checked_kind = _validate_kind(kind)
    return PROJECT_AGENT_CATALOG_DIR / checked_kind


def user_agent_config_dir(username: str, kind: AgentConfigKind | str) -> Path:
    checked_kind = _validate_kind(kind)
    return (
        Path(OUTPUT_DIR)
        / username
        / "_account"
        / "freezone"
        / "agent_config"
        / checked_kind
    )


def list_user_agent_config_items(
    username: str, kind: AgentConfigKind | str
) -> list[dict]:
    checked_kind = _validate_kind(kind)
    builtin_root = builtin_agent_catalog_dir(checked_kind)
    project_root = project_agent_catalog_dir(checked_kind)
    user_root = user_agent_config_dir(username, checked_kind)
    cache_key = (
        username,
        checked_kind,
        _directory_signature(builtin_root),
        _directory_signature(project_root),
        _directory_signature(user_root),
    )
    cached = _CATALOG_CACHE.get(cache_key)
    if cached is not None:
        return deepcopy(cached)

    builtin_items_by_id: dict[str, dict] = {}
    for payload in _read_agent_config_items(builtin_root):
        item_id = str(payload["id"])
        builtin_items_by_id[item_id] = payload
    for payload in _read_agent_config_items(project_root):
        item_id = str(payload["id"])
        builtin_items_by_id[item_id] = payload

    user_items_by_id = {
        str(payload["id"]): payload for payload in _read_agent_config_items(user_root)
    }
    user_items: list[dict] = []
    for item_id in sorted(user_items_by_id):
        user_payload = user_items_by_id[item_id]
        if user_payload.get("hidden") is True:
            continue
        builtin_payload = builtin_items_by_id.get(item_id)
        if builtin_payload is not None:
            merged_payload = {**builtin_payload, **user_payload}
            merged_payload["_catalog_source"] = "user"
            merged_payload["_catalog_base_source"] = "builtin"
            user_items.append(merged_payload)
            continue
        user_payload.setdefault("_catalog_source", "user")
        user_items.append(user_payload)
    user_items.sort(key=_user_agent_config_sort_key)

    builtin_items = [
        {**builtin_items_by_id[item_id], "_catalog_source": "builtin"}
        for item_id in sorted(builtin_items_by_id)
        if item_id not in user_items_by_id
    ]
    items = [*user_items, *builtin_items]
    _CATALOG_CACHE.clear()
    _CATALOG_CACHE[cache_key] = deepcopy(items)
    return items


def save_user_agent_config_item(
    *,
    username: str,
    kind: AgentConfigKind | str,
    payload: dict,
) -> dict:
    checked_kind = _validate_kind(kind)
    item_id = _validate_item_id(str(payload.get("id") or ""))
    root = user_agent_config_dir(username, checked_kind)
    root.mkdir(parents=True, exist_ok=True)
    stored_metadata = _stored_metadata(payload)
    payload_without_response_metadata = _strip_response_metadata(payload)
    stored_payload = validate_agent_config_item(
        checked_kind,
        _strip_stored_metadata(payload_without_response_metadata),
    )
    if checked_kind == "skills" and stored_payload.get("enabled") is not False:
        _validate_skill_recipe_references(username, stored_payload)
    stored_payload.update(stored_metadata)

    target = root / f"{item_id}.json"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(stored_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, target)
    _CATALOG_CACHE.clear()
    return stored_payload


def delete_user_agent_config_item(
    *,
    username: str,
    kind: AgentConfigKind | str,
    item_id: str,
) -> bool:
    checked_id = _validate_item_id(item_id)
    checked_kind = _validate_kind(kind)
    if checked_kind == "recipes":
        referencing_skills = _recipe_referencing_skill_ids(username, checked_id)
        if referencing_skills:
            raise ValueError(
                f"recipe {checked_id} is referenced by skill(s): "
                + ", ".join(referencing_skills)
            )
    user_root = user_agent_config_dir(username, checked_kind)
    target = user_root / f"{checked_id}.json"
    if _builtin_agent_config_exists(checked_kind, checked_id):
        user_root.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps({"id": checked_id, "hidden": True}, ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, target)
        _CATALOG_CACHE.clear()
        return True
    if not target.exists():
        return False
    target.unlink()
    _CATALOG_CACHE.clear()
    return True


def _validate_kind(kind: AgentConfigKind | str) -> AgentConfigKind:
    if kind in {"skills", "recipes"}:
        return kind  # type: ignore[return-value]
    raise ValueError("invalid agent config kind")


def _validate_item_id(item_id: str) -> str:
    if not SAFE_AGENT_CONFIG_ID.fullmatch(item_id):
        raise ValueError("invalid agent config id")
    return item_id


def _read_agent_config_items(root: Path) -> list[dict]:
    if not root.exists():
        return []

    items: list[dict] = []
    for path in sorted(root.glob("*.json"), key=lambda item: item.name):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        payloads = payload if isinstance(payload, list) else [payload]
        for item in payloads:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or not SAFE_AGENT_CONFIG_ID.fullmatch(
                item_id
            ):
                continue
            if item.get("hidden") is True:
                items.append({"id": item_id, "hidden": True})
                continue
            try:
                stored_metadata = _stored_metadata(item)
                item = validate_agent_config_item(
                    _kind_from_dir(root),
                    _strip_stored_metadata(item),
                )
                item.update(stored_metadata)
            except ValueError:
                continue
            try:
                item["_catalog_updated_at"] = path.stat().st_mtime
            except OSError:
                item["_catalog_updated_at"] = 0
            items.append(item)
    return items


def _directory_signature(root: Path) -> tuple:
    if not root.exists():
        return (str(root), "missing")
    if not root.is_dir():
        return (str(root), "not-dir")
    files: list[tuple[str, int, int]] = []
    for path in sorted(root.glob("*.json"), key=lambda item: item.name):
        try:
            stat = path.stat()
        except OSError:
            continue
        files.append((path.name, stat.st_mtime_ns, stat.st_size))
    return (str(root), tuple(files))


def _builtin_agent_config_exists(kind: AgentConfigKind, item_id: str) -> bool:
    return any(
        str(payload.get("id") or "") == item_id
        for root in (builtin_agent_catalog_dir(kind), project_agent_catalog_dir(kind))
        for payload in _read_agent_config_items(root)
    )


def _validate_skill_recipe_references(username: str, skill: dict) -> None:
    available_recipe_ids = {
        str(item.get("id") or "").strip()
        for item in list_user_agent_config_items(username, "recipes")
        if item.get("enabled") is not False
    }
    requested_recipe_ids = {
        str(item or "").strip()
        for item in skill.get("allowed_recipe_ids") or []
        if str(item or "").strip()
    }
    missing = sorted(requested_recipe_ids - available_recipe_ids)
    if missing:
        raise ValueError(
            f"skill {skill.get('id')} references unavailable recipe(s): "
            + ", ".join(missing)
        )


def _recipe_referencing_skill_ids(username: str, recipe_id: str) -> list[str]:
    return sorted(
        str(skill.get("id") or "").strip()
        for skill in list_user_agent_config_items(username, "skills")
        if skill.get("enabled") is not False
        if recipe_id
        in {
            str(item or "").strip()
            for item in skill.get("allowed_recipe_ids") or []
            if str(item or "").strip()
        }
        and str(skill.get("id") or "").strip()
    )


def _strip_response_metadata(payload: dict) -> dict:
    return {
        key: value for key, value in payload.items() if not key.startswith("_catalog_")
    }


def _kind_from_dir(root: Path) -> AgentConfigKind:
    return _validate_kind(root.name)


def _stored_metadata(payload: dict) -> dict:
    return {
        key: value
        for key, value in payload.items()
        if any(key.startswith(prefix) for prefix in _STORED_METADATA_PREFIXES)
    }


def _strip_stored_metadata(payload: dict) -> dict:
    return {
        key: value
        for key, value in payload.items()
        if not any(key.startswith(prefix) for prefix in _STORED_METADATA_PREFIXES)
    }


def _user_agent_config_sort_key(payload: dict) -> tuple[int, float, str]:
    priority = 1 if payload.get("_catalog_base_source") == "builtin" else 0
    updated_at = payload.get("_catalog_updated_at")
    if not isinstance(updated_at, int | float):
        updated_at = 0
    item_id = str(payload.get("id") or "")
    return (priority, -float(updated_at), item_id)

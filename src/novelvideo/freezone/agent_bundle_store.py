"""Install and export user-scoped Freezone community Skill Bundles."""

from __future__ import annotations

from copy import deepcopy
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from novelvideo.freezone.agent_bundle_schema import (
    BUNDLE_SCHEMA_VERSION,
    normalize_agent_bundle,
    parse_semver,
)
from novelvideo.freezone.agent_config_store import (
    list_user_agent_config_items,
    save_user_agent_config_item,
)

CURRENT_DRAMACLAW_VERSION = "1.1.2"


def current_dramaclaw_version() -> str:
    try:
        return version("supertale-ce")
    except PackageNotFoundError:
        return CURRENT_DRAMACLAW_VERSION


def validate_agent_bundle(payload: dict[str, Any], *, username: str | None = None) -> dict[str, Any]:
    bundle = normalize_agent_bundle(payload)
    _ensure_minimum_dramaclaw_version(bundle)
    return {
        "bundle": bundle,
        "bundle_id": bundle["id"],
        "skill_count": 1,
        "recipe_count": len(bundle["recipes"]),
        "warnings": [],
    }


def install_agent_bundle(*, username: str, payload: dict[str, Any]) -> dict[str, Any]:
    validated = validate_agent_bundle(payload, username=username)["bundle"]
    skill = {
        **validated["skill"],
        **_bundle_metadata_for_storage(validated),
    }
    recipes = list(validated["recipes"])
    _ensure_no_existing_skill_id(username, skill)
    resolved_recipes = _resolve_bundle_recipes(username=username, skill=skill, recipes=recipes)
    skill = resolved_recipes["skill"]

    saved_recipes: list[str] = []
    for recipe in resolved_recipes["recipes_to_install"]:
        saved = save_user_agent_config_item(username=username, kind="recipes", payload=recipe)
        saved_recipes.append(str(saved["id"]))
    saved_skill = save_user_agent_config_item(username=username, kind="skills", payload=skill)
    return {
        "bundle_id": validated["id"],
        "installed_skill": str(saved_skill["id"]),
        "installed_recipes": saved_recipes,
        "reused_recipes": resolved_recipes["reused_recipes"],
    }


def export_agent_bundle(
    *,
    username: str,
    skill_id: str,
    bundle_meta: dict[str, Any],
    include_recipes: bool = True,
) -> dict[str, Any]:
    skill = _find_existing_item(username, "skills", skill_id)
    recipes: list[dict[str, Any]] = []
    if include_recipes:
        for recipe_id in skill.get("allowed_recipe_ids") or []:
            recipes.append(_find_existing_item(username, "recipes", str(recipe_id)))

    bundle = {
        "schema_version": BUNDLE_SCHEMA_VERSION,
        "id": _bundle_meta_value(skill, bundle_meta, "id") or skill["id"],
        "name": _bundle_meta_value(skill, bundle_meta, "name") or skill.get("name") or skill["id"],
        "version": _bundle_meta_value(skill, bundle_meta, "version") or skill.get("version") or "1.0.0",
        "description": _bundle_meta_value(skill, bundle_meta, "description") or skill.get("description") or "",
        "author": _bundle_meta_value(skill, bundle_meta, "author") or _default_bundle_author(
            skill,
            username=username,
        ),
        "license": _bundle_meta_value(skill, bundle_meta, "license") or "Proprietary",
        "min_dramaclaw_version": _bundle_meta_value(skill, bundle_meta, "min_dramaclaw_version")
        or current_dramaclaw_version(),
        "tags": _bundle_meta_tags(skill, bundle_meta),
        "skill": _strip_catalog_metadata(skill),
        "recipes": [_strip_catalog_metadata(recipe) for recipe in recipes],
    }
    legal = _bundle_meta_legal(skill, bundle_meta)
    if legal is not None:
        bundle["legal"] = legal
    return validate_agent_bundle(bundle, username=username)["bundle"]


def _ensure_minimum_dramaclaw_version(bundle: dict[str, Any]) -> None:
    minimum = str(bundle["min_dramaclaw_version"])
    current = current_dramaclaw_version()
    if parse_semver(current) < parse_semver(minimum):
        raise ValueError(f"Bundle requires DramaClaw >= {minimum}; current version is {current}")


def _ensure_no_existing_skill_id(username: str, skill: dict[str, Any]) -> None:
    existing_skills = {str(item["id"]) for item in list_user_agent_config_items(username, "skills")}
    skill_id = str(skill["id"])
    if skill_id in existing_skills:
        raise ValueError(f"Bundle item already exists: skills/{skill_id}")


def _resolve_bundle_recipes(
    *,
    username: str,
    skill: dict[str, Any],
    recipes: list[dict[str, Any]],
) -> dict[str, Any]:
    skill_id = str(skill["id"])
    existing_recipes = {
        str(item["id"]): item for item in list_user_agent_config_items(username, "recipes")
    }
    reserved_recipes = dict(existing_recipes)
    recipes_to_install: list[dict[str, Any]] = []
    reused_recipes: list[str] = []
    recipe_id_map: dict[str, str] = {}

    for recipe in recipes:
        original_id = str(recipe["id"])
        resolved_id = _resolve_recipe_install_id(
            skill_id=skill_id,
            recipe=recipe,
            existing_recipes=reserved_recipes,
        )
        recipe_id_map[original_id] = resolved_id
        if resolved_id in existing_recipes:
            reused_recipes.append(resolved_id)
            continue
        install_recipe = deepcopy(recipe)
        install_recipe["id"] = resolved_id
        recipes_to_install.append(install_recipe)
        reserved_recipes[resolved_id] = install_recipe

    resolved_skill = deepcopy(skill)
    resolved_skill["allowed_recipe_ids"] = [
        recipe_id_map.get(str(recipe_id), str(recipe_id))
        for recipe_id in resolved_skill.get("allowed_recipe_ids") or []
    ]
    return {
        "skill": resolved_skill,
        "recipes_to_install": recipes_to_install,
        "reused_recipes": reused_recipes,
    }


def _resolve_recipe_install_id(
    *,
    skill_id: str,
    recipe: dict[str, Any],
    existing_recipes: dict[str, dict[str, Any]],
) -> str:
    original_id = str(recipe["id"])
    original_recipe = existing_recipes.get(original_id)
    if original_recipe is None or _same_recipe_content(original_recipe, recipe):
        return original_id

    renamed_base = f"{original_id}--{skill_id}"
    candidate = renamed_base
    suffix = 2
    while True:
        existing_recipe = existing_recipes.get(candidate)
        if existing_recipe is None or _same_recipe_content(existing_recipe, recipe):
            return candidate
        candidate = f"{renamed_base}-{suffix}"
        suffix += 1


def _same_recipe_content(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_content = _recipe_content_for_compare(left)
    right_content = _recipe_content_for_compare(right)
    return left_content == right_content


def _recipe_content_for_compare(payload: dict[str, Any]) -> dict[str, Any]:
    content = _strip_catalog_metadata(payload)
    content.pop("id", None)
    return content


def _find_existing_item(username: str, kind: str, item_id: str) -> dict[str, Any]:
    for item in list_user_agent_config_items(username, kind):
        if str(item.get("id") or "") == item_id:
            return item
    raise ValueError(f"{kind.rstrip('s')} not found: {item_id}")


def _strip_catalog_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if not key.startswith("_catalog_")}


def _bundle_metadata_for_storage(bundle: dict[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for key in (
        "id",
        "name",
        "version",
        "description",
        "author",
        "license",
        "min_dramaclaw_version",
    ):
        value = bundle.get(key)
        if isinstance(value, str) and value.strip():
            metadata[f"_catalog_bundle_{key}"] = value.strip()
    tags = bundle.get("tags")
    if isinstance(tags, list):
        clean_tags = [item.strip() for item in tags if isinstance(item, str) and item.strip()]
        if clean_tags:
            metadata["_catalog_bundle_tags"] = clean_tags
    legal = bundle.get("legal")
    if isinstance(legal, dict):
        metadata["_catalog_bundle_legal"] = deepcopy(legal)
    return metadata


def _bundle_meta_value(skill: dict[str, Any], bundle_meta: dict[str, Any], key: str) -> str:
    stored = skill.get(f"_catalog_bundle_{key}")
    if isinstance(stored, str) and stored.strip():
        return stored.strip()
    incoming = bundle_meta.get(key)
    if isinstance(incoming, str) and incoming.strip():
        return incoming.strip()
    return ""


def _bundle_meta_tags(skill: dict[str, Any], bundle_meta: dict[str, Any]) -> list[str]:
    stored_tags = skill.get("_catalog_bundle_tags")
    if isinstance(stored_tags, list):
        clean_stored = [item.strip() for item in stored_tags if isinstance(item, str) and item.strip()]
        if clean_stored:
            return clean_stored
    incoming_tags = bundle_meta.get("tags")
    if isinstance(incoming_tags, list):
        return [item.strip() for item in incoming_tags if isinstance(item, str) and item.strip()]
    return []


def _bundle_meta_legal(skill: dict[str, Any], bundle_meta: dict[str, Any]) -> dict[str, Any] | None:
    stored = skill.get("_catalog_bundle_legal")
    if isinstance(stored, dict):
        return deepcopy(stored)
    incoming = bundle_meta.get("legal")
    if isinstance(incoming, dict):
        return deepcopy(incoming)
    return None


def _default_bundle_author(skill: dict[str, Any], *, username: str) -> str:
    if skill.get("_catalog_source") == "builtin":
        return "DramaClaw"
    return username.strip() or "DramaClaw User"

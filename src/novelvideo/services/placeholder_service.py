"""Helpers for resolving and replacing script identity placeholders."""

from __future__ import annotations

import re
from typing import Any


async def resolve_character_names(
    char_id_map: dict[str, str],
    cognee_store: Any,
) -> dict[str, str]:
    """Resolve character aliases to display names through a project store."""
    name_map: dict[str, str] = {}
    if not char_id_map or not cognee_store:
        return name_map

    for alias in char_id_map.keys():
        try:
            char = await cognee_store.get_character_from_graph(alias)
            if char and hasattr(char, "name"):
                name_map[alias] = char.name
            else:
                name_map[alias] = alias
        except Exception as exc:
            print(f"[resolve_character_names] Failed to fetch character '{alias}': {exc}", flush=True)
            name_map[alias] = alias

    return name_map


def replace_placeholders_with_names(
    text: str,
    name_map: dict[str, str],
    language: str = "zh",
    identity_to_name: dict[str, str] | None = None,
) -> str:
    """Replace {{alias}} or {{identity_id}} placeholders with display names."""
    if not text:
        return text

    result = text
    for alias, real_name in name_map.items():
        result = result.replace(f"{{{{{alias}}}}}", real_name)

    if identity_to_name:
        for identity_id, real_name in identity_to_name.items():
            result = result.replace(f"{{{{{identity_id}}}}}", real_name)

    fallback = "角色" if language == "zh" else "the character"
    return re.sub(r"\{\{[^}]+\}\}", fallback, result)


__all__ = ["replace_placeholders_with_names", "resolve_character_names"]

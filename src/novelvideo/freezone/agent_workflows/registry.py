"""Agent-neutral access to the shared Freezone Skill and Recipe registry."""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any, Literal

from novelvideo.freezone.agent_config_store import list_user_agent_config_items

CatalogKind = Literal["skills", "recipes"]
_TOKEN_RE = re.compile(r"[\w\u4e00-\u9fff-]+", re.UNICODE)


def _public_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        key: deepcopy(value)
        for key, value in item.items()
        if not str(key).startswith("_")
    }


def _summary(kind: CatalogKind, item: dict[str, Any]) -> dict[str, Any]:
    base = {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or item.get("id") or ""),
        "version": item.get("version"),
        "description": str(item.get("description") or ""),
    }
    if kind == "skills":
        return {
            **base,
            "category": item.get("category"),
            "keywords": list((item.get("triggers") or {}).get("keywords") or []),
            "allowed_recipe_ids": list(item.get("allowed_recipe_ids") or []),
        }
    return {
        **base,
        "output_kind": item.get("output_kind"),
        "requires_source_media": bool(item.get("requires_source_media")),
        "action_keys": list(item.get("action_keys") or []),
    }


def search_catalog(
    *,
    username: str,
    kind: CatalogKind,
    query: str = "",
    limit: int = 12,
) -> list[dict[str, Any]]:
    """Return deterministic compact results without loading Recipe prompt bodies."""

    normalized = str(query or "").strip().lower()
    tokens = _TOKEN_RE.findall(normalized)
    ranked: list[tuple[int, str, dict[str, Any]]] = []
    for item in list_user_agent_config_items(username, kind):
        if item.get("enabled") is False:
            continue
        summary = _summary(kind, item)
        haystack = " ".join(
            str(value)
            for value in (
                summary.get("id"),
                summary.get("name"),
                summary.get("description"),
                summary.get("category"),
                summary.get("output_kind"),
                " ".join(summary.get("keywords") or []),
                " ".join(summary.get("action_keys") or []),
            )
            if value
        ).lower()
        score = 1 if not tokens else sum(
            4 if token in str(summary.get("id") or "").lower() else 1
            for token in tokens
            if token in haystack
        )
        if score:
            ranked.append((score, str(summary.get("id") or ""), summary))
    ranked.sort(key=lambda entry: (-entry[0], entry[1]))
    return [entry[2] for entry in ranked[: max(1, min(int(limit), 50))]]


def get_catalog_item(
    *,
    username: str,
    kind: CatalogKind,
    item_id: str,
) -> dict[str, Any] | None:
    normalized_id = str(item_id or "").strip()
    if not normalized_id:
        return None
    for item in list_user_agent_config_items(username, kind):
        if str(item.get("id") or "") == normalized_id and item.get("enabled") is not False:
            return _public_item(item)
    return None

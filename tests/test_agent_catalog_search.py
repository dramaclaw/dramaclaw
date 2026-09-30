from __future__ import annotations

from novelvideo.freezone.agent_workflows import registry


def _recipe(
    item_id: str,
    *,
    name: str = "",
    description: str = "",
    enabled: bool = True,
    hidden: bool = False,
) -> dict:
    return {
        "id": item_id,
        "name": name or item_id,
        "description": description,
        "enabled": enabled,
        "hidden": hidden,
        "output_kind": "text",
        "action_keys": ["text.generate"],
    }


def test_preloaded_search_matches_catalog_api_and_reuses_index(monkeypatch) -> None:
    items = [
        _recipe("video-summary", name="Video summary", description="Summarize video"),
        _recipe("summary", name="Summary", description="Summarize a document"),
    ]
    monkeypatch.setattr(
        registry, "list_user_agent_config_items", lambda _username, _kind: items
    )

    expected = registry.search_catalog(
        username="alice", kind="recipes", query="summary", limit=12
    )
    indexed = registry.CatalogSearch(items, "recipes")

    assert registry.search_catalog_items(
        items=items, kind="recipes", query="summary", limit=12
    ) == expected
    assert indexed.search("summary", 12) == expected
    assert indexed.search("video", 12) == registry.search_catalog(
        username="alice", kind="recipes", query="video", limit=12
    )


def test_preloaded_search_excludes_disabled_and_hidden_items() -> None:
    items = [
        _recipe("visible", description="Translate text"),
        _recipe("disabled", description="Translate text", enabled=False),
        _recipe("hidden", description="Translate text", hidden=True),
    ]

    assert [item["id"] for item in registry.search_catalog_items(
        items=items, kind="recipes", query="translate", limit=12
    )] == ["visible"]


def test_preloaded_search_preserves_stable_order_and_limit_cap() -> None:
    items = [
        _recipe("z-first", description="Translate text"),
        _recipe("a-second", description="Translate text"),
    ]
    indexed = registry.CatalogSearch(items, "recipes")

    assert [item["id"] for item in indexed.search("translate", 50)] == [
        "a-second",
        "z-first",
    ]
    assert len(indexed.search(query="", limit=99)) == 2
    assert indexed.search(query="missing", limit=12) == []

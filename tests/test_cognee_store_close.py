import pytest
from importlib import import_module


@pytest.mark.asyncio
async def test_close_releases_cached_cognee_graph_engine(monkeypatch):
    from novelvideo.cognee.store import CogneeStore

    graph_config_module = import_module("cognee.infrastructure.databases.graph.config")
    graph_engine_module = import_module("cognee.infrastructure.databases.graph.get_graph_engine")

    calls = []

    class FakeSQLiteStore:
        async def close(self):
            calls.append("sqlite.close")

    class FakeGraphConnection:
        def close(self):
            calls.append("graph.connection.close")

    class FakeGraphDatabase:
        def close(self):
            calls.append("graph.db.close")

    class FakeGraphEngine:
        def __init__(self):
            self.connection = FakeGraphConnection()
            self.db = FakeGraphDatabase()

        def close(self):
            calls.append("graph.close")

    class FakeCachedFactory:
        def cache_clear(self):
            calls.append("graph.cache_clear")

    fake_engine = FakeGraphEngine()
    monkeypatch.setattr(
        graph_config_module,
        "get_graph_context_config",
        lambda: {"graph_database_provider": "kuzu", "graph_file_path": "/tmp/project.pkl"},
    )
    monkeypatch.setattr(
        graph_engine_module,
        "create_graph_engine",
        lambda **config: fake_engine,
    )
    monkeypatch.setattr(graph_engine_module, "_create_graph_engine", FakeCachedFactory())

    store = CogneeStore.__new__(CogneeStore)
    store._owns_sqlite_store = True
    store.sqlite_store = FakeSQLiteStore()

    await store.close()

    assert calls == [
        "sqlite.close",
        "graph.connection.close",
        "graph.db.close",
        "graph.close",
        "graph.cache_clear",
    ]


@pytest.mark.asyncio
async def test_graph_snapshot_is_bounded_ranked_and_json_safe(monkeypatch):
    from novelvideo.cognee.store import CogneeStore

    graph_module = import_module("cognee.infrastructure.databases.graph")

    class FakeGraphEngine:
        async def get_graph_data(self):
            return (
                [
                    ("chunk", {"name": "原文章节", "type": "DocumentChunk", "embedding": [1, 2]}),
                    ("hero", {"name": "林昭", "type": "Entity", "description": "主角"}),
                    ("place", {"name": "雨巷", "type": "Entity"}),
                ],
                [
                    ("hero", "place", "appears_in", {}),
                    ("hero", "chunk", "mentioned_in", {"weight": 0.9}),
                ],
            )

    async def fake_get_graph_engine():
        return FakeGraphEngine()

    monkeypatch.setattr(graph_module, "get_graph_engine", fake_get_graph_engine)

    store = CogneeStore.__new__(CogneeStore)
    store._set_cognee_context = lambda: None
    snapshot = await store.get_graph_snapshot(max_nodes=20)

    assert snapshot["total_nodes"] == 3
    assert snapshot["total_edges"] == 2
    assert snapshot["nodes"][0]["label"] == "林昭"
    chunk = next(node for node in snapshot["nodes"] if node["id"] == "chunk")
    assert "embedding" not in chunk["properties"]

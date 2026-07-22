import pytest
from importlib import import_module
from types import SimpleNamespace


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

    async def fake_get_dataset_graph_data():
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

    store = CogneeStore.__new__(CogneeStore)
    store._get_dataset_graph_data = fake_get_dataset_graph_data
    snapshot = await store.get_graph_snapshot(max_nodes=20)

    assert snapshot["total_nodes"] == 3
    assert snapshot["total_edges"] == 2
    assert snapshot["nodes"][0]["label"] == "林昭"
    chunk = next(node for node in snapshot["nodes"] if node["id"] == "chunk")
    assert "embedding" not in chunk["properties"]


@pytest.mark.asyncio
async def test_graph_snapshot_reads_the_project_dataset_database(monkeypatch):
    from novelvideo.cognee.store import CogneeStore

    context_module = import_module("cognee.context_global_variables")
    graph_module = import_module("cognee.infrastructure.databases.graph")
    data_methods = import_module("cognee.modules.data.methods")
    user_methods = import_module("cognee.modules.users.methods")
    calls = []
    user = SimpleNamespace(id="user-id")
    dataset = SimpleNamespace(id="dataset-id", owner_id="owner-id")

    class FakeDatasetContext:
        async def __aenter__(self):
            calls.append("context.enter")

        async def __aexit__(self, exc_type, exc, tb):
            calls.append("context.exit")

    class FakeGraphEngine:
        async def get_graph_data(self):
            calls.append("graph.read")
            return [("hero", {"name": "林昭", "type": "Entity"})], []

    async def fake_get_default_user():
        return user

    async def fake_get_datasets_by_name(name, user_id):
        calls.append(("dataset.lookup", name, user_id))
        return [dataset]

    async def fake_get_graph_engine():
        return FakeGraphEngine()

    monkeypatch.setattr(user_methods, "get_default_user", fake_get_default_user)
    monkeypatch.setattr(data_methods, "get_datasets_by_name", fake_get_datasets_by_name)
    monkeypatch.setattr(
        context_module,
        "set_database_global_context_variables",
        lambda dataset_id, owner_id: (
            calls.append(("context.create", dataset_id, owner_id)) or FakeDatasetContext()
        ),
    )
    monkeypatch.setattr(graph_module, "get_graph_engine", fake_get_graph_engine)

    store = CogneeStore.__new__(CogneeStore)
    store.dataset_name = "novelvideo_local/test"
    store._set_cognee_context = lambda: calls.append("project.context")

    nodes, edges = await store._get_dataset_graph_data()

    assert nodes[0][1]["name"] == "林昭"
    assert edges == []
    assert calls == [
        "project.context",
        ("dataset.lookup", "novelvideo_local/test", "user-id"),
        ("context.create", "dataset-id", "owner-id"),
        "context.enter",
        "graph.read",
        "context.exit",
    ]

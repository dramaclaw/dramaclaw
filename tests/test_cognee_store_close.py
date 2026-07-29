import asyncio
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from threading import Event
from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_store_close_only_releases_owned_sqlite_store():
    from novelvideo.cognee.store import CogneeStore

    calls = []

    class FakeSQLiteStore:
        async def close(self):
            calls.append("sqlite.close")

    store = CogneeStore.__new__(CogneeStore)
    store._owns_sqlite_store = True
    store.sqlite_store = FakeSQLiteStore()

    await store.close()

    assert calls == ["sqlite.close"]


@pytest.mark.asyncio
async def test_cached_ladybug_adapter_switches_between_read_only_and_writer(tmp_path):
    from cognee.infrastructure.databases.graph.ladybug.adapter import LadybugAdapter
    from ladybug import Connection
    from ladybug.database import Database
    from novelvideo.cognee.ladybug_access import ladybug_graph_access

    database_path = tmp_path / "graph.lbdb"
    database = Database(str(database_path))
    connection = Connection(database)
    connection.execute(
        "CREATE NODE TABLE Node(id STRING PRIMARY KEY, name STRING, type STRING, "
        "created_at TIMESTAMP, updated_at TIMESTAMP, properties STRING)"
    )
    connection.execute(
        "CREATE REL TABLE EDGE(FROM Node TO Node, relationship_name STRING, "
        "created_at TIMESTAMP, updated_at TIMESTAMP, properties STRING)"
    )
    connection.execute(
        "CREATE (:Node {id: '1', name: 'Alice', type: 'person', properties: '{}'});"
    )
    connection.close()
    database.close()

    adapter = None
    try:
        async with ladybug_graph_access(str(tmp_path), read_only=True):
            adapter = LadybugAdapter(str(database_path))
            results = await asyncio.gather(
                *(adapter.query("MATCH (n:Node) RETURN n.name") for _ in range(4))
            )
            assert results == [[("Alice",)]] * 4
            assert adapter.db.read_only is True
        assert adapter.db is None

        async with ladybug_graph_access(str(tmp_path), read_only=False):
            await adapter.query(
                "CREATE (:Node {id: '2', name: 'Bob', type: 'person', properties: '{}'});"
            )
            assert adapter.db.read_only is False
        assert adapter.db is None

        async with ladybug_graph_access(str(tmp_path), read_only=True):
            assert await adapter.query(
                "MATCH (n:Node) RETURN n.name ORDER BY n.name"
            ) == [("Alice",), ("Bob",)]
        assert adapter.db is None

        with pytest.raises(RuntimeError, match="explicit ladybug_graph_access scope"):
            await adapter.query("MATCH (n:Node) RETURN n.name")
    finally:
        if adapter is not None:
            adapter.close()
            adapter.executor.shutdown(wait=True)


@pytest.mark.asyncio
async def test_ladybug_nested_scope_rejects_different_project(tmp_path):
    from novelvideo.cognee.ladybug_access import ladybug_graph_access

    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"

    async with ladybug_graph_access(str(project_a), read_only=True):
        # Equivalent paths for the same project may safely reuse the scope.
        async with ladybug_graph_access(
            str(project_a / ".." / "project-a"),
            read_only=True,
        ):
            pass

        with pytest.raises(RuntimeError, match="different project"):
            async with ladybug_graph_access(str(project_b), read_only=True):
                pass


@pytest.mark.asyncio
@pytest.mark.parametrize("read_only", [True, False])
async def test_ladybug_query_cancellation_keeps_database_and_lock_until_native_query_stops(
    tmp_path,
    read_only,
):
    from cognee.infrastructure.databases.graph.ladybug.adapter import LadybugAdapter
    from ladybug import Connection
    from ladybug.database import Database
    from novelvideo.cognee.ladybug_access import ladybug_graph_access
    from novelvideo.graph_preview import (
        acquire_graph_preview_lock_async,
        release_graph_preview_lock,
    )

    database_path = tmp_path / "graph.lbdb"
    database = Database(str(database_path))
    connection = Connection(database)
    connection.execute(
        "CREATE NODE TABLE Node(id STRING PRIMARY KEY, name STRING, type STRING, "
        "created_at TIMESTAMP, updated_at TIMESTAMP, properties STRING)"
    )
    connection.execute(
        "CREATE REL TABLE EDGE(FROM Node TO Node, relationship_name STRING, "
        "created_at TIMESTAMP, updated_at TIMESTAMP, properties STRING)"
    )
    connection.execute(
        "CREATE (:Node {id: '1', name: 'Alice', type: 'person', properties: '{}'});"
    )
    connection.close()
    database.close()

    adapter = None
    query_task = None
    conflicting_lock_task = None
    conflicting_lock = None
    started = Event()
    release_query = Event()
    gated_executor = ThreadPoolExecutor(max_workers=1)

    def gated_submit(function, *args, **kwargs):
        def run():
            started.set()
            assert release_query.wait(timeout=5)
            return function(*args, **kwargs)

        return original_submit(run)

    original_submit = gated_executor.submit
    gated_executor.submit = gated_submit

    try:
        async with ladybug_graph_access(str(tmp_path), read_only=True):
            adapter = LadybugAdapter(str(database_path))
        adapter.executor.shutdown(wait=True)
        adapter.executor = gated_executor

        async def run_query():
            async with ladybug_graph_access(str(tmp_path), read_only=read_only):
                return await adapter.query("MATCH (n:Node) RETURN n.name")

        query_task = asyncio.create_task(run_query())
        assert await asyncio.to_thread(started.wait, 2)

        query_task.cancel()
        conflicting_lock_task = asyncio.create_task(
            acquire_graph_preview_lock_async(
                str(tmp_path),
                shared=not read_only,
            )
        )
        await asyncio.sleep(0.1)
        assert not query_task.done()
        assert not conflicting_lock_task.done()
        assert adapter.db is not None

        release_query.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(query_task, timeout=2)
        assert adapter.db is None

        conflicting_lock = await asyncio.wait_for(conflicting_lock_task, timeout=2)
    finally:
        release_query.set()
        if conflicting_lock is not None:
            release_graph_preview_lock(conflicting_lock)
        if conflicting_lock_task is not None and not conflicting_lock_task.done():
            conflicting_lock_task.cancel()
            await asyncio.gather(conflicting_lock_task, return_exceptions=True)
        if query_task is not None and not query_task.done():
            query_task.cancel()
            await asyncio.gather(query_task, return_exceptions=True)
        if adapter is not None:
            adapter.close()
        gated_executor.shutdown(wait=True)


@pytest.mark.asyncio
async def test_graph_snapshot_is_bounded_ranked_and_json_safe(monkeypatch):
    from novelvideo.cognee.store import CogneeStore

    async def fake_get_dataset_graph_data(**_kwargs):
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


@pytest.mark.asyncio
async def test_graph_existence_check_uses_lightweight_is_empty(monkeypatch):
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
        async def is_empty(self):
            calls.append("graph.is_empty")
            return False

        async def get_graph_data(self):
            raise AssertionError("full graph must not be loaded for ingest validation")

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

    assert await store._dataset_graph_has_nodes() is True
    assert calls == [
        "project.context",
        ("dataset.lookup", "novelvideo_local/test", "user-id"),
        ("context.create", "dataset-id", "owner-id"),
        "context.enter",
        "graph.is_empty",
        "context.exit",
    ]

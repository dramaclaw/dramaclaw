import asyncio
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from pathlib import Path
from threading import Barrier, Event, Lock
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
    from novelvideo.cognee.ladybug_access import (
        cognee_project_context,
        ladybug_graph_access,
    )

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

    with cognee_project_context(str(project_a)):
        with pytest.raises(RuntimeError, match="different project"):
            async with ladybug_graph_access(str(project_b), read_only=False):
                pass


@pytest.mark.asyncio
async def test_cognee_project_context_isolates_concurrent_project_configs(tmp_path):
    import cognee.context_global_variables as context_module
    from cognee.infrastructure.databases.relational.get_relational_engine import (
        get_relational_engine,
    )
    from novelvideo.cognee.ladybug_access import cognee_project_context

    release = asyncio.Event()
    ready = [asyncio.Event(), asyncio.Event()]

    async def inspect_project(index: int, state_dir: Path):
        with cognee_project_context(str(state_dir)):
            relational_getter = get_relational_engine.__globals__[
                "get_relational_config"
            ]
            first = (
                relational_getter().db_path,
                context_module.get_base_config().system_root_directory,
            )
            ready[index].set()
            await release.wait()
            second = (
                relational_getter().db_path,
                context_module.get_base_config().system_root_directory,
            )
            return first, second

    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"
    task_a = asyncio.create_task(inspect_project(0, project_a))
    task_b = asyncio.create_task(inspect_project(1, project_b))
    await ready[0].wait()
    await ready[1].wait()
    release.set()
    result_a, result_b = await asyncio.gather(task_a, task_b)

    expected_a = (
        str(project_a.resolve() / "cognee_system" / "databases"),
        str(project_a.resolve() / "cognee_system"),
    )
    expected_b = (
        str(project_b.resolve() / "cognee_system" / "databases"),
        str(project_b.resolve() / "cognee_system"),
    )
    assert result_a == (expected_a, expected_a)
    assert result_b == (expected_b, expected_b)


@pytest.mark.asyncio
async def test_cognee_relational_setup_is_physically_isolated_per_project(tmp_path):
    from cognee.modules.data.methods import get_datasets_by_name
    from cognee.modules.engine.operations.setup import setup
    from cognee.modules.pipelines.layers.resolve_authorized_user_datasets import (
        resolve_authorized_user_datasets,
    )
    from cognee.modules.users.methods import get_default_user
    from novelvideo.cognee.ladybug_access import cognee_project_context

    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"

    async def initialize_project(state_dir: Path, dataset_name: str) -> None:
        with cognee_project_context(str(state_dir)):
            await setup()
            await resolve_authorized_user_datasets(dataset_name)

    await asyncio.gather(
        initialize_project(project_a, "dataset-a"),
        initialize_project(project_b, "dataset-b"),
    )

    async def dataset_names(state_dir: Path) -> tuple[list, list]:
        with cognee_project_context(str(state_dir)):
            user = await get_default_user()
            return (
                await get_datasets_by_name("dataset-a", user.id),
                await get_datasets_by_name("dataset-b", user.id),
            )

    datasets_a, datasets_b = await dataset_names(project_a)
    assert len(datasets_a) == 1
    assert datasets_b == []

    datasets_a, datasets_b = await dataset_names(project_b)
    assert datasets_a == []
    assert len(datasets_b) == 1
    assert (project_a / "cognee_system" / "databases" / "cognee_db").is_file()
    assert (project_b / "cognee_system" / "databases" / "cognee_db").is_file()


@pytest.mark.asyncio
async def test_writer_for_one_project_does_not_block_or_retarget_other_project_read(
    tmp_path,
):
    import cognee.context_global_variables as context_module
    from cognee.infrastructure.databases.relational.get_relational_engine import (
        get_relational_engine,
    )
    from novelvideo.cognee.ladybug_access import ladybug_graph_access

    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"
    read_ready = asyncio.Event()
    writer_ready = asyncio.Event()
    read_checked = asyncio.Event()

    async def read_project_b():
        async with ladybug_graph_access(str(project_b), read_only=True):
            relational_getter = get_relational_engine.__globals__[
                "get_relational_config"
            ]
            first = (
                relational_getter().db_path,
                context_module.get_base_config().system_root_directory,
            )
            read_ready.set()
            await writer_ready.wait()
            second = (
                relational_getter().db_path,
                context_module.get_base_config().system_root_directory,
            )
            read_checked.set()
            return first, second

    async def write_project_a():
        await read_ready.wait()
        async with ladybug_graph_access(str(project_a), read_only=False):
            writer_ready.set()
            await read_checked.wait()

    read_task = asyncio.create_task(read_project_b())
    write_task = asyncio.create_task(write_project_a())
    result = await asyncio.wait_for(read_task, timeout=3)
    await asyncio.wait_for(write_task, timeout=3)

    expected = (
        str(project_b.resolve() / "cognee_system" / "databases"),
        str(project_b.resolve() / "cognee_system"),
    )
    assert result == (expected, expected)


def test_ladybug_reads_overlap_across_thread_event_loops(tmp_path):
    from novelvideo.cognee.ladybug_access import ladybug_graph_access

    entered = Barrier(2)

    def read_project(state_dir: Path) -> None:
        async def run() -> None:
            async with ladybug_graph_access(str(state_dir), read_only=True):
                entered.wait(timeout=3)

        asyncio.run(run())

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(read_project, tmp_path / "project-a"),
            executor.submit(read_project, tmp_path / "project-b"),
        ]
        for future in futures:
            future.result(timeout=5)


def test_ladybug_writers_serialize_across_thread_event_loops(tmp_path):
    from novelvideo.cognee.ladybug_access import ladybug_graph_access

    active = 0
    peak = 0
    counter_lock = Lock()

    def write_project(state_dir: Path) -> None:
        async def run() -> None:
            nonlocal active, peak
            async with ladybug_graph_access(str(state_dir), read_only=False):
                with counter_lock:
                    active += 1
                    peak = max(peak, active)
                await asyncio.sleep(0.08)
                with counter_lock:
                    active -= 1

        asyncio.run(run())

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(write_project, tmp_path / "project-a"),
            executor.submit(write_project, tmp_path / "project-b"),
        ]
        for future in futures:
            future.result(timeout=5)

    assert peak == 1


@pytest.mark.asyncio
async def test_ladybug_writer_error_releases_process_writer_lock(tmp_path):
    from novelvideo.cognee.ladybug_access import ladybug_graph_access

    with pytest.raises(RuntimeError, match="write failed"):
        async with ladybug_graph_access(
            str(tmp_path / "project-a"),
            read_only=False,
        ):
            raise RuntimeError("write failed")

    async with asyncio.timeout(2):
        async with ladybug_graph_access(
            str(tmp_path / "project-b"),
            read_only=False,
        ):
            pass


@pytest.mark.asyncio
async def test_project_context_restores_native_cognee_contextvars(tmp_path):
    import cognee.context_global_variables as context_module
    from novelvideo.cognee.ladybug_access import cognee_project_context

    outer_graph = {"graph_file_path": "outer"}
    outer_vector = {"vector_db_url": "outer"}
    outer_storage = {"data_root_directory": "outer"}
    graph_token = context_module.graph_db_config.set(outer_graph)
    vector_token = context_module.vector_db_config.set(outer_vector)
    storage_token = context_module.file_storage_config.set(outer_storage)
    try:
        with cognee_project_context(str(tmp_path)):
            assert context_module.graph_db_config.get() is None
            assert context_module.vector_db_config.get() is None
            assert context_module.file_storage_config.get() is None
            context_module.graph_db_config.set({"graph_file_path": "project"})
            context_module.vector_db_config.set({"vector_db_url": "project"})
            context_module.file_storage_config.set(
                {"data_root_directory": "project"}
            )

        assert context_module.graph_db_config.get() == outer_graph
        assert context_module.vector_db_config.get() == outer_vector
        assert context_module.file_storage_config.get() == outer_storage
    finally:
        context_module.file_storage_config.reset(storage_token)
        context_module.vector_db_config.reset(vector_token)
        context_module.graph_db_config.reset(graph_token)


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

    nodes, edges = await store._get_dataset_graph_data()

    assert nodes[0][1]["name"] == "林昭"
    assert edges == []
    assert calls == [
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

    assert await store._dataset_graph_has_nodes() is True
    assert calls == [
        ("dataset.lookup", "novelvideo_local/test", "user-id"),
        ("context.create", "dataset-id", "owner-id"),
        "context.enter",
        "graph.is_empty",
        "context.exit",
    ]

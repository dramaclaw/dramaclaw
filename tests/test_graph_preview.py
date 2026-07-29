from __future__ import annotations

import asyncio

import pytest

from novelvideo.graph_preview import (
    acquire_graph_preview_lock,
    acquire_graph_preview_lock_async,
    delete_graph_preview,
    graph_preview_path,
    load_graph_preview,
    release_graph_preview_lock,
    write_graph_preview,
)


def test_graph_preview_round_trip_and_replace(tmp_path):
    first = {
        "nodes": [{"id": "one"}],
        "edges": [],
        "total_nodes": 1,
        "total_edges": 0,
        "truncated": False,
    }
    second = {
        "nodes": [{"id": "two"}],
        "edges": [{"source": "two", "target": "two"}],
        "total_nodes": 1,
        "total_edges": 1,
        "truncated": True,
    }

    write_graph_preview(tmp_path, first)
    assert load_graph_preview(tmp_path)["nodes"] == [{"id": "one"}]

    write_graph_preview(tmp_path, second)
    loaded = load_graph_preview(tmp_path)
    assert loaded["nodes"] == [{"id": "two"}]
    assert loaded["schema_version"] == 1
    assert not list(tmp_path.glob("*.tmp"))


def test_graph_preview_missing_or_corrupt_is_cache_miss(tmp_path):
    assert load_graph_preview(tmp_path) is None

    graph_preview_path(tmp_path).write_text("{not-json", encoding="utf-8")
    assert load_graph_preview(tmp_path) is None

    graph_preview_path(tmp_path).write_text('{"nodes": {}}', encoding="utf-8")
    assert load_graph_preview(tmp_path) is None


def test_delete_graph_preview_is_idempotent(tmp_path):
    write_graph_preview(tmp_path, {"nodes": [], "edges": []})
    delete_graph_preview(tmp_path)
    delete_graph_preview(tmp_path)
    assert load_graph_preview(tmp_path) is None


@pytest.mark.asyncio
async def test_cancelled_async_lock_wait_does_not_leak_lock(tmp_path):
    held = acquire_graph_preview_lock(tmp_path)
    waiter = asyncio.create_task(acquire_graph_preview_lock_async(tmp_path))
    await asyncio.sleep(0.06)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    release_graph_preview_lock(held)

    acquired = await asyncio.wait_for(
        acquire_graph_preview_lock_async(tmp_path),
        timeout=1,
    )
    release_graph_preview_lock(acquired)


@pytest.mark.asyncio
async def test_ingest_holds_project_graph_lock_for_complete_operation(
    tmp_path,
    monkeypatch,
):
    from novelvideo.cognee.store import CogneeStore

    store = object.__new__(CogneeStore)
    store.state_dir = str(tmp_path)
    ingest_started = asyncio.Event()
    finish_ingest = asyncio.Event()

    async def blocked_ingest(*_args, **_kwargs):
        ingest_started.set()
        await finish_ingest.wait()
        return {"status": "graph_ready"}

    monkeypatch.setattr(store, "_ingest_novel_fast_locked", blocked_ingest)

    ingest_task = asyncio.create_task(store.ingest_novel_fast("unused.txt"))
    await asyncio.wait_for(ingest_started.wait(), timeout=1)

    reader_lock_task = asyncio.create_task(acquire_graph_preview_lock_async(tmp_path))
    await asyncio.sleep(0.1)
    assert not reader_lock_task.done()

    finish_ingest.set()
    assert await asyncio.wait_for(ingest_task, timeout=1) == {
        "status": "graph_ready"
    }
    reader_lock = await asyncio.wait_for(reader_lock_task, timeout=1)
    release_graph_preview_lock(reader_lock)

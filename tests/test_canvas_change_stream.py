"""Canvas change replay and fan-out over the command SSE transport."""

import asyncio
import json
import logging
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from textwrap import dedent

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import chat
from novelvideo.freezone import canvas_store


def test_cancelled_change_subscription_cleans_up_and_allows_resubscription():
    script = dedent("""
        import asyncio
        import os
        import threading
        import time
        from pathlib import Path
        from tempfile import TemporaryDirectory

        def fail_if_hung():
            time.sleep(6)
            os._exit(3)

        threading.Thread(target=fail_if_hung, daemon=True).start()

        import anyio
        from novelvideo.freezone.canvas_change_watch import CanvasChangeWatchHub

        async def main():
            hub = CanvasChangeWatchHub()
            with TemporaryDirectory() as temporary:
                directory = Path(temporary)
                async with anyio.create_task_group() as group:
                    async with hub.subscribe(directory):
                        await anyio.sleep(1)
                        group.cancel_scope.cancel()
                async with hub.subscribe(directory):
                    await anyio.sleep(0.1)
                assert not hub.directories and hub.watcher is None
                await anyio.sleep(0.1)
                assert asyncio.all_tasks() == {asyncio.current_task()}
            print("canvas change hub cleanup complete")

        anyio.run(main)
    """)
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=30,
        env=os.environ.copy(),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "canvas change hub cleanup complete\n"


@pytest.fixture
async def scoped_canvas(monkeypatch, tmp_path):
    async def state(user, payload):
        assert user["username"] == "viewer"
        assert payload.project_id == "project"
        return tmp_path

    monkeypatch.setattr(chat, "_bridge_project_state_dir", state)
    monkeypatch.setattr(
        chat, "_candidate_canvas_bridge_dirs_for_scope", lambda *_: [tmp_path / "bridge"]
    )
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    monkeypatch.delenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_ENTRIES", raising=False)
    monkeypatch.delenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_BYTES", raising=False)
    yield tmp_path
    assert not chat.bridge_watch_hub().directories
    assert chat.bridge_watch_hub().metrics.get("sse_connections", 0) == 0
    # The factory is absent before the feature is implemented.
    if factory := getattr(chat, "canvas_change_watch_hub", None):
        assert not factory().directories
        assert factory().watcher is None


def save(directory, revision):
    return canvas_store.save_canvas(
        directory,
        "canvas",
        base_revision=revision - 1 if revision > 1 else None,
        build_payload=lambda existing: {
            "revision": revision,
            "nodes": [{"id": "node", "data": {"value": revision}}],
            "edges": [],
        },
    )


@asynccontextmanager
async def connected_stream(**kwargs):
    response = await chat.stream_canvas_commands(
        "project", "canvas", user={"username": "viewer"}, **kwargs
    )
    iterator = response.body_iterator
    try:
        assert response.headers["x-accel-buffering"] == "no"
        assert response.headers["cache-control"] == "no-cache"
        assert await asyncio.wait_for(anext(iterator), 2) == {"comment": "connected"}
        yield iterator
    finally:
        await iterator.aclose()


async def next_frame(iterator):
    event = await asyncio.wait_for(anext(iterator), 3)
    assert set(event) == {"data"}
    frame = json.loads(event["data"])
    assert "written_at" not in frame
    return frame


async def assert_idle(iterator):
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(anext(iterator), 0.3)


async def test_live_patch_is_fanned_out_to_both_streams(scoped_canvas):
    save(scoped_canvas, 1)
    async with connected_stream() as first, connected_stream() as second:
        pending = [asyncio.create_task(next_frame(iterator)) for iterator in (first, second)]
        try:
            # Polling backends compare signal mtimes at whole-second precision.
            await asyncio.sleep(1.1)
            await asyncio.to_thread(save, scoped_canvas, 2)
            frames = await asyncio.gather(*pending)
            assert frames == [
                {
                    "type": "canvas.patch",
                    "canvas_id": "canvas",
                    "revision": 2,
                    "base_revision": 1,
                    "save_source": "autosave",
                    "client_save_id": None,
                    "nodes": [{"id": "node", "data": {"value": 2}}],
                    "edges": [],
                    "deleted_node_ids": [],
                    "deleted_edge_ids": [],
                }
            ] * 2
            assert chat.bridge_watch_hub().metrics["sse_connections"] == 2
            assert chat.canvas_change_watch_hub().metrics["canvas_patch_frames"] == 2
        finally:
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)


async def test_reconnect_replays_in_order_then_sends_live_save_once(scoped_canvas):
    for revision in (1, 2, 3, 4):
        save(scoped_canvas, revision)
    async with connected_stream(last_revision=1) as iterator:
        frames = [await next_frame(iterator) for _ in range(3)]
        assert [frame["revision"] for frame in frames] == [2, 3, 4]
        assert [frame["nodes"] for frame in frames] == [
            [{"id": "node", "data": {"value": 2}}],
            [{"id": "node", "data": {"value": 3}}],
            [{"id": "node", "data": {"value": 4}}],
        ]
        await asyncio.sleep(1.1)
        await asyncio.to_thread(save, scoped_canvas, 5)
        frame = await next_frame(iterator)
        assert frame["revision"] == 5
        assert frame["nodes"] == [{"id": "node", "data": {"value": 5}}]
        await assert_idle(iterator)


@pytest.mark.parametrize("cursor", [0, 10], ids=["pruned", "ahead"])
async def test_invalid_cursor_sends_one_reset_without_patches(scoped_canvas, monkeypatch, cursor):
    from novelvideo.freezone.agent_canvas_metrics import metrics_snapshot

    before = metrics_snapshot().get("canvas_push.reset", 0)
    monkeypatch.setenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_ENTRIES", "2")
    for revision in (1, 2, 3, 4):
        save(scoped_canvas, revision)
    async with connected_stream(last_revision=cursor) as iterator:
        assert await next_frame(iterator) == {
            "type": "canvas.reset", "canvas_id": "canvas", "revision": 4
        }
        assert chat.canvas_change_watch_hub().metrics["canvas_reset_frames"] == 1
        assert metrics_snapshot().get("canvas_push.reset", 0) == before + 1
        await assert_idle(iterator)


async def test_no_cursor_starts_at_log_head_and_delivers_next_save(scoped_canvas):
    save(scoped_canvas, 1)
    async with connected_stream() as iterator:
        await asyncio.to_thread(save, scoped_canvas, 2)
        frame = await next_frame(iterator)
        assert frame["type"] == "canvas.patch"
        assert frame["revision"] == 2
        assert frame["nodes"] == [{"id": "node", "data": {"value": 2}}]
        await assert_idle(iterator)


async def test_empty_log_starts_at_canvas_file_revision(scoped_canvas, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "0")
    save(scoped_canvas, 1)
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    async with connected_stream() as iterator:
        await asyncio.to_thread(save, scoped_canvas, 2)
        frame = await next_frame(iterator)
        assert frame["type"] == "canvas.patch"
        assert frame["revision"] == 2
        assert frame["base_revision"] == 1


async def test_missing_canvas_starts_at_zero(scoped_canvas):
    async with connected_stream() as iterator:
        await asyncio.to_thread(save, scoped_canvas, 1)
        frame = await next_frame(iterator)
        assert frame["type"] == "canvas.patch"
        assert frame["revision"] == 1
        assert frame["base_revision"] == 0


async def test_timeout_recovers_save_when_change_watcher_never_wakes(scoped_canvas, monkeypatch):
    from novelvideo.freezone.canvas_change_watch import canvas_change_watch_hub

    async def never_wake():
        await asyncio.Event().wait()

    monkeypatch.setattr(canvas_change_watch_hub(), "_watch", never_wake)
    monkeypatch.setattr(chat, "CANVAS_STREAM_IDLE_SECONDS", 0.05)
    touches = []
    original_touch = chat.touch_canvas_presence

    def touch(*args, **kwargs):
        touches.append(True)
        return original_touch(*args, **kwargs)

    monkeypatch.setattr(chat, "touch_canvas_presence", touch)
    async with connected_stream() as iterator:
        pending = asyncio.create_task(next_frame(iterator))
        try:
            await asyncio.sleep(0.1)
            before = len(touches)
            await asyncio.to_thread(save, scoped_canvas, 1)
            frame = await pending
            assert frame["type"] == "canvas.patch"
            assert frame["revision"] == 1
            assert frame["nodes"] == [{"id": "node", "data": {"value": 1}}]
            assert len(touches) > before
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)


async def test_flag_off_sends_no_change_frames(scoped_canvas, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "0")
    async with connected_stream() as iterator:
        await asyncio.to_thread(save, scoped_canvas, 1)
        await assert_idle(iterator)


async def test_missing_state_directory_sends_no_change_frames(scoped_canvas, monkeypatch):
    async def no_state(*_):
        return None

    monkeypatch.setattr(chat, "_bridge_project_state_dir", no_state)
    async with connected_stream() as iterator:
        await asyncio.to_thread(save, scoped_canvas, 1)
        await assert_idle(iterator)


async def test_negative_cursor_is_rejected(scoped_canvas):
    with pytest.raises(HTTPException) as error:
        await chat.stream_canvas_commands(
            "project", "canvas", last_revision=-1, user={"username": "viewer"}
        )
    assert error.value.status_code == 400


async def test_signal_watcher_rebuilds_one_watch_and_filters_filenames(tmp_path, monkeypatch):
    from novelvideo.freezone import canvas_change_watch as watch

    original = watch.awatch
    started = asyncio.Queue()
    active = 0

    async def tracked(*directories, **kwargs):
        nonlocal active
        active += 1
        assert active == 1
        assert kwargs["recursive"] is False
        started.put_nowait(set(directories))
        try:
            async for changes in original(*directories, **kwargs):
                yield changes
        finally:
            active -= 1

    monkeypatch.setattr(watch, "awatch", tracked)
    hub = watch.canvas_change_watch_hub()
    assert hub is watch.canvas_change_watch_hub()
    first_dir, second_dir = tmp_path / "first", tmp_path / "second"
    try:
        async with hub.subscribe(first_dir) as first:
            assert first_dir.is_dir()
            assert await asyncio.wait_for(started.get(), 2) == {first_dir}
            async with hub.subscribe(first_dir) as peer:
                assert started.empty()
                async with hub.subscribe(second_dir) as second:
                    assert await asyncio.wait_for(started.get(), 2) == {first_dir, second_dir}
                    (first_dir / "unrelated.json").touch()
                    await asyncio.sleep(0.3)
                    assert not first.is_set() and not peer.is_set() and not second.is_set()
                    (first_dir / "changes.signal").touch()
                    await asyncio.wait_for(first.wait(), 2)
                    await asyncio.wait_for(peer.wait(), 2)
                    assert not second.is_set()
                    (second_dir / "changes.signal").touch()
                    await asyncio.wait_for(second.wait(), 2)
                assert await asyncio.wait_for(started.get(), 2) == {first_dir}
                assert set(hub.directories) == {first_dir}
    finally:
        assert not hub.directories
        assert hub.watcher is None
        assert active == 0


async def test_signal_watcher_logs_failure_and_retries(tmp_path, monkeypatch, caplog):
    from novelvideo.freezone import canvas_change_watch as watch

    original = watch.awatch
    started = asyncio.Event()
    calls = 0

    async def fail_once(*directories, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("watch unavailable")
        started.set()
        async for changes in original(*directories, **kwargs):
            yield changes

    monkeypatch.setattr(watch, "awatch", fail_once)
    hub = watch.canvas_change_watch_hub()
    with caplog.at_level(logging.WARNING):
        async with hub.subscribe(tmp_path) as wake:
            await asyncio.wait_for(started.wait(), 2)
            (tmp_path / "changes.signal").touch()
            await asyncio.wait_for(wake.wait(), 2)
            assert calls == 2
            assert any(record.levelno == logging.WARNING for record in caplog.records)
    assert not hub.directories
    assert hub.watcher is None


async def test_last_unsubscribe_and_new_subscription_never_overlap_watchers(tmp_path, monkeypatch):
    from novelvideo.freezone import canvas_change_watch as watch

    started, stopping = asyncio.Event(), asyncio.Event()
    active = peak = 0

    async def slow_close(*directories, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        started.set()
        try:
            await asyncio.Event().wait()
            yield set()
        finally:
            stopping.set()
            await asyncio.sleep(0.05)
            active -= 1

    monkeypatch.setattr(watch, "awatch", slow_close)
    hub = watch.canvas_change_watch_hub()
    first = hub.subscribe(tmp_path / "first")
    await first.__aenter__()
    closing = None
    try:
        await asyncio.wait_for(started.wait(), 2)
        closing = asyncio.create_task(first.__aexit__(None, None, None))
        await asyncio.wait_for(stopping.wait(), 2)
        async with hub.subscribe(tmp_path / "second"):
            await asyncio.sleep(0.1)
        assert peak == 1
    finally:
        if closing is not None:
            await closing
        else:
            await first.__aexit__(None, None, None)
    assert not hub.directories
    assert hub.watcher is None
    assert active == 0


async def test_cursor_replay_metrics_with_delivery_clock(scoped_canvas, monkeypatch, caplog):
    from datetime import datetime, timezone

    from novelvideo.freezone import agent_canvas_metrics as metrics
    from novelvideo.freezone.canvas_changes import canvas_changes_dir

    for revision in (1, 2, 3):
        save(scoped_canvas, revision)
    directory = canvas_changes_dir(scoped_canvas, "canvas")
    for revision, timestamp in (
        (2, "2200-01-01T00:00:00+00:00"),
        (3, "2200-01-01T23:59:59+00:00"),
    ):
        path = directory / f"{revision:012d}.json"
        entry = json.loads(path.read_text())
        entry["written_at"] = timestamp
        path.write_text(json.dumps(entry))
    monkeypatch.setattr(chat, "_push_now", lambda: datetime(2200, 1, 2, tzinfo=timezone.utc))
    before = metrics.metrics_snapshot().get("canvas_push.cursor_replay", 0)
    observations = metrics.observations_snapshot()
    with caplog.at_level(logging.INFO, logger=chat.__name__):
        async with connected_stream(last_revision=1) as iterator:
            assert [frame["revision"] for frame in [
                await next_frame(iterator), await next_frame(iterator)
            ]] == [2, 3]
            await assert_idle(iterator)
    assert metrics.metrics_snapshot()["canvas_push.cursor_replay"] == before + 1
    after = metrics.observations_snapshot()
    frames_before = observations.get("canvas_push.cursor_replay_frames", {})
    assert after["canvas_push.cursor_replay_frames"]["count"] == frames_before.get("count", 0) + 1
    assert after["canvas_push.cursor_replay_frames"]["total"] == frames_before.get("total", 0) + 2
    delivery_before = observations.get("canvas_push.delivery_ms", {})
    assert after["canvas_push.delivery_ms"]["count"] == delivery_before.get("count", 0) + 2
    assert after["canvas_push.delivery_ms"]["total"] == delivery_before.get("total", 0) + 86401000
    assert after["canvas_push.delivery_ms"]["max"] == 86400000.0
    assert [record.getMessage() for record in caplog.records if record.name == chat.__name__] == [
        "canvas_push canvas=canvas frames=2 reset=False replay=True max_delivery_ms=86400000"
    ]


@pytest.mark.parametrize("written_at", [None, "invalid", "2200-01-02T00:00:01+00:00"])
async def test_delivery_metrics_skip_invalid_dates_and_clamp_future(
    scoped_canvas, monkeypatch, written_at
):
    from datetime import datetime, timezone

    from novelvideo.freezone import agent_canvas_metrics as metrics
    from novelvideo.freezone.canvas_changes import canvas_changes_dir

    save(scoped_canvas, 1)
    path = canvas_changes_dir(scoped_canvas, "canvas") / "000000000001.json"
    entry = json.loads(path.read_text())
    entry.pop("written_at")
    if written_at is not None:
        entry["written_at"] = written_at
    path.write_text(json.dumps(entry))
    monkeypatch.setattr(chat, "_push_now", lambda: datetime(2200, 1, 2, tzinfo=timezone.utc))
    before = metrics.observations_snapshot().get("canvas_push.delivery_ms", {})
    async with connected_stream(last_revision=0) as iterator:
        assert (await next_frame(iterator))["revision"] == 1
    after = metrics.observations_snapshot().get("canvas_push.delivery_ms", {})
    expected_count = 1 if written_at and written_at != "invalid" else 0
    assert after.get("count", 0) - before.get("count", 0) == expected_count
    assert after.get("total", 0.0) == before.get("total", 0.0)

"""Regression coverage for read isolation, delivery races and event recovery."""

import asyncio
import sqlite3
import time

import pytest

from novelvideo.freezone import canvas_command_bridge as bridge


def publish(directory, key="command"):
    bridge.put_pending_canvas_command(
        key=key,
        project_id="project",
        canvas_id="canvas",
        commands=[],
        envelope={"external_mcp_command": True},
        bridge_dir=directory,
    )


def test_empty_reads_do_not_create_storage(tmp_path):
    directory = tmp_path / "missing"
    assert (
        bridge.list_pending_bridge_messages(
            project_id="project", canvas_id="canvas", bridge_dir=directory
        )
        == []
    )
    assert bridge._read_durable_bridge_result("absent", bridge_dir=directory) is None
    assert bridge.next_bridge_deadline("project", "canvas", directory) is None
    assert not bridge.bridge_message_exists("absent", bridge_dir=directory)
    assert not directory.exists()


def test_reads_are_readonly_and_do_not_notify(tmp_path, monkeypatch):
    publish(tmp_path)
    statements = []
    original = sqlite3.connect

    def connect(database, **kwargs):
        assert "mode=ro" in str(database)
        connection = original(database, **kwargs)
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(sqlite3, "connect", connect)
    monkeypatch.setattr(
        bridge, "touch_bridge_signal", lambda *_: pytest.fail("read notified")
    )
    assert bridge.list_pending_bridge_messages(
        project_id="project", canvas_id="canvas", bridge_dir=tmp_path
    )
    bridge._read_durable_bridge_result("command", bridge_dir=tmp_path)
    assert not any("BEGIN" in sql.upper() for sql in statements)


def test_ttl_race_blocks_claim_and_expiry_persists_result(tmp_path, monkeypatch):
    publish(tmp_path)
    now = time.time()
    monkeypatch.setattr(bridge.time, "time", lambda: now + 601)
    assert not bridge.list_pending_bridge_messages(
        project_id="project", canvas_id="canvas", bridge_dir=tmp_path
    )
    assert not bridge.mark_bridge_message_delivered(
        "command", consumer_id="late", bridge_dir=tmp_path
    )
    bridge.expire_bridge_messages(tmp_path)
    result = bridge._read_durable_bridge_result("command", bridge_dir=tmp_path)
    assert result["canvas_apply_status"] == "timeout"


def test_lease_allows_only_one_claim_then_redelivery(tmp_path, monkeypatch):
    publish(tmp_path)
    now = time.time()
    monkeypatch.setattr(bridge.time, "time", lambda: now)
    assert bridge.mark_bridge_message_delivered(
        "command", consumer_id="first", bridge_dir=tmp_path
    )
    signal = (tmp_path / "canvas_command.signal").stat().st_ino
    assert not bridge.mark_bridge_message_delivered(
        "command", consumer_id="second", bridge_dir=tmp_path
    )
    assert (tmp_path / "canvas_command.signal").stat().st_ino == signal
    assert bridge.next_bridge_deadline("project", "canvas", tmp_path) == now + 15
    monkeypatch.setattr(bridge.time, "time", lambda: now + 16)
    assert bridge.mark_bridge_message_delivered(
        "command", consumer_id="second", bridge_dir=tmp_path
    )


def test_notification_failure_does_not_fail_committed_write(tmp_path, monkeypatch):
    def fail(*_):
        raise OSError("notification unavailable")

    monkeypatch.setattr(bridge, "touch_bridge_signal", fail)
    publish(tmp_path)
    assert bridge.bridge_message_exists("command", bridge_dir=tmp_path)


def test_wait_existing_result_reads_once(tmp_path, monkeypatch):
    publish(tmp_path)
    bridge.resolve_canvas_command("command", {"ok": True}, bridge_dir=tmp_path)
    reads = []
    original = bridge._read_durable_bridge_result

    def read(*args, **kwargs):
        reads.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(bridge, "_read_durable_bridge_result", read)
    assert bridge.wait_canvas_command_result("command", 1, bridge_dir=tmp_path)["ok"]
    assert len(reads) == 1


async def eventually(predicate, timeout=2):
    end = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < end, "condition did not become true"
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_hub_native_cross_process_signal_within_one_second(tmp_path):
    import os
    import sys
    from novelvideo.freezone.canvas_command_watch import BridgeWatchHub

    hub = BridgeWatchHub()
    async with hub.subscribe([tmp_path]):
        await asyncio.sleep(0.4)  # Native watcher establishes its first watch.
        code = (
            "from novelvideo.freezone.canvas_command_bridge import put_pending_canvas_command; "
            "import sys; put_pending_canvas_command(key='process', project_id='project', "
            "canvas_id='canvas', commands=[], envelope={}, bridge_dir=sys.argv[1])"
        )
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", code, str(tmp_path), env=os.environ.copy()
        )
        assert await process.wait() == 0
        started = time.monotonic()
        await eventually(lambda: hub.pending(tmp_path, "project", "canvas"), timeout=1)
        print(
            f"native signal latency after writer exit: {time.monotonic() - started:.3f}s"
        )
    assert hub.task is hub.watcher is None
    assert not hub.directories


@pytest.mark.asyncio
async def test_hub_shares_idle_reads_without_scans_or_writes(tmp_path, monkeypatch):
    from novelvideo.freezone import canvas_command_watch as watch

    hub = watch.BridgeWatchHub(reconcile_seconds=0.15)
    publish(tmp_path)
    bridge.resolve_canvas_command("command", {"ok": True}, bridge_dir=tmp_path)
    async with hub.subscribe([tmp_path]), hub.subscribe([tmp_path]):
        await asyncio.sleep(0.5)
        before = hub.metrics["reads"]
        monkeypatch.setattr(
            watch, "expire_bridge_messages", lambda *_: pytest.fail("idle write")
        )
        monkeypatch.setattr(type(tmp_path), "glob", lambda *_: pytest.fail("idle scan"))
        await asyncio.sleep(0.48)
        assert 2 <= hub.metrics["reads"] - before <= 4


@pytest.mark.asyncio
async def test_hub_recovers_commit_without_notification(tmp_path, monkeypatch):
    from novelvideo.freezone.canvas_command_watch import BridgeWatchHub

    hub = BridgeWatchHub(reconcile_seconds=0.15)
    async with hub.subscribe([tmp_path]):
        await asyncio.sleep(0.4)
        monkeypatch.setattr(bridge, "_notify_bridge", lambda *_: None)
        # No compatibility file event either: simulate death between commit and notify.
        bridge._put_pending_bridge_message(
            key="lost",
            kind="canvas_command",
            project_id="project",
            canvas_id="canvas",
            payload={"envelope": {}},
            bridge_dir=tmp_path,
        )
        await eventually(lambda: hub.pending(tmp_path, "project", "canvas"))
        assert hub.metrics["recovered"] >= 1


@pytest.mark.asyncio
async def test_hub_deadline_redelivery_and_expiry(tmp_path, monkeypatch):
    from novelvideo.freezone.canvas_command_watch import BridgeWatchHub

    monkeypatch.setattr(bridge, "BRIDGE_DELIVERY_LEASE_SECONDS", 0.15)
    monkeypatch.setitem(bridge.BRIDGE_PENDING_TTL_SECONDS, "canvas_command", 0.7)
    publish(tmp_path)
    hub = BridgeWatchHub()
    async with hub.subscribe([tmp_path]):
        await eventually(lambda: hub.pending(tmp_path, "project", "canvas"))
        assert bridge.mark_bridge_message_delivered(
            "command", consumer_id="one", bridge_dir=tmp_path
        )
        await asyncio.sleep(0.2)
        assert hub.pending(tmp_path, "project", "canvas")
        assert bridge.mark_bridge_message_delivered(
            "command", consumer_id="two", bridge_dir=tmp_path
        )
        await eventually(
            lambda: bridge._read_durable_bridge_result("command", bridge_dir=tmp_path)
        )
        assert not hub.pending(tmp_path, "project", "canvas")


@pytest.mark.asyncio
async def test_hub_directory_delete_recreate(tmp_path):
    import shutil
    from novelvideo.freezone.canvas_command_watch import BridgeWatchHub

    directory = tmp_path / "bridge"
    hub = BridgeWatchHub(reconcile_seconds=0.1, degraded_seconds=0.1)
    async with hub.subscribe([directory]):
        await asyncio.sleep(0.4)
        shutil.rmtree(directory)
        await eventually(directory.exists)
        publish(directory)
        await eventually(lambda: hub.pending(directory, "project", "canvas"))


@pytest.mark.asyncio
async def test_hub_native_failure_degrades_then_recovers(tmp_path, monkeypatch):
    from novelvideo.freezone import canvas_command_watch as watch

    original = watch.awatch
    fail = [True]

    async def awatch(*args, **kwargs):
        if fail[0]:
            raise OSError("watch unavailable")
        async for changes in original(*args, **kwargs):
            yield changes

    monkeypatch.setattr(watch, "awatch", awatch)
    hub = watch.BridgeWatchHub(degraded_seconds=0.1)
    async with hub.subscribe([tmp_path]):
        await eventually(lambda: hub.degraded)
        publish(tmp_path)
        await eventually(lambda: hub.pending(tmp_path, "project", "canvas"))
        fail[0] = False
        await eventually(lambda: not hub.degraded, timeout=5)
        assert hub.metrics["degraded"] >= 1
        assert hub.metrics["restored"] >= 1

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
    monkeypatch.setattr(bridge, "touch_bridge_signal", lambda *_: pytest.fail("read notified"))
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
    assert bridge.mark_bridge_message_delivered("command", consumer_id="first", bridge_dir=tmp_path)
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
        print(f"native signal latency after writer exit: {time.monotonic() - started:.3f}s")
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
        monkeypatch.setattr(watch, "expire_bridge_messages", lambda *_: pytest.fail("idle write"))
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
        await eventually(lambda: bridge._read_durable_bridge_result("command", bridge_dir=tmp_path))
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


def test_wait_without_changes_only_reads_initially_and_before_timeout(tmp_path, monkeypatch):
    reads = []
    original = bridge._read_durable_bridge_result

    def read(*args, **kwargs):
        reads.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(bridge, "_read_durable_bridge_result", read)
    assert bridge.wait_canvas_command_result("missing", 0.25, 0.05, bridge_dir=tmp_path) is None
    assert len(reads) == 2


@pytest.mark.asyncio
async def test_two_processes_compete_for_one_lease(tmp_path):
    import sys

    publish(tmp_path)
    code = (
        "import sys; from novelvideo.freezone.canvas_command_bridge import mark_bridge_message_delivered; "
        "print(mark_bridge_message_delivered('command', consumer_id=sys.argv[2], bridge_dir=sys.argv[1]))"
    )

    async def claim(consumer):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", code, str(tmp_path), consumer, stdout=asyncio.subprocess.PIPE
        )
        output, _ = await process.communicate()
        assert process.returncode == 0
        return output.strip()

    assert sorted(await asyncio.gather(claim("one"), claim("two"))) == [b"False", b"True"]


@pytest.mark.asyncio
async def test_long_waiters_do_not_consume_hub_short_query_capacity(tmp_path):
    import threading
    from novelvideo.freezone.canvas_command_watch import BridgeWatchHub

    release = threading.Event()
    waits = [asyncio.create_task(asyncio.to_thread(release.wait, 2)) for _ in range(40)]
    try:
        await asyncio.sleep(0.05)
        hub = BridgeWatchHub()
        assert await asyncio.wait_for(hub.run(lambda: "available"), 0.5) == "available"
    finally:
        release.set()
        await asyncio.gather(*waits)


def test_legacy_import_preserves_age_and_claims_atomically(tmp_path):
    payload = {
        "project_id": "project",
        "canvas_id": "canvas",
        "envelope": {},
        "created_at": time.time() - 590,
    }
    assert bridge.claim_legacy_bridge_message(
        "legacy", payload, kind="canvas_command", consumer_id="one", bridge_dir=tmp_path
    )
    assert not bridge.claim_legacy_bridge_message(
        "legacy", payload, kind="canvas_command", consumer_id="two", bridge_dir=tmp_path
    )
    assert bridge.next_bridge_deadline("project", "canvas", tmp_path) == payload["created_at"] + 600


@pytest.mark.asyncio
async def test_crashed_writer_is_reconciled_within_thirty_seconds(tmp_path):
    import sys
    from novelvideo.freezone.canvas_command_watch import BridgeWatchHub

    hub = BridgeWatchHub()
    async with hub.subscribe([tmp_path]):
        await asyncio.sleep(0.5)
        code = (
            "import os,sys; from novelvideo.freezone import canvas_command_bridge as b; "
            "b._notify_bridge=lambda *_: os._exit(0); "
            "b._put_pending_bridge_message(key='crashed', kind='canvas_command', "
            "project_id='project', canvas_id='canvas', payload={'envelope':{}}, bridge_dir=sys.argv[1])"
        )
        process = await asyncio.create_subprocess_exec(sys.executable, "-c", code, str(tmp_path))
        assert await process.wait() == 0
        started = time.monotonic()
        await eventually(lambda: hub.pending(tmp_path, "project", "canvas"), timeout=30)
        elapsed = time.monotonic() - started
        print(f"crash recovery latency: {elapsed:.3f}s")
        assert elapsed <= 30
        assert hub.metrics["recovered"] >= 1


@pytest.mark.asyncio
async def test_cancelled_subscription_setup_leaks_no_references(tmp_path):
    from novelvideo.freezone.canvas_command_watch import BridgeWatchHub

    hub = BridgeWatchHub()
    original = hub.run
    calls = [0]

    async def run(function, *args, **kwargs):
        calls[0] += 1
        if calls[0] == 4:
            raise asyncio.CancelledError
        return await original(function, *args, **kwargs)

    hub.run = run
    with pytest.raises(asyncio.CancelledError):
        async with hub.subscribe([tmp_path / "one", tmp_path / "two"]):
            pytest.fail("setup should have cancelled")
    assert not hub.directories
    assert not hub.aliases
    assert hub.task is hub.watcher is None


@pytest.mark.asyncio
async def test_silent_native_watch_fails_probe_and_enters_degraded_mode(tmp_path, monkeypatch):
    from novelvideo.freezone import canvas_command_watch as watch

    async def silent(*args, **kwargs):
        while True:
            await asyncio.sleep(0.05)
            yield set()

    monkeypatch.setattr(watch, "awatch", silent)
    hub = watch.BridgeWatchHub(degraded_seconds=0.1)
    async with hub.subscribe([tmp_path]):
        await eventually(lambda: hub.degraded)
        legacy = tmp_path / "legacy.pending.json"
        legacy.write_text("{}")
        await eventually(lambda: legacy in hub.legacy_paths(tmp_path))


@pytest.mark.asyncio
async def test_rebuild_pull_recovers_unnotified_write(tmp_path, monkeypatch):
    from novelvideo.freezone.canvas_command_watch import BridgeWatchHub

    hub = BridgeWatchHub()
    first, second = tmp_path / "one", tmp_path / "two"
    async with hub.subscribe([first]):
        await asyncio.sleep(0.4)
        monkeypatch.setattr(bridge, "_notify_bridge", lambda *_: None)
        async with hub.subscribe([second]):
            bridge._put_pending_bridge_message(
                key="rebuild",
                kind="canvas_command",
                project_id="project",
                canvas_id="canvas",
                payload={"envelope": {}},
                bridge_dir=first,
            )
            await eventually(lambda: hub.pending(first, "project", "canvas"), timeout=1)
        assert len(hub.directories) == 1


@pytest.mark.asyncio
async def test_write_between_native_start_and_startup_pull_is_recovered(tmp_path, monkeypatch):
    from novelvideo.freezone import canvas_command_watch as watch

    original = watch.awatch
    injected = [False]
    monkeypatch.setattr(bridge, "_notify_bridge", lambda *_: None)

    async def awatch(*args, **kwargs):
        async for changes in original(*args, **kwargs):
            if changes and not injected[0]:
                # Native watch is running; the hub has not yet consumed its
                # readiness event and performed the post-establishment pull.
                injected[0] = True
                await asyncio.to_thread(
                    bridge._put_pending_bridge_message,
                    key="startup-gap",
                    kind="canvas_command",
                    project_id="project",
                    canvas_id="canvas",
                    payload={"envelope": {}},
                    bridge_dir=tmp_path,
                )
            yield changes

    monkeypatch.setattr(watch, "awatch", awatch)
    hub = watch.BridgeWatchHub()
    async with hub.subscribe([tmp_path]):
        await eventually(lambda: hub.pending(tmp_path, "project", "canvas"), timeout=1)
        assert injected[0]


def test_claim_checks_ttl_after_waiting_for_write_lock(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    publish(tmp_path)
    clock = [time.time()]
    monkeypatch.setattr(bridge.time, "time", lambda: clock[0])
    blocked = threading.Event()
    real_connect = sqlite3.connect

    def connect(*args, **kwargs):
        connection = real_connect(*args, **kwargs)
        connection.set_trace_callback(
            lambda sql: blocked.set() if sql == "BEGIN IMMEDIATE" else None
        )
        return connection

    blocker = real_connect(bridge._bridge_db_path(tmp_path))
    blocker.execute("BEGIN IMMEDIATE")
    monkeypatch.setattr(sqlite3, "connect", connect)
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            claimed = executor.submit(
                bridge.mark_bridge_message_delivered,
                "command",
                consumer_id="blocked",
                bridge_dir=tmp_path,
            )
            try:
                assert blocked.wait(1)
                clock[0] += 601
            finally:
                blocker.rollback()
            assert claimed.result(timeout=2) is False
    finally:
        blocker.close()

"""Regression coverage for read isolation, delivery races and event recovery."""
import asyncio
import sqlite3
import time

import pytest

from novelvideo.freezone import canvas_command_bridge as bridge


def publish(directory, key="command"):
    bridge.put_pending_canvas_command(
        key=key, project_id="project", canvas_id="canvas", commands=[],
        envelope={"external_mcp_command": True}, bridge_dir=directory,
    )


def test_empty_reads_do_not_create_storage(tmp_path):
    directory = tmp_path / "missing"
    assert bridge.list_pending_bridge_messages(
        project_id="project", canvas_id="canvas", bridge_dir=directory
    ) == []
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
    assert not bridge.mark_bridge_message_delivered("command", consumer_id="late", bridge_dir=tmp_path)
    bridge.expire_bridge_messages(tmp_path)
    result = bridge._read_durable_bridge_result("command", bridge_dir=tmp_path)
    assert result["canvas_apply_status"] == "timeout"


def test_lease_allows_only_one_claim_then_redelivery(tmp_path, monkeypatch):
    publish(tmp_path)
    now = time.time()
    monkeypatch.setattr(bridge.time, "time", lambda: now)
    assert bridge.mark_bridge_message_delivered("command", consumer_id="first", bridge_dir=tmp_path)
    signal = (tmp_path / "canvas_command.signal").stat().st_ino
    assert not bridge.mark_bridge_message_delivered("command", consumer_id="second", bridge_dir=tmp_path)
    assert (tmp_path / "canvas_command.signal").stat().st_ino == signal
    assert bridge.next_bridge_deadline("project", "canvas", tmp_path) == now + 15
    monkeypatch.setattr(bridge.time, "time", lambda: now + 16)
    assert bridge.mark_bridge_message_delivered("command", consumer_id="second", bridge_dir=tmp_path)


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

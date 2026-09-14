# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab

import sqlite3

from novelvideo.freezone import canvas_command_bridge


def test_repeated_canvas_commands_receive_unique_bridge_keys(monkeypatch):
    nonces = iter((100, 101))
    monkeypatch.setattr(canvas_command_bridge.time, "time_ns", lambda: next(nonces))

    first = canvas_command_bridge.canvas_command_bridge_key(
        project_id="project-a",
        canvas_id="canvas-a",
        commands=[{"type": "create_node", "node_type": "imageGenNode"}],
    )
    second = canvas_command_bridge.canvas_command_bridge_key(
        project_id="project-a",
        canvas_id="canvas-a",
        commands=[{"type": "create_node", "node_type": "imageGenNode"}],
    )

    assert first != second


def test_repeated_canvas_context_requests_receive_unique_bridge_keys(monkeypatch):
    nonces = iter((200, 201))
    monkeypatch.setattr(canvas_command_bridge.time, "time_ns", lambda: next(nonces))

    first = canvas_command_bridge.canvas_context_bridge_key(
        project_id="project-a",
        canvas_id="canvas-a",
        requests=[{"type": "canvas_summary"}],
    )
    second = canvas_command_bridge.canvas_context_bridge_key(
        project_id="project-a",
        canvas_id="canvas-a",
        requests=[{"type": "canvas_summary"}],
    )

    assert first != second


def test_late_canvas_cancellation_does_not_replace_accepted_result(tmp_path) -> None:
    bridge_dir = tmp_path / "bridge"
    accepted = canvas_command_bridge.resolve_canvas_command(
        "bridge-a",
        {
            "ok": True,
            "tool_call_status": "completed",
            "canvas_apply_status": "accepted",
            "applied": True,
            "cancelled": False,
        },
        bridge_dir=bridge_dir,
    )

    resolved = canvas_command_bridge.resolve_canvas_command(
        "bridge-a",
        {
            "ok": False,
            "tool_call_status": "failed",
            "canvas_apply_status": "cancelled_by_user",
            "applied": False,
            "cancelled": True,
        },
        bridge_dir=bridge_dir,
    )

    assert resolved == accepted
    persisted = canvas_command_bridge._read_json(bridge_dir / "bridge-a.result.json")
    assert persisted == accepted


def test_identical_retry_replays_durable_canvas_result(tmp_path) -> None:
    bridge_dir = tmp_path / "bridge"
    commands = [{"type": "create_node", "node_type": "imageGenNode"}]
    first = canvas_command_bridge.put_pending_canvas_command(
        key="stable-key",
        project_id="project-a",
        canvas_id="canvas-a",
        commands=commands,
        envelope={"commands": commands},
        bridge_dir=bridge_dir,
    )
    assert first is None
    accepted = canvas_command_bridge.resolve_canvas_command(
        "stable-key",
        {
            "ok": True,
            "canvas_apply_status": "accepted",
            "project_id": "project-a",
            "canvas_id": "canvas-a",
        },
        bridge_dir=bridge_dir,
    )

    replayed = canvas_command_bridge.put_pending_canvas_command(
        key="stable-key",
        project_id="project-a",
        canvas_id="canvas-a",
        commands=commands,
        envelope={"commands": commands},
        bridge_dir=bridge_dir,
    )

    assert replayed == accepted
    assert not (bridge_dir / "stable-key.pending.json").exists()


def test_reused_key_with_different_payload_returns_conflict(tmp_path) -> None:
    bridge_dir = tmp_path / "bridge"
    original = [{"type": "create_node", "node_type": "imageGenNode"}]
    canvas_command_bridge.put_pending_canvas_command(
        key="stable-key",
        project_id="project-a",
        canvas_id="canvas-a",
        commands=original,
        envelope={"commands": original},
        bridge_dir=bridge_dir,
    )
    accepted = canvas_command_bridge.resolve_canvas_command(
        "stable-key",
        {"ok": True, "canvas_apply_status": "accepted"},
        bridge_dir=bridge_dir,
    )

    conflict = canvas_command_bridge.put_pending_canvas_command(
        key="stable-key",
        project_id="project-a",
        canvas_id="canvas-a",
        commands=[{"type": "create_node", "node_type": "videoNode"}],
        envelope={"commands": []},
        bridge_dir=bridge_dir,
    )

    assert conflict is not None
    assert conflict["status"] == "canvas_command_idempotency_conflict"
    assert (
        canvas_command_bridge._read_json(bridge_dir / "stable-key.result.json")
        == accepted
    )


def test_sqlite_inbox_survives_worker_and_file_bridge_loss(tmp_path) -> None:
    bridge_dir = tmp_path / "bridge"
    commands = [{"type": "create_node", "node_type": "imageGenNode"}]
    canvas_command_bridge.put_pending_canvas_command(
        key="cross-worker",
        project_id="project-a",
        canvas_id="canvas-a",
        commands=commands,
        envelope={"external_mcp_command": True, "commands": commands},
        bridge_dir=bridge_dir,
    )
    (bridge_dir / "cross-worker.pending.json").unlink()

    pending = canvas_command_bridge.list_pending_bridge_messages(
        project_id="project-a",
        canvas_id="canvas-a",
        kinds={"canvas_command"},
        bridge_dir=bridge_dir,
    )

    assert [item["key"] for item in pending] == ["cross-worker"]
    assert canvas_command_bridge.mark_bridge_message_delivered(
        "cross-worker", consumer_id="api-worker-b", bridge_dir=bridge_dir
    )
    assert not canvas_command_bridge.mark_bridge_message_delivered(
        "cross-worker", consumer_id="api-worker-c", bridge_dir=bridge_dir
    )
    assert (
        canvas_command_bridge.list_pending_bridge_messages(
            project_id="project-a",
            canvas_id="canvas-a",
            kinds={"canvas_command"},
            bridge_dir=bridge_dir,
        )
        == []
    )

    with sqlite3.connect(canvas_command_bridge._bridge_db_path(bridge_dir)) as conn:
        conn.execute(
            "UPDATE canvas_command_messages SET lease_expires_at = 0 "
            "WHERE bridge_key = 'cross-worker'"
        )
    assert (
        canvas_command_bridge.list_pending_bridge_messages(
            project_id="project-a",
            canvas_id="canvas-a",
            kinds={"canvas_command"},
            bridge_dir=bridge_dir,
        )[0]["key"]
        == "cross-worker"
    )


def test_sqlite_outbox_returns_result_without_result_file(tmp_path) -> None:
    bridge_dir = tmp_path / "bridge"
    commands = [{"type": "create_node", "node_type": "imageGenNode"}]
    canvas_command_bridge.put_pending_canvas_command(
        key="durable-result",
        project_id="project-a",
        canvas_id="canvas-a",
        commands=commands,
        envelope={"commands": commands},
        bridge_dir=bridge_dir,
    )
    expected = canvas_command_bridge.resolve_canvas_command(
        "durable-result",
        {"ok": True, "applied": True, "canvas_apply_status": "applied"},
        bridge_dir=bridge_dir,
    )
    (bridge_dir / "durable-result.result.json").unlink()

    assert (
        canvas_command_bridge.wait_canvas_command_result(
            "durable-result", timeout_seconds=0, bridge_dir=bridge_dir
        )
        == expected
    )
    assert canvas_command_bridge.bridge_status_counts(bridge_dir=bridge_dir) == {
        "applied": 1
    }


def test_sqlite_bridge_prunes_expired_terminal_results(tmp_path) -> None:
    bridge_dir = tmp_path / "bridge"
    canvas_command_bridge.resolve_canvas_command(
        "expired-result",
        {"ok": False, "cancelled": True, "canvas_apply_status": "timeout"},
        bridge_dir=bridge_dir,
    )
    with sqlite3.connect(canvas_command_bridge._bridge_db_path(bridge_dir)) as conn:
        conn.execute(
            "UPDATE canvas_command_messages SET expires_at = 0 "
            "WHERE bridge_key = 'expired-result'"
        )

    assert canvas_command_bridge.bridge_status_counts(bridge_dir=bridge_dir) == {}


def test_sqlite_bridge_expires_abandoned_pending_message(tmp_path) -> None:
    bridge_dir = tmp_path / "bridge"
    commands = [{"type": "create_node", "node_type": "imageGenNode"}]
    canvas_command_bridge.put_pending_canvas_command(
        key="abandoned",
        project_id="project-a",
        canvas_id="canvas-a",
        commands=commands,
        envelope={"commands": commands},
        bridge_dir=bridge_dir,
    )
    with sqlite3.connect(canvas_command_bridge._bridge_db_path(bridge_dir)) as conn:
        conn.execute(
            "UPDATE canvas_command_messages SET created_at = 0 "
            "WHERE bridge_key = 'abandoned'"
        )

    result = canvas_command_bridge.wait_canvas_command_result(
        "abandoned", timeout_seconds=0, bridge_dir=bridge_dir
    )

    assert result is not None
    assert result["canvas_apply_status"] == "timeout"
    assert canvas_command_bridge.bridge_status_counts(bridge_dir=bridge_dir) == {
        "expired": 1
    }

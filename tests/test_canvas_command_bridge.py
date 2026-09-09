# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab

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
    persisted = canvas_command_bridge._read_json(
        bridge_dir / "bridge-a.result.json"
    )
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
    assert canvas_command_bridge._read_json(
        bridge_dir / "stable-key.result.json"
    ) == accepted

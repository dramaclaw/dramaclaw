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

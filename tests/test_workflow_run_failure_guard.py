from __future__ import annotations

import pytest

from test_freezone_plugin import _load_plugin_module
from test_freezone_plugin import (
    _restore_tools_registry_modules as _restore_tools_registry_modules,
)
from novelvideo.freezone import canvas_command_bridge as bridge


@pytest.fixture(params=["external", "hermes"])
def run_bridge(monkeypatch, tmp_path, request):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-1")
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    # The run handler validates exact node IDs through the Freezone canvas
    # boundary before exercising the turn guard. Keep this unit test local by
    # supplying the boundary URL and a deterministic canvas response.
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://freezone.test")
    monkeypatch.setenv("DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", str(tmp_path))
    monkeypatch.setattr(plugin, "_bound_scope_mismatch", lambda *_: None)
    delivered = []
    outcome = {
        "ok": False,
        "tool_call_status": "failed",
        "canvas_apply_status": "failed",
        "applied": False,
        "errors": ["workflow persistence HTTP 503"],
        "agent_instruction": "fix the command and retry only when it is safe",
    }

    def wait(key, **kwargs):
        rows = bridge.list_pending_bridge_messages(
            project_id="project-a", canvas_id="canvas-a", bridge_dir=tmp_path
        )
        if rows:
            delivered.extend(rows)
            bridge.resolve_canvas_command(key, outcome, bridge_dir=tmp_path)
        return bridge.wait_canvas_command_result(
            key, timeout_seconds=0, bridge_dir=tmp_path
        )

    monkeypatch.setattr(plugin, "wait_canvas_command_result", wait)
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda *_args, **_kwargs: {
            "ok": True,
            "data": {"nodes": [{"id": "image"}]},
        },
    )

    def dispatch(commands=None):
        handler = (
            plugin._dispatch_mcp_approved_frontend_commands
            if request.param == "external"
            else plugin._dispatch_frontend_canvas_commands
        )
        return handler(
            project="project-a",
            canvas="canvas-a",
            commands=commands or [{"type": "run_workflow", "node_ids": ["fail-image"]}],
            slim_result=True,
        )

    return plugin, dispatch, delivered, outcome, tmp_path


def test_persistence_503_stops_same_turn_and_replays_failure(run_bridge):
    _, dispatch, delivered, _, _ = run_bridge
    first = dispatch()
    second = dispatch()
    assert len(delivered) == 1
    assert first["ok"] is second["ok"] is False
    assert first["bridge_key"] == second["bridge_key"]
    assert "do not call freezone_run_workflow again" in second["agent_instruction"]
    assert "retry only" not in second["agent_instruction"]


def test_lost_tool_receipt_reads_persisted_result_without_another_dispatch(run_bridge):
    _, dispatch, delivered, outcome, _ = run_bridge
    outcome.update(ok=True, applied=True, canvas_apply_status="accepted", errors=[])
    first = (
        dispatch()
    )  # Discarded by the client after the browser persisted its receipt.
    second = dispatch()
    assert len(delivered) == 1
    assert first["bridge_key"] == second["bridge_key"]
    assert second["ok"] is True


def test_same_turn_changed_run_payload_fails_closed(run_bridge):
    _, dispatch, delivered, _, _ = run_bridge
    dispatch()
    changed = dispatch([{"type": "run_workflow", "node_ids": ["other-image"]}])
    assert len(delivered) == 1
    assert changed["ok"] is False
    assert "conflicts" in changed["message"]


def test_new_user_turn_can_resume_after_explicit_failure(run_bridge, monkeypatch):
    _, dispatch, delivered, outcome, _ = run_bridge
    first = dispatch()
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-2")
    outcome.update(ok=True, applied=True, canvas_apply_status="accepted", errors=[])
    second = dispatch()
    assert len(delivered) == 2
    assert first["bridge_key"] != second["bridge_key"]
    assert second["ok"] is True


def test_run_without_turn_identity_fails_closed(run_bridge, monkeypatch):
    _, dispatch, delivered, _, _ = run_bridge
    monkeypatch.delenv("DRAMACLAW_TURN_ID")
    result = dispatch()
    assert delivered == []
    assert result["ok"] is False
    assert "turn" in result["message"].lower()


def test_pending_run_timeout_keeps_receipt_queryable(run_bridge, monkeypatch):
    plugin, dispatch, delivered, outcome, _ = run_bridge
    timeouts = []

    def lost(key, **kwargs):
        timeouts.append(kwargs["timeout_result"])
        return None

    original = plugin.wait_canvas_command_result
    monkeypatch.setattr(plugin, "wait_canvas_command_result", lost)
    first = dispatch()
    assert timeouts == [None]
    assert first["cancelled"] is False
    monkeypatch.setattr(plugin, "wait_canvas_command_result", original)
    outcome.update(ok=True, applied=True, canvas_apply_status="accepted", errors=[])
    second = dispatch()
    assert len(delivered) == 1
    assert first["bridge_key"] == second["bridge_key"]
    assert second["ok"] is True


def test_next_turn_reuses_identical_pending_run(run_bridge, monkeypatch):
    plugin, _, _, _, tmp_path = run_bridge

    def lost(_key, **kwargs):
        assert kwargs["timeout_result"] is None
        return None

    monkeypatch.setattr(
        plugin, "_resolve_canvas_generation_recommendations", lambda *_: None
    )
    monkeypatch.setattr(
        plugin, "_external_generation_parameter_preflight", lambda *_: None
    )
    monkeypatch.setattr(plugin, "wait_canvas_command_result", lost)
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    arguments = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "node_ids": ["image"],
    }

    first = handlers["freezone_run_workflow"](arguments)
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-2")
    second = handlers["freezone_run_workflow"](arguments)
    pending = bridge.list_pending_bridge_messages(
        project_id="project-a",
        canvas_id="canvas-a",
        bridge_dir=tmp_path,
    )

    assert first["canvas_apply_status"] == "timeout"
    assert second["canvas_apply_status"] == "timeout"
    assert first["bridge_key"] == second["bridge_key"]
    assert len(pending) == 1


def test_regular_node_action_is_not_subject_to_run_turn_guard(run_bridge, monkeypatch):
    _, dispatch, delivered, _, _ = run_bridge
    monkeypatch.delenv("DRAMACLAW_TURN_ID")
    commands = [
        {"type": "run_node_action", "node_id": "image", "action": "generate_image"}
    ]
    dispatch(commands)
    dispatch(commands)
    assert len(delivered) == 2


def test_persisted_run_with_lost_http_response_blocks_a_new_runner(tmp_path):
    from novelvideo.freezone.workflow_runs import (
        WorkflowRunLeaseConflict,
        create_workflow_run,
        list_workflow_runs,
    )

    arguments = {
        "project_dir": tmp_path,
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "actions": [{"node_id": "image", "action": "generate_image"}],
        "idempotency_key": "canvas-run:original",
        "runner_id": "canvas-runner:original",
    }
    original = create_workflow_run(**arguments)  # HTTP response is lost after commit.
    recovered = create_workflow_run(**arguments)
    assert recovered["run_id"] == original["run_id"]
    with pytest.raises(WorkflowRunLeaseConflict):
        create_workflow_run(
            **{
                **arguments,
                "idempotency_key": "canvas-run:new-turn",
                "runner_id": "canvas-runner:new-turn",
            }
        )
    assert len(list_workflow_runs(project_dir=tmp_path, canvas_id="canvas-a")) == 1

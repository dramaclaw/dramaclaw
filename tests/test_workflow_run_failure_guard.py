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
    # Keep canvas validation local with a deterministic API response.
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

    def dispatch(commands):
        handler = (
            plugin._dispatch_mcp_approved_frontend_commands
            if request.param == "external"
            else plugin._dispatch_frontend_canvas_commands
        )
        return handler(
            project="project-a",
            canvas="canvas-a",
            commands=commands,
            slim_result=True,
        )

    return plugin, dispatch, delivered, outcome, tmp_path


def test_run_workflow_tool_asks_for_confirmation_in_each_turn_without_dispatch(
    run_bridge, monkeypatch
):
    plugin, _, _, _, tmp_path = run_bridge
    confirmation_bodies = []

    def request(method, path, *, body=None, **_kwargs):
        if method == "POST" and path.endswith("/confirmations"):
            confirmation_bodies.append(body)
            return {
                "ok": True,
                "data": {
                    "confirmation_id": "cc_" + "a" * 32,
                    "kinds": ["paid_generation"],
                    "targets": [{
                        "node_id": "image",
                        "title": "Image",
                        "node_type": "imageGenNode",
                        "action": "run_workflow",
                    }],
                    "expires_at": 1900001800.0,
                    "browser_open": False,
                },
            }
        return {"ok": True, "data": {"nodes": [{"id": "image"}]}}

    monkeypatch.setattr(plugin, "_request", request)
    monkeypatch.setattr(
        plugin, "_resolve_canvas_generation_recommendations", lambda *_: None
    )
    monkeypatch.setattr(
        plugin, "_external_generation_parameter_preflight", lambda *_: None
    )
    handlers = {name: handler for name, _schema, handler in plugin.TOOLS}
    arguments = {
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "node_ids": ["image"],
    }

    first = handlers["freezone_run_workflow"](arguments)
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-2")
    second = handlers["freezone_run_workflow"](arguments)

    for result in (first, second):
        assert result["status"] == "confirmation_required"
        assert result["canvas_apply_status"] == "awaiting_confirmation"
        assert result["confirmation_via"] == "conversation"
        assert result["kinds"] == ["paid_generation"]
    assert [body["turn_id"] for body in confirmation_bodies] == ["turn-1", "turn-2"]
    pending = bridge.list_pending_bridge_messages(
        project_id="project-a",
        canvas_id="canvas-a",
        bridge_dir=tmp_path,
    )
    assert len(pending) == 0


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

"""Exercise exact-plan revision through the public Hermes tool and real HTTP routes."""

import copy

import pytest
from jsonschema import Draft202012Validator

from test_api_freezone_workflow_runs import _valid_draft_compiled
from test_api_freezone_workflow_runs import workflow_run_client as _workflow_run_client
from test_freezone_plugin import _load_plugin_module
from test_freezone_plugin import _restore_tools_registry_modules as _registry_fixture

# Reuse the real route client and the plugin registry isolation fixture.
workflow_run_client = _workflow_run_client
_restore_tools_registry_modules = _registry_fixture


@pytest.fixture()
def exact_draft_tool(monkeypatch, workflow_run_client):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "proj_demo")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas_demo")
    monkeypatch.setattr(plugin, "_workflow_runtime_preflight", lambda *a, **kw: {
        "status": "ready", "blockers": [], "warnings": [],
    })
    requests = []

    def request(method, path, *, body=None, **kwargs):
        requests.append((method, path, copy.deepcopy(body)))
        response = workflow_run_client.request(method, "/api/v1" + path, json=body)
        result = response.json()
        if response.status_code >= 400:
            detail = result.get("detail")
            return detail if isinstance(detail, dict) else {"ok": False, "error": detail}
        return result

    monkeypatch.setattr(plugin, "_request", request)
    prepared = plugin._handle_prepare_workflow_plan_draft({
        "plan": _valid_draft_compiled()["plan"],
        "run_after_create": False,
    })
    assert prepared["ok"] is True, prepared
    return plugin, workflow_run_client, requests, prepared


def test_public_exact_plan_patch_revision_and_confirmation(exact_draft_tool, monkeypatch):
    plugin, client, requests, prepared = exact_draft_tool
    changes = {"step_updates": [{"node_id": "brief", "prompt": "新广告要求"}]}
    args = {"draft_id": prepared["draft_id"], "expected_revision": 1, "changes": changes}
    schemas = {name: schema for name, schema, handler in plugin.TOOLS}
    Draft202012Validator(schemas["freezone_patch_workflow_draft"]["parameters"]).validate(args)
    revised = plugin._handle_patch_workflow_draft(args)
    assert revised["ok"] is True, revised
    assert revised["draft_id"] == prepared["draft_id"]
    assert revised["revision"] == 2
    assert revised["plan_digest"] != prepared["plan_digest"]
    target = f"/api/v1/projects/proj_demo/freezone/canvases/canvas_demo/workflow-drafts/{prepared['draft_id']}"
    stored = client.get(target).json()["data"]
    assert stored["compiled"]["plan"]["nodes"][0]["data"]["content"] == "新广告要求"
    emitted = []
    monkeypatch.setattr(plugin, "_emit_canvas_commands", lambda *a, **kw: emitted.append((a, kw)) or {
        "ok": True, "canvas_apply_status": "applied", "applied": True,
        "operation_id": "operation-exact", "durable_receipt": {"receipt_id": "exact"},
    })
    requests.clear()
    stale = plugin._handle_confirm_workflow_draft({"draft_id": prepared["draft_id"], "revision": 1})
    assert stale["status"] == "workflow_draft_revision_conflict"
    assert emitted == []
    assert all(method == "GET" for method, path, body in requests)
    assert client.enqueued_tasks == []
    confirmed = plugin._handle_confirm_workflow_draft({"draft_id": prepared["draft_id"], "revision": 2})
    assert confirmed["ok"] is True, confirmed
    repeated = plugin._handle_confirm_workflow_draft({"draft_id": prepared["draft_id"], "revision": 2})
    assert repeated["ok"] is False
    assert len(emitted) == 1
    assert len(client.enqueued_tasks) == 1
    commands = emitted[0][0][2]
    assert any(command.get("data", {}).get("content") == "新广告要求" for command in commands)


@pytest.mark.parametrize("changes", [
    {"step_updates": [{"node_id": "brief", "semanticOutputRole": "input_text"}]},
    {"step_updates": [{"node_id": "missing", "prompt": "changed"}]},
    {"step_updates": [{"node_id": "brief", "settings": {"model": "illegal"}}]},
    {"step_updates": [{"node_id": "brief", "prompt": "changed"}], "schema_version": "freezone_workflow_intent.v1"},
    {"bindings": [{"source": "brief", "target": "brief", "usage": "prompt"}]},
    {"user_goal": "must not recompile an exact plan as compact intent"},
    {"step_updates": [{"node_id": "brief", "prompt": "changed"}], "summary": "   "},
    {"summary": ["not", "text"]},
    {"step_updates": [{"node_id": "brief", "prompt": "changed"}], "analysis": "not an object"},
])
def test_public_exact_plan_invalid_patch_preserves_draft(exact_draft_tool, changes):
    plugin, client, requests, prepared = exact_draft_tool
    result = plugin._handle_patch_workflow_draft({
        "draft_id": prepared["draft_id"], "expected_revision": 1, "changes": changes,
    })
    assert result["ok"] is False, result
    target = f"/api/v1/projects/proj_demo/freezone/canvases/canvas_demo/workflow-drafts/{prepared['draft_id']}"
    stored = client.get(target).json()["data"]
    assert stored["revision"] == 1
    assert stored["plan_digest"] == prepared["plan_digest"]
    assert stored["status"] == "ready"
    assert client.enqueued_tasks == []


def test_public_exact_plan_patch_revises_summary_and_preview_title(exact_draft_tool):
    plugin, client, requests, prepared = exact_draft_tool
    changes = {
        "step_updates": [{"node_id": "brief", "prompt": "绿色背景广告"}],
        "summary": "绿色背景商品广告",
    }
    args = {"draft_id": prepared["draft_id"], "expected_revision": 1, "changes": changes}
    schemas = {name: schema for name, schema, handler in plugin.TOOLS}
    Draft202012Validator(schemas["freezone_patch_workflow_draft"]["parameters"]).validate(args)
    revised = plugin._handle_patch_workflow_draft(args)
    assert revised["ok"] is True, revised
    assert revised["revision"] == 2
    target = f"/api/v1/projects/proj_demo/freezone/canvases/canvas_demo/workflow-drafts/{prepared['draft_id']}"
    stored = client.get(target).json()["data"]
    assert stored["compiled"]["plan"]["summary"] == "绿色背景商品广告"
    assert stored["intent"]["plan"]["summary"] == "绿色背景商品广告"
    assert stored["preview"]["title"] == "绿色背景商品广告"
    assert stored["compiled"]["plan"]["nodes"][0]["data"]["content"] == "绿色背景广告"
    assert stored["last_changes"]["summary"] == "绿色背景商品广告"

    analysis_only = plugin._handle_patch_workflow_draft({
        "draft_id": prepared["draft_id"], "expected_revision": 2,
        "changes": {"analysis": {"brief": "绿色背景商品广告分析"}},
    })
    assert analysis_only["ok"] is True, analysis_only
    stored = client.get(target).json()["data"]
    assert stored["compiled"]["plan"]["analysis"] == {"brief": "绿色背景商品广告分析"}
    assert stored["intent"]["plan"]["analysis"] == {"brief": "绿色背景商品广告分析"}
    assert stored["last_changes"]["analysis"] == {"brief": "绿色背景商品广告分析"}

    summary_only = plugin._handle_patch_workflow_draft({
        "draft_id": prepared["draft_id"], "expected_revision": 3,
        "changes": {"summary": "仅改摘要"},
    })
    assert summary_only["ok"] is True, summary_only
    stored = client.get(target).json()["data"]
    assert stored["revision"] == 4
    assert stored["preview"]["title"] == "仅改摘要"


def test_public_exact_plan_patch_freezes_updated_execution_policy(exact_draft_tool):
    plugin, client, requests, prepared = exact_draft_tool
    revised = plugin._handle_patch_workflow_draft({
        "draft_id": prepared["draft_id"], "expected_revision": 1,
        "changes": {"step_updates": [{"node_id": "brief", "prompt": "新版广告"}]},
        "run_after_create": True,
    })
    assert revised["ok"] is True, revised
    assert revised["revision"] == 2
    assert revised["run_after_create"] is True
    stale = plugin._handle_patch_workflow_draft({
        "draft_id": prepared["draft_id"], "expected_revision": 1,
        "changes": {"run_after_create": False},
    })
    assert stale["status"] == "workflow_draft_revision_conflict"
    conflict = plugin._handle_patch_workflow_draft({
        "draft_id": prepared["draft_id"], "expected_revision": 2,
        "changes": {"run_after_create": False}, "run_after_create": True,
    })
    assert conflict["ok"] is False
    target = f"/api/v1/projects/proj_demo/freezone/canvases/canvas_demo/workflow-drafts/{prepared['draft_id']}"
    stored = client.get(target).json()["data"]
    assert stored["revision"] == 2
    assert stored["plan_digest"] == revised["plan_digest"]
    assert stored["run_after_create"] is True

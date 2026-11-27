"""Cross-call plugin state must survive a change of process.

Each tool call may be served by a different process, so nothing a later call
depends on may live in module memory. Every ``_plugin_process`` is a separately
loaded copy of the plugin that shares nothing with the others but the API.
"""

from __future__ import annotations

import sqlite3

import pytest
from jsonschema import Draft202012Validator
from test_freezone_plugin import _install_workflow_draft_api, _load_plugin_module
from test_freezone_plugin import _restore_tools_registry_modules as _registry_fixture  # noqa: F401

from novelvideo.freezone.workflow_drafts import (
    bind_workflow_draft_task,
    cancel_workflow_draft,
    claim_workflow_draft_confirmation,
    create_workflow_draft,
    patch_workflow_draft,
    workflow_drafts_db_path,
)

_COMPILED = {
    "ok": True, "skill_id": "video-ad", "edge_count": 0,
    "plan": {"summary": "ad", "nodes": [], "edges": [], "phases": []},
}
_WRITE = [{"type": "run_node_action", "node_id": "image-a", "action": "generate_image"}]


def _plugin_process(monkeypatch, project_dir):
    plugin = _load_plugin_module()
    _install_workflow_draft_api(monkeypatch, plugin, project_dir)
    monkeypatch.setattr(plugin, "_available", lambda: True)
    monkeypatch.setattr(plugin, "_workflow_draft_dependencies_available", lambda: True)
    return plugin


def _stale_confirmation(monkeypatch, project_dir) -> dict:
    """The user confirmed revision 1 of a draft that has since moved to revision 2."""
    draft = create_workflow_draft(
        project_dir=project_dir, project_id="project-a", canvas_id="canvas-a",
        intent={"skill_id": "video-ad", "user_goal": "ad"}, compiled=_COMPILED,
    )
    scope = {
        "project_dir": project_dir, "canvas_id": "canvas-a", "draft_id": draft["draft_id"],
    }
    _, error = patch_workflow_draft(
        **scope, expected_revision=1,
        intent={"skill_id": "video-ad", "user_goal": "ad"}, compiled=_COMPILED,
    )
    assert error is None
    result = _plugin_process(monkeypatch, project_dir)._handle_confirm_workflow_draft(
        {"draft_id": draft["draft_id"], "revision": 1}
    )
    assert result["status"] == "workflow_draft_revision_conflict"
    assert result["current_revision"] == 2
    return scope


def _write(plugin):
    return plugin._emit_canvas_commands("project-a", "canvas-a", _WRITE, slim_result=True)


def test_revision_conflict_blocks_canvas_writes_in_another_process(monkeypatch, tmp_path):
    _stale_confirmation(monkeypatch, tmp_path)

    result = _write(_plugin_process(monkeypatch, tmp_path))

    assert result["ok"] is False
    assert result["status"] == "canvas_revision_confirmation_required"
    assert "未执行画布操作" in result["user_message"]


def test_canvas_writes_resume_after_the_latest_revision_is_confirmed(monkeypatch, tmp_path):
    scope = _stale_confirmation(monkeypatch, tmp_path)
    plugin = _plugin_process(monkeypatch, tmp_path)
    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is not None

    _, error = claim_workflow_draft_confirmation(**scope, revision=2)
    assert error is None
    bind_workflow_draft_task(**scope, task_id="task-1", root_task_id="task-1")

    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is None


def test_canvas_writes_resume_after_the_draft_is_cancelled(monkeypatch, tmp_path):
    scope = _stale_confirmation(monkeypatch, tmp_path)
    plugin = _plugin_process(monkeypatch, tmp_path)
    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is not None

    _, error = cancel_workflow_draft(**scope, expected_revision=2)
    assert error is None

    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is None


def test_canvas_writes_resume_after_the_draft_expires(monkeypatch, tmp_path):
    _stale_confirmation(monkeypatch, tmp_path)
    plugin = _plugin_process(monkeypatch, tmp_path)
    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is not None
    with sqlite3.connect(workflow_drafts_db_path(tmp_path)) as conn:
        conn.execute("UPDATE workflow_drafts SET expires_at = 1")
    conn.close()

    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is None


def test_revision_conflict_check_costs_one_request_per_write_batch(monkeypatch, tmp_path):
    plugin = _plugin_process(monkeypatch, tmp_path)
    served = plugin._request
    calls = []
    monkeypatch.setattr(
        plugin, "_request",
        lambda method, path, **kwargs: calls.append((method, path))
        or served(method, path, **kwargs),
    )

    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is None

    assert calls == [(
        "GET",
        "/projects/project-a/freezone/canvases/canvas-a/workflow-draft-revision-conflict",
    )]


@pytest.mark.parametrize(
    "response",
    [
        {"ok": False, "error": "network_error: connection refused"},
        {"ok": False, "status": "failed", "status_code": 503, "error": "unavailable"},
        {"ok": True, "data": "not-an-object"},
    ],
)
def test_canvas_write_is_refused_when_the_conflict_record_cannot_be_read(
    monkeypatch, tmp_path, response,
):
    plugin = _plugin_process(monkeypatch, tmp_path)
    monkeypatch.setattr(plugin, "_request", lambda *_args, **_kwargs: response)

    result = _write(plugin)

    assert result["ok"] is False
    assert result["status"] == "canvas_revision_check_unavailable"
    assert result["retryable"] is True
    assert "未执行画布操作" in result["user_message"]
    assert "Nothing was written" in result["agent_instruction"]
    assert "retry" in result["agent_instruction"].lower()


def test_no_conflict_record_is_consulted_without_an_api(monkeypatch, tmp_path):
    plugin = _plugin_process(monkeypatch, tmp_path)
    monkeypatch.setattr(plugin, "_available", lambda: False)
    monkeypatch.setattr(
        plugin, "_request",
        lambda *_args, **_kwargs: pytest.fail("no API is configured"),
    )

    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is None


def _stale_draft(project_dir) -> dict:
    """A draft the user reviewed at revision 1 that has since moved to revision 2."""
    draft = create_workflow_draft(
        project_dir=project_dir, project_id="project-a", canvas_id="canvas-a",
        intent={"skill_id": "video-ad", "user_goal": "ad"}, compiled=_COMPILED,
    )
    scope = {
        "project_dir": project_dir, "canvas_id": "canvas-a", "draft_id": draft["draft_id"],
    }
    _, error = patch_workflow_draft(
        **scope, expected_revision=1,
        intent={"skill_id": "video-ad", "user_goal": "ad"}, compiled=_COMPILED,
    )
    assert error is None
    return scope


def _answer_stale_claim_with(monkeypatch, plugin, answer):
    """Let every request through except the claim of the stale revision."""
    served = plugin._request

    def request(method, path, **kwargs):
        if method == "POST" and path.endswith("/claim"):
            return answer(lambda: served(method, path, **kwargs))
        return served(method, path, **kwargs)

    monkeypatch.setattr(plugin, "_request", request)


def _confirm_result_schema(plugin) -> dict:
    return next(
        schema["output_schema"] for name, schema, _handler in plugin.TOOLS
        if name == "freezone_confirm_workflow_draft"
    )


def test_stale_confirmation_the_server_recorded_keeps_its_result(monkeypatch, tmp_path):
    scope = _stale_draft(tmp_path)
    plugin = _plugin_process(monkeypatch, tmp_path)

    result = plugin._handle_confirm_workflow_draft(
        {"draft_id": scope["draft_id"], "revision": 1}
    )

    assert result == {
        "ok": False,
        "status": "workflow_draft_revision_conflict",
        "error": "workflow draft revision changed before confirmation",
        "user_message": "工作流草稿在你确认后已被修改，本次确认未创建任何节点，请查看最新方案后重新确认。",
        "retryable": False,
        "current_revision": 2,
        "agent_instruction": (
            "Nothing was created. The draft changed after the user reviewed it. "
            "Read the draft with freezone_get_workflow, show the current "
            "revision's preview to the user, and call "
            "freezone_confirm_workflow_draft only after they explicitly confirm "
            "that exact revision. Never confirm current_revision on your own."
        ),
    }
    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is not None


def _assert_conflict_was_not_recorded(plugin, result, *, status_code=None):
    from novelvideo.chat.mcp_runtime import normalize_structured_result

    assert result["ok"] is False
    assert result["status"] == "workflow_draft_revision_conflict_unrecorded"
    assert result["code"] == "workflow_draft_revision_conflict_unrecorded"
    assert result["retryable"] is True
    assert result["error"]
    assert "未创建任何节点" in result["user_message"]
    assert "Nothing was created" in result["agent_instruction"]
    assert "not a problem with your arguments" in result["agent_instruction"]
    assert "retry" in result["agent_instruction"].lower()
    assert result.get("status_code") == status_code
    schema = _confirm_result_schema(plugin)
    Draft202012Validator(schema).validate(normalize_structured_result(schema, result))


@pytest.mark.parametrize(
    "failure", [ValueError("no API base URL"), TimeoutError("timed out"), RuntimeError("boom")],
)
def test_stale_confirmation_reports_a_claim_request_that_raised(
    monkeypatch, tmp_path, failure,
):
    scope = _stale_draft(tmp_path)
    plugin = _plugin_process(monkeypatch, tmp_path)

    def raise_failure(_serve):
        raise failure

    _answer_stale_claim_with(monkeypatch, plugin, raise_failure)

    result = plugin._handle_confirm_workflow_draft(
        {"draft_id": scope["draft_id"], "revision": 1}
    )

    _assert_conflict_was_not_recorded(plugin, result)


@pytest.mark.parametrize(
    ("response", "status_code"),
    [
        ({"ok": False, "status": "failed", "status_code": 503, "error": "unavailable"}, 503),
        ({"ok": False, "error": "network_error: connection refused"}, None),
        ({"ok": True, "status_code": 200, "data": "not-an-object"}, 200),
        ({"ok": False, "status_code": 200, "status": "workflow_draft_revision_conflict"}, 200),
        (
            {
                "ok": False, "status_code": 200, "status": "some_future_status",
                "error": "workflow draft revision changed", "current_revision": 2,
            },
            200,
        ),
    ],
)
def test_stale_confirmation_reports_a_conflict_the_server_did_not_acknowledge(
    monkeypatch, tmp_path, response, status_code,
):
    scope = _stale_draft(tmp_path)
    plugin = _plugin_process(monkeypatch, tmp_path)
    _answer_stale_claim_with(monkeypatch, plugin, lambda _serve: response)

    result = plugin._handle_confirm_workflow_draft(
        {"draft_id": scope["draft_id"], "revision": 1}
    )

    _assert_conflict_was_not_recorded(plugin, result, status_code=status_code)
    # Nothing was recorded, so the result must not read as a held canvas.
    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is None


def test_stale_confirmation_reports_the_revision_the_server_judged_against(
    monkeypatch, tmp_path,
):
    scope = _stale_draft(tmp_path)
    plugin = _plugin_process(monkeypatch, tmp_path)

    def move_draft_first(serve):
        _, error = patch_workflow_draft(
            **scope, expected_revision=2,
            intent={"skill_id": "video-ad", "user_goal": "ad"}, compiled=_COMPILED,
        )
        assert error is None
        return serve()

    _answer_stale_claim_with(monkeypatch, plugin, move_draft_first)

    result = plugin._handle_confirm_workflow_draft(
        {"draft_id": scope["draft_id"], "revision": 1}
    )

    assert result["status"] == "workflow_draft_revision_conflict"
    assert result["current_revision"] == 3
    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is not None


def test_stale_confirmation_of_a_draft_that_just_expired_says_it_is_unavailable(
    monkeypatch, tmp_path,
):
    scope = _stale_draft(tmp_path)
    plugin = _plugin_process(monkeypatch, tmp_path)

    def expire_draft_first(serve):
        conn = sqlite3.connect(workflow_drafts_db_path(tmp_path))
        with conn:
            conn.execute("UPDATE workflow_drafts SET expires_at = 1")
        conn.close()
        return serve()

    _answer_stale_claim_with(monkeypatch, plugin, expire_draft_first)

    result = plugin._handle_confirm_workflow_draft(
        {"draft_id": scope["draft_id"], "revision": 1}
    )

    assert result["ok"] is False
    assert result["status"] == "workflow_draft_unavailable"
    assert result["error"] == "workflow draft expired"
    assert plugin._revision_conflict_write_error("project-a", "canvas-a") is None

_MODEL_CLARIFICATION = {
    "question": {"id": "compatible_video_model", "options": []},
    "affected_node_ids": ["vid1"],
}


def test_video_model_proof_is_not_kept_where_no_card_can_read_it(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.delenv("DRAMACLAW_TURN_ID", raising=False)

    plugin._remember_server_video_model_clarification(
        "project-a", "canvas-a", dict(_MODEL_CLARIFICATION)
    )

    assert not plugin._clarification_listener_available()
    assert plugin._PENDING_SERVER_VIDEO_MODEL_CLARIFICATIONS == {}


def test_video_model_proof_is_kept_for_a_chat_turn(monkeypatch):
    plugin = _load_plugin_module()
    monkeypatch.delenv("DRAMACLAW_EXTERNAL_MCP", raising=False)
    monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-1")

    plugin._remember_server_video_model_clarification(
        "project-a", "canvas-a", dict(_MODEL_CLARIFICATION)
    )

    assert (
        plugin._peek_server_video_model_clarification(
            "project-a", "canvas-a", "compatible_video_model"
        )
        is not None
    )


# --- Skill Studio drafts -------------------------------------------------

from test_api_freezone_workflow_runs import (  # noqa: E402
    workflow_run_client as _workflow_run_client,
)

workflow_run_client = _workflow_run_client

_STUDIO = {
    "project_id": "proj_demo", "canvas_id": "default",
    "skill_studio_session_id": "studio-a",
}
_OUTLINE = {
    **_STUDIO,
    "mode": "create",
    "reuse_goal": "structured content",
    "stages": [{
        "id": "recipe-a", "recipe_id": "recipe-a", "reuse": "new",
        "new_recipe_craft_gap": "no existing Recipe covers this stage",
    }],
    "expected_recipe_count": 1,
    "catalog_checked": True,
}
_BEGIN = {
    **_STUDIO,
    "mode": "create",
    "artifact_mode": "recipe_only",
    "expected_recipe_count": 1,
    "recipe_targets": ["recipe-a"],
    "generation_attempt_id": "attempt-a",
}
_SESSION_URL = "/api/v1/projects/proj_demo/freezone/agent-generation-sessions/studio-a"


def _studio_process(monkeypatch, client, *, failing=None):
    """A separately loaded plugin whose only link to the others is the real API."""
    plugin = _load_plugin_module()
    monkeypatch.setattr(plugin, "_available", lambda: True)

    def request(method, path, *, body=None, **_kwargs):
        if failing is not None and "/agent-generation-sessions/" in path:
            return dict(failing)
        response = client.request(method, "/api/v1" + path, json=body)
        if response.status_code >= 400:
            return {
                "ok": False, "status": "failed", "status_code": response.status_code,
                "error": str(response.json().get("detail")),
            }
        return {"status_code": response.status_code, **response.json()}

    monkeypatch.setattr(plugin, "_request", request)
    return {name: handler for name, _schema, handler in plugin.TOOLS}


def test_draft_begins_from_an_outline_written_by_another_process(
    monkeypatch, workflow_run_client,
):
    outlined = _studio_process(monkeypatch, workflow_run_client)[
        "freezone_put_agent_catalog_draft_outline"
    ](dict(_OUTLINE))
    assert outlined["ok"] is True, outlined
    stored = workflow_run_client.get(_SESSION_URL).json()["data"]
    assert stored["manifest"] == {}
    assert stored["draft"]["outline"]["stages"][0]["recipe_id"] == "recipe-a"

    begun = _studio_process(monkeypatch, workflow_run_client)[
        "freezone_begin_agent_catalog_draft"
    ](dict(_BEGIN))

    assert begun["ok"] is True, begun
    stored = workflow_run_client.get(_SESSION_URL).json()["data"]
    assert stored["manifest"]["generation_session_id"] == "studio-a"
    assert stored["draft"]["outline"]["stages"][0]["recipe_id"] == "recipe-a"
    assert list(stored["draft"]["operations"]["recipes"]) == ["0"]


def test_each_draft_step_continues_in_another_process(monkeypatch, workflow_run_client):
    for tool, args in (
        ("freezone_put_agent_catalog_draft_outline", _OUTLINE),
        ("freezone_begin_agent_catalog_draft", _BEGIN),
        ("freezone_put_agent_catalog_recipe",
         {**_STUDIO, "index": 0, "recipe": {"id": "recipe-a"}}),
    ):
        result = _studio_process(monkeypatch, workflow_run_client)[tool](dict(args))
        assert result["ok"] is True, (tool, result)

    stored = workflow_run_client.get(_SESSION_URL).json()["data"]["draft"]
    assert stored["recipes"] == {"0": {"id": "recipe-a"}}


def test_begin_without_an_outline_asks_for_the_outline(monkeypatch, workflow_run_client):
    result = _studio_process(monkeypatch, workflow_run_client)[
        "freezone_begin_agent_catalog_draft"
    ](dict(_BEGIN))

    assert result["ok"] is False
    assert result["status"] == "skill_studio_outline_required"


@pytest.mark.parametrize(
    "failure",
    [
        {"ok": False, "error": "network_error: connection refused"},
        {"ok": False, "status": "failed", "status_code": 503, "error": "unavailable"},
        {"ok": True, "data": "not-an-object"},
    ],
)
@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("freezone_begin_agent_catalog_draft", _BEGIN),
        ("freezone_put_agent_catalog_skill", {**_STUDIO, "skill": {"id": "skill-a"}}),
        ("freezone_put_agent_catalog_recipe",
         {**_STUDIO, "index": 0, "recipe": {"id": "recipe-a"}}),
        ("freezone_finish_agent_catalog_draft", _STUDIO),
    ],
)
def test_unreadable_draft_is_not_reported_as_a_missing_one(
    monkeypatch, workflow_run_client, tool, args, failure,
):
    handlers = _studio_process(monkeypatch, workflow_run_client, failing=failure)

    result = handlers[tool](dict(args))

    assert result["ok"] is False
    assert result["status"] == "skill_studio_session_read_failed"
    assert result["retryable"] is True
    assert result["skill_studio_session_id"] == "studio-a"
    assert "not missing" in result["agent_instruction"]
    assert "Retry" in result["agent_instruction"]


def test_outline_that_could_not_be_saved_is_reported(monkeypatch, workflow_run_client):
    handlers = _studio_process(
        monkeypatch, workflow_run_client,
        failing={"ok": False, "error": "network_error: connection refused"},
    )

    result = handlers["freezone_put_agent_catalog_draft_outline"](dict(_OUTLINE))

    assert result["ok"] is False
    assert result["status"] == "skill_studio_session_write_failed"
    assert result["retryable"] is True
    assert "Nothing was saved" in result["agent_instruction"]

"""Keep Freezone tool evidence parsing outside the chat application."""

import ast
from pathlib import Path
from types import SimpleNamespace

from novelvideo.chat.runtime_event_evidence import (
    _codex_freezone_confirmed_execution_policy,
    _codex_freezone_execution_policy_requirement,
    _codex_freezone_is_execution_policy_rejection,
    _codex_freezone_is_generation_preflight_rejection,
    _codex_freezone_write_receipt,
    _codex_freezone_write_result_error,
)


def test_runtime_event_evidence_has_no_application_or_persistence_imports() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/chat/runtime_event_evidence.py"
    )
    tree = ast.parse(source.read_text(encoding="utf-8"))
    imports = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
    ]
    # The tool-name policy leaf is the one novelvideo module this boundary may
    # depend on; everything else stays stdlib-only.
    allowed = ("novelvideo.chat.tool_policy",)
    forbidden = ("novelvideo", "sqlite3", "openai_codex")
    assert all(
        name in allowed or not name.startswith(forbidden)
        for node in imports
        for name in (
            [node.module or ""]
            if isinstance(node, ast.ImportFrom)
            else [alias.name for alias in node.names]
        )
    )


def test_runtime_event_evidence_requires_saved_canvas_identity() -> None:
    event = SimpleNamespace(
        name="dramaclaw.freezone_emit_canvas_command",
        status="completed",
        error=None,
        structured={
            "ok": True,
            "canvas_apply_status": "applied",
            "applied": True,
            "bridge_key": "bridge-a",
            "project_id": "project-a",
            "canvas_id": "canvas-a",
        },
        output=None,
    )
    assert (
        _codex_freezone_write_receipt(
            event, expected_project="project-a", expected_canvas="canvas-a"
        )
        is event.structured
    )
    assert _codex_freezone_write_receipt(event, expected_canvas="canvas-b") is None
    event.structured = {"ok": False, "user_message": "画布写入失败"}
    assert _codex_freezone_write_result_error(event) == "画布写入失败"


def _confirm_event(*, input: dict | None, structured: dict) -> SimpleNamespace:
    return SimpleNamespace(
        type="tool_updated",
        name="dramaclaw.freezone_confirm_workflow_draft",
        call_id="call-confirm",
        status="completed",
        input=input,
        output=None,
        structured=structured,
        error=None,
    )


_POLICY_REJECTION = {
    "ok": False,
    "status": "workflow_draft_execution_policy_changed",
    "error": "Patch the draft and confirm its new revision to change run_after_create.",
    "current_revision": 1,
    "run_after_create": False,
}


def test_execution_policy_rejection_records_the_requested_policy() -> None:
    event = _confirm_event(
        input={"draft_id": "workflow_draft_a", "revision": 1, "run_after_create": True},
        structured=_POLICY_REJECTION,
    )
    assert _codex_freezone_is_execution_policy_rejection(event) is True
    assert _codex_freezone_is_generation_preflight_rejection(event) is True
    assert _codex_freezone_execution_policy_requirement(event) is True


def test_execution_policy_rejection_without_boolean_request_cannot_be_superseded() -> None:
    # The plugin also rejects a non-boolean run_after_create; there is no policy
    # a later receipt could be checked against, so it stays a failure.
    event = _confirm_event(
        input={"draft_id": "workflow_draft_a", "revision": 1, "run_after_create": "true"},
        structured=_POLICY_REJECTION,
    )
    assert _codex_freezone_is_execution_policy_rejection(event) is True
    assert _codex_freezone_execution_policy_requirement(event) is None


def test_other_confirm_rejections_are_not_execution_policy_rejections() -> None:
    conflict = _confirm_event(
        input={"draft_id": "workflow_draft_a", "revision": 1},
        structured={
            "ok": False,
            "status": "workflow_draft_revision_conflict",
            "error": "workflow draft revision changed before confirmation",
        },
    )
    assert _codex_freezone_is_execution_policy_rejection(conflict) is False
    assert _codex_freezone_execution_policy_requirement(conflict) is None
    assert _codex_freezone_is_generation_preflight_rejection(conflict) is False


def test_confirmed_execution_policy_comes_from_a_successful_receipt_only() -> None:
    receipt = {
        "ok": True,
        "canvas_apply_status": "accepted",
        "applied": True,
        "bridge_key": "bridge-1",
        "draft_id": "workflow_draft_a",
    }
    assert _codex_freezone_confirmed_execution_policy(
        _confirm_event(input=None, structured={**receipt, "run_after_create": True})
    ) is True
    assert _codex_freezone_confirmed_execution_policy(
        _confirm_event(input=None, structured={**receipt, "run_after_create": False})
    ) is False
    # An older receipt without the field proves nothing about the policy.
    assert _codex_freezone_confirmed_execution_policy(
        _confirm_event(input=None, structured=receipt)
    ) is None
    # A rejection echoing the draft's policy is not a confirmation.
    assert _codex_freezone_confirmed_execution_policy(
        _confirm_event(input=None, structured=_POLICY_REJECTION)
    ) is None
    other_tool = SimpleNamespace(
        type="tool_updated",
        name="dramaclaw.freezone_emit_canvas_command",
        call_id="call-emit",
        status="completed",
        input=None,
        output=None,
        structured={**receipt, "run_after_create": True},
        error=None,
    )
    assert _codex_freezone_confirmed_execution_policy(other_tool) is None

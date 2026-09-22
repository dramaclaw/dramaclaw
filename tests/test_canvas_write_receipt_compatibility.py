"""Regression tests for Codex/MCP canvas write receipt compatibility.

Run with:
    PYTHONPATH=src .venv/bin/python -m pytest -q \
      tests/test_canvas_write_receipt_compatibility.py
"""

from types import SimpleNamespace

import pytest

from novelvideo.chat.canvas_outcome import receipt_reference
from novelvideo.chat.service import (
    _codex_freezone_write_receipt,
    _codex_freezone_write_result_succeeded,
    _codex_story_revision_conflict,
    _codex_story_validation_receipt_alias,
    _codex_story_write_intent,
)


def _event(
    payload,
    *,
    name="freezone_confirm_workflow_draft",
    status="completed",
    error=None,
    input=None,
):
    return SimpleNamespace(
        name=name,
        status=status,
        error=error,
        input=input,
        structured=payload,
        output=None,
    )


@pytest.mark.parametrize("name", [
    "dramaclaw_create_interactive_story", "dramaclaw_patch_interactive_story",
    "dramaclaw_confirm_interactive_story_stages",
])
def test_story_persistence_receipt_is_a_canvas_write(name):
    payload = {"ok": True, "project_id": "project-a", "canvas_id": "canvas-a", "story_id": "story-a",
               "revision": 2, "refresh_canvas": True}
    event = _event(payload, name=f"dramaclaw.{name}")
    assert _codex_freezone_write_result_succeeded(event)
    assert _codex_freezone_write_receipt(
        event, expected_project="project-a", expected_canvas="canvas-a"
    ) == payload
    assert receipt_reference(payload) == ("", 2)
    for field in ("project_id", "canvas_id", "story_id", "revision", "refresh_canvas"):
        incomplete = {k: v for k, v in payload.items() if k != field}
        assert _codex_freezone_write_receipt(
            _event(incomplete, name=name), expected_project="project-a", expected_canvas="canvas-a"
        ) is None
    for change in ({"project_id": "other"}, {"canvas_id": "other"}):
        assert _codex_freezone_write_receipt(
            _event({**payload, **change}, name=name),
            expected_project="project-a", expected_canvas="canvas-a",
        ) is None
    for change in ({"ok": False}, {"refresh_canvas": False}, {"revision": True}, {"revision": -1}):
        assert not _codex_freezone_write_result_succeeded(_event({**payload, **change}, name=name))
    assert not _codex_freezone_write_result_succeeded(_event(payload, name=name, error="cancelled"))
    # A story receipt does not stand in for a browser-applied ordinary canvas write.
    assert not _codex_freezone_write_result_succeeded(_event(payload))


def test_story_outline_persistence_receipt_is_a_canvas_write():
    payload = {
        "ok": True,
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "outline_id": "outline-a",
        "revision": 2,
        "refresh_canvas": True,
    }
    event = _event(payload, name="dramaclaw_save_interactive_story_outline")

    assert _codex_freezone_write_receipt(
        event, expected_project="project-a", expected_canvas="canvas-a"
    ) == payload
    assert receipt_reference(payload) == ("", 2)

    for field in (
        "project_id",
        "canvas_id",
        "outline_id",
        "revision",
        "refresh_canvas",
    ):
        incomplete = {key: value for key, value in payload.items() if key != field}
        assert _codex_freezone_write_receipt(
            _event(incomplete, name="dramaclaw_save_interactive_story_outline"),
            expected_project="project-a",
            expected_canvas="canvas-a",
        ) is None


def test_story_outline_revision_conflict_identifies_a_rebased_retry():
    event = _event(
        {
            "ok": False,
            "code": "revision_conflict",
            "story_id": "outline-a",
            "current_revision": 3,
        },
        name="dramaclaw_save_interactive_story_outline",
        input={
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "outline": {"outline_id": "outline-a"},
            "base_revision": 1,
            "idempotency_key": "outline-key",
        },
    )

    assert _codex_story_write_intent(
        event, project="project-a", canvas_id="canvas-a"
    ) == (
        "dramaclaw_save_interactive_story_outline",
        "outline-a",
        1,
        "outline-key",
    )
    assert _codex_story_revision_conflict(
        event, project="project-a", canvas_id="canvas-a"
    ) == (
        "dramaclaw_save_interactive_story_outline",
        "outline-a",
        3,
        "outline-key",
    )


def test_valid_story_readback_can_alias_only_its_same_turn_write_revision():
    event = _event(
        {
            "ok": True,
            "valid": True,
            "canvas_id": "canvas-a",
            "story_id": "story-a",
            "revision": 5,
        },
        name="dramaclaw_validate_interactive_story",
    )

    assert _codex_story_validation_receipt_alias(
        event,
        canvas_id="canvas-a",
        story_receipts={"story-a": ("", 4)},
    ) == (("", 5), ("", 4))
    assert (
        _codex_story_validation_receipt_alias(
            event,
            canvas_id="another-canvas",
            story_receipts={"story-a": ("", 4)},
        )
        is None
    )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "ok": True,
            "canvas_apply_status": "accepted",
            "applied": True,
            "bridge_key": "bridge-a",
            "project_id": "project-a",
            "canvas_id": "canvas-a",
        },
        {
            "ok": True,
            "canvas_apply_status": "applied",
            "applied": True,
            "bridge_key": "bridge-b",
            "project_id": "project-a",
            "canvas_id": "canvas-a",
        },
        {
            "ok": True,
            "canvas_apply_status": "direct_applied",
            "applied": True,
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "revision": 7,
        },
    ],
)
def test_accepts_supported_success_receipts(payload):
    assert _codex_freezone_write_result_succeeded(_event(payload)) is True


@pytest.mark.parametrize(
    "payload",
    [
        {"ok": False, "canvas_apply_status": "direct_apply_failed"},
        {"ok": False, "error": "validation failed"},
        {"ok": True, "canvas_apply_status": "timeout"},
        {"ok": True, "applied": False, "applied_count": 0},
        {"ok": True, "applied": True, "status": "completed"},
        {"ok": True, "applied_count": 1},
        {"ok": True, "created_node_count": 3},
        {"ok": True, "tool_call_status": "succeeded"},
        {"ok": True, "canvas_apply_status": "applied", "applied": True},
        {
            "ok": True,
            "canvas_apply_status": "direct_applied",
            "applied": True,
            "project_id": "project-a",
            "canvas_id": "canvas-a",
        },
    ],
)
def test_rejects_failure_or_empty_receipts(payload):
    assert _codex_freezone_write_result_succeeded(_event(payload)) is False


def test_rejects_failed_transport_even_when_payload_claims_success():
    event = _event({"ok": True, "applied": True}, error="MCP transport failed")

    assert _codex_freezone_write_result_succeeded(event) is False


def test_ignores_non_canvas_tools():
    event = _event({"ok": True, "applied": True}, name="freezone_get_canvas")

    assert _codex_freezone_write_result_succeeded(event) is False

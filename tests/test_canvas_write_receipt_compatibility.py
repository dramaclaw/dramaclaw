"""Regression tests for Codex/MCP canvas write receipt compatibility.

Run with:
    PYTHONPATH=src .venv/bin/python -m pytest -q \
      tests/test_canvas_write_receipt_compatibility.py
"""

from types import SimpleNamespace

import pytest

from novelvideo.chat.service import (
    _codex_freezone_write_receipt,
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
    assert _codex_freezone_write_receipt(
        event, expected_project="project-a", expected_canvas="canvas-a"
    ) == payload
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

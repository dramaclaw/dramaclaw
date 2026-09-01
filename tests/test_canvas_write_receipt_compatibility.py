"""Regression tests for Codex/MCP canvas write receipt compatibility.

Run with:
    PYTHONPATH=src .venv/bin/python -m pytest -q \
      tests/test_canvas_write_receipt_compatibility.py
"""

from types import SimpleNamespace

import pytest

from novelvideo.chat.service import _codex_freezone_write_result_succeeded


def _event(payload, *, name="freezone_create_workflow_graph", status="completed", error=None):
    return SimpleNamespace(
        name=name,
        status=status,
        error=error,
        structured=payload,
        output=None,
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"ok": True, "canvas_apply_status": "accepted"},
        {"ok": True, "canvas_apply_status": "applied"},
        {"ok": True, "canvas_apply_status": "direct_applied"},
        {"ok": True, "applied": True},
        {"ok": True, "applied_count": 1},
        {"ok": True, "created_node_count": 3},
        {"ok": True, "tool_call_status": "succeeded"},
        {"result": {"ok": True, "applied": True}},
        {
            "type": "text",
            "text": '{"ok":true,"created_node_count":2,"status":"completed"}',
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

"""Draft persistence is distinct from receipt-backed canvas writes."""

import json
from types import SimpleNamespace

import pytest

from novelvideo.chat.canvas_outcome import finalize_canvas_reply
from novelvideo.chat.runtime_event_evidence import _codex_freezone_ready_workflow_draft


def draft_event(tool="freezone_prepare_workflow", *, container="structured", **changes):
    payload = {
        "ok": True,
        "status": "workflow_draft_ready",
        "draft_id": "draft-a",
        "revision": 1,
        "draft_status": "ready",
        **changes,
    }
    return SimpleNamespace(
        name=f"dramaclaw.{tool}",
        status="completed",
        error=None,
        structured=payload if container == "structured" else None,
        output=(
            (
                {"structuredContent": payload}
                if container == "structuredContent"
                else {"content": [{"type": "text", "text": json.dumps(payload)}]}
            )
            if container != "structured"
            else None
        ),
    )


@pytest.mark.parametrize("container", ["structured", "structuredContent", "text"])
@pytest.mark.parametrize(
    "tool,status",
    [
        ("freezone_prepare_workflow", "workflow_draft_ready"),
        ("freezone_prepare_workflow_draft", "workflow_draft_ready"),
        ("freezone_prepare_workflow_plan_draft", "workflow_draft_ready"),
        ("freezone_patch_workflow_draft", "workflow_draft_updated"),
    ],
)
def test_persisted_draft_needs_approval_not_a_canvas_receipt(tool, status, container):
    payload = _codex_freezone_ready_workflow_draft(
        draft_event(tool, container=container, status=status)
    )
    assert payload is not None
    reply = finalize_canvas_reply(
        "已创建节点。",
        attempts={},
        receipts=set(),
        write_requested=True,
        draft_ready=True,
        draft_updated=payload["status"] == "workflow_draft_updated",
    )
    assert "等待你" in reply
    assert "尚未执行生成" in reply
    assert "操作未完成" not in reply
    assert ("已更新" in reply) == (tool == "freezone_patch_workflow_draft")


@pytest.mark.parametrize(
    "changes",
    [
        {"ok": False},
        {"status": "workflow_draft_revision_conflict"},
        {"status": "workflow_draft_updated"},
        {"draft_id": ""},
        {"revision": None},
        {"revision": True},
        {"revision": "1"},
        {"revision": 0},
        {"revision": -1},
        {"draft_status": "confirmed"},
        {"errors": ["invalid parameters"]},
    ],
)
def test_incomplete_or_failed_result_cannot_exempt_receipt_checks(changes):
    assert _codex_freezone_ready_workflow_draft(draft_event(**changes)) is None


@pytest.mark.parametrize(
    "status,error",
    [("in_progress", None), ("failed", None), ("completed", "connection lost")],
)
def test_unfinished_or_failed_transport_is_not_draft_success(status, error):
    event = draft_event()
    event.status = status
    event.error = error
    assert _codex_freezone_ready_workflow_draft(event) is None


def test_confirm_and_catalog_results_cannot_be_mistaken_for_draft_persistence():
    for tool in ("freezone_confirm_workflow_draft", "workflow_graph_compile"):
        assert _codex_freezone_ready_workflow_draft(draft_event(tool)) is None


@pytest.mark.parametrize("state", ["failed", "in_progress", "timeout", "cancelled"])
def test_draft_success_never_masks_canvas_write_problems(state):
    reply = finalize_canvas_reply(
        "已创建节点。",
        attempts={"confirm": state},
        receipts=set(),
        draft_ready=True,
        draft_updated=True,
        failure="画布保存失败",
    )
    assert "草稿已更新" not in reply
    assert "尚未执行生成" not in reply
    if state == "failed":
        assert reply == "画布操作未完成：画布保存失败"

from __future__ import annotations

import asyncio
import sqlite3

import pytest

from novelvideo.freezone.agent_billing_state import (
    confirm_billing_quote,
    consume_billing_confirmation,
    create_billing_quote,
    due_billing_settlements,
    enqueue_billing_settlement,
    mark_billing_settlement_failed,
    mark_billing_settlement_projected,
    mark_billing_settlement_succeeded,
)


def _quote(tmp_path, operation: dict | None = None) -> dict:
    return create_billing_quote(
        project_dir=tmp_path,
        user_id="user-a",
        project_id="project-a",
        canvas_id="canvas-a",
        feature_key="freezone.agent.creative_planning",
        operation_kind="workflow_planning_create",
        operation=operation or {"intent": {"user_goal": "广告"}},
        amount=12,
        price_version="planning-v1",
        display="12 积分",
    )


def test_confirmation_receipt_is_hashed_scoped_and_operation_bound(tmp_path) -> None:
    operation = {"intent": {"user_goal": "广告"}}
    quote = _quote(tmp_path, operation)
    confirmed = confirm_billing_quote(
        project_dir=tmp_path,
        quote_id=quote["quote_id"],
        user_id="user-a",
        project_id="project-a",
        canvas_id="canvas-a",
    )

    with sqlite3.connect(tmp_path / "data.db") as conn:
        stored_hash = conn.execute(
            "SELECT receipt_hash FROM agent_billing_quotes WHERE quote_id = ?",
            (quote["quote_id"],),
        ).fetchone()[0]
    assert stored_hash != confirmed["receipt"]

    consumed = consume_billing_confirmation(
        project_dir=tmp_path,
        quote_id=quote["quote_id"],
        receipt=confirmed["receipt"],
        user_id="user-a",
        project_id="project-a",
        canvas_id="canvas-a",
        feature_key="freezone.agent.creative_planning",
        operation_kind="workflow_planning_create",
        operation=operation,
    )
    assert consumed["status"] == "consumed"

    # Exact retries are allowed; downstream writes and reservations use quote_id for idempotency.
    consume_billing_confirmation(
        project_dir=tmp_path,
        quote_id=quote["quote_id"],
        receipt=confirmed["receipt"],
        user_id="user-a",
        project_id="project-a",
        canvas_id="canvas-a",
        feature_key="freezone.agent.creative_planning",
        operation_kind="workflow_planning_create",
        operation=operation,
    )

    with pytest.raises(ValueError, match="does not match this operation"):
        consume_billing_confirmation(
            project_dir=tmp_path,
            quote_id=quote["quote_id"],
            receipt=confirmed["receipt"],
            user_id="user-a",
            project_id="project-a",
            canvas_id="canvas-a",
            feature_key="freezone.agent.creative_planning",
            operation_kind="workflow_planning_create",
            operation={"intent": {"user_goal": "另一个广告"}},
        )


def test_confirmation_rejects_cross_user_scope(tmp_path) -> None:
    quote = _quote(tmp_path)

    with pytest.raises(ValueError, match="does not belong"):
        confirm_billing_quote(
            project_dir=tmp_path,
            quote_id=quote["quote_id"],
            user_id="user-b",
            project_id="project-a",
            canvas_id="canvas-a",
        )


def test_confirmation_rejects_mismatched_explicit_action(tmp_path) -> None:
    quote = _quote(tmp_path)

    with pytest.raises(ValueError, match="does not match this confirmation action"):
        confirm_billing_quote(
            project_dir=tmp_path,
            quote_id=quote["quote_id"],
            user_id="user-a",
            project_id="project-a",
            canvas_id="canvas-a",
            expected_operation_kind="workflow_create",
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("user_id", "user-b"),
        ("project_id", "project-b"),
        ("canvas_id", "canvas-b"),
        ("feature_key", "freezone.agent.workflow_design.simple"),
        ("operation_kind", "workflow_planning_patch"),
        ("operation", {"intent": {"user_goal": "篡改后的广告"}}),
    ],
)
def test_consumption_rejects_every_scope_or_operation_mismatch(
    tmp_path, field, value
) -> None:
    operation = {"intent": {"user_goal": "广告"}}
    quote = _quote(tmp_path, operation)
    confirmed = confirm_billing_quote(
        project_dir=tmp_path,
        quote_id=quote["quote_id"],
        user_id="user-a",
        project_id="project-a",
        canvas_id="canvas-a",
    )
    arguments = {
        "project_dir": tmp_path,
        "quote_id": quote["quote_id"],
        "receipt": confirmed["receipt"],
        "user_id": "user-a",
        "project_id": "project-a",
        "canvas_id": "canvas-a",
        "feature_key": "freezone.agent.creative_planning",
        "operation_kind": "workflow_planning_create",
        "operation": operation,
    }
    arguments[field] = value

    with pytest.raises(ValueError, match="does not match this operation"):
        consume_billing_confirmation(**arguments)


def test_confirmation_receipt_is_idempotent_and_expires(tmp_path) -> None:
    operation = {"intent": {"user_goal": "广告"}}
    quote = _quote(tmp_path, operation)
    first = confirm_billing_quote(
        project_dir=tmp_path,
        quote_id=quote["quote_id"],
        user_id="user-a",
        project_id="project-a",
        canvas_id="canvas-a",
    )
    repeated = confirm_billing_quote(
        project_dir=tmp_path,
        quote_id=quote["quote_id"],
        user_id="user-a",
        project_id="project-a",
        canvas_id="canvas-a",
    )
    assert repeated["receipt"] == first["receipt"]

    with sqlite3.connect(tmp_path / "data.db") as conn:
        conn.execute(
            "UPDATE agent_billing_quotes SET expires_at = 0 WHERE quote_id = ?",
            (quote["quote_id"],),
        )
    with pytest.raises(ValueError, match="expired"):
        consume_billing_confirmation(
            project_dir=tmp_path,
            quote_id=quote["quote_id"],
            receipt=repeated["receipt"],
            user_id="user-a",
            project_id="project-a",
            canvas_id="canvas-a",
            feature_key="freezone.agent.creative_planning",
            operation_kind="workflow_planning_create",
            operation=operation,
        )


def test_price_or_price_version_change_creates_a_new_quote(tmp_path) -> None:
    operation = {"intent": {"user_goal": "广告"}}
    original = _quote(tmp_path, operation)
    repriced = create_billing_quote(
        project_dir=tmp_path,
        user_id="user-a",
        project_id="project-a",
        canvas_id="canvas-a",
        feature_key="freezone.agent.creative_planning",
        operation_kind="workflow_planning_create",
        operation=operation,
        amount=13,
        price_version="planning-v2",
        display="13 积分",
    )

    assert repriced["quote_id"] != original["quote_id"]


def test_settlement_outbox_retries_with_backoff_and_reaches_terminal_state(
    tmp_path,
) -> None:
    enqueue_billing_settlement(
        project_dir=tmp_path,
        reservation_id="reservation-a",
        project_id="project-a",
        canvas_id="canvas-a",
        draft_id="workflow_draft_a",
        action="confirm",
        metadata={"outcome": "planning_delivered"},
    )
    assert (
        due_billing_settlements(project_dir=tmp_path)[0]["reservation_id"]
        == "reservation-a"
    )

    mark_billing_settlement_failed(
        project_dir=tmp_path,
        reservation_id="reservation-a",
        error="temporary outage",
    )
    assert due_billing_settlements(project_dir=tmp_path) == []

    with sqlite3.connect(tmp_path / "data.db") as conn:
        conn.execute(
            "UPDATE agent_billing_settlements SET next_attempt_at = 0 "
            "WHERE reservation_id = 'reservation-a'"
        )
    retried = due_billing_settlements(project_dir=tmp_path)
    assert retried[0]["attempts"] == 1
    assert retried[0]["metadata"] == {"outcome": "planning_delivered"}

    mark_billing_settlement_succeeded(
        project_dir=tmp_path,
        reservation_id="reservation-a",
    )
    pending_projection = due_billing_settlements(project_dir=tmp_path)
    assert pending_projection[0]["status"] == "settled_projection_pending"

    mark_billing_settlement_projected(
        project_dir=tmp_path,
        reservation_id="reservation-a",
    )
    assert due_billing_settlements(project_dir=tmp_path) == []


def test_reconciler_settles_outbox_and_updates_draft(tmp_path, monkeypatch) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.workflow_drafts import (
        create_workflow_draft,
        read_workflow_draft,
        set_workflow_draft_billing,
    )

    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="canvas-a",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled={
            "ok": True,
            "skill_id": "video-ad",
            "plan": {"nodes": [], "edges": [], "phases": []},
        },
    )
    set_workflow_draft_billing(
        project_dir=tmp_path,
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
        billing={
            "planning": {
                "reservation_id": "reservation-retry",
                "status": "settlement_pending",
            }
        },
    )
    enqueue_billing_settlement(
        project_dir=tmp_path,
        reservation_id="reservation-retry",
        project_id="project-a",
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
        action="confirm",
        metadata={"outcome": "planning_delivered"},
    )
    settled = []

    async def fake_settle(reservation_id, *, confirmed, metadata=None):
        settled.append((reservation_id, confirmed, metadata))

    monkeypatch.setattr(freezone, "settle_agent_capability_charge", fake_settle)
    asyncio.run(freezone._reconcile_agent_billing_settlements(tmp_path))

    stored, error = read_workflow_draft(
        project_dir=tmp_path,
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
    )
    assert error is None
    assert stored is not None
    assert stored["billing"]["planning"]["status"] == "confirmed"
    assert settled == [("reservation-retry", True, {"outcome": "planning_delivered"})]


def test_reconciler_recovers_projection_without_repeating_external_settlement(
    tmp_path, monkeypatch
) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.workflow_drafts import (
        create_workflow_draft,
        read_workflow_draft,
        set_workflow_draft_billing,
    )

    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="canvas-a",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled={
            "ok": True,
            "skill_id": "video-ad",
            "plan": {"nodes": [], "edges": [], "phases": []},
        },
    )
    set_workflow_draft_billing(
        project_dir=tmp_path,
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
        billing={
            "planning": {
                "reservation_id": "reservation-projection",
                "status": "settlement_pending",
            }
        },
    )
    enqueue_billing_settlement(
        project_dir=tmp_path,
        reservation_id="reservation-projection",
        project_id="project-a",
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
        action="confirm",
        metadata={"outcome": "planning_delivered"},
    )
    mark_billing_settlement_succeeded(
        project_dir=tmp_path,
        reservation_id="reservation-projection",
    )

    async def fail_if_settled_again(*_args, **_kwargs):
        pytest.fail("external settlement must not repeat after it already succeeded")

    monkeypatch.setattr(
        freezone, "settle_agent_capability_charge", fail_if_settled_again
    )
    asyncio.run(freezone._reconcile_agent_billing_settlements(tmp_path))

    stored, error = read_workflow_draft(
        project_dir=tmp_path,
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
    )
    assert error is None
    assert stored is not None
    assert stored["billing"]["planning"]["status"] == "confirmed"
    assert due_billing_settlements(project_dir=tmp_path) == []


def test_reconciler_refunds_cancelled_workflow_reservation(
    tmp_path, monkeypatch
) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.workflow_drafts import (
        create_workflow_draft,
        read_workflow_draft,
        set_workflow_draft_billing,
    )

    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="canvas-a",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled={
            "ok": True,
            "skill_id": "video-ad",
            "plan": {"nodes": [], "edges": [], "phases": []},
        },
    )
    set_workflow_draft_billing(
        project_dir=tmp_path,
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
        billing={
            "reservation_id": "workflow-reservation-refund",
            "status": "settlement_pending",
        },
    )
    enqueue_billing_settlement(
        project_dir=tmp_path,
        reservation_id="workflow-reservation-refund",
        project_id="project-a",
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
        action="refund",
        metadata={"outcome": "ready"},
    )
    settled = []

    async def fake_settle(reservation_id, *, confirmed, metadata=None):
        settled.append((reservation_id, confirmed, metadata))

    monkeypatch.setattr(freezone, "settle_agent_capability_charge", fake_settle)
    asyncio.run(freezone._reconcile_agent_billing_settlements(tmp_path))

    stored, error = read_workflow_draft(
        project_dir=tmp_path,
        canvas_id="canvas-a",
        draft_id=draft["draft_id"],
    )
    assert error is None
    assert stored is not None
    assert stored["billing"]["status"] == "refunded"
    assert settled == [("workflow-reservation-refund", False, {"outcome": "ready"})]

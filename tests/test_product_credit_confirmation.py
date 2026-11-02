from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from contextlib import contextmanager

import pytest

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.ports.usage import FeatureSettlementResolution
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.consumer import VerifiedTaskDelivery
from novelvideo.task_state import TaskStateManager


@pytest.fixture
def product_task(tmp_path):
    ctx = ProjectContext(
        project_id="project",
        project_name="demo",
        owner_type="user",
        owner_id="owner",
        owner_username="alice",
        requester_user_id="alice",
        requester_username="alice",
        requester_principals=(("user", "alice"),),
        effective_role="editor",
        home_node_id="home",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )
    manager = TaskStateManager()
    task_type = "freezone_agent_recipe_result"
    task = manager.create_task_for_project(
        ctx,
        task_type,
        0,
        scope="operation",
        metadata={"feature_credit_reservation_id": "reservation"},
    )
    operation = {
        "operation_id": "operation",
        "project_id": ctx.project_id,
        "task_id": task.task_id,
        "task_type": task_type,
        "product_kind": "recipe_result",
        "status": "delivered",
        "result_ref": {"kind": "recipe_result", "id": "asset"},
    }
    return ctx, manager, task, operation


@pytest.mark.parametrize("task_status", ["running", "completed"])
@pytest.mark.parametrize("failure_first", [False, True])
@pytest.mark.parametrize("previous_confirmation", [None, "other-reservation"])
async def test_poll_persists_confirmation_for_tasks_without_reconciled_marker(
    product_task, monkeypatch, task_status, failure_first, previous_confirmation
):
    from novelvideo.api.routes import freezone

    ctx, manager, task, operation = product_task
    if previous_confirmation:
        manager.update_task_metadata_for_project(
            ctx,
            task.task_type,
            0,
            scope=task.scope,
            expected_task_id=task.task_id,
            metadata={"feature_credit_confirmed_reservation_id": previous_confirmation},
        )
    manager.begin_task_execution_for_project(
        ctx,
        task.task_type,
        0,
        scope=task.scope,
        expected_task_id=task.task_id,
    )
    if task_status == "completed":
        manager.complete_task_for_project(
            ctx,
            task.task_type,
            0,
            scope=task.scope,
            result={"asset": "saved"},
            expected_task_id=task.task_id,
        )
    confirmations = []

    class Meter:
        async def settle_feature_credit_reservation(self, reservation_id, **kwargs):
            confirmations.append(reservation_id)
            if failure_first and len(confirmations) == 1:
                return {"status": "unavailable"}
            return {"status": "completed", "action": kwargs["action"]}

    monkeypatch.setattr(freezone, "get_task_manager", lambda: TaskStateManager())
    monkeypatch.setattr(freezone, "get_usage_meter", Meter)
    if failure_first:
        with pytest.raises(RuntimeError, match="credit confirmation unavailable"):
            await freezone._settle_delivered_agent_product_task(
                ctx=ctx, operation=operation
            )
    await freezone._settle_delivered_agent_product_task(ctx=ctx, operation=operation)

    def unavailable():
        pytest.fail("a persisted confirmation must not contact billing again")

    monkeypatch.setattr(freezone, "get_usage_meter", unavailable)
    await freezone._settle_delivered_agent_product_task(ctx=ctx, operation=operation)
    saved = TaskStateManager().get_task_for_project(
        ctx, task.task_type, 0, scope=task.scope
    )
    assert saved.status == task_status
    if task_status == "completed":
        assert saved.result["asset"] == "saved"
    assert saved.metadata["feature_credit_confirmed_reservation_id"] == "reservation"
    assert confirmations == ["reservation"] * (2 if failure_first else 1)


@pytest.mark.parametrize(
    "settlement", ["completed", "pending", "unavailable", "exception", "refund"]
)
@pytest.mark.parametrize("marker_write_fails", [False, True])
def test_worker_confirmation_survives_reload_and_polling(
    product_task, monkeypatch, settlement, marker_write_fails
):
    from novelvideo.api.routes import freezone
    from novelvideo.task_backend import run_core

    ctx, manager, task, operation = product_task
    if marker_write_fails:

        def failed_write(*_args, **_kwargs):
            raise OSError("confirmation marker write failed")

        monkeypatch.setattr(manager, "update_task_metadata_for_project", failed_write)
    confirmations = []

    class Meter:
        async def resolve_feature_credit_reservation(self, _identity):
            return FeatureSettlementResolution(
                outcome="resolved",
                reservation_id="reservation",
                feature_key="freezone.recipe",
                model_call_credit_policy="feature_included",
            )

        async def settle_feature_credit_reservation(self, reservation_id, **kwargs):
            confirmations.append(reservation_id)
            if len(confirmations) == 1:
                if settlement == "exception":
                    raise RuntimeError("billing unavailable")
                if settlement == "refund":
                    return {"status": "completed", "action": "refund"}
                return {"status": settlement, "action": kwargs["action"]}
            return {"status": "completed", "action": kwargs["action"]}

    async def not_cancelled(**_kwargs):
        return False

    async def no_metrics(*_args, **_kwargs):
        pass

    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(
        run_core,
        "get_project_task_runner",
        lambda _kind: lambda *_args: {"asset": "saved"},
    )
    monkeypatch.setattr(run_core, "is_cancel_requested", not_cancelled)
    monkeypatch.setattr(run_core, "_emit_project_task_metrics", no_metrics)
    monkeypatch.setattr(
        run_core, "_set_project_task_metrics_context", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    monkeypatch.setattr(run_core, "get_usage_meter", Meter)
    monkeypatch.setattr(freezone, "get_usage_meter", Meter)
    monkeypatch.setattr(freezone, "get_task_manager", TaskStateManager)
    delivery = VerifiedTaskDelivery(
        envelope_id="envelope",
        task_type=task.task_type,
        project_id=ctx.project_id,
        requester_user_id="alice",
        episode=0,
        beat_num=None,
        scope=task.scope,
        queue_kind="default",
        payload={},
        billing_metadata={"feature_credit_reservation_id": "reservation"},
        admission=AdmissionContext(
            requester_user_id="alice",
            billing_principal=BillingPrincipal(kind="local", id="alice"),
            credential=CredentialReference("local", "local-newapi", 1),
            admission_id="admission",
            root_task_id=task.task_id,
            admitted_at="2026-08-03T04:05:00Z",
            authz_version=1,
        ),
    )
    assert run_core.run_project_task_core_sync(
        delivery,
        ctx,
        manager,
        run_task_id=task.task_id,
    ) == {"asset": "saved"}
    saved = TaskStateManager().get_task_for_project(
        ctx, task.task_type, 0, scope=task.scope
    )
    assert saved.status == "completed"
    accepted = settlement in {"completed", "pending"}
    assert (
        saved.metadata.get("feature_credit_confirmed_reservation_id") == "reservation"
    ) == (accepted and not marker_write_fails)
    asyncio.run(
        freezone._settle_delivered_agent_product_task(ctx=ctx, operation=operation)
    )

    def unavailable():
        pytest.fail("polling a confirmed worker delivery must not contact billing")

    monkeypatch.setattr(freezone, "get_usage_meter", unavailable)
    asyncio.run(
        freezone._settle_delivered_agent_product_task(ctx=ctx, operation=operation)
    )
    assert confirmations == ["reservation"] * (
        1 if accepted and not marker_write_fails else 2
    )


def test_confirmation_metadata_rejects_stale_task_id(product_task):
    ctx, manager, task, _operation = product_task
    assert not manager.update_task_metadata_for_project(
        ctx,
        task.task_type,
        0,
        scope=task.scope,
        expected_task_id="replaced-task",
        metadata={"feature_credit_confirmed_reservation_id": "reservation"},
    )
    saved = TaskStateManager().get_task_for_project(
        ctx, task.task_type, 0, scope=task.scope
    )
    assert "feature_credit_confirmed_reservation_id" not in saved.metadata


@pytest.mark.parametrize("concurrent_change", ["completed", "replaced"])
def test_confirmation_does_not_overwrite_concurrent_task_change(
    product_task, monkeypatch, concurrent_change
):
    ctx, manager, task, _operation = product_task
    other = TaskStateManager()
    # Finish the one-time stale-task sweep before testing write contention.
    other.get_task_for_project(ctx, task.task_type, 0, scope=task.scope)
    first_attempt = threading.Event()
    confirmation_finished = threading.Event()
    errors = []
    threads = []
    connect = manager._connect_context

    def concurrent_write():
        try:
            with other._connect_context(ctx) as conn:
                conn.execute("PRAGMA busy_timeout = 0")
                if concurrent_change == "completed":
                    sql = (
                        "UPDATE task_states SET status = 'completed', progress = 1, "
                        "completed_at = 'finished', expires_at = '2999-01-01T00:00:00Z' "
                        "WHERE task_id = ?"
                    )
                    params = (task.task_id,)
                else:
                    sql = (
                        "UPDATE task_states SET task_id = 'replacement', "
                        "result_json = ? WHERE task_id = ?"
                    )
                    params = (json.dumps({"asset": "replacement"}), task.task_id)
                try:
                    conn.execute(sql, params)
                    conn.commit()
                except sqlite3.OperationalError as exc:
                    if "locked" not in str(exc):
                        raise
                    # A transactional confirmation holds the write lock. Retry
                    # after it commits; the old implementation allows this
                    # write to finish before saving its stale snapshot.
                    first_attempt.set()
                    assert confirmation_finished.wait(10)
                    conn.execute(sql, params)
        except BaseException as exc:
            errors.append(exc)
        finally:
            first_attempt.set()

    class Cursor:
        def __init__(self, cursor):
            self.cursor = cursor

        def fetchone(self):
            row = self.cursor.fetchone()
            thread = threading.Thread(target=concurrent_write)
            threads.append(thread)
            thread.start()
            assert first_attempt.wait(10)
            return row

    class Connection:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, params=()):
            cursor = self.conn.execute(sql, params)
            if sql.startswith("SELECT ") and "WHERE task_key = ? AND project_id = ?" in sql:
                return Cursor(cursor)
            return cursor

    @contextmanager
    def interleaved_connection(*args, **kwargs):
        with connect(*args, **kwargs) as conn:
            yield Connection(conn)

    monkeypatch.setattr(manager, "_connect_context", interleaved_connection)
    try:
        assert manager.update_task_metadata_for_project(
            ctx,
            task.task_type,
            0,
            scope=task.scope,
            expected_task_id=task.task_id,
            metadata={"feature_credit_confirmed_reservation_id": "reservation"},
        )
    finally:
        confirmation_finished.set()
        for thread in threads:
            thread.join(10)
            assert not thread.is_alive()
    assert not errors
    saved = other.get_task_for_project(ctx, task.task_type, 0, scope=task.scope)
    if concurrent_change == "completed":
        assert saved.status == "completed"
        assert saved.progress == 1
        assert saved.completed_at == "finished"
        assert saved.expires_at == "2999-01-01T00:00:00Z"
    else:
        assert saved.task_id == "replacement"
        assert saved.result == {"asset": "replacement"}


def test_confirmation_preserves_latest_completed_result_and_expiry(product_task):
    ctx, manager, task, _operation = product_task
    other = TaskStateManager()
    other.complete_task_for_project(
        ctx,
        task.task_type,
        0,
        scope=task.scope,
        expected_task_id=task.task_id,
        result={"asset": "saved"},
        metadata={"latest_metadata": True},
        logs=["finished"],
    )
    before = other.get_task_for_project(ctx, task.task_type, 0, scope=task.scope)
    assert manager.update_task_metadata_for_project(
        ctx,
        task.task_type,
        0,
        scope=task.scope,
        expected_task_id=task.task_id,
        metadata={"feature_credit_confirmed_reservation_id": "reservation"},
    )
    saved = other.get_task_for_project(ctx, task.task_type, 0, scope=task.scope)
    assert saved.status == before.status == "completed"
    assert saved.progress == before.progress
    assert saved.completed_at == before.completed_at
    assert saved.expires_at == before.expires_at
    assert saved.logs == before.logs
    assert saved.result["asset"] == "saved"
    assert saved.metadata == {
        **before.metadata,
        "feature_credit_confirmed_reservation_id": "reservation",
    }

import asyncio
import time
from types import SimpleNamespace

import pytest

from novelvideo.task_backend import cancel as cancel_module
from novelvideo.task_backend.cancel import TaskTimedOut


class _FakeTaskManager:
    def __init__(self) -> None:
        self.completed: list[dict] = []
        self.failed: list[dict] = []
        self.updates: list[dict] = []

    def update_progress_for_project(self, *_args, **kwargs) -> None:
        self.updates.append(kwargs)

    def complete_task_for_project(self, *_args, **kwargs) -> None:
        self.completed.append(kwargs)

    def fail_task_for_project(self, *_args, **kwargs) -> None:
        self.failed.append(kwargs)


@pytest.mark.asyncio
async def test_await_with_cancel_watch_times_out_from_deadline():
    async def slow_work():
        await asyncio.sleep(1)

    with pytest.raises(TaskTimedOut) as exc_info:
        await cancel_module.await_with_cancel_watch(
            slow_work(),
            project_id="proj_timeout",
            task_type="single_video",
            episode=1,
            task_id="task_1",
            deadline_monotonic=0.0,
        )

    assert exc_info.value.timeout_seconds == 30 * 60


def test_raise_if_envelope_cancel_requested_checks_deadline():
    with pytest.raises(TaskTimedOut):
        cancel_module.raise_if_envelope_cancel_requested(
            {
                "project_id": "proj_timeout",
                "task_type": "stage_asset",
                "episode": 0,
                "__run_task_id": "task_1",
                "__deadline_monotonic": 0.0,
                "__timeout_seconds": 30 * 60,
            },
            task_type="stage_asset",
        )


def test_remaining_timeout_seconds_uses_envelope_deadline():
    remaining = cancel_module.remaining_timeout_seconds(
        {
            "__deadline_monotonic": time.monotonic() + 20.0,
            "__timeout_seconds": 30 * 60,
        },
        default_seconds=60,
    )

    assert 1 <= remaining <= 20


def test_remaining_timeout_seconds_raises_when_deadline_expired():
    with pytest.raises(TaskTimedOut):
        cancel_module.remaining_timeout_seconds(
            {
                "__deadline_monotonic": 0.0,
                "__timeout_seconds": 30 * 60,
            },
            default_seconds=60,
        )


def test_project_task_timeout_defaults_to_30_minutes_without_celery(monkeypatch):
    from novelvideo.task_backend import run_core

    monkeypatch.delenv("ST_PROJECT_TASK_TIMEOUT_S", raising=False)

    assert run_core._project_task_timeout_seconds() == 30 * 60


def test_project_task_timeout_reads_ce_neutral_env(monkeypatch):
    from novelvideo.task_backend import run_core

    monkeypatch.setenv("ST_PROJECT_TASK_TIMEOUT_S", "42")

    assert run_core._project_task_timeout_seconds() == 42


def test_run_project_task_core_injects_deadline_for_runner(monkeypatch):
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    captured: dict[str, object] = {}

    def fake_runner(envelope, _ctx):
        captured.update(envelope)
        return {"ok": True}

    async def fake_is_cancel_requested(**_kwargs):
        return False

    async def fake_emit_project_task_metrics(*_args, **_kwargs):
        return None

    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "is_cancel_requested", fake_is_cancel_requested)
    monkeypatch.setattr(run_core, "_emit_project_task_metrics", fake_emit_project_task_metrics)
    monkeypatch.setattr(
        run_core,
        "_set_project_task_metrics_context",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    monkeypatch.setattr(run_core, "_project_task_timeout_seconds", lambda: 30 * 60)
    register_project_task_runner("timeout_probe", fake_runner)

    manager = _FakeTaskManager()
    result = run_core.run_project_task_core_sync(
        {
            "project_id": "proj_timeout",
            "requester_user_id": "usr_1",
            "task_type": "timeout_probe",
            "episode": 0,
        },
        SimpleNamespace(project_id="proj_timeout", requester_user_id="usr_1"),
        manager,
        run_task_id="task_1",
    )

    assert result == {"ok": True}
    assert captured["__run_task_id"] == "task_1"
    assert captured["__timeout_seconds"] == 30 * 60
    assert isinstance(captured["__deadline_monotonic"], float)


def test_run_project_task_core_persists_result_before_confirming_credit(monkeypatch):
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    events: list[str] = []

    class OrderedTaskManager(_FakeTaskManager):
        def complete_task_for_project(self, *_args, **kwargs) -> bool:
            events.append("persisted")
            super().complete_task_for_project(*_args, **kwargs)
            return True

    class UsageMeter:
        async def settle_feature_credit_reservation(
            self, _reservation_id, *, action, metadata=None
        ):
            events.append(action)
            return {"decision": action, "metadata": metadata or {}}

    def fake_runner(_envelope, _ctx):
        return {"asset_id": "asset_1"}

    async def fake_is_cancel_requested(**_kwargs):
        return False

    async def fake_emit_project_task_metrics(*_args, **_kwargs):
        events.append("metrics")

    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "is_cancel_requested", fake_is_cancel_requested)
    monkeypatch.setattr(run_core, "get_usage_meter", lambda: UsageMeter())
    monkeypatch.setattr(run_core, "_emit_project_task_metrics", fake_emit_project_task_metrics)
    monkeypatch.setattr(
        run_core,
        "_set_project_task_metrics_context",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    register_project_task_runner("result_settlement_order_probe", fake_runner)

    manager = OrderedTaskManager()
    result = run_core.run_project_task_core_sync(
        {
            "project_id": "proj_result",
            "requester_user_id": "usr_1",
            "task_type": "result_settlement_order_probe",
            "episode": 0,
            "billing_metadata": {
                "feature_credit_reservation_id": "reservation_1",
            },
        },
        SimpleNamespace(project_id="proj_result", requester_user_id="usr_1"),
        manager,
        run_task_id="task_1",
    )

    assert result == {"asset_id": "asset_1"}
    assert events == ["persisted", "confirm", "metrics"]


def test_run_project_task_core_refunds_when_completion_persistence_fails(monkeypatch):
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    events: list[tuple[str, dict]] = []

    class FailingTaskManager(_FakeTaskManager):
        def complete_task_for_project(self, *_args, **_kwargs) -> None:
            raise OSError("task state write failed")

    class UsageMeter:
        async def settle_cancelled_feature_credit_reservation(
            self, _reservation_id, *, metadata=None
        ):
            events.append(("refund", metadata or {}))
            return {"decision": "refund"}

    def fake_runner(_envelope, _ctx):
        return {"asset_id": "asset_1"}

    async def fake_is_cancel_requested(**_kwargs):
        return False

    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "is_cancel_requested", fake_is_cancel_requested)
    monkeypatch.setattr(run_core, "get_usage_meter", lambda: UsageMeter())
    monkeypatch.setattr(
        run_core,
        "_set_project_task_metrics_context",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    register_project_task_runner("result_persistence_failure_probe", fake_runner)

    with pytest.raises(OSError, match="task state write failed"):
        run_core.run_project_task_core_sync(
            {
                "project_id": "proj_result",
                "requester_user_id": "usr_1",
                "task_type": "result_persistence_failure_probe",
                "episode": 0,
                "billing_metadata": {
                    "feature_credit_reservation_id": "reservation_1",
                },
            },
            SimpleNamespace(project_id="proj_result", requester_user_id="usr_1"),
            FailingTaskManager(),
            run_task_id="task_1",
        )

    assert events == [
        (
            "refund",
            {
                "source": "task_completion_persist_failed",
                "business_outcome": "not_delivered",
            },
        )
    ]


def test_run_project_task_core_refunds_when_cancel_race_ignores_completion(monkeypatch):
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    events: list[tuple[str, dict]] = []

    class CancelledTaskManager(_FakeTaskManager):
        def complete_task_for_project(self, *_args, **_kwargs) -> bool:
            return False

    class UsageMeter:
        async def settle_cancelled_feature_credit_reservation(
            self, _reservation_id, *, metadata=None
        ):
            events.append(("refund", metadata or {}))
            return {"decision": "refund"}

    def fake_runner(_envelope, _ctx):
        return {"asset_id": "asset_1"}

    async def fake_is_cancel_requested(**_kwargs):
        return False

    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "is_cancel_requested", fake_is_cancel_requested)
    monkeypatch.setattr(run_core, "get_usage_meter", lambda: UsageMeter())
    monkeypatch.setattr(
        run_core,
        "_set_project_task_metrics_context",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    register_project_task_runner("cancel_race_settlement_probe", fake_runner)

    result = run_core.run_project_task_core_sync(
        {
            "project_id": "proj_result",
            "requester_user_id": "usr_1",
            "task_type": "cancel_race_settlement_probe",
            "episode": 0,
            "billing_metadata": {
                "feature_credit_reservation_id": "reservation_1",
            },
        },
        SimpleNamespace(project_id="proj_result", requester_user_id="usr_1"),
        CancelledTaskManager(),
        run_task_id="task_1",
    )

    assert result == {"asset_id": "asset_1"}
    assert events == [
        (
            "refund",
            {
                "source": "task_completion_not_persisted",
                "business_outcome": "not_delivered",
            },
        )
    ]

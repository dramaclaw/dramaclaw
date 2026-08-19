from __future__ import annotations

from types import SimpleNamespace

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.task_backend.consumer import VerifiedTaskDelivery
from novelvideo.task_backend.envelope import RunningTaskAuthorityIndeterminate


class Manager:
    def __init__(self) -> None:
        self.failures: list[dict] = []

    def begin_task_execution_for_project(self, *_args, **_kwargs) -> bool:
        return True

    def fail_task_for_project(self, *_args, **kwargs) -> None:
        self.failures.append(kwargs)


def _delivery() -> VerifiedTaskDelivery:
    admission = AdmissionContext(
        requester_user_id="user-1",
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            "organization", "credential-1", 2, org_id="org-1"
        ),
        admission_id="admission-1",
        root_task_id="task-1",
        admitted_at="2026-08-18T00:00:00Z",
        membership_id="membership-1",
        authz_version=2,
    )
    return VerifiedTaskDelivery(
        envelope_id="envelope-1",
        admission=admission,
        task_type="running_authz_probe",
        project_id="project-1",
        requester_user_id="user-1",
        episode=1,
        beat_num=None,
        scope=None,
        queue_kind="default",
        payload={},
        billing_metadata={
            "feature_credit_reservation_id": "foreign-reservation",
            "feature_credit_charge_id": "foreign-charge",
            "feature_key": "forged.feature",
            "model_call_credit_policy": "forged-policy",
            "feature_credit_cost": 0,
        },
    )


def test_post_start_authz_indeterminate_is_review_only(monkeypatch) -> None:
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    reviews: list[tuple[str, dict]] = []
    metric_contexts: list[dict] = []

    class Usage:
        async def resolve_feature_credit_reservation(self, identity):
            from novelvideo.ports.usage import FeatureSettlementResolution

            assert identity.root_task_id == "task-1"
            assert identity.project_id == "project-1"
            assert identity.requester_user_id == "user-1"
            return FeatureSettlementResolution(
                outcome="resolved",
                reservation_id="reservation-1",
                feature_key="mainline.beat_video_generation",
                model_call_credit_policy="feature_included",
            )

        async def mark_feature_credit_settlement_for_review(
            self, reservation_id, *, metadata=None
        ):
            reviews.append((reservation_id, metadata or {}))
            return {"status": "awaiting"}

        async def settle_cancelled_feature_credit_reservation(self, *_args, **_kwargs):
            raise AssertionError("running uncertainty must not refund")

        async def settle_feature_credit_reservation(self, *_args, **_kwargs):
            raise AssertionError("running uncertainty must not confirm")

    def runner(runner_envelope, _ctx):
        assert runner_envelope["billing_metadata"] == {
            "feature_credit_reservation_id": "reservation-1",
            "feature_key": "mainline.beat_video_generation",
            "model_call_credit_policy": "feature_included",
        }
        raise RunningTaskAuthorityIndeterminate(failure_kind="unavailable")

    async def not_cancelled(**_kwargs):
        return False

    async def no_metrics(*_args, **_kwargs):
        return None

    register_project_task_runner("running_authz_probe", runner)
    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "is_cancel_requested", not_cancelled)
    monkeypatch.setattr(run_core, "get_usage_meter", lambda: Usage())
    monkeypatch.setattr(run_core, "_emit_project_task_metrics", no_metrics)
    monkeypatch.setattr(
        run_core,
        "_set_project_task_metrics_context",
        lambda *_a, **kwargs: metric_contexts.append(kwargs["billing_metadata"]),
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)

    manager = Manager()
    result = run_core.run_project_task_core_sync(
        _delivery(),
        SimpleNamespace(
            project_id="project-1", requester_user_id="user-1", is_home_node=True
        ),
        manager,
        run_task_id="task-1",
    )

    assert result == {
        "failed": True,
        "error_code": "TASK_AUTHZ_REVALIDATION_INDETERMINATE",
        "failure_kind": "unavailable",
    }
    assert reviews == [
        (
            "reservation-1",
            {
                "source": "task_authz_revalidation_indeterminate",
                "error_code": "TASK_AUTHZ_REVALIDATION_INDETERMINATE",
                "failure_kind": "unavailable",
            },
        )
    ]
    assert manager.failures[0]["metadata"]["error_code"] == (
        "TASK_AUTHZ_REVALIDATION_INDETERMINATE"
    )
    assert metric_contexts == [
        {
            "feature_credit_reservation_id": "reservation-1",
            "feature_key": "mainline.beat_video_generation",
            "model_call_credit_policy": "feature_included",
        }
    ]
    assert "foreign-reservation" not in repr(metric_contexts)
    assert "forged" not in repr(metric_contexts)
    assert "feature_credit_cost" not in repr(metric_contexts)


def test_ambiguous_settlement_resolution_fails_before_runner(monkeypatch) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    invoked = False

    class Usage:
        async def resolve_feature_credit_reservation(self, _identity):
            return FeatureSettlementResolution(outcome="ambiguous")

    def runner(_envelope, _ctx):
        nonlocal invoked
        invoked = True

    register_project_task_runner("running_authz_probe", runner)
    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "get_usage_meter", lambda: Usage())

    manager = Manager()
    result = run_core.run_project_task_core_sync(
        _delivery(),
        SimpleNamespace(
            project_id="project-1", requester_user_id="user-1", is_home_node=True
        ),
        manager,
        run_task_id="task-1",
    )

    assert result == {
        "failed": True,
        "error_code": "FEATURE_SETTLEMENT_RESOLUTION_AMBIGUOUS",
    }
    assert invoked is False
    assert manager.failures[0]["metadata"]["error_code"] == (
        "FEATURE_SETTLEMENT_RESOLUTION_AMBIGUOUS"
    )


def test_settlement_resolution_fault_fails_task_before_runner(monkeypatch) -> None:
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    invoked = False
    metric_outcomes: list[str] = []

    class Usage:
        async def resolve_feature_credit_reservation(self, _identity):
            raise ConnectionError("postgres://user:secret-canary@internal")

    def runner(_envelope, _ctx):
        nonlocal invoked
        invoked = True

    async def capture_metrics(*_args, **kwargs):
        metric_outcomes.append(str(kwargs.get("outcome") or ""))

    register_project_task_runner("running_authz_probe", runner)
    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "get_usage_meter", lambda: Usage())
    monkeypatch.setattr(run_core, "_emit_project_task_metrics", capture_metrics)

    manager = Manager()
    result = run_core.run_project_task_core_sync(
        _delivery(),
        SimpleNamespace(
            project_id="project-1", requester_user_id="user-1", is_home_node=True
        ),
        manager,
        run_task_id="task-1",
    )

    assert result == {
        "failed": True,
        "error_code": "FEATURE_SETTLEMENT_RESOLUTION_FAILED",
    }
    assert invoked is False
    assert metric_outcomes == ["failed"]
    assert manager.failures[0]["metadata"]["error_code"] == (
        "FEATURE_SETTLEMENT_RESOLUTION_FAILED"
    )
    assert "secret-canary" not in str(manager.failures)

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
        billing_metadata={"feature_credit_reservation_id": "reservation-1"},
    )


def test_post_start_authz_indeterminate_is_review_only(monkeypatch) -> None:
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    reviews: list[tuple[str, dict]] = []

    class Usage:
        async def mark_feature_credit_settlement_for_review(
            self, reservation_id, *, metadata=None
        ):
            reviews.append((reservation_id, metadata or {}))
            return {"status": "awaiting"}

        async def settle_cancelled_feature_credit_reservation(self, *_args, **_kwargs):
            raise AssertionError("running uncertainty must not refund")

        async def settle_feature_credit_reservation(self, *_args, **_kwargs):
            raise AssertionError("running uncertainty must not confirm")

    def runner(_envelope, _ctx):
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
        run_core, "_set_project_task_metrics_context", lambda *_a, **_k: None
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

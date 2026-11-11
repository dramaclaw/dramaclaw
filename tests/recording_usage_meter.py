"""Recording usage port for provider-free workflow tests."""

from contextlib import contextmanager
from typing import Any, Optional

from novelvideo import llm_instrumentation as usage
from novelvideo.ports import get_usage_meter
from novelvideo.ports.registry import register_port
from novelvideo.ports.usage import FeatureSettlementResolution, VerifiedTaskSettlementIdentity


class RecordingUsageMeter:
    def __init__(self, billable_task_types=()):
        self.billable_task_types = set(billable_task_types)
        self.calls = []
        self.charges = []

    def _record(self, method, arguments):
        self.calls.append((method, {key: value for key, value in arguments.items()
                                    if key != "self"}))

    @contextmanager
    def registered(self):
        previous = get_usage_meter()
        register_port("usage_meter", self)
        try:
            yield self
        finally:
            register_port("usage_meter", previous)

    async def resolve_feature_credit_reservation(
        self,
        identity: VerifiedTaskSettlementIdentity,
    ) -> FeatureSettlementResolution:
        self._record("resolve_feature_credit_reservation", locals())
        if identity.task_type not in self.billable_task_types:
            return FeatureSettlementResolution(outcome="not_applicable")
        if identity.root_task_id not in self.charges:
            self.charges.append(identity.root_task_id)
        return FeatureSettlementResolution(
            outcome="resolved", reservation_id=f"res:{identity.root_task_id}",
            feature_key=identity.feature_key or identity.task_type,
            model_call_credit_policy="feature_included",
        )

    async def reserve_current_model_call_credit(
        self,
        *,
        model: str,
        project_id: Optional[str] = None,
        resource_kind: str = "",
        billing_kind: str = "model",
        billing_params: Optional[dict[str, Any]] = None,
        billing_quantity: int | float | str | None = 1,
        metadata: Optional[dict[str, Any]] = None,
    ) -> str:
        arguments = {**locals(), "user_context": usage.get_llm_user_context()}
        self._record("reserve_current_model_call_credit", arguments)
        return "model-reservation"

    async def refund_model_call_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        self._record("refund_model_call_credit_reservation", locals())

    async def update_current_model_call_log(
        self,
        *,
        request_payload: Optional[dict[str, Any]] = None,
        response_payload: Optional[dict[str, Any]] = None,
        error_message: str = "",
    ) -> None:
        self._record("update_current_model_call_log", locals())

    async def reserve_feature_start_credits(
        self,
        *,
        user_id: str,
        feature_key: str,
        product_surface: str,
        project_id: str = "",
        resource_kind: str = "",
        task_id: str = "",
        task_type: str = "",
        metadata: Optional[dict[str, Any]] = None,
        params: Optional[dict[str, Any]] = None,
        quantity: int | float | str | None = 1,
        idempotency_key: str = "",
        require_price_rule: bool = False,
        require_positive_cost: bool = False,
    ) -> dict[str, Any]:
        self._record("reserve_feature_start_credits", locals())
        return {"id": f"res:{task_id}", "reserved": True, "cost": 1,
                "model_call_credit_policy": "feature_included"}

    async def require_feature_credit_balance(
        self,
        *,
        user_id: str,
        feature_key: str,
        project_id: str = "",
        resource_kind: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        self._record("require_feature_credit_balance", locals())
        return {"allowed": True, "balance": 100}

    async def confirm_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        self._record("confirm_feature_credit_reservation", locals())

    async def refund_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        self._record("refund_feature_credit_reservation", locals())

    async def settle_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        action: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        self._record("settle_feature_credit_reservation", locals())
        return {"reservation_id": reservation_id, "action": action, "status": "completed"}

    async def settle_cancelled_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        self._record("settle_cancelled_feature_credit_reservation", locals())
        return {"reservation_id": reservation_id, "decision": "refund", "status": "completed"}

    async def mark_feature_credit_settlement_for_review(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        self._record("mark_feature_credit_settlement_for_review", locals())
        return {"reservation_id": reservation_id, "action": "review", "status": "awaiting"}

    async def mark_model_call_credit_settlement_for_review(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        self._record("mark_model_call_credit_settlement_for_review", locals())
        return {"reservation_id": reservation_id, "action": "review", "status": "awaiting"}

    async def mark_current_paid_execution_attempt(
        self,
        *,
        status: str,
        provider_request_id: str = "",
        provider_task_id: str = "",
        provider_response_id: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        self._record("mark_current_paid_execution_attempt", locals())

    async def bump_model_call(
        self,
        *,
        user_id: Optional[str],
        model: str = "",
        project_id: Optional[str] = None,
        resource_kind: str = "",
        provider_request_id: str = "",
        provider_task_id: str = "",
        credit_reservation_id: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        self._record("bump_model_call", locals())

    def set_llm_usage_context(
        self,
        user_id: Optional[str],
        project_id: Optional[str] = None,
        resource_kind: str = "",
        billing_metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        self._record("set_llm_usage_context", locals())
        usage.set_llm_usage_context(
            user_id, project_id, resource_kind, billing_metadata,
        )

    def clear_llm_usage_context(self) -> None:
        self._record("clear_llm_usage_context", locals())
        usage.clear_llm_usage_context()

    async def set_project_llm_usage_context(
        self,
        *,
        username: Optional[str],
        project_name: Optional[str],
        resource_kind: str = "",
        billing_metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        self._record("set_project_llm_usage_context", locals())

    async def get_user_credit_balance(self, user_id: str) -> int | None:
        self._record("get_user_credit_balance", locals())
        return 100

    async def bump_content_counter(
        self,
        *,
        user_id: Optional[str],
        metric: str,
        value: int,
        model: str = "",
        project_id: Optional[str] = None,
        resource_kind: str = "",
    ) -> None:
        self._record("bump_content_counter", locals())

    async def log_resource_attempts(
        self,
        *,
        user_id: Optional[str],
        project_id: Optional[str],
        kind: str,
        refs: list[str],
        outcome: str = "success",
        model: str = "",
    ) -> None:
        self._record("log_resource_attempts", locals())

    async def record_llm_tokens(
        self,
        *,
        user_id: Optional[str],
        input_tokens: int,
        output_tokens: int,
        model: Optional[str] = None,
        project_id: Optional[str] = None,
        resource_kind: str = "",
    ) -> None:
        self._record("record_llm_tokens", locals())


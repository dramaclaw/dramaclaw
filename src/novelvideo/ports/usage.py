"""Usage and provider instrumentation ports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional, Protocol


@dataclass(frozen=True)
class VerifiedTaskSettlementIdentity:
    """Signed task identity used to resolve durable settlement state."""

    root_task_id: str
    project_id: str
    requester_user_id: str
    task_type: str
    episode: int
    beat_num: int | None
    scope: str | None


@dataclass(frozen=True)
class FeatureSettlementResolution:
    """Authoritative feature-reservation lookup result."""

    outcome: Literal["not_applicable", "resolved", "ambiguous", "conflict"]
    reservation_id: str = ""
    feature_key: str = ""
    model_call_credit_policy: str = ""

    def __post_init__(self) -> None:
        allowed = {"not_applicable", "resolved", "ambiguous", "conflict"}
        if self.outcome not in allowed:
            raise ValueError("unsupported feature settlement outcome")
        clean_reservation_id = str(self.reservation_id or "").strip()
        clean_feature_key = str(self.feature_key or "").strip()
        clean_model_call_credit_policy = str(
            self.model_call_credit_policy or ""
        ).strip()
        if self.outcome == "resolved" and not clean_reservation_id:
            raise ValueError("resolved settlement requires reservation_id")
        if self.outcome != "resolved" and any(
            (
                clean_reservation_id,
                clean_feature_key,
                clean_model_call_credit_policy,
            )
        ):
            raise ValueError(
                "non-resolved settlement forbids reservation_id or authoritative fields"
            )
        object.__setattr__(self, "reservation_id", clean_reservation_id)
        object.__setattr__(self, "feature_key", clean_feature_key)
        object.__setattr__(
            self,
            "model_call_credit_policy",
            clean_model_call_credit_policy,
        )

    def trusted_billing_metadata(self) -> dict[str, str]:
        if self.outcome != "resolved":
            return {}
        if not self.feature_key or not self.model_call_credit_policy:
            raise ValueError("resolved settlement requires a complete billing snapshot")
        return {
            key: value
            for key, value in {
                "feature_credit_reservation_id": self.reservation_id,
                "feature_key": self.feature_key,
                "model_call_credit_policy": self.model_call_credit_policy,
            }.items()
            if value
        }


class FeatureSettlementResolutionRejected(RuntimeError):
    """Durable evidence cannot select one reservation safely."""

    def __init__(self, outcome: Literal["ambiguous", "conflict"]) -> None:
        if outcome not in {"ambiguous", "conflict"}:
            raise ValueError("unsupported rejected settlement outcome")
        self.outcome = outcome
        self.code = f"FEATURE_SETTLEMENT_RESOLUTION_{outcome.upper()}"
        message = {
            "ambiguous": "feature settlement resolution is ambiguous",
            "conflict": "feature settlement resolution conflicts with durable state",
        }[outcome]
        super().__init__(message)


class FeatureCreditSettlementConflict(RuntimeError):
    """A reservation has already advanced to an incompatible final action."""

    def __init__(self) -> None:
        super().__init__(
            "feature credit settlement action conflicts with durable state"
        )


class UsageMeter(Protocol):
    async def resolve_feature_credit_reservation(
        self,
        identity: VerifiedTaskSettlementIdentity,
    ) -> FeatureSettlementResolution: ...

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
    ) -> str: ...

    async def refund_model_call_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None: ...

    async def update_current_model_call_log(
        self,
        *,
        request_payload: Optional[dict[str, Any]] = None,
        response_payload: Optional[dict[str, Any]] = None,
        error_message: str = "",
    ) -> None:
        """Update observability payloads without entering the credit-settlement path."""
        ...

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
    ) -> dict[str, Any]: ...

    async def require_feature_credit_balance(
        self,
        *,
        user_id: str,
        feature_key: str,
        project_id: str = "",
        resource_kind: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]: ...

    async def confirm_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None: ...

    async def refund_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None: ...

    async def settle_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        action: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]: ...

    async def settle_cancelled_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Refund a reservation when no usable business result was delivered."""
        ...

    async def mark_feature_credit_settlement_for_review(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Keep a post-start reservation in review without refund or confirm."""
        ...

    async def mark_model_call_credit_settlement_for_review(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Keep an accepted provider model reservation for reconciliation."""
        ...

    async def mark_current_paid_execution_attempt(
        self,
        *,
        status: str,
        provider_request_id: str = "",
        provider_task_id: str = "",
        provider_response_id: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> None: ...

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
    ) -> None: ...

    def set_llm_usage_context(
        self,
        user_id: Optional[str],
        project_id: Optional[str] = None,
        resource_kind: str = "",
        billing_metadata: Optional[dict[str, Any]] = None,
    ) -> None: ...

    def clear_llm_usage_context(self) -> None: ...

    async def set_project_llm_usage_context(
        self,
        *,
        username: Optional[str],
        project_name: Optional[str],
        resource_kind: str = "",
        billing_metadata: Optional[dict[str, Any]] = None,
    ) -> None: ...

    async def get_user_credit_balance(self, user_id: str) -> int | None: ...

    async def bump_content_counter(
        self,
        *,
        user_id: Optional[str],
        metric: str,
        value: int,
        model: str = "",
        project_id: Optional[str] = None,
        resource_kind: str = "",
    ) -> None: ...

    async def log_resource_attempts(
        self,
        *,
        user_id: Optional[str],
        project_id: Optional[str],
        kind: str,
        refs: list[str],
        outcome: str = "success",
        model: str = "",
    ) -> None: ...

    async def record_llm_tokens(
        self,
        *,
        user_id: Optional[str],
        input_tokens: int,
        output_tokens: int,
        model: Optional[str] = None,
        project_id: Optional[str] = None,
        resource_kind: str = "",
    ) -> None: ...


class ProviderInstrumentation(Protocol):
    def install(self) -> None: ...

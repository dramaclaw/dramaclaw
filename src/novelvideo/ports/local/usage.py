"""Local CE usage port implementations."""

from __future__ import annotations

from typing import Any, Optional

from novelvideo.llm_instrumentation import (
    clear_llm_usage_context,
    set_llm_usage_context,
)


class NoOpUsageMeter:
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
        return ""

    async def refund_model_call_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        return None

    async def reserve_feature_start_credits(
        self,
        *,
        user_id: str,
        feature_key: str,
        project_id: str = "",
        resource_kind: str = "",
        task_id: str = "",
        task_type: str = "",
        metadata: Optional[dict[str, Any]] = None,
        require_price_rule: bool = False,
        require_positive_cost: bool = False,
    ) -> dict[str, Any]:
        return {
            "id": "",
            "user_id": user_id,
            "feature_key": feature_key,
            "cost": 0,
            "reserved": False,
            "balance_after": None,
            "reason": "feature_reserved",
        }

    async def require_feature_credit_balance(
        self,
        *,
        user_id: str,
        feature_key: str,
        project_id: str = "",
        resource_kind: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        return {
            "user_id": user_id,
            "feature_key": feature_key,
            "required_balance": 0,
            "balance": None,
            "allowed": True,
        }

    async def confirm_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        return None

    async def refund_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        return None

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
        return None

    def set_llm_usage_context(
        self,
        user_id: Optional[str],
        project_id: Optional[str] = None,
        resource_kind: str = "",
        billing_metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        set_llm_usage_context(
            user_id,
            project_id=project_id,
            resource_kind=resource_kind,
            billing_metadata=billing_metadata,
        )

    def clear_llm_usage_context(self) -> None:
        clear_llm_usage_context()

    async def set_project_llm_usage_context(
        self,
        *,
        username: Optional[str],
        project_name: Optional[str],
        resource_kind: str = "",
    ) -> None:
        return None

    async def get_user_credit_balance(self, user_id: str) -> int | None:
        return 0

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
        return None

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
        return None

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
        return None


class NoOpProviderInstrumentation:
    def install(self) -> None:
        return None

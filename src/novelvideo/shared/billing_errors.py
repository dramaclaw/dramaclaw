"""Billing error taxonomy shared by EE shims and data-plane code."""

from __future__ import annotations

from typing import Any

INSUFFICIENT_CREDITS_CODE = "INSUFFICIENT_CREDITS"
INSUFFICIENT_CREDITS_MESSAGE = "积分不足，请联系管理员充值"
BILLING_RULE_NOT_CONFIGURED_CODE = "BILLING_RULE_NOT_CONFIGURED"
BILLING_RULE_NOT_CONFIGURED_MESSAGE = "计费规则未配置，请联系管理员设置积分规则"
GENERATION_BILLING_UNITS = {"call", "item", "second", "token", "character"}


class InsufficientCreditsError(RuntimeError):
    """Raised when a credit reservation cannot be covered by current balance."""

    def __init__(self, *, user_id: str, cost: int, balance: int) -> None:
        self.user_id = user_id
        self.cost = int(cost)
        self.balance = int(balance)
        super().__init__(
            f"insufficient credits for user {user_id}: required {self.cost}, "
            f"available {self.balance}"
        )


class InsufficientCreditsStop(BaseException):
    """Business stop signal used to escape broad Exception handlers."""

    def __init__(self, *, user_id: str = "", cost: int = 0, balance: int = 0) -> None:
        self.user_id = user_id
        self.cost = int(cost or 0)
        self.balance = int(balance or 0)
        super().__init__(INSUFFICIENT_CREDITS_MESSAGE)


class BillingRuleNotConfiguredError(RuntimeError):
    """Raised when a billable action has no usable admin pricing rule."""

    def __init__(self, *, kind: str, key: str) -> None:
        self.kind = str(kind or "").strip()
        self.key = str(key or "").strip()
        super().__init__(
            f"billing rule is not configured for {self.kind or 'billing'}:{self.key}"
        )


def iter_exception_chain(exc: BaseException | None):
    """Yield an exception and its explicit/implicit causes once each."""
    seen: set[int] = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def find_insufficient_credits_error(
    exc: BaseException | None,
) -> InsufficientCreditsError | None:
    for item in iter_exception_chain(exc):
        if isinstance(item, InsufficientCreditsError):
            return item
    return None


def find_insufficient_credits_stop(
    exc: BaseException | None,
) -> InsufficientCreditsStop | None:
    for item in iter_exception_chain(exc):
        if isinstance(item, InsufficientCreditsStop):
            return item
    return None


def find_billing_rule_not_configured_error(
    exc: BaseException | None,
) -> BillingRuleNotConfiguredError | None:
    for item in iter_exception_chain(exc):
        if isinstance(item, BillingRuleNotConfiguredError):
            return item
    return None


def is_insufficient_credits_error(
    exc: BaseException | None = None, message: str = ""
) -> bool:
    if (
        find_insufficient_credits_error(exc) is not None
        or find_insufficient_credits_stop(exc) is not None
    ):
        return True
    combined = " ".join(str(item) for item in iter_exception_chain(exc))
    if message:
        combined = f"{combined} {message}"
    normalized = combined.lower()
    return (
        "insufficient credits" in normalized
        or INSUFFICIENT_CREDITS_CODE.lower() in normalized
    )


def insufficient_credits_payload(exc: BaseException | None = None) -> dict[str, Any]:
    err = find_insufficient_credits_error(exc)
    stop = find_insufficient_credits_stop(exc)
    payload: dict[str, Any] = {
        "error_code": INSUFFICIENT_CREDITS_CODE,
        "message": INSUFFICIENT_CREDITS_MESSAGE,
    }
    if err is not None or stop is not None:
        source = err or stop
        payload.update(
            {
                "user_id": source.user_id,
                "required": source.cost,
                "balance": source.balance,
            }
        )
    return payload


def billing_rule_not_configured_payload(
    exc: BaseException | None = None,
) -> dict[str, Any]:
    err = find_billing_rule_not_configured_error(exc)
    payload: dict[str, Any] = {
        "error_code": BILLING_RULE_NOT_CONFIGURED_CODE,
        "message": BILLING_RULE_NOT_CONFIGURED_MESSAGE,
    }
    if err is not None:
        payload.update({"billing_kind": err.kind, "billing_key": err.key})
    return payload


__all__ = [
    "BILLING_RULE_NOT_CONFIGURED_CODE",
    "BILLING_RULE_NOT_CONFIGURED_MESSAGE",
    "BillingRuleNotConfiguredError",
    "GENERATION_BILLING_UNITS",
    "INSUFFICIENT_CREDITS_CODE",
    "INSUFFICIENT_CREDITS_MESSAGE",
    "InsufficientCreditsError",
    "InsufficientCreditsStop",
    "billing_rule_not_configured_payload",
    "find_billing_rule_not_configured_error",
    "find_insufficient_credits_error",
    "find_insufficient_credits_stop",
    "insufficient_credits_payload",
    "is_insufficient_credits_error",
    "iter_exception_chain",
]

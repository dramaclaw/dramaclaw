"""Generation credit quote port."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CreditQuote:
    total_cost: int
    display: str
    original_total_cost: int | None = None
    discount_amount: int = 0
    promotion: dict | None = None
    unit: str = "call"
    unit_cost: int = 0
    quantity: int = 1
    params: dict | None = None


class CreditQuotePort(Protocol):
    async def generation_credit_quote(
        self,
        *,
        kind: str,
        model: str,
        params: dict,
        quantity: int,
        user_id: str = "",
    ) -> CreditQuote: ...

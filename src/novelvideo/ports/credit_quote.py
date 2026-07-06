"""Generation credit quote port."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CreditQuote:
    total_cost: int
    display: str
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
    ) -> CreditQuote: ...

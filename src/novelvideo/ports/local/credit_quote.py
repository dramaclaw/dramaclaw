"""Local CE generation credit quote implementation."""

from __future__ import annotations

from novelvideo.ports.credit_quote import CreditQuote


class LocalCreditQuote:
    async def generation_credit_quote(
        self,
        *,
        kind: str,
        model: str,
        params: dict,
        quantity: int,
    ) -> CreditQuote:
        return CreditQuote(total_cost=0, display="0", unit="call", unit_cost=0, quantity=1, params={})

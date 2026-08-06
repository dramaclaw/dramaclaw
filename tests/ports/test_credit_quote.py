import pytest


@pytest.mark.asyncio
async def test_local_credit_quote_returns_zero_display() -> None:
    from novelvideo.ports.credit_quote import CreditQuote
    from novelvideo.ports.local.credit_quote import LocalCreditQuote

    quote = await LocalCreditQuote().generation_credit_quote(
        kind="image",
        model="gpt-image-2",
        params={"size": "2K"},
        quantity=3,
        product_surface="mainline",
    )

    assert quote == CreditQuote(
        total_cost=0,
        display="0",
        unit="call",
        unit_cost=0,
        quantity=1,
        params={},
    )

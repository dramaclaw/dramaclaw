from __future__ import annotations

import logging

import pytest

from novelvideo.task_backend import run_core


@pytest.mark.asyncio
async def test_undelivered_refund_without_reservation_is_accepted(monkeypatch) -> None:
    monkeypatch.setattr(
        run_core,
        "get_usage_meter",
        lambda: (_ for _ in ()).throw(AssertionError("usage meter must not be read")),
    )

    result = await run_core.refund_undelivered_feature_credit_reservation("")

    assert result.accepted is True
    assert result.retryable is False


@pytest.mark.asyncio
async def test_undelivered_refund_reports_adapter_acceptance(monkeypatch) -> None:
    calls: list[tuple[str, dict | None]] = []

    class Meter:
        async def settle_cancelled_feature_credit_reservation(
            self, reservation_id, *, metadata=None
        ):
            calls.append((reservation_id, metadata))

    monkeypatch.setattr(run_core, "get_usage_meter", lambda: Meter())

    result = await run_core.refund_undelivered_feature_credit_reservation(
        "reservation-1", metadata={"source": "task_delivery_terminalizer"}
    )

    assert result.accepted is True
    assert result.retryable is False
    assert calls == [("reservation-1", {"source": "task_delivery_terminalizer"})]


@pytest.mark.asyncio
async def test_undelivered_refund_reports_adapter_failure_without_leaking_details(
    monkeypatch, caplog
) -> None:
    class Meter:
        async def settle_cancelled_feature_credit_reservation(self, *_args, **_kwargs):
            raise RuntimeError("postgres://secret@internal")

    monkeypatch.setattr(run_core, "get_usage_meter", lambda: Meter())

    with caplog.at_level(logging.ERROR, logger=run_core.__name__):
        result = await run_core.refund_undelivered_feature_credit_reservation(
            "reservation-1"
        )

    assert result.accepted is False
    assert result.retryable is True
    assert "secret" not in caplog.text
    record = next(
        item
        for item in caplog.records
        if item.message == "undelivered feature credit refund remains awaiting retry"
    )
    assert record.failure_kind == "settlement_adapter_failure"
    assert record.safe_error_type == "RuntimeError"
    assert len(record.error_id) == 32


@pytest.mark.asyncio
async def test_undelivered_refund_reports_permanent_settlement_conflict(
    monkeypatch, caplog
) -> None:
    from novelvideo.ports import usage

    class Meter:
        async def settle_cancelled_feature_credit_reservation(self, *_args, **_kwargs):
            raise usage.FeatureCreditSettlementConflict()

    monkeypatch.setattr(run_core, "get_usage_meter", lambda: Meter())

    result = await run_core.refund_undelivered_feature_credit_reservation(
        "reservation-1"
    )

    assert result.accepted is False
    assert result.retryable is False
    assert "reservation-1" not in caplog.text

from __future__ import annotations

import logging

import pytest


class _ConflictingUsageMeter:
    async def settle_feature_credit_reservation(self, *_args, **_kwargs):
        from novelvideo.task_backend.run_core import FeatureCreditSettlementConflict

        try:
            raise RuntimeError("postgres://user:secret-canary@internal")
        except RuntimeError:
            raise FeatureCreditSettlementConflict from None

    async def settle_cancelled_feature_credit_reservation(self, *_args, **_kwargs):
        from novelvideo.task_backend.run_core import FeatureCreditSettlementConflict

        try:
            raise RuntimeError("postgres://user:secret-canary@internal")
        except RuntimeError:
            raise FeatureCreditSettlementConflict from None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "helper_name",
    ["_confirm_feature_credit_reservation", "_refund_feature_credit_reservation"],
)
async def test_feature_settlement_conflict_logs_only_safe_fields(
    monkeypatch, caplog, helper_name
) -> None:
    from novelvideo.task_backend import run_core

    monkeypatch.setattr(run_core, "get_usage_meter", lambda: _ConflictingUsageMeter())

    with caplog.at_level(logging.WARNING, logger=run_core.logger.name):
        await getattr(run_core, helper_name)("reservation-secret")

    assert "secret-canary" not in caplog.text
    assert "reservation-secret" not in caplog.text
    record = caplog.records[-1]
    assert record.message == "feature_credit_settlement_conflict"
    assert record.safe_error_type == "FeatureCreditSettlementConflict"
    assert record.error_id


@pytest.mark.asyncio
async def test_cancelled_feature_settlement_conflict_logs_only_safe_fields(
    monkeypatch, caplog
) -> None:
    from novelvideo.task_backend import run_core

    monkeypatch.setattr(run_core, "get_usage_meter", lambda: _ConflictingUsageMeter())

    with caplog.at_level(logging.WARNING, logger=run_core.logger.name):
        result = await run_core.refund_undelivered_feature_credit_reservation(
            "reservation-secret"
        )

    assert result.accepted is False
    assert result.retryable is False
    assert "secret-canary" not in caplog.text
    assert "reservation-secret" not in caplog.text
    assert caplog.records[-1].message == "feature_credit_settlement_conflict"

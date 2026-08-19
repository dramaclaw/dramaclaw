from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_local_usage_meter_has_no_feature_settlement() -> None:
    from novelvideo.ports.local.usage import NoOpUsageMeter
    from novelvideo.ports.usage import VerifiedTaskSettlementIdentity

    identity = VerifiedTaskSettlementIdentity(
        root_task_id="task-1",
        project_id="project-1",
        requester_user_id="user-1",
        task_type="generate_video",
        episode=1,
        beat_num=2,
        scope="episode",
    )

    result = await NoOpUsageMeter().resolve_feature_credit_reservation(identity)

    assert result.outcome == "not_applicable"
    assert result.reservation_id == ""


def test_resolved_feature_settlement_requires_reservation_id() -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="reservation_id"):
        FeatureSettlementResolution(outcome="resolved")


def test_resolved_feature_settlement_builds_authoritative_billing_snapshot() -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    resolved = FeatureSettlementResolution(
        outcome="resolved",
        reservation_id="feature-res-1",
        feature_key="mainline.single_video",
        model_call_credit_policy="feature_included",
    )

    assert resolved.trusted_billing_metadata() == {
        "feature_credit_reservation_id": "feature-res-1",
        "feature_key": "mainline.single_video",
        "model_call_credit_policy": "feature_included",
    }


@pytest.mark.parametrize("field", ["feature_key", "model_call_credit_policy"])
def test_non_resolved_feature_settlement_rejects_authoritative_fields(field: str) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="non-resolved"):
        FeatureSettlementResolution(outcome="not_applicable", **{field: "forged"})


@pytest.mark.parametrize("outcome", ["not_applicable", "ambiguous", "conflict"])
def test_non_resolved_feature_settlement_rejects_reservation_id(outcome: str) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="reservation_id"):
        FeatureSettlementResolution(outcome=outcome, reservation_id="reservation-1")


def test_feature_settlement_rejects_unknown_outcome() -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="outcome"):
        FeatureSettlementResolution(outcome="unknown")


def test_trusted_metrics_metadata_rehydrates_only_authoritative_reservation() -> None:
    from novelvideo.task_backend.run_core import _trusted_metrics_billing_metadata

    result = _trusted_metrics_billing_metadata(
        {
            "feature_credit_reservation_id": "forged-reservation",
            "feature_credit_charge_id": "forged-alias",
            "feature_key": "video.generate",
        },
        feature_reservation_id="trusted-reservation",
    )

    assert result == {
        "feature_key": "video.generate",
        "feature_credit_reservation_id": "trusted-reservation",
    }


def test_trusted_metrics_metadata_omits_handle_when_not_applicable() -> None:
    from novelvideo.task_backend.run_core import _trusted_metrics_billing_metadata

    result = _trusted_metrics_billing_metadata(
        {"feature_credit_reservation_id": "forged-reservation"},
        feature_reservation_id="",
    )

    assert result == {}

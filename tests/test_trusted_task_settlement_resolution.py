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


@pytest.mark.parametrize(
    ("feature_key", "model_call_credit_policy"),
    [
        ("", "feature_included"),
        ("mainline.single_video", ""),
    ],
)
def test_resolved_feature_settlement_requires_complete_billing_snapshot(
    feature_key: str,
    model_call_credit_policy: str,
) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="billing snapshot"):
        FeatureSettlementResolution(
            outcome="resolved",
            reservation_id="feature-res-1",
            feature_key=feature_key,
            model_call_credit_policy=model_call_credit_policy,
        )


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


@pytest.mark.parametrize(
    ("outcome", "message"),
    [
        ("ambiguous", "feature settlement resolution is ambiguous"),
        ("conflict", "feature settlement resolution conflicts with durable state"),
    ],
)
def test_rejected_resolution_error_matches_terminalization_marker(
    outcome: str,
    message: str,
) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolutionRejected

    assert str(FeatureSettlementResolutionRejected(outcome)) == message


def test_not_applicable_feature_settlement_keeps_authoritative_policy_without_reservation() -> (
    None
):
    from novelvideo.ports.usage import FeatureSettlementResolution

    resolution = FeatureSettlementResolution(
        outcome="not_applicable",
        feature_key="freezone.text_translate",
        model_call_credit_policy="feature_included",
    )

    assert resolution.trusted_billing_metadata() == {
        "feature_key": "freezone.text_translate",
        "model_call_credit_policy": "feature_included",
    }


@pytest.mark.parametrize("field", ["feature_key", "model_call_credit_policy"])
def test_not_applicable_feature_settlement_rejects_partial_policy_snapshot(
    field: str,
) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError):
        FeatureSettlementResolution(outcome="not_applicable", **{field: "forged"})


@pytest.mark.parametrize("outcome", ["ambiguous", "conflict"])
@pytest.mark.parametrize("field", ["feature_key", "model_call_credit_policy"])
def test_rejected_feature_settlement_rejects_authoritative_fields(
    outcome: str,
    field: str,
) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError):
        FeatureSettlementResolution(outcome=outcome, **{field: "forged"})


@pytest.mark.parametrize("outcome", ["not_applicable", "ambiguous", "conflict"])
def test_non_resolved_feature_settlement_rejects_reservation_id(outcome: str) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="reservation_id"):
        FeatureSettlementResolution(outcome=outcome, reservation_id="reservation-1")


def test_feature_settlement_rejects_unknown_outcome() -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="outcome"):
        FeatureSettlementResolution(outcome="unknown")

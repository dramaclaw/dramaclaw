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


@pytest.mark.parametrize("outcome", ["not_applicable", "ambiguous", "conflict"])
def test_non_resolved_feature_settlement_rejects_reservation_id(outcome: str) -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="reservation_id"):
        FeatureSettlementResolution(outcome=outcome, reservation_id="reservation-1")


def test_feature_settlement_rejects_unknown_outcome() -> None:
    from novelvideo.ports.usage import FeatureSettlementResolution

    with pytest.raises(ValueError, match="outcome"):
        FeatureSettlementResolution(outcome="unknown")

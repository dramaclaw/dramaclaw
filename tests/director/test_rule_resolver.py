"""Conditional rule decisions cannot smuggle long-series defaults into short work."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from novelvideo.director.documents import object_hash
from novelvideo.director.rules.resolver import (
    KnowledgeItem,
    KnowledgeSnapshot,
    RuleContext,
    resolve_rules,
)
from novelvideo.director.schemas.execution import ExecutionFault


def selected(context):
    return {item["id"] for item in resolve_rules(context)["selected"]}


@pytest.mark.parametrize(
    "rule,stage,fields",
    [
        ("G01", "M01", {}),
        ("G02", "M03", {}),
        ("G03", "M07", {}),
        ("G04", "M04", {"has_source": True}),
        ("G05", "M11", {"has_source": True}),
        ("G06", "M09", {}),
        ("G07", "M11", {}),
        ("G08", "M11", {"episode_ordinal": 1, "total_episodes": 2}),
        (
            "G09",
            "M08",
            {"antagonism_confirmed": True, "antagonism_capacity_confirmed": True},
        ),
        ("G10", "M07", {"monetization_confirmed": True}),
        ("G11", "M10", {}),
        ("G12", "M12", {}),
        ("G13", "M11", {"ai_production": True}),
        ("G14", "M12", {"historical": True}),
        ("G15", "M14", {}),
        ("G16", "M15", {"language_or_market_change": True}),
        ("G17", "M17", {}),
        ("G18", "M22", {}),
    ],
)
def test_each_rule_has_a_positive_condition_and_receipt(rule, stage, fields):
    context = RuleContext(
        **{"stage": stage, "mode": "original", "total_episodes": 1, **fields}
    )
    resolution = resolve_rules(context)
    assert rule in selected(context)
    assert len(resolution["selected"]) + len(resolution["disabled"]) == 18
    assert resolution["knowledgeStatus"] == "empty_static_fallback"
    assert all(
        item["conditionResult"]
        for item in resolution["selected"] + resolution["disabled"]
    )


@pytest.mark.parametrize(
    "rule,stage,fields",
    [
        ("G02", "M11", {}),
        ("G03", "M21", {}),
        ("G04", "M04", {}),
        ("G05", "M11", {}),
        ("G06", "M21", {}),
        ("G07", "M21", {}),
        ("G08", "M11", {"episode_ordinal": 1, "ending_type": "closed"}),
        ("G09", "M08", {"antagonism_confirmed": True}),
        ("G10", "M07", {}),
        ("G11", "M21", {}),
        ("G12", "M11", {}),
        ("G13", "M11", {}),
        ("G14", "M12", {}),
        ("G15", "M11", {}),
        ("G16", "M15", {}),
    ],
)
def test_rules_are_disabled_outside_confirmed_conditions(rule, stage, fields):
    context = RuleContext(
        **{"stage": stage, "mode": "original", "total_episodes": 1, **fields}
    )
    resolution = resolve_rules(context)
    assert rule not in selected(context)
    assert next(item for item in resolution["disabled"] if item["id"] == rule)["reason"]


def test_no_closed_final_hook_and_open_ending_is_explicit():
    context = RuleContext(
        stage="M11", mode="original", total_episodes=1, episode_ordinal=1
    )
    assert "G08" not in selected(context)
    assert "G08" in selected(context.model_copy(update={"ending_type": "open"}))
    assert {"G01", "G17", "G18"}.issubset(selected(context))
    with pytest.raises(ValidationError):
        RuleContext(stage="M99", mode="original", total_episodes=1)


def test_locked_fact_conflict_is_reported_not_silently_overridden():
    context = RuleContext(
        stage="M15",
        mode="adaptation",
        total_episodes=1,
        locked_values={"motherStatus": "unknown"},
        requested_values={"motherStatus": "dead"},
    )
    result = resolve_rules(context)
    assert result["conflicts"] == [
        {
            "field": "motherStatus",
            "locked": "unknown",
            "requested": "dead",
            "resolution": "explicit_spec_changeset_required",
        }
    ]


def test_verified_knowledge_is_hash_checked_relevant_and_limited_to_three():
    items = [
        KnowledgeItem(
            id=f"k{i}",
            version=1,
            stages=["M12"],
            genres=["mystery"],
            query_terms=["key"],
            text=f"Advice {i}",
            content_hash=object_hash({"text": f"Advice {i}"}),
            status="verified",
        )
        for i in range(5)
    ]
    snapshot = KnowledgeSnapshot(
        schema_version=2,
        version="2026.09",
        items_hash=object_hash([item.model_dump(by_alias=True) for item in items]),
        items=items,
    )
    context = RuleContext(stage="M12", mode="original", total_episodes=1)
    snapshot_hash = object_hash(snapshot.model_dump(by_alias=True))
    result = resolve_rules(
        context,
        snapshot=snapshot,
        expected_snapshot_hash=snapshot_hash,
        genres=("mystery",),
        query="key ownership",
    )
    assert [item["id"] for item in result["knowledge"]] == ["k0", "k1", "k2"]
    assert not resolve_rules(
        context,
        snapshot=snapshot,
        expected_snapshot_hash=snapshot_hash,
        genres=("romance",),
        query="key",
    )["knowledge"]
    with pytest.raises(ExecutionFault, match="KNOWLEDGE_HASH_MISMATCH"):
        resolve_rules(context, snapshot=snapshot, expected_snapshot_hash="f" * 64)

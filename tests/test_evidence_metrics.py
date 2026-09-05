"""The three ways this side can quietly stop working must be distinguishable.

Without counters, an issuer that stopped minting, a turn refused for want of a
credential, and a worker rotating on every turn all present in production as
the same thing: fewer attested captures than expected, with nothing to say why.
"""
from __future__ import annotations

import json

import pytest

from novelvideo.chat import evidence_metrics


@pytest.fixture(autouse=True)
def clean_counters():
    evidence_metrics.reset_for_test()
    yield
    evidence_metrics.reset_for_test()


def test_outcomes_are_counted_by_name():
    evidence_metrics.observe("capability_issued")
    evidence_metrics.observe("capability_issued")
    evidence_metrics.observe("worker_spawned")
    assert evidence_metrics.counters() == {
        "capability_issued": 2, "worker_spawned": 1}


def test_an_unnamed_outcome_is_named_rather_than_dropped():
    evidence_metrics.observe("")
    assert evidence_metrics.counters()["unspecified"] == 1


def test_an_absent_issuer_is_not_a_failure():
    """Before the keys are rolled out this is the normal state.

    Counting it as a failure would make every pre-Stage-4 deployment look
    broken, and the operator would learn to ignore the signal that matters.
    """
    evidence_metrics.observe("capability_issuer_absent")
    evidence_metrics.observe("capability_no_identity")
    assert evidence_metrics.halting_counts() == {}


@pytest.mark.parametrize("outcome", [
    "capability_issue_failure",
    "foreign_endpoint_refused",
    "credential_refused",
])
def test_a_real_failure_halts_a_rollout(outcome):
    evidence_metrics.observe(outcome)
    assert evidence_metrics.halting_counts() == {outcome: 1}


def test_a_rotation_carries_its_reason():
    """The per-turn credential exists to make credential-driven rotation
    impossible, so a rotation count without its reason cannot show whether the
    thing it removed has come back."""
    evidence_metrics.observe("worker_rotated:scope-env-change")
    assert "worker_rotated:scope-env-change" in evidence_metrics.counters()


def test_the_report_names_no_secret():
    for outcome in ("capability_issued", "credential_refused",
                    "worker_rotated:authz-generation"):
        evidence_metrics.observe(outcome)
    report = evidence_metrics.format_report()
    assert "sk-" not in report and "Bearer" not in report
    assert "HALT" in report, "a halting outcome must be called out, not merely listed"


def test_agent_product_rollout_counters_include_zero_defaults():
    assert evidence_metrics.agent_product_counts() == {
        "agent_product_awaiting_reconciliation": 0,
        "agent_product_binding_failed": 0,
        "agent_product_evidence_rejected": 0,
        "agent_product_reconciled": 0,
    }

    evidence_metrics.observe("agent_product_evidence_rejected")
    evidence_metrics.observe("agent_product_awaiting_reconciliation")

    assert evidence_metrics.agent_product_counts() == {
        "agent_product_awaiting_reconciliation": 1,
        "agent_product_binding_failed": 0,
        "agent_product_evidence_rejected": 1,
        "agent_product_reconciled": 0,
    }


@pytest.mark.asyncio
async def test_diagnostics_exposes_agent_product_counters():
    from novelvideo.api.routes.diagnostics import get_evidence_counters

    evidence_metrics.observe("agent_product_binding_failed")
    response = await get_evidence_counters()
    payload = json.loads(response.body)

    assert payload["data"]["agent_products"]["agent_product_binding_failed"] == 1

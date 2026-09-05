"""Counters for the DramaClaw end of the evidence plane.

Every outcome here was already decided on each turn and then kept nowhere. That
is tolerable while a canary is watching; in production it means the three ways
this side can quietly stop working are indistinguishable from low traffic:

- the issuer stops minting capabilities, so nothing is ever attested;
- a turn is refused for want of a credential, so it never egresses at all;
- a worker rotates on every turn, so the per-turn credential bought nothing.

Names and counts only. No key, capability, project, trajectory or prompt — the
whole point is that these are safe to log wherever the process already logs, so
nothing here may carry anything the telemetry allowlist would have to govern.
"""
from __future__ import annotations

import threading
from collections import Counter

_lock = threading.Lock()
_counts: Counter[str] = Counter()

#: Outcomes that must stay at zero. Each means a turn either produced evidence
#: that cannot be trusted, or tried to leave for somewhere it had no business
#: going. Neither is a degraded service to be watched — rollout stops.
HALTING = frozenset({
    "capability_issue_failure",
    "foreign_endpoint_refused",
    "credential_refused",
})

AGENT_PRODUCT_OUTCOMES = frozenset(
    {
        "agent_product_binding_failed",
        "agent_product_evidence_rejected",
        "agent_product_awaiting_reconciliation",
        "agent_product_reconciled",
    }
)


def observe(outcome: str) -> None:
    """Record one outcome. Unnamed outcomes are named rather than dropped."""
    with _lock:
        _counts[outcome or "unspecified"] += 1


def counters() -> dict[str, int]:
    with _lock:
        return dict(_counts)


def halting_counts() -> dict[str, int]:
    return {name: count for name, count in counters().items()
            if name in HALTING and count > 0}


def agent_product_counts() -> dict[str, int]:
    """Return counters used to monitor Agent product settlement rollout."""
    current = counters()
    return {name: current.get(name, 0) for name in sorted(AGENT_PRODUCT_OUTCOMES)}


def format_report() -> str:
    """One line per outcome, ordered, for a periodic log."""
    lines = [f"dramaclaw evidence {name}={count}"
             for name, count in sorted(counters().items())]
    lines += [f"dramaclaw evidence HALT {name}={count} — stop increasing traffic"
              for name, count in sorted(halting_counts().items())]
    return "\n".join(lines)


def reset_for_test() -> None:
    with _lock:
        _counts.clear()

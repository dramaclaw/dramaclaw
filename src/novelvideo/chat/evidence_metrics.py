"""Shared counters for the DramaClaw end of the evidence plane.

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

import os
import sqlite3
import threading
from collections import Counter
from pathlib import Path

_lock = threading.Lock()
_counts: Counter[str] = Counter()


def _persistent_db_path() -> Path | None:
    explicit = os.environ.get("DRAMACLAW_EVIDENCE_METRICS_DB", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    state_dir = os.environ.get("NOVELVIDEO_STATE_DIR", "").strip()
    if not state_dir:
        return None
    return Path(state_dir).expanduser() / "_shared" / "diagnostics" / "evidence_metrics.sqlite3"


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS evidence_counters (
            outcome TEXT PRIMARY KEY,
            count INTEGER NOT NULL CHECK (count >= 0),
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    return conn

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
    name = outcome or "unspecified"
    with _lock:
        path = _persistent_db_path()
        if path is None:
            _counts[name] += 1
            return
        with _connect(path) as conn:
            conn.execute(
                """
                INSERT INTO evidence_counters(outcome, count)
                VALUES (?, 1)
                ON CONFLICT(outcome) DO UPDATE SET
                    count = evidence_counters.count + 1,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (name,),
            )


def counters() -> dict[str, int]:
    with _lock:
        path = _persistent_db_path()
        if path is None:
            return dict(_counts)
        with _connect(path) as conn:
            rows = conn.execute(
                "SELECT outcome, count FROM evidence_counters ORDER BY outcome"
            ).fetchall()
        return {str(name): int(count) for name, count in rows}


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
        path = _persistent_db_path()
        if path is not None and path.exists():
            with _connect(path) as conn:
                conn.execute("DELETE FROM evidence_counters")

"""Read-only diagnostics for the evidence plane.

``evidence_metrics`` persists each per-turn capability outcome in a shared
SQLite store under ``NOVELVIDEO_STATE_DIR``. API and task worker processes read
the same authoritative counters, including across worker restarts.

Only names and counts are returned. The ``evidence_metrics`` module is designed
so these carry no key, capability, project, trajectory or prompt — safe to
expose wherever the process already logs, so no auth gate is needed (mirrors the
public ``/config`` route).
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from novelvideo.chat import evidence_metrics

router = APIRouter()


@router.get("/diagnostics/evidence")
async def get_evidence_counters():
    """Return shared evidence-plane counters and any halting outcomes."""
    counters = evidence_metrics.counters()
    halting = evidence_metrics.halting_counts()
    agent_products = evidence_metrics.agent_product_counts()
    return JSONResponse(
        {
            "ok": True,
            "data": {
                # capability_issued > 0 proves a project-scoped turn minted a
                # capability with the configured K1/K3 keys since process start.
                "counters": counters,
                # Any non-empty halting map means rollout must stop — a turn
                # produced untrustworthy evidence or tried to leave for a host it
                # had no business reaching.
                "halting": halting,
                "capability_issued": counters.get("capability_issued", 0),
                "agent_products": agent_products,
            },
        }
    )

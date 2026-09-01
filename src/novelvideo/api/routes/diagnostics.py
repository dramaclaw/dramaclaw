"""Read-only diagnostics for the evidence plane.

``evidence_metrics`` counts each per-turn capability outcome in process memory
only — nothing persists it and nothing emits it, so a running backend cannot be
asked "did this turn mint a capability?". This endpoint exposes those counters
so the answer is observable with a single ``curl`` after a message is sent.

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
    """Return the in-process evidence-plane counters and any halting outcomes."""
    counters = evidence_metrics.counters()
    halting = evidence_metrics.halting_counts()
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
            },
        }
    )

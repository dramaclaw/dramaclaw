"""Use evidence-backed precedence, not word count or a model's declared duration.

Unordered shared resources are rejected rather than guessed parallel. A missing
estimate remains UNKNOWN and cannot become a zero-duration successful beat.
"""

from __future__ import annotations

from typing import Literal

from .schemas.common import ContractModel, DirectorContractError
from .schemas.foundation import DurationInput
from .semantic_validator import topological_order


class DurationResult(ContractModel):
    document_version: int
    semantic_hash: str
    minimum: float | None
    maximum: float | None
    status: Literal["UNKNOWN", "FAIL", "CAPACITY_RISK", "ESTIMATED", "MEASURED"]
    unknown_ids: list[str]
    production_ready: bool


def evaluate_duration(plan: DurationInput) -> DurationResult:
    # The repository resolves artifact ownership/content before constructing
    # evidence; this pure gate additionally binds it to the exact current draft.
    for beat in plan.beats:
        if beat.measurement is not None and (
            beat.measurement.document_version != plan.document_version
            or beat.measurement.semantic_hash != plan.semantic_hash
        ):
            raise DirectorContractError("STALE_TIMING_EVIDENCE", affected_ids=[beat.id])
    beats = {beat.id: beat for beat in plan.beats}
    order = topological_order({key: beat.depends_on for key, beat in beats.items()})
    ancestors: dict[str, set[str]] = {}
    for key in order:
        parents = beats[key].depends_on
        ancestors[key] = set(parents)
        for parent in parents:
            ancestors[key].update(ancestors[parent])
    for index, left in enumerate(order):
        for right in order[index + 1 :]:
            if set(beats[left].resources) & set(beats[right].resources):
                if left not in ancestors[right] and right not in ancestors[left]:
                    raise DirectorContractError(
                        "BLOCKING_RESOURCE_CONFLICT",
                        affected_ids=[left, right],
                    )
    unknown = [key for key in order if beats[key].estimate is None]
    ends: dict[str, tuple[float, float | None]] = {}
    for key in order:
        beat = beats[key]
        # A known chain can already exceed capacity even if an independent beat
        # is unknown. Keep that proof of FAIL; do not let UNKNOWN hide it.
        low_start = max((ends[parent][0] for parent in beat.depends_on), default=0.0)
        upper_parents = [ends[parent][1] for parent in beat.depends_on]
        high_start = None if None in upper_parents else max(upper_parents, default=0.0)
        ends[key] = (
            low_start + (beat.estimate.minimum if beat.estimate else 0.0),
            high_start + beat.estimate.maximum
            if high_start is not None and beat.estimate is not None
            else None,
        )
    minimum = max(value[0] for value in ends.values())
    maximum = None if unknown else max(value[1] for value in ends.values())
    if minimum > plan.target_seconds:
        status = "FAIL"
    elif unknown:
        status = "UNKNOWN"
    elif maximum is not None and maximum > plan.target_seconds:
        status = "CAPACITY_RISK"
    elif all(beat.timing_status == "measured" for beat in plan.beats):
        status = "MEASURED"
    else:
        status = "ESTIMATED"
    return DurationResult(
        document_version=plan.document_version,
        semantic_hash=plan.semantic_hash,
        minimum=minimum if not unknown or status == "FAIL" else None,
        maximum=maximum,
        status=status,
        unknown_ids=unknown,
        # This report measures timing only, not source truth or finalization.
        production_ready=False,
    )

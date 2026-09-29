"""Keep transport budgets out of creative settings and freeze them before consent.

These are conservative runtime tiers, not advertised provider capacity. The local
catalog does not currently supply verified output/context limits. A tier must
never shorten the source, change episode duration, or approve an unbounded retry.
"""

from __future__ import annotations

import math

OUTPUT_BUDGET_VERSION = "director-output-budget/1.0.2"
RUNTIME_OUTPUT_CEILING = 32768


def output_budget(
    stage: str,
    preset: dict,
    *,
    source_chars: int = 0,
    document_chars: int = 0,
    explicit: int | None = None,
) -> dict:
    """An estimate reserves capacity, never asserts measured literary duration."""
    count = int(preset["episode_count"])
    seconds = int(preset["duration_seconds"])
    if explicit is not None:
        if isinstance(explicit, bool) or not isinstance(explicit, int) or not 256 <= explicit <= RUNTIME_OUTPUT_CEILING:
            raise ValueError("INVALID_OUTPUT_BUDGET")
        return {"mode": "explicit", "policyVersion": OUTPUT_BUDGET_VERSION, "maxOutputTokens": explicit}
    base = 32768 if stage == "M12" else 12288 if stage in {"outline", "M07", "review"} else 8192
    # An episode request covers only that episode; project count must not inflate
    # it into permission to generate the rest of the series.
    estimate = base
    if stage in {"outline", "M07", "M09"}:
        estimate += max(0, count - 1) * 512
    elif stage == "episode":
        estimate = max(base, seconds * 12)
    estimate = max(estimate, math.ceil(document_chars * 1.5))
    if source_chars > 16000 and stage in {"outline", "M07", "M08", "characters", "scenes", "props"}:
        estimate = max(estimate, RUNTIME_OUTPUT_CEILING)
    tier = next((value for value in (8192, 12288, 16384, RUNTIME_OUTPUT_CEILING) if value >= estimate), RUNTIME_OUTPUT_CEILING)
    return {
        "mode": "automatic", "policyVersion": OUTPUT_BUDGET_VERSION,
        "maxOutputTokens": tier, "capacitySource": "conservative_runtime_policy",
        "estimatedOutputTokens": estimate,
        "requiresSectionPlan": estimate > RUNTIME_OUTPUT_CEILING,
        "basis": {"stage": stage, "episodeCount": count, "durationSeconds": seconds,
                  "sourceChars": source_chars, "documentChars": document_chars},
    }

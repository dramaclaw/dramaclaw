"""Require a traceable inspection of every paragraph, not six reassuring summaries.

Coverage proves what was inspected, not the truth of an LLM inference. The host
checks anchors and completeness; a person confirms the atomic fact table before
finalization. Unknowns and contradictions are never silently promoted to facts.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Literal

from pydantic import Field, ValidationError

from .documents import content_hash
from .schemas.common import ContractModel
from .schemas.quality import ReviewEvidence

FACT_VERSION = "episode-full-evidence/1.1.1"


class AtomicFact(ContractModel):
    subject: str = Field(min_length=1, max_length=300)
    relation: str = Field(min_length=1, max_length=300)
    value: str = Field(min_length=1, max_length=1000)
    before: str = Field(max_length=1000)
    after: str = Field(max_length=1000)
    layer: Literal["real", "depicted", "dialogue", "unknown"]
    status: Literal["SUPPORTED", "CONTRADICTED", "UNKNOWN", "CREATIVE"]
    evidence: list[ReviewEvidence] = Field(max_length=12)
    explanation: str = Field(min_length=1, max_length=2000)


class ParagraphFacts(ContractModel):
    unit_id: str = Field(min_length=1, max_length=100)
    disposition: Literal["FACTS", "METADATA", "OTHER_EPISODE", "NO_FACT"]
    explanation: str = Field(min_length=1, max_length=2000)
    facts: list[AtomicFact] = Field(max_length=100)


class EpisodeFacts(ContractModel):
    units: list[ParagraphFacts] = Field(min_length=1, max_length=10000)


def fact_units(inputs: dict[str, str]) -> list[dict]:
    units = []
    for input_id, text in inputs.items():
        # All non-whitespace text, including the last paragraph, is represented.
        # Reading full earlier episodes prevents last-episode-only amnesia.
        for match in re.finditer(r"\S[\s\S]*?(?=\n\s*\n|\Z)", text):
            part = match.group().rstrip()
            if not part:
                continue
            # Only section labels/episode titles are non-semantic metadata.
            # A heading containing a location, time or action still needs review.
            structural = all(re.fullmatch(r"(?:[-*_]{3,}|#{1,6}\s+(?:第\s*\d+\s*集|Episode\s+\d+|正文|剧情梗概|故事大纲|人物小传|场景设计|道具设计))", line.strip(), re.I)
                             for line in part.splitlines() if line.strip())
            units.append({"id": f"fact-{len(units) + 1:04d}", "inputId": input_id,
                          "start": match.start(), "end": match.start() + len(part),
                          "text": part, "hash": content_hash(part),
                          "structural": structural})
    return units


FACT_INSTRUCTION = """In addition to the six checks, return episodeFacts.units covering
EVERY supplied factUnit exactly once. Read all clauses within each paragraph;
extract each atomic assertion, not only the easiest one. Subject/relation/value
separate identity/age/address, knowledge, owner versus holder, physical position,
action completion, causal order, place interior/exterior and event occurrence.
Track an object's before/after state across scenes and ALL earlier episodes.
Holding is not owning; placing on a desk is not returning to its owner; a plan,
conditional risk, screen image or dialogue claim is not a completed real action.
Do not infer interior from a room name or invent a missing transition.
For SUPPORTED or CONTRADICTED give exact quotes, one from this unit and an
independent comparison from source/brief/locked facts/confirmed design/prior
episode or another paragraph. A quote of the claim alone cannot corroborate it.
Source/brief/locked requirements for THIS episode must cite actual execution in
document; future events use OTHER_EPISODE and explain the specific episode.
Unknown age/address/location stays UNKNOWN. CREATIVE identifies a new detail,
not user approval; scope restrictions can make it CONTRADICTED.
METADATA is only for structural headings/separators identified by the host.
Scene headings carry factual time/place/interior labels and must be FACTS.
Use FACTS for relevant earlier-episode state evidence too. OTHER_EPISODE may
include atomic facts but must explain why their event is not required again now.
Necessary-looking new gestures are still CREATIVE, not source-supported facts.
Use layer real for current physical events, depicted only for an image/screen
within the story, dialogue only for a character's claim. Keep answers concise.
NO_FACT needs a specific explanation and is still human-reviewed. OTHER_EPISODE
is forbidden for the current document. before/after use empty strings when no
state transition is asserted; do not fill from imagination. Preserve real,
depicted and dialogue layers. No overall score or self-claim proves completeness.
Unknowns/creative additions require individual human confirmation; contradictions
require editing and a new review. Neither review nor confirmation rewrites text."""


def validate_episode_facts(raw: object, frozen: dict) -> dict:
    units = frozen.get("factUnits", [])
    base = {"version": FACT_VERSION, "coverage": {"expected": len(units), "valid": 0,
             "semanticCompletenessVerified": False}, "units": [], "issues": [], "status": "UNAVAILABLE"}
    try:
        parsed = EpisodeFacts.model_validate(raw)
    except (ValidationError, ValueError, TypeError):
        return {**base, "issues": [{"code": "FACT_OUTPUT_INVALID"}]}
    counts = Counter(row.unit_id for row in parsed.units)
    known = {u["id"]: u for u in units}
    issues = [{"code": "FACT_COVERAGE_INVALID", "unitId": key} for key in set(counts) | set(known) if counts[key] != 1 or key not in known]
    rows, valid, contradiction = [], 0, False
    for row in parsed.units:
        unit = known.get(row.unit_id)
        if not unit or counts[row.unit_id] != 1:
            continue
        problems = []
        if row.disposition == "METADATA" and not unit["structural"]:
            problems.append("FACT_METADATA_BYPASS")
        if row.disposition == "OTHER_EPISODE" and unit["inputId"] == "document":
            problems.append("FACT_CURRENT_EPISODE_SKIPPED")
        if (row.disposition == "FACTS" and not row.facts) or (row.disposition in {"METADATA", "NO_FACT"} and row.facts):
            problems.append("FACT_ASSERTIONS_MISSING")
        grounded_facts = []
        for fact in row.facts:
            evidence, local, comparison, target = [], False, False, False
            fact_valid = True
            for ref in fact.evidence:
                text = frozen["inputs"].get(ref.input_id)
                start = -1
                for _ in range(ref.occurrence):
                    start = text.find(ref.quote, start + 1) if text is not None else -1
                    if start < 0:
                        fact_valid = False
                        break
                if start < 0:
                    continue
                end = start + len(ref.quote)
                in_unit = ref.input_id == unit["inputId"] and start >= unit["start"] and end <= unit["end"]
                local |= in_unit
                comparison |= not in_unit
                target |= ref.input_id == "document"
                evidence.append({**ref.model_dump(by_alias=True), "start": start, "end": end, "inputHash": content_hash(text)})
            conclusive = fact.status in {"SUPPORTED", "CONTRADICTED"}
            # Two disjoint clauses can contradict inside one paragraph. Repeating
            # or overlapping the same quote is not independent support.
            intra_conflict = fact.status == "CONTRADICTED" and any(
                a["inputId"] == b["inputId"] == unit["inputId"] and a["end"] <= b["start"]
                for a in evidence for b in evidence
            )
            if not fact_valid or (conclusive and (not local or not (comparison or intra_conflict))):
                problems.append("FACT_EVIDENCE_INVALID")
                fact_valid = False
            if conclusive and unit["inputId"] in {"source", "brief", "locked"} and not target:
                problems.append("FACT_REQUIREMENT_NOT_COMPARED_TO_DRAFT")
                fact_valid = False
            if fact.status == "CONTRADICTED" and fact_valid:
                contradiction = True
            grounded_facts.append({**fact.model_dump(by_alias=True), "status": fact.status if fact_valid else "UNKNOWN", "evidence": evidence})
        issues.extend({"code": code, "unitId": row.unit_id} for code in set(problems))
        valid += not problems
        rows.append({**unit, "disposition": row.disposition, "explanation": row.explanation, "facts": grounded_facts,
                     "requiresHumanCheck": not unit["structural"], "valid": not problems})
    return {**base, "coverage": {**base["coverage"], "valid": valid}, "units": rows, "issues": issues,
            "status": "FAIL" if contradiction else "UNAVAILABLE" if issues else "REVIEWED"}

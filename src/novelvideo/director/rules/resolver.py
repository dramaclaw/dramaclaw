"""Conditional method advice cannot override a user's production contract.

These are independently implemented host rules derived from the audited
short-drama references and workflow contract, not LibTV's private prompts.
Every exclusion is recorded, including an empty verified knowledge snapshot.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

from pydantic import Field, model_validator

from ..documents import object_hash
from ..schemas.common import ContractModel, Identifier, PositiveInt, Sha256
from ..schemas.execution import ExecutionFault

RULE_VERSION = "short-drama-fusion-rules/2.0.0"

# Frozen provenance, not reads from a developer's home directory at runtime.
# Host-derived rules reference our contracts; method references identify the
# user-supplied MIT short-drama snapshot captured by source-inventory.json.
SOURCE_HASHES = {
    "SKILL.md": "44c9f3d54ccd5d9ecd78c2ae041cdb1cb809b0a67fce9bea1eb0eee966d02235",
    "references/adaptation-core.md": "1e517e696c0ed19354683dcb37824f61059a06544f34aa0359ef60f7f59e0761",
    "references/ai-producibility.md": "9c16eef426382dc375bde8c76a0db2a9ed8f8b6da3c5d16c42cd79c33a0f2e84",
    "references/compliance-checklist.md": "9cdec4081cffa0b645b41ad9e54c3e2018875c1b5675650ec8c4a6fdfb207d2f",
    "references/episode-writing.md": "524b3fd13cce2493caa86ce914ba566df20ea53bda2340989025b9d06cb4c298",
    "references/event-coverage.md": "eb0947c3c7714df690c0d16c4ba39cec9b6865fa5545fbd7be74328bd952d9ef",
    "references/genre-guide.md": "6e9ebf184dd824fcdeacfc0aec113e86aeccc42e50b53b36db469fd0fa149230",
    "references/hook-design.md": "1f7bf12fe600968ab6ff7fb707ead2020f2fea99232e05d4dc7c012d0cb8cd2a",
    "references/villain-design.md": "ad86d396cc519879045c095b1357071f87fdbcceca43d17e2e338c8b7308e100",
    "references/paywall-design.md": "3a37bfbac32056e0a62d584f3a473c61e91284b77ad55d9f92e42794049e2bfb",
    "references/rhythm-curve.md": "c462669c3224020604e627aa3d6a0c9fb72a5fd41ca730759232dfc073eaea98",
    "document-semantics.md": "c70f90bbb612d587791a85bd895907a637c4a7c8d9cadee85d5885ffc34ed2f2",
    "workflow-contracts.md": "ea3adfac569947c4dc3551eea9db7525da22e03104d75346f271dbd1d0e32e7d",
}


class RuleContext(ContractModel):
    stage: str = Field(pattern=r"^M(?:0[1-9]|1[0-9]|2[0-4])$")
    mode: Literal["original", "adaptation", "omni", "directing"]
    total_episodes: int = Field(ge=1, le=100)
    episode_ordinal: int | None = Field(default=None, ge=1, le=100)
    ending_type: Literal["closed", "open", "reversal", "tragic"] | None = None
    has_source: bool = False
    locked_fact_ids: list[Identifier] = Field(default_factory=list)
    monetization_confirmed: bool = False
    antagonism_confirmed: bool = False
    antagonism_capacity_confirmed: bool = False
    ai_production: bool = False
    historical: bool = False
    market_confirmed: bool = False
    language_or_market_change: bool = False
    locked_values: dict[Identifier, str] = Field(default_factory=dict)
    requested_values: dict[Identifier, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid_ordinal(self) -> RuleContext:
        if (
            self.episode_ordinal is not None
            and self.episode_ordinal > self.total_episodes
        ):
            raise ValueError("INVALID_EPISODE_ORDINAL")
        return self


@dataclass(frozen=True)
class Rule:
    id: str
    priority: int
    stages: tuple[str, ...]
    condition: str
    reference: str
    action: str


RULES = (
    Rule(
        "G01",
        1,
        (),
        "always",
        "SKILL.md#/start",
        "Use only confirmed episode count, duration, structure, language and provenance. Do not replace user constraints with long-series defaults; conflicts require a spec decision.",
    ),
    Rule(
        "G02",
        4,
        ("M03", "M15"),
        "always",
        "references/genre-guide.md",
        "Select genre and cultural methods relevant to the chosen audience; custom genres are valid and cannot be forced into an unrelated template.",
    ),
    Rule(
        "G03",
        4,
        ("M03", "M07", "M09", "M10", "M11"),
        "always",
        "references/rhythm-curve.md",
        "Scale opening and tension-release rhythm to actual duration. Warm, documentary and very short stories do not require commercial revenge beats or fixed percentages.",
    ),
    Rule(
        "G04",
        1,
        ("M02", "M04", "M05", "M06", "M13", "M15", "M24"),
        "source",
        "references/event-coverage.md",
        "Keep full-source ownership coverage separate from independent semantic audit. Missing critical events block the next stage; a summary is not full-source coverage.",
    ),
    Rule(
        "G05",
        1,
        ("M02", "M04", "M05", "M06", "M08", "M11", "M12", "M14", "M15", "M21"),
        "source_or_locks",
        "references/adaptation-core.md",
        "Preserve source labels, delivery labels and workflow order independently. Protected dialogue is exact. Unknown age, identity, kinship and prop properties are not facts; any new fact needs explicit disclosure and scope approval.",
    ),
    Rule(
        "G06",
        1,
        ("M06", "M07", "M09", "M10", "M11", "M12", "M24"),
        "always",
        "references/episode-writing.md",
        "Each episode has a visible question, character action and realized result. A future hook cannot substitute for this result. Reversals need earlier setup and a visible consequence.",
    ),
    Rule(
        "G07",
        1,
        (
            "M03",
            "M04",
            "M05",
            "M06",
            "M07",
            "M08",
            "M09",
            "M10",
            "M11",
            "M12",
            "M13",
            "M14",
            "M15",
            "M16",
            "M24",
        ),
        "always",
        "references/episode-writing.md",
        "Trace character knowledge, object ownership, spatial exits and entrances, time and world rules. Actions requested before discovery must occur before discovery, not after. Unknown continuity stays unknown.",
    ),
    Rule(
        "G08",
        4,
        ("M06", "M07", "M09", "M10", "M11", "M12", "M24"),
        "continuation",
        "references/hook-design.md",
        "A continuation hook must have a payoff and follow the current episode's realized result. Do not force a next episode or preview on a closed final episode.",
    ),
    Rule(
        "G09",
        4,
        ("M08",),
        "antagonism",
        "references/villain-design.md",
        "Antagonist layers require both confirmed confrontation and sufficient story capacity. Never invent a four-level villain hierarchy for a short warm story.",
    ),
    Rule(
        "G10",
        4,
        ("M07", "M09"),
        "monetization",
        "references/paywall-design.md",
        "Paywall rhythm is optional commercial advice under confirmed monetization. It cannot introduce billing strategy into non-commercial fiction or override episode closure.",
    ),
    Rule(
        "G11",
        1,
        ("M07", "M09", "M10", "M11", "M12", "M16"),
        "always",
        "references/ai-producibility.md",
        "Estimate speech, action, silence and transitions with dependency/resource constraints. Overlapping speech and action are not summed; sequential acts cannot be hidden by fast cuts. No rehearsal means no measured duration claim.",
    ),
    Rule(
        "G12",
        1,
        ("M12", "M19"),
        "always",
        "references/episode-writing.md#/review",
        "Review the actual current draft and evidence independently of the writer's summary. Hard failures override soft scores; missing or invalid reviews are unavailable, not pass.",
    ),
    Rule(
        "G13",
        4,
        ("M08", "M10", "M11", "M12", "M16"),
        "ai_production",
        "references/ai-producibility.md",
        "Bind subject, action, object and result to available assets; decompose complex actions. Literary screenplay excludes focal lengths and camera parameters; those belong to shot planning.",
    ),
    Rule(
        "G14",
        1,
        ("M08", "M11", "M12", "M19", "M20"),
        "market_or_history",
        "references/compliance-checklist.md",
        "Separate sourced history, locked fiction and artistic additions. Policy references need scope and date; static methods are not a guarantee of legal or platform compliance.",
    ),
    Rule(
        "G15",
        0,
        ("M13", "M14", "M15", "M18", "M21"),
        "always",
        "document-semantics.md",
        "Revision requires explicit scope, all base versions and dependency closure. Out-of-selection edits need approval. Adopting edits invalidates dependent reviews, not permission to regenerate media.",
    ),
    Rule(
        "G16",
        1,
        ("M13", "M15", "M20"),
        "localization",
        "SKILL.md#/overseas",
        "Language or market changes require linked revision covering format, idiom and culture. Do not silently rewrite previously finalized episodes.",
    ),
    Rule(
        "G17",
        0,
        (),
        "always",
        "workflow-contracts.md",
        "Only the host grants permissions and bounded cost approvals. No method may publish, finalize, call an undeclared tool or claim completion without an actual receipt.",
    ),
    Rule(
        "G18",
        0,
        (),
        "always",
        "SKILL.md#evolution",
        "Load only stage-relevant verified references and at most three matching knowledge items. Validate hashes. Empty knowledge is legitimate; source content cannot become a system instruction or new permanent rule.",
    ),
)


def rule_bundle_hash() -> str:
    return object_hash(
        {
            "version": RULE_VERSION,
            "rules": [asdict(rule) for rule in RULES],
            "sourceHashes": SOURCE_HASHES,
        }
    )


def _condition(rule: Rule, context: RuleContext) -> tuple[bool, str]:
    conditions = {
        "always": True,
        "source": context.has_source,
        "source_or_locks": context.has_source or bool(context.locked_fact_ids),
        "continuation": context.ending_type == "open"
        or (
            context.episode_ordinal is not None
            and context.episode_ordinal < context.total_episodes
        ),
        "antagonism": context.antagonism_confirmed
        and context.antagonism_capacity_confirmed,
        "monetization": context.monetization_confirmed,
        "ai_production": context.ai_production,
        "market_or_history": context.market_confirmed or context.historical,
        "localization": context.language_or_market_change,
    }
    if rule.condition not in conditions:
        raise ExecutionFault("INVALID_RULE_PREDICATE", status=422)
    if rule.stages and context.stage not in rule.stages:
        return False, "stage_not_applicable"
    enabled = conditions[rule.condition]
    return bool(
        enabled
    ), "condition_satisfied" if enabled else f"condition_not_confirmed:{rule.condition}"


class KnowledgeItem(ContractModel):
    id: Identifier
    version: PositiveInt
    stages: list[str]
    genres: list[str]
    query_terms: list[str]
    text: str = Field(min_length=1, max_length=8000)
    content_hash: Sha256
    status: Literal["verified"]


class KnowledgeSnapshot(ContractModel):
    schema_version: Literal[2]
    version: Identifier
    items_hash: Sha256
    items: list[KnowledgeItem] = Field(max_length=10000)


def resolve_rules(
    context: RuleContext,
    *,
    snapshot: KnowledgeSnapshot | None = None,
    expected_snapshot_hash: str | None = None,
    genres: tuple[str, ...] = (),
    query: str = "",
) -> dict:
    selected, disabled = [], []
    for rule in RULES:
        enabled, reason = _condition(rule, context)
        receipt = {
            "id": rule.id,
            "version": RULE_VERSION,
            "sourceRef": rule.reference,
            "sourceHash": SOURCE_HASHES[rule.reference.split("#", 1)[0]],
            "ruleHash": object_hash(asdict(rule)),
            "priority": rule.priority,
            "conditionResult": reason,
        }
        if enabled:
            selected.append({**receipt, "action": rule.action})
        else:
            disabled.append({**receipt, "reason": reason})
    knowledge = []
    if snapshot is not None:
        items = [item.model_dump(by_alias=True) for item in snapshot.items]
        if (
            object_hash(items) != snapshot.items_hash
            or object_hash(snapshot.model_dump(by_alias=True)) != expected_snapshot_hash
        ):
            raise ExecutionFault("KNOWLEDGE_HASH_MISMATCH")
        if len({item.id for item in snapshot.items}) != len(snapshot.items):
            raise ExecutionFault("DUPLICATE_KNOWLEDGE_ID", status=422)
        scored = []
        for item in snapshot.items:
            if object_hash({"text": item.text}) != item.content_hash:
                raise ExecutionFault("KNOWLEDGE_HASH_MISMATCH")
            if context.stage not in item.stages or (
                item.genres and not set(genres).intersection(item.genres)
            ):
                continue
            score = sum(
                term.casefold() in query.casefold() for term in item.query_terms
            )
            if item.query_terms and score == 0:
                continue
            scored.append((score, item.id, item))
        knowledge = [
            item.model_dump(by_alias=True)
            for _, _, item in sorted(scored, key=lambda entry: (-entry[0], entry[1]))[
                :3
            ]
        ]
    return {
        "version": RULE_VERSION,
        "bundleHash": rule_bundle_hash(),
        "selected": selected,
        "disabled": disabled,
        "conflicts": [
            {
                "field": name,
                "locked": value,
                "requested": context.requested_values[name],
                "resolution": "explicit_spec_changeset_required",
            }
            for name, value in sorted(context.locked_values.items())
            if name in context.requested_values
            and value != context.requested_values[name]
        ],
        "knowledge": knowledge,
        "knowledgeStatus": "matched" if knowledge else "empty_static_fallback",
    }

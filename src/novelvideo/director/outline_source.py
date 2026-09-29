"""Source locations are host-owned; exact quotes are evidence, not proof of truth.

The first delivery slice uses one fully owned source chunk. It never labels a
curated summary as a complete-original audit, or discards a tail to fit a call.
"""

from __future__ import annotations

import re

from .documents import content_hash, object_hash
from .schemas.outline_source import SourceAudit, SourceExtraction


def freeze_source(text: str, *, kind: str = "full_text", label: str = "source") -> dict:
    if not text.strip() or kind not in {"full_text", "curated_summary"}:
        raise ValueError("SOURCE_REQUIRED")
    digest = content_hash(text)
    units = []
    # Newline ownership stays with its preceding unit. No strip/normalization
    # may change offsets between the stored source and its evidence.
    for match in re.finditer(r"[^\n]+(?:\n+|$)|\n+", text):
        start, end = match.span()
        if not match.group().strip():
            continue
        units.append({
            "id": "unit-" + object_hash([digest, start, end])[:20],
            "start": start, "end": end, "text": match.group(),
            "textHash": content_hash(match.group()),
        })
    return {
        "versionId": "source-" + digest, "hash": digest, "text": text,
        "kind": kind, "label": label, "offsetEncoding": "unicode_codepoint",
        "ownership": [{"start": 0, "end": len(text), "textHash": digest}],
        "units": units,
    }


def source_for_root(root: dict) -> dict:
    source = freeze_source(
        root["sourceText"], kind=root.get("sourceKind", "full_text"),
        label=root.get("sourceLabel", "source"),
    )
    if source["hash"] != root["sourceHash"]:
        raise ValueError("SOURCE_SPAN_HASH_MISMATCH")
    return source


def locate_quotes(quotes: list[dict], source: dict) -> list[dict]:
    units = {unit["id"]: unit for unit in source["units"]}
    result = []
    for ref in quotes:
        unit = units.get(ref["unitId"])
        quote = ref["quote"]
        if unit is None or not quote.strip() or unit["text"].count(quote) != 1:
            raise ValueError("SOURCE_QUOTE_AMBIGUOUS_OR_MISSING")
        start = unit["start"] + unit["text"].index(quote)
        result.append({
            **ref, "sourceVersionId": source["versionId"], "start": start,
            "end": start + len(quote), "quoteHash": content_hash(quote),
            "offsetEncoding": "unicode_codepoint",
        })
    return result


def _coverage(ids: list[str], source: dict) -> None:
    expected = {unit["id"] for unit in source["units"]}
    if len(ids) != len(set(ids)) or set(ids) != expected:
        raise ValueError("SOURCE_AUDIT_INCOMPLETE")


def extract_source(value: dict, source: dict) -> dict:
    data = SourceExtraction.from_wire(value).model_dump(by_alias=True)
    _coverage(data["readUnitIds"], source)
    claims = []
    for claim in data["claims"]:
        if claim["kind"] == "character_statement" and not (claim["speaker"] or "").strip():
            raise ValueError("SOURCE_SPEAKER_REQUIRED")
        evidence = locate_quotes(claim["evidence"], source)
        identity = object_hash([source["versionId"], claim])[:24]
        claims.append({**claim, "id": "claim-" + identity, "evidence": evidence,
                       "eventId": "event-" + identity})
    if len({claim["id"] for claim in claims}) != len(claims):
        raise ValueError("SOURCE_DUPLICATE_CLAIM")
    return {"contract": data["contract"], "sourceVersionId": source["versionId"],
            "sourceHash": source["hash"], "claims": claims,
            "readUnitIds": data["readUnitIds"], "ownership": source["ownership"]}


def audit_source(value: dict, source: dict, graph: dict) -> dict:
    data = SourceAudit.from_wire(value).model_dump(by_alias=True)
    _coverage(data["readUnitIds"], source)
    known = {claim["id"] for claim in graph["claims"]}
    checks = [check["claimId"] for check in data["checks"]]
    if len(checks) != len(set(checks)) or set(checks) != known:
        raise ValueError("SOURCE_AUDIT_INCOMPLETE")
    missing, bad = [], []
    observed = set()
    for observation in data["observations"]:
        observation["evidence"] = locate_quotes(observation["evidence"], source)
        if not set(observation["matchingClaimIds"]) <= known:
            raise ValueError("SOURCE_AUDIT_UNKNOWN_CLAIM")
        observed.update(ref["unitId"] for ref in observation["evidence"])
        if observation["critical"] and not observation["matchingClaimIds"]:
            missing.append(observation)
    if observed != set(data["readUnitIds"]):
        raise ValueError("SOURCE_AUDIT_INCOMPLETE")
    for check in data["checks"]:
        check["evidence"] = locate_quotes(check["evidence"], source)
        if check["verdict"] != "supported":
            bad.append(check["claimId"])
    return {**data, "sourceHash": source["hash"], "graphHash": object_hash(graph),
            "missingCritical": missing, "unresolvedClaimIds": bad,
            "status": "reviewed" if not missing and not bad else "blocked"}


def delivery_context(source: dict, graph: dict, audit: dict) -> dict:
    if (audit["status"] != "reviewed" or audit["sourceHash"] != source["hash"]
            or audit["graphHash"] != object_hash(graph)):
        raise ValueError("SOURCE_AUDIT_INCOMPLETE")
    if graph.get("operationId") and graph.get("operationId") == audit.get("operationId"):
        raise ValueError("AUDIT_MUST_BE_INDEPENDENT")
    claims = graph["claims"]
    return {
        "sourceVersionId": source["versionId"], "sourceHash": source["hash"],
        "sourceLabel": source["label"], "sourceKind": source["kind"],
        "claims": [{"id": c["id"], "text": c["assertion"]} for c in claims],
        "events": [{"id": c["eventId"], "text": c["assertion"]} for c in claims],
        "authorizedChanges": [],
        "requiredClaimIds": [c["id"] for c in claims if c["critical"]],
        # Unresolved boundaries must remain covered as claims, not be invented
        # as scenes just to satisfy narrative causality. Keep the ID catalogue
        # unchanged so retained wire responses remain reversibly decodable.
        "requiredEventIds": [c["eventId"] for c in claims if c["critical"] and c["kind"] != "unresolved"],
        "unresolvedClaimIds": [c["id"] for c in claims if c["kind"] == "unresolved"],
        "openingEventIds": None, "chapterKeys": [],
    }

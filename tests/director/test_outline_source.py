"""Source spans cannot become evidence by assertion, clipping or self-audit."""

import copy

import pytest

from novelvideo.director.documents import content_hash
from novelvideo.director.outline_source import (
    audit_source, delivery_context, extract_source, freeze_source, locate_quotes,
)


def extraction_for(source):
    return {"contract": "outline-source/1.0.0", "readUnitIds": [u["id"] for u in source["units"]],
            "claims": [{"assertion": u["text"].strip(), "kind": "observed", "speaker": None,
                        "subjects": ["visitor"], "critical": True,
                        "evidence": [{"unitId": u["id"], "quote": u["text"].strip()}]}
                       for u in source["units"]]}


def audit_for(source, graph):
    return {"contract": "outline-source-audit/1.0.0", "readUnitIds": [u["id"] for u in source["units"]],
            "observations": [{"assertion": c["assertion"], "critical": True,
                              "matchingClaimIds": [c["id"]], "evidence": [
                                  {"unitId": e["unitId"], "quote": e["quote"]} for e in c["evidence"]]}
                             for c in graph["claims"]],
            "checks": [{"claimId": c["id"], "verdict": "supported", "reason": "Source shows this.",
                        "evidence": [{"unitId": e["unitId"], "quote": e["quote"]} for e in c["evidence"]]}
                       for c in graph["claims"]]}


def test_unicode_locations_and_complete_ownership():
    text = "\n😀访客入画。\n\nA friend knocks.\nThe visitor returns.\n"
    source = freeze_source(text, kind="curated_summary")
    graph = extract_source(extraction_for(source), source)
    for claim in graph["claims"]:
        for evidence in claim["evidence"]:
            assert text[evidence["start"]:evidence["end"]] == evidence["quote"]
            assert content_hash(evidence["quote"]) == evidence["quoteHash"]
    assert source["ownership"] == [{"start": 0, "end": len(text), "textHash": content_hash(text)}]
    report = audit_source(audit_for(source, graph), source, graph)
    assert delivery_context(source, graph, report)["sourceKind"] == "curated_summary"


def test_identity_stable_under_response_reordering_not_source_changes():
    source = freeze_source("A enters.\nB leaves.")
    first = extraction_for(source)
    second = copy.deepcopy(first)
    second["claims"].reverse()
    a, b = extract_source(first, source), extract_source(second, source)
    assert sorted(c["id"] for c in a["claims"]) == sorted(c["id"] for c in b["claims"])
    assert freeze_source("A enters.\nB stays.")["versionId"] != source["versionId"]


@pytest.mark.parametrize("failure", ["tail", "quote", "speaker", "duplicate", "extra", "wire"])
def test_extraction_rejects_false_coverage_and_authority(failure):
    source = freeze_source("A enters.\nB leaves.")
    data = extraction_for(source)
    if failure == "tail":
        data["readUnitIds"].pop()
    elif failure == "quote":
        data["claims"][0]["evidence"][0]["quote"] = "A leaves."
    elif failure == "speaker":
        data["claims"][0]["kind"] = "character_statement"
    elif failure == "duplicate":
        data["claims"].append(data["claims"][0])
    elif failure == "extra":
        data["approved"] = True
    else:
        data["read_unit_ids"] = data.pop("readUnitIds")
    with pytest.raises(ValueError):
        extract_source(data, source)


def test_ambiguous_quote_is_not_arbitrarily_first_occurrence():
    source = freeze_source("knock, knock.")
    with pytest.raises(ValueError, match="AMBIGUOUS"):
        locate_quotes([{"unitId": source["units"][0]["id"], "quote": "knock"}], source)


def test_unresolved_constraints_are_not_required_narrative_events():
    source = freeze_source("A enters.\nDo not invent a marriage.")
    draft = extraction_for(source)
    draft["claims"][1]["kind"] = "unresolved"
    graph = extract_source(draft, source)
    context = delivery_context(source, graph, audit_source(audit_for(source, graph), source, graph))
    boundary = graph["claims"][1]
    assert boundary["id"] in context["requiredClaimIds"]
    assert boundary["id"] in context["unresolvedClaimIds"]
    assert boundary["eventId"] not in context["requiredEventIds"]
    assert boundary["eventId"] in {e["id"] for e in context["events"]}


@pytest.mark.parametrize("failure", ["missing_event", "wrong_claim", "uncertain", "self_audit", "stale", "coverage"])
def test_source_audit_cannot_be_used_when_incomplete_or_stale(failure):
    source = freeze_source("A enters.\nB leaves.")
    graph = extract_source(extraction_for(source), source)
    graph["operationId"] = "extract-run"
    data = audit_for(source, graph)
    if failure == "missing_event":
        data["observations"][0]["matchingClaimIds"] = []
    elif failure in {"wrong_claim", "uncertain"}:
        data["checks"][0]["verdict"] = "violated" if failure == "wrong_claim" else "uncertain"
    elif failure == "coverage":
        data["observations"].pop()
        with pytest.raises(ValueError, match="INCOMPLETE"):
            audit_source(data, source, graph)
        return
    report = audit_source(data, source, graph)
    report["operationId"] = "extract-run" if failure == "self_audit" else "audit-run"
    if failure == "stale":
        graph["claims"][0]["assertion"] = "changed"
    with pytest.raises(ValueError):
        delivery_context(source, graph, report)

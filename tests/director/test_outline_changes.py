"""Review/adoption is a versioned transaction, including mixed accept/reject."""

import json

import pytest

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.documents import object_hash
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import identifier
from novelvideo.director.outline_candidate_review import candidate_units
from novelvideo.director.repository import DocumentRepository
from novelvideo.director.schemas.documents import DocumentCommand
from novelvideo.director.schemas.execution import ExecutionCommand, ExecutionFault
from novelvideo.director.workflow import dispatch_planning
from tests.director.test_outline_pipeline import runtime as runtime, provider, start
from tests.director.test_workflow import decide


def execute(runtime, payload):
    store, wid, _, repo, _ = runtime
    intent = identifier()
    return ExecutionService(repo).execute("writer", ExecutionCommand.from_wire({
        "schemaVersion": 2, "commandId": intent, "clientRequestId": intent, "sessionId": "test", "workId": wid,
        "expected": {"workRevision": store.get_work(wid)["revision"],
                     "documentVersions": {"outline": store.get_document(wid, "outline")["version"]},
                     "capabilityVersion": execution_capability()["version"]}, "payload": payload}))["result"]


def patch_value(snapshot):
    ctx = snapshot["parameters"]["patchContext"]
    blocks = {b["id"]: b for b in ctx["baseAst"]["blocks"]}
    hunks = []
    for i, section in enumerate(ctx["bindings"]["sections"][:2]):
        bid = next(b for b in section["blockIds"] if b not in ctx["bindings"]["protectedBlockIds"])
        hunks.append({"id": f"h{i}", "sectionKey": section["key"], "targetBlockIds": [bid],
            "beforeHash": object_hash([blocks[bid]]), "changedClaimIds": [], "reason": "Clarify prose.",
            "afterBlocks": [{"type": "paragraph", "text": f"Requested clarification {i}.", "level": None, "lineBreak": True}]})
    return {"contract": "outline-patch/1.0.0", **{k: ctx[k] for k in ("baseVersion", "baseAstHash", "baseSemanticHash")},
            "hunks": hunks, "changeSummary": [{"text": "Two precise clarifications.", "hunkIds": [h["id"] for h in hunks]}],
            "unresolvedRequests": []}


async def prepare(runtime):
    await start(runtime, [])
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    decide(runtime, "adopt")
    quote = execute(runtime, {"type": "cost.quote", "kind": "outline", "instruction": "Clarify two passages."})
    assert quote["parameters"]["output_contract"] == "outline-patch/1.0.0"
    assert quote["parameters"]["skill_key"] == "studio/outline-patch"
    run = execute(runtime, {"type": "approval.grant", "quoteId": quote["quoteId"], "requestHash": quote["requestHash"], "unknownCostConsent": True})
    with runtime[0]._connect() as db:
        snapshot = runtime[3].snapshot(db, run["id"])
    value = patch_value(snapshot)

    async def model(*args):
        return json.dumps(value)

    result = await dispatch_writing(runtime[3], runtime[1], run["id"], model)
    assert result["status"] == "succeeded", json.dumps(result)
    return runtime[0].list_changes(runtime[1])[0]


async def review(runtime, change, group_ids, *, blocked=False):
    quote = execute(runtime, {"type": "cost.quote", "kind": "outline", "purpose": "review",
        "reviewTarget": {"changeId": change["id"], "changeRevision": change["outlinePatch"]["revision"], "acceptGroupIds": group_ids}})
    run = execute(runtime, {"type": "approval.grant", "quoteId": quote["quoteId"], "requestHash": quote["requestHash"], "unknownCostConsent": True})
    with runtime[0]._connect() as db:
        snapshot = runtime[3].snapshot(db, run["id"])

    async def model(*args):
        from novelvideo.director.outline_source import source_for_root
        source = source_for_root(snapshot["outlineReviewTarget"]["root"])
        return json.dumps({"contract": "outline-candidate-audit/1.0.0", "literaryNotes": ["Synthetic review."],
            "units": [{"path": u["path"], "findings": [{"assertion": u["text"], "candidateQuote": u["text"],
                "verdict": "violated" if blocked else "supported", "reason": "Synthetic fixture, not a semantic audit.",
                "sourceEvidence": [{"unitId": source["units"][0]["id"], "quote": source["units"][0]["text"]}]}]}
                for u in candidate_units(snapshot["outlineReviewTarget"]["candidate"])]})

    result = await dispatch_writing(runtime[3], runtime[1], run["id"], model)
    assert result["status"] == "succeeded", json.dumps(result)
    return result["response"]["outlineCandidateReview"]


def decision(runtime, change, group_ids, *, accept=True, report=None):
    store, wid = runtime[:2]
    doc = store.get_document(wid, "outline")
    intent = identifier()
    return DocumentCommand.from_wire({"schemaVersion": 2, "commandId": intent, "clientRequestId": intent,
        "sessionId": "test", "workId": wid, "expected": {"workRevision": store.get_work(wid)["revision"],
        "documentVersions": {doc["document_id"]: doc["version"]}}, "payload": {"type": "outline.decideGroups",
        "documentId": doc["document_id"], "changeId": change["id"], "changeRevision": change["outlinePatch"]["revision"],
        "groupIds": group_ids, "decision": "accept" if accept else "reject", "reportId": report}})


async def test_partial_accept_then_reject_is_durable_atomic_and_idempotent(runtime):
    change = await prepare(runtime)
    groups = [g["id"] for g in change["outlinePatch"]["groups"]]
    store, wid = runtime[:2]
    doc_before = store.get_document(wid, "outline")
    with pytest.raises(ExecutionFault, match="GROUP_DECISION_REQUIRED"):
        store.decide_change(wid, change["id"], True)
    repository = DocumentRepository(store)
    with pytest.raises(ExecutionFault, match="CANDIDATE_REVIEW_REQUIRED"):
        repository.execute("writer", decision(runtime, change, groups[:1]))
    report = await review(runtime, change, groups[:1])
    command = decision(runtime, change, groups[:1], report=report["id"])
    first = repository.execute("writer", command)
    assert repository.execute("writer", command) == first
    saved = store.get_document(wid, "outline")
    assert saved["version"] == doc_before["version"] + 1
    assert "Requested clarification 0." in saved["content"]
    assert "Requested clarification 1." not in saved["content"]
    partial = store.list_changes(wid)[0]
    assert partial["status"] == "pending"
    repository.execute("writer", decision(runtime, partial, groups[1:], accept=False))
    assert store.get_document(wid, "outline") == saved
    assert store.list_changes(wid)[0]["status"] == "accepted"
    assert store.list_changes(wid)[0]["outlinePatch"]["decisions"][groups[1]] == "rejected"


async def test_report_for_full_candidate_cannot_approve_a_partial_combination(runtime):
    change = await prepare(runtime)
    groups = [g["id"] for g in change["outlinePatch"]["groups"]]
    report = await review(runtime, change, groups)
    with pytest.raises(ExecutionFault, match="CANDIDATE_REVIEW_REQUIRED"):
        DocumentRepository(runtime[0]).execute("writer", decision(runtime, change, groups[:1], report=report["id"]))
    assert runtime[0].get_document(runtime[1], "outline")["version"] == 1


async def test_noop_reply_is_retained_without_leaving_editing_locked(runtime):
    from novelvideo.director.outline_changes import record_patch

    await start(runtime, [])
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    decide(runtime, "adopt")
    quote = execute(runtime, {"type": "cost.quote", "kind": "outline", "instruction": "No change needed."})
    run = execute(runtime, {"type": "approval.grant", "quoteId": quote["quoteId"], "requestHash": quote["requestHash"], "unknownCostConsent": True})
    with runtime[3].transaction() as db:
        snapshot = runtime[3].snapshot(db, run["id"])
        value = patch_value(snapshot)
        value.update(hunks=[], changeSummary=[], unresolvedRequests=["The requested property is already present."])
        record_patch(db, runtime[0], runtime[1], run["id"], snapshot, value)
    changes = runtime[0].list_changes(runtime[1])
    assert changes[0]["status"] == "rejected"
    assert changes[0]["outlinePatch"]["unresolvedRequests"]
    assert runtime[0].get_document(runtime[1], "outline")["version"] == 1


def test_duplicate_patch_json_fields_do_not_silently_override():
    from novelvideo.director.output_validation import parse_model_json

    with pytest.raises(ValueError, match="OUTLINE_DUPLICATE_JSON_KEY"):
        parse_model_json('{"hunks": [], "hunks": [{"id":"hidden"}]}')


async def test_failed_fact_review_and_stale_decision_do_not_write(runtime):
    change = await prepare(runtime)
    groups = [g["id"] for g in change["outlinePatch"]["groups"]]
    report = await review(runtime, change, groups, blocked=True)
    stale = decision(runtime, change, groups, report=report["id"])
    with pytest.raises(ExecutionFault, match="CANDIDATE_REVIEW_REQUIRED"):
        DocumentRepository(runtime[0]).execute("writer", stale)
    DocumentRepository(runtime[0]).execute("writer", decision(runtime, change, groups[:1], accept=False))
    with pytest.raises(ExecutionFault, match="REVIEW_HEAD_CHANGED"):
        DocumentRepository(runtime[0]).execute("writer", stale)


async def test_patch_reads_latest_manual_version_without_duplicate_ast(runtime):
    from novelvideo.director.outline_changes import compile_patch

    await start(runtime, [])
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    decide(runtime, "adopt")
    store, wid = runtime[:2]
    before = store.get_document(wid, "outline")
    marker = "Manual revision must reach the next model request."
    store.put_document(wid, "outline", before["content"] + "\n\n" + marker, before["version"])
    request = compile_patch(store, wid, "Revise only the final sentence.", 12288)
    frozen = request["parameters"]["patchContext"]
    assert frozen["baseVersion"] == before["version"] + 1
    assert any(marker in b["text"] for b in frozen["baseAst"]["blocks"])
    header = json.loads(request["prompt"].split("\n", 1)[1].split("\nHOST_VERIFIED_METHOD_JSON:")[0])
    view = header["parameters"]
    assert "outlineRoot" not in view
    assert "baseAst" not in view["patchContext"]
    assert "bindings" not in view["patchContext"]
    assert view["hostSnapshotHash"] == object_hash(request["parameters"])
    inputs = json.loads(json.loads(request["prompt"].split("INPUT_DATA_JSON:\n", 1)[1])[0]["text"])
    assert sum(marker in b["text"] for b in inputs["targets"]) == 1
    assert len(inputs["targets"]) + len(inputs["documentContext"]) == len(frozen["baseAst"]["blocks"])
    assert "sourceGraph" in inputs and "source" in inputs


async def test_review_retry_freezes_exact_failure_without_reusing_other_candidates(runtime):
    from novelvideo.director.outline_candidate_review import audit_aliases, map_audit_ids
    from novelvideo.director.outline_source import source_for_root
    from novelvideo.director.writing import WritingResult

    change = await prepare(runtime)
    group_ids = [g["id"] for g in change["outlinePatch"]["groups"]]
    target = {"changeId": change["id"], "changeRevision": change["outlinePatch"]["revision"], "acceptGroupIds": group_ids}
    quote = execute(runtime, {"type": "cost.quote", "kind": "outline", "purpose": "review", "reviewTarget": target})
    run = execute(runtime, {"type": "approval.grant", "quoteId": quote["quoteId"], "requestHash": quote["requestHash"], "unknownCostConsent": True})
    with runtime[0]._connect() as db:
        snapshot = runtime[3].snapshot(db, run["id"])
    frozen = snapshot["outlineReviewTarget"]
    source = source_for_root(frozen["root"])
    value = {"contract": "outline-candidate-audit/1.2.0", "literaryNotes": [], "units": [
        {"path": u["path"], "findings": [{"assertion": "Synthetic fixture", "candidateQuote": u["text"],
         "verdict": "supported", "reason": "Synthetic fixture", "sourceEvidence": [{"unitId": source["units"][0]["id"]}]}]}
        for u in candidate_units(frozen["candidate"])]}
    value = map_audit_ids(value, audit_aliases(source, frozen["candidate"]))
    value["units"][0]["findings_note"] = None
    raw = json.dumps(value)
    async def model(*args):
        return WritingResult(raw, 100, 100, 1, "stop", "test-seed")
    result = await dispatch_writing(runtime[3], runtime[1], run["id"], model)
    assert result["status"] == "failed"
    retry = execute(runtime, {"type": "cost.quote", "kind": "outline", "purpose": "review", "reviewTarget": target})
    assert retry["parameters"]["validationRecovery"]["operationId"] == run["id"]
    assert retry["parameters"]["validationRecovery"]["issues"][0]["code"] == "additionalProperties"
    assert runtime[3].retained_result(runtime[1], run["id"])["output"] == raw
    partial = execute(runtime, {"type": "cost.quote", "kind": "outline", "purpose": "review",
        "reviewTarget": {**target, "acceptGroupIds": group_ids[:1]}})
    assert "validationRecovery" not in partial["parameters"]
    assert not any(op["status"] == "queued" for op in runtime[3].list_operations(runtime[1]))
    from novelvideo.director.outline_changes import failed_review_context
    with runtime[3].transaction() as db:
        db.execute("UPDATE director_operations SET status='unknown' WHERE id=?", (run["id"],))
        assert failed_review_context(db, runtime[1], frozen) is None

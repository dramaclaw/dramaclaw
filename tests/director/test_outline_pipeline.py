"""V3 tests traverse paid-operation boundaries, not just a renderer's happy path."""

import copy
import json
from pathlib import Path

import pytest

from novelvideo.director import execution, writing
from novelvideo.director.documents import object_hash
from novelvideo.director.execution_repository import ExecutionRepository
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.outline_candidate_review import candidate_units
from novelvideo.director.outline_source import source_for_root
from novelvideo.director.schemas.execution import ExecutionFault
from novelvideo.director.store import DirectorStore
from novelvideo.director.workflow import WorkflowService, dispatch_planning
from tests.director.test_outline_source import extraction_for, audit_for
from tests.director.test_workflow import send, grant, decide, root_for, sample

FIXTURE = Path(__file__).parents[1] / "fixtures/director/outline-v3/delivery.json"


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("DIRECTOR_OUTLINE_V3", "1")
    def contract():
        return {"model_name": "test-model", "locked": True}
    monkeypatch.setattr(execution, "director_model_contract", contract)
    monkeypatch.setattr(writing, "director_model_contract", contract)
    fixture = json.loads(FIXTURE.read_text())
    source = "\n".join(c["text"] for c in fixture["context"]["claims"])
    store = DirectorStore(tmp_path)
    work = store.create_work(CreateWork(title="Gallery", brief=fixture["root"]["brief"], source_text=source,
                            preset=DirectorPreset(**fixture["root"]["preset"], adapt_direction="condense")))
    repo = ExecutionRepository(store)
    return store, work["id"], [0], repo, WorkflowService(repo)


def draft_for(runtime):
    fixture = json.loads(FIXTURE.read_text())
    graph = runtime[-1].projection(runtime[1])["artifacts"]["M04"]
    mapping = {"ep-1": root_for(runtime)["episodes"][0]["id"]}
    for i, claim in enumerate(graph["claims"], 1):
        mapping[f"claim-{i}"] = claim["id"]
        mapping[f"event-{i}"] = claim["eventId"]

    def remap(v):
        if isinstance(v, str):
            return mapping.get(v, v)
        if isinstance(v, list):
            return [remap(x) for x in v]
        if isinstance(v, dict):
            return {k: remap(x) for k, x in v.items()}
        return v

    return remap(fixture["draft"])


def provider(runtime, calls, *, fail_review=False):
    async def call(prompt, model, ceiling):
        assert model == "test-model"
        head = json.loads(prompt.split("\nHOST_VERIFIED_METHOD_JSON:")[0].split("\n", 1)[1])
        stage = head["parameters"]["stage"]
        calls.append(stage)
        source = source_for_root(root_for(runtime))
        artifacts = runtime[-1].projection(runtime[1])["artifacts"]
        if stage == "M04":
            value = extraction_for(source)
            value["claims"][1]["kind"] = "unresolved"
        elif stage == "M05":
            value = audit_for(source, artifacts["M04"])
        elif stage == "M03":
            value = sample("M03")
        elif stage == "M07":
            value = draft_for(runtime)
        else:
            value = {"contract": "outline-candidate-audit/1.0.0", "literaryNotes": ["Synthetic check only."],
                     "units": [{"path": u["path"], "findings": [{"assertion": u["text"],
                        "candidateQuote": u["text"], "verdict": "supported" if u["evidenceRole"] == "narrative" else "interpretation",
                        "reason": "Synthetic method output, not real semantic evidence.",
                        "sourceEvidence": [{"unitId": source["units"][0]["id"], "quote": source["units"][0]["text"]}]}]}
                               for u in candidate_units(artifacts["M07"]["candidate"])]}
            if fail_review:
                value["units"][0]["findings"][0]["verdict"] = "violated"
        return json.dumps(value)
    return call


async def start(runtime, calls):
    quote = send(runtime, {"type": "planning.quote", "targetScope": "outline", "sourceKind": "curated_summary"})
    assert quote["plan"]["stages"] == ["M04", "M05", "M03"]
    assert quote["plan"]["limits"]["maxCalls"] == 3
    grant(runtime, quote)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert runtime[-1].projection(runtime[1])["phase"] == "WAIT_DIRECTION", runtime[-1].projection(runtime[1])
    cp = runtime[-1].projection(runtime[1])["checkpoint"]["payload"]
    decide(runtime, "select", optionId=None, freeText="Keep source chronology.",
           answers={q["id"]: "Preserve the source." for q in cp["specQuestions"]})
    quote = send(runtime, {"type": "planning.quote", "targetScope": "outline"})
    assert quote["plan"]["stages"] == ["M07", "M12"]
    grant(runtime, quote)


async def test_new_pipeline_complete_five_sections_and_no_automatic_adoption(runtime):
    calls = []
    await start(runtime, calls)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    state = runtime[-1].projection(runtime[1])
    assert state["phase"] == "WAIT_OUTLINE", state
    assert calls == ["M04", "M05", "M03", "M07", "M12"]
    assert runtime[0].get_document(runtime[1], "outline")["version"] == 0
    content = state["checkpoint"]["payload"]["documents"]["outline"]
    assert len([line for line in content.splitlines() if line.startswith("## ")]) == 5
    candidate = state["artifacts"]["M07"]["candidate"]
    assert state["artifacts"]["M12"]["candidateHash"] == object_hash(candidate)
    assert len({state["artifacts"][s]["operationId"] for s in calls}) == 5
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert len(calls) == 5
    decide(runtime, "adopt")
    assert runtime[0].get_document(runtime[1], "outline")["content"] == content
    from novelvideo.director.repository import ast_version

    with runtime[0]._connect() as db:
        assert ast_version(db, runtime[1], "outline", 1)["ast"] == candidate["ast"]
    assert runtime[-1].projection(runtime[1])["phase"] == "READY"
    reopened = WorkflowService(ExecutionRepository(DirectorStore(runtime[0].path.parent.parent)))
    assert reopened.projection(runtime[1])["phase"] == "READY"


async def test_known_review_failure_retained_and_cannot_be_adopted(runtime):
    calls = []
    await start(runtime, calls)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls, fail_review=True))
    state = runtime[-1].projection(runtime[1])
    assert state["phase"] == "WAIT_OUTLINE", state
    assert state["artifacts"]["M12"]["status"] == "blocked"
    with pytest.raises(ExecutionFault, match="OUTLINE_FACT_CONFLICT"):
        decide(runtime, "adopt")
    assert runtime[0].get_document(runtime[1], "outline")["version"] == 0


async def test_source_graph_cannot_be_changed_behind_auditors_back(runtime):
    calls = []
    await start(runtime, calls)
    from novelvideo.director.outline_compiler import compile_outline_request
    state = runtime[-1].projection(runtime[1])
    altered = copy.deepcopy(state["artifacts"])
    altered["M04"]["claims"][0]["assertion"] = "invented"
    with pytest.raises(ValueError, match="SOURCE_AUDIT_INCOMPLETE"):
        compile_outline_request(root_for(runtime), "M07", altered, {"option": None, "freeText": "", "answers": {}}, 12288)


async def test_host_fix_can_revalidate_bytes_without_rewriting_cost_history(runtime, monkeypatch):
    from novelvideo.director import workflow

    calls = []
    await start(runtime, calls)
    validate = workflow.validate_planning
    def old_validator(stage, *args):
        if stage == "M07":
            raise ValueError("OUTLINE_CAUSAL_EVENT_MISSING")
        return validate(stage, *args)
    monkeypatch.setattr(workflow, "validate_planning", old_validator)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert runtime[-1].projection(runtime[1])["phase"] == "FAILED_RECOVERABLE"
    before = runtime[3].list_operations(runtime[1])
    monkeypatch.setattr(workflow, "validate_planning", validate)
    result = send(runtime, {"type": "planning.revalidate"})
    assert result["phase"] == "WAIT_COST"
    assert result["artifacts"]["M07"]["revalidated"]["outputHash"]
    assert runtime[3].list_operations(runtime[1]) == before
    quote = send(runtime, {"type": "planning.quote", "targetScope": "outline"})
    assert quote["plan"]["stages"] == ["M12"]
    assert calls == ["M04", "M05", "M03", "M07"]


async def test_blocked_candidate_has_explicit_revision_checkpoint_and_keeps_history(runtime):
    calls = []
    await start(runtime, calls)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls, fail_review=True))
    old = runtime[-1].projection(runtime[1])
    operations = runtime[3].list_operations(runtime[1])
    decide(runtime, "revise", freeText="Correct the cited chronology, preserve all other passages.")
    state = runtime[-1].projection(runtime[1])
    assert state["phase"] == "WAIT_COST" and set(state["artifacts"]) == {"M03", "M04", "M05"}
    assert state["checkpoint"]["payload"] == old["checkpoint"]["payload"]
    assert runtime[3].list_operations(runtime[1]) == operations
    assert runtime[0].get_document(runtime[1], "outline")["version"] == 0
    quote = send(runtime, {"type": "planning.quote", "targetScope": "outline"})
    assert quote["plan"]["stages"] == ["M07", "M12"]


async def test_last_stage_revalidation_restores_reading_checkpoint_without_new_call(runtime, monkeypatch):
    from novelvideo.director import workflow

    calls = []
    await start(runtime, calls)
    validate = workflow.validate_planning
    def old_validator(stage, *args):
        if stage == "M12":
            raise ValueError("OUTLINE_AUDIT_WIRE_INVALID")
        return validate(stage, *args)
    monkeypatch.setattr(workflow, "validate_planning", old_validator)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert runtime[-1].projection(runtime[1])["phase"] == "FAILED_RECOVERABLE"
    monkeypatch.setattr(workflow, "validate_planning", validate)
    operations = runtime[3].list_operations(runtime[1])
    result = send(runtime, {"type": "planning.revalidate"})
    assert result["phase"] == "WAIT_OUTLINE"
    assert result["checkpoint"]["payload"]["quality"]["status"] == "reviewed"
    assert runtime[3].list_operations(runtime[1]) == operations
    assert runtime[0].get_document(runtime[1], "outline")["version"] == 0


async def test_revalidation_rejects_response_from_another_direction(runtime, monkeypatch):
    from novelvideo.director import workflow

    await start(runtime, [])
    validate = workflow.validate_planning
    def old_validator(stage, *args):
        if stage == "M07":
            raise ValueError("OUTLINE_CAUSAL_EVENT_MISSING")
        return validate(stage, *args)
    monkeypatch.setattr(workflow, "validate_planning", old_validator)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    with runtime[3].transaction() as db:
        row = db.execute("SELECT direction_json FROM director_workflows WHERE work_id=?", (runtime[1],)).fetchone()
        direction = json.loads(row[0])
        direction["freeText"] = "A different confirmed direction."
        db.execute("UPDATE director_workflows SET direction_json=? WHERE work_id=?", (json.dumps(direction), runtime[1]))
    monkeypatch.setattr(workflow, "validate_planning", validate)
    with pytest.raises(ExecutionFault, match="PLANNING_RESULT_STALE"):
        send(runtime, {"type": "planning.revalidate"})


async def test_review_wire_selects_host_evidence_without_synthesized_quotes(runtime):
    from novelvideo.director.outline_candidate_review import validate_candidate_audit

    await start(runtime, [])
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    state = runtime[-1].projection(runtime[1])
    candidate = state["artifacts"]["M07"]["candidate"]
    source = source_for_root(root_for(runtime))
    value = {"contract": "outline-candidate-audit/1.1.0", "literaryNotes": [], "units": [
        {"path": u["path"], "findings": [{"assertion": "Synthetic test", "candidateQuote": u["text"],
         "verdict": "supported", "reason": "Synthetic test", "sourceEvidence": [{"unitId": source["units"][0]["id"]}]}]}
        for u in candidate_units(candidate)]}
    result = validate_candidate_audit(value, candidate, source)
    assert result["units"][0]["findings"][0]["sourceEvidence"][0]["quote"] == source["units"][0]["text"]
    value["units"][0]["findings"][0]["sourceEvidence"][0]["quote"] = "fake ... quote"
    with pytest.raises(ValueError, match="OUTLINE_AUDIT_WIRE_INVALID"):
        validate_candidate_audit(value, candidate, source)
    del value["units"][0]["findings"][0]["sourceEvidence"][0]["quote"]
    value["units"][0]["findings_note"] = None
    with pytest.raises(ValueError, match="OUTLINE_AUDIT_WIRE_INVALID"):
        validate_candidate_audit(value, candidate, source)


async def test_narrative_action_cannot_escape_fact_review_as_interpretation(runtime):
    from novelvideo.director.outline_candidate_review import validate_candidate_audit, audit_wire_schema
    from jsonschema import Draft202012Validator

    await start(runtime, [])
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    state = runtime[-1].projection(runtime[1])
    candidate = state["artifacts"]["M07"]["candidate"]
    source = source_for_root(root_for(runtime))
    value = {"contract": "outline-candidate-audit/1.1.0", "literaryNotes": [], "units": [
        {"path": u["path"], "findings": [{"assertion": "Synthetic claim", "candidateQuote": u["text"],
         "verdict": "interpretation", "reason": "It is a dramatization.", "sourceEvidence": []}]}
        for u in candidate_units(candidate)]}
    result = validate_candidate_audit(value, candidate, source)
    assert result["status"] == "blocked"
    assert result["uncertainPaths"]
    assert not Draft202012Validator(audit_wire_schema(source, candidate)).is_valid(value)


async def test_compact_audit_covers_every_unit_and_never_translates_prose(runtime):
    from novelvideo.director.outline_candidate_review import audit_aliases, audit_wire_schema, map_audit_ids, validate_candidate_audit
    from novelvideo.director.outline_compiler import compile_outline_request
    from jsonschema import Draft202012Validator

    await start(runtime, [])
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    state = runtime[-1].projection(runtime[1])
    candidate = state["artifacts"]["M07"]["candidate"]
    source = source_for_root(root_for(runtime))
    aliases = audit_aliases(source, candidate)
    canonical = {"contract": "outline-candidate-audit/1.2.0", "literaryNotes": [], "units": [
        {"path": u["path"], "findings": [{"assertion": "Synthetic fixture", "candidateQuote": u["text"],
         "verdict": "supported", "reason": "Synthetic evidence, not semantic proof.",
         "sourceEvidence": [{"unitId": source["units"][0]["id"]}]}]} for u in candidate_units(candidate)]}
    wire = map_audit_ids(canonical, aliases)
    schema = audit_wire_schema(source, candidate, compact=True)
    assert Draft202012Validator(schema).is_valid(wire)
    report = validate_candidate_audit(wire, candidate, source)
    assert [u["path"] for u in report["units"]] == [u["path"] for u in canonical["units"]]
    assert map_audit_ids({"path": "u1", "candidateQuote": "u1", "text": "s1"}, {"u1": "original", "s1": "source"}) == {"path": "original", "candidateQuote": "u1", "text": "s1"}
    wire["units"].pop()
    assert not Draft202012Validator(schema).is_valid(wire)
    with pytest.raises(ValueError, match="OUTLINE_AUDIT_WIRE_INVALID"):
        validate_candidate_audit(wire, candidate, source)
    compiled = compile_outline_request(root_for(runtime), "M12", state["artifacts"],
        {"option": None, "freeText": "Confirmed direction", "answers": {}}, 32768)
    inputs = json.loads(json.loads(compiled["prompt"].split("INPUT_DATA_JSON:\n", 1)[1])[0]["text"])
    assert inputs["requiredUnitCount"] == len(candidate_units(candidate))
    assert "sourceGraph" not in inputs and "deliveryContext" not in inputs
    assert inputs["source"]["text"] == source["text"]


async def test_explicit_schema_recovery_reuses_successful_source_stages(runtime):
    calls = []
    normal = provider(runtime, calls)

    async def faulty(prompt, model, ceiling):
        raw = await normal(prompt, model, ceiling)
        if calls[-1] == "M03":
            value = json.loads(raw)
            value["options"][2]["invented_field"] = "retained, never stripped"
            return json.dumps(value)
        return raw

    quote = send(runtime, {"type": "planning.quote", "targetScope": "outline"})
    grant(runtime, quote)
    await dispatch_planning(runtime[3], runtime[1], faulty)
    state = runtime[-1].projection(runtime[1])
    assert state["phase"] == "FAILED_RECOVERABLE"
    source_before = copy.deepcopy(state["artifacts"])
    quote = send(runtime, {"type": "planning.quote", "targetScope": "outline"})
    assert quote["plan"]["stages"] == ["M03"]
    assert quote["plan"]["limits"]["maxCalls"] == 1
    recovery = quote["plan"]["validationRecoveries"]["M03"]
    assert "invented_field" in recovery["output"]
    assert recovery["validation"]["issues"][0]["code"] == "extra_forbidden"
    assert calls == ["M04", "M05", "M03"]  # quote is not a model invocation
    grant(runtime, quote)

    async def repaired(prompt, model, ceiling):
        assert "HOST_VALIDATION_RECOVERY_JSON" in prompt
        assert recovery["operationId"] in prompt
        return await normal(prompt, model, ceiling)

    await dispatch_planning(runtime[3], runtime[1], repaired)
    state = runtime[-1].projection(runtime[1])
    assert state["phase"] == "WAIT_DIRECTION"
    assert calls == ["M04", "M05", "M03", "M03"]
    for key, value in source_before.items():
        assert state["artifacts"][key] == value
    assert "invented_field" in runtime[3].retained_result(runtime[1], recovery["operationId"])["output"]


async def test_wire_aliases_restore_storage_identity_without_losing_evidence(runtime):
    from novelvideo.director.outline_compiler import translate_ids, validate_pipeline_output, wire_ids

    await start(runtime, [])
    artifacts = runtime[-1].projection(runtime[1])["artifacts"]
    root = root_for(runtime)
    draft = draft_for(runtime)
    aliases = wire_ids(root, artifacts)
    encoded = translate_ids(draft, aliases)
    before = copy.deepcopy(artifacts)
    result = validate_pipeline_output("M07", encoded, root, artifacts)
    assert result["delivery"] == draft
    assert artifacts == before
    assert len(json.dumps(encoded)) < len(json.dumps(draft))
    assert len(set(aliases.values())) == len(aliases)

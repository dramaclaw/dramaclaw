"""Exercise the real planning ledger with deterministic provider responses."""

from __future__ import annotations

import asyncio
import copy
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from novelvideo.director import execution, writing
from novelvideo.director.execution import execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.planning import validate_planning
from novelvideo.director.schemas.execution import ExecutionFault
from novelvideo.director.schemas.planning import WorkflowCommand
from novelvideo.director.skills.runtime import load_package
from novelvideo.director.store import DirectorStore
from novelvideo.director.workflow import WorkflowService, dispatch_planning


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    def contract():
        return {"model_name": "test-model", "locked": True}

    monkeypatch.setattr(execution, "director_model_contract", contract)
    monkeypatch.setattr(writing, "director_model_contract", contract)
    store = DirectorStore(tmp_path)
    work = store.create_work(
        CreateWork(
            title="Synthetic",
            brief="Unlock a box, take glasses, read the letter.",
            preset=DirectorPreset(
                mode="original",
                episode_count=1,
                duration_seconds=30,
                structure="three_act",
            ),
        )
    )
    clock = [1000.0]
    repo = ExecutionRepository(store, clock=lambda: clock[0])
    return store, work["id"], clock, repo, WorkflowService(repo)


def command(runtime, payload):
    store, work_id, _, _, service = runtime
    return WorkflowCommand.from_wire(
        {
            "schemaVersion": 2,
            "commandId": identifier(),
            "clientRequestId": identifier(),
            "sessionId": "session-a",
            "workId": work_id,
            "expected": {
                "workRevision": store.get_work(work_id)["revision"],
                "workflowRevision": service.projection(work_id)["revision"],
                "capabilityVersion": execution_capability()["version"],
            },
            "payload": payload,
        }
    )


def send(runtime, payload):
    return runtime[-1].execute("writer", command(runtime, payload))["result"]


def quote(runtime):
    return send(runtime, {"type": "planning.quote", "maxOutputTokens": 1024})


def grant(runtime, value=None):
    value = value or quote(runtime)
    return send(
        runtime,
        {
            "type": "planning.grant",
            "quoteId": value["quoteId"],
            "planHash": value["planHash"],
            "unknownCostConsent": True,
        },
    )


def decide(runtime, decision, **kwargs):
    cp = runtime[-1].projection(runtime[1])["checkpoint"]
    if decision == "select" and "confirmedPreset" in cp["payload"]:
        kwargs.setdefault("episodeCount", cp["payload"]["confirmedPreset"]["episodeCount"])
        kwargs.setdefault("durationSeconds", cp["payload"]["confirmedPreset"]["durationSeconds"])
    return send(
        runtime,
        {
            "type": "planning.decide",
            "checkpointId": cp["id"],
            "resumeToken": cp["resumeToken"],
            "payloadHash": cp["payloadHash"],
            "decision": decision,
            **kwargs,
        },
    )


def sample(stage):
    package = load_package(stage)
    return copy.deepcopy(
        json.loads(package["files"][package["manifest"].fixtures])[0]["value"]
    )


def root_for(runtime):
    with runtime[0]._connect() as db:
        return json.loads(
            db.execute(
                "SELECT root_json FROM director_workflows WHERE work_id=?",
                (runtime[1],),
            ).fetchone()[0]
        )


def output_for(runtime, stage):
    value = sample(stage)
    root = root_for(runtime)
    if stage == "M08":
        for prop in value["props"]:
            prop["firstEpisodeId"] = root["episodes"][0]["id"]
            prop["keyEpisodeIds"] = [ep["id"] for ep in root["episodes"]]
        for location in value["locations"]:
            location["keyEpisodeIds"] = [ep["id"] for ep in root["episodes"]]
        for character in value["characters"]:
            character["firstEpisodeId"] = root["episodes"][0]["id"]
            character["keyEpisodeIds"] = [ep["id"] for ep in root["episodes"]]
    if stage == "M07":
        value["segments"][0]["episodeIds"] = [ep["id"] for ep in root["episodes"]]
        value["whyWatch"] = [
            {"episodeId": ep["id"], "reason": "See the action and its result."}
            for ep in root["episodes"]
        ]
        value["hooks"][0]["episodeId"] = root["episodes"][0]["id"]
        value["setups"][0].update(
            plantEpisodeId=root["episodes"][0]["id"],
            payoffEpisodeId=root["episodes"][-1]["id"],
        )
        value["structureId"] = root["preset"]["structure"]
        value["totalDurationSeconds"] = (
            len(root["episodes"]) * root["preset"]["duration_seconds"]
        )
    if stage == "M09":
        value["entries"] = [
            {
                **value["entries"][0],
                "episodeId": ep["id"],
                "orderKey": ep["orderKey"],
                "deliveryLabel": ep["deliveryLabel"],
                "targetDuration": root["preset"]["duration_seconds"],
            }
            for ep in root["episodes"]
        ]
    return value


def provider(runtime, calls, fail_stage=None, ceilings=None):
    async def call(prompt, model, ceiling):
        assert model == "test-model"
        params = json.loads(
            prompt.split("\nHOST_VERIFIED_METHOD_JSON:")[0].split("\n", 1)[1]
        )["parameters"]
        stage = params["stage"]
        assert ceiling == (ceilings[stage] if ceilings else 1024)
        calls.append(stage)
        if stage == fail_stage:
            raise TimeoutError("Private provider detail must not escape")
        return json.dumps(output_for(runtime, stage))

    return call


async def direction(runtime):
    grant(runtime)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    assert runtime[-1].projection(runtime[1])["phase"] == "WAIT_DIRECTION"


async def test_original_direction_uses_three_host_questions_and_preserves_model_suggestions(runtime):
    calls = []
    grant(runtime)
    async def suggested(prompt, model, ceiling):
        value = output_for(runtime, "M03")
        value["specQuestions"] = [{"id": "q-extra", "question": "Who holds the key?", "choices": []}]
        calls.append("M03")
        return json.dumps(value)
    await dispatch_planning(runtime[3], runtime[1], suggested)
    state = runtime[-1].projection(runtime[1])
    assert calls == ["M03"]
    assert state["checkpoint"]["payload"]["confirmedPreset"] == {"episodeCount": 1, "durationSeconds": 30}
    assert state["checkpoint"]["payload"]["specQuestions"] == []
    assert state["checkpoint"]["payload"]["suggestedQuestions"][0]["id"] == "q-extra"
    assert state["artifacts"]["M03"]["specQuestions"][0]["id"] == "q-extra"
    cp = state["checkpoint"]
    with pytest.raises(ExecutionFault, match="PLANNING_ANSWER_REQUIRED"):
        send(runtime, {"type": "planning.decide", "checkpointId": cp["id"], "resumeToken": cp["resumeToken"],
                       "payloadHash": cp["payloadHash"], "decision": "select", "optionId": "option-1"})
    assert runtime[0].get_work(runtime[1])["revision"] == state["workRevision"]


async def test_original_confirmed_custom_count_and_duration_are_the_next_stage_authority(runtime):
    await direction(runtime)
    before = runtime[0].get_work(runtime[1])["revision"]
    cp = runtime[-1].projection(runtime[1])["checkpoint"]
    payload = {"type": "planning.decide", "checkpointId": cp["id"], "resumeToken": cp["resumeToken"],
               "payloadHash": cp["payloadHash"], "decision": "select", "optionId": "option-1",
               "episodeCount": 3, "durationSeconds": 45}
    intent = command(runtime, payload)
    result = runtime[-1].execute("writer", intent)["result"]
    assert result["phase"] == "WAIT_COST" and result["workRevision"] == before + 1
    assert runtime[-1].execute("writer", intent)["result"] == result
    work = runtime[0].get_work(runtime[1])
    assert work["preset"]["episode_count"] == 3
    assert work["preset"]["duration_seconds"] == 45
    root = root_for(runtime)
    assert root["workRevision"] == before + 1
    assert len(root["episodes"]) == 3
    plan = quote(runtime)
    assert plan["plan"]["stages"] == ["M07", "M08", "M09"]
    from novelvideo.director.planning import compile_planning
    with runtime[0]._connect() as db:
        selected_direction = json.loads(db.execute("SELECT direction_json FROM director_workflows WHERE work_id=?",
                                         (runtime[1],)).fetchone()[0])
    compiled = compile_planning(root, "M07", {}, selected_direction, 4096)
    assert compiled["parameters"]["workflowRootHash"]
    assert '"duration_seconds": 45' in compiled["prompt"]
    assert '"episode_count": 3' in compiled["prompt"]


async def preparation(runtime):
    await direction(runtime)
    decide(
        runtime,
        "select",
        optionId="option-1",
        freeText="Keep the taking-glasses action.",
    )
    grant(runtime)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    assert runtime[-1].projection(runtime[1])["phase"] == "WAIT_OUTLINE"


def test_quote_does_not_call_or_grant_and_has_explicit_ceiling(runtime):
    result = quote(runtime)
    assert result["estimateMinor"] is None
    assert result["plan"]["stages"] == ["M03"]
    assert result["plan"]["limits"]["maxCalls"] == 1
    assert runtime[3].list_operations(runtime[1]) == []
    with pytest.raises(ExecutionFault, match="COST_CONSENT_REQUIRED"):
        send(
            runtime,
            {
                "type": "planning.grant",
                "quoteId": result["quoteId"],
                "planHash": result["planHash"],
                "unknownCostConsent": False,
            },
        )


def adaptation_runtime(runtime, source="A keeper taps twice and calls the lost traveler home."):
    store, _, clock, repo, service = runtime
    work = store.create_work(CreateWork(title="Source-bound", brief="Preserve the rescue, outline only.",
        source_text=source, preset=DirectorPreset(mode="adaptation", episode_count=1,
        duration_seconds=600, structure="three_act", adapt_direction="condense")))
    return store, work["id"], clock, repo, service


async def test_adaptation_freezes_source_asks_then_stops_at_outline(runtime):
    from novelvideo.director.planning import compile_planning

    runtime = adaptation_runtime(runtime)
    payload = {"type": "planning.quote", "maxOutputTokens": 1024, "targetScope": "outline"}
    plan = send(runtime, payload)
    root = root_for(runtime)
    assert root["sourceText"] == "A keeper taps twice and calls the lost traveler home."
    assert root["targetScope"] == "outline"
    compiled = compile_planning(root, "M03", {}, None, 1024)
    assert root["sourceText"] in compiled["prompt"]
    assert "Source-grounded outline adaptation" in compiled["prompt"]
    calls = []
    grant(runtime, plan)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert calls == ["M03"]
    assert runtime[-1].projection(runtime[1])["phase"] == "WAIT_DIRECTION"
    decide(runtime, "select", optionId="option-1")
    plan = send(runtime, payload)
    assert plan["plan"]["stages"] == ["M07"]
    assert plan["plan"]["limits"]["maxCalls"] == 1
    grant(runtime, plan)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    state = runtime[-1].projection(runtime[1])
    assert state["phase"] == "WAIT_OUTLINE"
    assert calls == ["M03", "M07"]
    assert list(state["checkpoint"]["payload"]["documents"]) == ["outline"]
    assert not runtime[0].list_documents(runtime[1])
    decide(runtime, "adopt")
    assert [d["doc_key"] for d in runtime[0].list_documents(runtime[1])] == ["outline"]
    assert runtime[0].get_work(runtime[1])["status"] != "completed"


def test_adaptation_does_not_silently_authorize_full_preparation(runtime):
    runtime = adaptation_runtime(runtime)
    with pytest.raises(ExecutionFault, match="PLANNING_ADAPTATION_OUTLINE_ONLY"):
        quote(runtime)
    assert not runtime[3].list_operations(runtime[1])


def test_adaptation_selection_does_not_promote_candidate_plot_claims(runtime):
    from novelvideo.director.planning import compile_planning
    runtime = adaptation_runtime(runtime)
    send(runtime, {"type": "planning.quote", "targetScope": "outline"})
    root = root_for(runtime)
    direction = {"option": {"id": "option-1", "difference": "Chronological eyewitness treatment.",
        "tone": "Restrained", "stakes": "Invented penalty: everyone loses all memory.",
        "obstacle": "An invented impassable door.", "logline": "An invented marriage."},
        "freeText": "No new penalty or family relationships.", "answers": {"q-1": "Preserve conflicting witness claims."}}
    prompt = compile_planning(root, "M07", {}, direction, 12288)["prompt"]
    assert "Invented penalty" not in prompt and "invented impassable" not in prompt
    assert "invented marriage" not in prompt
    for value in (root["sourceText"], direction["freeText"], direction["answers"]["q-1"], direction["option"]["difference"]):
        assert value in prompt


def test_direction_checkpoint_freezes_decoder_schema_for_seed(runtime):
    from novelvideo.director.planning import compile_planning
    from novelvideo.director.structured_output import decoder_schema

    runtime = adaptation_runtime(runtime)
    send(runtime, {"type": "planning.quote", "targetScope": "outline"})
    root = root_for(runtime)
    root["model"] = "ark::doubao-seed-evolving"
    parameters = compile_planning(root, "M03", {}, None, 8192)["parameters"]
    wire = parameters["response_format"]
    assert wire["type"] == "json_schema"
    assert wire["json_schema"]["name"] == "director_m03"
    assert wire["json_schema"]["strict"] is True
    assert wire["json_schema"]["schema"] == decoder_schema(parameters["responseSchema"])
    assert wire["json_schema"]["schema"]["$defs"]["Direction"]["additionalProperties"] is False

    root["model"] = "test-model"
    assert compile_planning(root, "M03", {}, None, 8192)["parameters"]["response_format"] == {"type": "json_object"}


def test_single_closed_episode_decoder_requires_null_final_hook(runtime):
    from copy import deepcopy
    from novelvideo.director.planning import compile_planning

    quote(runtime)
    root = root_for(runtime)
    root["model"] = "ark::doubao-seed-evolving"
    artifacts = {"M07": output_for(runtime, "M07"), "M08": output_for(runtime, "M08")}
    selected = {"option": output_for(runtime, "M03")["options"][0], "freeText": "", "answers": {}}
    compiled = compile_planning(root, "M09", artifacts, selected, 8192)
    schema = compiled["parameters"]["response_format"]["json_schema"]["schema"]
    assert compiled["parameters"]["response_format"]["type"] == "json_schema"
    assert schema["$defs"]["DirectoryEntry"]["properties"]["hook"]["type"] == "null"
    assert compiled["parameters"]["responseSchema"]["$defs"]["DirectoryEntry"]["properties"]["hook"]["type"] == "null"
    multiple = deepcopy(root)
    multiple["episodes"].append({**multiple["episodes"][0], "id": "episode-two", "orderKey": 2})
    multiple["preset"]["episode_count"] = 2
    multi_schema = compile_planning(multiple, "M09", artifacts, selected, 8192)["parameters"]["responseSchema"]
    assert "anyOf" in multi_schema["$defs"]["DirectoryEntry"]["properties"]["hook"]
    open_root = deepcopy(root)
    open_root["preset"]["ending_type"] = "open"
    open_schema = compile_planning(open_root, "M09", artifacts, selected, 8192)["parameters"]["responseSchema"]
    assert "anyOf" in open_schema["$defs"]["DirectoryEntry"]["properties"]["hook"]


def test_outline_scope_and_source_cannot_change_after_quote(runtime):
    from novelvideo.director.planning import compile_planning

    runtime = adaptation_runtime(runtime)
    send(runtime, {"type": "planning.quote", "maxOutputTokens": 1024, "targetScope": "outline"})
    with pytest.raises(ExecutionFault, match="PLANNING_INPUT_CHANGED"):
        quote(runtime)
    root = root_for(runtime)
    root["sourceText"] += " An unapproved replacement."
    with pytest.raises(ExecutionFault, match="SOURCE_REQUIRED"):
        compile_planning(root, "M03", {}, None, 1024)


async def test_complete_preparation_is_atomic_and_not_episode_completion(runtime):
    calls = []
    grant(runtime)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert calls == ["M03"]
    selected = decide(
        runtime,
        "select",
        optionId="option-2",
        freeText="Keep visible transfer of the glasses.",
    )
    assert selected["phase"] == "WAIT_COST" and len(calls) == 1
    plan = quote(runtime)
    assert plan["plan"]["stages"] == ["M07", "M08", "M09"]
    grant(runtime, plan)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert calls == ["M03", "M07", "M08", "M09"]
    state = runtime[-1].projection(runtime[1])
    assert state["phase"] == "WAIT_OUTLINE"
    preview = state["checkpoint"]["payload"]["documents"]["outline"]
    assert "## 概要设计" in preview and "## 创作禁区" in preview
    assert "storyPlan" not in preview
    assert not runtime[0].list_documents(runtime[1])
    assert not runtime[0].list_changes(runtime[1])
    assert state["budgets"][-1]["callsReserved"] == 3
    assert state["budgets"][-1]["outputTokensReserved"] == 3072
    assert all(
        item["cost"]["actualMinor"] is None
        for item in runtime[3].list_operations(runtime[1])
    )
    adopted = decide(runtime, "adopt")
    assert adopted["phase"] == "READY"
    assert {item["doc_key"] for item in runtime[0].list_documents(runtime[1])} == {
        "outline",
        "characters",
        "scenes",
        "props",
    }
    assert runtime[0].get_work(runtime[1])["status"] != "completed"
    assert runtime[0].get_document(runtime[1], "outline")["content"] == preview
    assert runtime[0].get_document(runtime[1], "episode-001")["version"] == 0
    assert runtime[-1].advance(runtime[1]) is None
    with runtime[0]._connect() as db:
        child = db.execute(
            "SELECT operation_id FROM director_planning_children WHERE stage='M07'"
        ).fetchone()[0]
        snapshot = runtime[3].snapshot(db, child)
        assert (
            "Keep visible transfer" in snapshot["prompt"]
            and "option-2" in snapshot["prompt"]
        )
        assert snapshot["parentPlanHash"] == plan["planHash"]


async def test_skip_and_return_never_approve_and_old_card_is_rejected(runtime):
    await direction(runtime)
    cp = runtime[-1].projection(runtime[1])["checkpoint"]
    old = {
        "type": "planning.decide",
        "checkpointId": cp["id"],
        "resumeToken": cp["resumeToken"],
        "payloadHash": cp["payloadHash"],
        "decision": "select",
        "optionId": "option-1",
    }
    assert decide(runtime, "skip")["phase"] == "WAIT_INPUT"
    with pytest.raises(ExecutionFault, match="PLANNING_CHECKPOINT_STALE"):
        send(runtime, old)
    assert decide(runtime, "return")["phase"] == "WAIT_DIRECTION"
    with pytest.raises(ExecutionFault, match="PLANNING_CHECKPOINT_STALE"):
        send(runtime, old)
    assert len(runtime[3].list_operations(runtime[1])) == 1


async def test_free_text_direction_survives_restart(runtime):
    await direction(runtime)
    decide(runtime, "select", freeText="A silent comedy with one location.")
    service = WorkflowService(
        ExecutionRepository(DirectorStore(runtime[0].path.parent.parent))
    )
    assert service.projection(runtime[1])["phase"] == "WAIT_COST"
    plan = quote(runtime)
    assert plan["plan"]["directionHash"]
    grant(runtime, plan)
    run = next(
        item
        for item in runtime[3].list_operations(runtime[1])
        if item["parameters"].get("stage") == "M07"
    )
    with runtime[0]._connect() as db:
        assert "silent comedy" in runtime[3].snapshot(db, run["id"])["prompt"]


async def test_unknown_retains_budget_and_never_retries(runtime):
    await direction(runtime)
    decide(runtime, "select", optionId="option-1")
    grant(runtime)
    calls = []
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls, "M08"))
    state = runtime[-1].projection(runtime[1])
    assert calls == ["M07", "M08"] and state["phase"] == "UNKNOWN"
    assert "M07" in state["artifacts"] and "M08" not in state["artifacts"]
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert calls == ["M07", "M08"]
    with pytest.raises(ExecutionFault, match="ACTIVE_OPERATION"):
        quote(runtime)
    assert (
        next(
            item
            for item in runtime[3].list_operations(runtime[1])
            if item["parameters"].get("stage") == "M08"
        )["cost"]["status"]
        == "unknown"
    )


async def test_duplicate_background_workers_and_duplicate_grant(runtime):
    q = quote(runtime)
    request = command(
        runtime,
        {
            "type": "planning.grant",
            "quoteId": q["quoteId"],
            "planHash": q["planHash"],
            "unknownCostConsent": True,
        },
    )
    with ThreadPoolExecutor(2) as pool:
        results = list(
            pool.map(lambda _: runtime[-1].execute("writer", request), range(2))
        )
    assert results[0] == results[1]
    calls = []
    await asyncio.gather(
        *(
            dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
            for _ in range(2)
        )
    )
    assert calls == ["M03"]
    assert len(runtime[3].list_operations(runtime[1])) == 1


async def test_atomic_adoption_rollback(runtime, monkeypatch):
    await preparation(runtime)
    store = runtime[0]
    original = store._put_document

    def fail(db, work_id, key, *args):
        if key == "scenes":
            raise RuntimeError("simulated disk failure")
        return original(db, work_id, key, *args)

    monkeypatch.setattr(store, "_put_document", fail)
    with pytest.raises(RuntimeError):
        decide(runtime, "adopt")
    assert not store.list_documents(runtime[1])
    assert runtime[-1].projection(runtime[1])["checkpoint"]["status"] == "open"
    monkeypatch.setattr(store, "_put_document", original)
    assert decide(runtime, "adopt")["phase"] == "READY"


async def test_stale_manual_document_prevents_adoption(runtime):
    await preparation(runtime)
    runtime[0].put_document(runtime[1], "characters", "My new character", 0)
    with pytest.raises(ExecutionFault, match="PLANNING_INPUT_CHANGED"):
        decide(runtime, "adopt")
    assert runtime[0].get_document(runtime[1], "outline")["version"] == 0


def test_cancel_before_send_is_local_zero_and_requires_new_approval(runtime):
    grant(runtime)
    result = send(runtime, {"type": "planning.cancel"})
    assert result["phase"] == "CANCELLED"
    op = runtime[3].list_operations(runtime[1])[0]
    assert op["cost"]["actualMinor"] == 0 and op["status"] == "cancelled"
    assert result["budgets"][0]["status"] == "cancelled"
    assert quote(runtime)["plan"]["stages"] == ["M03"]


async def test_schema_failure_stops_and_preserves_paid_text(runtime):
    grant(runtime)

    async def invalid(*_):
        return '{"approved":true}'

    await dispatch_planning(runtime[3], runtime[1], invalid)
    assert runtime[-1].projection(runtime[1])["phase"] == "FAILED_RECOVERABLE"
    op = runtime[3].list_operations(runtime[1])[0]
    assert op["errorCode"] == "PLANNING_OUTPUT_INVALID"
    assert op["response"]["validation"]["kind"] == "schema"
    assert op["response"]["validation"]["issueCount"] > 0
    assert (
        runtime[3].retained_result(runtime[1], op["id"])["output"]
        == '{"approved":true}'
    )
    assert op["cost"]["actualMinor"] is None


@pytest.mark.parametrize(
    "stage,mutate",
    [
        ("M03", lambda v: v["options"].pop()),
        ("M03", lambda v: v["options"][1].update(logline=v["options"][0]["logline"])),
        ("M07", lambda v: v.update(structureId="nonlinear")),
        ("M07", lambda v: v.update(totalDurationSeconds=31)),
        ("M07", lambda v: v["segments"][0].update(episodeIds=["fake-episode"])),
        ("M08", lambda v: v["props"][0].update(id="char-1")),
        (
            "M08",
            lambda v: v["relations"].append(
                {"fromId": "missing", "toId": "char-1", "description": "friend"}
            ),
        ),
        ("M09", lambda v: v["entries"][0].update(targetDuration=31)),
        ("M09", lambda v: v["entries"][0].update(hook="Next time")),
        ("M09", lambda v: v["entries"][0].update(characterIds=["missing"])),
        ("M09", lambda v: v["entries"].append(v["entries"][0])),
    ],
)
def test_planning_contract_negatives(runtime, stage, mutate):
    quote(runtime)
    value = output_for(runtime, stage)
    mutate(value)
    with pytest.raises((ValueError, ValidationError)):
        validate_planning(
            stage, json.dumps(value), root_for(runtime), {"M08": sample("M08")}
        )


def test_approval_expiry_and_actor_binding(runtime):
    q = quote(runtime)
    request = command(
        runtime,
        {
            "type": "planning.grant",
            "quoteId": q["quoteId"],
            "planHash": q["planHash"],
            "unknownCostConsent": True,
        },
    )
    with pytest.raises(ExecutionFault, match="FORBIDDEN"):
        runtime[-1].execute("other", request)
    runtime[2][0] += 601
    with pytest.raises(ExecutionFault, match="APPROVAL_EXPIRED"):
        runtime[-1].execute("writer", request)
    assert not runtime[3].list_operations(runtime[1])


async def test_failed_stage_new_quote_does_not_rebuy_successful_prerequisite(runtime):
    await direction(runtime)
    decide(runtime, "select", optionId="option-1")
    grant(runtime)
    calls = []
    correct = provider(runtime, calls)

    async def broken(prompt, *args):
        if '"stage": "M08"' in prompt:
            return "invalid-json"
        return await correct(prompt, *args)

    await dispatch_planning(runtime[3], runtime[1], broken)
    q = quote(runtime)
    assert q["plan"]["stages"] == ["M08", "M09"]
    grant(runtime, q)
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, calls))
    assert calls == ["M07", "M08", "M09"]
    assert runtime[-1].projection(runtime[1])["phase"] == "WAIT_OUTLINE"


async def test_automatic_stage_budgets_match_each_child_and_total_reservations(runtime):
    await direction(runtime)
    decide(runtime, "select", optionId="option-1")
    q = send(runtime, {"type": "planning.quote"})
    plan = q["plan"]
    assert plan["limits"]["maxTotalOutputTokens"] == 12288 + 8192 + 8192
    grant(runtime, q)
    calls = []
    respond = provider(runtime, calls, ceilings={"M07": 12288, "M08": 8192, "M09": 8192})
    ceilings = []

    async def model(prompt, name, ceiling):
        ceilings.append(ceiling)
        return await respond(prompt, name, ceiling)

    await dispatch_planning(runtime[3], runtime[1], model)
    assert ceilings == [12288, 8192, 8192]
    for run in runtime[3].list_operations(runtime[1]):
        if run["parameters"]["stage"] != "M03":
            assert run["parameters"]["outputBudget"]["maxOutputTokens"] == run["limits"]["maxOutputTokens"]
    assert runtime[-1].projection(runtime[1])["phase"] == "WAIT_OUTLINE"


async def test_stop_after_last_response_opens_question_without_rebuy(runtime):
    from novelvideo.director.dispatch import dispatch_writing

    grant(runtime)
    operation_id = runtime[-1].advance(runtime[1])
    calls = []
    await dispatch_writing(
        runtime[3], runtime[1], operation_id, provider(runtime, calls)
    )
    send(runtime, {"type": "planning.cancel"})
    assert runtime[-1].projection(runtime[1])["phase"] == "WAIT_DIRECTION"
    assert calls == ["M03"]
    assert not runtime[0].get_document(runtime[1], "outline")["version"]


async def test_live_planning_harness_retains_four_receipts_without_adopting(
    runtime, monkeypatch, tmp_path
):
    from novelvideo.director.dispatch import dispatch_writing
    from tests.director import live_execution

    async def synthetic(repository, work_id, operation_id):
        async def model(prompt, _name, ceiling):
            assert ceiling == 4096
            params = json.loads(
                prompt.split("\nHOST_VERIFIED_METHOD_JSON:")[0].split("\n", 1)[1]
            )["parameters"]
            return json.dumps(output_for((repository.store, work_id), params["stage"]))

        return await dispatch_writing(repository, work_id, operation_id, model)

    monkeypatch.setattr(live_execution, "dispatch_writing", synthetic)
    root = tmp_path / "live-harness"
    await live_execution.validate_preparation(root)
    result = json.loads((root / "summary.json").read_text())
    assert [item["stage"] for item in result["results"]] == ["M03", "M07", "M08", "M09"]
    assert result["planning"]["phase"] == "WAIT_OUTLINE"
    assert not result["formalAdoptionPerformed"]
    assert all(
        (root / f"{stage}.json").exists() for stage in ("M03", "M07", "M08", "M09")
    )

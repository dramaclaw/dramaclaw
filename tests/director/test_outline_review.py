"""No network: provenance is mandatory but never treated as semantic proof."""

import copy
import json

import httpx
import pytest
from fastapi import FastAPI

from novelvideo.api.routes import director
from novelvideo.director import execution, writing
from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.outline_review import (
    _obligations,
    compile_outline_review,
    freeze_outline_inputs,
    outline_quality_report,
    story_passages,
    validate_outline_review,
)
from novelvideo.director.schemas.execution import ExecutionCommand, ExecutionFault
from novelvideo.director.schemas.outline_review import LITERARY_CHECKS
from novelvideo.director.store import DirectorStore

STORY = """# A modest consequence
## 概要设计
- **核心看点**：She pays an actual cost.
### 来源与约束
- **用户要求**：She must lose the next project.
## 故事简述
Ada refuses to erase Bea's contribution. Her manager removes Ada from the next project.
## 背景设定
- **关键规则或现实条件**：Only Ada and Bea may sign.
## 全剧分段
### Resolution
- **可拍行动**：Bea signs the final page herself and sends the file.
- **已发生结果**：Ada loses the project. Bea's signature remains visible.
## 为什么能追
- Everyone has agency and the story is excellent.
## 创作禁区
- Never remove Bea's agency.
## 创作策略补充
- **制作风险（时长未实测）**：No timing proof.
- **结局设计**：The signed file is delivered.
"""


def command(store, work_id, payload):
    intent = identifier()
    return ExecutionCommand.from_wire(
        {
            "schemaVersion": 2,
            "commandId": intent,
            "clientRequestId": intent,
            "sessionId": "outline-review-test",
            "workId": work_id,
            "expected": {
                "workRevision": store.get_work(work_id)["revision"],
                "documentVersions": {
                    "outline": store.get_document(work_id, "outline")["version"]
                },
                "capabilityVersion": execution_capability()["version"],
            },
            "payload": payload,
        }
    )


def response(frozen):
    plot_id = next(
        key for key, row in frozen["passages"].items() if row["role"] == "plot"
    )
    return {
        "schemaVersion": 2,
        "subjectHash": frozen["contentHash"],
        "checks": [
            {
                "id": key,
                "status": "FULFILLED",
                "explanation": "The story depicts an observable outcome.",
                "evidence": [
                    {"inputId": plot_id, "quote": frozen["passages"][plot_id]["text"]}
                ],
                "suggestion": "",
            }
            for key in [u["id"] for u in frozen["obligations"]] + list(LITERARY_CHECKS)
        ],
    }


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    def contract():
        return {"model_name": "test-model", "locked": True}

    monkeypatch.setattr(execution, "director_model_contract", contract)
    monkeypatch.setattr(writing, "director_model_contract", contract)
    store = DirectorStore(tmp_path)
    work = store.create_work(
        CreateWork(
            title="Synthetic outline",
            brief="Ada must lose the next project.",
            preset=DirectorPreset(mode="original", episode_count=1),
        )
    )
    store.put_document(work["id"], "outline", STORY, 0)
    with store._connect() as db:
        frozen = freeze_outline_inputs(store, db, work["id"])
    return store, work["id"], frozen


def test_units_have_exact_original_coordinates_and_deduplicate_locked_brief():
    sources = {"brief": " 甲开锁。\n乙接过钥匙！", "locked": "甲开锁。"}
    units = _obligations(sources)
    assert len(units) == 2 and len(units[0]["sourceRefs"]) == 2
    for unit in units:
        for ref in unit["sourceRefs"]:
            assert sources[ref["inputId"]][ref["start"] : ref["end"]] == unit["text"]


def test_story_excludes_copied_requirements_bans_and_self_praise():
    passages = story_passages(STORY)
    assert all(STORY[p["start"] : p["end"]] == p["text"] for p in passages.values())
    text = json.dumps(passages)
    for excluded in ["She must lose", "Never remove", "excellent", "No timing proof"]:
        assert excluded not in text
    assert any(p["role"] == "claim" for p in passages.values())
    assert any(p["role"] == "plot" for p in passages.values())


def test_positive_review_is_not_pass_or_finalization(runtime):
    _, _, frozen = runtime
    result = validate_outline_review(json.dumps(response(frozen)), frozen)
    assert result["status"] == "REVIEWED"
    assert result["requiresHumanReview"] and not result["productionReady"]
    assert not result["coverage"]["semanticCompletenessVerified"]


@pytest.mark.parametrize(
    "mutation", ["missing", "duplicate", "badquote", "badid", "claim", "malformed"]
)
def test_bad_sibling_cannot_erase_grounded_failure(runtime, mutation):
    _, _, frozen = runtime
    value = response(frozen)
    value["checks"][-1].update(status="VIOLATED", suggestion="Repair the mismatch.")
    if mutation == "missing":
        del value["checks"][0]
    elif mutation == "duplicate":
        value["checks"].append(copy.deepcopy(value["checks"][0]))
    elif mutation == "badquote":
        value["checks"][0]["evidence"][0]["quote"] = "Imaginary sentence."
    elif mutation == "badid":
        value["checks"][0]["evidence"][0]["inputId"] = "brief"
    elif mutation == "malformed":
        value["checks"][0] = {"id": "obligation-001", "bad": True}
    else:
        key = next(key for key, p in frozen["passages"].items() if p["role"] == "claim")
        value["checks"][0]["evidence"] = [
            {"inputId": key, "quote": frozen["passages"][key]["text"]}
        ]
    result = validate_outline_review(json.dumps(value), frozen)
    assert result["status"] == "FAIL"
    assert result["unavailableCheckIds"]
    assert any(
        c["id"] == "consistency" and c["status"] == "VIOLATED" for c in result["checks"]
    )


def test_missing_or_unknown_coverage_never_passes(runtime):
    _, _, frozen = runtime
    value = response(frozen)
    value["checks"][0]["status"] = "UNKNOWN"
    assert validate_outline_review(json.dumps(value), frozen)["status"] == "UNKNOWN"
    value["checks"].pop(0)
    assert validate_outline_review(json.dumps(value), frozen)["status"] == "UNAVAILABLE"
    value["subjectHash"] = "0" * 64
    assert not validate_outline_review(json.dumps(value), frozen)["checks"]


def test_duplicate_keys_and_truncation_not_silently_repaired(runtime):
    _, _, frozen = runtime
    text = json.dumps(response(frozen))
    assert (
        validate_outline_review(text[:-1] + ',"checks":[]}', frozen)["status"]
        == "UNAVAILABLE"
    )
    assert (
        validate_outline_review(text, frozen, truncated=True)["status"] == "UNAVAILABLE"
    )
    assert (
        validate_outline_review(text[:-15], frozen, truncated=True)["status"]
        == "UNAVAILABLE"
    )


def test_compile_keeps_short_drama_and_frozen_settings_without_review_answers(runtime):
    store, work_id, frozen = runtime
    result = compile_outline_review(store, work_id)
    prompt = json.loads(result["prompt"])
    assert prompt["subjectHash"] == frozen["contentHash"]
    assert prompt["shortDramaMethod"]["binding"]["selectedReferences"]
    assert prompt["shortDramaMethod"]["binding"]["usage"] == "reference_only"
    assert "six host check IDs" not in result["prompt"]
    assert all(ref["text"] for ref in prompt["shortDramaMethod"]["references"])
    assert prompt["parameters"]["duration_seconds"] == 120
    assert prompt["obligations"] == frozen["obligations"]
    assert "Everyone has agency" not in result["prompt"]
    assert result["parameters"]["review_kind"] == "outline"


async def test_approved_dispatch_preserves_report_usage_not_draft_and_invalidates(
    runtime, monkeypatch
):
    store, work_id, frozen = runtime
    repo = ExecutionRepository(store)
    service = ExecutionService(repo)
    calls = []

    async def model(prompt, name, limit):
        calls.append((prompt, name, limit))
        return writing.WritingResult(
            json.dumps(response(frozen)), 123, 456, 1, "stop", name
        )

    monkeypatch.setattr(
        "novelvideo.director.dispatch.run_bounded_outline_review_model", model
    )
    quote = service.execute(
        "actor",
        command(
            store,
            work_id,
            {
                "type": "cost.quote",
                "kind": "outline",
                "purpose": "review",
                "maxOutputTokens": 8192,
            },
        ),
    )["result"]
    assert not calls
    grant = command(
        store,
        work_id,
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        },
    )
    run = service.execute("actor", grant)["result"]
    assert service.execute("actor", grant)["result"]["id"] == run["id"]
    result = await dispatch_writing(repo, work_id, run["id"])
    await dispatch_writing(repo, work_id, run["id"])
    assert len(calls) == 1 and result["changeId"] is None
    assert not store.list_changes(work_id)
    assert result["response"]["usage"]["outputTokens"] == 456
    assert outline_quality_report(store, work_id)["review"]["status"] == "REVIEWED"
    store.put_document(work_id, "outline", STORY + "\nA new action.\n", 1)
    assert outline_quality_report(store, work_id)["review"] is None
    assert repo.retained_result(work_id, run["id"])["output"]


def test_stale_approval_sends_nothing(runtime):
    store, work_id, _ = runtime
    service = ExecutionService(ExecutionRepository(store))
    quote = service.execute(
        "actor",
        command(
            store,
            work_id,
            {
                "type": "cost.quote",
                "kind": "outline",
                "purpose": "review",
                "maxOutputTokens": 8192,
            },
        ),
    )["result"]
    store.put_document(work_id, "outline", STORY + "\nChanged.\n", 1)
    with pytest.raises(ExecutionFault):
        service.execute(
            "actor",
            command(
                store,
                work_id,
                {
                    "type": "approval.grant",
                    "quoteId": quote["quoteId"],
                    "requestHash": quote["requestHash"],
                    "unknownCostConsent": True,
                },
            ),
        )


async def test_outline_report_api_uses_project_viewer_permission(runtime, monkeypatch):
    store, work_id, _ = runtime
    seen = []

    async def scoped(project, user, permission):
        seen.append((project, permission))
        return store

    monkeypatch.setattr(director, "_store", scoped)
    app = FastAPI()
    app.include_router(director.router)
    app.dependency_overrides[director.get_api_user] = lambda: {"id": "actor"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get(
            f"/projects/demo/director/v2/works/{work_id}/outline-quality"
        )
    assert response.status_code == 200
    assert seen == [("demo", "viewer")]


async def test_outline_review_system_and_json_limits_reach_wire_once(monkeypatch):
    from openai import AsyncOpenAI
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider
    from novelvideo.director.outline_review import OUTLINE_REVIEW_SYSTEM

    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "synthetic",
                "object": "chat.completion",
                "created": 1,
                "model": "test-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": '{"invalid":true}'},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        client = AsyncOpenAI(
            api_key="synthetic-test-only",
            base_url="https://test.invalid/v1",
            http_client=http,
            max_retries=0,
        )
        model = OpenAIChatModel(
            "test-model", provider=OpenAIProvider(openai_client=client)
        )
        monkeypatch.setattr(
            writing, "get_newapi_text_pydantic_model", lambda *_a, **_k: model
        )
        result = await writing.run_bounded_outline_review_model(
            "Synthetic data", "test-model", 512
        )
    assert len(requests) == 1
    assert requests[0]["messages"][0] == {
        "role": "system",
        "content": OUTLINE_REVIEW_SYSTEM,
    }
    assert requests[0]["response_format"] == {"type": "json_object"}
    assert requests[0]["max_tokens"] == requests[0]["max_completion_tokens"] == 512
    assert result.text == '{"invalid":true}' and result.requests == 1

"""No provider calls: exercise the production transaction/dispatch/API paths with faults."""

from __future__ import annotations

import asyncio
import copy
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest
from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import ValidationError

from novelvideo.api.routes import director
from novelvideo.director import execution, writing
from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.schemas.execution import ExecutionCommand, ExecutionFault
from novelvideo.director.store import DirectorInvalidState, DirectorStore
from novelvideo.director.skills.runtime import load_package


@pytest.fixture
def runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def contract():
        return {"model_name": "test-model", "locked": True}

    monkeypatch.setattr(execution, "director_model_contract", contract)
    monkeypatch.setattr(writing, "director_model_contract", contract)
    store = DirectorStore(tmp_path / "synthetic-project")
    work = store.create_work(
        CreateWork(
            title="Synthetic work",
            brief="One scene; a found key opens a door.",
            preset=DirectorPreset(
                mode="original", episode_count=1, duration_seconds=30
            ),
        )
    )
    clock = [1000.0]
    repo = ExecutionRepository(store, clock=lambda: clock[0])
    return store, work, clock, repo, ExecutionService(repo)


def command(
    work: dict,
    payload: dict,
    *,
    revision: int = 1,
    version: int = 0,
    intent: str | None = None,
) -> ExecutionCommand:
    key = intent or identifier()
    return ExecutionCommand.from_wire(
        {
            "schemaVersion": 2,
            "commandId": key,
            "clientRequestId": key,
            "sessionId": "session-one",
            "workId": work["id"],
            "expected": {
                "workRevision": revision,
                "documentVersions": {"outline": version},
                "capabilityVersion": execution_capability()["version"],
            },
            "payload": payload,
        }
    )


def quote(runtime, **kwargs):
    _, work, _, _, service = runtime
    request = command(
        work,
        {
            "type": "cost.quote",
            "kind": "outline",
            "instruction": "Keep the key.",
            "maxOutputTokens": 1024,
        },
        **kwargs,
    )
    return request, service.execute("writer", request)["result"]


def test_default_budget_fits_real_outlines_without_overriding_explicit_limits(runtime):
    assert execution_capability()["outputTokens"]["default"] == 12288
    _, quoted = quote(runtime)
    assert quoted["limits"]["maxOutputTokens"] == 1024


def outline_output(runtime):
    package = load_package("M07")
    value = json.loads(package["files"][package["manifest"].fixtures])[0]["value"]
    with runtime[0]._connect() as db:
        episode_id = db.execute(
            "SELECT id FROM director_episodes WHERE work_id=?", (runtime[1]["id"],)
        ).fetchone()[0]
    return json.dumps(value).replace('"ep-1"', json.dumps(episode_id))


def grant(runtime, quoted: dict | None = None):
    _, work, _, _, service = runtime
    if quoted is None:
        _, quoted = quote(runtime)
    request = command(
        work,
        {
            "type": "approval.grant",
            "quoteId": quoted["quoteId"],
            "requestHash": quoted["requestHash"],
            "unknownCostConsent": True,
        },
    )
    return request, service.execute("writer", request)["result"]


def test_quote_is_persisted_and_no_operation_until_explicit_consent(runtime):
    store, work, _, repo, service = runtime
    request, quoted = quote(runtime)
    assert quoted["limits"] == {
        "maxAttempts": 1,
        "maxOutputTokens": 1024,
        "inputChars": quoted["limits"]["inputChars"],
        "timeoutSeconds": 300,
    }
    assert quoted["estimateMinor"] is None
    assert "prompt" not in quoted
    assert not repo.list_operations(work["id"])
    assert not store.list_runs(work["id"])
    assert service.execute("writer", request)["result"] == quoted
    bad = command(
        work,
        {
            "type": "approval.grant",
            "quoteId": quoted["quoteId"],
            "requestHash": quoted["requestHash"],
            "unknownCostConsent": False,
        },
    )
    with pytest.raises(ExecutionFault, match="COST_CONSENT_REQUIRED"):
        service.execute("writer", bad)
    assert not repo.list_operations(work["id"])


@pytest.mark.parametrize(
    "field,value",
    [
        ("maxOutputTokens", 0),
        ("maxOutputTokens", True),
        ("maxOutputTokens", "1024"),
        ("maxOutputTokens", 32769),
        ("kind", "video"),
        ("episodeOrdinal", 1),
        ("actor", "admin"),
    ],
)
def test_schema_rejects_invalid_and_smuggled_execution_fields(runtime, field, value):
    _, work, _, _, _ = runtime
    with pytest.raises(ValidationError):
        command(
            work,
            {
                "type": "cost.quote",
                "kind": "outline",
                "maxOutputTokens": 1024,
                field: value,
            },
        )


def test_wire_aliases_cannot_bypass_canonical_openapi(runtime):
    request, _ = quote(runtime)
    value = request.model_dump(by_alias=True)
    value["payload"]["max_output_tokens"] = value["payload"].pop("maxOutputTokens")
    with pytest.raises(ValidationError):
        ExecutionCommand.model_validate(value)


def test_changed_payload_same_intent_is_conflict_but_new_quote_is_new_intent(runtime):
    _, _, _, _, service = runtime
    request, first = quote(runtime)
    value = request.model_dump(by_alias=True)
    value["payload"]["instruction"] = "Different request"
    with pytest.raises(ExecutionFault, match="IDEMPOTENCY_CONFLICT"):
        service.execute("writer", ExecutionCommand.from_wire(value))
    _, second = quote(runtime)
    assert first["requestHash"] == second["requestHash"]
    assert first["quoteId"] != second["quoteId"]


@pytest.mark.parametrize(
    "change,expected",
    [
        ("expired", "APPROVAL_EXPIRED"),
        ("hash", "REQUEST_HASH_MISMATCH"),
        ("actor", "RESOURCE_GONE"),
        ("session", "RESOURCE_GONE"),
        ("work", "RESOURCE_GONE"),
        ("version", "VERSION_CONFLICT"),
        ("capability", "CAPABILITY_CHANGED"),
    ],
)
def test_grant_is_bound_to_scope_input_version_and_expiry(runtime, change, expected):
    store, work, clock, repo, service = runtime
    _, q = quote(runtime)
    payload = {
        "type": "approval.grant",
        "quoteId": q["quoteId"],
        "requestHash": q["requestHash"],
        "unknownCostConsent": True,
    }
    value = command(work, payload).model_dump(by_alias=True)
    actor = "writer"
    if change == "expired":
        clock[0] += 601
    if change == "hash":
        value["payload"]["requestHash"] = "0" * 64
    if change == "actor":
        actor = "someone-else"
    if change == "session":
        value["sessionId"] = "wrong-session"
    if change == "work":
        second = store.create_work(
            CreateWork(
                title="Other", brief="Other", preset=DirectorPreset(mode="original")
            )
        )
        value["workId"] = second["id"]
    if change == "version":
        store.put_document(work["id"], "outline", "Manual change", 0)
    if change == "capability":
        value["expected"]["capabilityVersion"] = "f" * 64
    with pytest.raises(ExecutionFault, match=expected):
        service.execute(actor, ExecutionCommand.from_wire(value))
    assert not repo.list_operations(work["id"])


def test_atomic_approval_reservation_operation_outbox_and_events(runtime, monkeypatch):
    store, work, _, repo, _ = runtime
    _, q = quote(runtime)
    original = repo.event

    def fail(*args, **kwargs):
        if args[3] == "run.queued":
            raise RuntimeError("injected commit fault")
        return original(*args, **kwargs)

    monkeypatch.setattr(repo, "event", fail)
    with pytest.raises(RuntimeError, match="injected"):
        grant(runtime, q)
    assert not store.list_runs(work["id"])
    with store._connect() as db:
        for table in (
            "director_approvals",
            "director_operations",
            "director_cost_entries",
            "director_outbox",
        ):
            assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
        assert (
            db.execute(
                "SELECT status FROM director_quotes WHERE id=?", (q["quoteId"],)
            ).fetchone()[0]
            == "pending"
        )
    monkeypatch.setattr(repo, "event", original)
    _, run = grant(runtime, q)
    assert run["status"] == "queued"


def test_parallel_double_click_and_distinct_approval_have_one_active_operation(runtime):
    _, work, _, repo, service = runtime
    _, q = quote(runtime)
    _, q2 = quote(runtime)
    value = command(
        work,
        {
            "type": "approval.grant",
            "quoteId": q["quoteId"],
            "requestHash": q["requestHash"],
            "unknownCostConsent": True,
        },
    )
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: service.execute("writer", value), range(8)))
    assert len({r["result"]["id"] for r in results}) == 1
    assert len(repo.list_operations(work["id"])) == 1
    with pytest.raises(ExecutionFault, match="ACTIVE_OPERATION"):
        grant(runtime, q2)


async def test_dispatch_claims_once_and_commits_proposal_receipt_atomically(runtime):
    store, work, _, repo, service = runtime
    approval, run = grant(runtime)
    calls = []

    async def model(prompt, name, tokens):
        calls.append((prompt, name, tokens))
        await asyncio.sleep(0)
        return outline_output(runtime)

    await asyncio.gather(
        *[dispatch_writing(repo, work["id"], run["id"], model) for _ in range(8)]
    )
    assert len(calls) == 1
    assert calls[0][1:] == ("test-model", 1024)
    result = repo.list_operations(work["id"])[0]
    assert result["status"] == "succeeded"
    assert result["cost"]["actualMinor"] is None
    assert result["cost"]["status"] == "settlement_pending"
    assert store.get_document(work["id"], "outline")["version"] == 0
    assert store.list_changes(work["id"])[0]["id"] == result["changeId"]
    assert store.list_runs(work["id"])[0]["response"] == result["response"]
    assert service.execute("writer", approval)["result"]["id"] == run["id"]
    reopened = ExecutionRepository(DirectorStore(store.path.parent.parent))
    assert reopened.list_operations(work["id"])[0]["response"] == result["response"]
    events = repo.events(work["id"])
    assert [e["seq"] for e in events["events"]] == list(range(1, events["nextSeq"] + 1))
    assert repo.events(work["id"], events["nextSeq"])["events"] == []


async def test_unknown_response_stays_reserved_and_cannot_redispatch(runtime):
    store, work, _, repo, service = runtime
    _, run = grant(runtime)
    calls = []

    async def broken(*_):
        calls.append(1)
        raise httpx.ReadTimeout("synthetic secret in provider exception")

    await dispatch_writing(repo, work["id"], run["id"], broken)
    await dispatch_writing(repo, work["id"], run["id"], broken)
    result = repo.list_operations(work["id"])[0]
    assert result["status"] == "unknown"
    assert result["cost"]["status"] == "unknown"
    assert result["cost"]["actualMinor"] is None
    assert len(calls) == 1
    assert "synthetic secret" not in json.dumps(result)
    with pytest.raises(ExecutionFault, match="STATUS_UNKNOWN"):
        service.execute(
            "writer", command(work, {"type": "run.resume", "runId": run["id"]})
        )
    with pytest.raises(ExecutionFault, match="ACTIVE_OPERATION"):
        quote(runtime)
    assert not store.list_changes(work["id"])


async def test_queued_cancel_has_zero_external_calls(runtime):
    _, work, _, repo, service = runtime
    _, run = grant(runtime)
    service.execute("writer", command(work, {"type": "run.cancel", "runId": run["id"]}))

    async def should_not_call(*_):
        pytest.fail("cancelled before send")

    assert await dispatch_writing(repo, work["id"], run["id"], should_not_call) is None
    result = repo.list_operations(work["id"])[0]
    assert result["status"] == "cancelled"
    assert result["cost"]["actualMinor"] == 0


async def test_cancel_in_flight_keeps_output_but_never_adopts_or_claims_refund(runtime):
    store, work, _, repo, service = runtime
    _, run = grant(runtime)
    entered, release = asyncio.Event(), asyncio.Event()

    async def delayed(*_):
        entered.set()
        await release.wait()
        return "Late output"

    task = asyncio.create_task(dispatch_writing(repo, work["id"], run["id"], delayed))
    await entered.wait()
    service.execute("writer", command(work, {"type": "run.cancel", "runId": run["id"]}))
    release.set()
    await task
    result = repo.list_operations(work["id"])[0]
    assert result["status"] == "cancelled"
    assert result["cost"]["actualMinor"] is None
    assert result["response"]["output_chars"] == len("Late output")
    assert not store.list_changes(work["id"])


def test_restart_after_claim_never_reclaims_and_reconciliation_is_explicit(runtime):
    _, work, clock, repo, service = runtime
    _, run = grant(runtime)
    repo.claim(work["id"], run["id"])
    clock[0] += 601
    assert repo.claim(work["id"], run["id"]) is None
    assert repo.list_operations(work["id"])[0]["requiresReconciliation"]
    result = service.execute(
        "writer", command(work, {"type": "run.resume", "runId": run["id"]})
    )["result"]
    assert result["status"] == "unknown"
    assert not result["canResume"]


def test_unknown_late_result_is_retained_not_mislabelled_user_cancelled(runtime):
    store, work, clock, repo, service = runtime
    _, run = grant(runtime)
    token, _ = repo.claim(work["id"], run["id"])
    clock[0] += 601
    service.execute("writer", command(work, {"type": "run.resume", "runId": run["id"]}))
    result = repo.complete(work["id"], run["id"], token, output="Late response")
    assert result["status"] == "stale"
    assert result["cost"]["actualMinor"] is None
    assert not store.list_changes(work["id"])


async def test_provider_configuration_failure_before_send_is_known_unsent(
    runtime, monkeypatch
):
    _, work, _, repo, _ = runtime
    _, run = grant(runtime)

    def unavailable():
        raise RuntimeError("synthetic private configuration")

    monkeypatch.setattr(execution, "director_model_contract", unavailable)
    result = await dispatch_writing(repo, work["id"], run["id"])
    assert result["status"] == "failed"
    assert result["cost"]["actualMinor"] == 0
    assert "private" not in json.dumps(result)


def test_system_prompt_revision_invalidates_existing_quote(runtime, monkeypatch):
    _, quoted = quote(runtime)
    monkeypatch.setattr(execution, "SYSTEM_PROMPT", "New method instruction")
    with pytest.raises(ExecutionFault, match="CAPABILITY_CHANGED"):
        grant(runtime, quoted)


@pytest.mark.parametrize("finish_reason", ["stop", "length"])
async def test_safe_usage_receipt_and_truncated_output_not_offered_as_complete(
    runtime, finish_reason
):
    store, work, _, repo, _ = runtime
    _, run = grant(runtime)

    async def model(*_):
        return writing.WritingResult(
            outline_output(runtime), 321, 123, 1, finish_reason
        )

    result = await dispatch_writing(repo, work["id"], run["id"], model)
    assert result["response"]["usage"] == {
        "inputTokens": 321,
        "outputTokens": 123,
        "requests": 1,
        "finishReason": finish_reason,
    }
    assert result["cost"]["actualMinor"] is None
    assert len(store.list_changes(work["id"])) == (1 if finish_reason == "stop" else 0)
    assert result["status"] == ("succeeded" if finish_reason == "stop" else "failed")
    assert result["cost"]["actualOutputTokens"] == 123
    assert repo.retained_result(work["id"], run["id"])["output"] == outline_output(
        runtime
    )


async def test_retained_output_is_read_only_and_work_scoped(runtime, monkeypatch):
    store, work, _, repo, _ = runtime
    _, run = grant(runtime)
    assert repo.retained_result(work["id"], run["id"])["output"] is None
    token, _ = repo.claim(work["id"], run["id"])
    repo.complete(work["id"], run["id"], token, output="Retained text")
    other = store.create_work(
        CreateWork(title="Other", brief="Other", preset=DirectorPreset(mode="original"))
    )
    with pytest.raises(ExecutionFault, match="RESOURCE_GONE"):
        repo.retained_result(other["id"], run["id"])

    async def scoped(project, user, role):
        assert role == "viewer"
        if project != "demo" or user != {"username": "writer"}:
            raise HTTPException(403)
        return store

    monkeypatch.setattr(director, "_store", scoped)
    before = repo.events(work["id"])
    result = await director.get_execution_result(
        "demo", work["id"], run["id"], {"username": "writer"}
    )
    assert result["data"]["output"] == "Retained text"
    assert result["data"]["readOnly"]
    assert "prompt" not in result["data"]
    assert repo.events(work["id"]) == before
    with pytest.raises(HTTPException) as denied:
        await director.get_execution_result(
            "other", work["id"], run["id"], {"username": "writer"}
        )
    assert denied.value.status_code == 403


@pytest.mark.parametrize("status", ["queued", "dispatching", "unknown"])
def test_active_operation_blocks_legacy_finalization_in_same_transaction(
    runtime, status
):
    store, work, _, repo, _ = runtime
    _, run = grant(runtime)
    with repo.transaction() as db:
        db.execute(
            "UPDATE director_operations SET status=? WHERE id=?", (status, run["id"])
        )
    document = store.put_document(
        work["id"], "episode-001", "Episode 1\nA key opens the door.", 0
    )
    assert "ACTIVE_OPERATION" in store.quality_report(work["id"], 1)["blockers"]
    with pytest.raises(DirectorInvalidState, match="ACTIVE_OPERATION"):
        store.finalize_episode(work["id"], 1, document["version"], True)


async def test_edit_before_dispatch_releases_unsent_but_edit_during_call_retains_bill(
    runtime,
):
    store, work, _, repo, _ = runtime
    _, run = grant(runtime)
    store.put_document(work["id"], "outline", "Changed", 0)

    async def not_called(*_):
        pytest.fail("stale input must not be sent")

    result = await dispatch_writing(repo, work["id"], run["id"], not_called)
    assert result["cost"]["actualMinor"] == 0
    assert result["errorCode"] == "INPUT_CHANGED_BEFORE_SEND"


async def test_late_output_cannot_overwrite_new_manual_version(runtime):
    store, work, _, repo, _ = runtime
    _, run = grant(runtime)

    async def editing_call(*_):
        store.put_document(work["id"], "outline", "New user draft", 0)
        return "Old model output"

    result = await dispatch_writing(repo, work["id"], run["id"], editing_call)
    assert result["status"] == "stale"
    assert result["cost"]["actualMinor"] is None
    assert store.get_document(work["id"], "outline")["content"] == "New user draft"
    assert not store.list_changes(work["id"])


async def test_expired_queued_approval_never_calls_provider(runtime):
    _, work, clock, repo, _ = runtime
    _, run = grant(runtime)
    clock[0] += 601

    async def not_called(*_):
        pytest.fail("expired approval")

    await dispatch_writing(repo, work["id"], run["id"], not_called)
    result = repo.list_operations(work["id"])[0]
    assert result["status"] == "cancelled"
    assert result["cost"]["actualMinor"] == 0


async def test_api_checks_auth_scope_schema_and_creates_only_one_background_intent(
    runtime, monkeypatch
):
    store, work, _, _, _ = runtime
    roles = []

    async def scoped(project, user, role):
        roles.append(role)
        if project != "demo" or user.get("username") != "writer":
            raise HTTPException(403)
        return store

    monkeypatch.setattr(director, "_store", scoped)
    request = command(
        work, {"type": "cost.quote", "kind": "outline", "maxOutputTokens": 1024}
    )
    tasks = BackgroundTasks()
    quoted = (
        await director.execute_cost_command(
            "demo", request, tasks, {"username": "writer"}
        )
    )["data"]["result"]
    assert tasks.tasks == []
    assert roles == ["editor"]
    with pytest.raises(HTTPException) as denied:
        await director.execute_cost_command(
            "other", request, tasks, {"username": "writer"}
        )
    assert denied.value.status_code == 403
    consent = command(
        work,
        {
            "type": "approval.grant",
            "quoteId": quoted["quoteId"],
            "requestHash": quoted["requestHash"],
            "unknownCostConsent": True,
        },
    )
    result = await director.execute_cost_command(
        "demo", consent, tasks, {"username": "writer"}
    )
    assert len(tasks.tasks) == 1
    assert result["data"]["result"]["status"] == "queued"
    app = FastAPI()
    app.include_router(director.router)
    app.dependency_overrides[director.get_api_user] = lambda: {"username": "writer"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        malformed = copy.deepcopy(request.model_dump(by_alias=True))
        malformed["payload"]["requestHash"] = "0" * 64
        response = await client.post(
            "/projects/demo/director/v2/approvals/commands", json=malformed
        )
        assert response.status_code == 422
        history = await client.get(
            f"/projects/demo/director/v2/works/{work['id']}/runs"
        )
        assert history.status_code == 200
        assert history.json()["data"][0]["id"] == result["data"]["result"]["id"]

"""Drive independent review through real approval/dispatch storage with synthetic responses."""

from __future__ import annotations

import copy
import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from novelvideo.api.routes import director
from novelvideo.director import execution, writing
from novelvideo.director import quality as quality_module
from novelvideo.director.documents import content_hash
from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.quality import (
    QualityService,
    review_inputs,
    save_review,
    validate_review,
)
from novelvideo.director.schemas.execution import ExecutionCommand, ExecutionFault
from novelvideo.director.schemas.quality import CHECK_IDS, FinalizeCommand
from novelvideo.director.store import DirectorInvalidState, DirectorStore


def response(frozen, *, failed=False):
    return {
        **({"episodeFacts": {"units": [{"unitId": unit["id"],
             "disposition": "METADATA" if unit["structural"] else "NO_FACT",
             "explanation": "Synthetic transport fixture: each non-structural unit still requires a human attestation.",
             "facts": []} for unit in frozen["factUnits"]]}} if frozen.get("factAuditVersion") else {}),
        "schemaVersion": 2,
        "subjectHash": frozen["contentHash"],
        "checks": [
            {
                "id": key,
                "status": "FAIL" if failed and key == "scope" else "PASS",
                "explanation": "The exact source and current scene were compared.",
                "suggestion": "Correct the timing of the action." if failed else "",
                "evidence": [
                    {
                        "inputId": "document",
                        "quote": frozen["inputs"]["document"],
                        "occurrence": 1,
                    }
                ],
            }
            for key in CHECK_IDS
        ],
    }


def test_model_path_like_reference_is_not_silently_rewritten_into_valid_evidence():
    frozen = {"contentHash": "a" * 64, "inputs": {"document": "Ada opens a box."}}
    output = response(frozen)
    output["checks"][0]["evidence"][0]["inputId"] = "inputs.document"
    assert validate_review(json.dumps(output), frozen)["status"] == "UNAVAILABLE"
    output["checks"][0]["evidence"][0]["inputId"] = "document"
    assert validate_review(json.dumps(output), frozen)["status"] == "PASS"


def test_invalid_quote_does_not_erase_another_grounded_failure():
    frozen = {"contentHash": "a" * 64, "inputs": {"document": "Ada opens a box."}}
    output = response(frozen, failed=True)
    output["checks"][0]["evidence"][0]["quote"] = "A fabricated observation."
    result = validate_review(json.dumps(output), frozen)
    assert result["status"] == "FAIL"
    checks = {item["id"]: item for item in result["checks"]}
    assert checks["scope"]["status"] == "FAIL"
    assert checks["scope"]["evidence"][0]["quoteHash"] == content_hash(
        "Ada opens a box."
    )
    assert checks["source_fidelity"]["status"] == "UNKNOWN"
    assert not checks["source_fidelity"]["evidence"]
    assert result["unavailableCheckIds"] == ["source_fidelity"]


def reviewed_command(store, work_id, ordinal=1, *, failed=False, unavailable=False):
    """Test fixture only; production reports are exclusively created by dispatcher."""
    with store._write() as db:
        frozen = review_inputs(store, db, work_id, ordinal)
        save_review(
            db,
            work_id,
            str(uuid.uuid4()),
            {"reviewInputs": frozen},
            "not JSON" if unavailable else json.dumps(response(frozen, failed=failed)),
            None,
        )
    report = QualityService(store).report(work_id, ordinal)
    intent = str(uuid.uuid4())
    return FinalizeCommand.from_wire(
        {
            "schemaVersion": 2,
            "commandId": intent,
            "clientRequestId": intent,
            "workId": work_id,
            "episodeOrdinal": ordinal,
            "expectedWorkRevision": store.get_work(work_id)["revision"],
            "documentVersion": report["version"],
            "contentHash": report["contentHash"],
            "reportId": report["review"]["id"],
            "reportHash": report["review"]["reportHash"],
            "humanChecks": [
                {
                    "checkId": key,
                    "conclusion": "literary_only"
                    if key in {"timing", "production_unverified"}
                    else "verified",
                    "evidence": "Scene 1 and the source were compared; no rehearsal is claimed.",
                }
                for key in report["requiredHumanChecks"]
            ],
        }
    )


@pytest.fixture
def quality(tmp_path, monkeypatch):
    def contract():
        return {"model_name": "test-model", "locked": True}

    monkeypatch.setattr(execution, "director_model_contract", contract)
    monkeypatch.setattr(writing, "director_model_contract", contract)
    store = DirectorStore(tmp_path)
    work = store.create_work(
        CreateWork(
            title="Synthetic",
            brief="A red key opens the box.",
            preset=DirectorPreset(mode="original", episode_count=2),
        )
    )
    store.put_document(
        work["id"],
        "episode-001",
        "# Scene 1\nAda finds the red key and opens the box.",
        0,
    )
    return store, store.get_work(work["id"])


def review_command(work, payload):
    intent = str(uuid.uuid4())
    return ExecutionCommand.from_wire(
        {
            "schemaVersion": 2,
            "commandId": intent,
            "clientRequestId": intent,
            "sessionId": "quality-session",
            "workId": work["id"],
            "expected": {
                "workRevision": work["revision"],
                "documentVersions": {"episode-001": 1},
                "capabilityVersion": execution_capability()["version"],
            },
            "payload": payload,
        }
    )


def approved_review(store, work):
    repository = ExecutionRepository(store)
    service = ExecutionService(repository)
    quote = service.execute(
        "actor",
        review_command(
            work,
            {
                "type": "cost.quote",
                "kind": "episode",
                "episodeOrdinal": 1,
                "purpose": "review",
                "instruction": "",
                "maxOutputTokens": 4096,
            },
        ),
    )["result"]
    operation = service.execute(
        "actor",
        review_command(
            work,
            {
                "type": "approval.grant",
                "quoteId": quote["quoteId"],
                "requestHash": quote["requestHash"],
                "unknownCostConsent": True,
            },
        ),
    )["result"]
    return repository, operation


async def test_independent_call_has_full_original_inputs_and_never_creates_draft(
    quality,
):
    store, work = quality
    repo, operation = approved_review(store, work)
    calls = []

    async def model(prompt, name, tokens):
        calls.append((prompt, name, tokens))
        frozen = json.loads(prompt)["frozenInputs"]
        assert (
            frozen["inputs"]["document"]
            == store.get_document(work["id"], "episode-001")["content"]
        )
        return writing.WritingResult(
            json.dumps(response(frozen)), 300, 200, 1, "stop", name
        )

    result = await dispatch_writing(repo, work["id"], operation["id"], model)
    assert len(calls) == 1
    assert result["status"] == "succeeded"
    assert result["changeId"] is None and not store.list_changes(work["id"])
    assert result["cost"]["actualMinor"] is None
    report = QualityService(DirectorStore(store.path.parent.parent)).report(
        work["id"], 1
    )
    assert report["review"]["reviewerRunId"] == operation["id"]
    assert report["review"]["status"] == "PASS"
    assert "timing" in report["requiredHumanChecks"]
    assert not report["productionReady"]
    assert await dispatch_writing(repo, work["id"], operation["id"], model) is None


@pytest.mark.parametrize(
    "mutation",
    [
        "bad_json",
        "missing_check",
        "wrong_hash",
        "fake_quote",
        "unknown_reference",
        "critical",
        "truncated",
    ],
)
def test_model_cannot_self_certify_or_forge_evidence(quality, mutation):
    store, work = quality
    with store._connect() as db:
        frozen = review_inputs(store, db, work["id"], 1)
    value = response(frozen)
    if mutation == "missing_check":
        value["checks"].pop()
    if mutation == "wrong_hash":
        value["subjectHash"] = "0" * 64
    if mutation == "fake_quote":
        value["checks"][0]["evidence"][0]["quote"] = "Invented quote"
    if mutation == "unknown_reference":
        value["checks"][0]["evidence"][0]["inputId"] = "different-work"
    if mutation == "critical":
        value["checks"][0]["unresolvedCriticalFact"] = True
    report = validate_review(
        "nope" if mutation == "bad_json" else json.dumps(value),
        frozen,
        truncated=mutation == "truncated",
    )
    assert report["status"] == ("FAIL" if mutation == "critical" else "UNAVAILABLE")


async def test_bad_output_is_unavailable_billable_retained_and_human_review_is_per_check(
    quality,
):
    store, work = quality
    repo, operation = approved_review(store, work)

    async def model(*args):
        return "not JSON"

    result = await dispatch_writing(repo, work["id"], operation["id"], model)
    assert result["status"] == "failed"
    assert result["cost"]["status"] == "settlement_pending"
    assert repo.retained_result(work["id"], operation["id"])["output"] == "not JSON"
    report = QualityService(store).report(work["id"], 1)
    assert report["review"]["status"] == "UNAVAILABLE"
    assert set(CHECK_IDS).issubset(report["requiredHumanChecks"])


async def test_old_unavailable_report_is_rechecked_without_fee_or_history_rewrite(
    quality, monkeypatch
):
    store, work = quality
    repo, operation = approved_review(store, work)
    calls = []

    async def model(prompt, *_):
        calls.append(prompt)
        value = response(json.loads(prompt)["frozenInputs"], failed=True)
        value["checks"][0]["evidence"][0]["quote"] = "Invented quote"
        return json.dumps(value)

    with monkeypatch.context() as legacy:
        legacy.setattr(
            quality_module,
            "validate_review",
            lambda *args, **kwargs: {
                "status": "UNAVAILABLE",
                "checks": [],
                "errorCode": "INVALID_REVIEW_OUTPUT",
                "productionReady": False,
            },
        )
        await dispatch_writing(repo, work["id"], operation["id"], model)
    with store._connect() as db:
        original_row = tuple(
            db.execute("SELECT * FROM director_quality_reports").fetchone()
        )
        original_cost = tuple(
            db.execute("SELECT * FROM director_cost_entries").fetchone()
        )
    service = QualityService(store)
    report = service.report(work["id"], 1)
    assert report["review"]["status"] == "UNAVAILABLE"
    assert report["retainedValidation"]["status"] == "FAIL"
    assert "REVIEW_FAILED" in report["blockers"]
    assert not report["ready_for_human_review"]
    intent = str(uuid.uuid4())
    command = FinalizeCommand.from_wire(
        {
            "schemaVersion": 2,
            "commandId": intent,
            "clientRequestId": intent,
            "workId": work["id"],
            "episodeOrdinal": 1,
            "expectedWorkRevision": store.get_work(work["id"])["revision"],
            "documentVersion": report["version"],
            "contentHash": report["contentHash"],
            "reportId": report["review"]["id"],
            "reportHash": report["review"]["reportHash"],
            "humanChecks": [
                {
                    "checkId": key,
                    "conclusion": "literary_only"
                    if key in {"timing", "production_unverified"}
                    else "verified",
                    "evidence": "Attempt to override the review with human confirmation.",
                }
                for key in report["requiredHumanChecks"]
            ],
        }
    )
    with pytest.raises(ExecutionFault, match="QUALITY_BLOCKED"):
        service.finalize("actor", command)
    with store._connect() as db:
        assert original_row == tuple(
            db.execute("SELECT * FROM director_quality_reports").fetchone()
        )
        assert original_cost == tuple(
            db.execute("SELECT * FROM director_cost_entries").fetchone()
        )
    assert len(calls) == 1


def test_bool_finalization_is_blocked_and_independent_review_is_required(quality):
    store, work = quality
    assert (
        "INDEPENDENT_REVIEW_REQUIRED"
        in QualityService(store).report(work["id"], 1)["blockers"]
    )
    with pytest.raises(DirectorInvalidState, match="FINALIZATION_V2_REQUIRED"):
        store.finalize_episode(work["id"], 1, 1, True)


@pytest.mark.parametrize("unavailable", [False, True])
def test_version_bound_manual_review_finalizes_exactly_once_and_preserves_boundary(
    quality, unavailable
):
    store, work = quality
    cmd = reviewed_command(store, work["id"], unavailable=unavailable)
    service = QualityService(store)
    if unavailable:
        assert "EPISODE_FACTS_INCOMPLETE" in service.report(work["id"], 1)["blockers"]
        with pytest.raises(ExecutionFault, match="QUALITY_BLOCKED"):
            service.finalize("actor", cmd)
        return
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: service.finalize("actor", cmd), range(2)))
    assert results[0] == results[1]
    assert results[0]["work"]["current_episode"] == 2
    assert not results[0]["productionReady"]
    assert results[0]["reviewStatus"] == ("UNAVAILABLE" if unavailable else "PASS")
    with store._connect() as db:
        row = db.execute("SELECT * FROM director_finalizations_v2").fetchone()
        assert row["actor"] == "actor"
        assert "red key" in json.loads(row["boundary_json"])["content"]
        assert (
            db.execute("SELECT count(*) FROM director_finalizations_v2").fetchone()[0]
            == 1
        )


def test_fail_cannot_be_overridden_by_manual_evidence(quality):
    store, work = quality
    cmd = reviewed_command(store, work["id"], failed=True)
    with pytest.raises(ExecutionFault, match="QUALITY_BLOCKED"):
        QualityService(store).finalize("actor", cmd)
    assert store.get_work(work["id"])["current_episode"] == 1


@pytest.mark.parametrize(
    "change",
    ["target", "upstream", "missing_attestation", "wrong_hash", "wrong_conclusion"],
)
def test_stale_or_incomplete_confirmation_never_commits(quality, change):
    store, work = quality
    cmd = reviewed_command(store, work["id"])
    wire = cmd.model_dump(by_alias=True)
    if change == "target":
        store.put_document(work["id"], "episode-001", "Changed draft", 1)
    if change == "upstream":
        store.put_document(work["id"], "outline", "The key is blue now", 0)
    if change == "missing_attestation":
        wire["humanChecks"].pop()
    if change == "wrong_hash":
        wire["reportHash"] = "f" * 64
    if change == "wrong_conclusion":
        next(item for item in wire["humanChecks"] if item["checkId"] == "production_unverified")["conclusion"] = "verified"
    with pytest.raises(ExecutionFault):
        QualityService(store).finalize("actor", FinalizeCommand.from_wire(wire))
    with store._connect() as db:
        assert not db.execute("SELECT 1 FROM director_finalizations_v2").fetchone()


def test_upstream_change_invalidates_report_without_changing_target_version(quality):
    store, work = quality
    reviewed_command(store, work["id"])
    store.put_document(work["id"], "characters", "Ada is now Bea", 0)
    report = QualityService(store).report(work["id"], 1)
    assert report["version"] == 1
    assert report["review"] is None


def test_upstream_edits_invalidate_finalization_but_writing_next_episode_does_not(
    quality,
):
    from novelvideo.director.quality import valid_finalization

    store, work = quality
    QualityService(store).finalize("actor", reviewed_command(store, work["id"]))
    store.put_document(work["id"], "episode-002", "Ada keeps the red key.", 0)
    with store._connect() as db:
        assert valid_finalization(store, db, work["id"], 1)
    store.put_document(work["id"], "characters", "Ada must not possess the key.", 0)
    with store._connect() as db:
        assert not valid_finalization(store, db, work["id"], 1)
        assert (
            db.execute("SELECT COUNT(*) FROM director_finalizations_v2").fetchone()[0]
            == 1
        )
    assert (
        "PRIOR_EPISODE_UNCONFIRMED"
        in QualityService(store).report(work["id"], 2)["blockers"]
    )


def test_review_sees_exact_revision_instruction_and_prior_version_not_writer_summary(
    quality,
):
    store, work = quality
    before = store.get_document(work["id"], "episode-001")["content"]
    change = store.propose_change(
        work["id"],
        "episode-001",
        before + "\nAda pauses AFTER finding the key.",
        1,
        "Add a pause BEFORE finding the key; do not change other scenes.",
    )
    store.decide_change(work["id"], change["id"], True)
    with store._connect() as db:
        frozen = review_inputs(store, db, work["id"], 1)
    assert "BEFORE" in frozen["inputs"]["revision-instruction"]
    assert frozen["inputs"]["revision-base"] == before
    assert "AFTER" in frozen["inputs"]["document"]


async def test_late_review_is_retained_but_never_becomes_current_report(quality):
    store, work = quality
    repo, operation = approved_review(store, work)

    async def model(prompt, *_):
        frozen = json.loads(prompt)["frozenInputs"]
        store.put_document(work["id"], "episode-001", "A newer user-authored draft.", 1)
        return json.dumps(response(frozen))

    result = await dispatch_writing(repo, work["id"], operation["id"], model)
    assert result["status"] == "stale"
    assert repo.retained_result(work["id"], operation["id"])["output"]
    assert QualityService(store).report(work["id"], 1)["review"] is None


def test_finalization_strict_fields_and_no_whitespace_evidence(quality):
    store, work = quality
    wire = reviewed_command(store, work["id"]).model_dump(by_alias=True)
    for field, value in [("approved", True), ("documentVersion", "1")]:
        with pytest.raises(ValidationError):
            FinalizeCommand.from_wire({**wire, field: value})
    wire["humanChecks"][0]["evidence"] = " " * 10
    with pytest.raises(ValidationError):
        FinalizeCommand.from_wire(wire)


async def test_api_requires_auth_and_editor_and_cross_work_report_cannot_finalize(
    quality, monkeypatch
):
    store, work = quality
    app = FastAPI()
    app.include_router(director.router)
    roles = []

    async def get_store(project, user, role):
        roles.append(role)
        return store

    monkeypatch.setattr(director, "_store", get_store)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        path = f"/projects/test/director/v2/works/{work['id']}/quality/1"
        # An unconfigured CE auth backend is 503; either way scope resolution
        # and the quality repository must not run without authentication.
        assert (await client.get(path)).status_code in {401, 403, 503}
        assert roles == []
        app.dependency_overrides[director.get_api_user] = lambda: {"id": "actor"}
        assert (await client.get(path)).status_code == 200
        cmd = reviewed_command(store, work["id"]).model_dump(by_alias=True)
        other = store.create_work(
            CreateWork(
                title="Other", brief="A box", preset=DirectorPreset(mode="original")
            )
        )
        store.put_document(other["id"], "episode-001", "Other story", 0)
        cross = copy.deepcopy(cmd)
        cross["workId"] = other["id"]
        assert (
            await client.post(
                "/projects/test/director/v2/episodes/commands", json=cross
            )
        ).status_code == 409
        assert roles[-1] == "editor"
        assert (
            await client.post("/projects/test/director/v2/episodes/commands", json=cmd)
        ).status_code == 200

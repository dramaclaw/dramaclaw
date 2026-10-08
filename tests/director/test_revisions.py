"""Assert impact approval against real SQLite history, never a destructive rewrite."""

import copy
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from novelvideo.api.routes import director
from novelvideo.director.execution_repository import ExecutionRepository
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.quality import QualityService, valid_finalization
from novelvideo.director.repository import DocumentRepository
from novelvideo.director.revisions import RevisionService
from novelvideo.director.schemas.execution import ExecutionFault
from novelvideo.director.schemas.revisions import (
    CommitRevision,
    RevisionPreviewCommand,
    SettingsPreset,
)
from novelvideo.director.store import DirectorStore
from tests.director.test_quality import reviewed_command


@pytest.fixture
def revisions(tmp_path):
    store = DirectorStore(tmp_path)
    work = store.create_work(
        CreateWork(
            title="Synthetic",
            brief="A key opens a box.",
            preset=DirectorPreset(mode="original", episode_count=2),
        )
    )
    for n in (1, 2):
        store.put_document(
            work["id"], f"episode-{n:03d}", f"# Scene {n}\nAda opens a box.", 0
        )
        QualityService(store).finalize("actor", reviewed_command(store, work["id"], n))
    assert store.get_work(work["id"])["status"] == "completed"
    return store, work["id"], RevisionService(store)


def preview_command(store, work_id, *, reopen=None, **updates):
    work = store.get_work(work_id)
    preset = SettingsPreset.model_validate(work["preset"], by_name=True).model_dump(
        by_alias=True
    )
    payload = (
        {"type": "episode.reopenPreview", "episodeOrdinal": reopen}
        if reopen
        else {
            "type": "settings.preview",
            "candidate": {
                "title": updates.pop("title", work["title"]),
                "brief": updates.pop("brief", work["brief"]),
                "preset": {**preset, **updates},
            },
        }
    )
    return RevisionPreviewCommand.from_wire(
        {
            "schemaVersion": 2,
            "workId": work_id,
            "expectedWorkRevision": work["revision"],
            "payload": payload,
        }
    )


def commit_command(preview):
    intent = uuid.uuid4().hex
    return CommitRevision.from_wire(
        {
            "schemaVersion": 2,
            "commandId": intent,
            "clientRequestId": intent,
            "workId": preview["workId"],
            "previewId": preview["previewId"],
            "previewHash": preview["previewHash"],
            "archiveEpisodeIds": [e["id"] for e in preview["archiveEpisodes"]],
            "reason": "I reviewed the affected episodes and explicitly approve this impact.",
        }
    )


def test_settings_preview_no_change_until_commit_and_history_kept(revisions):
    store, wid, service = revisions
    before = store.get_document(wid, "episode-001")
    preview = service.preview(
        "actor", preview_command(store, wid, narrativeTone="Warm and restrained")
    )
    assert len(preview["invalidatedFinalizationIds"]) == 2
    assert preview["modelCalls"] == 0
    assert preview["restartEpisode"] == 1
    assert store.get_work(wid)["status"] == "completed"
    result = service.commit("actor", commit_command(preview))
    assert result["work"]["status"] == "needs_review"
    assert result["work"]["current_episode"] == 1
    assert result["work"]["preset"]["narrative_tone"] == "Warm and restrained"
    assert store.get_document(wid, "episode-001") == before
    assert len(service.history(wid)) == 2
    assert (
        "INDEPENDENT_REVIEW_REQUIRED"
        in QualityService(store).report(wid, 1)["blockers"]
    )
    with store._connect() as db:
        assert not valid_finalization(store, db, wid, 1)
        assert (
            db.execute("SELECT COUNT(*) FROM director_finalizations_v2").fetchone()[0]
            == 2
        )
        assert (
            db.execute("SELECT COUNT(*) FROM director_quality_reports").fetchone()[0]
            == 2
        )


def test_reopen_later_episode_keeps_prior_finalization_but_requires_new_review(
    revisions,
):
    store, wid, service = revisions
    preview = service.preview("actor", preview_command(store, wid, reopen=2))
    assert len(preview["invalidatedFinalizationIds"]) == 1
    service.commit("actor", commit_command(preview))
    with store._connect() as db:
        assert valid_finalization(store, db, wid, 1)
        assert not valid_finalization(store, db, wid, 2)
    assert QualityService(store).report(wid, 2)["review"] is None
    store.put_document(wid, "episode-002", "# Scene 2\nAda closes the box.", 1)
    QualityService(store).finalize("actor", reviewed_command(store, wid, 2))
    assert store.get_work(wid)["status"] == "completed"


def test_title_only_does_not_invalidate_content_or_completed_state(revisions):
    store, wid, service = revisions
    preview = service.preview(
        "actor", preview_command(store, wid, title="New synthetic title")
    )
    assert preview["restartEpisode"] is None
    assert preview["invalidatedReportIds"] == []
    service.commit("actor", commit_command(preview))
    assert store.get_work(wid)["status"] == "completed"
    with store._connect() as db:
        assert valid_finalization(store, db, wid, 1)
        assert valid_finalization(store, db, wid, 2)


def test_model_switch_preserves_review_and_finalization_but_changes_work_revision(revisions):
    store, wid, service = revisions
    before = store.get_work(wid)
    reports = [QualityService(store).report(wid, n)["review"] for n in (1, 2)]
    preview = service.preview("actor", preview_command(store, wid, modelName="ark::doubao-seed-evolving"))
    assert preview["restartEpisode"] is None
    assert preview["invalidatedReportIds"] == []
    assert preview["invalidatedFinalizationIds"] == []
    result = service.commit("actor", commit_command(preview))
    assert result["work"]["revision"] == before["revision"] + 1
    assert result["work"]["status"] == "completed"
    assert result["work"]["preset"]["model_name"] == "ark::doubao-seed-evolving"
    assert [QualityService(store).report(wid, n)["review"] for n in (1, 2)] == reports
    with store._connect() as db:
        assert all(valid_finalization(store, db, wid, n) for n in (1, 2))
    changed_story = service.preview("actor", preview_command(store, wid, modelName="ark::deepseek-v4.1-flash", narrativeTone="Unsettling"))
    assert changed_story["restartEpisode"] == 1
    assert len(changed_story["invalidatedFinalizationIds"]) == 2


def test_shrink_requires_exact_ack_preserves_text_and_expand_restores_ids(revisions):
    store, wid, service = revisions
    before = DocumentRepository(store).projection(wid)
    preview = service.preview("actor", preview_command(store, wid, episodeCount=1))
    command = commit_command(preview)
    with pytest.raises(ExecutionFault, match="ARCHIVE_CONFIRMATION_REQUIRED"):
        service.commit("actor", command.model_copy(update={"archive_episode_ids": []}))
    service.commit("actor", command)
    archived = DocumentRepository(store).projection(wid)
    assert archived["episodes"][1]["archived"]
    assert store.get_document(wid, "episode-002")["version"] == 1
    preview2 = service.preview("actor", preview_command(store, wid, episodeCount=3))
    assert preview2["restoredEpisodes"][0]["id"] == before["episodes"][1]["id"]
    assert preview2["addedOrdinals"] == [3]
    service.commit("actor", commit_command(preview2))
    after = DocumentRepository(store).projection(wid)
    assert [e["id"] for e in after["episodes"][:2]] == [
        e["id"] for e in before["episodes"]
    ]
    assert all(not e["archived"] for e in after["episodes"])
    assert len(after["episodes"]) == 3


def test_reverting_settings_does_not_resurrect_old_review(revisions):
    store, wid, service = revisions
    for duration in (60, 120):
        preview = service.preview(
            "actor", preview_command(store, wid, durationSeconds=duration)
        )
        service.commit("actor", commit_command(preview))
    assert QualityService(store).report(wid, 1)["review"] is None


def test_concurrent_same_intent_has_one_revision_event_and_receipt(revisions):
    store, wid, service = revisions
    preview = service.preview("actor", preview_command(store, wid, reopen=1))
    command = commit_command(preview)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: service.commit("actor", command), range(2)))
    assert results[0] == results[1]
    assert results[0]["work"]["revision"] == preview["workRevision"] + 1
    assert (
        len(
            [
                e
                for e in store.list_events(wid, 0)
                if e["kind"] == "work.revision_committed"
            ]
        )
        == 1
    )
    with pytest.raises(ExecutionFault, match="IDEMPOTENCY_CONFLICT"):
        service.commit(
            "actor", command.model_copy(update={"reason": "A different valid reason."})
        )


@pytest.mark.parametrize("mutation", ["revision", "review", "pending", "unknown"])
def test_intervening_changes_invalidate_preview(revisions, mutation):
    store, wid, service = revisions
    preview = service.preview("actor", preview_command(store, wid, reopen=1))
    if mutation == "review":
        reviewed_command(store, wid)
    elif mutation == "unknown":
        ExecutionRepository(store)
        # Synthetic unknown row, no provider calls; approval FK satisfied in one transaction.
        with store._write() as db:
            db.execute(
                "INSERT INTO director_quotes VALUES ('q',?,'actor','s','hash','{}',0,99999999999,'approved')",
                (wid,),
            )
            db.execute(
                "INSERT INTO director_approvals VALUES ('a','q','actor','hash','{}',0,99999999999)"
            )
            db.execute(
                "INSERT INTO director_operations(id,work_id,approval_id,session_id,request_hash,status,created_at,updated_at) VALUES ('r',?,'a','s','hash','unknown',0,0)",
                (wid,),
            )
    else:
        with store._write() as db:
            if mutation == "revision":
                db.execute("UPDATE works SET revision=revision+1 WHERE id=?", (wid,))
            else:
                db.execute(
                    "INSERT INTO changes(id,work_id,doc_key,base_version,content,reason,created_at) VALUES ('c',?,'episode-001',1,'draft','reason',0)",
                    (wid,),
                )
    with pytest.raises(
        ExecutionFault, match="IMPACT_STALE|PENDING_CHANGES|ACTIVE_OPERATION"
    ):
        service.commit("actor", commit_command(preview))
    assert service.history(wid) == []


def test_expired_wrong_hash_actor_work_and_invalid_targets(revisions):
    store, wid, service = revisions
    preview = service.preview("actor", preview_command(store, wid, reopen=1))
    command = commit_command(preview)
    with pytest.raises(ExecutionFault, match="RESOURCE_GONE"):
        service.commit("someone-else", command)
    with pytest.raises(ExecutionFault, match="IMPACT_HASH_MISMATCH"):
        service.commit("actor", command.model_copy(update={"preview_hash": "0" * 64}))
    expired = RevisionService(store, clock=lambda: preview["expiresAt"] + 1)
    with pytest.raises(ExecutionFault, match="IMPACT_EXPIRED"):
        expired.commit("actor", command)
    with pytest.raises(ExecutionFault, match="EPISODE_NOT_FOUND"):
        service.preview("actor", preview_command(store, wid, reopen=3))
    with pytest.raises(ExecutionFault, match="SOURCE_BINDING_IMMUTABLE"):
        service.preview("actor", preview_command(store, wid, sourceEpisodeLabel="EP42"))
    with pytest.raises(ExecutionFault, match="NO_SETTINGS_CHANGE"):
        service.preview("actor", preview_command(store, wid))


def test_transaction_failure_rolls_back_every_write(revisions, monkeypatch):
    store, wid, service = revisions
    preview = service.preview("actor", preview_command(store, wid, episodeCount=1))
    before = store.get_work(wid)

    def broken(*_args):
        raise RuntimeError("injected transaction failure")

    monkeypatch.setattr(store, "_event", broken)
    with pytest.raises(RuntimeError, match="injected"):
        service.commit("actor", commit_command(preview))
    assert store.get_work(wid) == before
    assert service.history(wid) == []
    assert not DocumentRepository(store).projection(wid)["episodes"][1]["archived"]
    with store._connect() as db:
        assert valid_finalization(store, db, wid, 1)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda raw: raw["payload"]["candidate"]["preset"].update(episodeCount="3"),
        lambda raw: raw["payload"]["candidate"]["preset"].update(episode_count=3),
        lambda raw: raw["payload"]["candidate"].update(sourceText="replace source"),
        lambda raw: raw.update(actor="another-user"),
    ],
)
def test_strict_contract_rejects_coercion_unknown_or_source_override(revisions, mutate):
    store, wid, _ = revisions
    raw = preview_command(store, wid, episodeCount=3).model_dump(by_alias=True)
    mutate(raw)
    with pytest.raises(ValidationError):
        RevisionPreviewCommand.from_wire(raw)


async def test_authenticated_routes_and_cross_work_preview_scope(
    revisions, monkeypatch
):
    store, wid, service = revisions
    app = FastAPI()
    app.include_router(director.router)
    user = {"id": "actor", "role": "viewer"}
    app.dependency_overrides[director.get_api_user] = lambda: user

    async def scoped(project, user, role):
        if project != "synthetic" or role == "editor" and user["role"] != "editor":
            raise HTTPException(403)
        return store

    monkeypatch.setattr(director, "_store", scoped)
    raw = preview_command(store, wid, reopen=1).model_dump(by_alias=True)
    base = "/projects/synthetic/director/v2"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (
            await client.post(base + "/revisions/preview", json=raw)
        ).status_code == 403
        user["role"] = "editor"
        response = await client.post(base + "/revisions/preview", json=raw)
        assert response.status_code == 200
        command = commit_command(response.json()["data"]).model_dump(by_alias=True)
        another = store.create_work(
            CreateWork(
                title="Other", brief="A box.", preset=DirectorPreset(mode="original")
            )
        )
        wrong = copy.deepcopy(command)
        wrong["workId"] = another["id"]
        assert (
            await client.post(base + "/revisions/commands", json=wrong)
        ).status_code == 404
        result = await client.post(base + "/revisions/commands", json=command)
        assert result.status_code == 200
        assert result.json()["data"]["work"]["status"] == "needs_review"
        assert (
            len(
                (await client.get(base + f"/works/{wid}/settings-history")).json()[
                    "data"
                ]
            )
            == 2
        )

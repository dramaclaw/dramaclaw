"""No media provider runs here: prove approvals cannot dispatch twice."""
from copy import deepcopy
from uuid import uuid4

import pytest

from novelvideo.director.media import MediaPrepare, MediaRepository, document_assets
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.store import DirectorConflict, DirectorNotFound, DirectorStore

CATALOG = [{"id": "image-one", "label": "Synthetic image model", "apiModel": "image-test", "providerId": "newapi",
            "ratioOptions": ["16:9", "1:1"], "resolutionOptions": ["1K"], "qualityOptions": ["high"],
            "request": {"endpoint": "images/generations", "parameters": [{"key": "seed", "label": "Seed", "control": "number", "requestPath": "seed", "min": 0}]}}]


@pytest.fixture
def setup(tmp_path):
    store = DirectorStore(tmp_path)
    work = store.create_work(CreateWork(title="Synthetic", brief="Only a corridor and a courtyard.", preset=DirectorPreset(mode="original", episode_count=1)))
    store.put_document(work["id"], "scenes", "# Scenes\n\n## Corridor\nInterior.\n\n## Courtyard\nExterior.\n", 0)
    repo = MediaRepository(store)
    source = repo.source(work["id"], "scenes")
    body = MediaPrepare(intent_id=uuid4(), work_revision=source["workRevision"], document_version=1,
                        kind="scenes", asset_id="1", prompt="A courtyard; no people.", model_id="image-one",
                        aspect_ratio="16:9", image_size="1K", quality="high", model_params={"seed": 42})
    return store, work["id"], repo, body


def test_source_order_and_no_model_roster_invention(setup):
    _, work, repo, _ = setup
    assert [item["name"] for item in repo.source(work, "scenes")["assets"]] == ["Corridor", "Courtyard"]
    assert document_assets("# No assets") == []
    legacy = document_assets("# 人物清单\n## Lin\nActor.\n## 人物关系\nFriends.\n## 世界规则\nRules.")
    assert [(item["name"], item["text"]) for item in legacy] == [("Lin", "## Lin\nActor.")]
    with pytest.raises(ValueError, match="MEDIA_KIND_INVALID"):
        repo.source(work, "episode-001")


def test_prepare_is_free_and_exact_selected_asset_and_params(setup):
    _, work, repo, body = setup
    prepared = repo.prepare("actor", work, body, CATALOG)
    assert prepared["status"] == "prepared"
    assert prepared["request"]["source"]["asset"]["name"] == "Courtyard"
    assert "Corridor" not in prepared["request"]["source"]["asset"]["text"]
    assert prepared["request"]["price"] == {"status": "unknown", "amount": None}
    assert prepared["request"]["actual"] == {
        "prompt": body.prompt, "provider": "newapi", "model": "image-test", "model_id": "image-one",
        "aspect_ratio": "16:9", "image_size": "1K", "quality": "high", "model_params": {"seed": 42},
        "gen_mode": "text_to_image", "reference_urls": [], "canvas_id": f"director-{work}", "node_id": str(body.intent_id)}
    assert repo.prepare("actor", work, body, CATALOG) == prepared
    assert len(repo.list(work)) == 1


def test_same_intent_different_payload_or_actor_never_reused(setup):
    _, work, repo, body = setup
    repo.prepare("actor", work, body, CATALOG)
    with pytest.raises(DirectorConflict):
        repo.prepare("other", work, body, CATALOG)
    with pytest.raises(DirectorConflict):
        repo.prepare("actor", work, body.model_copy(update={"prompt": "Changed"}), CATALOG)
    with pytest.raises(DirectorNotFound):
        repo.claim("other", work, str(body.intent_id), CATALOG)


@pytest.mark.parametrize("field,value", [("aspect_ratio", "9:16"), ("image_size", "4K"), ("quality", "low"), ("model_params", {"unknown": True}), ("model_params", {"seed": -1}), ("asset_id", "9")])
def test_unoffered_and_invalid_params_cannot_be_prepared(setup, field, value):
    _, work, repo, body = setup
    with pytest.raises(ValueError):
        repo.prepare("actor", work, body.model_copy(update={field: value}), CATALOG)
    assert repo.list(work) == []


def test_changed_document_and_catalog_invalidate_approval(setup):
    store, work, repo, body = setup
    repo.prepare("actor", work, body, CATALOG)
    changed = deepcopy(CATALOG)
    changed[0]["apiModel"] = "another-model"
    with pytest.raises(DirectorConflict, match="MEDIA_MODEL_CHANGED"):
        repo.claim("actor", work, str(body.intent_id), changed)
    store.put_document(work, "scenes", "# Scenes\n\n## Different\nChanged.", 1)
    with pytest.raises(DirectorConflict, match="MEDIA_SOURCE_CHANGED"):
        repo.claim("actor", work, str(body.intent_id), CATALOG)


@pytest.mark.parametrize("receipt", [None, {"task_key": "media:one", "job_id": "job-one", "task_type": "freezone_gen"}])
def test_double_click_loss_and_restart_never_redispatch(setup, receipt):
    store, work, repo, body = setup
    repo.prepare("actor", work, body, CATALOG)
    assert repo.claim("actor", work, str(body.intent_id), CATALOG)[1] is True
    assert repo.claim("actor", work, str(body.intent_id), CATALOG)[1] is False
    restored = MediaRepository(DirectorStore(store.path.parent.parent))
    assert restored.claim("actor", work, str(body.intent_id), CATALOG)[1] is False
    result = restored.finish(work, str(body.intent_id), receipt)
    assert result["status"] == ("accepted" if receipt else "unknown")
    assert restored.claim("actor", work, str(body.intent_id), CATALOG)[1] is False


def test_authenticated_route_uses_exact_frozen_body_once(setup, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from novelvideo.api.routes import director, freezone

    store, work, _, body = setup
    sent = []

    async def scoped(project, user, role):
        assert project == "synthetic" and user["username"] == "actor"
        return store

    async def catalog(project, user):
        return {"ok": True, "data": CATALOG}

    async def generate(project, request, user):
        sent.append(request.model_dump())
        return {"ok": True, "data": {"task_key": "media:one", "job_id": "one", "task_type": "freezone_gen"}}

    monkeypatch.setattr(director, "_store", scoped)
    monkeypatch.setattr(freezone, "freezone_image_models", catalog)
    monkeypatch.setattr(freezone, "freezone_gen", generate)
    app = FastAPI()
    app.include_router(director.router)
    app.dependency_overrides[director.get_api_user] = lambda: {"username": "actor"}
    client = TestClient(app)
    path = f"/projects/synthetic/director/works/{work}/media"
    response = client.post(path + "/prepare", json=body.model_dump(mode="json"))
    assert response.status_code == 200
    prepared = response.json()["data"]
    assert sent == []
    approve_path = path + f"/{body.intent_id}/confirm"
    assert client.post(approve_path, json={"approved": True, "acknowledge_unknown_cost": False}).status_code == 422
    assert sent == []
    for _ in range(2):
        reply = client.post(approve_path, json={"approved": True, "acknowledge_unknown_cost": True})
        assert reply.status_code == 200 and reply.json()["data"]["status"] == "accepted"
    assert len(sent) == 1
    assert all(sent[0][key] == value for key, value in prepared["request"]["actual"].items())

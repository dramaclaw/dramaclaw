"""A cancelled plan leaves visible nodes, never permission to buy again."""
from uuid import UUID, uuid4
from concurrent.futures import ThreadPoolExecutor

import pytest

from novelvideo.director.media_batch import BatchApproval, BatchPrepare, MediaBatchRepository, NodePosition
from novelvideo.director.store import DirectorConflict, DirectorNotFound
from tests.director.test_media import CATALOG, setup as media_setup


@pytest.fixture
def setup(tmp_path):
    return media_setup.__wrapped__(tmp_path)


def plan(setup, **updates):
    _, work, media, single = setup
    repo = MediaBatchRepository(media)
    body = BatchPrepare(**single.model_dump(exclude={"intent_id", "asset_id", "prompt"}), id=uuid4())
    body = body.model_copy(update=updates)
    return repo, body, repo.prepare("actor", work, body, CATALOG)


def approval(batch, indexes=(0, 1)):
    return BatchApproval(selected_ids=[UUID(batch["nodes"][i]["id"]) for i in indexes], acknowledge_unknown_cost=True)


def test_plan_atomic_order_exact_params_and_recovery(setup):
    repo, body, batch = plan(setup)
    _, work, media, _ = setup
    assert [n["intent"]["request"]["source"]["asset"]["name"] for n in batch["nodes"]] == ["Corridor", "Courtyard"]
    assert all(n["id"] == n["intent"]["request"]["actual"]["node_id"] for n in batch["nodes"])
    assert "Courtyard" not in batch["nodes"][0]["intent"]["request"]["actual"]["prompt"]
    assert all(n["intent"]["request"]["actual"]["model_params"] == {"seed": 42} for n in batch["nodes"])
    assert repo.prepare("actor", work, body, CATALOG) == batch
    assert repo.list(work) == [batch]
    with pytest.raises(DirectorConflict, match="NOT_APPROVED"):
        media.claim("actor", work, batch["nodes"][0]["id"], CATALOG)
    with pytest.raises(DirectorConflict, match="REUSED"):
        repo.prepare("other", work, body, CATALOG)


def test_late_invalid_item_rolls_back_entire_plan(setup):
    _, work, media, _ = setup
    with pytest.raises(ValueError):
        plan(setup, prompts={"1": " "})
    assert media.list(work) == []
    assert MediaBatchRepository(media).list(work) == []


def test_subset_approval_single_dispatch_and_unknown_never_rebought(setup):
    repo, _, batch = plan(setup)
    _, work, media, _ = setup
    result = repo.approve("actor", work, batch["id"], approval(batch, (1,)), CATALOG)
    assert [n["intent"]["status"] for n in result["nodes"]] == ["cancelled", "prepared"]
    target = result["nodes"][1]["id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        calls = list(pool.map(lambda _: media.claim("actor", work, target, CATALOG), range(2)))
    assert sum(c[1] for c in calls) == 1
    media.finish(work, target, None)
    repo.approve("actor", work, batch["id"], approval(batch, (1,)), CATALOG)
    assert media.claim("actor", work, target, CATALOG)[1] is False
    with pytest.raises(DirectorConflict, match="APPROVAL_REUSED"):
        repo.approve("actor", work, batch["id"], approval(batch), CATALOG)


def test_cancel_stops_only_unsubmitted_and_preserves_received_job(setup):
    repo, _, batch = plan(setup)
    _, work, media, _ = setup
    repo.approve("actor", work, batch["id"], approval(batch, (1, 0)), CATALOG)
    first = batch["nodes"][0]["id"]
    media.claim("actor", work, first, CATALOG)
    media.finish(work, first, {"job_id": "existing", "task_key": "task"})
    result = repo.cancel("actor", work, batch["id"])
    assert [n["intent"]["status"] for n in result["nodes"]] == ["accepted", "cancelled"]
    assert repo.cancel("actor", work, batch["id"]) == result
    assert not media.claim("actor", work, batch["nodes"][1]["id"], CATALOG)[1]


def test_source_and_catalog_changes_reject_before_any_purchase(setup):
    repo, _, batch = plan(setup)
    store, work, media, _ = setup
    with pytest.raises(DirectorConflict, match="MODEL_CHANGED"):
        repo.approve("actor", work, batch["id"], approval(batch), [])
    store.put_document(work, "scenes", "## New place\nUnknown", 1)
    with pytest.raises(DirectorConflict, match="SOURCE_CHANGED"):
        repo.approve("actor", work, batch["id"], approval(batch), CATALOG)
    assert all(i["status"] == "prepared" for i in media.list(work))


def test_node_positions_cas_and_exact_replay(setup):
    repo, _, batch = plan(setup)
    _, work, _, _ = setup
    node = batch["nodes"][0]
    body = NodePosition(version=1, x=150, y=260)
    moved = repo.move(work, node["id"], body)
    assert moved["version"] == 2
    assert repo.move(work, node["id"], body) == moved
    with pytest.raises(DirectorConflict):
        repo.move(work, node["id"], body.model_copy(update={"x": 900}))
    with pytest.raises(DirectorNotFound):
        repo.move("another-work", node["id"], body)
    assert repo.list(work)[0]["nodes"][0]["x"] == 150


def test_batch_http_queues_frozen_source_order_only_once(setup, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from novelvideo.api.routes import director, freezone

    store, work, _, single = setup
    sent = []

    async def scoped(project, user, role):
        assert project == "synthetic" and user["username"] == "actor"
        assert role in {"editor", "viewer"}
        return store

    async def catalog(project, user):
        return {"ok": True, "data": CATALOG}

    async def generate(project, request, user):
        sent.append(request.model_dump())
        return {"ok": True, "data": {"task_key": f"image:{len(sent)}", "job_id": str(len(sent)), "task_type": "freezone_gen"}}

    monkeypatch.setattr(director, "_store", scoped)
    monkeypatch.setattr(freezone, "freezone_image_models", catalog)
    monkeypatch.setattr(freezone, "freezone_gen", generate)
    app = FastAPI()
    app.include_router(director.router)
    app.dependency_overrides[director.get_api_user] = lambda: {"username": "actor"}
    client = TestClient(app)
    path = f"/projects/synthetic/director/works/{work}/media/batches"
    body = BatchPrepare(**single.model_dump(exclude={"intent_id", "asset_id", "prompt"}), id=uuid4())
    prepared = client.post(path, json=body.model_dump(mode="json"))
    assert prepared.status_code == 200 and not sent
    batch = prepared.json()["data"]
    payload = approval(batch, (1, 0)).model_dump(mode="json")
    for _ in range(2):
        response = client.post(path + f"/{body.id}/approve", json=payload)
        assert response.status_code == 200
    assert len(sent) == 2
    for actual, node in zip(sent, batch["nodes"], strict=True):
        assert all(actual[key] == value for key, value in node["intent"]["request"]["actual"].items())
    restored = client.get(path).json()["data"]
    assert [n["intent"]["status"] for n in restored[0]["nodes"]] == ["accepted", "accepted"]


def test_full_page_pixel_gate_never_hides_errors(tmp_path):
    np = pytest.importorskip("numpy")
    image = pytest.importorskip("PIL.Image")
    from tests.director.pixel_compare import compare

    a, b = tmp_path / "a.png", tmp_path / "b.png"
    image.new("RGB", (100, 100), "black").save(a)
    image.new("RGB", (100, 100), "black").save(b)
    assert compare(a, b, tmp_path / "same")["pass"]
    pixels = np.zeros((100, 100, 3), dtype=np.uint8)
    pixels[10:40, 10:40] = 255
    image.fromarray(pixels).save(b)
    result = compare(a, b, tmp_path / "changed", regions=[("quiet-crop", 50, 50, 20, 20)])
    assert not result["pass"] and result["full"]["changedRatio"] == .09
    assert result["regions"]["quiet-crop"]["changedRatio"] == 0
    image.new("RGB", (99, 100)).save(b)
    assert compare(a, b, tmp_path / "size")["reason"] == "DIMENSION_MISMATCH"

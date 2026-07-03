from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image


class _DetectStore:
    def __init__(
        self,
        beats: list[dict],
        *,
        sketch_colors: dict[str, str] | None = None,
        script_sketch_colors: dict[str, str] | None = None,
    ):
        self.beats = beats
        self.sketch_colors = (
            {"Hero_Main": "#ff0000 RED"} if sketch_colors is None else sketch_colors
        )
        self.script_sketch_colors = (
            {"Hero_Main": "#ff0000 RED"}
            if script_sketch_colors is None
            else script_sketch_colors
        )
        self.identity_writes: dict[int, list[str]] = {}
        self.prop_writes: dict[int, list[str]] = {}

    async def get_beats_as_dicts(self, episode_num: int):
        assert episode_num == 1
        return self.beats

    def get_sketch_colors(self, episode_num: int):
        assert episode_num == 1
        return self.sketch_colors

    async def get_script_as_dict(self, episode_num: int):
        assert episode_num == 1
        return {
            "beats": self.beats,
            "sketch_colors": self.script_sketch_colors,
            "prop_menu": [],
        }

    def get_episode(self, episode_num: int):
        assert episode_num == 1
        return None

    def get_all_characters(self):
        return [{"name": "Hero", "identities": [{"identity_id": "Hero_Main"}]}]

    async def set_beat_detected_identities(
        self,
        episode_number: int,
        detections: dict[int, list[str]],
    ):
        assert episode_number == 1
        self.identity_writes.update(detections)
        return len(detections)

    async def set_beat_detected_props(
        self,
        episode_number: int,
        detections: dict[int, list[str]],
    ):
        assert episode_number == 1
        self.prop_writes.update(detections)
        return len(detections)


def _write_sketch(project_dir, beat_num: int, *, padded: bool = True) -> None:
    sketches_dir = project_dir / "sketches" / "ep001"
    sketches_dir.mkdir(parents=True, exist_ok=True)
    suffix = f"{beat_num:02d}" if padded else str(beat_num)
    Image.new("RGB", (8, 8), color=(beat_num % 255, 0, 0)).save(
        sketches_dir / f"beat_{suffix}.png"
    )


class _UsageMeter:
    def __init__(self):
        self.reserve_calls: list[dict] = []
        self.confirm_calls: list[tuple[str, dict | None]] = []
        self.refund_calls: list[tuple[str, dict | None]] = []
        self.contexts: list[dict] = []
        self.clear_count = 0

    async def reserve_feature_start_credits(self, **kwargs):
        self.reserve_calls.append(kwargs)
        return {
            "id": "feature-reservation-1",
            "cost": 7,
            "reserved": True,
            "feature_key": kwargs["feature_key"],
        }

    async def confirm_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata=None,
    ):
        self.confirm_calls.append((reservation_id, metadata))

    async def refund_feature_credit_reservation(
        self,
        reservation_id: str,
        *,
        metadata=None,
    ):
        self.refund_calls.append((reservation_id, metadata))

    def set_llm_usage_context(
        self,
        user_id: str,
        project_id: str = "",
        resource_kind: str = "",
        billing_metadata: dict | None = None,
    ):
        self.contexts.append(
            {
                "user_id": user_id,
                "project_id": project_id,
                "resource_kind": resource_kind,
                "billing_metadata": billing_metadata or {},
            }
        )

    def clear_llm_usage_context(self):
        self.clear_count += 1


def _client(
    monkeypatch,
    tmp_path,
    store: _DetectStore,
    calls: list[int],
    *,
    usage_meter=None,
    ctx=None,
):
    from novelvideo.agents import global_video_optimizer
    from novelvideo.api.routes import generation

    async def fake_make_sqlite_store(username: str, project: str):
        assert username == "alice"
        assert project == "demo"
        return store

    async def fake_make_sqlite_store_for_context(context):
        assert context is ctx
        return store

    async def fake_detect_identities_by_ai(
        *,
        sketch_image_paths: list[str],
        color_identity_map: dict[str, str],
        total_beats: int,
    ):
        assert sketch_image_paths
        assert color_identity_map == {"#ff0000 RED": "Hero_Main"}
        calls.append(total_beats)
        return {1: ["Hero_Main"]}

    async def fake_resolve_generation_project(project: str, user: dict, required_role: str):
        assert project == "demo"
        assert user == {"username": "alice"}
        assert required_role == "editor"
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            ctx=ctx,
        )

    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve_generation_project)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation,
        "make_sqlite_store_for_context",
        fake_make_sqlite_store_for_context,
    )
    if usage_meter is not None:
        monkeypatch.setattr(generation, "get_usage_meter", lambda: usage_meter)
    monkeypatch.setattr(
        global_video_optimizer,
        "detect_identities_by_ai",
        fake_detect_identities_by_ai,
    )

    app = FastAPI()
    app.include_router(generation.router, prefix="/api/v1")
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    return TestClient(app)


def test_detect_identities_accepts_single_sketch(monkeypatch, tmp_path):
    store = _DetectStore([{"beat_number": 1, "visual_description": "{{Hero_Main}}"}])
    calls: list[int] = []
    _write_sketch(tmp_path, 1)
    client = _client(monkeypatch, tmp_path, store, calls)

    response = client.post(
        "/api/v1/projects/demo/episodes/1/sketches/detect-identities"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert calls == [1]
    assert body["data"]["identity_detections"] == {"1": ["Hero_Main"]}
    assert store.identity_writes == {1: ["Hero_Main"]}


def test_detect_identities_reserves_feature_credit_and_marks_model_calls_included(
    monkeypatch,
    tmp_path,
):
    store = _DetectStore([{"beat_number": 1, "visual_description": "{{Hero_Main}}"}])
    calls: list[int] = []
    usage_meter = _UsageMeter()
    ctx = SimpleNamespace(project_id="project-1", requester_user_id="user-1")
    _write_sketch(tmp_path, 1)
    client = _client(
        monkeypatch,
        tmp_path,
        store,
        calls,
        usage_meter=usage_meter,
        ctx=ctx,
    )

    response = client.post(
        "/api/v1/projects/demo/episodes/1/sketches/detect-identities"
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert usage_meter.reserve_calls == [
        {
            "user_id": "user-1",
            "feature_key": "ai_identity_detection",
            "project_id": "project-1",
            "resource_kind": "sketch",
            "task_type": "ai_identity_detection",
            "metadata": {
                "source": "sync_api",
                "endpoint": "detect_sketch_identities",
                "episode": 1,
                "sketch_count": 1,
            },
            "require_price_rule": True,
            "require_positive_cost": True,
        }
    ]
    assert usage_meter.contexts[0]["billing_metadata"][
        "model_call_credit_policy"
    ] == "feature_included"
    assert usage_meter.contexts[0]["billing_metadata"][
        "feature_credit_reservation_id"
    ] == "feature-reservation-1"
    assert usage_meter.confirm_calls[0][0] == "feature-reservation-1"
    assert usage_meter.refund_calls == []
    assert usage_meter.clear_count == 1


def test_detect_identities_refunds_feature_credit_when_ai_detection_fails(
    monkeypatch,
    tmp_path,
):
    from novelvideo.agents import global_video_optimizer

    store = _DetectStore([{"beat_number": 1, "visual_description": "{{Hero_Main}}"}])
    usage_meter = _UsageMeter()
    _write_sketch(tmp_path, 1)
    client = _client(
        monkeypatch,
        tmp_path,
        store,
        [],
        usage_meter=usage_meter,
        ctx=SimpleNamespace(project_id="project-1", requester_user_id="user-1"),
    )

    async def fake_failed_detect_identities_by_ai(**kwargs):
        raise RuntimeError("vision model failed")

    monkeypatch.setattr(
        global_video_optimizer,
        "detect_identities_by_ai",
        fake_failed_detect_identities_by_ai,
    )

    response = client.post("/api/v1/projects/demo/episodes/1/sketches/detect-identities")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "vision model failed" in body["error"]
    assert usage_meter.confirm_calls == []
    assert usage_meter.refund_calls[0][0] == "feature-reservation-1"
    assert usage_meter.clear_count == 1


def test_detect_identities_accepts_unpadded_nicegui_sketch(monkeypatch, tmp_path):
    store = _DetectStore([{"beat_number": 1, "visual_description": "{{Hero_Main}}"}])
    calls: list[int] = []
    _write_sketch(tmp_path, 1, padded=False)
    client = _client(monkeypatch, tmp_path, store, calls)

    response = client.post("/api/v1/projects/demo/episodes/1/sketches/detect-identities")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert calls == [1]
    assert body["data"]["identity_detections"] == {"1": ["Hero_Main"]}


def test_detect_identities_falls_back_to_script_sketch_colors(monkeypatch, tmp_path):
    store = _DetectStore(
        [{"beat_number": 1, "visual_description": "{{Hero_Main}}"}],
        sketch_colors={},
        script_sketch_colors={"Hero_Main": "#ff0000 RED"},
    )
    calls: list[int] = []
    _write_sketch(tmp_path, 1)
    client = _client(monkeypatch, tmp_path, store, calls)

    response = client.post("/api/v1/projects/demo/episodes/1/sketches/detect-identities")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert calls == [1]
    assert body["data"]["identity_detections"] == {"1": ["Hero_Main"]}


def test_detect_identities_batches_more_than_twenty_five_sketches(monkeypatch, tmp_path):
    beats = [
        {"beat_number": beat_num, "visual_description": "{{Hero_Main}}"}
        for beat_num in range(1, 27)
    ]
    store = _DetectStore(beats)
    calls: list[int] = []
    for beat_num in range(1, 27):
        _write_sketch(tmp_path, beat_num)
    client = _client(monkeypatch, tmp_path, store, calls)

    response = client.post("/api/v1/projects/demo/episodes/1/sketches/detect-identities")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert calls == [25, 1]
    assert body["data"]["identity_detections"]["1"] == ["Hero_Main"]
    assert body["data"]["identity_detections"]["26"] == ["Hero_Main"]
    assert body["data"]["identity_detections"]["2"] == ["__NO_CHARACTER__"]
    assert len(body["data"]["identity_detections"]) == 26
    assert store.identity_writes[1] == ["Hero_Main"]
    assert store.identity_writes[26] == ["Hero_Main"]
    assert store.identity_writes[2] == ["__NO_CHARACTER__"]


def test_detect_identities_marks_empty_ai_result_as_no_character_and_no_prop(
    monkeypatch, tmp_path
):
    from novelvideo.agents import global_video_optimizer

    store = _DetectStore([{"beat_number": 1, "visual_description": ""}])
    calls: list[int] = []
    _write_sketch(tmp_path, 1)
    client = _client(monkeypatch, tmp_path, store, calls)

    async def fake_empty_detect_identities_by_ai(**kwargs):
        calls.append(kwargs["total_beats"])
        return {1: []}

    monkeypatch.setattr(
        global_video_optimizer,
        "detect_identities_by_ai",
        fake_empty_detect_identities_by_ai,
    )

    response = client.post("/api/v1/projects/demo/episodes/1/sketches/detect-identities")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["identity_detections"] == {"1": ["__NO_CHARACTER__"]}
    assert body["data"]["prop_detections"] == {"1": ["__NO_PROP__"]}
    assert "核对" in body["data"]["review_message"]
    assert store.identity_writes == {1: ["__NO_CHARACTER__"]}
    assert store.prop_writes == {1: ["__NO_PROP__"]}


def test_detect_identities_marks_missing_ai_panel_result_as_no_character_and_no_prop(
    monkeypatch, tmp_path
):
    from novelvideo.agents import global_video_optimizer

    store = _DetectStore([{"beat_number": 1, "visual_description": ""}])
    _write_sketch(tmp_path, 1)
    client = _client(monkeypatch, tmp_path, store, [])

    async def fake_missing_detect_identities_by_ai(**kwargs):
        return {}

    monkeypatch.setattr(
        global_video_optimizer,
        "detect_identities_by_ai",
        fake_missing_detect_identities_by_ai,
    )

    response = client.post("/api/v1/projects/demo/episodes/1/sketches/detect-identities")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["identity_detections"] == {"1": ["__NO_CHARACTER__"]}
    assert body["data"]["prop_detections"] == {"1": ["__NO_PROP__"]}
    assert store.identity_writes == {1: ["__NO_CHARACTER__"]}
    assert store.prop_writes == {1: ["__NO_PROP__"]}

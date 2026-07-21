from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.models import CharacterIdentity, NovelCharacter
from novelvideo.models import NO_CHARACTER_MARKER
from novelvideo.project_context import ProjectContext

pytestmark = pytest.mark.m09


_PROJECT = "demo"
_PROJECT_ID = "proj_m09"
_USER = "alice"
_IDENTITY = "hero_young"
_SCENE = "alley"
_PROP = "umbrella"


_M09_OPERATIONS = {
    ("GET", "/api/v1/projects/{project}/video-backends"),
    ("GET", "/api/v1/projects/{project}/render-settings"),
    ("PATCH", "/api/v1/projects/{project}/render-settings"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/videos/compose"),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/final"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/render/plan"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/render/execute"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/render/upload"),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/export/srt"),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/export/video"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/export/zip"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/video"),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/video-pool"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/video-pool-select"),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2-status"),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2/assets/upload",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2/assets/delete",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2/assets/crop",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/seedance2/assets/audio-trim",
    ),
    (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/optimize/video-global/billing-quote",
    ),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/optimize/video-global"),
    ("GET", "/api/v1/projects/{project}/assets/{asset_type}/{asset_id}/references"),
    ("GET", "/api/v1/projects/{project}/media/{file_path}"),
}


def _png_bytes() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color=(40, 80, 120)).save(buf, format="PNG")
    return buf.getvalue()


class _M09Store:
    def __init__(self):
        identity = CharacterIdentity(
            identity_id=_IDENTITY,
            character_name="Hero",
            identity_name="young",
            appearance_details="blue coat",
            face_prompt="clear eyes",
        )
        character = NovelCharacter(
            name="Hero",
            role="lead",
            is_main=True,
            face_prompt="clear eyes",
            description="lead",
        )
        character.identities = [identity]
        self.characters = [character]
        self.beats = [
            {
                "episode_number": 1,
                "beat_number": 1,
                "visual_description": "Hero walks through the alley.",
                "narration_segment": "Footsteps echo.",
                "video_prompt": "A cinematic alley shot.",
                "video_mode": "first_frame",
                "scene_ref": {"scene_id": _SCENE},
                "detected_identities": [NO_CHARACTER_MARKER],
                "detected_props": [],
                "seedance2_config_json": "{}",
            },
            {
                "episode_number": 1,
                "beat_number": 2,
                "visual_description": "Hero turns back.",
                "narration_segment": "The rain slows.",
                "video_prompt": "A close shot in rain.",
                "video_mode": "first_frame",
                "scene_ref": {"scene_id": _SCENE},
                "detected_identities": [NO_CHARACTER_MARKER],
                "detected_props": [],
                "seedance2_config_json": "{}",
            },
        ]

    def get_all_characters(self):
        return list(self.characters)

    def get_sketch_colors(self, episode: int):
        assert episode == 1
        return {}

    def get_episode(self, episode: int):
        assert episode == 1
        return None

    def get_cached_prop(self, _prop_id: str):
        return None

    async def get_beats_as_dicts(self, episode: int):
        assert episode == 1
        return [dict(beat) for beat in self.beats]

    async def list_visual_beats(self):
        return [
            SimpleNamespace(
                episode_number=1,
                beat_number=1,
                scene_id=_SCENE,
                detected_identities_json=json.dumps([_IDENTITY]),
                detected_props_json=json.dumps([_PROP]),
            )
        ]

    async def update_beat_asset(self, **_kwargs):
        return True

    async def close(self):
        return None


class _FakeTaskBackend:
    def __init__(self, backend: str):
        self.backend = backend
        self.calls: list[dict] = []
        self.queued: list[dict] = []

    async def enqueue_project_task(self, ctx, **kwargs):
        self.calls.append({"ctx": ctx, **kwargs})
        task_type = kwargs["task_type"]
        queue_kind = kwargs.get("queue_kind") or "default"
        queue = "inline" if self.backend == "inline" else f"node.{ctx.home_node_id}.{queue_kind}"
        task_id = f"task-{self.backend}-{task_type}-{len(self.calls)}"
        queued = {
            "task_id": task_id,
            "task_key": f"task:{task_type}:project:{ctx.project_id}:{kwargs.get('episode', 0)}",
            "backend": self.backend,
            "queue": queue,
        }
        self.queued.append({"task_type": task_type, **queued})
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=task_id),
            backend=self.backend,
            queue=queue,
        )


class _FakeCreditQuote:
    async def generation_credit_quote(self, *, kind, model, params, quantity):
        assert kind == "feature"
        assert model == "mainline.beat_video_prompt"
        assert params == {}
        return SimpleNamespace(
            total_cost=6 * quantity,
            display=str(6 * quantity),
            unit="call",
            unit_cost=6,
            quantity=quantity,
        )


@pytest.fixture()
def m09_client_factory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from novelvideo.api import auth as api_auth
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import assets, files, generation
    from novelvideo.generators.video_pool_indexer import add_video_to_pool
    from novelvideo.seedance2_i2v import panel_service

    store = _M09Store()
    project_dir = tmp_path / "output" / _USER / _PROJECT
    state_dir = tmp_path / "state" / _USER / _PROJECT
    runtime_dir = tmp_path / "runtime" / _USER / _PROJECT
    for path in (project_dir, state_dir, runtime_dir):
        path.mkdir(parents=True, exist_ok=True)

    for rel in (
        "frames/ep001/beat_01.png",
        "frames/ep001/beat_02.png",
        "sketches/ep001/beat_01.png",
        "sketches/ep001/beat_02.png",
        "grids/ep001/grid_01.png",
    ):
        target = project_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_png_bytes())
    for rel, content in (
        ("audio/ep001/beat_01.mp3", b"audio"),
        ("videos/beats/ep001/beat_01.mp4", b"beat-video"),
        ("videos/episodes/ep001_final.mp4", b"final-video"),
        ("media/existing.mp4", b"media-video"),
        ("seedance2_uploads/ep001/beat_01/images/ref.png", _png_bytes()),
        ("seedance2_uploads/ep001/beat_01/audios/ref.wav", b"audio"),
    ):
        target = project_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    pool_entry = add_video_to_pool(
        project_dir / "videos" / "beats" / "ep001",
        1,
        1,
        project_dir / "videos" / "beats" / "ep001" / "beat_01.mp4",
        backend="mock",
        prompt="pool prompt",
    )

    ctx = ProjectContext(
        project_id=_PROJECT_ID,
        project_name=_PROJECT,
        owner_type="user",
        owner_id="user-alice",
        owner_username=_USER,
        requester_user_id="user-alice",
        requester_username=_USER,
        requester_principals=(("user", "user-alice"),),
        effective_role="owner",
        home_node_id="local",
        output_dir=project_dir,
        state_dir=state_dir,
        runtime_dir=runtime_dir,
        is_home_node=True,
    )
    resolution = ProjectResolution(
        ctx=ctx,
        username=_USER,
        project_name=_PROJECT,
        project_dir=project_dir,
        output_dir=str(project_dir),
        state_dir=str(state_dir),
        runtime_dir=str(runtime_dir),
    )

    async def resolve_project_scope(project: str, user: dict, *, required_role: str = "viewer"):
        assert project == _PROJECT
        return resolution

    async def resolve_generation_project(project: str, user: dict, required_role: str = "viewer"):
        assert project == _PROJECT
        return resolution

    async def make_store_for_context(_ctx):
        return store

    async def make_store(username: str, project: str):
        assert username == _USER
        assert project == _PROJECT
        return store

    async def character_map(*_args, **_kwargs):
        return {}

    async def audio_duration(*_args, **_kwargs):
        return 4.0

    async def srt_duration(*_args, **_kwargs):
        return 5.0

    async def save_seedance2_uploaded_asset(**_kwargs):
        return project_dir / "seedance2_uploads" / "ep001" / "beat_01" / "images" / "uploaded.png"

    async def remove_seedance2_uploaded_asset(**_kwargs):
        return True

    async def crop_seedance2_asset_to_reference(**_kwargs):
        return project_dir / "seedance2_uploads" / "ep001" / "beat_01" / "images" / "crop.png"

    async def trim_seedance2_audio_to_reference(**_kwargs):
        return project_dir / "seedance2_uploads" / "ep001" / "beat_01" / "audios" / "trim.wav"

    monkeypatch.setattr(generation, "_resolve_generation_project", resolve_generation_project)
    monkeypatch.setattr(generation, "make_sqlite_store_for_context", make_store_for_context)
    monkeypatch.setattr(generation, "make_sqlite_store", make_store)
    monkeypatch.setattr(generation, "_build_character_map", character_map)
    monkeypatch.setattr(generation, "_api_audio_duration_seconds", audio_duration)
    monkeypatch.setattr(generation, "load_project_config", lambda *_: {})
    monkeypatch.setattr(generation, "save_project_config", lambda *_, **__: None)
    monkeypatch.setattr(generation, "get_credit_quote", lambda: _FakeCreditQuote())
    monkeypatch.setattr(
        generation,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )
    monkeypatch.setattr(
        generation,
        "_seedance2_status_response",
        lambda **_: {"ok": True, "data": {"beat_num": 1, "assets": {"items": []}}},
    )
    monkeypatch.setattr(panel_service, "save_seedance2_uploaded_asset", save_seedance2_uploaded_asset)
    monkeypatch.setattr(panel_service, "remove_seedance2_uploaded_asset", remove_seedance2_uploaded_asset)
    monkeypatch.setattr(panel_service, "crop_seedance2_asset_to_reference", crop_seedance2_asset_to_reference)
    monkeypatch.setattr(panel_service, "trim_seedance2_audio_to_reference", trim_seedance2_audio_to_reference)

    monkeypatch.setattr(files, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(assets, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(assets, "make_sqlite_store_for_context", make_store_for_context)
    monkeypatch.setattr(assets, "get_project_dir", lambda username, project: project_dir, raising=False)
    monkeypatch.setattr(assets, "make_sqlite_store", make_store, raising=False)

    from novelvideo.export import episode_export

    monkeypatch.setattr(episode_export, "get_audio_duration_async", srt_duration)

    def build(backend: str = "inline"):
        task_backend = _FakeTaskBackend(backend)
        monkeypatch.setattr(generation, "get_task_backend", lambda tb=task_backend: tb)
        app = FastAPI()
        app.include_router(generation.router, prefix="/api/v1")
        app.include_router(assets.router, prefix="/api/v1")
        app.include_router(files.router, prefix="/api/v1")
        user = {
            "id": "local",
            "user_id": "local",
            "username": _USER,
            "role": "owner",
        }
        for dep in (
            api_auth.get_api_user,
            generation.get_api_user,
            assets.get_api_user,
            files.get_api_user,
        ):
            app.dependency_overrides[dep] = lambda user=user: user
        return TestClient(app), task_backend, project_dir, pool_entry.id

    return build


def _assert_ok(response):
    assert response.status_code == 200
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        payload = response.json()
        assert payload["ok"] is True
        return payload
    assert response.content
    return {"ok": True}


def _assert_task_payload(payload: dict, *, backend: str, task_type: str):
    assert payload["ok"] is True
    assert payload["task_type"] == task_type
    assert payload["task_id"]
    assert payload["task_key"]
    assert payload["backend"] == backend
    assert "queue" in payload
    assert "celery_id" not in payload


def test_m09_openapi_exposes_all_23_owned_operations(m09_client_factory):
    client, _task_backend, _project_dir, _pool_id = m09_client_factory("inline")
    spec = client.get("/openapi.json").json()
    actual = {
        (method.upper(), path)
        for path, methods in spec["paths"].items()
        for method in methods
        if method.lower() in {"get", "post", "patch", "delete"}
    }

    assert len(_M09_OPERATIONS) == 23
    assert not sorted(_M09_OPERATIONS - actual)


def test_m09_l2_exercises_all_23_endpoint_contracts(m09_client_factory):
    client, _task_backend, _project_dir, pool_id = m09_client_factory("inline")
    png = _png_bytes()

    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/video-backends"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/render-settings"))
    _assert_ok(
        client.patch(
            f"/api/v1/projects/{_PROJECT}/render-settings",
            json={"render_image_selection": "newapi_nanobanana2", "sketch_aspect_padding": True},
        )
    )
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/videos/compose", json={}))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/final"))

    plan_payload = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/render/plan",
            json={"beat_indices": [1], "strategy": "naive", "aspect_mode": "9:16"},
        )
    )
    plan_data = plan_payload["data"]
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/render/execute",
            json={
                "plan": plan_data["plan"],
                "plan_hash": plan_data["plan_hash"],
                "input_fingerprint": plan_data["input_fingerprint"],
                "strategy": "naive",
                "aspect_mode": "9:16",
                "beat_indices": [1],
            },
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/render/upload",
            files={"file": ("frame.png", png, "image/png")},
        )
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/export/srt"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/export/video"))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/export/zip"))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/video", json={}))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/video-pool"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/video-pool-select",
            json={"pool_id": pool_id},
        )
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/seedance2-status"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/seedance2/assets/upload",
            files={"file": ("ref.png", png, "image/png")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/seedance2/assets/delete",
            json={
                "media_kind": "images",
                "path": "seedance2_uploads/ep001/beat_01/images/ref.png",
            },
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/seedance2/assets/crop",
            json={
                "asset_key": "manual:image",
                "source_path": "seedance2_uploads/ep001/beat_01/images/ref.png",
                "width": 1,
                "height": 1,
            },
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/seedance2/assets/audio-trim",
            json={
                "asset_key": "manual:audio",
                "source_path": "seedance2_uploads/ep001/beat_01/audios/ref.wav",
            },
        )
    )
    _assert_ok(
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/optimize/video-global", json={})
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/assets/identity/{_IDENTITY}/references"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/media/media/existing.mp4"))


@pytest.mark.parametrize("backend", ["inline", "celery"])
def test_m09_task_backend_responses_are_ce_ee_isomorphic(m09_client_factory, backend: str):
    client, task_backend, _project_dir, _pool_id = m09_client_factory(backend)

    single_video = _assert_ok(
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/video", json={})
    )
    _assert_task_payload(single_video, backend=backend, task_type="single_video")

    plan_data = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/render/plan",
            json={"beat_indices": [1], "strategy": "naive", "aspect_mode": "9:16"},
        )
    )["data"]
    execute_payload = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/render/execute",
            json={
                "plan": plan_data["plan"],
                "plan_hash": plan_data["plan_hash"],
                "input_fingerprint": plan_data["input_fingerprint"],
                "strategy": "naive",
                "aspect_mode": "9:16",
                "beat_indices": [1],
            },
        )
    )
    assert execute_payload["data"]["task_ids"]
    selected = [item for item in task_backend.queued if item["task_type"] == "selected_regen"]
    assert selected
    for queued in selected:
        assert queued["task_id"]
        assert queued["backend"] == backend
        assert "queue" in queued
        assert "celery_id" not in queued

    compose = _assert_ok(
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/videos/compose", json={})
    )
    _assert_task_payload(compose, backend=backend, task_type="compose_episode")


@pytest.mark.parametrize("backend", ["inline", "celery"])
def test_global_video_prompt_batch_bills_existing_sketches(
    m09_client_factory,
    backend: str,
):
    client, task_backend, _project_dir, _pool_id = m09_client_factory(backend)

    quote = _assert_ok(
        client.get(
            f"/api/v1/projects/{_PROJECT}/episodes/1/optimize/video-global/billing-quote"
        )
    )
    assert quote["data"]["beat_numbers"] == [1, 2]
    assert quote["data"]["quantity"] == 2
    assert quote["data"]["unit_cost"] == 6
    assert quote["data"]["cost"] == 12
    assert quote["data"]["display"] == "12"

    response = _assert_ok(
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/optimize/video-global", json={})
    )

    _assert_task_payload(response, backend=backend, task_type="global_optimize_video")
    call = next(
        call for call in reversed(task_backend.calls) if call["task_type"] == "global_optimize_video"
    )
    assert call["payload"]["billing"]["items"] == 2
    assert call["payload"]["billing"]["beat_numbers"] == [1, 2]
    assert call["payload"]["beat_numbers"] == [1, 2]


def test_m09_render_execute_rejects_stale_fingerprint_and_plan_hash(m09_client_factory):
    client, _task_backend, _project_dir, _pool_id = m09_client_factory("inline")
    plan_data = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/render/plan",
            json={"beat_indices": [1], "strategy": "naive", "aspect_mode": "9:16"},
        )
    )["data"]
    body = {
        "plan": plan_data["plan"],
        "plan_hash": plan_data["plan_hash"],
        "input_fingerprint": "stale-fingerprint",
        "strategy": "naive",
        "aspect_mode": "9:16",
        "beat_indices": [1],
    }

    response = client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/render/execute", json=body)

    assert response.status_code == 409
    assert response.json()["error"] == "input_stale"

    body["input_fingerprint"] = plan_data["input_fingerprint"]
    body["plan_hash"] = "stale-plan"
    response = client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/render/execute", json=body)

    assert response.status_code == 409
    assert response.json()["error"] == "plan_stale"


def test_m09_media_rejects_traversal_reports_missing_and_serves_existing(m09_client_factory):
    client, _task_backend, _project_dir, _pool_id = m09_client_factory("inline")

    assert client.get(f"/api/v1/projects/{_PROJECT}/media/%2E%2E%2Fsecret.txt").status_code == 403
    assert client.get(f"/api/v1/projects/{_PROJECT}/media/missing.mp4").status_code == 404
    existing = client.get(f"/api/v1/projects/{_PROJECT}/media/media/existing.mp4")
    assert existing.status_code == 200
    assert existing.content == b"media-video"


def test_m09_asset_references_reject_invalid_type_and_empty_id(m09_client_factory):
    client, _task_backend, _project_dir, _pool_id = m09_client_factory("inline")

    invalid_type = client.get(f"/api/v1/projects/{_PROJECT}/assets/unknown/{_IDENTITY}/references")
    assert invalid_type.status_code == 200
    assert invalid_type.json()["ok"] is False
    assert "Unsupported asset type" in invalid_type.json()["error"]

    empty_id = client.get(f"/api/v1/projects/{_PROJECT}/assets/identity/%20/references")
    assert empty_id.status_code == 200
    assert empty_id.json()["ok"] is False
    assert empty_id.json()["error"] == "Asset id is required"

    scene = _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/assets/scene/{_SCENE}/references"))
    assert scene["data"]["beats"] == [{"episode": 1, "beat_number": 1}]
    assert scene["data"]["co_identities"] == [_IDENTITY]
    assert scene["data"]["co_props"] == [_PROP]

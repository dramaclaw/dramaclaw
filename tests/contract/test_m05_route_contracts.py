from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.models import NO_CHARACTER_MARKER, NovelScene

pytestmark = pytest.mark.m05


_PROJECT = "demo"
_SCENE = "中庭"
_DERIVED_SCENE = "中庭_雨夜"

M05_EXPECTED_OPERATIONS = {
    ("GET", "/api/v1/projects/{project}/scenes"),
    ("GET", "/api/v1/projects/{project}/scenes/plate-preview"),
    ("GET", "/api/v1/projects/{project}/scenes/{name}/pano/manifest"),
    ("PATCH", "/api/v1/projects/{project}/scenes/{name}/pano/correction"),
    ("GET", "/api/v1/projects/{project}/scenes/{name}/director-stage/manifest"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/director-stage/world"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/director-stage/world/clear"),
    ("POST", "/api/v1/projects/{project}/scenes"),
    ("PATCH", "/api/v1/projects/{project}/scenes/{name}"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/delete"),
    ("POST", "/api/v1/projects/{project}/scenes/build"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/master/upload"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/master/delete"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/master/generate-async"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/reverse/generate-async"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/pano/upload"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/pano/delete"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/custom/upload"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/custom/delete"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/3gs/master-ply/generate-async"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/3gs/reverse-ply/generate-async"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/3gs/pano-ply/generate-async"),
    ("POST", "/api/v1/projects/{project}/scenes/{name}/pano/generate-async"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/scenes/plan"),
    ("GET", "/api/v1/projects/{project}/sketch-settings"),
    ("PATCH", "/api/v1/projects/{project}/sketch-settings"),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/sketch-regen-queue"),
    ("PUT", "/api/v1/projects/{project}/episodes/{episode_num}/sketch-regen-queue"),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/sketch-image-usage"),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/image-generation-guard"),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/image-generation-guard/verify-password",
    ),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/sketches/generate"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/render/plan"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/render/execute"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/beats/regenerate"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/sketches/regenerate"),
    (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/pano-background/manifest",
    ),
    (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch-candidates",
    ),
    ("GET", "/api/v1/projects/{project}/director-stage/palette"),
    (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-stage/manifest",
    ),
    (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-stage/overlay",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-stage/overlay",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-stage/control-frame",
    ),
    (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/background-anchors",
    ),
    (
        "PATCH",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/background-anchor",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/background-anchor/crop",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/background-anchor/upload",
    ),
    (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-control-frame",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/director-control-to-sketch",
    ),
    (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch/pose-editor",
    ),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch/pose-editor",
    ),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch/crop"),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/sketches/generate-missing-manual",
    ),
    ("GET", "/api/v1/projects/{project}/episodes/{episode_num}/grids"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/grids/rebuild-pool"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/pool-select"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch/upload"),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/render/upload"),
    (
        "POST",
        "/api/v1/projects/{project}/episodes/{episode_num}/grids/{grid_index}/sketch-preview",
    ),
    ("POST", "/api/v1/projects/{project}/episodes/{episode_num}/verify/sketch-edit-execute/start"),
}


def _png_bytes(width: int = 2, height: int = 2, color: tuple[int, int, int] = (30, 60, 90)) -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=color).save(buf, format="PNG")
    return buf.getvalue()


def _data_url() -> str:
    return f"data:image/png;base64,{base64.b64encode(_png_bytes()).decode('ascii')}"


class _M05Store:
    def __init__(self):
        self.resolved_roles: list[tuple[str, str]] = []
        self.scenes = {
            _SCENE: NovelScene(
                name=_SCENE,
                scene_type="exterior",
                environment_prompt="青石中庭，雨后积水。",
                description="庭院",
            ),
            _DERIVED_SCENE: NovelScene(
                name=_DERIVED_SCENE,
                scene_type="exterior",
                base_scene_id=_SCENE,
                variant_id="雨夜",
                environment_prompt="",
            ),
        }
        self.sketch_colors = {NO_CHARACTER_MARKER: "#999999"}
        self.beats = [
            {
                "beat_number": 1,
                "episode_number": 1,
                "narration_segment": "雨落中庭。",
                "visual_description": "空镜，中庭雨水泛光。",
                "detected_identities": [NO_CHARACTER_MARKER],
                "scene_ref": {"scene_id": _SCENE},
                "location": _SCENE,
                "time_of_day": "夜晚",
                "is_manual_shot": False,
            },
            {
                "beat_number": 2,
                "episode_number": 1,
                "narration_segment": "补拍雨声。",
                "visual_description": "手工补拍镜头。",
                "detected_identities": [NO_CHARACTER_MARKER],
                "scene_ref": {"scene_id": _SCENE},
                "location": _SCENE,
                "time_of_day": "夜晚",
                "is_manual_shot": True,
            },
        ]

    async def list_scenes(self):
        return list(self.scenes.values())

    async def get_scene(self, name: str):
        return self.scenes.get(name)

    async def add_scene(self, scene: NovelScene):
        self.scenes[scene.name] = scene

    async def update_scene(self, name: str, **updates):
        scene = self.scenes[name]
        for key, value in updates.items():
            setattr(scene, key, value)
        return True

    async def rename_scene(self, old_name: str, new_name: str):
        scene = self.scenes.pop(old_name)
        scene.name = new_name
        self.scenes[new_name] = scene
        return True

    async def delete_scene(self, name: str):
        return self.scenes.pop(name, None) is not None

    def get_all_characters(self):
        return []

    async def get_beats_as_dicts(self, episode: int):
        assert episode == 1
        return [dict(beat) for beat in self.beats]

    async def get_script_as_dict(self, episode: int):
        assert episode == 1
        return {"beats": [dict(beat) for beat in self.beats], "sketch_colors": self.sketch_colors}

    def get_sketch_colors(self, episode: int):
        assert episode == 1
        return dict(self.sketch_colors)

    async def set_sketch_colors(self, episode: int, colors: dict):
        assert episode == 1
        self.sketch_colors = dict(colors)

    async def update_beat_asset(self, episode_number: int, beat_number: int, **updates):
        assert episode_number == 1
        for beat in self.beats:
            if beat["beat_number"] == beat_number:
                beat.update(updates)
                return True
        return False

    async def close(self):
        return None


class _FakeTaskBackend:
    def __init__(self, backend: str):
        self.backend = backend
        self.queue = "inline" if backend == "inline" else "default"
        self.calls: list[dict] = []

    async def enqueue_project_task(self, ctx, **kwargs):
        self.calls.append({"ctx": ctx, **kwargs})
        task_type = kwargs["task_type"]
        scope = kwargs.get("scope")
        suffix = f"-{scope}" if scope else ""
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=f"task-{self.backend}-{task_type}{suffix}"),
            backend=self.backend,
            queue=self.queue,
        )


@pytest.fixture()
def m05_client_factory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from novelvideo.api import auth as api_auth
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import episodes, generation, scenes
    from novelvideo.project_context import ProjectContext
    from novelvideo.verification import routes as verification_routes

    store = _M05Store()
    project_dir = tmp_path / "output" / "alice" / _PROJECT
    state_dir = tmp_path / "state" / "alice" / _PROJECT
    runtime_dir = tmp_path / "runtime" / "alice" / _PROJECT
    for path in (project_dir, state_dir, runtime_dir):
        path.mkdir(parents=True, exist_ok=True)
    (project_dir / "novel.txt").write_text("测试原文", encoding="utf-8")

    ctx = ProjectContext(
        project_id="proj_m05",
        project_name=_PROJECT,
        owner_type="user",
        owner_id="alice-id",
        owner_username="alice",
        requester_user_id="alice-id",
        requester_username="alice",
        requester_principals=[],
        effective_role="owner",
        home_node_id="local",
        output_dir=project_dir,
        state_dir=state_dir,
        runtime_dir=runtime_dir,
        is_home_node=True,
    )
    resolution = ProjectResolution(
        ctx=ctx,
        username="alice",
        project_name=_PROJECT,
        project_dir=project_dir,
        output_dir=str(project_dir),
        state_dir=str(state_dir),
        runtime_dir=str(runtime_dir),
    )

    async def resolve_scope(project: str, user: dict, *, required_role: str = "viewer"):
        assert project == _PROJECT
        store.resolved_roles.append(("generation", required_role))
        return resolution

    async def resolve_scene_project(project: str, user: dict, *, required_role: str = "editor"):
        assert project == _PROJECT
        store.resolved_roles.append(("scenes", required_role))
        return ctx, "alice", _PROJECT, project_dir, str(project_dir), store

    async def make_store_for_context(_ctx):
        return store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_scene_project)
    monkeypatch.setattr(generation, "_resolve_generation_project", resolve_scope)
    monkeypatch.setattr(generation, "make_sqlite_store_for_context", make_store_for_context)
    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_scope)
    monkeypatch.setattr(verification_routes, "resolve_project_scope", resolve_scope)
    monkeypatch.setattr(verification_routes, "get_task_backend", lambda: task_backend)
    monkeypatch.setattr(generation, "load_project_config", lambda *_: {})
    monkeypatch.setattr(generation, "save_project_config", lambda *_, **__: None)
    async def build_character_map(*_args, **_kwargs):
        return {
            "林昭": {
                "identity_sketch_colors": {"青年": "#3366FF"},
                "sketch_color": "#3366FF",
            },
            "林昭_青年": {
                "identity_sketch_colors": {"青年": "#3366FF"},
                "sketch_color": "#3366FF",
            },
        }

    async def runtime_prop_menu(*_args, **_kwargs):
        return []

    monkeypatch.setattr(generation, "_build_character_map", build_character_map)
    monkeypatch.setattr(generation, "_runtime_prop_menu_with_global_props", runtime_prop_menu)
    monkeypatch.setattr(generation, "_episode_from_store_or_none", lambda *_: None)
    monkeypatch.setattr(scenes, "load_project_config_file", lambda *_: {"visual_style": "cinematic"})
    monkeypatch.setattr(
        scenes,
        "build_pano_viewer_manifest",
        lambda **_: SimpleNamespace(model_dump=lambda **__: {"mode": "viewer", "scene_id": _SCENE}),
    )
    monkeypatch.setattr(
        scenes,
        "build_director_stage_manifest",
        lambda **_: SimpleNamespace(model_dump=lambda **__: {"mode": "stage", "scene_id": _SCENE}),
    )
    monkeypatch.setattr(
        generation,
        "build_pano_viewer_manifest",
        lambda **_: SimpleNamespace(model_dump=lambda **__: {"mode": "beat-pano", "scene_id": _SCENE}),
    )
    monkeypatch.setattr(
        generation,
        "build_director_stage_manifest",
        lambda **_: SimpleNamespace(model_dump=lambda **__: {"mode": "beat-stage", "scene_id": _SCENE}),
    )

    def static_url(_ctx, rel_path: str, local_path=None):
        return f"/static/projects/proj_m05/{rel_path}"

    monkeypatch.setattr(scenes, "make_static_url_for_context", static_url)
    monkeypatch.setattr(generation, "make_static_url_for_context", static_url)

    def build(backend: str = "inline"):
        nonlocal task_backend
        task_backend = _FakeTaskBackend(backend)
        monkeypatch.setattr(scenes, "get_task_backend", lambda: task_backend)
        monkeypatch.setattr(generation, "get_task_backend", lambda: task_backend)
        monkeypatch.setattr(episodes, "get_task_backend", lambda: task_backend)
        monkeypatch.setattr(verification_routes, "get_task_backend", lambda: task_backend)

        app = FastAPI()
        app.include_router(scenes.router, prefix="/api/v1")
        app.include_router(generation.router, prefix="/api/v1")
        app.include_router(episodes.router, prefix="/api/v1")
        app.include_router(verification_routes.router, prefix="/api/v1")
        user = {"id": "alice-id", "user_id": "alice-id", "username": "alice", "role": "owner"}
        for dep in (
            api_auth.get_api_user,
            scenes.get_api_user,
            generation.get_api_user,
            episodes.get_api_user,
            verification_routes.get_api_user,
        ):
            app.dependency_overrides[dep] = lambda user=user: user
        return TestClient(app), task_backend, project_dir, store

    task_backend = _FakeTaskBackend("inline")
    return build


def _assert_ok(response):
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True, payload
    return payload


def _assert_task_shape(payload: dict, *, backend: str, task_type: str):
    assert payload["ok"] is True
    assert payload["task_type"] == task_type
    assert payload["task_id"]
    assert payload["task_key"]
    assert payload["backend"] == backend
    assert payload["queue"] == ("inline" if backend == "inline" else "default")
    assert "celery_task_id" not in payload
    assert "celery_queue" not in payload


def _seed_labels(project_dir: Path) -> None:
    labels_dir = project_dir / "verify_reports" / "ep001"
    labels_dir.mkdir(parents=True, exist_ok=True)
    row = {
        "project_dir": str(project_dir),
        "episode_num": 1,
        "beat_number": 1,
        "execution_mode": "polish",
        "sketch_path": "sketches/ep001/beat_01.png",
        "beat": {"beat_number": 1},
        "sketch_colors": [],
        "result": {
            "decision": "revise",
            "main_problem": "composition_weak",
            "reasoning": "需要强化构图。",
            "edit_instruction": "Tighten the courtyard composition.",
            "confidence": 0.8,
        },
    }
    (labels_dir / "labels.jsonl").write_text(json.dumps(row, ensure_ascii=False) + "\n")


def _seed_stage_files(project_dir: Path) -> None:
    from novelvideo.director_world import stage_manifest
    from novelvideo.utils.path_resolver import canonical_scene_master_path

    master = canonical_scene_master_path(project_dir, _SCENE)
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(_png_bytes())
    reverse = master.with_name("reverse_master.png")
    reverse.write_bytes(_png_bytes())
    stage_dir = stage_manifest.stage_dir(project_dir, _SCENE)
    stage_dir.mkdir(parents=True, exist_ok=True)
    for name in ("pano_360.png", "master_sharp.ply", "reverse_sharp.ply", "pano_depth.ply"):
        (stage_dir / name).write_bytes(_png_bytes(4, 2) if name.endswith(".png") else b"ply")
    stage_manifest.update_manifest(
        project_dir,
        _SCENE,
        source="uploaded_360",
        pano_path="pano_360.png",
        ply_path="master_sharp.ply",
        master_ply_path="master_sharp.ply",
        reverse_ply_path="reverse_sharp.ply",
        pano_ply_path="pano_depth.ply",
    )


def test_m05_openapi_exposes_expected_operations(m05_client_factory):
    client, _backend, _project_dir, _store = m05_client_factory("inline")

    spec = client.get("/openapi.json").json()
    actual = {
        (method.upper(), path)
        for path, methods in spec["paths"].items()
        for method in methods
        if method.lower() in {"get", "post", "patch", "put", "delete"}
    }

    assert len(M05_EXPECTED_OPERATIONS) == 60
    assert not M05_EXPECTED_OPERATIONS - actual
    assert "/api/v1/projects/{project}/scenes/{name}/director-stage/world" in spec["paths"]
    assert "/api/v1/projects/{project}/scenes/{name}/director-stage/world/clear" in spec["paths"]


def test_m05_contract_requires_promoted_world_and_sketch_candidate_routes() -> None:
    assert len(M05_EXPECTED_OPERATIONS) == 60
    assert (
        "POST",
        "/api/v1/projects/{project}/scenes/{name}/director-stage/world",
    ) in M05_EXPECTED_OPERATIONS
    assert (
        "POST",
        "/api/v1/projects/{project}/scenes/{name}/director-stage/world/clear",
    ) in M05_EXPECTED_OPERATIONS
    assert (
        "GET",
        "/api/v1/projects/{project}/episodes/{episode_num}/beats/{beat_num}/sketch-candidates",
    ) in M05_EXPECTED_OPERATIONS


def test_scene_reference_generation_accepts_image_source_model(m05_client_factory):
    client, task_backend, _project_dir, _store = m05_client_factory("inline")

    payload = client.post(
        f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/master/generate-async",
        json={"model": "newapi_gpt_image2"},
    ).json()
    _assert_task_shape(
        payload,
        backend="inline",
        task_type="scene_reference_asset",
    )

    assert payload["ok"] is True
    assert task_backend.calls[-1]["payload"]["model"] == "newapi_gpt_image2"


def test_m05_l2_exercises_happy_path_route_contracts(m05_client_factory):
    client, _backend, project_dir, _store = m05_client_factory("inline")
    _seed_stage_files(project_dir)
    _seed_labels(project_dir)

    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/scenes"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/scenes/plate-preview"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/pano/manifest"))
    _assert_ok(
        client.patch(
            f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/pano/correction",
            json={"front_yaw_deg": 12.0, "sphere_correction_deg": {"yaw": 1, "pitch": 0, "roll": 0}},
        )
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/director-stage/manifest"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/scenes",
            json={"name": "廊下", "environment_prompt": "木质长廊"},
        )
    )
    _assert_ok(client.patch(f"/api/v1/projects/{_PROJECT}/scenes/廊下", json={"notes": "updated"}))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/scenes/廊下/delete"))
    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/scenes/build").json(),
        backend="inline",
        task_type="build_scenes",
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/master/upload",
            files={"file": ("master.png", _png_bytes(), "image/png")},
        )
    )
    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/master/generate-async").json(),
        backend="inline",
        task_type="scene_reference_asset",
    )
    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/reverse/generate-async").json(),
        backend="inline",
        task_type="scene_reference_asset",
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/pano/upload",
            files={"file": ("pano.png", _png_bytes(4, 2), "image/png")},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/custom/upload",
            files={"file": ("scene.sog", b"sog data", "application/octet-stream")},
        )
    )
    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/3gs/master-ply/generate-async").json(),
        backend="inline",
        task_type="stage_asset",
    )
    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/3gs/reverse-ply/generate-async").json(),
        backend="inline",
        task_type="stage_asset",
    )
    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/3gs/pano-ply/generate-async").json(),
        backend="inline",
        task_type="stage_asset",
    )
    _assert_task_shape(
        client.post(
            f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/pano/generate-async",
            json={"source": "text"},
        ).json(),
        backend="inline",
        task_type="stage_asset",
    )
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/custom/delete"))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/pano/delete"))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/master/delete"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/master/upload",
            files={"file": ("master.png", _png_bytes(), "image/png")},
        )
    )

    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/scenes/plan").json(),
        backend="inline",
        task_type="episode_scene_planner",
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/sketch-settings"))
    _assert_ok(client.patch(f"/api/v1/projects/{_PROJECT}/sketch-settings", json={}))
    queue_item = {
        "id": "q1",
        "modeKey": "1x1_2-3",
        "modeLabel": "1x1",
        "beatNumbers": [1],
        "sceneIds": [_SCENE],
        "createdAt": "2026-06-17T00:00:00Z",
    }
    _assert_ok(client.put(f"/api/v1/projects/{_PROJECT}/episodes/1/sketch-regen-queue", json={"items": [queue_item]}))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/sketch-regen-queue"))
    _assert_ok(
        client.get(
            f"/api/v1/projects/{_PROJECT}/episodes/1/image-generation-guard",
            params={"task_type": "sketch_grid", "scope": "grid_0"},
        )
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/sketch-image-usage"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/image-generation-guard/verify-password",
            json={"password": ""},
        )
    )
    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/sketches/generate", json={"grid_index": 0}).json(),
        backend="inline",
        task_type="sketch_generation",
    )
    _assert_task_shape(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/sketches/regenerate",
            json={"beat_indices": [1]},
        ).json(),
        backend="inline",
        task_type="sketch_regen",
    )
    manual = client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/sketches/generate-missing-manual").json()
    assert manual["ok"] is True
    assert manual["task_type"] == "sketch_regen"
    _assert_task_shape(
        client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/verify/sketch-edit-execute/start", json={}).json(),
        backend="inline",
        task_type="sketch_edit_execute",
    )

    plan = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/render/plan",
            json={"beat_indices": [1], "strategy": "naive", "aspect_mode": "9:16"},
        )
    )["data"]
    assert {"plan", "plan_hash", "input_fingerprint"} <= set(plan)
    executed = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/render/execute",
            json={
                "beat_indices": [1],
                "strategy": "naive",
                "aspect_mode": "9:16",
                "plan": plan["plan"],
                "plan_hash": plan["plan_hash"],
                "input_fingerprint": plan["input_fingerprint"],
            },
        )
    )["data"]
    assert executed["task_type"] == "render_plan"
    assert len(executed["task_ids"]) == 1
    assert executed["task_ids"][0].startswith("task-inline-selected_regen-1x1_2-3__")
    _assert_task_shape(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/regenerate",
            json={"beat_indices": [1]},
        ).json(),
        backend="inline",
        task_type="selected_regen",
    )

    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/pano-background/manifest"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/director-stage/palette"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/director-stage/manifest"))
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/director-stage/overlay"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/director-stage/overlay",
            json={"actors": [], "props": [], "stagings": []},
        )
    )
    control = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/director-stage/control-frame",
            json={
                "images": {"combined": _data_url(), "env_only": _data_url()},
                "frame_meta": {"camera": "wide"},
            },
        )
    )["data"]
    assert "combined" in control["rel_paths"]
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/director-control-frame"))
    _assert_task_shape(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/director-control-to-sketch"
        ).json(),
        backend="inline",
        task_type="sketch_generation",
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/background-anchors"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/background-anchor/upload",
            files={"file": ("background.png", _png_bytes(), "image/png")},
        )
    )
    _assert_ok(
        client.patch(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/background-anchor",
            json={"anchor_id": "selected_background"},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/background-anchor/crop",
            json={"anchor_id": "reverse", "x": 0, "y": 0, "width": 1, "height": 1},
        )
    )

    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/grids"))
    _assert_ok(client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/grids/rebuild-pool"))
    sketch_upload = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/sketch/upload",
            files={"file": ("sketch.png", _png_bytes(), "image/png")},
        )
    )["data"]
    frame_upload = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/render/upload",
            files={"file": ("frame.png", _png_bytes(color=(90, 30, 60)), "image/png")},
        )
    )["data"]
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/pool-select",
            json={"pool_id": sketch_upload["pool_id"], "force": True},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/pool-select",
            json={"pool_id": frame_upload["pool_id"]},
        )
    )
    _assert_ok(client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/sketch/pose-editor"))
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/sketch/pose-editor",
            json={"strokes": []},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/sketch/crop",
            json={"x": 0, "y": 0, "width": 1, "height": 1},
        )
    )
    _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/grids/0/sketch-preview",
            json={"rows": 1, "cols": 1, "beat_numbers": [1]},
        )
    )

    assert (project_dir / "sketches" / "ep001" / "beat_01.png").exists()
    assert (project_dir / "frames" / "ep001" / "beat_01.png").exists()
    assert (
        project_dir / "director_control_frames" / "ep001" / "beat_01" / "selected_background.png"
    ).exists()
    assert (project_dir / "director_control_frames" / "ep001" / "beat_01" / "combined.png").exists()
    assert (project_dir / "assets" / "scenes" / _SCENE / "master.png").exists()


def test_m05_negative_blocks_base_scene_delete_when_derived_scene_exists(m05_client_factory):
    client, _backend, _project_dir, _store = m05_client_factory("inline")

    response = client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/delete")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert "派生场景" in payload["error"]


def test_m05_ce_exposes_scene_director_world_openapi_and_http(m05_client_factory):
    client, _backend, project_dir, store = m05_client_factory("inline")
    _seed_stage_files(project_dir)

    spec = client.get("/openapi.json").json()

    assert "/api/v1/projects/{project}/scenes/{name}/director-stage/world" in spec["paths"]
    assert "/api/v1/projects/{project}/scenes/{name}/director-stage/world/clear" in spec["paths"]

    save = client.post(
        f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/director-stage/world",
        json={
            "active_source_id": "uploaded_360",
            "active_source": {"id": "uploaded_360", "kind": "pano"},
            "snapshot": {"world": {"activeSourceId": "uploaded_360"}, "nodes": []},
        },
    )
    saved = _assert_ok(save)["data"]
    assert saved["active_source_id"] == "uploaded_360"
    assert saved["scene"]["world"]["activeSourceId"] == "uploaded_360"
    assert saved["manifest"]["scene_id"] == _SCENE

    clear = client.post(f"/api/v1/projects/{_PROJECT}/scenes/{_SCENE}/director-stage/world/clear")
    cleared = _assert_ok(clear)["data"]
    assert cleared["active_source_id"] == ""
    assert cleared["scene"] is None
    assert cleared["scenes_by_source_id"] == {}
    assert ("scenes", "editor") in store.resolved_roles


def test_m05_scene_director_world_missing_scene_uses_ok_false_not_404(m05_client_factory):
    client, _backend, _project_dir, _store = m05_client_factory("inline")

    save = client.post(
        f"/api/v1/projects/{_PROJECT}/scenes/不存在/director-stage/world",
        json={
            "active_source_id": "uploaded_360",
            "snapshot": {"world": {"activeSourceId": "uploaded_360"}},
        },
    )
    clear = client.post(f"/api/v1/projects/{_PROJECT}/scenes/不存在/director-stage/world/clear")

    for response in (save, clear):
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is False
        assert "not found" in payload["error"]


def test_m05_sketch_candidates_is_viewer_and_empty_pool_is_ok(m05_client_factory):
    client, _backend, _project_dir, store = m05_client_factory("inline")

    response = client.get(f"/api/v1/projects/{_PROJECT}/episodes/1/beats/1/sketch-candidates")

    payload = _assert_ok(response)
    assert payload["data"] == {
        "episode": 1,
        "beat": 1,
        "current_sketch_url": "",
        "candidate_count": 0,
        "candidates": [],
    }
    assert ("generation", "viewer") in store.resolved_roles


def test_m05_negative_render_execute_rejects_stale_fingerprint(m05_client_factory):
    client, _backend, _project_dir, _store = m05_client_factory("inline")
    plan = _assert_ok(
        client.post(
            f"/api/v1/projects/{_PROJECT}/episodes/1/render/plan",
            json={"beat_indices": [1], "strategy": "naive", "aspect_mode": "9:16"},
        )
    )["data"]

    response = client.post(
        f"/api/v1/projects/{_PROJECT}/episodes/1/render/execute",
        json={
            "beat_indices": [1],
            "strategy": "naive",
            "aspect_mode": "9:16",
            "plan": plan["plan"],
            "plan_hash": plan["plan_hash"],
            "input_fingerprint": "stale",
        },
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error"] == "input_stale"
    assert {"new_plan", "new_plan_hash", "new_input_fingerprint"} <= set(payload["data"])


def test_m05_task_responses_are_ce_ee_isomorphic_without_celery_only_fields(m05_client_factory):
    for backend in ("inline", "celery"):
        client, task_backend, project_dir, _store = m05_client_factory(backend)
        _seed_stage_files(project_dir)
        _seed_labels(project_dir)

        cases = [
            ("episode_scene_planner", client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/scenes/plan")),
            ("sketch_generation", client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/sketches/generate", json={})),
            (
                "sketch_regen",
                client.post(
                    f"/api/v1/projects/{_PROJECT}/episodes/1/sketches/regenerate",
                    json={"beat_indices": [1]},
                ),
            ),
            (
                "selected_regen",
                client.post(
                    f"/api/v1/projects/{_PROJECT}/episodes/1/beats/regenerate",
                    json={"beat_indices": [1]},
                ),
            ),
            (
                "sketch_edit_execute",
                client.post(f"/api/v1/projects/{_PROJECT}/episodes/1/verify/sketch-edit-execute/start", json={}),
            ),
        ]

        for task_type, response in cases:
            assert response.status_code == 200
            _assert_task_shape(response.json(), backend=backend, task_type=task_type)

        assert [call["task_type"] for call in task_backend.calls] == [
            "episode_scene_planner",
            "sketch_generation",
            "sketch_regen",
            "selected_regen",
            "sketch_edit_execute",
        ]


def test_m05_acceptance_script_keeps_world_split_and_ee_assertions() -> None:
    script = Path("scripts/acceptance/checks/m05.sh").read_text(encoding="utf-8")

    assert "director-stage/world" in script
    assert "director-stage/world/clear" in script
    assert "CE OpenAPI 暴露 scene director-stage world/clear" in script
    assert "OpenAPI 暴露 M05 §1.5 实测 60 个 method/path 操作" in script
    assert "episode_scene_planner" in script
    assert '\"backend\"] == (\"inline\" if os.environ[\"MODE\"] == \"ce\" else \"celery\")' in script
    assert "selected_regen" in script

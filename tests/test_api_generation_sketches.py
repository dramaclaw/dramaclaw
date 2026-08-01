from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient


class _SketchStore:
    async def get_beats_as_dicts(self, episode_num: int):
        assert episode_num == 2
        return [
            {"beat_number": 1, "narration_segment": "a", "location": "A"},
            {"beat_number": 2, "narration_segment": "b", "location": "B"},
        ]

    def get_episode(self, episode_num: int):
        assert episode_num == 2
        return SimpleNamespace(prop_menu=[])

    def get_cached_prop(self, prop_id: str):
        return None

    def get_sketch_colors(self, episode_num: int):
        assert episode_num == 2
        return {"hero_main": "#ffffff"}


def _client(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.generators import nanobanana_grid
    from novelvideo.utils.path_resolver import PathResolver

    store = _SketchStore()
    clean_calls = []
    start_calls = []
    scene_split_calls = []

    async def fake_make_sqlite_store(username: str, project: str):
        assert username == "alice"
        assert project == "demo"
        return store

    async def fake_make_sqlite_store_for_context(ctx):
        assert ctx.project_id == "proj"
        return store

    async def fake_character_map(*args, **kwargs):
        return {"hero": {"identity_sketch_colors": {"hero_main": "#ffffff"}}}

    async def fake_prop_menu(*args, **kwargs):
        return []

    async def fake_enqueue_project_task(ctx, **kwargs):
        start_calls.append(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=f"task-{len(start_calls)}"),
            backend="celery",
            queue=kwargs.get("queue_kind") or "default",
        )

    def fake_clean_sketches(self):
        clean_calls.append(self)
        return []

    def fake_scene_split(beats, aspect_ratio="2:3"):
        scene_split_calls.append(aspect_ratio)
        return [
            {
                "rows": 1,
                "cols": 1,
                "mode_key": "1x1_2-3_sketch",
                "scene_id": "A",
                "beat_numbers": [1],
                "beats": [beats[0]],
            },
            {
                "rows": 1,
                "cols": 1,
                "mode_key": "1x1_2-3_sketch",
                "scene_id": "B",
                "beat_numbers": [2],
                "beats": [beats[1]],
            },
        ]

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=SimpleNamespace(project_id="proj", state_dir=tmp_path / "state"),
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(generation, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "_runtime_prop_menu_with_global_props", fake_prop_menu)
    monkeypatch.setattr(generation, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(PathResolver, "clean_sketches", fake_clean_sketches)
    monkeypatch.setattr(nanobanana_grid, "sketch_scene_grid_split", fake_scene_split)

    app = FastAPI()
    app.include_router(generation.router, prefix="/api/v1")
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}

    return TestClient(app), clean_calls, start_calls, scene_split_calls


def test_generate_sketches_grid_index_minus_one_dispatches_all_scene_grids(
    monkeypatch, tmp_path
):
    client, clean_calls, start_calls, _scene_split_calls = _client(monkeypatch, tmp_path)

    response = client.post(
        "/api/v1/projects/demo/episodes/2/sketches/generate",
        json={"grid_index": -1, "sketch_scene_grouping": True},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["task_type"] == "sketch_grid_generation"
    assert body["data"]["dispatched"] == 2
    assert body["data"]["scopes"] == ["grid_0", "grid_1"]
    assert len(clean_calls) == 1
    assert [call["payload"]["config"]["grid_index"] for call in start_calls] == [0, 1]
    assert {call["task_type"] for call in start_calls} == {"sketch_grid_generation"}
    for call in start_calls:
        billing = call["payload"]["billing"]
        assert billing["pricing_kind"] == "image"
        assert billing["pricing_model"]
        assert billing["pricing_params"]


def test_generate_sketches_forwards_sketch_model_and_aspect_ratio(
    monkeypatch, tmp_path
):
    client, _clean_calls, start_calls, scene_split_calls = _client(monkeypatch, tmp_path)

    response = client.post(
        "/api/v1/projects/demo/episodes/2/sketches/generate",
        json={
            "grid_index": 0,
            "sketch_scene_grouping": True,
            "aspect_ratio": "16:9",
            "image_generation_selection": "openrouter_nanobanana2",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert scene_split_calls == ["16:9"]
    assert start_calls[0]["payload"]["config"]["aspect_ratio"] == "16:9"
    assert (
        start_calls[0]["payload"]["config"]["image_generation_selection"]
        == "newapi_nanobanana2"
    )
    billing = start_calls[0]["payload"]["billing"]
    assert billing["image_selection"] == "newapi_nanobanana2"
    assert billing["pricing_kind"] == "image"

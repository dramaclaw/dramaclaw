from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.models import NO_CHARACTER_MARKER


class _RenderRegenStore:
    def __init__(self, beats: list[dict] | None = None):
        self.beats = beats or [
            {"beat_number": 1, "narration_segment": "a", "location": "A"},
            {"beat_number": 2, "narration_segment": "b", "location": "B"},
            {"beat_number": 3, "narration_segment": "c", "location": "C"},
        ]

    async def get_beats_as_dicts(self, episode_num: int):
        assert episode_num == 2
        return self.beats

    def get_sketch_colors(self, episode_num: int):
        assert episode_num == 2
        return {"hero_main": "#ffffff"}

    def get_cached_prop(self, prop_id: str):
        return None


def _client(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation

    calls: list[dict] = []

    async def fake_make_sqlite_store(username: str, project: str):
        assert username == "alice"
        assert project == "demo"
        return _RenderRegenStore()

    async def fake_make_sqlite_store_for_context(ctx):
        assert ctx.project_id == "proj"
        return _RenderRegenStore()

    async def fake_resolve_generation_project(project: str, user: dict, required_role: str):
        assert project == "demo"
        assert user == {"username": "alice"}
        assert required_role == "editor"
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            ctx=SimpleNamespace(
                project_id="proj",
                state_dir=tmp_path / "state",
                runtime_dir=tmp_path / "runtime",
            ),
        )

    async def fake_character_map(store, beats, username, project, **kwargs):
        return {"hero": {"ref_path": ""}}

    async def fake_prop_menu(*args, **kwargs):
        return []

    async def fake_enqueue_project_task(ctx, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=f"task-{len(calls)}"),
            backend="celery",
            queue=kwargs.get("queue_kind") or "default",
        )

    monkeypatch.setattr(
        generation,
        "get_project_dir",
        lambda username, project: tmp_path,
        raising=False,
    )
    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve_generation_project)
    monkeypatch.setattr(
        generation,
        "get_output_dir",
        lambda username, project: str(tmp_path),
        raising=False,
    )
    monkeypatch.setattr(generation, "get_state_dir", lambda username, project: str(tmp_path / "state"))
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "_runtime_prop_menu_with_global_props", fake_prop_menu)
    monkeypatch.setattr(generation, "render_ai_detection_error", lambda beats: None)
    monkeypatch.setattr(generation, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))

    app = FastAPI()
    app.include_router(generation.router, prefix="/api/v1")
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}

    return TestClient(app), calls


def _client_with_real_detection_guard(monkeypatch, tmp_path, beats: list[dict]):
    from novelvideo.api.routes import generation

    calls: list[dict] = []
    seen_character_map_beats: list[list[int]] = []
    store = _RenderRegenStore(beats)

    async def fake_resolve_generation_project(project: str, user: dict, required_role: str):
        assert project == "demo"
        assert user == {"username": "alice"}
        assert required_role == "editor"
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            ctx=SimpleNamespace(
                project_id="proj",
                state_dir=tmp_path / "state",
                runtime_dir=tmp_path / "runtime",
            ),
        )

    async def fake_make_sqlite_store(username: str, project: str):
        assert username == "alice"
        assert project == "demo"
        return store

    async def fake_make_sqlite_store_for_context(ctx):
        assert ctx.project_id == "proj"
        return store

    async def fake_character_map(store, selected_beats, username, project, **kwargs):
        seen_character_map_beats.append([beat["beat_number"] for beat in selected_beats])
        return {"hero": {"ref_path": ""}}

    async def fake_prop_menu(*args, **kwargs):
        return []

    async def fake_enqueue_project_task(ctx, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=f"task-{len(calls)}"),
            backend="celery",
            queue=kwargs.get("queue_kind") or "default",
        )

    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve_generation_project)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "_runtime_prop_menu_with_global_props", fake_prop_menu)
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "get_state_dir", lambda username, project: str(tmp_path / "state"))
    monkeypatch.setattr(generation, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))

    app = FastAPI()
    app.include_router(generation.router, prefix="/api/v1")
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    return TestClient(app), calls, seen_character_map_beats


def test_render_selected_regen_returns_scope_and_passes_render_settings(
    monkeypatch,
    tmp_path,
):
    from novelvideo.task_identity import selection_scope

    client, calls = _client(monkeypatch, tmp_path)

    response = client.post(
        "/api/v1/projects/demo/episodes/2/beats/regenerate",
        json={
            "beat_indices": [3, 1],
            "mode_key": "1x1_2-3",
            "image_generation_selection": "newapi_nanobanana2",
            "sketch_aspect_padding": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    expected_scope = selection_scope("1x1_2-3", [3, 1])
    assert body["ok"] is True
    assert body["task_type"] == "selected_regen"
    assert body["scope"] == expected_scope
    assert calls[0]["payload"]["mode_key"] == "1x1_2-3"
    assert calls[0]["payload"]["config"]["image_generation_selection"] == "newapi_nanobanana2"
    assert calls[0]["payload"]["config"]["sketch_aspect_padding"] is True
    assert "force_half_k" not in calls[0]["payload"]["config"]
    billing = calls[0]["payload"]["billing"]
    assert billing["image_selection"] == "newapi_nanobanana2"
    assert billing["pricing_kind"] == "image"
    assert billing["pricing_model"]
    assert billing["pricing_params"]


def test_render_selected_regen_checks_only_selected_beat_detection(monkeypatch, tmp_path):
    client, calls, seen_character_map_beats = _client_with_real_detection_guard(
        monkeypatch,
        tmp_path,
        [
            {"beat_number": 1, "narration_segment": "a", "detected_identities": []},
            {
                "beat_number": 2,
                "narration_segment": "b",
                "detected_identities": [NO_CHARACTER_MARKER],
            },
        ],
    )

    response = client.post(
        "/api/v1/projects/demo/episodes/2/beats/regenerate",
        json={"beat_indices": [2], "mode_key": "1x1_2-3"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert calls[0]["payload"]["config"]["selected_beat_numbers"] == [2]
    assert seen_character_map_beats == [[2]]


@pytest.mark.m09
def test_render_plan_execute_checks_only_selected_beat_detection(monkeypatch, tmp_path):
    client, calls, seen_character_map_beats = _client_with_real_detection_guard(
        monkeypatch,
        tmp_path,
        [
            {"beat_number": 1, "narration_segment": "a", "detected_identities": []},
            {
                "beat_number": 2,
                "narration_segment": "b",
                "detected_identities": [NO_CHARACTER_MARKER],
            },
        ],
    )

    plan_response = client.post(
        "/api/v1/projects/demo/episodes/2/render/plan",
        json={"beat_indices": [2], "strategy": "naive", "aspect_mode": "9:16"},
    )

    assert plan_response.status_code == 200
    plan_body = plan_response.json()
    assert plan_body["ok"] is True
    plan_data = plan_body["data"]
    assert plan_data["total_beats"] == 1
    assert [entry["beat_numbers"] for entry in plan_data["plan"]] == [[2]]

    execute_response = client.post(
        "/api/v1/projects/demo/episodes/2/render/execute",
        json={
            "plan": plan_data["plan"],
            "plan_hash": plan_data["plan_hash"],
            "input_fingerprint": plan_data["input_fingerprint"],
            "strategy": plan_data["strategy"],
            "aspect_mode": "9:16",
            "beat_indices": [2],
        },
    )

    assert execute_response.status_code == 200
    execute_body = execute_response.json()
    assert execute_body["ok"] is True
    assert calls[0]["payload"]["config"]["selected_beat_numbers"] == [2]
    billing = calls[0]["payload"]["billing"]
    assert billing["image_selection"]
    assert billing["pricing_kind"] == "image"
    assert billing["pricing_model"]
    assert billing["pricing_params"]
    assert seen_character_map_beats == [[2], [2]]


def test_render_grid_regen_passes_render_settings(monkeypatch, tmp_path):
    from novelvideo.generators import nanobanana_grid

    monkeypatch.setattr(
        nanobanana_grid,
        "scene_grid_split",
        lambda beats, character_map=None: [
            {"rows": 1, "cols": 1, "scene_id": "A", "beat_numbers": [1, 3]}
        ],
    )
    client, calls = _client(monkeypatch, tmp_path)

    response = client.post(
        "/api/v1/projects/demo/episodes/2/grids/0/regenerate",
        json={
            "scene_grouping": True,
            "image_generation_selection": "newapi_nanobanana2",
            "sketch_aspect_padding": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["task_type"] == "grid_regenerate"
    assert calls[0]["payload"]["grid_index"] == 0
    assert calls[0]["payload"]["config"]["image_generation_selection"] == "newapi_nanobanana2"
    assert calls[0]["payload"]["config"]["sketch_aspect_padding"] is True
    assert "force_half_k" not in calls[0]["payload"]["config"]


def test_render_grid_regen_checks_only_selected_grid_detection(monkeypatch, tmp_path):
    from novelvideo.generators import nanobanana_grid

    monkeypatch.setattr(
        nanobanana_grid,
        "scene_grid_split",
        lambda beats, character_map=None: [
            {"rows": 1, "cols": 1, "scene_id": "B", "beat_numbers": [2]}
        ],
    )
    client, calls, _seen_character_map_beats = _client_with_real_detection_guard(
        monkeypatch,
        tmp_path,
        [
            {
                "beat_number": 1,
                "narration_segment": "a",
                "location": "A",
                "detected_identities": [],
            },
            {
                "beat_number": 2,
                "narration_segment": "b",
                "location": "B",
                "detected_identities": [NO_CHARACTER_MARKER],
            },
        ],
    )

    response = client.post(
        "/api/v1/projects/demo/episodes/2/grids/0/regenerate",
        json={"scene_grouping": True},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert calls[0]["payload"]["grid_index"] == 0

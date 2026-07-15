from __future__ import annotations

from datetime import datetime
import base64
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image


def _client(monkeypatch, tmp_path, config: dict | None = None):
    from novelvideo.api.routes import generation

    saved: list[dict] = []
    current_config = dict(config or {})
    ctx = SimpleNamespace(
        project_id="proj_demo",
        owner_username="alice",
        project_name="demo",
        output_dir=tmp_path,
        state_dir=tmp_path / "_state",
        runtime_dir=tmp_path / "_runtime",
        is_home_node=True,
    )

    async def fake_resolve_project(project: str, user: dict, required_role: str = "editor"):
        return SimpleNamespace(
            ctx=None,
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "_state"),
            runtime_dir=str(tmp_path / "_runtime"),
        )

    def fake_save_project_config(username: str, project: str, config: dict | None = None, **kwargs):
        assert username == "alice"
        assert project == "demo"
        updates = dict(config or {})
        updates.update(kwargs)
        current_config.update(updates)
        saved.append(updates)

    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve_project)

    async def fake_store_for_context(*_args, **_kwargs):
        return await generation.make_sqlite_store("alice", "demo")

    monkeypatch.setattr(generation, "make_sqlite_store_for_context", fake_store_for_context)
    monkeypatch.setattr(
        generation,
        "get_state_dir",
        lambda username, project: str(tmp_path / "_state"),
    )
    monkeypatch.setattr(
        generation,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: (
            f"/static/projects/{getattr(ctx, 'project_id', 'proj_demo')}/{rel}"
        ),
    )
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: current_config)
    monkeypatch.setattr(generation, "save_project_config", fake_save_project_config, raising=False)

    app = FastAPI()
    app.include_router(generation.router, prefix="/api/v1")
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}

    return TestClient(app), saved


def _selected_background_path(project_dir):
    return project_dir / "director_control_frames" / "ep001" / "beat_04" / "selected_background.png"


@pytest.mark.m09
def test_render_settings_returns_current_selection_and_options(monkeypatch, tmp_path):
    client, _saved = _client(
        monkeypatch,
        tmp_path,
        {
            "render_image_selection": "newapi_nanobanana2",
            "sketch_aspect_padding": True,
        },
    )

    response = client.get("/api/v1/projects/demo/render-settings")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["render_image_selection"] == "newapi_nanobanana2"
    assert body["data"]["options"] == {
        "newapi_gpt_image2": "LingShan-G2",
        "newapi_nanobanana2": "LingShan-NB-2",
    }
    assert body["data"]["sketch_aspect_padding"] is True
    assert "force_half_k" not in body["data"]


@pytest.mark.m09
def test_render_settings_maps_legacy_selection_to_visible_newapi_option(monkeypatch, tmp_path):
    client, _saved = _client(
        monkeypatch,
        tmp_path,
        {"render_image_selection": "huimeng_gpt_image2"},
    )

    response = client.get("/api/v1/projects/demo/render-settings")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["render_image_selection"] == "newapi_gpt_image2"
    assert body["data"]["render_image_selection"] in body["data"]["options"]


@pytest.mark.m09
def test_render_settings_patch_persists_valid_settings(monkeypatch, tmp_path):
    client, saved = _client(monkeypatch, tmp_path)

    response = client.patch(
        "/api/v1/projects/demo/render-settings",
        json={
            "render_image_selection": "newapi_nanobanana2",
            "sketch_aspect_padding": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert saved == [
        {
            "render_image_selection": "newapi_nanobanana2",
            "sketch_aspect_padding": True,
        }
    ]
    assert "force_half_k" not in body["data"]


@pytest.mark.m09
def test_render_settings_patch_rejects_unknown_selection(monkeypatch, tmp_path):
    client, saved = _client(monkeypatch, tmp_path)

    response = client.patch(
        "/api/v1/projects/demo/render-settings",
        json={"render_image_selection": "unknown"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert "Invalid render_image_selection" in body["error"]
    assert saved == []


def test_sketch_settings_returns_current_selection_and_options(monkeypatch, tmp_path):
    client, _saved = _client(
        monkeypatch,
        tmp_path,
        {"sketch_image_selection": "newapi_nanobanana2"},
    )

    response = client.get("/api/v1/projects/demo/sketch-settings")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["sketch_image_selection"] == "newapi_nanobanana2"
    assert body["data"]["options"] == {
        "newapi_gpt_image2": "LingShan-G2",
        "newapi_nanobanana2": "LingShan-NB-2",
    }


def test_sketch_settings_maps_legacy_selection_to_visible_newapi_option(monkeypatch, tmp_path):
    client, _saved = _client(
        monkeypatch,
        tmp_path,
        {"sketch_image_selection": "huimeng_image2_official"},
    )

    response = client.get("/api/v1/projects/demo/sketch-settings")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["sketch_image_selection"] == "newapi_gpt_image2"
    assert body["data"]["sketch_image_selection"] in body["data"]["options"]


def test_sketch_settings_patch_persists_valid_selection(monkeypatch, tmp_path):
    client, saved = _client(monkeypatch, tmp_path)

    response = client.patch(
        "/api/v1/projects/demo/sketch-settings",
        json={"sketch_image_selection": "newapi_nanobanana2"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert saved == [{"sketch_image_selection": "newapi_nanobanana2"}]
    assert body["data"]["sketch_image_selection"] == "newapi_nanobanana2"


def test_sketch_settings_patch_rejects_unknown_selection(monkeypatch, tmp_path):
    client, saved = _client(monkeypatch, tmp_path)

    response = client.patch(
        "/api/v1/projects/demo/sketch-settings",
        json={"sketch_image_selection": "unknown"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert "Invalid sketch_image_selection" in body["error"]
    assert saved == []


def test_director_control_frame_status_reports_missing_and_ready(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)

    missing_response = client.get("/api/v1/projects/demo/episodes/1/beats/4/director-control-frame")

    assert missing_response.status_code == 200
    missing_body = missing_response.json()
    assert missing_body["ok"] is True
    assert missing_body["data"]["ready"] is False
    assert missing_body["data"]["scope"] == "director_control_to_sketch:ep001:beat_04"

    control_frame = tmp_path / "director_control_frames" / "ep001" / "beat_04" / "combined.png"
    control_frame.parent.mkdir(parents=True)
    control_frame.write_bytes(b"fake png")

    ready_response = client.get("/api/v1/projects/demo/episodes/1/beats/4/director-control-frame")

    assert ready_response.status_code == 200
    ready_body = ready_response.json()
    assert ready_body["ok"] is True
    assert ready_body["data"]["ready"] is True
    assert ready_body["data"]["url"] == (
        "/static/projects/proj_demo/director_control_frames/ep001/beat_04/combined.png"
    )


def test_director_control_to_sketch_starts_existing_actor(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)
    control_frame = tmp_path / "director_control_frames" / "ep001" / "beat_04" / "combined.png"
    control_frame.parent.mkdir(parents=True)
    control_frame.write_bytes(b"fake png")
    calls: list[dict] = []

    def fake_start_control_frame_to_sketch_task(**kwargs):
        calls.append(kwargs)

    from novelvideo.api.routes import generation

    monkeypatch.setattr(
        generation,
        "start_control_frame_to_sketch_task",
        fake_start_control_frame_to_sketch_task,
        raising=False,
    )

    response = client.post("/api/v1/projects/demo/episodes/1/beats/4/director-control-to-sketch")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["task_type"] == "sketch_generation"
    assert body["scope"] == "director_control_to_sketch:ep001:beat_04"
    assert calls == [
        {
            "username": "alice",
            "project": "demo",
            "episode": 1,
            "beat_num": 4,
            "output_dir": str(tmp_path),
            "state_dir": str(tmp_path / "_state"),
            "scope": "director_control_to_sketch:ep001:beat_04",
        }
    ]


def test_director_control_to_sketch_rejects_missing_control_frame(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)

    response = client.post("/api/v1/projects/demo/episodes/1/beats/4/director-control-to-sketch")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "combined.png" in body["error"]


class _FakePropMenuItem:
    def __init__(self, **values):
        self.values = values

    def model_dump(self):
        return dict(self.values)


class _FakeEpisode:
    def __init__(self, prop_menu: list[dict] | None = None):
        self.prop_menu = [_FakePropMenuItem(**item) for item in prop_menu or []]


class _FakeBeatStore:
    def __init__(
        self,
        beats: list[dict],
        *,
        sketch_colors: dict[str, str] | None = None,
        episode: _FakeEpisode | None = None,
    ):
        self.beats = beats
        self.sketch_colors = sketch_colors or {}
        self.episode = episode
        self.updates: list[dict] = []
        self.closed = False

    async def get_beats_as_dicts(self, episode: int):
        return list(self.beats)

    def get_sketch_colors(self, episode: int):
        return dict(self.sketch_colors)

    def get_episode(self, episode: int):
        return self.episode

    async def update_beat_asset(self, **kwargs):
        self.updates.append(kwargs)
        return True

    async def close(self):
        self.closed = True


def test_beat_viewer_manifests_include_context_and_destinations(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)
    store = _FakeBeatStore(
        [
            {
                "beat_number": 2,
                "visual_description": "{{大厅路人_default}}端起[[茶杯]]。",
                "scene_ref": {"scene_id": "大厅"},
                "detected_identities": ["大厅路人_default"],
                "detected_props": ["茶杯"],
            },
            {
                "beat_number": 4,
                "visual_description": "{{青年_default}}拿着[[账单]]看向吧台",
                "scene_ref": {"scene_id": "地下室"},
                "detected_identities": ["青年_错误检测"],
                "detected_props": ["错误账单"],
            },
            {
                "beat_number": 5,
                "visual_description": "{{老板_default}}把[[手机]]递给青年",
                "scene_ref": {"scene_id": "地下室"},
                "detected_identities": ["老板_错误检测"],
                "detected_props": ["错误手机"],
            },
        ],
        sketch_colors={
            "青年_default": "#ff00ff FLUORESCENT MAGENTA",
            "老板_default": "#00ffff FLUORESCENT CYAN",
            "配色额外身份_default": "#ccff00 FLUORESCENT LIME",
        },
        episode=_FakeEpisode(
            prop_menu=[
                {"prop_id": "账单", "marker_color": "#0d47a1 ROYAL BLUE"},
                {"prop_id": "手机", "marker_color": "#b71c1c DEEP CRIMSON"},
                {"prop_id": "配色额外道具", "marker_color": "#1b5e20 FOREST GREEN"},
            ]
        ),
    )

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    async def fake_resolve_project(project: str, user: dict, required_role: str = "editor"):
        ctx = SimpleNamespace(project_id="proj_demo", output_dir=tmp_path)
        return SimpleNamespace(
            ctx=ctx,
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "_state"),
            runtime_dir=str(tmp_path / "_runtime"),
        )

    from novelvideo.api import viewer_manifests
    from novelvideo.api.routes import generation
    from novelvideo.director_world import stage_manifest

    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve_project)
    monkeypatch.setattr(
        viewer_manifests,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    stage_dir = stage_manifest.stage_dir(tmp_path, "地下室")
    stage_dir.mkdir(parents=True)
    (stage_dir / "pano_360.png").write_bytes(b"pano")
    (stage_dir / "master_sharp.ply").write_bytes(b"ply")
    (stage_dir / "master_sharp.sog").write_bytes(b"sog")
    (stage_dir / "reverse_sharp.sog").write_bytes(b"reverse sog")
    (stage_dir / "pano_depth.sog").write_bytes(b"pano sog")
    stage_manifest.update_manifest(
        tmp_path,
        "地下室",
        pano_path="pano_360.png",
        ply_path="master_sharp.ply",
        master_ply_path="master_sharp.ply",
        reverse_ply_path="reverse_sharp.sog",
        pano_ply_path="pano_depth.sog",
        source="single_face_master",
    )

    pano_response = client.get("/api/v1/projects/demo/episodes/1/beats/4/pano-background/manifest")
    assert pano_response.status_code == 200
    pano_body = pano_response.json()
    assert pano_body["ok"] is True
    pano = pano_body["data"]
    assert pano["viewer_kind"] == "pano360"
    assert pano["mode"] == "beat"
    assert (
        pano["source"]["url"] == "/static/projects/proj_demo/director_worlds/地下室/v1/pano_360.png"
    )
    assert pano["beat_context"]["episode"] == 1
    assert pano["beat_context"]["beat"] == 4
    assert pano["allowed_destinations"] == ["view", "download", "beat_selected_background"]
    assert "pano_viewer_url" not in pano

    stage_response = client.get("/api/v1/projects/demo/episodes/1/beats/4/director-stage/manifest")
    assert stage_response.status_code == 200
    stage_body = stage_response.json()
    assert stage_body["ok"] is True
    stage = stage_body["data"]
    assert stage["viewer_kind"] == "three_d_director"
    assert stage["mode"] == "beat"
    assert (
        stage["source"]["ply_url"]
        == "/static/projects/proj_demo/director_worlds/地下室/v1/master_sharp.sog"
    )
    assert (
        stage["source"]["splat_url"]
        == "/static/projects/proj_demo/director_worlds/地下室/v1/master_sharp.sog"
    )
    assert stage["source"]["splat_format"] == "sog"
    assert stage["source"]["source_kind"] == "master"
    assert stage["source_orientation_mode"] == "supersplat_auto"
    assert [
        item["kind"] for item in stage["source_options"]
    ] == ["active", "master", "reverse", "pano", "pano"]
    assert stage["source_options"][0]["current"] is True
    assert stage["source_options"][2]["ply_url"].endswith("/reverse_sharp.sog")
    assert stage["source_options"][2]["splat_url"].endswith("/reverse_sharp.sog")
    assert stage["source_options"][2]["splat_format"] == "sog"
    pano360 = stage["source_options"][-1]
    assert pano360["source_type"] == "pano360"
    assert pano360["pano_url"].endswith("/pano_360.png")
    assert pano360["slot_kind"] == "scene_director_pano_360"
    assert stage["beat_context"]["detected_identities"] == ["青年_错误检测"]
    assert stage["beat_context"]["detected_props"] == ["错误账单"]
    assert stage["blockings_dir_fs"].endswith("/director_blockings/ep001")
    assert stage["control_frames_dir_fs"].endswith("/director_control_frames")
    assert stage["slate_beat"] == 4
    assert stage["palette"]["actors"] == [
        {"identity_id": "青年_default", "label": "青年_default", "color": "#ff00ff"},
        {"identity_id": "老板_default", "label": "老板_default", "color": "#00ffff"},
        {"identity_id": "配色额外身份_default", "label": "配色额外身份_default", "color": "#ccff00"},
    ]
    assert stage["palette"]["props"] == [
        {"prop_id": "账单", "label": "账单", "color": "#0d47a1"},
        {"prop_id": "手机", "label": "手机", "color": "#b71c1c"},
        {"prop_id": "配色额外道具", "label": "配色额外道具", "color": "#1b5e20"},
    ]
    assert stage["palette"]["anonymous_colors"] == []
    assert stage["palette"]["anonymous_prop_colors"] == [
        "#B71C1C",
        "#6D4C41",
        "#827717",
        "#1B5E20",
        "#006064",
        "#0D47A1",
        "#311B92",
        "#7B1FA2",
        "#880E4F",
        "#3E2723",
    ]
    assert stage["allowed_destinations"] == [
        "view",
        "download",
        "canvas_screenshot_node",
        "beat_director_combined",
        "beat_director_env_only",
        "beat_selected_background",
    ]
    assert "editor_url" not in stage


def test_director_stage_overlay_loads_inherits_and_saves(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)
    store = _FakeBeatStore(
        [
            {"beat_number": 2, "scene_ref": {"scene_id": "大厅"}},
            {
                "beat_number": 3,
                "scene_ref": {"scene_id": "地下室"},
                "detected_identities": ["陆辰_default"],
                "detected_props": ["账单"],
            },
            {
                "beat_number": 4,
                "scene_ref": {"scene_id": "地下室"},
                "detected_identities": ["陆辰_default"],
                "detected_props": ["账单", "手机"],
            },
        ]
    )

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    async def fake_resolve_project(project: str, user: dict, required_role: str = "editor"):
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            ctx=None,
        )

    from novelvideo.api.routes import generation
    from novelvideo.director_world.store import save_beat_blocking

    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve_project)

    inherited_payload = {
        "schema_version": "director_stage_overlay_v1",
        "scene_id": "地下室",
        "episode": 1,
        "beat": 3,
        "frame_aspect": "16:9",
        "snapshot": {"schemaVersion": 1, "savedAt": 1, "actors": [], "props": [], "stagings": []},
        "command_log": [{"kind": "place_actor"}],
    }
    save_beat_blocking(tmp_path, 1, 3, inherited_payload)

    response = client.get("/api/v1/projects/demo/episodes/1/beats/4/director-stage/overlay")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["status"] == "inherited"
    assert body["data"]["inherited_from_beat"] == 3
    assert body["data"]["overlay"]["beat"] == 3
    assert [item["beat"] for item in body["data"]["same_scene_beats"]] == [3, 4]

    save_response = client.post(
        "/api/v1/projects/demo/episodes/1/beats/4/director-stage/overlay",
        json={
            "frame_aspect": "2:3",
            "snapshot": {
                "schemaVersion": 1,
                "savedAt": 2,
                "world": {"activeSourceId": "legacy:pano:pano360:/static/demo/pano_360.png"},
                "camera": {"azim": 1, "elev": 2, "distance": 3, "focalPoint": [0, 0, 0]},
                "actors": [{"label": "陆辰", "color": "#38bdf8"}],
                "props": [{"label": "手机", "color": "#a78bfa"}],
                "stagings": [],
            },
            "source": {
                "source_id": "legacy:pano:pano360:/static/demo/pano_360.png",
                "source_type": "pano360",
                "source_kind": "pano",
                "label": "360 图",
                "pano_url": "/static/demo/pano_360.png",
            },
            "frame_meta": {
                "schema_version": "director_frame_meta_v1",
                "source": {
                    "source_id": "legacy:pano:pano360:/static/demo/pano_360.png",
                    "source_type": "pano360",
                    "source_kind": "pano",
                    "label": "360 图",
                    "pano_url": "/static/demo/pano_360.png",
                },
                "camera": {"mode": "pano", "frame_aspect": "2:3", "state": {"azim": 1}},
                "layer": {"source_id": "legacy:pano:pano360:/static/demo/pano_360.png"},
            },
            "actors": [{"identity_id": "陆辰_default", "name": "陆辰", "marker_color": "#38bdf8"}],
            "props": [{"prop_id": "手机", "name": "手机", "type": "prop_hero"}],
            "stagings": [{"prop_id": "纸箱堆", "name": "纸箱堆", "type": "prop_staging"}],
            "command_log": [{"kind": "save_overlay"}],
            "deleted_keys": ["prop:账单"],
        },
    )

    assert save_response.status_code == 200
    saved = save_response.json()
    assert saved["ok"] is True
    assert saved["data"]["status"] == "saved"
    assert saved["data"]["path"].endswith("/director_blockings/ep001/beat_04.json")
    assert saved["data"]["overlay"]["beat"] == 4
    assert saved["data"]["overlay"]["frame_aspect"] == "2:3"
    assert saved["data"]["overlay"]["source"]["source_id"] == "legacy:pano:pano360:/static/demo/pano_360.png"
    assert saved["data"]["overlay"]["source"]["source_type"] == "pano360"
    assert saved["data"]["overlay"]["frame_meta"]["source"]["source_id"] == "legacy:pano:pano360:/static/demo/pano_360.png"
    assert saved["data"]["overlay"]["snapshot"]["world"]["activeSourceId"] == "legacy:pano:pano360:/static/demo/pano_360.png"
    assert saved["data"]["overlay"]["actors"] == [
        {"identity_id": "陆辰_default", "name": "陆辰", "marker_color": "#38bdf8"}
    ]
    assert saved["data"]["overlay"]["props"] == [
        {"prop_id": "手机", "name": "手机", "type": "prop_hero"},
        {"prop_id": "纸箱堆", "name": "纸箱堆", "type": "prop_staging"},
    ]
    assert saved["data"]["overlay"]["stagings"] == [
        {"prop_id": "纸箱堆", "name": "纸箱堆", "type": "prop_staging"}
    ]
    assert saved["data"]["overlay"]["beat_context"]["detected_identities"] == ["陆辰_default"]
    assert saved["data"]["overlay"]["beat_context"]["detected_props"] == ["账单", "手机"]
    assert saved["data"]["overlay"]["deleted_keys"] == ["prop:账单"]
    assert store.updates[-1]["detected_props"] == ["账单", "手机"]

    current_response = client.get("/api/v1/projects/demo/episodes/1/beats/4/director-stage/overlay")
    assert current_response.json()["data"]["status"] == "current"
    assert current_response.json()["data"]["overlay"]["beat"] == 4
    assert (
        current_response.json()["data"]["overlay"]["source"]["source_id"]
        == "legacy:pano:pano360:/static/demo/pano_360.png"
    )


def test_director_stage_control_frame_export_writes_images_and_meta(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)
    store = _FakeBeatStore(
        [
            {
                "beat_number": 4,
                "scene_ref": {"scene_id": "地下室"},
                "detected_identities": ["陆辰_default"],
                "detected_props": ["账单"],
            },
        ]
    )

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    async def fake_resolve_project(project: str, user: dict, required_role: str = "editor"):
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            ctx=None,
        )

    from novelvideo.api.routes import generation

    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve_project)

    png = BytesIO()
    Image.new("RGB", (2, 2), color=(255, 255, 255)).save(png, format="PNG")
    png_bytes = png.getvalue()
    png_data_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
    response = client.post(
        "/api/v1/projects/demo/episodes/1/beats/4/director-stage/control-frame",
        json={
            "frame_aspect": "16:9",
            "images": {
                "combined": png_data_url,
                "env_only": png_data_url,
            },
            "frame_meta": {
                "schema_version": "director_frame_meta_v1",
                "source": {
                    "source_id": "source:master:sog:/static/demo/world.sog",
                    "source_type": "sog",
                    "source_kind": "master",
                    "label": "master",
                    "ply_url": "/static/demo/world.sog",
                },
                "camera": {
                    "mode": "sog",
                    "frame_aspect": "16:9",
                    "state": {"azim": 1},
                },
                "layer": {
                    "source_id": "source:master:sog:/static/demo/world.sog",
                    "actors": [
                        {
                            "kind": "actor",
                            "id": "actor_1",
                            "label": "陆辰",
                            "color": "#38bdf8",
                            "scale": [1, 1, 1],
                            "placement": {
                                "space": "world",
                                "position": [0, 0, 0],
                                "yaw_deg": 0,
                            },
                            "pose": "standing",
                        }
                    ],
                    "props": [],
                    "stagings": [],
                },
                "beat_context": {"episode": 1, "beat": 4},
            },
            "snapshot": {
                "camera": {"azim": 1},
                "actors": [{"label": "陆辰"}],
                "props": [{"label": "账单"}],
            },
            "actors": [{"identity_id": "陆辰_default", "name": "陆辰"}],
            "props": [{"prop_id": "账单", "name": "账单", "type": "prop_hero"}],
            "stagings": [{"prop_id": "纸箱堆", "name": "纸箱堆", "type": "prop_staging"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    data = body["data"]
    assert data["dir"].endswith("/director_control_frames/ep001/beat_04")
    assert data["paths"]["combined"].endswith("/combined.png")
    assert data["paths"]["env_only"].endswith("/env_only.png")
    assert data["urls"]["combined"].endswith(
        "/director_control_frames/ep001/beat_04/combined.png"
    )
    target_dir = tmp_path / "director_control_frames" / "ep001" / "beat_04"
    assert (target_dir / "combined.png").read_bytes() == png_bytes
    assert (target_dir / "env_only.png").read_bytes() == png_bytes
    assert "actor_overlay_black" not in data["paths"]
    assert "actor_mask" not in data["paths"]
    assert "combined_layered_debug" not in data["paths"]
    meta = __import__("json").loads((target_dir / "frame_meta.json").read_text())
    assert meta["schema_version"] == "director_frame_meta_v1"
    assert meta["source"]["source_type"] == "sog"
    assert meta["camera"] == {
        "mode": "sog",
        "frame_aspect": "16:9",
        "state": {"azim": 1},
    }
    assert meta["layer"]["actors"][0]["placement"] == {
        "space": "world",
        "position": [0, 0, 0],
        "yaw_deg": 0,
    }
    assert meta["scene_id"] == "地下室"
    assert meta["episode"] == 1
    assert meta["beat"] == 4
    assert meta["frame_aspect"] == "16:9"
    assert meta["actors"] == [{"identity_id": "陆辰_default", "name": "陆辰"}]
    assert meta["props"] == [
        {"prop_id": "账单", "name": "账单", "type": "prop_hero"},
        {"prop_id": "纸箱堆", "name": "纸箱堆", "type": "prop_staging"},
    ]
    assert meta["stagings"] == [{"prop_id": "纸箱堆", "name": "纸箱堆", "type": "prop_staging"}]
    assert meta["paths"]["combined"] == "director_control_frames/ep001/beat_04/combined.png"


def test_director_stage_control_frame_export_requires_complete_bundle(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)
    store = _FakeBeatStore(
        [
            {
                "beat_number": 4,
                "scene_ref": {"scene_id": "地下室"},
            },
        ]
    )

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    async def fake_resolve_project(project: str, user: dict, required_role: str = "editor"):
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            ctx=None,
        )

    from novelvideo.api.routes import generation

    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(generation, "_resolve_generation_project", fake_resolve_project)

    png = BytesIO()
    Image.new("RGB", (2, 2), color=(255, 255, 255)).save(png, format="PNG")
    png_data_url = "data:image/png;base64," + base64.b64encode(png.getvalue()).decode("ascii")

    response = client.post(
        "/api/v1/projects/demo/episodes/1/beats/4/director-stage/control-frame",
        json={
            "frame_aspect": "16:9",
            "images": {"combined": png_data_url},
            "frame_meta": {"schema_version": "director_frame_meta_v1"},
        },
    )

    assert response.status_code == 400
    assert "combined, env_only and frame_meta are required" in response.json()["error"]


def test_beat_background_anchor_lists_and_snapshots_master(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)
    store = _FakeBeatStore(
        [
            {"beat_number": 4, "scene_ref": {"scene_id": "地下室", "render_anchor_id": "master"}},
        ]
    )

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    from novelvideo.api.routes import generation

    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)

    master = tmp_path / "assets" / "scenes" / "地下室" / "master.png"
    master.parent.mkdir(parents=True)
    master.write_bytes(b"fake master")

    response = client.get("/api/v1/projects/demo/episodes/1/beats/4/background-anchors")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["current_anchor"] == "master"
    master_anchor = [item for item in body["data"]["anchors"] if item["id"] == "master"][0]
    assert master_anchor["exists"] is True

    response = client.patch(
        "/api/v1/projects/demo/episodes/1/beats/4/background-anchor",
        json={"anchor_id": "master"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["render_anchor_id"] == "selected_background"
    assert body["data"]["current_anchor"] == "master"
    assert body["data"]["current_source"] == "master"
    assert body["data"]["current_reference"]["label"] == "master"
    assert body["data"]["current_reference"]["rel_path"] == "assets/scenes/地下室/master.png"
    assert body["data"]["current_reference"]["url"].startswith(
        "/static/projects/proj_demo/assets/scenes/"
    )
    assert body["data"]["display_reference"]["id"] == "master"
    assert body["data"]["display_reference"]["rel_path"] == "assets/scenes/地下室/master.png"
    assert body["data"]["render_input"]["id"] == "selected_background"
    assert (
        body["data"]["render_input"]["rel_path"]
        == "director_control_frames/ep001/beat_04/selected_background.png"
    )
    assert body["data"]["render_input"]["url"].startswith(
        "/static/projects/proj_demo/director_control_frames/ep001/beat_04/selected_background.png"
    )
    selected = _selected_background_path(tmp_path)
    assert selected.read_bytes() == b"fake master"
    assert store.updates[-1]["scene_ref"]["render_anchor_id"] == "selected_background"
    assert store.updates[-1]["scene_ref"]["render_anchor_source_id"] == "master"


def test_beat_background_anchor_infers_legacy_selected_source(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)
    store = _FakeBeatStore(
        [
            {
                "beat_number": 4,
                "scene_ref": {
                    "scene_id": "地下室",
                    "render_anchor_id": "selected_background",
                },
            },
        ]
    )

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    from novelvideo.api.routes import generation

    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)

    master = tmp_path / "assets" / "scenes" / "地下室" / "master.png"
    master.parent.mkdir(parents=True)
    master.write_bytes(b"same frozen master")
    selected = _selected_background_path(tmp_path)
    selected.parent.mkdir(parents=True)
    selected.write_bytes(b"same frozen master")

    response = client.get("/api/v1/projects/demo/episodes/1/beats/4/background-anchors")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["render_anchor_id"] == "selected_background"
    assert body["data"]["current_anchor"] == "master"
    assert body["data"]["current_source"] == "master"
    assert body["data"]["current_reference"]["label"] == "master"
    assert body["data"]["current_reference"]["rel_path"] == "assets/scenes/地下室/master.png"
    assert body["data"]["current_reference"]["url"].startswith(
        "/static/projects/proj_demo/assets/scenes/"
    )
    assert body["data"]["display_reference"]["id"] == "master"
    assert body["data"]["render_input"]["id"] == "selected_background"
    master_anchor = [item for item in body["data"]["anchors"] if item["id"] == "master"][0]
    external_anchor = [
        item for item in body["data"]["anchors"] if item["id"] == "selected_background"
    ][0]
    assert master_anchor["current"] is True
    assert external_anchor["current"] is False


def test_beat_background_anchor_upload_writes_selected_background(monkeypatch, tmp_path):
    client, _saved = _client(monkeypatch, tmp_path)
    store = _FakeBeatStore(
        [
            {"beat_number": 4, "scene_ref": {"scene_id": "地下室", "render_anchor_id": "master"}},
        ]
    )

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    from novelvideo.api.routes import generation

    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)

    content = BytesIO()
    Image.new("RGB", (4, 4), color=(255, 0, 0)).save(content, format="PNG")
    content.seek(0)

    response = client.post(
        "/api/v1/projects/demo/episodes/1/beats/4/background-anchor/upload",
        files={"file": ("background.png", content.getvalue(), "image/png")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["render_anchor_id"] == "selected_background"
    assert body["data"]["current_anchor"] == "selected_background"
    selected = _selected_background_path(tmp_path)
    assert selected.exists()
    assert store.updates[-1]["scene_ref"]["render_anchor_id"] == "selected_background"
    assert store.updates[-1]["scene_ref"]["render_anchor_source_id"] == "selected_background"


def test_sketch_regen_queue_round_trips_per_episode(monkeypatch, tmp_path):
    client, saved = _client(
        monkeypatch,
        tmp_path,
        {
            "react_sketch_regen_queue": {
                "ep001": [
                    {
                        "id": "2x2_2-3_sketch:1,2",
                        "modeKey": "2x2_2-3_sketch",
                        "modeLabel": "2×2",
                        "beatNumbers": [1, 2],
                        "sceneIds": ["store"],
                        "createdAt": "2026-05-18T00:00:00.000Z",
                    }
                ]
            }
        },
    )

    response = client.get("/api/v1/projects/demo/episodes/1/sketch-regen-queue")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["items"][0]["id"] == "2x2_2-3_sketch:1,2"

    response = client.put(
        "/api/v1/projects/demo/episodes/2/sketch-regen-queue",
        json={
            "items": [
                {
                    "id": "1x1_2-3_sketch:3",
                    "modeKey": "1x1_2-3_sketch",
                    "modeLabel": "1×1",
                    "beatNumbers": [3],
                    "sceneIds": ["store"],
                    "createdAt": "2026-05-18T00:01:00.000Z",
                }
            ]
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["items"][0]["beatNumbers"] == [3]
    assert saved[-1]["react_sketch_regen_queue"]["ep001"][0]["id"] == "2x2_2-3_sketch:1,2"
    assert saved[-1]["react_sketch_regen_queue"]["ep002"][0]["id"] == "1x1_2-3_sketch:3"
    assert "sketch_regen_queue" not in saved[-1]


def test_sketch_regen_queue_migrates_react_items_out_of_nicegui_legacy_key(
    monkeypatch,
    tmp_path,
):
    client, saved = _client(
        monkeypatch,
        tmp_path,
        {
            "sketch_regen_queue": {
                "ep001": [
                    {
                        "id": "1x2_4-3_sketch:2,3",
                        "modeKey": "1x2_4-3_sketch",
                        "modeLabel": "1×2_4:3 Sketch",
                        "beatNumbers": [2, 3],
                        "sceneIds": ["地下室"],
                        "createdAt": "2026-05-19T02:39:21.704Z",
                        "taskScope": "1x2_4-3_sketch__c0e3a7e07213",
                    }
                ]
            }
        },
    )

    response = client.get("/api/v1/projects/demo/episodes/1/sketch-regen-queue")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["items"][0]["beatNumbers"] == [2, 3]

    response = client.put(
        "/api/v1/projects/demo/episodes/1/sketch-regen-queue",
        json={"items": body["data"]["items"]},
    )

    assert response.status_code == 200
    assert saved[-1]["react_sketch_regen_queue"]["ep001"][0]["id"] == "1x2_4-3_sketch:2,3"
    assert saved[-1]["sketch_regen_queue"] == {}


def test_sketch_image_usage_and_guard_return_attempt_context(monkeypatch, tmp_path):
    from novelvideo.image_request_usage import record_image_request

    client, _saved = _client(monkeypatch, tmp_path)
    for idx in range(3):
        record_image_request(
            project_output_dir=tmp_path,
            request_id=f"r{idx}",
            provider="openrouter",
            model_name="nanobanana2",
            task_type="sketch_grid",
            scope="sketch_grid:1x1_2-3_sketch:3",
            episode=1,
            beat_num=3,
        )
    record_image_request(
        project_output_dir=tmp_path,
        request_id="render1",
        provider="openrouter",
        model_name="nanobanana2",
        task_type="render_grid",
        scope="render_grid:1x1:3",
        episode=1,
        beat_num=3,
    )

    response = client.get("/api/v1/projects/demo/episodes/1/sketch-image-usage")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["today_requests"] == 3
    assert body["data"]["total_requests"] == 3

    response = client.get(
        "/api/v1/projects/demo/episodes/1/image-generation-guard",
        params={
            "task_type": "sketch_grid",
            "scope": "sketch_grid:1x1_2-3_sketch:3",
            "subject": "Beat 3",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["attempt_count"] == 3
    assert body["data"]["next_attempt"] == 4
    assert body["data"]["level"] == "confirm"
    assert "Beat 3" in body["data"]["message"]


def test_image_generation_guard_password_verification_matches_nicegui(monkeypatch, tmp_path):
    from novelvideo.image_request_usage import record_image_request

    monkeypatch.setenv("PROMPT_EXPORT_PASSWORD", "secret")
    client, _saved = _client(monkeypatch, tmp_path)
    for idx in range(4):
        record_image_request(
            project_output_dir=tmp_path,
            request_id=f"r{idx}",
            provider="openrouter",
            model_name="nanobanana2",
            task_type="sketch_grid",
            scope="sketch_grid:1x1_2-3_sketch:3",
            episode=1,
            beat_num=3,
        )

    response = client.get(
        "/api/v1/projects/demo/episodes/1/image-generation-guard",
        params={
            "task_type": "sketch_grid",
            "scope": "sketch_grid:1x1_2-3_sketch:3",
            "subject": "Beat 3",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["next_attempt"] == 5
    assert body["data"]["level"] == "locked"
    assert "密码" in body["data"]["message"]

    response = client.post(
        "/api/v1/projects/demo/episodes/1/image-generation-guard/verify-password",
        json={"password": "wrong"},
    )
    assert response.status_code == 200
    assert response.json()["data"]["verified"] is False

    response = client.post(
        "/api/v1/projects/demo/episodes/1/image-generation-guard/verify-password",
        json={"password": "secret"},
    )
    assert response.status_code == 200
    assert response.json()["data"]["verified"] is True


def test_sketch_grid_preview_exposes_nicegui_thumbnail_contract(monkeypatch, tmp_path):
    from novelvideo.generators import nanobanana_grid, pool_indexer

    client, _saved = _client(monkeypatch, tmp_path)
    calls: dict[str, object] = {}

    def fake_build_beat_sketch_paths(ep_grids_dir, beat_numbers):
        calls["paths_args"] = (str(ep_grids_dir), list(beat_numbers))
        return {7: "sketch/beat_07_t20260519010101.png", 8: "sketch/beat_08_t20260519010102.png"}

    def fake_crop_sketch_panels(
        ep_grids_dir, beat_numbers, rows, cols, out_file, beat_sketch_paths=None
    ):
        calls["crop_args"] = {
            "ep_grids_dir": ep_grids_dir,
            "beat_numbers": list(beat_numbers),
            "rows": rows,
            "cols": cols,
            "out_file": out_file,
            "beat_sketch_paths": beat_sketch_paths,
        }
        return out_file

    monkeypatch.setattr(pool_indexer, "build_beat_sketch_paths", fake_build_beat_sketch_paths)
    monkeypatch.setattr(nanobanana_grid, "crop_sketch_panels", fake_crop_sketch_panels)

    response = client.post(
        "/api/v1/projects/demo/episodes/1/grids/1/sketch-preview",
        json={"rows": 5, "cols": 5, "beat_numbers": [7, 8]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["preview_url"].endswith("/grids/ep001/sketch_thumb_grid1_7_8_5x5.jpg")
    assert calls["paths_args"] == (str(tmp_path / "grids" / "ep001"), [7, 8])
    assert calls["crop_args"]["rows"] == 5
    assert calls["crop_args"]["cols"] == 5


def test_sketch_grid_preview_falls_back_to_latest_pool_sketch_cells(monkeypatch, tmp_path):
    from novelvideo.generators import nanobanana_grid, pool_indexer

    client, _saved = _client(monkeypatch, tmp_path)
    ep_grids_dir = tmp_path / "grids" / "ep001"
    old_cell = ep_grids_dir / "sketch" / "beat_07_t20260519010101.png"
    new_cell = ep_grids_dir / "sketch" / "beat_07_t20260519010202.png"
    beat8_cell = ep_grids_dir / "sketch" / "beat_08_t20260519010103.png"
    for cell in (old_cell, new_cell, beat8_cell):
        cell.parent.mkdir(parents=True, exist_ok=True)
        cell.write_bytes(b"stub")

    calls: dict[str, object] = {}

    monkeypatch.setattr(pool_indexer, "build_beat_sketch_paths", lambda ep, beats: {})
    monkeypatch.setattr(
        pool_indexer,
        "load_pool_index",
        lambda ep: SimpleNamespace(
            images=[
                SimpleNamespace(
                    type="sketch",
                    cell_path="sketch/beat_07_t20260519010101.png",
                    original_beat=7,
                    generated_at=datetime(2026, 5, 19, 1, 1, 1),
                ),
                SimpleNamespace(
                    type="sketch",
                    cell_path="sketch/beat_07_t20260519010202.png",
                    original_beat=7,
                    generated_at=datetime(2026, 5, 19, 1, 2, 2),
                ),
                SimpleNamespace(
                    type="sketch",
                    cell_path="sketch/beat_08_t20260519010103.png",
                    original_beat=8,
                    generated_at=datetime(2026, 5, 19, 1, 1, 3),
                ),
            ]
        ),
    )

    def fake_crop_sketch_panels(
        ep_grids_dir, beat_numbers, rows, cols, out_file, beat_sketch_paths=None
    ):
        calls["beat_sketch_paths"] = beat_sketch_paths
        return out_file

    monkeypatch.setattr(nanobanana_grid, "crop_sketch_panels", fake_crop_sketch_panels)

    response = client.post(
        "/api/v1/projects/demo/episodes/1/grids/1/sketch-preview",
        json={"rows": 5, "cols": 5, "beat_numbers": [7, 8]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert calls["beat_sketch_paths"] == {
        7: str(new_cell),
        8: str(beat8_cell),
    }

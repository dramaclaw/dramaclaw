from __future__ import annotations

import io
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import UploadFile

from novelvideo.api.schemas import (
    PanoSphereCorrection,
    PanoViewerCorrection,
    PropUpdate,
    ScenePanoGenerateRequest,
    SceneUpdate,
)
from novelvideo.models import NovelEpisode, NovelProp, NovelScene, NovelVisualBeat


class _SceneStore:
    def __init__(self, scenes: list[NovelScene]):
        self.scenes = {scene.name: scene for scene in scenes}

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


class _PropStore:
    def __init__(self, props: list[NovelProp]):
        self.props = {prop.name: prop for prop in props}

    async def list_props(self):
        return list(self.props.values())

    async def get_prop(self, name: str):
        return self.props.get(name)

    async def add_prop(self, prop: NovelProp):
        self.props[prop.name] = prop

    async def update_prop(self, name: str, **updates):
        prop = self.props[name]
        for key, value in updates.items():
            setattr(prop, key, value)
        return True

    async def rename_prop(self, old_name: str, new_name: str):
        prop = self.props.pop(old_name)
        prop.name = new_name
        self.props[new_name] = prop
        return True

    async def delete_prop(self, name: str):
        return self.props.pop(name, None) is not None


class _PropEpisodeStore(_PropStore):
    def __init__(self, props: list[NovelProp], episodes: list[NovelEpisode]):
        super().__init__(props)
        self.episodes = episodes

    async def list_episodes(self):
        return self.episodes


def _ctx(project_dir: Path):
    return SimpleNamespace(
        project_id="proj_demo",
        owner_username="admin",
        project_name="demo",
        output_dir=project_dir,
        state_dir=project_dir / "_state",
        runtime_dir=project_dir / "_runtime",
        is_home_node=True,
    )


def _resolution(project_dir: Path):
    return SimpleNamespace(
        ctx=_ctx(project_dir),
        username="admin",
        project_name="demo",
        project_dir=project_dir,
        output_dir=str(project_dir),
        state_dir=str(project_dir / "_state"),
        runtime_dir=str(project_dir / "_runtime"),
    )


def test_scene_payload_effective_prompt_combines_base_prompt_for_variant(
    tmp_path: Path,
):
    from novelvideo.api.routes.scenes import _scene_payload

    base_scene = NovelScene(
        name="卫生间",
        scene_type="interior",
        environment_prompt="白瓷砖墙面，正面是洗手台。",
    )
    variant_scene = NovelScene(
        name="卫生间_漏水",
        scene_type="interior",
        base_scene_id="卫生间",
        variant_id="漏水",
        variant_prompt="地面积水，天花板持续滴水。",
        environment_prompt="",
    )

    payload = _scene_payload(
        variant_scene,
        ctx=_ctx(tmp_path),
        project_dir=tmp_path,
        base_scene=base_scene,
    )

    assert "白瓷砖墙面" in payload["effective_environment_prompt"]
    assert "地面积水" in payload["effective_environment_prompt"]


def _patch_project(
    monkeypatch: pytest.MonkeyPatch,
    module,
    project_dir: Path,
    store=None,
) -> None:
    if hasattr(module, "_resolve_scene_project"):

        async def fake_resolve_scene_project(
            project: str, user: dict, *, required_role: str = "editor"
        ):
            return (
                None,
                "admin",
                "demo",
                project_dir,
                str(project_dir),
                store or _SceneStore([]),
            )

        monkeypatch.setattr(
            module, "_resolve_scene_project", fake_resolve_scene_project
        )

    if hasattr(module, "resolve_project_scope"):

        async def fake_resolve_project_scope(
            project: str, user: dict, *, required_role: str = "viewer"
        ):
            resolved = _resolution(project_dir)
            resolved.ctx = None
            return resolved

        monkeypatch.setattr(module, "resolve_project_scope", fake_resolve_project_scope)

    if hasattr(module, "make_sqlite_store_for_context"):

        async def fake_store_for_context(*_args, **_kwargs):
            return store or _PropStore([])

        monkeypatch.setattr(
            module, "make_sqlite_store_for_context", fake_store_for_context
        )

    if hasattr(module, "make_sqlite_store"):

        async def fake_make_sqlite_store(*_args, **_kwargs):
            return store or _PropStore([])

        monkeypatch.setattr(module, "make_sqlite_store", fake_make_sqlite_store)

    monkeypatch.setattr(
        module, "get_project_dir", lambda username, project: project_dir, raising=False
    )
    monkeypatch.setattr(
        module,
        "get_output_dir",
        lambda username, project: str(project_dir),
        raising=False,
    )
    monkeypatch.setattr(
        module,
        "load_project_config_file",
        lambda username, project: {"visual_style": "ink_wash"},
        raising=False,
    )
    monkeypatch.setattr(
        module,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: (
            f"/static/projects/{getattr(ctx, 'project_id', 'proj_demo')}/{rel}"
        ),
        raising=False,
    )


def _png_bytes(size: tuple[int, int] = (4, 2)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, (255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


def test_stage_manifest_prefers_sog_sidecar_for_ply_manifest(tmp_path):
    from novelvideo.director_world import stage_manifest

    stage_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    stage_dir.mkdir(parents=True)
    (stage_dir / "master_sharp.ply").write_bytes(b"large ply")
    (stage_dir / "master_sharp.sog").write_bytes(b"small sog")
    stage_manifest.update_manifest(
        tmp_path,
        "Hall",
        ply_path="master_sharp.ply",
        master_ply_path="master_sharp.ply",
        source="single_face_master",
    )

    assert (
        stage_manifest.resolve_ply_path(tmp_path, "Hall")
        == stage_dir / "master_sharp.sog"
    )
    assert (
        stage_manifest.resolve_ply_path(tmp_path, "Hall", ply_kind="master")
        == stage_dir / "master_sharp.sog"
    )


@pytest.mark.asyncio
async def test_list_scenes_returns_master_reverse_and_pano_urls(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(
        name="Hall_雪夜",
        scene_type="interior",
        environment_prompt="wide hall",
    )
    store = _SceneStore([scene])

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    monkeypatch.setattr(
        scenes,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )
    scene_dir = tmp_path / "assets" / "scenes" / "Hall_雪夜"
    scene_dir.mkdir(parents=True)
    (scene_dir / "master.png").write_bytes(b"master")
    (scene_dir / "reverse_master.png").write_bytes(b"reverse")
    pano_dir = stage_manifest.stage_dir(tmp_path, "Hall_雪夜")
    pano_dir.mkdir(parents=True)
    (pano_dir / "pano_360.png").write_bytes(b"pano")
    (pano_dir / "master_sharp.ply").write_bytes(b"master ply")
    (pano_dir / "master_sharp.sog").write_bytes(b"master sog")
    (pano_dir / "custom.sog").write_bytes(b"custom ply")
    stage_manifest.update_manifest(
        tmp_path,
        "Hall_雪夜",
        pano_path="pano_360.png",
        ply_path="custom.sog",
        custom_scene_path="custom.sog",
        master_ply_path="master_sharp.ply",
        source="custom_scene",
    )

    res = await scenes.list_scenes(
        project="demo",
        user={"username": "admin"},
    )

    asset = res["data"][0]
    assert asset["name"] == "Hall_雪夜"
    assert "base_scene" not in asset
    assert (
        asset["master_url"]
        == "/static/projects/proj_demo/assets/scenes/Hall_雪夜/master.png"
    )
    assert (
        asset["reverse_master_url"]
        == "/static/projects/proj_demo/assets/scenes/Hall_雪夜/reverse_master.png"
    )
    assert (
        asset["pano_url"]
        == "/static/projects/proj_demo/director_worlds/Hall_雪夜/v1/pano_360.png"
    )
    assert (
        asset["custom_scene_url"]
        == "/static/projects/proj_demo/director_worlds/Hall_雪夜/v1/custom.sog"
    )
    assert asset["stage_3gs"]["stage_dir"] == "director_worlds/Hall_雪夜/v1"
    assert asset["stage_3gs"]["active"]["ready"] is True
    assert (
        asset["stage_3gs"]["active"]["path"]
        == "director_worlds/Hall_雪夜/v1/custom.sog"
    )
    assert asset["stage_3gs"]["active_source"] == "custom"
    assert asset["stage_3gs"]["custom"]["ready"] is True
    assert asset["stage_3gs"]["master"]["ready"] is True
    assert asset["stage_3gs"]["reverse"]["ready"] is False
    assert "viewer_url" not in asset["stage_3gs"]
    assert "pano_viewer_url" not in asset
    assert asset["updated_at"]


@pytest.mark.asyncio
async def test_list_scenes_marks_derived_scene_base(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes

    store = _SceneStore(
        [
            NovelScene(name="故宫"),
            NovelScene(name="故宫_下雪", base_scene_id="故宫", variant_id="下雪"),
        ]
    )
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.list_scenes(
        project="demo",
        user={"username": "admin"},
    )

    by_name = {asset["name"]: asset for asset in res["data"]}
    assert by_name["故宫"]["derived_from_scene"] == ""
    assert by_name["故宫_下雪"]["derived_from_scene"] == "故宫"
    assert by_name["故宫_下雪"]["base_scene_id"] == "故宫"
    assert by_name["故宫_下雪"]["variant_id"] == "下雪"
    assert by_name["故宫_下雪"]["time_of_day"] == ""


@pytest.mark.asyncio
async def test_list_scenes_does_not_infer_derived_base_from_underscore_name(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    store = _SceneStore([NovelScene(name="地下"), NovelScene(name="地下_主控室")])
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.list_scenes(
        project="demo",
        user={"username": "admin"},
    )

    by_name = {asset["name"]: asset for asset in res["data"]}
    assert by_name["地下_主控室"]["derived_from_scene"] == ""
    assert by_name["地下_主控室"]["base_scene_id"] == ""
    assert by_name["地下_主控室"]["variant_id"] == ""


@pytest.mark.asyncio
async def test_derived_scene_guard_uses_structured_base_scene_id(tmp_path):
    from novelvideo.api.routes import scenes

    independent_store = _SceneStore(
        [NovelScene(name="地下"), NovelScene(name="地下_主控室")]
    )
    assert await scenes._derived_scene_names_for(independent_store, "地下") == []

    derived_store = _SceneStore(
        [
            NovelScene(name="地下"),
            NovelScene(name="地下_主控室", base_scene_id="地下", variant_id="主控室"),
        ]
    )
    assert await scenes._derived_scene_names_for(derived_store, "地下") == [
        "地下_主控室"
    ]


@pytest.mark.asyncio
async def test_create_scene_composes_structured_variant_and_time_name(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.api.schemas import SceneCreate

    store = _SceneStore([NovelScene(name="卫生间")])
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.create_scene(
        project="demo",
        body=SceneCreate(
            name="",
            base_scene_id="卫生间",
            variant_id="漏水",
            time_of_day="夜晚",
            scene_type="interior",
        ),
        user={"username": "admin"},
    )

    assert res["ok"] is True
    assert res["data"]["name"] == "卫生间_漏水_夜晚"
    assert res["data"]["base_scene_id"] == "卫生间"
    assert res["data"]["variant_id"] == "漏水"
    assert res["data"]["time_of_day"] == "夜晚"
    assert await store.get_scene("卫生间_漏水_夜晚") is not None


@pytest.mark.asyncio
async def test_preview_scene_plate_explains_render_and_seedance_resolution(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    master_path = tmp_path / "assets" / "scenes" / "卫生间_漏水_夜" / "master.png"
    master_path.parent.mkdir(parents=True)
    master_path.write_bytes(b"png")
    store = _SceneStore(
        [
            NovelScene(name="卫生间"),
            NovelScene(name="卫生间_漏水"),
            NovelScene(name="卫生间_漏水_夜"),
        ]
    )
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.preview_scene_plate(
        project="demo",
        scene_id="卫生间",
        variant_id="漏水",
        time_of_day="夜晚",
        user={"username": "admin"},
    )

    assert res == {
        "ok": True,
        "data": {
            "scene_id": "卫生间",
            "variant_id": "漏水",
            "time_of_day": "夜晚",
            "resolved_scene_name": "卫生间_漏水_夜",
            "planned_scene_name": "",
            "time_baked": True,
            "render": {
                "resolved_scene_name": "卫生间_漏水_夜",
                "planned_scene_name": "",
                "relight": False,
                "status": "time_baked",
                "label": "Render：将使用 卫生间_漏水_夜，锁图光",
            },
            "seedance2": {
                "resolved_scene_name": "卫生间_漏水_夜",
                "prompt_time_of_day": "夜晚",
                "label": "Seedance2：将喂入 卫生间_漏水_夜，提示词时间：夜晚",
            },
        },
    }


@pytest.mark.asyncio
async def test_preview_scene_plate_relights_when_planned_time_plate_has_no_image(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    store = _SceneStore(
        [
            NovelScene(name="卫生间"),
            NovelScene(
                name="卫生间_夜晚",
                base_scene_id="卫生间",
                time_of_day="夜晚",
            ),
        ]
    )
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.preview_scene_plate(
        project="demo",
        scene_id="卫生间",
        variant_id="",
        time_of_day="夜晚",
        user={"username": "admin"},
    )

    assert res["ok"] is True
    assert res["data"]["resolved_scene_name"] == "卫生间"
    assert res["data"]["planned_scene_name"] == "卫生间_夜晚"
    assert res["data"]["time_baked"] is False
    assert res["data"]["render"] == {
        "resolved_scene_name": "卫生间",
        "planned_scene_name": "卫生间_夜晚",
        "relight": True,
        "status": "planned_missing",
        "label": "Render：已规划 卫生间_夜晚 但暂无图，将使用 卫生间，relight 到 夜晚",
    }


@pytest.mark.asyncio
async def test_preview_scene_plate_explains_relight_fallback(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes

    store = _SceneStore([NovelScene(name="卫生间"), NovelScene(name="卫生间_夜")])
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.preview_scene_plate(
        project="demo",
        scene_id="卫生间",
        variant_id="夜",
        time_of_day="白天",
        user={"username": "admin"},
    )

    assert res["ok"] is True
    assert res["data"]["resolved_scene_name"] == "卫生间"
    assert res["data"]["time_baked"] is False
    assert res["data"]["render"] == {
        "resolved_scene_name": "卫生间",
        "planned_scene_name": "",
        "relight": True,
        "status": "relight",
        "label": "Render：将使用 卫生间，relight 到 白天",
    }
    assert res["data"]["seedance2"] == {
        "resolved_scene_name": "卫生间",
        "prompt_time_of_day": "白天",
        "label": "Seedance2：将喂入 卫生间，提示词时间：白天",
    }


@pytest.mark.asyncio
async def test_preview_scene_plate_beat_time_overrides_scene_ref_time(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    master_path = tmp_path / "assets" / "scenes" / "卫生间_漏水_白天" / "master.png"
    master_path.parent.mkdir(parents=True)
    master_path.write_bytes(b"png")
    store = _SceneStore(
        [
            NovelScene(name="卫生间"),
            NovelScene(name="卫生间_漏水"),
            NovelScene(name="卫生间_漏水_夜晚"),
            NovelScene(name="卫生间_漏水_白天"),
        ]
    )
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.preview_scene_plate(
        project="demo",
        scene_id="卫生间",
        variant_id="漏水",
        time_of_day="白天",
        user={"username": "admin"},
    )

    assert res["ok"] is True
    assert res["data"]["resolved_scene_name"] == "卫生间_漏水_白天"
    assert res["data"]["time_baked"] is True
    assert res["data"]["render"]["relight"] is False


@pytest.mark.asyncio
async def test_update_scene_pano_correction_persists_and_returns_manifest(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(
        name="Hall", scene_type="interior", environment_prompt="wide hall"
    )
    store = _SceneStore([scene])

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    monkeypatch.setattr(
        "novelvideo.api.viewer_manifests.make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    pano_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    pano_dir.mkdir(parents=True)
    (pano_dir / "pano_360.png").write_bytes(b"pano")
    stage_manifest.update_manifest(tmp_path, "Hall", pano_path="pano_360.png")

    response = await scenes.update_scene_pano_correction(
        project="demo",
        name="Hall",
        correction=PanoViewerCorrection(
            front_yaw_deg=35,
            sphere_correction_deg=PanoSphereCorrection(roll=1, pitch=2, yaw=3),
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["correction"] == {
        "front_yaw_deg": 35.0,
        "sphere_correction_deg": {"roll": 1.0, "pitch": 2.0, "yaw": 3.0},
    }
    assert stage_manifest.get_pano_correction(tmp_path, "Hall") == {
        "front_yaw_deg": 35.0,
        "sphere_correction_deg": {"roll": 1.0, "pitch": 2.0, "yaw": 3.0},
    }


@pytest.mark.asyncio
async def test_scene_viewer_manifests_return_typed_contracts(tmp_path, monkeypatch):
    from novelvideo.api import viewer_manifests
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(
        name="Hall", scene_type="interior", environment_prompt="wide hall"
    )
    store = _SceneStore([scene])

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    monkeypatch.setattr(
        viewer_manifests,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    pano_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    pano_dir.mkdir(parents=True)
    (pano_dir / "pano_360.png").write_bytes(b"pano")
    (pano_dir / "pano_depth.ply").write_bytes(b"ply")
    (pano_dir / "pano_depth.sog").write_bytes(b"sog")
    (pano_dir / "scene.collision.glb").write_bytes(b"glb")
    stage_manifest.update_manifest(
        tmp_path,
        "Hall",
        pano_path="pano_360.png",
        ply_path="pano_depth.ply",
        pano_ply_path="pano_depth.ply",
        collision_glb_path="scene.collision.glb",
        source="uploaded_360",
        pano_correction={
            "front_yaw_deg": 45,
            "sphere_correction_deg": {"yaw": 1, "pitch": 2, "roll": 3},
        },
    )

    pano_res = await scenes.get_scene_pano_manifest(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )
    pano = pano_res["data"]
    assert pano_res["ok"] is True
    assert pano["viewer_kind"] == "pano360"
    assert pano["mode"] == "scene"
    assert (
        pano["source"]["url"]
        == "/static/projects/proj_demo/director_worlds/Hall/v1/pano_360.png"
    )
    from novelvideo.director_world.paths import fs_url

    assert pano["source"]["fs"] == fs_url(pano_dir / "pano_360.png")
    assert pano["correction"]["front_yaw_deg"] == 45
    assert pano["correction"]["sphere_correction_deg"] == {
        "roll": 3.0,
        "pitch": 2.0,
        "yaw": 1.0,
    }
    assert pano["allowed_destinations"] == [
        "view",
        "download",
        "canvas_screenshot_node",
    ]
    assert "pano_viewer_url" not in pano

    stage_res = await scenes.get_scene_director_stage_manifest(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )
    stage = stage_res["data"]
    assert stage_res["ok"] is True
    assert stage["viewer_kind"] == "three_d_director"
    assert stage["mode"] == "scene"
    assert (
        stage["source"]["ply_url"]
        == "/static/projects/proj_demo/director_worlds/Hall/v1/pano_depth.sog"
    )
    assert (
        stage["source"]["splat_url"]
        == "/static/projects/proj_demo/director_worlds/Hall/v1/pano_depth.sog"
    )
    assert stage["source"]["splat_format"] == "sog"
    assert stage["source"]["collision_glb_url"] == (
        "/static/projects/proj_demo/director_worlds/Hall/v1/scene.collision.glb"
    )
    assert stage["source"]["source_kind"] == "pano"
    assert [item["kind"] for item in stage["source_options"]] == [
        "active",
        "pano",
        "pano",
    ]
    assert stage["source_options"][0]["current"] is True
    assert (
        stage["source_options"][0]["ply_url"]
        == "/static/projects/proj_demo/director_worlds/Hall/v1/pano_depth.sog"
    )
    assert (
        stage["source_options"][0]["splat_url"]
        == "/static/projects/proj_demo/director_worlds/Hall/v1/pano_depth.sog"
    )
    assert stage["source_options"][0]["splat_format"] == "sog"
    assert stage["source_options"][-1]["source_type"] == "pano360"
    assert (
        stage["source_options"][-1]["pano_url"]
        == "/static/projects/proj_demo/director_worlds/Hall/v1/pano_360.png"
    )
    assert stage["source_options"][-1]["slot_kind"] == "scene_director_pano_360"
    assert stage["palette"]["actors"] == []
    assert stage["palette"]["props"] == []
    assert stage["palette"]["anonymous_colors"] == [
        "#FF00FF",
        "#00FFFF",
        "#CCFF00",
        "#FF6B00",
        "#7C4DFF",
        "#00FF66",
        "#00A2FF",
        "#FFD400",
        "#9D00FF",
        "#00FFCC",
        "#39FF14",
        "#5C6BC0",
    ]
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
    assert "editor_url" not in stage


@pytest.mark.asyncio
async def test_scene_director_world_manifest_returns_pano_only_source_without_3gs(
    tmp_path, monkeypatch
):
    from novelvideo.api import viewer_manifests
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(
        name="Hall", scene_type="interior", environment_prompt="wide hall"
    )
    store = _SceneStore([scene])

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    monkeypatch.setattr(
        viewer_manifests,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    pano_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    pano_dir.mkdir(parents=True)
    (pano_dir / "pano_360.png").write_bytes(b"pano")
    stage_manifest.update_manifest(tmp_path, "Hall", pano_path="pano_360.png")

    res = await scenes.get_scene_director_stage_manifest(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )

    stage = res["data"]
    assert res["ok"] is True
    assert stage["viewer_kind"] == "three_d_director"
    assert stage["source"]["source_type"] == "pano360"
    assert stage["source"]["pano_url"] == (
        "/static/projects/proj_demo/director_worlds/Hall/v1/pano_360.png"
    )
    assert stage["source"]["slot_kind"] == "scene_director_pano_360"
    assert stage["source"]["source_kind"] == "pano"
    assert stage["active_source_id"] == "scene-pano:Hall"
    assert [item["kind"] for item in stage["source_options"]] == ["pano"]
    assert stage["source_options"][0]["source_type"] == "pano360"
    assert stage["source_options"][0]["current"] is True


@pytest.mark.asyncio
async def test_scene_director_world_save_restores_active_source_and_snapshot(
    tmp_path, monkeypatch
):
    from novelvideo.api import viewer_manifests
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(
        name="Hall", scene_type="interior", environment_prompt="wide hall"
    )
    store = _SceneStore([scene])

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    monkeypatch.setattr(
        viewer_manifests,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    stage_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    stage_dir.mkdir(parents=True)
    (stage_dir / "pano_360.png").write_bytes(b"pano")
    (stage_dir / "pano_depth.sog").write_bytes(b"sog")
    stage_manifest.update_manifest(
        tmp_path,
        "Hall",
        pano_path="pano_360.png",
        ply_path="pano_depth.sog",
        pano_ply_path="pano_depth.sog",
        source="text_to_360",
    )

    snapshot = {
        "schemaVersion": 1,
        "world": {
            "activeSourceId": "scene-pano:Hall",
            "sourceTransform": {"yaw": 12},
        },
        "camera": {"azim": 1},
        "actors": [{"label": "临时演员"}],
        "props": [],
        "stagings": [],
    }
    save_response = await scenes.save_scene_director_world(
        project="demo",
        name="Hall",
        body={"active_source_id": "scene-pano:Hall", "snapshot": snapshot},
        user={"username": "admin"},
    )

    assert save_response["ok"] is True
    assert save_response["data"]["active_source_id"] == "scene-pano:Hall"
    assert save_response["data"]["scenes_by_source_id"]["scene-pano:Hall"] == snapshot

    manifest_response = await scenes.get_scene_director_stage_manifest(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )

    manifest = manifest_response["data"]
    assert manifest["active_source_id"] == "scene-pano:Hall"
    assert manifest["scene"] == snapshot
    assert manifest["scenes_by_source_id"]["scene-pano:Hall"] == snapshot


@pytest.mark.asyncio
async def test_list_scenes_reports_saved_scene_director_world_pano_source(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(
        name="Hall", scene_type="interior", environment_prompt="wide hall"
    )
    store = _SceneStore([scene])

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    monkeypatch.setattr(
        scenes,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    stage_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    stage_dir.mkdir(parents=True)
    (stage_dir / "pano_360.png").write_bytes(b"pano")
    stage_manifest.update_manifest(tmp_path, "Hall", pano_path="pano_360.png")
    stage_manifest.save_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id="scene-pano:Hall",
        snapshot={"schemaVersion": 1, "world": {"activeSourceId": "scene-pano:Hall"}},
    )

    response = await scenes.list_scenes(project="demo", user={"username": "admin"})

    stage = response["data"][0]["stage_3gs"]
    assert stage["active_source"] == "360"
    assert stage["active"]["ready"] is True
    assert stage["active"]["path"] == "director_worlds/Hall/v1/pano_360.png"


@pytest.mark.asyncio
async def test_scene_director_world_manifest_returns_saved_empty_world_without_3gs(
    tmp_path, monkeypatch
):
    from novelvideo.api import viewer_manifests
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(
        name="Hall", scene_type="interior", environment_prompt="wide hall"
    )
    store = _SceneStore([scene])

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    monkeypatch.setattr(
        viewer_manifests,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )
    snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": "__empty_director_world__"},
        "actors": [],
        "props": [],
        "stagings": [],
    }
    stage_manifest.save_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id="__empty_director_world__",
        snapshot=snapshot,
    )

    response = await scenes.get_scene_director_stage_manifest(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    manifest = response["data"]
    assert manifest["active_source_id"] == "__empty_director_world__"
    assert manifest["scene"] == snapshot
    assert manifest["source"]["ply_url"] == ""


def test_clear_scene_director_world_keeps_remaining_source_active(tmp_path):
    from novelvideo.director_world import stage_manifest

    stage_manifest.save_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id="scene-pano:Hall",
        snapshot={"schemaVersion": 1, "world": {"activeSourceId": "scene-pano:Hall"}},
        active_source={"source_type": "pano360", "label": "360"},
    )
    stage_manifest.save_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id="scene-master:Hall",
        snapshot={"schemaVersion": 1, "world": {"activeSourceId": "scene-master:Hall"}},
        active_source={"source_type": "sog", "label": "master"},
    )

    result = stage_manifest.clear_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id="scene-master:Hall",
    )

    assert result["active_source_id"] == "scene-pano:Hall"
    assert result["scene"] == {
        "schemaVersion": 1,
        "world": {"activeSourceId": "scene-pano:Hall"},
    }
    assert set(result["scenes_by_source_id"]) == {"scene-pano:Hall"}


def test_clear_scene_director_world_canonicalizes_versioned_legacy_source_id(tmp_path):
    from novelvideo.director_world import stage_manifest

    canonical_master = "legacy:master:sog:/static/master.sog"
    versioned_master = "legacy:master:sog:/static/master.sog?v=123#frag"
    master_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": canonical_master},
    }
    stage_manifest.save_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id=canonical_master,
        snapshot=master_snapshot,
        active_source={
            "id": canonical_master,
            "source_type": "sog",
            "source_kind": "master",
        },
    )

    result = stage_manifest.clear_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id=versioned_master,
    )

    assert result["active_source_id"] == ""
    assert result["scene"] is None
    assert result["scenes_by_source_id"] == {}


def test_save_scene_director_world_source_preserves_other_active_source(tmp_path):
    from novelvideo.director_world import stage_manifest

    pano_snapshot = {"schemaVersion": 1, "world": {"activeSourceId": "scene-pano:Hall"}}
    master_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": "scene-master:Hall"},
    }

    stage_manifest.save_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id="scene-pano:Hall",
        snapshot=pano_snapshot,
        active_source={"source_type": "pano360", "label": "360"},
    )

    result = stage_manifest.save_scene_director_world_source(
        tmp_path,
        "Hall",
        source_id="scene-master:Hall",
        snapshot=master_snapshot,
        source={"source_type": "sog", "label": "master"},
    )

    assert result["active_source_id"] == "scene-pano:Hall"
    assert result["scene"] == pano_snapshot
    assert result["scenes_by_source_id"]["scene-pano:Hall"] == pano_snapshot
    assert result["scenes_by_source_id"]["scene-master:Hall"] == master_snapshot

    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    assert manifest["active_source_id"] == "scene-pano:Hall"
    assert manifest["scene"] == pano_snapshot
    assert manifest["scenes_by_source_id"]["scene-master:Hall"] == master_snapshot


def test_save_scene_director_world_source_does_not_promote_when_active_is_empty(
    tmp_path,
):
    from novelvideo.director_world import stage_manifest

    master_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": "scene-master:Hall"},
    }

    result = stage_manifest.save_scene_director_world_source(
        tmp_path,
        "Hall",
        source_id="scene-master:Hall",
        snapshot=master_snapshot,
        source={"source_type": "sog", "label": "master"},
    )

    assert result["active_source_id"] == ""
    assert result["scene"] is None
    assert result["scenes_by_source_id"]["scene-master:Hall"] == master_snapshot

    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    assert manifest["active_source_id"] == ""
    assert manifest.get("scene") is None
    assert manifest["scenes_by_source_id"]["scene-master:Hall"] == master_snapshot


@pytest.mark.asyncio
async def test_save_scene_director_world_source_route_preserves_active_source(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(name="Hall")
    store = _SceneStore([scene])

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    pano_snapshot = {"schemaVersion": 1, "world": {"activeSourceId": "scene-pano:Hall"}}
    master_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": "scene-master:Hall"},
    }
    stage_manifest.save_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id="scene-pano:Hall",
        snapshot=pano_snapshot,
        active_source={"source_type": "pano360", "label": "360"},
    )

    response = await scenes.save_scene_director_world_source(
        project="demo",
        name="Hall",
        body={
            "source_id": "scene-master:Hall",
            "snapshot": master_snapshot,
            "source": {"source_type": "sog", "label": "master"},
        },
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["active_source_id"] == "scene-pano:Hall"
    assert data["scene"] == pano_snapshot
    assert data["scenes_by_source_id"]["scene-master:Hall"] == master_snapshot


def test_save_scene_director_world_source_canonicalizes_versioned_legacy_source_ids(
    tmp_path,
):
    from novelvideo.director_world import stage_manifest

    reverse_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": "legacy:reverse:sog:/static/reverse.sog"},
    }
    stale_master_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": "legacy:master:sog:/static/master.sog"},
        "actors": [{"id": "stale"}],
    }
    master_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": "legacy:master:sog:/static/master.sog?v=123"},
        "actors": [{"id": "fresh"}],
    }

    stage_manifest.save_scene_director_world(
        tmp_path,
        "Hall",
        active_source_id="legacy:reverse:sog:/static/reverse.sog",
        snapshot=reverse_snapshot,
        active_source={"source_type": "sog", "source_kind": "reverse"},
    )
    stage_manifest.update_manifest(
        tmp_path,
        "Hall",
        scenes_by_source_id={
            "legacy:master:sog:/static/master.sog": stale_master_snapshot,
            "legacy:master:sog:/static/master.sog?v=111": stale_master_snapshot,
            "legacy:reverse:sog:/static/reverse.sog": reverse_snapshot,
        },
    )

    result = stage_manifest.save_scene_director_world_source(
        tmp_path,
        "Hall",
        source_id="legacy:master:sog:/static/master.sog?v=123",
        snapshot=master_snapshot,
        source={
            "id": "legacy:master:sog:/static/master.sog?v=123",
            "source_kind": "master",
        },
    )

    canonical_master = "legacy:master:sog:/static/master.sog"
    assert result["active_source_id"] == "legacy:reverse:sog:/static/reverse.sog"
    assert result["scene"] == reverse_snapshot
    assert set(result["scenes_by_source_id"]) == {
        canonical_master,
        "legacy:reverse:sog:/static/reverse.sog",
    }
    assert result["scenes_by_source_id"][canonical_master]["actors"] == [
        {"id": "fresh"}
    ]
    assert (
        result["scenes_by_source_id"][canonical_master]["world"]["activeSourceId"]
        == canonical_master
    )


def test_get_scene_director_world_prefers_newest_canonical_duplicate(tmp_path):
    from novelvideo.director_world import stage_manifest

    older_snapshot = {
        "schemaVersion": 1,
        "savedAt": 1,
        "world": {"activeSourceId": "legacy:master:sog:/static/master.sog"},
        "actors": [{"id": "older"}],
    }
    newer_snapshot = {
        "schemaVersion": 1,
        "savedAt": 2,
        "world": {"activeSourceId": "legacy:master:sog:/static/master.sog?v=222"},
        "actors": [{"id": "newer"}],
    }
    stage_manifest.update_manifest(
        tmp_path,
        "Hall",
        active_source_id="legacy:master:sog:/static/master.sog",
        scene=older_snapshot,
        scenes_by_source_id={
            "legacy:master:sog:/static/master.sog": older_snapshot,
            "legacy:master:sog:/static/master.sog?v=222": newer_snapshot,
        },
    )

    result = stage_manifest.get_scene_director_world(tmp_path, "Hall")

    canonical_master = "legacy:master:sog:/static/master.sog"
    assert set(result["scenes_by_source_id"]) == {canonical_master}
    assert result["scenes_by_source_id"][canonical_master]["actors"] == [
        {"id": "newer"}
    ]
    assert (
        result["scenes_by_source_id"][canonical_master]["world"]["activeSourceId"]
        == canonical_master
    )


def test_get_scene_director_world_prefers_unversioned_duplicate_when_saved_at_ties(
    tmp_path,
):
    from novelvideo.director_world import stage_manifest

    canonical_master = "legacy:master:sog:/static/master.sog"
    canonical_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": canonical_master},
        "actors": [{"id": "canonical"}],
    }
    versioned_snapshot = {
        "schemaVersion": 1,
        "world": {"activeSourceId": f"{canonical_master}?v=222"},
        "actors": [{"id": "versioned"}],
    }
    stage_manifest.update_manifest(
        tmp_path,
        "Hall",
        active_source_id=canonical_master,
        scene=canonical_snapshot,
        scenes_by_source_id={
            canonical_master: canonical_snapshot,
            f"{canonical_master}?v=222": versioned_snapshot,
        },
    )

    result = stage_manifest.get_scene_director_world(tmp_path, "Hall")

    assert set(result["scenes_by_source_id"]) == {canonical_master}
    assert result["scenes_by_source_id"][canonical_master]["actors"] == [
        {"id": "canonical"}
    ]
    assert (
        result["scenes_by_source_id"][canonical_master]["world"]["activeSourceId"]
        == canonical_master
    )


@pytest.mark.asyncio
async def test_upload_scene_pano_validates_ratio_and_updates_manifest(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(name="Hall")
    _patch_project(monkeypatch, scenes, tmp_path, _SceneStore([scene]))
    upload = UploadFile(file=io.BytesIO(_png_bytes((4, 2))), filename="pano.png")

    res = await scenes.upload_scene_pano(
        project="demo",
        name="Hall",
        file=upload,
        user={"username": "admin"},
    )

    pano_path = stage_manifest.stage_dir(tmp_path, "Hall") / "pano_360.png"
    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    assert res["ok"] is True
    assert pano_path.exists()
    assert manifest["pano_path"] == "pano_360.png"
    assert manifest["source"] == "uploaded_360"


@pytest.mark.asyncio
async def test_upload_scene_custom_package_updates_custom_manifest_slot(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(name="Hall")
    _patch_project(monkeypatch, scenes, tmp_path, _SceneStore([scene]))
    upload = UploadFile(file=io.BytesIO(b"sog package"), filename="scene.sog")

    res = await scenes.upload_scene_custom_package(
        project="demo",
        name="Hall",
        file=upload,
        user={"username": "admin"},
    )

    custom_path = stage_manifest.stage_dir(tmp_path, "Hall") / "custom.sog"
    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    asset = res["data"]
    assert res["ok"] is True
    assert custom_path.exists()
    assert manifest["source"] == "custom_scene"
    assert manifest["ply_path"] == "custom.sog"
    assert manifest["custom_scene_path"] == "custom.sog"
    assert (
        asset["custom_scene_url"]
        == "/static/projects/proj_demo/director_worlds/Hall/v1/custom.sog"
    )


@pytest.mark.asyncio
async def test_upload_scene_custom_package_streams_sog_without_full_read(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(name="Hall")
    _patch_project(monkeypatch, scenes, tmp_path, _SceneStore([scene]))
    upload = UploadFile(file=io.BytesIO(b"sog package"), filename="scene.sog")

    async def fail_full_read():
        raise MemoryError("full upload read should not be required")

    monkeypatch.setattr(upload, "read", fail_full_read)

    res = await scenes.upload_scene_custom_package(
        project="demo",
        name="Hall",
        file=upload,
        user={"username": "admin"},
    )

    custom_path = stage_manifest.stage_dir(tmp_path, "Hall") / "custom.sog"
    assert res["ok"] is True
    assert custom_path.read_bytes() == b"sog package"


@pytest.mark.asyncio
async def test_generate_scene_pano_returns_scope_and_falls_back_to_text(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    scene = NovelScene(name="Hall", environment_prompt="wide hall")
    _patch_project(monkeypatch, scenes, tmp_path, _SceneStore([scene]))

    res = await scenes.generate_scene_pano(
        project="demo",
        name="Hall",
        body=ScenePanoGenerateRequest(source="master"),
        user={"username": "admin"},
    )

    assert res["ok"] is False
    assert "project context" in res["error"]


@pytest.mark.asyncio
async def test_generate_scene_3gs_ply_routes_match_nicegui_task_params(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(name="Hall", environment_prompt="wide hall")
    scene_dir = tmp_path / "assets" / "scenes" / "Hall"
    scene_dir.mkdir(parents=True)
    (scene_dir / "master.png").write_bytes(b"master")
    (scene_dir / "reverse_master.png").write_bytes(b"reverse")
    stage_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    stage_dir.mkdir(parents=True)
    (stage_dir / "pano_360.png").write_bytes(b"pano")
    stage_manifest.update_manifest(tmp_path, "Hall", pano_path="pano_360.png")
    store = _SceneStore([scene])
    _patch_project(monkeypatch, scenes, tmp_path, store)

    master_res = await scenes.generate_scene_3gs_master_ply(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )
    reverse_res = await scenes.generate_scene_3gs_reverse_ply(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )
    pano_res = await scenes.generate_scene_3gs_pano_ply(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )

    assert master_res["ok"] is False
    assert "project context" in master_res["error"]
    assert reverse_res["ok"] is False
    assert "project context" in reverse_res["error"]
    assert pano_res["ok"] is False
    assert "project context" in pano_res["error"]


@pytest.mark.asyncio
async def test_generate_scene_reference_assets_default_to_project_style(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    scene = NovelScene(name="Hall", environment_prompt="wide hall")
    _patch_project(monkeypatch, scenes, tmp_path, _SceneStore([scene]))

    res = await scenes.generate_scene_master(
        project="demo",
        name="Hall",
        user={"username": "admin"},
    )

    assert res["ok"] is False
    assert "project context" in res["error"]


@pytest.mark.asyncio
async def test_update_scene_renames_record_and_asset_directories(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    scene = NovelScene(
        name="Hall", scene_type="interior", environment_prompt="wide hall"
    )
    asset_dir = tmp_path / "assets" / "scenes" / "Hall"
    asset_dir.mkdir(parents=True)
    (asset_dir / "master.png").write_bytes(b"master")
    stage_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    stage_dir.mkdir(parents=True)
    (stage_dir / "pano_360.png").write_bytes(b"pano")
    stage_manifest.update_manifest(tmp_path, "Hall", pano_path="pano_360.png")
    store = _SceneStore([scene])
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.update_scene(
        project="demo",
        name="Hall",
        body=SceneUpdate(name="GrandHall", environment_prompt="brighter hall"),
        user={"username": "admin"},
    )

    assert res["ok"] is True
    assert res["data"]["name"] == "GrandHall"
    assert await store.get_scene("Hall") is None
    assert (await store.get_scene("GrandHall")).environment_prompt == "brighter hall"
    assert not (tmp_path / "assets" / "scenes" / "Hall").exists()
    assert (tmp_path / "assets" / "scenes" / "GrandHall" / "master.png").exists()
    assert not stage_manifest.stage_dir(tmp_path, "Hall").exists()
    assert (stage_manifest.stage_dir(tmp_path, "GrandHall") / "pano_360.png").exists()


@pytest.mark.asyncio
async def test_update_scene_rejects_renaming_base_scene_with_derived_scenes(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    store = _SceneStore(
        [
            NovelScene(name="故宫"),
            NovelScene(name="故宫_下雪", base_scene_id="故宫", variant_id="下雪"),
        ]
    )
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.update_scene(
        project="demo",
        name="故宫",
        body=SceneUpdate(name="紫禁城"),
        user={"username": "admin"},
    )

    assert res["ok"] is False
    assert "派生场景" in res["error"]
    assert await store.get_scene("故宫") is not None
    assert await store.get_scene("紫禁城") is None


@pytest.mark.asyncio
async def test_delete_scene_rejects_base_scene_with_derived_scenes(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    store = _SceneStore(
        [
            NovelScene(name="故宫"),
            NovelScene(name="故宫_下雪", base_scene_id="故宫", variant_id="下雪"),
        ]
    )
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.delete_scene(
        project="demo",
        name="故宫",
        user={"username": "admin"},
    )

    assert res["ok"] is False
    assert "派生场景" in res["error"]
    assert await store.get_scene("故宫") is not None
    assert await store.get_scene("故宫_下雪") is not None


@pytest.mark.asyncio
async def test_delete_scene_allows_leaf_scene_plate(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes

    store = _SceneStore(
        [
            NovelScene(name="公寓楼家门口"),
            NovelScene(
                name="公寓楼家门口_上午",
                base_scene_id="公寓楼家门口",
                time_of_day="上午",
            ),
        ]
    )
    _patch_project(monkeypatch, scenes, tmp_path, store)

    res = await scenes.delete_scene(
        project="demo",
        name="公寓楼家门口_上午",
        user={"username": "admin"},
    )

    assert res["ok"] is True
    assert res["data"]["deleted"] is True
    assert await store.get_scene("公寓楼家门口") is not None
    assert await store.get_scene("公寓楼家门口_上午") is None


@pytest.mark.asyncio
async def test_build_scenes_allows_supplement_when_derived_scenes_exist(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    store = _SceneStore(
        [
            NovelScene(name="故宫"),
            NovelScene(name="故宫_下雪", base_scene_id="故宫", variant_id="下雪"),
        ]
    )
    _patch_project(monkeypatch, scenes, tmp_path, store)

    async def fake_resolve_scene_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return (
            _ctx(tmp_path),
            "admin",
            "demo",
            tmp_path,
            str(tmp_path),
            store,
        )

    async def fake_enqueue_project_task(*_args, **_kwargs):
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-scene-build"),
            backend="celery",
            queue="default",
        )

    monkeypatch.setattr(scenes, "_resolve_scene_project", fake_resolve_scene_project)
    monkeypatch.setattr(
        scenes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    res = await scenes.build_scenes(project="demo", user={"username": "admin"})

    assert res["ok"] is True
    assert res["task_type"] == "build_scenes"
    assert res["task_id"] == "task-scene-build"
    assert res["message"] == "场景补充任务已进入队列"


@pytest.mark.asyncio
async def test_list_props_returns_reference_url(tmp_path, monkeypatch):
    from novelvideo.api.routes import props

    prop = NovelProp(name="Sword", visual_prompt="silver sword")
    store = _PropStore([prop])
    _patch_project(monkeypatch, props, tmp_path, store)
    prop_dir = tmp_path / "assets" / "props" / "Sword"
    prop_dir.mkdir(parents=True)
    (prop_dir / "reference_3view.png").write_bytes(b"ref")

    res = await props.list_props(
        project="demo",
        user={"username": "admin"},
    )

    asset = res["data"][0]
    assert (
        asset["reference_url"]
        == "/static/projects/proj_demo/assets/props/Sword/reference_3view.png"
    )
    assert asset["scope"] == "global"
    assert asset["updated_at"]


@pytest.mark.asyncio
async def test_list_props_defaults_to_global_props(tmp_path, monkeypatch):
    from novelvideo.api.routes import props

    episode = NovelEpisode(
        number=2,
        title="Ep2",
        prop_menu=[
            {"prop_id": "GlobalSword", "description": "already global"},
            {
                "prop_id": "LocalCharm",
                "prop_type": "artifact",
                "description": "one-off charm",
            },
        ],
        updated_at="2026-05-21 03:12:44",
    )
    _patch_project(
        monkeypatch,
        props,
        tmp_path,
        _PropEpisodeStore([NovelProp(name="GlobalSword")], [episode]),
    )

    res = await props.list_props(
        project="demo",
        user={"username": "admin"},
    )

    assert [item["name"] for item in res["data"]] == ["GlobalSword"]
    assert res["data"][0]["scope"] == "global"


@pytest.mark.asyncio
async def test_list_props_scope_all_includes_episode_local_props(tmp_path, monkeypatch):
    from novelvideo.api.routes import props

    episode = NovelEpisode(
        number=2,
        title="Ep2",
        prop_menu=[
            {"prop_id": "GlobalSword", "description": "already global"},
            {
                "prop_id": "LocalCharm",
                "prop_type": "artifact",
                "description": "one-off charm",
            },
        ],
        updated_at="2026-05-21 03:12:44",
    )
    _patch_project(
        monkeypatch,
        props,
        tmp_path,
        _PropEpisodeStore([NovelProp(name="GlobalSword")], [episode]),
    )

    res = await props.list_props(
        project="demo",
        scope="all",
        user={"username": "admin"},
    )

    by_name = {item["name"]: item for item in res["data"]}
    assert by_name["GlobalSword"]["scope"] == "global"
    assert by_name["LocalCharm"]["scope"] == "local"
    assert by_name["LocalCharm"]["source_episode"] == 2
    assert by_name["LocalCharm"]["updated_at"] == "2026-05-21T03:12:44Z"


@pytest.mark.asyncio
async def test_list_props_scope_local_only_returns_episode_local_props(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import props

    episode = NovelEpisode(
        number=2,
        title="Ep2",
        prop_menu=[
            {"prop_id": "GlobalSword", "description": "already global"},
            {
                "prop_id": "LocalCharm",
                "prop_type": "artifact",
                "description": "one-off charm",
            },
        ],
        updated_at="2026-05-21 03:12:44",
    )
    _patch_project(
        monkeypatch,
        props,
        tmp_path,
        _PropEpisodeStore([NovelProp(name="GlobalSword")], [episode]),
    )

    res = await props.list_props(
        project="demo",
        scope="local",
        user={"username": "admin"},
    )

    assert [item["name"] for item in res["data"]] == ["LocalCharm"]
    assert res["data"][0]["scope"] == "local"


@pytest.mark.asyncio
async def test_asset_references_match_beat_asset_ids(monkeypatch, tmp_path):
    from novelvideo.api.routes import assets

    class Store:
        async def initialize(self):
            return None

        async def load_graph_state(self):
            return None

        async def list_visual_beats(self):
            return [
                NovelVisualBeat(
                    episode_number=1,
                    beat_number=12,
                    narration="n",
                    visual_description="v",
                    detected_identities_json='["苏清晏_少女"]',
                    detected_props_json='["油泼辣子"]',
                    scene_ref_json='{"scene_id": "兰州拉面馆"}',
                ),
                NovelVisualBeat(
                    episode_number=3,
                    beat_number=4,
                    narration="n",
                    visual_description="v",
                    detected_identities_json='["路人_青年"]',
                    detected_props_json='["木凳"]',
                    scene_ref_json='{"scene_id": "兰州拉面馆"}',
                ),
            ]

    ctx = SimpleNamespace(
        project_id="proj_demo",
        owner_username="admin",
        project_name="demo",
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
    )

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        assert project == "proj_demo"
        assert required_role == "viewer"
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    async def fake_make_sqlite_store_for_context(ctx_arg):
        assert ctx_arg is ctx
        return Store()

    monkeypatch.setattr(assets, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(
        assets, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )

    res = await assets.get_asset_references(
        project="proj_demo",
        asset_type="scene",
        asset_id="兰州拉面馆",
        user={"username": "admin"},
    )

    assert res == {
        "ok": True,
        "data": {
            "beats": [
                {"episode": 1, "beat_number": 12},
                {"episode": 3, "beat_number": 4},
            ],
            "co_identities": ["苏清晏_少女", "路人_青年"],
            "co_props": ["木凳", "油泼辣子"],
        },
    }


@pytest.mark.asyncio
async def test_update_prop_renames_record_and_asset_directory(tmp_path, monkeypatch):
    from novelvideo.api.routes import props

    prop = NovelProp(name="Sword", visual_prompt="silver sword")
    prop_dir = tmp_path / "assets" / "props" / "Sword"
    prop_dir.mkdir(parents=True)
    (prop_dir / "reference_3view.png").write_bytes(b"ref")
    store = _PropStore([prop])
    _patch_project(monkeypatch, props, tmp_path, store)

    res = await props.update_prop(
        project="demo",
        name="Sword",
        body=PropUpdate(name="MoonSword", visual_prompt="moonlit sword"),
        user={"username": "admin"},
    )

    assert res["ok"] is True
    assert res["data"]["name"] == "MoonSword"
    assert await store.get_prop("Sword") is None
    assert (await store.get_prop("MoonSword")).visual_prompt == "moonlit sword"
    assert not (tmp_path / "assets" / "props" / "Sword").exists()
    assert (
        tmp_path / "assets" / "props" / "MoonSword" / "reference_3view.png"
    ).exists()


@pytest.mark.asyncio
async def test_generate_prop_reference_returns_scope(tmp_path, monkeypatch):
    from novelvideo.api.routes import props

    prop = NovelProp(name="Sword", visual_prompt="silver sword")
    _patch_project(monkeypatch, props, tmp_path, _PropStore([prop]))

    res = await props.generate_prop_reference(
        project="demo",
        name="Sword",
        user={"username": "admin"},
    )

    assert res["ok"] is False
    assert "project context" in res["error"]


@pytest.mark.asyncio
async def test_batch_generate_prop_references_starts_batch_task(tmp_path, monkeypatch):
    from novelvideo.api.routes import props

    _patch_project(monkeypatch, props, tmp_path, _PropStore([]))

    res = await props.batch_generate_prop_references(
        project="demo",
        user={"username": "admin"},
    )

    assert res["ok"] is False
    assert "project context" in res["error"]

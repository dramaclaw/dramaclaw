from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.runners import sketch as sketch_runner
from novelvideo.task_backend.runners import render as render_runner


pytestmark = pytest.mark.m09


def _project_ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_freezone",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="admin",
        requester_user_id="owner_1",
        requester_username="admin",
        requester_principals=(("user", "owner_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


@pytest.mark.asyncio
async def test_frame_skill_render_uses_canvas_sketch_input_without_mainline_sketch_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.generators import nanobanana_grid
    from novelvideo.generators import pool_indexer

    ctx = _project_ctx(tmp_path)
    canvas_sketch_path = tmp_path / "canvas" / "sketch.png"
    canvas_sketch_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (160, 90), "white").save(canvas_sketch_path)
    identity_path = tmp_path / "canvas" / "identity.png"
    prop_path = tmp_path / "canvas" / "prop.png"
    Image.new("RGB", (64, 64), "red").save(identity_path)
    Image.new("RGB", (64, 64), "green").save(prop_path)

    captured: dict = {}

    async def fake_ensure_scene_refs_for_beats(**_kwargs):
        return {"requested": 0, "generated": 0, "skipped": 0, "missing": 0, "director_refs": 0}

    async def fake_regenerate_selected_beats(**kwargs):
        captured.update(kwargs)
        output_path = Path(kwargs["output_dir"]) / "regen_1x1_16-9_g01.png"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (160, 90), "blue").save(output_path)
        return [
            SimpleNamespace(
                success=True,
                grid_image_path=str(output_path),
                error=None,
                beat_count=1,
                grid_rows=1,
                grid_cols=1,
            )
        ]

    def fake_save_grid_and_split(**kwargs):
        return {"grid_path": kwargs["grid_image_path"], "cell_paths": [Path("beat_03.png")], "added": 1, "skipped": 0}

    monkeypatch.setattr(render_runner, "_ensure_scene_refs_for_beats", fake_ensure_scene_refs_for_beats)
    monkeypatch.setattr(nanobanana_grid, "regenerate_selected_beats", fake_regenerate_selected_beats)
    monkeypatch.setattr(pool_indexer, "save_grid_and_split", fake_save_grid_and_split)

    result = await render_runner._run_selected_regen_async(
        {
            "task_type": "mainline_frame_from_context",
            "episode": 1,
            "beat_num": 3,
            "scope": "job_canvas",
            "payload": {
                "output_dir": str(ctx.output_dir),
                "mode_key": "1x1_16-9",
                "config": {
                    "mode_key": "1x1_16-9",
                    "selected_beat_numbers": [3],
                    "beats": [
                        {
                            "episode_number": 1,
                            "beat_number": 3,
                            "scene_ref": {"scene_id": "S"},
                            "detected_identities": ["杜晨_孩童时期"],
                            "detected_props": ["纸箱"],
                        }
                    ],
                    "character_map": {"杜晨": {"reference_mode": "prompt_only"}},
                    "canvas_sketch_paths": {"3": str(canvas_sketch_path)},
                    "canvas_identity_refs": [
                        {
                            "beat_number": 3,
                            "identity_id": "杜晨_孩童时期",
                            "image_path": str(identity_path),
                        }
                    ],
                    "canvas_prop_refs": [
                        {"beat_number": 3, "prop_id": "纸箱", "image_path": str(prop_path)}
                    ],
                    "promote_selected_regen": False,
                },
            },
        },
        ctx,
        is_sketch=False,
    )

    assert captured["sketch_dir"].endswith("grids/ep001/sketch")
    assert captured["beat_sketch_paths_override"] == {3: str(canvas_sketch_path)}
    assert captured["character_map"]["杜晨"]["ref_path"] == str(identity_path)
    assert captured["prop_refs_override"][1][0].base_id == "纸箱"
    assert captured["prop_refs_override"][1][0].image_paths == [str(prop_path)]
    assert result["updated_beats"] == [3]


@pytest.mark.asyncio
async def test_standalone_frame_skill_render_uses_zero_based_local_panel(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.generators import nanobanana_grid
    from novelvideo.generators import pool_indexer

    ctx = _project_ctx(tmp_path)
    canvas_sketch_path = tmp_path / "canvas" / "sketch.png"
    canvas_sketch_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (160, 90), "white").save(canvas_sketch_path)
    background_path = tmp_path / "canvas" / "background.png"
    identity_path = tmp_path / "canvas" / "identity.png"
    prop_path = tmp_path / "canvas" / "prop.png"
    Image.new("RGB", (160, 90), "gray").save(background_path)
    Image.new("RGB", (64, 64), "red").save(identity_path)
    Image.new("RGB", (64, 64), "green").save(prop_path)

    captured: dict = {}
    save_calls: list[dict] = []

    async def fake_ensure_scene_refs_for_beats(**_kwargs):
        return {"requested": 0, "generated": 0, "skipped": 0, "missing": 0, "director_refs": 0}

    async def fake_regenerate_selected_beats(**kwargs):
        captured.update(kwargs)
        assert kwargs["selected_beats"][0]["episode_number"] == 0
        assert kwargs["selected_beats"][0]["beat_number"] == 0
        assert kwargs["selected_beats"][0]["panel_index"] == 0
        output_path = Path(kwargs["output_dir"]) / "regen_1x1_16-9_standalone.png"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (160, 90), "blue").save(output_path)
        return [
            SimpleNamespace(
                success=True,
                grid_image_path=str(output_path),
                error=None,
                beat_count=1,
                grid_rows=1,
                grid_cols=1,
            )
        ]

    def fake_save_grid_and_split(**kwargs):
        save_calls.append(kwargs)
        return {
            "grid_path": kwargs["grid_image_path"],
            "cell_paths": [Path("panel_01.png")],
            "added": 1,
            "skipped": 0,
        }

    monkeypatch.setattr(render_runner, "_ensure_scene_refs_for_beats", fake_ensure_scene_refs_for_beats)
    monkeypatch.setattr(nanobanana_grid, "regenerate_selected_beats", fake_regenerate_selected_beats)
    monkeypatch.setattr(pool_indexer, "save_grid_and_split", fake_save_grid_and_split)

    result = await render_runner._run_selected_regen_async(
        {
            "task_type": "mainline_frame_from_context",
            "episode": 0,
            "scope": "job_standalone",
            "payload": {
                "output_dir": str(ctx.output_dir),
                "mode_key": "1x1_16-9",
                "config": {
                    "standalone_beat_context": True,
                    "mode_key": "1x1_16-9",
                    "selected_panel_indices": [0],
                    "beats": [
                        {
                            "episode_number": 0,
                            "beat_number": 0,
                            "panel_index": 0,
                            "scene_ref": {"scene_id": ""},
                            "visual_description": "用户自定义分镜",
                            "detected_identities": ["Kris_Kris"],
                            "detected_props": ["雨伞"],
                        }
                    ],
                    "character_map": {"Kris": {"reference_mode": "prompt_only"}},
                    "canvas_sketch_paths": {"0": str(canvas_sketch_path)},
                    "canvas_scene_refs": [
                        {"panel_index": 0, "image_path": str(background_path), "base_id": "背景"}
                    ],
                    "canvas_identity_refs": [
                        {
                            "panel_index": 0,
                            "identity_id": "Kris_Kris",
                            "image_path": str(identity_path),
                        }
                    ],
                    "canvas_prop_refs": [
                        {"panel_index": 0, "prop_id": "雨伞", "image_path": str(prop_path)}
                    ],
                    "promote_selected_regen": False,
                },
            },
        },
        ctx,
        is_sketch=False,
    )

    assert captured["beat_sketch_paths_override"] == {0: str(canvas_sketch_path)}
    assert captured["character_map"]["Kris"]["ref_path"] == str(identity_path)
    assert captured["scene_refs_override"][1][0].image_paths == [str(background_path)]
    assert captured["prop_refs_override"][1][0].image_paths == [str(prop_path)]
    assert save_calls[0]["beat_nums"] == [0]
    assert result["updated_beats"] == [0]
    assert result["grid_results"][0]["beat_nums"] == [0]


@pytest.mark.asyncio
async def test_standalone_frame_skill_render_normalizes_legacy_local_panel_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.generators import nanobanana_grid
    from novelvideo.generators import pool_indexer

    ctx = _project_ctx(tmp_path)
    canvas_sketch_path = tmp_path / "canvas" / "sketch.png"
    canvas_sketch_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (160, 90), "white").save(canvas_sketch_path)

    captured: dict = {}

    async def fake_ensure_scene_refs_for_beats(**_kwargs):
        return {"requested": 0, "generated": 0, "skipped": 0, "missing": 0, "director_refs": 0}

    async def fake_regenerate_selected_beats(**kwargs):
        captured.update(kwargs)
        selected_beat = kwargs["selected_beats"][0]
        assert selected_beat["episode_number"] == 0
        assert selected_beat["beat_number"] == 0
        assert selected_beat["panel_index"] == 0
        output_path = Path(kwargs["output_dir"]) / "regen_1x1_16-9_standalone.png"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (160, 90), "blue").save(output_path)
        return [
            SimpleNamespace(
                success=True,
                grid_image_path=str(output_path),
                error=None,
                beat_count=1,
                grid_rows=1,
                grid_cols=1,
            )
        ]

    def fake_save_grid_and_split(**kwargs):
        return {
            "grid_path": kwargs["grid_image_path"],
            "cell_paths": [Path("panel_00.png")],
            "added": 1,
            "skipped": 0,
        }

    monkeypatch.setattr(render_runner, "_ensure_scene_refs_for_beats", fake_ensure_scene_refs_for_beats)
    monkeypatch.setattr(nanobanana_grid, "regenerate_selected_beats", fake_regenerate_selected_beats)
    monkeypatch.setattr(pool_indexer, "save_grid_and_split", fake_save_grid_and_split)

    result = await render_runner._run_selected_regen_async(
        {
            "task_type": "mainline_frame_from_context",
            "episode": 0,
            "scope": "job_standalone_legacy",
            "payload": {
                "output_dir": str(ctx.output_dir),
                "mode_key": "1x1_16-9",
                "config": {
                    "standalone_beat_context": True,
                    "mode_key": "1x1_16-9",
                    "selected_beat_numbers": [1],
                    "beats": [
                        {
                            "episode_number": None,
                            "beat_number": None,
                            "scene_ref": {"scene_id": ""},
                            "visual_description": "用户自定义分镜",
                        }
                    ],
                    "character_map": {},
                    "canvas_sketch_paths": {"1": str(canvas_sketch_path)},
                    "promote_selected_regen": False,
                },
            },
        },
        ctx,
        is_sketch=False,
    )

    assert captured["beat_sketch_paths_override"] == {0: str(canvas_sketch_path)}
    assert result["updated_beats"] == [0]


@pytest.mark.asyncio
async def test_sketch_runner_accepts_missing_generation_time(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.generators import nanobanana_grid
    from novelvideo.generators import pool_indexer

    ctx = _project_ctx(tmp_path)

    class FakeGridGenerator:
        provider = "test"
        model = "fake"

        def __init__(self, **_kwargs):
            pass

        async def generate_grid(self, **kwargs):
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (160, 90), "blue").save(output_path)
            return SimpleNamespace(success=True, error=None, generation_time=None)

    def fake_save_grid_and_split(**kwargs):
        return {
            "grid_path": kwargs["grid_image_path"],
            "cell_paths": [Path("beat_01.png")],
            "added": 1,
            "skipped": 0,
        }

    monkeypatch.setattr(nanobanana_grid, "NanoBananaGridGenerator", FakeGridGenerator)
    monkeypatch.setattr(pool_indexer, "save_grid_and_split", fake_save_grid_and_split)

    result = await sketch_runner._run_sketch_generation_async(
        {
            "task_type": "mainline_sketch_from_context",
            "episode": 1,
            "scope": "job_sketch_none_time",
            "payload": {
                "output_dir": str(ctx.output_dir),
                "config": {
                    "direct_sketch_beats": True,
                    "mode_key": "1x1_16-9",
                    "beat_numbers": [1],
                    "beats": [
                        {
                            "episode_number": 1,
                            "beat_number": 1,
                            "scene_ref": {"scene_id": "S"},
                            "visual_description": "测试草图",
                        }
                    ],
                    "character_map": {},
                    "promote_direct_sketch": False,
                },
            },
        },
        ctx,
    )

    assert result["beat_numbers"] == [1]
    assert Path(result["sketch_path"]).exists()


@pytest.mark.asyncio
async def test_regenerate_selected_beats_preserves_standalone_zero_beat_number(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.generators import nanobanana_grid

    sketch_path = tmp_path / "canvas" / "sketch.png"
    sketch_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (160, 90), "white").save(sketch_path)
    captured: dict = {}

    class FakeGridGenerator:
        async def generate_grid(self, **kwargs):
            captured.update(kwargs)
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (160, 90), "blue").save(output_path)
            return nanobanana_grid.GridGenerationResult(
                success=True,
                grid_image_path=str(output_path),
                generation_time=0.0,
            )

    monkeypatch.setattr(
        nanobanana_grid,
        "create_grid_generator",
        lambda *_args, **_kwargs: FakeGridGenerator(),
    )

    results = await nanobanana_grid.regenerate_selected_beats(
        selected_beats=[
            {
                "episode_number": 0,
                "beat_number": 0,
                "panel_index": 0,
                "visual_description": "用户自定义分镜",
            }
        ],
        mode_key="1x1_16-9",
        character_map={},
        style="realistic",
        output_dir=str(tmp_path / "render"),
        is_sketch=False,
        episode_grids_dir=str(tmp_path / "grids" / "ep000"),
        beat_sketch_paths_override={0: str(sketch_path)},
    )

    assert results[0].success is True
    assert results[0].beat_count == 1
    assert captured["location_beat_numbers"] == [0]
    assert captured["beat_sketch_paths"] == {0: str(sketch_path)}


@pytest.mark.asyncio
async def test_regenerate_selected_beats_runs_images_sequentially(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.generators import nanobanana_grid

    active = 0
    max_active = 0
    completed_batches: list[tuple[int, int]] = []

    class FakeGridGenerator:
        async def generate_grid(self, **kwargs):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            try:
                await asyncio.sleep(0.01)
                output_path = Path(kwargs["output_path"])
                output_path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (16, 24), "blue").save(output_path)
                return nanobanana_grid.GridGenerationResult(
                    success=True,
                    grid_image_path=str(output_path),
                    generation_time=0.01,
                )
            finally:
                active -= 1

    monkeypatch.setattr(
        nanobanana_grid,
        "create_grid_generator",
        lambda *_args, **_kwargs: FakeGridGenerator(),
    )

    results = await nanobanana_grid.regenerate_selected_beats(
        selected_beats=[
            {"beat_number": index, "visual_description": f"Beat {index}"}
            for index in range(1, 8)
        ],
        mode_key="1x1_2-3",
        character_map={},
        style="realistic",
        output_dir=str(tmp_path / "render"),
        progress_callback=lambda completed, total: completed_batches.append(
            (completed, total)
        ),
    )

    assert max_active == 1
    assert len(results) == 7
    assert [Path(result.grid_image_path or "").name for result in results] == [
        f"regen_1x1_2-3_g{index:02d}.png" for index in range(1, 8)
    ]
    assert completed_batches == [
        (1, 7),
        (2, 7),
        (3, 7),
        (4, 7),
        (5, 7),
        (6, 7),
        (7, 7),
    ]


@pytest.mark.asyncio
async def test_generate_grid_render_accepts_standalone_zero_sketch_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.generators import nanobanana_grid

    sketch_path = tmp_path / "canvas" / "sketch.png"
    sketch_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (160, 90), "white").save(sketch_path)

    monkeypatch.setattr(
        nanobanana_grid,
        "load_precomputed_panel_detected",
        lambda _beat_numbers, _beats: {},
    )

    generator = nanobanana_grid.NanoBananaGridGenerator.__new__(
        nanobanana_grid.NanoBananaGridGenerator
    )
    generator.provider = "test"
    generator.model = "fake"
    generator.api_key = ""

    result = await generator.generate_grid(
        beats=[
            {
                "episode_number": 0,
                "beat_number": 0,
                "panel_index": 0,
                "visual_description": "用户自定义分镜",
                "detected_identities": ["Kris_Kris"],
                "detected_props": [],
            }
        ],
        character_map={"Kris": {"reference_mode": "prompt_only"}},
        sketch_colors={"Kris_Kris": "#ff00ff"},
        style="realistic",
        output_path=str(tmp_path / "render" / "grid.png"),
        rows=1,
        cols=1,
        sketch=False,
        prompt_only=True,
        sketch_dir=str(tmp_path / "missing_sketch_dir"),
        mode_key="1x1_16-9",
        beat_sketch_paths={0: str(sketch_path)},
        location_beat_numbers=[0],
    )

    assert result.success is True

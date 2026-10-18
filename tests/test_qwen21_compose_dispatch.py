"""End-to-end dispatch tests for the sketch-free Qwen-Image 2.1 "compose"
render mode (`runpod_qwen21_compose`, added 2026-10-18), through the real
`NanoBananaGridGenerator.generate_grid()` entry point — mirrors the
monkeypatch pattern in `test_multi_character_render_wrapper.py`. No DB, no
network, no GPU calls: `_resolve_scene_prop_asset_refs` and
`_call_runpod_qwen21_render_image_api` are both monkeypatched.
"""

from __future__ import annotations

import pytest
from PIL import Image

from novelvideo.generators import nanobanana_grid as grid
from novelvideo.utils.asset_resolver import ResolvedAssetRef


def _make_png(path, color=(5, 5, 5)) -> str:
    Image.new("RGB", (64, 64), color).save(path, format="PNG")
    return str(path)


def _compose_generator() -> grid.NanoBananaGridGenerator:
    return grid.NanoBananaGridGenerator(
        api_key="test-key",
        config={
            "provider": "runpod_qwen21_compose",
            "api_key": "test-key",
            "model": "qwen-image-2.1",
            "rows": 1,
            "cols": 1,
            "batch_size": 1,
            "total_panels": 1,
            "mode": "1x1",
        },
    )


def _patch_scene_prop_refs(monkeypatch, scene_path: str, prop_path: str | None = None):
    scene_ref = ResolvedAssetRef(
        asset_type="scene",
        base_id="公园",
        variant_id=None,
        image_paths=[scene_path],
        text_description="",
        source_level="scene_master",
    )
    prop_refs = {}
    if prop_path:
        prop_refs = {
            1: [
                ResolvedAssetRef(
                    asset_type="prop",
                    base_id="bucket",
                    variant_id=None,
                    image_paths=[prop_path],
                    text_description="",
                    source_level="prop_reference",
                )
            ]
        }

    def fake_resolve(*_args, **_kwargs):
        return {1: [scene_ref]}, prop_refs

    monkeypatch.setattr(grid, "_resolve_scene_prop_asset_refs", fake_resolve)


@pytest.mark.asyncio
async def test_compose_dispatch_builds_correct_reference_images(tmp_path, monkeypatch):
    scene_path = _make_png(tmp_path / "scene.png")
    bucket_path = _make_png(tmp_path / "bucket.png")
    portrait_path = _make_png(tmp_path / "portrait.png")
    _patch_scene_prop_refs(monkeypatch, scene_path, bucket_path)
    # Disable aspect-cropping for this test — it's covered on its own in
    # test_qwen21_compose_plan.py; here we just want byte-identical
    # pass-through to confirm reference_images[0] really is the scene.
    monkeypatch.setattr("novelvideo.config.RUNPOD_QWEN21_COMPOSE_CROP_TO_MODE_ASPECT", False)

    captured: dict = {}

    async def fake_call(**kwargs):
        captured.update(kwargs)
        return b"fake-png-bytes", "", ""

    monkeypatch.setattr(grid, "_call_runpod_qwen21_render_image_api", fake_call)

    generator = _compose_generator()
    character_map = {
        "Nam": {
            "name": "Nam",
            "portrait_path": portrait_path,
            "appearance_details": "",
            "identities": [],
        }
    }
    beats = [
        {
            "beat_number": 7,
            "visual_description": "{{Nam}} holds a [[bucket]] in the park.",
            "detected_identities": ["Nam"],
            "detected_props": ["bucket"],
        }
    ]

    result = await generator.generate_grid(
        beats=beats,
        character_map=character_map,
        style="chinese_period_drama",
        output_path=None,
        rows=1,
        cols=1,
        sketch=False,
        sketch_dir="",
        mode_key="1x1_2-3",
    )

    assert result.success is True, result.error
    assert "mask_image" not in captured
    assert captured["reference_images"][0][1] == open(scene_path, "rb").read()
    assert len(captured["reference_images"]) == 3  # scene + Nam + bucket
    assert "<image3>" in captured["prompt"]


@pytest.mark.asyncio
async def test_compose_dispatch_rejects_sketch_mode(tmp_path, monkeypatch):
    scene_path = _make_png(tmp_path / "scene.png")
    _patch_scene_prop_refs(monkeypatch, scene_path)

    async def fake_call(**_kwargs):
        raise AssertionError("must not call RunPod when sketch=True")

    monkeypatch.setattr(grid, "_call_runpod_qwen21_render_image_api", fake_call)

    generator = _compose_generator()
    result = await generator.generate_grid(
        beats=[{"beat_number": 1, "visual_description": "x", "detected_identities": []}],
        character_map={},
        style="chinese_period_drama",
        output_path=None,
        rows=1,
        cols=1,
        sketch=True,
        sketch_dir="",
        mode_key="1x1_2-3",
    )
    assert result.success is False


@pytest.mark.asyncio
async def test_compose_dispatch_rejects_multi_beat_grid(tmp_path, monkeypatch):
    scene_path = _make_png(tmp_path / "scene.png")
    _patch_scene_prop_refs(monkeypatch, scene_path)

    async def fake_call(**_kwargs):
        raise AssertionError("must not call RunPod for a multi-beat grid")

    monkeypatch.setattr(grid, "_call_runpod_qwen21_render_image_api", fake_call)

    generator = _compose_generator()
    generator.rows = 2
    generator.cols = 2
    generator.total_panels = 4
    result = await generator.generate_grid(
        beats=[
            {"beat_number": i, "visual_description": "x", "detected_identities": []}
            for i in range(1, 5)
        ],
        character_map={},
        style="chinese_period_drama",
        output_path=None,
        rows=2,
        cols=2,
        sketch=False,
        sketch_dir="",
        mode_key="2x2",
    )
    assert result.success is False
    assert "1x1" in (result.error or "")


@pytest.mark.asyncio
async def test_existing_runpod_qwen21_render_still_requires_sketch(tmp_path):
    # Regression guard: the sketch+mask provider's chain (`if sketch: ...
    # elif sketch_dir: ... else: error`) must be completely untouched by
    # the new compose branch inserted between them.
    generator = grid.NanoBananaGridGenerator(
        api_key="test-key",
        config={
            "provider": "runpod_qwen21_render",
            "api_key": "test-key",
            "model": "qwen-image-2.1",
            "rows": 1,
            "cols": 1,
            "batch_size": 1,
            "total_panels": 1,
            "mode": "1x1",
        },
    )
    result = await generator.generate_grid(
        beats=[
            {
                "beat_number": 1,
                "visual_description": "{{Nam}}",
                "detected_identities": ["Nam"],
            }
        ],
        character_map={"Nam": {"reference_mode": "prompt_only"}},
        style="chinese_period_drama",
        output_path=None,
        rows=1,
        cols=1,
        sketch=False,
        sketch_dir=str(tmp_path / "no_such_sketch_dir"),
        mode_key="1x1_2-3",
    )
    assert result.success is False
    assert "草图" in (result.error or "") or "sketch" in (result.error or "").lower()

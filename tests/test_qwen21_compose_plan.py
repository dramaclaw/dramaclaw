"""Unit tests for `generators/nanobanana_grid._build_qwen21_compose_plan()`
and its small helpers — the sketch-free Qwen-Image 2.1 "compose" render
mode (`runpod_qwen21_compose`, added 2026-10-18). Real tiny PNGs on disk
via PIL/`tmp_path`, no DB, no network, no GPU calls."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from novelvideo.generators import nanobanana_grid as grid
from novelvideo.utils.asset_resolver import ResolvedAssetRef


def _make_png(path, size=(64, 64), color=(10, 20, 30)):
    img = Image.new("RGB", size, color)
    img.save(path, format="PNG")
    return str(path)


def _scene_ref(path: str, base_id: str = "公园") -> ResolvedAssetRef:
    return ResolvedAssetRef(
        asset_type="scene",
        base_id=base_id,
        variant_id=None,
        image_paths=[path],
        text_description="",
        source_level="scene_master",
    )


def _prop_ref(path: str, base_id: str) -> ResolvedAssetRef:
    return ResolvedAssetRef(
        asset_type="prop",
        base_id=base_id,
        variant_id=None,
        image_paths=[path],
        text_description="",
        source_level="prop_reference",
    )


def _character_map_for(tmp_path, char_name: str) -> dict:
    portrait = _make_png(tmp_path / f"{char_name}_portrait.png")
    return {
        char_name: {
            "name": char_name,
            "portrait_path": portrait,
            "appearance_details": "",
            "identities": [],
        }
    }


def test_reference_order_is_scene_then_identities_then_props(tmp_path):
    scene_path = _make_png(tmp_path / "scene.png", size=(200, 100))
    nam_map = _character_map_for(tmp_path, "Nam")
    ryan_portrait = _make_png(tmp_path / "ryan_portrait.png")
    nam_map["Ryan"] = {
        "name": "Ryan",
        "portrait_path": ryan_portrait,
        "appearance_details": "",
        "identities": [],
    }
    bucket_path = _make_png(tmp_path / "bucket.png")

    beat = {
        "visual_description": "{{Nam}} holds a [[bucket]] near {{Ryan}}.",
        "detected_identities": ["Nam", "Ryan"],
        "detected_props": ["bucket"],
    }
    scene_refs = {1: [_scene_ref(scene_path)]}
    prop_refs = {1: [_prop_ref(bucket_path, "bucket")]}

    plan, err = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=nam_map,
        scene_refs=scene_refs,
        prop_refs=prop_refs,
        mode_key=None,
    )
    assert plan is not None, err
    assert len(plan.reference_images) == 4
    # Scene is always first (image1).
    assert plan.reference_images[0][1] == open(scene_path, "rb").read()
    kinds = [r["kind"] for r in plan.audit_refs]
    assert kinds == ["scene", "identity", "identity", "prop"]
    assert "<image1>" in plan.prompt
    assert "<image4>" in plan.prompt
    assert "<image5>" not in plan.prompt


def test_unique_file_names_even_with_colliding_source_basenames(tmp_path):
    # Two different directories, each holding a file literally named
    # "primary.png" — this is exactly the collision the real
    # `_webai_ref_filename(i, mime)` naming (not `os.path.basename`) must
    # prevent, since the RunPod worker reads uploaded references by name.
    dir_a = tmp_path / "a"
    dir_b = tmp_path / "b"
    dir_a.mkdir()
    dir_b.mkdir()
    nam_path = _make_png(dir_a / "primary.png", color=(1, 1, 1))
    ryan_path = _make_png(dir_b / "primary.png", color=(2, 2, 2))
    scene_path = _make_png(tmp_path / "scene.png")

    character_map = {
        "Nam": {"name": "Nam", "portrait_path": nam_path, "appearance_details": "", "identities": []},
        "Ryan": {"name": "Ryan", "portrait_path": ryan_path, "appearance_details": "", "identities": []},
    }
    beat = {
        "visual_description": "{{Nam}} and {{Ryan}} stand together.",
        "detected_identities": ["Nam", "Ryan"],
        "detected_props": [],
    }
    plan, err = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={},
        mode_key=None,
    )
    assert plan is not None, err
    names = [name for name, _data, _mime in plan.reference_images]
    assert len(names) == len(set(names)), f"collided reference filenames: {names}"
    # Confirm the two portraits are both actually present (not one
    # silently overwriting the other).
    datas = [data for _name, data, _mime in plan.reference_images]
    assert open(nam_path, "rb").read() in datas
    assert open(ryan_path, "rb").read() in datas


def test_missing_scene_image_returns_error():
    beat = {"visual_description": "Empty park.", "detected_identities": [], "detected_props": []}
    plan, err = grid._build_qwen21_compose_plan(
        beat=beat, character_map={}, scene_refs={}, prop_refs={}, mode_key=None
    )
    assert plan is None
    assert err


def test_prop_without_image_excluded_from_images_but_kept_in_text(tmp_path):
    scene_path = _make_png(tmp_path / "scene.png")
    beat = {
        "visual_description": "{{Nam}} looks for a [[shovel]] in the sandbox.",
        "detected_identities": ["Nam"],
        "detected_props": ["shovel"],
    }
    character_map = _character_map_for(tmp_path, "Nam")
    # prop_refs intentionally has NO entry for "shovel" (no reference image
    # resolved) — the marker must still be named in the prompt text.
    plan, err = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={},
        mode_key=None,
    )
    assert plan is not None, err
    assert len(plan.reference_images) == 2  # scene + Nam only
    assert "shovel" in plan.prompt
    assert not any(r["kind"] == "prop" for r in plan.audit_refs)


def test_more_than_16_total_references_are_capped(tmp_path):
    scene_path = _make_png(tmp_path / "scene.png")
    character_map = _character_map_for(tmp_path, "Nam")
    prop_entries = []
    prop_ids = []
    for i in range(20):
        p = _make_png(tmp_path / f"prop_{i}.png")
        prop_entries.append(_prop_ref(p, f"prop{i}"))
        prop_ids.append(f"prop{i}")
    beat = {
        "visual_description": "{{Nam}} stands surrounded by props.",
        "detected_identities": ["Nam"],
        "detected_props": prop_ids,
    }
    plan, err = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={1: prop_entries},
        mode_key=None,
    )
    assert plan is not None, err
    assert len(plan.reference_images) <= 16


def test_crop_on_produces_target_aspect_crop_off_preserves_original(tmp_path, monkeypatch):
    scene_path = _make_png(tmp_path / "scene.png", size=(400, 200))  # 2:1
    character_map = _character_map_for(tmp_path, "Nam")
    beat = {
        "visual_description": "{{Nam}} stands.",
        "detected_identities": ["Nam"],
        "detected_props": [],
    }

    monkeypatch.setattr(
        "novelvideo.config.RUNPOD_QWEN21_COMPOSE_CROP_TO_MODE_ASPECT", True
    )
    plan_cropped, err = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={},
        mode_key="1x1_2-3",
    )
    assert plan_cropped is not None, err
    cropped_bytes = plan_cropped.reference_images[0][1]
    cropped_img = Image.open(io.BytesIO(cropped_bytes))
    w, h = cropped_img.size
    assert abs((w / h) - (2 / 3)) < 0.02

    monkeypatch.setattr(
        "novelvideo.config.RUNPOD_QWEN21_COMPOSE_CROP_TO_MODE_ASPECT", False
    )
    plan_uncropped, err2 = grid._build_qwen21_compose_plan(
        beat=beat,
        character_map=character_map,
        scene_refs={1: [_scene_ref(scene_path)]},
        prop_refs={},
        mode_key="1x1_2-3",
    )
    assert plan_uncropped is not None, err2
    uncropped_bytes = plan_uncropped.reference_images[0][1]
    uncropped_img = Image.open(io.BytesIO(uncropped_bytes))
    assert uncropped_img.size == (400, 200)

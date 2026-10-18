"""Unit tests for the 2026-10-18 age/identity-fidelity fix in the
Qwen-Image 2.1 multi-character render path:

- `qwen_edit_subject_body_hints()` — resolves non-identifying body-size
  hints for `scene_only`.
- `_qwen21_render_call_image_api_for_multi_character()` — boosts cfg and
  adds a real negative prompt for the masked (inpaint) pass only, leaving
  the unmasked (`scene_only`) pass at the official recipe.

No DB, no network, no RunPod calls — `_call_runpod_qwen21_render_image_api`
is monkeypatched.
"""

from __future__ import annotations

import pytest

from novelvideo.generators import nanobanana_grid as grid


def test_subject_body_hints_resolve_from_identity_level_body_type():
    # Shape matches the REAL `character_map` built by
    # `api/routes/generation.py:_build_character_map` /
    # `services/character_ref_service.py` — a list of `identities` dicts
    # matched by `identity_name`, NOT a `identity_body_types` dict (that
    # shape belongs to a different, unrelated char_map built by
    # `agents/global_video_optimizer.py`; a first version of this test used
    # that wrong shape and passed while the live function silently
    # returned no hints — found via a real `render/review` call
    # 2026-10-18).
    character_map = {
        "Nam": {
            "body_type": "fallback character-level build",
            "identities": [
                {
                    "identity_name": "幼年时期",
                    "body_type": "Small, soft toddler build with round cheeks",
                }
            ],
        }
    }
    beat = {"detected_identities": ["Nam_幼年时期"]}
    hints = grid.qwen_edit_subject_body_hints(character_map, beat)
    assert hints == ["Small, soft toddler build with round cheeks"]


def test_subject_body_hints_fall_back_to_character_level_body_type():
    character_map = {"Ryan": {"body_type": "Small, plump toddler build with a round belly"}}
    beat = {"detected_identities": ["Ryan"]}
    hints = grid.qwen_edit_subject_body_hints(character_map, beat)
    assert hints == ["Small, plump toddler build with a round belly"]


def test_subject_body_hints_dedupe_and_skip_empty():
    character_map = {
        "Nam": {"body_type": "a small toddler build"},
        "Ryan": {"body_type": "a small toddler build"},
        "Teacher": {"body_type": ""},
    }
    beat = {"detected_identities": ["Nam", "Ryan", "Teacher"]}
    hints = grid.qwen_edit_subject_body_hints(character_map, beat)
    assert hints == ["a small toddler build"]


def test_subject_body_hints_empty_for_unknown_or_missing_characters():
    assert grid.qwen_edit_subject_body_hints({}, {"detected_identities": ["Ghost"]}) == []
    assert grid.qwen_edit_subject_body_hints({"Nam": {}}, {"detected_identities": ["Nam"]}) == []


@pytest.mark.asyncio
async def test_unmasked_call_keeps_official_recipe_no_boost(monkeypatch):
    captured: dict = {}

    async def fake_call(**kwargs):
        captured.update(kwargs)
        return b"bytes", "", ""

    monkeypatch.setattr(grid, "_call_runpod_qwen21_render_image_api", fake_call)

    await grid._qwen21_render_call_image_api_for_multi_character(
        api_key="k", model="m", prompt="p", reference_images=[("canvas.png", b"x", "image/png")]
    )

    assert "cfg" not in captured
    assert "negative_prompt" not in captured
    assert captured["mask_image"] is None


@pytest.mark.asyncio
async def test_masked_call_gets_boosted_cfg_and_negative_prompt(monkeypatch):
    from novelvideo.config import (
        RUNPOD_QWEN21_RENDER_INPAINT_CFG,
        RUNPOD_QWEN21_RENDER_INPAINT_NEGATIVE_PROMPT,
    )

    captured: dict = {}

    async def fake_call(**kwargs):
        captured.update(kwargs)
        return b"bytes", "", ""

    monkeypatch.setattr(grid, "_call_runpod_qwen21_render_image_api", fake_call)

    await grid._qwen21_render_call_image_api_for_multi_character(
        api_key="k",
        model="m",
        prompt="p",
        reference_images=[("scene.png", b"x", "image/png"), ("ref.png", b"y", "image/png")],
        mask_image=("mask.png", b"z", "image/png"),
    )

    assert captured["cfg"] == RUNPOD_QWEN21_RENDER_INPAINT_CFG
    assert captured["negative_prompt"] == RUNPOD_QWEN21_RENDER_INPAINT_NEGATIVE_PROMPT
    assert captured["mask_image"] == ("mask.png", b"z", "image/png")

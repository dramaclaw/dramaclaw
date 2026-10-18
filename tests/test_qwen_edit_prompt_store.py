"""Unit tests for `generators/qwen_edit_prompt_store.py` — plain file I/O,
no DB."""

from __future__ import annotations

from novelvideo.generators.qwen_edit_prompt_store import (
    load_qwen_edit_prompts,
    save_qwen_edit_prompts,
)


def test_round_trip_single_character(tmp_path):
    assert load_qwen_edit_prompts(tmp_path, 1, 4) is None

    save_qwen_edit_prompts(
        tmp_path,
        1,
        4,
        full_prompt="Replace Picture 1 with Picture 2.",
        source="ai",
    )
    loaded = load_qwen_edit_prompts(tmp_path, 1, 4)
    assert loaded is not None
    assert loaded["full_prompt"] == "Replace Picture 1 with Picture 2."
    assert loaded["source"] == "ai"
    assert loaded["inpaint_prompts"] == {}


def test_round_trip_multi_character(tmp_path):
    save_qwen_edit_prompts(
        tmp_path,
        1,
        6,
        scene_prompt="Convert Picture 1.",
        inpaint_prompts={"Tesla_1893": "Replace the person...", "老师": "Replace the person..."},
        source="manual",
    )
    loaded = load_qwen_edit_prompts(tmp_path, 1, 6)
    assert loaded["scene_prompt"] == "Convert Picture 1."
    assert loaded["inpaint_prompts"]["Tesla_1893"] == "Replace the person..."
    assert loaded["source"] == "manual"


def test_different_beats_do_not_collide(tmp_path):
    save_qwen_edit_prompts(tmp_path, 1, 4, full_prompt="beat 4 prompt")
    save_qwen_edit_prompts(tmp_path, 1, 5, full_prompt="beat 5 prompt")
    assert load_qwen_edit_prompts(tmp_path, 1, 4)["full_prompt"] == "beat 4 prompt"
    assert load_qwen_edit_prompts(tmp_path, 1, 5)["full_prompt"] == "beat 5 prompt"


def test_different_episodes_do_not_collide(tmp_path):
    save_qwen_edit_prompts(tmp_path, 1, 4, full_prompt="ep1 beat4")
    save_qwen_edit_prompts(tmp_path, 2, 4, full_prompt="ep2 beat4")
    assert load_qwen_edit_prompts(tmp_path, 1, 4)["full_prompt"] == "ep1 beat4"
    assert load_qwen_edit_prompts(tmp_path, 2, 4)["full_prompt"] == "ep2 beat4"


def test_overwrite_updates_in_place(tmp_path):
    save_qwen_edit_prompts(tmp_path, 1, 4, full_prompt="first", source="default")
    save_qwen_edit_prompts(tmp_path, 1, 4, full_prompt="second", source="manual")
    loaded = load_qwen_edit_prompts(tmp_path, 1, 4)
    assert loaded["full_prompt"] == "second"
    assert loaded["source"] == "manual"


def test_namespace_isolates_different_providers_on_the_same_beat(tmp_path):
    # Added 2026-10-18 for the Qwen-Image 2.1 render path, which shares a
    # beat with Edit-2511's saved prompts but must never collide with them.
    save_qwen_edit_prompts(
        tmp_path, 1, 7, full_prompt="edit-2511 prompt", namespace="qwen_edit"
    )
    save_qwen_edit_prompts(
        tmp_path, 1, 7, full_prompt="qwen21 prompt", namespace="qwen21_render"
    )
    assert load_qwen_edit_prompts(tmp_path, 1, 7, namespace="qwen_edit")["full_prompt"] == "edit-2511 prompt"
    assert load_qwen_edit_prompts(tmp_path, 1, 7, namespace="qwen21_render")["full_prompt"] == "qwen21 prompt"
    # default namespace ("qwen_edit") is unaffected by the explicit-namespace call
    assert load_qwen_edit_prompts(tmp_path, 1, 7)["full_prompt"] == "edit-2511 prompt"


def test_namespace_default_matches_pre_2026_10_18_behavior(tmp_path):
    save_qwen_edit_prompts(tmp_path, 1, 4, full_prompt="no namespace arg")
    assert load_qwen_edit_prompts(tmp_path, 1, 4, namespace="qwen_edit")["full_prompt"] == "no namespace arg"
    assert load_qwen_edit_prompts(tmp_path, 1, 4, namespace="qwen21_render") is None


def test_render_prompt_namespace_by_provider_mapping():
    from novelvideo.generators.qwen_edit_prompt_store import RENDER_PROMPT_NAMESPACE_BY_PROVIDER

    assert RENDER_PROMPT_NAMESPACE_BY_PROVIDER["runpod_qwen_edit"] == "qwen_edit"
    assert RENDER_PROMPT_NAMESPACE_BY_PROVIDER["runpod_qwen21_render"] == "qwen21_render"

"""Unit tests for `generators/render_review_registry.py` — pure key
lookup, no DB, no network, no LLM calls (the registry's `rewrite`
callables import their agents lazily, never touched by these tests)."""

from __future__ import annotations

from novelvideo.generators.render_review_registry import strategy_for_selection


def test_edit_2511_selections_resolve():
    for key in ("runpod_qwen_edit_render", "runpod_qwen_edit_render_multi"):
        strategy = strategy_for_selection(key)
        assert strategy is not None
        assert strategy.family == "runpod_qwen_edit"
        assert strategy.model_label == "Qwen-Image-Edit-2511"
        assert strategy.store_namespace == "qwen_edit"


def test_qwen21_render_selections_resolve():
    for key in ("runpod_qwen21_render", "runpod_qwen21_render_multi"):
        strategy = strategy_for_selection(key)
        assert strategy is not None
        assert strategy.family == "runpod_qwen21_render"
        assert strategy.model_label == "Qwen-Image 2.1"
        assert strategy.store_namespace == "qwen21_render"


def test_unrelated_selection_returns_none():
    assert strategy_for_selection("gemini_webai") is None
    assert strategy_for_selection("runpod_qwen_image_1k") is None
    assert strategy_for_selection("") is None


def test_sketch_free_compose_selection_has_no_review_strategy():
    # v1 deliberately has no RenderReviewStrategy for runpod_qwen21_compose
    # (added 2026-10-18) — the review dialog's rewrite adapters are
    # hardcoded to exactly 2 images, compose's count varies per beat. The
    # route falls back to the plain confirm dialog for this selection.
    assert strategy_for_selection("runpod_qwen21_compose") is None


def test_build_prompt_and_lint_are_wired_to_the_right_module():
    edit_strategy = strategy_for_selection("runpod_qwen_edit_render")
    qwen21_strategy = strategy_for_selection("runpod_qwen21_render")

    edit_prompt = edit_strategy.build_prompt([{"visual_description": "x"}], "full")
    qwen21_prompt = qwen21_strategy.build_prompt([{"visual_description": "x"}], "full")
    assert "Picture 1" in edit_prompt
    assert "<image1>" in qwen21_prompt

    assert edit_strategy.lint(edit_prompt, stage="full").ok
    assert qwen21_strategy.lint(qwen21_prompt, stage="full").ok
    # cross-checking the wrong lint against the other model's prompt should
    # fail — proves the two aren't accidentally sharing one lint function.
    assert not edit_strategy.lint(qwen21_prompt, stage="full").ok
    assert not qwen21_strategy.lint(edit_prompt, stage="full").ok


def test_build_prompt_accepts_subject_hints_for_scene_only():
    # Added 2026-10-18 for the toddler-rendered-as-adult fix: both
    # adapters must accept a 3rd `subject_hints` arg (qwen_edit's adapter
    # ignores it, qwen21's forwards it) without raising.
    edit_strategy = strategy_for_selection("runpod_qwen_edit_render_multi")
    qwen21_strategy = strategy_for_selection("runpod_qwen21_render_multi")
    hints = ["a small child with a toddler build"]

    edit_prompt = edit_strategy.build_prompt([{"visual_description": "x"}], "scene_only", hints)
    qwen21_prompt = qwen21_strategy.build_prompt(
        [{"visual_description": "x"}], "scene_only", hints
    )
    assert "toddler build" not in edit_prompt
    assert "toddler build" in qwen21_prompt

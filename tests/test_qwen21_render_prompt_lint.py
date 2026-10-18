"""Unit tests for `agents/qwen21_render_prompt_lint.py` and the default
templates in `generators/prompt_builder.build_qwen21_render_prompt()` —
no DB, no network, no LLM calls."""

from __future__ import annotations

from novelvideo.agents.qwen21_render_prompt_lint import lint_qwen21_render_prompt
from novelvideo.generators.prompt_builder import build_qwen21_render_prompt


def _beat(visual_description: str = "He walks into the room.") -> dict:
    return {"visual_description": visual_description}


def test_default_full_template_has_no_lint_errors():
    prompt = build_qwen21_render_prompt([_beat()], stage="full")
    lint = lint_qwen21_render_prompt(prompt, stage="full")
    assert lint.ok, [i.message for i in lint.errors]
    assert "<image1>" in prompt
    assert "<image2>" in prompt
    assert prompt.strip().startswith("Replace")


def test_default_scene_only_template_has_no_lint_errors():
    prompt = build_qwen21_render_prompt([_beat()], stage="scene_only")
    lint = lint_qwen21_render_prompt(prompt, stage="scene_only")
    assert lint.ok, [i.message for i in lint.errors]
    assert "<image1>" not in prompt
    assert "<image2>" not in prompt


def test_default_inpaint_template_has_no_lint_errors():
    prompt = build_qwen21_render_prompt([_beat()], stage="inpaint")
    lint = lint_qwen21_render_prompt(prompt, stage="inpaint")
    assert lint.ok, [i.message for i in lint.errors]
    assert "<image1>" in prompt
    assert "<image2>" in prompt


def test_inpaint_template_does_not_describe_the_scene_action():
    beat = _beat("The teacher stands at the podium lecturing. Tesla sits below, defiant.")
    inpaint_prompt = build_qwen21_render_prompt([beat], stage="inpaint")
    assert "lectur" not in inpaint_prompt.lower()
    assert "stand" not in inpaint_prompt.lower()
    assert "sit" not in inpaint_prompt.lower()

    full_prompt = build_qwen21_render_prompt([beat], stage="full")
    assert "Scene:" in full_prompt


def test_scene_only_and_inpaint_preserve_body_proportions_wording():
    # Part C of the 2026-10-18 toddler-rendered-as-adult fix: "pose" alone
    # was ambiguous (read as posture/angle only); naming body proportions
    # and size explicitly as something to preserve costs nothing.
    scene_only = build_qwen21_render_prompt([_beat()], stage="scene_only")
    assert "body proportions and size" in scene_only
    inpaint = build_qwen21_render_prompt([_beat()], stage="inpaint")
    assert "body proportions" in inpaint


def test_subject_hints_default_none_is_byte_identical_to_before():
    # Regression guard: the new optional parameter must not change
    # single-character/no-hint behavior.
    with_default = build_qwen21_render_prompt([_beat()], stage="scene_only")
    with_explicit_none = build_qwen21_render_prompt([_beat()], stage="scene_only", subject_hints=None)
    with_empty_list = build_qwen21_render_prompt([_beat()], stage="scene_only", subject_hints=[])
    assert with_default == with_explicit_none == with_empty_list


def test_subject_hints_are_included_in_scene_only_and_lint_clean():
    hints = ["a small child with a toddler build", "a small child with a round belly"]
    prompt = build_qwen21_render_prompt([_beat()], stage="scene_only", subject_hints=hints)
    assert "a small child with a toddler build" in prompt
    assert "a small child with a round belly" in prompt
    lint = lint_qwen21_render_prompt(prompt, stage="scene_only")
    assert lint.ok, [i.message for i in lint.errors]


def test_subject_hints_are_ignored_outside_scene_only():
    hints = ["a small child with a toddler build"]
    full_prompt = build_qwen21_render_prompt([_beat()], stage="full", subject_hints=hints)
    inpaint_prompt = build_qwen21_render_prompt([_beat()], stage="inpaint", subject_hints=hints)
    assert "toddler build" not in full_prompt
    assert "toddler build" not in inpaint_prompt


def test_empty_prompt_is_a_hard_error():
    lint = lint_qwen21_render_prompt("", stage="full")
    assert not lint.ok
    assert lint.errors[0].code == "empty"


def test_newline_is_a_hard_error():
    lint = lint_qwen21_render_prompt("Replace <image1> with <image2>.\nSecond line.", stage="full")
    assert any(i.code == "newline" for i in lint.errors)


def test_legacy_picture_tag_is_a_hard_error():
    lint = lint_qwen21_render_prompt("Replace Picture 1 with Picture 2.", stage="full")
    assert any(i.code == "legacy_tag" for i in lint.errors)
    assert any(i.code == "missing_image1_tag" for i in lint.errors)


def test_malformed_capitalized_tag_is_a_hard_error():
    lint = lint_qwen21_render_prompt("Replace <Image1> with <image2>.", stage="full")
    assert any(i.code == "malformed_tag" for i in lint.errors)


def test_malformed_spaced_tag_is_a_hard_error():
    lint = lint_qwen21_render_prompt("Replace <image 1> with <image2>.", stage="full")
    assert any(i.code == "malformed_tag" for i in lint.errors)


def test_tag_out_of_range_is_a_hard_error():
    lint = lint_qwen21_render_prompt("Replace <image1> with <image3>.", stage="full")
    assert any(i.code == "tag_out_of_range" for i in lint.errors)


def test_unexpected_tag_in_scene_only_is_a_hard_error():
    lint = lint_qwen21_render_prompt("Convert <image1> to a photo.", stage="scene_only")
    assert any(i.code == "unexpected_tag" for i in lint.errors)


def test_missing_image2_tag_in_full_is_a_hard_error():
    lint = lint_qwen21_render_prompt("Replace the figure in <image1>.", stage="full")
    assert any(i.code == "missing_image2_tag" for i in lint.errors)


def test_layout_word_is_a_hard_error():
    lint = lint_qwen21_render_prompt(
        "Replace the grid panel in <image1> with <image2>.", stage="full"
    )
    assert any(i.code == "layout_word" for i in lint.errors)


def test_resolution_token_is_a_hard_error():
    lint = lint_qwen21_render_prompt(
        "Replace <image1> with <image2>, output at 2K, 9:16 aspect, photorealistic.", stage="full"
    )
    assert any(i.code == "resolution_token" for i in lint.errors)


def test_json_wrapper_output_is_a_hard_error():
    lint = lint_qwen21_render_prompt('{"Rewritten": "Replace <image1> with <image2>."}', stage="full")
    assert any(i.code == "wrapper_output" for i in lint.errors)


def test_stray_think_tag_is_a_hard_error():
    # Real failure seen 2026-10-18 (BabyStories beat 7): the thinking-mode
    # model leaked a `</think>` tag with its answer duplicated around it —
    # qwen21_render_prompt_builder.py strips this in post-processing, but
    # the lint is a safety net in case something slips through.
    lint = lint_qwen21_render_prompt(
        "Replace <image1> with <image2>, keep unchanged, photorealistic. </think> "
        "Replace <image1> with <image2>, keep unchanged, photorealistic.",
        stage="full",
    )
    assert any(i.code == "wrapper_output" for i in lint.errors)


def test_quoted_text_is_a_warning():
    lint = lint_qwen21_render_prompt(
        'Replace <image1> with <image2>, keep "unchanged" photorealistic.', stage="full"
    )
    assert lint.ok
    assert any(i.code == "quoted_text" for i in lint.warnings)


def test_non_english_prose_is_a_warning():
    lint = lint_qwen21_render_prompt(
        "替换 <image1> 的人物为 <image2>, keep unchanged, photorealistic photograph.", stage="full"
    )
    assert any(i.code == "non_english_prose" for i in lint.warnings)


def test_inpaint_action_verb_is_a_warning():
    lint = lint_qwen21_render_prompt(
        "Replace the standing person in <image1> with <image2>, keep unchanged, photorealistic.",
        stage="inpaint",
    )
    assert any(i.code == "inpaint_describes_action" for i in lint.warnings)


def test_mannequin_color_word_is_a_warning():
    lint = lint_qwen21_render_prompt(
        "Replace the magenta figure in <image1> with <image2>, keep unchanged, photorealistic.",
        stage="full",
    )
    assert lint.ok
    assert any(i.code == "mannequin_color_word" for i in lint.warnings)


def test_cyan_mannequin_color_word_is_a_warning():
    # Real false-negative found 2026-10-18 (BabyStories beat 7 AI rewrite:
    # "strictly preserving the cyan-colored mannequin figure") — "cyan" is
    # in BRIDGMAN_CHARACTER_PALETTE but wasn't in the original word list.
    lint = lint_qwen21_render_prompt(
        "Replace <image1> with <image2>, keep the cyan-colored figure unchanged, photorealistic.",
        stage="full",
    )
    assert any(i.code == "mannequin_color_word" for i in lint.warnings)


def test_ordinary_clothing_colors_do_not_trigger_mannequin_color_warning():
    # These are legitimate real appearance descriptions, not sketch
    # tracking-color references — must not be flagged.
    lint = lint_qwen21_render_prompt(
        "Replace <image1> with <image2>, wearing a navy blue coat and red tie, "
        "keep unchanged, photorealistic.",
        stage="full",
    )
    assert not any(i.code == "mannequin_color_word" for i in lint.warnings)


def test_too_long_is_a_hard_error():
    prompt = "Replace <image1> with <image2>. " + ("x" * 2100)
    lint = lint_qwen21_render_prompt(prompt, stage="full")
    assert any(i.code == "too_long" for i in lint.errors)

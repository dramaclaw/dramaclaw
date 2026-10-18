"""Unit tests for `agents/qwen_edit_render_prompt_lint.py` and the default
templates in `generators/prompt_builder.build_qwen_edit_render_prompt()` —
no DB, no network, no LLM calls."""

from __future__ import annotations

from novelvideo.agents.qwen_edit_render_prompt_lint import lint_qwen_edit_render_prompt
from novelvideo.generators.prompt_builder import build_qwen_edit_render_prompt


def _beat(visual_description: str = "He walks into the room.") -> dict:
    return {"visual_description": visual_description}


def test_default_full_template_has_no_lint_errors():
    prompt = build_qwen_edit_render_prompt([_beat()], stage="full")
    lint = lint_qwen_edit_render_prompt(prompt, stage="full")
    assert lint.ok, [i.message for i in lint.errors]
    assert "Picture 1" in prompt
    assert "Picture 2" in prompt
    # Instruction clause first, style tail last — official rule §2.4.
    assert prompt.strip().startswith("Replace")
    assert prompt.strip().endswith(
        "not line art, not a sketch, not an illustration."
    )


def test_default_scene_only_template_has_no_lint_errors():
    prompt = build_qwen_edit_render_prompt([_beat()], stage="scene_only")
    lint = lint_qwen_edit_render_prompt(prompt, stage="scene_only")
    assert lint.ok, [i.message for i in lint.errors]
    assert "Picture 1" in prompt
    assert "Picture 2" not in prompt


def test_default_inpaint_template_has_no_lint_errors():
    prompt = build_qwen_edit_render_prompt([_beat()], stage="inpaint")
    lint = lint_qwen_edit_render_prompt(prompt, stage="inpaint")
    assert lint.ok, [i.message for i in lint.errors]
    assert "Picture 1" in prompt
    assert "Picture 2" in prompt


def test_inpaint_template_does_not_describe_the_scene_action():
    # A multi-character beat's visual_description describes EVERY
    # character's action — appending it to an inpaint prompt risks
    # attributing one person's action to a different identity's inpaint
    # pass (confirmed by real testing 2026-10-17, beat 6: teacher standing
    # and lecturing vs. Tesla sitting, defiant). Pose is locked by the mask,
    # not by text, so `inpaint` must not mention the beat's action at all —
    # unlike `full`/`scene_only`, which do include it.
    beat = _beat("The teacher stands at the podium lecturing. Tesla sits below, defiant.")
    inpaint_prompt = build_qwen_edit_render_prompt([beat], stage="inpaint")
    assert "lectur" not in inpaint_prompt.lower()
    assert "stand" not in inpaint_prompt.lower()
    assert "sit" not in inpaint_prompt.lower()

    full_prompt = build_qwen_edit_render_prompt([beat], stage="full")
    assert "Scene:" in full_prompt


def test_inpaint_lint_warns_on_action_verbs():
    lint = lint_qwen_edit_render_prompt(
        "Replace the person in Picture 1 with the person from Picture 2, "
        "standing and lecturing, keeping identity unchanged. Photorealistic.",
        stage="inpaint",
    )
    assert any(i.code == "inpaint_describes_action" for i in lint.warnings)


def test_full_stage_action_verbs_do_not_trigger_inpaint_warning():
    # The same check must be scoped to stage="inpaint" only — `full` is
    # expected to include a "Scene: ..." clause describing the action.
    lint = lint_qwen_edit_render_prompt(
        "Replace the mannequin figure in Picture 1 with the person from "
        "Picture 2. Scene: he stands and points. Photorealistic.",
        stage="full",
    )
    assert not any(i.code == "inpaint_describes_action" for i in lint.issues)


def test_empty_prompt_is_a_hard_error():
    lint = lint_qwen_edit_render_prompt("", stage="full")
    assert not lint.ok
    assert lint.errors[0].code == "empty"


def test_newline_is_a_hard_error():
    lint = lint_qwen_edit_render_prompt("Replace Picture 1 with Picture 2.\nSecond line.", stage="full")
    assert any(i.code == "newline" for i in lint.errors)


def test_legacy_image_n_wording_is_a_hard_error():
    lint = lint_qwen_edit_render_prompt(
        "Replace image 1 with the person from image 2.", stage="full"
    )
    assert any(i.code == "legacy_image_tag" for i in lint.errors)


def test_scene_only_mentioning_picture_2_is_a_hard_error():
    lint = lint_qwen_edit_render_prompt(
        "Convert Picture 1 to match Picture 2.", stage="scene_only"
    )
    assert any(i.code == "unexpected_picture_2" for i in lint.errors)


def test_full_missing_picture_2_is_a_hard_error():
    lint = lint_qwen_edit_render_prompt("Replace the figure in Picture 1.", stage="full")
    assert any(i.code == "missing_picture_2" for i in lint.errors)


def test_layout_word_is_a_hard_error():
    lint = lint_qwen_edit_render_prompt(
        "Replace Picture 1's grid panel with Picture 2.", stage="full"
    )
    assert any(i.code == "layout_word" for i in lint.errors)


def test_mannequin_color_word_is_a_warning_not_an_error():
    # Naming the TRACKING COLOR (e.g. magenta) is the known failure mode —
    # the bare word "mannequin" itself (used by the default template) is
    # fine and must not be flagged.
    lint = lint_qwen_edit_render_prompt(
        "Replace the magenta mannequin figure in Picture 1 with Picture 2. Photorealistic.",
        stage="full",
    )
    assert lint.ok
    assert any(i.code == "mannequin_color_word" for i in lint.warnings)


def test_cyan_mannequin_color_word_is_a_warning():
    # Regression (2026-10-18): the palette includes "cyan" but it was
    # missing from the original word list — found via the qwen21 sibling
    # lint's real-world test, fixed in both lint modules together.
    lint = lint_qwen_edit_render_prompt(
        "Replace Picture 1 with Picture 2, keep the cyan-colored figure unchanged. Photorealistic.",
        stage="full",
    )
    assert any(i.code == "mannequin_color_word" for i in lint.warnings)


def test_ordinary_clothing_colors_do_not_trigger_mannequin_color_warning():
    lint = lint_qwen_edit_render_prompt(
        "Replace Picture 1 with Picture 2, wearing a navy blue coat and red tie. Photorealistic.",
        stage="full",
    )
    assert not any(i.code == "mannequin_color_word" for i in lint.warnings)


def test_too_long_is_a_hard_error():
    prompt = "Replace Picture 1 with Picture 2. " + ("x" * 1600)
    lint = lint_qwen_edit_render_prompt(prompt, stage="full")
    assert any(i.code == "too_long" for i in lint.errors)


def test_subject_hints_kwarg_accepted_but_unused():
    # Signature symmetry with build_qwen21_render_prompt (added 2026-10-18
    # for render_review_registry.py's shared build_prompt callable type) —
    # Edit-2511's path uses a real VAEEncode'd canvas, not a zero-latent +
    # reference_latents design, and has shown no age/body-proportion bias
    # in any beat verified so far, so this must be a true no-op.
    without_hints = build_qwen_edit_render_prompt([_beat()], stage="scene_only")
    with_hints = build_qwen_edit_render_prompt(
        [_beat()], stage="scene_only", subject_hints=["a small child with a toddler build"]
    )
    assert without_hints == with_hints

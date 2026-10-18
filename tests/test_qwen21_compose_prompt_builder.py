"""Unit tests for `generators/prompt_builder.build_qwen21_compose_prompt()`
and `agents/qwen21_compose_prompt_lint.lint_qwen21_compose_prompt()` — the
sketch-free Qwen-Image 2.1 "compose" render mode (`runpod_qwen21_compose`,
added 2026-10-18). No DB, no network, no LLM/GPU calls."""

from __future__ import annotations

from novelvideo.agents.qwen21_compose_prompt_lint import lint_qwen21_compose_prompt
from novelvideo.generators.prompt_builder import build_qwen21_compose_prompt


def _beat(visual_description: str) -> dict:
    return {"visual_description": visual_description}


def test_two_identities_one_prop_has_correct_tag_range_and_lints_clean():
    beat = _beat(
        "{{Nam_幼年时期}} stands in the park facing {{Ryan_幼年时期}}, holding up a "
        "[[bucket]] toward him, her expression mocking as she speaks."
    )
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam_幼年时期", "Nam"), ("Ryan_幼年时期", "Ryan")],
        prop_images=[("bucket", "bucket")],
        identity_names={"Nam_幼年时期": "Nam", "Ryan_幼年时期": "Ryan"},
        prop_names={"bucket": "bucket"},
    )
    for tag in ("<image1>", "<image2>", "<image3>", "<image4>"):
        assert tag in prompt
    assert "<image5>" not in prompt
    lint_issues = lint_qwen21_compose_prompt(prompt, n_images=4)
    assert lint_issues == [], lint_issues


def test_role_sentences_pair_the_right_name_with_the_right_tag():
    beat = _beat("{{Nam}} and {{Ryan}} talk.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam"), ("Ryan", "Ryan")],
        prop_images=[],
        identity_names={"Nam": "Nam", "Ryan": "Ryan"},
    )
    assert "<image2> shows Nam;" in prompt
    assert "<image3> shows Ryan;" in prompt


def test_first_mention_annotated_later_mentions_plain():
    beat = _beat("{{Nam}} looks at {{Ryan}}, then {{Nam}} smiles at {{Ryan}} again.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam"), ("Ryan", "Ryan")],
        prop_images=[],
        identity_names={"Nam": "Nam", "Ryan": "Ryan"},
    )
    # First mention of Nam is annotated with its tag exactly once.
    assert prompt.count("Nam (matching <image2> exactly)") == 1
    assert prompt.count("Ryan (matching <image3> exactly)") == 1
    # The repeated mentions are plain names (no re-annotation).
    assert "{{" not in prompt and "}}" not in prompt


def test_no_markers_left_unresolved():
    beat = _beat("{{Nam}} holds a [[bucket]] near {{Ryan}} and a [[shovel]].")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[("bucket", "bucket")],
        identity_names={"Nam": "Nam", "Ryan": "Ryan"},
        prop_names={"bucket": "bucket", "shovel": "shovel"},
    )
    assert "{{" not in prompt
    assert "}}" not in prompt
    assert "[[" not in prompt
    assert "]]" not in prompt
    # Ryan has no image but is still named in the scene text.
    assert "Ryan" in prompt
    # shovel has no image but is still named in the scene text.
    assert "shovel" in prompt


def test_count_guard_text_for_two_identities():
    beat = _beat("{{Nam}} and {{Ryan}} stand together.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam"), ("Ryan", "Ryan")],
        prop_images=[],
        identity_names={"Nam": "Nam", "Ryan": "Ryan"},
    )
    assert "exactly 2 people" in prompt
    assert "Nam, Ryan" in prompt


def test_count_guard_text_for_one_identity():
    beat = _beat("{{Nam}} stands alone.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[],
        identity_names={"Nam": "Nam"},
    )
    assert "exactly 1 person" in prompt


def test_no_people_clause_when_zero_identities_detected():
    beat = _beat("The park is empty in the afternoon light.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[],
        prop_images=[],
        identity_names={},
    )
    assert "No people appear in the image." in prompt


def test_count_guard_skipped_when_identities_named_but_not_imaged():
    # 0 images but 1 named-only identity — must not contradict the scene
    # text by claiming "no people appear".
    beat = _beat("{{Nam}} stands alone.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[],
        prop_images=[],
        identity_names={"Nam": "Nam"},
    )
    assert "No people appear" not in prompt
    assert "Nam" in prompt


def test_photorealistic_and_not_a_sketch_wording_present():
    beat = _beat("{{Nam}} stands.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[],
        identity_names={"Nam": "Nam"},
    )
    assert "photorealistic" in prompt.lower()
    assert "sketch" in prompt.lower()


def test_no_quotes_no_newlines_no_self_injected_resolution_tokens():
    # The function must not inject a quote/newline/resolution token
    # itself — the beat's own narrative text is passed through as-is
    # (quote-stripped), this only asserts the TEMPLATE never adds one.
    beat = _beat('{{Nam}} says "hello" and smiles.\nHe waits.')
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[],
        identity_names={"Nam": "Nam"},
    )
    assert '"' not in prompt
    assert "\n" not in prompt
    assert "16:9" not in prompt
    assert "2K" not in prompt


def test_n_equals_1_background_only_uses_no_tags_at_all():
    beat = _beat("The park sits empty.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[],
        prop_images=[],
        identity_names={},
        prop_names={},
    )
    assert "<image" not in prompt
    lint_issues = lint_qwen21_compose_prompt(prompt, n_images=1)
    assert lint_issues == [], lint_issues


def test_chinese_identity_marker_resolves_to_plain_name():
    beat = _beat("{{Nam_幼年时期}} stands in the park.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam_幼年时期", "Nam")],
        prop_images=[],
        identity_names={"Nam_幼年时期": "Nam"},
    )
    assert "Nam_幼年时期" not in prompt
    assert "Nam" in prompt


def test_prop_image_sentence_and_scene_reference():
    beat = _beat("{{Nam}} holds a [[bucket]].")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[("bucket", "bucket")],
        identity_names={"Nam": "Nam"},
        prop_names={"bucket": "bucket"},
    )
    assert "<image3> shows the bucket;" in prompt
    assert "bucket (shown in <image3>)" in prompt


def test_no_double_comma_when_source_text_has_comma_right_after_marker():
    # Real bug found 2026-10-18 via the free dry-run verification
    # (BabyStories beat 7): "{{Ryan}}," in the source produced
    # "Ryan, matching <image3> exactly,," (doubled comma) because the old
    # annotation style always appended its own trailing comma.
    beat = _beat("{{Nam}} faces {{Ryan}}, holding something.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam"), ("Ryan", "Ryan")],
        prop_images=[],
        identity_names={"Nam": "Nam", "Ryan": "Ryan"},
    )
    assert ",," not in prompt
    assert "exactly) ," not in prompt


def test_no_double_article_when_source_text_already_has_one():
    # Real bug found 2026-10-18 via the free dry-run verification
    # (BabyStories beat 7): "holding up a [[bucket]]" + a self-added "the"
    # produced "holding up a the bucket from <image4>".
    beat = _beat("{{Nam}} holds up a [[bucket]] toward him.")
    prompt = build_qwen21_compose_prompt(
        beat,
        identity_images=[("Nam", "Nam")],
        prop_images=[("bucket", "bucket")],
        identity_names={"Nam": "Nam"},
        prop_names={"bucket": "bucket"},
    )
    assert "a the bucket" not in prompt
    assert "a bucket (shown in <image3>)" in prompt


# --- lint ---


def test_lint_catches_missing_tag():
    issues = lint_qwen21_compose_prompt(
        "<image1> is the background. <image2> shows Nam. Photorealistic photo.",
        n_images=3,
    )
    assert any("missing tag" in i for i in issues)


def test_lint_catches_tag_out_of_range():
    issues = lint_qwen21_compose_prompt(
        "<image1> is the background. <image2> shows Nam. <image3> shows a bucket. "
        "Photorealistic photo.",
        n_images=2,
    )
    assert any("out of range" in i for i in issues)


def test_lint_catches_tags_present_when_n_equals_1():
    issues = lint_qwen21_compose_prompt(
        "<image1> is the background. Photorealistic photo.", n_images=1
    )
    assert any("must use no" in i for i in issues)


def test_lint_catches_leftover_markers():
    issues = lint_qwen21_compose_prompt(
        "<image1> is the background. {{Nam}} stands. Photorealistic photo.",
        n_images=1,
    )
    assert any("marker" in i for i in issues)


def test_lint_catches_missing_photorealistic_clause():
    issues = lint_qwen21_compose_prompt("<image1> is the background.", n_images=1)
    assert any("photorealistic" in i for i in issues)


def test_lint_catches_resolution_token():
    issues = lint_qwen21_compose_prompt(
        "<image1> is the background. Output at 2K, 16:9. Photorealistic photo.",
        n_images=1,
    )
    assert any("resolution" in i for i in issues)


def test_lint_empty_prompt():
    issues = lint_qwen21_compose_prompt("", n_images=1)
    assert issues == ["empty prompt"]

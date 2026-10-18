"""Unit tests for `agents/qwen21_render_prompt_builder.py`'s pure
post-processing logic (`_strip_output_wrapper`) — no LLM calls."""

from __future__ import annotations

from novelvideo.agents.qwen21_render_prompt_builder import _strip_output_wrapper


def test_strips_duplicate_echo_separated_by_stray_think_tag():
    # Real failure seen 2026-10-18 (BabyStories beat 7, DC-qwen-vision):
    # the model emitted its answer, then a stray `</think>` with no
    # matching opener, then the exact same answer again.
    answer = "Replace <image1> with <image2>, keep unchanged, photorealistic."
    raw = f"{answer} </think>  {answer}"
    assert _strip_output_wrapper(raw) == answer


def test_strips_a_conventional_think_block():
    raw = "<think>reasoning about the image</think>Replace <image1> with <image2>."
    assert _strip_output_wrapper(raw) == "Replace <image1> with <image2>."


def test_strips_json_wrapper():
    raw = '{"Rewritten": "Replace <image1> with <image2>."}'
    assert _strip_output_wrapper(raw) == "Replace <image1> with <image2>."


def test_strips_code_fence():
    raw = "```\nReplace <image1> with <image2>.\n```"
    assert _strip_output_wrapper(raw) == "Replace <image1> with <image2>."


def test_collapses_newlines():
    raw = "Replace <image1>\nwith <image2>."
    assert "\n" not in _strip_output_wrapper(raw)


def test_plain_text_passes_through_unchanged():
    raw = "Replace <image1> with <image2>, keep unchanged, photorealistic."
    assert _strip_output_wrapper(raw) == raw

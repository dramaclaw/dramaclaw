"""The 360 environment contract: what counts as one, and what to do otherwise.

The validator used to require each heading at the start of a line. Models emit
the whole contract on one line, so every scene in every project was failing
validation and being replaced with generated boilerplate — which then quoted
the rejected description back as its own source evidence.
"""

from __future__ import annotations

import pytest

from novelvideo.cognee.pipeline import (
    SCENE_FALLBACK_FINGERPRINT,
    _ensure_directional_environment_prompt,
    _has_required_scene_environment_headings,
    normalize_scene_environment_prompt,
    should_repair_scene_placeholder,
)

SINGLE_LINE = (
    "正面：主墙平整素雅，中央悬挂单位标识，下方为办公桌。"
    "左侧：浅色实体墙连接前后，靠前设磨砂玻璃木门。"
    "右侧：墙面延伸至后方，设大面积窗户与百叶帘。"
    "背面：与主墙相对的墙面完整平直，设嵌入式资料柜。"
    "光源：日间稳定环境光，来自窗户与顶灯。"
    "材质/风格：办公空间的素色墙面与木质家具。"
    "禁止元素：不出现人物与临时道具。"
)

MULTI_LINE = "正面：a\n左侧：b\n右侧：c\n背面：d"


def test_a_single_line_contract_is_accepted():
    """This is what the model actually produces, and it was being thrown away."""
    assert _has_required_scene_environment_headings(SINGLE_LINE)


def test_a_single_line_contract_is_stored_one_section_per_line():
    normalized = normalize_scene_environment_prompt(SINGLE_LINE)
    assert normalized.splitlines()[0].startswith("正面：")
    assert len(normalized.splitlines()) == 7
    # The description survives; only its shape changes.
    assert "磨砂玻璃木门" in normalized
    assert "嵌入式资料柜" in normalized


def test_an_already_sectioned_contract_is_unchanged():
    assert _has_required_scene_environment_headings(MULTI_LINE)
    assert normalize_scene_environment_prompt(MULTI_LINE) == MULTI_LINE


@pytest.mark.parametrize(
    ("label", "prompt"),
    [
        ("缺一个方向", "正面：a。左侧：b。右侧：c。"),
        ("方向乱序", "正面：a。右侧：c。左侧：b。背面：d。"),
        ("章节为空", "正面：a。左侧：。右侧：c。背面：d。"),
        ("只是正文里提到", "正面：房间左侧：有窗，右侧：有门，背面：是墙"),
        ("完全不是合同", "一间安静的办公室。"),
        ("空字符串", ""),
    ],
)
def test_text_that_is_not_a_contract_is_rejected(label, prompt):
    """Presence of the words is not enough; each must open a real section."""
    assert not _has_required_scene_environment_headings(prompt), label


def test_a_valid_contract_reaches_storage_intact():
    kept = _ensure_directional_environment_prompt(
        prompt=SINGLE_LINE,
        scene_name="主任办公室",
        scene_type="interior",
        time_of_day="",
        context_lines=["▲张秉权坐在办公桌后翻看文件。"],
    )
    assert "磨砂玻璃木门" in kept
    assert SCENE_FALLBACK_FINGERPRINT not in kept


def test_the_fallback_never_quotes_the_rejected_prompt():
    """Quoting a rejected description back made the contract cite itself."""
    rejected = "这个房间很安静，没有按方位描述。"
    generated = _ensure_directional_environment_prompt(
        prompt=rejected,
        scene_name="主任办公室",
        scene_type="interior",
        time_of_day="",
        context_lines=["▲张秉权坐在办公桌后翻看文件。"],
    )
    assert SCENE_FALLBACK_FINGERPRINT in generated
    assert rejected not in generated
    # Evidence comes from the script instead.
    assert "翻看文件" in generated


def test_the_fallback_still_applies_without_any_usable_text():
    generated = _ensure_directional_environment_prompt(
        prompt="",
        scene_name="主任办公室",
        scene_type="interior",
        time_of_day="",
        context_lines=[],
    )
    assert SCENE_FALLBACK_FINGERPRINT in generated


def test_english_fallback_keeps_fixed_headings_but_uses_english_bodies():
    generated = _ensure_directional_environment_prompt(
        prompt="",
        scene_name="Central Library",
        scene_type="interior",
        time_of_day="",
        context_lines=["Maya walks between the shelves."],
        output_language="en",
    )

    assert generated.startswith("正面：Use the main entrance")
    assert "左侧：From the front-facing view" in generated
    assert "Maya walks between the shelves" in generated


# ── the repair predicate both tracks share ──────────────────────────────────

PLACEHOLDER = _ensure_directional_environment_prompt(
    prompt="",
    scene_name="主任办公室",
    scene_type="interior",
    time_of_day="",
    context_lines=["▲张秉权坐在办公桌后翻看文件。"],
)


def test_boilerplate_is_replaced_by_a_valid_contract():
    assert should_repair_scene_placeholder(PLACEHOLDER, SINGLE_LINE)


def test_a_prompt_a_user_wrote_is_never_touched():
    """Only prompts this code generated carry the fingerprint."""
    assert not should_repair_scene_placeholder(SINGLE_LINE, MULTI_LINE)
    assert not should_repair_scene_placeholder("我自己写的场景描述", SINGLE_LINE)


def test_boilerplate_is_not_churned_into_more_boilerplate():
    assert not should_repair_scene_placeholder(PLACEHOLDER, PLACEHOLDER)


@pytest.mark.parametrize("replacement", ["", "   ", "正面：a", "一段没有分区的描述"])
def test_boilerplate_is_never_replaced_by_something_worse(replacement):
    """A malformed or empty model response must not overwrite what is stored."""
    assert not should_repair_scene_placeholder(PLACEHOLDER, replacement)

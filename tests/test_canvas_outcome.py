import json

import pytest

from novelvideo.chat.canvas_outcome import (
    CANVAS_FINAL_RESPONSE_INSTRUCTIONS,
    unwrap_legacy_canvas_envelope,
)


def legacy(mode="read_only", claims=None, message="建议保持当前布局。"):
    return json.dumps(
        {"message": message, "mode": mode, "canvas_receipts": claims or []},
        ensure_ascii=False,
    )


# --- pre-#862 envelope compatibility -------------------------------------


def test_legacy_envelope_from_an_old_thread_is_unwrapped_to_its_message():
    assert (
        unwrap_legacy_canvas_envelope(legacy())
        == "建议保持当前布局。"
    )
    assert (
        unwrap_legacy_canvas_envelope(
            legacy(
                "mutation",
                [{"bridge_key": "bridge-a", "revision": None}],
                "节点已创建。",
            ),
        )
        == "节点已创建。"
    )


def test_fenced_legacy_envelope_is_unwrapped():
    fenced = "```json\n" + legacy(message="视频按九段规划。") + "\n```"
    assert (
        unwrap_legacy_canvas_envelope(fenced) == "视频按九段规划。"
    )


def test_truncated_legacy_envelope_keeps_its_complete_message():
    assert (
        unwrap_legacy_canvas_envelope(
            '{"message":"视频按九段规划。","mode":"read_only","canvas_receipts":[]'
        )
        == "视频按九段规划。"
    )
    truncated_message = '{"message":"视频规划'
    assert unwrap_legacy_canvas_envelope(truncated_message) == truncated_message


@pytest.mark.parametrize(
    "text",
    [
        "已创建节点。",
        "[]",
        "null",
        "{}",
        '{"message": "说明"}',
        json.dumps(
            {"message": "说明", "mode": "read_only", "canvas_receipts": [], "extra": 1}
        ),
        json.dumps({"title": "方案", "steps": ["a", "b"]}, ensure_ascii=False),
    ],
)
def test_other_json_is_the_model_answer_not_an_envelope(text):
    assert unwrap_legacy_canvas_envelope(text) == text


# --- instructions ---------------------------------------------------------


def test_freezone_instructions_ask_for_plain_text_without_schema():
    from novelvideo.chat import service

    instructions = service._codex_developer_instructions("freezone_canvas")
    assert CANVAS_FINAL_RESPONSE_INSTRUCTIONS in instructions
    assert "plain text or Markdown" in instructions
    assert "not a JSON object" in instructions
    assert '"type": "object"' not in instructions
    assert '{"message"' not in instructions
    assert "interactive-story or interactive-ad proposal" in instructions
    assert "canvas_receipts" not in service._codex_developer_instructions("default")

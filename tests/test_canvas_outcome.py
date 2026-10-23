import json

import pytest

from novelvideo.chat.canvas_outcome import (
    CANVAS_FINAL_RESPONSE_INSTRUCTIONS,
    finalize_canvas_reply,
    unwrap_legacy_canvas_envelope,
)

_UNVERIFIED = "画布操作未完成：本轮没有可验证的画布写入回执"


def legacy(mode="read_only", claims=None, message="建议保持当前布局。"):
    return json.dumps(
        {"message": message, "mode": mode, "canvas_receipts": claims or []},
        ensure_ascii=False,
    )


def test_read_only_answer_is_delivered_as_plain_text():
    assert (
        finalize_canvas_reply("建议保持当前布局。", attempts={}, receipts=set())
        == "建议保持当前布局。"
    )


def test_markdown_proposal_without_writes_is_delivered_unchanged():
    proposal = "## 互动广告方案\n先展示口香糖，再让用户选择。"
    assert finalize_canvas_reply(proposal, attempts={}, receipts=set()) == proposal


def test_greeting_needs_no_envelope():
    assert (
        finalize_canvas_reply(
            "你好！有什么我可以帮你的吗？", attempts={}, receipts=set()
        )
        == "你好！有什么我可以帮你的吗？"
    )


def test_requested_canvas_write_without_attempt_reports_host_outcome_first():
    result = finalize_canvas_reply(
        "正在通过节点绑定的 drama-background-music Recipe 编译提示词并执行 generate_audio。",
        attempts={},
        receipts=set(),
        write_requested=True,
    )

    assert result.startswith(_UNVERIFIED)
    assert "不代表实际操作结果" in result
    assert result.endswith("并执行 generate_audio。")


def test_requested_canvas_write_without_attempt_or_reply_is_a_plain_failure():
    assert (
        finalize_canvas_reply("", attempts={}, receipts=set(), write_requested=True)
        == "画布操作未完成：本轮没有可验证的画布写入回执，请重试。"
    )


def test_success_claim_is_not_judged_from_prose_when_no_write_was_requested():
    # Receipt checks, not keyword scanning, decide the outcome. A read-only
    # turn's prose is delivered as the model wrote it.
    assert (
        finalize_canvas_reply("图片节点已创建成功。", attempts={}, receipts=set())
        == "图片节点已创建成功。"
    )


def test_catalog_only_success_needs_no_canvas_receipt():
    assert (
        finalize_canvas_reply("Skill 已保存，尚未运行。", attempts={}, receipts=set())
        == "Skill 已保存，尚未运行。"
    )


def test_verified_write_delivers_the_model_reply():
    assert (
        finalize_canvas_reply(
            "节点已创建。",
            attempts={"call-a": "succeeded"},
            receipts={("bridge-a", None)},
        )
        == "节点已创建。"
    )
    assert (
        finalize_canvas_reply(
            "节点已更新。", attempts={"call-a": "succeeded"}, receipts={("", 3)}
        )
        == "节点已更新。"
    )


@pytest.mark.parametrize(
    ("receipt", "expected"),
    [(("", 7), "本轮画布修改已保存。"), (("bridge-a", None), "本轮画布执行请求已受理")],
)
def test_empty_reply_after_verified_writes_reports_saved_status(receipt, expected):
    result = finalize_canvas_reply(
        "", attempts={"call-a": "succeeded"}, receipts={receipt}
    )
    assert result.startswith(expected)
    assert "无需重复提交" in result


def test_both_receipt_kinds_are_reported_when_the_reply_is_empty():
    result = finalize_canvas_reply(
        "",
        attempts={"confirm": "succeeded", "submit": "succeeded"},
        receipts={("", 14), ("bridge-a", None)},
    )
    assert "画布修改已保存" in result
    assert "执行请求已受理" in result


def test_one_success_cannot_mask_another_failed_write():
    assert (
        finalize_canvas_reply(
            "两个节点都已创建。",
            attempts={"call-a": "succeeded", "call-b": "failed"},
            receipts={("bridge-a", None)},
            failure="第二个节点未保存。",
        )
        == "画布操作未完成：第二个节点未保存。"
    )


def test_failed_write_without_detail_uses_the_generic_failure():
    assert (
        finalize_canvas_reply(
            "图片节点已创建成功。", attempts={"call-a": "failed"}, receipts=set()
        )
        == "画布操作未完成：没有收到所有操作的成功画布写入回执，请重试。"
    )


@pytest.mark.parametrize(
    "state", ["waiting_approval", "in_progress", "cancelled", "timeout"]
)
def test_non_success_operation_keeps_its_state(state):
    result = finalize_canvas_reply(
        "已创建。", attempts={"call-a": state}, receipts=set()
    )
    expected = {"cancelled": "已取消", "timeout": "等待超时"}.get(state, "等待确认")
    assert expected in result


def test_workflow_draft_is_pending_approval_not_success_or_failure():
    result = finalize_canvas_reply(
        "已创建节点。", attempts={}, receipts=set(), draft_ready=True
    )
    assert "等待你确认" in result
    assert "操作未完成" not in result


def test_write_request_guard_does_not_apply_once_a_write_was_attempted():
    assert (
        finalize_canvas_reply(
            "节点已创建。",
            attempts={"call-a": "succeeded"},
            receipts={("bridge-a", None)},
            write_requested=True,
        )
        == "节点已创建。"
    )


# --- pre-#862 envelope compatibility -------------------------------------


def test_legacy_envelope_from_an_old_thread_is_unwrapped_to_its_message():
    assert (
        finalize_canvas_reply(legacy(), attempts={}, receipts=set())
        == "建议保持当前布局。"
    )
    assert (
        finalize_canvas_reply(
            legacy(
                "mutation",
                [{"bridge_key": "bridge-a", "revision": None}],
                "节点已创建。",
            ),
            attempts={"call-a": "succeeded"},
            receipts={("bridge-a", None)},
        )
        == "节点已创建。"
    )


def test_fenced_legacy_envelope_is_unwrapped():
    fenced = "```json\n" + legacy(message="视频按九段规划。") + "\n```"
    assert (
        finalize_canvas_reply(fenced, attempts={}, receipts=set()) == "视频按九段规划。"
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
    assert finalize_canvas_reply(text, attempts={}, receipts=set()) == text


def test_legacy_envelope_cannot_bypass_the_write_request_guard():
    result = finalize_canvas_reply(
        legacy(
            "mutation",
            [{"bridge_key": "forged", "revision": None}],
            "图片节点已创建成功。",
        ),
        attempts={},
        receipts=set(),
        write_requested=True,
    )
    assert result.startswith(_UNVERIFIED)
    assert "forged" not in result


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

import json

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat.canvas_outcome import (
    CANVAS_REPLY_SCHEMA,
    NO_CANVAS_WRITE_NOTE,
    finalize_canvas_reply,
)


def reply(mode="read_only", claims=None, message="建议保持当前布局。"):
    return json.dumps(
        {"message": message, "mode": mode, "canvas_receipts": claims or []}
    )


def test_reply_schema_accepts_read_only_and_mutation_results():
    validator = Draft202012Validator(CANVAS_REPLY_SCHEMA)
    validator.validate(json.loads(reply()))
    validator.validate(
        json.loads(reply("mutation", [{"bridge_key": "bridge-a", "revision": None}]))
    )


def test_read_only_answer_needs_no_canvas_receipt():
    assert (
        finalize_canvas_reply(reply(), attempts={}, receipts=set())
        == "建议保持当前布局。"
    )


def test_freezone_instructions_embed_schema_and_valid_greeting_example():
    from novelvideo.chat import service

    instructions = service._codex_developer_instructions("freezone_canvas")
    schema = json.loads(instructions.rsplit("\n", 1)[1])
    assert schema == CANVAS_REPLY_SCHEMA
    example, _ = json.JSONDecoder().raw_decode(
        instructions.split("For a greeting, return ", 1)[1]
    )
    Draft202012Validator(schema).validate(example)
    assert (
        finalize_canvas_reply(json.dumps(example), attempts={}, receipts=set())
        == example["message"]
    )
    assert example["mode"] == "read_only"
    assert example["canvas_receipts"] == []
    assert "not plain text or Markdown" in instructions
    assert "ordinary conversation" in instructions
    assert "canvas_receipts" not in service._codex_developer_instructions("default")


def test_read_only_plain_text_reply_is_surfaced_not_replaced():
    # #680: a read-only status turn answered in prose must reach the user.
    assert (
        finalize_canvas_reply(
            "工作流失败，未生成视频。\n", attempts={}, receipts=set(), failure=""
        )
        == "工作流失败，未生成视频。" + NO_CANVAS_WRITE_NOTE
    )


def test_plain_success_claim_without_receipts_is_marked_as_no_write():
    result = finalize_canvas_reply("图片节点已创建成功。", attempts={}, receipts=set())
    assert result.endswith(NO_CANVAS_WRITE_NOTE)
    assert "未修改画布" in result


@pytest.mark.parametrize(
    ("attempts", "receipts"),
    [
        ({"call-a": "succeeded"}, {("bridge-a", None)}),
        ({}, {("", 7)}),
    ],
)
def test_plain_text_after_canvas_writes_still_fails_closed(attempts, receipts):
    assert "未返回结构化结果" in finalize_canvas_reply(
        "图片节点已创建成功。", attempts=attempts, receipts=receipts
    )


@pytest.mark.parametrize("text", ["", "   "])
def test_empty_plain_reply_fails_closed(text):
    assert "未返回结构化结果" in finalize_canvas_reply(text, attempts={}, receipts=set())


def test_catalog_only_success_needs_no_canvas_receipt():
    assert (
        finalize_canvas_reply(
            reply(message="Skill 已保存，尚未运行。"), attempts={}, receipts=set()
        )
        == "Skill 已保存，尚未运行。"
    )


def test_canvas_success_requires_actual_same_turn_receipts():
    text = reply("mutation", [{"bridge_key": "bridge-a", "revision": None}])
    assert "没有可验证" in finalize_canvas_reply(text, attempts={}, receipts=set())
    assert "不匹配" in finalize_canvas_reply(
        text, attempts={"call-a": "succeeded"}, receipts={("bridge-other", None)}
    )


def test_canvas_success_accepts_verified_browser_receipt():
    assert (
        finalize_canvas_reply(
            reply(
                "mutation",
                [{"bridge_key": "bridge-a", "revision": None}],
                "节点已创建。",
            ),
            attempts={"call-a": "succeeded"},
            receipts={("bridge-a", None)},
        )
        == "节点已创建。"
    )


def test_canvas_success_accepts_verified_direct_revision():
    assert (
        finalize_canvas_reply(
            reply("mutation", [{"bridge_key": None, "revision": 3}], "节点已更新。"),
            attempts={"call-a": "succeeded"},
            receipts={("", 3)},
        )
        == "节点已更新。"
    )


def test_one_success_cannot_mask_another_failed_write():
    assert (
        finalize_canvas_reply(
            reply("mutation", [{"bridge_key": "bridge-a", "revision": None}]),
            attempts={"call-a": "succeeded", "call-b": "failed"},
            receipts={("bridge-a", None)},
            failure="第二个节点未保存。",
        )
        == "画布操作未完成：第二个节点未保存。"
    )


@pytest.mark.parametrize(
    "state", ["waiting_approval", "in_progress", "cancelled", "timeout"]
)
def test_non_success_operation_keeps_its_state(state):
    result = finalize_canvas_reply(
        reply("mutation"), attempts={"call-a": state}, receipts=set()
    )
    expected = {"cancelled": "已取消", "timeout": "等待超时"}.get(state, "等待确认")
    assert expected in result


def test_workflow_draft_is_pending_approval_not_success_or_failure():
    result = finalize_canvas_reply(
        "已创建节点。", attempts={}, receipts=set(), draft_ready=True
    )
    assert "等待你确认" in result
    assert "操作未完成" not in result


@pytest.mark.parametrize(
    "text",
    [
        "[]",
        "null",
        "{}",
        json.dumps({"message": "说明", "mode": [], "canvas_receipts": []}),
        json.dumps(
            {"message": "说明", "mode": "read_only", "canvas_receipts": [], "extra": 1}
        ),
    ],
)
def test_missing_or_invalid_structured_reply_fails_closed(text):
    assert "未通过操作结果校验" in finalize_canvas_reply(
        text, attempts={}, receipts=set()
    )


def test_read_only_mode_cannot_hide_actual_canvas_writes():
    assert "不一致" in finalize_canvas_reply(
        reply(), attempts={"call-a": "succeeded"}, receipts={("bridge-a", None)}
    )


def test_claims_must_cover_all_successful_writes():
    assert "未覆盖" in finalize_canvas_reply(
        reply("mutation", [{"bridge_key": "bridge-a", "revision": None}]),
        attempts={"call-a": "succeeded", "call-b": "succeeded"},
        receipts={("bridge-a", None), ("bridge-b", None)},
    )


@pytest.mark.parametrize("revision", [True, "3", 3.5])
def test_invalid_revision_claims_fail_closed(revision):
    assert "不匹配" in finalize_canvas_reply(
        reply("mutation", [{"bridge_key": None, "revision": revision}]),
        attempts={"call-a": "succeeded"},
        receipts={("", 3)},
    )

"""Codex native history parsing stays independent of chat storage."""

from types import SimpleNamespace

from openai_codex.generated.v2_all import (
    AgentMessageThreadItem,
    CommandExecutionThreadItem,
    UserMessageThreadItem,
)

from novelvideo.chat.runtime_history import (
    _split_trace_contents,
    parse_codex_history_item,
)


def test_user_history_preserves_text_and_attachment_markers() -> None:
    item = UserMessageThreadItem.model_construct(
        id="user-1",
        type="userMessage",
        content=[
            SimpleNamespace(type="text", text="  hello  "),
            SimpleNamespace(type="skill", name="builder", path="/skills/builder"),
            SimpleNamespace(type="mention", name="doc", path="/docs/doc"),
            SimpleNamespace(type="image", url="https://example.test/image.png"),
            SimpleNamespace(type="localImage", path="/tmp/image.png"),
        ],
    )

    assert parse_codex_history_item(item, 2, 3) == [
        {
            "id": 2003,
            "role": "user",
            "content": (
                "hello\n[skill] builder\n[mention] doc\n"
                "[image] https://example.test/image.png\n[image] /tmp/image.png"
            ),
        }
    ]


def test_assistant_history_trims_text_and_skips_empty_message() -> None:
    item = AgentMessageThreadItem.model_validate(
        {"id": "assistant-1", "type": "agentMessage", "text": "  finished  "}
    )

    assert parse_codex_history_item(item, 1, 2) == [
        {"id": 1002, "role": "assistant", "content": "finished"}
    ]
    assert parse_codex_history_item(item.model_copy(update={"text": "  "}), 1, 2) == []


def test_command_history_keeps_output_and_trace_id() -> None:
    item = CommandExecutionThreadItem.model_validate(
        {
            "id": "command-1",
            "type": "commandExecution",
            "command": "pwd",
            "commandActions": [],
            "cwd": "/tmp",
            "status": "completed",
            "aggregatedOutput": "first\n\nsecond",
        }
    )

    records = parse_codex_history_item(item, 3, 4)

    assert [record["id"] for record in records] == [30040, 30041]
    assert all(record["role"] == "trace" for record in records)
    assert records[0]["content"] == "first"
    assert "second" in records[1]["content"]
    assert "Ran pwd" in records[1]["content"]


def test_unknown_history_item_has_no_record() -> None:
    assert parse_codex_history_item(SimpleNamespace(type="unknown"), 0, 0) == []


def test_trace_blocks_skip_blank_lines() -> None:
    assert _split_trace_contents("first\n\nsecond\nthird\n") == [
        "first",
        "second\nthird",
    ]

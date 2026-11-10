"""Project recorded Codex wire items into browser chat cards."""

import json
from pathlib import Path

import pytest
from openai_codex.generated.v2_all import (
    AgentMessageThreadItem,
    CommandExecutionThreadItem,
    ContextCompactionThreadItem,
    ImageGenerationThreadItem,
    McpToolCallError,
    McpToolCallResult,
    McpToolCallThreadItem,
    PlanThreadItem,
    ReasoningThreadItem,
    UserMessageThreadItem,
)

from novelvideo.chat.codex_projection import business_turn_id, project_item, project_turn
from novelvideo.chat.codex_protocol import (
    CodexItemRecord,
    CodexTurn,
    ThreadItemsPage,
    ThreadTurnsPage,
)


def _read_trace(filename: str) -> list[dict]:
    path = Path(__file__).parent / "fixtures" / "codex-0.162" / filename
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _requests(records: list[dict], method: str, direction: str = "send") -> list[dict]:
    return [
        record
        for record in records
        if record["dir"] == direction
        and record["msg"].get("method") == method
        and "id" in record["msg"]
    ]


def _reply(records: list[dict], request: dict) -> dict:
    return next(
        record["msg"]
        for record in records[records.index(request) + 1 :]
        if record["conn"] == request["conn"]
        and record["dir"] != request["dir"]
        and record["msg"].get("id") == request["msg"]["id"]
        and ("result" in record["msg"] or "error" in record["msg"])
    )


@pytest.fixture
def expected_history() -> dict:
    return {
        "id": "assistant:01a1c513-66de-7730-9509-ffca305e55c0",
        "role": "assistant",
        "content": "I can see DI-ALPHA, AC-ONE, and AC-TWO.",
        "media": [],
        "attachments": [],
        "turn_id": "fixture-client-message-0001",
        "created_at": "2026-11-10T10:49:05+00:00",
        "parts": [
            {
                "id": "rs_56e31892808e5110f241f6b5e8119f42d2db267baec15ace",
                "type": "agent_thought",
                "seq": 1794307748104,
                "event": {
                    "type": "agent.thought",
                    "turn_id": "fixture-client-message-0001",
                    "text": "Markers: DI-ALPHA, AC-ONE, AC-TWO.",
                    "status": "completed",
                    "truncated": False,
                },
            },
            {
                "id": "msg_a1ad627fcf5f8db2f08a2ee8b3964aa1c8e8a5697bcc7893",
                "type": "text",
                "text": "I can see DI-ALPHA, AC-ONE, and AC-TWO.",
                "seq": 1794307748436,
            },
        ],
        "ui_events": [],
    }


def test_recorded_history_projects_in_timestamp_order(expected_history):
    records = _read_trace("05-history-reads.jsonl")
    request = next(
        r for r in _requests(records, "thread/turns/list")
        if r["msg"]["params"].get("itemsView") == "notLoaded"
    )
    turn = ThreadTurnsPage.model_validate(_reply(records, request)["result"]).data[0]
    items_request = next(
        r for r in _requests(records, "thread/items/list")
        if r["msg"]["params"].get("turnId") == turn.id
    )
    items = ThreadItemsPage.model_validate(_reply(records, items_request)["result"]).data

    assert project_turn(turn, items) == expected_history
    assert project_turn(turn, list(reversed(items))) == expected_history


def test_live_completed_cards_equal_recorded_history(expected_history):
    records = _read_trace("04-turn-additional-context-client-id.jsonl")
    completed = [
        r["msg"]["params"]["item"] for r in records
        if r["msg"].get("method") == "item/completed"
        and r["msg"]["params"]["item"]["type"] in ("reasoning", "agentMessage")
    ]
    cards = []
    for item in completed:
        started = next(
            r["msg"]["params"]["startedAtMs"] for r in records
            if r["msg"].get("method") == "item/started"
            and r["msg"]["params"]["item"]["id"] == item["id"]
        )
        cards.append(project_item(
            item, turn_id="fixture-client-message-0001", started_at_ms=started, completed=True
        ))
    assert cards == expected_history["parts"]


def test_in_progress_history_keeps_completed_command():
    records = _read_trace("08-thread-b-tools-reasoning-inflight-resume.jsonl")
    request = next(r for r in _requests(records, "thread/turns/list") if r["conn"] == "c4")
    turn = ThreadTurnsPage.model_validate(_reply(records, request)["result"]).data[0]
    items_request = next(
        r for r in _requests(records, "thread/items/list")
        if r["conn"] == "c4" and r["seq"] > request["seq"]
        and r["msg"]["params"].get("turnId") == turn.id
    )
    items = ThreadItemsPage.model_validate(_reply(records, items_request)["result"]).data

    assert project_turn(turn, items) == {
        "id": "assistant:01a1c513-9ad9-75e0-bf99-4ff3d12fff7b",
        "role": "assistant",
        "content": "",
        "media": [],
        "attachments": [],
        "turn_id": "01a1c513-9ad9-75e0-bf99-4ff3d12fff7b",
        "created_at": "2026-11-10T10:49:18+00:00",
        "parts": [{
            "id": "call_81ab3db0133441cdb97eac18",
            "type": "tool_status",
            "seq": 1794307764430,
            "event": {
                "id": "agent-tool-call_81ab3db0133441cdb97eac18",
                "role": "tool",
                "text": "command_execution\n\nfixture-shell-ok",
                "turnId": "01a1c513-9ad9-75e0-bf99-4ff3d12fff7b",
                "timestamp": 1794307764430,
                "raw": {
                    "type": "agent.tool.updated",
                    "turn_id": "01a1c513-9ad9-75e0-bf99-4ff3d12fff7b",
                    "call_id": "call_81ab3db0133441cdb97eac18",
                    "name": "command_execution",
                    "status": "completed",
                    "input": {"command": "/bin/zsh -lc 'echo fixture-shell-ok'"},
                    "text": "fixture-shell-ok",
                    "error": None,
                    "result_json": None,
                    "duration_ms": 0,
                },
            },
        }],
        "ui_events": [],
    }


def test_recorded_mcp_completion():
    records = _read_trace("08-thread-b-tools-reasoning-inflight-resume.jsonl")
    item = next(
        r["msg"]["params"]["item"] for r in records
        if r["msg"].get("method") == "item/completed"
        and r["msg"]["params"]["item"]["type"] == "mcpToolCall"
    )
    assert project_item(item, turn_id="turn-1", started_at_ms=None, completed=True) == {
        "id": "call_81c0f5f831c24b33b889d752",
        "type": "tool_status",
        "event": {
            "id": "agent-tool-call_81c0f5f831c24b33b889d752",
            "role": "tool",
            "text": "fixture.echo_text\n\nfixture-mcp-ok",
            "turnId": "turn-1",
            "timestamp": 0,
            "raw": {
                "type": "agent.tool.updated",
                "turn_id": "turn-1",
                "call_id": "call_81c0f5f831c24b33b889d752",
                "name": "fixture.echo_text",
                "status": "completed",
                "input": {"text": "fixture-mcp-ok"},
                "text": "fixture-mcp-ok",
                "error": None,
                "result_json": None,
                "duration_ms": 0,
            },
        },
    }


def test_interrupted_turn_with_only_user_message_has_no_projection():
    records = _read_trace("09-turn-interrupt.jsonl")
    request = _requests(records, "thread/turns/list")[0]
    turn = ThreadTurnsPage.model_validate(_reply(records, request)["result"]).data[0]
    items_request = next(
        r for r in _requests(records, "thread/items/list")
        if r["msg"]["params"].get("turnId") == turn.id
    )
    items = ThreadItemsPage.model_validate(_reply(records, items_request)["result"]).data
    assert project_turn(turn, items) is None


def test_declined_command_is_cancelled():
    records = _read_trace("10-approval-decline.jsonl")
    item = next(
        r["msg"]["params"]["item"] for r in records
        if r["msg"].get("method") == "item/completed"
        and r["msg"]["params"]["item"]["type"] == "commandExecution"
    )
    card = project_item(item, turn_id="turn-1", started_at_ms=None, completed=True)
    assert card["event"]["raw"] == {
        "type": "agent.tool.updated",
        "turn_id": "turn-1",
        "call_id": "call_8cfa45f48f3d4b2f855bd1ce",
        "name": "command_execution",
        "status": "cancelled",
        "input": {"command": "/bin/zsh -lc 'touch fixture-approval.txt'"},
        "text": "",
        "error": "declined",
        "result_json": None,
        "duration_ms": None,
    }
    assert card["event"]["text"] == "command_execution"


@pytest.mark.parametrize(("status", "result", "error", "expected_result", "expected_error"), [
    (
        "completed",
        McpToolCallResult(content=[], structured_content={
            "ok": False, "status": "timeout", "user_message": "Canvas did not answer in time."
        }),
        None,
        {"ok": False, "status": "timeout", "user_message": "Canvas did not answer in time."},
        "Canvas did not answer in time.",
    ),
    ("failed", None, McpToolCallError(message="tool crashed"), None, "tool crashed"),
    (
        "completed",
        McpToolCallResult(content=[], structured_content={
            "ok": True, "status": "ready", "detail": "a" * 5000
        }),
        None,
        {"ok": True, "status": "ready"},
        None,
    ),
])
def test_sdk_mcp_results(status, result, error, expected_result, expected_error):
    item = McpToolCallThreadItem(
        id="mcp-1", type="mcpToolCall", server="fixture", tool="echo_text",
        arguments={"text": "hello"}, status=status, result=result, error=error,
    ).model_dump(mode="json", by_alias=True)
    card = project_item(item, turn_id="turn-1", started_at_ms=12, completed=True)
    assert card["event"]["raw"] == {
        "type": "agent.tool.updated",
        "turn_id": "turn-1",
        "call_id": "mcp-1",
        "name": "fixture.echo_text",
        "status": "failed" if expected_error else "completed",
        "input": {"text": "hello"},
        "text": "",
        "error": expected_error,
        "result_json": expected_result,
        "duration_ms": None,
    }


@pytest.mark.parametrize(("completed", "status"), [(True, "completed"), (False, "running")])
def test_sdk_context_compaction(completed, status):
    item = ContextCompactionThreadItem(id="compact-1", type="contextCompaction").model_dump(
        mode="json", by_alias=True
    )
    assert project_item(item, turn_id="turn-1", started_at_ms=0, completed=completed) == {
        "id": "compact-1", "type": "context_compaction", "seq": 0,
        "event": {"type": "context_compaction", "turn_id": "turn-1", "status": status},
    }


@pytest.mark.parametrize("model", [
    ImageGenerationThreadItem(id="image-1", type="imageGeneration", result="", status="completed"),
    PlanThreadItem(id="plan-1", type="plan", text="a plan"),
    UserMessageThreadItem(id="user-1", type="userMessage", content=[]),
    AgentMessageThreadItem(id="blank-1", type="agentMessage", text=" \n "),
    ReasoningThreadItem(id="raw-1", type="reasoning", summary=[" ", ""], content=["hidden"]),
])
def test_sdk_hidden_or_blank_items(model):
    assert project_item(
        model.model_dump(mode="json", by_alias=True),
        turn_id="turn-1", started_at_ms=None, completed=True,
    ) is None


def test_sdk_reasoning_truncates_at_utf8_boundary():
    item = ReasoningThreadItem(
        id="reason-1", type="reasoning", summary=["思" * 20000], content=["hidden"]
    ).model_dump(mode="json", by_alias=True)
    assert project_item(item, turn_id="turn-1", started_at_ms=None, completed=False) == {
        "id": "reason-1", "type": "agent_thought",
        "event": {
            "type": "agent.thought", "turn_id": "turn-1", "text": "思" * 10922,
            "status": "running", "truncated": True,
        },
    }


def test_sdk_command_limits_output_and_reports_exit_code():
    item = CommandExecutionThreadItem(
        id="command-1", type="commandExecution", command="echo hello", command_actions=[],
        cwd="/tmp", source="agent", status="completed", aggregated_output="a" * 5000, exit_code=2,
    ).model_dump(mode="json", by_alias=True)
    card = project_item(item, turn_id="turn-1", started_at_ms=None, completed=True)
    assert card["event"]["raw"] == {
        "type": "agent.tool.updated", "turn_id": "turn-1", "call_id": "command-1",
        "name": "command_execution", "status": "failed", "input": {"command": "echo hello"},
        "text": "a" * 2048, "error": "exit code 2", "result_json": None, "duration_ms": None,
    }
    assert card["event"]["text"] == "command_execution\n\n" + "a" * 2048


def test_sdk_agent_message_masks_local_path():
    item = AgentMessageThreadItem(
        id="message-1", type="agentMessage", text="Saved to ~/workspace/output.png."
    ).model_dump(mode="json", by_alias=True)
    assert project_item(item, turn_id="turn-1", started_at_ms=None, completed=True) == {
        "id": "message-1", "type": "text", "text": "Saved to [本地路径]",
    }


def test_business_turn_id_uses_first_nonblank_client_id():
    records = [
        CodexItemRecord.model_validate({
            "turnId": "turn-1",
            "item": UserMessageThreadItem(
                id=f"user-{index}", type="userMessage", client_id=client_id, content=[]
            ).model_dump(mode="json", by_alias=True),
        })
        for index, client_id in enumerate([None, " ", "client-1", "client-2"])
    ]
    assert business_turn_id("turn-1", records) == "client-1"
    assert business_turn_id("turn-1", records[:2]) == "turn-1"


def test_turn_sorts_missing_times_last_and_preserves_ties():
    turn = CodexTurn.model_validate({"id": "turn-1", "status": "completed", "startedAt": None})
    records = [
        CodexItemRecord.model_validate({
            "turnId": "turn-1", "startedAtMs": started_at,
            "item": AgentMessageThreadItem(
                id=item_id, type="agentMessage", text=text
            ).model_dump(mode="json", by_alias=True),
        })
        for item_id, text, started_at in [
            ("last", "Last", None), ("first", "First", 4), ("second", "Second", 4)
        ]
    ]
    assert project_turn(turn, records) == {
        "id": "assistant:turn-1", "role": "assistant", "content": "First\n\nSecond\n\nLast",
        "media": [], "attachments": [], "turn_id": "turn-1", "created_at": "",
        "parts": [
            {"id": "first", "type": "text", "text": "First", "seq": 4},
            {"id": "second", "type": "text", "text": "Second", "seq": 4},
            {"id": "last", "type": "text", "text": "Last"},
        ],
        "ui_events": [],
    }

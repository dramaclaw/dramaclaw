"""Check the chat thread wire contract against recorded Codex 0.162 traffic."""

import json
from pathlib import Path

from novelvideo.chat.codex_app_server import _refuse_server_request
from novelvideo.chat.codex_protocol import (
    THREAD_ITEMS_LIST,
    THREAD_REVERT,
    THREAD_TURNS_LIST,
    CodexThreadResponse,
    ThreadItemsPage,
    ThreadRevertResponse,
    ThreadTurnsPage,
    newest_turns_params,
    oldest_turn_params,
    thread_revert_params,
    turn_items_params,
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


def test_start_returns_paginated_idle_thread():
    records = _read_trace("02-thread-start-ce.jsonl")
    request = _requests(records, "thread/start")[0]
    result = _reply(records, request)["result"]

    response = CodexThreadResponse.model_validate(result)

    assert response.thread.history_mode == "paginated"
    assert response.thread.status.type == "idle"
    assert response.thread.status.active_flags == []
    assert result["thread"]["status"] == {"type": "idle"}
    assert result["thread"]["turns"] == []


def test_legacy_thread_rejects_revert():
    records = _read_trace("11-legacy-history-thread.jsonl")
    start = _requests(records, "thread/start")[0]
    assert start["msg"]["params"]["historyMode"] == "legacy"

    response = CodexThreadResponse.model_validate(_reply(records, start)["result"])

    assert response.thread.history_mode == "legacy"
    revert = _requests(records, THREAD_REVERT)[0]
    assert _reply(records, revert)["error"] == {
        "code": -32600,
        "message": "thread/revert only supports paginated threads",
    }


def test_resume_and_revert_to_first_turn_clears_history():
    records = _read_trace("12-revert.jsonl")
    resume = _requests(records, "thread/resume")[0]
    response = CodexThreadResponse.model_validate(_reply(records, resume)["result"])
    thread_id = response.thread.id

    assert resume["msg"]["params"] == {"threadId": thread_id, "excludeTurns": True}
    assert response.thread.history_mode == "paginated"
    assert response.thread.status.type == "idle"

    first_revert, second_revert = _requests(records, THREAD_REVERT)
    assert first_revert["seq"] < second_revert["seq"]
    expected_params = {
        "threadId": thread_id,
        "beforeTurnId": "01a1c513-4c51-7a02-acaa-5f75458748e4",
    }
    assert thread_revert_params(
        thread_id, "01a1c513-4c51-7a02-acaa-5f75458748e4"
    ) == expected_params
    assert second_revert["msg"]["params"] == expected_params

    result = _reply(records, second_revert)["result"]
    reverted = ThreadRevertResponse.model_validate(result)

    assert reverted.thread.id == thread_id
    assert reverted.turns_backwards_cursor is None
    assert result["thread"]["turns"] == []
    assert "itemsBackwardsCursor" in result

    following_list = next(
        request
        for request in _requests(records, THREAD_TURNS_LIST)
        if request["seq"] > second_revert["seq"]
    )
    assert following_list["msg"]["params"] == {"threadId": thread_id}
    assert any(
        record["dir"] == "recv"
        and record["conn"] == second_revert["conn"]
        and second_revert["seq"] < record["seq"] < following_list["seq"]
        and record["msg"].get("method") == "thread/reverted"
        and "id" not in record["msg"]
        and record["msg"]["params"] == {"threadId": thread_id}
        for record in records
    )
    result = _reply(records, following_list)["result"]
    page = ThreadTurnsPage.model_validate(result)

    assert page.data == []
    assert page.next_cursor is None
    assert result["backwardsCursor"] is None


def test_history_order_and_oldest_turn_wire_params():
    records = _read_trace("05-history-reads.jsonl")
    requests = _requests(records, THREAD_TURNS_LIST)
    ascending = next(r for r in requests if r["msg"]["params"].get("sortDirection") == "asc")
    page = ThreadTurnsPage.model_validate(_reply(records, ascending)["result"])
    thread_id = ascending["msg"]["params"]["threadId"]

    assert page.data[0].id == "01a1c513-4c51-7a02-acaa-5f75458748e4"
    assert page.data[0].status == "completed"

    default = next(r for r in requests if r["msg"]["params"] == {"threadId": thread_id})
    default_page = ThreadTurnsPage.model_validate(_reply(records, default)["result"])
    assert [turn.id for turn in default_page.data] == [
        "01a1c513-66de-7730-9509-ffca305e55c0",
        "01a1c513-4c51-7a02-acaa-5f75458748e4",
    ]

    not_loaded = next(r for r in requests if r["msg"]["params"].get("itemsView") == "notLoaded")
    assert [turn["items"] for turn in _reply(records, not_loaded)["result"]["data"]] == [[], []]
    assert oldest_turn_params(thread_id) == {
        "threadId": thread_id,
        "sortDirection": "asc",
        "limit": 1,
        "itemsView": "notLoaded",
    }


def test_newest_turn_pages_follow_next_cursor():
    records = _read_trace("05-history-reads.jsonl")
    thread_id = "01a1c513-4902-7a92-81fa-3d7461d47839"
    requests = _requests(records, THREAD_TURNS_LIST)
    first = next(r for r in requests if r["msg"]["params"] == {"threadId": thread_id, "limit": 1})
    page = ThreadTurnsPage.model_validate(_reply(records, first)["result"])

    assert [turn.id for turn in page.data] == ["01a1c513-66de-7730-9509-ffca305e55c0"]
    following = requests[requests.index(first) + 1]
    assert page.next_cursor is not None
    assert page.next_cursor == following["msg"]["params"]["cursor"]
    following_page = ThreadTurnsPage.model_validate(_reply(records, following)["result"])
    assert [turn.id for turn in following_page.data] == ["01a1c513-4c51-7a02-acaa-5f75458748e4"]
    assert following_page.next_cursor is None

    assert newest_turns_params(thread_id, limit=1) == {
        "threadId": "01a1c513-4902-7a92-81fa-3d7461d47839",
        "itemsView": "notLoaded",
        "limit": 1,
    }
    assert newest_turns_params(thread_id, limit=20, cursor="c") == {
        "threadId": "01a1c513-4902-7a92-81fa-3d7461d47839",
        "itemsView": "notLoaded",
        "limit": 20,
        "cursor": "c",
    }


def test_not_loaded_turns_carry_status_and_times():
    records = _read_trace("05-history-reads.jsonl")
    request = next(
        r for r in _requests(records, THREAD_TURNS_LIST)
        if r["msg"]["params"].get("itemsView") == "notLoaded"
    )
    page = ThreadTurnsPage.model_validate(_reply(records, request)["result"])

    assert [
        (turn.id, turn.status, turn.started_at, turn.completed_at, turn.error)
        for turn in page.data
    ] == [
        ("01a1c513-66de-7730-9509-ffca305e55c0", "completed", 1794307745, 1794307748, None),
        ("01a1c513-4c51-7a02-acaa-5f75458748e4", "completed", 1794307738, 1794307744, None),
    ]


def test_turn_items_page_lists_items_in_order_with_times():
    records = _read_trace("05-history-reads.jsonl")
    thread_id = "01a1c513-4902-7a92-81fa-3d7461d47839"
    turn_id = "01a1c513-66de-7730-9509-ffca305e55c0"
    requests = _requests(records, THREAD_ITEMS_LIST)
    request = next(r for r in requests if r["msg"]["params"].get("turnId") == turn_id)
    page = ThreadItemsPage.model_validate(_reply(records, request)["result"])

    assert [(r.item["type"], r.item["id"]) for r in page.data] == [
        ("userMessage", "01a1c513-66e6-7c72-8ad9-190023ec024b"),
        ("reasoning", "rs_56e31892808e5110f241f6b5e8119f42d2db267baec15ace"),
        ("agentMessage", "msg_a1ad627fcf5f8db2f08a2ee8b3964aa1c8e8a5697bcc7893"),
    ]
    assert page.data[1].started_at_ms == 1794307748104
    assert page.data[1].completed_at_ms == 1794307748651
    assert [r.turn_id for r in page.data] == [
        "01a1c513-66de-7730-9509-ffca305e55c0",
        "01a1c513-66de-7730-9509-ffca305e55c0",
        "01a1c513-66de-7730-9509-ffca305e55c0",
    ]
    assert page.next_cursor is None

    first = next(r for r in requests if r["msg"]["params"] == {"threadId": thread_id, "limit": 2})
    first_page = ThreadItemsPage.model_validate(_reply(records, first)["result"])
    following = requests[requests.index(first) + 1]
    assert first_page.next_cursor is not None
    assert first_page.next_cursor == following["msg"]["params"]["cursor"]

    assert turn_items_params(thread_id, turn_id, limit=2) == {
        "threadId": "01a1c513-4902-7a92-81fa-3d7461d47839",
        "turnId": "01a1c513-66de-7730-9509-ffca305e55c0",
        "limit": 2,
    }
    assert turn_items_params(thread_id, turn_id, limit=20, cursor="c") == {
        "threadId": "01a1c513-4902-7a92-81fa-3d7461d47839",
        "turnId": "01a1c513-66de-7730-9509-ffca305e55c0",
        "limit": 20,
        "cursor": "c",
    }


def test_in_progress_turn_lists_only_completed_items():
    records = _read_trace("08-thread-b-tools-reasoning-inflight-resume.jsonl")
    request = next(r for r in _requests(records, THREAD_TURNS_LIST) if r["conn"] == "c4")
    page = ThreadTurnsPage.model_validate(_reply(records, request)["result"])

    assert [(turn.id, turn.status) for turn in page.data] == [
        ("01a1c513-9ad9-75e0-bf99-4ff3d12fff7b", "inProgress"),
    ]
    items_request = next(
        r for r in _requests(records, THREAD_ITEMS_LIST)
        if r["conn"] == "c4" and r["seq"] > request["seq"]
        and r["msg"]["params"].get("turnId") == page.data[0].id
    )
    items_page = ThreadItemsPage.model_validate(_reply(records, items_request)["result"])
    assert [r.item["type"] for r in items_page.data] == ["userMessage", "commandExecution"]
    assert items_page.data[1].item["status"] == "completed"


def test_interrupted_turn_keeps_only_user_message():
    records = _read_trace("09-turn-interrupt.jsonl")
    request = _requests(records, THREAD_TURNS_LIST)[0]
    page = ThreadTurnsPage.model_validate(_reply(records, request)["result"])

    assert page.data[0].id == "01a1c513-ccc5-7612-927f-716a8aeb8414"
    assert page.data[0].status == "interrupted"
    items_request = next(
        r for r in _requests(records, THREAD_ITEMS_LIST)
        if r["msg"]["params"].get("turnId") == page.data[0].id
    )
    items_page = ThreadItemsPage.model_validate(_reply(records, items_request)["result"])
    assert [r.item["type"] for r in items_page.data] == ["userMessage"]


def test_command_approval_decline_matches_recorded_reply():
    records = _read_trace("10-approval-decline.jsonl")
    approval = _requests(records, "item/commandExecution/requestApproval", "recv")[0]
    request = approval["msg"]
    reply = _reply(records, approval)["result"]

    assert reply == {"decision": "decline"}
    assert _refuse_server_request(request["method"], request["params"]) == reply

    completed = next(
        record["msg"]["params"]
        for record in records[records.index(approval) + 1 :]
        if record["dir"] == "recv"
        and record["conn"] == approval["conn"]
        and record["msg"].get("method") == "item/completed"
        and record["msg"]["params"]["item"]["type"] == "commandExecution"
        and record["msg"]["params"]["item"]["id"] == request["params"]["itemId"]
    )
    assert completed["item"]["status"] == "declined"

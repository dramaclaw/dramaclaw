"""Clear a stored thread using the recorded Codex wire contract."""

from copy import deepcopy
import json
import time
from pathlib import Path

from openai_codex.errors import InvalidRequestError
import pytest

from novelvideo.chat import backend_sdk
from novelvideo.chat.codex_protocol import oldest_turn_params


def _recorded_results(filename: str, method: str) -> list[tuple[dict, dict]]:
    path = Path(__file__).parent / "fixtures" / "codex-0.162" / filename
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    results = []
    for index, record in enumerate(records):
        msg = record["msg"]
        if record["dir"] != "send" or msg.get("method") != method or "id" not in msg:
            continue
        reply = next(
            item["msg"]
            for item in records[index + 1 :]
            if item["conn"] == record["conn"]
            and item["dir"] != record["dir"]
            and item["msg"].get("id") == msg["id"]
            and ("result" in item["msg"] or "error" in item["msg"])
        )
        if "result" in reply:
            results.append((msg["params"], reply["result"]))
    return results


@pytest.fixture
def history():
    resume = _recorded_results("12-revert.jsonl", "thread/resume")[0][1]
    empty = next(
        result for _, result in _recorded_results("12-revert.jsonl", "thread/turns/list")
        if result["data"] == []
    )
    oldest = next(
        result
        for params, result in _recorded_results("05-history-reads.jsonl", "thread/turns/list")
        if params.get("sortDirection") == "asc"
    )
    reverted = _recorded_results("12-revert.jsonl", "thread/revert")[-1][1]
    legacy = _recorded_results("11-legacy-history-thread.jsonl", "thread/start")[0][1]
    return SimpleHistory(resume, empty, oldest, reverted, legacy)


class SimpleHistory:
    def __init__(self, resume, empty, oldest, reverted, legacy):
        self.resume = resume
        self.empty = empty
        self.oldest = oldest
        self.reverted = reverted
        self.legacy = legacy
        self.thread_id = resume["thread"]["id"]
        self.resume_call = (
            "request", "thread/resume", {"threadId": self.thread_id, "excludeTurns": True}
        )
        self.oldest_call = ("request", "thread/turns/list", oldest_turn_params(self.thread_id))
        self.newest_call = (
            "request", "thread/turns/list",
            {"threadId": self.thread_id, "limit": 1, "itemsView": "notLoaded"},
        )
        self.read_call = (
            "request", "thread/read", {"threadId": self.thread_id, "includeTurns": False}
        )
        self.idle_calls = [
            self.oldest_call,
            (
                "request", "thread/revert",
                {
                    "threadId": self.thread_id,
                    "beforeTurnId": "01a1c513-4c51-7a02-acaa-5f75458748e4",
                },
            ),
            self.newest_call,
        ]

    def active(self):
        response = deepcopy(self.resume)
        response["thread"]["status"] = {"type": "active", "activeFlags": []}
        return response

    def in_progress(self):
        page = deepcopy(self.oldest)
        page["data"] = [page["data"][-1]]
        page["data"][0]["status"] = "inProgress"
        return page


class ScriptedClient:
    def __init__(self, answers):
        self.answers = iter(answers)
        self.calls = []

    def request(self, method, params, *, response_model):
        self.calls.append(("request", method, params))
        answer = next(self.answers)
        if isinstance(answer, Exception):
            raise answer
        return response_model.model_validate(answer)

    def turn_interrupt(self, thread_id, turn_id):
        self.calls.append(("turn_interrupt", thread_id, turn_id))

    def thread_unarchive(self, thread_id):
        self.calls.append(("thread_unarchive", thread_id))


def test_idle_thread_is_reverted(history):
    client = ScriptedClient([history.resume, history.oldest, history.reverted, history.empty])
    assert backend_sdk.revert_codex_thread_history(client, history.thread_id) == "reverted"
    assert client.calls == [history.resume_call, *history.idle_calls]


def test_empty_thread_needs_no_revert(history):
    client = ScriptedClient([history.resume, history.empty])
    assert backend_sdk.revert_codex_thread_history(client, history.thread_id) == "empty"
    assert client.calls == [history.resume_call, history.oldest_call]


def test_missing_rollout_needs_no_revert(history):
    client = ScriptedClient([
        InvalidRequestError(-32600, f"no rollout found for thread id {history.thread_id}")
    ])
    assert backend_sdk.revert_codex_thread_history(client, history.thread_id) == "missing"
    assert client.calls == [history.resume_call]


def test_archived_thread_is_restored_before_revert(history):
    client = ScriptedClient([
        InvalidRequestError(-32600, f"session {history.thread_id} is archived"),
        history.resume, history.oldest, history.reverted, history.empty,
    ])
    assert backend_sdk.revert_codex_thread_history(client, history.thread_id) == "reverted"
    assert client.calls == [
        history.resume_call, ("thread_unarchive", history.thread_id),
        history.resume_call, *history.idle_calls,
    ]


def test_legacy_thread_is_rejected(history):
    client = ScriptedClient([history.legacy])
    with pytest.raises(backend_sdk.CodexThreadHistoryModeError) as error:
        backend_sdk.revert_codex_thread_history(client, history.thread_id)
    assert history.thread_id in str(error.value)
    assert "legacy" in str(error.value)
    assert client.calls == [history.resume_call]


def test_active_turn_is_interrupted_and_waited_for(history, monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda _: None)
    newest = history.in_progress()
    client = ScriptedClient([
        history.active(), newest, history.active(), history.resume,
        history.oldest, history.reverted, history.empty,
    ])
    assert backend_sdk.revert_codex_thread_history(client, history.thread_id) == "reverted"
    assert client.calls == [
        history.resume_call, history.newest_call,
        ("turn_interrupt", history.thread_id, "01a1c513-66de-7730-9509-ffca305e55c0"),
        history.read_call, history.read_call, *history.idle_calls,
    ]


def test_active_thread_that_stays_busy_is_not_reverted(history, monkeypatch):
    monkeypatch.setattr(backend_sdk, "_CODEX_CLEAR_IDLE_POLLS", 3, raising=False)
    monkeypatch.setattr(time, "sleep", lambda _: None)
    client = ScriptedClient([
        history.active(), history.oldest, history.active(), history.active(), history.active(),
    ])
    with pytest.raises(backend_sdk.CodexThreadBusyError):
        backend_sdk.revert_codex_thread_history(client, history.thread_id)
    assert client.calls == [
        history.resume_call, history.newest_call,
        history.read_call, history.read_call, history.read_call,
    ]


def test_turn_left_after_revert_is_an_error(history):
    client = ScriptedClient([history.resume, history.oldest, history.reverted, history.oldest])
    with pytest.raises(RuntimeError) as error:
        backend_sdk.revert_codex_thread_history(client, history.thread_id)
    assert history.thread_id in str(error.value)
    assert client.calls == [history.resume_call, *history.idle_calls]

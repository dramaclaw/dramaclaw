"""Per-turn context chunking and the recorded turn/start wire contract."""

import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.chat import backend_sdk, codex_app_server


@pytest.mark.parametrize("kind", ["application", "untrusted"])
def test_context_entries_preserve_short_text(kind):
    from novelvideo.chat.codex_protocol import context_entries

    assert context_entries("k", "  exact text\n", kind=kind) == {
        "k": {"value": "  exact text\n", "kind": kind}
    }
    assert context_entries("k", "a" * 4000, kind=kind) == {
        "k": {"value": "a" * 4000, "kind": kind}
    }


@pytest.mark.parametrize("text", ["", "  \n"])
def test_context_entries_omit_blank_text(text):
    from novelvideo.chat.codex_protocol import context_entries

    assert context_entries("k", text, kind="application") == {}


@pytest.mark.parametrize("kind", ["application", "untrusted"])
def test_context_entries_pack_paragraphs_in_reading_order(kind):
    from novelvideo.chat.codex_protocol import context_entries

    text = "\n\n".join(["a" * 500] * 30)
    entries = context_entries("k", text, kind=kind)
    assert list(entries) == ["k", "k-02", "k-03", "k-04", "k-05"]
    values = [entry["value"] for entry in entries.values()]
    assert values == [
        ("a" * 500 + "\n\n") * 7,
        ("a" * 500 + "\n\n") * 7,
        ("a" * 500 + "\n\n") * 7,
        ("a" * 500 + "\n\n") * 7,
        "a" * 500 + "\n\n" + "a" * 500,
    ]
    assert all(len(value.encode("utf-8")) <= 4000 for value in values)
    assert "".join(values) == text
    assert all(entry == {"value": entry["value"], "kind": kind} for entry in entries.values())


def test_context_entries_split_long_lines_at_character_boundaries():
    from novelvideo.chat.codex_protocol import context_entries

    text = "界" * 3000
    entries = context_entries("k", text, kind="untrusted")
    assert entries == {
        "k": {"value": "界" * 1333, "kind": "untrusted"},
        "k-02": {"value": "界" * 1333, "kind": "untrusted"},
        "k-03": {"value": "界" * 334, "kind": "untrusted"},
    }
    values = [entry["value"] for entry in entries.values()]
    assert all(len(value.encode("utf-8")) <= 4000 for value in values)
    assert all(len(value.encode("utf-8")) % 3 == 0 for value in values)
    assert "".join(values) == text


def test_context_entries_split_oversized_paragraphs_at_lines_and_merge_remainders():
    from novelvideo.chat.codex_protocol import context_entries

    text = "a" * 2500 + "\n" + "b" * 2000 + "\n\n" + "c" * 1000
    assert context_entries("k", text, kind="application") == {
        "k": {"value": "a" * 2500 + "\n", "kind": "application"},
        "k-02": {
            "value": "b" * 2000 + "\n\n" + "c" * 1000,
            "kind": "application",
        },
    }


def test_context_entries_keys_sort_in_reading_order():
    from novelvideo.chat.codex_protocol import context_entries

    entries = context_entries("k", "a" * 48000, kind="application")
    assert list(entries) == [
        "k", "k-02", "k-03", "k-04", "k-05", "k-06",
        "k-07", "k-08", "k-09", "k-10", "k-11", "k-12",
    ]
    assert list(entries) == sorted(entries)


def test_context_entries_reject_more_than_99_chunks():
    from novelvideo.chat.codex_protocol import context_entries

    with pytest.raises(ValueError):
        context_entries("k", "\n\n".join(["a" * 3999] * 100), kind="application")


def _recorded_turn():
    path = (
        Path(__file__).parent / "fixtures" / "codex-0.162"
        / "04-turn-additional-context-client-id.jsonl"
    )
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    request = next(
        record for record in records
        if record["dir"] == "send" and record["msg"].get("method") == "turn/start"
    )
    response = next(
        record["msg"]["result"] for record in records[records.index(request) + 1 :]
        if record["conn"] == request["conn"]
        and record["dir"] == "recv"
        and record["msg"].get("id") == request["msg"]["id"]
        and "result" in record["msg"]
    )
    return records, request, response


def test_start_codex_turn_matches_recorded_wire_payload(monkeypatch):
    from openai_codex.client import CodexClient

    _, request, response = _recorded_turn()
    params = request["msg"]["params"]
    calls = []
    client = CodexClient()

    def record(method, params):
        calls.append((method, params))
        return response

    monkeypatch.setattr(client, "_request_raw", record)
    turn = backend_sdk._start_codex_turn(
        SimpleNamespace(id=params["threadId"], _client=client),
        params["input"][0]["text"],
        {"dramaclaw_gateway_api_key": "<GATEWAY_API_KEY>"},
        additional_context=params["additionalContext"],
        client_user_message_id="fixture-client-message-0001",
    )
    assert calls == [("turn/start", params)]
    assert turn.id == response["turn"]["id"]


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"additional_context": {"k": {"value": "context", "kind": "application"}}},
         {"additionalContext": {"k": {"value": "context", "kind": "application"}}}),
        ({"client_user_message_id": "turn-1"}, {"clientUserMessageId": "turn-1"}),
        ({"additional_context": {}, "client_user_message_id": ""}, {}),
    ],
)
def test_start_codex_turn_sends_only_nonempty_context_params(monkeypatch, kwargs, expected):
    from openai_codex.client import CodexClient

    _, _, response = _recorded_turn()
    calls = []
    client = CodexClient()

    def record(method, params):
        calls.append((method, params))
        return response

    monkeypatch.setattr(client, "_request_raw", record)
    backend_sdk._start_codex_turn(
        SimpleNamespace(id="thread-1", _client=client, turn=lambda _input: "ordinary-turn"),
        "hi", {}, **kwargs,
    )
    assert calls == (
        [("turn/start", {"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}],
                          **expected})]
        if expected else []
    )


def test_recorded_user_message_contains_only_user_text_and_client_id():
    records, request, response = _recorded_turn()
    params = request["msg"]["params"]
    item = next(
        record["msg"]["params"]["item"] for record in records
        if record["conn"] == request["conn"]
        and record["dir"] == "recv"
        and record["msg"].get("method") == "item/completed"
        and record["msg"]["params"]["turnId"] == response["turn"]["id"]
        and record["msg"]["params"]["item"]["type"] == "userMessage"
    )
    assert item["clientId"] == "fixture-client-message-0001"
    assert item["content"] == [{
        "type": "text",
        "text": params["input"][0]["text"],
        "text_elements": [],
    }]


@pytest.mark.asyncio
@pytest.mark.parametrize("resume", [False, True])
@pytest.mark.parametrize("with_context", [False, True])
async def test_client_passes_turn_context_on_start_and_resume(
    monkeypatch, tmp_path, resume, with_context
):
    from openai_codex.client import Notification
    from openai_codex.generated.v2_all import TurnCompletedNotification

    class FakeTurn:
        id = "turn-1"

        def stream(self):
            return iter([Notification(
                method="turn/completed",
                payload=TurnCompletedNotification.model_validate({
                    "threadId": "thread-1",
                    "turn": {"id": "turn-1", "items": [], "status": "completed"},
                }),
            )])

    @contextmanager
    def fake_shared_codex(_config):
        yield object()

    calls = []

    def start_turn(_thread, _prompt, _metadata, _schema, **kwargs):
        calls.append((kwargs.get("additional_context"), kwargs.get("client_user_message_id")))
        return FakeTurn()

    monkeypatch.setattr(codex_app_server, "shared_codex", fake_shared_codex)
    monkeypatch.setattr(
        backend_sdk, "_start_or_resume_codex_thread",
        lambda *_args, **_kwargs: SimpleNamespace(id="thread-1"),
    )
    monkeypatch.setattr(backend_sdk, "_start_codex_turn", start_turn)
    context = {"k": {"value": "context", "kind": "application"}}
    client = backend_sdk.CodexClient(
        codex_bin=None, cwd=tmp_path, env={}, model="test-model", model_provider="test",
        developer_instructions="Reply briefly.",
        **({"additional_context": context, "client_user_message_id": "turn-1"}
           if with_context else {}),
    )
    context["k"]["value"] = "changed after client construction"
    thread = client.thread_resume("thread-1") if resume else client.thread_start()
    events = [event async for event in thread.stream("hi")]
    assert any(event.type == "complete" for event in events)
    assert calls == (
        [({"k": {"value": "context", "kind": "application"}}, "turn-1")]
        if with_context else [(None, None)]
    )

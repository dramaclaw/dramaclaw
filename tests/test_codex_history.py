"""Exercise bounded history reads with recorded Codex wire shapes."""

import importlib
import json
import math
import tracemalloc

import pytest
from openai_codex.errors import CodexError, TransportClosedError, map_jsonrpc_error

from codex_history_stub import HistoryClient

THREAD = "thread-history"
TURNS = "thread/turns/list"
ITEMS = "thread/items/list"
MIB = 1024 * 1024


@pytest.fixture
def history():
    # Import per test so the red run also exercises the existing projection tests.
    return importlib.import_module("novelvideo.chat.codex_history")


def _turns_request(thread=THREAD, limit=20, **extra):
    return (TURNS, {"threadId": thread, "itemsView": "notLoaded", "limit": limit, **extra})


def _items_request(index, thread=THREAD, limit=200, **extra):
    return (ITEMS, {"threadId": thread, "turnId": f"turn-{index:04d}", "limit": limit, **extra})


def _message_ids(page):
    return [message["id"] for message in page.messages]


def test_three_turns_and_literal_wire_requests(history):
    client = HistoryClient(3)
    page = history.read_codex_history_page(client, THREAD)

    assert _message_ids(page) == [
        "assistant:turn-0001", "assistant:turn-0002", "assistant:turn-0003",
    ]
    assert [message["turn_id"] for message in page.messages] == [
        "business-0001", "business-0002", "business-0003",
    ]
    assert [message["content"] for message in page.messages] == [
        "reply-0001", "reply-0002", "reply-0003",
    ]
    assert page.before is None
    assert page.byte_size == sum(
        len(json.dumps(message, ensure_ascii=False).encode("utf-8")) for message in page.messages
    )
    assert page.stats == {
        "requests": 4, "turns": 3, "items_limit_halvings": 0, "retries": 0, "capped": None,
    }
    assert client.requests == [
        _turns_request(), _items_request(3), _items_request(2), _items_request(1),
    ]


def test_thousand_large_turns_within_caps_and_memory(history):
    client = HistoryClient(1000, text_size=100 * 1024)
    seen = []
    before = None
    first = True
    tracemalloc.start()
    try:
        while True:
            start = len(client.requests)
            page = history.read_codex_history_page(client, THREAD, before=before)
            if first:
                # Measured once: 205298 bytes/message (text in content and parts).
                # 15 * 205298 = 3079470 <= 3145728; 16 * 205298 = 3284768 > 3145728.
                assert len(page.messages) == 15
                assert _message_ids(page) == [
                    f"assistant:turn-{index:04d}" for index in range(986, 1001)
                ]
                assert page.stats["capped"] == "bytes"
                first = False
            assert page.byte_size <= history.HISTORY_PAGE_MAX_BYTES
            requests = client.requests[start:]
            assert sum(method == TURNS for method, _ in requests) <= (
                math.ceil(len(page.messages) / 20) + 1
            )
            seen.extend(reversed(_message_ids(page)))
            before = page.before
            del page
            if before is None:
                break
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert seen == [f"assistant:turn-{index:04d}" for index in range(1000, 0, -1)]
    assert peak < 16 * MIB


@pytest.mark.parametrize("max_turns", [100, 7])
def test_thousand_small_turns_continue_without_gaps(history, max_turns):
    client = HistoryClient(1000)
    seen = []
    before = None
    while True:
        page = history.read_codex_history_page(client, THREAD, before=before, max_turns=max_turns)
        if before is None:
            assert len(page.messages) == max_turns
            assert [m["turn_id"] for m in page.messages] == [
                f"business-{index:04d}" for index in range(1001 - max_turns, 1001)
            ]
            assert page.stats["capped"] == "turns"
        seen.extend(m["turn_id"] for m in reversed(page.messages))
        before = page.before
        if before is None:
            break
    assert seen == [f"business-{index:04d}" for index in range(1000, 0, -1)]


@pytest.mark.parametrize("appended", [3, 25])
def test_appended_turns_do_not_shift_continuation(history, appended):
    client = HistoryClient(30)
    first = history.read_codex_history_page(client, THREAD, max_turns=7)
    assert first.before == '{"cursor":null,"turn":"turn-0023"}'
    client.count += appended
    before = first.before
    seen = []
    while before is not None:
        page = history.read_codex_history_page(client, THREAD, before=before, max_turns=7)
        seen.extend(m["turn_id"] for m in reversed(page.messages))
        before = page.before
    assert seen == [f"business-{index:04d}" for index in range(23, 0, -1)]


def test_single_oversized_turn_is_whole(history):
    client = HistoryClient(1, text_size=5 * MIB)
    page = history.read_codex_history_page(client, THREAD)
    assert _message_ids(page) == ["assistant:turn-0001"]
    assert len(page.messages[0]["content"]) == 5 * MIB
    assert page.messages[0]["content"] == "x" * (5 * MIB)
    assert page.messages[0]["parts"][-1]["text"] == "x" * (5 * MIB)
    assert page.byte_size > history.HISTORY_PAGE_MAX_BYTES
    assert page.before is None


def test_oversized_items_response_reduces_following_limits(history):
    client = HistoryClient(2, text_size=64 * 1024, item_repeats=80)
    page = history.read_codex_history_page(client, THREAD, max_bytes=100 * MIB)
    assert [params["limit"] for method, params in client.requests if method == ITEMS] == [
        200, 100, 100, 100, 100,
    ]
    assert page.stats["items_limit_halvings"] == 1
    assert _message_ids(page) == ["assistant:turn-0001", "assistant:turn-0002"]
    assert len(page.messages[0]["parts"]) == 160
    assert len(page.messages[0]["content"]) == 80 * 64 * 1024 + 79 * 2


def test_archive_window_retries_same_request(history):
    client = HistoryClient(3)
    client.fail(TURNS, map_jsonrpc_error(-32600, "session thread-history is archived"), 2)
    sleeps = []
    page = history.read_codex_history_page(client, THREAD, sleep=sleeps.append)
    assert _message_ids(page) == [
        "assistant:turn-0001", "assistant:turn-0002", "assistant:turn-0003",
    ]
    assert sleeps == [0.2, 0.2]
    assert page.stats["retries"] == 2
    assert page.stats["requests"] == 6
    assert client.requests[:3] == [_turns_request(), _turns_request(), _turns_request()]


@pytest.mark.parametrize("cached", [False, True])
def test_missing_thread_returns_empty_after_retries(history, cached):
    client = HistoryClient(1)
    error = map_jsonrpc_error(-32600, "no rollout found for thread id thread-history")
    client.fail(TURNS, error, 9)
    sleeps = []
    read = history.CodexHistoryCache().read_page if cached else history.read_codex_history_page
    page = read(client, THREAD, sleep=sleeps.append)
    assert page.messages == []
    assert page.before is None
    assert page.byte_size == 0
    assert sleeps == [0.2, 0.2, 0.2]
    assert page.stats["retries"] == 3
    assert page.stats["requests"] == 4
    assert client.requests == [_turns_request(limit=1 if cached else 20)] * 4


@pytest.mark.parametrize("cached", [False, True])
def test_legacy_items_are_unavailable(history, cached):
    client = HistoryClient(1)
    error = map_jsonrpc_error(-32601, "thread/items/list is not supported yet")
    client.fail(ITEMS, error, 1)
    sleeps = []
    read = history.CodexHistoryCache().read_page if cached else history.read_codex_history_page
    with pytest.raises(history.CodexHistoryUnavailable) as caught:
        read(client, THREAD, sleep=sleeps.append)
    assert caught.value.__cause__ is error
    assert sleeps == []


@pytest.mark.parametrize("error", [
    TransportClosedError("closed"), CodexError("failed"),
    map_jsonrpc_error(-32602, "invalid params"),
])
def test_nonretryable_failures_are_unavailable(history, error):
    client = HistoryClient(1)
    client.fail(TURNS, error, 1)
    sleeps = []
    with pytest.raises(history.CodexHistoryUnavailable) as caught:
        history.read_codex_history_page(client, THREAD, sleep=sleeps.append)
    assert caught.value.__cause__ is error
    assert client.requests == [_turns_request()]
    assert sleeps == []


@pytest.mark.parametrize("method", [TURNS, ITEMS])
@pytest.mark.parametrize("times", [2, 9])
def test_retryable_error_on_any_request(history, method, times):
    client = HistoryClient(1)
    error = map_jsonrpc_error(-32000, "busy", {"codexErrorInfo": "server_overloaded"})
    client.fail(method, error, times)
    sleeps = []
    if times == 9:
        with pytest.raises(history.CodexHistoryUnavailable) as caught:
            history.read_codex_history_page(client, THREAD, sleep=sleeps.append)
        assert caught.value.__cause__ is error
        assert sleeps == [0.2, 0.2, 0.2]
    else:
        page = history.read_codex_history_page(client, THREAD, sleep=sleeps.append)
        assert _message_ids(page) == ["assistant:turn-0001"]
        assert page.stats["retries"] == 2
        assert sleeps == [0.2, 0.2]
    requests = [request for request in client.requests if request[0] == method]
    assert requests == [(_turns_request() if method == TURNS else _items_request(1))] * (
        4 if times == 9 else 3
    )


def test_in_progress_projects_completed_items_and_is_not_cached(history):
    client = HistoryClient(1, in_progress=True)
    cache = history.CodexHistoryCache()
    first = cache.read_page(client, THREAD)
    assert first.messages[0]["content"] == "reply-0001"
    assert first.messages[0]["parts"][0]["event"]["status"] == "completed"
    client.requests.clear()
    second = cache.read_page(client, THREAD)
    assert second == first
    assert client.requests == [_turns_request(limit=1), _turns_request(), _items_request(1)]


def test_cache_probe_newest_key_and_invalidate(history):
    client = HistoryClient(1)
    cache = history.CodexHistoryCache()
    first = cache.read_page(client, THREAD)
    client.requests.clear()
    assert cache.read_page(client, THREAD) == first
    assert client.requests == [_turns_request(limit=1)]

    client.count = 2
    client.requests.clear()
    second = cache.read_page(client, THREAD)
    assert _message_ids(second) == ["assistant:turn-0001", "assistant:turn-0002"]
    assert client.requests == [
        _turns_request(limit=1), _turns_request(), _items_request(2), _items_request(1),
    ]
    cache.invalidate(THREAD)
    client.requests.clear()
    assert cache.read_page(client, THREAD) == second
    assert client.requests == [
        _turns_request(limit=1), _turns_request(), _items_request(2), _items_request(1),
    ]


def test_cache_lru_and_oversized_page(history):
    client = HistoryClient(1)
    cache = history.CodexHistoryCache(max_bytes=1100)
    cache.read_page(client, "thread-a")
    cache.read_page(client, "thread-b")
    cache.read_page(client, "thread-a")
    cache.read_page(client, "thread-c")
    client.requests.clear()
    cache.read_page(client, "thread-a")
    cache.read_page(client, "thread-b")
    assert client.requests == [
        _turns_request("thread-a", 1),
        _turns_request("thread-b", 1), _turns_request("thread-b"), _items_request(1, "thread-b"),
    ]
    cache = history.CodexHistoryCache(max_bytes=1)
    cache.read_page(client, THREAD)
    client.requests.clear()
    cache.read_page(client, THREAD)
    assert client.requests == [_turns_request(limit=1), _turns_request(), _items_request(1)]


@pytest.mark.parametrize("before", [
    "bad json", "null", "[]", "{}", '{"cursor":5,"turn":"turn-0001"}',
    '{"cursor":null,"turn":2}', '{"cursor":null,"turn":"turn-9999"}',
])
def test_invalid_or_missing_continuation_turn(history, before):
    with pytest.raises(ValueError):
        history.read_codex_history_page(HistoryClient(3), THREAD, before=before)


def test_empty_history_is_not_cached(history):
    client = HistoryClient(0)
    cache = history.CodexHistoryCache()
    assert cache.read_page(client, THREAD).messages == []
    assert cache.read_page(client, THREAD).before is None
    assert client.requests == [_turns_request(limit=1), _turns_request(limit=1)]

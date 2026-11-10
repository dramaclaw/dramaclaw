"""Browser history pages merge real Codex projections with scoped SQLite rows."""

import copy
import importlib
import json
import logging
from datetime import datetime, timezone

import pytest

from codex_history_stub import HistoryClient
from novelvideo.chat.codex_history import CodexHistoryCache, CodexHistoryUnavailable
from novelvideo.chat.store import ChatScope, ChatStore

THREAD = "thread-history"
USER = "test"


@pytest.fixture
def chat(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    return ChatStore(), ChatScope(kind="home")


@pytest.fixture
def history_page():
    return importlib.import_module("novelvideo.chat.history_page")


def codex_reader(count, *, text_size=None):
    cache, client = CodexHistoryCache(), HistoryClient(count, text_size=text_size)

    async def read(before):
        return cache.read_page(client, THREAD, before=before)

    return read


async def read_page(module, chat, read_codex, before=None, extract_media=lambda text: []):
    store, scope = chat
    return await module.read_history_page(
        username=USER, store_scope=scope, before=before, read_codex=read_codex,
        extract_media=extract_media, store=store,
    )


def append(chat, role, content, **kwargs):
    store, scope = chat
    return store.append_message(USER, scope, role, content, **kwargs)


def set_created_at(chat, row_id, created_at):
    store, scope = chat
    with store.connect(USER, scope) as conn:
        conn.execute("UPDATE chat_messages SET created_at=? WHERE id=?", (created_at, row_id))


def append_turns(chat, count, *, errors=False):
    ids = []
    for index in range(1, count + 1):
        row = append(chat, "user", f"user-{index:04d}", turn_id=f"business-{index:04d}")
        ids.append(row["id"])
        set_created_at(
            chat, row["id"], datetime.fromtimestamp(1794307745 + index, timezone.utc).isoformat()
        )
        if errors and index % 10 == 0:
            ids.append(append(
                chat, "assistant", f"error-{index:04d}", turn_id=f"business-{index:04d}",
                metadata={"chat_error": True},
            )["id"])
    return ids


async def collect_pages(module, chat, read_codex):
    pages, before = [], None
    for _ in range(300):
        page = await read_page(module, chat, read_codex, before)
        pages.append(page)
        assert page.has_more is (page.before is not None)
        before = page.before
        if before is None:
            return pages
    pytest.fail("history cursor did not terminate")


async def no_codex(before):
    return None


@pytest.mark.asyncio
async def test_merge(history_page, chat, caplog):
    append(chat, "user", "user1", turn_id="business-0001")
    append(chat, "assistant", "old reply", turn_id="business-0001",
           idempotency_key="assistant:business-0001")
    append(chat, "trace", "hidden trace")
    append(chat, "agent_notification", "hidden notification")
    append(chat, "user", "user2", turn_id="business-0002")
    error = append(chat, "assistant", "error", turn_id="business-0002",
                   metadata={"chat_error": True})
    append(chat, "user", "user3", turn_id="business-0003")
    notice = append(chat, "assistant", "notice", idempotency_key="chat-notification:k1")
    extracted = []
    extract = lambda content: extracted.append(content) or [  # noqa: E731
        {"type": "image", "url": "/m/" + content}
    ]
    with caplog.at_level(logging.INFO, logger="novelvideo.chat.history_page"):
        page = await read_page(history_page, chat, codex_reader(3), extract_media=extract)
    assert [(m["role"], m["id"] if isinstance(m["id"], str) else m["content"])
            for m in page.history] == [
        ("user", "user1"), ("assistant", "assistant:turn-0001"),
        ("user", "user2"), ("assistant", "assistant:turn-0002"),
        ("assistant", "error"), ("user", "user3"),
        ("assistant", "assistant:turn-0003"), ("assistant", "notice"),
    ]
    assert [m["id"] for m in page.history if isinstance(m["id"], int)][-1] == notice["id"]
    assert next(m for m in page.history if m["id"] == error["id"])["chat_error"] is True
    assert all("idempotency_key" not in m for m in page.history)
    assert extracted == ["reply-0001", "reply-0002", "reply-0003"]
    assert [m["media"] for m in page.history if isinstance(m["id"], str)] == [
        [{"type": "image", "url": "/m/reply-0001"}],
        [{"type": "image", "url": "/m/reply-0002"}],
        [{"type": "image", "url": "/m/reply-0003"}],
    ]
    assert page.before is None
    assert page.has_more is False
    records = [r for r in caplog.records if r.name == "novelvideo.chat.history_page"]
    assert len(records) == 1
    for field in ("scope=home", "codex=3", "store=5", "overflow=False", "has_more=False",
                  "elapsed_ms="):
        assert field in records[0].message
    assert "user1" not in records[0].message
    assert "reply-0001" not in records[0].message


@pytest.mark.asyncio
async def test_server_events_exclude_snapshots_and_preserve_cache(history_page, chat):
    store, scope = chat
    append_turns(chat, 3)
    store.append_ui_event(USER, scope, "business-0002", {
        "type": "assistant.clarification.request", "submitted": True,
        "clarification_id": "question-2", "question": "Continue?",
    })
    store.append_ui_event(USER, scope, "business-0001", {
        "type": "assistant.message_parts",
        "parts": [{"id": "browser", "type": "text", "text": "x" * (2 * 1024 * 1024)}],
    })
    read = codex_reader(3)
    cached = await read(None)
    original = copy.deepcopy(cached.messages)
    page = await read_page(history_page, chat, read)
    messages = {m["id"]: m for m in page.history}
    events = messages["assistant:turn-0002"]["ui_events"]
    assert [(e["type"], e["submitted"], e["clarification_id"], e["question"])
            for e in events] == [
        ("assistant.clarification.request", True, "question-2", "Continue?"),
    ]
    assert messages["assistant:turn-0001"]["ui_events"] == []
    assert messages["assistant:turn-0001"]["parts"] == original[0]["parts"]
    assert not messages["assistant:turn-0001"].get("parts_incomplete", False)
    assert cached.messages == original


@pytest.mark.asyncio
async def test_history_page_with_no_loss_or_duplicates(history_page, chat):
    old_ids = [append(chat, "assistant", f"old-{i}")["id"] for i in range(3)]
    for row_id in old_ids:
        set_created_at(chat, row_id, "2000-01-01T00:00:00+00:00")
    row_ids = old_ids + append_turns(chat, 250, errors=True)
    pages = await collect_pages(history_page, chat, codex_reader(250))
    assert [sum(isinstance(m["id"], str) for m in p.history) for p in pages] == [100, 100, 50]
    assert [m["id"] for p in reversed(pages) for m in p.history
            if isinstance(m["id"], str)] == [
        f"assistant:turn-{i:04d}" for i in range(1, 251)
    ]
    assert [m["id"] for p in reversed(pages) for m in p.history
            if isinstance(m["id"], int)] == row_ids
    assert [m["content"] for m in pages[-1].history[:3]] == ["old-0", "old-1", "old-2"]
    assert all(m["id"] not in old_ids for p in pages[:-1] for m in p.history)


@pytest.mark.asyncio
@pytest.mark.parametrize("turns", [1, 101])
async def test_store_overflow_keeps_all_rows(history_page, chat, monkeypatch, turns):
    monkeypatch.setattr(history_page, "STORE_ROWS_PAGE_MAX", 5)
    row_ids = append_turns(chat, turns)
    row_ids += [append(chat, "assistant", f"notice-{i}")["id"] for i in range(11)]
    pages = await collect_pages(history_page, chat, codex_reader(turns))
    assert [m["id"] for p in reversed(pages) for m in p.history
            if isinstance(m["id"], int)] == row_ids
    assert [m["id"] for p in reversed(pages) for m in p.history
            if isinstance(m["id"], str)] == [f"assistant:turn-{i:04d}" for i in range(1, turns + 1)]
    assert all(sum(isinstance(m["id"], int) for m in p.history) <= 5 for p in pages)
    assert json.loads(pages[0].before)["codex_done"] is (turns == 1)
    if turns == 1:
        assert [len(p.history) for p in pages] == [6, 5, 2]
        assert json.loads(pages[0].before) == {"codex": None, "row": 8, "codex_done": True}


@pytest.mark.asyncio
async def test_store_only_tail(history_page, chat):
    row_ids = [append(chat, "assistant", f"row-{i}", turn_id=f"store-{i}",
                      idempotency_key=f"assistant:store-{i}")["id"] for i in range(1200)]
    pages = await collect_pages(history_page, chat, no_codex)
    assert [len(p.history) for p in pages] == [500, 500, 200]
    assert [m["id"] for p in reversed(pages) for m in p.history] == row_ids
    assert json.loads(pages[0].before) == {"codex": None, "row": 701, "codex_done": True}
    assert json.loads(pages[1].before) == {"codex": None, "row": 201, "codex_done": True}


@pytest.mark.asyncio
async def test_codex_unavailable(history_page, chat, caplog):
    append(chat, "user", "hello", turn_id="business-0001")
    append(chat, "assistant", "old", turn_id="business-0001",
           idempotency_key="assistant:business-0001")

    async def unavailable(before):
        raise CodexHistoryUnavailable("private diagnostic text")

    with caplog.at_level(logging.INFO, logger="novelvideo.chat.history_page"):
        page = await read_page(history_page, chat, unavailable)
    assert [(m["role"], m["content"]) for m in page.history] == [
        ("user", "hello"), ("assistant", "old"),
    ]
    assert page.before is None
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "scope=home" in warnings[0].message
    assert "private diagnostic text" not in caplog.text
    assert "hello" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("before", [
    "x", "{}", '{"codex":null,"row":"a","codex_done":false}',
    "[]", "null", '{"codex":null,"row":true,"codex_done":false}',
    '{"codex":2,"row":null,"codex_done":false}',
    '{"codex":null,"row":null,"codex_done":0}',
    '{"codex":null,"row":null,"codex_done":false,"extra":1}',
])
async def test_invalid_cursor(history_page, chat, before):
    with pytest.raises(ValueError, match="cursor"):
        await read_page(history_page, chat, no_codex, before)


@pytest.mark.asyncio
async def test_timestamp_fallback_and_codex_order(history_page, chat):
    append(chat, "assistant", "early")
    set_created_at(chat, 1, "2000-01-01T00:00:00+00:00")
    append(chat, "assistant", "late")
    page = await read_page(history_page, chat, codex_reader(3))
    assert [m["content"] for m in page.history] == [
        "early", "reply-0001", "reply-0002", "reply-0003", "late",
    ]


@pytest.mark.asyncio
async def test_missing_anchor_defers_store_to_last_page(history_page, chat):
    append(chat, "assistant", "early")
    set_created_at(chat, 1, "2000-01-01T00:00:00+00:00")
    pages = await collect_pages(history_page, chat, codex_reader(101))
    assert [len(p.history) for p in pages] == [100, 2]
    assert json.loads(pages[0].before)["row"] is None
    assert [m["content"] for m in pages[-1].history] == ["early", "reply-0001"]


@pytest.mark.asyncio
async def test_history_rows_bounds_and_shape(chat):
    store, scope = chat
    append(chat, "assistant", "prefix")
    append(chat, "assistant", "prefix suffix", metadata={"chat_error": True},
           idempotency_key="error:1")
    append(chat, "trace", "hidden")
    append(chat, "agent_notification", "hidden")
    append(chat, "user", "last", turn_id="business-0001")
    rows, overflow = await store.history_rows_async(
        USER, scope, lower_id=2, upper_id=5, limit=10, max_bytes=512 * 1024,
    )
    assert overflow is False
    assert rows == [{
        "id": 2, "role": "assistant", "content": "prefix suffix", "media": [],
        "attachments": [], "created_at": rows[0]["created_at"], "chat_error": True,
        "idempotency_key": "error:1",
    }]
    rows, overflow = await store.history_rows_async(
        USER, scope, lower_id=None, upper_id=None, limit=2, max_bytes=512 * 1024,
    )
    assert overflow is True
    assert [r["id"] for r in rows] == [2, 5]
    assert rows[1]["idempotency_key"] is None
    assert rows[1]["turn_id"] == "business-0001"
    assert all("ui_events" not in row for row in rows)


@pytest.mark.asyncio
async def test_history_anchor_prefers_first_user_then_timestamp(chat):
    store, scope = chat
    append(chat, "assistant", "first", turn_id="business-0001")
    append(chat, "user", "second", turn_id="business-0001")
    append(chat, "user", "third", turn_id="business-0001")
    set_created_at(chat, 1, "2001-01-01T00:00:00+00:00")
    set_created_at(chat, 2, "2000-01-01T00:00:00+00:00")
    set_created_at(chat, 3, "2002-01-01T00:00:00+00:00")
    assert await store.history_anchor_id_async(
        USER, scope, turn_id="business-0001", created_at="2003-01-01T00:00:00+00:00"
    ) == 2
    assert await store.history_anchor_id_async(
        USER, scope, turn_id="missing", created_at="2001-01-01T00:00:00+00:00"
    ) == 1
    assert await store.history_anchor_id_async(
        USER, scope, turn_id="missing", created_at="2003-01-01T00:00:00+00:00"
    ) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("cap, expected", [
    ("UI_TURN_MAX_OTHER_ROWS", ["notice", "chat.history_incomplete"]),
    ("UI_EVENT_MAX_BYTES", ["chat.history_incomplete"]),
    ("UI_TURN_MAX_BYTES", ["chat.history_incomplete"]),
    ("UI_HISTORY_MAX_BYTES", ["chat.history_incomplete"]),
])
async def test_turn_events_reuse_bounds(chat, monkeypatch, cap, expected):
    from novelvideo.chat import store as store_module

    store, scope = chat
    for seq in range(2):
        store.append_ui_event(USER, scope, "business-0001", {"type": "notice", "seq": seq})
    monkeypatch.setattr(store_module, cap, 1)
    events = await store.turn_ui_events_async(
        USER, scope, ["business-0001"], max_bytes=store_module.UI_HISTORY_MAX_BYTES,
    )
    assert [e["type"] for e in events["business-0001"]] == expected
    if cap == "UI_TURN_MAX_OTHER_ROWS":
        assert events["business-0001"][0]["seq"] == 1


@pytest.mark.asyncio
async def test_store_byte_overflow_keeps_all_rows_and_codex_messages(history_page, chat):
    row_ids = [append(
        chat, "user", "x" * (200 * 1024), turn_id=f"business-{index:04d}",
    )["id"] for index in range(1, 6)]
    pages = await collect_pages(history_page, chat, codex_reader(5))
    assert [sum(isinstance(m["id"], int) for m in p.history) for p in pages] == [2, 2, 1]
    assert [m["id"] for m in pages[0].history if isinstance(m["id"], int)] == [4, 5]
    assert [m["id"] for p in reversed(pages) for m in p.history
            if isinstance(m["id"], int)] == row_ids
    assert [m["id"] for p in reversed(pages) for m in p.history
            if isinstance(m["id"], str)] == [
        "assistant:turn-0001", "assistant:turn-0002", "assistant:turn-0003",
        "assistant:turn-0004", "assistant:turn-0005",
    ]


@pytest.mark.asyncio
async def test_single_oversized_store_row_is_whole_on_its_own_page(history_page, chat):
    append(chat, "user", "older")
    append(chat, "user", "x" * (1024 * 1024))
    append(chat, "user", "newer")
    pages = await collect_pages(history_page, chat, no_codex)
    assert [[m["id"] for m in p.history] for p in pages] == [[3], [2], [1]]
    assert pages[1].history[0]["content"] == "x" * (1024 * 1024)


@pytest.mark.asyncio
async def test_store_byte_cut_formats_only_kept_rows(history_page, chat, monkeypatch):
    for index in range(1, 6):
        append(chat, "user", "x" * (200 * 1024), turn_id=f"business-{index:04d}")
    formatted = []
    original = ChatStore._message_from_row

    def record(row):
        formatted.append(row["id"])
        return original(row)

    monkeypatch.setattr(ChatStore, "_message_from_row", staticmethod(record))
    page = await read_page(history_page, chat, codex_reader(5))
    assert formatted == [4, 5]
    assert [m["id"] for m in page.history if isinstance(m["id"], int)] == [4, 5]


@pytest.mark.asyncio
async def test_ui_events_page_budget_favors_recent_turns(history_page, chat):
    store, scope = chat
    append_turns(chat, 3)
    for index in range(1, 4):
        store.append_ui_event(USER, scope, f"business-{index:04d}", {
            "type": "notice", "text": "x" * (300 * 1024),
        })
    page = await read_page(history_page, chat, codex_reader(3))
    messages = {m["id"]: m for m in page.history}
    newest = messages["assistant:turn-0003"]["ui_events"]
    assert [e["type"] for e in newest] == ["notice"]
    assert newest[0]["text"] == "x" * (300 * 1024)
    assert messages["assistant:turn-0002"]["ui_events"] == [
        {"type": "chat.history_incomplete"},
    ]
    assert messages["assistant:turn-0001"]["ui_events"] == [
        {"type": "chat.history_incomplete"},
    ]


@pytest.mark.asyncio
async def test_whole_browser_page_byte_bound_and_complete_ids(history_page, chat):
    store, scope = chat
    row_ids = []
    for index in range(1, 101):
        turn_id = f"business-{index:04d}"
        row_ids.append(append(chat, "user", "x" * (100 * 1024), turn_id=turn_id)["id"])
        store.append_ui_event(USER, scope, turn_id, {
            "type": "notice", "text": "x" * (100 * 1024),
        })
    pages = await collect_pages(history_page, chat, codex_reader(100, text_size=100 * 1024))
    for page in pages:
        assert len(json.dumps(page.history, ensure_ascii=False).encode()) <= (
            4 * 1024 * 1024 + 64 * 1024
        )
    assert [m["id"] for p in reversed(pages) for m in p.history
            if isinstance(m["id"], int)] == row_ids
    assert [m["id"] for p in reversed(pages) for m in p.history
            if isinstance(m["id"], str)] == [
        f"assistant:turn-{index:04d}" for index in range(1, 101)
    ]

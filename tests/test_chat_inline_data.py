"""Chat storage keeps addresses only: inline ``data:`` payloads never reach SQLite."""

from __future__ import annotations

import json
import logging

import pytest

from novelvideo.chat import message_repository
from novelvideo.chat.store import ChatScope, ChatStore

PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="


@pytest.fixture
def chat(tmp_path):
    return ChatStore(), ChatScope(kind="project", id="p", state_dir=str(tmp_path))


def _stored_message(store: ChatStore, scope: ChatScope) -> tuple[str, str]:
    with store.connect("alice", scope) as conn:
        row = conn.execute("SELECT media_json, metadata_json FROM chat_messages").fetchone()
    return row[0], row[1]


def _assert_dropped_without_payload(caplog, *counts: int) -> None:
    messages = [record.getMessage() for record in caplog.records]
    assert messages == [
        f"dropped {count} inline data value(s) from chat storage" for count in counts
    ]


def test_message_media_and_metadata_keep_addresses_only(chat, caplog):
    store, scope = chat
    caplog.set_level(logging.WARNING, logger="novelvideo.chat.inline_data")

    message = store.append_message(
        "alice",
        scope,
        "user",
        "看这两张",
        [
            {"type": "image", "fileName": "a.png", "content": PNG_DATA_URL},
            {"type": "image", "url": "/static/projects/p/b.png?v=3"},
        ],
        metadata={"preview": JPEG_DATA_URL, "label": "参考"},
    )

    media_json, metadata_json = _stored_message(store, scope)
    assert media_json == (
        '[{"type": "image", "fileName": "a.png"}, '
        '{"type": "image", "url": "/static/projects/p/b.png?v=3"}]'
    )
    assert metadata_json == '{"label": "参考"}'
    assert message["media"] == json.loads(media_json)
    # One line per stored field; the payload itself is never logged.
    _assert_dropped_without_payload(caplog, 1, 1)


@pytest.mark.asyncio
async def test_async_message_media_keeps_addresses_only(chat, caplog):
    store, scope = chat
    caplog.set_level(logging.WARNING, logger="novelvideo.chat.inline_data")

    await store.append_message_async(
        "alice",
        scope,
        "user",
        "hi",
        [{"type": "file", "url": PNG_DATA_URL, "path": PNG_DATA_URL, "fileName": "a.png"}],
        turn_id="turn",
    )

    media_json, metadata_json = _stored_message(store, scope)
    assert media_json == '[{"type": "file", "fileName": "a.png"}]'
    assert metadata_json == "{}"
    _assert_dropped_without_payload(caplog, 2)


def test_tool_status_card_inline_data_is_dropped_from_ui_events(chat, caplog):
    store, scope = chat
    caplog.set_level(logging.WARNING, logger="novelvideo.chat.inline_data")
    tool_card = {
        "id": "tool",
        "type": "tool_status",
        "event": {
            "input": {"image": PNG_DATA_URL, "node_id": "n1"},
            "output": f"saved {JPEG_DATA_URL} to n1",
            "result_json": {"images": [PNG_DATA_URL, "/static/projects/p/n1.png"]},
            "raw": PNG_DATA_URL,
        },
    }

    stored = store.append_ui_event(
        "alice",
        scope,
        "turn",
        {"type": "assistant.message_parts", "parts": [tool_card]},
    )

    with store.connect("alice", scope) as conn:
        (payload_json,) = conn.execute("SELECT payload_json FROM chat_ui_events").fetchone()
    assert json.loads(payload_json)["parts"] == [
        {
            "id": "tool",
            "type": "tool_status",
            "event": {
                "input": {"node_id": "n1"},
                "output": "saved  to n1",
                "result_json": {"images": ["/static/projects/p/n1.png"]},
            },
        }
    ]
    assert "data:" not in payload_json
    assert stored["payload"]["parts"] == json.loads(payload_json)["parts"]
    _assert_dropped_without_payload(caplog, 4)


def test_inline_data_inside_a_json_string_is_dropped(chat):
    store, scope = chat
    reference = json.dumps(
        {"nodes": [{"node_id": "n1", "source_url": PNG_DATA_URL}]}, ensure_ascii=False
    )

    store.append_message(
        "alice",
        scope,
        "user",
        "ref",
        [{"type": "canvas_node_reference", "content": reference}],
    )

    media_json, _ = _stored_message(store, scope)
    stored_reference = json.loads(json.loads(media_json)[0]["content"])
    assert stored_reference == {"nodes": [{"node_id": "n1", "source_url": ""}]}


def test_prose_that_mentions_data_colon_is_kept(chat):
    store, scope = chat

    store.append_message(
        "alice",
        scope,
        "assistant",
        "ok",
        [{"type": "note", "label": "metadata: a,b", "url": "data: is a scheme"}],
    )

    media_json, _ = _stored_message(store, scope)
    assert json.loads(media_json) == [
        {"type": "note", "label": "metadata: a,b", "url": "data: is a scheme"}
    ]


def test_data_url_right_after_cjk_text_or_an_underscore_is_cut(chat):
    store, scope = chat

    store.append_message(
        "alice",
        scope,
        "assistant",
        "ok",
        [{"type": "note", "label": f"见图片{PNG_DATA_URL}"}],
        metadata={"ref": f"node_{JPEG_DATA_URL}"},
    )

    media_json, metadata_json = _stored_message(store, scope)
    assert json.loads(media_json) == [{"type": "note", "label": "见图片"}]
    assert json.loads(metadata_json) == {"ref": "node_"}


def test_legacy_project_message_database_keeps_addresses_only(tmp_path):
    conn = message_repository.connect(tmp_path / "chat.db")
    try:
        message_repository.append_message(
            conn,
            "assistant",
            "done",
            [{"type": "image", "url": PNG_DATA_URL}, {"type": "image", "url": "/a.png"}],
            now_iso=lambda: "2026-01-01T00:00:00Z",
        )
        message_repository.replace_trace_messages(
            conn,
            [{"role": "trace", "content": "t", "media": [{"preview": JPEG_DATA_URL}]}],
            now_iso=lambda: "2026-01-02T00:00:00Z",
        )
        rows = conn.execute("SELECT role, media_json FROM chat_messages ORDER BY id").fetchall()
    finally:
        conn.close()

    assert [(row[0], row[1]) for row in rows] == [
        ("assistant", '[{"type": "image"}, {"type": "image", "url": "/a.png"}]'),
        ("trace", "[{}]"),
    ]

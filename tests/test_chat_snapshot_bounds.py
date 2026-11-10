import json
import pytest
from novelvideo.chat import store as module
from novelvideo.chat.store import ChatStore, ChatScope
from scripts.compact_chat_ui_events import compact


@pytest.fixture
def chat(tmp_path):
    return ChatStore(), ChatScope(kind="project", id="p", state_dir=str(tmp_path))


def snapshot(parts, revision=None):
    return {
        "type": "assistant.message_parts",
        "parts": parts,
        **({"snapshot_revision": revision} if revision is not None else {}),
    }


def test_snapshots_merge_and_reject_stale(chat):
    store, scope = chat
    first = {"id": "tool", "type": "tool_status", "text": "retained"}
    for i in range(100):
        store.append_ui_event(
            "alice",
            scope,
            "turn",
            snapshot(
                (
                    [first]
                    if i == 0
                    else [{"id": "thought", "type": "agent_thought", "text": str(i)}]
                ),
                i,
            ),
        )
    store.append_ui_event("alice", scope, "turn", snapshot([], 1))
    with store.connect("alice", scope) as conn:
        rows = conn.execute("SELECT payload_json FROM chat_ui_events").fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0][0])["parts"] == [
        first,
        {"id": "thought", "type": "agent_thought", "text": "99"},
    ]


@pytest.mark.asyncio
async def test_legacy_history_bounded_sync_async(chat, monkeypatch):
    store, scope = chat
    await store.append_message_async("alice", scope, "user", "hello", turn_id="turn")
    with store.connect("alice", scope) as conn:
        for i in range(100):
            conn.execute(
                "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
                (
                    "turn",
                    "assistant.message_parts",
                    json.dumps(
                        snapshot([{"id": "t", "type": "agent_thought", "text": str(i)}])
                    ),
                    "now",
                ),
            )
    monkeypatch.setattr(module, "UI_TURN_MAX_ROWS", 3)
    sync = store.list_messages("alice", scope)
    asynchronous = await store.list_messages_async("alice", scope)
    assert sync == asynchronous
    assert sync[0]["parts_incomplete"] is True
    assert sync[0]["parts"][0]["text"] == "99"
    assert sync[0]["content"] == "hello"


def test_compaction_preserves_early_parts_and_other_events(chat):
    store, scope = chat
    early = {"id": "a", "type": "tool_status"}
    late = {"id": "b", "type": "agent_thought"}
    with store.connect("alice", scope) as conn:
        for payload in [snapshot([early]), snapshot([late]), {"type": "notice"}]:
            conn.execute(
                "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
                ("turn", payload["type"], json.dumps(payload), "now"),
            )
    assert compact(store.db_for("alice", scope), apply=True) == 2
    with store.connect("alice", scope) as conn:
        rows = conn.execute(
            "SELECT event_type,payload_json FROM chat_ui_events ORDER BY id"
        ).fetchall()
    assert len(rows) == 2
    assert json.loads(rows[0][1])["parts"] == [early, late]
    assert rows[1][0] == "notice"


@pytest.mark.asyncio
async def test_oversized_history_is_not_decoded(chat, monkeypatch):
    store, scope = chat
    store.append_message("alice", scope, "user", "hello", turn_id="turn")
    with store.connect("alice", scope) as conn:
        conn.execute(
            "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
            ("turn", "assistant.message_parts", "x" * 1024, "now"),
        )
    monkeypatch.setattr(module, "UI_EVENT_MAX_BYTES", 32)
    assert (await store.list_messages_async("alice", scope))[0]["parts_incomplete"]
    with pytest.raises(ValueError, match="budget"):
        await store.append_ui_event_async(
            "alice", scope, "turn", snapshot([{"text": "x" * 100}])
        )


@pytest.mark.asyncio
async def test_concurrent_updates_keep_one_latest_snapshot(chat):
    import asyncio

    store, scope = chat
    # Chat turns already have their user message and initialized schema.
    store.append_message("alice", scope, "user", "hello", turn_id="turn")
    await asyncio.gather(
        *[
            store.append_ui_event_async(
                "alice",
                scope,
                "turn",
                snapshot([{"id": "t", "type": "agent_thought", "text": str(i)}], i),
            )
            for i in range(20)
        ]
    )
    with store.connect("alice", scope) as conn:
        rows = conn.execute("SELECT payload_json FROM chat_ui_events").fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0][0])["snapshot_revision"] == 19


def test_nonvisible_turns_are_not_read(chat):
    store, scope = chat
    store.append_message("alice", scope, "user", "hello", turn_id="visible")
    with store.connect("alice", scope) as conn:
        conn.execute(
            "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
            ("hidden", "assistant.message_parts", "not json", "now"),
        )
    assert "parts_incomplete" not in store.list_messages("alice", scope)[0]


def test_failed_compaction_rolls_back(chat, monkeypatch):
    store, scope = chat
    with store.connect("alice", scope) as conn:
        for raw in [
            json.dumps(snapshot([{"id": "a", "type": "agent_thought"}])),
            "bad json",
        ]:
            conn.execute(
                "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
                ("turn", "assistant.message_parts", raw, "now"),
            )
    with pytest.raises(ValueError):
        compact(store.db_for("alice", scope), apply=True)
    with store.connect("alice", scope) as conn:
        assert conn.execute("SELECT count(*) FROM chat_ui_events").fetchone()[0] == 2


@pytest.mark.asyncio
async def test_total_history_budget_is_shared_across_turns(chat, monkeypatch):
    store, scope = chat
    for i in range(8):
        turn = str(i)
        store.append_message("alice", scope, "user", turn, turn_id=turn)
        store.append_ui_event(
            "alice",
            scope,
            turn,
            snapshot([{"id": "thought", "type": "agent_thought", "text": "文" * 100}]),
        )
    monkeypatch.setattr(module, "UI_HISTORY_MAX_BYTES", 1000)
    sync = store.list_messages("alice", scope)
    assert sync == await store.list_messages_async("alice", scope)
    assert sum(not row.get("parts_incomplete", False) for row in sync) <= 2
    assert len(sync) == 8


def test_oversized_merge_preserves_previous_snapshot(chat, monkeypatch):
    store, scope = chat
    part = {"id": "a", "type": "tool_status", "text": "x" * 80}
    store.append_ui_event("alice", scope, "turn", snapshot([part]))
    monkeypatch.setattr(module, "UI_EVENT_MAX_BYTES", 220)
    with pytest.raises(ValueError, match="merged"):
        store.append_ui_event("alice", scope, "turn", snapshot([{**part, "id": "b"}]))
    with store.connect("alice", scope) as conn:
        rows = conn.execute("SELECT payload_json FROM chat_ui_events").fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0][0])["parts"] == [part]


def _insert_other_events(store, scope, turn, count, event_type="canvas_context_result"):
    with store.connect("alice", scope) as conn:
        conn.executemany(
            "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
            [
                (turn, event_type, json.dumps({"type": event_type, "seq": i}), "now")
                for i in range(count)
            ],
        )


@pytest.mark.asyncio
async def test_long_normal_turn_fits_default_limits(chat):
    # Shape measured on a real ~31 minute turn: one ~1.5 MiB merged snapshot and
    # ~250 small non-snapshot events. Use 300 to exceed the old all-types row cap.
    store, scope = chat
    store.append_message("alice", scope, "user", "hello", turn_id="turn")
    _insert_other_events(store, scope, "turn", 300)
    big = {"id": "tool", "type": "tool_status", "text": "x" * (1600 * 1024)}
    store.append_ui_event("alice", scope, "turn", snapshot([big], revision=1))
    store.append_ui_event(
        "alice", scope, "turn", snapshot([big, {"id": "done", "type": "text"}], revision=2)
    )
    sync = store.list_messages("alice", scope)
    assert sync == await store.list_messages_async("alice", scope)
    message = next(m for m in sync if m.get("parts"))
    assert not message.get("parts_incomplete")
    assert [p["id"] for p in message["parts"]] == ["tool", "done"]
    assert [e["seq"] for e in message["ui_events"]] == list(range(300))


@pytest.mark.asyncio
async def test_other_event_rows_have_their_own_cap(chat, monkeypatch):
    store, scope = chat
    store.append_message("alice", scope, "user", "hello", turn_id="turn")
    store.append_ui_event("alice", scope, "turn", snapshot([{"id": "a", "type": "tool_status"}]))
    _insert_other_events(store, scope, "turn", 10)
    monkeypatch.setattr(module, "UI_TURN_MAX_ROWS", 1)
    monkeypatch.setattr(module, "UI_TURN_MAX_OTHER_ROWS", 4)
    sync = store.list_messages("alice", scope)
    assert sync == await store.list_messages_async("alice", scope)
    message = next(m for m in sync if m.get("ui_events"))
    assert message["parts_incomplete"] is True
    # Newest events are kept; the snapshot row is older than all of them.
    seqs = [e["seq"] for e in message["ui_events"] if "seq" in e]
    assert seqs == [6, 7, 8, 9]


def test_unstorable_snapshot_is_rejected_as_permanent(chat, monkeypatch):
    store, scope = chat
    part = {"id": "a", "type": "tool_status", "text": "x" * 80}
    store.append_ui_event("alice", scope, "turn", snapshot([part]))
    monkeypatch.setattr(module, "UI_EVENT_MAX_BYTES", 220)
    with pytest.raises(module.ChatUiEventRejected):
        store.append_ui_event("alice", scope, "turn", snapshot([{**part, "id": "b"}]))
    with pytest.raises(module.ChatUiEventRejected):
        store.append_ui_event("alice", scope, "other", snapshot([{"text": "y" * 400}]))

"""Live cards: recorded Codex 0.162 wire contracts and bounded streaming."""

import copy
import json
import tracemalloc
from pathlib import Path
from types import SimpleNamespace

import pytest
from openai_codex.generated import v2_all as v2

from novelvideo.chat import backend_sdk, hermes_sdk, service
from novelvideo.chat.codex_projection import project_item
from novelvideo.chat.presentation_text import _redact_local_filesystem_paths
from novelvideo.chat.runtime_port import ChatBackendEvent
from novelvideo.chat.store import ChatScope, chat_store

FIXTURES = Path(__file__).parent / "fixtures" / "codex-0.162"
RECORDINGS = (
    "03-turn-ce-plain", "08-thread-b-tools-reasoning-inflight-resume",
    "09-turn-interrupt", "10-approval-decline",
)


def notifications(name):
    for line in (FIXTURES / f"{name}.jsonl").read_text().splitlines():
        entry = json.loads(line)
        msg = entry["msg"]
        if entry["dir"] == "recv" and "method" in msg and "id" not in msg:
            yield msg["method"], msg.get("params", {})


def without_none(value):
    if isinstance(value, dict):
        return {k: without_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [without_none(v) for v in value]
    return value


def projector():
    from novelvideo.chat.codex_live import LiveTurnProjector

    live = LiveTurnProjector(turn_id="business-1")
    live.bind("turn-1")
    return live


def apply(cards, frame):
    if frame is None:
        return
    item_id = frame["item_id"]
    if frame["type"] == "item":
        if frame["card"] is None:
            cards.pop(item_id, None)
        else:
            cards[item_id] = copy.deepcopy(frame["card"])
    else:
        target = cards[item_id] if frame["kind"] == "text" else cards[item_id]["event"]
        prefix = target["text"].encode("utf-16-le")[:frame["offset"] * 2]
        target["text"] = prefix.decode("utf-16-le") + frame["text"]


def replay(live, name):
    frames = []
    for method, p in notifications(name):
        if method == "item/started":
            frame = live.started(p["item"], p["startedAtMs"])
        elif method == "item/completed":
            frame = live.completed(p["item"])
        elif method in ("item/agentMessage/delta", "item/reasoning/summaryTextDelta"):
            frame = live.delta(
                p["itemId"], "text" if "agentMessage" in method else "reasoning",
                p["delta"], p.get("summaryIndex"),
            )
        else:
            continue
        if frame is not None:
            frames.append(frame)
    return frames


@pytest.mark.parametrize("name", RECORDINGS)
def test_wire_items_equal_recordings(name):
    for method, p in notifications(name):
        if method in ("item/started", "item/completed"):
            model = (
                v2.ItemStartedNotification if method == "item/started"
                else v2.ItemCompletedNotification
            )
            assert backend_sdk._codex_wire_item(model.model_validate(p).item) == without_none(
                p["item"]
            )


def test_recorded_turn_replay():
    live = projector()
    frames = replay(live, RECORDINGS[1])
    command = "call_81ab3db0133441cdb97eac18"
    mcp = "call_81c0f5f831c24b33b889d752"
    message = "msg_e001c057821f8663ed4d62754a0048834c47fcfd5dd21d90"
    assert [(f["type"], f["item_id"]) for f in frames] == [
        ("item", command), ("item", command), ("item", mcp), ("item", mcp),
        ("item", message),
        *[("item_delta", message)] * 15,
        ("item", message),
    ]
    cards = {}
    for frame in frames:
        assert frame["message_id"] == "assistant:turn-1"
        apply(cards, frame)
    starts = {}
    completed = {}
    for method, p in notifications(RECORDINGS[1]):
        if method == "item/started":
            starts[p["item"]["id"]] = p["startedAtMs"]
        elif method == "item/completed":
            completed[p["item"]["id"]] = p["item"]
    expected = [
        project_item(completed[i], turn_id="business-1", started_at_ms=t, completed=True)
        for i, t in starts.items()
    ]
    assert list(cards.values()) == [c for c in expected if c is not None]
    assert live.item_ids == [command, mcp, message]
    assert live.finish() == []


def test_reasoning_incident_is_capped_and_bounded():
    live = projector()
    item = {"type": "reasoning", "id": "r-1", "summary": [], "content": []}
    cards = {}
    apply(cards, live.started(item, 1))
    count = 0
    tracemalloc.start()
    try:
        for index in range(46_930):
            frame = live.delta("r-1", "reasoning", "tok ", 0)
            if index < 8192:
                assert frame == {
                    "type": "item_delta", "message_id": "assistant:turn-1",
                    "item_id": "r-1", "kind": "reasoning", "offset": index * 4, "text": "tok ",
                }
                count += 1
                apply(cards, frame)
            else:
                assert frame is None
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert count == 8192
    assert peak < 1024 * 1024
    completed = {**item, "summary": ["tok " * 46_930]}
    expected = project_item(completed, turn_id="business-1", started_at_ms=1, completed=True)
    assert cards["r-1"]["event"]["text"] == "tok " * 8192 == expected["event"]["text"]
    frame = live.completed(completed)
    assert frame["card"] == expected
    assert frame["card"]["event"]["truncated"] is True


def test_summary_parts_and_utf16():
    live = projector()
    cards = {}
    item = {"type": "reasoning", "id": "r-1", "summary": []}
    apply(cards, live.started(item, None))
    apply(cards, live.delta("r-1", "reasoning", "a", 0))
    apply(cards, live.delta("r-1", "reasoning", "b", 1))
    assert cards["r-1"]["event"]["text"] == "a\n\nb"
    assert live.completed({**item, "summary": ["a", "b"]})["card"] == project_item(
        {**item, "summary": ["a", "b"]},
        turn_id="business-1", started_at_ms=None, completed=True,
    )
    apply(cards, live.started({"type": "agentMessage", "id": "m-1", "text": ""}, None))
    apply(cards, live.delta("m-1", "text", "😀"))
    frame = live.delta("m-1", "text", "!")
    assert frame["offset"] == 2
    apply(cards, frame)
    assert cards["m-1"]["text"] == "😀!"


def test_path_redaction_across_deltas():
    live = projector()
    cards = {}
    apply(cards, live.started({"type": "agentMessage", "id": "m-1", "text": ""}, 1))
    for text in ("see /Users/al", "ice/x.txt now"):
        frame = live.delta("m-1", "text", text)
        assert "alice" not in frame["text"]
        apply(cards, frame)
    assert cards["m-1"]["text"] == _redact_local_filesystem_paths(
        "see /Users/alice/x.txt now"
    )


def test_finish_interrupted_recording_and_tools():
    live = projector()
    cards = {}
    for frame in replay(live, RECORDINGS[2]):
        apply(cards, frame)
    frames = live.finish()
    assert [f["item_id"] for f in frames] == [
        "rs_e9ee61400cd897f7bca5bb7928b2391edd708ca30b6bbe18",
        "msg_74e4f260a1cf03bbfece837b3df1f420b93dd3a1e7db3426",
    ]
    assert frames[0]["card"]["event"]["text"] == (
        "User wants pure output. Write 1 to 400. That's long but manageable. "
        "Let me output them all on one line. I'll carefully list integers separated by single spaces."
    )
    assert frames[0]["card"]["event"]["status"] == "completed"
    assert frames[1]["card"]["text"] == "1"
    for frame in frames:
        apply(cards, frame)
    assert live.finish() == []
    tool = next(p for method, p in notifications(RECORDINGS[1])
                if method == "item/started" and p["item"]["type"] == "commandExecution")
    live.started(tool["item"], tool["startedAtMs"])
    live.started({"type": "agentMessage", "id": "empty", "text": ""}, None)
    frames = live.finish()
    assert frames[0]["card"]["event"]["raw"]["status"] == "cancelled"
    assert frames[0]["card"]["event"]["raw"]["error"] is None
    assert frames[1] == {
        "type": "item", "message_id": "assistant:turn-1", "item_id": "empty", "card": None,
    }


def test_unrendered_and_unbound_items():
    from novelvideo.chat.codex_live import LiveTurnProjector

    live = LiveTurnProjector(turn_id="business-1")
    message = {"type": "agentMessage", "id": "m-1", "text": "hello"}
    assert live.started(message, 1) is None
    assert live.completed(message) is None
    assert live.delta("m-1", "text", "hello") is None
    assert live.finish() == []
    live.bind("turn-1")
    for item in (
        {"type": "userMessage", "id": "u-1", "content": []},
        {"type": "imageGeneration", "id": "ig-1"},
        {"type": "unknown", "id": "unknown-1"},
    ):
        assert live.started(item, 1) is None
        assert live.delta(item["id"], "text", "ignored") is None
        assert live.completed(item) is None
    assert live.item_ids == []
    assert live.completed(message)["card"] == {
        "id": "m-1", "type": "text", "text": "hello",
    }
    assert live.item_ids == ["m-1"]


@pytest.fixture
def service_runtime(monkeypatch, tmp_path):
    async def authorize(**kwargs):
        return None

    async def token(*args, **kwargs):
        return "test-token"

    class AuthPort:
        async def revoke_agent_session(self, token):
            return True

    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setattr(service, "authorize_hermes_launch", authorize)
    monkeypatch.setattr(service, "_create_page_agent_session_token", token)
    monkeypatch.setattr(service, "get_auth_session_port", lambda: AuthPort())
    monkeypatch.setattr(hermes_sdk, "_issue_turn_capability", lambda **kw: None)


@pytest.mark.asyncio
async def test_service_codex_forwards_items_and_named_tools_without_anonymous_frames(
    service_runtime, monkeypatch, tmp_path,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    message = {"type": "agentMessage", "id": "m-1", "text": ""}
    reasoning = {"type": "reasoning", "id": "r-1", "summary": []}

    class Thread:
        async def stream(self, prompt):
            yield ChatBackendEvent(
                type="thread_started", thread_id="thread-1", turn_id="turn-1",
            )
            yield ChatBackendEvent(type="item_started", item=message, started_at_ms=1)
            for text in ("Hello", " world"):
                yield ChatBackendEvent(
                    type="item_delta", item_id="m-1", name="text", text=text,
                )
                yield ChatBackendEvent(type="assistant_delta", text=text)
            yield ChatBackendEvent(type="item_started", item=reasoning, started_at_ms=2)
            yield ChatBackendEvent(
                type="item_delta", item_id="r-1", name="reasoning",
                text="Checking projects", summary_index=0,
            )
            yield ChatBackendEvent(type="thought_delta", text="Checking projects")
            yield ChatBackendEvent(type="tool_update", text="Listing projects")
            yield ChatBackendEvent(
                type="tool_started", name="dramaclaw.list_projects",
                call_id="call-1", status="running", input={"limit": 1},
            )
            yield ChatBackendEvent(
                type="tool_updated", name="dramaclaw.list_projects",
                call_id="call-1", status="completed", input={"limit": 1},
                text="Projects listed",
            )
            yield ChatBackendEvent(
                type="item_completed", item={**message, "text": "Hello world"},
            )
            yield ChatBackendEvent(
                type="item_completed", item={**reasoning, "summary": ["Checking projects"]},
            )
            yield ChatBackendEvent(type="complete", thread_id="thread-1", text="Hello world")

    monkeypatch.setattr(service, "_build_codex_thread", lambda *a, **kw: Thread())
    events = []

    async def collect(event):
        events.append(event)

    await service._stream_assistant_reply_codex(
        "test-user", "", "hello", collect, store_scope=ChatScope(kind="home"),
        turn_id="business-1",
    )

    assert [event["type"] for event in events] == [
        "thread_started", "item", "item_delta", "item_delta", "item", "item_delta",
        "tool_started", "tool_updated", "item", "item", "done",
    ]


@pytest.mark.asyncio
async def test_service_live_events_do_not_grow_storage(service_runtime, monkeypatch, tmp_path):
    stored = []
    for n in (10, 46_930):
        monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / str(n)))
        reasoning = {"type": "reasoning", "id": "r-1", "summary": []}
        message = {"type": "agentMessage", "id": "m-1", "text": ""}

        class Thread:
            async def stream(self, prompt):
                yield ChatBackendEvent(
                    type="thread_started", thread_id="thread-1", turn_id="turn-1",
                )
                yield ChatBackendEvent(type="item_started", item=reasoning, started_at_ms=1)
                for _ in range(n):
                    yield ChatBackendEvent(
                        type="item_delta", item_id="r-1", name="reasoning",
                        text="tok ", summary_index=0,
                    )
                yield ChatBackendEvent(
                    type="item_completed", item={**reasoning, "summary": ["tok " * n]},
                )
                yield ChatBackendEvent(type="item_started", item=message, started_at_ms=2)
                for text in ("hello", " world"):
                    yield ChatBackendEvent(
                        type="item_delta", item_id="m-1", name="text", text=text,
                    )
                yield ChatBackendEvent(
                    type="item_completed", item={**message, "text": "hello world"},
                )
                yield ChatBackendEvent(type="complete", thread_id="thread-1", text="hello world")

        monkeypatch.setattr(service, "_build_codex_thread", lambda *a, **kw: Thread())
        cards = {}
        counts = {"item": 0, "item_delta": 0}

        async def collect(event):
            if event["type"] in counts:
                assert event["message_id"] == "assistant:turn-1"
                counts[event["type"]] += 1
                apply(cards, event)

        scope = ChatScope(kind="home")
        await service._stream_assistant_reply_codex(
            "test-user", "", "hello", collect, store_scope=scope, turn_id="business-1",
        )
        assert counts == {"item": 4, "item_delta": min(n, 8192) + 2}
        assert cards["m-1"]["text"] == "hello world"
        with chat_store.connect("test-user", scope) as conn:
            assert conn.execute("SELECT COUNT(*) FROM chat_ui_events").fetchone()[0] == 0
            rows = conn.execute("SELECT * FROM chat_messages").fetchall()
            stored.append((len(rows), sum(
                len(str(value).encode()) for row in rows for value in row if value is not None
            )))
    assert stored[0][0] == 0
    assert stored[0] == stored[1]


@pytest.mark.asyncio
async def test_adapter_emits_recorded_items_before_legacy_events(monkeypatch, tmp_path):
    from contextlib import contextmanager

    from openai_codex.models import Notification

    from novelvideo.chat import codex_app_server

    models = {
        "item/started": v2.ItemStartedNotification,
        "item/completed": v2.ItemCompletedNotification,
        "item/agentMessage/delta": v2.AgentMessageDeltaNotification,
        "item/reasoning/summaryTextDelta": v2.ReasoningSummaryTextDeltaNotification,
        "turn/completed": v2.TurnCompletedNotification,
    }
    recorded = [(m, p) for m, p in notifications(RECORDINGS[2]) if m in models]
    turn_id = recorded[0][1]["turnId"]

    class Turn:
        id = turn_id

        def stream(self):
            return iter([
                Notification(method=m, payload=models[m].model_validate(p)) for m, p in recorded
            ])

    @contextmanager
    def shared(config):
        yield object()

    monkeypatch.setattr(codex_app_server, "shared_codex", shared)
    monkeypatch.setattr(
        backend_sdk, "_start_or_resume_codex_thread",
        lambda *a, **kw: SimpleNamespace(id="thread-1"),
    )
    monkeypatch.setattr(backend_sdk, "_start_codex_turn", lambda *a, **kw: Turn())
    thread = backend_sdk.CodexThread(
        codex_bin=None, cwd=tmp_path, env={}, model="test-model", model_provider="test",
        developer_instructions="", config_overrides=(), thread_config={},
        turn_metadata={}, thread_id=None,
    )
    events = [event async for event in thread.stream("hello")]
    live_events = [e for e in events if e.type in {"item_started", "item_completed", "item_delta"}]
    expected = []
    for method, p in recorded:
        if method in {"item/started", "item/completed"}:
            expected.append((
                "item_started" if method == "item/started" else "item_completed",
                p["item"]["id"], without_none(p["item"]), p.get("startedAtMs"), None, None, None,
            ))
        elif "delta" in method.lower():
            expected.append((
                "item_delta", p["itemId"], None, None,
                "text" if "agentMessage" in method else "reasoning",
                p["delta"], p.get("summaryIndex"),
            ))
    assert [
        (e.type, e.item_id, e.item, e.started_at_ms, e.name, e.text, e.summary_index)
        for e in live_events
    ] == expected
    assert all(e.turn_id == turn_id and e.thread_id == "thread-1" for e in live_events)
    for index, event in enumerate(events):
        if event.type == "item_delta":
            assert events[index + 1].type == (
                "assistant_delta" if event.name == "text" else "thought_delta"
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
@pytest.mark.parametrize("callback_fails", [False, True])
async def test_service_finishes_open_items_on_exit(
    service_runtime, monkeypatch, tmp_path, fail, callback_fails,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    class Thread:
        async def stream(self, prompt):
            yield ChatBackendEvent(
                type="thread_started", thread_id="thread-1", turn_id="turn-1",
            )
            yield ChatBackendEvent(
                type="item_started",
                item={"type": "reasoning", "id": "r-1", "summary": []},
            )
            yield ChatBackendEvent(
                type="item_delta", item_id="r-1", name="reasoning", text="thinking",
                summary_index=0,
            )
            if fail:
                raise RuntimeError("runtime failed")
            yield ChatBackendEvent(type="complete", text="done", thread_id="thread-1")

    monkeypatch.setattr(service, "_build_codex_thread", lambda *a, **kw: Thread())
    finished = []
    order = []

    async def collect(event):
        if (
            event["type"] == "item" and event["card"] is not None
            and event["card"]["event"]["status"] == "completed"
        ):
            finished.append(event)
            order.append("finished")
            if callback_fails:
                raise ValueError("client disconnected")
        elif event["type"] == "done":
            order.append("done")

    async def run():
        await service._stream_assistant_reply_codex(
            "test-user", "", "hello", collect, store_scope=ChatScope(kind="home"),
            turn_id="business-1",
        )

    if fail:
        with pytest.raises(RuntimeError, match="^runtime failed$"):
            await run()
    else:
        await run()
    assert finished == [{
        "type": "item", "message_id": "assistant:turn-1", "item_id": "r-1",
        "card": {
            "id": "r-1", "type": "agent_thought", "event": {
                "type": "agent.thought", "turn_id": "business-1", "text": "thinking",
                "status": "completed", "truncated": False,
            },
        },
    }]
    assert order == (["finished"] if fail else ["finished", "done"])


def test_empty_placeholders_are_removed_and_completed_items_stop_streaming():
    live = projector()
    message = {"type": "agentMessage", "id": "empty-message", "text": ""}
    reasoning = {"type": "reasoning", "id": "empty-reasoning", "summary": []}
    assert live.started(message, 7) == {
        "type": "item", "message_id": "assistant:turn-1", "item_id": "empty-message",
        "card": {"id": "empty-message", "seq": 7, "type": "text", "text": ""},
    }
    assert live.started(reasoning, None) == {
        "type": "item", "message_id": "assistant:turn-1", "item_id": "empty-reasoning",
        "card": {
            "id": "empty-reasoning", "type": "agent_thought",
            "event": {
                "type": "agent.thought", "turn_id": "business-1", "text": "",
                "status": "running", "truncated": False,
            },
        },
    }
    assert live.completed(message) == {
        "type": "item", "message_id": "assistant:turn-1",
        "item_id": "empty-message", "card": None,
    }
    assert live.delta("empty-message", "text", "too late") is None
    assert live.finish() == [{
        "type": "item", "message_id": "assistant:turn-1",
        "item_id": "empty-reasoning", "card": None,
    }]
    assert live.item_ids == ["empty-message", "empty-reasoning"]


@pytest.mark.asyncio
async def test_freezone_forwards_reply_without_storing_it(
    service_runtime, monkeypatch, tmp_path,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    class Thread:
        async def stream(self, prompt):
            yield ChatBackendEvent(
                type="thread_started", thread_id="thread-1", turn_id="turn-1",
            )
            yield ChatBackendEvent(
                type="item_started", item={"type": "agentMessage", "id": "m-1", "text": ""},
            )
            yield ChatBackendEvent(type="item_delta", item_id="m-1", name="text", text="Hel")
            yield ChatBackendEvent(type="assistant_delta", text="Hel")
            yield ChatBackendEvent(type="item_delta", item_id="m-1", name="text", text="lo")
            yield ChatBackendEvent(type="assistant_delta", text="Hello")
            yield ChatBackendEvent(
                type="item_completed",
                item={"type": "agentMessage", "id": "m-1", "text": "Hello"},
            )
            yield ChatBackendEvent(type="complete", text="Hello", thread_id="thread-1")

    monkeypatch.setattr(service, "_build_codex_thread", lambda *a, **kw: Thread())
    events = []

    async def collect(event):
        events.append(event)

    scope = ChatScope(
        kind="project", id="project-local", surface="freezone", canvas_id="canvas-local",
    )
    result = await service._stream_assistant_reply_codex(
        "test-user", "project-local", "hello", collect,
        project_dir=tmp_path / "project", tool_mode="freezone_canvas",
        store_scope=scope, turn_id="business-1",
    )
    assert [e for e in events if e["type"] == "item_delta"] == [
        {
            "type": "item_delta", "message_id": "assistant:turn-1", "item_id": "m-1",
            "kind": "text", "offset": 0, "text": "Hel",
        },
        {
            "type": "item_delta", "message_id": "assistant:turn-1", "item_id": "m-1",
            "kind": "text", "offset": 3, "text": "lo",
        },
    ]
    assert events[-1] == {"type": "done", "message": None}
    assert result is None
    with chat_store.connect("test-user", scope) as conn:
        assert conn.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_freezone_cancel_notice_is_idempotent_and_settles_old_clarification(
    service_runtime, monkeypatch, tmp_path,
):
    from novelvideo.chat import hermes_pool, hermes_workspace
    from novelvideo.freezone import canvas_command_bridge

    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(
        kind="project", id="project-local", surface="freezone", canvas_id="canvas-local",
    )
    chat_store.append_ui_event("test-user", scope, "business-1", {
        "type": "assistant.clarification.request", "bridge_key": "bridge-1",
        "clarification_id": "clarify-1", "questions": [{"id": "model", "options": []}],
    })
    for index in range(60):
        chat_store.append_message(
            "test-user", scope, "user", "Other request", turn_id=f"other-{index}",
        )
    resolved = []
    monkeypatch.setattr(
        hermes_workspace, "ensure_user_hermes_workspace", lambda *a, **kw: tmp_path / "hermes",
    )
    monkeypatch.setattr(
        hermes_pool, "canvas_bridge_dir_for_profile", lambda *a, **kw: tmp_path / "bridge",
    )
    monkeypatch.setattr(
        canvas_command_bridge, "resolve_clarification_result",
        lambda key, result, **kw: resolved.append((key, result, kw)),
    )

    class Thread:
        async def stream(self, prompt):
            yield ChatBackendEvent(
                type="thread_started", thread_id="thread-1", turn_id="turn-1",
            )
            yield ChatBackendEvent(type="assistant_delta", text="Partial reply")
            yield ChatBackendEvent(type="egress_disposition", disposition="cancelled")
            yield ChatBackendEvent(type="complete", text="Partial reply", thread_id="thread-1")

    monkeypatch.setattr(service, "_build_codex_thread", lambda *a, **kw: Thread())
    events = []

    async def collect(event):
        events.append(event)

    for _ in range(2):
        result = await service._stream_assistant_reply_codex(
            "test-user", "project-local", "hello", collect,
            project_dir=tmp_path / "project", project_state_dir=tmp_path / "project-state",
            tool_mode="freezone_canvas", store_scope=scope, turn_id="business-1",
        )
        with chat_store.connect("test-user", scope) as conn:
            rows = conn.execute(
                "SELECT role, content, turn_id FROM chat_messages WHERE role != 'user'"
            ).fetchall()
            assert [tuple(row) for row in rows] == [
                ("system", "已取消本轮请求。", "business-1"),
            ]
            assert conn.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0] == 61
        assert result is None
        assert events[-1] == {"type": "done", "message": None}
    turn_events = (await chat_store.turn_ui_events_async(
        "test-user", scope, ["business-1"],
    ))["business-1"]
    assert turn_events[-1]["submitted"] is True
    assert turn_events[-1]["cancelled"] is True
    assert turn_events[-1]["clarification_status"] == "cancelled"
    assert resolved[0][0] == "bridge-1"
    assert resolved[0][1]["cancelled"] is True
    assert resolved[0][1]["message"] == "用户已取消本轮请求"
    assert resolved[0][1]["message_i18n"] == {
        "code": "freezone.chat.clarification.cancelledRequest",
    }
    assert resolved[0][2]["bridge_dir"] == tmp_path / "bridge"

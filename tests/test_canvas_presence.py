"""Project state presence tracks each browser subscription independently."""

import asyncio
import hashlib
import os

import pytest

from novelvideo.api.routes import chat
from novelvideo.freezone import canvas_command_bridge as bridge, canvas_presence as presence


def records(root, canvas="c"):
    digest = hashlib.sha256(canvas.encode()).hexdigest()
    return root / "freezone" / "canvas_presence" / digest


def test_presence_expires_and_is_canvas_scoped(tmp_path):
    module = presence
    assert module.PRESENCE_MAX_AGE_SECONDS == 60
    assert not module.canvas_browser_open(tmp_path, "c", now=100)
    module.touch_canvas_presence(tmp_path, "c", "sse-one", now=100)
    assert module.canvas_browser_open(tmp_path, "c", now=159)
    assert not module.canvas_browser_open(tmp_path, "c", now=161)
    assert not module.canvas_browser_open(tmp_path, "other", now=100)
    assert (records(tmp_path) / "sse-one").read_bytes() == b""


@pytest.mark.parametrize("subscriber", ["", "../escape", "a/b", "a.b", "a" * 81, "a\n"])
def test_invalid_subscriber_ids_are_rejected(tmp_path, subscriber):
    module = presence
    with pytest.raises(ValueError):
        module.touch_canvas_presence(tmp_path, "c", subscriber)
    with pytest.raises(ValueError):
        module.remove_canvas_presence(tmp_path, "c", subscriber)
    assert not list(tmp_path.iterdir())


def test_canvas_path_is_hashed_inside_presence_root(tmp_path):
    module = presence
    module.touch_canvas_presence(tmp_path, "../canvas", "valid_A-1", now=100)
    record = records(tmp_path, "../canvas") / "valid_A-1"
    assert record.is_file()
    assert record.parent.parent == tmp_path / "freezone" / "canvas_presence"
    assert module.canvas_browser_open(tmp_path, "../canvas", now=159)


def test_scanning_prunes_old_records_and_preserves_recent_stale_records(tmp_path):
    module = presence
    for subscriber, timestamp in [("fresh", 999), ("old", 399), ("stale", 500)]:
        module.touch_canvas_presence(tmp_path, "c", subscriber, now=timestamp)
    assert module.canvas_browser_open(tmp_path, "c", now=1000)
    assert {path.name for path in records(tmp_path).iterdir()} == {"fresh", "stale"}
    module.remove_canvas_presence(tmp_path, "c", "fresh")
    module.remove_canvas_presence(tmp_path, "c", "fresh")
    assert not module.canvas_browser_open(tmp_path, "c", now=1000)


@pytest.fixture
def state_dir(monkeypatch, tmp_path):
    async def state(*_):
        return tmp_path

    monkeypatch.setattr(chat, "_bridge_project_state_dir", state)
    monkeypatch.setattr(
        chat, "_candidate_canvas_bridge_dirs_for_scope", lambda *_: [tmp_path / "bridge"]
    )
    return tmp_path


async def test_poll_touches_project_state_before_frame_limit(state_dir):
    for index in range(10):
        bridge.put_pending_canvas_command(
            key=f"command-{index}", project_id="p", canvas_id="c",
            commands=[{"type": "select_nodes", "node_ids": []}],
            envelope={"external_mcp_command": True, "canvas_id": "c",
                      "commands": [{"type": "select_nodes", "node_ids": []}]},
            bridge_dir=state_dir / "bridge",
        )
    result = await chat.list_pending_canvas_commands(
        chat.PendingCanvasCommandsIn(project_id="p", canvas_id="c"), {"username": "viewer"},
    )
    assert len(result["data"]["frames"]) == 10
    assert presence.canvas_browser_open(state_dir, "c")
    subscriber = "poll-" + hashlib.sha256(b"viewer").hexdigest()[:16]
    assert [path.name for path in records(state_dir).iterdir()] == [subscriber]


@pytest.mark.parametrize("push", [False, True])
async def test_sse_presence_is_removed_on_close_even_after_delivery(state_dir, monkeypatch, push):
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1" if push else "0")
    bridge.put_pending_canvas_command(
        key="command", project_id="p", canvas_id="c",
        commands=[{"type": "select_nodes", "node_ids": []}],
        envelope={"external_mcp_command": True, "canvas_id": "c",
                  "commands": [{"type": "select_nodes", "node_ids": []}]},
        bridge_dir=state_dir / "bridge",
    )
    response = await chat.stream_canvas_commands("p", "c", user={"username": "viewer"})
    iterator = response.body_iterator
    try:
        assert await asyncio.wait_for(anext(iterator), 1) == {"comment": "connected"}
        assert presence.canvas_browser_open(state_dir, "c")
        subscribers = list(records(state_dir).iterdir())
        assert len(subscribers) == 1 and subscribers[0].name.startswith("sse-")
        assert (await asyncio.wait_for(anext(iterator), 2))["id"] == "command"
    finally:
        await iterator.aclose()
    assert not presence.canvas_browser_open(state_dir, "c")


async def test_closing_one_sse_keeps_other_subscription_open(state_dir):
    first = (await chat.stream_canvas_commands("p", "c", user={"username": "viewer"})).body_iterator
    response = await chat.stream_canvas_commands("p", "c", user={"username": "viewer"})
    second = response.body_iterator
    try:
        await asyncio.wait_for(anext(first), 1)
        await asyncio.wait_for(anext(second), 1)
        assert len(list(records(state_dir).iterdir())) == 2
        await first.aclose()
        assert presence.canvas_browser_open(state_dir, "c")
    finally:
        await first.aclose()
        await second.aclose()
    assert not presence.canvas_browser_open(state_dir, "c")


async def test_idle_sse_renews_presence_after_timeout(state_dir, monkeypatch):
    monkeypatch.setattr(chat, "CANVAS_STREAM_IDLE_SECONDS", 0.02)
    response = await chat.stream_canvas_commands("p", "c", user={"username": "viewer"})
    iterator = response.body_iterator
    task = None
    try:
        await asyncio.wait_for(anext(iterator), 1)
        for record in records(state_dir).iterdir():
            os.utime(record, (0, 0))
        task = asyncio.create_task(anext(iterator))
        async with asyncio.timeout(1):
            while not presence.canvas_browser_open(state_dir, "c"):
                await asyncio.sleep(0.01)
    finally:
        if task:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        await iterator.aclose()
    assert not presence.canvas_browser_open(state_dir, "c")


async def test_unknown_state_dir_skips_presence(state_dir, monkeypatch):
    async def unknown(*_):
        return None

    monkeypatch.setattr(chat, "_bridge_project_state_dir", unknown)
    await chat.list_pending_canvas_commands(
        chat.PendingCanvasCommandsIn(project_id="p", canvas_id="c"), {"username": "viewer"},
    )
    response = await chat.stream_canvas_commands("p", "c", user={"username": "viewer"})
    iterator = response.body_iterator
    try:
        assert await asyncio.wait_for(anext(iterator), 1) == {"comment": "connected"}
    finally:
        await iterator.aclose()
    assert not records(state_dir).exists()

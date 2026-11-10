"""Browser presence expires independently from command delivery."""

import asyncio

import pytest

from novelvideo.api.routes import chat
from novelvideo.freezone import canvas_command_bridge as bridge


def test_presence_expires_and_is_canvas_scoped(tmp_path):
    assert not bridge.browser_presence_fresh("../canvas", bridge_dir=tmp_path, now=100)
    bridge.touch_browser_presence("../canvas", bridge_dir=tmp_path, now=100)
    assert bridge.browser_presence_fresh("../canvas", bridge_dir=tmp_path, now=100)
    assert bridge.browser_presence_fresh("../canvas", bridge_dir=tmp_path, now=159)
    assert not bridge.browser_presence_fresh("../canvas", bridge_dir=tmp_path, now=161)
    assert not bridge.browser_presence_fresh("other", bridge_dir=tmp_path, now=100)
    assert len(list(tmp_path.iterdir())) == 1


@pytest.fixture
def directories(monkeypatch, tmp_path):
    paths = [tmp_path / "one", tmp_path / "two"]

    async def state(*_):
        return tmp_path

    monkeypatch.setattr(chat, "_bridge_project_state_dir", state)
    monkeypatch.setattr(chat, "_candidate_canvas_bridge_dirs_for_scope", lambda *_: paths)
    return paths


async def test_poll_touches_every_bridge_dir(directories):
    await chat.list_pending_canvas_commands(
        chat.PendingCanvasCommandsIn(project_id="p", canvas_id="c"), {"username": "viewer"},
    )
    assert all(bridge.browser_presence_fresh("c", bridge_dir=path) for path in directories)


async def test_sse_connect_touches_every_bridge_dir(directories):
    response = await chat.stream_canvas_commands("p", "c", user={"username": "viewer"})
    iterator = response.body_iterator
    try:
        assert await asyncio.wait_for(anext(iterator), 1) == {"comment": "connected"}
        assert all(bridge.browser_presence_fresh("c", bridge_dir=path) for path in directories)
    finally:
        await iterator.aclose()


async def test_idle_sse_renews_presence_after_timeout(directories, monkeypatch):
    real_wait_for = asyncio.wait_for
    timeouts = []

    async def short_wait(awaitable, timeout):
        if timeout == 20:
            timeouts.append(timeout)
            timeout = 0.02
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr(chat.asyncio, "wait_for", short_wait)
    response = await chat.stream_canvas_commands("p", "c", user={"username": "viewer"})
    iterator = response.body_iterator
    task = None
    try:
        await real_wait_for(anext(iterator), 1)
        for directory in directories:
            bridge.touch_browser_presence("c", bridge_dir=directory, now=0)
        task = asyncio.create_task(anext(iterator))
        async with asyncio.timeout(1):
            while not all(bridge.browser_presence_fresh("c", bridge_dir=path) for path in directories):
                await asyncio.sleep(0.01)
        assert timeouts
    finally:
        if task:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        await iterator.aclose()


async def test_poll_touches_all_dirs_before_frame_limit(directories):
    for index in range(10):
        bridge.put_pending_canvas_command(
            key=f"command-{index}", project_id="p", canvas_id="c", commands=[],
            envelope={"external_mcp_command": True, "canvas_id": "c"}, bridge_dir=directories[0],
        )
    result = await chat.list_pending_canvas_commands(
        chat.PendingCanvasCommandsIn(project_id="p", canvas_id="c"), {"username": "viewer"},
    )
    assert len(result["data"]["frames"]) == 10
    assert all(bridge.browser_presence_fresh("c", bridge_dir=path) for path in directories)
